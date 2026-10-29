# AGENTS.md · 音色工坊（dsh-voice-studio）

给任何接手这个项目的 AI / 人看的速查。**先读这个，再看代码。**

## 这个项目是什么

DeepSeek Harness 插件（Windows 专用）：侧边栏管理 GPT-SoVITS 音色（零样本/训练/切换/试听）
与 RVC 翻唱（分离→变声→混音）。插件本身不含模型与引擎，只做编排、界面、保活。

- 仓库：https://github.com/liye0803/dsh-voice-studio
- 许可：MIT
- 当前版本：见 `package.json`（对外语义化）· `lib/app.js` 里的 `BUILD`（构建戳）

## 三处路径（别搞混）

| 用途 | 路径 | 谁管 |
|---|---|---|
| 插件代码 | `D:\AI_Tools\dsh-voice-studio` | git 仓库，改动在这 |
| 说话引擎 | `D:\AI_Tools\dania-voice` | GPT-SoVITS + venv + asr-venv + 底模 + `ref\` 参考音 |
| 翻唱引擎 | `E:\Aurabot\rvc` | python env + Applio + audio-separator + ffmpeg + `models\` |
| 运行数据 | `C:\Users\xu050\.dsh\voice-studio` | settings/voices/jobs/logs/samples/uploads/dataset |

引擎地址：`http://127.0.0.1:9880`（启动脚本是 `D:\AI_Tools\dania-voice\start-tts-bg.cmd`，
必须用 WMI 启动才不会被 DSH 退出带走，插件里 `startTts()` 已这样做）。

## 改哪里、怎么生效

| 文件 | 生效方式 |
|---|---|
| `lib/page.html`（整个界面，HTML+CSS+JS 单文件） | **面板 F5 刷新即可**（热加载，不用重启） |
| `lib/app.js`（核心逻辑） | **重启 DSH** |
| `lib/index.js`（宿主路由/看门狗） | 重启 DSH |
| `lib/client.js`（侧边栏入口） | 重启 DSH |
| `tools/*.py`（训练/打标） | 下次任务生效 |

⚠️ 改 `page.html` 后必须先做语法检查，否则整页 JS 失效（历史上踩过两次）：

```powershell
cd D:\AI_Tools\dsh-voice-studio
$html=Get-Content lib/page.html -Raw -Encoding UTF8
$m=[regex]::Match($html,'(?s)<script>(.*?)</script>')
Set-Content page.check.js -Value $m.Groups[1].Value -Encoding UTF8
node --check page.check.js; Remove-Item page.check.js
```

（`-Encoding UTF8` 不能省，中文 Windows 默认 GBK 读会误报。）

## 常用命令

```powershell
# 语法检查 + 接口冒烟（19 项，初装态）
cd D:\AI_Tools\dsh-voice-studio
npm test
npm run check

# 独立预览（不开 DSH，跑当前文件）
node lib/index.js --standalone 9909
# → http://127.0.0.1:9909/voice-studio/app

# 发版（改版本 → CHANGELOG → commit → tag → push）
node scripts/release.mjs 1.1.0 "这次改了什么"

# 手动启动/重启语音引擎
D:\AI_Tools\dania-voice\start-tts-bg.cmd
```

Node 装在 `E:\node`（v22，已加用户 PATH，便携版）。

## 关键设计（改之前先理解）

- **引擎保活**：60 秒看门狗 + WMI 独立进程；`autoStartEngine` 关闭时不自动拉。
- **训练/翻唱前暂停引擎**：`autoPauseTts`，结束后恢复；期间 Aurabot 侧失败会改发文字。
- **Aurabot 机械音兜底守卫**：`ensureAurabotNoFallback()` 会在启动/同步时给
  `~/.dsh/profiles/desktop/node_modules/dsh-aurabot-qq/src/voice/tts.js` 打补丁
  （合成失败直接抛错，不降级 Windows 语音）。Aurabot 升级会覆盖该文件，守卫会自动重打。
- **安全**：`/voice-studio/api?action=audio` 只允许读数据目录、输出目录、参考音目录。
- **初装守卫**：未配置 `installRoot`/`rvcRoot`/`refAudio` 时，试听/训练/翻唱/导入都会
  快速失败并给出指引，不会挂 180 秒或写到相对路径。
- **翻唱分离**：`audio-separator` 的 `--model_filename` **必须带扩展名**（`.ckpt`），
  去掉就报 "not found in supported model files"。

## 发布

```powershell
node scripts/release.mjs 1.0.2 "修了什么"     # 打 tag + push
# 然后在 GitHub Releases 页面点 Draft a new release 选 tag
```

注意：发布 Release 时必须**先选 tag**，否则报 "tag name can't be blank"。

## 已知限制

- 仅 Windows（PowerShell / WMI / explorer）
- 6GB 显存：TTS 与 RVC 不能同时常驻；GPT-SoVITS 只能训 v2（v2ProPlus 会 OOM）
- 翻唱依赖 Aurabot 风格的 RVC 目录布局
- 训练轮数/batch 仍手动（可改进：OOM 自动降档）
