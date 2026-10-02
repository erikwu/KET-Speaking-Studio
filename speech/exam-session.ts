// @ts-check

/** @typedef {"phase1"|"phase2"|"part2"} ExamSectionId */
/** @typedef {{id:string,role:"Q"|"A"|"B",voiceRole:"question"|"answer",text:string,translation:string}} ExamTurn */
/** @typedef {{id:string,number:number,context:string,turns:ExamTurn[]}} ExamGroup */
/** @typedef {{id:ExamSectionId,title:string,groups:ExamGroup[]}} ExamSection */
/** @typedef {{score:number,feedback:string}} ExamDimensionScore */
/** @typedef {{relevance:ExamDimensionScore,completeness:ExamDimensionScore,grammar:ExamDimensionScore,vocabulary:ExamDimensionScore,total:number}} ExamScores */
/** @typedef {{responseId:string,unitId:string,sectionId:ExamSectionId,status:"scored"|"unscored"|"unanswered",transcript?:string,scores?:ExamScores}} ExamResult */
/** @typedef {{id:string,sectionId:"phase1"|"phase2",kind:"part1",group:ExamGroup,question:ExamTurn,answers:ExamTurn[]}} Part1ExamUnit */
/** @typedef {{id:string,sectionId:"part2",kind:"part2",group:ExamGroup,turns:[ExamTurn,ExamTurn,ExamTurn],openingSpeaker:"computer"|"student",studentTurnIndexes:[1]|[0,2]}} Part2ExamUnit */
/** @typedef {Part1ExamUnit|Part2ExamUnit} ExamUnit */
/** @typedef {{units:ExamUnit[],skippedCounts:Record<ExamSectionId,number>,missingSections:ExamSectionId[],insufficientSections:Partial<Record<ExamSectionId,{available:number,required:number}>>}} ExamPlan */
/** @typedef {{scoredCount:number,uncompletedCount:number,averages:Record<"relevance"|"completeness"|"grammar"|"vocabulary"|"total",number|null>,hintCount:number}} ExamSectionSummary */
/** @typedef {{bySection:Record<ExamSectionId,ExamSectionSummary>,scoredCount:number,uncompletedCount:number,hintCount:number}} ExamSummary */

const SECTION_ORDER = /** @type {const} */ (["phase1", "phase2", "part2"]);
const SCORE_FIELDS = /** @type {const} */ (["relevance", "completeness", "grammar", "vocabulary", "total"]);
const SECTION_QUESTION_LIMITS = /** @type {const} */ ({ phase1: 8, phase2: 8, part2: 3 });

/**
 * Pick a random subset and randomize its order without mutating the source list.
 * @template T
 * @param {T[]} items
 * @param {number} count
 * @param {() => number} random
 * @returns {T[]}
 */
function sampleWithoutReplacement(items, count, random) {
  const pool = [...items];
  const selectedCount = Math.min(count, pool.length);
  if (selectedCount < count) return pool;
  for (let index = 0; index < selectedCount; index += 1) {
    const remaining = pool.length - index;
    const offset = Math.min(remaining - 1, Math.max(0, Math.floor(random() * remaining)));
    const selectedIndex = index + offset;
    [pool[index], pool[selectedIndex]] = [pool[selectedIndex], pool[index]];
  }
  return pool.slice(0, selectedCount);
}

/**
 * Convert parser output into a randomized fixed-size mock-exam sequence.
 * Invalid groups are omitted and counted; each section is sampled independently.
 * @param {ExamSection[]} sections
 * @param {() => number} [random]
 * @returns {ExamPlan}
 */
