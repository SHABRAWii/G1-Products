"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { StatusBadge } from "@/components/status-badge";

type TrainingRecipe = { id: string; name: string; algorithm: string };
type ApiTrainingRun = { id: string; jobId: string | null; name: string; status: string; recipe: TrainingRecipe; createdAt: string; updatedAt: string };

export function TrainingRunTable() {
  const [runs, setRuns] = useState<ApiTrainingRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/training-runs").then(async (response) => { const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "Unable to load training runs."); return payload.data as ApiTrainingRun[]; }).then(setRuns).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Unable to load training runs."));
  }, []);
  if (error) return <p className="empty-state">{error}</p>;
  if (!runs.length) return <p className="empty-state">No training runs yet. Dispatch a job that ends at the training stage to see it here.</p>;
  return <div className="table-wrap"><table><thead><tr><th>Run</th><th>Status</th><th>Recipe</th><th>Created</th><th>Updated</th><th>Action</th></tr></thead><tbody>{runs.map((run) => (
    <tr key={run.id}>
      <td><span>{run.name}<small>{run.id.slice(-8)}</small></span></td>
      <td><StatusBadge status={run.status} /></td>
      <td>{run.recipe.name}</td>
      <td>{new Date(run.createdAt).toLocaleString()}</td>
      <td>{new Date(run.updatedAt).toLocaleString()}</td>
      <td>{run.jobId ? <Link className="table-link" href={`/jobs/${run.jobId}`}>Open job</Link> : "—"}</td>
    </tr>
  ))}</tbody></table></div>;
}
