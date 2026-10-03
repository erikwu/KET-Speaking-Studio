import assert from "node:assert/strict";
import test from "node:test";
import { getPart1PromptDisplay, getPart2StudentPrompt, isExamResponseCurrent, shouldContinueExamPlayback } from "./exam-controller.ts";

const turn = { id: "phase1-1-1", role: "Q", voiceRole: "question", text: "What is your name?", translation: "你叫什么名字？" } as const;

test("getPart1PromptDisplay_hidesQuestionTextButKeepsAudioTurn", () => {
  const display = getPart1PromptDisplay(turn);
  assert.equal(display.visibleQuestion, "");
  assert.equal(display.audioTurn, turn);
});

test("getPart2StudentPrompt_usesTurnTranslation", () => {
  assert.equal(getPart2StudentPrompt(turn), "你叫什么名字？");
});

test("isExamResponseCurrent_rejectsLateResponseFromOldSessionOrPrompt", () => {
  assert.equal(isExamResponseCurrent("exam-a", "response-a", "exam-a", "response-a"), true);
  assert.equal(isExamResponseCurrent("exam-b", "response-a", "exam-a", "response-a"), false);
  assert.equal(isExamResponseCurrent("exam-a", "response-b", "exam-a", "response-a"), false);
});

test("shouldContinueExamPlayback_rejectsSupersededWaitForEndSpeech", () => {
  assert.equal(shouldContinueExamPlayback(true, true), true);
  assert.equal(shouldContinueExamPlayback(false, false), false);
  assert.throws(() => shouldContinueExamPlayback(false, true), /被另一句语音替换/);
});

test("installExamController_enablesRecordingOnlyAfterQuestionPlaybackSettles", async () => {
  class FakeElement {
    constructor() {
      this.disabled = false;
      this.textContent = "";
      this.dataset = {};
      this.children = [];
      this.listeners = new Map();
      this.attributes = new Map();
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle: (name, force) => {
          const next = force === undefined ? !classes.has(name) : force;
          if (next) classes.add(name);
          else classes.delete(name);
          return next;
        },
      };
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    querySelectorAll() { return []; }
    click() { if (!this.disabled) this.listeners.get("click")?.({ currentTarget: this }); }
  }

  const ids = [
    "practice-card", "exam-view-summary", "exam-score-sound", "exam-rerecord-score",
    "exam-start", "exam-availability", "exam-panel", "exam-summary", "exam-content", "exam-stage",
    "exam-progress", "exam-status", "exam-error", "exam-feedback", "exam-reference-toggle",
    "exam-reference", "exam-record", "exam-stop", "exam-continue", "exam-end", "exam-retry-score",
  ];
  const elements = new Map(ids.map((id) => [`#${id}`, new FakeElement()]));
  const previousDocument = globalThis.document;
  globalThis.document = {
    querySelector: (selector) => elements.get(selector),
    createElement: () => new FakeElement(),
  };

  let finishPlayback;
  const playback = new Promise((resolve) => { finishPlayback = resolve; });
  const sections = [
    { id: "phase1", title: "Phase 1", groups: [{ id: "p1-1", number: 1, context: "", turns: [
      { ...turn, role: "Q", voiceRole: "question" }, { ...turn, id: "p1-a", role: "A", voiceRole: "answer" },
    ] }] },
    { id: "phase2", title: "Phase 2", groups: [{ id: "p2-1", number: 1, context: "", turns: [
      { ...turn, id: "p2-q", role: "Q", voiceRole: "question" }, { ...turn, id: "p2-a", role: "A", voiceRole: "answer" },
    ] }] },
    { id: "part2", title: "Part 2", groups: [{ id: "p3-1", number: 1, context: "A shop", turns: [
      { ...turn, id: "p3-a1", role: "A", voiceRole: "answer" },
      { ...turn, id: "p3-b", role: "B", voiceRole: "answer" },
      { ...turn, id: "p3-a2", role: "A", voiceRole: "answer" },
    ] }] },
  ];
  expandExamFixtures(sections);

  try {
    const { installExamController } = await import("./exam-controller.ts");
    const controller = installExamController({
      getSections: () => sections,
      getExamAvailability: () => ({ available: true, reason: "" }),
      speakText: () => playback,
    });
    elements.get("#exam-start").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(elements.get("#practice-card").classList.contains("hidden"), true);
    const recordButton = elements.get("#exam-record");
    assert.equal(recordButton.classList.contains("hidden"), false);
    assert.equal(recordButton.disabled, true);

    finishPlayback();
    await playback;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recordButton.disabled, false);
    controller.resetForMaterialChange();
    assert.equal(elements.get("#practice-card").classList.contains("hidden"), false);
    controller.dispose();
  } finally {
    globalThis.document = previousDocument;
  }
});

