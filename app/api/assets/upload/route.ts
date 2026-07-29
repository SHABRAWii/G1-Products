import { File } from "node:buffer";
import { AssetApprovalStatus, AssetType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured, ensureMvpWorkspace, prisma } from "@/lib/db";
import { objectStorageConfigured, putArtifact } from "@/lib/object-storage";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

export async function POST(request: NextRequest) {
  if (!databaseConfigured()) return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
  if (!objectStorageConfigured()) return NextResponse.json({ error: "Object storage is not configured. Set OBJECT_STORAGE_ENDPOINT, OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_ACCESS_KEY, and OBJECT_STORAGE_SECRET_KEY." }, { status: 503 });
  let assetId: string | undefined;
  try {
    const form = await request.formData();
    const file = form.get("file");
    const type = form.get("type");
    const requestedName = form.get("name");
    const schemaVersion = form.get("schemaVersion");
    if (!(file instanceof File)) throw new Error("file is required.");
    if (typeof type !== "string" || !Object.values(AssetType).includes(type as AssetType)) throw new Error("type must be a supported asset type.");
    if (file.size === 0) throw new Error("The uploaded file is empty.");
    if (file.size > MAX_UPLOAD_BYTES) throw new Error("Uploads are limited to 500 MB in the MVP API. Use multipart direct upload for larger files.");
    const { workspace } = await ensureMvpWorkspace();
    const name = typeof requestedName === "string" && requestedName.trim() ? requestedName.trim() : file.name;
    const asset = await prisma.asset.create({ data: { workspaceId: workspace.id, name, type: type as AssetType } });
    assetId = asset.id;
    const uploaded = await putArtifact({
      workspaceId: workspace.id,
      assetId: asset.id,
      version: 1,
      filename: file.name,
      body: new Uint8Array(await file.arrayBuffer()),
      contentType: file.type || "application/octet-stream",
    });
    const version = await prisma.assetVersion.create({
      data: {
        assetId: asset.id,
        version: 1,
        schemaVersion: typeof schemaVersion === "string" && schemaVersion.trim() ? schemaVersion.trim() : "artifact/v1",
        storageKey: uploaded.storageKey,
        contentType: file.type || "application/octet-stream",
        byteSize: BigInt(uploaded.byteSize),
        checksum: uploaded.checksum,
        approvalStatus: AssetApprovalStatus.APPROVED,
        metadata: { originalFilename: file.name, bucket: uploaded.bucket },
      },
    });
    return NextResponse.json({ data: { assetId: asset.id, versionId: version.id, storageKey: version.storageKey, checksum: version.checksum, approvalStatus: version.approvalStatus } }, { status: 201 });
  } catch (error) {
    if (assetId) await prisma.asset.delete({ where: { id: assetId } }).catch(() => undefined);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to upload artifact." }, { status: 400 });
  }
}
