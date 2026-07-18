import { NextResponse } from "next/server";
import { databaseConfigured, ensureMvpWorkspace, prisma } from "@/lib/db";

export async function GET() {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  const { workspace } = await ensureMvpWorkspace();
  const data = await prisma.policy.findMany({ where: { workspaceId: workspace.id }, include: { robotModel: true, versions: { orderBy: { version: "desc" } } }, orderBy: { updatedAt: "desc" } });
  return NextResponse.json({ data });
}
