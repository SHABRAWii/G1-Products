import Link from "next/link";
import { JobTable } from "@/components/job-table";
import { PageHeader } from "@/components/page-header";

export default function HomePage() {
  return <><PageHeader eyebrow="Workspace overview" title="Home" description="Start with a real source asset, then track its actual pre-training pipeline work." action={<Link className="button button--primary" href="/new-job">+ <span>New Job</span></Link>} /><section className="dashboard-main"><article className="panel"><h2>Pre-training MVP</h2><p>Upload a video or pose artifact in Assets, create a bounded job, and use its detail view to dispatch stages, complete local adapter tests, approve pose review, retry, or cancel.</p><div className="compute-summary__actions"><Link className="button button--primary" href="/assets">Upload asset</Link><Link className="button button--subtle" href="/new-job">Create job</Link></div></article><article className="panel"><div className="panel__header"><div><h2>Recent jobs</h2><p>Only records created in this workspace are shown.</p></div><Link href="/jobs">View all jobs</Link></div><JobTable compact /></article></section></>;
}
