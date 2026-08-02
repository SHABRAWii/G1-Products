"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Activity, AlertTriangle, Award, CheckCircle2, Clock3, Gauge } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";

type TrainingRecipe = {
  id: string;
  name: string;
  algorithm: string;
  config: { numEnvs?: number; maxIterations?: number; outputFps?: number };
};
type PolicyVersion = { id: string; version: number; status: string; checkpointAssetVersionId: string | null };
type Policy = {
  id: string;
  name: string;
  status: string;
  robotModel: { name: string; dof: number };
  versions: PolicyVersion[];
};
type ApiTrainingRun = {
  id: string;
  jobId: string | null;
  name: string;
  status: string;
  recipe: TrainingRecipe;
  policy: Policy | null;
  metrics: TrainingMetrics;
  createdAt: string;
  updatedAt: string;
};

type TrainingMetricPoint = {
  iteration: number;
  totalIterations: number;
  meanReward?: number;
  stepsPerSecond?: number;
  terminations?: Record<string, number>;
  errors?: Record<string, number>;
};

type PolicyEvaluation = {
  completedReferenceMotion?: boolean;
  completionRatio?: number;
  earlyTerminationFrame?: number | null;
  firstFailureReasons?: string[];
  qualityStatus?: string;
};

type TrainingReport = {
  currentIteration?: number;
  totalIterations?: number;
  progress?: number;
  history?: TrainingMetricPoint[];
  latest?: TrainingMetricPoint;
  best?: { iteration: number; meanReward: number };
  bestSavedMeanReward?: number | null;
  bestSavedIteration?: number | null;
  qualityStatus?: string;
  evaluation?: PolicyEvaluation;
};

type TrainingMetrics = {
  telemetry?: TrainingReport;
  report?: TrainingReport;
  failure?: string;
};

function trainingReport(run: ApiTrainingRun) {
  return run.metrics.report ?? run.metrics.telemetry ?? {};
}

function dominantTermination(point?: TrainingMetricPoint) {
  return Object.entries(point?.terminations ?? {}).sort((a, b) => b[1] - a[1])[0];
}

function friendlySignal(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function TrainingRunTable() {
  const [runs, setRuns] = useState<ApiTrainingRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/training-runs", { cache: "no-store" })
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error ?? "Unable to load training runs.");
          return payload.data as ApiTrainingRun[];
        })
        .then((data) => {
          if (!cancelled) {
            setRuns(data);
            setError(null);
          }
        })
        .catch((reason: unknown) => {
          if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to load training runs.");
        });
    };
    load();
    const timer = window.setInterval(load, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  if (error) return <p className="empty-state">{error}</p>;
  if (!runs.length) return <p className="empty-state">No training runs yet. Dispatch a job that ends at the training stage to see it here.</p>;
  return <div className="training-runs">{runs.map((run) => {
    const version = run.policy?.versions[0];
    const config = run.recipe.config;
    const report = trainingReport(run);
    const latest = report.latest ?? report.history?.at(-1);
    const total = report.totalIterations ?? latest?.totalIterations ?? config.maxIterations ?? 0;
    const current = report.currentIteration ?? latest?.iteration ?? 0;
    const progress = run.status === "COMPLETED"
      ? 1
      : report.progress ?? (total ? Math.min(1, (current + 1) / total) : 0);
    const bestReward = report.bestSavedMeanReward ?? report.best?.meanReward;
    const termination = dominantTermination(latest);
    const evaluation = report.evaluation;
    const passed = evaluation?.completedReferenceMotion === true;
    const evaluated = evaluation?.completedReferenceMotion !== undefined;
    const failureReason = evaluation?.firstFailureReasons?.[0] ?? termination?.[0] ?? run.metrics.failure;
    return (
      <article className="training-run" key={run.id}>
        <header>
          <div className="training-run__identity">
            <span><Activity size={17} /></span>
            <div>
              <small>POLICY TRAINING</small>
              <h3>{run.name}</h3>
              <p>{run.recipe.name} · {run.recipe.algorithm}</p>
            </div>
          </div>
          <StatusBadge status={run.status} />
        </header>
        <div className="training-run__progress">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <div className="training-run__metrics">
          <div><Award size={16} /><span><small>Best reward so far</small><b>{bestReward !== undefined && bestReward !== null ? bestReward.toFixed(3) : "Waiting"}</b></span></div>
          <div><Gauge size={16} /><span><small>Iteration</small><b>{run.status === "COMPLETED" ? `${total} / ${total}` : `${Math.min(current + 1, total || current + 1)} / ${total || "…"}`}</b></span></div>
          <div className={evaluated ? (passed ? "is-good" : "is-warning") : ""}>
            {passed ? <CheckCircle2 size={16} /> : evaluated ? <AlertTriangle size={16} /> : <Clock3 size={16} />}
            <span>
              <small>Reference rollout</small>
              <b>{passed ? "Motion completed" : evaluated ? `Stopped at ${Math.round((evaluation?.completionRatio ?? 0) * 100)}%` : run.status === "COMPLETED" ? "Evaluation unavailable" : "Pending"}</b>
            </span>
          </div>
          <div className={failureReason ? "is-warning" : ""}><AlertTriangle size={16} /><span><small>Dominant failure signal</small><b>{failureReason ? friendlySignal(String(failureReason)) : "None reported"}</b></span></div>
        </div>
        <footer>
          <div>
            <span>{config.numEnvs?.toLocaleString() ?? "—"} envs</span>
            <span>{config.maxIterations?.toLocaleString() ?? "—"} iterations</span>
            <span>{config.outputFps ?? "—"} FPS</span>
            {latest?.stepsPerSecond ? <span>{Math.round(latest.stepsPerSecond).toLocaleString()} steps/s</span> : null}
          </div>
          <div>
            {run.policy ? <span>{run.policy.name} · {run.policy.robotModel.name} · v{version?.version ?? "—"}</span> : null}
            {run.jobId ? <Link className="button button--subtle" href={`/jobs/${run.jobId}`}>Open live monitor</Link> : null}
          </div>
        </footer>
      </article>
    );
  })}</div>;
}
