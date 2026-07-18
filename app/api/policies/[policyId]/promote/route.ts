import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured, ensureMvpWorkspace, prisma } from "@/lib/db";

type Context = { params: Promise<{ policyId: string }> };

export async function POST(request: NextRequest, { params }: Context) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const { policyId } = await params;
    const body = await request.json();
    if (!Number.isInteger(body.version)) throw new Error("version is required.");
    const { workspace } = await ensureMvpWorkspace();
    const policy = await prisma.policy.findFirst({ where: { id: policyId, workspaceId: workspace.id } });
    if (!policy) return NextResponse.json({ error: "Policy was not found." }, { status: 404 });
    const data = await prisma.$transaction(async (tx) => {
      const version = await tx.policyVersion.findUnique({ where: { policyId_version: { policyId, version: body.version } } });
      if (!version) throw new Error("Policy version was not found.");
      const passingSimulation = await tx.simulationRun.findFirst({ where: { policyVersionId: version.id, status: "VERIFIED", passed: true } });
      if (!passingSimulation) throw new Error("A verified passing simulation is required before policy promotion.");
      await tx.policyVersion.update({ where: { id: version.id }, data: { status: "PROMOTED", promotedAt: new Date() } });
      return tx.policy.update({ where: { id: policyId }, data: { status: "PROMOTED" }, include: { versions: true } });
    });
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to promote policy." }, { status: 400 });
  }
}
