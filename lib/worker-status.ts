import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PipelineStage } from "@prisma/client";
import { prisma } from "@/lib/db";
import { deserializeWorkerDetail, parseWorkerStages, workerRequirements } from "@/lib/worker-capabilities";

export const localPipelineWorkerId = process.env.ROBOMOTION_WORKER_ID ?? "local-pipeline-worker";
const staleAfterMs = 15_000;

export function localPipelineConfiguration(stages = parseWorkerStages()) {
  const required = workerRequirements(stages);
  const promptHmrRoot = process.env.ROBOMOTION_PROMPTHMR_ROOT;
  const gmrRoot = process.env.ROBOMOTION_GMR_ROOT;
  const trainRoot = process.env.ROBOMOTION_TRAIN_ROOT;

  const requiredEnvs: string[] = [];
  if (required.promptHmr) {
    if (!promptHmrRoot) return "ROBOMOTION_PROMPTHMR_ROOT is required by this worker's pose_extraction capability.";
    if (!existsSync(join(promptHmrRoot, "pipeline", "pipeline.py"))) return "The configured PromptHMR source is incomplete.";
    if (!process.env.ROBOMOTION_PROMPTHMR_ENV) return "ROBOMOTION_PROMPTHMR_ENV is not configured.";
    requiredEnvs.push(process.env.ROBOMOTION_PROMPTHMR_ENV);
  }
  if (required.gmr) {
    if (!gmrRoot) return "ROBOMOTION_GMR_ROOT is required by this worker's configured capabilities.";
    if (!existsSync(join(gmrRoot, "general_motion_retargeting"))) return "The configured GMR source is incomplete.";
    if (!process.env.ROBOMOTION_GMR_ENV) return "ROBOMOTION_GMR_ENV is not configured.";
    requiredEnvs.push(process.env.ROBOMOTION_GMR_ENV);
  }
  if (required.training) {
    if (!trainRoot) return "ROBOMOTION_TRAIN_ROOT is required by this worker's training capability.";
    if (!existsSync(join(trainRoot, "scripts", "train.py"))) return "The configured unitree_rl_mjlab source is incomplete.";
    const trainingPython = process.env.ROBOMOTION_TRAIN_PYTHON;
    if (trainingPython) {
      if (!existsSync(trainingPython)) return "ROBOMOTION_TRAIN_PYTHON does not exist.";
    } else {
      if (!process.env.ROBOMOTION_TRAIN_ENV) return "ROBOMOTION_TRAIN_ENV is not configured.";
      requiredEnvs.push(process.env.ROBOMOTION_TRAIN_ENV);
    }
  }
  try {
    const environments = JSON.parse(execFileSync("conda", ["env", "list", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as { envs?: string[] };
    for (const name of requiredEnvs) {
      if (!environments.envs?.some((path) => path.endsWith(`/${name}`) || path.endsWith(`\\${name}`))) return `Conda environment \"${name}\" does not exist.`;
    }
  } catch { return "Conda is unavailable to the local GPU worker."; }
  return null;
}

export async function localPipelineWorkerAvailability(stage?: PipelineStage) {
  const workers = await prisma.workerHeartbeat.findMany();
  const fresh = workers.filter((worker) => Date.now() - worker.lastSeenAt.getTime() <= staleAfterMs);
  const capable = fresh.filter((worker) => {
    const detail = deserializeWorkerDetail(worker.detail);
    return worker.status === "ready" && (!stage || detail.capabilities.has(stage));
  });
  if (capable.length) {
    return { ready: true, status: "ready", detail: stage ? `A ready worker supports ${stage.toLowerCase()}.` : "At least one local GPU worker is ready." };
  }
  if (!workers.length) return { ready: false, status: "offline", detail: "No local GPU worker heartbeat has been received." };
  if (!fresh.length) return { ready: false, status: "offline", detail: "All local GPU worker heartbeats are stale." };
  if (stage) return { ready: false, status: "unavailable", detail: `No ready worker advertises the ${stage.toLowerCase()} capability.` };
  return { ready: false, status: "unavailable", detail: "No local GPU worker is ready." };
}
