#!/usr/bin/env node

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

import puppeteer from "puppeteer-core";

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid argument near ${key ?? "end of command"}.`);
    }
    values[key.slice(2)] = value;
  }
  return values;
}

function requiredFile(value, label) {
  if (!value) throw new Error(`${label} is required.`);
  const path = resolve(value);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} does not exist: ${path}`);
  }
  return path;
}

function requiredDirectory(value, label) {
  if (!value) throw new Error(`${label} is required.`);
  const path = resolve(value);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} does not exist: ${path}`);
  }
  return path;
}

function chromeExecutable() {
  const candidates = [
    process.env.ROBOMOTION_CHROME_BIN,
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error(
      "Google Chrome or Chromium is required for exact Three.js MP4 capture. " +
        "Set ROBOMOTION_CHROME_BIN when it is installed at a custom path.",
    );
  }
  return executable;
}

function contentType(path) {
  if (extname(path).toLowerCase() === ".json") return "application/json";
  if (extname(path).toLowerCase() === ".stl") return "model/stl";
  return "application/octet-stream";
}

function startAssetServer(scenePath, modelRoot) {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    let file;
    if (requestUrl.pathname === "/scene.json") {
      file = scenePath;
    } else if (requestUrl.pathname.startsWith("/models/")) {
      const filename = basename(decodeURIComponent(requestUrl.pathname.slice("/models/".length)));
      if (!/^[a-zA-Z0-9_.-]+\.stl$/i.test(filename)) {
        response.writeHead(400).end("Unsupported model file.");
        return;
      }
      file = join(modelRoot, filename);
    }
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end("Not found.");
      return;
    }
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Type": contentType(file),
      "Content-Length": statSync(file).size,
    });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate the capture asset server."));
        return;
      }
      resolvePromise({
        server,
        origin: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

function startEncoder(output, width, height, fps) {
  const encoder = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "image2pipe",
      "-framerate",
      String(fps),
      "-vcodec",
      "png",
      "-i",
      "pipe:0",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      process.env.ROBOMOTION_DIGITAL_TWIN_PRESET ?? "medium",
      "-crf",
      process.env.ROBOMOTION_DIGITAL_TWIN_CRF ?? "15",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-vf",
      `scale=${width}:${height}:flags=lanczos`,
      output,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let errorOutput = "";
  encoder.stderr.setEncoding("utf8");
  encoder.stderr.on("data", (chunk) => {
    errorOutput += chunk;
  });
  return { encoder, errorOutput: () => errorOutput };
}

async function writeFrame(stream, frame) {
  if (stream.write(frame)) return;
  await new Promise((resolvePromise, reject) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolvePromise();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

async function finishEncoder(encoder, errorOutput) {
  encoder.stdin.end();
  const exitCode = await new Promise((resolvePromise, reject) => {
    encoder.once("error", reject);
    encoder.once("close", resolvePromise);
  });
  if (exitCode !== 0) {
    throw new Error(`FFmpeg failed while encoding the Three.js capture: ${errorOutput().trim()}`);
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const scenePath = requiredFile(args.scene, "Scene JSON");
  const modelRoot = requiredDirectory(args["model-root"], "Unitree mesh cache");
  const output = resolve(args.output ?? "");
  if (!args.output) throw new Error("Output MP4 is required.");
  const width = Number(args.width ?? 1920);
  const height = Number(args.height ?? 1080);
  const outputFps = Number(args.fps ?? process.env.ROBOMOTION_DIGITAL_TWIN_FPS ?? 60);
  if (!Number.isInteger(width) || width < 640 || !Number.isInteger(height) || height < 360) {
    throw new Error("Capture dimensions are invalid.");
  }
  if (!Number.isFinite(outputFps) || outputFps <= 0 || outputFps > 120) {
    throw new Error("Capture FPS must be between 1 and 120.");
  }

  const dashboardUrl = (
    args["dashboard-url"] ??
    process.env.ROBOMOTION_DASHBOARD_URL ??
    "http://127.0.0.1:3000"
  ).replace(/\/$/, "");
  const { server, origin } = await startAssetServer(scenePath, modelRoot);
  let browser;
  let encoderState;
  try {
    browser = await puppeteer.launch({
      executablePath: chromeExecutable(),
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        "--enable-unsafe-swiftshader",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        process.stderr.write(`[capture:${message.type()}] ${message.text()}\n`);
      }
    });
    page.on("pageerror", (error) => {
      process.stderr.write(`[capture:page] ${error.message}\n`);
    });
    const captureUrl = new URL("/render/digital-twin", dashboardUrl);
    captureUrl.searchParams.set("scene", `${origin}/scene.json`);
    captureUrl.searchParams.set("models", `${origin}/models`);
    await page.goto(captureUrl.toString(), {
      waitUntil: "networkidle0",
      timeout: 120_000,
    });
    // Next.js injects a development-only status badge outside the application
    // tree. It is not part of RoboMotion and must never enter evidence video.
    await page.addStyleTag({
      content: "nextjs-portal{display:none!important}",
    });
    await page.waitForFunction(
      () =>
        Boolean(
          window.__ROBOMOTION_CAPTURE__?.ready ||
            window.__ROBOMOTION_CAPTURE__?.error,
        ),
      { timeout: 120_000, polling: 100 },
    );
    const metadata = await page.evaluate(() => {
      const capture = window.__ROBOMOTION_CAPTURE__;
      if (!capture) throw new Error("The Three.js capture controller was not initialized.");
      if (capture.error) throw new Error(capture.error);
      return {
        fps: capture.fps,
        frameCount: capture.frameCount,
        duration: capture.duration,
      };
    });
    const frameCount = Math.max(1, Math.round(metadata.duration * outputFps));
    encoderState = startEncoder(output, width, height, outputFps);
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const mediaTime = frameIndex / outputFps;
      await page.evaluate(async (time) => {
        await window.__ROBOMOTION_CAPTURE__?.renderTime(time);
      }, mediaTime);
      const png = await page.screenshot({
        type: "png",
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width, height },
      });
      await writeFrame(encoderState.encoder.stdin, png);
      if ((frameIndex + 1) % Math.max(1, Math.round(outputFps)) === 0) {
        process.stdout.write(
          `RoboMotion: Three.js capture ${frameIndex + 1}/${frameCount} frames\n`,
        );
      }
    }
    await finishEncoder(encoderState.encoder, encoderState.errorOutput);
    encoderState = undefined;
    process.stdout.write(
      `RoboMotion: captured ${frameCount} frames at ${outputFps} FPS ` +
        `from the production Three.js digital twin\n`,
    );
  } finally {
    if (encoderState) encoderState.encoder.kill("SIGKILL");
    await browser?.close();
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
