import { PipelineStage as PrismaPipelineStage } from "@prisma/client";
import { pipelineStages, type PipelineStage } from "@/lib/domain";

const profiles: Record<PipelineStage, { adapter: string; estimateMinor: number; estimateMinutes: number; storageBytes: number }> = {
  video_generation: { adapter: "video-provider", estimateMinor: 320, estimateMinutes: 9, storageBytes: 240_000_000 },
  pose_extraction: { adapter: "prompthmr", estimateMinor: 96, estimateMinutes: 12, storageBytes: 85_000_000 },
  pose_review: { adapter: "review-gate", estimateMinor: 2, estimateMinutes: 5, storageBytes: 3_000_000 },
  robot_retargeting: { adapter: "gmr", estimateMinor: 42, estimateMinutes: 8, storageBytes: 18_000_000 },
  visualization: { adapter: "visualization", estimateMinor: 25, estimateMinutes: 6, storageBytes: 70_000_000 },
  training: { adapter: "training", estimateMinor: 640, estimateMinutes: 180, storageBytes: 750_000_000 },
  policy_evaluation: { adapter: "policy-evaluation", estimateMinor: 155, estimateMinutes: 28, storageBytes: 35_000_000 },
  simulation_verification: { adapter: "simulation", estimateMinor: 210, estimateMinutes: 35, storageBytes: 140_000_000 },
};

const prismaStages: Record<PipelineStage, PrismaPipelineStage> = {
  video_generation: PrismaPipelineStage.VIDEO_GENERATION,
  pose_extraction: PrismaPipelineStage.POSE_EXTRACTION,
  pose_review: PrismaPipelineStage.POSE_REVIEW,
  robot_retargeting: PrismaPipelineStage.ROBOT_RETARGETING,
  visualization: PrismaPipelineStage.VISUALIZATION,
  training: PrismaPipelineStage.TRAINING,
  policy_evaluation: PrismaPipelineStage.POLICY_EVALUATION,
  simulation_verification: PrismaPipelineStage.SIMULATION_VERIFICATION,
};

export interface JobPlanInput {
  startStage: unknown;
  endStage: unknown;
}

export interface JobPlan {
  stages: { stage: PipelineStage; position: number; adapter: string; estimateMinor: number; estimateMinutes: number }[];
  estimateMinor: number;
  estimateMinutes: number;
  storageBytes: number;
  requiresPoseReview: boolean;
}

export function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === "string" && pipelineStages.includes(value as PipelineStage);
}

export function createJobPlan(input: JobPlanInput): JobPlan {
  if (!isPipelineStage(input.startStage) || !isPipelineStage(input.endStage)) throw new Error("startStage and endStage must be supported pipeline stages.");
  const start = pipelineStages.indexOf(input.startStage);
  const end = pipelineStages.indexOf(input.endStage);
  if (end < start) throw new Error("endStage must be at or after startStage.");
  const stages = pipelineStages.slice(start, end + 1).map((stage, position) => ({ stage, position, ...profiles[stage] }));
  return {
    stages,
    estimateMinor: stages.reduce((total, stage) => total + stage.estimateMinor, 0),
    estimateMinutes: stages.reduce((total, stage) => total + stage.estimateMinutes, 0),
    storageBytes: stages.reduce((total, stage) => total + profiles[stage.stage].storageBytes, 0),
    requiresPoseReview: stages.some((stage) => stage.stage === "pose_review"),
  };
}

export function toPrismaStage(stage: PipelineStage) {
  return prismaStages[stage];
}

export function fromPrismaStage(stage: PrismaPipelineStage): PipelineStage {
  return stage.toLowerCase() as PipelineStage;
}