test("installExamController_ignoresStopFailureFromPreviousExam", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  class FakeElement {
    constructor() {
      this.disabled = false; this.textContent = ""; this.dataset = {}; this.children = []; this.listeners = new Map(); this.attributes = new Map();
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle: (name, force) => { const next = force === undefined ? !classes.has(name) : force; if (next) classes.add(name); else classes.delete(name); return next; },
      };
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    querySelectorAll() { return []; }
    click() { if (!this.disabled) this.listeners.get("click")?.({ currentTarget: this }); }
  }
  const ids = ["practice-card", "exam-view-summary", "exam-score-sound", "exam-rerecord-score", "exam-start", "exam-availability", "exam-panel", "exam-summary", "exam-content", "exam-stage", "exam-progress", "exam-status", "exam-error", "exam-feedback", "exam-reference-toggle", "exam-reference", "exam-record", "exam-stop", "exam-continue", "exam-end", "exam-retry-score"];
  const elements = new Map(ids.map((id) => [`#${id}`, new FakeElement()]));
  const previousDocument = globalThis.document;
  globalThis.document = { querySelector: (selector) => elements.get(selector), createElement: () => new FakeElement() };
  let rejectStop;
  let stopStarted;
  const stopped = new Promise((resolve) => { stopStarted = resolve; });
  const sections = [
    { id: "phase1", title: "Phase 1", groups: [{ id: "p1", number: 1, context: "", turns: [{ ...turn, role: "Q", voiceRole: "question" }, { ...turn, id: "a", role: "A", voiceRole: "answer" }] }] },
    { id: "phase2", title: "Phase 2", groups: [{ id: "p2", number: 1, context: "", turns: [{ ...turn, role: "Q", voiceRole: "question" }, { ...turn, id: "a2", role: "A", voiceRole: "answer" }] }] },
    { id: "part2", title: "Part 2", groups: [{ id: "p3", number: 1, context: "A shop", turns: [{ ...turn, role: "A", voiceRole: "answer" }, { ...turn, id: "b", role: "B", voiceRole: "answer" }, { ...turn, id: "a3", role: "A", voiceRole: "answer" }] }] },
  ];
  expandExamFixtures(sections);
  try {
    const { installExamController } = await import("./exam-controller.ts");
    const controller = installExamController({
      getSections: () => sections,
      getExamAvailability: () => ({ available: true, reason: "" }),
      speakText: async () => {},
      startRecording: async () => ({ completion: new Promise(() => {}), stop: () => { stopStarted(); return new Promise((_, reject) => { rejectStop = reject; }); }, cancel: async () => {} }),
    });
    elements.get("#exam-start").click();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    elements.get("#exam-record").click();
    await new Promise((resolve) => setImmediate(resolve));
    elements.get("#exam-stop").click();
    await stopped;
    controller.resetForMaterialChange();
    rejectStop(new Error("旧录音失败"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(elements.get("#exam-error").classList.contains("hidden"), true);
    controller.dispose();
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

function expandExamFixtures(sections) {
  for (const section of sections) {
    const group = section.groups[0];
    section.groups = Array.from({ length: section.id === "part2" ? 3 : 8 }, (_, index) => ({
      ...group, id: `${section.id}-${index}`, number: index + 1,
      turns: group.turns.map((turn, turnIndex) => ({ ...turn, id: `${section.id}-${index}-${turnIndex}` })),
    }));
  }
}
