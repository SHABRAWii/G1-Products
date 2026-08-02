import { NextResponse } from "next/server";
import { databaseConfigured, prisma } from "@/lib/db";
import { OrchestrationError } from "@/lib/orchestration";
import { fromPrismaStage } from "@/lib/job-planner";
import { localPipelineWorkerAvailability } from "@/lib/worker-status";

type Context = { params: Promise<{ jobId: string }> };

export async function GET(_: Request, { params }: Context) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const { jobId } = await params;
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: {
        stages: { include: { attempts: { orderBy: { attempt: "desc" } }, reviewTask: true, artifacts: { include: { assetVersion: { select: { id: true, contentType: true, schemaVersion: true, asset: { select: { name: true, type: true } } } } } } }, orderBy: { position: "asc" } },
        costs: { orderBy: { createdAt: "desc" } },
        reviewTasks: { orderBy: { createdAt: "desc" } },
        artifactExports: {
          orderBy: { createdAt: "desc" },
          include: {
            outputAssetVersion: {
              select: {
                id: true,
                contentType: true,
                schemaVersion: true,
                asset: { select: { name: true, type: true } },
              },
            },
          },
        },
        inputAssetVersion: { select: { id: true, contentType: true, schemaVersion: true, asset: { select: { name: true, type: true } } } },
      },
    });
    if (!job) throw new OrchestrationError("Job was not found.", 404);
    const worker = await localPipelineWorkerAvailability();
    return NextResponse.json({
      data: {
        ...job,
        startStage: fromPrismaStage(job.startStage),
        endStage: fromPrismaStage(job.endStage),
        stages: job.stages.map((stage) => ({ ...stage, stage: fromPrismaStage(stage.stage) })),
        worker,
      },
    });
  } catch (error) {
    const status = error instanceof OrchestrationError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to retrieve job." }, { status });
  }
}
