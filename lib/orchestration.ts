import { ArtifactExportStatus, JobStatus, PipelineStage, Prisma, ReviewStatus, StageArtifactRole, StageStatus } from "@prisma/client";
import { cancelAttemptLease, createLocalComputeLease, recordAttemptCompletionCost } from "@/lib/costs";
import { enforceDispatchBudget } from "@/lib/budgets";
import { prisma } from "@/lib/db";
import { recordJobEvent } from "@/lib/events";
import { createHash } from "node:crypto";
import { normalizeTrainingStageConfig } from "@/lib/training-config";
import { queueDigitalTwinExport } from "@/lib/artifact-exports";

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
    if (stage.stage === PipelineStage.TRAINING) {
      await recordTrainingStarted(tx, {
        workspaceId: job.workspaceId,
        jobId,
        jobName: job.name,
        stageConfig: stage.config,
        startedAt: stageAttempt.startedAt ?? new Date(),
      });
    }
    await tx.job.update({ where: { id: jobId }, data: { status: JobStatus.RUNNING } });
    await recordJobEvent(tx, { jobId, type: "stage_dispatched", stage: stage.stage, message: `${stage.stage.toLowerCase()} was dispatched to ${stage.adapter}.`, metadata: { stageId: stage.id, attemptId: stageAttempt.id, adapter: stage.adapter } });
    return { state: "running" as const, jobId, stageId: stage.id, stage: stage.stage, attemptId: stageAttempt.id, adapter: stage.adapter };
  });
}

type OutputArtifact = { assetVersionId: string; role: StageArtifactRole };
type TrainingCompletion = {
  algorithm: string;
  task: string;
  robot: string;
  numEnvs: number;
  maxIterations: number;
  outputFps: number;
  experimentName: string;
  captureTrainingVideos?: boolean;
  videoIntervalSteps?: number;
  videoLengthSteps?: number;
  videoWidth?: number;
  videoHeight?: number;
  telemetry?: unknown;
  report?: unknown;
};
type ReusableTrainingRecipe = Omit<TrainingCompletion, "experimentName">;

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
}

function trainingRecipeFromStageConfig(config: unknown): ReusableTrainingRecipe {
  const normalized = normalizeTrainingStageConfig(config);
  return {
    algorithm: "rsl-rl-ppo",
    task: "Unitree-G1-Tracking-No-State-Estimation",
    robot: "g1",
    numEnvs: normalized.numEnvs,
    maxIterations: normalized.maxIterations,
    outputFps: normalized.outputFps,
    captureTrainingVideos: normalized.captureTrainingVideos,
    videoIntervalSteps: normalized.videoIntervalSteps,
    videoLengthSteps: normalized.videoLengthSteps,
    videoWidth: normalized.videoWidth,
    videoHeight: normalized.videoHeight,
  };
}

async function upsertTrainingRecipe(tx: Prisma.TransactionClient, workspaceId: string, recipeConfig: ReusableTrainingRecipe) {
  const configHash = createHash("sha256").update(JSON.stringify(recipeConfig)).digest("hex").slice(0, 10);
  const recipeSlug = `${slugify(recipeConfig.task)}-${configHash}`;
  return tx.trainingRecipe.upsert({
    where: { workspaceId_slug: { workspaceId, slug: recipeSlug } },
    update: { name: recipeConfig.task, algorithm: recipeConfig.algorithm, config: recipeConfig as unknown as Prisma.InputJsonValue },
    create: {
      workspaceId,
      slug: recipeSlug,
      name: recipeConfig.task,
      algorithm: recipeConfig.algorithm,
      config: recipeConfig as unknown as Prisma.InputJsonValue,
    },
  });
}

async function recordTrainingStarted(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; jobId: string; jobName: string; stageConfig: unknown; startedAt: Date },
) {
  const recipeConfig = trainingRecipeFromStageConfig(input.stageConfig);
  const recipe = await upsertTrainingRecipe(tx, input.workspaceId, recipeConfig);
  await tx.trainingRun.upsert({
    where: { jobId: input.jobId },
    update: {
      recipeId: recipe.id,
      policyId: null,
      status: "RUNNING",
      startedAt: input.startedAt,
      endedAt: null,
      metrics: { ...recipeConfig, stage: PipelineStage.TRAINING } as unknown as Prisma.InputJsonValue,
    },
    create: {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      recipeId: recipe.id,
      name: `${input.jobName} · training`,
      status: "RUNNING",
      startedAt: input.startedAt,
      metrics: { ...recipeConfig, stage: PipelineStage.TRAINING } as unknown as Prisma.InputJsonValue,
    },
  });
}

