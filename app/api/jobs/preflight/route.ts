import { NextRequest, NextResponse } from "next/server";
import { createJobPlan } from "@/lib/job-planner";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const plan = createJobPlan(body);
    return NextResponse.json({
      data: plan,
      meta: { currency: "USD", rateCard: "runpod-mvp-v1", message: "Estimate only. Actual costs are recorded per stage attempt." },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid preflight request." }, { status: 400 });
  }
}
