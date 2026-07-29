"use client";

import { useEffect, useMemo, useState } from "react";
import { pipelineStages, stageLabels, type PipelineStage } from "@/lib/domain";
import { artifactDisplayName } from "@/lib/artifact-display-name";

const entryPoints: { value: PipelineStage; description: string }[] = [
  { value: "video_generation", description: "Start from a text prompt and generate a source video." },
  { value: "pose_extraction", description: "Start from an uploaded or existing source video." },
  { value: "pose_review", description: "Start from extracted SMPL-X pose data." },
  { value: "robot_retargeting", description: "Start from an approved human-pose artifact." },
  { value: "visualization", description: "Render an approved pose or robot-motion artifact." },
  { value: "training", description: "Start from an approved robot-motion artifact." },
];

interface Preflight { estimateMinor: number; estimateMinutes: number; storageBytes: number; requiresPoseReview: boolean; }
interface AssetOption { id: string; name: string; type: string; latestVersion: { id: string; version: number; approvalStatus: string; schemaVersion: string } | null; }

export function NewJobForm() {
  const [startStage, setStartStage] = useState<PipelineStage>("video_generation");
  const [endStage, setEndStage] = useState<PipelineStage>("visualization");
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [submission, setSubmission] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const availableEndStages = useMemo(() => pipelineStages.slice(pipelineStages.indexOf(startStage), pipelineStages.indexOf("training") + 1), [startStage]);
  const selectedStages = pipelineStages.slice(pipelineStages.indexOf(startStage), pipelineStages.indexOf(endStage) + 1);

  useEffect(() => {
    const controller = new AbortController();
    setPreflightError(null);
    fetch("/api/jobs/preflight", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startStage, endStage }), signal: controller.signal })
      .then(async (response) => { const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "Unable to calculate preflight."); setPreflight(payload.data as Preflight); })
      .catch((error: unknown) => { if (error instanceof DOMException && error.name === "AbortError") return; setPreflightError(error instanceof Error ? error.message : "Unable to calculate preflight."); });
    return () => controller.abort();
  }, [startStage, endStage]);

  useEffect(() => { fetch("/api/assets").then(async (response) => { const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "Unable to load assets."); return payload.data as AssetOption[]; }).then(setAssets).catch(() => setAssets([])); }, []);

  function changeStartStage(stage: PipelineStage) { setStartStage(stage); if (pipelineStages.indexOf(endStage) < pipelineStages.indexOf(stage)) setEndStage(stage); }

  async function submitJob(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmission(null);
    const form = new FormData(event.currentTarget);
    const inputAssetVersionId = form.get("inputAssetVersionId");
    const response = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.get("name"), robotModel: form.get("robotModel"), startStage, endStage, ...(typeof inputAssetVersionId === "string" && inputAssetVersionId ? { inputAssetVersionId } : {}) }) });
    const payload = await response.json();
    if (!response.ok) { setSubmission({ type: "error", message: payload.error ?? "Unable to create job." }); return; }
    const dispatch = await fetch(`/api/jobs/${payload.data.id}/dispatch`, { method: "POST" });
    if (!dispatch.ok) { const dispatchPayload = await dispatch.json(); setSubmission({ type: "error", message: `Job was created but could not start: ${dispatchPayload.error ?? "dispatch failed."}` }); return; }
    window.location.assign(`/jobs/${payload.data.id}`);
  }

  const estimate = preflight ? `$${(preflight.estimateMinor / 100).toFixed(2)}` : "Calculating…";
  const usableAssets = assets.filter((asset) => asset.latestVersion?.approvalStatus === "APPROVED");
  return <form className="job-form" onSubmit={submitJob}>
    <section className="form-section"><div className="form-section__heading"><span>01</span><div><h2>Define the pipeline</h2><p>Select the exact portion of the system to run.</p></div></div><div className="form-grid form-grid--two"><label>Job name<input name="name" required placeholder="e.g. Kitchen reach test" /></label><label>Target robot<select name="robotModel" defaultValue="unitree_g1"><option value="unitree_g1">Unitree G1</option><option value="unitree_h1">Unitree H1</option><option value="booster_t1">Booster T1</option></select></label><label>Start stage<select value={startStage} onChange={(event) => changeStartStage(event.target.value as PipelineStage)}>{entryPoints.map((stage) => <option value={stage.value} key={stage.value}>{stageLabels[stage.value]}</option>)}</select></label><label>End stage<select value={endStage} onChange={(event) => setEndStage(event.target.value as PipelineStage)}>{availableEndStages.map((stage) => <option value={stage} key={stage}>{stageLabels[stage]}</option>)}</select></label></div><p className="form-hint">{entryPoints.find((stage) => stage.value === startStage)?.description}</p><div className="pipeline-preview" aria-label="Selected pipeline stages">{selectedStages.map((stage, index) => <span key={stage}>{index > 0 ? <b>→</b> : null}<i>{index + 1}</i>{stageLabels[stage]}</span>)}</div></section>
    <section className="form-section"><div className="form-section__heading"><span>02</span><div><h2>Choose an input</h2><p>Only approved, versioned assets can enter a stage after video generation.</p></div></div>{startStage === "video_generation" ? <div className="asset-picker"><div><strong>Video provider request</strong><p>Generation is adapter-backed. Configure provider credentials before dispatch; the rest of the pre-training flow can be tested from an uploaded video.</p></div></div> : <label>Source asset<select name="inputAssetVersionId" required defaultValue=""><option value="" disabled>{usableAssets.length ? "Select an approved asset" : "Upload an approved source asset first"}</option>{usableAssets.map((asset) => <option value={asset.latestVersion!.id} key={asset.latestVersion!.id}>{artifactDisplayName(asset.name)} · {asset.type} · v{asset.latestVersion!.version}</option>)}</select></label>}</section>
    <section className="estimate-panel"><div><p className="eyebrow">Live preflight estimate</p><strong>{estimate}</strong><span>{preflight ? `${preflight.estimateMinutes} min · ${(preflight.storageBytes / 1_000_000_000).toFixed(1)} GB storage${preflight.requiresPoseReview ? " · pose review gate" : ""}` : "Checking stage configuration…"}</span></div><div className="estimate-panel__cost"><span>Rate card</span><b>RunPod MVP</b><small>Actual usage is recorded per stage attempt.</small></div></section>
    {preflightError ? <div className="form-success form-success--error" role="alert">{preflightError}</div> : null}
    <div className="form-actions"><span>Submission creates an immutable job plan.</span><button className="button button--primary" type="submit">Create job <span>→</span></button></div>
    {submission ? <div className={`form-success${submission.type === "error" ? " form-success--error" : ""}`} role="status">{submission.message}</div> : null}
  </form>;
}
