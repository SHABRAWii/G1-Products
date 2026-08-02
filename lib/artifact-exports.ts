import {
  ArtifactExportKind,
  ArtifactExportStatus,
  AssetApprovalStatus,
  AssetType,
  Prisma,
  StageArtifactRole,
} from "@prisma/client";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { prisma } from "@/lib/db";
import { getArtifactBytes, putArtifactFile } from "@/lib/object-storage";

type Database = Prisma.TransactionClient | typeof prisma;

export const digitalTwinExportDefaults = {
  width: 1920,
  height: 1080,
  fps: 60,
  schemaVersion: "visualization.robot-digital-twin/v1",
} as const;

export async function queueDigitalTwinExport(
  tx: Database,
  input: {
    workspaceId: string;
    jobId: string;
    jobStageId: string;
    sourceSceneAssetVersionId: string;
  },
) {
  return tx.artifactExport.upsert({
    where: {
      jobStageId_kind: {
        jobStageId: input.jobStageId,
        kind: ArtifactExportKind.DIGITAL_TWIN_MP4,
      },
    },
    update: {
      status: ArtifactExportStatus.QUEUED,
      sourceSceneAssetVersionId: input.sourceSceneAssetVersionId,
      outputAssetVersionId: null,
      progressCurrent: 0,
      progressTotal: null,
      workerId: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
      config: digitalTwinExportDefaults,
    },
    create: {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      jobStageId: input.jobStageId,
      kind: ArtifactExportKind.DIGITAL_TWIN_MP4,
      sourceSceneAssetVersionId: input.sourceSceneAssetVersionId,
      config: digitalTwinExportDefaults,
    },
  });
}

export async function retryArtifactExport(exportId: string) {
  const artifactExport = await prisma.artifactExport.findUnique({ where: { id: exportId } });
  if (!artifactExport) throw new Error("Artifact export was not found.");
  if (
    artifactExport.status !== ArtifactExportStatus.FAILED
    && artifactExport.status !== ArtifactExportStatus.CANCELLED
  ) {
    throw new Error("Only failed or cancelled artifact exports can be retried.");
  }
  return prisma.artifactExport.update({
    where: { id: exportId },
    data: {
      status: ArtifactExportStatus.QUEUED,
      progressCurrent: 0,
      progressTotal: null,
      workerId: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
    },
  });
}

function runCapture(
  args: string[],
  onProgress: (current: number, total: number) => void,
  signal?: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let pending = "";
    const parse = (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const match = line.match(/Three\.js capture\s+(\d+)\/(\d+)\s+frames/i);
        if (match) onProgress(Number(match[1]), Number(match[2]));
      }
    };
    child.stdout.on("data", parse);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (code === 0) resolve();
      else reject(new Error(`Digital-twin capture exited with code ${code}. ${stderr.slice(-2000)}`));
    });
  });
}

async function publishDigitalTwinMp4(input: {
  exportId: string;
  workspaceId: string;
  jobId: string;
  jobStageId: string;
  outputPath: string;
  completedFrames: number;
}) {
  const filename = "unitree_g1_digital-twin.mp4";
  const asset = await prisma.asset.create({
    data: {
      workspaceId: input.workspaceId,
      name: `visualization · ${filename}`,
      type: AssetType.VISUALIZATION,
    },
  });
  const uploaded = await putArtifactFile({
    workspaceId: input.workspaceId,
    assetId: asset.id,
    version: 1,
    filename,
    path: input.outputPath,
    contentType: "video/mp4",
  });
  const version = await prisma.assetVersion.create({
    data: {
      assetId: asset.id,
      version: 1,
      schemaVersion: digitalTwinExportDefaults.schemaVersion,
      storageKey: uploaded.storageKey,
      contentType: "video/mp4",
      byteSize: BigInt(uploaded.byteSize),
      checksum: uploaded.checksum,
      approvalStatus: AssetApprovalStatus.APPROVED,
      metadata: {
        jobId: input.jobId,
        stage: "VISUALIZATION",
        exportId: input.exportId,
        worker: "artifact-export-worker",
      },
    },
  });
  await prisma.$transaction([
    prisma.stageArtifact.create({
      data: {
        jobStageId: input.jobStageId,
        assetVersionId: version.id,
        role: StageArtifactRole.PREVIEW,
      },
    }),
    prisma.artifactExport.update({
      where: { id: input.exportId },
      data: {
        status: ArtifactExportStatus.SUCCEEDED,
        outputAssetVersionId: version.id,
        progressCurrent: input.completedFrames,
        progressTotal: input.completedFrames,
        finishedAt: new Date(),
        errorMessage: null,
      },
    }),
    prisma.jobEvent.create({
      data: {
        jobId: input.jobId,
        type: "artifact_export_succeeded",
        stage: "VISUALIZATION",
        message: "The downloadable Unitree G1 digital-twin MP4 is ready.",
        metadata: { exportId: input.exportId, assetVersionId: version.id },
      },
    }),
  ]);
  return version;
}

