import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createAppUpdater } from "./app-update.ts";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-c", "user.name=Update Test", "-c", "user.email=update@example.test", ...args], { cwd })).stdout.trim();
async function fixture(run: (f: any) => Promise<void>) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ket-update-"));
  const remote = path.join(temp, "remote"), root = path.join(temp, "app");
  await mkdir(remote);
  await git(remote, "init", "-b", "main");
  await mkdir(path.join(remote, "speech"));
  await writeFile(path.join(remote, "package.json"), '{"type":"module","scripts":{"start:tts":"node speech/launcher.ts"}}');
  await writeFile(path.join(remote, "speech/server.ts"), 'console.log("old");\n');
  await writeFile(path.join(remote, "speech/launcher.ts"), 'console.log("launcher");\n');
  await writeFile(path.join(remote, "obsolete.txt"), "old file");
  await git(remote, "add", "."); await git(remote, "commit", "-m", "initial");
  const initial = await git(remote, "rev-parse", "HEAD");
  await git(temp, "clone", remote, root);
  const advance = async () => {
    await writeFile(path.join(remote, "speech/server.ts"), 'console.log("new");\n');
    await writeFile(path.join(remote, "new.txt"), "new file");
    await git(remote, "rm", "obsolete.txt");
    await git(remote, "add", "."); await git(remote, "commit", "-m", "Improve practice");
    return git(remote, "rev-parse", "HEAD");
  };
  try { await run({ temp, remote, root, initial, advance, updater: () => createAppUpdater({ root, repository: remote }) }); }
  finally { await rm(temp, { recursive: true, force: true }); }
}

test("git update and rollback preserve models, environment and practice files", async () => {
  await fixture(async ({ root, initial, advance, updater }) => {
    for (const dir of ["models", ".venv", "outputs"]) { await mkdir(path.join(root, dir), { recursive: true }); await writeFile(path.join(root, dir, "keep"), dir); }
    const target = await advance(); const u = updater();
    const info = await u.check(); assert.equal(info.target, target); assert.equal(info.available, true); assert.match(info.notes, /Improve practice/);
    await u.apply(target); assert.equal(await git(root, "rev-parse", "HEAD"), target);
    assert.match(await readFile(path.join(root, "speech/server.ts"), "utf8"), /new/);
    await u.rollback(); assert.equal(await git(root, "rev-parse", "HEAD"), initial);
    assert.equal(await readFile(path.join(root, "obsolete.txt"), "utf8"), "old file");
    for (const dir of ["models", ".venv", "outputs"]) assert.equal(await readFile(path.join(root, dir, "keep"), "utf8"), dir);
  });
});

test("local tracked edits block updates before any replacement", async () => {
  await fixture(async ({ root, advance, updater }) => {
    await advance(); await writeFile(path.join(root, "speech/server.ts"), "my changes");
    await assert.rejects(updater().check(), /本地.*修改/);
    assert.equal(await readFile(path.join(root, "speech/server.ts"), "utf8"), "my changes");
  });
});

test("Git recovery handles interrupted checkout but preserves new user files at deleted paths", async () => {
  await fixture(async ({ root, initial, advance, updater }) => {
    const target = await advance(), u = updater(); await u.check(); await u.apply(target);
    // Simulate interruption with the original HEAD but some target file contents.
    await git(root, "update-ref", "HEAD", initial);
    await updater().recover();
    assert.match(await readFile(path.join(root, "speech/server.ts"), "utf8"), /old/);
    assert.equal(await git(root, "status", "--porcelain", "--untracked-files=no"), "");
  });
  await fixture(async ({ root, advance, updater }) => {
    const target = await advance(), u = updater(); await u.check(); await u.apply(target);
    await writeFile(path.join(root, "obsolete.txt"), "new user notes");
    await assert.rejects(u.rollback(), /本地修改/);
    assert.equal(await readFile(path.join(root, "obsolete.txt"), "utf8"), "new user notes");
  });
});

test("ZIP installation is matched to history, updated, and recovered after interruption", async () => {
  await fixture(async ({ root, advance, updater }) => {
    await rm(path.join(root, ".git"), { recursive: true, force: true });
    await writeFile(path.join(root, "my-notes.md"), "personal");
    const target = await advance(); const u = updater();
    assert.equal((await u.check()).mode, "zip");
    await u.apply(target);
    assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "new file");
    await assert.rejects(readFile(path.join(root, "obsolete.txt")), /ENOENT/);
    await updater().recover();
    assert.equal(await readFile(path.join(root, "obsolete.txt"), "utf8"), "old file");
    await assert.rejects(readFile(path.join(root, "new.txt")), /ENOENT/);
    assert.equal(await readFile(path.join(root, "my-notes.md"), "utf8"), "personal");
  });
});

test("files edited after checking and untracked target collisions are never overwritten", async () => {
  await fixture(async ({ root, advance, updater }) => {
    const target = await advance(), u = updater(); await u.check();
    await writeFile(path.join(root, "new.txt"), "user file");
    await assert.rejects(u.apply(target), /覆盖|冲突/);
    assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "user file");
    await rm(path.join(root, "new.txt"));
    await writeFile(path.join(root, "speech/server.ts"), "edited after check");
    await assert.rejects(u.apply(target), /本地.*修改/);
  });
});

test("remote model/environment paths and symlinks are refused", async () => {
  await fixture(async ({ remote, updater }) => {
    await mkdir(path.join(remote, "models")); await writeFile(path.join(remote, "models/keep"), "remote");
    await git(remote, "add", "."); await git(remote, "commit", "-m", "unsafe assets");
    await assert.rejects(updater().check(), /保护|不允许/);
  });
  await fixture(async ({ remote, updater }) => {
    await symlink("/tmp", path.join(remote, "linked")); await git(remote, "add", "."); await git(remote, "commit", "-m", "symlink");
    await assert.rejects(updater().check(), /符号链接|不允许/);
  });
});

test("ZIP local modifications and diverged Git history are refused", async () => {
  await fixture(async ({ root, advance, updater }) => {
    await advance(); await rm(path.join(root, ".git"), { recursive: true, force: true });
    await writeFile(path.join(root, "speech/server.ts"), "custom code");
    await assert.rejects(updater().check(), /本地.*修改|无法确认/);
  });
  await fixture(async ({ root, advance, updater }) => {
    await advance(); await writeFile(path.join(root, "local.txt"), "local commit");
    await git(root, "add", "."); await git(root, "commit", "-m", "local only");
    await assert.rejects(updater().check(), /分叉|本地提交/);
  });
});
