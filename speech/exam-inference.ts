import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { Buffer } from "node:buffer";

const MAX_WAV_BYTES = 25 * 1024 * 1024;
const MAX_SCORE_TEXT = 3000;
const MAX_FEEDBACK = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const START_TIMEOUT_MS = 60_000;
const SCORE_DIMENSIONS = ["relevance", "completeness", "grammar", "vocabulary"] as const;

/** @typedef {{question:string,reference:string,transcript:string}} ExamScoreInput */
/** @typedef {{score:number,feedback:string}} ExamDimension */
/** @typedef {{relevance:ExamDimension,completeness:ExamDimension,grammar:ExamDimension,vocabulary:ExamDimension,total:number}} ExamScore */
/** @typedef {{pythonPath:string,workerPath:string,asrModelDir:string,scoringModelDir:string,tempDirectory:string,spawnImpl?:typeof spawn,requestTimeoutMs?:number,env?:NodeJS.ProcessEnv,writeAudioFile?:typeof writeFile}} ExamInferenceOptions */
/** @typedef {{resolve:(value:any)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}} PendingRequest */

/** Validates the exact audio format accepted by the local ASR model. @param {Buffer} wav */
export function validateExamWav(wav: Buffer): void {
  if (!Buffer.isBuffer(wav) || wav.length > MAX_WAV_BYTES) throw new Error("录音文件超过 25 MiB。");
  if (wav.length < 46 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("录音不是有效的 PCM WAV 文件。");
  }
  if (wav.readUInt32LE(4) + 8 !== wav.length) throw new Error("WAV 文件长度信息不匹配。");
  let offset = 12;
  let format: { encoding:number; channels:number; sampleRate:number; byteRate:number; blockAlign:number; bits:number } | null = null;
  let dataBytes = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const contentStart = offset + 8;
    const contentEnd = contentStart + size;
    if (contentEnd > wav.length) throw new Error("WAV 文件包含截断的数据块。");
    if (id === "fmt ") {
      if (size < 16) throw new Error("WAV 音频格式区段无效。");
      format = {
        encoding: wav.readUInt16LE(contentStart),
        channels: wav.readUInt16LE(contentStart + 2),
        sampleRate: wav.readUInt32LE(contentStart + 4),
        byteRate: wav.readUInt32LE(contentStart + 8),
        blockAlign: wav.readUInt16LE(contentStart + 12),
        bits: wav.readUInt16LE(contentStart + 14),
      };
    } else if (id === "data") {
      dataBytes = size;
    }
    offset = contentEnd + (size % 2);
  }
  if (!format || format.encoding !== 1 || format.channels !== 1 || format.sampleRate !== 16_000 || format.byteRate !== 32_000 || format.blockAlign !== 2 || format.bits !== 16) {
    throw new Error("录音必须是 16 kHz、单声道、16-bit PCM WAV。");
  }
  if (dataBytes < 2 || dataBytes % 2 !== 0) throw new Error("WAV 文件不包含有效的 PCM 录音数据。");
}

/** Validate worker output and calculate the total locally. @param {unknown} value @returns {ExamScore} */
export function validateExamScore(value: unknown): ExamScore {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("本机评分结果格式无效。");
  const record = /** @type {Record<string,unknown>} */ (value);
  if (Object.keys(record).length !== SCORE_DIMENSIONS.length || SCORE_DIMENSIONS.some((key) => !(key in record))) throw new Error("本机评分结果缺少必要维度。");
  /** @type {Record<string, ExamDimension>} */ const dimensions = {};
  for (const name of SCORE_DIMENSIONS) {
    const dimension = record[name];
    if (typeof dimension !== "object" || dimension === null || Array.isArray(dimension)) throw new Error("本机评分维度格式无效。");
    const fields = /** @type {Record<string,unknown>} */ (dimension);
    if (Object.keys(fields).length !== 2 || !Number.isInteger(fields.score) || Number(fields.score) < 0 || Number(fields.score) > 5) throw new Error("本机评分超出 0 到 5 分范围。");
    if (typeof fields.feedback !== "string" || !fields.feedback.trim() || fields.feedback.length > MAX_FEEDBACK || !/[\u3400-\u9fff]/.test(fields.feedback)) throw new Error("本机评分建议不是有效的中文反馈。");
    dimensions[name] = { score: Number(fields.score), feedback: fields.feedback.trim() };
  }
  return { ...dimensions, total: SCORE_DIMENSIONS.reduce((sum, name) => sum + dimensions[name]!.score, 0) };
}

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A dedicated worker process and bounded temp-file lifecycle for local exam inference.
 * @param {ExamInferenceOptions} options
 */
