import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured } from "@/lib/db";
import { rejectReviewTask, OrchestrationError } from "@/lib/orchestration";

type Context = { params: Promise<{ reviewTaskId: string }> };

export async function POST(request: NextRequest, { params }: Context) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const { reviewTaskId } = await params;
    const body = await request.json().catch(() => ({}));
    return NextResponse.json({ data: await rejectReviewTask(reviewTaskId, body.reviewedBy, body.decisionNote) });
  } catch (error) {
    const status = error instanceof OrchestrationError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to reject review." }, { status });
  }
}
