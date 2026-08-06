import { prisma } from "@/lib/db";
import {
  gpuWorkState,
  podImage,
  podIsRunning,
  RunPodClient,
  type RunPodPod,
} from "@/lib/runpod-controller";
import { getRunPodControlMode, setRunPodControlMode } from "@/lib/runpod-control-state";
import { deserializeWorkerDetail } from "@/lib/worker-capabilities";

const controllerId = process.env.ROBOMOTION_RUNPOD_CONTROLLER_ID ?? "control-runpod-controller";
const workerStaleAfterMs = 20_000;

export class RunPodControlError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
  }
}

function configuration() {
  const apiKey = process.env.RUNPOD_API_KEY?.trim();
  const podId = process.env.RUNPOD_POD_ID?.trim();
  return {
    apiKey,
    podId,
    targetImage: process.env.RUNPOD_GPU_IMAGE?.trim() || null,
    baseUrl: process.env.RUNPOD_API_BASE_URL ?? "https://rest.runpod.io/v1",
    idleAfterSeconds: Number(process.env.RUNPOD_IDLE_AFTER_SECONDS ?? 900),
  };
}

function clientOrThrow() {
  const config = configuration();
  if (!config.apiKey || !config.podId) {
    throw new RunPodControlError("RunPod control is not configured on this server.", 503);
  }
  return { config, client: new RunPodClient(config.apiKey, config.podId, config.baseUrl) };
}

function parseDetail(detail: string | null) {
  try {
    return detail ? JSON.parse(detail) as Record<string, unknown> : {};
  } catch {
    return { error: detail };
  }
}

function providerMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/not enough free gpu|gpu.*not.*available|no available gpu/i.test(message)) {
    return "RunPod cannot currently allocate this Pod's GPU. The controller will retry while work is queued.";
  }
  return message;
}

export async function getRunPodSnapshot() {
  const config = configuration();
  const [work, mode, controller, worker] = await Promise.all([
    gpuWorkState(),
    getRunPodControlMode(),
    prisma.workerHeartbeat.findUnique({ where: { workerId: controllerId } }),
    prisma.workerHeartbeat.findFirst({
      where: {
        workerId: { notIn: [controllerId, "runpod-manual-control"] },
        OR: [
          { detail: { contains: "pose_extraction" } },
          { detail: { contains: "robot_retargeting" } },
          { detail: { contains: "visualization" } },
          { detail: { contains: "training" } },
        ],
      },
      orderBy: { lastSeenAt: "desc" },
    }),
  ]);
  const controllerDetail = parseDetail(controller?.detail ?? null);
  const workerDetail = deserializeWorkerDetail(worker?.detail ?? null);
  const workerOnline = Boolean(
    worker
    && worker.status === "ready"
    && worker.lastSeenAt.getTime() >= Date.now() - workerStaleAfterMs,
  );

  let pod: RunPodPod | null = null;
  let providerError: string | null = null;
  if (config.apiKey && config.podId) {
    try {
      pod = await new RunPodClient(config.apiKey, config.podId, config.baseUrl).getPod();
    } catch (error) {
      providerError = providerMessage(error);
    }
  }

  return {
    configured: Boolean(config.apiKey && config.podId),
    pod: pod ? {
      id: pod.id,
      status: String(pod.desiredStatus ?? "UNKNOWN").toUpperCase(),
      running: podIsRunning(pod),
      image: podImage(pod),
    } : null,
    mode,
    idleAfterSeconds: Number.isFinite(config.idleAfterSeconds) ? config.idleAfterSeconds : 900,
    targetImage: config.targetImage,
    work: {
      pending: work.pendingGpuWork,
      activeStages: work.activeStages,
      readyStages: work.readyStages,
    },
    worker: worker ? {
      id: worker.workerId,
      online: workerOnline,
      status: workerOnline ? worker.status : "offline",
      lastSeenAt: worker.lastSeenAt.toISOString(),
      capabilities: [...workerDetail.capabilities].map((stage) => stage.toLowerCase()),
      gpu: workerDetail.gpu ?? null,
      error: workerDetail.error,
    } : null,
    controller: controller ? {
      online: controller.lastSeenAt.getTime() >= Date.now() - 60_000,
      status: controller.status,
      lastSeenAt: controller.lastSeenAt.toISOString(),
      action: typeof controllerDetail.action === "string" ? controllerDetail.action : null,
      error: typeof controllerDetail.error === "string" ? providerMessage(controllerDetail.error) : null,
    } : null,
    providerError,
  };
}

export async function startRunPod() {
  const { client } = clientOrThrow();
  await setRunPodControlMode("AUTO");
  try {
    await client.start();
  } catch (error) {
    throw new RunPodControlError(providerMessage(error), 503);
  }
  return getRunPodSnapshot();
}

export async function stopRunPod() {
  const { client } = clientOrThrow();
  const work = await gpuWorkState();
  if (work.activeStages > 0) {
    throw new RunPodControlError(
      `Cannot stop the GPU Pod while ${work.activeStages} stage${work.activeStages === 1 ? " is" : "s are"} running. Cancel the job first to preserve its outputs.`,
      409,
    );
  }
  await setRunPodControlMode("MANUAL_STOP");
  try {
    const pod = await client.getPod();
    if (podIsRunning(pod)) await client.stop();
  } catch (error) {
    throw new RunPodControlError(providerMessage(error), 503);
  }
  return getRunPodSnapshot();
}
