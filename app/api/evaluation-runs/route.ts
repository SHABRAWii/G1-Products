import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured, ensureMvpWorkspace, prisma } from "@/lib/db";

export async function GET() {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  const { workspace } = await ensureMvpWorkspace();
  const data = await prisma.evaluationRun.findMany({ where: { workspaceId: workspace.id }, include: { policyVersion: { include: { policy: true } } }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const body = await request.json();
    if (typeof body.policyVersionId !== "string") throw new Error("policyVersionId is required.");
    const { workspace } = await ensureMvpWorkspace();
    const version = await prisma.policyVersion.findFirst({ where: { id: body.policyVersionId, policy: { workspaceId: workspace.id } } });
    if (!version) return NextResponse.json({ error: "policyVersionId was not found." }, { status: 400 });
    const data = await prisma.evaluationRun.create({ data: { workspaceId: workspace.id, policyVersionId: version.id, status: "QUEUED", metrics: {} }, include: { policyVersion: { include: { policy: true } } } });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create evaluation run." }, { status: 400 });
  }
}
