// @ts-check
import { getCacheActionState, resolvePlaybackMode } from "./cache-action-state.ts";
import { installExamController, shouldContinueExamPlayback } from "./exam-controller.ts";
import { installUpdateControls } from "./update-controls.ts";

/** @typedef {{id:string,role:"Q"|"A"|"B",voiceRole:"question"|"answer",text:string,translation:string}} Turn */
/** @typedef {{id:string,number:number,context:string,turns:Turn[]}} Group */
/** @typedef {{id:"phase1"|"phase2"|"part2",title:string,groups:Group[]}} Section */
/** @typedef {{filePath:string,materialKey:string,sections:Section[],itemCount:number}} ParsedFile */

const TAGS = {
  voice: [
    { id: "clear", label: "清晰自然", prompt: "speaking clearly with natural English pronunciation" },
    { id: "male", label: "男声", prompt: "a male voice" },
    { id: "female", label: "女声", prompt: "a female voice" },
    { id: "bright", label: "明亮活泼", prompt: "a bright, lively voice" },
    { id: "youthful", label: "年轻童声", prompt: "a youthful, childlike voice" },
    { id: "warm", label: "温暖亲切", prompt: "a warm, friendly voice" },
    { id: "gentle", label: "温柔柔和", prompt: "a gentle, soft-spoken voice" },
    { id: "playful", label: "轻快俏皮", prompt: "a light, playful voice" },
    { id: "calm", label: "平静沉稳", prompt: "a calm, composed voice" },
    { id: "slow", label: "慢速清晰", prompt: "speaking slowly and clearly" },
  ],
  question: [
    { id: "curious", label: "好奇友好", prompt: "curious and friendly" },
    { id: "rising", label: "句尾微微上扬", prompt: "with a gentle rising intonation at the end" },
    { id: "polite", label: "礼貌自然", prompt: "polite and natural" },
    { id: "excited", label: "兴奋期待", prompt: "excited and eager" },
    { id: "gentle", label: "温和耐心", prompt: "gentle and patient" },
    { id: "surprised", label: "带一点惊讶", prompt: "slightly surprised" },
    { id: "calm", label: "平静清楚", prompt: "calm and clear" },
    { id: "conversational", label: "像日常对话", prompt: "conversational and natural" },
  ],
  answer: [
    { id: "warm", label: "温暖亲切", prompt: "warm" },
    { id: "clear", label: "清晰自信", prompt: "clear and confident" },
    { id: "young-learner", label: "像年轻学习者", prompt: "like a young learner answering" },
    { id: "test-style", label: "口语考试回答", prompt: "like a speaking test response" },
    { id: "cheerful", label: "开心轻松", prompt: "cheerful and relaxed" },
    { id: "thoughtful", label: "认真思考", prompt: "thoughtful, as if considering the answer" },
    { id: "shy", label: "害羞轻声", prompt: "shy and soft-spoken" },
    { id: "enthusiastic", label: "热情积极", prompt: "enthusiastic and upbeat" },
    { id: "natural-pace", label: "语速适中", prompt: "at a natural pace" },
  ],
};
const DEFAULTS = {
  voice: ["clear", "bright", "youthful"],
  question: ["curious", "rising"],
  answer: ["warm", "clear", "young-learner", "test-style"],
};
const EXCLUSIVE_VOICE_TAGS = new Set(["male", "female"]);
const SETTINGS_KEY = "ket-speaking-mlx-settings-v1";
const PLAYBACK_MODE_KEY = "ket-speaking-mlx-playback-mode-v1";
const $ = (selector) => document.querySelector(selector);
const pathInput = /** @type {HTMLInputElement} */ $("#file-path");
const loadButton = /** @type {HTMLButtonElement} */ $("#load-file");
const tabs = /** @type {HTMLElement} */ $("#section-tabs");
const list = /** @type {HTMLElement} */ $("#practice-list");
const player = /** @type {HTMLAudioElement} */ $("#audio-player");
let sections = /** @type {Section[]} */ ([]);
let activeSection = "phase1";
let modelAvailable = false;
let examAvailability = { available: false, reason: "正在检查本机考试能力…" };
let examController = null;
let updateControls = null;
let playbackWaiter = null;
let illustrationAvailable = false;
let archiveToolsAvailable = false;
let illustrationModelName = "Qwen Image";
let audioCurrent = null;
let currentObjectUrl = "";
const audioCache = new Map();
let loadedFilePath = "";
let materialKey = "";
let cachePollToken = 0;
let materialLoadToken = 0;
let cachedPackageExists = false;
let playbackRequestToken = 0;
let activePlaybackToken = 0;
let playbackMode = localStorage.getItem(PLAYBACK_MODE_KEY) === "offline-first" ? "offline-first" : "realtime";
/** @type {HTMLSelectElement} */ $("#playback-mode").value = playbackMode;

