import { AssetApprovalStatus, AssetType, PipelineStage as PrismaPipelineStage, StageArtifactRole, StageStatus } from "@prisma/client";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { spawn } from "node:child_process";
import { prisma } from "@/lib/db";
import { getArtifactBytes, putArtifact } from "@/lib/object-storage";
import { completeStage, dispatchNextStage, failStage } from "@/lib/orchestration";

type WorkerOutput = { path: string; assetType: keyof typeof AssetType; schemaVersion: string; role: keyof typeof StageArtifactRole; contentType: string };
type WorkerManifest = { summary?: string; outputs: WorkerOutput[] };

const executableStages = new Set<PrismaPipelineStage>([PrismaPipelineStage.POSE_EXTRACTION, PrismaPipelineStage.ROBOT_RETARGETING, PrismaPipelineStage.VISUALIZATION]);

function run(command: string, args: string[], onLog: (line: string) => void) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env });
    let stderr = "";
    const emit = (chunk: Buffer) => chunk.toString().split(/\r?\n/).filter(Boolean).forEach(onLog);
    child.stdout.on("data", emit);
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); emit(chunk); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Worker bridge exited with code ${code}. ${stderr.slice(-1000)}`)));
  });
}

async function storeOutput(input: { workspaceId: string; jobId: string; stage: PrismaPipelineStage; output: WorkerOutput }) {
  const body = new Uint8Array(await readFile(input.output.path));
  const filename = basename(input.output.path);
  const asset = await prisma.asset.create({ data: { workspaceId: input.workspaceId, name: `${input.jobId} · ${input.stage.toLowerCase()} · ${filename}`, type: AssetType[input.output.assetType] } });
  const uploaded = await putArtifact({ workspaceId: input.workspaceId, assetId: asset.id, version: 1, filename, body, contentType: input.output.contentType });
  const version = await prisma.assetVersion.create({ data: { assetId: asset.id, version: 1, schemaVersion: input.output.schemaVersion, storageKey: uploaded.storageKey, contentType: input.output.contentType, byteSize: BigInt(uploaded.byteSize), checksum: uploaded.checksum, approvalStatus: AssetApprovalStatus.APPROVED, metadata: { jobId: input.jobId, stage: input.stage, worker: "local-pipeline-worker" } } });
  return { assetVersionId: version.id, role: StageArtifactRole[input.output.role] };
}

async function executeStage(stageId: string) {
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
  const writeProgress = async (line: string) => {
    logs.push(line);
    if (logs.length > 80) logs.shift();
    await prisma.stageAttempt.update({ where: { id: attempt.id }, data: { workerId: "local-pipeline-worker", result: { state: "running", logs, updatedAt: new Date().toISOString() } } });
  };
  try {
    await writeProgress(`Worker claimed ${stage.stage.toLowerCase()}.`);
    const suffix = extname(input.asset.name) || (stage.stage === PrismaPipelineStage.POSE_EXTRACTION ? ".mp4" : ".npz");
    const inputPath = join(workDir, `input${suffix}`);
    await writeFile(inputPath, await getArtifactBytes(input.storageKey));
    const manifestPath = join(workDir, "manifest.json");
    const bridgeArgs = ["scripts/run-motion-stage.py", "--stage", stage.stage.toLowerCase(), "--input", inputPath, "--work-dir", workDir, "--manifest", manifestPath, "--robot", stage.job.robotModel];
    await run("python3", bridgeArgs, (line) => { void writeProgress(line); });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as WorkerManifest;
    const outputs = await Promise.all(manifest.outputs.map((output) => storeOutput({ workspaceId: stage.job.workspaceId, jobId: stage.jobId, stage: stage.stage, output })));
    const completion = await completeStage(stage.jobId, stage.id, { worker: "local-pipeline-worker", summary: manifest.summary ?? "Stage completed.", logs, outputCount: outputs.length }, outputs);
    // Keep the pipeline moving after an approved review.  Do not auto-dispatch
    // future non-worker stages (training/evaluation/simulation), because they
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
    const message = error instanceof Error ? error.message : "The local worker failed.";
    await failStage(stage.jobId, stage.id, { retryable: true, errorCode: "LOCAL_WORKER_FAILED", message, logs, worker: "local-pipeline-worker" });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function processLocalPipelineOnce() {
  const stages = await prisma.jobStage.findMany({ where: { status: StageStatus.RUNNING, stage: { in: [...executableStages] } }, select: { id: true }, orderBy: { createdAt: "asc" }, take: 1 });
  if (stages[0]) await executeStage(stages[0].id);
  return Boolean(stages[0]);
}
