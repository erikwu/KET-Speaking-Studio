# KET Speaking 模拟考实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为当前 Markdown 材料增加完整的 Part 1 Phase 1、Part 1 Phase 2 和 Part 2 模拟考流程，使用本机录音、转写和语义评分。

**Architecture:** 在现有 8788 TypeScript 服务中增加考试计划/会话纯函数、本机 MLX 考试推理 worker 和受控 API；浏览器新增考试控制器及 WAV 编码模块。现有朗读/TTS 继续提供题目、答案与对话语音，安装脚本新增 Whisper 和 Qwen3 评分模型。

**Tech Stack:** Node.js 22 `--experimental-strip-types`、TypeScript、Node built-in test runner、Python 3.13、MLX、`mlx-whisper==0.4.3`、`mlx-lm==0.32.0`、Homebrew FFmpeg、浏览器 `MediaRecorder` / `AudioContext`。

**Spec:** `docs/superpowers/specs/2026-10-02-ket-mock-exam-design.md`

## Global Constraints

- 录音、转写和评分全部在本机处理，不向云服务上传录音或文本。
- 单条作答最长 120 秒；请求体上限 25 MiB。
- Part 1 / Phase 1、Part 1 / Phase 2、Part 2 固定按顺序出题；无效组跳过并统计，任一分段无有效题则阻止开考。
- Part 2 每个有效情景使用前三条 A/B/A 台词；三条中文 `translation` 均须非空；开场方在每场考试每情景只随机决定一次。
- 每项评分为 0–5 整数：切题度、信息完整度、语法、词汇；总分 0–20；不评发音或口音。
- 考试答案、转写、评分和提示统计仅保存在页面内存，不写入 Markdown、资源包、数据库、`localStorage` 或日志；录音处理结束后删除。
- 新增模型：`mlx-community/whisper-large-v3-turbo`（约 1.61 GB）和 `mlx-community/Qwen3-4B-4bit`（约 2.26 GB）；权重留在仓库根目录 `models/`，不进入 Git 或 `.ketpack.zip`。
- 缺少任一考试模型/runtime 时禁用模拟考，但不得影响普通朗读、已有离线语音、导入导出或已缓存情景图片。
- 8788 继续只监听 `127.0.0.1`；8787 图片生成服务不承载本功能。
- 由 8788 直接作为浏览器模块加载的 `.ts` 文件沿用当前 `speech/app.ts` 方式，只写浏览器可执行 JavaScript 和 JSDoc 类型，不写浏览器无法解析的 TypeScript 类型语法。

## File Map

- `speech/exam-session.ts`：考试材料校验、轮次映射、会话内提示计数和结果汇总的纯函数，使用浏览器可执行 JavaScript 语法及 JSDoc 类型。
- `speech/exam-audio.ts`：浏览器录音编排和 PCM WAV 编码。
- `speech/exam-controller.ts`：考试 UI 状态流、录音控件、播放/提示/评分与结果渲染，使用浏览器可执行 JavaScript 语法及 JSDoc 类型。
- `speech/exam-models.ts`：两个模型的本地文件结构和运行时能力检测。
- `speech/exam-inference.ts`：管理考试 worker 子进程、请求/响应队列、超时和临时 WAV 生命周期。
- `speech/exam_worker.py`：JSON Lines 协议，调用 MLX Whisper 转写与 MLX-LM 评分。
- `speech/server.ts`：暴露能力状态、转写/评分 API，并静态提供新增浏览器模块。
- `speech/index.html`、`speech/styles.css`：考试入口、过程、结果和无模型状态界面。
- `install.command`：新增依赖、模型空间估算、断点下载、文件校验。
- `speech/README.md`、`README.md`：更新安装容量、考试使用及本机数据说明。
- `speech/install-models.test.sh`：对安装脚本的模型校验函数使用临时目录做无网络检查。
- `package.json`：将考试纯函数/API 测试加入既有 Node 测试入口。
- `speech/exam-session.test.ts`、`speech/exam-controller.test.ts`、`speech/exam-audio.test.ts`、`speech/exam-models.test.ts`、`speech/exam-inference.test.ts`、`speech/exam-api.test.ts`、`speech/test_exam_worker.py`：分别测试考试逻辑、UI 显示映射、录音编码、模型检查、worker 生命周期、HTTP 合约和 Python 协议。

## Review Focus

