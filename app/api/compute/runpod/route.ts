import { NextRequest, NextResponse } from "next/server";
import {
  getRunPodSnapshot,
  RunPodControlError,
  startRunPod,
  stopRunPod,
} from "@/lib/runpod-control";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ data: await getRunPodSnapshot() }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to retrieve RunPod status." },
      { status: error instanceof RunPodControlError ? error.status : 503 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { action?: string };
    if (body.action !== "start" && body.action !== "stop") {
      return NextResponse.json({ error: "action must be start or stop." }, { status: 400 });
    }
    const data = body.action === "start" ? await startRunPod() : await stopRunPod();
    return NextResponse.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to control RunPod." },
      { status: error instanceof RunPodControlError ? error.status : 503 },
    );
  }
}
