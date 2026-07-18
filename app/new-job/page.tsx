import { PageHeader } from "@/components/page-header";
import { NewJobForm } from "@/components/new-job-form";

export default function NewJobPage() {
  return <><PageHeader eyebrow="New job" title="Start exactly where you need to." description="RoboMotion validates the artifact, pipeline path, and estimated resource use before dispatch." /><NewJobForm /></>;
}
