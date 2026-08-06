import { PipelineStage } from "@prisma/client";

export const executablePipelineStages = [
  PipelineStage.POSE_EXTRACTION,
  PipelineStage.ROBOT_RETARGETING,
  PipelineStage.VISUALIZATION,
  PipelineStage.TRAINING,
] as const;

export function isExecutablePipelineStage(stage: PipelineStage | undefined): stage is (typeof executablePipelineStages)[number] {
  return Boolean(stage && executablePipelineStages.includes(stage as (typeof executablePipelineStages)[number]));
}

const aliases = new Map<string, PipelineStage>([
  ["pose_extraction", PipelineStage.POSE_EXTRACTION],
  ["robot_retargeting", PipelineStage.ROBOT_RETARGETING],
  ["visualization", PipelineStage.VISUALIZATION],
  ["training", PipelineStage.TRAINING],
]);

export function parseWorkerStages(value = process.env.ROBOMOTION_WORKER_STAGES ?? "") {
  const requested = value.trim()
    ? value.split(",").map((stage) => stage.trim().toLowerCase()).filter(Boolean)
    : executablePipelineStages.map((stage) => stage.toLowerCase());
  const resolved = requested.map((stage) => aliases.get(stage));
  const invalid = requested.filter((_stage, index) => !resolved[index]);
  if (invalid.length) throw new Error(`Unsupported ROBOMOTION_WORKER_STAGES value(s): ${invalid.join(", ")}.`);
  return new Set(resolved as PipelineStage[]);
}

export function workerRequirements(stages: ReadonlySet<PipelineStage>) {
  return {
    promptHmr: stages.has(PipelineStage.POSE_EXTRACTION),
    gmr: stages.has(PipelineStage.ROBOT_RETARGETING) || stages.has(PipelineStage.VISUALIZATION),
    training: stages.has(PipelineStage.TRAINING),
  };
}

export type GpuTelemetry = {
  name: string;
  utilizationPercent: number;
  memoryUsedMiB: number;
  memoryTotalMiB: number;
  powerDrawWatts: number;
  powerLimitWatts: number;
  temperatureC: number;
};

export function serializeWorkerDetail(stages: ReadonlySet<PipelineStage>, error: string | null, gpu?: GpuTelemetry | null) {
  return JSON.stringify({ capabilities: [...stages].map((stage) => stage.toLowerCase()), error, gpu: gpu ?? null });
}

export function deserializeWorkerDetail(detail: string | null) {
  if (!detail) return {
    capabilities: new Set<PipelineStage>(executablePipelineStages),
    error: null as string | null,
    gpu: null as GpuTelemetry | null,
  };
  try {
    const parsed = JSON.parse(detail) as { capabilities?: string[]; error?: string | null; gpu?: GpuTelemetry | null };
    if (!Array.isArray(parsed.capabilities) || !parsed.capabilities.length) {
      return { capabilities: new Set<PipelineStage>(), error: parsed.error ?? "Worker did not advertise any capabilities.", gpu: parsed.gpu ?? null };
    }
    return { capabilities: parseWorkerStages(parsed.capabilities.join(",")), error: parsed.error ?? null, gpu: parsed.gpu ?? null };
  } catch {
    return { capabilities: new Set<PipelineStage>(executablePipelineStages), error: detail, gpu: null };
  }
}
