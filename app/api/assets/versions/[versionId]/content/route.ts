import { NextResponse } from "next/server";
import { databaseConfigured, ensureMvpWorkspace, prisma } from "@/lib/db";
import { getArtifact, objectStorageConfigured } from "@/lib/object-storage";

type Context = { params: Promise<{ versionId: string }> };

export const runtime = "nodejs";

export async function GET(request: Request, { params }: Context) {
  if (!databaseConfigured() || !objectStorageConfigured()) return NextResponse.json({ error: "Artifact storage is not configured." }, { status: 503 });
  try {
    const { versionId } = await params;
    const { workspace } = await ensureMvpWorkspace();
    const version = await prisma.assetVersion.findFirst({ where: { id: versionId, asset: { workspaceId: workspace.id } } });
    if (!version) return NextResponse.json({ error: "Artifact version was not found." }, { status: 404 });
    const range = request.headers.get("range") ?? undefined;
    if (range && !/^bytes=\d*-\d*$/.test(range)) {
      return new Response(null, {
        status: 416,
        headers: { "Accept-Ranges": "bytes" },
      });
    }
    const artifact = await getArtifact(version.storageKey, range);
    const headers = new Headers({
      "Content-Type": artifact.contentType,
      "Cache-Control": "private, max-age=60",
      "Content-Disposition": "inline",
      "Accept-Ranges": artifact.acceptRanges ?? "bytes",
    });
    if (artifact.contentLength !== undefined) {
      headers.set("Content-Length", artifact.contentLength.toString());
    }
    if (artifact.contentRange) headers.set("Content-Range", artifact.contentRange);
    return new Response(artifact.body, {
      status: range ? 206 : 200,
      headers,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to retrieve artifact." }, { status: 404 });
  }
}
