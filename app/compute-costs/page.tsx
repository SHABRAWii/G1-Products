import { PageHeader } from "@/components/page-header";

export default function ComputeCostsPage() {
  return <><PageHeader eyebrow="Operations" title="Compute & Costs" description="Actual stage attempts write compute leases and observed costs using the active database rate card." tabs={["Overview", "Resources", "Ledger", "Rate cards", "Budgets"]} /><article className="panel"><h2>Live operations data</h2><p className="empty-state">Run a job from Jobs to create real lease and ledger entries. No fabricated GPU utilization, provider spend, or invoice totals are displayed.</p></article></>;
}
