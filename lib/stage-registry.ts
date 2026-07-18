import { type PipelineStage, pipelineStages } from "@/lib/domain";

export type StageDefinition = {
  stage: PipelineStage;
  adapter: string;
  title: string;
  inputContracts: string[];
  outputContracts: string[];
  computeProfile: "provider" | "gpu" | "human" | "cpu";
  requiresApproval: boolean;
  retryPolicy: "safe" | "manual" | "never";
  implementation: "mvp-adapter" | "human-gate";
};

const definitions: Record<PipelineStage, StageDefinition> = {
  video_generation: { stage: "video_generation", adapter: "video-provider", title: "Video generation", inputContracts: ["generation.request/v1"], outputContracts: ["video.generated/v1"], computeProfile: "provider", requiresApproval: false, retryPolicy: "manual", implementation: "mvp-adapter" },
  pose_extraction: { stage: "pose_extraction", adapter: "prompthmr", title: "Pose extraction", inputContracts: ["video.source/v1", "video.generated/v1"], outputContracts: ["pose.smplx/v1", "pose.track-manifest/v1"], computeProfile: "gpu", requiresApproval: false, retryPolicy: "safe", implementation: "mvp-adapter" },
  pose_review: { stage: "pose_review", adapter: "review-gate", title: "Pose review", inputContracts: ["pose.smplx/v1"], outputContracts: ["pose.reviewed/v1"], computeProfile: "human", requiresApproval: true, retryPolicy: "never", implementation: "human-gate" },
  robot_retargeting: { stage: "robot_retargeting", adapter: "gmr", title: "Robot retargeting", inputContracts: ["pose.reviewed/v1", "pose.smplx/v1"], outputContracts: ["motion.robot/v1"], computeProfile: "gpu", requiresApproval: false, retryPolicy: "manual", implementation: "mvp-adapter" },
  visualization: { stage: "visualization", adapter: "visualization", title: "Visualization", inputContracts: ["pose.smplx/v1", "motion.robot/v1"], outputContracts: ["visualization/v1"], computeProfile: "cpu", requiresApproval: false, retryPolicy: "safe", implementation: "mvp-adapter" },
  training: { stage: "training", adapter: "training", title: "Training", inputContracts: ["dataset.training/v1"], outputContracts: ["policy.checkpoint/v1"], computeProfile: "gpu", requiresApproval: false, retryPolicy: "manual", implementation: "mvp-adapter" },
  policy_evaluation: { stage: "policy_evaluation", adapter: "policy-evaluation", title: "Policy evaluation", inputContracts: ["policy.checkpoint/v1"], outputContracts: ["evaluation.report/v1"], computeProfile: "gpu", requiresApproval: false, retryPolicy: "safe", implementation: "mvp-adapter" },
  simulation_verification: { stage: "simulation_verification", adapter: "simulation", title: "Simulation verification", inputContracts: ["motion.robot/v1", "policy.checkpoint/v1"], outputContracts: ["simulation.evidence/v1"], computeProfile: "gpu", requiresApproval: true, retryPolicy: "manual", implementation: "mvp-adapter" },
};

export function getStageDefinition(stage: PipelineStage) {
  return definitions[stage];
}

export function listStageDefinitions() {
  return pipelineStages.map((stage) => definitions[stage]);
}
