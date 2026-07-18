import { NextRequest, NextResponse } from "next/server";
import { StageArtifactRole } from "@prisma/client";
import { databaseConfigured } from "@/lib/db";
import { completeStage, OrchestrationError } from "@/lib/orchestration";

type Context = { params: Promise<{ jobId: string; stageId: string }> };

export async function POST(request: NextRequest, { params }: Context) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const { jobId, stageId } = await params;
    const body = await request.json().catch(() => ({}));
    const outputs = Array.isArray(body.outputs) ? body.outputs.map((output: unknown) => {
      if (!output || typeof output !== "object" || typeof (output as { assetVersionId?: unknown }).assetVersionId !== "string") throw new Error("Each output needs an assetVersionId.");
      const role = (output as { role?: unknown }).role;
      if (role !== undefined && role !== "OUTPUT" && role !== "PREVIEW" && role !== "EVIDENCE") throw new Error("Output role must be OUTPUT, PREVIEW, or EVIDENCE.");
      return { assetVersionId: (output as { assetVersionId: string }).assetVersionId, role: (role ?? "OUTPUT") as StageArtifactRole };
    }) : [];
    return NextResponse.json({ data: await completeStage(jobId, stageId, body.result ?? {}, outputs) });
  } catch (error) {
    const status = error instanceof OrchestrationError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to complete stage." }, { status });
  }
}