- Markdown 缺少某一阶段、Part 1 缺 Q/A、Part 2 缺少 A/B/A 或中文提示：开考前跳过并统计；缺段时阻止开考。由 Task 1 的材料计划测试覆盖。
- 麦克风拒绝、音频格式无法解码、损坏 WAV 或超过 25 MiB：留在当前题、释放麦克风并删除临时音频。由 Task 3 的请求校验和 Task 4 的编码/清理测试覆盖。
- Whisper 返回空文本、Qwen JSON 不合法/越界或模型提示包含指令文本：不得生成虚假分数；保留可重试转写并约束评分输出。由 Task 2、Task 3 的 worker/API 测试覆盖。
- 录音或推理期间结束考试、换材料、重复展开提示：过期响应不可覆盖新状态，轨道必须释放，提示只按主动展开累计。由 Task 1 会话测试及 Task 5 浏览器流程核验覆盖。
- worker 崩溃/超时、模型缺失、依赖不兼容：服务仍能启动和跟读，考试能力独立显示；失败请求临时文件清理。由 Task 2、Task 3、Task 6 的能力/worker/安装检查覆盖。

---

### Task 1: 构建考试题目计划与结果统计纯函数

**Files:**
- Create: `speech/exam-session.ts`
- Create: `speech/exam-session.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: 与当前 parser 相同的 `Section[]` / `Group[]` / `Turn[]` 形状。
- Produces:
  - `buildExamPlan(sections, random = Math.random): ExamPlan`：返回按三个阶段排序的 `units`、按 `phase1` / `phase2` / `part2` 计数的 `skippedCounts` 和 `missingSections: ExamSectionId[]`。
  - `ExamPlan` 的 Phase 1/2 unit 含 `question: Turn` 与有序 `answers: Turn[]`；Part 2 unit 含 `turns: [Turn, Turn, Turn]`、固定的 `openingSpeaker: "computer" | "student"` 及 `studentTurnIndexes: [1] | [0,2]`。
  - `recordExamHint(counts, unitId): Record<string, number>`：只对显式展开事件递增对应题/情景计数。
  - `ExamResult` 每条学生回答一项，含 `{responseId, unitId, sectionId, status:"scored"|"unscored"|"unanswered", transcript?, scores?}`；成功分数结构为 `{relevance, completeness, grammar, vocabulary, total}`，各维度为 `{score, feedback}`。
  - `ExamSummary.bySection` 对每个阶段返回 `{scoredCount, uncompletedCount, averages:{relevance, completeness, grammar, vocabulary, total}, hintCount}`；平均值四舍五入至一位小数，分母仅为成功评分回答，暂无有效分数时均值为 `null`。
  - `summarizeExam(units, results, hintCounts): ExamSummary`：按阶段计算上述统计。

- [ ] **Step 1: 写失败测试**

在 `speech/exam-session.test.ts` 写以下用例：`buildExamPlan_returnsCompletePartsInFixedOrder` 断言 Phase 1→Phase 2→Part 2 且第一条 A 是 Part 1 参考答案；`buildExamPlan_skipsMalformedGroupsAndReportsMissingSections` 断言缺 Q/A、A/B/A 或中文翻译的组被跳过并报告空段；`buildExamPlan_randomizesEachPart2StartOnce` 注入随机函数并断言学生轮次分别是 `[1]` / `[0,2]`；`recordExamHint_countsEachExplicitReveal` 断言每次显式展开加一；`summarizeExam_excludesUnscoredAndUnanswered` 断言未评分/未作答不进平均分。

- [ ] **Step 2: 运行目标测试确认失败**

运行：`node --experimental-strip-types --test speech/exam-session.test.ts`
预期：因 `exam-session.ts` 尚不存在而失败。

- [ ] **Step 3: 实现纯函数**

在 `speech/exam-session.ts` 定义 `ExamPlan`、`ExamUnit`、`ExamResult`、`ExamSummary` 类型并实现上列接口。`buildExamPlan` 只对有效 Part 2 情景调用注入的随机函数；当随机函数返回值小于 `0.5` 时设为 `computer`，否则设为 `student`。

- [ ] **Step 4: 运行目标测试确认通过**

运行：`node --experimental-strip-types --test speech/exam-session.test.ts`
预期：全部考试计划、边界和统计断言通过。

- [ ] **Step 5: 将新测试加入项目测试入口并提交**

把 `speech/exam-session.test.ts` 加入 `package.json` 的 `test:resource-bundles` 命令。

```bash
git add package.json speech/exam-session.ts speech/exam-session.test.ts
git commit -m "feat: add mock exam session planning"
```

### Task 2: 增加模型检查和本机 ASR/评分 worker

**Files:**
- Create: `speech/exam-models.ts`
- Create: `speech/exam-models.test.ts`
- Create: `speech/exam_worker.py`
- Create: `speech/test_exam_worker.py`

**Interfaces:**
- Consumes: Task 1 定义的题目与参考回答语义；模型目录由服务传入，不从请求文本推断文件路径。
- Produces:
  - `checkExamModels({asrModelDir, scoringModelDir, pythonPath, ffmpegPath}): Promise<ExamModelState>`；状态字段固定为 `asrModelReady`、`asrRuntimeReady`、`scoringModelReady`、`scoringRuntimeReady`、`examAvailable`。
  - `exam_worker.py --check-runtime --ffmpeg PATH` 在标准输出单行 JSON 返回 `{asrPackageReady:boolean, scoringPackageReady:boolean, ffmpegReady:boolean}`，不加载权重。
  - worker 启动输出 `{"type":"ready"}`；请求为 `{id,type:"transcribe",audioPath}` 或 `{id,type:"score",question,reference,transcript}`；成功返回 `{id,ok:true,result}`，失败返回 `{id,ok:false,error}`；诊断只写标准错误且不得写入音频路径、录音、题目、参考答案或转写。
  - 转写结果为 `{transcript}`；worker 评分结果固定为四项 `{relevance:{score,feedback}, completeness:{score,feedback}, grammar:{score,feedback}, vocabulary:{score,feedback}}`，`feedback` 使用简体中文；Node 服务校验并累加 0–20 的 `total`。

- [ ] **Step 1: 写模型结构与 worker 协议测试**

在 `speech/exam-models.test.ts` 写 `isAsrModelReady_requiresConfigAndWeights`、`isScoringModelReady_requiresEveryShardAndTokenizer` 和 `checkExamModels_requiresBothRuntimesAndFfmpeg`：分别断言 Whisper 文件、Qwen3 index 引用权重和 tokenizer、runtime/FFmpeg 任何一个缺失时对应 readiness 为 false。

在 `speech/test_exam_worker.py` 写 `test_runtimeCheckReportsMissingPackagesAndFfmpeg`、`test_transcribe_usesEnglishAndLocalModelPath`、`test_loadsEachModelOnlyOnce`、`test_score_returnsFourDimensionsWithoutTotal`、`test_scoringPromptTreatsMaterialAsUntrusted`、`test_modelErrorReturnsProtocolError` 和 `test_logsNeverContainExamInputOrAudioPath`；用 mock 断言 runtime 状态、模型调用参数、四维结果、提示中的不可信内容约束、模型复用和隐私字段不出现在 stdout/stderr。

- [ ] **Step 2: 运行两组目标测试确认失败**

运行：`node --experimental-strip-types --test speech/exam-models.test.ts` 和 `.venv/bin/python -m unittest speech.test_exam_worker`
预期：因模型 helper 和 worker 尚不存在而失败。

- [ ] **Step 3: 实现模型检查与 worker**

`checkExamModels` 验证上述目录结构，并运行 Python 的 `--check-runtime --ffmpeg PATH` 子命令检测 `mlx_whisper`、`mlx_lm` 是否可导入及 `ffmpeg` 是否可执行；`asrRuntimeReady` 等于 `asrPackageReady && ffmpegReady`。worker 用 `mlx_whisper.transcribe(path, path_or_hf_repo=asrModelDir, language="en", task="transcribe")` 返回英文原文；用 `mlx_lm.load()` / `generate()` 生成四维评分 JSON，不让模型自行计算 `total`。为 Qwen3 chat template 传入 `enable_thinking=False`，并使用 temperature 0 与受限 token 数；消息中包含固定 A2 四维 rubric、含义等价要求及忽略参考材料中命令式文本的要求。

- [ ] **Step 4: 运行目标测试确认通过**

运行 Step 2 的两条命令。
预期：文件结构检查和无模型权重的 mock worker 测试全部通过。

- [ ] **Step 5: 提交模型检查与 worker**

```bash
git add speech/exam-models.ts speech/exam-models.test.ts speech/exam_worker.py speech/test_exam_worker.py
git commit -m "feat: add local exam inference worker"
```

### Task 3: 提供有界本机推理 API 和 worker 生命周期管理

**Files:**
- Create: `speech/exam-inference.ts`
- Create: `speech/exam-inference.test.ts`
- Create: `speech/exam-api.test.ts`
- Modify: `speech/server.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 2 的 `ExamModelState` 与 JSONL worker 协议。
- Produces:
  - `ExamScoreInput = {question:string, reference:string, transcript:string}`；worker 原始分数含四个固定 `{score:number,feedback:string}` 字段；`validateExamScore(value): ExamScore` 返回 `{relevance,completeness,grammar,vocabulary,total:number}` 并由 Node 服务端累加 `total`。
  - `createExamInference({pythonPath,workerPath,asrModelDir,scoringModelDir,tempDirectory,spawnImpl?})` 返回 `transcribe(wav: Buffer): Promise<{transcript:string}>` 与 `score(input: ExamScoreInput): Promise<ExamScore>`。
  - `POST /api/exam/transcribe` 接收 `audio/wav`，成功返回 `{transcript}`。
  - `POST /api/exam/score` 接收 `{question,reference,transcript}`，成功返回四项 `{score,feedback}` 与总分。
  - `/api/config` 新增 Task 2 的状态字段，并保留现有字段。

