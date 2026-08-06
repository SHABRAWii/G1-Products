import { PageHeader } from "@/components/page-header";
import { RunPodControlPanel } from "@/components/runpod-control-panel";

export default function ComputeCostsPage() {
  return <><PageHeader eyebrow="Operations" title="Compute & Costs" description="Control the RunPod GPU plane and inspect live worker utilization, work, and cost evidence." /><RunPodControlPanel /></>;
}
