export const pipelineStages = [
  "video_generation",
  "pose_extraction",
  "pose_review",
  "robot_retargeting",
  "visualization",
  "training",
  "policy_evaluation",
  "simulation_verification",
] as const;

export type PipelineStage = (typeof pipelineStages)[number];

export const stageLabels: Record<PipelineStage, string> = {
  video_generation: "Video generation",
  pose_extraction: "Pose extraction",
  pose_review: "Pose review",
  robot_retargeting: "Robot retargeting",
  visualization: "Visualization",
  training: "Training",
  policy_evaluation: "Policy evaluation",
  simulation_verification: "Simulation verification",
};
