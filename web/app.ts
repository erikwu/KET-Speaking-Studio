// This file stays within TypeScript's JavaScript-compatible syntax so the browser can run it directly.
// @ts-check

/** @typedef {{modelName:string,modelPath:string,modelReady:boolean,cliReady:boolean,maxReferenceImages:number,referenceMode:string}} AppConfig */
/** @typedef {{id:string,state:string,progress:number,message:string,seed:number,error?:string,logTail?:string,imageUrl?:string,downloadUrl?:string}} JobStatus */

/** @type {HTMLFormElement} */
const form = document.querySelector("#generate-form");
/** @type {HTMLInputElement} */
const referenceInput = document.querySelector("#reference-file");
/** @type {HTMLImageElement} */
const referencePreviewImage = document.querySelector("#reference-image");
/** @type {HTMLImageElement} */
const resultImage = document.querySelector("#result-image");
/** @type {HTMLButtonElement} */
const generateButton = document.querySelector("#generate-button");
/** @type {HTMLButtonElement} */
const cancelButton = document.querySelector("#cancel-button");
/** @type {HTMLDivElement} */
const formError = document.querySelector("#form-error");
/** @type {HTMLDivElement} */
const uploadZone = document.querySelector("#upload-zone");
/** @type {HTMLInputElement} */
const guidanceInput = document.querySelector("#guidance");

const $ = (selector) => document.querySelector(selector);
let selectedFile = null;
let currentJobId = null;
let referenceObjectUrl = null;
let pollTimer = null;

function setState(label, state = "idle") {
  const chip = $("#result-state");
  chip.className = `state-chip${state === "running" ? " is-running" : state === "done" ? " is-done" : state === "error" ? " is-error" : ""}`;
  chip.innerHTML = `<i></i> ${label}`;
}

function setError(message) {
  formError.textContent = message;
  formError.classList.toggle("hidden", !message);
}

function showOnly(id) {
  for (const name of ["empty-state", "loading-state", "result-image", "failed-state"]) {
    $(`#${name}`).classList.toggle("hidden", name !== id);
  }
}

async function loadConfig() {
  const response = await fetch("/api/config");
  /** @type {AppConfig} */
  const config = await response.json();
  const name = $("#model-name");
  name.textContent = config.modelName;
  name.title = config.modelPath;
  if (!config.modelReady || !config.cliReady) {
    setError(!config.modelReady ? `模型目录不完整：${config.modelPath}` : "找不到本地 mflux 命令。请确认项目 .venv 已安装 mflux。");
    generateButton.disabled = true;
    setState("模型未就绪", "error");
    $("#empty-state").querySelector("h3").textContent = "模型尚未就绪";
    $("#empty-state").querySelector("p").textContent = "请检查本地模型目录和 mflux 安装。";
    return;
  }
  generateButton.disabled = false;
}

function updatePromptCount() {
  $("#prompt-count").textContent = `${$("#prompt").value.length.toLocaleString()} / 10,000`;
}

function renderReference(file) {
  if (referenceObjectUrl) URL.revokeObjectURL(referenceObjectUrl);
  selectedFile = file;
  if (!file) {
    referencePreviewImage.removeAttribute("src");
    $("#reference-preview").classList.add("hidden");
    $("#upload-zone").classList.remove("hidden");
    $("#strength-row").classList.add("hidden");
    return;
  }
  referenceObjectUrl = URL.createObjectURL(file);
  referencePreviewImage.src = referenceObjectUrl;
  $("#reference-name").textContent = file.name;
  $("#reference-size").textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · ${file.type.replace("image/", "").toUpperCase()}`;
  $("#reference-preview").classList.remove("hidden");
  $("#upload-zone").classList.add("hidden");
  $("#strength-row").classList.remove("hidden");
}

function selectReference(file) {
  if (!file) return;
  const allowed = ["image/png", "image/jpeg", "image/webp"];
  if (!allowed.includes(file.type)) {
    setError("参考图只支持 PNG、JPEG 或 WebP 格式。");
    referenceInput.value = "";
    return;
  }
  if (file.size > 24 * 1024 * 1024) {
    setError("参考图超过 24 MB，请先压缩图片后再上传。");
    referenceInput.value = "";
    return;
  }
  setError("");
  renderReference(file);
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取参考图失败。"));
    reader.readAsDataURL(file);
  });
}

function validateForm() {
  const prompt = $("#prompt").value.trim();
  if (!prompt) throw new Error("请先填写提示词。");
  const steps = Number($("#steps").value);
  if (!Number.isInteger(steps) || steps < 1 || steps > 100) throw new Error("步数需在 1 到 100 之间。");
  for (const id of ["width", "height"]) {
    const value = Number($(`#${id}`).value);
    if (!Number.isInteger(value) || value < 256 || value > 4096 || value % 16 !== 0) {
      throw new Error("宽度和高度需为 256 到 4096 之间、且能被 16 整除的整数。");
    }
  }
  const guidance = Number(guidanceInput.value);
  if (!Number.isFinite(guidance) || guidance < 1 || guidance > 20) throw new Error("Guidance 需在 1 到 20 之间。");
  if (guidance > 1 && !$("#negative-prompt").value.trim()) throw new Error("Guidance 大于 1 时，请填写负面提示词。");
  const seedValue = $("#seed").value;
  const seed = seedValue === "" ? null : Number(seedValue);
  if (seed !== null && (!Number.isInteger(seed) || seed < 0 || seed > 999999999)) throw new Error("Seed 需在 0 到 999,999,999 之间。");
  return { prompt, steps, guidance, seed };
}

