import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured, ensureMvpWorkspace, prisma } from "@/lib/db";

export async function GET() {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  const { workspace } = await ensureMvpWorkspace();
  const data = await prisma.budget.findMany({ where: { workspaceId: workspace.id }, include: { alerts: { orderBy: { createdAt: "desc" }, take: 5 } }, orderBy: { name: "asc" } });
  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const body = await request.json();
    if (typeof body.name !== "string" || !Number.isInteger(body.limitMinor) || body.limitMinor <= 0) throw new Error("name and a positive integer limitMinor are required.");
    if (body.enforcement !== undefined && body.enforcement !== "WARN" && body.enforcement !== "BLOCK") throw new Error("enforcement must be WARN or BLOCK.");
    const { workspace } = await ensureMvpWorkspace();
    const data = await prisma.budget.create({ data: { workspaceId: workspace.id, name: body.name.trim(), category: typeof body.category === "string" ? body.category : null, limitMinor: body.limitMinor, currency: typeof body.currency === "string" ? body.currency.toUpperCase() : "USD", alertPercent: Number.isInteger(body.alertPercent) ? body.alertPercent : 80, enforcement: body.enforcement ?? "WARN" } });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create budget." }, { status: 400 });
  }
}
