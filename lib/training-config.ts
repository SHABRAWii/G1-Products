export type TrainingStageConfig = {
  numEnvs: number;
  maxIterations: number;
  outputFps: number;
  maxRuntimeMinutes: number;
  captureTrainingVideos: boolean;
  videoIntervalSteps: number;
  videoLengthSteps: number;
  videoWidth: number;
  videoHeight: number;
};

export const defaultTrainingStageConfig: TrainingStageConfig = {
  numEnvs: 4096,
  maxIterations: 3000,
  outputFps: 50,
  maxRuntimeMinutes: 360,
  captureTrainingVideos: true,
  videoIntervalSteps: 2000,
  videoLengthSteps: 200,
  videoWidth: 1280,
  videoHeight: 720,
};

function boundedNumber(value: unknown, name: string, minimum: number, maximum: number, integer = false) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum || (integer && !Number.isInteger(number))) {
    throw new Error(`${name} must be ${integer ? "an integer " : ""}between ${minimum} and ${maximum}.`);
  }
  return number;
}

export function normalizeTrainingStageConfig(value: unknown): TrainingStageConfig {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    numEnvs: boundedNumber(input.numEnvs ?? defaultTrainingStageConfig.numEnvs, "trainingConfig.numEnvs", 1, 16_384, true),
    maxIterations: boundedNumber(input.maxIterations ?? defaultTrainingStageConfig.maxIterations, "trainingConfig.maxIterations", 1, 100_000, true),
    outputFps: boundedNumber(input.outputFps ?? defaultTrainingStageConfig.outputFps, "trainingConfig.outputFps", 1, 240),
    maxRuntimeMinutes: boundedNumber(input.maxRuntimeMinutes ?? defaultTrainingStageConfig.maxRuntimeMinutes, "trainingConfig.maxRuntimeMinutes", 1, 10_080, true),
    captureTrainingVideos: typeof input.captureTrainingVideos === "boolean"
      ? input.captureTrainingVideos
      : defaultTrainingStageConfig.captureTrainingVideos,
    videoIntervalSteps: boundedNumber(input.videoIntervalSteps ?? defaultTrainingStageConfig.videoIntervalSteps, "trainingConfig.videoIntervalSteps", 1, 10_000_000, true),
    videoLengthSteps: boundedNumber(input.videoLengthSteps ?? defaultTrainingStageConfig.videoLengthSteps, "trainingConfig.videoLengthSteps", 1, 100_000, true),
    videoWidth: boundedNumber(input.videoWidth ?? defaultTrainingStageConfig.videoWidth, "trainingConfig.videoWidth", 320, 3840, true),
    videoHeight: boundedNumber(input.videoHeight ?? defaultTrainingStageConfig.videoHeight, "trainingConfig.videoHeight", 240, 2160, true),
  };
}
