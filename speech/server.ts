import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type SectionId = "phase1" | "phase2" | "part2";
type VoiceRole = "question" | "answer";
interface Turn {
  id: string;
  role: "Q" | "A" | "B";
  voiceRole: VoiceRole;
  text: string;
  translation: string;
}
interface Group {
  id: string;
  number: number;
  context: string;
  turns: Turn[];
}
interface ParsedSection {
  id: SectionId;
  title: string;
  groups: Group[];
}
interface TtsRequest {
  id: string;
  text: string;
  instruct: string;
  language: string;
}
interface PendingSpeech {
  resolve: (fileName: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
type SpeechPriority = "foreground" | "background";
interface QueuedSpeech {
  request: TtsRequest;
  resolve: (fileName: string) => void;
  reject: (error: Error) => void;
}
type IllustrationState = "running" | "completed" | "failed";
interface IllustrationJob {
  id: string;
  scenarioKey: string;
  state: IllustrationState;
  progress: number;
  completed: number;
  message: string;
  error?: string;
  logs: string;
  child?: ChildProcess;
}
type AudioCacheProfile = "default" | "current";
type AudioCacheJobState = "running" | "completed" | "failed";
interface AudioCacheItem {
  id: string;
  text: string;
  language: "English" | "Chinese";
  instruct: string;
  cacheKey: string;
}
interface OfflineClip {
  id: string;
  cacheKey: string;
  audioHash: string;
}
interface OfflineManifest {
  version: 1;
  materialKey: string;
  profile: AudioCacheProfile;
  profileKey: string;
  total: number;
  clips: OfflineClip[];
  completedAt?: string;
}
interface AudioCacheJob {
  id: string;
  materialKey: string;
  profile: AudioCacheProfile;
  profileKey: string;
  state: AudioCacheJobState;
  completed: number;
  total: number;
  currentItem: string;
  message: string;
  error?: string;
  items: AudioCacheItem[];
  clips: OfflineClip[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const MODEL_DIR = path.join(ROOT, "models", "Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16");
const AUDIO_DIR = path.join(ROOT, "outputs", "speech-practice");
const OFFLINE_CACHE_DIR = path.join(AUDIO_DIR, "offline-audio");
const OFFLINE_STAGING_DIR = path.join(AUDIO_DIR, "offline-audio.staging");
const OFFLINE_BACKUP_DIR = path.join(AUDIO_DIR, "offline-audio.previous");
const ILLUSTRATION_DIR = path.join(AUDIO_DIR, "scenario-images");
const PYTHON = process.env.TTS_PYTHON ?? path.join(ROOT, ".venv", "bin", "python");
const PY_WORKER = path.join(HERE, "mlx_worker.py");
const IMAGE_CLI = path.join(ROOT, ".venv", "bin", "mflux-generate-qwen-2.1");
const IMAGE_MODELS = [
  path.join(ROOT, "models", "Qwen-Image-2.1-MLX-4bit-Heretic"),
  path.join(ROOT, "models", "Qwen-Image-2.1-MLX-4bit"),
];
const ILLUSTRATION_PROMPT_VERSION = "dialogue-cue-v2";
const JSON_LIMIT = 64 * 1024;
const AUDIO_CACHE_REQUEST_LIMIT = 8 * 1024 * 1024;
const FILE_LIMIT = 10 * 1024 * 1024;
const SECTION_TITLES: Record<SectionId, string> = {
  phase1: "Part 1 · Phase 1",
  phase2: "Part 1 · Phase 2",
  part2: "Part 2",
};
function isImageModelDirectory(candidate: string): boolean {
  return (
    existsSync(path.join(candidate, "vae", "model.safetensors.index.json")) &&
    existsSync(path.join(candidate, "transformer", "model.safetensors.index.json")) &&
    existsSync(path.join(candidate, "text_encoder", "model.safetensors.index.json")) &&
    existsSync(path.join(candidate, "processor", "tokenizer.json"))
  );
}
const IMAGE_MODEL_DIR = IMAGE_MODELS.find(isImageModelDirectory) ?? IMAGE_MODELS.at(-1)!;

let worker: ChildProcess | null = null;
let workerReady: Promise<void> | null = null;
let workerReadyResolve: (() => void) | null = null;
let workerReadyReject: ((error: Error) => void) | null = null;
let workerStdout = "";
let workerLog = "";
const pending = new Map<string, PendingSpeech>();
const speechQueues: Record<SpeechPriority, QueuedSpeech[]> = { foreground: [], background: [] };
const audioCacheJobs = new Map<string, AudioCacheJob>();
const illustrationJobs = new Map<string, IllustrationJob>();
let activeIllustrationJob: string | null = null;
let activeSpeechId: string | null = null;
let dispatchingSpeech = false;
let activeAudioCacheJob: string | null = null;

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

function readJson(req: IncomingMessage, limit = JSON_LIMIT): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("请求内容过大。"), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("请求不是有效的 JSON。"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^\uFEFF?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "");
}

function cleanTurnLine(line: string): { role: "Q" | "A" | "B"; text: string; translation: string } | null {
  const roleMatch = /^\s*(?:(?:[-*+]|\d+\.)\s*)?\*\*?\s*([QAB])\s*:\s*/i.exec(line);
  if (!roleMatch) return null;
  let remainder = line.slice(roleMatch[0].length).trim();
  remainder = remainder.replace(/\*\*\s*$/, "").replace(/\*\s*$/, "").trim();

  let translation = "";
  const translationMatch = /[（(]([^（）()]*)[）)]\s*$/.exec(remainder);
  if (translationMatch) {
    translation = translationMatch[1].trim();
    remainder = remainder.slice(0, translationMatch.index).trim();
  }
  const text = remainder
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\\([*_`~])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return { role: roleMatch[1].toUpperCase() as "Q" | "A" | "B", text, translation };
}

function getQuestionAnswerRole(role: "Q" | "A" | "B", text: string): VoiceRole {
  if (role === "Q" || /[?？]\s*$/.test(text)) return "question";
  return "answer";
}

function parseMarkdown(markdown: string): ParsedSection[] {
  const sections = new Map<SectionId, ParsedSection>([
    ["phase1", { id: "phase1", title: SECTION_TITLES.phase1, groups: [] }],
    ["phase2", { id: "phase2", title: SECTION_TITLES.phase2, groups: [] }],
    ["part2", { id: "part2", title: SECTION_TITLES.part2, groups: [] }],
  ]);
  let active: SectionId | null = null;
  let current: Group | null = null;

  for (const line of stripFrontmatter(markdown).split(/\r?\n/)) {
    const heading = /^#{1,4}\s+(.+?)\s*#*\s*$/.exec(line)?.[1] ?? "";
    const normalizedHeading = heading.toLowerCase().replace(/\s+/g, " ");
    if (/\bpart\s*1\b/.test(normalizedHeading) && /\bphase\s*1\b/.test(normalizedHeading)) {
      active = "phase1";
      current = null;
      continue;
    }
    if (/\bpart\s*1\b/.test(normalizedHeading) && /\bphase\s*2\b/.test(normalizedHeading)) {
      active = "phase2";
      current = null;
      continue;
    }
    if (/\bpart\s*2\b/.test(normalizedHeading)) {
      active = "part2";
      current = null;
      continue;
    }
    if (/^#{1,4}\s/.test(line) && active) {
      active = null;
      current = null;
      continue;
    }
    if (!active) continue;

    if (active === "part2") {
      const context = /^\s*\d+\.\s+\*\*\s*(?:情境|Situation)\s*[：:]\s*(.*?)\*\*/i.exec(line);
      if (context) {
        current = {
          id: `part2-${sections.get("part2")!.groups.length + 1}`,
          number: sections.get("part2")!.groups.length + 1,
          context: context[1].trim(),
          turns: [],
        };
        sections.get("part2")!.groups.push(current);
      }
    }

    const turn = cleanTurnLine(line);
    if (!turn) continue;
    if (active === "part2") {
      if (!current) {
        current = {
          id: `part2-${sections.get("part2")!.groups.length + 1}`,
          number: sections.get("part2")!.groups.length + 1,
          context: "",
          turns: [],
        };
        sections.get("part2")!.groups.push(current);
      }
    } else if (turn.role === "Q" || !current) {
      current = {
        id: `${active}-${sections.get(active)!.groups.length + 1}`,
        number: sections.get(active)!.groups.length + 1,
        context: "",
        turns: [],
      };
      sections.get(active)!.groups.push(current);
    }

    current!.turns.push({
      id: `${current!.id}-${current!.turns.length + 1}`,
      role: turn.role,
      voiceRole: getQuestionAnswerRole(turn.role, turn.text),
      text: turn.text,
      translation: turn.translation,
    });
  }

  return ["phase1", "phase2", "part2"]
    .map((id) => sections.get(id as SectionId)!)
    .filter((section) => section.groups.some((group) => group.turns.length > 0));
}

function normalizeMarkdownPath(value: string): string {
  return path.resolve(value.trim().replace(/\\~/g, "~"));
}

function materialIdentity(filePath: string, markdown: string): string {
  return createHash("sha256").update(path.resolve(filePath)).update("\0").update(markdown).digest("hex");
}

function speechLanguage(text: string): "English" | "Chinese" {
  return /[\u3400-\u9fff]/.test(text) ? "Chinese" : "English";
}

async function localModelReady(): Promise<boolean> {
  try {
    const files = await readdir(MODEL_DIR);
    if (!files.includes("config.json")) return false;
    const indexPath = path.join(MODEL_DIR, "model.safetensors.index.json");
    if (existsSync(indexPath)) {
      const index = JSON.parse(await readFile(indexPath, "utf8")) as { weight_map?: Record<string, string> };
      const requiredShards = [...new Set(Object.values(index.weight_map ?? {}))];
      return (
        requiredShards.length > 0 &&
        requiredShards.every((name) => existsSync(path.join(MODEL_DIR, name))) &&
        existsSync(path.join(MODEL_DIR, "speech_tokenizer", "model.safetensors"))
      );
    }
    return files.some((name) => name.endsWith(".safetensors"));
  } catch {
    return false;
  }
}

function runtimeReady(): boolean {
  return existsSync(PYTHON) && existsSync(path.join(ROOT, ".venv", "lib", "python3.13", "site-packages", "mlx_audio"));
}

function handleWorkerMessage(message: Record<string, unknown>): void {
  if (message.type === "ready") {
    workerReadyResolve?.();
    workerReadyResolve = null;
    workerReadyReject = null;
    return;
  }
  if (message.type === "fatal") {
    const error = new Error(String(message.error ?? "TTS 模型加载失败。"));
    workerReadyReject?.(error);
    workerReadyResolve = null;
    workerReadyReject = null;
    return;
  }
  if (typeof message.id !== "string") return;
  const job = pending.get(message.id);
  if (!job) return;
  clearTimeout(job.timer);
  pending.delete(message.id);
  if (activeSpeechId === message.id) activeSpeechId = null;
  if (message.ok && typeof message.fileName === "string") job.resolve(message.fileName);
  else job.reject(new Error(String(message.error ?? "语音合成失败。")));
  void dispatchNextSpeech();
}

function failWorker(error: Error): void {
  workerReadyReject?.(error);
  workerReadyResolve = null;
  workerReadyReject = null;
  activeSpeechId = null;
  dispatchingSpeech = false;
  for (const [id, job] of pending) {
    clearTimeout(job.timer);
    job.reject(new Error(`${error.message}${workerLog ? `\n${workerLog.slice(-1600)}` : ""}`));
    pending.delete(id);
  }
  for (const queue of Object.values(speechQueues)) {
    for (const job of queue.splice(0)) job.reject(new Error(`${error.message}${workerLog ? `\n${workerLog.slice(-1600)}` : ""}`));
  }
  worker = null;
  workerReady = null;
  workerStdout = "";
}

function ensureWorker(): Promise<void> {
  if (worker && workerReady) return workerReady;
  workerLog = "";
  workerStdout = "";
  const child = spawn(PYTHON, ["-u", PY_WORKER, "--model", MODEL_DIR, "--output", AUDIO_DIR], {
    cwd: ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  worker = child;
  let timeout: ReturnType<typeof setTimeout>;
  const ready = new Promise<void>((resolve, reject) => {
    workerReadyResolve = resolve;
    workerReadyReject = reject;
    timeout = setTimeout(() => reject(new Error("模型加载超时。")), 10 * 60 * 1000);
    child.stdout?.on("data", (chunk: Buffer) => {
      workerStdout += chunk.toString("utf8");
      const lines = workerStdout.split("\n");
      workerStdout = lines.pop() ?? "";
      for (const line of lines) {
        try {
          handleWorkerMessage(JSON.parse(line) as Record<string, unknown>);
        } catch {
          workerLog = `${workerLog}\n${line}`.slice(-8000);
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      workerLog = `${workerLog}${chunk.toString("utf8")}`.slice(-8000);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      failWorker(new Error(`无法启动本地 MLX 运行环境：${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (worker === child) failWorker(new Error(`MLX 语音进程结束（${signal ?? code ?? "未知原因"}）。`));
    });
  });
  workerReady = ready;
  ready.then(() => clearTimeout(timeout), () => clearTimeout(timeout));
  return ready;
}

async function dispatchNextSpeech(): Promise<void> {
  if (dispatchingSpeech || activeSpeechId) return;
  dispatchingSpeech = true;
  try {
    await ensureWorker();
  } catch (error) {
    dispatchingSpeech = false;
    const message = error instanceof Error ? error.message : "无法启动语音模型。";
    for (const queue of Object.values(speechQueues)) {
      for (const job of queue.splice(0)) job.reject(new Error(message));
    }
    return;
  }

  const job = speechQueues.foreground.shift() ?? speechQueues.background.shift();
  dispatchingSpeech = false;
  if (!job || !worker?.stdin) return;

  const { request, resolve, reject } = job;
  activeSpeechId = request.id;
  const timer = setTimeout(() => {
    const active = pending.get(request.id);
    if (!active) return;
    pending.delete(request.id);
    activeSpeechId = null;
    active.reject(new Error("合成超时，请稍后重试。"));
    worker?.kill("SIGTERM");
  }, 10 * 60 * 1000);
  pending.set(request.id, { resolve, reject, timer });
  worker.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
    if (!error) return;
    const active = pending.get(request.id);
    if (!active) return;
    clearTimeout(active.timer);
    pending.delete(request.id);
    activeSpeechId = null;
    active.reject(error);
    worker?.kill("SIGTERM");
  });
}

