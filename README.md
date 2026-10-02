# KET Speaking Studio · 本地 AI 练习工具

本项目提供两个独立的本地 Web 服务：KET 英语跟读练习（8788）和视觉生成工作室（8787）。两个服务都只监听 `127.0.0.1`，仅供本机浏览器访问。

## 两个服务分别做什么

### KET Speaking 跟读练习 · 8788

打开 <http://127.0.0.1:8788>。选择本机的 Markdown 练习材料后，页面会按 Part 1 / Phase 1、Part 1 / Phase 2、Part 2 的顺序整理问答。点击句子即可用本地 Qwen3-TTS 模型生成并播放语音，也可以配置基础音色、问句语气和回答语气标签。

页面还支持为整份材料生成本地离线语音缓存，以及为 Part 2 对话情景生成配图。配图由本机 Qwen Image 模型生成；这些功能都由 8788 服务调用，不需要另外打开 8787 页面。练习材料、语音缓存和情景图片保存在本机 `outputs/speech-practice/`。

材料载入后也可以开始模拟考：Part 1 的问题只播放语音，Part 2 按随机开场顺序进行对话。网页在本机录音、用 Whisper 转写，并由本机 Qwen3 模型按切题度、信息完整度、语法和词汇评分，不评发音。考试录音、转写、分数和提示次数只保留在当前页面内存；刷新页面或切换材料后清除。首次安装还会下载 Whisper 和 Qwen3 评分模型，约增加 3.9 GB 权重；任一考试模型或运行环境缺失时，模拟考会禁用，逐句跟读和已有离线资源继续可用。

跟读页还支持跨设备的离线资源包：完整离线语音通过校验后，可以下载 `.ketpack.zip`；压缩包包含当前 Markdown、该材料的全部 WAV，以及已经生成的 Part 2 配图，不包含模型或运行环境。在另一台 Mac 的 8788 页面导入后，材料会自动载入，可直接播放包内语音和查看图片。每次只保留一份活动语音包；成功导入会替换它，校验失败则保留原资源。

### 视觉生成工作室 · 8787

打开 <http://127.0.0.1:8787>。页面包含“图像”和“图生视频”两种模式：图像模式由 Qwen Image 2.1 生成图片，保留参考图、尺寸、步数、Seed 和输出格式等选项；图生视频模式由 Wan 2.2 TI2V-5B 根据一张起始图和提示词生成 MP4。视频长度可选 41、81 或 121 帧，输出为 24 fps。生成结果可在页面预览和下载，提示词、输入图片及输出保存在 `outputs/web-ui/<任务编号>/`。

## 首次安装

适用于 Apple Silicon Mac。双击项目根目录的 [`install.command`](install.command)，按提示完成依赖和本地模型安装。安装脚本会启动 KET Speaking 服务并打开 8788 页面。现在会安装 TTS、图片、模拟考转写和评分模型；完整模型约 33 GiB，建议至少预留 40 GiB 可用空间（包含临时下载空间）。系统要求、下载过程和模型许可说明见 [`speech/README.md`](speech/README.md)。

## 启动服务

安装完成后，如需同时使用两个服务，在项目根目录分别打开两个终端窗口，并保持窗口运行：

**终端窗口 1：KET Speaking 跟读练习（8788）**

```sh
npm run start:tts
```

浏览器打开 <http://127.0.0.1:8788>。也可以双击 `install.command` 启动此服务。

**终端窗口 2：视觉生成工作室（8787）**

```sh
npm start
```

浏览器打开 <http://127.0.0.1:8787>。这两个进程相互独立；关闭某个终端只会停止对应服务。

带模型的完整运行环境需要 Node.js 22 或更新版本，以及安装脚本准备的项目 `.venv` 和模型。没有模型的 Mac 也能启动 8788：只需 Node.js 22+，以及 macOS 自带的 `zip`/`unzip`；在终端运行 `npm run start:tts`，打开 <http://127.0.0.1:8788> 并导入资源包。此场景不要运行 `install.command`，以免下载模型。没有本地语音能力时，页面只播放资源包中已有的离线 WAV；缺少的句子不可播放，也不会触发实时合成或缓存生成。没有图片模型和 mflux 时，已有配图仍可查看，但不能生成或补图。

## 关闭服务

在对应服务的终端窗口按 **Control-C**。8788 和 8787 分别运行，因此需要分别停止。

## 模型与本地文件

- 8788 使用 `models/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16` 生成语音，并使用 Qwen Image 模型生成 Part 2 情景图。
- 模拟考使用 [`mlx-community/whisper-large-v3-turbo`](https://huggingface.co/mlx-community/whisper-large-v3-turbo) 在本机转写英文，并使用 [`mlx-community/Qwen3-4B-4bit`](https://huggingface.co/mlx-community/Qwen3-4B-4bit) 在本机评分；两者约增加 3.9 GB 权重。Whisper 模型按 MIT 许可发布，Qwen3 按 Apache-2.0 许可发布；请以模型仓库随附的许可文件为准。
- 8787 使用 Qwen Image 2.1 MLX 4-bit 模型生成图片；默认优先使用 `models/Qwen-Image-2.1-MLX-4bit-Heretic`，否则使用 `models/Qwen-Image-2.1-MLX-4bit`。
- 8787 的图生视频模式使用 `models/Wan2.2-TI2V-5B-MLX-Q8` 和隔离环境 `.venv-wan22-mlx/bin/python`。两种模式共用任务状态和单任务锁，避免同时占用统一内存；缺少 Wan 文件时图像模式仍可独立使用。
- 模型文件、语音缓存、输入材料和生成图片不纳入 Git 提交。模型的许可说明见 [`speech/README.md`](speech/README.md)。
- 视觉生成工作室的功能与参数说明见 [`web/README.md`](web/README.md)。
- 8787 分别检查 Qwen 图片模型/mflux 和 Wan 模型/运行环境；任一模式未就绪只会禁用对应模式，不影响另一模式，也不影响 8788 对已导入语音和图片的离线使用。
