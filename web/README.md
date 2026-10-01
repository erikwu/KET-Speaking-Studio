# Qwen Image Studio

本机运行的 Qwen-Image-2.1 Web 界面，使用项目中的 mflux 虚拟环境和 MLX checkpoint。界面和推理服务只监听 `127.0.0.1`，参考图和生成结果不会上传到远程服务。

## 启动

需要 Apple Silicon Mac、项目内已安装 mflux 的 `.venv`、以及 Node.js 22 或更新版本。于项目根目录运行：

```sh
npm start
```

在浏览器打开 <http://127.0.0.1:8787>。默认优先使用 `models/Qwen-Image-2.1-MLX-4bit-Heretic`；如果该目录不存在或不完整，则使用 `models/Qwen-Image-2.1-MLX-4bit`。可通过 `MFLUX_MODEL_PATH` 环境变量指定另一个兼容的本地模型目录。

生成图像和本次任务的输入文件保存在 `outputs/web-ui/`。页面提供图像预览和下载。

## 当前 checkpoint 支持的输入和参数

- 提示词、负面提示词、步数、Seed、宽高、Guidance。
- 可选一张 PNG、JPEG 或 WebP 初始图；此 mflux checkpoint 用 img2img 的 `--image` / strength 路径，不是支持最多十张图的多模态编辑 checkpoint。
- PNG、WebP、TIFF 输出。
- 低内存模式和 VAE 分块解码。
- 宽高必须是 16 的倍数。步数为 1–100；Guidance 大于 1 时 mflux 需要非空负面提示词。

模型 README 建议 40 步、Guidance 1，并推荐 `--low-ram`。Web 界面默认使用这些设置。