function enqueueSpeech(request: TtsRequest, priority: SpeechPriority): Promise<string> {
  return new Promise((resolve, reject) => {
    speechQueues[priority].push({ request, resolve, reject });
    void dispatchNextSpeech();
  });
}

async function synthesize(input: unknown): Promise<{ id: string; audioUrl: string }> {
  if (!isRecord(input)) throw new Error("请求格式不正确。");
  const { text, instruct, language } = input;
  if (typeof text !== "string" || !text.trim() || text.length > 3000) throw new Error("朗读文本需为 1 到 3,000 个字符。");
  if (typeof instruct !== "string" || instruct.length > 1200) throw new Error("语气指令不能超过 1,200 个字符。");
  if (!new Set(["English", "Chinese"]).has(String(language))) throw new Error("语言只支持 English 或 Chinese。");
  if (!(await localModelReady())) throw Object.assign(new Error(`模型文件尚未下载完整：${path.relative(ROOT, MODEL_DIR)}`), { status: 503 });
  if (!runtimeReady()) throw Object.assign(new Error("MLX-Audio 运行环境未安装。请按 speech/README.md 完成一次环境准备。"), { status: 503 });
  await mkdir(AUDIO_DIR, { recursive: true });

  const id = randomUUID();
  const request: TtsRequest = { id, text: text.trim(), instruct: instruct.trim(), language: String(language) };
  await enqueueSpeech(request, "foreground");
  return { id, audioUrl: `/api/audio/${id}` };
}

