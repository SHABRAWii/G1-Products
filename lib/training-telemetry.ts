export type TrainingMetricPoint = {
  iteration: number;
  totalIterations: number;
  totalSteps?: number;
  stepsPerSecond?: number;
  meanReward?: number;
  meanEpisodeLength?: number;
  iterationSeconds?: number;
  rewards: Record<string, number>;
  terminations: Record<string, number>;
  errors: Record<string, number>;
};

export type TrainingTelemetry = {
  currentIteration: number;
  totalIterations: number;
  progress: number;
  history: TrainingMetricPoint[];
  latest?: TrainingMetricPoint;
  best?: { iteration: number; meanReward: number };
  dominantTermination?: { name: string; value: number };
  outcome: "RUNNING" | "COMPLETED" | "FAILED";
  qualityStatus: "NOT_EVALUATED" | "EVALUATION_PENDING" | "EVALUATED";
};

const ANSI = /\u001b\[[0-9;]*m/g;
const NUMBER = "(-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?)";

export function createTrainingTelemetry(totalIterations = 0): TrainingTelemetry {
  return {
    currentIteration: 0,
    totalIterations,
    progress: 0,
    history: [],
    outcome: "RUNNING",
    qualityStatus: "NOT_EVALUATED",
  };
}

function numeric(line: string, label: string) {
  const match = line.match(new RegExp(`${label}:\\s*${NUMBER}\\s*$`));
  return match ? Number(match[1]) : undefined;
}

function updateDerived(telemetry: TrainingTelemetry, point: TrainingMetricPoint) {
  telemetry.currentIteration = point.iteration;
  telemetry.totalIterations = point.totalIterations || telemetry.totalIterations;
  telemetry.progress = telemetry.totalIterations
    ? Math.min(1, Math.max(0, (point.iteration + 1) / telemetry.totalIterations))
    : 0;
  telemetry.latest = point;
  if (point.meanReward !== undefined && (!telemetry.best || point.meanReward > telemetry.best.meanReward)) {
    telemetry.best = { iteration: point.iteration, meanReward: point.meanReward };
  }
  const dominant = Object.entries(point.terminations).sort((a, b) => b[1] - a[1])[0];
  if (dominant) telemetry.dominantTermination = { name: dominant[0], value: dominant[1] };
}

export function ingestTrainingLog(telemetry: TrainingTelemetry, rawLine: string) {
  const line = rawLine.replace(ANSI, "").trim();
  const iteration = line.match(/Learning iteration\s+(\d+)\/(\d+)/);
  if (iteration) {
    const point: TrainingMetricPoint = {
      iteration: Number(iteration[1]),
      totalIterations: Number(iteration[2]),
      rewards: {},
      terminations: {},
      errors: {},
    };
    telemetry.history.push(point);
    if (telemetry.history.length > 500) telemetry.history.shift();
    updateDerived(telemetry, point);
    return telemetry;
  }
  const point = telemetry.history.at(-1);
  if (!point) return telemetry;

  point.totalSteps = numeric(line, "Total steps") ?? point.totalSteps;
  point.stepsPerSecond = numeric(line, "Steps per second") ?? point.stepsPerSecond;
  point.meanReward = numeric(line, "Mean reward") ?? point.meanReward;
  point.meanEpisodeLength = numeric(line, "Mean episode length") ?? point.meanEpisodeLength;
  point.iterationSeconds = numeric(line, "Iteration time") ?? point.iterationSeconds;

  const named = line.match(new RegExp(`^(Episode_Reward|Episode_Termination|Metrics/motion)/([^:]+):\\s*${NUMBER}$`));
  if (named) {
    const [, family, name, value] = named;
    const target = family === "Episode_Reward"
      ? point.rewards
      : family === "Episode_Termination"
        ? point.terminations
        : point.errors;
    target[name] = Number(value);
  }
  updateDerived(telemetry, point);
  return telemetry;
}

export function completeTrainingTelemetry(telemetry: TrainingTelemetry, succeeded: boolean) {
  telemetry.outcome = succeeded ? "COMPLETED" : "FAILED";
  telemetry.qualityStatus = succeeded ? "EVALUATION_PENDING" : "NOT_EVALUATED";
  if (succeeded) telemetry.progress = 1;
  return telemetry;
}
