import assert from "node:assert/strict";
import test from "node:test";
import { getCacheActionState } from "./cache-action-state.ts";

test("cacheActionState_showsOnlyDefaultGenerationWhenNoCacheExists", () => {
  assert.deepEqual(getCacheActionState({ hasMaterial: true, modelAvailable: true, isRunning: false, packageExists: false }), {
    showDefault: true,
    showReplace: false,
    defaultLabel: "为当前材料生成默认缓存",
    replaceLabel: "按当前标签生成并替换现有缓存",
    disabled: false,
  });
});

test("cacheActionState_showsOnlyReplacementWhenAnyCompleteCacheExists", () => {
  assert.deepEqual(getCacheActionState({ hasMaterial: true, modelAvailable: true, isRunning: false, packageExists: true }), {
    showDefault: false,
    showReplace: true,
    defaultLabel: "为当前材料生成默认缓存",
    replaceLabel: "按当前标签生成并替换现有缓存",
    disabled: false,
  });
});
