import { CostKind } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured, ensureMvpWorkspace, prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const kind = request.nextUrl.searchParams.get("kind");
    const requestedLimit = Number(request.nextUrl.searchParams.get("limit") ?? "100");
    const limit = Number.isFinite(requestedLimit) ? Math.min(250, Math.max(1, Math.floor(requestedLimit))) : 100;
    const { workspace } = await ensureMvpWorkspace();
    const data = await prisma.costLedgerEntry.findMany({
      where: { workspaceId: workspace.id, ...(kind && Object.values(CostKind).includes(kind as CostKind) ? { kind: kind as CostKind } : {}) },
      include: { job: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return NextResponse.json({ data, meta: { total: data.length } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to retrieve ledger." }, { status: 503 });
  }
}