function setError(message) {
  const box = $("#page-error");
  box.textContent = message;
  box.classList.toggle("hidden", !message);
}

function cancelPlaybackWait(message = "朗读已取消。") {
  if (!playbackWaiter) return;
  const waiter = playbackWaiter;
  playbackWaiter = null;
  waiter.reject(new Error(message));
}

function invalidatePlayback() {
  cancelPlaybackWait("练习材料已切换，朗读已停止。");
  playbackRequestToken += 1;
  activePlaybackToken = 0;
  player.pause();
  player.onended = null;
  player.onerror = null;
  player.removeAttribute("src");
  player.load();
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = "";
  audioCurrent = null;
  return playbackRequestToken;
}

function isCurrentPlayback(token, requestedMaterialKey) {
  return token === playbackRequestToken && requestedMaterialKey === materialKey;
}

function readSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    return Object.fromEntries(Object.keys(TAGS).map((group) => {
      const allowed = new Set(TAGS[group].map((tag) => tag.id));
      const stored = Array.isArray(saved[group]) ? saved[group] : DEFAULTS[group];
      return [group, stored.filter((id) => allowed.has(id))];
    }));
  } catch {
    return Object.fromEntries(Object.entries(DEFAULTS).map(([group, ids]) => [group, [...ids]]));
  }
}

let settings = readSettings();

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function renderTagGroup(group) {
  const container = $(`#${group}-tags`);
  container.replaceChildren();
  for (const tag of TAGS[group]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tag-choice${settings[group].includes(tag.id) ? " selected" : ""}`;
    button.dataset.tagId = tag.id;
    button.setAttribute("aria-pressed", String(settings[group].includes(tag.id)));
    button.textContent = tag.label;
    button.addEventListener("click", () => {
      if (settings[group].includes(tag.id)) {
        settings[group] = settings[group].filter((id) => id !== tag.id);
      } else if (group === "voice" && EXCLUSIVE_VOICE_TAGS.has(tag.id)) {
        settings[group] = [...settings[group].filter((id) => !EXCLUSIVE_VOICE_TAGS.has(id)), tag.id];
      } else {
        settings[group] = [...settings[group], tag.id];
      }
      saveSettings();
      renderTagGroup(group);
    });
    container.append(button);
  }
}

function renderSettings() {
  for (const group of Object.keys(TAGS)) renderTagGroup(group);
}

function installSettings() {
  renderSettings();
  $("#reset-settings").addEventListener("click", () => {
    settings = Object.fromEntries(Object.entries(DEFAULTS).map(([group, ids]) => [group, [...ids]]));
    saveSettings();
    renderSettings();
  });
}

async function loadConfig() {
  const response = await fetch("/api/config");
  const config = await response.json();
  const version = $("#app-version");
  version.textContent = config.appVersion && config.appVersion !== "unknown" ? `v${config.appVersion}` : "版本未知";
  version.title = `当前服务版本：${config.appVersion ?? "未知"}`;
  modelAvailable = Boolean(config.speechAvailable ?? (config.modelReady && config.runtimeReady));
  for (const selector of ["#material-options", "#voice-options"]) {
    const panel = /** @type {HTMLDetailsElement} */ $(selector);
    if (!panel.dataset.initialized) {
      panel.open = modelAvailable;
      panel.dataset.initialized = "true";
    }
  }
  const missingExamCapabilities = [];
  if (!config.asrModelReady) missingExamCapabilities.push("Whisper 英语识别模型");
  if (!config.asrRuntimeReady) missingExamCapabilities.push("mlx-whisper 与 FFmpeg 运行环境");
  if (!config.scoringModelReady) missingExamCapabilities.push("Qwen3 本机评分模型");
  if (!config.scoringRuntimeReady) missingExamCapabilities.push("mlx-lm 评分运行环境");
  examAvailability = {
    available: Boolean(config.examAvailable),
    reason: `模拟考暂不可用：缺少${missingExamCapabilities.join("、") || "本机考试运行环境"}。请运行 install.command 完成安装。`,
  };
  examController?.refreshAvailability();
  illustrationAvailable = Boolean(config.imageAvailable ?? config.illustrationReady);
  archiveToolsAvailable = Boolean(config.archiveToolsReady);
  illustrationModelName = config.illustrationModel || illustrationModelName;
  $("#model-name").textContent = config.modelPath;
  const status = $("#model-status");
  status.classList.remove("status-warn", "status-ready");
  if (!modelAvailable && !illustrationAvailable) {
    status.textContent = "无本地模型 · 可导入离线资源";
    status.classList.add("status-warn");
  } else if (!modelAvailable) {
    status.textContent = "语音模型未就绪 · 可用离线语音";
    status.classList.add("status-warn");
  } else if (!illustrationAvailable) {
    status.textContent = "语音模型已就绪 · 图片生成不可用";
    status.classList.add("status-warn");
  } else {
    status.textContent = "语音与图片模型已就绪";
    status.classList.add("status-ready");
  }
  const playbackSelect = /** @type {HTMLSelectElement} */ $("#playback-mode");
  playbackSelect.disabled = !modelAvailable;
  playbackMode = resolvePlaybackMode(playbackMode, modelAvailable);
  playbackSelect.value = playbackMode;
  playbackSelect.querySelector('option[value="offline-first"]').textContent = modelAvailable ? "离线优先，缺失时实时合成" : "离线优先";
  if (!modelAvailable) {
    $("#playback-mode-note").textContent = "优先播放已导入的离线语音；缺少时请导入包含该语音的资源包。本机没有语音模型，无法实时合成；音色和语气标签不会影响离线语音。";
  } else {
    $("#playback-mode-note").textContent = "缓存任务在后台逐句生成，可继续练习。离线语音使用生成时保存的音色；重新生成完成后才会替换旧缓存。";
  }
  const importButton = /** @type {HTMLButtonElement} */ $("#import-bundle");
  importButton.disabled = !archiveToolsAvailable;
  $("#bundle-status").textContent = archiveToolsAvailable
    ? "导入包含材料、语音和已有配图的资源包；导出仅在离线语音完整时开放。"
    : "本机缺少 zip/unzip 工具，暂时无法导入或导出资源包。";
}

function renderTabs() {
  tabs.replaceChildren();
  for (const section of sections) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tab${activeSection === section.id ? " active" : ""}`;
    button.setAttribute("aria-current", activeSection === section.id ? "page" : "false");
    const count = section.groups.reduce((total, group) => total + group.turns.length, 0);
    button.textContent = `${section.title} · ${count}`;
    button.addEventListener("click", () => {
      activeSection = section.id;
      renderTabs();
      renderGroups();
    });
    tabs.append(button);
  }
  const selectedTab = tabs.querySelector(".tab.active");
  if (selectedTab) {
    const tabBarBounds = tabs.getBoundingClientRect();
    const selectedBounds = selectedTab.getBoundingClientRect();
    if (selectedBounds.right > tabBarBounds.right) tabs.scrollLeft += selectedBounds.right - tabBarBounds.right;
    else if (selectedBounds.left < tabBarBounds.left) tabs.scrollLeft -= tabBarBounds.left - selectedBounds.left;
  }
}