export function createExamInference(options: ExamInferenceOptions) {
  const spawnChild = options.spawnImpl ?? spawn;
  const writeAudioFile = options.writeAudioFile ?? writeFile;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pending = new Map<string, PendingRequest>();
  let child: ChildProcess | null = null;
  let readyPromise: Promise<void> | null = null;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let disposed = false;

  const clearChild = (candidate: ChildProcess) => {
    if (child === candidate) {
      child = null;
      readyPromise = null;
      stdoutBuffer = "";
      stderrBuffer = "";
    }
  };

  const failChild = (candidate: ChildProcess, error: Error) => {
    if (child !== candidate) return;
    readyReject?.(error);
    readyResolve = null;
    readyReject = null;
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(error);
      pending.delete(id);
    }
    clearChild(candidate);
  };

  const processLine = (line: string) => {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) return;
      message = parsed;
    } catch {
      return;
    }
    if (message.type === "ready") {
      readyResolve?.();
      readyResolve = null;
      readyReject = null;
      return;
    }
    if (typeof message.id !== "string") return;
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.ok === true) request.resolve(message.result);
    else request.reject(new Error(request.kind === "score" ? "本机语义评分失败，可保留转写后重试评分。" : "本机语音识别失败，请重新录音。"));
  };

  const ensureWorker = async () => {
    if (disposed) throw new Error("模拟考推理服务已经关闭。");
    if (child && readyPromise) return readyPromise;
    stdoutBuffer = "";
    stderrBuffer = "";
    const pythonUnbuffered = /python/i.test(options.pythonPath) ? ["-u"] : [];
    const candidate = spawnChild(options.pythonPath, [
      ...pythonUnbuffered, options.workerPath,
      "--asr-model", options.asrModelDir,
      "--scoring-model", options.scoringModelDir,
    ], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(options.env ?? {}), PYTHONUNBUFFERED: "1" } });
    child = candidate;
    let startupTimer: ReturnType<typeof setTimeout>;
    const started = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
      startupTimer = setTimeout(() => {
        const error = new Error("本机考试模型 worker 启动超时。");
        failChild(candidate, error);
        candidate.kill("SIGTERM");
      }, START_TIMEOUT_MS);
      candidate.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      candidate.stderr?.on("data", (chunk: Buffer) => { stderrBuffer = `${stderrBuffer}${chunk.toString("utf8")}`.slice(-2048); });
      candidate.once("error", (error) => failChild(candidate, new Error(`无法启动本机考试 worker：${error.message}`)));
      candidate.once("close", (code, signal) => {
        if (child === candidate) failChild(candidate, new Error(`本机考试 worker 已退出（${signal ?? code ?? "未知原因"}）。`));
      });
    });
    readyPromise = started;
    started.then(() => clearTimeout(startupTimer), () => clearTimeout(startupTimer));
    return started;
  };

  const request = async (body: Record<string, unknown>): Promise<unknown> => {
    await ensureWorker();
    const active = child;
    if (!active?.stdin) throw new Error("本机考试 worker 尚未准备好。");
    const id = randomUUID();
    const message = { ...body, id };
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error("本机模型推理超时，请重试。");
        failChild(active, error);
        active.kill("SIGTERM");
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, kind: String(body.type ?? "") });
      active.stdin!.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        const current = pending.get(id);
        if (!current) return;
        clearTimeout(current.timer);
        pending.delete(id);
        current.reject(new Error("无法向本机考试 worker 发送请求。"));
        failChild(active, new Error("本机考试 worker 通信失败。"));
        active.kill("SIGTERM");
      });
    });
    return response;
  };

  return {
    /** @param {Buffer} wav */
    async transcribe(wav: Buffer): Promise<{ transcript: string }> {
      validateExamWav(wav);
      await mkdir(options.tempDirectory, { recursive: true });
      const audioPath = `${options.tempDirectory}/exam-${randomUUID()}.wav`;
      try {
        await writeAudioFile(audioPath, wav, { flag: "wx", mode: 0o600 });
        const result = await request({ type: "transcribe", audioPath });
        if (!isRecord(result) || typeof result.transcript !== "string" || !result.transcript.trim()) throw new Error("本机没有识别到清晰的英文回答，请重新录音。");
        return { transcript: result.transcript.trim() };
      } finally {
        await rm(audioPath, { force: true });
      }
    },
    /** @param {ExamScoreInput} input */
    async score(input: ExamScoreInput): Promise<ExamScore> {
      for (const [name, value] of Object.entries(input)) {
        if (typeof value !== "string" || !value.trim() || value.length > MAX_SCORE_TEXT) throw new Error(`${name} 需要填写 1 到 ${MAX_SCORE_TEXT} 个字符。`);
      }
      const result = await request({ type: "score", ...input });
      return validateExamScore(result);
    },
    async dispose(): Promise<void> {
      disposed = true;
      const active = child;
      if (!active) return;
      failChild(active, new Error("模拟考推理服务已关闭。"));
      active.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (active.exitCode !== null || active.signalCode !== null) return resolve();
        const timer = setTimeout(() => resolve(), 2_000);
        active.once("close", () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}
