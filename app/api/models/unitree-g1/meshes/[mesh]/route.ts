import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

type Context = { params: Promise<{ mesh: string }> };

export const runtime = "nodejs";

function modelRoot() {
  return path.resolve(
    process.env.ROBOMOTION_GMR_ROOT ??
      path.join(process.cwd(), ".robomotion", "sources", "GMR"),
    "assets",
    "unitree_g1",
    "meshes",
  );
}

function compiledModelRoot() {
  if (process.env.ROBOMOTION_MODEL_CACHE) {
    return path.resolve(process.env.ROBOMOTION_MODEL_CACHE, "unitree-g1-web");
  }
  return path.resolve(process.cwd(), ".robomotion", "cache", "unitree-g1-web");
}

export async function GET(_: Request, { params }: Context) {
  const { mesh } = await params;
  const filename = path.basename(mesh);
  if (!/^[a-zA-Z0-9_.-]+\.stl$/i.test(filename)) {
    return NextResponse.json({ error: "Unsupported Unitree mesh." }, { status: 400 });
  }

  try {
    const root = filename.endsWith(".compiled.stl") ? compiledModelRoot() : modelRoot();
    const file = path.resolve(root, filename);
    if (!file.startsWith(`${root}${path.sep}`)) {
      return NextResponse.json({ error: "Unsupported Unitree mesh." }, { status: 400 });
    }
    const [body, details] = await Promise.all([readFile(file), stat(file)]);
    return new Response(body, {
      headers: {
        "Content-Type": "model/stl",
        "Content-Length": details.size.toString(),
        "Cache-Control": "public, max-age=86400, immutable",
        "Content-Disposition": `inline; filename="${filename}"`,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "The Unitree G1 mesh is not installed on this server." },
      { status: 404 },
    );
  }
}
