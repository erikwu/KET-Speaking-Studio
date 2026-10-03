// @ts-check

/** Reconcile a disconnected POST: shutdown may happen before its response reaches the browser. */
export async function applyAndWaitForUpdate({ submit, readState, target, onState, pause = () => new Promise(resolve => setTimeout(resolve, 1500)), timeoutMs = 180_000 }) {
  try { await submit(); }
  catch (error) { if (error && typeof error === "object" && "httpStatus" in error) throw error; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await pause();
    let state;
    try { state = await readState(); }
    catch { onState({ phase: "reconnecting", message: "服务暂时断开，正在等待重启和恢复连接…" }); continue; }
    onState(state);
    if (state.phase === "done" && state.info?.current === target) return state;
    if (state.phase === "error") throw new Error(state.message);
  }
  throw new Error("尚未连接到重启后的服务。请查看启动终端；备份保留在 outputs/app-updates。请勿重复安装。");
}

/** @param {{isExamActive:()=>boolean}} options */
export function installUpdateControls({ isExamActive }) {
  const button = /** @type {HTMLButtonElement} */ (document.querySelector("#check-update"));
  const panel = /** @type {HTMLElement} */ (document.querySelector("#update-panel"));
  const message = /** @type {HTMLElement} */ (document.querySelector("#update-message"));
  const notes = /** @type {HTMLElement} */ (document.querySelector("#update-notes"));
  const install = /** @type {HTMLButtonElement} */ (document.querySelector("#install-update"));
  const close = /** @type {HTMLButtonElement} */ (document.querySelector("#close-update"));
  const progress = /** @type {HTMLProgressElement} */ (document.querySelector("#update-progress"));
  const clientId = crypto.randomUUID();
  let token = "", managed = false, target = "", applying = false, checking = false;
  let lastState = { phase: "idle", message: "点击检查 GitHub 最新版本。" }, generation = 0, polling = false;
  const busyPhases = ["checking", "updating", "restarting", "reconnecting", "recovering"];

  async function status() {
    const response = await fetch("/api/update", { cache: "no-store", signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error("无法读取更新状态，请稍后再试。");
    const state = await response.json(); token = state.token; managed = state.managed;
    return state;
  }
  async function post(route, input, keepalive = false) {
    const response = await fetch(route, {
      method: "POST", headers: { "content-type": "application/json", "x-ket-update-token": token },
      body: JSON.stringify(input), keepalive, signal: keepalive ? undefined : AbortSignal.timeout(155000),
    });
    const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error ?? "更新操作失败。"), { httpStatus: response.status });
    return value;
  }
  function render(state) {
    lastState = state;
    const busy = busyPhases.includes(state.phase);
    message.textContent = state.message;
    message.classList.toggle("update-error", state.phase === "error");
    progress.hidden = !busy; button.disabled = busy || applying || checking;
    button.setAttribute("aria-busy", String(busy || applying || checking));
    button.title = state.message;
    close.disabled = applying;
    notes.textContent = state.info?.notes ?? "";
    notes.hidden = !notes.textContent;
    target = state.info?.target ?? "";
    install.hidden = !(managed && state.info?.available && state.phase === "available");
    install.disabled = busy || applying || checking;
    button.textContent = ({
      idle: "检查更新", checking: "检查中…", available: "发现新版本", current: "已是最新",
      updating: "更新中…", restarting: "更新完成 · 重启中", reconnecting: "等待服务恢复…", recovering: "服务恢复中…",
      done: "更新完成 · 已恢复", error: "操作失败 · 重试",
    })[state.phase] ?? "检查更新";
  }
  function error(value) { render({ phase: "error", message: value instanceof Error ? value.message : "更新操作失败，请重试。" }); }
  button.addEventListener("click", async () => {
    if (checking || applying || busyPhases.includes(lastState.phase)) return;
    checking = true; generation++;
    panel.hidden = false; render({ phase: "checking", message: "正在检查 GitHub 最新版本…" });
    try {
      const current = await status();
      if (!managed || busyPhases.includes(current.phase)) return render(current);
      await post("/api/update/check", {}); render(await status());
    } catch (e) { error(e); }
    finally { checking = false; render(lastState); }
  });
  close.addEventListener("click", () => { panel.hidden = true; button.focus(); });
  install.addEventListener("click", async () => {
    if (checking || applying || busyPhases.includes(lastState.phase) || !target) return;
    if (isExamActive()) return error(new Error("请先结束模拟考并保存结果，再更新服务。"));
    const requestedTarget = target;
    applying = true; generation++; render({ phase: "updating", message: "正在安装更新，完成后页面会自动刷新…" });
    const main = document.querySelector("main"); if (main) main.inert = true;
    try {
      await applyAndWaitForUpdate({ submit: () => post("/api/update/apply", { target: requestedTarget }), readState: status, target: requestedTarget, onState: render });
      location.reload();
    } catch (e) { applying = false; error(e); }
    finally { applying = false; if (main) main.inert = false; render(lastState); }
  });
  async function lease(active, keepalive = false) {
    if (!token) await status();
    if (!managed) return;
    await post("/api/update/lease", { clientId, active }, keepalive);
  }
  const heartbeat = setInterval(() => { if (isExamActive()) void lease(true).catch(() => {}); }, 10_000);
  // Other tabs follow the same launcher state and cannot start a concurrent operation.
  const monitor = setInterval(async () => {
    if (checking || applying || polling) return;
    polling = true; const startedAt = generation;
    try {
      const state = await status();
      if (startedAt !== generation) return;
      if (busyPhases.includes(state.phase)) panel.hidden = false;
      render(state);
    } catch {
      if (startedAt === generation && busyPhases.includes(lastState.phase)) {
        render({ phase: "reconnecting", message: "服务暂时断开，正在等待恢复连接…" });
      }
    }
    finally { polling = false; }
  }, 1500);
  window.addEventListener("pagehide", () => { clearInterval(heartbeat); clearInterval(monitor); if (token && managed) void lease(false, true).catch(() => {}); }, { once: true });
  // Local status only; GitHub is contacted solely after clicking Check updates.
  void status().then(state => {
    if (generation) return;
    if (state.phase === "error" || state.phase === "done" || busyPhases.includes(state.phase)) panel.hidden = false;
    render(state);
  }).catch(() => {});
  return { reserveExam: () => lease(true), releaseExam: () => { if (token) void lease(false).catch(() => {}); } };
}
