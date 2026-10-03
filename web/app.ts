// This file stays within TypeScript's JavaScript-compatible syntax so the browser can run it directly.
// @ts-check

/** @typedef {{modelName:string,modelPath:string,modelReady:boolean,cliReady:boolean,maxReferenceImages:number,referenceMode:string,video:{modelName:string,modelPath:string,modelReady:boolean,cliReady:boolean,defaults:{width:number,height:number,frameOptions:number[],numFrames:number,steps:number,guideScale:number,fps:number}}}} AppConfig */
/** @typedef {{id:string,mediaType:"image"|"video",state:string,progress:number,message:string,seed:number,error?:string,logTail?:string,imageUrl?:string,downloadUrl?:string,videoUrl?:string,videoDownloadUrl?:string}} JobStatus */

/** @type {HTMLFormElement} */
const form = document.querySelector("#generate-form");
/** @type {HTMLFormElement} */
const videoForm = document.querySelector("#video-form");
/** @type {HTMLInputElement} */
const referenceInput = document.querySelector("#reference-file");
/** @type {HTMLInputElement} */
const videoReferenceInput = document.querySelector("#video-reference-file");
/** @type {HTMLImageElement} */
const referencePreviewImage = document.querySelector("#reference-image");
/** @type {HTMLImageElement} */
const videoReferencePreviewImage = document.querySelector("#video-reference-image");
/** @type {HTMLImageElement} */
const resultImage = document.querySelector("#result-image");
/** @type {HTMLVideoElement} */
const resultVideo = document.querySelector("#result-video");
/** @type {HTMLButtonElement} */
const generateButton = document.querySelector("#generate-button");
/** @type {HTMLButtonElement} */
const videoGenerateButton = document.querySelector("#video-generate-button");
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
let selectedVideoFile = null;
let currentJobId = null;
let referenceObjectUrl = null;
let videoReferenceObjectUrl = null;
let pollTimer = null;
let imageReady = false;
let videoReady = false;
let isBusy = false;
let activeMode = "image";
let videoFps = 16;
let imageModel = { name: "", path: "" };
let videoModel = { name: "", path: "" };

function updateModelBadge() {
  const model = activeMode === "video" ? videoModel : imageModel;
  if (!model.name) return;
  $("#model-name").textContent = model.name;
  $("#model-name").title = model.path;
}

function setState(label, state = "idle") {
  const chip = $("#result-state");
  chip.className = `state-chip${state === "running" ? " is-running" : state === "done" ? " is-done" : state === "error" ? " is-error" : ""}`;
  chip.innerHTML = `<i></i> ${label}`;
}

function setError(message) {
  formError.textContent = message;
  formError.classList.toggle("hidden", !message);
}

function setVideoError(message) {
  const error = $("#video-form-error");
  error.textContent = message;
  error.classList.toggle("hidden", !message);
}

function showOnly(id) {
  for (const name of ["empty-state", "loading-state", "result-image", "result-video", "failed-state"]) {
    $(`#${name}`).classList.toggle("hidden", name !== id);
  }
  if (id !== "result-image") resultImage.removeAttribute("src");
  if (id !== "result-video") {
    resultVideo.pause();
    resultVideo.removeAttribute("src");
    resultVideo.load();
  }
}

function switchMode(mode) {
  if (isBusy || !["image", "video"].includes(mode)) return;
  activeMode = mode;
  const isVideo = mode === "video";
  $("#image-panel").classList.toggle("hidden", isVideo);
  $("#video-panel").classList.toggle("hidden", !isVideo);
  $("#image-mode-button").classList.toggle("is-active", !isVideo);
  $("#video-mode-button").classList.toggle("is-active", isVideo);
  $("#image-mode-button").setAttribute("aria-pressed", String(!isVideo));
  $("#video-mode-button").setAttribute("aria-pressed", String(isVideo));
  updateModelBadge();
  $("#studio-kicker").classList.toggle("hidden", isVideo);
  $("#studio-kicker").textContent = "MLX · QWEN IMAGE 2.1";
  $("#studio-title").textContent = isVideo ? "让静态画面动起来" : "把想法变成图像";
  $("#studio-subtitle").textContent = isVideo ? "上传一张起始图，描述动作，本机生成一段视频。" : "提示词和参数在本机处理，生成结果保存在当前项目中。";
  $("#model-quantization").textContent = isVideo ? "Q8" : "4-bit";
  setState("等待输入");
}

