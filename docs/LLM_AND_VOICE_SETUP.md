# LLM API 与免费语音配置

本机预览地址：<http://127.0.0.1:5178/learnbuddy/>。教师可选陈知行，学生可选林一；这是独立教学样例库。

## 接入 DeepSeek

配置已准备在 `plugins/dsh-plugin-learnbuddy/web/.env.local`（已被 Git 忽略）。当前只缺真实 API Key，在本机编辑这一行即可：

```dotenv
LLM_API_KEY=你的密钥
```

其余已配置：

```dotenv
LLM_PROVIDER=deepseek
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL_TEXT=deepseek-flash
LLM_MODEL_VISION=deepseek-flash
```

API Key 从 [DeepSeek 平台](https://platform.deepseek.com/) 创建。`deepseek-flash` 是官方当前 Flash 接口名，支持图文输入，依据 [2026-09-10 官方发布说明](https://www.deepseek.com/en/news/deepseek-v4-1-flash/)。模型使用计费以平台账户为准。

密钥仅供教学后端与 DSH 服务读取。不要写成 `VITE_LLM_API_KEY`，也不要贴进前端代码、文档或聊天。

编辑后重启“教学服务”和“DSH”两个本机进程。两者启动时都会读取同一份 `.env.local`；不需要在页面中重复填写。DSH 的模型配置只存环境变量引用，不把密钥写进插件补丁。

## 启动与检查

在 `plugins/dsh-plugin-learnbuddy/web` 目录使用 Node.js 24，分别在三个终端启动：

```sh
npm run dev:services
npm run dev:dsh
npm run dev
```

分别监听 `127.0.0.1:3091`（教学与语音）、`127.0.0.1:3089`（DSH）和 `127.0.0.1:5178`（页面）。首次或重启 DSH 后，在使用页面的同一个浏览器中打开启动输出的本机登录链接，然后回到课件页选择“DSH 对话”。本次内置浏览器与 Chrome 已完成登录；下次 DSH 重启时链接会变化。

新环境先分别在插件目录、web 目录执行 `npm ci`，再在 web 目录执行 `npm run setup:dsh`。`.env.example` 是无密钥配置模板；本机现有 `.env.local` 无需覆盖。三个服务的数据与 DSH 工作目录保存在被忽略的 `.dsh-preview/` 中。

填入 Key 后可运行：

```sh
npm run check:llm
```

此命令会实际请求文本模型和图片模型，检查文本回答与自生成测试图片的读图结果。没有 Key 时只会显示跳过，**退出成功不代表模型验证通过**；需要看到具体文本与视觉检查通过。然后分别在“课件答疑”和“DSH 对话”发送一个公开测试问题，确认两条链路。

教学后端也兼容智谱：`LLM_PROVIDER=zhipu`、`LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4`，模型名按所用账户配置。当前自动连接 DSH 的本机方案按 DeepSeek 验证；其他提供商需在 DSH 模型设置中选择相应适配器并单独验收。

## 免费语音已经配置的部分

使用这台 Mac 已有的共享 `andy-stt` 与本地 Whisper 模型，没有重复安装模型，没有语音 API 调用费用。底层使用开源 [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 或现有的本机加速后端。

```dotenv
LEARNBUDDY_STT_COMMAND=/Users/andy/.local/bin/andy-stt
LEARNBUDDY_STT_MODEL=small
LEARNBUDDY_STT_DEVICE=auto
```

使用：点击“语音输入”并允许麦克风，讲话后点击停止，等待文字进入当前输入框，检查后再发送或保存。支持课件问答、DSH 原生输入框、备课草稿、作业任务要求与综合反馈。

一次最多录制 60 秒、8 MB，服务同时处理一段音频。音频转写在本机完成，临时录音和转写文件处理完即删除。识别文字留在表单草稿；只有用户点击发送后，文字才进入所选模型。模型权重使用已有共享目录。

已用公开中文样本完成一次真实转写。麦克风权限、现场噪声与专业术语需要在实际浏览器中口述验收；本次没有录制用户环境声音。

`GET /api/learnbuddy/speech/status` 可查看是否找到可执行的语音服务；`ready=true` 只说明入口可运行，不代替实际转写测试。

## 公网与其他机器

本次配置只在当前 Mac 生效，未更新公网。部署到其他机器时需要在教学服务所在机器配置可用的语音执行器，并确保它支持 `--input / --model / --device / --language / --output` 参数，输出包含 `text` 和 `duration` 的 JSON。

浏览器录音需要 HTTPS 或 localhost。公网 HTTP 页面不能视为语音已可用。迁移配置时只迁移环境变量和服务部署方案，不上传本机密钥、教学样例库、DSH 会话或模型缓存。