function offlineManifestPath(directory: string): string {
  return path.join(directory, "manifest.json");
}

function offlineClipPath(directory: string, id: string): string {
  return path.join(directory, `clip-${id}.wav`);
}

function isOfflineManifest(value: unknown): value is OfflineManifest {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.materialKey !== "string" || !/^[a-f0-9]{64}$/.test(value.materialKey) ||
    (value.profile !== "default" && value.profile !== "current") ||
    typeof value.profileKey !== "string" || !/^[a-f0-9]{64}$/.test(value.profileKey) ||
    typeof value.total !== "number" || !Number.isInteger(value.total) || value.total < 0 ||
    !Array.isArray(value.clips) ||
    (value.completedAt !== undefined && typeof value.completedAt !== "string")
  ) return false;

  const ids = new Set<string>();
  for (const clip of value.clips) {
    if (
      !isRecord(clip) || typeof clip.id !== "string" || !/^[a-z0-9-]{1,160}$/.test(clip.id) ||
      typeof clip.cacheKey !== "string" || !/^[a-f0-9]{64}$/.test(clip.cacheKey) ||
      typeof clip.audioHash !== "string" || !/^[a-f0-9]{64}$/.test(clip.audioHash) || ids.has(clip.id)
    ) return false;
    ids.add(clip.id);
  }
  return true;
}

async function readOfflineManifest(directory: string): Promise<OfflineManifest | null> {
  try {
    const value: unknown = JSON.parse(await readFile(offlineManifestPath(directory), "utf8"));
    return isOfflineManifest(value) ? value : null;
  } catch {
    return null;
  }
}

