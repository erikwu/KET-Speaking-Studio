import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export type ResourceBundleManifestV1 = {
  format: "ket-speaking-resource-bundle";
  version: 1;
  material: { entry: "material.md"; filename: string; byteLength: number; sha256: string };
  speech: {
    profile: "default" | "current";
    profileKey: string;
    total: number;
    clips: Array<{ id: string; entry: string; cacheKey: string; byteLength: number; sha256: string }>;
  };
  images: Array<{ groupId: string; variant: 1 | 2; entry: string; byteLength: number; sha256: string }>;
};

export type ArchiveEntryDescriptor = {
  name: string;
  kind: "file" | "directory" | "symlink" | "hardlink" | "other";
};

export type ValidatedResourceBundle = {
  manifest: ResourceBundleManifestV1;
  materialPath: string;
  audioPaths: Map<string, string>;
  imagePaths: Map<string, string>;
};

type ZipEntry = ArchiveEntryDescriptor & {
  compressedSize: number;
  expandedSize: number;
  method: number;
  flags: number;
  localHeaderOffset: number;
};

const FORMAT = "ket-speaking-resource-bundle";
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRY_COUNT = 10_000;
const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const ZIP = "/usr/bin/zip";
const UNZIP = "/usr/bin/unzip";

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isByteLength(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateDisplayFilename(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value, "utf8") > 255 ||
    value === "." || value === ".." ||
    /[\\/\0-\x1f\x7f]/.test(value) ||
    path.basename(value) !== value ||
    path.extname(value).toLowerCase() !== ".md"
  ) fail("Resource bundle Markdown filename is invalid.");
}

