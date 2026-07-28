"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Bot, BrainCircuit, CheckCircle2, ChevronDown, ChevronUp, CircleAlert, ClipboardCheck, Clock3, Download, FileText, Gamepad2, MonitorPlay, PersonStanding, Play, RotateCcw, Share2, ShieldCheck, Video, XCircle } from "lucide-react";
import { stageLabels, type PipelineStage } from "@/lib/domain";
import { StatusBadge } from "@/components/status-badge";
import { Motion3DViewer } from "@/components/motion-3d-viewer";
import { artifactDisplayName } from "@/lib/artifact-display-name";

type AssetVersion = { id: string; contentType: string; schemaVersion: string; asset: { name: string; type: string } };
type StageArtifact = { role: "INPUT" | "OUTPUT" | "PREVIEW" | "EVIDENCE"; assetVersion: AssetVersion };
type WorkerResult = { state?: string; logs?: string[]; summary?: string; updatedAt?: string; message?: string };
type StageAttempt = { id: string; attempt: number; status: string; startedAt?: string; endedAt?: string; result?: WorkerResult };
type Stage = { id: string; stage: PipelineStage; status: string; position: number; adapter: string; attempts: StageAttempt[]; reviewTask: { id: string; status: string } | null; artifacts: StageArtifact[] };
type Cost = { id: string; amountMinor: number; category: string; provider: string; kind: string; createdAt: string };
type Job = { id: string; name: string; status: string; robotModel: string; startStage?: PipelineStage; endStage?: PipelineStage; estimateMinor: number; estimateCurrency: string; createdAt: string; stages: Stage[]; costs: Cost[]; inputAssetVersion: AssetVersion | null; worker: { ready: boolean; status: string; detail: string } };
export type PlaybackSync = {
  masterVideo: MutableRefObject<HTMLVideoElement | null>;
  muted?: boolean;
};

const stageIcons: Record<PipelineStage, typeof Video> = { video_generation: Video, pose_extraction: PersonStanding, pose_review: ClipboardCheck, robot_retargeting: Bot, visualization: MonitorPlay, training: BrainCircuit, policy_evaluation: CheckCircle2, simulation_verification: Gamepad2 };
const descriptions: Record<PipelineStage, string> = {
  video_generation: "Generated source video for this run.",
  pose_extraction: "PromptHMR extracts 3D human motion and the SMPL-X track.",
  pose_review: "The extracted motion is checked before it is released to GMR.",
  robot_retargeting: "GMR converts the approved human track to Unitree G1 joint motion.",
  visualization: "Inspect the retargeted Unitree G1 motion as an interactive digital twin.",
  training: "Training is not configured for this workspace.", policy_evaluation: "Policy evaluation is not configured for this workspace.", simulation_verification: "Simulation verification is not configured for this workspace.",
};

function artifactUrl(artifact: AssetVersion) { return `/api/assets/versions/${artifact.id}/content`; }
function stageArtifact(stage: Stage, role: StageArtifact["role"]) { return stage.artifacts.find((artifact) => artifact.role === role)?.assetVersion; }
function stageArtifacts(stage: Stage, role: StageArtifact["role"]) { return stage.artifacts.filter((artifact) => artifact.role === role).map((artifact) => artifact.assetVersion); }
function isVideo(artifact?: AssetVersion) { return Boolean(artifact?.contentType.startsWith("video/")); }
function isSourceVideo(artifact?: AssetVersion) { return Boolean(artifact && isVideo(artifact) && ["VIDEO_SOURCE", "VIDEO_GENERATED"].includes(artifact.asset.type)); }
function isDeprecatedRenderedPreview(artifact: AssetVersion) {
  return [
    "visualization.pose-3d/v1",
    "visualization.robot-preview/v1",
    "visualization.robot-retarget/v1",
  ].includes(artifact.schemaVersion);
}
function prefer3dPose(previews: AssetVersion[]) { return previews.find((artifact) => artifact.schemaVersion.includes("pose-3d")) ?? previews[0]; }

