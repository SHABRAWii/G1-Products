import { JobStatus, PipelineStage, Prisma, ReviewStatus, StageArtifactRole, StageStatus } from "@prisma/client";
import { cancelAttemptLease, createLocalComputeLease, recordAttemptCompletionCost } from "@/lib/costs";
import { enforceDispatchBudget } from "@/lib/budgets";
import { prisma } from "@/lib/db";
import { recordJobEvent } from "@/lib/events";

type Database = Prisma.TransactionClient | typeof prisma;

export class OrchestrationError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = "OrchestrationError";
  }
}

function nextStage(stages: { id: string; position: number; status: StageStatus; stage: PipelineStage }[], position: number) {
  return stages.find((stage) => stage.position > position);
}

async function openPoseReview(tx: Database, jobId: string, stageId: string) {
  await tx.jobStage.update({ where: { id: stageId }, data: { status: StageStatus.AWAITING_REVIEW } });
  const reviewTask = await tx.reviewTask.upsert({
    where: { jobStageId: stageId },
    update: { status: ReviewStatus.PENDING, decisionNote: null, reviewedBy: null, decidedAt: null },
    create: { jobId, jobStageId: stageId, status: ReviewStatus.PENDING },
  });
  await tx.job.update({ where: { id: jobId }, data: { status: JobStatus.WAITING_REVIEW } });
  await recordJobEvent(tx, { jobId, type: "review_requested", stage: PipelineStage.POSE_REVIEW, message: "Pose review is awaiting a reviewer decision.", metadata: { reviewTaskId: reviewTask.id } });
  return reviewTask;
}

async function finishStageAndPrepareNext(tx: Database, jobId: string, stageId: string, outputAssetVersionIds: string[] = []) {
  const job = await tx.job.findUnique({
    where: { id: jobId },
    include: { stages: { orderBy: { position: "asc" } } },
  });
  if (!job) throw new OrchestrationError("Job was not found.", 404);

  const stage = job.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new OrchestrationError("Stage does not belong to this job.", 404);
  const next = nextStage(job.stages, stage.position);
  if (!next) {
    await tx.job.update({ where: { id: jobId }, data: { status: JobStatus.SUCCEEDED } });
    await recordJobEvent(tx, { jobId, type: "job_succeeded", message: "All selected pipeline stages completed." });
    return { state: "succeeded" as const, nextStage: null, reviewTask: null };
  }
  if (next.stage === PipelineStage.POSE_REVIEW) {
    if (outputAssetVersionIds.length) await tx.stageArtifact.createMany({ data: outputAssetVersionIds.map((assetVersionId) => ({ jobStageId: next.id, assetVersionId, role: StageArtifactRole.INPUT })), skipDuplicates: true });
    const reviewTask = await openPoseReview(tx, jobId, next.id);
    return { state: "awaiting_review" as const, nextStage: next, reviewTask };
  }
  if (outputAssetVersionIds.length) await tx.stageArtifact.createMany({ data: outputAssetVersionIds.map((assetVersionId) => ({ jobStageId: next.id, assetVersionId, role: StageArtifactRole.INPUT })), skipDuplicates: true });
  const readyStage = await tx.jobStage.update({ where: { id: next.id }, data: { status: StageStatus.READY } });
  await tx.job.update({ where: { id: jobId }, data: { status: JobStatus.QUEUED } });
  return { state: "ready" as const, nextStage: readyStage, reviewTask: null };
}

