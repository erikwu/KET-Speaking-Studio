import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

async function startSpeechServer(root: string) {
  const port = await reservePort();
  const outputDirectory = path.join(root, "outputs");
  const child = spawn(process.execPath, ["--experimental-strip-types", "speech/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TTS_PORT: String(port),
      TTS_OUTPUT_DIR: outputDirectory,
      TTS_MODEL_PATH: path.join(root, "missing-speech-model"),
      TTS_IMAGE_MODEL_PATH: path.join(root, "missing-image-model"),
      MFLUX_CLI_PATH: path.join(root, "missing-mflux"),
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

async function withServer<T>(run: (context: { root: string; baseUrl: string; outputDirectory: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ket-resource-api-test-"));
  const server = await startSpeechServer(root);
  try {
    return await run({ root, baseUrl: server.baseUrl, outputDirectory: server.outputDirectory });
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
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
