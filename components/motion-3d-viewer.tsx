"use client";

import { Pause, Play, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type Scene = { kind: "smplx" | "robot"; fps: number; upAxis: "z"; edges: [number, number][]; frames: number[][][] };
type Sync = { time: number; playing: boolean; onTimeChange: (time: number) => void; onPlayingChange: (playing: boolean) => void };
type Bounds = { min: [number, number, number]; max: [number, number, number]; center: [number, number, number]; scale: number };

function validScene(value: unknown): value is Scene {
  if (!value || typeof value !== "object") return false;
  const scene = value as Partial<Scene>;
  return Array.isArray(scene.frames) && scene.frames.length > 0 && Array.isArray(scene.edges) && typeof scene.fps === "number";
}

function getBounds(scene: Scene): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]; const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const bodyExtents: number[] = [];
  for (const frame of scene.frames) { for (const point of frame) for (let axis = 0; axis < 3; axis += 1) { min[axis] = Math.min(min[axis], point[axis] ?? 0); max[axis] = Math.max(max[axis], point[axis] ?? 0); } const root = frame[0]; if (root) bodyExtents.push(Math.max(...frame.map((point) => Math.hypot((point[0] ?? 0) - root[0], (point[1] ?? 0) - root[1], (point[2] ?? 0) - root[2])))); }
  bodyExtents.sort((first, second) => first - second); const typicalBodyExtent = bodyExtents[Math.floor(bodyExtents.length / 2)] ?? 1;
  return { min, max, center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]], scale: Math.max(typicalBodyExtent * 1.25, .8) };
}

