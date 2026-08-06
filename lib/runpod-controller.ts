import { JobStatus, PipelineStage, StageStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { dispatchNextStage } from "@/lib/orchestration";
import { getRunPodControlMode } from "@/lib/runpod-control-state";

export const gpuStages = [
  PipelineStage.POSE_EXTRACTION,
  PipelineStage.ROBOT_RETARGETING,
  PipelineStage.VISUALIZATION,
  PipelineStage.TRAINING,
] as const;

export type RunPodPod = {
  id: string;
  desiredStatus?: string | null;
  image?: string | null;
  imageName?: string | null;
};

export type RunPodControllerDecision =
  | "START"
  | "STOP"
  | "UPDATE"
  | "DISPATCH"
  | "WAIT";

export function decideRunPodAction(input: {
  pendingGpuWork: boolean;
  readyWorker: boolean;
  podRunning: boolean;
  idleExpired: boolean;
  imageUpdatePending: boolean;
  manualStop?: boolean;
}): RunPodControllerDecision {
  if (input.manualStop) {
    if (input.podRunning) return "STOP";
    if (input.imageUpdatePending) return "UPDATE";
    return "WAIT";
  }
  if (input.pendingGpuWork && input.readyWorker) return "DISPATCH";
  if (
    input.pendingGpuWork
    && !input.podRunning
    && input.imageUpdatePending
  ) {
    return "UPDATE";
  }
  if (input.pendingGpuWork && !input.podRunning) return "START";
  if (!input.pendingGpuWork && !input.podRunning && input.imageUpdatePending) {
    return "UPDATE";
  }
  if (!input.pendingGpuWork && input.podRunning && input.idleExpired) return "STOP";
  return "WAIT";
}

export class RunPodClient {
  constructor(
    private readonly apiKey: string,
    private readonly podId: string,
    private readonly baseUrl = "https://rest.runpod.io/v1",
  ) {}

  private async request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `RunPod ${init.method ?? "GET"} ${path} failed (${response.status}): ${detail.slice(0, 1000)}`,
      );
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async getPod() {
    return this.request(`/pods/${encodeURIComponent(this.podId)}`) as Promise<RunPodPod>;
  }

  async start() {
    await this.request(`/pods/${encodeURIComponent(this.podId)}/start`, {
      method: "POST",
    });
  }

  async stop() {
    await this.request(`/pods/${encodeURIComponent(this.podId)}/stop`, {
      method: "POST",
    });
  }

  async updateImage(imageName: string) {
    await this.request(`/pods/${encodeURIComponent(this.podId)}`, {
      method: "PATCH",
      body: JSON.stringify({ imageName }),
    });
  }
}

export function podIsRunning(pod: RunPodPod) {
  return String(pod.desiredStatus ?? "").toUpperCase() === "RUNNING";
}

export function podImage(pod: RunPodPod) {
  return pod.imageName ?? pod.image ?? null;
}

