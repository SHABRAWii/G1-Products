import { Motion3DViewer } from "@/components/motion-3d-viewer";

type CapturePageProps = {
  searchParams: Promise<{
    scene?: string;
    models?: string;
  }>;
};

function localCaptureUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return null;
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export default async function DigitalTwinCapturePage({
  searchParams,
}: CapturePageProps) {
  const query = await searchParams;
  const sceneUrl = localCaptureUrl(query.scene);
  const modelBaseUrl = localCaptureUrl(query.models);

  if (!sceneUrl || !modelBaseUrl) {
    return (
      <main className="digital-twin-capture-error">
        The digital-twin capture source is invalid.
      </main>
    );
  }

  return (
    <main className="digital-twin-capture">
      <Motion3DViewer
        sceneUrl={sceneUrl}
        modelBaseUrl={modelBaseUrl}
        title="Unitree G1 digital twin"
        captureMode
      />
    </main>
  );
}
