import { NextResponse } from "next/server";
import { databaseConfigured } from "@/lib/db";
import { retryArtifactExport } from "@/lib/artifact-exports";

type Context = { params: Promise<{ exportId: string }> };

export async function POST(_: Request, { params }: Context) {
  if (!databaseConfigured()) {
    return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  }
  try {
    const { exportId } = await params;
    const data = await retryArtifactExport(exportId);
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to retry artifact export." },
      { status: 409 },
    );
  }
}
