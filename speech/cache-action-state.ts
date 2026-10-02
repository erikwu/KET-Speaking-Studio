export function getCacheActionState(input) {
  return {
    showDefault: !input.packageExists,
    showReplace: input.packageExists,
    defaultLabel: "为当前材料生产默认缓存",
    replaceLabel: "按当前标签生产并替换现有缓存",
    disabled: !input.hasMaterial || !input.modelAvailable || input.isRunning,
  };
}

export function resolvePlaybackMode(requestedMode, speechAvailable) {
  if (!speechAvailable) return "offline-only";
  return requestedMode === "offline-first" ? "offline-first" : "realtime";
}
