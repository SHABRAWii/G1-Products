import { NextResponse } from "next/server";
import { databaseConfigured } from "@/lib/db";
import { OrchestrationError, retryJobStage } from "@/lib/orchestration";

type Context = { params: Promise<{ jobId: string; stageId: string }> };

export async function POST(_: Request, { params }: Context) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const { jobId, stageId } = await params;
    return NextResponse.json({ data: await retryJobStage(jobId, stageId) });
  } catch (error) {
    const status = error instanceof OrchestrationError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to retry stage." }, { status });
  }
}
