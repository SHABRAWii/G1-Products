import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured } from "@/lib/db";
import { failStage, OrchestrationError } from "@/lib/orchestration";

type Context = { params: Promise<{ jobId: string; stageId: string }> };

export async function POST(request: NextRequest, { params }: Context) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const { jobId, stageId } = await params;
    const body = await request.json();
    if (typeof body.retryable !== "boolean") throw new Error("retryable is required.");
    return NextResponse.json({ data: await failStage(jobId, stageId, { retryable: body.retryable, errorCode: typeof body.errorCode === "string" ? body.errorCode : undefined, message: typeof body.message === "string" ? body.message : undefined }) });
  } catch (error) {
    const status = error instanceof OrchestrationError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to fail stage." }, { status });
  }
}
