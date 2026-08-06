import { StageArtifactRole, StageStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { completeStage, type TrainingCompletion } from "@/lib/orchestration";
import { compactTrainingReport } from "@/lib/training-telemetry";

type TrainingManifest = {
  stage?: string;
  summary?: string;
  training?: Record<string, unknown>;
};

function manifestFromResult(result: unknown): TrainingManifest | null {
  if (!result || typeof result !== "object") return null;
  const logs = (result as { logs?: unknown }).logs;
  if (!Array.isArray(logs)) return null;
  for (const item of [...logs].reverse()) {
    if (typeof item !== "string" || !item.trimStart().startsWith("{")) continue;
    try {
      const candidate = JSON.parse(item) as TrainingManifest;
      if (candidate.stage === "training" && candidate.training) return candidate;
    } catch {
      // Ordinary training log lines can start with braces; only a valid stage
      // manifest is useful for recovery.
    }
  }
  return null;
}

function artifactRole(schemaVersion: string): StageArtifactRole {
  if (schemaVersion.startsWith("policy.checkpoint.rsl-rl-best/")) return StageArtifactRole.OUTPUT;
  if (schemaVersion.startsWith("visualization.policy-best-rollout/")) return StageArtifactRole.PREVIEW;
  return StageArtifactRole.EVIDENCE;
}

async function main() {
  const stageId = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!stageId) throw new Error("Usage: npx tsx scripts/recover-completed-training.ts <stage-id> [--apply]");

  const stage = await prisma.jobStage.findUnique({
    where: { id: stageId },
    include: {
      job: true,
      attempts: { orderBy: { attempt: "desc" } },
    },
  });
  if (!stage) throw new Error(`Stage ${stageId} was not found.`);
  if (stage.stage !== "TRAINING") throw new Error(`${stageId} is not a training stage.`);
  if (stage.status !== StageStatus.RUNNING) throw new Error(`${stageId} is ${stage.status}; recovery requires a running retry attempt.`);

  const activeAttempt = stage.attempts.find((attempt) => attempt.status === StageStatus.RUNNING);
  const sourceAttempt = stage.attempts.find((attempt) => {
    return attempt.status === StageStatus.FAILED_RETRYABLE && Boolean(manifestFromResult(attempt.result));
  });
  if (!activeAttempt) throw new Error("No running retry attempt is available to finalize.");
  if (!sourceAttempt) throw new Error("No failed attempt contains a completed training manifest.");
  const manifest = manifestFromResult(sourceAttempt.result);
  if (!manifest?.training) throw new Error("The source attempt training manifest is incomplete.");

  const createdWindowStart = new Date((sourceAttempt.startedAt ?? sourceAttempt.createdAt).getTime() - 60_000);
  const createdWindowEnd = new Date((sourceAttempt.endedAt ?? new Date()).getTime() + 60_000);
  const versions = await prisma.assetVersion.findMany({
    where: {
      createdAt: { gte: createdWindowStart, lte: createdWindowEnd },
      asset: {
        workspaceId: stage.job.workspaceId,
        name: { startsWith: `${stage.jobId} · training ·` },
      },
    },
    include: { asset: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const outputs = versions.map((version) => ({
    assetVersionId: version.id,
    role: artifactRole(version.schemaVersion),
  }));
  const checkpoint = versions.find((version) => version.schemaVersion.startsWith("policy.checkpoint.rsl-rl-best/"));
  if (!checkpoint) throw new Error("The completed attempt did not upload its best-policy checkpoint.");
  if (versions.length < 2) throw new Error("The completed attempt artifact bundle is unexpectedly incomplete.");

  const sourceRuntimeMs = sourceAttempt.startedAt && sourceAttempt.endedAt
    ? Math.max(1000, sourceAttempt.endedAt.getTime() - sourceAttempt.startedAt.getTime())
    : 1000;
  const training = manifest.training as Record<string, unknown>;
  const required = ["algorithm", "task", "robot", "numEnvs", "maxIterations", "outputFps", "experimentName"];
  for (const key of required) {
    if (training[key] === undefined || training[key] === null) throw new Error(`Training manifest is missing ${key}.`);
  }

  console.log(JSON.stringify({
    stageId,
    jobId: stage.jobId,
    activeAttempt: activeAttempt.attempt,
    sourceAttempt: sourceAttempt.attempt,
    artifacts: versions.length,
    bestCheckpoint: checkpoint.asset.name,
    sourceRuntimeSeconds: Math.round(sourceRuntimeMs / 1000),
    apply,
  }, null, 2));
  if (!apply) {
    console.log("Dry run only. Add --apply after reviewing this summary.");
    return;
  }

  // The retry was opened only because finalization failed. Attribute the
  // successful completion to the actual GPU runtime rather than hours spent
  // waiting for a replacement Pod.
  await prisma.stageAttempt.update({
    where: { id: activeAttempt.id },
    data: { startedAt: new Date(Date.now() - sourceRuntimeMs) },
  });
  await completeStage(
    stage.jobId,
    stage.id,
    {
      worker: "training-recovery",
      summary: manifest.summary ?? "Recovered completed training artifacts after database finalization timeout.",
      recoveredFromAttemptId: sourceAttempt.id,
      outputCount: outputs.length,
      training: compactTrainingReport(training.report),
    },
    outputs,
    { training: training as unknown as TrainingCompletion },
  );
  console.log(`Recovered training stage ${stage.id} without rerunning GPU training.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
