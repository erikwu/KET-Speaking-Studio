import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkExamModels, isAsrModelReady, isScoringModelReady } from "./exam-models.ts";

async function tempDirectory() { return mkdtemp(path.join(os.tmpdir(), "ket-exam-models-")); }

async function writeAsrModel(root: string) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "config.json"), "{}");
  await writeFile(path.join(root, "weights.safetensors"), "weights");
}

async function writeScoringModel(root: string) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "config.json"), "{}");
  await writeFile(path.join(root, "tokenizer.json"), "{}");
  await writeFile(path.join(root, "model.safetensors.index.json"), JSON.stringify({ weight_map: { layer: "model-00001-of-00002.safetensors", second: "model-00002-of-00002.safetensors" } }));
  await writeFile(path.join(root, "model-00001-of-00002.safetensors"), "one");
  await writeFile(path.join(root, "model-00002-of-00002.safetensors"), "two");
}

function runtimeStub(root: string) {
  const script = path.join(root, "python-runtime-check");
  return writeFile(script, '#!/bin/sh\nprintf \'%s\\n\' "$RUNTIME_CHECK_RESULT"\n', "utf8").then(async () => { await chmod(script, 0o755); return script; });
}

test("isAsrModelReady_requiresConfigAndWeights", async () => {
  const root = await tempDirectory();
  try {
    assert.equal(await isAsrModelReady(root), false);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "config.json"), "{}");
    assert.equal(await isAsrModelReady(root), false);
    await writeFile(path.join(root, "weights.safetensors"), "weights");
    assert.equal(await isAsrModelReady(root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("isScoringModelReady_requiresEveryShardAndTokenizer", async () => {
  const root = await tempDirectory();
  try {
    await writeScoringModel(root);
    assert.equal(await isScoringModelReady(root), true);
    await rm(path.join(root, "tokenizer.json"));
    assert.equal(await isScoringModelReady(root), false);
    await writeFile(path.join(root, "tokenizer.json"), "{}");
    await rm(path.join(root, "model-00002-of-00002.safetensors"));
    assert.equal(await isScoringModelReady(root), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("checkExamModels_requiresBothRuntimesAndFfmpeg", async () => {
  const root = await tempDirectory();
  try {
    const asrModelDir = path.join(root, "asr");
    const scoringModelDir = path.join(root, "scoring");
    await writeAsrModel(asrModelDir);
    await writeScoringModel(scoringModelDir);
    const pythonPath = await runtimeStub(root);
    const ready = await checkExamModels({
      asrModelDir,
      scoringModelDir,
      pythonPath,
      workerPath: "worker.py",
      ffmpegPath: "ffmpeg",
      env: { ...process.env, RUNTIME_CHECK_RESULT: JSON.stringify({ asrPackageReady: true, scoringPackageReady: true, ffmpegReady: true }) },
    });
    assert.deepEqual(ready, { asrModelReady: true, asrRuntimeReady: true, scoringModelReady: true, scoringRuntimeReady: true, examAvailable: true });

    const missingFfmpeg = await checkExamModels({
      asrModelDir, scoringModelDir, pythonPath, workerPath: "worker.py", ffmpegPath: "ffmpeg",
      env: { ...process.env, RUNTIME_CHECK_RESULT: JSON.stringify({ asrPackageReady: true, scoringPackageReady: true, ffmpegReady: false }) },
    });
    assert.equal(missingFfmpeg.asrRuntimeReady, false);
    assert.equal(missingFfmpeg.scoringRuntimeReady, false);
    assert.equal(missingFfmpeg.examAvailable, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
