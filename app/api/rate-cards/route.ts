import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured, ensureMvpWorkspace, prisma } from "@/lib/db";

type RateItemInput = { sku?: unknown; category?: unknown; unit?: unknown; amountMinor?: unknown };

export async function GET() {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  const { workspace } = await ensureMvpWorkspace();
  const data = await prisma.rateCard.findMany({ where: { workspaceId: workspace.id }, include: { items: { orderBy: { sku: "asc" } } }, orderBy: [{ active: "desc" }, { effectiveAt: "desc" }] });
  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const body = await request.json();
    if (typeof body.name !== "string" || body.name.trim().length < 3) throw new Error("name must contain at least 3 characters.");
    if (!Array.isArray(body.items) || body.items.length === 0) throw new Error("At least one rate-card item is required.");
    const items = body.items.map((item: RateItemInput) => {
      const amountMinor = item.amountMinor;
      if (typeof item.sku !== "string" || typeof item.category !== "string" || typeof item.unit !== "string" || typeof amountMinor !== "number" || !Number.isInteger(amountMinor) || amountMinor < 0) throw new Error("Each item requires sku, category, unit, and a non-negative integer amountMinor.");
      return { sku: item.sku, category: item.category, unit: item.unit, amountMinor };
    });
    const { workspace } = await ensureMvpWorkspace();
    const data = await prisma.$transaction(async (tx) => {
      if (body.active !== false) await tx.rateCard.updateMany({ where: { workspaceId: workspace.id, active: true }, data: { active: false } });
      return tx.rateCard.create({ data: { workspaceId: workspace.id, name: body.name.trim(), currency: typeof body.currency === "string" ? body.currency.toUpperCase() : "USD", active: body.active !== false, items: { create: items } }, include: { items: true } });
    });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create rate card." }, { status: 400 });
  }
}