function buildPayload(valid) {
  return {
    prompt: valid.prompt,
    negativePrompt: $("#negative-prompt").value,
    seed: valid.seed,
    steps: valid.steps,
    width: Number($("#width").value),
    height: Number($("#height").value),
    guidance: valid.guidance,
    imageStrength: Number($("#image-strength").value),
    lowRam: $("#low-ram").checked,
    vaeTiling: $("#vae-tiling").checked,
    format: $("#format").value,
    referenceImage: selectedFile ? { name: selectedFile.name, type: selectedFile.type, dataUrl: null } : null,
  };
}

function setBusy(busy) {
  generateButton.disabled = busy;
  generateButton.innerHTML = busy
    ? '<span class="button-spark">◌</span><span>正在生成…</span>'
    : '<span class="button-spark">✳</span><span>生成图像</span><span class="button-arrow">↗</span>';
  cancelButton.disabled = !busy;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function followJob(jobId) {
  while (currentJobId === jobId) {
    let response;
    try {
      response = await fetch(`/api/jobs/${jobId}`);
    } catch {
      showFailure("与本地生成服务的连接中断。", "");
      return;
    }
    /** @type {JobStatus} */
    const job = await response.json();
    if (!response.ok) {
      showFailure(job.error ?? "读取任务状态失败。", job.logTail ?? "");
      return;
    }
    if (job.state === "running" || job.state === "cancelling") {
      $("#loading-message").textContent = job.message;
      $("#progress-bar").style.width = `${Math.max(job.progress, 3)}%`;
      $("#progress-label").textContent = job.progress ? "采样中" : "加载模型 / 编码提示词";
      $("#progress-percent").textContent = job.progress ? `${job.progress}%` : "…";
      setState(job.state === "cancelling" ? "正在停止" : "本机生成中", "running");
    } else if (job.state === "completed") {
      currentJobId = null;
      setBusy(false);
      showOnly("result-image");
      resultImage.src = `${job.imageUrl}?v=${Date.now()}`;
      $("#download-button").href = job.downloadUrl;
      $("#result-details").textContent = `Seed ${job.seed} · ${$("#width").value} × ${$("#height").value} · ${$("#format").value.toUpperCase()}`;
      $("#result-footer").classList.remove("hidden");
      $("#loading-state").classList.add("hidden");
      $("#canvas-wrap").style.background = "#f1f0eb";
      setState("生成完成", "done");
      return;
    } else if (job.state === "failed") {
      currentJobId = null;
      setBusy(false);
      showFailure(job.error ?? "生成失败。", job.logTail ?? "");
      return;
    } else if (job.state === "cancelled") {
      currentJobId = null;
      setBusy(false);
      showOnly("empty-state");
      $("#result-footer").classList.add("hidden");
      setState("已停止");
      return;
    }
    await delay(1300);
  }
}

function showFailure(message, log) {
  currentJobId = null;
  setBusy(false);
  showOnly("failed-state");
  $("#failure-message").textContent = message;
  $("#failure-log").textContent = log;
  $("#result-footer").classList.add("hidden");
  setState("生成失败", "error");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("");
  $("#result-footer").classList.add("hidden");
  $("#failure-title").textContent = "生成失败";
  /** @type {{prompt:string,steps:number,guidance:number,seed:number|null}} */
  let valid;
  try {
    valid = validateForm();
  } catch (error) {
    setError(error instanceof Error ? error.message : "请检查输入参数。");
    return;
  }
  setBusy(true);
  showOnly("loading-state");
  $("#loading-title").textContent = "正在准备生成";
  $("#loading-message").textContent = "本机模型正在运行，请稍候。";
  $("#progress-bar").style.width = "3%";
  $("#progress-label").textContent = "加载模型";
  $("#progress-percent").textContent = "…";
  setState("本机生成中", "running");
  try {
    const payload = buildPayload(valid);
    if (selectedFile) payload.referenceImage.dataUrl = await readDataUrl(selectedFile);
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    /** @type {JobStatus} */
    const job = await response.json();
    if (!response.ok) throw new Error(job.error ?? "无法开始生成。");
    currentJobId = job.id;
    await followJob(job.id);
  } catch (error) {
    showFailure(error instanceof Error ? error.message : "无法开始生成。", "");
  }
});

referenceInput.addEventListener("change", () => selectReference(referenceInput.files?.[0] ?? null));
$("#remove-reference").addEventListener("click", () => {
  renderReference(null);
  referenceInput.value = "";
});
$("#prompt").addEventListener("input", updatePromptCount);
$("#image-strength").addEventListener("input", () => {
  $("#strength-value").textContent = Number($("#image-strength").value).toFixed(2);
});
uploadZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  uploadZone.classList.add("drag-over");
});
uploadZone.addEventListener("dragleave", () => uploadZone.classList.remove("drag-over"));
uploadZone.addEventListener("drop", (event) => {
  event.preventDefault();
  uploadZone.classList.remove("drag-over");
  selectReference(event.dataTransfer?.files?.[0] ?? null);
});
cancelButton.addEventListener("click", async () => {
  if (!currentJobId) return;
  cancelButton.disabled = true;
  try {
    await fetch(`/api/jobs/${currentJobId}/cancel`, { method: "POST" });
  } catch {
    $("#loading-message").textContent = "停止请求失败，任务可能仍在运行。";
  }
});
$("#retry-button").addEventListener("click", () => {
  showOnly("empty-state");
  setState("等待输入");
});

loadConfig().catch((error) => {
  setError(error instanceof Error ? error.message : "无法连接本地服务。");
  setState("服务未连接", "error");
});