- [ ] **Step 1: 写 inference 生命周期和 API 失败路径测试**

在 `speech/exam-inference.test.ts` 用临时 stub worker 写 `dispatch_matchesResponsesByRequestId`、`transcribe_rejectsInvalidOrOversizedWavBeforeWriting`、`transcribe_removesTempAudioOnSuccessAndWorkerFailure`、`workerTimeout_rejectsPendingRequestAndRestartsCleanly` 和 `validateExamScore_rejectsInvalidFieldsAndSumsTotal`；断言响应 ID 配对、大小/PCM 头校验、所有路径清理 WAV、worker 故障/180 秒超时可重试、非法分数拒绝且总分由四维相加。

在 `speech/exam-api.test.ts` 写 `config_reportsExamUnavailableWithoutModels`、`examRoutes_return503WhenCapabilityIsMissing`、`transcribe_rejectsWrongContentTypeAndMalformedWav`、`score_rejectsTextOver3000Characters` 和 `browserModuleRoutes_serveJavaScript`；断言路由状态码/错误体、无本机路径泄漏及浏览器模块 MIME/语法可读。

- [ ] **Step 2: 运行目标测试确认失败**

运行：`node --experimental-strip-types --test speech/exam-inference.test.ts speech/exam-api.test.ts`
预期：因 inference helper 和考试路由尚不存在而失败。

