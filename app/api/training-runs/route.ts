import { NextRequest, NextResponse } from "next/server";
import { PipelineStage, StageStatus } from "@prisma/client";
import { databaseConfigured, ensureMvpWorkspace, prisma } from "@/lib/db";
import { completeTrainingTelemetry, createTrainingTelemetry, ingestTrainingLog } from "@/lib/training-telemetry";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function GET() {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  const { workspace } = await ensureMvpWorkspace();
  const runs = await prisma.trainingRun.findMany({
    where: { workspaceId: workspace.id },
    include: {
      recipe: true,
      policy: {
        include: {
          robotModel: true,
          versions: { orderBy: { version: "desc" }, take: 1 },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  const jobIds = runs.flatMap((run) => run.jobId ? [run.jobId] : []);
  const legacyStages = jobIds.length ? await prisma.jobStage.findMany({
    where: { jobId: { in: jobIds }, stage: PipelineStage.TRAINING },
    select: {
      jobId: true,
      attempts: {
        where: { status: StageStatus.SUCCEEDED },
        orderBy: { attempt: "desc" },
        take: 1,
        select: { result: true },
      },
    },
  }) : [];
  const attemptByJob = new Map(legacyStages.map((stage) => [stage.jobId, stage.attempts[0]?.result]));
  const data = runs.map((run) => {
    const metrics = objectValue(run.metrics);
    if (metrics.telemetry || metrics.report || !run.jobId) return run;
    const attempt = objectValue(attemptByJob.get(run.jobId));
    const logs = Array.isArray(attempt.logs) ? attempt.logs.filter((line): line is string => typeof line === "string") : [];
    if (!logs.length) return run;
    const recipeConfig = objectValue(run.recipe.config);
    const telemetry = createTrainingTelemetry(Number(recipeConfig.maxIterations) || 0);
    logs.forEach((line) => ingestTrainingLog(telemetry, line));
    completeTrainingTelemetry(telemetry, true);
    return { ...run, metrics: { ...metrics, telemetry, legacyLogRecovery: true } };
  });
  return NextResponse.json({ data }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const body = await request.json();
    if (typeof body.name !== "string" || typeof body.recipeId !== "string") throw new Error("name and recipeId are required.");
    const { workspace } = await ensureMvpWorkspace();
    const recipe = await prisma.trainingRecipe.findFirst({ where: { id: body.recipeId, workspaceId: workspace.id, active: true } });
    if (!recipe) return NextResponse.json({ error: "An active training recipe is required." }, { status: 400 });
    const policy = typeof body.policyId === "string" ? await prisma.policy.findFirst({ where: { id: body.policyId, workspaceId: workspace.id } }) : null;
    if (body.policyId && !policy) return NextResponse.json({ error: "policyId was not found." }, { status: 400 });
    const data = await prisma.trainingRun.create({
      data: { workspaceId: workspace.id, recipeId: recipe.id, policyId: policy?.id, name: body.name.trim(), status: "QUEUED", metrics: {} },
      include: {
        recipe: true,
        policy: {
          include: {
            robotModel: true,
            versions: { orderBy: { version: "desc" }, take: 1 },
          },
        },
      },
    });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create training run." }, { status: 400 });
  }
}
