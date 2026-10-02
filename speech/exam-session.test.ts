import assert from "node:assert/strict";
import test from "node:test";
import { buildExamPlan, recordExamHint, summarizeExam } from "./exam-session.ts";

const turn = (id: string, role: "Q" | "A" | "B", text: string, translation = "中文提示") => ({
  id, role, voiceRole: role === "Q" ? "question" as const : "answer" as const, text, translation,
});
const group = (id: string, turns: ReturnType<typeof turn>[]) => ({ id, number: 1, context: "At the park", turns });
const section = (id: "phase1" | "phase2" | "part2", groups: ReturnType<typeof group>[]) => ({ id, title: id, groups });
const validSections = () => [
  section("part2", [group("p2-good", [turn("a1", "A", "I like parks."), turn("b1", "B", "What can you see?"), turn("a2", "A", "I can see a swing.")])]),
  section("phase2", [group("p1b", [turn("q2", "Q", "What do you like?"), turn("a2p1", "A", "I like music.")])]),
  section("phase1", [group("p1a", [turn("q1", "Q", "What is your name?"), turn("a1p1", "A", "My name is Ada.")])]),
];

test("buildExamPlan_returnsCompletePartsInFixedOrder", () => {
  const plan = buildExamPlan(validSections(), () => 0);
  assert.deepEqual(plan.units.map((unit) => unit.sectionId), ["phase1", "phase2", "part2"]);
  assert.equal(plan.units[0].kind, "part1");
  if (plan.units[0].kind !== "part1") assert.fail("first unit should be Part 1");
  assert.equal(plan.units[0].answers[0].id, "a1p1");
  assert.deepEqual(plan.missingSections, []);
});

test("buildExamPlan_skipsMalformedGroupsAndReportsMissingSections", () => {
  const plan = buildExamPlan([
    section("phase1", [group("no-answer", [turn("q", "Q", "Question?")])]),
    section("phase2", [group("no-question", [turn("a", "A", "Answer")])]),
    section("part2", [
      group("wrong-order", [turn("a1", "A", "One"), turn("a2", "A", "Two"), turn("b", "B", "Three")]),
      group("no-translation", [turn("a3", "A", "One", "提示"), turn("b2", "B", "Two", ""), turn("a4", "A", "Three", "提示")]),
    ]),
  ]);
  assert.deepEqual(plan.units, []);
  assert.deepEqual(plan.missingSections, ["phase1", "phase2", "part2"]);
  assert.deepEqual(plan.skippedCounts, { phase1: 1, phase2: 1, part2: 2 });
});

test("buildExamPlan_randomizesEachPart2StartOnce", () => {
  const values = [0.1, 0.9];
  let calls = 0;
  const sections = [section("part2", [
    group("first", [turn("a1", "A", "One"), turn("b1", "B", "Two"), turn("a2", "A", "Three")]),
    group("second", [turn("a3", "A", "Four"), turn("b2", "B", "Five"), turn("a4", "A", "Six")]),
  ])];
  const plan = buildExamPlan(sections, () => values[calls++]);
  assert.equal(calls, 2);
  assert.deepEqual(plan.units.map((unit) => unit.kind === "part2" ? [unit.openingSpeaker, unit.studentTurnIndexes] : null), [
    ["computer", [1]], ["student", [0, 2]],
  ]);
});

test("recordExamHint_countsEachExplicitReveal", () => {
  const once = recordExamHint({}, "phase1-1");
  assert.deepEqual(recordExamHint(once, "phase1-1"), { "phase1-1": 2 });
});

test("summarizeExam_excludesUnscoredAndUnanswered", () => {
  const plan = buildExamPlan(validSections(), () => 0);
  const scores = { relevance: { score: 4, feedback: "切题" }, completeness: { score: 3, feedback: "补充细节" }, grammar: { score: 5, feedback: "很好" }, vocabulary: { score: 4, feedback: "很好" }, total: 16 };
  const summary = summarizeExam(plan.units, [
    { responseId: "r1", unitId: "p1a", sectionId: "phase1", status: "scored", scores },
    { responseId: "r2", unitId: "p1b", sectionId: "phase2", status: "unscored", transcript: "I like." },
    { responseId: "r3", unitId: "p2-good", sectionId: "part2", status: "unanswered" },
  ], { "p1a": 2 });
  assert.equal(summary.bySection.phase1.scoredCount, 1);
  assert.deepEqual(summary.bySection.phase1.averages, {
    relevance: 4,
    completeness: 3,
    grammar: 5,
    vocabulary: 4,
    total: 16,
  });
  assert.equal(summary.bySection.phase1.hintCount, 2);
  assert.equal(summary.bySection.phase2.scoredCount, 0);
  assert.equal(summary.bySection.phase2.averages.total, null);
  assert.equal(summary.bySection.phase2.uncompletedCount, 1);
  assert.equal(summary.bySection.part2.uncompletedCount, 1);
});
