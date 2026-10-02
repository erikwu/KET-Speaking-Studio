import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function reservePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ket-exam-api-"));
  const port = await reservePort();
  const child = spawn(process.execPath, ["--experimental-strip-types", "speech/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TTS_PORT: String(port),
      TTS_OUTPUT_DIR: path.join(root, "outputs"),
      TTS_MODEL_PATH: path.join(root, "missing-tts"),
      TTS_IMAGE_MODEL_PATH: path.join(root, "missing-image"),
      TTS_PYTHON: path.join(root, "missing-python"),
      TTS_EXAM_PYTHON: path.join(root, "missing-python"),
      TTS_ASR_MODEL_PATH: path.join(root, "missing-asr"),
      TTS_SCORING_MODEL_PATH: path.join(root, "missing-scorer"),
      TTS_EXAM_WORKER_PATH: path.resolve("speech/exam_worker.py"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Speech server exited during startup: ${stderr}`);
    try {
      if ((await fetch(`${baseUrl}/api/config`)).ok) { ready = true; break; }
    } catch { /* listener not open yet */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (!ready) {
    child.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
    throw new Error(`Speech server did not start: ${stderr}`);
  }
  try { await run(baseUrl); } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      setTimeout(resolve, 2000);
    });
    await rm(root, { recursive: true, force: true });
  }
}

test("config_reportsExamUnavailableWithoutModels", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/config`);
    const config = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200);
    assert.equal(config.asrModelReady, false);
    assert.equal(config.asrRuntimeReady, false);
    assert.equal(config.scoringModelReady, false);
    assert.equal(config.scoringRuntimeReady, false);
    assert.equal(config.examAvailable, false);
    assert.equal("asrModelPath" in config, false);
    assert.equal("scoringModelPath" in config, false);
  });
});

test("examRoutes_return503WhenCapabilityIsMissing", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/exam/score`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Question?", reference: "Answer", transcript: "Attempt" }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json() as any).error, /考试模型/);
  });
});

test("transcribe_rejectsWrongContentTypeAndMalformedWav", async () => {
  await withServer(async (baseUrl) => {
    const wrongType = await fetch(`${baseUrl}/api/exam/transcribe`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "x" });
    assert.equal(wrongType.status, 415);
    const malformed = await fetch(`${baseUrl}/api/exam/transcribe`, { method: "POST", headers: { "content-type": "audio/wav" }, body: Buffer.from("not a wav") });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json() as any).error, /WAV/);
  });
});

test("score_rejectsTextOver3000Characters", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/exam/score`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "q".repeat(3001), reference: "Answer", transcript: "Attempt" }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json() as any).error, /3,000/);
  });
});

test("browserModuleRoutes_serveJavaScript", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/exam-session.ts`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /javascript/);
    assert.match(await response.text(), /buildExamPlan/);
  });
});
