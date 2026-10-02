# KET Speaking Studio · 本地 AI 练习工具

本项目提供两个独立的本地 Web 服务：KET 英语跟读练习（8788）和 Qwen 图片生成工作室（8787）。两个服务都只监听 `127.0.0.1`，仅供本机浏览器访问。

## 两个服务分别做什么

### KET Speaking 跟读练习 · 8788

打开 <http://127.0.0.1:8788>。选择本机的 Markdown 练习材料后，页面会按 Part 1 / Phase 1、Part 1 / Phase 2、Part 2 的顺序整理问答。点击句子即可用本地 Qwen3-TTS 模型生成并播放语音，也可以配置基础音色、问句语气和回答语气标签。

页面还支持为整份材料生成本地离线语音缓存，以及为 Part 2 对话情景生成配图。配图由本机 Qwen Image 模型生成；这些功能都由 8788 服务调用，不需要另外打开 8787 页面。练习材料、语音缓存和情景图片保存在本机 `outputs/speech-practice/`。

跟读页还支持跨设备的离线资源包：完整离线语音通过校验后，可以下载 `.ketpack.zip`；压缩包包含当前 Markdown、该材料的全部 WAV，以及已经生成的 Part 2 配图，不包含模型或运行环境。在另一台 Mac 的 8788 页面导入后，材料会自动载入，可直接播放包内语音和查看图片。每次只保留一份活动语音包；成功导入会替换它，校验失败则保留原资源。

### Qwen Image 图片生成工作室 · 8787

打开 <http://127.0.0.1:8787>。这是独立的图片生成页面，可配置提示词、负面提示词、尺寸、步数、Seed 等参数，也可选择一张本地图片作为 img2img 初始图。生成结果可在页面预览和下载，任务文件保存在 `outputs/web-ui/`。

## 首次安装

适用于 Apple Silicon Mac。双击项目根目录的 [`install.command`](install.command)，按提示完成依赖和本地模型安装。安装脚本会启动 KET Speaking 服务并打开 8788 页面。首次安装需要下载约 25 GB 的语音与图片模型，建议预留至少 40 GB 可用空间。系统要求、下载过程和模型许可说明见 [`speech/README.md`](speech/README.md)。

## 启动服务

安装完成后，如需同时使用两个服务，在项目根目录分别打开两个终端窗口，并保持窗口运行：

**终端窗口 1：KET Speaking 跟读练习（8788）**

```sh
npm run start:tts
```

浏览器打开 <http://127.0.0.1:8788>。也可以双击 `install.command` 启动此服务。

**终端窗口 2：Qwen Image 图片生成工作室（8787）**

```sh
npm start
```

浏览器打开 <http://127.0.0.1:8787>。这两个进程相互独立；关闭某个终端只会停止对应服务。

带模型的完整运行环境需要 Node.js 22 或更新版本，以及安装脚本准备的项目 `.venv` 和模型。没有模型的 Mac 也能启动 8788：只需 Node.js 22+，以及 macOS 自带的 `zip`/`unzip`；在终端运行 `npm run start:tts`，打开 <http://127.0.0.1:8788> 并导入资源包。此场景不要运行 `install.command`，以免下载模型。没有本地语音能力时，页面只播放资源包中已有的离线 WAV；缺少的句子不可播放，也不会触发实时合成或缓存生成。没有图片模型和 mflux 时，已有配图仍可查看，但不能生成或补图。

## 关闭服务

在对应服务的终端窗口按 **Control-C**。8788 和 8787 分别运行，因此需要分别停止。

## 模型与本地文件

- 8788 使用 `models/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16` 生成语音，并使用 Qwen Image 模型生成 Part 2 情景图。
- 8787 使用 Qwen Image 2.1 MLX 4-bit 模型生成图片；默认优先使用 `models/Qwen-Image-2.1-MLX-4bit-Heretic`，否则使用 `models/Qwen-Image-2.1-MLX-4bit`。
- 模型文件、语音缓存、输入材料和生成图片不纳入 Git 提交。模型的许可说明见 [`speech/README.md`](speech/README.md)。
- 图片工作室的功能与参数说明见 [`web/README.md`](web/README.md)。
- 没有 Qwen Image 模型或 mflux 时，8787 仍会显示模型未就绪状态，但图像生成按钮会禁用；此状态不会影响 8788 对已导入语音和图片的离线使用。
