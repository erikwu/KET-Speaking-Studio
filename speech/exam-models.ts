import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** @typedef {{asrModelReady:boolean,asrRuntimeReady:boolean,scoringModelReady:boolean,scoringRuntimeReady:boolean,examAvailable:boolean}} ExamModelState */
/** @typedef {{asrModelDir:string,scoringModelDir:string,pythonPath:string,workerPath?:string,ffmpegPath?:string,env?:NodeJS.ProcessEnv}} ExamModelOptions */

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/** @param {string} modelDir */
export async function isAsrModelReady(modelDir: string): Promise<boolean> {
  return (await isRegularFile(path.join(modelDir, "config.json"))) &&
    (await isRegularFile(path.join(modelDir, "weights.safetensors")));
}

/** @param {string} modelDir */
export async function isScoringModelReady(modelDir: string): Promise<boolean> {
  if (!(await isRegularFile(path.join(modelDir, "config.json"))) || !(await isRegularFile(path.join(modelDir, "tokenizer.json")))) return false;
  const indexPath = path.join(modelDir, "model.safetensors.index.json");
  if (!(await isRegularFile(indexPath))) return false;
  try {
    const index = JSON.parse(await readFile(indexPath, "utf8")) as { weight_map?: Record<string, unknown> };
    const shardNames = [...new Set(Object.values(index.weight_map ?? {}))];
    if (shardNames.length === 0 || shardNames.some((name) => typeof name !== "string" || !name || path.isAbsolute(name) || name.split(/[\\/]/).includes(".."))) return false;
    return (await Promise.all(shardNames.map((name) => isRegularFile(path.join(modelDir, name as string))))).every(Boolean);
  } catch {
    return false;
  }
}

async function checkRuntime(options: ExamModelOptions): Promise<{ asrPackageReady: boolean; scoringPackageReady: boolean; ffmpegReady: boolean }> {
  if (!options.workerPath) return { asrPackageReady: false, scoringPackageReady: false, ffmpegReady: false };
  try {
    const result = await execFileAsync(options.pythonPath, [options.workerPath, "--check-runtime", "--ffmpeg", options.ffmpegPath ?? "ffmpeg"], {
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      env: options.env ?? process.env,
    });
    const value = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    return {
      asrPackageReady: value.asrPackageReady === true,
      scoringPackageReady: value.scoringPackageReady === true,
      ffmpegReady: value.ffmpegReady === true,
    };
  } catch {
    return { asrPackageReady: false, scoringPackageReady: false, ffmpegReady: false };
  }
}

/** @param {ExamModelOptions} options */
export async function checkExamModels(options: ExamModelOptions): Promise<ExamModelState> {
  const [asrModelReady, scoringModelReady, runtime] = await Promise.all([
    isAsrModelReady(options.asrModelDir),
    isScoringModelReady(options.scoringModelDir),
    checkRuntime(options),
  ]);
  const asrRuntimeReady = runtime.asrPackageReady && runtime.ffmpegReady;
  const scoringRuntimeReady = runtime.scoringPackageReady && runtime.ffmpegReady;
  return {
    asrModelReady,
    asrRuntimeReady,
    scoringModelReady,
    scoringRuntimeReady,
    examAvailable: asrModelReady && asrRuntimeReady && scoringModelReady && scoringRuntimeReady,
  };
}