- [ ] **Step 3: 实现独立 worker manager 与 API**

`exam-inference.ts` 使用唯一请求 ID、逐行 JSON 协议和 180 秒请求超时；worker stdout 仅解析 JSON，stderr 保留有限长度且不含考试内容的诊断。转写先验证 RIFF/WAVE PCM 标头，再将有界 WAV 写入考试临时目录；无论识别成功或失败都在 `finally` 删除。worker 超时或退出时拒绝待处理请求并清理进程状态；服务退出时停止 worker。`validateExamScore(value): ExamScore` 对四个维度、反馈文本和分数范围集中校验，并从维度分数计算总分。

在 `server.ts` 配置模型路径环境变量 `TTS_ASR_MODEL_PATH`、`TTS_SCORING_MODEL_PATH`、Python 路径 `TTS_EXAM_PYTHON` 和 worker 路径 `TTS_EXAM_WORKER_PATH`；新增 config 字段和两个 API。转写 API 按流读取，超过 25 MiB 时继续丢弃请求剩余数据并返回 JSON 413，不将超限内容写入磁盘。WAV 校验 RIFF/WAVE、PCM 编码、单声道、16 kHz、16-bit 和 data 长度后再写临时文件。评分请求三个文本字段各限 3,000 字符；服务端验证四项分数均为 0–5 整数、`feedback` 是简体中文且最长 500 字符，再累加 `total`。考试 worker 独立于 TTS worker、语音队列和缓存任务。

- [ ] **Step 4: 运行目标测试确认通过**

运行：`node --experimental-strip-types --test speech/exam-inference.test.ts speech/exam-api.test.ts`
预期：请求、超时、评分校验和临时文件清理测试通过。

- [ ] **Step 5: 将新测试加入项目测试入口并提交**