function safeEntryName(name: string): boolean {
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0") || !/^[\x20-\x7e]+$/.test(name)) return false;
  const parts = name.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

export function validateResourceBundleEntries(input: { entries: ArchiveEntryDescriptor[]; allowedNames: Set<string> }): void {
  if (input.entries.length > MAX_ENTRY_COUNT) fail("Resource bundle contains too many entries.");
  const seen = new Set<string>();
  for (const entry of input.entries) {
    if (!safeEntryName(entry.name)) fail(`Unsafe resource bundle entry name: ${JSON.stringify(entry.name)}.`);
    if (seen.has(entry.name)) fail(`Duplicate resource bundle entry: ${entry.name}.`);
    seen.add(entry.name);
    if (entry.kind !== "file") fail(`Resource bundle entry is not a regular file: ${entry.name}.`);
    if (!input.allowedNames.has(entry.name)) fail(`Unexpected resource bundle entry: ${entry.name}.`);
  }
}

export function validateResourceBundleSizes(input: { compressedBytes: number; expandedBytes: number; markdownBytes: number }): void {
  if (!Number.isSafeInteger(input.compressedBytes) || input.compressedBytes < 0 || input.compressedBytes > MAX_ARCHIVE_BYTES) {
    fail("Compressed resource bundle exceeds the 2 GiB limit.");
  }
  if (!Number.isSafeInteger(input.expandedBytes) || input.expandedBytes < 0 || input.expandedBytes > MAX_ARCHIVE_BYTES) {
    fail("Expanded resource bundle exceeds the 2 GiB limit.");
  }
  if (!Number.isSafeInteger(input.markdownBytes) || input.markdownBytes < 0 || input.markdownBytes > MAX_MARKDOWN_BYTES) {
    fail("Markdown material exceeds the 10 MB limit.");
  }
}

function validateManifest(value: unknown): ResourceBundleManifestV1 {
  if (!isRecord(value) || value.format !== FORMAT || value.version !== 1) fail("Unsupported resource bundle format or version.");
  const material = value.material;
  const speech = value.speech;
  const images = value.images;
  if (!isRecord(material) || material.entry !== "material.md" || !isByteLength(material.byteLength) || !isSha256(material.sha256)) {
    fail("Resource bundle material metadata is invalid.");
  }
  validateDisplayFilename(material.filename);
  if (!isRecord(speech) || (speech.profile !== "default" && speech.profile !== "current") || !isSha256(speech.profileKey)) {
    fail("Resource bundle speech metadata is invalid.");
  }
  if (!Number.isSafeInteger(speech.total) || Number(speech.total) < 1 || !Array.isArray(speech.clips) || speech.clips.length !== speech.total) {
    fail("Resource bundle must include a complete speech package.");
  }
  if (!Array.isArray(images)) fail("Resource bundle image metadata is invalid.");
  const ids = new Set<string>();
  const clips: ResourceBundleManifestV1["speech"]["clips"] = [];
  for (const clip of speech.clips) {
    if (
      !isRecord(clip) || typeof clip.id !== "string" || !/^[a-z0-9-]{1,160}$/.test(clip.id) || ids.has(clip.id) ||
      clip.entry !== `audio/${clip.id}.wav` || !isSha256(clip.cacheKey) || !isByteLength(clip.byteLength) || !isSha256(clip.sha256)
    ) fail("Resource bundle speech clip metadata is invalid.");
    ids.add(clip.id);
    clips.push({ id: clip.id, entry: clip.entry, cacheKey: clip.cacheKey, byteLength: clip.byteLength, sha256: clip.sha256 });
  }
  const imageKeys = new Set<string>();
  const validatedImages: ResourceBundleManifestV1["images"] = [];
  for (const image of images) {
    if (
      !isRecord(image) || typeof image.groupId !== "string" || !/^[a-z0-9-]{1,160}$/.test(image.groupId) ||
      (image.variant !== 1 && image.variant !== 2) || image.entry !== `scenario-images/${image.groupId}-${image.variant}.png` ||
      !isByteLength(image.byteLength) || !isSha256(image.sha256)
    ) fail("Resource bundle image metadata is invalid.");
    const key = `${image.groupId}:${image.variant}`;
    if (imageKeys.has(key)) fail("Resource bundle contains duplicate scenario image metadata.");
    imageKeys.add(key);
    validatedImages.push({ groupId: image.groupId, variant: image.variant, entry: image.entry, byteLength: image.byteLength, sha256: image.sha256 });
  }
  const entryCount = 2 + clips.length + validatedImages.length;
  if (entryCount > MAX_ENTRY_COUNT) fail("Resource bundle contains too many entries.");
  return {
    format: FORMAT,
    version: 1,
    material: { entry: "material.md", filename: material.filename, byteLength: material.byteLength, sha256: material.sha256 },
    speech: { profile: speech.profile, profileKey: speech.profileKey, total: speech.total, clips },
    images: validatedImages,
  };
}

function expectedEntryNames(manifest: ResourceBundleManifestV1): Set<string> {
  return new Set([
    "manifest.json",
    "material.md",
    ...manifest.speech.clips.map((clip) => clip.entry),
    ...manifest.images.map((image) => image.entry),
  ]);
}

async function runZip(args: string[], cwd: string, input?: string): Promise<void> {
  const child = spawn(args[0]!, args.slice(1), { cwd, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  if (input !== undefined) child.stdin.end(input);
  else child.stdin.end();
  const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  if (code !== 0) fail(`ZIP utility failed${stderr ? `: ${stderr.trim()}` : "."}`);
}

async function readEntryBuffer(archivePath: string, name: string, maxBytes: number): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const child = spawn(UNZIP, ["-p", archivePath, name], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill("SIGKILL");
        reject(new Error(`Resource bundle entry exceeds its permitted size: ${name}.`));
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`Unable to read resource bundle entry ${name}${stderr ? `: ${stderr.trim()}` : "."}`));
      else resolve(Buffer.concat(chunks, bytes));
    });
  });
}

async function hashFile(filePath: string): Promise<{ byteLength: number; sha256: string }> {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = chunk as Buffer;
    byteLength += bytes.length;
    hash.update(bytes);
  }
  return { byteLength, sha256: hash.digest("hex") };
}

