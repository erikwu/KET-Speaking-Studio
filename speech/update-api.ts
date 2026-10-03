import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Same-origin, token-protected update RPC. Raw server launches cannot restart themselves. */
export function createUpdateApi({ busy, port, rpc, managed = process.env.KET_MANAGED_SERVER === "1" && Boolean(process.send) }: {
  busy: () => boolean; port: number; rpc: (action: string, target?: string) => Promise<any>; managed?: boolean;
}) {
  const token = randomUUID(), leases = new Map<string, number>();
  let maintenance = false;
  const origin = `http://127.0.0.1:${port}`;
  const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
  return {
    maintenance: () => maintenance,
    setMaintenance(value: boolean) { maintenance = value; },
    async handle(req: IncomingMessage, res: ServerResponse, route: string): Promise<boolean> {
      if (!route.startsWith("/api/update")) return false;
      const host = req.headers.host;
      const allowedOrigin = host === `localhost:${port}` ? `http://localhost:${port}` : origin;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host ?? "") || req.headers["sec-fetch-site"] === "cross-site") { json(res, 403, { error: "更新操作仅允许从本机页面发起。" }); return true; }
      try {
        if (req.method === "GET" && route === "/api/update") {
          const state = managed ? await rpc("status") : { phase: "idle", message: "请通过 install.command 或 npm run start:tts 启动服务后使用自动更新。" };
          json(res, 200, { managed, token, ...state }); return true;
        }
        if (req.method !== "POST" || req.headers.origin !== allowedOrigin || req.headers["x-ket-update-token"] !== token || !String(req.headers["content-type"]).startsWith("application/json")) {
          json(res, 403, { error: "更新请求验证失败，请刷新页面后重试。" }); return true;
        }
        let text = "";
        for await (const chunk of req) { text += chunk.toString(); if (text.length > 4096) throw new Error("更新请求过大。"); }
        const input = JSON.parse(text || "{}");
        if (route === "/api/update/lease") {
          if (maintenance && input.active) { json(res, 409, { error: "正在更新服务，请等待更新完成后再开始模拟考。" }); return true; }
          if (typeof input.clientId !== "string" || !/^[a-z0-9-]{1,80}$/i.test(input.clientId)) throw new Error("页面会话无效。");
          for (const [id, expires] of leases) if (expires < Date.now()) leases.delete(id);
          if (input.active) { if (leases.size > 100) throw new Error("页面会话过多。"); leases.set(input.clientId, Date.now() + 120_000); }
          else leases.delete(input.clientId);
          json(res, 200, { ok: true, maintenance }); return true;
        }
        if (!managed) { json(res, 409, { error: "请使用 npm run start:tts 启动服务以启用自动重启。" }); return true; }
        if (route === "/api/update/check") { json(res, 200, await rpc("check")); return true; }
        if (route === "/api/update/apply") {
          if (maintenance || busy() || [...leases.values()].some(expiry => expiry > Date.now())) { json(res, 409, { error: "模拟考或生成任务正在进行，请结束后再更新。" }); return true; }
          if (typeof input.target !== "string" || !/^[a-f0-9]{40}$/.test(input.target)) throw new Error("更新版本无效，请重新检查。");
          maintenance = true;
          try { const result = await rpc("apply", input.target); json(res, 202, result); }
          catch (error) { maintenance = false; throw error; }
          return true;
        }
        json(res, 404, { error: "更新接口不存在。" });
      } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : "更新失败。" }); }
      return true;
    },
  };
}

export function createUpdateRpc() {
  const requests = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  process.on("message", (message: any) => {
    if (message?.type !== "ket-update-response") return;
    const pending = requests.get(message.id); if (!pending) return;
    requests.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.value);
  });
  return (action: string, target?: string) => new Promise<any>((resolve, reject) => {
    if (!process.send) return reject(new Error("自动更新启动进程不可用。"));
    const id = randomUUID();
    const timer = setTimeout(() => { requests.delete(id); reject(new Error("更新操作超时，请检查网络后重试。")); }, 150_000);
    requests.set(id, { resolve, reject, timer });
    process.send({ type: "ket-update-request", id, action, target }, error => {
      if (error) { clearTimeout(timer); requests.delete(id); reject(error); }
    });
  });
}