function makeTurnCard(turn) {
  const card = document.createElement("article");
  card.className = "turn-card";
  const head = document.createElement("div");
  head.className = "turn-head";
  const role = document.createElement("span");
  role.className = `role-badge ${turn.voiceRole}`;
  role.textContent = turn.role === "Q" ? "Q · QUESTION" : turn.role === "A" ? "A · SPEAKER A" : "B · SPEAKER B";
  const speak = document.createElement("button");
  speak.type = "button";
  speak.className = "speak-button";
  speak.dataset.turnId = turn.id;
  speak.dataset.text = turn.text;
  speak.dataset.voiceRole = turn.voiceRole;
  speak.innerHTML = '<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M4.25 2.85a.7.7 0 0 1 1.05-.6l8.1 4.65a1.26 1.26 0 0 1 0 2.2l-8.1 4.65a.7.7 0 0 1-1.05-.6V2.85Z"/></svg><span>朗读</span>';
  head.append(role, speak);
  const text = document.createElement("p");
  text.className = "turn-text";
  text.textContent = turn.text;
  card.append(head, text);
  if (turn.translation) {
    const translation = document.createElement("p");
    translation.className = "translation";
    translation.textContent = turn.translation;
    card.append(translation);
  }
  return card;
}

function renderGroups() {
  list.replaceChildren();
  const section = sections.find((item) => item.id === activeSection);
  if (!section) return;
  for (const group of section.groups) {
    const groupNode = document.createElement("article");
    groupNode.className = "question-group";
    const title = document.createElement("div");
    title.className = "group-title";
    const number = document.createElement("span");
    number.className = "group-number";
    number.textContent = String(group.number).padStart(2, "0");
    const context = document.createElement("h3");
    context.textContent = group.context || (section.id === "part2" ? "Conversation" : `Question set ${group.number}`);
    title.append(number, context);
    groupNode.append(title);
    if (section.id === "part2") groupNode.append(makeScenarioIllustration(group));
    for (const turn of group.turns) groupNode.append(makeTurnCard(turn));
    list.append(groupNode);
  }
}

