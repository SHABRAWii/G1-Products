import { NextResponse } from "next/server";
import { databaseConfigured } from "@/lib/db";
import { cancelJob, OrchestrationError } from "@/lib/orchestration";

type Context = { params: Promise<{ jobId: string }> };

export async function POST(_: Request, { params }: Context) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const { jobId } = await params;
    return NextResponse.json({ data: await cancelJob(jobId) });
  } catch (error) {
    const status = error instanceof OrchestrationError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to cancel job." }, { status });
  }
}
