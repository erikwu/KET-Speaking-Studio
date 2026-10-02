import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

export type ResourceBundleFileOps = {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  rename(source: string, destination: string): Promise<void>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
};

const defaultFileOps: ResourceBundleFileOps = {
  mkdir: async (target, options) => await mkdir(target, options),
  rename,
  rm,
};

export async function promoteResourceBundleFiles(input: {
  moves: Array<{ stagedPath: string; destinationPath: string }>;
  backupDirectory: string;
  fileOps?: ResourceBundleFileOps;
}): Promise<void> {
  const fileOps = input.fileOps ?? defaultFileOps;
  const backupDirectory = path.resolve(input.backupDirectory);
  const destinations = new Set<string>();
  for (const move of input.moves) {
    const destination = path.resolve(move.destinationPath);
    if (destinations.has(destination)) throw new Error(`Duplicate resource destination: ${destination}.`);
    destinations.add(destination);
  }

  const backups: Array<{ backupPath: string; destinationPath: string }> = [];
  const promoted: string[] = [];
  await fileOps.mkdir(backupDirectory, { recursive: true });
  try {
    for (const [index, move] of input.moves.entries()) {
      const stagedPath = path.resolve(move.stagedPath);
      const destinationPath = path.resolve(move.destinationPath);
      await fileOps.mkdir(path.dirname(destinationPath), { recursive: true });
      if (existsSync(destinationPath)) {
        const backupPath = path.join(backupDirectory, String(index));
        await fileOps.mkdir(path.dirname(backupPath), { recursive: true });
        await fileOps.rename(destinationPath, backupPath);
        backups.push({ backupPath, destinationPath });
      }
      await fileOps.rename(stagedPath, destinationPath);
      promoted.push(destinationPath);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const destinationPath of promoted.reverse()) {
      try { await fileOps.rm(destinationPath, { recursive: true, force: true }); }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    for (const backup of backups.reverse()) {
      try {
        await fileOps.mkdir(path.dirname(backup.destinationPath), { recursive: true });
        await fileOps.rename(backup.backupPath, backup.destinationPath);
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Resource bundle promotion failed and rollback was incomplete.");
    throw error;
  }

  try { await fileOps.rm(backupDirectory, { recursive: true, force: true }); }
  catch { /* Successful promotion is the commit point; stale backups are safe to remove later. */ }
}
