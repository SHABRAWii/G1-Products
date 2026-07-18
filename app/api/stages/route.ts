import { NextResponse } from "next/server";
import { listStageDefinitions } from "@/lib/stage-registry";

export async function GET() {
  return NextResponse.json({ data: listStageDefinitions() });
}