async function loadConfig() {
  const response = await fetch("/api/config");
  /** @type {AppConfig} */
  const config = await response.json();
  imageModel = { name: config.modelName, path: config.modelPath };
  videoModel = { name: config.video.modelName, path: config.video.modelPath };
  updateModelBadge();
  imageReady = config.modelReady && config.cliReady;
  if (!config.modelReady || !config.cliReady) {
    setError(!config.modelReady ? `模型目录不完整：${config.modelPath}` : "找不到本地 mflux 命令。请确认项目 .venv 已安装 mflux。");
    setState("模型未就绪", "error");
    $("#empty-state").querySelector("h3").textContent = "模型尚未就绪";
    $("#empty-state").querySelector("p").textContent = "请检查本地模型目录和 mflux 安装。";
  } else {
    setError("");
  }
  const defaults = config.video.defaults;
  videoFps = defaults.fps;
  $("#video-output-fps").textContent = `${defaults.fps} fps`;
  $("#video-width").value = String(defaults.width);
  $("#video-height").value = String(defaults.height);
  $("#video-frames").replaceChildren(...defaults.frameOptions.map((frames) => {
    const option = document.createElement("option");
    option.value = String(frames);
    option.textContent = `${frames} 帧 · 约 ${(frames / defaults.fps).toFixed(1)} 秒`;
    return option;
  }));
  $("#video-frames").value = String(defaults.numFrames);
  $("#video-steps").value = String(defaults.steps);
  $("#video-guidance").value = String(defaults.guideScale);
  videoReady = config.video.modelReady && config.video.cliReady;
  const readiness = $("#video-readiness");
  readiness.classList.toggle("is-ready", videoReady);
  readiness.classList.toggle("is-error", !videoReady);
  readiness.textContent = videoReady
    ? `${config.video.modelName} 已就绪 · ${config.video.modelPath} · 本机生成，输出 ${defaults.fps} fps`
    : (!config.video.modelReady
      ? `Wan 模型目录不完整：${config.video.modelPath}`
      : "找不到 Wan 本地 Python 环境：.venv-wan22-mlx/bin/python");
  videoGenerateButton.disabled = !videoReady;
  setBusy(false);
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

function renderVideoReference(file) {
  if (videoReferenceObjectUrl) URL.revokeObjectURL(videoReferenceObjectUrl);
  videoReferenceObjectUrl = null;
  selectedVideoFile = file;
  if (!file) {
    videoReferencePreviewImage.removeAttribute("src");
    $("#video-reference-preview").classList.add("hidden");
    $("#video-upload-zone").classList.remove("hidden");
    return;
  }
  videoReferenceObjectUrl = URL.createObjectURL(file);
  videoReferencePreviewImage.src = videoReferenceObjectUrl;
  $("#video-reference-name").textContent = file.name;
  $("#video-reference-size").textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · ${file.type.replace("image/", "").toUpperCase()}`;
  $("#video-reference-preview").classList.remove("hidden");
  $("#video-upload-zone").classList.add("hidden");
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

function selectVideoReference(file) {
  if (!file) return;
  const allowed = ["image/png", "image/jpeg", "image/webp"];
  if (!allowed.includes(file.type)) {
    setVideoError("起始图只支持 PNG、JPEG 或 WebP 格式。");
    videoReferenceInput.value = "";
    return;
  }
  if (file.size > 24 * 1024 * 1024) {
    setVideoError("起始图超过 24 MB，请先压缩图片后再上传。");
    videoReferenceInput.value = "";
    return;
  }
  setVideoError("");
  renderVideoReference(file);
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

function validateVideoForm() {
  const prompt = $("#video-prompt").value.trim();
  if (!prompt) throw new Error("请先填写提示词。");
  if (prompt.length > 10000) throw new Error("提示词不能超过 10,000 个字符。");
  if (!selectedVideoFile) throw new Error("请先选择一张起始图。");
  if (!["image/png", "image/jpeg", "image/webp"].includes(selectedVideoFile.type)) throw new Error("起始图只支持 PNG、JPEG 或 WebP 格式。");
  if (selectedVideoFile.size > 24 * 1024 * 1024) throw new Error("起始图超过 24 MB，请先压缩图片后再上传。");
  const width = Number($("#video-width").value);
  const height = Number($("#video-height").value);
  for (const [label, value] of [["宽度", width], ["高度", height]]) {
    if (!Number.isInteger(value) || value < 256 || value > 4096 || value % 16 !== 0) {
      throw new Error(`${label}需为 256 到 4096 之间、且能被 16 整除的整数。`);
    }
  }
  const numFrames = Number($("#video-frames").value);
  if (![41, 81, 121].includes(numFrames)) throw new Error("帧数只能选择 41、81 或 121 帧。");
  const steps = Number($("#video-steps").value);
  if (!Number.isInteger(steps) || steps < 1 || steps > 100) throw new Error("步数需在 1 到 100 之间。");
  const guideScale = Number($("#video-guidance").value);
  if (!Number.isFinite(guideScale) || guideScale < 0 || guideScale > 20) throw new Error("Guidance scale 需在 0 到 20 之间。");
  const seedValue = $("#video-seed").value;
  const seed = seedValue === "" ? null : Number(seedValue);
  if (seed !== null && (!Number.isInteger(seed) || seed < 0 || seed > 4294967295)) throw new Error("Seed 需为 0 到 4,294,967,295 之间的整数。");
  const negativePrompt = $("#video-negative-prompt").value;
  if (negativePrompt.length > 5000) throw new Error("负面提示词不能超过 5,000 个字符。");
  return { prompt, negativePrompt, seed, steps, width, height, numFrames, guideScale };
}

async function buildVideoPayload(valid) {
  return {
    ...valid,
    image: { name: selectedVideoFile.name, type: selectedVideoFile.type, dataUrl: await readDataUrl(selectedVideoFile) },
  };
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
  isBusy = busy;
  generateButton.disabled = busy || !imageReady;
  generateButton.innerHTML = busy
    ? '<span class="button-spark">◌</span><span>正在生成…</span>'
    : '<span class="button-spark">✳</span><span>生成图像</span><span class="button-arrow">↗</span>';
  videoGenerateButton.disabled = busy || !videoReady;
  videoGenerateButton.innerHTML = busy && activeMode === "video"
    ? '<span class="button-spark">◌</span><span>正在生成…</span>'
    : '<span class="button-spark">✳</span><span>生成视频</span><span class="button-arrow">↗</span>';
  $("#image-mode-button").disabled = busy;
  $("#video-mode-button").disabled = busy;
  cancelButton.disabled = !busy;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function followJob(jobId) {
  while (currentJobId === jobId) {
    let response;
    /** @type {JobStatus} */
    let job;
    try {
      response = await fetch(`/api/jobs/${jobId}`);
      job = await response.json();
    } catch {
      $("#loading-title").textContent = "与本机服务的连接暂时中断";
      $("#loading-message").textContent = "任务可能仍在本机运行。重新连接查看状态，或尝试停止任务。";
      $("#progress-label").textContent = "等待重新连接";
      $("#progress-percent").textContent = "—";
      $("#retry-poll-button").classList.remove("hidden");
      setState("连接中断", "error");
      return;
    }
    $("#retry-poll-button").classList.add("hidden");
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
      if (job.mediaType === "video") {
        if (!job.videoUrl || !job.videoDownloadUrl) {
          showFailure("视频任务已完成，但找不到视频输出。", job.logTail ?? "");
          return;
        }
        resultImage.removeAttribute("src");
        showOnly("result-video");
        resultVideo.src = `${job.videoUrl}?v=${Date.now()}`;
        $("#download-button").href = job.videoDownloadUrl;
        $("#download-label").textContent = "下载视频";
        $("#download-button").setAttribute("aria-label", "下载生成的 MP4 视频");
        $("#result-details").textContent = `Seed ${job.seed} · ${$("#video-width").value} × ${$("#video-height").value} · ${$("#video-frames").value} 帧 · ${videoFps} fps`;
      } else {
        resultVideo.pause();
        resultVideo.removeAttribute("src");
        resultVideo.load();
        showOnly("result-image");
        resultImage.src = `${job.imageUrl}?v=${Date.now()}`;
        $("#download-button").href = job.downloadUrl;
        $("#download-label").textContent = "下载图像";
        $("#download-button").setAttribute("aria-label", "下载生成的图像");
        $("#result-details").textContent = `Seed ${job.seed} · ${$("#width").value} × ${$("#height").value} · ${$("#format").value.toUpperCase()}`;
      }
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
  $("#retry-poll-button").classList.add("hidden");
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

videoForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setVideoError("");
  $("#result-footer").classList.add("hidden");
  $("#failure-title").textContent = "视频生成失败";
  let valid;
  try {
    valid = validateVideoForm();
  } catch (error) {
    setVideoError(error instanceof Error ? error.message : "请检查视频参数。");
    return;
  }
  setBusy(true);
  showOnly("loading-state");
  $("#retry-poll-button").classList.add("hidden");
  $("#loading-title").textContent = "正在准备视频生成";
  $("#loading-message").textContent = "Wan 模型正在本机运行，请稍候。";
  $("#progress-bar").style.width = "3%";
  $("#progress-label").textContent = "加载模型";
  $("#progress-percent").textContent = "…";
  setState("本机生成中", "running");
  try {
    const payload = await buildVideoPayload(valid);
    const response = await fetch("/api/video/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    /** @type {JobStatus} */
    const job = await response.json();
    if (!response.ok) throw new Error(job.error ?? "无法开始视频生成。");
    currentJobId = job.id;
    await followJob(job.id);
  } catch (error) {
    if (currentJobId) {
      showFailure(error instanceof Error ? error.message : "视频生成失败。", "");
    } else {
      setBusy(false);
      showOnly("empty-state");
      setState("等待输入");
      setVideoError(error instanceof Error ? error.message : "无法开始视频生成。");
    }
  }
});

referenceInput.addEventListener("change", () => selectReference(referenceInput.files?.[0] ?? null));
videoReferenceInput.addEventListener("change", () => selectVideoReference(videoReferenceInput.files?.[0] ?? null));
$("#remove-reference").addEventListener("click", () => {
  renderReference(null);
  referenceInput.value = "";
});
$("#remove-video-reference").addEventListener("click", () => {
  renderVideoReference(null);
  videoReferenceInput.value = "";
});
$("#prompt").addEventListener("input", updatePromptCount);
$("#video-prompt").addEventListener("input", () => {
  $("#video-prompt-count").textContent = `${$("#video-prompt").value.length.toLocaleString()} / 10,000`;
});
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
const videoUploadZone = $("#video-upload-zone");
videoUploadZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  videoUploadZone.classList.add("drag-over");
});
videoUploadZone.addEventListener("dragleave", () => videoUploadZone.classList.remove("drag-over"));
videoUploadZone.addEventListener("drop", (event) => {
  event.preventDefault();
  videoUploadZone.classList.remove("drag-over");
  selectVideoReference(event.dataTransfer?.files?.[0] ?? null);
});
$("#image-mode-button").addEventListener("click", () => switchMode("image"));
$("#video-mode-button").addEventListener("click", () => switchMode("video"));
cancelButton.addEventListener("click", async () => {
  if (!currentJobId) return;
  cancelButton.disabled = true;
  try {
    await fetch(`/api/jobs/${currentJobId}/cancel`, { method: "POST" });
  } catch {
    $("#loading-message").textContent = "停止请求失败，任务可能仍在运行。";
    cancelButton.disabled = false;
  }
});
$("#retry-poll-button").addEventListener("click", async () => {
  if (!currentJobId) return;
  $("#retry-poll-button").classList.add("hidden");
  $("#loading-title").textContent = "正在重新连接";
  $("#loading-message").textContent = "正在读取本机任务状态…";
  setState("正在重新连接", "running");
  await followJob(currentJobId);
});
$("#retry-button").addEventListener("click", () => {
  showOnly("empty-state");
  setState("等待输入");
});

loadConfig().catch((error) => {
  setError(error instanceof Error ? error.message : "无法连接本地服务。");
  $("#video-readiness").classList.add("is-error");
  $("#video-readiness").textContent = "无法读取模型状态，请确认 8787 本机服务正在运行。";
  setVideoError("无法连接本地服务。");
  setState("服务未连接", "error");
});
