import { PageHeader } from "@/components/page-header";

export default function SimulationPage() {
  return <><PageHeader eyebrow="Verification" title="Simulation" description="Simulation verification becomes available after a real policy is produced by the later training module." /><article className="panel"><h2>No simulation runs yet</h2><p className="empty-state">This screen deliberately contains no fabricated policies, scenarios, scores, or videos. Add training and a real policy version to enable simulation verification.</p></article></>;
}