export async function gpuWorkState() {
  const [pendingGpuWork, readyWorker, queuedJobs, activeStages, readyStages] = await Promise.all([
    prisma.jobStage.count({
      where: {
        stage: { in: [...gpuStages] },
        status: { in: [StageStatus.READY, StageStatus.RUNNING] },
      },
    }),
    prisma.workerHeartbeat.findFirst({
      where: {
        status: "ready",
        lastSeenAt: { gte: new Date(Date.now() - 20_000) },
        OR: gpuStages.map((stage) => ({
          detail: { contains: stage.toLowerCase() },
        })),
      },
      select: { workerId: true },
    }),
    prisma.job.findMany({
      where: {
        status: {
          in: [
            JobStatus.QUEUED,
            JobStatus.DISPATCHING,
            JobStatus.RUNNING,
          ],
        },
        stages: {
          some: {
            stage: { in: [...gpuStages] },
            status: StageStatus.READY,
          },
        },
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: 20,
    }),
    prisma.jobStage.count({
      where: {
        stage: { in: [...gpuStages] },
        status: StageStatus.RUNNING,
      },
    }),
    prisma.jobStage.count({
      where: {
        stage: { in: [...gpuStages] },
        status: StageStatus.READY,
      },
    }),
  ]);
  return {
    pendingGpuWork: pendingGpuWork > 0,
    readyWorker: Boolean(readyWorker),
    queuedJobs,
    activeStages,
    readyStages,
  };
}

async function dispatchQueuedJobs(jobIds: Array<{ id: string }>) {
  for (const job of jobIds) {
    try {
      await dispatchNextStage(job.id);
    } catch (error) {
      console.error(`Unable to dispatch queued job ${job.id}:`, error);
    }
  }
}

export async function runPodControllerLoop(input: {
  client: RunPodClient;
  workerId: string;
  idleAfterMs: number;
  targetImage?: string;
  signal?: AbortSignal;
  pollMs?: number;
  retryMs?: number;
}) {
  let idleSince: number | null = null;
  const pollMs = input.pollMs ?? 5000;
  const retryMs = input.retryMs ?? Math.max(pollMs, 30_000);
  while (!input.signal?.aborted) {
    let nextPollMs = pollMs;
    try {
      const [pod, work, controlMode] = await Promise.all([
        input.client.getPod(),
        gpuWorkState(),
        getRunPodControlMode(),
      ]);
      const running = podIsRunning(pod);
      if (work.pendingGpuWork) idleSince = null;
      else if (running && idleSince === null) idleSince = Date.now();
      const imageUpdatePending = Boolean(
        input.targetImage && podImage(pod) !== input.targetImage,
      );
      const action = decideRunPodAction({
        pendingGpuWork: work.pendingGpuWork,
        readyWorker: work.readyWorker,
        podRunning: running,
        idleExpired: idleSince !== null && Date.now() - idleSince >= input.idleAfterMs,
        imageUpdatePending,
        manualStop: controlMode === "MANUAL_STOP",
      });
      if (action === "START") {
        console.log("GPU work is ready; starting the configured RunPod Pod.");
        await input.client.start();
      } else if (action === "UPDATE" && input.targetImage) {
        console.log(`Updating stopped RunPod Pod to ${input.targetImage}.`);
        await input.client.updateImage(input.targetImage);
      } else if (action === "STOP") {
        console.log("GPU work is idle; stopping the configured RunPod Pod.");
        await input.client.stop();
        idleSince = null;
      } else if (action === "DISPATCH") {
        await dispatchQueuedJobs(work.queuedJobs);
      }
      await prisma.workerHeartbeat.upsert({
        where: { workerId: input.workerId },
        update: {
          status: "ready",
          detail: JSON.stringify({
            capability: "runpod_control",
            podId: pod.id,
            podRunning: running,
            action,
            controlMode,
            pendingGpuWork: work.pendingGpuWork,
            readyWorker: work.readyWorker,
            activeStages: work.activeStages,
            readyStages: work.readyStages,
            targetImage: input.targetImage ?? null,
            currentImage: podImage(pod),
          }),
        },
        create: {
          workerId: input.workerId,
          status: "ready",
          detail: JSON.stringify({
            capability: "runpod_control",
            podId: pod.id,
            podRunning: running,
            action,
            controlMode,
          }),
        },
      });
    } catch (error) {
      nextPollMs = retryMs;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`RunPod controller cycle failed; retrying in ${retryMs}ms:`, error);
      try {
        await prisma.workerHeartbeat.upsert({
          where: { workerId: input.workerId },
          update: {
            status: "degraded",
            detail: JSON.stringify({
              capability: "runpod_control",
              error: message,
              retryAfterMs: retryMs,
            }),
          },
          create: {
            workerId: input.workerId,
            status: "degraded",
            detail: JSON.stringify({
              capability: "runpod_control",
              error: message,
              retryAfterMs: retryMs,
            }),
          },
        });
      } catch (heartbeatError) {
        console.error("Unable to record the degraded RunPod controller state:", heartbeatError);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, nextPollMs));
  }
}
