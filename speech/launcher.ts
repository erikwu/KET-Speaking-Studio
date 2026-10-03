import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAppUpdater, type UpdateInfo } from "./app-update.ts";
import { stopWorkerProcess } from "./worker-shutdown.ts";

export type UpdateState = { phase: "idle" | "checking" | "available" | "current" | "updating" | "restarting" | "recovering" | "done" | "error"; message: string; info?: UpdateInfo };
/** A stable parent process survives replacement of the code and its HTTP child. */
export async function startManagedApp({ root, repository, readinessTimeoutMs = 60_000, stdio = "inherit", env = process.env }: {
  root: string; repository?: string; readinessTimeoutMs?: number; stdio?: "inherit" | "ignore"; env?: NodeJS.ProcessEnv;
}) {
  const updater = createAppUpdater({ root, repository });
  let child: ChildProcess | null = null, closing = false, operating = false;
  let capabilities: Record<string, boolean> = {};
  let state: UpdateState = { phase: "idle", message: "点击检查 GitHub 最新版本。" };
  function publish(next: UpdateState) {
    state = next;
    if (child?.connected) child.send({ type: "ket-update-state", state }, () => {});
  }
  async function stopChild() {
    const active = child; child = null;
    await stopWorkerProcess(active, () => {});
  }
  function launch(): Promise<void> {
    if (closing) return Promise.reject(new Error("服务正在关闭。"));
    return new Promise((resolve, reject) => {
      const candidate = spawn(process.execPath, ["--experimental-strip-types", path.join(root, "speech/server.ts")], {
        cwd: root, env: { ...env, KET_MANAGED_SERVER: "1", KET_UPDATE_MAINTENANCE: operating ? "1" : "0" }, stdio: [stdio, stdio, stdio, "ipc"],
      });
      child = candidate; let ready = false;
      const timer = setTimeout(() => { reject(new Error("新版服务启动超时。")); }, readinessTimeoutMs);
      candidate.once("error", error => { clearTimeout(timer); reject(error); });
      candidate.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (!ready) reject(new Error(`服务启动失败（${signal ?? code}）。`));
        else if (child === candidate && !closing) {
          child = null;
          publish({ phase: "error", message: `服务意外退出（${signal ?? code}），请重新运行 install.command。` });
          console.error(state.message);
        }
      });
      candidate.on("message", async (message: any) => {
        if (child !== candidate || !message || typeof message !== "object") return;
        if (message.type === "ket-ready" && !ready) {
          ready = true; clearTimeout(timer); capabilities = message.capabilities ?? {}; publish(state); resolve(); return;
        }
        if (message.type !== "ket-update-request" || typeof message.id !== "string") return;
        const reply = (value: unknown, error?: string) => { if (candidate.connected) candidate.send({ type: "ket-update-response", id: message.id, value, error }, () => {}); };
        try {
          if (message.action === "status") reply(state);
          else if (message.action === "check") reply(await check());
          else if (message.action === "apply") {
            const info = reserveUpdate(message.target);
            // Acknowledge before shutdown; the browser observes progress by reconnecting.
            reply({ accepted: true });
            setImmediate(() => { void performUpdate(info).catch(error => { publish({ phase: "error", message: String(error) }); }); });
          } else throw new Error("不支持的更新操作。");
        } catch (error) { reply(null, error instanceof Error ? error.message : "更新操作失败。"); }
      });
    });
  }
  async function check() {
    if (operating) throw new Error("正在检查或安装更新，请稍后重试。");
    operating = true; publish({ phase: "checking", message: "正在连接 GitHub，检查最新版本…" });
    try {
      const info = await updater.check();
      publish({ phase: info.available ? "available" : "current", message: info.available ? "发现新版本，可以更新并重启。" : "当前已是最新版本。", info });
      return info;
    } catch (error) {
      publish({ phase: "error", message: error instanceof Error ? error.message : "检查更新失败。" }); throw error;
    } finally { operating = false; }
  }
  function reserveUpdate(target: string): UpdateInfo {
    if (operating || !state.info?.available || state.info.target !== target) throw new Error("请先检查更新。");
    operating = true;
    const info = state.info;
    publish({ phase: "updating", message: "正在备份并安装更新，页面会短暂断开…", info });
    return info;
  }
  async function update(target: string) { await performUpdate(reserveUpdate(target)); }
  async function performUpdate(info: UpdateInfo) {
    const target = info.target, previousCapabilities = { ...capabilities };
    let committed = false;
    try {
      // Keep the maintenance-only HTTP child available to report installation progress.
      await updater.apply(target);
      publish({ phase: "restarting", message: "更新已安装，正在重启并检查服务…", info });
      await stopChild();
      await launch();
      publish({ phase: "recovering", message: "服务已恢复连接，正在验证功能和运行状态…", info });
      const replacement = child;
      // Let immediate post-ready failures arrive before declaring the replacement healthy.
      await new Promise(resolve => setTimeout(resolve, 150));
      const assertAlive = () => { if (!replacement || child !== replacement || replacement.exitCode !== null || replacement.signalCode !== null) throw new Error("新版服务在启动检查后退出。"); };
      assertAlive();
      for (const [name, wasReady] of Object.entries(previousCapabilities)) {
        if (wasReady && !capabilities[name]) throw new Error("新版所需运行环境尚未就绪，请重新运行 install.command 更新依赖。");
      }
      await updater.commit();
      committed = true;
      assertAlive();
      publish({ phase: "done", message: "更新完成，服务已重新启动。", info: { ...info, current: target, available: false } });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "更新失败。";
      try {
        await stopChild(); await updater.rollback(committed);
        await launch();
        publish({ phase: "error", message: `更新未完成，已恢复原版本。${reason}` });
      } catch (recoveryError) {
        publish({ phase: "error", message: `自动恢复未完成，请保留 outputs/app-updates 中的备份并重新运行 install.command。${String(recoveryError)}` });
        console.error(state.message);
      }
    } finally { operating = false; }
  }
  try { await updater.recover(); await launch(); }
  catch (error) { await stopChild(); throw error; }
  return { check, update, state: () => state, pid: () => child?.pid, async stop() { closing = true; await stopChild(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const app = await startManagedApp({ root });
    const stop = () => { void app.stop().then(() => process.exit(0)); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
