import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { prisma } from "@/lib/db";

export const localPipelineWorkerId = "local-pipeline-worker";
const staleAfterMs = 15_000;

// Each model root is only validated when it's actually configured, so a
// worker only serving a subset of stages (e.g. training only, with no
// PromptHMR/GMR installed) can still report ready.
export function localPipelineConfiguration() {
  const promptHmrRoot = process.env.ROBOMOTION_PROMPTHMR_ROOT;
  const gmrRoot = process.env.ROBOMOTION_GMR_ROOT;
  const trainRoot = process.env.ROBOMOTION_TRAIN_ROOT;
  if (!promptHmrRoot && !gmrRoot && !trainRoot) return "No pipeline model environment is configured (set ROBOMOTION_PROMPTHMR_ROOT, ROBOMOTION_GMR_ROOT, and/or ROBOMOTION_TRAIN_ROOT).";

  const requiredEnvs: string[] = [];
  if (promptHmrRoot) {
    if (!existsSync(join(promptHmrRoot, "pipeline", "pipeline.py"))) return "The configured PromptHMR source is incomplete.";
    if (!process.env.ROBOMOTION_PROMPTHMR_ENV) return "ROBOMOTION_PROMPTHMR_ENV is not configured.";
    requiredEnvs.push(process.env.ROBOMOTION_PROMPTHMR_ENV);
  }
  if (gmrRoot) {
    if (!existsSync(join(gmrRoot, "general_motion_retargeting"))) return "The configured GMR source is incomplete.";
    if (!process.env.ROBOMOTION_GMR_ENV) return "ROBOMOTION_GMR_ENV is not configured.";
    requiredEnvs.push(process.env.ROBOMOTION_GMR_ENV);
  }
  if (trainRoot) {
    if (!existsSync(join(trainRoot, "scripts", "train.py"))) return "The configured unitree_rl_mjlab source is incomplete.";
    if (!process.env.ROBOMOTION_TRAIN_ENV) return "ROBOMOTION_TRAIN_ENV is not configured.";
    requiredEnvs.push(process.env.ROBOMOTION_TRAIN_ENV);
  }
  try {
    const environments = JSON.parse(execFileSync("conda", ["env", "list", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as { envs?: string[] };
    for (const name of requiredEnvs) {
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
