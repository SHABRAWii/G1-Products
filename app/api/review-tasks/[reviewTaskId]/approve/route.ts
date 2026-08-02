import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured } from "@/lib/db";
import { approveReviewTask, dispatchNextStage, OrchestrationError } from "@/lib/orchestration";
import { isExecutablePipelineStage } from "@/lib/worker-capabilities";
import { localPipelineWorkerAvailability } from "@/lib/worker-status";

type Context = { params: Promise<{ reviewTaskId: string }> };

export async function POST(request: NextRequest, { params }: Context) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const { reviewTaskId } = await params;
    const body = await request.json().catch(() => ({}));
    const approval = await approveReviewTask(reviewTaskId, body.reviewedBy, body.decisionNote);
    // Approval is the operator's explicit release of the downstream automated
    // work. Dispatch it immediately when the worker is ready so the reviewer
    // never has to click a second, redundant "start next stage" button.
    let worker: Awaited<ReturnType<typeof localPipelineWorkerAvailability>> | null = null;
    let autoDispatch: unknown = { state: "not_required" };
    if (approval.state === "ready") {
      if (isExecutablePipelineStage(approval.nextStage?.stage)) {
        worker = await localPipelineWorkerAvailability(approval.nextStage.stage);
      }
      if (worker && !worker.ready) {
        autoDispatch = { state: "worker_unavailable", detail: worker.detail };
      } else {
        try {
          autoDispatch = await dispatchNextStage(approval.jobId);
        } catch (error) {
          // Approval is already durable. Return the dispatch reason for the UI
          // rather than presenting the successful approval as a failed action.
          autoDispatch = { state: "not_dispatched", detail: error instanceof Error ? error.message : "Unable to dispatch the next stage." };
        }
      }
    }
    return NextResponse.json({ data: { ...approval, autoDispatch, worker } });
  } catch (error) {
    const status = error instanceof OrchestrationError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to approve review." }, { status });
  }
}