async function streamEntryToFile(input: {
  archivePath: string;
  entryName: string;
  destinationPath: string;
  expectedBytes: number;
  expectedSha256: string;
  signature: "wav" | "png" | null;
  totalCounter: { value: number };
}): Promise<void> {
  await mkdir(path.dirname(input.destinationPath), { recursive: true });
  const child = spawn(UNZIP, ["-p", input.archivePath, input.entryName], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let bytes = 0;
  const hash = createHash("sha256");
  const prefix: Buffer[] = [];
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      input.totalCounter.value += chunk.length;
      if (bytes > input.expectedBytes || input.totalCounter.value > MAX_ARCHIVE_BYTES) {
        callback(new Error(`Resource bundle entry exceeds its declared or total size: ${input.entryName}.`));
        child.kill("SIGKILL");
        return;
      }
      hash.update(chunk);
      if (prefix.reduce((sum, part) => sum + part.length, 0) < 12) prefix.push(Buffer.from(chunk.subarray(0, 12)));
      callback(null, chunk);
    },
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
  const output = createWriteStream(input.destinationPath, { flags: "wx" });
  let pipelineError: unknown;
  const pipelinePromise = pipeline(child.stdout, meter, output).catch((error) => { pipelineError = error; child.kill("SIGKILL"); });
  const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  await pipelinePromise;
  if (pipelineError) throw pipelineError;
  if (code !== 0) fail(`Unable to read resource bundle entry ${input.entryName}${stderr ? `: ${stderr.trim()}` : "."}`);
  if (bytes !== input.expectedBytes) fail(`Resource bundle entry length mismatch: ${input.entryName}.`);
  if (hash.digest("hex") !== input.expectedSha256) fail(`Resource bundle entry hash mismatch: ${input.entryName}.`);
  const leading = Buffer.concat(prefix);
  if (input.signature === "wav" && (bytes < 44 || leading.length < 12 || leading.toString("ascii", 0, 4) !== "RIFF" || leading.toString("ascii", 8, 12) !== "WAVE")) {
    fail(`Resource bundle WAV signature is invalid: ${input.entryName}.`);
  }
  if (input.signature === "png" && (leading.length < 8 || !leading.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))) {
    fail(`Resource bundle PNG signature is invalid: ${input.entryName}.`);
  }
}

async function listZipEntries(archivePath: string): Promise<ZipEntry[]> {
  const file = await open(archivePath, "r");
  try {
    const metadata = await file.stat();
    if (metadata.size < 22 || metadata.size > MAX_ARCHIVE_BYTES) fail("Resource bundle archive size is invalid.");
    const tailLength = Math.min(metadata.size, 22 + 65_535);
    const tail = Buffer.alloc(tailLength);
    await file.read(tail, 0, tailLength, metadata.size - tailLength);
    let eocd = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50) {
        const commentLength = tail.readUInt16LE(offset + 20);
        if (offset + 22 + commentLength === tail.length) { eocd = offset; break; }
      }
    }
    if (eocd < 0) fail("Resource bundle ZIP directory is missing or malformed.");
    const disk = tail.readUInt16LE(eocd + 4);
    const centralDisk = tail.readUInt16LE(eocd + 6);
    const entriesOnDisk = tail.readUInt16LE(eocd + 8);
    const entryCount = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount > MAX_ENTRY_COUNT || centralSize > MAX_CENTRAL_DIRECTORY_BYTES) {
      fail("Resource bundle uses unsupported ZIP features or has too many entries.");
    }
    if (centralOffset + centralSize > metadata.size - tailLength + eocd || centralOffset + centralSize > metadata.size) {
      fail("Resource bundle ZIP directory is out of bounds.");
    }
    const central = Buffer.alloc(centralSize);
    await file.read(central, 0, centralSize, centralOffset);
    const entries: ZipEntry[] = [];
    let cursor = 0;
    while (cursor < central.length) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) fail("Resource bundle ZIP directory entry is malformed.");
      const madeBy = central.readUInt16LE(cursor + 4) >>> 8;
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const expandedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const startDisk = central.readUInt16LE(cursor + 34);
      const externalAttributes = central.readUInt32LE(cursor + 38);
      const localHeaderOffset = central.readUInt32LE(cursor + 42);
      const recordLength = 46 + nameLength + extraLength + commentLength;
      if (cursor + recordLength > central.length || nameLength === 0) fail("Resource bundle ZIP directory entry is truncated.");
      if (startDisk !== 0 || (flags & 0x0001) !== 0 || ![0, 8].includes(method) || compressedSize === 0xffff_ffff || expandedSize === 0xffff_ffff || localHeaderOffset === 0xffff_ffff) {
        fail("Resource bundle uses encrypted, multi-disk, ZIP64, or unsupported compression entries.");
      }
      const nameBuffer = central.subarray(cursor + 46, cursor + 46 + nameLength);
      if (nameBuffer.some((byte) => byte > 0x7f)) fail("Resource bundle entry names must be ASCII.");
      const name = nameBuffer.toString("ascii");
      const unixMode = madeBy === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
      const fileType = unixMode & 0xf000;
      const dosDirectory = (externalAttributes & 0x10) !== 0;
      let kind: ArchiveEntryDescriptor["kind"] = "file";
      if (name.endsWith("/") || dosDirectory || fileType === 0x4000) kind = "directory";
      else if (fileType === 0xa000) kind = "symlink";
      else if (fileType !== 0 && fileType !== 0x8000) kind = "other";
      entries.push({ name, kind, compressedSize, expandedSize, method, flags, localHeaderOffset });
      cursor += recordLength;
    }
    if (cursor !== central.length || entries.length !== entryCount) fail("Resource bundle ZIP directory length does not match its entry count.");
    return entries;
  } finally {
    await file.close();
  }
}

