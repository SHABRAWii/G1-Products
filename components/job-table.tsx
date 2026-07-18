"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { stageLabels, type PipelineStage } from "@/lib/domain";
import { StatusBadge } from "@/components/status-badge";

type ApiJob = { id: string; name: string; robot: string; status: string; startStage: PipelineStage; endStage: PipelineStage; stages: { stage: PipelineStage; status: string; position: number }[]; estimateMinor: number; currency: string; createdAt: string };

function currentStage(job: ApiJob) {
  return job.stages.find((stage) => stage.status === "running" || stage.status === "awaiting_review" || stage.status === "ready") ?? job.stages.find((stage) => stage.status === "pending") ?? job.stages.at(-1);
}

export function JobTable({ compact = false }: { compact?: boolean }) {
  const [jobs, setJobs] = useState<ApiJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/jobs").then(async (response) => { const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "Unable to load jobs."); return payload.data as ApiJob[]; }).then(setJobs).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Unable to load jobs."));
  }, []);
  const visibleJobs = compact ? jobs.slice(0, 4) : jobs;
  if (error) return <p className="empty-state">{error}</p>;
  if (!jobs.length) return <p className="empty-state">No jobs yet. Upload an asset or create a new job to begin.</p>;
  return <div className="table-wrap"><table><thead><tr><th>Job</th><th>Status</th><th>Current stage</th><th>Progress</th><th>Estimate</th><th>Created</th><th>Action</th></tr></thead><tbody>{visibleJobs.map((job) => {
    const stage = currentStage(job); const complete = job.stages.filter((item) => item.status === "succeeded").length; const progress = Math.round((complete / Math.max(1, job.stages.length)) * 100);
    return <tr key={job.id}><td><Link className="table-link table-link--job" href={`/jobs/${job.id}`}><span className="robot-thumb">R</span><span>{job.name}<small>{job.id.slice(-8)} · {job.robot}</small></span></Link></td><td><StatusBadge status={job.status} /></td><td>{stage ? stageLabels[stage.stage] : "—"}</td><td><div className="progress-cell"><div><i style={{ width: `${progress}%` }} /></div><span>{progress}%</span></div></td><td>${(job.estimateMinor / 100).toFixed(2)} {job.currency}</td><td>{new Date(job.createdAt).toLocaleString()}</td><td><Link className="table-link" href={`/jobs/${job.id}`}>Open</Link></td></tr>;
  })}</tbody></table></div>;
}
