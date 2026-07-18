import { ReactNode } from "react";

export function MetricCard({ label, value, detail, trend, icon, tone = "blue" }: { label: string; value: string; detail: string; trend?: ReactNode; icon?: ReactNode; tone?: "blue" | "mint" | "violet" | "amber" | "pink" | "cyan" }) {
  return <article className="metric-card"><span className={`metric-card__icon metric-card__icon--${tone}`}>{icon}</span><div><p>{label}</p><strong>{value}</strong><span>{trend ? trend : null} {detail}</span></div></article>;
}
