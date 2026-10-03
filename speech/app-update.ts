import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, lstat, realpath, open } from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
export const UPDATE_REPOSITORY = "https://github.com/erikwu/KET-Speaking-Studio.git";
type Entry = { name: string; hash: string; mode: number };
type Plan = { mode: "git" | "zip"; current: string; target: string; before: Entry[]; after: Entry[]; ownerPid: number };
export type UpdateInfo = { mode: "git" | "zip"; current: string; target: string; available: boolean; notes: string };

async function exists(file: string) { try { return await lstat(file); } catch (error: any) { if (error.code === "ENOENT") return null; throw error; } }
function blobHash(bytes: Buffer) { return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"); }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
function safeName(name: string) {
  const first = name.split("/")[0].toLowerCase();
  if (!name || path.isAbsolute(name) || /[\\\x00-\x1f]/.test(name) || name.split("/").some(x => x === ".." || x === ".") ||
      ["models", "outputs", "node_modules", ".git", ".codex", ".agents", ".aws", ".hf-cache", ".hf-home", ".hf-xet", ".uv-cache"].includes(first) || first.startsWith(".venv") || (first.startsWith(".env") && first !== ".env.example")) {
    throw new Error(`更新包含受保护或不允许的路径：${name}`);
  }
}

/** Only the launcher owns this object. The browser cannot choose a repository or file path. */
export function createAppUpdater({ root, repository = UPDATE_REPOSITORY }: { root: string; repository?: string }) {
  root = path.resolve(root);
  const store = path.join(root, "outputs", "app-updates"), repo = path.join(store, "repository.git");
  const journal = path.join(store, "pending.json"), stage = path.join(store, "staged"), backup = path.join(store, "backup");
  let checked: UpdateInfo | null = null;
  let committedPlan: Plan | null = null;
  const git = async (cwd: string, args: string[], binary = false): Promise<any> => (await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", ...args], {
    cwd, timeout: 120_000, maxBuffer: 140 * 1024 * 1024, encoding: binary ? "buffer" : "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  })).stdout;
  async function atomic(file: string, data: string | Buffer, mode = 0o600) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.update-${randomUUID()}`;
    try { await writeFile(tmp, data, { mode, flag: "wx" }); await rename(tmp, file); }
    finally { await rm(tmp, { force: true }); }
  }
  async function lock<T>(run: () => Promise<T>): Promise<T> {
    await mkdir(store, { recursive: true });
    const file = path.join(store, "update.lock");
    let handle;
    try { handle = await open(file, "wx"); }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(await readFile(file, "utf8"));
      if (!pid || alive(pid)) throw new Error("另一个更新任务正在运行，请稍后重试。");
      await rm(file); handle = await open(file, "wx");
    }
    await handle.writeFile(String(process.pid));
    try { return await run(); } finally { await handle.close(); await rm(file, { force: true }); }
  }
  async function tree(revision: string): Promise<Entry[]> {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("版本编号无效。");
    const output: string = await git(repo, ["ls-tree", "-r", "-z", "-l", revision]);
    let total = 0; const names = new Set<string>();
    return output.split("\0").filter(Boolean).map(line => {
      const [meta, name] = [line.slice(0, line.indexOf("\t")), line.slice(line.indexOf("\t") + 1)];
      const [mode, type, hash, bytes] = meta.trim().split(/\s+/);
      safeName(name);
      if (type !== "blob" || !["100644", "100755"].includes(mode)) throw new Error(`更新不允许符号链接或子模块：${name}`);
      const size = Number(bytes); total += size;
      if (size > 16 * 1024 * 1024 || total > 128 * 1024 * 1024) throw new Error("更新源码超过大小限制。");
      const key = name.normalize("NFC").toLowerCase();
      if (names.has(key)) throw new Error("更新存在大小写冲突的文件名。"); names.add(key);
      return { name, hash, mode: mode === "100755" ? 0o755 : 0o644 };
    });
  }
  async function local(entry: Entry) {
    // Reject symlinked parent directories too; never follow them during a write.
    const parts = entry.name.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const info = await exists(path.join(root, ...parts.slice(0, i)));
      if (info?.isSymbolicLink()) throw new Error(`本地存在符号链接，无法安全更新：${entry.name}`);
      if (i < parts.length && info && !info.isDirectory()) throw new Error(`本地路径冲突：${entry.name}`);
      if (i === parts.length) return info;
    }
    return null;
  }
  async function matches(entries: Entry[]) {
    for (const entry of entries) {
      const info = await local(entry);
      if (!info?.isFile() || blobHash(await readFile(path.join(root, entry.name))) !== entry.hash) return false;
    }
    return true;
  }
  async function baseline(): Promise<{ mode: "git" | "zip"; current: string }> {
    const dotgit = await exists(path.join(root, ".git"));
    if (dotgit) {
      if (!dotgit.isDirectory() || dotgit.isSymbolicLink()) throw new Error("此工作副本不支持自动更新，请在主项目目录操作。");
      if ((await git(root, ["branch", "--show-current"])).trim() !== "main") throw new Error("请切换到 main 分支后更新。");
      if ((await git(root, ["status", "--porcelain", "--untracked-files=no"])).trim()) throw new Error("检测到本地代码修改，请先提交或备份修改后再更新。");
      const current = (await git(root, ["rev-parse", "HEAD"])).trim();
      try { await git(repo, ["merge-base", "--is-ancestor", current, "refs/heads/update-source"]); }
      catch { throw new Error("本地提交与 GitHub 版本分叉或含未发布的本地提交，请手动同步后再更新。"); }
      return { mode: "git", current };
    }
    const revisions = (await git(repo, ["rev-list", "--first-parent", "refs/heads/update-source"])).trim().split("\n");
    for (const revision of revisions) {
      let entries: Entry[]; try { entries = await tree(revision); } catch { continue; }
      if (entries.length && await matches(entries)) return { mode: "zip", current: revision };
    }
    throw new Error("无法确认 ZIP 安装的原始版本，可能存在本地代码修改。请备份修改，使用 GitHub 原版文件后再更新。");
  }
  async function validateFiles(before: Entry[], after: Entry[]) {
    if (!await matches(before)) throw new Error("检查更新后发生了本地代码修改，已停止更新。");
    const old = new Set(before.map(e => e.name));
    for (const entry of after) {
      const info = await local(entry);
      if (info && (!old.has(entry.name) || !info.isFile())) throw new Error(`更新会覆盖本地文件或发生路径冲突：${entry.name}`);
    }
  }
  async function pending(): Promise<Plan | null> { return await exists(journal) ? JSON.parse(await readFile(journal, "utf8")) : null; }
  async function restore(plan: Plan) {
    const old = new Map(plan.before.map(e => [e.name, e]));
    const next = new Map(plan.after.map(e => [e.name, e]));
    for (const name of new Set([...old.keys(), ...next.keys()])) {
      const entry = next.get(name) ?? old.get(name)!;
      const info = await local(entry);
      if (info) {
        if (!info.isFile()) throw new Error(`恢复时遇到本地路径冲突：${name}`);
        const hash = blobHash(await readFile(path.join(root, name)));
        if (hash !== old.get(name)?.hash && hash !== next.get(name)?.hash) throw new Error(`恢复前发现新的本地修改，已保留备份：${name}`);
      }
    }
    if (plan.mode === "git") {
      const head = (await git(root, ["rev-parse", "HEAD"])).trim();
      if (![plan.current, plan.target].includes(head)) throw new Error("恢复前发现新的本地修改，已保留备份，请手动恢复。");
      const index: string = await git(root, ["ls-files", "--stage", "-z"]);
      for (const line of index.split("\0").filter(Boolean)) {
        const tab = line.indexOf("\t"), name = line.slice(tab + 1), [, hash, stage] = line.slice(0, tab).split(" ");
        if (stage !== "0" || (hash !== old.get(name)?.hash && hash !== next.get(name)?.hash)) throw new Error("恢复前发现新的本地修改已暂存，已保留备份，请手动恢复。");
      }
      // Only transaction-owned before/after bytes may be reset; unrelated changes abort above.
      await git(root, ["reset", "--hard", plan.current]);
      for (const entry of plan.after) if (!old.has(entry.name)) await rm(path.join(root, entry.name), { force: true });
    } else {
      for (const entry of plan.after) if (!old.has(entry.name)) await rm(path.join(root, entry.name), { force: true });
      for (const entry of plan.before) await atomic(path.join(root, entry.name), await readFile(path.join(backup, entry.name)), entry.mode);
    }
    await rm(journal, { force: true }); checked = null;
  }
  return {
    async check(): Promise<UpdateInfo> {
      return lock(async () => {
        if (await pending()) throw new Error("上次更新尚未完成，请重启服务以恢复。");
        if (!await exists(path.join(repo, "HEAD"))) { await mkdir(repo, { recursive: true }); await git(repo, ["init", "--bare"]); }
        try { await git(repo, ["fetch", "--no-tags", repository, "+refs/heads/main:refs/heads/update-source"]); }
        catch { throw new Error("无法连接 GitHub 检查更新，请检查网络后重试。当前版本未改变。"); }
        const target = (await git(repo, ["rev-parse", "refs/heads/update-source"])).trim();
        const after = await tree(target), base = await baseline(), before = await tree(base.current);
        await validateFiles(before, after);
        const notes = (await git(repo, ["log", "--format=%s", "-8", `${base.current}..${target}`])).trim();
        checked = { ...base, target, available: base.current !== target, notes };
        return checked;
      });
    },
    async apply(target: string) {
      return lock(async () => {
        if (!checked?.available || checked.target !== target) throw new Error("请先重新检查更新。");
        if (await pending()) throw new Error("已有更新任务尚未完成。");
        const base = await baseline();
        if (base.current !== checked.current) throw new Error("本地版本已改变，请重新检查更新。");
        const before = await tree(base.current), after = await tree(target);
        await validateFiles(before, after);
        await rm(stage, { recursive: true, force: true }); await rm(backup, { recursive: true, force: true });
        for (const entry of before) await atomic(path.join(backup, entry.name), await readFile(path.join(root, entry.name)), entry.mode);
        for (const entry of after) await atomic(path.join(stage, entry.name), await git(repo, ["cat-file", "blob", entry.hash], true), entry.mode);
        for (const file of ["speech/server.ts", "speech/launcher.ts"]) {
          try { await exec(process.execPath, ["--experimental-strip-types", "--check", path.join(stage, file)], { timeout: 15_000 }); }
          catch { throw new Error("新版启动代码未通过检查，当前版本未改变。"); }
        }
        const oldPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
        const newPackage = JSON.parse(await readFile(path.join(stage, "package.json"), "utf8"));
        if (JSON.stringify(oldPackage.dependencies ?? {}) !== JSON.stringify(newPackage.dependencies ?? {})) throw new Error("新版需要更新运行依赖，请先备份并重新运行 install.command。");
        const plan: Plan = { ...base, target, before, after, ownerPid: process.pid };
        await atomic(journal, JSON.stringify(plan));
        try {
          await validateFiles(before, after);
          if (base.mode === "git") {
            await git(root, ["fetch", "--no-tags", repo, target]);
            await git(root, ["merge", "--ff-only", "--no-edit", target]);
          } else {
            const keep = new Set(after.map(e => e.name));
            for (const entry of after) await atomic(path.join(root, entry.name), await readFile(path.join(stage, entry.name)), entry.mode);
            for (const entry of before) if (!keep.has(entry.name)) await rm(path.join(root, entry.name));
          }
        } catch (error) { await restore(plan); throw error; }
      });
    },
    async rollback(includeCommitted = false) { await lock(async () => { const plan = await pending() ?? (includeCommitted ? committedPlan : null); if (plan) await restore(plan); }); },
    async commit() { await lock(async () => { committedPlan = await pending(); await rm(journal, { force: true }); checked = null; }); },
    async recover() {
      await lock(async () => {
        const plan = await pending(); if (!plan) return;
        if (plan.ownerPid !== process.pid && alive(plan.ownerPid)) throw new Error("另一个服务正在更新此项目，请勿重复启动。");
        await restore(plan);
      });
    },
  };
}
