import { AssetType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured, ensureMvpWorkspace, prisma } from "@/lib/db";

export async function GET() {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  try {
    const { workspace } = await ensureMvpWorkspace();
    const data = await prisma.asset.findMany({ where: { workspaceId: workspace.id }, include: { versions: { orderBy: { version: "desc" }, take: 1 } }, orderBy: { updatedAt: "desc" } });
    return NextResponse.json({ data: data.map((asset) => ({ id: asset.id, name: asset.name, type: asset.type, latestVersion: asset.versions[0] ? { id: asset.versions[0].id, version: asset.versions[0].version, approvalStatus: asset.versions[0].approvalStatus, schemaVersion: asset.versions[0].schemaVersion } : null })) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to list assets." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
    const body = await request.json();
    if (typeof body.name !== "string" || !Object.values(AssetType).includes(body.type)) throw new Error("name and a valid asset type are required.");
    const { workspace } = await ensureMvpWorkspace();
    const asset = await prisma.asset.create({ data: { workspaceId: workspace.id, name: body.name.trim(), type: body.type } });
    const version = await prisma.assetVersion.create({ data: { assetId: asset.id, version: 1, schemaVersion: body.schemaVersion ?? "artifact/v1", storageKey: body.storageKey ?? `pending/${asset.id}`, contentType: body.contentType ?? "application/octet-stream", byteSize: BigInt(body.byteSize ?? 0), checksum: body.checksum ?? "pending" } });
    return NextResponse.json({ data: { assetId: asset.id, versionId: version.id } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create asset." }, { status: 400 });
  }
}
