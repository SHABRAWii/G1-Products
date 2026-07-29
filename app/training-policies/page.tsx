import { PageHeader } from "@/components/page-header";
import { TrainingRunTable } from "@/components/training-run-table";

export default function TrainingPoliciesPage() {
  return <><PageHeader eyebrow="Pipeline operations" title="Training & Policies" description="Track motion-imitation training runs in this workspace." /><article className="panel"><TrainingRunTable /></article></>;
}
