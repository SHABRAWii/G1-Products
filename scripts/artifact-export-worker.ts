import { prisma } from "@/lib/db";
import {
  processArtifactExportOnce,
  recoverStaleArtifactExports,
} from "@/lib/artifact-exports";

const workerId = process.env.ROBOMOTION_EXPORT_WORKER_ID ?? "control-artifact-export-worker";
const pollMs = Number(process.env.ROBOMOTION_EXPORT_POLL_MS ?? 2000);
const controller = new AbortController();
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    controller.abort();
  });
}

async function heartbeat(status = "ready", detail?: string) {
  await prisma.workerHeartbeat.upsert({
    where: { workerId },
    update: { status, detail: detail ?? JSON.stringify({ capabilities: ["artifact_export"] }) },
    create: { workerId, status, detail: detail ?? JSON.stringify({ capabilities: ["artifact_export"] }) },
  });
}

async function main() {
  await recoverStaleArtifactExports();
  console.log(`RoboMotion artifact export worker ${workerId} started.`);
  while (!stopping) {
    try {
      await heartbeat();
      await processArtifactExportOnce(workerId, controller.signal);
    } catch (error) {
      console.error(error);
      await heartbeat("unavailable", error instanceof Error ? error.message : String(error));
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  console.log("RoboMotion artifact export worker stopped.");
}

void main();