export async function dispatchNextStage(jobId: string) {
  return prisma.$transaction(async (tx) => {
    const job = await tx.job.findUnique({
      where: { id: jobId },
      include: { stages: { orderBy: { position: "asc" } } },
    });
    if (!job) throw new OrchestrationError("Job was not found.", 404);
    if (job.status !== JobStatus.QUEUED && job.status !== JobStatus.DISPATCHING && job.status !== JobStatus.RUNNING) {
      throw new OrchestrationError(`Job cannot be dispatched while ${job.status.toLowerCase()}.`);
    }
    const budget = await enforceDispatchBudget(tx, { workspaceId: job.workspaceId, jobId, estimateMinor: job.estimateMinor });
    if (budget.blocked) return { state: "blocked" as const, jobId, budgetId: budget.budgetId };
    const active = job.stages.find((stage) => stage.status === StageStatus.RUNNING || stage.status === StageStatus.LEASED);
    if (active) throw new OrchestrationError("A stage is already running for this job.");
    const stage = job.stages.find((candidate) => candidate.status === StageStatus.PENDING || candidate.status === StageStatus.READY);
    if (!stage) throw new OrchestrationError("No dispatchable stage remains for this job.");
    if (stage.stage === PipelineStage.POSE_REVIEW) {
      const reviewTask = await openPoseReview(tx, jobId, stage.id);
      return { state: "awaiting_review" as const, jobId, stageId: stage.id, reviewTaskId: reviewTask.id };
    }

    const latest = await tx.stageAttempt.aggregate({ where: { jobStageId: stage.id }, _max: { attempt: true } });
    const attempt = (latest._max.attempt ?? 0) + 1;
    await tx.jobStage.update({ where: { id: stage.id }, data: { status: StageStatus.RUNNING } });
    const stageAttempt = await tx.stageAttempt.create({
      data: {
        jobStageId: stage.id,
        attempt,
        workerId: "local-adapter",
        containerRef: stage.adapter,
        status: StageStatus.RUNNING,
        startedAt: new Date(),
      },
    });
    if (stage.stage !== PipelineStage.VIDEO_GENERATION) {
      await createLocalComputeLease(tx, { workspaceId: job.workspaceId, jobId, stageAttemptId: stageAttempt.id });
    }
    await tx.job.update({ where: { id: jobId }, data: { status: JobStatus.RUNNING } });
    await recordJobEvent(tx, { jobId, type: "stage_dispatched", stage: stage.stage, message: `${stage.stage.toLowerCase()} was dispatched to ${stage.adapter}.`, metadata: { stageId: stage.id, attemptId: stageAttempt.id, adapter: stage.adapter } });
    return { state: "running" as const, jobId, stageId: stage.id, stage: stage.stage, attemptId: stageAttempt.id, adapter: stage.adapter };
  });
}

type OutputArtifact = { assetVersionId: string; role: StageArtifactRole };

export async function completeStage(jobId: string, stageId: string, result: unknown = {}, outputs: OutputArtifact[] = []) {
  return prisma.$transaction(async (tx) => {
    const stage = await tx.jobStage.findFirst({ where: { id: stageId, jobId }, include: { job: { select: { workspaceId: true } } } });
    if (!stage) throw new OrchestrationError("Stage was not found for this job.", 404);
    if (stage.status !== StageStatus.RUNNING) throw new OrchestrationError("Only a running stage can be completed.");
    for (const output of outputs) {
      const version = await tx.assetVersion.findFirst({ where: { id: output.assetVersionId, asset: { workspaceId: stage.job.workspaceId } } });
      if (!version) throw new OrchestrationError("An output artifact was not found in this workspace.", 400);
    }
    if (outputs.length) await tx.stageArtifact.createMany({ data: outputs.map((output) => ({ jobStageId: stageId, assetVersionId: output.assetVersionId, role: output.role })), skipDuplicates: true });
    await tx.jobStage.update({ where: { id: stageId }, data: { status: StageStatus.SUCCEEDED } });
    await recordJobEvent(tx, { jobId, type: "stage_succeeded", stage: stage.stage, message: `${stage.stage.toLowerCase()} completed.`, metadata: { stageId } });
    const activeAttempt = await tx.stageAttempt.findFirst({ where: { jobStageId: stageId, status: StageStatus.RUNNING }, orderBy: { attempt: "desc" } });
    if (activeAttempt) {
      await tx.stageAttempt.update({
        where: { id: activeAttempt.id },
        data: { status: StageStatus.SUCCEEDED, endedAt: new Date(), result: result as Prisma.InputJsonValue },
      });
    }
    const usage = activeAttempt
      ? await recordAttemptCompletionCost(tx, { workspaceId: stage.job.workspaceId, jobId, stage: stage.stage, attempt: activeAttempt })
      : { recorded: false, runtimeSeconds: 0, reason: "No active attempt was found." };
    const next = await finishStageAndPrepareNext(tx, jobId, stageId, outputs.filter((output) => output.role === StageArtifactRole.OUTPUT).map((output) => output.assetVersionId));
    return { jobId, stageId, usage, ...next };
  });
}

