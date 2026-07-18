import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured, ensureMvpWorkspace, prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const requestedDays = Number(request.nextUrl.searchParams.get("days") ?? "30");
    const days = Number.isFinite(requestedDays) ? Math.min(365, Math.max(1, Math.floor(requestedDays))) : 30;
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { workspace } = await ensureMvpWorkspace();
    const entries = await prisma.costLedgerEntry.findMany({ where: { workspaceId: workspace.id, createdAt: { gte: from } }, orderBy: { createdAt: "desc" } });
    const byKind: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const entry of entries) {
      byKind[entry.kind] = (byKind[entry.kind] ?? 0) + entry.amountMinor;
      byCategory[entry.category] = (byCategory[entry.category] ?? 0) + entry.amountMinor;
    }
    return NextResponse.json({
      data: {
        currency: entries[0]?.currency ?? "USD",
        from: from.toISOString(),
        to: new Date().toISOString(),
        totals: { estimatedMinor: byKind.ESTIMATED ?? 0, observedMinor: byKind.OBSERVED ?? 0, reconciledMinor: byKind.RECONCILED ?? 0, allMinor: entries.reduce((sum, entry) => sum + entry.amountMinor, 0) },
        byCategory,
        entries: entries.length,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to summarize costs." }, { status: 503 });
  }
}
