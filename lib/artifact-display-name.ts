const PIPELINE_STAGE_NAMES = new Set([
  "video_generation",
  "pose_extraction",
  "pose_review",
  "robot_retargeting",
  "visualization",
  "training",
  "policy_evaluation",
  "simulation_verification",
]);

const GENERATED_ID = /^[a-z][a-z0-9]{20,}$/i;

export function artifactDisplayName(name: string) {
  const parts = name
    .split(/\s+·\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (
    parts.length >= 3 &&
    GENERATED_ID.test(parts[0]) &&
    PIPELINE_STAGE_NAMES.has(parts[1])
  ) {
    return parts.slice(1).join(" · ");
  }

  return name;
}