export async function failStage(jobId: string, stageId: string, input: { retryable: boolean; errorCode?: string; message?: string; logs?: string[]; worker?: string }) {
  return prisma.$transaction(async (tx) => {
    const stage = await tx.jobStage.findFirst({ where: { id: stageId, jobId } });
    if (!stage) throw new OrchestrationError("Stage was not found for this job.", 404);
    if (stage.status !== StageStatus.RUNNING) throw new OrchestrationError("Only a running stage can fail.");
    const status = input.retryable ? StageStatus.FAILED_RETRYABLE : StageStatus.FAILED_TERMINAL;
    await tx.jobStage.update({ where: { id: stageId }, data: { status } });
    const attempt = await tx.stageAttempt.findFirst({ where: { jobStageId: stageId, status: StageStatus.RUNNING }, orderBy: { attempt: "desc" } });
    if (attempt) {
      await tx.stageAttempt.update({ where: { id: attempt.id }, data: { status, endedAt: new Date(), workerId: input.worker ?? attempt.workerId, errorCode: input.errorCode ?? "STAGE_FAILED", result: { message: input.message ?? "Stage failed.", logs: input.logs ?? [] } } });
      await cancelAttemptLease(tx, attempt.id);
    }
    await tx.job.update({ where: { id: jobId }, data: { status: JobStatus.FAILED } });
    await recordJobEvent(tx, { jobId, type: "stage_failed", stage: stage.stage, message: input.message ?? `${stage.stage.toLowerCase()} failed.`, metadata: { stageId, retryable: input.retryable, errorCode: input.errorCode ?? "STAGE_FAILED" } });
    return { jobId, stageId, state: input.retryable ? "failed_retryable" as const : "failed_terminal" as const };
  });
}

export async function retryJobStage(jobId: string, stageId: string) {
  return prisma.$transaction(async (tx) => {
    const stage = await tx.jobStage.findFirst({ where: { id: stageId, jobId } });
    if (!stage) throw new OrchestrationError("Stage was not found for this job.", 404);
    if (stage.status !== StageStatus.FAILED_RETRYABLE) throw new OrchestrationError("Only retryable failed stages can be retried.");
    await tx.jobStage.update({ where: { id: stageId }, data: { status: StageStatus.READY } });
    await tx.job.update({ where: { id: jobId }, data: { status: JobStatus.QUEUED } });
    await recordJobEvent(tx, { jobId, type: "stage_retried", stage: stage.stage, message: `${stage.stage.toLowerCase()} was requeued for retry.`, metadata: { stageId } });
    return { jobId, stageId, state: "queued" as const };
  });
}

export async function rerunVisualizationStage(jobId: string, stageId: string) {
  return prisma.$transaction(async (tx) => {
    const stage = await tx.jobStage.findFirst({
      where: { id: stageId, jobId },
      include: {
        job: { include: { stages: { select: { id: true, status: true } } } },
        artifacts: { where: { role: StageArtifactRole.INPUT }, select: { id: true } },
      },
    });
    if (!stage) throw new OrchestrationError("Stage was not found for this job.", 404);
    if (stage.stage !== PipelineStage.VISUALIZATION) {
      throw new OrchestrationError("Only the visualization stage can be re-rendered.");
    }
    if (stage.status !== StageStatus.SUCCEEDED) {
      throw new OrchestrationError("Only a completed visualization stage can be re-rendered.");
    }
    if (!stage.artifacts.length) {
      throw new OrchestrationError("The visualization stage has no robot-motion input.");
    }
    const active = stage.job.stages.find((candidate) =>
      candidate.status === StageStatus.RUNNING || candidate.status === StageStatus.LEASED
    );
    if (active) throw new OrchestrationError("Another stage is already running for this job.");
    await tx.jobStage.update({
      where: { id: stageId },
      data: { status: StageStatus.READY },
    });
    await tx.job.update({
      where: { id: jobId },
      data: { status: JobStatus.QUEUED },
    });
    await recordJobEvent(tx, {
      jobId,
      type: "visualization_rerender_requested",
      stage: PipelineStage.VISUALIZATION,
      message: "The Unitree G1 digital-twin MP4 was queued for re-rendering.",
      metadata: { stageId },
    });
    return { jobId, stageId, state: "queued" as const };
  });
}

