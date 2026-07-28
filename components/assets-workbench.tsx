"use client";

import { useEffect, useRef, useState } from "react";
import { artifactDisplayName } from "@/lib/artifact-display-name";

type Asset = { id: string; name: string; type: string; latestVersion: { id: string; version: number; approvalStatus: string; schemaVersion: string } | null };

export function AssetsWorkbench() {
  const formRef = useRef<HTMLFormElement>(null);
  const [assets, setAssets] = useState<Asset[]>([]); const [message, setMessage] = useState<string | null>(null); const [uploading, setUploading] = useState(false);
  const load = () => fetch("/api/assets").then(async (response) => { const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "Unable to load assets."); return payload.data as Asset[]; }).then(setAssets).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Unable to load assets."));
  useEffect(() => { load(); }, []);
  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setUploading(true); setMessage(null);
    const response = await fetch("/api/assets/upload", { method: "POST", body: new FormData(event.currentTarget) }); const payload = await response.json();
    setUploading(false); if (!response.ok) { setMessage(payload.error ?? "Upload failed."); return; } formRef.current?.reset(); setMessage("Asset uploaded and approved for the pre-training pipeline."); load();
  }
  return <div className="dashboard-main"><article className="panel"><div className="panel__header"><div><h2>Upload source artifact</h2><p>Upload a video to start pose extraction, review, retargeting, or visualization.</p></div></div><form ref={formRef} onSubmit={upload} className="form-grid form-grid--two"><label>Name<input name="name" placeholder="Optional display name" /></label><label>Asset type<select name="type" defaultValue="VIDEO_SOURCE"><option value="VIDEO_SOURCE">Source video</option><option value="VIDEO_GENERATED">Generated video</option><option value="POSE_SMPLX">SMPL-X pose</option><option value="POSE_REVIEWED">Reviewed pose</option><option value="MOTION_ROBOT">Robot motion</option></select></label><label>Schema version<input name="schemaVersion" defaultValue="video.source/v1" /></label><label>File<input name="file" type="file" required /></label><button className="button button--primary" disabled={uploading} type="submit">{uploading ? "Uploading…" : "Upload asset"}</button></form>{message ? <p className="form-success">{message}</p> : null}</article><article className="panel"><div className="panel__header"><div><h2>Workspace assets</h2><p>{assets.length ? "Select an approved version when creating a job." : "No assets yet."}</p></div></div>{assets.length ? <div className="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Version</th><th>Schema</th><th>Approval</th></tr></thead><tbody>{assets.map((asset) => <tr key={asset.id}><td>{artifactDisplayName(asset.name)}</td><td>{asset.type}</td><td>v{asset.latestVersion?.version ?? "—"}</td><td>{asset.latestVersion?.schemaVersion ?? "—"}</td><td>{asset.latestVersion?.approvalStatus ?? "—"}</td></tr>)}</tbody></table></div> : <p className="empty-state">Upload a source artifact to begin testing the motion pipeline.</p>}</article></div>;
}
