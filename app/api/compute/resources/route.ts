import { NextResponse } from "next/server";
import { databaseConfigured, ensureMvpWorkspace, prisma } from "@/lib/db";

export async function GET() {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const { workspace } = await ensureMvpWorkspace();
    const data = await prisma.computeResource.findMany({
      where: { workspaceId: workspace.id },
      include: {
        leases: {
          where: { state: "ACTIVE" },
          include: { job: { select: { id: true, name: true } }, stageAttempt: { select: { id: true, startedAt: true } } },
        },
      },
      orderBy: { lastSeenAt: "desc" },
    });
    return NextResponse.json({ data, meta: { activeResources: data.filter((resource) => resource.state === "RUNNING").length, activeLeases: data.reduce((total, resource) => total + resource.leases.length, 0) } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to retrieve compute resources." }, { status: 503 });
  }
}
