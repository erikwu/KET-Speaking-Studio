import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseVersion(value: unknown): number[] {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error("版本号必须是 major.minor.patch 格式，例如 1.0.1。");
  }
  const parts = value.split(".").map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error("版本号超出允许范围。");
  return parts;
}

export function verifyVersionBump(previous: unknown, current: unknown, files: string[]): void {
  const before = parseVersion(previous ?? "0.0.0"), after = parseVersion(current);
  const difference = after.map((part, index) => part - before[index]).find(value => value !== 0) ?? 0;
  const appChanged = files.some(file => !file.startsWith("docs/") && !/\.md$|\.test\.[^/]+$/.test(file));
  if (difference < 0 || (appChanged && difference === 0)) {
    throw new Error("应用代码有更新时必须提升版本号。请运行 npm run release:patch，并提交 package.json。");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const exec = promisify(execFile);
    const git = async (...args: string[]) => (await exec("git", args)).stdout.trim();
    const reference = process.argv[2] ?? "origin/main";
    const base = await git("rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`);
    const previous = JSON.parse(await git("show", `${base}:package.json`)).version;
    const current = JSON.parse(await readFile("package.json", "utf8")).version;
    const changed = (await git("diff", "--name-only", base, "--")).split("\n").filter(Boolean);
    const untracked = (await git("ls-files", "--others", "--exclude-standard")).split("\n").filter(Boolean);
    verifyVersionBump(previous, current, [...changed, ...untracked]);
    console.log(`版本校验通过：${previous ?? "未编号"} → ${current}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