async function recordSuccessfulTraining(
  tx: Prisma.TransactionClient,
  input: {
    jobId: string;
    workspaceId: string;
    jobName: string;
    robotModel: string;
    startedAt: Date | null;
    training: TrainingCompletion;
    checkpointAssetVersionId: string;
  },
) {
  const recipeConfig = {
    algorithm: input.training.algorithm,
    task: input.training.task,
    robot: input.training.robot,
    numEnvs: input.training.numEnvs,
    maxIterations: input.training.maxIterations,
    outputFps: input.training.outputFps,
    captureTrainingVideos: input.training.captureTrainingVideos ?? false,
    videoIntervalSteps: input.training.videoIntervalSteps,
    videoLengthSteps: input.training.videoLengthSteps,
    videoWidth: input.training.videoWidth,
    videoHeight: input.training.videoHeight,
  };
  const recipe = await upsertTrainingRecipe(tx, input.workspaceId, recipeConfig);
  const robot = await tx.robotModel.upsert({
    where: { workspaceId_slug: { workspaceId: input.workspaceId, slug: input.robotModel } },
    update: { active: true },
    create: {
      workspaceId: input.workspaceId,
      slug: input.robotModel,
      name: input.robotModel === "unitree_g1" ? "Unitree G1" : input.robotModel,
      dof: input.robotModel === "unitree_g1" ? 29 : 0,
      config: { source: "job", trainingRobot: input.training.robot },
    },
  });
  const policyName = `${input.jobName} · ${input.jobId.slice(-6)}`;
  const policy = await tx.policy.upsert({
    where: { workspaceId_name: { workspaceId: input.workspaceId, name: policyName } },
    update: { robotModelId: robot.id, status: "CANDIDATE" },
    create: { workspaceId: input.workspaceId, robotModelId: robot.id, name: policyName, status: "CANDIDATE" },
  });
  const current = await tx.policyVersion.aggregate({ where: { policyId: policy.id }, _max: { version: true } });
  const metrics = {
    checkpointAssetVersionId: input.checkpointAssetVersionId,
    jobId: input.jobId,
    ...input.training,
  };
  const policyVersion = await tx.policyVersion.create({
    data: {
      policyId: policy.id,
      version: (current._max.version ?? 0) + 1,
      status: "CANDIDATE",
      checkpointAssetVersionId: input.checkpointAssetVersionId,
      metrics: metrics as unknown as Prisma.InputJsonValue,
    },
  });
  await tx.trainingRun.upsert({
    where: { jobId: input.jobId },
    update: {
      recipeId: recipe.id,
      policyId: policy.id,
      status: "SUCCEEDED",
      endedAt: new Date(),
      metrics: { ...metrics, policyVersionId: policyVersion.id } as unknown as Prisma.InputJsonValue,
    },
    create: {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      recipeId: recipe.id,
      policyId: policy.id,
      name: `${input.jobName} · training`,
      status: "SUCCEEDED",
      startedAt: input.startedAt,
      endedAt: new Date(),
      metrics: { ...metrics, policyVersionId: policyVersion.id } as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function completeStage(
  jobId: string,
  stageId: string,
  result: unknown = {},
  outputs: OutputArtifact[] = [],
  completion?: { training?: TrainingCompletion },
) {
  return prisma.$transaction(async (tx) => {
    const stage = await tx.jobStage.findFirst({ where: { id: stageId, jobId }, include: { job: { select: { workspaceId: true, name: true, robotModel: true } } } });
    if (!stage) throw new OrchestrationError("Stage was not found for this job.", 404);
    if (stage.status !== StageStatus.RUNNING) throw new OrchestrationError("Only a running stage can be completed.");
    for (const output of outputs) {
      const version = await tx.assetVersion.findFirst({ where: { id: output.assetVersionId, asset: { workspaceId: stage.job.workspaceId } } });
      if (!version) throw new OrchestrationError("An output artifact was not found in this workspace.", 400);
    }
    if (outputs.length) await tx.stageArtifact.createMany({ data: outputs.map((output) => ({ jobStageId: stageId, assetVersionId: output.assetVersionId, role: output.role })), skipDuplicates: true });
    if (stage.stage === PipelineStage.VISUALIZATION) {
      const scene = await tx.assetVersion.findFirst({
        where: {
          id: { in: outputs.map((output) => output.assetVersionId) },
          schemaVersion: { startsWith: "visualization.robot-3d-scene/" },
        },
        select: { id: true },
      });
      if (!scene) {
        throw new OrchestrationError("Visualization must publish an interactive Unitree G1 scene before it can complete.", 400);
      }
      await queueDigitalTwinExport(tx, {
        workspaceId: stage.job.workspaceId,
        jobId,
        jobStageId: stageId,
        sourceSceneAssetVersionId: scene.id,
      });
      await recordJobEvent(tx, {
        jobId,
        type: "artifact_export_queued",
        stage: PipelineStage.VISUALIZATION,
        message: "The interactive digital twin is ready; its downloadable MP4 is rendering in the background.",
        metadata: { stageId, kind: "DIGITAL_TWIN_MP4" },
      });
    }
    await tx.jobStage.update({ where: { id: stageId }, data: { status: StageStatus.SUCCEEDED } });
    await recordJobEvent(tx, { jobId, type: "stage_succeeded", stage: stage.stage, message: `${stage.stage.toLowerCase()} completed.`, metadata: { stageId } });
    const activeAttempt = await tx.stageAttempt.findFirst({ where: { jobStageId: stageId, status: StageStatus.RUNNING }, orderBy: { attempt: "desc" } });
    if (activeAttempt) {
      await tx.stageAttempt.update({
        where: { id: activeAttempt.id },
        data: { status: StageStatus.SUCCEEDED, endedAt: new Date(), result: result as Prisma.InputJsonValue },
      });
    }
    if (completion?.training) {
      if (stage.stage !== PipelineStage.TRAINING) throw new OrchestrationError("Training completion metadata can only be attached to a training stage.");
      const checkpoint = outputs.find((output) => output.role === StageArtifactRole.OUTPUT);
      if (!checkpoint) throw new OrchestrationError("A successful training stage must publish a checkpoint output.");
      await recordSuccessfulTraining(tx, {
        jobId,
        workspaceId: stage.job.workspaceId,
        jobName: stage.job.name,
        robotModel: stage.job.robotModel,
        startedAt: activeAttempt?.startedAt ?? null,
        training: completion.training,
        checkpointAssetVersionId: checkpoint.assetVersionId,
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
    if (stage.stage === PipelineStage.TRAINING) {
      await tx.trainingRun.updateMany({
        where: { jobId },
        data: { status: "FAILED", endedAt: new Date() },
      });
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
        job: { select: { workspaceId: true } },
        artifacts: {
          include: { assetVersion: { select: { id: true, schemaVersion: true } } },
        },
      },
    });
    if (!stage) throw new OrchestrationError("Stage was not found for this job.", 404);
    if (stage.stage !== PipelineStage.VISUALIZATION) {
      throw new OrchestrationError("Only the visualization stage can be re-rendered.");
    }
    if (stage.status !== StageStatus.SUCCEEDED) {
      throw new OrchestrationError("Only a completed visualization stage can be re-rendered.");
    }
    const scene = stage.artifacts
      .map((artifact) => artifact.assetVersion)
      .find((version) => version.schemaVersion.startsWith("visualization.robot-3d-scene/"));
    if (!scene) throw new OrchestrationError("The visualization stage has no interactive scene to export.");
    const artifactExport = await queueDigitalTwinExport(tx, {
      workspaceId: stage.job.workspaceId,
      jobId,
      jobStageId: stageId,
      sourceSceneAssetVersionId: scene.id,
    });
    await recordJobEvent(tx, {
      jobId,
      type: "visualization_rerender_requested",
      stage: PipelineStage.VISUALIZATION,
      message: "The Unitree G1 digital-twin MP4 was queued for re-rendering.",
      metadata: { stageId, exportId: artifactExport.id },
    });
    return { jobId, stageId, exportId: artifactExport.id, state: "queued" as const };
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
    await tx.trainingRun.updateMany({ where: { jobId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", endedAt: new Date() } });
    await tx.artifactExport.updateMany({
      where: { jobId, status: { in: [ArtifactExportStatus.QUEUED, ArtifactExportStatus.RUNNING] } },
      data: { status: ArtifactExportStatus.CANCELLED, finishedAt: new Date(), errorMessage: "The job was cancelled." },
    });
    await tx.job.update({ where: { id: jobId }, data: { status: JobStatus.CANCELLED } });
    await recordJobEvent(tx, { jobId, type: "job_cancelled", message: "Job and unfinished stages were cancelled." });
    return { jobId, state: "cancelled" as const };
  });
}