把新增 Node 测试文件加入 `package.json` 的 `test:resource-bundles`。

```bash
git add package.json speech/exam-inference.ts speech/exam-inference.test.ts speech/exam-api.test.ts speech/server.ts
git commit -m "feat: expose local mock exam APIs"
```

### Task 4: 实现浏览器录音与 PCM WAV 编码

**Files:**
- Create: `speech/exam-audio.ts`
- Create: `speech/exam-audio.test.ts`

**Interfaces:**
- Consumes: 浏览器 `MediaRecorder` 输出及 `AudioContext` 解码结果。
- Produces: `downmixAndResample(channels: Float32Array[], sourceRate: number, targetRate = 16000): Float32Array` 和 `encodeMonoPcmWav(samples: Float32Array, sampleRate = 16000): Uint8Array`；浏览器采集流程只在显式开始录音时请求麦克风，返回标准 16 kHz 单声道 PCM WAV `Blob`。

- [ ] **Step 1: 写 WAV 编码和音频边界测试**

在 `speech/exam-audio.test.ts` 写 `downmixAndResample_convertsStereoTo16000HzMono`、`encodeMonoPcmWav_writesPcm16LeHeaderAndSamples` 和 `encodeMonoPcmWav_rejectsEmptyInput`；断言 RIFF/WAVE 头、16 kHz 单声道 PCM 格式字段、采样数量/字节长度、振幅裁剪和空输入拒绝。

- [ ] **Step 2: 运行目标测试确认失败**

运行：`node --experimental-strip-types --test speech/exam-audio.test.ts`
预期：因音频模块尚不存在而失败。

- [ ] **Step 3: 实现录音与 WAV 编码**

用 `MediaRecorder` 采集浏览器支持的格式；调用 `AudioContext.decodeAudioData()`，多声道下混为单声道、线性重采样到 16 kHz，并用 little-endian signed 16-bit PCM 写入 WAV。达到 120 秒自动停止；手动停止、取消、组件清理或转换错误均停止 MediaStream 所有轨道并关闭 AudioContext。

- [ ] **Step 4: 运行目标测试确认通过**

运行：`node --experimental-strip-types --test speech/exam-audio.test.ts`
预期：WAV 头、PCM 编码和输入边界断言通过。

- [ ] **Step 5: 提交录音模块**

```bash
git add speech/exam-audio.ts speech/exam-audio.test.ts
git commit -m "feat: capture local exam answers"
```

### Task 5: 接入考试流程、录音、提示和结果 UI

**Files:**
- Create: `speech/exam-controller.ts`
- Create: `speech/exam-controller.test.ts`
- Modify: `speech/app.ts`
- Modify: `speech/index.html`
- Modify: `speech/styles.css`
- Modify: `speech/server.ts`

**Interfaces:**
- Consumes: Task 1 `buildExamPlan` / `recordExamHint` / `summarizeExam`、Task 3 两个 API、Task 4 音频采集接口，以及现有 `speak()` TTS 播放能力。
- Produces: `installExamController({getSections,getExamAvailability,speakText})` 返回 `{refreshAvailability(), resetForMaterialChange(), dispose()}`；控制器管理单场考试的内存状态。`getExamAvailability(): {available:boolean, reason:string}`；`speakText(turn: Turn): Promise<void>` 使用完整 `Turn.id/text/voiceRole` 复用现有语音标签、播放模式和离线缓存策略，播放结束才 resolve，播放失败 reject。
  - `getPart1PromptDisplay(turn: Turn): {audioTurn:Turn, visibleQuestion:""}`；`getPart2StudentPrompt(turn: Turn): string` 返回 `turn.translation`；`isExamResponseCurrent(activeExamId,activeResponseId,responseExamId,responseId): boolean`。

- [ ] **Step 1: 写考试提示显示和过期响应测试**

在 `speech/exam-controller.test.ts` 写 `getPart1PromptDisplay_hidesQuestionTextButKeepsAudioTurn`（断言显示模型不含英文问题文本但保留可朗读 Turn）、`getPart2StudentPrompt_usesTurnTranslation`（断言返回当前轮中文翻译）和 `isExamResponseCurrent_rejectsLateResponseFromOldSessionOrPrompt`（断言考试 ID 或回答 ID 任一变化时丢弃异步结果）。

- [ ] **Step 2: 运行目标测试确认失败**