export function buildExamPlan(sections, random = Math.random) {
  const sectionMap = new Map(sections.map((section) => [section.id, section]));
  /** @type {ExamUnit[]} */ const units = [];
  /** @type {Record<ExamSectionId, number>} */ const skippedCounts = { phase1: 0, phase2: 0, part2: 0 };
  /** @type {ExamSectionId[]} */ const missingSections = [];
  /** @type {Partial<Record<ExamSectionId, {available:number,required:number}>>} */ const insufficientSections = {};

  for (const sectionId of SECTION_ORDER) {
    const section = sectionMap.get(sectionId);
    /** @type {ExamGroup[]} */ const validGroups = [];
    for (const group of section?.groups ?? []) {
      if (sectionId === "part2") {
        const firstThree = group.turns.slice(0, 3);
        const isValid = firstThree.length === 3 &&
          firstThree[0].role === "A" && firstThree[1].role === "B" && firstThree[2].role === "A" &&
          firstThree.every((turn) => typeof turn.translation === "string" && turn.translation.trim().length > 0);
        if (!isValid) {
          skippedCounts.part2 += 1;
          continue;
        }
        validGroups.push(group);
      } else {
        const question = group.turns[0];
        const answers = group.turns.slice(1);
        const isValid = question?.role === "Q" && answers.length > 0 && answers.every((turn) => turn.role === "A");
        if (!isValid) {
          skippedCounts[sectionId] += 1;
          continue;
        }
        validGroups.push(group);
      }
    }
    if (!validGroups.length) missingSections.push(sectionId);
    const required = SECTION_QUESTION_LIMITS[sectionId];
    if (validGroups.length < required) {
      insufficientSections[sectionId] = { available: validGroups.length, required };
    }

    const sampledGroups = sampleWithoutReplacement(validGroups, required, random);
    for (const group of sampledGroups) {
      if (sectionId === "part2") {
        const firstThree = group.turns.slice(0, 3);
        const studentStarts = random() >= 0.5;
        /** @type {[ExamTurn, ExamTurn, ExamTurn]} */ const turns = /** @type {[ExamTurn, ExamTurn, ExamTurn]} */ (firstThree);
        units.push({
          id: group.id,
          sectionId: "part2",
          kind: "part2",
          group,
          turns,
          openingSpeaker: studentStarts ? "student" : "computer",
          studentTurnIndexes: studentStarts ? [0, 2] : [1],
        });
      } else {
        const question = group.turns[0];
        const answers = group.turns.slice(1);
        units.push({ id: group.id, sectionId, kind: "part1", group, question, answers });
      }
    }
  }

  return { units, skippedCounts, missingSections, insufficientSections };
}

/**
 * Record a single explicit reveal of a reference answer/script.
 * @param {Record<string, number>} counts
 * @param {string} unitId
 * @returns {Record<string, number>}
 */
export function recordExamHint(counts, unitId) {
  return { ...counts, [unitId]: (counts[unitId] ?? 0) + 1 };
}

/** @param {number} value */
function roundOneDecimal(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Summarize scored and unfinished student turns without treating missing marks as zero.
 * @param {ExamUnit[]} units
 * @param {ExamResult[]} results
 * @param {Record<string, number>} hintCounts
 * @returns {ExamSummary}
 */
export function summarizeExam(units, results, hintCounts) {
  /** @type {Record<ExamSectionId, {expected:number,scored:ExamResult[]}>} */
  const grouped = {
    phase1: { expected: 0, scored: [] },
    phase2: { expected: 0, scored: [] },
    part2: { expected: 0, scored: [] },
  };
  for (const unit of units) {
    grouped[unit.sectionId].expected += unit.kind === "part2" ? unit.studentTurnIndexes.length : 1;
  }
  for (const result of results) {
    if (result.status === "scored" && result.scores && result.sectionId in grouped) {
      grouped[result.sectionId].scored.push(result);
    }
  }

  /** @type {Record<ExamSectionId, ExamSectionSummary>} */ const bySection = {
    phase1: makeSectionSummary("phase1", grouped.phase1, units, hintCounts),
    phase2: makeSectionSummary("phase2", grouped.phase2, units, hintCounts),
    part2: makeSectionSummary("part2", grouped.part2, units, hintCounts),
  };
  return {
    bySection,
    scoredCount: Object.values(bySection).reduce((sum, value) => sum + value.scoredCount, 0),
    uncompletedCount: Object.values(bySection).reduce((sum, value) => sum + value.uncompletedCount, 0),
    hintCount: Object.values(bySection).reduce((sum, value) => sum + value.hintCount, 0),
  };
}

/**
 * @param {ExamSectionId} sectionId
 * @param {{expected:number,scored:ExamResult[]}} values
 * @param {ExamUnit[]} units
 * @param {Record<string, number>} hintCounts
 * @returns {ExamSectionSummary}
 */
function makeSectionSummary(sectionId, values, units, hintCounts) {
  /** @type {Record<"relevance"|"completeness"|"grammar"|"vocabulary"|"total",number|null>} */
  const averages = { relevance: null, completeness: null, grammar: null, vocabulary: null, total: null };
  for (const field of SCORE_FIELDS) {
    if (values.scored.length) {
      const total = values.scored.reduce((sum, result) => {
        const value = field === "total" ? result.scores?.total : result.scores?.[field]?.score;
        return sum + (value ?? 0);
      }, 0);
      averages[field] = roundOneDecimal(total / values.scored.length);
    }
  }
  const hintCount = units.reduce((sum, unit) => sum + (unit.sectionId === sectionId ? (hintCounts[unit.id] ?? 0) : 0), 0);
  return {
    scoredCount: values.scored.length,
    uncompletedCount: Math.max(0, values.expected - values.scored.length),
    averages,
    hintCount,
  };
}
