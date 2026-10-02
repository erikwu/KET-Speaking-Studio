export function getCacheActionState(input) {
  return {
    showDefault: !input.packageExists,
    showReplace: input.packageExists,
    defaultLabel: "为当前材料生成默认缓存",
    replaceLabel: "按当前标签生成并替换现有缓存",
    disabled: !input.hasMaterial || !input.modelAvailable || input.isRunning,
  };
}
