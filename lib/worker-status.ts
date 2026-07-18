import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { prisma } from "@/lib/db";

export const localPipelineWorkerId = "local-pipeline-worker";
const staleAfterMs = 15_000;

export function localPipelineConfiguration() {
  const promptHmrRoot = process.env.ROBOMOTION_PROMPTHMR_ROOT;
  const gmrRoot = process.env.ROBOMOTION_GMR_ROOT;
  if (!promptHmrRoot) return "ROBOMOTION_PROMPTHMR_ROOT is not configured.";
  if (!existsSync(join(promptHmrRoot, "pipeline", "pipeline.py"))) return "The configured PromptHMR source is incomplete.";
  if (!gmrRoot) return "ROBOMOTION_GMR_ROOT is not configured.";
  if (!existsSync(join(gmrRoot, "general_motion_retargeting"))) return "The configured GMR source is incomplete.";
  if (!process.env.ROBOMOTION_PROMPTHMR_ENV) return "ROBOMOTION_PROMPTHMR_ENV is not configured.";
  if (!process.env.ROBOMOTION_GMR_ENV) return "ROBOMOTION_GMR_ENV is not configured.";
  try {
    const environments = JSON.parse(execFileSync("conda", ["env", "list", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as { envs?: string[] };
    for (const name of [process.env.ROBOMOTION_PROMPTHMR_ENV, process.env.ROBOMOTION_GMR_ENV]) {
      if (!environments.envs?.some((path) => path.endsWith(`/${name}`) || path.endsWith(`\\${name}`))) return `Conda environment \"${name}\" does not exist.`;
    }
  } catch { return "Conda is unavailable to the local GPU worker."; }
  return null;
}

export async function localPipelineWorkerAvailability() {
  const worker = await prisma.workerHeartbeat.findUnique({ where: { workerId: localPipelineWorkerId } });
  if (!worker) return { ready: false, status: "offline", detail: "No local GPU worker heartbeat has been received." };
  if (Date.now() - worker.lastSeenAt.getTime() > staleAfterMs) return { ready: false, status: "offline", detail: "The local GPU worker heartbeat is stale." };
  if (worker.status !== "ready") return { ready: false, status: worker.status, detail: worker.detail ?? "The local GPU worker is not ready." };
  return { ready: true, status: "ready", detail: "Local GPU worker is ready." };
}
