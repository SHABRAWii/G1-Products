import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured, ensureMvpWorkspace, prisma } from "@/lib/db";

type Context = { params: Promise<{ simulationRunId: string }> };

export async function POST(request: NextRequest, { params }: Context) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const { simulationRunId } = await params;
    const body = await request.json();
    if (typeof body.verifiedBy !== "string" || !body.verifiedBy.trim() || typeof body.passed !== "boolean") throw new Error("verifiedBy and passed are required.");
    const { workspace } = await ensureMvpWorkspace();
    const run = await prisma.simulationRun.findFirst({ where: { id: simulationRunId, workspaceId: workspace.id } });
    if (!run) return NextResponse.json({ error: "Simulation run was not found." }, { status: 404 });
    const data = await prisma.simulationRun.update({ where: { id: run.id }, data: { status: body.passed ? "VERIFIED" : "FAILED", passed: body.passed, verifiedBy: body.verifiedBy.trim(), verificationNote: typeof body.note === "string" ? body.note.trim() : null, verifiedAt: new Date() } });
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to verify simulation run." }, { status: 400 });
  }
}
