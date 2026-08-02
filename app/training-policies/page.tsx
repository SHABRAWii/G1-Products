import { PageHeader } from "@/components/page-header";
import { TrainingRunTable } from "@/components/training-run-table";

export default function TrainingPoliciesPage() {
  return <><PageHeader eyebrow="Policy lifecycle" title="Training & Policies" description="Track immutable training recipes, checkpoints, and candidate policy versions produced by pipeline jobs." /><article className="panel"><TrainingRunTable /></article></>;
}
