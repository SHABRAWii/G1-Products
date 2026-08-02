import { prisma } from "@/lib/db";
import {
  RunPodClient,
  runPodControllerLoop,
} from "@/lib/runpod-controller";

const apiKey = process.env.RUNPOD_API_KEY?.trim();
const podId = process.env.RUNPOD_POD_ID?.trim();
const workerId =
  process.env.ROBOMOTION_RUNPOD_CONTROLLER_ID ?? "control-runpod-controller";
const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => controller.abort());
}

async function main() {
  if (!apiKey || !podId) {
    throw new Error(
      "RUNPOD_API_KEY and RUNPOD_POD_ID are required by the RunPod controller.",
    );
  }
  const idleAfterMs =
    Number(process.env.RUNPOD_IDLE_AFTER_SECONDS ?? 900) * 1000;
  const pollMs = Number(process.env.RUNPOD_CONTROLLER_POLL_MS ?? 5000);
  if (!Number.isFinite(idleAfterMs) || idleAfterMs < 60_000) {
    throw new Error("RUNPOD_IDLE_AFTER_SECONDS must be at least 60.");
  }
  console.log(
    `RoboMotion RunPod controller started for ${podId}; idle stop is ${idleAfterMs / 1000}s.`,
  );
  await runPodControllerLoop({
    client: new RunPodClient(
      apiKey,
      podId,
      process.env.RUNPOD_API_BASE_URL ?? "https://rest.runpod.io/v1",
    ),
    workerId,
    idleAfterMs,
    targetImage: process.env.RUNPOD_GPU_IMAGE?.trim() || undefined,
    pollMs,
    signal: controller.signal,
  });
}

main()
  .catch(async (error) => {
    console.error(error);
    await prisma.workerHeartbeat.upsert({
      where: { workerId },
      update: {
        status: "unavailable",
        detail: error instanceof Error ? error.message : String(error),
      },
      create: {
        workerId,
        status: "unavailable",
        detail: error instanceof Error ? error.message : String(error),
      },
    });
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