export function Motion3DViewer({ sceneUrl, title, downloadUrl, sync }: { sceneUrl: string; title: string; downloadUrl?: string; sync?: Sync }) {
  const canvas = useRef<HTMLCanvasElement>(null); const [scene, setScene] = useState<Scene | null>(null); const [error, setError] = useState<string | null>(null); const [localFrame, setLocalFrame] = useState(0); const [localPlaying, setLocalPlaying] = useState(true); const [speed, setSpeed] = useState(1); const [yaw, setYaw] = useState(-.78); const [pitch, setPitch] = useState(.43); const [zoom, setZoom] = useState(1); const drag = useRef<{ x: number; y: number } | null>(null); const syncedClock = useRef({ time: 0, stampedAt: 0 }); const [, setRenderTick] = useState(0);
  const bounds = useMemo(() => scene ? getBounds(scene) : null, [scene]);
  useEffect(() => { if (sync) syncedClock.current = { time: sync.time, stampedAt: performance.now() }; }, [sync?.time]);
  useEffect(() => { if (!sync || !sync.playing) return; let animation = 0; const draw = () => { setRenderTick((value) => value + 1); animation = requestAnimationFrame(draw); }; animation = requestAnimationFrame(draw); return () => cancelAnimationFrame(animation); }, [sync?.playing]);
  useEffect(() => { const element = canvas.current; if (!element) return; const wheel = (event: WheelEvent) => { event.preventDefault(); setZoom((value) => Math.max(.45, Math.min(2.5, value - event.deltaY * .001))); }; element.addEventListener("wheel", wheel, { passive: false }); return () => element.removeEventListener("wheel", wheel); }, []);
  const syncedTime = sync ? sync.time + (sync.playing && syncedClock.current.stampedAt ? Math.max(0, performance.now() - syncedClock.current.stampedAt) / 1000 : 0) : 0;
  const frame = scene && sync ? Math.min(scene.frames.length - 1, Math.max(0, Math.round(syncedTime * scene.fps))) : localFrame;
  const playing = sync?.playing ?? localPlaying;
  const setPlaying = (value: boolean) => sync ? sync.onPlayingChange(value) : setLocalPlaying(value);
  const setFrame = (value: number) => { const bounded = Math.max(0, Math.min((scene?.frames.length ?? 1) - 1, value)); if (sync && scene) sync.onTimeChange(bounded / scene.fps); else setLocalFrame(bounded); };

  useEffect(() => { let cancelled = false; setScene(null); setError(null); fetch(sceneUrl).then((response) => response.json()).then((value: unknown) => { if (!validScene(value)) throw new Error("The scene artifact is not valid."); if (!cancelled) { setScene(value); setLocalFrame(0); } }).catch((cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : "Unable to load 3D scene.")); return () => { cancelled = true; }; }, [sceneUrl]);
  useEffect(() => { if (!scene || !playing || sync) return; let animation = 0; let last = performance.now(); let carry = 0; const step = (now: number) => { carry += (now - last) / 1000 * Math.max(1, scene.fps) * speed; last = now; const advance = Math.floor(carry); if (advance > 0) { carry -= advance; setLocalFrame((value) => (value + advance) % scene.frames.length); } animation = requestAnimationFrame(step); }; animation = requestAnimationFrame(step); return () => cancelAnimationFrame(animation); }, [playing, scene, speed, sync]);
  useEffect(() => {
    if (!scene || !bounds || !canvas.current) return; const element = canvas.current; const ratio = window.devicePixelRatio || 1; const rect = element.getBoundingClientRect(); element.width = Math.max(1, Math.round(rect.width * ratio)); element.height = Math.max(1, Math.round(rect.height * ratio)); const context = element.getContext("2d"); if (!context) return; context.scale(ratio, ratio); const width = rect.width; const height = rect.height; const backdrop = context.createLinearGradient(0, 0, 0, height); backdrop.addColorStop(0, "#fdfefe"); backdrop.addColorStop(.55, "#f2f5f8"); backdrop.addColorStop(1, "#e6eaf0"); context.fillStyle = backdrop; context.fillRect(0, 0, width, height);
    const points = scene.frames[frame] ?? scene.frames[0];
    const root = points[0] ?? bounds.center; const cameraCenter = [root[0], root[1], bounds.min[2]];
    const projectFull = (point: number[]) => { const x = point[0] - cameraCenter[0]; const y = point[1] - cameraCenter[1]; const z = point[2] - cameraCenter[2]; const cy = Math.cos(yaw); const sy = Math.sin(yaw); const cp = Math.cos(pitch); const sp = Math.sin(pitch); const horizontal = cy * x - sy * y; const depthBase = sy * x + cy * y; const vertical = cp * z - sp * depthBase; const depth = sp * z + cp * depthBase + bounds.scale * 2.6; const scale = Math.min(width, height) * 1.55 * zoom / Math.max(depth, bounds.scale * .45); return { x: width * .5 + horizontal * scale, y: height * .78 - vertical * scale, depth, px: scale }; };
    const project = (point: number[]) => { const projected = projectFull(point); return [projected.x, projected.y] as const; };
    const ground = bounds.min[2] - bounds.scale * .02;
    // World-anchored checker floor (MuJoCo style): cells stay fixed in the
    // world while the camera follows the root, so real travel stays visible.
    const cell = Math.max(.3, bounds.scale * .42); const range = bounds.scale * 2.6;
    for (let ix = Math.floor((cameraCenter[0] - range) / cell); ix * cell < cameraCenter[0] + range; ix += 1) {
      for (let iy = Math.floor((cameraCenter[1] - range) / cell); iy * cell < cameraCenter[1] + range; iy += 1) {
        const fade = Math.max(0, 1 - Math.hypot((ix + .5) * cell - cameraCenter[0], (iy + .5) * cell - cameraCenter[1]) / range);
        if (fade <= 0) continue;
        context.fillStyle = (ix + iy) % 2 ? `rgba(198,206,217,${.5 * fade})` : `rgba(225,230,237,${.5 * fade})`;
        const corners = [project([ix * cell, iy * cell, ground]), project([(ix + 1) * cell, iy * cell, ground]), project([(ix + 1) * cell, (iy + 1) * cell, ground]), project([ix * cell, (iy + 1) * cell, ground])];
        context.beginPath(); context.moveTo(...corners[0]); context.lineTo(...corners[1]); context.lineTo(...corners[2]); context.lineTo(...corners[3]); context.closePath(); context.fill();
      }
    }
    // Shared capsule renderer for robot and human: shaded limbs, depth-sorted
    // so near links occlude far ones. Robot edge order comes from
    // render-robot-motion.py's KINEMATIC_CHAINS: 0-13 legs, 14-17 torso, 18+ arms.
    const isRobot = scene.kind === "robot";
    const partOfEdge = (index: number) => isRobot ? (index < 14 ? "leg" : index < 18 ? "torso" : "arm") : "limb";
    const radiusByPart: Record<string, number> = isRobot ? { leg: .042, torso: .06, arm: .031 } : { limb: .027 };
    const paletteByPart: Record<string, readonly [string, string, string]> = isRobot
      ? { leg: ["#f5f7fa", "#c6cdd6", "#7f8895"], torso: ["#e7ebf0", "#adb6c1", "#666f7c"], arm: ["#f5f7fa", "#c6cdd6", "#7f8895"] }
      : { limb: ["#d4e0f2", "#8fa9cd", "#54719c"] };
    const outline = "rgba(43,52,65,.78)";
    const shadowAnchors = isRobot ? [points[7], points[15]].filter(Boolean) : [...points].sort((first, second) => (first[2] ?? 0) - (second[2] ?? 0)).slice(0, 2);
    for (const anchor of shadowAnchors) { const spot = projectFull([anchor[0], anchor[1], ground]); const radius = spot.px * .13; const shadow = context.createRadialGradient(spot.x, spot.y, 0, spot.x, spot.y, radius); shadow.addColorStop(0, "rgba(28,35,46,.3)"); shadow.addColorStop(1, "rgba(28,35,46,0)"); context.fillStyle = shadow; context.save(); context.translate(spot.x, spot.y); context.scale(1, .32); context.beginPath(); context.arc(0, 0, radius, 0, Math.PI * 2); context.fill(); context.restore(); }
    const links = scene.edges.map((edge, index) => ({ index, start: points[edge[0]], end: points[edge[1]] })).filter((link) => link.start && link.end).map((link) => { const a = projectFull(link.start); const b = projectFull(link.end); return { index: link.index, a, b, depth: (a.depth + b.depth) / 2 }; }).sort((first, second) => second.depth - first.depth);
    for (const link of links) {
      const part = partOfEdge(link.index);
      const [light, mid, dark] = paletteByPart[part];
      const strokeWidth = Math.max(2.5, radiusByPart[part] * (link.a.px + link.b.px));
      const midX = (link.a.x + link.b.x) / 2; const midY = (link.a.y + link.b.y) / 2;
      const shading = context.createLinearGradient(midX, midY - strokeWidth * .62, midX, midY + strokeWidth * .62);
      shading.addColorStop(0, light); shading.addColorStop(.55, mid); shading.addColorStop(1, dark);
      context.lineCap = "round";
      context.strokeStyle = outline; context.lineWidth = strokeWidth + 2; context.beginPath(); context.moveTo(link.a.x, link.a.y); context.lineTo(link.b.x, link.b.y); context.stroke();
      context.strokeStyle = shading; context.lineWidth = strokeWidth; context.beginPath(); context.moveTo(link.a.x, link.a.y); context.lineTo(link.b.x, link.b.y); context.stroke();
      if (isRobot) {
        const jointRadius = strokeWidth * .56;
        const housing = context.createRadialGradient(link.b.x - jointRadius * .3, link.b.y - jointRadius * .35, jointRadius * .15, link.b.x, link.b.y, jointRadius);
        housing.addColorStop(0, "#49525f"); housing.addColorStop(1, "#20262f");
        context.fillStyle = housing; context.beginPath(); context.arc(link.b.x, link.b.y, jointRadius, 0, Math.PI * 2); context.fill();
        context.strokeStyle = "rgba(255,255,255,.4)"; context.lineWidth = 1; context.stroke();
      }
    }
    const head = points[isRobot ? 19 : 15];
    if (head) {
      const spot = projectFull(head);
      const headRadius = Math.max(5, spot.px * (isRobot ? .085 : .105));
      const shell = context.createRadialGradient(spot.x - headRadius * .35, spot.y - headRadius * .45, headRadius * .2, spot.x, spot.y, headRadius);
      if (isRobot) { shell.addColorStop(0, "#ffffff"); shell.addColorStop(.65, "#c6cdd6"); shell.addColorStop(1, "#79828f"); } else { shell.addColorStop(0, "#dee8f6"); shell.addColorStop(.65, "#9fb4d4"); shell.addColorStop(1, "#5c789f"); }
      context.fillStyle = shell; context.strokeStyle = outline; context.lineWidth = 1.5;
      context.beginPath(); context.arc(spot.x, spot.y, headRadius, 0, Math.PI * 2); context.fill(); context.stroke();
      if (isRobot) { context.fillStyle = "rgba(16,21,28,.9)"; context.save(); context.translate(spot.x, spot.y + headRadius * .12); context.scale(1, .7); context.beginPath(); context.arc(0, 0, headRadius * .6, 0, Math.PI * 2); context.fill(); context.restore(); }
    }
    if (isRobot && points[18]) { const spot = projectFull(points[18]); const glow = Math.max(2, spot.px * .014); context.save(); context.shadowColor = "#2f9dff"; context.shadowBlur = glow * 3.4; context.fillStyle = "#5cb8ff"; context.beginPath(); context.arc(spot.x, spot.y - glow, glow, 0, Math.PI * 2); context.fill(); context.restore(); }
  }, [bounds, frame, pitch, scene, yaw, zoom]);
  const reset = () => { setYaw(-.78); setPitch(.43); setZoom(1); };
  return <section className="motion-3d"><div className="motion-3d__heading"><div><b>{title}</b><span>{scene ? `${scene.kind === "robot" ? "Unitree G1" : "SMPL-X"} · interactive 3D preview` : "Loading 3D scene…"}</span></div>{downloadUrl ? <a href={downloadUrl} target="_blank">MP4 evidence</a> : null}</div><div className="motion-3d__canvas"><canvas ref={canvas} aria-label={`${title} interactive 3D viewer`} onPointerDown={(event) => { drag.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (!drag.current) return; const dx = event.clientX - drag.current.x; const dy = event.clientY - drag.current.y; drag.current = { x: event.clientX, y: event.clientY }; setYaw((value) => value + dx * .012); setPitch((value) => Math.max(-1.15, Math.min(1.15, value + dy * .012))); }} onPointerUp={() => { drag.current = null; }} />{error ? <p className="motion-3d__message">{error}</p> : null}{!scene && !error ? <p className="motion-3d__message">Preparing the interactive scene…</p> : null}<span className="motion-3d__hint">Drag to orbit · scroll to zoom</span></div><div className="motion-3d__controls"><button type="button" aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying(!playing)}>{playing ? <Pause size={14} /> : <Play size={14} />}</button><input aria-label="Frame" type="range" min="0" max={Math.max(0, (scene?.frames.length ?? 1) - 1)} value={frame} onChange={(event) => { setPlaying(false); setFrame(Number(event.target.value)); }} /><span>{scene ? `${frame + 1}/${scene.frames.length}` : "—"}</span><select aria-label="Playback speed" value={speed} disabled={Boolean(sync)} onChange={(event) => setSpeed(Number(event.target.value))}><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option></select><button type="button" aria-label="Reset isometric view" onClick={reset}><RotateCcw size={14} /></button></div></section>;
}
