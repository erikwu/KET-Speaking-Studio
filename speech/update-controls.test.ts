import assert from "node:assert/strict";
import test from "node:test";
import { applyAndWaitForUpdate, installUpdateControls } from "./update-controls.ts";

test("lost apply response reconciles status and waits for the requested revision", async () => {
  const seen: string[] = [];
  const states = [{ phase: "restarting" }, { phase: "done", info: { current: "new" } }];
  const result = await applyAndWaitForUpdate({
    submit: async () => { throw new TypeError("connection closed"); },
    readState: async () => states.shift(), target: "new", pause: async () => {},
    onState: (state: any) => seen.push(state.phase),
  });
  assert.equal(result.info.current, "new");assert.deepEqual(seen,["restarting","done"]);
});
test("explicit update rejection is shown without entering a reconnect loop", async () => {
  let polls=0;
  await assert.rejects(applyAndWaitForUpdate({submit:async()=>{throw Object.assign(new Error("busy"),{httpStatus:409});},readState:async()=>{polls++;},target:"new",pause:async()=>{},onState:()=>{}}),/busy/);
  assert.equal(polls,0);
});

test("controls lock queued clicks immediately and show distinct update stages on the button", async () => {
  const originals = Object.fromEntries(["document", "window", "fetch", "setInterval", "clearInterval", "location"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const elements = new Map();
  const events = new Map();
  const intervals: Array<() => void> = [];
  let phase = "idle", checks = 0, applies = 0, reloads = 0;
  let releaseCheck: () => void;
  const checkPending = new Promise<void>(resolve => { releaseCheck = resolve; });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  function element(id: string) {
    if (!elements.has(id)) elements.set(id, {textContent:"", disabled:false, hidden:false, classList:{toggle(){}}, setAttribute(){}, focus(){}, addEventListener(type: string, handler: any){events.set(`${id}:${type}`, handler);}});
    return elements.get(id);
  }
  try {
    Object.assign(globalThis, {
      document: {querySelector: element}, window: {addEventListener(){}}, location: {reload(){reloads++;}},
      setInterval(callback: () => void) {intervals.push(callback); return intervals.length;}, clearInterval(){},
      fetch: async (url: string) => {
        if (url.endsWith("/check")) {checks++; await checkPending; phase="available";}
        if (url.endsWith("/apply")) {applies++; phase="updating";}
        return {ok:true,json:async()=>({managed:true,token:"test",phase,message:phase,info:{available:phase==="available",target:"new",current:phase==="done"?"new":"old"}})};
      },
    });
    installUpdateControls({isExamActive:()=>false});
    await tick();
    const button=element("#check-update"), install=element("#install-update");
    const checking=events.get("#check-update:click")();
    const duplicate=events.get("#check-update:click")();
    await tick();
    assert.equal(checks,1,"queued clicks must produce just one check request");
    assert.equal(button.textContent,"检查中…"); assert.equal(button.disabled,true);
    releaseCheck!(); await Promise.all([checking,duplicate]);
    assert.equal(button.textContent,"发现新版本");
    const updating=events.get("#install-update:click")();
    await events.get("#install-update:click")();
    await tick();
    assert.equal(applies,1,"queued clicks must produce just one apply request");
    assert.equal(button.textContent,"更新中…"); assert.equal(install.disabled,true);
    phase="restarting"; await new Promise(resolve=>setTimeout(resolve,1600));
    assert.match(button.textContent,/重启/); assert.equal(button.disabled,true);
    phase="recovering"; await new Promise(resolve=>setTimeout(resolve,1600));
    assert.match(button.textContent,/恢复/); assert.equal(button.disabled,true);
    phase="done"; await updating;
    assert.equal(button.textContent,"更新完成 · 已恢复"); assert.equal(reloads,1);
  } finally {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key];
    }
  }
});