function renderScenarioImages(gallery, imageUrls, refresh = false) {
  const currentUrls = [...gallery.querySelectorAll("img")].map((image) => image.dataset.url);
  if (!refresh && JSON.stringify(currentUrls) === JSON.stringify(imageUrls)) return;
  gallery.replaceChildren();
  for (const [index, imageUrl] of imageUrls.entries()) {
    const figure = document.createElement("figure");
    figure.className = "scenario-picture";
    const image = document.createElement("img");
    image.src = `${imageUrl}?v=${Date.now()}`;
    image.alt = `情景配图 ${index + 1}`;
    image.loading = "lazy";
    image.dataset.url = imageUrl;
    const caption = document.createElement("figcaption");
    caption.textContent = `配图 ${index + 1}`;
    figure.append(image, caption);
    gallery.append(figure);
  }
}

async function loadScenarioImages(panel, context, dialogue) {
  const gallery = panel.querySelector(".scenario-gallery");
  const status = panel.querySelector(".scenario-image-status");
  const button = panel.querySelector(".scenario-generate");
  const query = new URLSearchParams({ filePath: pathInput.value.trim(), context, dialogue });
  try {
    const response = await fetch(`/api/scenario-images?${query}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "读取配图失败。");
    renderScenarioImages(gallery, result.imageUrls ?? []);
    button.dataset.cached = String(result.imageUrls?.length === 2);
    button.textContent = button.dataset.cached === "true" ? "重新生成两张配图" : "生成两张配图";
    status.textContent = result.imageUrls?.length === 2
      ? "两张配图已从本机缓存载入，可直接练习"
      : result.imageUrls?.length
        ? illustrationAvailable ? `已缓存 ${result.imageUrls.length} 张，点击补全` : `已缓存 ${result.imageUrls.length} 张；图片模型未就绪，不能补全`
        : illustrationAvailable ? "点击按钮生成两张情景配图" : "没有已缓存配图；本机图片模型未就绪，无法生成";
    if (result.job?.state === "running") {
      button.disabled = true;
      await followScenarioImageJob(panel, result.job);
    }
  } catch {
    status.textContent = "暂时无法读取配图";
  }
}

async function followScenarioImageJob(panel, initialJob) {
  const button = panel.querySelector(".scenario-generate");
  const status = panel.querySelector(".scenario-image-status");
  const gallery = panel.querySelector(".scenario-gallery");
  let job = initialJob;
  while (job.state === "running") {
    status.textContent = `${job.message} ${job.progress ? `(${job.progress}%)` : ""}`;
    renderScenarioImages(gallery, job.imageUrls ?? []);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const statusResponse = await fetch(`/api/scenario-images/jobs/${job.id}`);
    job = await statusResponse.json();
    if (!statusResponse.ok) throw new Error(job.error ?? "读取配图生成进度失败。");
  }
  renderScenarioImages(gallery, job.imageUrls ?? [], job.state === "completed");
  button.dataset.cached = String(job.imageUrls?.length === 2);
  button.textContent = !illustrationAvailable ? "图像模型未就绪" : button.dataset.cached === "true" ? "重新生成两张配图" : "生成两张配图";
  if (job.state === "completed") status.textContent = job.message.includes("缓存") ? "两张配图已从本机缓存载入，可直接练习" : "两张配图已生成并缓存在本机";
  else status.textContent = job.error ?? "本机图像生成失败。";
  button.disabled = !illustrationAvailable;
}

async function generateScenarioImages(panel, context, dialogue) {
  const button = panel.querySelector(".scenario-generate");
  const status = panel.querySelector(".scenario-image-status");
  const useCachedImages = button.dataset.cached === "true";
  button.disabled = true;
  status.textContent = "正在启动本机图像模型…";
  try {
    const response = await fetch("/api/scenario-images", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filePath: pathInput.value.trim(), context, dialogue, force: useCachedImages }),
    });
    const job = await response.json();
    if (!response.ok) throw new Error(job.error ?? "无法开始生成配图。");
    await followScenarioImageJob(panel, job);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "生成配图失败。";
    button.disabled = !illustrationAvailable;
  }
}

function makeScenarioIllustration(group) {
  const context = group.context || `口语练习情景 ${group.number}`;
  const dialogue = group.turns.map((turn) => `${turn.role}: ${turn.text}`).join("\n");
  const panel = document.createElement("section");
  panel.className = "scenario-illustration";
  const header = document.createElement("div");
  header.className = "scenario-image-header";
  const label = document.createElement("div");
  label.className = "scenario-image-label";
  const heading = document.createElement("b");
  heading.textContent = "情景配图";
  const model = document.createElement("small");
  model.textContent = `本机 ${illustrationModelName} · 每次生成 2 张`;
  label.append(heading, model);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "scenario-generate";
  button.disabled = !illustrationAvailable;
  button.dataset.cached = "false";
  button.textContent = illustrationAvailable ? "生成两张配图" : "图像模型未就绪";
  button.addEventListener("click", () => void generateScenarioImages(panel, context, dialogue));
  header.append(label, button);
  const status = document.createElement("p");
  status.className = "scenario-image-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const gallery = document.createElement("div");
  gallery.className = "scenario-gallery";
  panel.append(header, status, gallery);
  void loadScenarioImages(panel, context, dialogue);
  return panel;
}

function cloneSettings(source) {
  return Object.fromEntries(Object.entries(source).map(([group, ids]) => [group, [...ids]]));
}

function allTurns() {
  return sections.flatMap((section) => section.groups.flatMap((group) => group.turns));
}

function cacheItemsFor(profile) {
  const profileSettings = profile === "default" ? cloneSettings(DEFAULTS) : cloneSettings(settings);
  return allTurns().map((turn) => ({
    id: turn.id,
    text: turn.text,
    language: /[\u3400-\u9fff]/.test(turn.text) ? "Chinese" : "English",
    instruct: speechInstruction(turn.voiceRole, profileSettings),
  }));
}

function setCacheStatus(message) {
  $("#audio-cache-status").textContent = message;
}

function updateBundleControls(exportReady = false) {
  const exportButton = /** @type {HTMLButtonElement} */ $("#export-bundle");
  const available = archiveToolsAvailable && Boolean(materialKey && loadedFilePath);
  exportButton.classList.toggle("hidden", !available || !exportReady);
  exportButton.disabled = !available || !exportReady;
  if (available && exportReady) $("#bundle-status").textContent = "当前材料的完整离线语音已通过校验，可下载资源包。";
  else if (archiveToolsAvailable && materialKey) $("#bundle-status").textContent = "导出会在当前材料的全部离线语音生成并校验通过后开放。";
}

function renderAudioCacheStatus(data) {
  const runningJob = data.job?.state === "running" ? data.job : null;
  const hasMaterial = Boolean(materialKey && loadedFilePath);
  const packageMatches = Boolean(data.matchesMaterial);
  if (typeof data.packageExists === "boolean") cachedPackageExists = data.packageExists;
  const packageExists = typeof data.packageExists === "boolean" ? data.packageExists : cachedPackageExists;
  const generateButton = /** @type {HTMLButtonElement} */ $("#generate-cache");
  const replaceButton = /** @type {HTMLButtonElement} */ $("#replace-cache");
  const isRunning = Boolean(runningJob);
  const actionState = getCacheActionState({ hasMaterial, modelAvailable, isRunning, packageExists });

  updateBundleControls(Boolean(data.exportReady && packageMatches));

  $("#cache-count").textContent = packageMatches ? `${data.cached}/${data.total} 句` : "";
  generateButton.classList.toggle("hidden", !actionState.showDefault);
  generateButton.textContent = actionState.defaultLabel;
  generateButton.disabled = actionState.disabled;
  replaceButton.classList.toggle("hidden", !actionState.showReplace);
  replaceButton.textContent = actionState.replaceLabel;
  replaceButton.disabled = actionState.disabled;

  const progressWrap = $("#cache-progress-wrap");
  if (runningJob) {
    const currentIndex = allTurns().findIndex((turn) => turn.id === runningJob.currentItem) + 1;
    const target = runningJob.materialKey === materialKey ? "当前材料" : "另一份材料";
    setCacheStatus(`后台正在为${target}生成：${runningJob.completed}/${runningJob.total} 句已完成。${runningJob.message ?? ""}`);
    /** @type {HTMLProgressElement} */ $("#cache-progress").value = Number(runningJob.progress ?? 0);
    $("#cache-progress-label").textContent = currentIndex ? `当前第 ${currentIndex}/${runningJob.total} 句` : `${runningJob.completed}/${runningJob.total}`;
    progressWrap.classList.remove("hidden");
  } else {
    progressWrap.classList.add("hidden");
    if (packageMatches) setCacheStatus(`已有可用离线语音，覆盖 ${data.cached}/${data.total} 句。`);
    else if (packageExists) setCacheStatus("当前材料还没有匹配缓存；生成新包后会替换本机唯一的离线包。");
    else setCacheStatus(hasMaterial
      ? modelAvailable ? "还没有离线语音缓存；可在后台生成固定默认音色版本。" : "没有可用的离线语音；请导入资源包，或在装有模型的 Mac 上生成后导出。"
      : "读取材料后查看缓存状态");
  }
}

async function refreshAudioCacheStatus() {
  if (!materialKey) return;
  const requestedKey = materialKey;
  try {
    const query = new URLSearchParams({ materialKey: requestedKey, filePath: loadedFilePath });
    const response = await fetch(`/api/audio-cache/status?${query}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "读取离线语音状态失败。");
    if (requestedKey !== materialKey) return;
    renderAudioCacheStatus(data);
    if (data.job?.state === "running") void followAudioCacheJob(data.job);
  } catch (error) {
    if (requestedKey === materialKey) setCacheStatus(error instanceof Error ? error.message : "读取离线语音状态失败。");
  }
}

