import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startManagedApp } from "./launcher.ts";
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], { cwd })).stdout.trim();
const healthy = 'process.send({type:"ket-ready",capabilities:{examAvailable:true}}); setInterval(()=>{},1000); process.on("SIGTERM",()=>process.exit(0));';

for (const broken of [false, true, "after-ready"]) test(`managed update ${broken ? `restores previous version when new server fails (${broken})` : "restarts into new version without exiting launcher"}`, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ket-launcher-")), remote=path.join(tmp,"remote"), root=path.join(tmp,"app");
  let app;
  try {
    await mkdir(path.join(remote,"speech"),{recursive:true});
    await writeFile(path.join(remote,"package.json"),'{"type":"module"}');
    await writeFile(path.join(remote,"speech/launcher.ts"),'// launcher fixture');
    await writeFile(path.join(remote,"speech/server.ts"),healthy);
    await git(remote,"init","-b","main");await git(remote,"add",".");await git(remote,"commit","-m","old");
    const initial=await git(remote,"rev-parse","HEAD");
    await git(tmp,"clone",remote,root);
    app=await startManagedApp({root,repository:remote,readinessTimeoutMs:2000,stdio:"ignore"});
    const pid=app.pid(); assert.ok(pid);
    await writeFile(path.join(remote,"speech/server.ts"),broken === "after-ready" ? 'process.send({type:"ket-ready",capabilities:{examAvailable:true}},()=>process.exit(9));' : broken?'process.exit(9);':healthy+'\n// new version');
    await git(remote,"add",".");await git(remote,"commit","-m","new");
    const info=await app.check();assert.equal(info.available,true);
    const updating = app.update(info.target);
    await assert.rejects(app.update(info.target), /请先检查更新/);
    await assert.rejects(app.check(), /正在检查或安装更新/);
    await updating;
    assert.notEqual(app.pid(),pid);assert.ok(app.pid());
    assert.equal(app.state().phase,broken?"error":"done");
    assert.equal(await git(root,"rev-parse","HEAD"),broken?initial:info.target);
    if(broken)assert.match(app.state().message,/恢复/);
  } finally { await app?.stop(); await rm(tmp,{recursive:true,force:true}); }
});
