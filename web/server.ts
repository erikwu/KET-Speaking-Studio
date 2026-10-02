import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JobState = "queued" | "running" | "completed" | "failed" | "cancelling" | "cancelled";
type ImageMime = "image/png" | "image/jpeg" | "image/webp";
type OutputFormat = "png" | "webp" | "tiff";
type MediaType = "image" | "video";

interface ReferenceImageInput {
  name?: string;
  type: ImageMime;
  dataUrl: string;
}

interface GenerateInput {
  prompt: string;
  negativePrompt?: string;
  seed?: number | null;
  steps: number;
  width: number;
  height: number;
  guidance: number;
  imageStrength: number;
  lowRam: boolean;
  vaeTiling: boolean;
  format: OutputFormat;
  referenceImage?: ReferenceImageInput | null;
}

interface VideoGenerateInput {
  prompt: string;
  negativePrompt?: string;
  image: ReferenceImageInput;
  seed?: number | null;
  steps: number;
  width: number;
  height: number;
  numFrames: 41 | 81 | 121;
  guideScale: number;
}

interface Job {
  id: string;
  mediaType: MediaType;
  state: JobState;
  progress: number;
  message: string;
  seed: number;
  outputPath: string;
  error?: string;
  logs: string;
  child?: ChildProcess;
}

const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(WEB_DIR, "..");
const OUTPUT_DIR = path.join(ROOT_DIR, "outputs", "web-ui");
const PYTHON_CLI = process.env.MFLUX_CLI_PATH
  ? path.resolve(ROOT_DIR, process.env.MFLUX_CLI_PATH)
  : path.join(ROOT_DIR, ".venv", "bin", "mflux-generate-qwen-2.1");
const baseModel = path.join(ROOT_DIR, "models", "Qwen-Image-2.1-MLX-4bit");
const hereticModel = path.join(ROOT_DIR, "models", "Qwen-Image-2.1-MLX-4bit-Heretic");
const wanModel = path.join(ROOT_DIR, "models", "Wan2.2-TI2V-5B-MLX-Q8");
const wanPython = path.join(ROOT_DIR, ".venv-wan22-mlx", "bin", "python");

function isWanModelDirectory(candidate: string): boolean {
  return ["config.json", "model.safetensors", "t5_encoder.safetensors", "vae.safetensors"]
    .every((file) => existsSync(path.join(candidate, file)));
}

function isModelDirectory(candidate: string): boolean {
  return (
    existsSync(path.join(candidate, "vae", "model.safetensors.index.json")) &&
    existsSync(path.join(candidate, "transformer", "model.safetensors.index.json")) &&
    existsSync(path.join(candidate, "text_encoder", "model.safetensors.index.json")) &&
    existsSync(path.join(candidate, "processor", "tokenizer.json"))
  );
}

const configuredModel = process.env.MFLUX_MODEL_PATH
  ? path.resolve(ROOT_DIR, process.env.MFLUX_MODEL_PATH)
  : isModelDirectory(hereticModel)
    ? hereticModel
    : baseModel;

const jobs = new Map<string, Job>();
let activeJobId: string | null = null;
const JSON_LIMIT = 34 * 1024 * 1024;
const IMAGE_LIMIT = 24 * 1024 * 1024;

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

