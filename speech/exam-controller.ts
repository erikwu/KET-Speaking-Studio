// @ts-check
import { buildExamPlan, recordExamHint, summarizeExam } from "./exam-session.ts";
import { startExamRecording } from "./exam-audio.ts";

/** @typedef {{id:string,role:"Q"|"A"|"B",voiceRole:"question"|"answer",text:string,translation:string}} Turn */
/** @typedef {{id:string,title:string,groups:Array<{id:string,number:number,context:string,turns:Turn[]}>}} Section */

/** @param {Turn} turn */
export function getPart1PromptDisplay(turn) {
  return { audioTurn: turn, visibleQuestion: "" };
}

/** @param {Turn} turn */
export function getPart2StudentPrompt(turn) {
  return turn.translation;
}

/** @param {string} activeExamId @param {string} activeResponseId @param {string} responseExamId @param {string} responseId */
export function isExamResponseCurrent(activeExamId, activeResponseId, responseExamId, responseId) {
  return Boolean(activeExamId && activeResponseId && activeExamId === responseExamId && activeResponseId === responseId);
}

/** @param {boolean} isCurrent @param {boolean} waitForEnd */
export function shouldContinueExamPlayback(isCurrent, waitForEnd) {
  if (isCurrent) return true;
  if (waitForEnd) throw new Error("朗读被另一句语音替换。");
  return false;
}

const SECTION_NAMES = { phase1: "Part 1 · Phase 1", phase2: "Part 1 · Phase 2", part2: "Part 2" };
const $ = (selector) => document.querySelector(selector);