function formatRobotModel(model: string) {
  return model
    .split("_")
    .map((part) => part.toLowerCase() === "g1" ? "G1" : `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function formatRunDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatRuntime(milliseconds: number) {
  if (milliseconds <= 0) return "—";
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

function getRunTiming(job: Job) {
  const attempts = job.stages.flatMap((stage) => stage.attempts);
  const startedTimestamps = attempts
    .map((attempt) => attempt.startedAt ? Date.parse(attempt.startedAt) : Number.NaN)
    .filter(Number.isFinite);
  const startedAt = startedTimestamps.length
    ? new Date(Math.min(...startedTimestamps)).toISOString()
    : job.createdAt;
  const runtime = attempts.reduce((total, attempt) => {
    if (!attempt.startedAt) return total;
    const started = Date.parse(attempt.startedAt);
    const ended = attempt.endedAt
      ? Date.parse(attempt.endedAt)
      : ["RUNNING", "LEASED"].includes(attempt.status)
        ? Date.now()
        : started;
    return Number.isFinite(started) && Number.isFinite(ended)
      ? total + Math.max(0, ended - started)
      : total;
  }, 0);
  return { startedAt, runtime };
}

function describePipeline(job: Job, robot: string) {
  const stages = new Set(job.stages.map((stage) => stage.stage));
  if (stages.has("pose_extraction") && stages.has("robot_retargeting")) {
    return `Pipeline run for 3D human motion → SMPL-X → ${robot} retargeting${stages.has("visualization") ? " and visualization" : ""}.`;
  }
  if (job.startStage && job.endStage) {
    return `Pipeline run from ${stageLabels[job.startStage].toLowerCase()} to ${stageLabels[job.endStage].toLowerCase()}.`;
  }
  return "Pipeline run with retained inputs, artifacts, and stage-by-stage execution evidence.";
}

function ActionNotice({ stage, job, onAction, busy }: { stage?: Stage; job: Job; onAction: (url: string, body?: unknown) => void; busy: boolean }) {
  if (!stage) return <section className="run-notice run-notice--complete"><CheckCircle2 /><div><small>RUN COMPLETE</small><h2>All selected stages completed</h2><p>The artifacts below are retained for review and reuse.</p></div></section>;
  const retry = stage.status === "FAILED_RETRYABLE";
  const review = stage.status === "AWAITING_REVIEW";
  const running = stage.status === "RUNNING";
  const queued = stage.status === "READY" || job.status === "QUEUED";
  const heading = retry ? `${stageLabels[stage.stage]} failed` : review ? "Pose review needs approval" : running ? `${stageLabels[stage.stage]} is running` : queued ? `${stageLabels[stage.stage]} is ready` : `${stageLabels[stage.stage]} is waiting`;
  const body = retry ? "Something went wrong while running this stage. You can retry it safely." : review ? "Approve once to automatically start the next available automated stage." : running ? "The worker has claimed this stage. New logs and artifacts appear here automatically." : queued ? "The worker is ready to run this stage." : "This stage becomes available when its predecessor completes.";
  const icon = retry ? <CircleAlert /> : review ? <ShieldCheck /> : running ? <Clock3 /> : <Play />;
  return <section className={`run-notice${retry ? " run-notice--error" : ""}`}><span>{icon}</span><div><small>{retry ? "ACTION REQUIRED" : "PIPELINE STATUS"}</small><h2>{heading}</h2><p>{body}</p></div><div className="run-notice__actions">{retry ? <button className="button danger-button" disabled={busy} onClick={() => onAction(`/api/jobs/${job.id}/stages/${stage.id}/retry`)}><RotateCcw size={15} /> Retry stage</button> : null}{review && stage.reviewTask ? <><button className="button button--primary" disabled={busy} onClick={() => onAction(`/api/review-tasks/${stage.reviewTask!.id}/approve`, { reviewedBy: "operator", decisionNote: "Approved from RoboMotion" })}><ShieldCheck size={15} /> Approve & continue</button><button className="button button--subtle" disabled={busy} onClick={() => onAction(`/api/review-tasks/${stage.reviewTask!.id}/reject`, { reviewedBy: "operator", decisionNote: "Rejected from RoboMotion" })}><XCircle size={15} /> Reject</button></> : null}{queued ? <button className="button button--primary" disabled={busy} onClick={() => onAction(`/api/jobs/${job.id}/dispatch`)}><Play size={15} /> Start stage</button> : null}</div></section>;
}

function SyncedVideo({ artifact, sync, master = false }: { artifact: AssetVersion; sync: PlaybackSync; master?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (master) {
      sync.masterVideo.current = element;
      return () => {
        if (sync.masterVideo.current === element) sync.masterVideo.current = null;
      };
    }
    let animation = 0;
    const follow = () => {
      const source = sync.masterVideo.current;
      if (source) {
        element.playbackRate = source.playbackRate;
        if (Math.abs(element.currentTime - source.currentTime) > 0.04) {
          element.currentTime = Math.min(
            source.currentTime,
            Number.isFinite(element.duration) ? element.duration : source.currentTime,
          );
        }
        if (!source.paused && !source.ended && source.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          if (element.paused) void element.play().catch(() => undefined);
        } else if (!element.paused) element.pause();
      }
      animation = requestAnimationFrame(follow);
    };
    animation = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(animation);
  }, [master, sync.masterVideo]);
  return <video ref={video} controls={master} muted={master ? sync.muted : true} playsInline preload={master ? "auto" : "metadata"} src={artifactUrl(artifact)}>Your browser cannot play this video.</video>;
}

function MediaPanel({ artifact, title, empty, sync, master = false }: { artifact?: AssetVersion; title: string; empty: string; sync?: PlaybackSync; master?: boolean }) {
  if (!artifact) return <div className="run-media run-media--empty"><CircleAlert size={18} /><b>{title}</b><p>{empty}</p></div>;
  if (isVideo(artifact)) return <figure className={`run-media${artifact.schemaVersion.includes("visualization.robot-digital-twin") ? " run-media--mesh" : ""}`}><figcaption><b>{title}</b><span>{artifactDisplayName(artifact.asset.name)}</span></figcaption>{sync ? <SyncedVideo artifact={artifact} sync={sync} master={master} /> : <video controls preload="metadata" src={artifactUrl(artifact)}>Your browser cannot play this video.</video>}</figure>;
  return <div className="run-media run-media--file"><FileText size={20} /><b>{title}</b><strong>{artifactDisplayName(artifact.asset.name)}</strong><a className="button button--subtle" href={artifactUrl(artifact)} target="_blank">Open artifact</a></div>;
}

function SourceStage({ artifact }: { artifact?: AssetVersion }) {
  const video = isVideo(artifact); const title = video ? "Source Video" : "Run Input";
  return <article className="run-stage run-stage--source"><header className="run-stage__header"><span className="run-stage__number"><CheckCircle2 size={16} /></span><span className="run-stage__icon"><Video size={19} /></span><div><small>STEP 1 · SOURCE</small><h2>{title}</h2><p>{artifact ? (video ? "Uploaded video retained as the immutable source for this pipeline run." : "A previously produced artifact is the immutable input for this partial pipeline run.") : "The selected source artifact will appear here."}</p></div><StatusBadge status={artifact ? "SUCCEEDED" : "PENDING"} /></header><div className="run-stage__content"><MediaPanel artifact={artifact} title={video ? "Source video" : "Input artifact"} empty="No input artifact was attached to this run." /></div></article>;
}

function StageCard({ stage, stages, job, expanded, onToggle, onAction, busy }: { stage: Stage; stages: Stage[]; job: Job; expanded: boolean; onToggle: () => void; onAction: (url: string, body?: unknown) => void; busy: boolean }) {
  const masterVideo = useRef<HTMLVideoElement | null>(null);
  const playbackSync = useMemo<PlaybackSync>(() => ({ masterVideo }), []);
  const Icon = stageIcons[stage.stage];
  const stageIndex = stages.findIndex((candidate) => candidate.id === stage.id);
  const previous = stages[stageIndex - 1];
  const input = stageArtifact(stage, "INPUT") ?? (stageIndex === 0 ? job.inputAssetVersion ?? undefined : undefined);
  const rawOutput = stageArtifact(stage, "OUTPUT");
  const output = rawOutput && !isDeprecatedRenderedPreview(rawOutput) ? rawOutput : undefined;
  const previews = stageArtifacts(stage, "PREVIEW").filter((artifact) => !isDeprecatedRenderedPreview(artifact));
  const previousPreviews = previous ? stageArtifacts(previous, "PREVIEW").filter((artifact) => !isDeprecatedRenderedPreview(artifact)) : [];
  const previousPreview = prefer3dPose(previousPreviews);
  const downstreamVisualization = stages.slice(stageIndex + 1).find((candidate) => candidate.stage === "visualization");
  const downstreamPreview = downstreamVisualization ? stageArtifact(downstreamVisualization, "OUTPUT") : undefined;
  const sceneArtifacts = stage.artifacts.filter((artifact) => artifact.assetVersion.schemaVersion.includes("3d-scene")).map((artifact) => artifact.assetVersion);
  const sceneArtifact = sceneArtifacts.find((artifact) => artifact.schemaVersion.includes("robot-3d-scene/v4")) ?? sceneArtifacts.find((artifact) => artifact.schemaVersion.includes("robot-3d-scene/v3")) ?? sceneArtifacts[0];
  const upstreamPoseArtifacts = stages.slice(0, stageIndex).reverse().flatMap((candidate) => candidate.artifacts.map((artifact) => artifact.assetVersion));
  const upstreamPoseScene = upstreamPoseArtifacts.find((artifact) => artifact.schemaVersion.includes("pose-3d-scene"));
  const sourceVideo = isSourceVideo(job.inputAssetVersion ?? undefined)
    ? job.inputAssetVersion!
    : stages.slice(0, stageIndex + 1).flatMap((candidate) => candidate.artifacts.map((artifact) => artifact.assetVersion)).find(isSourceVideo);
  const poseOverlay = previews.find((artifact) => artifact.schemaVersion.includes("pose-skeleton"));
  const poseEvidence = previews.find((artifact) => artifact.schemaVersion.includes("pose-3d") && isVideo(artifact));
  const ownPreview = stage.stage === "pose_extraction" ? poseEvidence ?? prefer3dPose(previews) : previews[0];
  // Existing runs created before direct retarget previews are still useful:
  // surface their completed visualization result on the retargeting card.
  const outputVisual = ownPreview ?? (isVideo(output) ? output : undefined) ?? (stage.stage === "robot_retargeting" && isVideo(downstreamPreview) ? downstreamPreview : undefined);
  const preferRealRobotRender = stage.stage === "robot_retargeting" || stage.stage === "visualization";
  const actualRobotScene = Boolean(sceneArtifact?.schemaVersion.match(/robot-3d-scene\/v[34]/));
  const interactiveScene = !preferRealRobotRender || !outputVisual || actualRobotScene ? sceneArtifact : undefined;
  const priorVisual = isVideo(input) ? input : previousPreview;
  const outputTitle = stage.stage === "pose_extraction" ? "3D SMPL-X motion" : stage.stage === "robot_retargeting" ? "Retargeted Unitree G1" : stage.stage === "visualization" ? "Unitree G1 digital twin" : `${stageLabels[stage.stage]} output`;
  const emptyMessage = stage.status === "FAILED_RETRYABLE"
    ? "No output was generated. Review the stage log and retry when ready."
    : "This stage is waiting for a visual artifact from its predecessor or adapter.";

  let stageBody: React.ReactNode;
  if (stage.stage === "pose_extraction") {
    stageBody = (
      <div className="run-stage__pose-layout">
        <MediaPanel artifact={priorVisual} title="Input video" empty={emptyMessage} sync={playbackSync} master />
        <MediaPanel artifact={poseOverlay} title="2D pose overlay" empty="The tracking overlay has not been published yet." sync={playbackSync} />
      </div>
    );
  } else if (stage.stage === "pose_review") {
    const reviewStatus = stage.reviewTask?.status ?? (stage.status === "SUCCEEDED" ? "APPROVED" : "AWAITING_REVIEW");
    stageBody = (
      <>
        <div className="run-stage__digital-twin run-stage__digital-twin--pose-review">
          {upstreamPoseScene ? (
            <Motion3DViewer
              sceneUrl={artifactUrl(upstreamPoseScene)}
              title="3D SMPL-X motion review"
              referenceVideoUrl={sourceVideo ? artifactUrl(sourceVideo) : undefined}
              controls="full"
            />
          ) : (
            <MediaPanel artifact={undefined} title="3D SMPL-X motion review" empty="The pose extraction stage has not published its interactive scene yet." />
          )}
        </div>
        <div className="run-stage__review-summary">
          <span><ShieldCheck size={20} /></span>
          <div>
            <small>HUMAN REVIEW GATE</small>
            <h3>{reviewStatus === "APPROVED" || stage.status === "SUCCEEDED" ? "Extracted motion approved" : "Review the full 3D SMPL-X motion above"}</h3>
            <p>This review records the operator decision and releases the same immutable SMPL-X artifact to robot retargeting.</p>
          </div>
          <StatusBadge status={stage.status === "SUCCEEDED" ? "COMPLETED" : stage.status} />
        </div>
      </>
    );
  } else if (stage.stage === "robot_retargeting") {
    stageBody = (
      <div className="run-stage__retarget-layout">
        {sourceVideo ? (
          <MediaPanel artifact={sourceVideo} title="Human motion reference" empty="" sync={playbackSync} master />
        ) : upstreamPoseScene ? (
          <Motion3DViewer sceneUrl={artifactUrl(upstreamPoseScene)} title="Human SMPL-X input" />
        ) : (
          <MediaPanel artifact={undefined} title="Human motion reference" empty={emptyMessage} />
        )}
        {interactiveScene ? (
          <Motion3DViewer
            sceneUrl={artifactUrl(interactiveScene)}
            title={outputTitle}
            sync={sourceVideo ? playbackSync : undefined}
            referenceVideoUrl={sourceVideo ? artifactUrl(sourceVideo) : undefined}
            controls="compact"
          />
        ) : (
          <MediaPanel artifact={undefined} title={outputTitle} empty={emptyMessage} />
        )}
      </div>
    );
  } else if (stage.stage === "visualization") {
    stageBody = (
      <div className="run-stage__digital-twin run-stage__digital-twin--robot">
        {interactiveScene ? (
          <Motion3DViewer
            sceneUrl={artifactUrl(interactiveScene)}
            title={outputTitle}
            downloadUrl={outputVisual && isVideo(outputVisual) ? artifactUrl(outputVisual) : undefined}
            referenceVideoUrl={sourceVideo ? artifactUrl(sourceVideo) : undefined}
            controls="full"
          />
        ) : (
          <MediaPanel artifact={undefined} title={outputTitle} empty={emptyMessage} />
        )}
      </div>
    );
  } else {
    stageBody = (
      <div className="run-stage__visuals">
        {priorVisual ? <MediaPanel artifact={priorVisual} title={`Input from ${previous ? stageLabels[previous.stage] : "source"}`} empty="" /> : null}
        {outputVisual ? <MediaPanel artifact={outputVisual} title={outputTitle} empty="" /> : null}
        {!priorVisual && !outputVisual ? <MediaPanel artifact={undefined} title={stageLabels[stage.stage]} empty={emptyMessage} /> : null}
      </div>
    );
  }

  return (
    <article className={`run-stage run-stage--${stage.stage}${stage.status === "FAILED_RETRYABLE" ? " run-stage--failed" : ""}`}>
      <header className="run-stage__header">
        <span className="run-stage__number">{stage.status === "SUCCEEDED" ? <CheckCircle2 size={16} /> : stage.position + 2}</span>
        <span className="run-stage__icon"><Icon size={19} /></span>
        <div><small>STEP {stage.position + 2}</small><h2>{stageLabels[stage.stage]}</h2><p>{descriptions[stage.stage]}</p></div>
        <StatusBadge status={stage.status} />
        <button className="run-stage__details" type="button" onClick={onToggle}>View details {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>
      </header>
      {expanded ? (
        <div className="run-stage__content">
          {stage.status === "FAILED_RETRYABLE" ? (
            <div className="run-stage__retry">
              <CircleAlert size={15} />
              <span>This stage failed. You can retry it safely.</span>
              <button className="button danger-button" disabled={busy} onClick={() => onAction(`/api/jobs/${job.id}/stages/${stage.id}/retry`)}><RotateCcw size={14} /> Retry stage</button>
            </div>
          ) : null}
          {stageBody}
        </div>
      ) : null}
    </article>
  );
}

export function JobDetail({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<Job | null>(null); const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [expanded, setExpanded] = useState<string[]>([]);
  const load = async () => { try { const response = await fetch(`/api/jobs/${jobId}`); const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "Unable to load job."); const nextJob = payload.data as Job; setJob(nextJob); setExpanded((current) => current.length ? current : nextJob.stages.map((stage) => stage.id)); } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to load job."); } };
  useEffect(() => { void load(); const refresh = window.setInterval(() => void load(), 3000); return () => window.clearInterval(refresh); }, [jobId]);
  async function action(url: string, body?: unknown) { setBusy(true); setMessage(null); try { const response = await fetch(url, { method: "POST", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }); const payload = await response.json(); const autoState = payload.data?.autoDispatch?.state; setMessage(response.ok ? (autoState === "running" ? "Pose approved and the next stage was dispatched." : "The pipeline was updated.") : payload.error ?? "Action failed."); await load(); } finally { setBusy(false); } }
  const activeStage = useMemo(() => job?.stages.find((stage) => ["RUNNING", "AWAITING_REVIEW", "FAILED_RETRYABLE", "READY"].includes(stage.status)) ?? job?.stages.find((stage) => stage.status === "PENDING"), [job]);
  if (!job) return <p className="empty-state">{message ?? "Loading job…"}</p>;
  const actualCost = job.costs.filter((cost) => cost.kind !== "ESTIMATED").reduce((total, cost) => total + cost.amountMinor, 0);
  const artifacts = job.stages
    .flatMap((stage) => stage.artifacts.map((artifact) => ({ ...artifact, stage })))
    .filter((entry) => !isDeprecatedRenderedPreview(entry.assetVersion))
    .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.assetVersion.id === entry.assetVersion.id && candidate.role === entry.role) === index);
  const latestDownload = [...artifacts].reverse().find((entry) => entry.role === "OUTPUT")?.assetVersion;
  const completedCount = job.stages.filter((stage) => stage.status === "SUCCEEDED").length;
  const robot = formatRobotModel(job.robotModel);
  const timing = getRunTiming(job);
  const runtime = formatRuntime(timing.runtime);
  const pipelineDescription = describePipeline(job, robot);

  return (
    <div className="run-detail-page">
      <nav className="run-breadcrumb" aria-label="Breadcrumb">
        <Link href="/jobs">Jobs</Link>
        <span>›</span>
        <span>Job details</span>
        <span>›</span>
        <strong>{job.name}</strong>
      </nav>

      <header className="run-detail-header">
        <div className="run-detail-header__status">
          <StatusBadge status={job.status} />
        </div>
        <div className="run-detail-header__actions">
          <button className="button button--subtle" onClick={() => navigator.clipboard?.writeText(window.location.href)}>
            <Share2 size={15} /> Share
          </button>
          {latestDownload ? (
            <a className="button button--primary" href={artifactUrl(latestDownload)}>
              <Download size={15} /> Download latest
            </a>
          ) : (
            <button className="button button--primary" disabled>
              <Download size={15} /> Download latest
            </button>
          )}
          <a className="button button--subtle" href="#pipeline-results">
            <ClipboardCheck size={15} /> View report
          </a>
        </div>
        <div className="run-detail-header__content">
          <h1>{job.name}</h1>
          <p className="run-detail-header__meta">
            <strong>Robot: {robot}</strong>
            <span>•</span>
            Started {formatRunDate(timing.startedAt)}
          </p>
          <p className="run-detail-header__description">{pipelineDescription}</p>
          <div className="run-detail-header__stats">
            <span><CheckCircle2 size={18} /><strong>{completedCount} of {job.stages.length} stages completed</strong></span>
            <span><Clock3 size={18} /><strong>Total runtime {runtime}</strong></span>
          </div>
        </div>
      </header>

      <section className="run-rail" aria-label="Pipeline stages">
        <div className="run-rail__node run-rail__node--done"><span><Video size={17} /></span><b>1</b><small>Source Video</small><em>Completed</em></div>
        {job.stages.map((stage) => {
          const Icon = stageIcons[stage.stage];
          const complete = stage.status === "SUCCEEDED";
          const active = stage.id === activeStage?.id;
          return (
            <div className={`run-rail__node${complete ? " run-rail__node--done" : ""}${active ? " run-rail__node--active" : ""}`} key={stage.id}>
              <span><Icon size={17} /></span>
              <b>{stage.position + 2}</b>
              <small>{stageLabels[stage.stage]}</small>
              <em>{complete ? "Completed" : stage.status === "FAILED_RETRYABLE" ? "Failed" : stage.status.replaceAll("_", " ").toLowerCase()}</em>
            </div>
          );
        })}
      </section>

      <ActionNotice stage={activeStage} job={job} onAction={action} busy={busy} />
      {message ? <p className="form-success">{message}</p> : null}

      <div className="run-detail-layout">
        <main className="run-stages" id="pipeline-results">
          <div className="run-section-heading">
            <div><small>PIPELINE</small><h2>Stage-by-stage results</h2></div>
            <span>Auto-refreshing</span>
          </div>
          <SourceStage artifact={job.inputAssetVersion ?? undefined} />
          {job.stages.map((stage) => (
            <StageCard
              key={stage.id}
              stage={stage}
              stages={job.stages}
              job={job}
              expanded={expanded.includes(stage.id)}
              onToggle={() => setExpanded((current) => current.includes(stage.id) ? current.filter((id) => id !== stage.id) : [...current, stage.id])}
              onAction={action}
              busy={busy}
            />
          ))}
        </main>

        <aside className="run-sidebar">
          <article>
            <div className="run-sidebar__heading"><h2>Job Summary</h2><StatusBadge status={job.status} /></div>
            <dl>
              <div><dt>Robot</dt><dd>{robot}</dd></div>
              <div><dt>Progress</dt><dd>{completedCount} of {job.stages.length} stages</dd></div>
              <div><dt>Active stage</dt><dd>{activeStage ? stageLabels[activeStage.stage] : "Complete"}</dd></div>
              <div><dt>Estimated cost</dt><dd>${(job.estimateMinor / 100).toFixed(2)}</dd></div>
              <div><dt>Actual cost</dt><dd>${(actualCost / 100).toFixed(2)}</dd></div>
              <div><dt>Total runtime</dt><dd>{runtime}</dd></div>
              <div><dt>Started</dt><dd>{formatRunDate(timing.startedAt)}</dd></div>
            </dl>
          </article>
          <article className="run-artifacts">
            <div className="run-sidebar__heading"><h2>Artifacts</h2><span>{artifacts.length}</span></div>
            {artifacts.length ? (
              <ul>
                {artifacts.map(({ assetVersion, role, stage }) => (
                  <li key={`${stage.id}-${role}-${assetVersion.id}`}>
                    <a href={artifactUrl(assetVersion)} target="_blank">
                      <FileText size={14} />
                      <span><b>{artifactDisplayName(assetVersion.asset.name)}</b><small>{stageLabels[stage.stage]} · {role.toLowerCase()}</small></span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : <p>No artifacts have been published yet.</p>}
          </article>
        </aside>
      </div>
    </div>
  );
}