async function followAudioCacheJob(initialJob) {
  const token = ++cachePollToken;
  let job = initialJob;
  renderAudioCacheStatus({ job });
  while (job.state === "running" && token === cachePollToken) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    try {
      const response = await fetch(`/api/audio-cache/jobs/${job.id}`);
      const updated = await response.json();
      if (!response.ok) throw new Error(updated.error ?? "读取缓存进度失败。");
      job = updated;
      if (token !== cachePollToken) return;
      renderAudioCacheStatus({ job });
    } catch (error) {
      if (token === cachePollToken) setCacheStatus(error instanceof Error ? error.message : "读取缓存进度失败。");
      return;
    }
  }
  if (token !== cachePollToken) return;
  await refreshAudioCacheStatus();
  if (job.state === "failed") setCacheStatus(`生成失败：${job.error ?? job.message ?? "请稍后重试。"} 原有完整缓存仍保留。`);
}

async function startAudioCache(profile) {
  if (!materialKey || !loadedFilePath) return;
  const payload = {
    filePath: loadedFilePath,
    materialKey,
    profile,
    items: cacheItemsFor(profile),
  };
  setCacheStatus("正在提交后台缓存任务…");
  const response = await fetch("/api/audio-cache/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const job = await response.json();
  if (!response.ok) throw new Error(job.error ?? "无法开始离线语音生成。");
  if (job.state === "completed") await refreshAudioCacheStatus();
  else void followAudioCacheJob(job);
}

function applyParsedMaterial(data) {
  examController?.resetForMaterialChange();
  invalidatePlayback();
  sections = data.sections;
  loadedFilePath = data.filePath;
  materialKey = data.materialKey;
  examController?.refreshAvailability();
  cachedPackageExists = false;
  $("#cache-count").textContent = "";
  updateBundleControls(false);
  activeSection = sections[0]?.id ?? "phase1";
  pathInput.value = loadedFilePath;
  localStorage.setItem("ket-speaking-last-material", loadedFilePath);
  const displayName = data.filePath.split(/[\\/]/).filter(Boolean).pop() ?? data.filePath;
  $("#file-name").textContent = displayName;
  $("#file-name").title = data.filePath;
  $("#item-count").textContent = `${data.itemCount} 句英文台词`;
  $("#empty-state").classList.add("hidden");
  renderTabs();
  renderGroups();
}

async function loadFile() {
  const requestedPath = pathInput.value.trim();
  if (!requestedPath) return setError("请填写 Markdown 文件路径。");
  const requestToken = ++materialLoadToken;
  cachePollToken += 1;
  invalidatePlayback();
  loadButton.disabled = true;
  loadButton.textContent = "读取中…";
  setError("");
  $("#playback-status").textContent = "正在读取练习材料…";
  try {
    const response = await fetch("/api/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: requestedPath }),
    });
    const result = await response.json();
    if (requestToken !== materialLoadToken) return;
    if (!response.ok) throw new Error(result.error ?? "读取失败。");
    /** @type {ParsedFile} */
    const data = result;
    applyParsedMaterial(data);
    $("#playback-status").textContent = modelAvailable ? "点击任一句开始朗读" : "仅播放已缓存的离线语音";
    await refreshAudioCacheStatus();
    if (requestToken !== materialLoadToken) return;
    if (!modelAvailable && !$("#cache-count").textContent) setError("题目已读取，但没有匹配的离线语音。请导入资源包，或使用已安装模型的 Mac 生成语音资源。");
  } catch (error) {
    if (requestToken === materialLoadToken) {
      setError(error instanceof Error ? error.message : "读取 Markdown 文件失败。");
      $("#playback-status").textContent = "读取材料失败";
    }
  } finally {
    if (requestToken === materialLoadToken) {
      loadButton.disabled = false;
      loadButton.innerHTML = '读取文件 <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M6 14 14 6M7 6h7v7" /></svg>';
    }
  }
}

