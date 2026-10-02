import assert from "node:assert/strict";
import test from "node:test";
import { downmixAndResample, encodeMonoPcmWav } from "./exam-audio.ts";

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
