import { artifactDisplayName } from "@/lib/artifact-display-name";

const MIME_EXTENSIONS: Record<string, string> = {
  "application/json": ".json",
  "application/octet-stream": ".bin",
  "application/zip": ".zip",
  "application/x-npz": ".npz",
  "text/csv": ".csv",
  "text/plain": ".txt",
  "video/mp4": ".mp4",
};

function cleanSegment(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export function artifactDownloadFilename(input: {
  assetName: string;
  contentType: string;
  jobName?: string | null;
}) {
  const displayName = artifactDisplayName(input.assetName);
  const parts = displayName.split(/\s+·\s+/).filter(Boolean);
  const sourceName = parts.at(-1) ?? "artifact";
  const stageName = parts.length > 1 ? parts.slice(0, -1).join("-") : "";
  const prefix = [input.jobName, stageName].filter(Boolean).map((part) => cleanSegment(part!)).filter(Boolean).join("-");
  let filename = cleanSegment(sourceName) || "artifact";
  if (!/\.[a-z0-9]{1,8}$/i.test(filename)) {
    filename += MIME_EXTENSIONS[input.contentType] ?? "";
  }
  return prefix && !filename.toLowerCase().startsWith(`${prefix.toLowerCase()}-`)
    ? `${prefix}-${filename}`
    : filename;
}

export function contentDisposition(disposition: "inline" | "attachment", filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