function readJson(req: IncomingMessage, maxBytes = JSON_LIMIT): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("请求内容过大。单张图片请控制在 24 MB 以内。"), { status: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("请求内容不是有效的 JSON。"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateInput(value: unknown): GenerateInput {
  if (!isRecord(value)) throw new Error("表单数据格式不正确。");
  const input = value as unknown as GenerateInput;
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    throw new Error("请先填写提示词。");
  }
  if (input.prompt.length > 10000) throw new Error("提示词不能超过 10,000 个字符。");
  if (typeof input.negativePrompt !== "string" || input.negativePrompt.length > 5000) {
    throw new Error("负面提示词不能超过 5,000 个字符。");
  }
  if (!Number.isInteger(input.steps) || input.steps < 1 || input.steps > 100) {
    throw new Error("步数需在 1 到 100 之间。");
  }
  for (const [label, dimension] of [["宽度", input.width], ["高度", input.height]] as const) {
    if (!Number.isInteger(dimension) || dimension < 256 || dimension > 4096 || dimension % 16 !== 0) {
      throw new Error(`${label}需为 256 到 4096 之间、且能被 16 整除的整数。`);
    }
  }
  if (!Number.isFinite(input.guidance) || input.guidance < 1 || input.guidance > 20) {
    throw new Error("Guidance 需在 1 到 20 之间。");
  }
  if (input.guidance > 1 && !input.negativePrompt.trim()) {
    throw new Error("Guidance 大于 1 时，请填写负面提示词；该模型只有在负面提示词非空时才会启用 CFG。");
  }
  if (!Number.isFinite(input.imageStrength) || input.imageStrength < 0 || input.imageStrength > 1) {
    throw new Error("参考图影响强度需在 0 到 1 之间。");
  }
  if (input.seed !== null && input.seed !== undefined && (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 999999999)) {
    throw new Error("Seed 需在 0 到 999,999,999 之间，留空可随机生成。");
  }
  if (!["png", "webp", "tiff"].includes(input.format)) throw new Error("输出格式需为 PNG、WebP 或 TIFF。");
  if (typeof input.lowRam !== "boolean" || typeof input.vaeTiling !== "boolean") {
    throw new Error("内存选项格式不正确。");
  }
  if (input.referenceImage !== null && input.referenceImage !== undefined) {
    const image = input.referenceImage;
    if (!isRecord(image) || !["image/png", "image/jpeg", "image/webp"].includes(String(image.type))) {
      throw new Error("参考图只支持 PNG、JPEG 或 WebP。");
    }
    if (typeof image.dataUrl !== "string") throw new Error("参考图数据无效。");
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image.dataUrl);
    if (!match || match[1] !== image.type) throw new Error("参考图编码无效，请重新选择图片。");
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length === 0 || bytes.length > IMAGE_LIMIT) throw new Error("参考图大小需小于 24 MB。");
    if (!isSupportedImage(bytes, image.type)) throw new Error("图片内容与文件格式不匹配，请换一张 PNG、JPEG 或 WebP 图片。");
  }
  return input;
}

function validateVideoInput(value: unknown): VideoGenerateInput {
  if (!isRecord(value)) throw new Error("表单数据格式不正确。");
  const input = value as unknown as VideoGenerateInput;
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    throw new Error("请先填写提示词。");
  }
  if (input.prompt.length > 10000) throw new Error("提示词不能超过 10,000 个字符。");
  if (input.negativePrompt !== undefined && (typeof input.negativePrompt !== "string" || input.negativePrompt.length > 5000)) {
    throw new Error("负面提示词不能超过 5,000 个字符。");
  }
  if (!isRecord(input.image) || !["image/png", "image/jpeg", "image/webp"].includes(String(input.image.type))) {
    throw new Error("图生视频只支持 PNG、JPEG 或 WebP 图片。");
  }
  const image = input.image as unknown as ReferenceImageInput;
  if (typeof image.dataUrl !== "string") throw new Error("参考图数据无效。");
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image.dataUrl);
  if (!match || match[1] !== image.type) throw new Error("参考图编码无效，请重新选择图片。");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0 || bytes.length > IMAGE_LIMIT) throw new Error("参考图大小需控制在 24 MB 以内。");
  if (!isSupportedImage(bytes, image.type)) throw new Error("图片内容与文件格式不匹配，请换一张 PNG、JPEG 或 WebP 图片。");
  if (!Number.isInteger(input.steps) || input.steps < 1 || input.steps > 100) {
    throw new Error("步数需在 1 到 100 之间。");
  }
  for (const [label, dimension] of [["宽度", input.width], ["高度", input.height]] as const) {
    if (!Number.isInteger(dimension) || dimension < 256 || dimension > 4096 || dimension % 32 !== 0) {
      throw new Error(`${label}需为 256 到 4096 之间、且能被 32 整除的整数。`);
    }
  }
  if (![41, 81, 121].includes(input.numFrames)) throw new Error("帧数只能选择 41、81 或 121 帧。");
  if (!Number.isFinite(input.guideScale) || input.guideScale < 0 || input.guideScale > 20) {
    throw new Error("Guidance scale 需在 0 到 20 之间。");
  }
  if (input.seed !== null && input.seed !== undefined && (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 4294967295)) {
    throw new Error("Seed 需为 0 到 4,294,967,295 之间的整数，留空可随机生成。");
  }
  return input;
}

