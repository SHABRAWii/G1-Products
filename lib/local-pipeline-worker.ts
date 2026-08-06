import { AssetApprovalStatus, AssetType, PipelineStage as PrismaPipelineStage, StageArtifactRole, StageStatus } from "@prisma/client";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { spawn } from "node:child_process";
import { prisma } from "@/lib/db";
import { getArtifactBytes, putArtifactFile } from "@/lib/object-storage";
import { completeStage, dispatchNextStage, failStage } from "@/lib/orchestration";
import { executablePipelineStages } from "@/lib/worker-capabilities";
import { normalizeTrainingStageConfig } from "@/lib/training-config";
import {
  compactTrainingReport,
  completeTrainingTelemetry,
  createTrainingTelemetry,
  ingestTrainingLog,
  type TrainingTelemetry,
} from "@/lib/training-telemetry";

type WorkerOutput = { path: string; assetType: keyof typeof AssetType; schemaVersion: string; role: keyof typeof StageArtifactRole; contentType: string };
type WorkerTrainingConfig = {
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
  telemetry?: TrainingTelemetry;
  report?: Record<string, unknown>;
};
type WorkerManifest = { summary?: string; outputs: WorkerOutput[]; training?: WorkerTrainingConfig };

function completionCanRetry(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Transaction already closed")
    || message.includes("expired transaction")
    || message.includes("P2028")
    || message.includes("Timed out fetching a new connection");
}

async function pause(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const executableStages = new Set<PrismaPipelineStage>(executablePipelineStages);

class WorkerTerminationError extends Error {
  constructor(message: string, readonly cancelled: boolean) { super(message); }
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already exited */ }
  }
}

function run(command: string, args: string[], onLog: (line: string) => void, input: { stageId: string; signal?: AbortSignal; maxRuntimeMs?: number }) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env, detached: process.platform !== "win32" });
    let stderr = "";
    let cancellationRequested = false;
    let cancellationReason = "Stage execution was cancelled.";
    let cancelledByOperator = true;
    let forceKill: NodeJS.Timeout | undefined;
    const emit = (chunk: Buffer) => chunk.toString().split(/[\r\n]+/).filter(Boolean).forEach(onLog);
    const cancel = (reason: string, operatorCancellation = true) => {
      if (cancellationRequested) return;
      cancellationRequested = true;
      cancellationReason = reason;
      cancelledByOperator = operatorCancellation;
      onLog(`Worker termination requested: ${reason}`);
      terminateProcessGroup(child.pid, "SIGTERM");
      forceKill = setTimeout(() => terminateProcessGroup(child.pid, "SIGKILL"), 10_000);
    };
    const abort = () => cancel("worker shutdown");
    input.signal?.addEventListener("abort", abort, { once: true });
    const cancellationPoll = setInterval(() => {
      void prisma.jobStage.findUnique({ where: { id: input.stageId }, select: { status: true } })
        .then((stage) => { if (!stage || stage.status === StageStatus.CANCELLED) cancel("job cancelled"); })
        .catch((error) => onLog(`Unable to check cancellation state: ${error instanceof Error ? error.message : String(error)}`));
    }, 1000);
    const maxRuntimeMs = input.maxRuntimeMs;
    const runtimeLimit = maxRuntimeMs
      ? setTimeout(() => cancel(`runtime limit of ${Math.round(maxRuntimeMs / 60_000)} minutes exceeded`, false), maxRuntimeMs)
      : undefined;
    child.stdout.on("data", emit);
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); emit(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearInterval(cancellationPoll);
      if (forceKill) clearTimeout(forceKill);
      if (runtimeLimit) clearTimeout(runtimeLimit);
      input.signal?.removeEventListener("abort", abort);
      if (cancellationRequested) reject(new WorkerTerminationError(cancellationReason, cancelledByOperator));
      else if (code === 0) resolve();
      else reject(new Error(`Worker bridge exited with code ${code}. ${stderr.slice(-1000)}`));
    });
  });
}

async function storeOutput(input: { workspaceId: string; jobId: string; stage: PrismaPipelineStage; output: WorkerOutput }) {
  const filename = basename(input.output.path);
  const asset = await prisma.asset.create({ data: { workspaceId: input.workspaceId, name: `${input.jobId} · ${input.stage.toLowerCase()} · ${filename}`, type: AssetType[input.output.assetType] } });
  const uploaded = await putArtifactFile({ workspaceId: input.workspaceId, assetId: asset.id, version: 1, filename, path: input.output.path, contentType: input.output.contentType });
  const version = await prisma.assetVersion.create({ data: { assetId: asset.id, version: 1, schemaVersion: input.output.schemaVersion, storageKey: uploaded.storageKey, contentType: input.output.contentType, byteSize: BigInt(uploaded.byteSize), checksum: uploaded.checksum, approvalStatus: AssetApprovalStatus.APPROVED, metadata: { jobId: input.jobId, stage: input.stage, worker: "local-pipeline-worker" } } });
  return { assetVersionId: version.id, role: StageArtifactRole[input.output.role] };
}