export async function writeResourceBundleArchive(input: {
  manifest: ResourceBundleManifestV1;
  sources: Array<{ entry: string; sourcePath: string }>;
  archivePath: string;
}): Promise<void> {
  const manifest = validateManifest(input.manifest);
  const expected = expectedEntryNames(manifest);
  const sourceNames = new Set(input.sources.map((source) => source.entry));
  if (sourceNames.size !== input.sources.length || sourceNames.size !== expected.size - 1 || [...sourceNames].some((name) => !expected.has(name) || name === "manifest.json")) {
    fail("Resource bundle source files do not match the manifest.");
  }
  validateResourceBundleEntries({
    entries: [...expected].map((name) => ({ name, kind: "file" })),
    allowedNames: expected,
  });
  const outputDirectory = path.dirname(path.resolve(input.archivePath));
  await mkdir(outputDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(path.join(outputDirectory, ".ketpack-"));
  const temporaryArchive = path.join(outputDirectory, `.ketpack-${randomUUID()}.zip`);
  try {
    const materialSource = input.sources.find((source) => source.entry === "material.md")!;
    const expectedSources = new Map<string, { byteLength: number; sha256: string }>([
      ["material.md", manifest.material],
      ...manifest.speech.clips.map((clip) => [clip.entry, clip] as const),
      ...manifest.images.map((image) => [image.entry, image] as const),
    ]);
    let expandedBytes = 0;
    for (const source of input.sources) {
      const target = path.join(stagingDirectory, source.entry);
      await mkdir(path.dirname(target), { recursive: true });
      await pipeline(createReadStream(source.sourcePath), createWriteStream(target, { flags: "wx" }));
      const metadata = await hashFile(target);
      const descriptor = expectedSources.get(source.entry)!;
      if (metadata.byteLength !== descriptor.byteLength || metadata.sha256 !== descriptor.sha256) fail(`Resource bundle source file does not match its manifest: ${source.entry}.`);
      expandedBytes += metadata.byteLength;
    }
    const manifestPath = path.join(stagingDirectory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest), { flag: "wx" });
    const manifestBytes = (await stat(manifestPath)).size;
    if (manifestBytes > MAX_MANIFEST_BYTES) fail("Resource bundle manifest is too large.");
    expandedBytes += manifestBytes;
    validateResourceBundleSizes({ compressedBytes: 0, expandedBytes, markdownBytes: manifest.material.byteLength });
    const archivePath = temporaryArchive;
    const names = [...expected].sort();
    await runZip([ZIP, "-q", "-D", archivePath, "-@"], stagingDirectory, `${names.join("\n")}\n`);
    const archiveSize = (await stat(archivePath)).size;
    validateResourceBundleSizes({ compressedBytes: archiveSize, expandedBytes, markdownBytes: manifest.material.byteLength });
    await rename(archivePath, path.resolve(input.archivePath));
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
    await rm(temporaryArchive, { force: true });
  }
}