export async function recoverStaleArtifactExports(staleAfterMs = 10 * 60_000) {
  return prisma.artifactExport.updateMany({
    where: {
      status: ArtifactExportStatus.RUNNING,
      updatedAt: { lt: new Date(Date.now() - staleAfterMs) },
    },
    data: {
      status: ArtifactExportStatus.QUEUED,
      workerId: null,
      errorMessage: "The previous export worker stopped before completion; the export was requeued.",
      startedAt: null,
    },
  });
}

export async function processArtifactExportOnce(
  workerId = process.env.ROBOMOTION_EXPORT_WORKER_ID ?? "control-artifact-export-worker",
  signal?: AbortSignal,
) {
  const queued = await prisma.artifactExport.findFirst({
    where: { status: ArtifactExportStatus.QUEUED },
    orderBy: { createdAt: "asc" },
    include: { sourceSceneAssetVersion: true },
  });
  if (!queued) return false;
  const claimed = await prisma.artifactExport.updateMany({
    where: { id: queued.id, status: ArtifactExportStatus.QUEUED },
    data: {
      status: ArtifactExportStatus.RUNNING,
      workerId,
      attempts: { increment: 1 },
      startedAt: new Date(),
      finishedAt: null,
      errorMessage: null,
    },
  });
  if (!claimed.count) return true;

  const workDir = await mkdtemp(join(tmpdir(), `robomotion-export-${queued.id}-`));
  const scenePath = join(workDir, "scene.json");
  const outputPath = join(workDir, "unitree_g1_digital-twin.mp4");
  let progressWrite = Promise.resolve();
  try {
    await writeFile(scenePath, await getArtifactBytes(queued.sourceSceneAssetVersion.storageKey));
    const modelRoot = join(
      process.env.ROBOMOTION_MODEL_CACHE ?? join(process.cwd(), ".robomotion", "cache"),
      "unitree-g1-web",
    );
    const captureArgs = [
      join(process.cwd(), "scripts", "capture-digital-twin.mjs"),
      "--scene", scenePath,
      "--model-root", modelRoot,
      "--output", outputPath,
      "--fps", String(digitalTwinExportDefaults.fps),
      "--width", String(digitalTwinExportDefaults.width),
      "--height", String(digitalTwinExportDefaults.height),
      "--dashboard-url", process.env.ROBOMOTION_DASHBOARD_URL ?? "http://127.0.0.1:3000",
    ];
    await runCapture(captureArgs, (current, total) => {
      progressWrite = progressWrite.then(() => prisma.artifactExport.updateMany({
        where: { id: queued.id, status: ArtifactExportStatus.RUNNING },
        data: { progressCurrent: current, progressTotal: total },
      })).then(() => undefined);
    }, signal);
    await progressWrite;
    const completed = await prisma.artifactExport.findUnique({
      where: { id: queued.id },
      select: { progressCurrent: true, progressTotal: true },
    });
    await publishDigitalTwinMp4({
      exportId: queued.id,
      workspaceId: queued.workspaceId,
      jobId: queued.jobId,
      jobStageId: queued.jobStageId,
      outputPath,
      completedFrames: completed?.progressTotal ?? completed?.progressCurrent ?? 0,
    });
  } catch (error) {
    await progressWrite;
    const message = error instanceof Error ? error.message : "The digital-twin export failed.";
    await prisma.$transaction([
      prisma.artifactExport.update({
        where: { id: queued.id },
        data: {
          status: signal?.aborted ? ArtifactExportStatus.CANCELLED : ArtifactExportStatus.FAILED,
          errorMessage: message,
          finishedAt: new Date(),
        },
      }),
      prisma.jobEvent.create({
        data: {
          jobId: queued.jobId,
          type: "artifact_export_failed",
          stage: "VISUALIZATION",
          message: "The pipeline completed, but the downloadable digital-twin MP4 export failed.",
          metadata: { exportId: queued.id, error: message },
        },
      }),
    ]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  return true;
}

export function artifactExportDisplayName(kind: ArtifactExportKind) {
  return kind === ArtifactExportKind.DIGITAL_TWIN_MP4
    ? basename("unitree_g1_digital-twin.mp4")
    : "artifact-export";
}
