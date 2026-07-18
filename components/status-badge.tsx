const statusMap: Record<string, { label: string; tone: "running" | "review" | "queued" | "failed" | "completed" }> = {
  running: { label: "Running", tone: "running" }, dispatching: { label: "Dispatching", tone: "running" },
  queued: { label: "Queued", tone: "queued" }, draft: { label: "Draft", tone: "queued" }, preflighted: { label: "Preflighted", tone: "queued" },
  waiting_review: { label: "Needs review", tone: "review" }, review: { label: "Needs review", tone: "review" },
  failed: { label: "Failed", tone: "failed" }, blocked: { label: "Blocked", tone: "failed" }, cancelled: { label: "Cancelled", tone: "failed" },
  succeeded: { label: "Completed", tone: "completed" }, completed: { label: "Completed", tone: "completed" },
};

export function StatusBadge({ status }: { status: string }) {
  const item = statusMap[status.toLowerCase()] ?? { label: status.replaceAll("_", " "), tone: "queued" as const };
  return <span className={`status status--${item.tone}`}>{item.label}</span>;
}
