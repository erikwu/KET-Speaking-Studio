import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const format = "ket-speaking-resource-bundle" as const;
const markdown = Buffer.from("# Part 1 Phase 1\nQ: How are you?\nA: Fine.\n# Part 2\n1. **Situation: Shop**\nQ: What is this?\nA: A ball.\n", "utf8");
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
wav.writeUInt32LE(0, 40);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function api(names: string[]): Promise<Record<string, any>> {
  let module: Record<string, any> = {};
  try {
    module = await import("./resource-bundle.ts") as Record<string, any>;
  } catch {
    // Keep RED as a failing assertion when the production module is absent.
  }
  for (const name of names) assert.equal(typeof module[name], "function", `expected resource-bundle.ts to export ${name}()`);
  return module;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function manifestFor(options: { version?: number; markdownBytes?: number; markdownSha?: string; wavBytes?: number; wavSha?: string; pngBytes?: number; pngSha?: string } = {}) {
  return {
    format,
    version: options.version ?? 1,
    material: {
      entry: "material.md" as const,
      filename: "KET questions.md",
      byteLength: options.markdownBytes ?? markdown.length,
      sha256: options.markdownSha ?? sha256(markdown),
    },
    speech: {
      profile: "default" as const,
      profileKey: "a".repeat(64),
      total: 1,
      clips: [{
        id: "phase1-1-1",
        entry: "audio/phase1-1-1.wav",
        cacheKey: "b".repeat(64),
        byteLength: options.wavBytes ?? wav.length,
        sha256: options.wavSha ?? sha256(wav),
      }],
    },
    images: [{
      groupId: "part2-1",
      variant: 1 as const,
      entry: "scenario-images/part2-1-1.png",
      byteLength: options.pngBytes ?? png.length,
      sha256: options.pngSha ?? sha256(png),
    }],
  };
}

async function withTempDirectory<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ket-resource-bundle-test-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createRawArchive(root: string, archivePath: string, entries: Record<string, Buffer>, bundleManifest = manifestFor()): Promise<void> {
  const staging = path.join(root, "raw-bundle");
  for (const [entry, content] of Object.entries({ "manifest.json": Buffer.from(JSON.stringify(bundleManifest)), ...entries })) {
    const filePath = path.join(staging, entry);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  await execFileAsync("/usr/bin/zip", ["-q", "-D", archivePath, "manifest.json", "material.md", "audio/phase1-1-1.wav", "scenario-images/part2-1-1.png"], { cwd: staging });
}

test("validateResourceBundleEntries_rejectsUnsafeDuplicateAndNonFileEntries", async () => {
  const { validateResourceBundleEntries } = await api(["validateResourceBundleEntries"]);
  const allowedNames = new Set(["manifest.json", "material.md", "audio/phase1-1-1.wav", "scenario-images/part2-1-1.png"]);
  const unsafeEntries = [
    [{ name: "manifest.json", kind: "file" }, { name: "manifest.json", kind: "file" }],
    [{ name: "/manifest.json", kind: "file" }],
    [{ name: "../material.md", kind: "file" }],
    [{ name: "audio\\phase1-1-1.wav", kind: "file" }],
    [{ name: "audio/phase1-1-1.wav", kind: "symlink" }],
    [{ name: "audio/phase1-1-1.wav", kind: "hardlink" }],
    [{ name: "audio/", kind: "directory" }],
    [{ name: "material.md", kind: "other" }],
    [{ name: "unrelated.txt", kind: "file" }],
  ];
  for (const entries of unsafeEntries) {
    assert.throws(() => validateResourceBundleEntries({ entries, allowedNames }));
  }
});

test("readResourceBundleArchive_roundTripsValidBundle", async () => {
  const { readResourceBundleArchive, writeResourceBundleArchive } = await api(["readResourceBundleArchive", "writeResourceBundleArchive"]);
  await withTempDirectory(async (root) => {
    const sourceRoot = path.join(root, "source");
    const sources = [
      { entry: "material.md", sourcePath: path.join(sourceRoot, "material.md") },
      { entry: "audio/phase1-1-1.wav", sourcePath: path.join(sourceRoot, "speech.wav") },
      { entry: "scenario-images/part2-1-1.png", sourcePath: path.join(sourceRoot, "picture.png") },
    ];
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(sources[0].sourcePath, markdown);
    await writeFile(sources[1].sourcePath, wav);
    await writeFile(sources[2].sourcePath, png);
    const archivePath = path.join(root, "practice.ketpack.zip");
    await writeResourceBundleArchive({ manifest: manifestFor(), sources, archivePath });
    const destinationDirectory = path.join(root, "decoded");
    const decoded = await readResourceBundleArchive({ archivePath, destinationDirectory });

    assert.deepEqual(decoded.manifest, manifestFor());
    assert.equal(await readFile(decoded.materialPath, "utf8"), markdown.toString("utf8"));
    assert.deepEqual(await readFile(decoded.audioPaths.get("phase1-1-1")!), wav);
    assert.deepEqual(await readFile(decoded.imagePaths.get("part2-1:1")!), png);
    assert.equal(decoded.imagePaths.size, 1, "partial image entries remain partial");
  });
});

test("readResourceBundleArchive_rejectsUnsupportedVersionAndBadMedia", async () => {
  const { readResourceBundleArchive } = await api(["readResourceBundleArchive"]);
  const shortWav = Buffer.alloc(12);
  shortWav.write("RIFF", 0, "ascii");
  shortWav.writeUInt32LE(4, 4);
  shortWav.write("WAVE", 8, "ascii");
  const invalidBundles = [
    { name: "version", manifest: manifestFor({ version: 2 }) },
    { name: "material-hash", manifest: manifestFor({ markdownSha: "c".repeat(64) }) },
    { name: "material-length", manifest: manifestFor({ markdownBytes: markdown.length + 1 }) },
    { name: "audio-hash", manifest: manifestFor({ wavSha: "d".repeat(64) }) },
    { name: "audio-length", manifest: manifestFor({ wavBytes: wav.length + 1 }) },
    { name: "bad-wav", manifest: manifestFor(), replaceWav: Buffer.from("not a wav") },
    { name: "short-wav", manifest: manifestFor({ wavBytes: shortWav.length, wavSha: sha256(shortWav) }), replaceWav: shortWav },
    { name: "bad-png", manifest: manifestFor(), replacePng: Buffer.from("not a png") },
  ];
  await withTempDirectory(async (root) => {
    for (const invalid of invalidBundles) {
      const archivePath = path.join(root, `${invalid.name}.zip`);
      await createRawArchive(root, archivePath, {
        "material.md": markdown,
        "audio/phase1-1-1.wav": invalid.replaceWav ?? wav,
        "scenario-images/part2-1-1.png": invalid.replacePng ?? png,
      }, invalid.manifest);
      const destinationDirectory = path.join(root, `decoded-${invalid.name}`);
      await assert.rejects(readResourceBundleArchive({ archivePath, destinationDirectory }), undefined, invalid.name);
      await assert.rejects(readdir(destinationDirectory), { code: "ENOENT" }, `${invalid.name} staging directory is removed`);
    }
  });
});

test("validateResourceBundleSizes_enforcesAllCaps", async () => {
  const { validateResourceBundleSizes } = await api(["validateResourceBundleSizes"]);
  const twoGiB = 2 * 1024 * 1024 * 1024;
  const tenMiB = 10 * 1024 * 1024;
  for (const input of [
    { compressedBytes: twoGiB + 1, expandedBytes: 0, markdownBytes: 0 },
    { compressedBytes: 0, expandedBytes: twoGiB + 1, markdownBytes: 0 },
    { compressedBytes: 0, expandedBytes: 0, markdownBytes: tenMiB + 1 },
  ]) assert.throws(() => validateResourceBundleSizes(input));
});
