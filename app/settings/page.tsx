import { PageHeader } from "@/components/page-header";

export default function SettingsPage() {
  return <><PageHeader eyebrow="Workspace administration" title="Settings & Integrations" description="Configure provider credentials, rate cards, budgets, and adapters before dispatching external work." tabs={["Integrations", "Robot models", "Storage", "Rate cards", "Budgets"]} /><article className="panel"><h2>Configuration is API-backed</h2><p className="empty-state">No provider is presented as connected until its real credentials and worker image are configured. Local PostgreSQL and MinIO are used only for this test environment.</p></article></>;
}
