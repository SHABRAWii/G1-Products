import { NextResponse } from "next/server";
import { databaseConfigured, prisma } from "@/lib/db";
import { dispatchNextStage, OrchestrationError } from "@/lib/orchestration";
import { isExecutablePipelineStage } from "@/lib/worker-capabilities";
import { localPipelineWorkerAvailability } from "@/lib/worker-status";

type Context = { params: Promise<{ jobId: string }> };

export async function POST(_: Request, { params }: Context) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const { jobId } = await params;
    const next = await prisma.jobStage.findFirst({
      where: { jobId, status: { in: ["PENDING", "READY"] } },
      orderBy: { position: "asc" },
      select: { stage: true },
    });
    if (isExecutablePipelineStage(next?.stage)) {
      const worker = await localPipelineWorkerAvailability(next.stage);
      if (!worker.ready) return NextResponse.json({ error: `Stage was not dispatched: ${worker.detail}`, worker }, { status: 409 });
    }
    const data = await dispatchNextStage(jobId);
    return NextResponse.json({ data }, { status: data.state === "blocked" ? 409 : 200 });
  } catch (error) {
    const status = error instanceof OrchestrationError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to dispatch stage." }, { status });
  }
}
