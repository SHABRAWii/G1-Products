import { NextResponse } from "next/server";
import { databaseConfigured, ensureMvpWorkspace, prisma } from "@/lib/db";
import { getArtifact, objectStorageConfigured } from "@/lib/object-storage";

type Context = { params: Promise<{ versionId: string }> };

export const runtime = "nodejs";

export async function GET(_: Request, { params }: Context) {
  if (!databaseConfigured() || !objectStorageConfigured()) return NextResponse.json({ error: "Artifact storage is not configured." }, { status: 503 });
  try {
    const { versionId } = await params;
    const { workspace } = await ensureMvpWorkspace();
    const version = await prisma.assetVersion.findFirst({ where: { id: versionId, asset: { workspaceId: workspace.id } } });
    if (!version) return NextResponse.json({ error: "Artifact version was not found." }, { status: 404 });
    const artifact = await getArtifact(version.storageKey);
    return new Response(artifact.body, { headers: { "Content-Type": artifact.contentType, "Content-Length": artifact.contentLength?.toString() ?? "", "Cache-Control": "private, max-age=60", "Content-Disposition": "inline" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to retrieve artifact." }, { status: 404 });
  }
}