export async function approveReviewTask(reviewTaskId: string, reviewedBy?: string, decisionNote?: string) {
  return prisma.$transaction(async (tx) => {
    const task = await tx.reviewTask.findUnique({ where: { id: reviewTaskId }, include: { jobStage: { include: { artifacts: { where: { role: StageArtifactRole.INPUT } } } } } });
    if (!task) throw new OrchestrationError("Review task was not found.", 404);
    if (task.status !== ReviewStatus.PENDING) throw new OrchestrationError("This review task has already been decided.");
    await tx.reviewTask.update({
      where: { id: task.id },
      data: { status: ReviewStatus.APPROVED, reviewedBy: reviewedBy?.trim() || "operator", decisionNote: decisionNote?.trim() || null, decidedAt: new Date() },
    });
    await tx.jobStage.update({ where: { id: task.jobStageId }, data: { status: StageStatus.SUCCEEDED } });
    await recordJobEvent(tx, { jobId: task.jobId, type: "review_approved", stage: PipelineStage.POSE_REVIEW, message: "Pose review was approved.", metadata: { reviewTaskId, reviewedBy: reviewedBy?.trim() || "operator" } });
    const next = await finishStageAndPrepareNext(tx, task.jobId, task.jobStageId, task.jobStage.artifacts.map((artifact) => artifact.assetVersionId));
    return { reviewTaskId, jobId: task.jobId, ...next };
  });
}

export async function rejectReviewTask(reviewTaskId: string, reviewedBy?: string, decisionNote?: string) {
  return prisma.$transaction(async (tx) => {
    const task = await tx.reviewTask.findUnique({ where: { id: reviewTaskId } });
    if (!task) throw new OrchestrationError("Review task was not found.", 404);
    if (task.status !== ReviewStatus.PENDING) throw new OrchestrationError("This review task has already been decided.");
    await tx.reviewTask.update({
      where: { id: task.id },
      data: { status: ReviewStatus.REJECTED, reviewedBy: reviewedBy?.trim() || "operator", decisionNote: decisionNote?.trim() || null, decidedAt: new Date() },
    });
    await tx.jobStage.update({ where: { id: task.jobStageId }, data: { status: StageStatus.FAILED_TERMINAL } });
    await tx.job.update({ where: { id: task.jobId }, data: { status: JobStatus.BLOCKED } });
    await recordJobEvent(tx, { jobId: task.jobId, type: "review_rejected", stage: PipelineStage.POSE_REVIEW, message: "Pose review was rejected and the job was blocked.", metadata: { reviewTaskId, reviewedBy: reviewedBy?.trim() || "operator" } });
    return { reviewTaskId, jobId: task.jobId, state: "blocked" as const };
  });
}

export async function cancelJob(jobId: string) {
  return prisma.$transaction(async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId } });
    if (!job) throw new OrchestrationError("Job was not found.", 404);
    if (job.status === JobStatus.SUCCEEDED || job.status === JobStatus.CANCELLED) throw new OrchestrationError(`A ${job.status.toLowerCase()} job cannot be cancelled.`);
    const activeAttempts = await tx.stageAttempt.findMany({ where: { jobStage: { jobId }, status: { in: [StageStatus.LEASED, StageStatus.RUNNING] } } });
    for (const attempt of activeAttempts) await cancelAttemptLease(tx, attempt.id);
    await tx.jobStage.updateMany({
      where: { jobId, status: { in: [StageStatus.PENDING, StageStatus.READY, StageStatus.LEASED, StageStatus.RUNNING, StageStatus.AWAITING_REVIEW] } },
      data: { status: StageStatus.CANCELLED },
    });
    await tx.stageAttempt.updateMany({ where: { jobStage: { jobId }, status: { in: [StageStatus.LEASED, StageStatus.RUNNING] } }, data: { status: StageStatus.CANCELLED, endedAt: new Date() } });
    await tx.job.update({ where: { id: jobId }, data: { status: JobStatus.CANCELLED } });
    await recordJobEvent(tx, { jobId, type: "job_cancelled", message: "Job and unfinished stages were cancelled." });
    return { jobId, state: "cancelled" as const };
  });
}
