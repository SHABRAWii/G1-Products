import { processLocalPipelineOnce } from "@/lib/local-pipeline-worker";
import { localPipelineConfiguration, localPipelineWorkerId } from "@/lib/worker-status";
import { prisma } from "@/lib/db";

const intervalMs = Number(process.env.ROBOMOTION_WORKER_POLL_MS ?? 2500);
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });

async function recordHeartbeat(configurationError: string | null) {
  await prisma.workerHeartbeat.upsert({
    where: { workerId: localPipelineWorkerId },
    update: { status: configurationError ? "unavailable" : "ready", detail: configurationError },
    create: { workerId: localPipelineWorkerId, status: configurationError ? "unavailable" : "ready", detail: configurationError },
  });
}

async function main() {
  console.log(`RoboMotion local pipeline worker started (poll ${intervalMs}ms).`);
  while (!stopping) {
    const configurationError = localPipelineConfiguration();
    await recordHeartbeat(configurationError);
    // PromptHMR and GMR can run for minutes. Keep the dashboard heartbeat fresh
    // while that real work is in progress so "offline" always means offline.
    const heartbeat = setInterval(() => { void recordHeartbeat(configurationError).catch((error) => console.error("Unable to update worker heartbeat:", error)); }, Math.min(intervalMs, 5000));
    try { if (!configurationError) await processLocalPipelineOnce(); } catch (error) { console.error(error); } finally { clearInterval(heartbeat); }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  console.log("RoboMotion local pipeline worker stopped.");
}

void main();
