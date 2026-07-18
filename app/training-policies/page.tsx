import { PageHeader } from "@/components/page-header";

export default function TrainingPoliciesPage() {
  return <><PageHeader eyebrow="Future module" title="Training & Policies" description="Training is intentionally disabled in this MVP. The pre-training motion pipeline can be tested end to end first." /><article className="panel"><h2>Training will be enabled later</h2><p className="empty-state">No sample runs, policies, rewards, or costs are shown here. When the training module is added, this workspace will use the same artifact, job, compute, and cost records.</p></article></>;
}