运行：`node --experimental-strip-types --test speech/exam-controller.test.ts`
预期：因 controller helper 尚不存在而失败。

- [ ] **Step 3: 实现考试 UI 与浏览器状态流**

在 `index.html` 增加模拟考入口、设备状态、过程面板和结果面板。Part 1 面板仅显示题号与问题朗读控件，不显示英文问题文本；答案默认隐藏。Part 2 显示情景、当前学生轮中文提示与隐藏的英文参考脚本。

在 `exam-controller.ts` 实现并导出 `getPart1PromptDisplay(turn)`、`getPart2StudentPrompt(turn)` 与 `isExamResponseCurrent(activeExamId, activeResponseId, responseExamId, responseId)`，控制器使用这些函数生成题面并丢弃过期响应。按规格执行 `ready → playing-prompt → recording → transcribing → scoring → answer-result` 和 Part 2 电脑台词播放阶段。评分失败保留转写并只重试评分；ASR 失败允许重新录音；播放电脑台词失败提供重播和跳过该台词后继续。考试摘要展示各阶段逐题转写、分项分数、未完成条目、均分和提示数。

调用 `speakText(turn)` 复用 `app.ts` 当前音色/语气和实时/离线播放模式，并保留 turn ID 以便命中已缓存离线语音。`app.ts` 通过 off-DOM 播放按钮复用 `speak(button, {waitForEnd:true})`；该模式播放结束 resolve、播放失败 reject，普通逐句播放行为不变。`app.ts` 在 config 完成及材料变更时调用控制器 `refreshAvailability()`；材料加载时调用 `resetForMaterialChange()`，页面卸载时调用 `dispose()`，分别释放考试麦克风并清空/销毁本场数据。为 `exam-session.ts`、`exam-audio.ts`、`exam-controller.ts` 添加静态 JavaScript 模块路由。

- [ ] **Step 4: 运行逻辑测试并在本机浏览器核对流程**

运行：`node --experimental-strip-types --test speech/exam-controller.test.ts speech/exam-session.test.ts`。
随后在 8788 页面用测试 Markdown 手动核对三阶段顺序、Part 1 不显示问题文字、电脑/学生两种 Part 2 开场、提示统计、麦克风拒绝与模型缺失 UI、结束汇总及换材料后的数据清空；确认电脑播放完成后才出现下一学生提示。
预期：纯函数测试通过；浏览器交互符合规格且普通跟读不受影响。

- [ ] **Step 5: 将 controller 测试加入项目入口并提交考试 UI**

把 `speech/exam-controller.test.ts` 加入 `package.json` 的 `test:resource-bundles` 命令。

```bash
git add package.json speech/exam-controller.ts speech/exam-controller.test.ts speech/app.ts speech/index.html speech/styles.css speech/server.ts
git commit -m "feat: add KET mock exam interface"
```

### Task 6: 安装考试模型并更新使用文档

**Files:**
- Modify: `install.command`
- Modify: `speech/README.md`
- Modify: `README.md`
- Create: `speech/install-models.test.sh`

**Interfaces:**
- Consumes: Task 2 的模型目录结构、模型仓库 ID 与运行时包名。
- Produces: 一键安装会准备 `mlx-whisper`、`mlx-lm`，下载并校验考试模型后启动 8788；文档说明新增约 3.9 GB 权重和无模型机器的功能边界。

- [ ] **Step 1: 写安全的安装脚本 fixture 测试**

在 `speech/install-models.test.sh` 创建临时目录，source `install.command` 的函数定义但禁止自动调用 `main`，调用 `verify_asr_model DIR` 和 `verify_scoring_model DIR`。断言 Whisper 必须有 `config.json` 与 `weights.safetensors`；Qwen3 必须有 `config.json`、包含至少一个 `weight_map` 条目的 `model.safetensors.index.json`、全部引用分片和 `tokenizer.json`；移除任何必需文件后返回不完整。

- [ ] **Step 2: 让安装脚本可安全测试并确认测试失败**

在 `install.command` 末尾仅当 `[[ "${BASH_SOURCE[0]}" == "$0" ]]` 时调用 `main "$@"`，从测试脚本 source 时不触发任何安装动作。随后运行：`bash speech/install-models.test.sh`。
预期：测试安全退出，并因尚未定义 `verify_asr_model` / `verify_scoring_model` 而失败；不访问网络、不触发 Homebrew 或模型下载。

