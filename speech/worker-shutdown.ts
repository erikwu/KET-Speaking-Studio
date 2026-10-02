import type { ChildProcess } from "node:child_process";

type StoppableChild = Pick<ChildProcess, "kill" | "once" | "off" | "exitCode" | "signalCode">;

function waitForClose(child: StoppableChild, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
  });
}

/** Reject queued/in-flight work before asking its worker process to exit. */
export async function stopWorkerProcess(child: StoppableChild | null, rejectPending: (error: Error) => void, graceMs = 2_000): Promise<void> {
  if (!child) return;
  rejectPending(new Error("语音服务正在关闭。"));
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gracefulClose = waitForClose(child, graceMs);
  child.kill("SIGTERM");
  if (await gracefulClose) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const forcedClose = waitForClose(child, graceMs);
  child.kill("SIGKILL");
  await forcedClose;
}