async function writeOfflineManifest(directory: string, manifest: OfflineManifest): Promise<void> {
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `manifest-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, JSON.stringify(manifest, null, 2), "utf8");
  await rename(temporaryPath, offlineManifestPath(directory));
}

function audioItemCacheKey(materialKey: string, item: Omit<AudioCacheItem, "cacheKey">): string {
  return createHash("sha256").update(JSON.stringify([
    materialKey,
    item.id,
    item.text,
    item.language,
    item.instruct,
  ])).digest("hex");
}

async function offlineClipHash(directory: string, id: string): Promise<string | null> {
  try {
    const audio = await readFile(offlineClipPath(directory, id));
    if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") return null;
    return createHash("sha256").update(audio).digest("hex");
  } catch {
    return null;
  }
}

function publicAudioCacheJob(job: AudioCacheJob): Record<string, unknown> {
  return {
    id: job.id,
    materialKey: job.materialKey,
    profile: job.profile,
    state: job.state,
    completed: job.completed,
    total: job.total,
    progress: job.total ? Math.floor((job.completed / job.total) * 100) : 100,
    currentItem: job.currentItem,
    message: job.message,
    error: job.error,
  };
}

async function promoteOfflinePackage(): Promise<void> {
  await rm(OFFLINE_BACKUP_DIR, { recursive: true, force: true });
  const hadPrevious = existsSync(OFFLINE_CACHE_DIR);
  if (hadPrevious) await rename(OFFLINE_CACHE_DIR, OFFLINE_BACKUP_DIR);
  try {
    await rename(OFFLINE_STAGING_DIR, OFFLINE_CACHE_DIR);
    if (hadPrevious) await rm(OFFLINE_BACKUP_DIR, { recursive: true, force: true });
  } catch (error) {
    if (hadPrevious && existsSync(OFFLINE_BACKUP_DIR)) {
      await rm(OFFLINE_CACHE_DIR, { recursive: true, force: true });
      await rename(OFFLINE_BACKUP_DIR, OFFLINE_CACHE_DIR);
    }
    throw error;
  }
}

async function runAudioCacheJob(job: AudioCacheJob): Promise<void> {
  try {
    const reusable = new Map(job.clips.map((clip) => [clip.id, clip]));
    const itemCacheKeys = new Map(job.items.map((item) => [item.id, item.cacheKey]));
    for (const item of job.items) {
      job.currentItem = item.id;
      const previousClip = reusable.get(item.id);
      if (
        previousClip?.cacheKey === item.cacheKey &&
        await offlineClipHash(OFFLINE_STAGING_DIR, item.id) === previousClip.audioHash
      ) continue;

      job.message = `正在生成第 ${job.completed + 1}/${job.total} 句离线语音…`;
      const id = randomUUID();
      const fileName = await enqueueSpeech({
        id,
        text: item.text,
        instruct: item.instruct,
        language: item.language,
      }, "background");
      if (path.basename(fileName) !== fileName || !new RegExp(`^${id}_[0-9]+\\.wav$`).test(fileName)) {
        throw new Error("本机模型返回了无效的语音文件名。");
      }
      const generatedPath = path.join(AUDIO_DIR, fileName);
      try {
        await copyFile(generatedPath, offlineClipPath(OFFLINE_STAGING_DIR, item.id));
      } finally {
        await rm(generatedPath, { force: true });
      }

      const audioHash = await offlineClipHash(OFFLINE_STAGING_DIR, item.id);
      if (!audioHash) throw new Error(`第 ${job.completed + 1} 句生成的 WAV 文件无效。`);
      const clip: OfflineClip = { id: item.id, cacheKey: item.cacheKey, audioHash };
      reusable.set(clip.id, clip);
      job.clips = job.items
        .map((candidate) => reusable.get(candidate.id))
        .filter((candidate): candidate is OfflineClip => {
          return Boolean(candidate && itemCacheKeys.get(candidate.id) === candidate.cacheKey);
        });
      const manifest: OfflineManifest = {
        version: 1,
        materialKey: job.materialKey,
        profile: job.profile,
        profileKey: job.profileKey,
        total: job.total,
        clips: job.clips,
      };
      await writeOfflineManifest(OFFLINE_STAGING_DIR, manifest);
      job.completed += 1;
    }

    if (job.clips.length !== job.total) throw new Error("离线语音缓存未生成完整，旧缓存仍保留。");
    const completeManifest: OfflineManifest = {
      version: 1,
      materialKey: job.materialKey,
      profile: job.profile,
      profileKey: job.profileKey,
      total: job.total,
      clips: job.clips,
      completedAt: new Date().toISOString(),
    };
    await writeOfflineManifest(OFFLINE_STAGING_DIR, completeManifest);
    await promoteOfflinePackage();
    job.state = "completed";
    job.currentItem = "";
    job.message = "离线语音已生成并保存到本机。";
  } catch (error) {
    job.state = "failed";
    job.message = "离线语音生成失败；原有缓存仍可使用。";
    job.error = error instanceof Error ? error.message : "本机语音生成失败。";
  } finally {
    if (activeAudioCacheJob === job.id) activeAudioCacheJob = null;
  }
}

async function startAudioCacheJob(input: unknown): Promise<AudioCacheJob> {
  if (!isRecord(input)) throw new Error("离线语音缓存请求格式不正确。");
  const filePathValue = input.filePath;
  const requestedMaterialKey = input.materialKey;
  const profileValue = input.profile;
  const inputItems = input.items;
  if (typeof filePathValue !== "string" || !filePathValue.trim()) throw new Error("请先读取 Markdown 练习材料。");
  if (typeof requestedMaterialKey !== "string" || !/^[a-f0-9]{64}$/.test(requestedMaterialKey)) throw new Error("练习材料标识无效，请重新读取 Markdown。");
  if (profileValue !== "default" && profileValue !== "current") throw new Error("离线语音配置类型无效。");
  if (!Array.isArray(inputItems) || !inputItems.length) throw new Error("练习材料中没有可生成的语音。");

  const filePath = normalizeMarkdownPath(filePathValue);
  if (path.extname(filePath).toLowerCase() !== ".md") throw new Error("请先读取 .md 练习材料。");
  const metadata = await stat(filePath).catch(() => null);
  if (!metadata?.isFile()) throw new Error("找不到所选 Markdown 文件，请重新读取材料。");
  if (metadata.size > FILE_LIMIT) throw Object.assign(new Error("Markdown 文件超过 10 MB。"), { status: 413 });
  const markdown = await readFile(filePath, "utf8");
  const actualMaterialKey = materialIdentity(filePath, markdown);
  if (actualMaterialKey !== requestedMaterialKey) {
    throw Object.assign(new Error("Markdown 文件已变化，请重新读取后再生成离线语音。"), { status: 409 });
  }

  const expectedTurns = parseMarkdown(markdown).flatMap((section) => section.groups.flatMap((group) => group.turns));
  if (inputItems.length !== expectedTurns.length) throw new Error("练习句数与所选材料不一致，请重新读取 Markdown。");
  const items: AudioCacheItem[] = [];
  const seenIds = new Set<string>();
  for (const [index, raw] of inputItems.entries()) {
    const expected = expectedTurns[index];
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.text !== "string" || typeof raw.instruct !== "string") {
      throw new Error(`第 ${index + 1} 句的缓存信息不完整。`);
    }
    if (!/^[a-z0-9-]{1,160}$/.test(raw.id) || raw.id !== expected.id || raw.text.trim() !== expected.text) {
      throw new Error(`第 ${index + 1} 句与所选材料不匹配，请重新读取 Markdown。`);
    }
    if (raw.text.length > 3000) throw new Error(`第 ${index + 1} 句超过 3,000 个字符。`);
    if (raw.instruct.length > 1200) throw new Error(`第 ${index + 1} 句的语气指令超过 1,200 个字符。`);
    if (raw.language !== speechLanguage(expected.text)) throw new Error(`第 ${index + 1} 句的语言标记无效。`);
    if (seenIds.has(raw.id)) throw new Error("练习材料中出现重复句子标识。");
    seenIds.add(raw.id);
    const item = {
      id: raw.id,
      text: expected.text,
      language: speechLanguage(expected.text),
      instruct: raw.instruct.trim(),
    } as Omit<AudioCacheItem, "cacheKey">;
    items.push({ ...item, cacheKey: audioItemCacheKey(actualMaterialKey, item) });
  }

  if (!(await localModelReady())) throw Object.assign(new Error(`模型文件尚未下载完整：${path.relative(ROOT, MODEL_DIR)}`), { status: 503 });
  if (!runtimeReady()) throw Object.assign(new Error("MLX-Audio 运行环境未安装。请按 speech/README.md 完成一次环境准备。"), { status: 503 });
  if (activeAudioCacheJob) throw Object.assign(new Error("已有离线语音缓存任务正在生成，请稍后再试。"), { status: 409 });

  activeAudioCacheJob = "starting";
  try {
    await mkdir(AUDIO_DIR, { recursive: true });
    const profile = profileValue;
    const profileKey = createHash("sha256")
      .update(JSON.stringify([profile, items.map(({ id, cacheKey }) => [id, cacheKey])]))
      .digest("hex");
    const activeManifest = await readOfflineManifest(OFFLINE_CACHE_DIR);
    const activeComplete = Boolean(activeManifest?.completedAt && activeManifest.clips.length === activeManifest.total);
    const activePackageUsable = Boolean(
      activeManifest &&
      activeComplete &&
      activeManifest.clips.every((clip) => existsSync(offlineClipPath(OFFLINE_CACHE_DIR, clip.id))) &&
      (await Promise.all(activeManifest.clips.map(async (clip) => {
        return await offlineClipHash(OFFLINE_CACHE_DIR, clip.id) === clip.audioHash;
      }))).every(Boolean)
    );
    if (
      activeManifest &&
      activePackageUsable &&
      activeManifest.materialKey === actualMaterialKey &&
      activeManifest.profileKey === profileKey
    ) {
      const cachedJob: AudioCacheJob = {
        id: randomUUID(),
        materialKey: actualMaterialKey,
        profile,
        profileKey,
        state: "completed",
        completed: items.length,
        total: items.length,
        currentItem: "",
        message: "已有匹配的离线语音缓存。",
        items,
        clips: activeManifest.clips,
      };
      audioCacheJobs.set(cachedJob.id, cachedJob);
      activeAudioCacheJob = null;
      return cachedJob;
    }

    const stagedManifest = await readOfflineManifest(OFFLINE_STAGING_DIR);
    const matchingStage = stagedManifest?.materialKey === actualMaterialKey && stagedManifest.profileKey === profileKey;
    if (!matchingStage) await rm(OFFLINE_STAGING_DIR, { recursive: true, force: true });
    await mkdir(OFFLINE_STAGING_DIR, { recursive: true });
    const reusableClips: OfflineClip[] = [];
    if (matchingStage && stagedManifest) {
      for (const clip of stagedManifest.clips) {
        const item = items.find((candidate) => candidate.id === clip.id);
        if (
          item?.cacheKey === clip.cacheKey &&
          await offlineClipHash(OFFLINE_STAGING_DIR, clip.id) === clip.audioHash
        ) reusableClips.push(clip);
      }
    }
    const job: AudioCacheJob = {
      id: randomUUID(),
      materialKey: actualMaterialKey,
      profile,
      profileKey,
      state: "running",
      completed: reusableClips.length,
      total: items.length,
      currentItem: "",
      message: reusableClips.length ? `正在续生成，已复用 ${reusableClips.length} 句缓存…` : "后台语音缓存已开始…",
      items,
      clips: reusableClips,
    };
    await writeOfflineManifest(OFFLINE_STAGING_DIR, {
      version: 1,
      materialKey: actualMaterialKey,
      profile,
      profileKey,
      total: items.length,
      clips: reusableClips,
    });
    audioCacheJobs.set(job.id, job);
    activeAudioCacheJob = job.id;
    void runAudioCacheJob(job);
    return job;
  } catch (error) {
    if (activeAudioCacheJob === "starting") activeAudioCacheJob = null;
    throw error;
  }
}

function illustrationKey(filePath: string, context: string, dialogue: string): string {
  const normalizedPath = path.resolve(filePath.replace(/\\~/g, "~"));
  return createHash("sha256").update(`${ILLUSTRATION_PROMPT_VERSION}\0${normalizedPath}\0${context.trim()}\0${dialogue.trim()}`).digest("hex").slice(0, 32);
}

function scenarioImageUrls(key: string): string[] {
  return [1, 2]
    .filter((number) => existsSync(path.join(ILLUSTRATION_DIR, key, `picture-${number}.png`)))
    .map((number) => `/api/scenario-images/${key}/${number}`);
}

function publicIllustrationJob(job: IllustrationJob): Record<string, unknown> {
  return {
    id: job.id,
    scenarioKey: job.scenarioKey,
    state: job.state,
    progress: job.progress,
    completed: job.completed,
    message: job.message,
    error: job.error,
    logTail: job.logs.slice(-1600),
    imageUrls: scenarioImageUrls(job.scenarioKey),
  };
}

function visualSubject(context: string, dialogue: string): string {
  const text = dialogue.toLowerCase();
  const cues: Array<[RegExp, string]> = [
    [/cycling in the park|ride my bike|go cycling|\bbicycles?\b|\bbikes?\b/, "two child friends riding bicycles together along a leafy park path"],
    [/\bbadminton\b/, "two child friends playing badminton together in a park"],
    [/\bfootball\b|\bsoccer\b/, "two children choosing a football as a birthday present for their friend"],
    [/\bpicnic\b|\bsandwiches\b/, "two children preparing sandwiches, fruit and juice for a picnic outdoors"],
    [/\bart club\b|\bdrawing\b|\bdraw\b/, "two school friends choosing an art club, with sketchbooks and pencils"],
    [/\bfilm\b|\bmovie\b|\bpopcorn\b/, "two friends watching a film together at home on a rainy day with popcorn"],
    [/asian civilisations museum/, "school children exploring galleries at Singapore's Asian Civilisations Museum"],
    [/\bbirthday party\b|\bparty at home\b/, "two children planning a cheerful birthday party at home or in a sunny park"],
    [/\bspace\b|\bplanets\b/, "two children reading an illustrated book about space and planets"],
    [/\bbeach\b|\bsand\b/, "two friends enjoying a weekend beach trip, playing on the sand with a ball"],
    [/\btennis\b/, "two children choosing a sport and playing tennis together"],
    [/\btable tennis\b/, "two school friends playing table tennis after school"],
    [/\bplants\b|\banimals\b|\bschool project\b/, "two students making a school project about animals and plants"],
    [/\bgrandma\b|\bgrandmother\b/, "a child visiting their grandmother at home and sharing a family lunch"],
    [/\bhamster\b|\brabbit\b|\bfish as a pet\b/, "two children talking about choosing a small pet, with a friendly hamster nearby"],
    [/\bmap\b|\bcamera\b|\btake photos\b/, "two children packing a map and camera for a trip"],
    [/\bsandwich\b|\bwatermelon juice\b/, "two friends choosing sandwiches and watermelon juice at a lunch counter"],
    [/\blibrary\b|\bhomework\b/, "two children studying together at a quiet library table"],
    [/\bmagic show\b|\bschool play\b/, "two children choosing a show and watching a colorful stage performance"],
    [/\bsports day\b|\bbeanbag\b|\brace\b/, "children taking part together in a beanbag game at a school sports day"],
  ];
  return cues.find(([pattern]) => pattern.test(text))?.[1] ?? `two child friends acting out the everyday situation: ${context}`;
}

function illustrationPrompt(subject: string, variant: number): string {
  const framing = variant === 1
    ? "Wide view, showing the setting and main activity clearly."
    : "A different moment in the same activity, closer view with both children naturally interacting.";
  return [
    `Single full-bleed children's storybook scene: ${subject}.`,
    "Show two child friends interacting in the exact activity described. Make the action, location and objects obvious so the picture can cue their spoken conversation.",
    "One continuous image only: no panels, no grid, no collage, no comic layout, no border.",
    "No text, no writing, no letters, no subtitles, no labels, no speech bubbles, no signs, no watermark.",
    "Warm natural daylight, friendly expressions, polished painterly realism, age-appropriate and uncluttered.",
    framing,
  ].join("\n\n");
}

