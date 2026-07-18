import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

let bucketReady: Promise<void> | undefined;

function storageSettings() {
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
  const bucket = process.env.OBJECT_STORAGE_BUCKET;
  const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY;
  const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey };
}

export function objectStorageConfigured() {
  return storageSettings() !== null;
}

function client(settings: NonNullable<ReturnType<typeof storageSettings>>) {
  return new S3Client({
    endpoint: settings.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
  });
}

async function ensureBucket() {
  const settings = storageSettings();
  if (!settings) throw new Error("Object storage is not configured.");
  if (!bucketReady) {
    const s3 = client(settings);
    bucketReady = (async () => {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: settings.bucket }));
      } catch {
        await s3.send(new CreateBucketCommand({ Bucket: settings.bucket }));
      }
    })();
  }
  await bucketReady;
  return { settings, s3: client(settings) };
}

function safeSegment(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

export function createArtifactObjectKey(workspaceId: string, assetId: string, version: number, filename: string) {
  return `workspaces/${workspaceId}/assets/${assetId}/${version}/source/${safeSegment(filename)}`;
}

export async function putArtifact(input: { workspaceId: string; assetId: string; version: number; filename: string; body: Uint8Array; contentType: string }) {
  const { settings, s3 } = await ensureBucket();
  const storageKey = createArtifactObjectKey(input.workspaceId, input.assetId, input.version, input.filename);
  const checksum = createHash("sha256").update(input.body).digest("hex");
  await s3.send(new PutObjectCommand({
    Bucket: settings.bucket,
    Key: storageKey,
    Body: input.body,
    ContentType: input.contentType,
    Metadata: { sha256: checksum, "schema-version": "artifact/v1" },
  }));
  return { storageKey, checksum, byteSize: input.body.byteLength, bucket: settings.bucket };
}

export async function getArtifact(storageKey: string) {
  const { settings, s3 } = await ensureBucket();
  const output = await s3.send(new GetObjectCommand({ Bucket: settings.bucket, Key: storageKey }));
  if (!output.Body || !("transformToWebStream" in output.Body)) throw new Error("The stored artifact could not be streamed.");
  return { body: output.Body.transformToWebStream(), contentType: output.ContentType ?? "application/octet-stream", contentLength: output.ContentLength };
}

export async function getArtifactBytes(storageKey: string) {
  const { settings, s3 } = await ensureBucket();
  const output = await s3.send(new GetObjectCommand({ Bucket: settings.bucket, Key: storageKey }));
  if (!output.Body || !("transformToByteArray" in output.Body)) throw new Error("The stored artifact could not be read by the worker.");
  return new Uint8Array(await output.Body.transformToByteArray());
}
