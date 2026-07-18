import { PipelineStage, Prisma, StageAttempt, StageStatus } from "@prisma/client";

type Database = Prisma.TransactionClient;

function billingDescriptor(stage: PipelineStage) {
  if (stage === PipelineStage.VIDEO_GENERATION) return { sku: "video-generation-minute", category: "video_generation", provider: "video-provider" };
  return { sku: "runpod-gpu-minute", category: "runpod_compute", provider: "runpod" };
}

export async function createLocalComputeLease(tx: Database, input: { workspaceId: string; jobId: string; stageAttemptId: string }) {
  const resource = await tx.computeResource.upsert({
    where: { workspaceId_provider_externalId: { workspaceId: input.workspaceId, provider: "runpod", externalId: "local-mvp-pod" } },
    update: { state: "RUNNING", lastSeenAt: new Date() },
    create: { workspaceId: input.workspaceId, provider: "runpod", externalId: "local-mvp-pod", gpuSku: "configured-by-rate-card", region: "local", state: "RUNNING", gpuCount: 1, vramGb: 24 },
  });
  return tx.computeLease.create({ data: { workspaceId: input.workspaceId, jobId: input.jobId, stageAttemptId: input.stageAttemptId, resourceId: resource.id, provider: "runpod", state: "ACTIVE" } });
}

export async function recordAttemptCompletionCost(tx: Database, input: { workspaceId: string; jobId: string; stage: PipelineStage; attempt: StageAttempt }) {
  const endedAt = new Date();
  const startedAt = input.attempt.startedAt ?? input.attempt.createdAt;
  const runtimeSeconds = Math.max(1, Math.ceil((endedAt.getTime() - startedAt.getTime()) / 1000));
  const descriptor = billingDescriptor(input.stage);
  const rateCard = await tx.rateCard.findFirst({
    where: { workspaceId: input.workspaceId, active: true, effectiveAt: { lte: endedAt } },
    include: { items: { where: { sku: descriptor.sku } } },
    orderBy: { effectiveAt: "desc" },
  });
  const rate = rateCard?.items[0];
  if (input.stage !== PipelineStage.VIDEO_GENERATION) {
    await tx.computeLease.updateMany({ where: { stageAttemptId: input.attempt.id, state: "ACTIVE" }, data: { state: "RELEASED", endedAt, runtimeSeconds } });
  }
  if (!rate || !rateCard) return { runtimeSeconds, recorded: false, reason: `No active rate-card item for ${descriptor.sku}.` };
  const units = Math.max(1, Math.ceil(runtimeSeconds / 60));
  const amountMinor = rate.amountMinor * units;
  const entry = await tx.costLedgerEntry.create({
    data: {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      kind: "OBSERVED",
      category: descriptor.category,
      provider: descriptor.provider,
      amountMinor,
      currency: rateCard.currency,
      rateCard: `${rateCard.id}:${rate.sku}`,
      metadata: { stage: input.stage, stageAttemptId: input.attempt.id, runtimeSeconds, units, unit: rate.unit, rateMinor: rate.amountMinor },
    },
  });
  return { runtimeSeconds, recorded: true, entry };
}

export async function cancelAttemptLease(tx: Database, attemptId: string) {
  const now = new Date();
  const lease = await tx.computeLease.findUnique({ where: { stageAttemptId: attemptId } });
  if (!lease || lease.state !== "ACTIVE") return;
  await tx.computeLease.update({
    where: { id: lease.id },
    data: { state: "CANCELLED", endedAt: now, runtimeSeconds: Math.max(1, Math.ceil((now.getTime() - lease.startedAt.getTime()) / 1000)) },
  });
}

export function isTerminalStageStatus(status: StageStatus) {
  return status === StageStatus.SUCCEEDED || status === StageStatus.FAILED_TERMINAL || status === StageStatus.CANCELLED || status === StageStatus.SKIPPED;
}