async function runIllustrationVariant(job: IllustrationJob, context: string, dialogue: string, variant: number): Promise<void> {
  const directory = path.join(ILLUSTRATION_DIR, job.scenarioKey);
  await mkdir(directory, { recursive: true });
  const promptPath = path.join(directory, `picture-${variant}-prompt.txt`);
  const outputPath = path.join(directory, `picture-${variant}.png`);
  await writeFile(promptPath, illustrationPrompt(visualSubject(context, dialogue), variant), "utf8");
  job.message = `本机模型正在生成第 ${variant}/2 张情景配图…`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(IMAGE_CLI, [
      "--model", IMAGE_MODEL_DIR,
      "--base-model", "qwen-image-2.1",
      "--prompt-file", promptPath,
      "--seed", String(randomInt(0, 1_000_000_000)),
      "--steps", "40",
      "--width", "1024",
      "--height", "768",
      "--guidance", "3",
      "--negative-prompt", "text, writing, letters, subtitles, labels, signs, speech bubbles, comic strip, collage, panels, grid, frames, logos, watermark, blurry, distorted anatomy",
      "--output", outputPath,
      "--low-ram",
    ], {
      cwd: ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.child = child;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (job.child === child) job.child = undefined;
      if (error) reject(error);
      else resolve();
    };
    const onOutput = (chunk: Buffer) => {
      const value = chunk.toString("utf8");
      job.logs = `${job.logs}${value}`.slice(-8000);
      const matches = [...value.matchAll(/(?:^|\D)(\d{1,3})\s*\/\s*(\d{1,3})(?:\D|$)/g)];
      const latest = matches.at(-1);
      if (latest) {
        const step = Number(latest[1]);
        const total = Number(latest[2]);
        if (total > 0 && step <= total) {
          const withinPicture = step / total;
          job.progress = Math.min(99, Math.floor(((variant - 1 + withinPicture) / 2) * 100));
        }
      }
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.once("error", (error) => finish(new Error(`无法启动本地 Qwen Image：${error.message}`)));
    child.once("close", (code, signal) => {
      if (code === 0 && existsSync(outputPath)) finish();
      else finish(new Error(`第 ${variant} 张图片生成失败（${signal ?? code ?? "未知原因"}）。${job.logs.slice(-1600)}`));
    });
  });
  job.completed = variant;
  job.progress = Math.floor((variant / 2) * 100);
}

