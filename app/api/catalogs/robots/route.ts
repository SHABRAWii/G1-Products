import { NextResponse } from "next/server";
import { databaseConfigured, ensureMvpWorkspace, prisma } from "@/lib/db";

export async function GET() {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  const { workspace } = await ensureMvpWorkspace();
  return NextResponse.json({ data: await prisma.robotModel.findMany({ where: { workspaceId: workspace.id }, orderBy: { name: "asc" } }) });
}
