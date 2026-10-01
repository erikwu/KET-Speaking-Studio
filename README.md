# Qwen Image Studio

## KET Speaking

Apple Silicon Mac 新机器可双击项目根目录的 [`install.command`](install.command)，自动安装语音与配图模型、准备本地运行环境并启动跟读 Web App。完整步骤和系统要求见 [`speech/README.md`](speech/README.md)。

在本机通过浏览器使用 Qwen-Image-2.1 MLX 模型生成图片。页面和服务只监听 `127.0.0.1`；提示词、参考图和生成图像都留在本机。

## 环境要求

- Apple Silicon Mac 和可用的 MLX / Metal 环境
- 项目内已安装 mflux 的 `.venv`
- Node.js 22 或更新版本

## 启动服务

在项目根目录打开终端并运行：

```sh
npm start
```

终端显示 `Qwen Image Studio is ready at http://127.0.0.1:8787` 表示服务已启动。保持这个终端窗口打开，服务运行期间不要关闭它。

默认优先使用完整的 `models/Qwen-Image-2.1-MLX-4bit-Heretic`；该目录不可用时，会回退到 `models/Qwen-Image-2.1-MLX-4bit`。如需选择其他兼容模型目录，可在启动时设置：

```sh
MFLUX_MODEL_PATH="models/你的模型目录" npm start
```

## 打开页面

在浏览器访问：<http://127.0.0.1:8787>

不要把服务地址改成 `0.0.0.0` 或转发到公网。默认监听回环地址，只供这台电脑访问。

## 查询服务状态

在另一个终端窗口执行：

```sh
curl -fsS http://127.0.0.1:8787/api/config
```

服务正常时会返回 JSON，其中：

- `modelReady: true` 表示模型目录结构完整。
- `cliReady: true` 表示项目内的 mflux 生成命令存在。
- `modelName` 和 `modelPath` 显示当前使用的模型。

如果请求失败，先确认启动服务的终端还开着。也可检查 8787 端口是否有服务监听：

```sh
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

## 关闭服务

在运行 `npm start` 的终端按 **Control-C**。停止后，浏览器刷新页面会无法连接服务。

如果忘记哪个终端启动了服务，可先运行 `lsof -nP -iTCP:8787 -sTCP:LISTEN` 找到监听进程的 PID，再只结束该 PID：

```sh
kill <PID>
```

不要用 `killall node`，它会一并关闭这台电脑上其他 Node.js 程序。

如果 8787 已被另一个程序占用，可以改用其他端口启动：

```sh
PORT=8788 npm start
```

此时页面地址为 <http://127.0.0.1:8788>，查询状态也要改用该端口。

## 图片与模型参数

- 支持提示词、负面提示词、步数、Seed、宽高、Guidance、输出格式、低内存模式和 VAE 分块解码。
- 可选一张 PNG、JPEG 或 WebP 初始图。当前本地 mflux checkpoint 使用 img2img 初始图与影响强度，不支持多图指令编辑。
- 宽高需为 16 的倍数。Guidance 大于 1 时需填写负面提示词。
- 生成图片和任务输入保存在 `outputs/web-ui/`。

更详细的模型参数说明见 [`web/README.md`](web/README.md)。
