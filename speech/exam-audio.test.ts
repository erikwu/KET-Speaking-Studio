import assert from "node:assert/strict";
import test from "node:test";
import { downmixAndResample, encodeMonoPcmWav, startExamRecording } from "./exam-audio.ts";

test("downmixAndResample_convertsStereoTo16000HzMono", () => {
  const left = Float32Array.from([0.5, 0.25, -0.5, -0.25]);
  const right = Float32Array.from([0.5, -0.25, -0.5, 0.25]);
  const mono = downmixAndResample([left, right], 4, 2);
  assert.deepEqual([...mono], [0.5, -0.5]);
});

test("encodeMonoPcmWav_writesPcm16LeHeaderAndSamples", () => {
  const wav = encodeMonoPcmWav(Float32Array.from([-1.2, 0.5, 1.2]), 16000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(wav.slice(8, 12)), "WAVE");
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(46, true), 16383);
  assert.equal(view.getInt16(48, true), 32767);
});

test("encodeMonoPcmWav_rejectsEmptyInput", () => {
  assert.throws(() => encodeMonoPcmWav(new Float32Array()));
});

test("startExamRecording_releasesMicrophoneWhenCancelledDuringDecode", async () => {
  const prior = Object.fromEntries(["navigator", "window", "MediaRecorder"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let tracksStopped = 0;
  let contextClosed = 0;
  let decodeStarted = false;
  let resolveDecode;
  let session;
  const decodePromise = new Promise((resolve) => { resolveDecode = resolve; });
  const track = { stop() { tracksStopped += 1; } };
  const stream = { getTracks: () => [track] };
  class FakeMediaRecorder {
    static isTypeSupported() { return true; }
    constructor() { this.mimeType = "audio/webm"; this.state = "inactive"; this.listeners = new Map(); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.listeners.get("dataavailable")?.({ data: new Blob(["audio"], { type: this.mimeType }) });
      this.listeners.get("stop")?.();
    }
  }
  const fakeWindow = {
    setTimeout: () => 1,
    clearTimeout: () => {},
    AudioContext: class {
      state = "running";
      decodeAudioData() { decodeStarted = true; return decodePromise; }
      close() { this.state = "closed"; contextClosed += 1; return Promise.resolve(); }
    },
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeMediaRecorder });

  try {
    session = await startExamRecording();
    const stopping = session.stop();
    while (!decodeStarted) await new Promise((resolve) => setImmediate(resolve));
    await session.cancel();
    assert.equal(tracksStopped, 1);
    assert.equal(contextClosed, 1);
    resolveDecode({ numberOfChannels: 1, sampleRate: 16_000, getChannelData: () => Float32Array.of(0.25) });
    assert.equal(await stopping, null);
  } finally {
    resolveDecode?.({ numberOfChannels: 1, sampleRate: 16_000, getChannelData: () => Float32Array.of(0.25) });
    await session?.completion.catch(() => {});
    for (const [key, descriptor] of Object.entries(prior)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
