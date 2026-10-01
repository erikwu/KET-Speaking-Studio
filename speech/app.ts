// @ts-check

/** @typedef {{id:string,role:"Q"|"A"|"B",voiceRole:"question"|"answer",text:string,translation:string}} Turn */
/** @typedef {{id:string,number:number,context:string,turns:Turn[]}} Group */
/** @typedef {{id:"phase1"|"phase2"|"part2",title:string,groups:Group[]}} Section */
/** @typedef {{filePath:string,materialKey:string,sections:Section[],itemCount:number}} ParsedFile */

const DEFAULT_PATH = "/Users/erik/Library/Mobile Documents/iCloud~md~obsidian/Documents/MyWiki/2.Wiki/000.生活总结/个人英语学习/KET口语常用问答_9岁儿童_表达变体.md";
const TAGS = {
  voice: [
    { id: "clear", label: "清晰自然", prompt: "speaking clearly with natural English pronunciation" },
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
let illustrationAvailable = false;
let illustrationModelName = "Qwen Image";
let audioCurrent = null;
let currentObjectUrl = "";
const audioCache = new Map();
let loadedFilePath = "";
let materialKey = "";
let cachePollToken = 0;
let materialLoadToken = 0;
let playbackRequestToken = 0;
let activePlaybackToken = 0;
let playbackMode = localStorage.getItem(PLAYBACK_MODE_KEY) === "offline-first" ? "offline-first" : "realtime";
/** @type {HTMLSelectElement} */ $("#playback-mode").value = playbackMode;

function setError(message) {
  const box = $("#page-error");
  box.textContent = message;
  box.classList.toggle("hidden", !message);
}

function invalidatePlayback() {
  playbackRequestToken += 1;
  activePlaybackToken = 0;
  player.pause();
  player.onended = null;
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
      settings[group] = settings[group].includes(tag.id)
        ? settings[group].filter((id) => id !== tag.id)
        : [...settings[group], tag.id];
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
  modelAvailable = Boolean(config.modelReady && config.runtimeReady);
  illustrationAvailable = Boolean(config.illustrationReady);
  illustrationModelName = config.illustrationModel || illustrationModelName;
  $("#model-name").textContent = config.modelPath;
  const status = $("#model-status");
  if (!config.modelReady) {
    status.textContent = "模型文件未完整下载";
    status.classList.add("status-warn");
  } else if (!config.runtimeReady) {
    status.textContent = "还需安装 MLX-Audio";
    status.classList.add("status-warn");
  } else {
    status.textContent = "本地模型已就绪";
    status.classList.add("status-ready");
  }
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
    status.textContent = result.imageUrls?.length === 2 ? "两张配图已从本机缓存载入，可直接练习" : result.imageUrls?.length ? `已缓存 ${result.imageUrls.length} 张，点击补全` : "点击按钮生成两张情景配图";
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
  button.textContent = button.dataset.cached === "true" ? "重新生成两张配图" : "生成两张配图";
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

function renderAudioCacheStatus(data) {
  const runningJob = data.job?.state === "running" ? data.job : null;
  const hasMaterial = Boolean(materialKey && loadedFilePath);
  const packageMatches = Boolean(data.matchesMaterial);
  const packageExists = Boolean(data.packageExists);
  const generateButton = /** @type {HTMLButtonElement} */ $("#generate-cache");
  const replaceButton = /** @type {HTMLButtonElement} */ $("#replace-cache");
  const isRunning = Boolean(runningJob);

  $("#cache-count").textContent = packageMatches ? `${data.cached}/${data.total} 句` : "";
  generateButton.classList.toggle("hidden", packageMatches);
  generateButton.textContent = packageExists && !packageMatches ? "为当前材料生成默认缓存" : "生成默认音色缓存";
  generateButton.disabled = !hasMaterial || !modelAvailable || isRunning;
  replaceButton.classList.toggle("hidden", !packageExists);
  replaceButton.textContent = packageMatches ? "按当前标签重新生成并替换" : "按当前标签生成并替换现有缓存";
  replaceButton.disabled = !hasMaterial || !modelAvailable || isRunning;

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
    else setCacheStatus(hasMaterial ? "还没有离线语音缓存；可在后台生成固定默认音色版本。" : "读取材料后查看缓存状态");
  }
}

async function refreshAudioCacheStatus() {
  if (!materialKey) return;
  const requestedKey = materialKey;
  try {
    const response = await fetch(`/api/audio-cache/status?materialKey=${encodeURIComponent(requestedKey)}`);
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
  renderAudioCacheStatus({ packageExists: false, matchesMaterial: false, cached: 0, total: 0, job });
  while (job.state === "running" && token === cachePollToken) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    try {
      const response = await fetch(`/api/audio-cache/jobs/${job.id}`);
      const updated = await response.json();
      if (!response.ok) throw new Error(updated.error ?? "读取缓存进度失败。");
      job = updated;
      if (token !== cachePollToken) return;
      renderAudioCacheStatus({ packageExists: false, matchesMaterial: false, cached: 0, total: 0, job });
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
    invalidatePlayback();
    sections = data.sections;
    loadedFilePath = data.filePath;
    materialKey = data.materialKey;
    activeSection = sections[0]?.id ?? "phase1";
    const displayName = data.filePath.split(/[\\/]/).filter(Boolean).pop() ?? data.filePath;
    $("#file-name").textContent = displayName;
    $("#file-name").title = data.filePath;
    $("#item-count").textContent = `${data.itemCount} 句英文台词`;
    $("#empty-state").classList.add("hidden");
    renderTabs();
    renderGroups();
    $("#playback-status").textContent = modelAvailable ? "点击任一句开始朗读" : "先完成模型安装后即可朗读";
    await refreshAudioCacheStatus();
    if (requestToken !== materialLoadToken) return;
    if (!modelAvailable) setError("题目已读取；本机模型或 MLX-Audio 尚未就绪，语气设置已保存。完成环境准备后刷新即可朗读。");
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

function speechInstruction(voiceRole, settingsSnapshot = settings) {
  const voice = TAGS.voice.filter((tag) => settingsSnapshot.voice.includes(tag.id)).map((tag) => tag.prompt);
  const delivery = TAGS[voiceRole].filter((tag) => settingsSnapshot[voiceRole].includes(tag.id)).map((tag) => tag.prompt);
  return [voice.length && `Voice: ${voice.join(", ")}`, delivery.length && `Delivery: ${delivery.join(", ")}`]
    .filter(Boolean)
    .join(". ");
}

async function speak(button) {
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
  try {
    let audioUrl = "";
    if (requestedMode === "offline-first" && requestedMaterialKey) {
      const offlineResponse = await fetch(`/api/offline-audio/${requestedMaterialKey}/${button.dataset.turnId}`, { cache: "no-store" });
      if (!isCurrentPlayback(requestToken, requestedMaterialKey)) return;
      if (offlineResponse.ok) {
        const audioBlob = await offlineResponse.blob();
        if (!isCurrentPlayback(requestToken, requestedMaterialKey)) return;
        audioUrl = URL.createObjectURL(audioBlob);
        $("#playback-status").textContent = "正在播放本机离线语音";
      } else {
        $("#playback-status").textContent = "此句没有离线缓存，正在按当前标签实时合成…";
      }
    }
    if (!audioUrl) {
      if (!modelAvailable) throw new Error("本地语音模型尚未就绪。请先完成 speech/README.md 中的模型与运行环境安装。");
      audioUrl = audioCache.get(cacheKey) ?? "";
      if (!audioUrl) {
        $("#playback-status").textContent = "本机正在合成…首次加载模型会稍久";
        const response = await fetch("/api/synthesize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, instruct, language }),
        });
        if (!isCurrentPlayback(requestToken, requestedMaterialKey)) return;
        const result = await response.json();
        if (!isCurrentPlayback(requestToken, requestedMaterialKey)) return;
        if (!response.ok) throw new Error(result.error ?? "语音合成失败。");
        audioUrl = `${result.audioUrl}?v=${Date.now()}`;
        audioCache.set(cacheKey, audioUrl);
      }
    }
    if (!isCurrentPlayback(requestToken, requestedMaterialKey)) return;
    if (audioCurrent) audioCurrent.pause();
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = audioUrl.startsWith("blob:") ? audioUrl : "";
    player.src = audioUrl;
    audioCurrent = player;
    activePlaybackToken = requestToken;
    player.onended = () => {
      if (activePlaybackToken !== requestToken) return;
      if (requestToken === playbackRequestToken) $("#playback-status").textContent = "朗读完成";
      if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = "";
      activePlaybackToken = 0;
    };
    await player.play();
    if (!isCurrentPlayback(requestToken, requestedMaterialKey)) return;
    if (requestedMode === "realtime" || audioUrl.startsWith("/api/audio/")) $("#playback-status").textContent = "正在朗读 · 本地实时合成";
  } catch (error) {
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
$("#playback-mode").addEventListener("change", (event) => {
  playbackMode = /** @type {HTMLSelectElement} */ (event.currentTarget).value === "offline-first" ? "offline-first" : "realtime";
  localStorage.setItem(PLAYBACK_MODE_KEY, playbackMode);
  $("#playback-status").textContent = playbackMode === "offline-first" ? "离线优先；缺失语音时使用实时合成" : "实时合成模式";
});

installSettings();
pathInput.value = DEFAULT_PATH;
async function initialize() {
  await loadConfig();
  await loadFile();
}
initialize().catch((error) => {
  setError(error instanceof Error ? error.message : "本地服务初始化失败。");
});