async function importResourceBundle(file) {
  const button = /** @type {HTMLButtonElement} */ $("#import-bundle");
  button.disabled = true;
  button.textContent = "正在上传并校验…";
  $("#bundle-status").textContent = `正在导入 ${file.name}；上传与完整性校验完成前不会替换当前资源。`;
  setError("");
  try {
    const response = await fetch("/api/resource-bundles/import", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: file,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "资源包导入失败。");
    ++materialLoadToken;
    cachePollToken += 1;
    applyParsedMaterial(result);
    $("#playback-status").textContent = "资源包已导入；正在校验语音并载入配图…";
    await refreshAudioCacheStatus();
    $("#playback-status").textContent = "资源包已就绪，点击任一句播放本地语音";
    $("#bundle-status").textContent = `已导入 ${file.name}：${result.itemCount} 句语音材料和可用配图。`;
    if (!modelAvailable) $("#playback-mode-note").textContent = "仅播放资源包内的离线语音；音色和语气标签不影响已生成的音频。";
  } catch (error) {
    setError(error instanceof Error ? error.message : "资源包导入失败。");
    $("#bundle-status").textContent = "导入未完成；原有材料和离线资源保持不变。";
  } finally {
    button.disabled = !archiveToolsAvailable;
    button.textContent = "导入资源包";
    /** @type {HTMLInputElement} */ $("#bundle-file").value = "";
  }
}