export async function readResourceBundleArchive(input: { archivePath: string; destinationDirectory: string }): Promise<ValidatedResourceBundle> {
  const archivePath = path.resolve(input.archivePath);
  const destinationDirectory = path.resolve(input.destinationDirectory);
  await rm(destinationDirectory, { recursive: true, force: true });
  try {
    const archiveSize = (await stat(archivePath)).size;
    const entries = await listZipEntries(archivePath);
    const allListedNames = new Set(entries.map((entry) => entry.name));
    validateResourceBundleEntries({ entries, allowedNames: allListedNames });
    if (entries.filter((entry) => entry.name === "manifest.json").length !== 1) fail("Resource bundle must contain exactly one manifest.json.");
    const centralByName = new Map(entries.map((entry) => [entry.name, entry]));
    const manifestEntry = centralByName.get("manifest.json")!;
    if (manifestEntry.expandedSize > MAX_MANIFEST_BYTES) fail("Resource bundle manifest is too large.");
    const manifestContent = await readEntryBuffer(archivePath, "manifest.json", MAX_MANIFEST_BYTES);
    if (manifestContent.length !== manifestEntry.expandedSize) fail("Resource bundle manifest length does not match its ZIP directory.");
    const manifest = validateManifest(JSON.parse(manifestContent.toString("utf8")) as unknown);
    const allowedNames = expectedEntryNames(manifest);
    validateResourceBundleEntries({ entries, allowedNames });
    if (entries.length !== allowedNames.size || [...allowedNames].some((name) => !centralByName.has(name))) {
      fail("Resource bundle entries do not match the manifest.");
    }
    const expandedBytes = entries.reduce((sum, entry) => sum + entry.expandedSize, 0);
    validateResourceBundleSizes({ compressedBytes: archiveSize, expandedBytes, markdownBytes: manifest.material.byteLength });
    for (const [name, expectedBytes] of [
      ["material.md", manifest.material.byteLength] as const,
      ...manifest.speech.clips.map((clip) => [clip.entry, clip.byteLength] as const),
      ...manifest.images.map((image) => [image.entry, image.byteLength] as const),
    ]) {
      if (centralByName.get(name)!.expandedSize !== expectedBytes) fail(`Resource bundle declared length mismatch: ${name}.`);
    }
    await mkdir(destinationDirectory, { recursive: true });
    let expandedStreamBytes = 0;
    const totalCounter = { get value() { return expandedStreamBytes; }, set value(value: number) { expandedStreamBytes = value; } };
    const materialPath = path.join(destinationDirectory, "material.md");
    await streamEntryToFile({ archivePath, entryName: "material.md", destinationPath: materialPath, expectedBytes: manifest.material.byteLength, expectedSha256: manifest.material.sha256, signature: null, totalCounter });
    const audioPaths = new Map<string, string>();
    for (const clip of manifest.speech.clips) {
      const destinationPath = path.join(destinationDirectory, "audio", `${clip.id}.wav`);
      await streamEntryToFile({ archivePath, entryName: clip.entry, destinationPath, expectedBytes: clip.byteLength, expectedSha256: clip.sha256, signature: "wav", totalCounter });
      audioPaths.set(clip.id, destinationPath);
    }
    const imagePaths = new Map<string, string>();
    for (const image of manifest.images) {
      const destinationPath = path.join(destinationDirectory, "scenario-images", `${image.groupId}-${image.variant}.png`);
      await streamEntryToFile({ archivePath, entryName: image.entry, destinationPath, expectedBytes: image.byteLength, expectedSha256: image.sha256, signature: "png", totalCounter });
      imagePaths.set(`${image.groupId}:${image.variant}`, destinationPath);
    }
    if (expandedStreamBytes + manifestContent.length !== expandedBytes) fail("Resource bundle expanded size does not match its ZIP directory.");
    return { manifest, materialPath, audioPaths, imagePaths };
  } catch (error) {
    await rm(destinationDirectory, { recursive: true, force: true });
    throw error;
  }
}