- [ ] **Step 3: 更新安装器与文档**

安装环境加入 `mlx-whisper==0.4.3`、`mlx-lm==0.32.0` 并通过 Homebrew 确保 `ffmpeg` 可用；验证 `mlx_audio`、`mlx_whisper`、`mlx_lm` 均可导入。若增加依赖导致既有 MLX-Audio 或 mflux CLI 不可用，则安装失败并说明环境问题。新增两个模型目录变量、以目录参数工作的校验函数、断点下载分支和约 5 GiB 总模型下载估算（ASR 2 GiB + 评分 3 GiB），保留原有 5 GiB 临时空间；完整模型跳过重复下载。将 `config_is_ready` 改为同时要求 `examAvailable`，避免安装器在考试模型/runtime 未就绪时报告完整安装。README 说明录音和分数不持久化、模型缺失时模拟考禁用、正常跟读/离线资源仍可用，并列出模型许可、仓库链接和容量。

- [ ] **Step 4: 运行安装器静态检查与模型 fixture 测试**

运行：`bash -n install.command` 和 `bash speech/install-models.test.sh`。
预期：shell 语法及模型 fixture 测试通过；完整模型被识别为可复用，缺文件目录被识别为不完整。

- [ ] **Step 5: 提交安装器和文档**

```bash
git add install.command speech/install-models.test.sh speech/README.md README.md
git commit -m "feat: install local mock exam models"
```

### Task 7: 完成整体验收和回归

**Files:**
- Modify only any files exposed by the verification failures above.

**Interfaces:**
- Consumes: Tasks 1–6 完成的考试 UI、API、worker 与安装路径。
- Produces: 通过现有功能回归和考试专项检查的可运行 `main` 工作树。

- [ ] **Step 1: 运行全部 Node 回归与专项测试**

运行：`npm run test:resource-bundles`
预期：资源包既有测试、考试会话/音频/模型/API/inference 测试全部通过。

- [ ] **Step 2: 运行 Python worker mock 测试**

运行：`.venv/bin/python -m unittest speech.test_exam_worker`
预期：JSONL 转写、评分、错误和加载复用测试通过；无需下载 MLX 权重。

- [ ] **Step 3: 检查安装脚本、工作树差异和模型缺失启动**

运行：`bash -n install.command`、`git diff --check`，并用模型路径指向不存在目录启动服务。
预期：语法/差异检查通过；`/api/config` 报告考试不可用但 8788 和普通跟读服务正常。

- [ ] **Step 4: 浏览器完整流程验收**

在装好两个考试模型的 Apple Silicon Mac 上完成一场测试考试，检查 120 秒停止上限、转写与评分、两种 Part 2 开场、提示统计、音频重试、结束汇总和刷新后数据清空；另在无考试模型环境检查降级 UI。
预期：考试流程全本机完成，开发者工具只出现 `127.0.0.1` 请求；录音结束后临时目录无 WAV，资源包导出仍不包含考试数据。

- [ ] **Step 5: 修复差异并确认最终状态**

重跑失败的目标检查，确认普通 TTS、资源包导入导出和图片缓存功能继续通过；检查 `git status --short`，确认模型权重不在待提交清单。

---

## Self-Review

- **Spec coverage:** 题目验证/分段顺序/随机开场/映射/提示计数在 Task 1、5；录音权限、PCM WAV、120 秒、25 MiB 和清理在 Task 3、4；模型检测和隔离 worker 在 Task 2、3；评分 schema 与四项维度在 Task 2、3；页面摘要、无模型状态和会话清理在 Task 5；安装、磁盘空间与文档在 Task 6；资源包排除考试数据与既有回归在 Task 7。
- **Step scan:** 每个任务都按测试、确认失败、实现、确认通过、提交排列；接口参数、模型文件检查条件、提示/评分值和请求限制均明确。
- **Type consistency:** `buildExamPlan` 返回的 `ExamPlan.units` 同时提供 Part 1 question/answers 与 Part 2 三轮/openingSpeaker；`createExamInference` 的 transcribe 与 score 返回类型对应两个 HTTP 路由；`ExamSummary` 与结束页字段一致。
- **Review Focus:** 五类高风险输入均绑定了目标纯函数、API/worker、浏览器流程或安装测试。
- **Proportion:** 七项任务分开覆盖会话逻辑、推理环境、API、录音、UI、安装文档和整体验收；没有额外引入持久化或新服务。
