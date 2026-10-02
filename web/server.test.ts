import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";

async function reservePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function createImageModel(root: string): Promise<string> {
  const modelPath = path.join(root, "valid-image-model");
  for (const relativePath of [
    "vae/model.safetensors.index.json",
    "transformer/model.safetensors.index.json",
    "text_encoder/model.safetensors.index.json",
    "processor/tokenizer.json",
  ]) {
    const filePath = path.join(modelPath, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "{}");
  }
  return modelPath;
}

async function withWebServer<T>(root: string, options: { modelPath: string; cliPath: string }, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const port = await reservePort();
  const child = spawn(process.execPath, ["--experimental-strip-types", "web/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), MFLUX_MODEL_PATH: options.modelPath, MFLUX_CLI_PATH: options.cliPath },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Image Studio server exited during startup: ${stderr}`);
    try {
      const response = await fetch(`${baseUrl}/api/config`);
      if (response.ok) { ready = true; break; }
    } catch { /* The listener has not opened yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (!ready) {
    child.kill("SIGTERM");
    throw new Error(`Image Studio server did not start: ${stderr}`);
  }
  try {
    return await run(baseUrl);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }
}

test("imageStudioRejectsMissingModelOrCli", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ket-image-studio-test-"));
  try {
    const modelPath = await createImageModel(root);
    const missingCli = path.join(root, "missing-mflux-cli");
    await withWebServer(root, { modelPath, cliPath: missingCli }, async (baseUrl) => {
      const config = await fetch(`${baseUrl}/api/config`).then((response) => response.json()) as any;
      assert.equal(config.modelReady, true);
      assert.equal(config.cliReady, false);
      const response = await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 503);
      assert.match((await response.json() as any).error, /mflux/i);
    });

    const fakeCli = path.join(root, "fake-mflux-cli");
    await writeFile(fakeCli, "test executable placeholder");
    await withWebServer(root, { modelPath: path.join(root, "missing-model"), cliPath: fakeCli }, async (baseUrl) => {
      const config = await fetch(`${baseUrl}/api/config`).then((response) => response.json()) as any;
      assert.equal(config.modelReady, false);
      assert.equal(config.cliReady, true);
      const response = await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 503);
      assert.match((await response.json() as any).error, /模型目录/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
