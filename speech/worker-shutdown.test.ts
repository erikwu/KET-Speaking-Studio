import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { stopWorkerProcess } from "./worker-shutdown.ts";

test("stopWorkerProcess_rejectsPendingWorkBeforeTerminatingChild", async () => {
  const calls: string[] = [];
  const child = new EventEmitter() as EventEmitter & { exitCode: number | null; signalCode: NodeJS.Signals | null; kill: (signal: string) => boolean };
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    calls.push(`kill:${signal}`);
    setImmediate(() => { child.exitCode = 0; child.emit("close", 0, null); });
    return true;
  };
  await stopWorkerProcess(child, (error) => {
    assert.match(error.message, /服务正在关闭/);
    calls.push("reject-pending");
  }, 20);
  assert.deepEqual(calls, ["reject-pending", "kill:SIGTERM"]);
});

test("stopWorkerProcess_ignoresMissingChild", () => {
  let called = false;
  stopWorkerProcess(null, () => { called = true; });
  assert.equal(called, false);
});

test("stopWorkerProcess_escalatesToForceKillAfterGracePeriod", async () => {
  const signals: string[] = [];
  const child = new EventEmitter() as EventEmitter & { exitCode: number | null; signalCode: NodeJS.Signals | null; kill: (signal: string) => boolean };
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => { signals.push(signal); return true; };
  await stopWorkerProcess(child, () => {}, 5);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});