function isSupportedImage(bytes: Buffer, mime: ImageMime): boolean {
  if (mime === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
}

function decodeImage(image: ReferenceImageInput): Buffer {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image.dataUrl);
  if (!match) throw new Error("参考图编码无效。");
  return Buffer.from(match[2], "base64");
}

function publicJob(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    mediaType: job.mediaType,
    state: job.state,
    progress: job.progress,
    message: job.message,
    seed: job.seed,
    error: job.error,
    logTail: job.logs.slice(-2400),
    imageUrl: job.state === "completed" && job.mediaType === "image" ? `/api/jobs/${job.id}/image` : undefined,
    downloadUrl: job.state === "completed" && job.mediaType === "image" ? `/api/jobs/${job.id}/image?download=1` : undefined,
    videoUrl: job.state === "completed" && job.mediaType === "video" ? `/api/jobs/${job.id}/video` : undefined,
    videoDownloadUrl: job.state === "completed" && job.mediaType === "video" ? `/api/jobs/${job.id}/video?download=1` : undefined,
  };
}

function appendOutput(job: Job, chunk: Buffer): void {
  const value = chunk.toString("utf8");
  job.logs = (job.logs + value).slice(-12000);
  const candidates = [...value.matchAll(/(?:^|\D)(\d{1,3})\s*\/\s*(\d{1,3})(?:\D|$)/g)];
  const latest = candidates.at(-1);
  if (latest) {
    const step = Number(latest[1]);
    const total = Number(latest[2]);
    if (total > 0 && step <= total) job.progress = Math.min(98, Math.floor((step / total) * 100));
  }
}