async function startIllustration(input: unknown): Promise<IllustrationJob> {
  if (!isRecord(input) || typeof input.filePath !== "string" || typeof input.context !== "string" || typeof input.dialogue !== "string") {
    throw new Error("情景配图请求格式不正确。");
  }
  const filePath = input.filePath.trim().replace(/\\~/g, "~");
  const context = input.context.trim();
  const dialogue = input.dialogue.trim();
  const force = input.force === true;
  if (path.extname(filePath).toLowerCase() !== ".md") throw new Error("请先读取 Markdown 练习材料。");
  if (!context || context.length > 600) throw new Error("情景描述需为 1 到 600 个字符。");
  if (!dialogue || dialogue.length > 2400) throw new Error("情景对话需为 1 到 2,400 个字符。");
  if (!isImageModelDirectory(IMAGE_MODEL_DIR)) {
    throw Object.assign(new Error("本机 Qwen Image 模型目录不完整。"), { status: 503 });
  }
  if (!existsSync(IMAGE_CLI)) {
    throw Object.assign(new Error("找不到本地 mflux 图像生成命令。"), { status: 503 });
  }
  if (activeIllustrationJob) throw Object.assign(new Error("另一个情景正在生成配图，请稍后再试。"), { status: 409 });

  const scenarioKey = illustrationKey(filePath, context, dialogue);
  const cachedCount = scenarioImageUrls(scenarioKey).length;
  const job: IllustrationJob = {
    id: randomUUID(),
    scenarioKey,
    state: cachedCount === 2 && !force ? "completed" : "running",
    progress: cachedCount === 2 && !force ? 100 : Math.floor((cachedCount / 2) * 100),
    completed: cachedCount,
    message: cachedCount === 2 && !force ? "已从本机缓存载入两张配图。" : "正在准备本机图像模型…",
    logs: "",
  };
  illustrationJobs.set(job.id, job);
  if (job.state === "completed") return job;
  activeIllustrationJob = job.id;
  void (async () => {
    try {
      for (const variant of [1, 2]) {
        const existingPath = path.join(ILLUSTRATION_DIR, job.scenarioKey, `picture-${variant}.png`);
        if (!force && existsSync(existingPath)) continue;
        await runIllustrationVariant(job, context, dialogue, variant);
      }
      job.state = "completed";
      job.message = "两张情景配图已生成并保存在本机。";
    } catch (error) {
      job.state = "failed";
      job.message = "情景配图生成失败。";
      job.error = error instanceof Error ? error.message : "本机图像生成失败。";
    } finally {
      if (activeIllustrationJob === job.id) activeIllustrationJob = null;
    }
  })();
  return job;
}

