import Link from "next/link";
import { JobTable } from "@/components/job-table";
import { PageHeader } from "@/components/page-header";

export default function JobsPage() {
  return <><PageHeader eyebrow="Pipeline operations" title="Jobs" description="Track and operate the real jobs created in this workspace." action={<Link href="/new-job" className="button button--primary">+ <span>New Job</span></Link>} /><article className="panel"><JobTable /></article></>;
}