function watchJobProcess(job: Job, child: ChildProcess, startErrorHint: string): void {
  let finalized = false;
  const releaseLock = () => {
    if (activeJobId === job.id) activeJobId = null;
  };
  const failToStart = (error: Error) => {
    if (finalized) return;
    finalized = true;
    job.state = "failed";
    job.message = "无法启动本机生成程序。";
    job.error = `${error.message}。${startErrorHint}`;
    job.child = undefined;
    releaseLock();
  };
  child.stdout?.on("data", (chunk: Buffer) => appendOutput(job, chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendOutput(job, chunk));
  child.on("error", failToStart);
  child.on("close", (code, signal) => {
    if (finalized) return;
    finalized = true;
    job.child = undefined;
    releaseLock();
    if (job.state === "cancelling" || signal === "SIGTERM" || signal === "SIGINT") {
      job.state = "cancelled";
      job.message = "已停止生成。";
      return;
    }
    if (code === 0 && existsSync(job.outputPath)) {
      job.state = "completed";
      job.progress = 100;
      job.message = job.mediaType === "video" ? "视频已生成。" : "图片已生成。";
      return;
    }
    job.state = "failed";
    job.message = "生成失败。";
    const cleanTail = job.logs.replace(/\u001b\[[0-9;]*m/g, "").trim();
    job.error = cleanTail.slice(-1800) || `生成程序退出，状态码 ${code ?? "未知"}。`;
  });
}

async function launchJob(input: GenerateInput): Promise<Job> {
  const id = randomUUID();
  const seed = input.seed ?? randomInt(0, 1_000_000_000);
  const jobDir = path.join(OUTPUT_DIR, id);
  await mkdir(jobDir, { recursive: true });
  const promptPath = path.join(jobDir, "prompt.txt");
  const outputPath = path.join(jobDir, `result.${input.format}`);
  await writeFile(promptPath, input.prompt, "utf8");

  const args = [
    "--model", configuredModel,
    "--base-model", "qwen-image-2.1",
    "--prompt-file", promptPath,
    "--seed", String(seed),
    "--steps", String(input.steps),
    "--width", String(input.width),
    "--height", String(input.height),
    "--guidance", String(input.guidance),
    "--negative-prompt", input.negativePrompt,
    "--output", outputPath,
  ];
  if (input.referenceImage) {
    const extension = input.referenceImage.type === "image/jpeg" ? "jpg" : input.referenceImage.type === "image/webp" ? "webp" : "png";
    const referencePath = path.join(jobDir, `reference.${extension}`);
    await writeFile(referencePath, decodeImage(input.referenceImage));
    args.push("--image", referencePath, String(input.imageStrength));
  }
  if (input.lowRam) args.push("--low-ram");
  if (input.vaeTiling && !input.lowRam) args.push("--vae-tiling");

  const job: Job = {
    id,
    mediaType: "image",
    state: "running",
    progress: 0,
    message: "模型正在加载，首次生成可能需要更久。",
    seed,
    outputPath,
    logs: "",
  };
  jobs.set(id, job);
  activeJobId = id;

  try {
    const child = spawn(PYTHON_CLI, args, {
      cwd: ROOT_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.child = child;
    watchJobProcess(job, child, "请检查 .venv/bin/mflux-generate-qwen-2.1 是否存在。");
  } catch (error) {
    jobs.delete(id);
    if (activeJobId === id) activeJobId = null;
    throw error;
  }
  return job;
}

async function launchVideoJob(input: VideoGenerateInput): Promise<Job> {
  const id = randomUUID();
  const seed = input.seed ?? randomInt(0, 0x1_0000_0000);
  const jobDir = path.join(OUTPUT_DIR, id);
  await mkdir(jobDir, { recursive: true });
  const imageExtension = input.image.type === "image/jpeg" ? "jpg" : input.image.type === "image/webp" ? "webp" : "png";
  const imagePath = path.join(jobDir, `reference.${imageExtension}`);
  const promptPath = path.join(jobDir, "prompt.txt");
  const outputPath = path.join(jobDir, "result.mp4");
  await Promise.all([
    writeFile(promptPath, input.prompt, "utf8"),
    writeFile(imagePath, decodeImage(input.image)),
  ]);
  const args = [
    "-m", "mlx_video.models.wan_2.generate",
    "--model-dir", wanModel,
    "--image", imagePath,
    "--prompt", input.prompt,
    "--width", String(input.width),
    "--height", String(input.height),
    "--num-frames", String(input.numFrames),
    "--steps", String(input.steps),
    "--guide-scale", String(input.guideScale),
    "--seed", String(seed),
    "--output-path", outputPath,
  ];
  if (input.negativePrompt?.trim()) args.push("--negative-prompt", input.negativePrompt);

  const job: Job = {
    id,
    mediaType: "video",
    state: "running",
    progress: 0,
    message: "Wan 模型正在加载，首次生成可能需要更久。",
    seed,
    outputPath,
    logs: "",
  };
  jobs.set(id, job);
  activeJobId = id;

  try {
    const child = spawn(wanPython, args, {
      cwd: ROOT_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.child = child;
    watchJobProcess(job, child, "请检查 .venv-wan22-mlx/bin/python 和 mlx-video 安装。");
  } catch (error) {
    jobs.delete(id);
    if (activeJobId === id) activeJobId = null;
    throw error;
  }
  return job;
}

async function serveFile(res: ServerResponse, filePath: string, contentType: string): Promise<void> {
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": content.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(content);
  } catch {
    json(res, 404, { error: "文件不存在。" });
  }
}

function handleImage(req: IncomingMessage, res: ServerResponse, job: Job): void {
  if (job.state !== "completed" || !existsSync(job.outputPath)) {
    json(res, 409, { error: "图片尚未生成完成。" });
    return;
  }
  const format = path.extname(job.outputPath).slice(1).toLowerCase();
  const type = format === "webp" ? "image/webp" : format === "tiff" ? "image/tiff" : "image/png";
  const disposition = new URL(req.url ?? "/", "http://localhost").searchParams.has("download") ? "attachment" : "inline";
  readFile(job.outputPath).then((content) => {
    res.writeHead(200, {
      "content-type": type,
      "content-length": content.length,
      "content-disposition": `${disposition}; filename="qwen-image-${job.id}.${format}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(content);
  }).catch(() => json(res, 404, { error: "图片文件不存在。" }));
}

async function handleVideo(req: IncomingMessage, res: ServerResponse, job: Job): Promise<void> {
  if (job.mediaType !== "video") {
    json(res, 404, { error: "这个任务没有视频输出。" });
    return;
  }
  if (job.state !== "completed") {
    json(res, 409, { error: "视频尚未生成完成。" });
    return;
  }

  let size: number;
  try {
    const details = await stat(job.outputPath);
    if (!details.isFile() || details.size <= 0) throw new Error("输出文件不可用。");
    size = details.size;
  } catch {
    json(res, 404, { error: "视频文件不存在。" });
    return;
  }

  const rangeHeader = req.headers.range;
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes" });
      res.end();
      return;
    }
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        res.writeHead(416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes" });
        res.end();
        return;
      }
      start = Math.max(0, size - suffixLength);
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
      res.writeHead(416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes" });
      res.end();
      return;
    }
    end = Math.min(end, size - 1);
    status = 206;
  }

  const disposition = new URL(req.url ?? "/", "http://localhost").searchParams.has("download") ? "attachment" : "inline";
  const headers: Record<string, string | number> = {
    "content-type": "video/mp4",
    "content-length": end - start + 1,
    "content-disposition": `${disposition}; filename="wan-video-${job.id}.mp4"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
  };
  if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${size}`;

  const stream = createReadStream(job.outputPath, { start, end });
  stream.on("error", () => {
    if (!res.headersSent) json(res, 404, { error: "视频文件不存在。" });
    else res.destroy();
  });
  res.writeHead(status, headers);
  stream.pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const route = url.pathname;

  if (req.method === "GET" && route === "/api/config") {
    json(res, 200, {
      modelName: path.basename(configuredModel),
      modelPath: path.relative(ROOT_DIR, configuredModel),
      modelReady: isModelDirectory(configuredModel),
      cliReady: existsSync(PYTHON_CLI),
      maxReferenceImages: 1,
      referenceMode: "img2img",
      video: {
        modelName: path.basename(wanModel),
        modelPath: path.relative(ROOT_DIR, wanModel),
        modelReady: isWanModelDirectory(wanModel),
        cliReady: existsSync(wanPython),
        defaults: {
          width: 1280,
          height: 704,
          frameOptions: [41, 81, 121],
          numFrames: 41,
          steps: 20,
          guideScale: 5.0,
          fps: 24,
        },
      },
    });
    return;
  }

  if (req.method === "POST" && route === "/api/generate") {
    if (!isModelDirectory(configuredModel)) {
      json(res, 503, { error: `模型目录不完整：${path.relative(ROOT_DIR, configuredModel)}` });
      return;
    }
    if (!existsSync(PYTHON_CLI)) {
      json(res, 503, { error: "找不到本地 mflux 命令：.venv/bin/mflux-generate-qwen-2.1" });
      return;
    }
    if (activeJobId) {
      json(res, 409, { error: "已有生成任务正在运行，请等它完成或先停止任务。" });
      return;
    }
    activeJobId = "preparing";
    try {
      const contentType = String(req.headers["content-type"] ?? "");
      if (!contentType.includes("application/json")) {
        activeJobId = null;
        json(res, 415, { error: "请求需使用 application/json。" });
        return;
      }
      const input = validateInput(await readJson(req));
      const job = await launchJob(input);
      json(res, 202, publicJob(job));
    } catch (error) {
      if (activeJobId === "preparing") activeJobId = null;
      const status = isRecord(error) && typeof error.status === "number" ? error.status : 400;
      json(res, status, { error: error instanceof Error ? error.message : "无法开始生成。" });
    }
    return;
  }

  if (req.method === "POST" && route === "/api/video/generate") {
    if (!isWanModelDirectory(wanModel)) {
      json(res, 503, { error: `Wan 模型目录不完整：${path.relative(ROOT_DIR, wanModel)}` });
      return;
    }
    if (!existsSync(wanPython)) {
      json(res, 503, { error: "找不到 Wan 本地 Python 环境：.venv-wan22-mlx/bin/python" });
      return;
    }
    if (activeJobId) {
      json(res, 409, { error: "已有生成任务正在运行，请等它完成或先停止任务。" });
      return;
    }
    activeJobId = "preparing";
    try {
      const contentType = String(req.headers["content-type"] ?? "");
      if (!contentType.includes("application/json")) {
        activeJobId = null;
        json(res, 415, { error: "请求需使用 application/json。" });
        return;
      }
      const input = validateVideoInput(await readJson(req));
      const job = await launchVideoJob(input);
      json(res, 202, publicJob(job));
    } catch (error) {
      if (activeJobId === "preparing") activeJobId = null;
      const status = isRecord(error) && typeof error.status === "number" ? error.status : 400;
      json(res, status, { error: error instanceof Error ? error.message : "无法开始视频生成。" });
    }
    return;
  }

  const jobMatch = /^\/api\/jobs\/([0-9a-f-]+)(?:\/(image|video|cancel))?$/.exec(route);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) {
      json(res, 404, { error: "找不到这个生成任务。" });
      return;
    }
    if (jobMatch[2] === "image" && req.method === "GET") {
      handleImage(req, res, job);
      return;
    }
    if (jobMatch[2] === "video" && req.method === "GET") {
      await handleVideo(req, res, job);
      return;
    }
    if (jobMatch[2] === "cancel" && req.method === "POST") {
      if (job.state === "running" && job.child) {
        job.state = "cancelling";
        job.message = "正在停止生成…";
        job.child.kill("SIGTERM");
      }
      json(res, 200, publicJob(job));
      return;
    }
    if (!jobMatch[2] && req.method === "GET") {
      json(res, 200, publicJob(job));
      return;
    }
    json(res, 405, { error: "不支持的请求方法。" });
    return;
  }

  if (req.method === "GET" && route === "/") {
    await serveFile(res, path.join(WEB_DIR, "index.html"), "text/html; charset=utf-8");
    return;
  }
  if (req.method === "GET" && route === "/app.ts") {
    await serveFile(res, path.join(WEB_DIR, "app.ts"), "text/javascript; charset=utf-8");
    return;
  }
  if (req.method === "GET" && route === "/styles.css") {
    await serveFile(res, path.join(WEB_DIR, "styles.css"), "text/css; charset=utf-8");
    return;
  }

  json(res, 404, { error: "页面或接口不存在。" });
});

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT 需为 1 到 65535 的整数。");
server.listen(port, "127.0.0.1", () => {
  console.log(`Qwen Image Studio is ready at http://127.0.0.1:${port}`);
  console.log(`Model: ${path.relative(ROOT_DIR, configuredModel)}`);
  console.log(`Saved images: ${path.relative(ROOT_DIR, OUTPUT_DIR)}`);
});