async function exportResourceBundle() {
  const button = /** @type {HTMLButtonElement} */ $("#export-bundle");
  if (!materialKey || !loadedFilePath || !archiveToolsAvailable) return;
  button.disabled = true;
  button.textContent = "正在准备下载…";
  try {
    const query = new URLSearchParams({ filePath: loadedFilePath, materialKey });
    const response = await fetch(`/api/resource-bundles/export?${query}`);
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error ?? "无法导出资源包。");
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get("content-disposition") ?? "")?.[1];
    const plainName = /filename="?([^";]+)"?/i.exec(response.headers.get("content-disposition") ?? "")?.[1];
    link.download = encodedName ? decodeURIComponent(encodedName) : plainName ?? "practice.ketpack.zip";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    $("#bundle-status").textContent = "离线资源包已下载。";
  } catch (error) {
    setError(error instanceof Error ? error.message : "无法导出资源包。");
  } finally {
    button.disabled = false;
    button.textContent = "下载离线资源包";
  }
}

function speechInstruction(voiceRole, settingsSnapshot = settings) {
  const voice = TAGS.voice.filter((tag) => settingsSnapshot.voice.includes(tag.id)).map((tag) => tag.prompt);
  const delivery = TAGS[voiceRole].filter((tag) => settingsSnapshot[voiceRole].includes(tag.id)).map((tag) => tag.prompt);
  return [voice.length && `Voice: ${voice.join(", ")}`, delivery.length && `Delivery: ${delivery.join(", ")}`]
    .filter(Boolean)
    .join(". ");
}

async function speak(button, { waitForEnd = false } = {}) {
  cancelPlaybackWait("朗读被另一句语音替换。");
  const requestToken = ++playbackRequestToken;
  const requestedMaterialKey = materialKey;
  const requestedMode = playbackMode;
  const settingsSnapshot = cloneSettings(settings);
  const text = button.dataset.text ?? "";
  const voiceRole = button.dataset.voiceRole === "question" ? "question" : "answer";
  const language = /[\u3400-\u9fff]/.test(text) ? "Chinese" : "English";
  const instruct = speechInstruction(voiceRole, settingsSnapshot);
  const cacheKey = JSON.stringify([text, instruct, language]);
  button.classList.add("is-loading");
  button.disabled = true;
  setError("");
  let playbackFinished = null;
  const shouldContinue = () => shouldContinueExamPlayback(isCurrentPlayback(requestToken, requestedMaterialKey), waitForEnd);
  try {
    let audioUrl = "";
    if ((requestedMode === "offline-first" || requestedMode === "offline-only") && requestedMaterialKey) {
      const offlineResponse = await fetch(`/api/offline-audio/${requestedMaterialKey}/${button.dataset.turnId}`, { cache: "no-store" });
      if (!shouldContinue()) return;
      if (offlineResponse.ok) {
        const audioBlob = await offlineResponse.blob();
        if (!shouldContinue()) return;
        audioUrl = URL.createObjectURL(audioBlob);
        $("#playback-status").textContent = "正在播放本机离线语音";
      } else {
        if (requestedMode === "offline-only" || !modelAvailable) throw new Error("这句话没有可用的离线语音。请导入包含该语音的资源包，或在有模型的 Mac 上重新生成并导出。");
        $("#playback-status").textContent = "此句没有离线缓存，正在按当前标签实时合成…";
      }
    }
    if (!audioUrl) {
      if (!modelAvailable) throw new Error("本机语音模型尚未就绪，无法实时合成语音。");
      audioUrl = audioCache.get(cacheKey) ?? "";
      if (!audioUrl) {
        $("#playback-status").textContent = "本机正在合成…首次加载模型会稍久";
        const response = await fetch("/api/synthesize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, instruct, language }),
        });
        if (!shouldContinue()) return;
        const result = await response.json();
        if (!shouldContinue()) return;
        if (!response.ok) throw new Error(result.error ?? "语音合成失败。");
        audioUrl = `${result.audioUrl}?v=${Date.now()}`;
        audioCache.set(cacheKey, audioUrl);
      }
    }
    if (!shouldContinue()) return;
    if (audioCurrent) audioCurrent.pause();
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = audioUrl.startsWith("blob:") ? audioUrl : "";
    player.src = audioUrl;
    audioCurrent = player;
    activePlaybackToken = requestToken;
    if (waitForEnd) {
      playbackFinished = new Promise((resolve, reject) => {
        playbackWaiter = { token: requestToken, resolve, reject };
      });
    }
    player.onended = () => {
      if (activePlaybackToken !== requestToken) return;
      if (requestToken === playbackRequestToken) $("#playback-status").textContent = "朗读完成";
      if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = "";
      activePlaybackToken = 0;
      if (playbackWaiter?.token === requestToken) {
        const waiter = playbackWaiter;
        playbackWaiter = null;
        waiter.resolve();
      }
    };
    player.onerror = () => {
      if (activePlaybackToken !== requestToken) return;
      if (playbackWaiter?.token === requestToken) {
        const waiter = playbackWaiter;
        playbackWaiter = null;
        waiter.reject(new Error("语音播放失败，请重试。"));
      }
    };
    await player.play();
    if (playbackFinished) await playbackFinished;
    if (!shouldContinue()) return;
    if (!waitForEnd && (requestedMode === "realtime" || audioUrl.startsWith("/api/audio/"))) $("#playback-status").textContent = "正在朗读 · 本地实时合成";
  } catch (error) {
    if (waitForEnd) {
      if (playbackWaiter?.token === requestToken) {
        const waiter = playbackWaiter;
        playbackWaiter = null;
        waiter.reject(error instanceof Error ? error : new Error("无法播放生成的语音。"));
      }
      if (playbackFinished) await playbackFinished.catch(() => {});
      throw error instanceof Error ? error : new Error("无法播放生成的语音。");
    }
    if (isCurrentPlayback(requestToken, requestedMaterialKey)) {
      setError(error instanceof Error ? error.message : "无法播放生成的语音。");
      $("#playback-status").textContent = "朗读失败";
    }
  } finally {
    button.classList.remove("is-loading");
    button.disabled = false;
  }
}