async function executeStage(stageId: string, signal?: AbortSignal) {
  const stage = await prisma.jobStage.findUnique({
    where: { id: stageId },
    include: { job: true, artifacts: { where: { role: StageArtifactRole.INPUT }, include: { assetVersion: { include: { asset: true } } } }, attempts: { where: { status: StageStatus.RUNNING }, orderBy: { attempt: "desc" }, take: 1 } },
  });
  if (!stage || stage.status !== StageStatus.RUNNING || !executableStages.has(stage.stage)) return;
  const attempt = stage.attempts[0];
  const input = stage.artifacts[0]?.assetVersion;
  if (!attempt || !input) {
    await failStage(stage.jobId, stage.id, { retryable: false, errorCode: "MISSING_STAGE_INPUT", message: "The worker could not find an input artifact for this stage." });
    return;
  }
  const workDir = await mkdtemp(join(tmpdir(), `robomotion-${stage.id}-`));
  const logs: string[] = [];
  const stageTrainingConfig = stage.stage === PrismaPipelineStage.TRAINING
    ? normalizeTrainingStageConfig(stage.config)
    : null;
  const trainingTelemetry = stageTrainingConfig
    ? createTrainingTelemetry(stageTrainingConfig.maxIterations)
    : null;
  let progressTimer: NodeJS.Timeout | undefined;
  let activityTimer: NodeJS.Timeout | undefined;
  let progressWrite = Promise.resolve();
  const startedAt = Date.now();
  let lastChildOutputAt = startedAt;
  const logPrefix = `[stage:${stage.jobId}:${stage.stage.toLowerCase()}:attempt-${attempt.attempt}]`;
  const appendLog = (line: string) => {
    logs.push(line);
    if (logs.length > 80) logs.shift();
  };
  const enqueueProgressWrite = () => {
    const snapshot = [...logs];
    const telemetrySnapshot = trainingTelemetry
      ? structuredClone(trainingTelemetry)
      : null;
    progressWrite = progressWrite
      .then(async () => {
        const active = await prisma.stageAttempt.findUnique({ where: { id: attempt.id }, select: { status: true } });
        if (active?.status !== StageStatus.RUNNING) return;
        await prisma.$transaction([
          prisma.stageAttempt.update({
            where: { id: attempt.id },
            data: {
              workerId: "local-pipeline-worker",
              result: {
                state: "running",
                logs: snapshot,
                ...(telemetrySnapshot ? { training: telemetrySnapshot } : {}),
                updatedAt: new Date().toISOString(),
              },
            },
          }),
          ...(telemetrySnapshot
            ? [prisma.trainingRun.updateMany({
                where: { jobId: stage.jobId },
                data: { metrics: { telemetry: telemetrySnapshot } },
              })]
            : []),
        ]);
      })
      .catch((error) => console.error(`Unable to persist logs for stage ${stage.id}:`, error));
  };
  const scheduleProgress = (line: string) => {
    console.log(`${logPrefix} ${line}`);
    appendLog(line);
    if (trainingTelemetry) ingestTrainingLog(trainingTelemetry, line);
    if (progressTimer) return;
    progressTimer = setTimeout(() => {
      progressTimer = undefined;
      enqueueProgressWrite();
    }, 250);
  };
  const flushProgress = async () => {
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = undefined;
      enqueueProgressWrite();
    }
    await progressWrite;
  };
  try {
    scheduleProgress(`Worker claimed ${stage.stage.toLowerCase()}.`);
    await flushProgress();
    const suffix = extname(input.asset.name) || (stage.stage === PrismaPipelineStage.POSE_EXTRACTION ? ".mp4" : ".npz");
    const inputPath = join(workDir, `input${suffix}`);
    await writeFile(inputPath, await getArtifactBytes(input.storageKey));
    const manifestPath = join(workDir, "manifest.json");
    const bridgeArgs = ["scripts/run-motion-stage.py", "--stage", stage.stage.toLowerCase(), "--input", inputPath, "--work-dir", workDir, "--manifest", manifestPath, "--robot", stage.job.robotModel];
    if (stageTrainingConfig) bridgeArgs.push(
      "--training-num-envs", String(stageTrainingConfig.numEnvs),
      "--training-max-iterations", String(stageTrainingConfig.maxIterations),
      "--training-output-fps", String(stageTrainingConfig.outputFps),
      "--training-video-interval-steps", String(stageTrainingConfig.videoIntervalSteps),
      "--training-video-length-steps", String(stageTrainingConfig.videoLengthSteps),
      "--training-video-width", String(stageTrainingConfig.videoWidth),
      "--training-video-height", String(stageTrainingConfig.videoHeight),
    );
    if (stageTrainingConfig?.captureTrainingVideos) bridgeArgs.push("--training-capture-videos");
    activityTimer = setInterval(() => {
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      const silentSeconds = Math.round((Date.now() - lastChildOutputAt) / 1000);
      scheduleProgress(`Stage is still running (${elapsedSeconds}s elapsed; ${silentSeconds}s since adapter output).`);
    }, 30_000);
    await run("python3", bridgeArgs, (line) => {
      lastChildOutputAt = Date.now();
      scheduleProgress(line);
    }, {
      stageId: stage.id,
      signal,
      maxRuntimeMs: stageTrainingConfig ? stageTrainingConfig.maxRuntimeMinutes * 60_000 : undefined,
    });
    await flushProgress();
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as WorkerManifest;
    const outputs = await Promise.all(manifest.outputs.map((output) => storeOutput({ workspaceId: stage.job.workspaceId, jobId: stage.jobId, stage: stage.stage, output })));
    if (manifest.training && trainingTelemetry) {
      manifest.training.telemetry = completeTrainingTelemetry(trainingTelemetry, true);
    }
    const persistedResult = {
      worker: "local-pipeline-worker",
      summary: manifest.summary ?? "Stage completed.",
      logs,
      outputCount: outputs.length,
      ...(manifest.training
        ? { training: compactTrainingReport(manifest.training.report ?? manifest.training.telemetry) }
        : {}),
    };
    let completion: Awaited<ReturnType<typeof completeStage>> | undefined;
    for (let completionAttempt = 1; completionAttempt <= 3; completionAttempt += 1) {
      try {
        completion = await completeStage(
          stage.jobId,
          stage.id,
          persistedResult,
          outputs,
          manifest.training ? { training: manifest.training } : undefined,
        );
        break;
      } catch (error) {
        if (!completionCanRetry(error) || completionAttempt === 3) throw error;
        scheduleProgress(`Stage outputs are safe; retrying database finalization (${completionAttempt}/3).`);
        await pause(completionAttempt * 500);
      }
    }
    if (!completion) throw new Error("Stage output finalization did not return a result.");
    // Keep the pipeline moving after an approved review.  Do not auto-dispatch
    // future non-worker stages (evaluation/simulation), because they
    // intentionally do not have a local implementation yet.
    if (completion.state === "ready" && completion.nextStage && executableStages.has(completion.nextStage.stage)) {
      try {
        await dispatchNextStage(stage.jobId);
      } catch (error) {
        // The completed stage must remain successful if a follow-up dispatch is
        // blocked by a concurrent action or a budget rule.  The job stays READY
        // and the normal Dashboard action explains the remaining condition.
        console.warn(`RoboMotion could not auto-dispatch the next stage for ${stage.jobId}:`, error);
      }
    }
  } catch (error) {
    await flushProgress();
    const latest = await prisma.jobStage.findUnique({ where: { id: stage.id }, select: { status: true } });
    if ((error instanceof WorkerTerminationError && error.cancelled) || latest?.status === StageStatus.CANCELLED) {
      appendLog("Stage execution stopped after cancellation.");
      return;
    }
    const message = error instanceof Error ? error.message : "The local worker failed.";
    if (trainingTelemetry) {
      completeTrainingTelemetry(trainingTelemetry, false);
      await prisma.trainingRun.updateMany({
        where: { jobId: stage.jobId },
        data: { metrics: { telemetry: trainingTelemetry, failure: message } },
      });
    }
    await failStage(stage.jobId, stage.id, { retryable: true, errorCode: "LOCAL_WORKER_FAILED", message, logs, worker: "local-pipeline-worker" });
  } finally {
    if (progressTimer) clearTimeout(progressTimer);
    if (activityTimer) clearInterval(activityTimer);
    await progressWrite;
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function processLocalPipelineOnce(capabilities: ReadonlySet<PrismaPipelineStage> = executableStages, signal?: AbortSignal) {
  const stages = await prisma.jobStage.findMany({ where: { status: StageStatus.RUNNING, stage: { in: [...capabilities] } }, select: { id: true }, orderBy: { createdAt: "asc" }, take: 1 });
  if (stages[0]) await executeStage(stages[0].id, signal);
  return Boolean(stages[0]);
}
