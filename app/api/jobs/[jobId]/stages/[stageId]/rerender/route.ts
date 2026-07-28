import { NextResponse } from "next/server";
import { databaseConfigured } from "@/lib/db";
import {
  dispatchNextStage,
  OrchestrationError,
  rerunVisualizationStage,
} from "@/lib/orchestration";

type Context = { params: Promise<{ jobId: string; stageId: string }> };

export async function POST(_: Request, { params }: Context) {
  if (!databaseConfigured()) {
    return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  }
  try {
    const { jobId, stageId } = await params;
    const queued = await rerunVisualizationStage(jobId, stageId);
    const dispatch = await dispatchNextStage(jobId);
    return NextResponse.json({ data: { ...queued, dispatch } });
  } catch (error) {
    const status = error instanceof OrchestrationError ? error.status : 400;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to re-render visualization." },
      { status },
    );
  }
}
