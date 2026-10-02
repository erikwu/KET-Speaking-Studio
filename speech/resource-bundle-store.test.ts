import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function api() {
  let module: Record<string, any> = {};
  try {
    module = await import("./resource-bundle-store.ts") as Record<string, any>;
  } catch {
    // Keep RED as an assertion failure until the transaction helper exists.
  }
  assert.equal(typeof module.promoteResourceBundleFiles, "function", "expected resource-bundle-store.ts to export promoteResourceBundleFiles()");
  return module;
}

test("promoteResourceBundleFiles_restoresAllDestinationsAfterInjectedRenameFailure", async () => {
  const { promoteResourceBundleFiles } = await api();
  const root = await mkdtemp(path.join(os.tmpdir(), "ket-resource-store-test-"));
  try {
    const stagedA = path.join(root, "stage-a.txt");
    const stagedB = path.join(root, "stage-b.txt");
    const destinationA = path.join(root, "destination-a.txt");
    const destinationB = path.join(root, "destination-b.txt");
    const backupDirectory = path.join(root, "backup");
    await writeFile(stagedA, "new-a");
    await writeFile(stagedB, "new-b");
    await writeFile(destinationA, "old-a");
    await writeFile(destinationB, "old-b");
    const fileOps = {
      mkdir: async (directory: string, options: { recursive: true }) => { await mkdir(directory, options); },
      rename: async (source: string, destination: string) => {
        if (source === stagedB) throw new Error("injected second promotion failure");
        await rename(source, destination);
      },
      rm: async (target: string, options: { recursive: true; force: true }) => { await rm(target, options); },
    };

    await assert.rejects(promoteResourceBundleFiles({
      moves: [
        { stagedPath: stagedA, destinationPath: destinationA },
        { stagedPath: stagedB, destinationPath: destinationB },
      ],
      backupDirectory,
      fileOps,
    }), /injected second promotion failure/);
    assert.equal(await readFile(destinationA, "utf8"), "old-a");
    assert.equal(await readFile(destinationB, "utf8"), "old-b");
    await assert.rejects(readFile(stagedA), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promoteResourceBundleFiles_preservesRecoveryBackupWhenRollbackIsIncomplete", async () => {
  const { promoteResourceBundleFiles } = await api();
  const root = await mkdtemp(path.join(os.tmpdir(), "ket-resource-recovery-test-"));
  try {
    const stagedA = path.join(root, "stage-a.txt");
    const stagedB = path.join(root, "stage-b.txt");
    const destinationA = path.join(root, "destination-a.txt");
    const destinationB = path.join(root, "destination-b.txt");
    const backupDirectory = path.join(root, "durable-backups");
    await writeFile(stagedA, "new-a");
    await writeFile(stagedB, "new-b");
    await writeFile(destinationA, "old-a");
    await writeFile(destinationB, "old-b");
    const fileOps = {
      mkdir: async (directory: string, options: { recursive: true }) => { await mkdir(directory, options); },
      rename: async (source: string, destination: string) => {
        if (source === stagedB || (source === path.join(backupDirectory, "1") && destination === destinationB)) {
          throw new Error("injected promotion or rollback failure");
        }
        await rename(source, destination);
      },
      rm: async (target: string, options: { recursive: true; force: true }) => { await rm(target, options); },
    };

    await assert.rejects(promoteResourceBundleFiles({
      moves: [
        { stagedPath: stagedA, destinationPath: destinationA },
        { stagedPath: stagedB, destinationPath: destinationB },
      ],
      backupDirectory,
      fileOps,
    }), (error: unknown) => {
      assert(error instanceof AggregateError);
      assert.equal((error as AggregateError & { recoveryDirectory?: string }).recoveryDirectory, backupDirectory);
      return true;
    });
    assert.equal(await readFile(destinationA, "utf8"), "old-a");
    assert.equal(await readFile(path.join(backupDirectory, "1"), "utf8"), "old-b");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
