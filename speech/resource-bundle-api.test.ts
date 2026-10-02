import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const markdown = `# Part 1 Phase 1\n**Q: What is your name?**\n**A: My name is Ada.**\n\n# Part 1 Phase 2\n**Q: What do you like?**\n**A: I like music.**\n\n# Part 2\n1. **Situation: At the park**\n**Q: What can you see?**\n**A: I can see a swing.**\n`;
const wav = Buffer.alloc(44);
wav.write("RIFF", 0, "ascii");
wav.writeUInt32LE(36, 4);
wav.write("WAVE", 8, "ascii");
wav.write("fmt ", 12, "ascii");
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(22050, 24);
wav.writeUInt32LE(44100, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36, "ascii");
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

async function reservePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startSpeechServer(root: string, overrides: { speechModelPath?: string; imageModelPath?: string; mfluxCliPath?: string } = {}) {
  const port = await reservePort();
  const outputDirectory = path.join(root, "outputs");
  const child = spawn(process.execPath, ["--experimental-strip-types", "speech/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TTS_PORT: String(port),
      TTS_OUTPUT_DIR: outputDirectory,
      TTS_MODEL_PATH: overrides.speechModelPath ?? path.join(root, "missing-speech-model"),
      TTS_IMAGE_MODEL_PATH: overrides.imageModelPath ?? path.join(root, "missing-image-model"),
      TTS_PYTHON: path.join(root, "missing-python"),
      MFLUX_CLI_PATH: overrides.mfluxCliPath ?? path.join(root, "missing-mflux"),
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
      const response = await fetch(`${baseUrl}/api/config`);
      if (response.ok) { ready = true; break; }
    } catch { /* The listener has not opened yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (!ready) {
    child.kill("SIGTERM");
    throw new Error(`Speech server did not start: ${stderr}`);
  }
  return {
    baseUrl,
    outputDirectory,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
    },
  };
}

async function withServer<T>(
  run: (context: { root: string; baseUrl: string; outputDirectory: string }) => Promise<T>,
  prepare?: (root: string) => Promise<{ speechModelPath?: string; imageModelPath?: string; mfluxCliPath?: string }>,
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ket-resource-api-test-"));
  const overrides = prepare ? await prepare(root) : {};
  const server = await startSpeechServer(root, overrides);
  try {
    return await run({ root, baseUrl: server.baseUrl, outputDirectory: server.outputDirectory });
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function createSpeechModelFixture(root: string): Promise<string> {
  const modelPath = path.join(root, "valid-speech-model");
  await mkdir(path.join(modelPath, "speech_tokenizer"), { recursive: true });
  await writeFile(path.join(modelPath, "config.json"), "{}");
  await writeFile(path.join(modelPath, "model.safetensors.index.json"), JSON.stringify({ weight_map: { test: "weights.safetensors" } }));
  await writeFile(path.join(modelPath, "weights.safetensors"), "model-shard");
  await writeFile(path.join(modelPath, "speech_tokenizer", "model.safetensors"), "tokenizer");
  return modelPath;
}

async function createImageModelFixture(root: string): Promise<string> {
  const modelPath = path.join(root, "valid-image-model");
  for (const relativePath of [
    "vae/model.safetensors.index.json",
    "transformer/model.safetensors.index.json",
    "text_encoder/model.safetensors.index.json",
    "processor/tokenizer.json",
  ]) {
    const filePath = path.join(modelPath, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "{}");
  }
  return modelPath;
}

async function parseFixture(baseUrl: string, root: string) {
  const filePath = path.join(root, "KET questions.md");
  await writeFile(filePath, markdown);
  const response = await fetch(`${baseUrl}/api/parse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: filePath }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const parsed = JSON.parse(body) as any;
  return { filePath, parsed };
}

async function writeCompleteCache(baseUrl: string, outputDirectory: string, filePath: string, parsed: any, options: { complete?: boolean; materialKey?: string } = {}) {
  const turns = parsed.sections.flatMap((section: any) => section.groups.flatMap((group: any) => group.turns));
  const cacheDirectory = path.join(outputDirectory, "offline-audio");
  await mkdir(cacheDirectory, { recursive: true });
  const clips = turns.map((turn: any) => ({ id: turn.id, cacheKey: "b".repeat(64), audioHash: sha256(wav) }));
  for (const clip of clips) await writeFile(path.join(cacheDirectory, `clip-${clip.id}.wav`), wav);
  const manifest = {
    version: 1,
    materialKey: options.materialKey ?? parsed.materialKey,
    profile: "default",
    profileKey: "a".repeat(64),
    total: turns.length,
    clips: options.complete === false ? clips.slice(1) : clips,
    completedAt: "2026-10-02T00:00:00.000Z",
  };
  await writeFile(path.join(cacheDirectory, "manifest.json"), JSON.stringify(manifest));

  const group = parsed.sections.find((section: any) => section.id === "part2").groups[0];
  const dialogue = group.turns.map((turn: any) => `${turn.role}: ${turn.text}`).join("\n");
  const key = sha256(`dialogue-cue-v2\0${path.resolve(filePath)}\0${group.context.trim()}\0${dialogue.trim()}`).slice(0, 32);
  const imageDirectory = path.join(outputDirectory, "scenario-images", key);
  await mkdir(imageDirectory, { recursive: true });
  await writeFile(path.join(imageDirectory, "picture-1.png"), png);
}

async function createImportBundle(root: string, parsed: any, options: { version?: number; badHash?: boolean; reverseTurns?: boolean; includeImage?: boolean } = {}) {
  const staging = path.join(root, `bundle-source-${Math.random().toString(16).slice(2)}`);
  const archivePath = path.join(root, `import-${Math.random().toString(16).slice(2)}.ketpack.zip`);
  const turns = parsed.sections.flatMap((section: any) => section.groups.flatMap((group: any) => group.turns));
  const clips = turns.map((turn: any) => ({
    id: turn.id,
    entry: `audio/${turn.id}.wav`,
    cacheKey: "b".repeat(64),
    byteLength: wav.length,
    sha256: options.badHash && turn.id === turns[0].id ? "d".repeat(64) : sha256(wav),
  }));
  if (options.reverseTurns) clips.reverse();
  const group = parsed.sections.find((section: any) => section.id === "part2").groups[0];
  const images = options.includeImage === false ? [] : [{
    groupId: group.id,
    variant: 1,
    entry: `scenario-images/${group.id}-1.png`,
    byteLength: png.length,
    sha256: sha256(png),
  }];
  const manifest = {
    format: "ket-speaking-resource-bundle",
    version: options.version ?? 1,
    material: { entry: "material.md", filename: "KET questions.md", byteLength: Buffer.byteLength(markdown), sha256: sha256(markdown) },
    speech: { profile: "default", profileKey: "a".repeat(64), total: turns.length, clips },
    images,
  };
  const entries: Record<string, Buffer> = { "material.md": Buffer.from(markdown) };
  for (const turn of turns) entries[`audio/${turn.id}.wav`] = wav;
  if (images.length) entries[images[0]!.entry] = png;
  for (const [entry, content] of Object.entries({ "manifest.json": Buffer.from(JSON.stringify(manifest)), ...entries })) {
    const filePath = path.join(staging, entry);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  const names = ["manifest.json", ...Object.keys(entries)].sort();
  const zip = spawn("/usr/bin/zip", ["-q", "-D", archivePath, "-@"], { cwd: staging, stdio: ["pipe", "ignore", "pipe"] });
  let zipError = "";
  zip.stderr.setEncoding("utf8");
  zip.stderr.on("data", (chunk: string) => { zipError = (zipError + chunk).slice(-1000); });
  zip.stdin.end(`${names.join("\n")}\n`);
  const [zipCode] = await once(zip, "close") as [number | null, NodeJS.Signals | null];
  assert.equal(zipCode, 0, zipError);
  return archivePath;
}

async function importBundle(baseUrl: string, archivePath: string) {
  const response = await fetch(`${baseUrl}/api/resource-bundles/import`, {
    method: "POST",
    headers: { "content-type": "application/zip" },
    body: new Uint8Array(await readFile(archivePath)),
  });
  const body = await response.json() as any;
  return { response, body };
}

function importedScenarioQuery(filePath: string, group: any) {
  const context = group.context || `口语练习情景 ${group.number}`;
  const dialogue = group.turns.map((turn: any) => `${turn.role}: ${turn.text}`).join("\n");
  return new URLSearchParams({ filePath, context, dialogue });
}

test("exportResourceBundle_includesMaterialCompleteAudioAndOnlyExistingImages", async () => {
  await withServer(async ({ root, baseUrl, outputDirectory }) => {
    const { filePath, parsed } = await parseFixture(baseUrl, root);
    await writeCompleteCache(baseUrl, outputDirectory, filePath, parsed);
    const query = new URLSearchParams({ filePath, materialKey: parsed.materialKey });
    const response = await fetch(`${baseUrl}/api/resource-bundles/export?${query}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition") ?? "", /attachment; filename="[A-Za-z0-9_.-]+\.ketpack\.zip"/);
    assert.equal(response.headers.get("content-type"), "application/zip");
    const archivePath = path.join(root, "download.ketpack.zip");
    await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
    const listing = await execFileAsync("/usr/bin/unzip", ["-Z1", archivePath]);
    const entries = listing.stdout.trim().split("\n").sort();
    assert.deepEqual(entries, [
      "audio/part2-1-1.wav",
      "audio/part2-1-2.wav",
      "audio/phase1-1-1.wav",
      "audio/phase1-1-2.wav",
      "audio/phase2-1-1.wav",
      "audio/phase2-1-2.wav",
      "manifest.json",
      "material.md",
      "scenario-images/part2-1-1.png",
    ].sort());
    const manifest = JSON.parse((await execFileAsync("/usr/bin/unzip", ["-p", archivePath, "manifest.json"])).stdout);
    assert.equal(manifest.material.filename, "KET questions.md");
    assert.equal(manifest.speech.total, 6);
    assert.equal(manifest.images.length, 1);
    assert.equal(manifest.speech.clips.every((clip: any) => clip.sha256 === sha256(wav)), true);
  });
});

test("exportResourceBundle_rejectsMissingIncompleteOrMismatchedAudioPackage", async () => {
  await withServer(async ({ root, baseUrl, outputDirectory }) => {
    const { filePath, parsed } = await parseFixture(baseUrl, root);
    const query = new URLSearchParams({ filePath, materialKey: parsed.materialKey });
    const missingResponse = await fetch(`${baseUrl}/api/resource-bundles/export?${query}`);
    assert.equal(missingResponse.status, 409);

    await writeCompleteCache(baseUrl, outputDirectory, filePath, parsed, { complete: false });
    const incompleteResponse = await fetch(`${baseUrl}/api/resource-bundles/export?${query}`);
    assert.equal(incompleteResponse.status, 409);

    await writeCompleteCache(baseUrl, outputDirectory, filePath, parsed, { materialKey: "c".repeat(64) });
    const mismatchedResponse = await fetch(`${baseUrl}/api/resource-bundles/export?${query}`);
    assert.equal(mismatchedResponse.status, 409);
  });
});

test("importResourceBundle_remapsAudioAndImagesToNewMaterialPath", async () => {
  await withServer(async ({ root, baseUrl, outputDirectory }) => {
    const { parsed } = await parseFixture(baseUrl, root);
    const archivePath = await createImportBundle(root, parsed);
    const { response, body } = await importBundle(baseUrl, archivePath);
    assert.equal(response.status, 200, body.error);
    assert.equal(body.filePath, path.join(outputDirectory, "imported-material.md"));
    assert.notEqual(body.materialKey, parsed.materialKey);
    assert.equal(body.itemCount, 6);
    assert.equal(body.sections[0].id, "phase1");

    const turnId = parsed.sections[0].groups[0].turns[0].id;
    const audioResponse = await fetch(`${baseUrl}/api/offline-audio/${body.materialKey}/${turnId}`);
    assert.equal(audioResponse.status, 200);
    assert.deepEqual(Buffer.from(await audioResponse.arrayBuffer()), wav);

    const importedGroup = body.sections.find((section: any) => section.id === "part2").groups[0];
    const imageState = await fetch(`${baseUrl}/api/scenario-images?${importedScenarioQuery(body.filePath, importedGroup)}`).then((result) => result.json()) as any;
    assert.equal(imageState.imageUrls.length, 1);
    const imageResponse = await fetch(`${baseUrl}${imageState.imageUrls[0]}`);
    assert.equal(imageResponse.status, 200);
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), png);
  });
});

test("importResourceBundle_allowsPartialImages", async () => {
  await withServer(async ({ root, baseUrl, outputDirectory }) => {
    const { parsed } = await parseFixture(baseUrl, root);
    const existingOtherImage = path.join(outputDirectory, "scenario-images", "e".repeat(32), "picture-1.png");
    await mkdir(path.dirname(existingOtherImage), { recursive: true });
    await writeFile(existingOtherImage, Buffer.from("keep this other scenario image"));
    const archivePath = await createImportBundle(root, parsed);
    const { response, body } = await importBundle(baseUrl, archivePath);
    assert.equal(response.status, 200, body.error);
    const group = body.sections.find((section: any) => section.id === "part2").groups[0];
    const imageState = await fetch(`${baseUrl}/api/scenario-images?${importedScenarioQuery(body.filePath, group)}`).then((result) => result.json()) as any;
    assert.equal(imageState.imageUrls.length, 1);
    assert.deepEqual(await readFile(existingOtherImage), Buffer.from("keep this other scenario image"));
    const absentVariant = await fetch(`${baseUrl}${imageState.imageUrls[0].replace(/\/1$/, "/2")}`);
    assert.equal(absentVariant.status, 404);
  });
});

test("importResourceBundle_rejectsInvalidBundleWithoutReplacingActiveFiles", async () => {
  await withServer(async ({ root, baseUrl, outputDirectory }) => {
    const { filePath, parsed } = await parseFixture(baseUrl, root);
    await writeCompleteCache(baseUrl, outputDirectory, filePath, parsed);
    const importedMarkdown = path.join(outputDirectory, "imported-material.md");
    const oldMarkdown = Buffer.from("the previous imported material\n");
    await writeFile(importedMarkdown, oldMarkdown);
    const offlineDirectory = path.join(outputDirectory, "offline-audio");
    const oldManifest = await readFile(path.join(offlineDirectory, "manifest.json"));
    const oldClip = await readFile(path.join(offlineDirectory, `clip-${parsed.sections[0].groups[0].turns[0].id}.wav`));
    const invalidOptions = [{ version: 2 }, { badHash: true }, { reverseTurns: true }];
    for (const options of invalidOptions) {
      const archivePath = await createImportBundle(root, parsed, options);
      const { response, body } = await importBundle(baseUrl, archivePath);
      assert.equal(response.status, 400, body.error ?? "invalid resource bundle must be rejected with a validation error");
      assert.deepEqual(await readFile(importedMarkdown), oldMarkdown);
      assert.deepEqual(await readFile(path.join(offlineDirectory, "manifest.json")), oldManifest);
      assert.deepEqual(await readFile(path.join(offlineDirectory, `clip-${parsed.sections[0].groups[0].turns[0].id}.wav`)), oldClip);
    }
  });
});

test("config_reportsIndependentCapabilitiesWhenModelsAreMissing", async () => {
  await withServer(async ({ baseUrl }) => {
    const config = await fetch(`${baseUrl}/api/config`).then((response) => response.json()) as any;
    assert.equal(config.speechModelReady, false);
    assert.equal(config.speechRuntimeReady, false);
    assert.equal(config.imageModelReady, false);
    assert.equal(config.imageRuntimeReady, false);
    assert.equal(config.archiveToolsReady, true);
    assert.equal(config.speechAvailable, false);
    assert.equal(config.imageAvailable, false);
  });

  await withServer(async ({ baseUrl }) => {
    const config = await fetch(`${baseUrl}/api/config`).then((response) => response.json()) as any;
    assert.equal(config.speechModelReady, false);
    assert.equal(config.imageModelReady, true);
    assert.equal(config.imageRuntimeReady, false);
    assert.equal(config.imageAvailable, false);
  }, async (root) => ({ imageModelPath: await createImageModelFixture(root) }));

  await withServer(async ({ baseUrl }) => {
    const config = await fetch(`${baseUrl}/api/config`).then((response) => response.json()) as any;
    assert.equal(config.speechModelReady, true);
    assert.equal(config.speechRuntimeReady, false);
    assert.equal(config.speechAvailable, false);
    assert.equal(config.imageModelReady, false);
  }, async (root) => ({ speechModelPath: await createSpeechModelFixture(root) }));
});

test("offlinePlaybackWorksWithoutModelsAndSynthesisDoesNot", async () => {
  await withServer(async ({ root, baseUrl }) => {
    const { parsed } = await parseFixture(baseUrl, root);
    const archivePath = await createImportBundle(root, parsed);
    const { response: importResponse, body } = await importBundle(baseUrl, archivePath);
    assert.equal(importResponse.status, 200, body.error);
    const turn = parsed.sections[0].groups[0].turns[0];
    const offlineResponse = await fetch(`${baseUrl}/api/offline-audio/${body.materialKey}/${turn.id}`);
    assert.equal(offlineResponse.status, 200);
    assert.deepEqual(Buffer.from(await offlineResponse.arrayBuffer()), wav);

    const synthesisResponse = await fetch(`${baseUrl}/api/synthesize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: turn.text, instruct: "", language: "English" }),
    });
    assert.equal(synthesisResponse.status, 503);

    const cacheItems = parsed.sections.flatMap((section: any) => section.groups.flatMap((group: any) => group.turns)).map((item: any) => ({
      id: item.id,
      text: item.text,
      language: /[\u3400-\u9fff]/.test(item.text) ? "Chinese" : "English",
      instruct: "",
    }));
    const cacheResponse = await fetch(`${baseUrl}/api/audio-cache/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filePath: body.filePath, materialKey: body.materialKey, profile: "default", items: cacheItems }),
    });
    assert.equal(cacheResponse.status, 503);

    const group = body.sections.find((section: any) => section.id === "part2").groups[0];
    const dialogue = group.turns.map((item: any) => `${item.role}: ${item.text}`).join("\n");
    const imageResponse = await fetch(`${baseUrl}/api/scenario-images`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filePath: body.filePath, context: group.context, dialogue }),
    });
    assert.equal(imageResponse.status, 503);
  });
});

test("audioCacheStatusReportsOnlyHashVerifiedPackagesAsComplete", async () => {
  await withServer(async ({ root, baseUrl, outputDirectory }) => {
    const { filePath, parsed } = await parseFixture(baseUrl, root);
    await writeCompleteCache(baseUrl, outputDirectory, filePath, parsed);
    const statusUrl = `${baseUrl}/api/audio-cache/status?materialKey=${encodeURIComponent(parsed.materialKey)}`;
    const goodStatus = await fetch(statusUrl).then((response) => response.json()) as any;
    assert.equal(goodStatus.packageExists, true);
    assert.equal(goodStatus.matchesMaterial, true);

    const firstTurnId = parsed.sections[0].groups[0].turns[0].id;
    await writeFile(path.join(outputDirectory, "offline-audio", `clip-${firstTurnId}.wav`), Buffer.from("damaged wave"));
    const damagedStatus = await fetch(statusUrl).then((response) => response.json()) as any;
    assert.equal(damagedStatus.packageExists, false);
    assert.equal(damagedStatus.matchesMaterial, false);
    assert.equal(damagedStatus.cached, 0);
  });
});
