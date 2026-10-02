// @ts-check

const DEFAULT_MAX_RECORDING_MS = 120_000;
const TARGET_SAMPLE_RATE = 16_000;

/**
 * Downmix channels to mono, then linearly resample to the requested rate.
 * @param {Float32Array[]} channels
 * @param {number} sourceRate
 * @param {number} [targetRate]
 * @returns {Float32Array}
 */
export function downmixAndResample(channels, sourceRate, targetRate = TARGET_SAMPLE_RATE) {
  if (!channels.length || !Number.isFinite(sourceRate) || !Number.isFinite(targetRate) || sourceRate <= 0 || targetRate <= 0) {
    throw new Error("录音采样率或声道无效。");
  }
  const sourceLength = Math.min(...channels.map((channel) => channel.length));
  if (!sourceLength) throw new Error("录音没有有效的音频采样。");
  const outputLength = Math.max(1, Math.round(sourceLength * targetRate / sourceRate));
  const result = new Float32Array(outputLength);
  const sourceSample = (index) => channels.reduce((sum, channel) => sum + channel[index], 0) / channels.length;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * sourceRate / targetRate;
    const lower = Math.min(Math.floor(position), sourceLength - 1);
    const upper = Math.min(lower + 1, sourceLength - 1);
    const fraction = Math.min(1, position - lower);
    result[index] = sourceSample(lower) * (1 - fraction) + sourceSample(upper) * fraction;
  }
  return result;
}

/**
 * Encode mono floating-point samples as 16-bit little-endian PCM WAV.
 * @param {Float32Array} samples
 * @param {number} [sampleRate]
 * @returns {Uint8Array}
 */
export function encodeMonoPcmWav(samples, sampleRate = TARGET_SAMPLE_RATE) {
  if (!(samples instanceof Float32Array) || samples.length === 0) throw new Error("录音没有有效的音频采样。");
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error("WAV 采样率无效。");
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Number.isFinite(samples[index]) ? Math.max(-1, Math.min(1, samples[index])) : 0;
    view.setInt16(44 + index * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return bytes;
}

/**
 * Request microphone access only when the user starts a response. The returned
 * completion promise resolves to a local WAV Blob, or null if the recording is cancelled.
 * @param {{maxDurationMs?:number,onAutoStop?:()=>void}} [options]
 */
export async function startExamRecording({ maxDurationMs = DEFAULT_MAX_RECORDING_MS, onAutoStop } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("此浏览器不支持麦克风录音。");
  if (typeof MediaRecorder === "undefined") throw new Error("此浏览器不支持录音格式转换。");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"]
    .find((candidate) => MediaRecorder.isTypeSupported(candidate));
  /** @type {MediaRecorder} */ let recorder;
  try {
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }

  /** @type {Blob[]} */ const chunks = [];
  /** @type {AudioContext|null} */ let audioContext = null;
  let timer = 0;
  let cancelled = false;
  let settled = false;
  /** @type {(value:Blob|null)=>void} */ let resolveCompletion;
  /** @type {(error:Error)=>void} */ let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const cleanup = async () => {
    window.clearTimeout(timer);
    stream.getTracks().forEach((track) => track.stop());
    if (audioContext && audioContext.state !== "closed") await audioContext.close().catch(() => {});
  };
  const finish = async () => {
    if (settled) return;
    settled = true;
    try {
      if (cancelled) {
        resolveCompletion(null);
        return;
      }
      const recording = new Blob(chunks, { type: recorder.mimeType || "application/octet-stream" });
      if (!recording.size) throw new Error("没有录到音频，请重试。");
      const AudioContextConstructor = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
      if (!AudioContextConstructor) throw new Error("此浏览器不支持音频转换。");
      audioContext = new AudioContextConstructor();
      const decoded = await audioContext.decodeAudioData(await recording.arrayBuffer());
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
      const mono = downmixAndResample(channels, decoded.sampleRate, TARGET_SAMPLE_RATE);
      resolveCompletion(new Blob([encodeMonoPcmWav(mono, TARGET_SAMPLE_RATE)], { type: "audio/wav" }));
    } catch (error) {
      rejectCompletion(error instanceof Error ? error : new Error("录音格式转换失败，请重试。"));
    } finally {
      await cleanup();
    }
  };

  recorder.addEventListener("dataavailable", (event) => { if (event.data?.size) chunks.push(event.data); });
  recorder.addEventListener("stop", () => { void finish(); }, { once: true });
  recorder.addEventListener("error", () => {
    if (settled) return;
    settled = true;
    void cleanup().finally(() => rejectCompletion(new Error("浏览器录音失败，请检查麦克风设备后重试。")));
  }, { once: true });

  const stop = () => {
    window.clearTimeout(timer);
    if (recorder.state === "recording") recorder.stop();
    return completion;
  };
  const cancel = async () => {
    if (settled) return;
    cancelled = true;
    window.clearTimeout(timer);
    if (recorder.state === "recording") recorder.stop();
    else await finish();
    await completion.catch(() => null);
  };

  try {
    recorder.start(250);
  } catch (error) {
    await cleanup();
    throw error;
  }
  timer = window.setTimeout(() => {
    try { onAutoStop?.(); } catch { /* UI callbacks must not interrupt resource cleanup. */ }
    void stop();
  }, Math.max(1, Math.min(maxDurationMs, DEFAULT_MAX_RECORDING_MS)));
  return { completion, stop, cancel };
}
