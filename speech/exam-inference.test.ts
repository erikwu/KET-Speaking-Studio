import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createExamInference, validateExamScore } from "./exam-inference.ts";

function wavBuffer() {
  const wav = Buffer.alloc(46);
  wav.write("RIFF", 0, "ascii"); wav.writeUInt32LE(38, 4); wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii"); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii"); wav.writeUInt32LE(2, 40); wav.writeInt16LE(500, 44);
  return wav;
}

async function withWorker(run: (options: { root: string; workerPath: string; tempDirectory: string }) => Promise<void>, timeoutMs = 1000) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ket-exam-inference-"));
  const workerPath = path.join(root, "stub-worker.mjs");
  const markerPath = path.join(root, "first-request.marker");
  const source = `#!/usr/bin/env node\nimport readline from 'node:readline';\nimport fs from 'node:fs';\nconst marker = ${JSON.stringify(markerPath)};\nconsole.log(JSON.stringify({type:'ready'}));\nfor await (const line of readline.createInterface({input:process.stdin})) { const q=JSON.parse(line); if (q.type==='transcribe' && process.env.STUB_TIMEOUT_ONCE==='1' && !fs.existsSync(marker)) { fs.writeFileSync(marker,'timeout'); continue; } if (process.env.STUB_ERROR==='1') { console.log(JSON.stringify({id:q.id,ok:false,error:'failed'})); continue; } const result=q.type==='transcribe'?{transcript:'hello'}:{relevance:{score:4,feedback:'切题'},completeness:{score:3,feedback:'完整'},grammar:{score:5,feedback:'正确'},vocabulary:{score:4,feedback:'准确'}}; console.log(JSON.stringify({id:q.id,ok:true,result})); }\n`;
  await writeFile(workerPath, source);
  await chmod(workerPath, 0o755);
  const tempDirectory = path.join(root, "temp-audio");
  await mkdir(tempDirectory);
  try { await run({ root, workerPath, tempDirectory }); } finally { await rm(root, { recursive: true, force: true }); }
  void timeoutMs;
}

const inferenceOptions = (root: string, workerPath: string, tempDirectory: string, options = {}) => ({
  pythonPath: process.execPath,
  workerPath,
  asrModelDir: path.join(root, "asr"),
  scoringModelDir: path.join(root, "scoring"),
  tempDirectory,
  ...options,
});

test("dispatch_matchesResponsesByRequestId", async () => {
  await withWorker(async ({ root, workerPath, tempDirectory }) => {
    const inference = createExamInference(inferenceOptions(root, workerPath, tempDirectory));
    try {
      const [first, second] = await Promise.all([
        inference.score({ question: "question one", reference: "reference", transcript: "answer" }),
        inference.score({ question: "question two", reference: "reference", transcript: "answer" }),
      ]);
      assert.equal(first.total, 16);
      assert.equal(second.total, 16);
    } finally { await inference.dispose(); }
  });
});

test("transcribe_rejectsInvalidOrOversizedWavBeforeWriting", async () => {
  await withWorker(async ({ root, workerPath, tempDirectory }) => {
    const inference = createExamInference(inferenceOptions(root, workerPath, tempDirectory));
    try {
      await assert.rejects(inference.transcribe(Buffer.from("not wav")), /WAV/);
      await assert.rejects(inference.transcribe(Buffer.alloc(25 * 1024 * 1024 + 1)), /25 MiB/);
      assert.deepEqual(await readdir(tempDirectory), []);
    } finally { await inference.dispose(); }
  });
});

test("transcribe_removesTempAudioOnSuccessAndWorkerFailure", async () => {
  await withWorker(async ({ root, workerPath, tempDirectory }) => {
    const success = createExamInference(inferenceOptions(root, workerPath, tempDirectory));
    try { assert.deepEqual(await success.transcribe(wavBuffer()), { transcript: "hello" }); }
    finally { await success.dispose(); }
    assert.deepEqual(await readdir(tempDirectory), []);

    const failure = createExamInference(inferenceOptions(root, workerPath, tempDirectory, { env: { ...process.env, STUB_ERROR: "1" } }));
    try { await assert.rejects(failure.transcribe(wavBuffer()), { message: "failed" }); }
    finally { await failure.dispose(); }
    assert.deepEqual(await readdir(tempDirectory), []);
  });
});

test("transcribe_removesPartiallyWrittenAudioWhenFileWriteFails", async () => {
  await withWorker(async ({ root, workerPath, tempDirectory }) => {
    const inference = createExamInference(inferenceOptions(root, workerPath, tempDirectory, {
      writeAudioFile: async (filePath, data, options) => {
        await writeFile(filePath, data.subarray(0, 12), options);
        throw new Error("simulated disk write failure");
      },
    }));
    await assert.rejects(inference.transcribe(wavBuffer()), /simulated disk write failure/);
    assert.deepEqual(await readdir(tempDirectory), []);
    await inference.dispose();
  });
});

test("workerTimeout_rejectsPendingRequestAndRestartsCleanly", async () => {
  await withWorker(async ({ root, workerPath, tempDirectory }) => {
    const inference = createExamInference(inferenceOptions(root, workerPath, tempDirectory, {
      requestTimeoutMs: 80,
      env: { ...process.env, STUB_TIMEOUT_ONCE: "1" },
    }));
    try {
      await assert.rejects(inference.transcribe(wavBuffer()), /超时/);
      assert.deepEqual(await inference.transcribe(wavBuffer()), { transcript: "hello" });
    } finally { await inference.dispose(); }
  });
});

test("validateExamScore_rejectsInvalidFieldsAndSumsTotal", () => {
  const valid = {
    relevance: { score: 4, feedback: "切题" }, completeness: { score: 3, feedback: "信息完整" },
    grammar: { score: 5, feedback: "语法正确" }, vocabulary: { score: 4, feedback: "词汇准确" },
  };
  assert.equal(validateExamScore(valid).total, 16);
  assert.throws(() => validateExamScore({ ...valid, relevance: { score: 6, feedback: "越界" } }));
  assert.throws(() => validateExamScore({ ...valid, vocabulary: undefined }));
});