/** @param {{getSections:()=>Section[],getExamAvailability:()=>{available:boolean,reason:string},speakText:(turn:Turn)=>Promise<void>,stopSpeech?:()=>void,startRecording?:typeof startExamRecording,beforeBeginExam?:()=>Promise<void>,onExamEnd?:()=>void}} options */
export function installExamController({ getSections, getExamAvailability, speakText, stopSpeech = () => {}, startRecording = startExamRecording, beforeBeginExam = async () => {}, onExamEnd = () => {} }) {
  const startButton = /** @type {HTMLButtonElement} */ $("#exam-start");
  const practicePanel = /** @type {HTMLElement} */ $("#practice-card");
  const availabilityNode = /** @type {HTMLElement} */ $("#exam-availability");
  const sessionPanel = /** @type {HTMLElement} */ $("#exam-panel");
  const summaryPanel = /** @type {HTMLDialogElement} */ $("#exam-summary");
  const viewSummaryButton = /** @type {HTMLButtonElement} */ $("#exam-view-summary");
  const scoreSoundButton = /** @type {HTMLButtonElement} */ $("#exam-score-sound");
  const contentNode = /** @type {HTMLElement} */ $("#exam-content");
  const stageNode = /** @type {HTMLElement} */ $("#exam-stage");
  const progressNode = /** @type {HTMLElement} */ $("#exam-progress");
  const statusNode = /** @type {HTMLElement} */ $("#exam-status");
  const errorNode = /** @type {HTMLElement} */ $("#exam-error");
  const feedbackNode = /** @type {HTMLElement} */ $("#exam-feedback");
  const referenceToggle = /** @type {HTMLButtonElement} */ $("#exam-reference-toggle");
  const referenceNode = /** @type {HTMLElement} */ $("#exam-reference");
  const recordButton = /** @type {HTMLButtonElement} */ $("#exam-record");
  const stopButton = /** @type {HTMLButtonElement} */ $("#exam-stop");
  const continueButton = /** @type {HTMLButtonElement} */ $("#exam-continue");
  const endButton = /** @type {HTMLButtonElement} */ $("#exam-end");
  const retryScoreButton = /** @type {HTMLButtonElement} */ $("#exam-retry-score");
  const rerecordScoreButton = /** @type {HTMLButtonElement} */ $("#exam-rerecord-score");
  const skipScoreButton = /** @type {HTMLButtonElement|null} */ $("#exam-skip-score");

  let availability = { available: false, reason: "正在检查模拟考能力…" };
  let plan = null;
  let activeExamId = "";
  let unitIndex = 0;
  let sequenceIndex = 0;
  let hintCounts = {};
  let responseRecords = new Map();
  let practiceAttempts = new Map();
  let revealed = false;
  let recordingSession = null;
  let recordingTarget = null;
  let pendingScoreTarget = null;
  let currentResponseId = "";
  let currentQuestion = "";
  let currentReference = "";
  let questionPlaybackId = 0;
  let disposed = false;
  let scoreSoundEnabled = true;
  let scoreAudioContext = /** @type {AudioContext|null} */ (null);
  let summarySoundButton = /** @type {HTMLButtonElement|null} */ (null);

  const unit = () => plan?.units[unitIndex] ?? null;
  const responseIdFor = (current, turnIndex) => `${current.id}-response-${turnIndex}`;
  const stagePosition = () => plan?.units.slice(0, unitIndex).filter((item) => item.sectionId === unit()?.sectionId).length + 1;
  const stageTotal = () => plan?.units.filter((item) => item.sectionId === unit()?.sectionId).length;
  const isCurrent = (examId, responseId) => isExamResponseCurrent(activeExamId, currentResponseId, examId, responseId);

  function setError(message = "") {
    errorNode.textContent = message;
    errorNode.classList.toggle("hidden", !message);
  }

  function setStatus(message) {
    statusNode.textContent = message;
  }

  function syncScoreSoundButtons() {
    const label = `满分音效：${scoreSoundEnabled ? "开" : "关"}`;
    for (const button of [scoreSoundButton, summarySoundButton]) {
      if (!button) continue;
      button.textContent = label;
      button.setAttribute("aria-pressed", String(scoreSoundEnabled));
    }
  }

  function toggleScoreSound() {
    scoreSoundEnabled = !scoreSoundEnabled;
    syncScoreSoundButtons();
    if (scoreSoundEnabled) primeScoreAudio();
  }

  function primeScoreAudio() {
    if (!scoreSoundEnabled || typeof window.AudioContext !== "function") return;
    try {
      scoreAudioContext ??= new window.AudioContext();
      if (scoreAudioContext.state === "suspended") void scoreAudioContext.resume().catch(() => {});
    } catch {
      scoreAudioContext = null;
    }
  }

  function playPerfectScoreSound() {
    if (!scoreSoundEnabled || !scoreAudioContext) return;
    const context = scoreAudioContext;
    const playNotes = () => {
      if (!scoreSoundEnabled) return;
      const now = context.currentTime;
      [659.25, 783.99, 1046.5].forEach((frequency, index) => {
        const start = now + index * 0.105;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.055, start + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.29);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.3);
      });
    };
    if (context.state === "running") playNotes();
    else void context.resume().then(playNotes).catch(() => {});
  }

  function restoreAnswerActions(responseId = currentResponseId, attemptId = null) {
    stopButton.classList.add("hidden");
    const record = responseRecords.get(responseId);
    if (record?.status === "scored") {
      recordButton.classList.add("hidden");
      continueButton.classList.remove("hidden");
      continueButton.textContent = isLastStudentAction(unit()) ? "下一题" : "继续对话";
      rerecordScoreButton.classList.remove("hidden");
      rerecordScoreButton.disabled = false;
      rerecordScoreButton.textContent = "重新作答并评估";
      const hasPendingScore = pendingScoreTarget?.responseId === responseId;
      retryScoreButton.classList.toggle("hidden", !hasPendingScore);
      retryScoreButton.disabled = false;
      skipScoreButton?.classList.add("hidden");
    } else if (record?.transcript && record.status === "unscored") {
      recordButton.classList.add("hidden");
      continueButton.classList.add("hidden");
      retryScoreButton.classList.remove("hidden");
      retryScoreButton.disabled = false;
      rerecordScoreButton.classList.remove("hidden");
      rerecordScoreButton.textContent = "重新录音并评分";
      rerecordScoreButton.disabled = false;
      if (skipScoreButton) skipScoreButton.classList.remove("hidden");
    } else {
      recordButton.classList.remove("hidden");
      recordButton.disabled = false;
      continueButton.classList.add("hidden");
      retryScoreButton.classList.add("hidden");
      rerecordScoreButton.classList.add("hidden");
      skipScoreButton?.classList.add("hidden");
    }
  }

  function formatScoringError(result) {
    const message = typeof result?.error === "string" ? result.error : "本机评分失败，可重试评分。";
    if (typeof result?.diagnosticId !== "string" || !/^[A-Fa-f0-9]{12}$/.test(result.diagnosticId)) return message;
    const logPath = typeof result.diagnosticLogPath === "string" ? result.diagnosticLogPath : "outputs/speech-practice/exam-diagnostics.jsonl";
    const logStatus = result.diagnosticLogSaved === true ? `诊断日志已写入 ${logPath}` : `诊断日志未能写入，请检查本机目录权限（${logPath}）`;
    /** @type {Record<string,string>} */ const reasonLabels = {
      missing_json_object: "模型没有返回评分 JSON 对象",
      malformed_json: "模型返回的 JSON 无法解析",
      invalid_top_level_type: "评分结果顶层格式无效",
      unexpected_top_level_fields: "评分维度字段缺失或多余",
      invalid_feedback_fields: "评分反馈字段格式无效",
      invalid_dimension_shape: "某项评分缺少分数或反馈",
      invalid_score_value: "评分不是 0 到 5 的整数",
      invalid_feedback_text: "评分反馈为空或格式无效",
      invalid_worker_score: "评分结果未通过本机结构校验",
      worker_request_failed: "本机评分服务请求失败",
      unexpected_scoring_error: "本机评分遇到未分类错误",
      runtime_error: "评分运行阶段出错",
    };
    const reason = typeof result?.diagnosticCode === "string" ? reasonLabels[result.diagnosticCode] : "";
    return `${message}${reason ? `\n诊断原因：${reason}。` : ""}\n诊断编号：${result.diagnosticId}。${logStatus}。`;
  }

  function clearExamView() {
    contentNode.replaceChildren();
    feedbackNode.replaceChildren();
    referenceNode.replaceChildren();
    referenceNode.classList.add("hidden");
    referenceToggle.classList.add("hidden");
    referenceToggle.setAttribute("aria-expanded", "false");
    referenceToggle.textContent = "查看参考答案";
    revealed = false;
    errorNode.classList.add("hidden");
    recordButton.classList.add("hidden");
    recordButton.disabled = true;
    stopButton.classList.add("hidden");
    continueButton.classList.add("hidden");
    retryScoreButton.classList.add("hidden");
    rerecordScoreButton.classList.add("hidden");
    skipScoreButton?.classList.add("hidden");
  }

  function addText(parent, tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    parent.append(element);
    return element;
  }

  function addExamButton(parent, label, className, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", action);
    parent.append(button);
    return button;
  }

  function renderAvailability() {
    availability = getExamAvailability();
    const hasSections = getSections().length > 0;
    startButton.disabled = !availability.available || !hasSections || disposed;
    if (!availability.available) {
      availabilityNode.textContent = availability.reason || "本机考试模型和运行环境未就绪。";
      availabilityNode.classList.add("status-warn");
      availabilityNode.classList.remove("status-ready");
    } else if (!hasSections) {
      availabilityNode.textContent = "先读取一份含 Part 1 Phase 1、Phase 2 和 Part 2 的 Markdown 材料。";
      availabilityNode.classList.add("status-warn");
      availabilityNode.classList.remove("status-ready");
    } else {
      availabilityNode.textContent = "本机转写与评分已就绪 · 录音不会上传";
      availabilityNode.classList.add("status-ready");
      availabilityNode.classList.remove("status-warn");
    }
  }

  function enterExamMode() {
    document.body?.classList.add("exam-mode");
    if (document.fullscreenElement || !document.documentElement?.requestFullscreen) return;
    try {
      void document.documentElement.requestFullscreen().catch(() => {});
    } catch {
      // Keep the in-page focused layout when browser fullscreen is unavailable.
    }
  }

  function exitExamMode() {
    document.body?.classList.remove("exam-mode");
    if (!document.fullscreenElement || !document.exitFullscreen) return;
    try {
      void document.exitFullscreen().catch(() => {});
    } catch {
      // Restoring the page layout does not depend on browser fullscreen support.
    }
  }

  function makeResponseRecord(current, turnIndex) {
    const responseId = responseIdFor(current, turnIndex);
    return {
      responseId,
      unitId: current.id,
      sectionId: current.sectionId,
      status: "unanswered",
      turnIndex,
    };
  }

  let startingExam = false;
  async function beginExam() {
    if (startingExam) return;
    void cancelRecording();
    const sections = getSections();
    const nextPlan = buildExamPlan(sections);
    if (nextPlan.missingSections.length || Object.keys(nextPlan.insufficientSections).length) {
      const shortage = Object.entries(nextPlan.insufficientSections)
        .map(([id, counts]) => `${SECTION_NAMES[id]} 需要 ${counts.required} 题，当前只有 ${counts.available} 题`)
        .join("；");
      const skipped = Object.entries(nextPlan.skippedCounts).filter(([, count]) => count > 0).map(([id, count]) => `${SECTION_NAMES[id]} ${count} 组`).join("；");
      const message = `无法开始模拟考：题量不足，${shortage}。${skipped ? ` 已跳过不完整题目：${skipped}。` : ""}请检查当前 Markdown 的题目结构。`;
      availabilityNode.textContent = message;
      availabilityNode.classList.add("status-warn");
      availabilityNode.classList.remove("status-ready");
      setError(message);
      return;
    }
    startingExam = true;
    startButton.disabled = true;
    try {
      await beforeBeginExam();
      if (disposed || getSections() !== sections) { onExamEnd(); return; }
    } catch (error) {
      availabilityNode.textContent = error instanceof Error ? error.message : "暂时无法开始模拟考，请稍后重试。";
      return;
    } finally { startingExam = false; startButton.disabled = false; }
    plan = nextPlan;
    const skippedGroups = Object.entries(nextPlan.skippedCounts).filter(([, count]) => count > 0).map(([id, count]) => `${SECTION_NAMES[id]} ${count} 组`).join("；");
    if (skippedGroups) availabilityNode.textContent = `本次考试会跳过不完整题目：${skippedGroups}。`;
    if (summaryPanel.open) summaryPanel.close();
    summaryPanel.replaceChildren();
    summaryPanel.classList.add("hidden");
    viewSummaryButton.classList.add("hidden");
    summarySoundButton = null;
    activeExamId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    unitIndex = 0;
    sequenceIndex = 0;
    hintCounts = {};
    responseRecords = new Map();
    practiceAttempts = new Map();
    pendingScoreTarget = null;
    for (const current of plan.units) {
      const indexes = current.kind === "part2" ? current.studentTurnIndexes : [0];
      for (const turnIndex of indexes) {
        const record = makeResponseRecord(current, turnIndex);
        responseRecords.set(record.responseId, record);
      }
    }
    enterExamMode();
    sessionPanel.classList.remove("hidden");
    practicePanel.classList.add("hidden");
    summaryPanel.classList.add("hidden");
    startButton.classList.add("hidden");
    setError("");
    showCurrentUnit();
  }

  function renderReference() {
    referenceNode.replaceChildren();
    const current = unit();
    if (!current) return;
    if (current.kind === "part1") {
      current.answers.forEach((answer, index) => {
        const item = document.createElement("article");
        item.className = "exam-reference-line";
        addText(item, "span", "exam-reference-label", index === 0 ? "参考答案" : `表达变体 ${index}`);
        addText(item, "p", "exam-reference-text", answer.text);
        const speakButton = addExamButton(item, "听答案", "speak-button", () => { void speakText(answer).catch((error) => setError(error instanceof Error ? error.message : "参考答案播放失败。")); });
        speakButton.setAttribute("aria-label", `播放参考答案 ${index + 1}`);
        referenceNode.append(item);
      });
    } else {
      current.turns.forEach((turn) => {
        const item = document.createElement("article");
        item.className = "exam-reference-line";
        addText(item, "span", "exam-reference-label", `Speaker ${turn.role}`);
        addText(item, "p", "exam-reference-text", turn.text);
        const speakButton = addExamButton(item, "听台词", "speak-button", () => { void speakText(turn).catch((error) => setError(error instanceof Error ? error.message : "参考台词播放失败。")); });
        referenceNode.append(item);
      });
    }
  }

  function toggleReference() {
    const current = unit();
    if (!current) return;
    revealed = !revealed;
    referenceToggle.setAttribute("aria-expanded", String(revealed));
    referenceNode.classList.toggle("hidden", !revealed);
    referenceToggle.textContent = revealed ? "隐藏参考内容" : current.kind === "part2" ? "查看参考台词" : "查看参考答案";
    if (revealed) {
      hintCounts = recordExamHint(hintCounts, current.id);
      renderReference();
    }
  }

  function renderResponseTranscript(record) {
    feedbackNode.replaceChildren();
    if (record?.transcript) {
      renderAttemptResult(feedbackNode, record, record.status === "scored" ? "首次回答 · 计入正式成绩" : "首次回答 · 评分未完成", false);
    }
    const attempts = practiceAttempts.get(record?.responseId) ?? [];
    attempts.forEach((attempt, index) => {
      renderAttemptResult(feedbackNode, attempt, `练习重答 ${index + 1} · 不计入成绩`, true);
    });
  }

  function renderAttemptResult(parent, record, label, isPractice) {
    const panel = document.createElement("section");
    panel.className = `exam-transcript-panel${isPractice ? " exam-practice-attempt" : ""}`;
    addText(panel, "b", "exam-attempt-label", label);
    if (record.transcript) addText(panel, "p", "exam-transcript", record.transcript);
    else addText(panel, "p", "exam-attempt-pending", record.status === "recording" ? "正在录音…" : "等待回答识别");
    if (record.status === "scored" && record.scores) {
      const scoreGrid = document.createElement("div");
      scoreGrid.className = "exam-score-grid";
      const labels = { relevance: "切题度", completeness: "信息完整度", grammar: "语法", vocabulary: "词汇" };
      for (const key of ["relevance", "completeness", "grammar", "vocabulary"]) {
        const score = record.scores[key];
        const tile = document.createElement("div");
        const isPerfect = score.score === 5;
        tile.className = `exam-score-tile${isPerfect ? " is-perfect-dimension" : ""}`;
        addText(tile, "span", "exam-score-label", labels[key]);
        addText(tile, "strong", "exam-score-value", `${score.score} / 5`);
        if (isPerfect) addText(tile, "span", "exam-score-honor", "单项满分");
        addText(tile, "small", "exam-score-feedback", score.feedback);
        scoreGrid.append(tile);
      }
      panel.append(scoreGrid);
      const isPerfect = record.scores.total === 20;
      const total = document.createElement("div");
      total.className = `exam-total-score${isPerfect ? " is-perfect-total" : ""}`;
      addText(total, "span", "exam-total-label", isPractice ? "重答参考分 · 不计入成绩" : isPerfect ? "完美表现" : "本题总分");
      addText(total, "strong", "exam-total-value", `${record.scores.total} / 20`);
      panel.append(total);
    } else if (record.status === "unscored" && record.transcript) {
      addText(panel, "p", "exam-attempt-pending", "转写已保留 · 评分未完成");
    }
    parent.append(panel);
  }

  function displayStudentPrompt(current, turnIndex) {
    const responseId = responseIdFor(current, turnIndex);
    const record = responseRecords.get(responseId);
    if (pendingScoreTarget && pendingScoreTarget.responseId !== responseId) pendingScoreTarget = null;
    currentResponseId = responseId;
    if (current.kind === "part1") {
      const question = getPart1PromptDisplay(current.question);
      currentQuestion = question.audioTurn.text;
      currentReference = current.answers[0].text;
      addText(contentNode, "p", "exam-instruction", "请听问题，然后用英语回答。问题文字会保持隐藏。你可以重播问题，再开始录音。 ");
      const replay = addExamButton(contentNode, "重播问题", "cache-button secondary", () => { void playPart1Question(current, true); });
      replay.dataset.action = "replay-question";
    } else {
      const turn = current.turns[turnIndex];
      const computerTurnsBefore = current.openingSpeaker === "computer" ? current.turns.slice(0, sequenceIndex + 1) : current.turns.slice(0, turnIndex);
      const conversationCue = computerTurnsBefore.filter((candidate) => candidate.role !== turn.role).map((candidate) => `Speaker ${candidate.role}: ${candidate.text}`).join("\n");
      currentQuestion = [current.group.context, `中文提示：${getPart2StudentPrompt(turn)}`, conversationCue].filter(Boolean).join("\n");
      currentReference = turn.text;
      addText(contentNode, "p", "exam-scene", current.group.context || `情景 ${current.group.number}`);
      addText(contentNode, "span", "exam-speaker-label", `轮到你 · Speaker ${turn.role}`);
      addText(contentNode, "p", "exam-chinese-prompt", getPart2StudentPrompt(turn));
      addText(contentNode, "p", "exam-instruction", "请根据中文提示，用英语继续对话。 ");
    }
    referenceToggle.classList.remove("hidden");
    renderResponseTranscript(record);
    if (record?.status === "scored") {
      continueButton.classList.remove("hidden");
      continueButton.textContent = isLastStudentAction(current) ? "下一题" : "继续对话";
      rerecordScoreButton.classList.remove("hidden");
      rerecordScoreButton.disabled = false;
      rerecordScoreButton.textContent = "重新作答并评估";
      setStatus("首次成绩已保留 · 可重新作答练习，重答成绩不计入结算");
    } else if (record?.transcript && record.status === "unscored") {
      retryScoreButton.classList.remove("hidden");
      rerecordScoreButton.classList.remove("hidden");
      rerecordScoreButton.textContent = "重新录音并评分";
      recordButton.classList.add("hidden");
      setStatus("转写已保留，评分暂时失败；可以重试评分或重新录音。");
    } else {
      recordButton.classList.remove("hidden");
      recordButton.disabled = current.kind === "part1";
      setStatus("准备就绪 · 点击开始录音后才会请求麦克风");
    }
  }

  function isLastStudentAction(current) {
    return current.kind === "part1" || sequenceIndex >= part2Actions(current).length - 1;
  }

  function part2Actions(current) {
    return current.openingSpeaker === "computer"
      ? [{ type: "computer", turnIndex: 0 }, { type: "student", turnIndex: 1 }, { type: "computer", turnIndex: 2 }]
      : [{ type: "student", turnIndex: 0 }, { type: "computer", turnIndex: 1 }, { type: "student", turnIndex: 2 }];
  }

  async function playPart1Question(current, replay = false) {
    if (unit()?.id !== current.id) return;
    const display = getPart1PromptDisplay(current.question);
    const examId = activeExamId;
    const responseId = responseIdFor(current, 0);
    const playbackId = ++questionPlaybackId;
    recordButton.disabled = true;
    try {
      setStatus(replay ? "正在重播问题…" : "正在播放问题…");
      await speakText(display.audioTurn);
      if (playbackId === questionPlaybackId && isCurrent(examId, responseId) && unit()?.id === current.id) {
        setStatus("问题播放完毕 · 可以开始录音");
      }
    } catch (error) {
      if (playbackId === questionPlaybackId && isCurrent(examId, responseId) && unit()?.id === current.id) {
        setError(error instanceof Error ? error.message : "问题播放失败，可重试播放。题目文字保持隐藏。");
        setStatus("问题播放失败 · 可重试播放或继续录音");
      }
    } finally {
      if (playbackId === questionPlaybackId && isCurrent(examId, responseId) && unit()?.id === current.id) {
        const record = responseRecords.get(responseId);
        recordButton.disabled = Boolean(record && record.status !== "unanswered");
      }
    }
  }

  async function playComputerTurn(current, action) {
    const examId = activeExamId;
    const actionToken = `${current.id}:${sequenceIndex}`;
    const responseId = `${current.id}-computer-${action.turnIndex}`;
    currentResponseId = responseId;
    addText(contentNode, "p", "exam-scene", current.group.context || `情景 ${current.group.number}`);
    referenceToggle.classList.remove("hidden");
    referenceToggle.textContent = "查看参考台词";
    const placeholder = document.createElement("p");
    placeholder.className = "exam-instruction";
    placeholder.textContent = "电脑正在说话，请听完后再继续。";
    contentNode.append(placeholder);
    const controls = document.createElement("div");
    controls.className = "exam-inline-actions";
    const replay = addExamButton(controls, "重播电脑台词", "cache-button secondary", () => { void retryComputerTurn(current, action, placeholder, controls); });
    replay.disabled = true;
    contentNode.append(controls);
    recordButton.classList.add("hidden");
    setStatus("正在播放电脑台词…");
    try {
      await speakText(current.turns[action.turnIndex]);
      if (!isCurrent(examId, responseId) || unit()?.id !== current.id || `${current.id}:${sequenceIndex}` !== actionToken) return;
      sequenceIndex += 1;
      showCurrentUnit();
    } catch (error) {
      if (!isCurrent(examId, responseId) || unit()?.id !== current.id) return;
      setError(error instanceof Error ? error.message : "电脑台词播放失败。");
      setStatus("电脑台词没有播放完成。可以重播，或跳过这句后继续。");
      replay.disabled = false;
      addExamButton(controls, "跳过这句", "quiet-button", () => {
        if (unit()?.id !== current.id) return;
        sequenceIndex += 1;
        showCurrentUnit();
      });
    }
  }

  async function retryComputerTurn(current, action, placeholder, controls) {
    const examId = activeExamId;
    const actionToken = `${current.id}:${sequenceIndex}`;
    const responseId = `${current.id}-computer-${action.turnIndex}`;
    placeholder.textContent = "正在重播电脑台词…";
    controls.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    setError("");
    try {
      await speakText(current.turns[action.turnIndex]);
      if (isCurrent(examId, responseId) && unit()?.id === current.id && `${current.id}:${sequenceIndex}` === actionToken) {
        sequenceIndex += 1;
        showCurrentUnit();
      }
    } catch (error) {
      if (!isCurrent(examId, responseId) || unit()?.id !== current.id) return;
      placeholder.textContent = "电脑台词仍未播放成功。";
      setError(error instanceof Error ? error.message : "电脑台词播放失败。");
      controls.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    }
  }

  function showCurrentUnit() {
    if (disposed || !activeExamId || !plan) return;
    const current = unit();
    if (!current) return finishExam();
    clearExamView();
    stageNode.textContent = SECTION_NAMES[current.sectionId];
    progressNode.textContent = `第 ${stagePosition()} / ${stageTotal()} 题`;
    if (current.kind === "part1") {
      currentResponseId = responseIdFor(current, 0);
      displayStudentPrompt(current, 0);
      void playPart1Question(current);
      return;
    }
    const actions = part2Actions(current);
    const action = actions[sequenceIndex];
    if (!action) {
      unitIndex += 1;
      sequenceIndex = 0;
      return showCurrentUnit();
    }
    if (action.type === "computer") void playComputerTurn(current, action);
    else displayStudentPrompt(current, action.turnIndex);
  }

  function getAnswerRecord(responseId, attemptId = null) {
    if (!attemptId) return responseRecords.get(responseId);
    return (practiceAttempts.get(responseId) ?? []).find((attempt) => attempt.attemptId === attemptId);
  }

  function setAnswerRecord(responseId, nextRecord, attemptId = null) {
    if (!attemptId) {
      responseRecords.set(responseId, nextRecord);
      return;
    }
    const attempts = practiceAttempts.get(responseId) ?? [];
    const index = attempts.findIndex((attempt) => attempt.attemptId === attemptId);
    if (index >= 0) attempts[index] = nextRecord;
    else attempts.push(nextRecord);
    practiceAttempts.set(responseId, attempts);
  }

  function removePracticeAttempt(responseId, attemptId) {
    if (!attemptId) return;
    const attempts = (practiceAttempts.get(responseId) ?? []).filter((attempt) => attempt.attemptId !== attemptId);
    if (attempts.length) practiceAttempts.set(responseId, attempts);
    else practiceAttempts.delete(responseId);
  }

  async function beginRecording({ practice = false } = {}) {
    if (!activeExamId || !currentResponseId || recordingSession || !unit()) return;
    primeScoreAudio();
    const examId = activeExamId;
    const responseId = currentResponseId;
    const officialRecord = responseRecords.get(responseId);
    const attemptId = practice ? (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`) : null;
    setError("");
    recordButton.disabled = true;
    retryScoreButton.disabled = true;
    rerecordScoreButton.disabled = true;
    retryScoreButton.classList.add("hidden");
    rerecordScoreButton.classList.add("hidden");
    skipScoreButton?.classList.add("hidden");
    continueButton.classList.add("hidden");
    setStatus("正在请求麦克风权限…");
    try {
      const session = await startRecording({
        maxDurationMs: 120_000,
        onAutoStop: () => { if (isCurrent(examId, responseId)) setStatus("已录满 120 秒，正在结束录音并识别…"); },
      });
      if (!isCurrent(examId, responseId)) {
        await session.cancel();
        return;
      }
      const target = { responseId, attemptId };
      recordingTarget = target;
      if (attemptId) {
        setAnswerRecord(responseId, { responseId, attemptId, status: "recording", transcript: "" }, attemptId);
        renderResponseTranscript(officialRecord);
      }
      recordingSession = session;
      recordButton.classList.add("hidden");
      stopButton.classList.remove("hidden");
      stopButton.disabled = false;
      setStatus("正在录音 · 最长 120 秒 · 录音仅在本机处理");
      session.completion.then((blob) => {
        if (blob && isCurrent(examId, responseId)) void transcribeAnswer(blob, examId, responseId, attemptId);
        else if (isCurrent(examId, responseId)) {
          removePracticeAttempt(responseId, attemptId);
          renderResponseTranscript(responseRecords.get(responseId));
          restoreAnswerActions(responseId, attemptId);
        }
      }).catch((error) => {
        if (isCurrent(examId, responseId)) {
          removePracticeAttempt(responseId, attemptId);
          renderResponseTranscript(responseRecords.get(responseId));
          setError(error instanceof Error ? error.message : "录音转换失败，请重试。");
          setStatus("录音失败 · 可重新录音");
          restoreAnswerActions(responseId, attemptId);
        }
      }).finally(() => {
        if (recordingSession === session) {
          recordingSession = null;
          if (recordingTarget === target) recordingTarget = null;
        }
      });
    } catch (error) {
      if (isCurrent(examId, responseId)) {
        setError(error instanceof Error ? error.message : "无法开始录音。请检查浏览器麦克风权限和设备。");
        setStatus("麦克风不可用 · 当前题目未改变");
        restoreAnswerActions(responseId, attemptId);
      }
    }
  }

  async function stopRecording() {
    if (!recordingSession) return;
    const examId = activeExamId;
    const target = recordingTarget ?? { responseId: currentResponseId, attemptId: null };
    stopButton.disabled = true;
    setStatus("正在结束录音并准备本机识别…");
    try { await recordingSession.stop(); }
    catch (error) {
      if (!isCurrent(examId, target.responseId)) return;
      setError(error instanceof Error ? error.message : "录音处理失败，请重试。");
      restoreAnswerActions(target.responseId, target.attemptId);
    }
  }

  async function cancelRecording() {
    const session = recordingSession;
    recordingSession = null;
    recordingTarget = null;
    if (session) await session.cancel().catch(() => {});
  }

  async function transcribeAnswer(blob, examId, responseId, attemptId = null) {
    if (!isCurrent(examId, responseId)) return;
    const record = getAnswerRecord(responseId, attemptId);
    if (!record) return;
    stopButton.classList.add("hidden");
    recordButton.classList.add("hidden");
    setStatus("正在本机转写英文回答…");
    try {
      const response = await fetch("/api/exam/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: blob });
      const result = await response.json();
      if (!isCurrent(examId, responseId)) return;
      if (!response.ok) throw new Error(result.error ?? "本机语音识别失败，请重新录音。");
      if (typeof result.transcript !== "string" || !result.transcript.trim()) throw new Error("没有识别到英文回答，请重新录音。");
      const nextRecord = { ...record, transcript: result.transcript.trim(), status: "unscored" };
      setAnswerRecord(responseId, nextRecord, attemptId);
      renderResponseTranscript(responseRecords.get(responseId));
      setStatus("转写完成 · 正在本机语义评分…");
      await scoreAnswer(examId, responseId, attemptId);
    } catch (error) {
      if (!isCurrent(examId, responseId)) return;
      removePracticeAttempt(responseId, attemptId);
      renderResponseTranscript(responseRecords.get(responseId));
      setError(error instanceof Error ? error.message : "本机转写失败，请重新录音。");
      setStatus("识别失败 · 当前题未前进，可重新录音");
      restoreAnswerActions(responseId, attemptId);
    }
  }

  async function scoreAnswer(examId, responseId, attemptId = null) {
    const record = getAnswerRecord(responseId, attemptId);
    if (!record?.transcript || !isCurrent(examId, responseId)) return;
    setError("");
    retryScoreButton.disabled = true;
    rerecordScoreButton.disabled = true;
    retryScoreButton.classList.add("hidden");
    rerecordScoreButton.classList.add("hidden");
    skipScoreButton?.classList.add("hidden");
    continueButton.classList.add("hidden");
    setStatus("正在本机语义评分…");
    try {
      const response = await fetch("/api/exam/score", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: currentQuestion, reference: currentReference, transcript: record.transcript }),
      });
      const scores = await response.json();
      if (!isCurrent(examId, responseId)) return;
      if (!response.ok) throw new Error(formatScoringError(scores));
      const nextRecord = { ...record, status: "scored", scores };
      setAnswerRecord(responseId, nextRecord, attemptId);
      pendingScoreTarget = null;
      renderResponseTranscript(responseRecords.get(responseId));
      if (!attemptId && scores.total === 20) playPerfectScoreSound();
      retryScoreButton.classList.add("hidden");
      rerecordScoreButton.classList.remove("hidden");
      rerecordScoreButton.textContent = "重新作答并评估";
      skipScoreButton?.classList.add("hidden");
      continueButton.classList.remove("hidden");
      continueButton.textContent = isLastStudentAction(unit()) ? "下一题" : "继续对话";
      setStatus(attemptId
        ? "重答评估完成 · 结果仅供练习，不计入模拟考成绩"
        : scores.total === 20 ? "本题满分 20 / 20 · 首次评分已计入本次成绩" : "首次评分完成 · 可重新作答练习，重答不计入成绩");
    } catch (error) {
      if (!isCurrent(examId, responseId)) return;
      const nextRecord = { ...record, status: "unscored" };
      setAnswerRecord(responseId, nextRecord, attemptId);
      pendingScoreTarget = { responseId, attemptId };
      renderResponseTranscript(responseRecords.get(responseId));
      retryScoreButton.classList.remove("hidden");
      rerecordScoreButton.classList.remove("hidden");
      rerecordScoreButton.textContent = responseRecords.get(responseId)?.status === "scored" ? "重新作答并评估" : "重新录音并评分";
      retryScoreButton.disabled = false;
      rerecordScoreButton.disabled = false;
      if (skipScoreButton && !attemptId && responseRecords.get(responseId)?.status !== "scored") {
        skipScoreButton.textContent = unit()?.kind === "part2" ? "跳过评分，继续对话" : "跳过评分，下一题";
        skipScoreButton.classList.remove("hidden");
      }
      if (responseRecords.get(responseId)?.status === "scored") {
        continueButton.classList.remove("hidden");
        continueButton.textContent = isLastStudentAction(unit()) ? "下一题" : "继续对话";
      }
      setError(error instanceof Error ? error.message : "本机评分失败，可保留转写后重试评分或重新录音。");
      setStatus(attemptId ? "重答评分未完成 · 首次成绩已保留，可重试评分、重新作答或继续" : "评分未完成 · 已保留转写，可重试评分或重新录音");
    } finally {
      retryScoreButton.disabled = false;
      rerecordScoreButton.disabled = false;
    }
  }

  function retryScore() {
    const target = pendingScoreTarget;
    if (!target || target.responseId !== currentResponseId) return;
    void scoreAnswer(activeExamId, target.responseId, target.attemptId);
  }

  async function continueExam() {
    const current = unit();
    if (!current) return finishExam();
    const record = responseRecords.get(currentResponseId);
    if (record?.status !== "scored") return;
    await cancelRecording();
    if (current.kind === "part1") {
      unitIndex += 1;
      sequenceIndex = 0;
    } else {
      sequenceIndex += 1;
    }
    showCurrentUnit();
  }

  async function skipUnscoredResponse() {
    const current = unit();
    const record = responseRecords.get(currentResponseId);
    if (!current || record?.status !== "unscored" || !record.transcript) return;
    await cancelRecording();
    if (current.kind === "part1") {
      unitIndex += 1;
      sequenceIndex = 0;
    } else {
      sequenceIndex += 1;
    }
    showCurrentUnit();
  }

  async function finishExam() {
    if (!activeExamId || !plan) return;
    await cancelRecording();
    stopSpeech();
    const summary = summarizeExam(plan.units, [...responseRecords.values()], hintCounts);
    activeExamId = "";
    onExamEnd();
    currentResponseId = "";
    exitExamMode();
    sessionPanel.classList.add("hidden");
    practicePanel.classList.remove("hidden");
    renderSummary(summary);
    summaryPanel.classList.remove("hidden");
    summaryPanel.showModal();
    viewSummaryButton.classList.remove("hidden");
    startButton.classList.remove("hidden");
    startButton.textContent = "再考一次";
    renderAvailability();
  }

  function renderSummary(summary) {
    summaryPanel.replaceChildren();
    summarySoundButton = null;
    const heading = document.createElement("header");
    heading.className = "exam-summary-heading";
    const copy = document.createElement("div");
    copy.className = "exam-summary-heading-copy";
    addText(copy, "h3", "", "本次模拟考结果").id = "exam-summary-title";
    addText(copy, "p", "", `已评分 ${summary.scoredCount} 题 · 未完成 ${summary.uncompletedCount} 题 · 查看提示 ${summary.hintCount} 次`).id = "exam-summary-meta";
    addText(copy, "p", "exam-summary-date", `完成时间：${new Intl.DateTimeFormat("zh-Hans", { dateStyle: "medium", timeStyle: "short" }).format(new Date())}`);
    const actions = document.createElement("div");
    actions.className = "exam-summary-actions";
    summarySoundButton = addExamButton(actions, "", "quiet-button exam-sound-toggle", toggleScoreSound);
    summarySoundButton.setAttribute("aria-pressed", String(scoreSoundEnabled));
    syncScoreSoundButtons();
    addExamButton(actions, "保存为 PDF", "cache-button", () => window.print()).title = "在打印窗口中选择‘存储为 PDF’";
    addExamButton(actions, "关闭", "quiet-button", () => summaryPanel.close()).setAttribute("aria-label", "关闭成绩面板");
    heading.append(copy, actions);
    summaryPanel.append(heading);
    const overview = document.createElement("section");
    overview.className = "exam-summary-overview";
    addText(overview, "h4", "", "成绩简报");
    const overviewCards = document.createElement("div");
    overviewCards.className = "exam-summary-overview-cards";
    for (const sectionId of ["phase1", "phase2", "part2"]) {
      const data = summary.bySection[sectionId];
      const card = document.createElement("article");
      card.className = "exam-summary-overview-card";
      addText(card, "span", "exam-summary-overview-label", SECTION_NAMES[sectionId]);
      addText(card, "strong", "exam-summary-overview-score", `${formatAverage(data.averages.total)} / 20`);
      addText(card, "span", "exam-summary-overview-meta", `已评分 ${data.scoredCount} · 未完成 ${data.uncompletedCount} · 提示 ${data.hintCount} 次`);
      overviewCards.append(card);
    }
    overview.append(overviewCards);
    summaryPanel.append(overview);
    for (const sectionId of ["phase1", "phase2", "part2"]) {
      const section = document.createElement("section");
      section.className = "exam-summary-section";
      const data = summary.bySection[sectionId];
      const averages = data.averages;
      addText(section, "h4", "", SECTION_NAMES[sectionId]);
      addText(section, "p", "exam-summary-stats", `已评分 ${data.scoredCount} · 未完成 ${data.uncompletedCount} · 提示 ${data.hintCount} 次`);
      addText(section, "p", "exam-summary-averages", `平均分：切题 ${formatAverage(averages.relevance)} · 完整 ${formatAverage(averages.completeness)} · 语法 ${formatAverage(averages.grammar)} · 词汇 ${formatAverage(averages.vocabulary)} · 总分 ${formatAverage(averages.total)} / 20`);
      const items = document.createElement("div");
      items.className = "exam-summary-items";
      for (const record of [...responseRecords.values()].filter((item) => item.sectionId === sectionId)) {
        const row = document.createElement("article");
        row.className = "exam-summary-item";
        const questionUnit = plan?.units.find((item) => item.id === record.unitId);
        const number = (plan?.units.filter((item) => item.sectionId === sectionId).findIndex((item) => item.id === record.unitId) ?? -1) + 1;
        const speaker = questionUnit?.kind === "part2"
          ? ` · Speaker ${questionUnit.turns[record.turnIndex]?.role} · 对话第 ${record.turnIndex + 1} 轮`
          : "";
        const itemHeading = document.createElement("div");
        itemHeading.className = "exam-summary-item-heading";
        addText(itemHeading, "b", "", `第 ${number} 题${speaker}`);
        if (record.status === "scored" && record.scores) {
          const isPerfect = record.scores.total === 20;
          if (isPerfect) row.classList.add("is-perfect");
          const score = addText(itemHeading, "span", `exam-summary-score${isPerfect ? " is-perfect-total" : ""}`, `${record.scores.total} / 20`);
          score.setAttribute("aria-label", isPerfect ? "本题满分 20 分" : `本题 ${record.scores.total} 分，共 20 分`);
          if (isPerfect) addText(itemHeading, "span", "exam-score-honor", "满分");
        } else {
          addText(itemHeading, "span", "exam-summary-unscored", record.transcript ? "已作答 · 未评分" : "未作答");
        }
        row.append(itemHeading);
        if (questionUnit?.kind === "part1") {
          addText(row, "span", "exam-summary-detail-label", "问题");
          addText(row, "p", "exam-summary-prompt", questionUnit.question.text);
          if (questionUnit.question.translation) addText(row, "p", "exam-summary-translation", questionUnit.question.translation);
        } else if (questionUnit?.kind === "part2") {
          const turn = questionUnit.turns[record.turnIndex];
          if (questionUnit.group.context) {
            addText(row, "span", "exam-summary-detail-label", "情景");
            addText(row, "p", "exam-summary-context", questionUnit.group.context);
          }
          if (turn) {
            addText(row, "span", "exam-summary-detail-label", "你的提示");
            addText(row, "p", "exam-summary-prompt", getPart2StudentPrompt(turn));
          }
          const precedingTurns = questionUnit.turns.slice(0, record.turnIndex);
          if (precedingTurns.length) {
            addText(row, "span", "exam-summary-detail-label", "此前对话");
            addText(row, "p", "exam-summary-context", precedingTurns.map((item) => `Speaker ${item.role}: ${item.text}`).join("\n"));
          }
        }
        const officialAnswerLabel = record.status === "scored"
          ? "首次回答（语音转写 · 计入正式成绩）"
          : "首次回答（语音转写 · 未完成评分）";
        addText(row, "span", "exam-summary-detail-label", officialAnswerLabel);
        addText(row, "p", "exam-summary-answer", record.transcript || "本题未作答");
        if (record.status === "scored" && record.scores) {
          appendSummaryScores(row, record.scores);
        }
        const attempts = practiceAttempts.get(record.responseId) ?? [];
        if (attempts.length) {
          const attemptList = document.createElement("div");
          attemptList.className = "exam-summary-practice-list";
          attempts.forEach((attempt, index) => {
            const attemptRow = document.createElement("article");
            attemptRow.className = "exam-summary-practice-item";
            const attemptHeading = document.createElement("div");
            attemptHeading.className = "exam-summary-item-heading";
            addText(attemptHeading, "b", "", `练习重答 ${index + 1} · 不计入成绩`);
            if (attempt.status === "scored" && attempt.scores) {
              addText(attemptHeading, "span", "exam-summary-score", `${attempt.scores.total} / 20`);
            } else {
              addText(attemptHeading, "span", "exam-summary-unscored", attempt.transcript ? "已转写 · 未评分" : "未完成");
            }
            attemptRow.append(attemptHeading);
            addText(attemptRow, "span", "exam-summary-detail-label", "重答内容（语音转写）");
            addText(attemptRow, "p", "exam-summary-answer", attempt.transcript || "没有保留可供评估的转写");
            if (attempt.status === "scored" && attempt.scores) appendSummaryScores(attemptRow, attempt.scores);
            attemptList.append(attemptRow);
          });
          row.append(attemptList);
        }
        items.append(row);
      }
      section.append(items);
      summaryPanel.append(section);
    }
  }

  function formatAverage(value) {
    return value === null ? "—" : value.toFixed(1);
  }

  function appendSummaryScores(container, scores) {
    const feedbackList = document.createElement("div");
    feedbackList.className = "exam-summary-feedback-list";
    for (const [key, label] of [["relevance", "切题"], ["completeness", "完整"], ["grammar", "语法"], ["vocabulary", "词汇"]]) {
      const value = scores[key];
      const feedbackItem = document.createElement("div");
      feedbackItem.className = `exam-summary-feedback-item${value.score === 5 ? " is-perfect-dimension" : ""}`;
      const feedbackHeading = document.createElement("div");
      feedbackHeading.className = "exam-summary-feedback-heading";
      addText(feedbackHeading, "b", "", label);
      addText(feedbackHeading, "span", "exam-summary-feedback-score", `${value.score} / 5`);
      addText(feedbackItem, "p", "exam-summary-feedback-copy", value.feedback);
      feedbackItem.prepend(feedbackHeading);
      feedbackList.append(feedbackItem);
    }
    container.append(feedbackList);
  }

  startButton.addEventListener("click", beginExam);
  viewSummaryButton.addEventListener("click", () => {
    if (!summaryPanel.open) summaryPanel.showModal();
    syncScoreSoundButtons();
  });
  scoreSoundButton.addEventListener("click", toggleScoreSound);
  summaryPanel.addEventListener("click", (event) => {
    if (event.target === summaryPanel) summaryPanel.close();
  });
  summaryPanel.addEventListener("close", () => {
    if (!viewSummaryButton.classList.contains("hidden")) viewSummaryButton.focus();
  });
  recordButton.addEventListener("click", () => { void beginRecording(); });
  stopButton.addEventListener("click", () => { void stopRecording(); });
  continueButton.addEventListener("click", () => { void continueExam(); });
  endButton.addEventListener("click", () => { void finishExam(); });
  referenceToggle.addEventListener("click", toggleReference);
  retryScoreButton.addEventListener("click", retryScore);
  rerecordScoreButton.addEventListener("click", () => {
    const record = responseRecords.get(currentResponseId);
    void beginRecording({ practice: record?.status === "scored" });
  });
  skipScoreButton?.addEventListener("click", () => { void skipUnscoredResponse(); });

  renderAvailability();
  return {
    isActive() { return Boolean(activeExamId || startingExam); },
    refreshAvailability() { renderAvailability(); },
    resetForMaterialChange() {
      void cancelRecording();
      if (summaryPanel.open) summaryPanel.close();
      activeExamId = "";
      onExamEnd();
      plan = null;
      unitIndex = 0;
      sequenceIndex = 0;
      currentResponseId = "";
      responseRecords.clear();
      practiceAttempts.clear();
      hintCounts = {};
      pendingScoreTarget = null;
      exitExamMode();
      sessionPanel.classList.add("hidden");
      practicePanel.classList.remove("hidden");
      summaryPanel.classList.add("hidden");
      summaryPanel.replaceChildren();
      viewSummaryButton.classList.add("hidden");
      summarySoundButton = null;
      startButton.classList.remove("hidden");
      startButton.textContent = "开始模拟考";
      setError("");
      renderAvailability();
    },
    dispose() {
      disposed = true;
      stopSpeech();
      void cancelRecording();
      if (summaryPanel.open) summaryPanel.close();
      activeExamId = "";
      onExamEnd();
      responseRecords.clear();
      practiceAttempts.clear();
      hintCounts = {};
      pendingScoreTarget = null;
      exitExamMode();
      sessionPanel.classList.add("hidden");
      practicePanel.classList.remove("hidden");
      summaryPanel.classList.add("hidden");
      viewSummaryButton.classList.add("hidden");
      summarySoundButton = null;
      void scoreAudioContext?.close().catch(() => {});
      scoreAudioContext = null;
      renderAvailability();
    },
  };
}