async function serveFile(res: ServerResponse, filePath: string, contentType: string): Promise<void> {
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": body.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  } catch {
    json(res, 404, { error: "文件不存在。" });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const route = url.pathname;
  if (req.method === "GET" && route === "/api/config") {
    json(res, 200, {
      modelName: path.basename(MODEL_DIR),
      modelPath: path.relative(ROOT, MODEL_DIR),
      modelReady: await localModelReady(),
      runtimeReady: runtimeReady(),
      pythonPath: path.relative(ROOT, PYTHON),
      outputPath: path.relative(ROOT, AUDIO_DIR),
      illustrationModel: path.basename(IMAGE_MODEL_DIR),
      illustrationReady: isImageModelDirectory(IMAGE_MODEL_DIR) && existsSync(IMAGE_CLI),
    });
    return;
  }
  if (req.method === "GET" && route === "/api/audio-cache/status") {
    const materialKey = url.searchParams.get("materialKey") ?? "";
    if (!/^[a-f0-9]{64}$/.test(materialKey)) {
      json(res, 400, { error: "练习材料标识无效。" });
      return;
    }
    const manifest = await readOfflineManifest(OFFLINE_CACHE_DIR);
    const clipCount = manifest?.clips.filter((clip) => existsSync(offlineClipPath(OFFLINE_CACHE_DIR, clip.id))).length ?? 0;
    const packageComplete = Boolean(manifest?.completedAt && clipCount === manifest.total && manifest.clips.length === manifest.total);
    const job = [...audioCacheJobs.values()].find((candidate) => candidate.state === "running");
    json(res, 200, {
      packageExists: packageComplete,
      matchesMaterial: packageComplete && manifest?.materialKey === materialKey,
      activeMaterialKey: packageComplete ? manifest?.materialKey : undefined,
      profile: packageComplete ? manifest?.profile : undefined,
      total: packageComplete ? manifest?.total : 0,
      cached: packageComplete ? clipCount : 0,
      job: job ? publicAudioCacheJob(job) : undefined,
    });
    return;
  }
  if (req.method === "POST" && route === "/api/audio-cache/jobs") {
    try {
      const job = await startAudioCacheJob(await readJson(req, AUDIO_CACHE_REQUEST_LIMIT));
      json(res, job.state === "completed" ? 200 : 202, publicAudioCacheJob(job));
    } catch (error) {
      const status = isRecord(error) && typeof error.status === "number" ? error.status : 400;
      json(res, status, { error: error instanceof Error ? error.message : "无法开始离线语音缓存。" });
    }
    return;
  }
  const audioCacheJobMatch = /^\/api\/audio-cache\/jobs\/([0-9a-f-]+)$/.exec(route);
  if (req.method === "GET" && audioCacheJobMatch) {
    const job = audioCacheJobs.get(audioCacheJobMatch[1]);
    if (!job) json(res, 404, { error: "找不到这个离线语音缓存任务。" });
    else json(res, 200, publicAudioCacheJob(job));
    return;
  }
  const offlineAudioMatch = /^\/api\/offline-audio\/([a-f0-9]{64})\/([a-z0-9-]{1,160})$/.exec(route);
  if (req.method === "GET" && offlineAudioMatch) {
    const [, materialKey, turnId] = offlineAudioMatch;
    const manifest = await readOfflineManifest(OFFLINE_CACHE_DIR);
    const clip = manifest?.clips.find((candidate) => candidate.id === turnId);
    const authorized = Boolean(
      manifest?.completedAt &&
      manifest.materialKey === materialKey &&
      manifest.clips.length === manifest.total &&
      clip &&
      await offlineClipHash(OFFLINE_CACHE_DIR, turnId) === clip.audioHash &&
      existsSync(offlineClipPath(OFFLINE_CACHE_DIR, turnId))
    );
    if (!authorized) json(res, 404, { error: "没有找到匹配的离线语音。" });
    else await serveFile(res, offlineClipPath(OFFLINE_CACHE_DIR, turnId), "audio/wav");
    return;
  }
  if (req.method === "GET" && route === "/api/scenario-images") {
    const filePath = url.searchParams.get("filePath") ?? "";
    const context = url.searchParams.get("context") ?? "";
    const dialogue = url.searchParams.get("dialogue") ?? "";
    if (!filePath || !context || !dialogue) {
      json(res, 400, { error: "缺少 Markdown 路径、情景描述或对话内容。" });
      return;
    }
    const scenarioKey = illustrationKey(filePath, context, dialogue);
    const activeJob = [...illustrationJobs.values()].find((job) => job.scenarioKey === scenarioKey && job.state === "running");
    json(res, 200, {
      imageUrls: scenarioImageUrls(scenarioKey),
      job: activeJob ? publicIllustrationJob(activeJob) : undefined,
    });
    return;
  }
  if (req.method === "POST" && route === "/api/scenario-images") {
    try {
      const job = await startIllustration(await readJson(req));
      json(res, 202, publicIllustrationJob(job));
    } catch (error) {
      const status = isRecord(error) && typeof error.status === "number" ? error.status : 400;
      json(res, status, { error: error instanceof Error ? error.message : "无法开始生成情景配图。" });
    }
    return;
  }
  const illustrationJobMatch = /^\/api\/scenario-images\/jobs\/([0-9a-f-]+)$/.exec(route);
  if (req.method === "GET" && illustrationJobMatch) {
    const job = illustrationJobs.get(illustrationJobMatch[1]);
    if (!job) json(res, 404, { error: "找不到这个情景配图任务。" });
    else json(res, 200, publicIllustrationJob(job));
    return;
  }
  const illustrationImageMatch = /^\/api\/scenario-images\/([0-9a-f]{32})\/([12])$/.exec(route);
  if (req.method === "GET" && illustrationImageMatch) {
    const imagePath = path.join(ILLUSTRATION_DIR, illustrationImageMatch[1], `picture-${illustrationImageMatch[2]}.png`);
    await serveFile(res, imagePath, "image/png");
    return;
  }
  if (req.method === "POST" && route === "/api/parse") {
    try {
      const input = await readJson(req);
      if (!isRecord(input) || typeof input.path !== "string" || !input.path.trim()) throw new Error("请填写 Markdown 文件的完整路径。");
      const filePath = normalizeMarkdownPath(input.path);
      if (path.extname(filePath).toLowerCase() !== ".md") throw new Error("请选择 .md 文件。");
      const metadata = await stat(filePath);
      if (!metadata.isFile()) throw new Error("指定路径不是文件。");
      if (metadata.size > FILE_LIMIT) throw Object.assign(new Error("Markdown 文件超过 10 MB。"), { status: 413 });
      const markdown = await readFile(filePath, "utf8");
      const sections = parseMarkdown(markdown);
      const itemCount = sections.reduce((sum, section) => sum + section.groups.reduce((n, group) => n + group.turns.length, 0), 0);
      if (!itemCount) throw new Error("没有找到 Part 1 / Phase 1、Part 1 / Phase 2 或 Part 2 中的 Q/A 台词。请检查标题和 Q:/A:/B: 格式。");
      json(res, 200, { filePath, materialKey: materialIdentity(filePath, markdown), sections, itemCount });
    } catch (error) {
      const status = isRecord(error) && typeof error.status === "number" ? error.status : 400;
      json(res, status, { error: error instanceof Error ? error.message : "无法读取 Markdown 文件。" });
    }
    return;
  }
  if (req.method === "POST" && route === "/api/synthesize") {
    try {
      const result = await synthesize(await readJson(req));
      json(res, 200, result);
    } catch (error) {
      const status = isRecord(error) && typeof error.status === "number" ? error.status : 500;
      json(res, status, { error: error instanceof Error ? error.message : "语音合成失败。", logTail: workerLog.slice(-1600) });
    }
    return;
  }
  const audioMatch = /^\/api\/audio\/([0-9a-f-]+)$/.exec(route);
  if (req.method === "GET" && audioMatch) {
    const file = path.join(AUDIO_DIR, `${audioMatch[1]}_000.wav`);
    await serveFile(res, file, "audio/wav");
    return;
  }
  if (req.method === "GET" && route === "/") {
    await serveFile(res, path.join(HERE, "index.html"), "text/html; charset=utf-8");
    return;
  }
  if (req.method === "GET" && route === "/app.ts") {
    await serveFile(res, path.join(HERE, "app.ts"), "text/javascript; charset=utf-8");
    return;
  }
  if (req.method === "GET" && route === "/styles.css") {
    await serveFile(res, path.join(HERE, "styles.css"), "text/css; charset=utf-8");
    return;
  }
  json(res, 404, { error: "页面或接口不存在。" });
});

const port = Number(process.env.TTS_PORT ?? 8788);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("TTS_PORT 需为 1 到 65535 的整数。");
server.listen(port, "127.0.0.1", () => {
  console.log(`Local KET Speech Practice is ready at http://127.0.0.1:${port}`);
  console.log(`Model: ${path.relative(ROOT, MODEL_DIR)}`);
});
