import { JobStatus, Prisma, StageStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured, ensureMvpWorkspace, prisma } from "@/lib/db";
import { createJobPlan, fromPrismaStage, isPipelineStage, toPrismaStage } from "@/lib/job-planner";
import { normalizeTrainingStageConfig } from "@/lib/training-config";

export async function GET() {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const data = await prisma.job.findMany({ include: { stages: { orderBy: { position: "asc" } } }, orderBy: { createdAt: "desc" }, take: 100 });
    return NextResponse.json({ data: data.map((job) => ({ id: job.id, name: job.name, robot: job.robotModel, status: job.status.toLowerCase(), startStage: fromPrismaStage(job.startStage), endStage: fromPrismaStage(job.endStage), stages: job.stages.map((stage) => ({ stage: fromPrismaStage(stage.stage), status: stage.status.toLowerCase(), position: stage.position })), estimateMinor: job.estimateMinor, currency: job.estimateCurrency, createdAt: job.createdAt.toISOString() })), meta: { source: "database", total: data.length } });
  } catch (error) {
    return NextResponse.json({ error: "Database query failed.", detail: error instanceof Error ? error.message : "Unknown error" }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (typeof body.name !== "string" || body.name.trim().length < 3) throw new Error("name must contain at least 3 characters.");
    if (!isPipelineStage(body.startStage) || !isPipelineStage(body.endStage)) throw new Error("startStage and endStage must be supported pipeline stages.");
    const plan = createJobPlan(body);
    const trainingConfig = plan.stages.some((stage) => stage.stage === "training")
      ? normalizeTrainingStageConfig(body.trainingConfig)
      : null;
    if (trainingConfig && body.robotModel !== "unitree_g1") throw new Error("Training currently supports only the Unitree G1 29-DoF robot.");
    if (body.startStage !== "video_generation" && typeof body.inputAssetVersionId !== "string") throw new Error("inputAssetVersionId is required when starting after video generation.");
    if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured. Start PostgreSQL and set DATABASE_URL before creating jobs." }, { status: 503 });
    const { workspace, project } = await ensureMvpWorkspace();
    if (body.inputAssetVersionId) {
      const input = await prisma.assetVersion.findFirst({ where: { id: body.inputAssetVersionId, asset: { workspaceId: workspace.id } }, include: { asset: true } });
      if (!input) return NextResponse.json({ error: "inputAssetVersionId was not found in this workspace." }, { status: 400 });
      if (input.approvalStatus !== "APPROVED") return NextResponse.json({ error: "The selected asset version must be approved before creating a job." }, { status: 400 });
      const acceptedTypes: Record<string, string[]> = {
        pose_extraction: ["VIDEO_SOURCE", "VIDEO_GENERATED"], pose_review: ["POSE_SMPLX", "POSE_REVIEWED"], robot_retargeting: ["POSE_SMPLX", "POSE_REVIEWED"], visualization: ["MOTION_ROBOT"], training: ["MOTION_ROBOT"],
      };
      if (!acceptedTypes[body.startStage]?.includes(input.asset.type)) return NextResponse.json({ error: `The selected ${input.asset.type} asset is not compatible with ${body.startStage}.` }, { status: 400 });
      if ((body.startStage === "training" || (body.startStage === "visualization" && input.asset.type === "MOTION_ROBOT"))
        && input.schemaVersion !== "motion.robot.unitree-g1-29dof-npz/v2") {
        return NextResponse.json({ error: "This stage requires the safe motion.robot.unitree-g1-29dof-npz/v2 artifact contract. Legacy pickle motion cannot be executed." }, { status: 400 });
      }
    }
    const job = await prisma.$transaction(async (tx) => tx.job.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        inputAssetVersionId: body.inputAssetVersionId,
        name: body.name.trim(),
        robotModel: typeof body.robotModel === "string" ? body.robotModel : "unitree_g1",
        startStage: toPrismaStage(body.startStage),
        endStage: toPrismaStage(body.endStage),
        status: JobStatus.QUEUED,
        plan: plan as unknown as Prisma.InputJsonValue,
        estimateMinor: plan.estimateMinor,
        stages: { create: plan.stages.map((stage) => ({ stage: toPrismaStage(stage.stage), position: stage.position, adapter: stage.adapter, status: StageStatus.PENDING, config: stage.stage === "training" ? trainingConfig ?? {} : {}, ...(stage.position === 0 && body.inputAssetVersionId ? { artifacts: { create: { assetVersionId: body.inputAssetVersionId, role: "INPUT" } } } : {}) })) },
        costs: { create: { workspaceId: workspace.id, kind: "ESTIMATED", category: "pipeline", provider: "robomotion", amountMinor: plan.estimateMinor, rateCard: "runpod-mvp-v1", metadata: { estimateMinutes: plan.estimateMinutes, storageBytes: plan.storageBytes } } },
        events: { create: { type: "job_queued", message: "Job plan was created and queued for dispatch.", metadata: { startStage: body.startStage, endStage: body.endStage, estimateMinor: plan.estimateMinor } } },
      },
    }));
    return NextResponse.json({ data: { id: job.id, status: job.status, plan, stages: plan.stages.map((stage) => ({ stage: stage.stage, position: stage.position, status: "PENDING" })) } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create job." }, { status: 400 });
  }
}
