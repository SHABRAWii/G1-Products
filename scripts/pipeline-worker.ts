import { processLocalPipelineOnce } from "@/lib/local-pipeline-worker";
import { localGpuTelemetry, localPipelineConfiguration, localPipelineWorkerId } from "@/lib/worker-status";
import { parseWorkerStages, serializeWorkerDetail } from "@/lib/worker-capabilities";
import { prisma } from "@/lib/db";

const intervalMs = Number(process.env.ROBOMOTION_WORKER_POLL_MS ?? 2500);
let stopping = false;
const controller = new AbortController();
const capabilities = parseWorkerStages();

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; controller.abort(); });

async function recordHeartbeat(configurationError: string | null) {
  const detail = serializeWorkerDetail(capabilities, configurationError, localGpuTelemetry());
  await prisma.workerHeartbeat.upsert({
    where: { workerId: localPipelineWorkerId },
    update: { status: configurationError ? "unavailable" : "ready", detail },
    create: { workerId: localPipelineWorkerId, status: configurationError ? "unavailable" : "ready", detail },
  });
}

async function main() {
  console.log(`RoboMotion worker ${localPipelineWorkerId} started for ${[...capabilities].map((stage) => stage.toLowerCase()).join(", ")} (poll ${intervalMs}ms).`);
  while (!stopping) {
    const configurationError = localPipelineConfiguration(capabilities);
    await recordHeartbeat(configurationError);
    // PromptHMR and GMR can run for minutes. Keep the dashboard heartbeat fresh
    // while that real work is in progress so "offline" always means offline.
    const heartbeat = setInterval(() => { void recordHeartbeat(configurationError).catch((error) => console.error("Unable to update worker heartbeat:", error)); }, Math.min(intervalMs, 5000));
    try { if (!configurationError) await processLocalPipelineOnce(capabilities, controller.signal); } catch (error) { console.error(error); } finally { clearInterval(heartbeat); }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  console.log("RoboMotion local pipeline worker stopped.");
}

void main();