list.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest(".speak-button") : null;
  if (target) void speak(/** @type {HTMLButtonElement} */ (target));
});
loadButton.addEventListener("click", () => void loadFile());
pathInput.addEventListener("keydown", (event) => { if (event.key === "Enter") void loadFile(); });
$("#generate-cache").addEventListener("click", () => {
  void startAudioCache("default").catch((error) => setCacheStatus(error instanceof Error ? error.message : "无法开始缓存生成。"));
});
$("#replace-cache").addEventListener("click", () => {
  void startAudioCache("current").catch((error) => setCacheStatus(error instanceof Error ? error.message : "无法开始缓存生成。"));
});
$("#import-bundle").addEventListener("click", () => /** @type {HTMLInputElement} */ $("#bundle-file").click());
$("#bundle-file").addEventListener("change", (event) => {
  const file = /** @type {HTMLInputElement} */ (event.currentTarget).files?.[0];
  if (file) void importResourceBundle(file);
});
$("#export-bundle").addEventListener("click", () => void exportResourceBundle());
$("#playback-mode").addEventListener("change", (event) => {
  playbackMode = resolvePlaybackMode(/** @type {HTMLSelectElement} */ (event.currentTarget).value, modelAvailable);
  localStorage.setItem(PLAYBACK_MODE_KEY, playbackMode);
  $("#playback-status").textContent = !modelAvailable ? "离线优先；缺少语音时请导入资源包" : playbackMode === "offline-first" ? "离线优先；缺失语音时使用实时合成" : "实时合成模式";
});

examController = installExamController({
  beforeBeginExam: () => updateControls?.reserveExam() ?? Promise.resolve(),
  onExamEnd: () => updateControls?.releaseExam(),
  getSections: () => sections,
  getExamAvailability: () => examAvailability,
  stopSpeech: () => invalidatePlayback(),
  speakText: async (turn) => {
    const button = document.createElement("button");
    button.dataset.turnId = turn.id;
    button.dataset.text = turn.text;
    button.dataset.voiceRole = turn.voiceRole;
    await speak(button, { waitForEnd: true });
  },
});
updateControls = installUpdateControls({ isExamActive: () => examController?.isActive() ?? false });
window.addEventListener("pagehide", () => examController?.dispose(), { once: true });
installSettings();
pathInput.value = localStorage.getItem("ket-speaking-last-material") || "";
async function initialize() {
  await loadConfig();
  if (pathInput.value.trim()) await loadFile();
}
initialize().catch((error) => {
  setError(error instanceof Error ? error.message : "本地服务初始化失败。");
});
