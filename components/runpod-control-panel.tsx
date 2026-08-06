"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleStop, Gauge, MemoryStick, Play, RefreshCw, Server, Thermometer, Zap } from "lucide-react";

type Snapshot = {
  configured: boolean;
  pod: { id: string; status: string; running: boolean; image: string | null } | null;
  mode: "AUTO" | "MANUAL_STOP";
  idleAfterSeconds: number;
  targetImage: string | null;
  work: { pending: boolean; activeStages: number; readyStages: number };
  worker: {
    id: string;
    online: boolean;
    status: string;
    lastSeenAt: string;
    capabilities: string[];
    gpu: {
      name: string;
      utilizationPercent: number;
      memoryUsedMiB: number;
      memoryTotalMiB: number;
      powerDrawWatts: number;
      powerLimitWatts: number;
      temperatureC: number;
    } | null;
    error: string | null;
  } | null;
  controller: { online: boolean; status: string; lastSeenAt: string; action: string | null; error: string | null } | null;
  providerError: string | null;
};

function gibibytes(value: number) {
  return `${(value / 1024).toFixed(1)} GB`;
}

function percentage(value: number, total: number) {
  return total > 0 ? Math.min(100, Math.max(0, value / total * 100)) : 0;
}

export function RunPodControlPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/compute/runpod", { cache: "no-store" });
      const body = await response.json() as { data?: Snapshot; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? "Unable to load RunPod status.");
      setSnapshot(body.data);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load RunPod status.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function control(action: "start" | "stop") {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch("/api/compute/runpod", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await response.json() as { data?: Snapshot; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? `Unable to ${action} RunPod.`);
      setSnapshot(body.data);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : `Unable to ${action} RunPod.`);
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  const gpu = snapshot?.worker?.gpu ?? null;
  const memoryPercent = gpu ? percentage(gpu.memoryUsedMiB, gpu.memoryTotalMiB) : 0;
  const powerPercent = gpu ? percentage(gpu.powerDrawWatts, gpu.powerLimitWatts) : 0;
  const providerStatus = snapshot?.pod?.status ?? (snapshot?.configured ? "UNAVAILABLE" : "NOT CONFIGURED");
  const active = (snapshot?.work.activeStages ?? 0) > 0;

  return (
    <section className="runpod-console">
      <article className="panel runpod-console__hero">
        <div>
          <p className="eyebrow">RunPod GPU plane</p>
          <div className="runpod-console__title-row">
            <h2>RTX 4090 worker</h2>
            <span className={`runpod-state runpod-state--${snapshot?.pod?.running ? "online" : "offline"}`}>
              {providerStatus}
            </span>
          </div>
          <p className="runpod-console__description">
            The controller starts this Pod for queued GPU stages and stops it after {Math.round((snapshot?.idleAfterSeconds ?? 900) / 60)} idle minutes.
          </p>
        </div>
        <div className="runpod-console__actions">
          <button className="button button--subtle" type="button" onClick={() => void refresh()} disabled={Boolean(busy)}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="button button--primary" type="button" onClick={() => void control("start")} disabled={Boolean(busy) || snapshot?.pod?.running || !snapshot?.configured}>
            <Play size={14} /> {busy === "start" ? "Starting…" : "Start GPU Pod"}
          </button>
          <button className="button danger-button" type="button" onClick={() => void control("stop")} disabled={Boolean(busy) || !snapshot?.pod?.running || active}>
            <CircleStop size={14} /> {busy === "stop" ? "Stopping…" : "Stop GPU Pod"}
          </button>
        </div>
      </article>

      {error || snapshot?.providerError || snapshot?.controller?.error ? (
        <div className="runpod-alert" role="alert">{error ?? snapshot?.providerError ?? snapshot?.controller?.error}</div>
      ) : null}

      <div className="runpod-metrics">
        <article className="panel runpod-metric">
          <Server size={19} />
          <span>Worker</span>
          <strong>{snapshot?.worker?.online ? "Ready" : "Offline"}</strong>
          <small>{snapshot?.worker?.online ? snapshot.worker.id : "Waiting for a fresh heartbeat"}</small>
        </article>
        <article className="panel runpod-metric">
          <Gauge size={19} />
          <span>GPU utilization</span>
          <strong>{gpu ? `${gpu.utilizationPercent.toFixed(0)}%` : "—"}</strong>
          <div className="runpod-meter"><i style={{ width: `${gpu?.utilizationPercent ?? 0}%` }} /></div>
        </article>
        <article className="panel runpod-metric">
          <MemoryStick size={19} />
          <span>VRAM allocation</span>
          <strong>{gpu ? `${gibibytes(gpu.memoryUsedMiB)} / ${gibibytes(gpu.memoryTotalMiB)}` : "—"}</strong>
          <div className="runpod-meter"><i style={{ width: `${memoryPercent}%` }} /></div>
        </article>
        <article className="panel runpod-metric">
          <Zap size={19} />
          <span>GPU power</span>
          <strong>{gpu ? `${gpu.powerDrawWatts.toFixed(0)} W / ${gpu.powerLimitWatts.toFixed(0)} W` : "—"}</strong>
          <div className="runpod-meter"><i style={{ width: `${powerPercent}%` }} /></div>
        </article>
        <article className="panel runpod-metric">
          <Thermometer size={19} />
          <span>Temperature</span>
          <strong>{gpu ? `${gpu.temperatureC.toFixed(0)}°C` : "—"}</strong>
          <small>{gpu?.name ?? "No live GPU telemetry"}</small>
        </article>
      </div>

      <div className="runpod-details">
        <article className="panel">
          <div className="panel__header"><div><h2>Work queue</h2><p>Only real pre-training and training stages are counted.</p></div></div>
          <dl className="runpod-definition-list">
            <div><dt>Running GPU stages</dt><dd>{snapshot?.work.activeStages ?? 0}</dd></div>
            <div><dt>Ready GPU stages</dt><dd>{snapshot?.work.readyStages ?? 0}</dd></div>
            <div><dt>Controller mode</dt><dd>{snapshot?.mode === "MANUAL_STOP" ? "Manual hold" : "Automatic"}</dd></div>
            <div><dt>Last controller action</dt><dd>{snapshot?.controller?.action ?? "—"}</dd></div>
          </dl>
          {active ? <p className="runpod-note">Stop is disabled while a stage is running. Cancel the job first so partial outputs and logs remain consistent.</p> : null}
        </article>
        <article className="panel">
          <div className="panel__header"><div><h2>Performance guidance</h2><p>Allocated memory and useful GPU work are different measurements.</p></div></div>
          <p className="runpod-guidance">
            Using 3–4 GB of a 24 GB GPU is not itself a slowdown. The completed run reached about <strong>115k simulation steps/second</strong>; GPU utilization, power, and steps/second are the speed signals. RoboMotion does not waste VRAM merely to make the memory gauge full.
          </p>
          <p className="runpod-guidance">
            Training currently starts with 4,096 parallel environments. Increase it per job only after comparing steps/second and policy quality, because doubling environments also changes the PPO batch and total sampled experience.
          </p>
        </article>
      </div>
    </section>
  );
}
