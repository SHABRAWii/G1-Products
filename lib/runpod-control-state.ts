import { prisma } from "@/lib/db";

export const runPodControlStateWorkerId = "runpod-manual-control";

export type RunPodControlMode = "AUTO" | "MANUAL_STOP";

export async function getRunPodControlMode(): Promise<RunPodControlMode> {
  const state = await prisma.workerHeartbeat.findUnique({
    where: { workerId: runPodControlStateWorkerId },
    select: { status: true },
  });
  return state?.status === "manual_stop" ? "MANUAL_STOP" : "AUTO";
}

export async function setRunPodControlMode(mode: RunPodControlMode) {
  await prisma.workerHeartbeat.upsert({
    where: { workerId: runPodControlStateWorkerId },
    update: {
      status: mode === "MANUAL_STOP" ? "manual_stop" : "auto",
      detail: JSON.stringify({ capability: "runpod_manual_control", mode }),
    },
    create: {
      workerId: runPodControlStateWorkerId,
      status: mode === "MANUAL_STOP" ? "manual_stop" : "auto",
      detail: JSON.stringify({ capability: "runpod_manual_control", mode }),
    },
  });
  return mode;
}
