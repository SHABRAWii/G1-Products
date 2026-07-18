import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured, ensureMvpWorkspace, prisma } from "@/lib/db";

export async function GET() {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  const { workspace } = await ensureMvpWorkspace();
  const data = await prisma.simulationRun.findMany({ where: { workspaceId: workspace.id }, include: { scenario: true, policyVersion: { include: { policy: true } } }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const body = await request.json();
    if (typeof body.policyVersionId !== "string" || typeof body.scenarioId !== "string") throw new Error("policyVersionId and scenarioId are required.");
    const { workspace } = await ensureMvpWorkspace();
    const [version, scenario] = await Promise.all([
      prisma.policyVersion.findFirst({ where: { id: body.policyVersionId, policy: { workspaceId: workspace.id } } }),
      prisma.simulationScenario.findFirst({ where: { id: body.scenarioId, workspaceId: workspace.id, active: true } }),
    ]);
    if (!version || !scenario) return NextResponse.json({ error: "An active scenario and workspace policy version are required." }, { status: 400 });
    const data = await prisma.simulationRun.create({ data: { workspaceId: workspace.id, policyVersionId: version.id, scenarioId: scenario.id, status: "QUEUED", metrics: {} }, include: { scenario: true, policyVersion: { include: { policy: true } } } });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create simulation run." }, { status: 400 });
  }
}
