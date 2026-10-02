import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function withServer(run: (baseUrl: string) => Promise<void>, { readyExam = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ket-exam-api-"));
  let examWorkerPath = path.resolve("speech/exam_worker.py");
  if (readyExam) {
    const asrDir = path.join(root, "asr");
    const scoringDir = path.join(root, "scoring");
    await mkdir(asrDir);
    await mkdir(scoringDir);
    await writeFile(path.join(asrDir, "config.json"), "{}");
    await writeFile(path.join(asrDir, "weights.safetensors"), "weights");
    await writeFile(path.join(scoringDir, "config.json"), "{}");
    await writeFile(path.join(scoringDir, "tokenizer.json"), "{}");
    await writeFile(path.join(scoringDir, "model.safetensors.index.json"), JSON.stringify({ weight_map: { layer: "model-00001.safetensors" } }));
    await writeFile(path.join(scoringDir, "model-00001.safetensors"), "weights");
    examWorkerPath = path.join(root, "stub-exam-worker.mjs");
    await writeFile(examWorkerPath, `#!/usr/bin/env node
import readline from 'node:readline';
if (process.argv.includes('--check-runtime')) {
  console.log(JSON.stringify({asrPackageReady:true,scoringPackageReady:true,ffmpegReady:true}));
  process.exit(0);
}
console.log(JSON.stringify({type:'ready'}));
for await (const line of readline.createInterface({input:process.stdin})) {
  const request=JSON.parse(line);
  const result={relevance:{score:4,feedback:'切题'},completeness:{score:3,feedback:'信息完整'},grammar:{score:5,feedback:'语法正确'},vocabulary:{score:4,feedback:'词汇准确'}};
  console.log(JSON.stringify({id:request.id,ok:true,result}));
}
`, "utf8");
    await chmod(examWorkerPath, 0o755);
  }
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
      TTS_EXAM_PYTHON: readyExam ? process.execPath : path.join(root, "missing-python"),
      TTS_ASR_MODEL_PATH: readyExam ? path.join(root, "asr") : path.join(root, "missing-asr"),
      TTS_SCORING_MODEL_PATH: readyExam ? path.join(root, "scoring") : path.join(root, "missing-scorer"),
      TTS_EXAM_WORKER_PATH: examWorkerPath,
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

test("score_returnsValidatedDimensionsAndServerCalculatedTotal", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/exam/score`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What do you like?", reference: "I like music.", transcript: "I like music." }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      relevance: { score: 4, feedback: "切题" },
      completeness: { score: 3, feedback: "信息完整" },
      grammar: { score: 5, feedback: "语法正确" },
      vocabulary: { score: 4, feedback: "词汇准确" },
      total: 16,
    });
  }, { readyExam: true });
});

test("browserModuleRoutes_serveJavaScript", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/exam-session.ts`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /javascript/);
    assert.match(await response.text(), /buildExamPlan/);
  });
});
