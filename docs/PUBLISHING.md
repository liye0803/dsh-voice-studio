# 开源插件发布流程（以 dsh-voice-studio 为实例）

一份从“能跑”到“能发、有人装、能维护”的检查清单。按阶段顺序做，每阶段都有验收标准。
方括号里是本次实践踩过的真实坑。

---

## 阶段 0 · 定边界（先想清楚，省得后面返工）

- **它做什么 / 不做什么**：插件只做编排与界面，还是连模型一起打包？
  - 本项目：不含模型与推理环境，只做编排 + 界面 + 保活。→ 文档必须反复强调，否则用户装完以为坏了。
- **平台**：Windows / macOS / Linux？
  - 本项目仅 Windows（PowerShell、WMI、explorer），`package.json` 写死 `os: ["win32"]`，装错平台直接拒绝。
- **依赖形态**：是否强依赖外部服务（引擎端口、外部目录布局）？
  - 强依赖就要有“检测 + 指引”，不能默认用户已经装好。

**验收**：能用三句话向陌生人解释「这是什么、装它需要什么、装完能干什么」。

---

## 阶段 1 · 代码整理

| 事项 | 要求 |
|---|---|
| 目录结构 | 宿主/界面/脚本分离；界面若热加载，单独文件（本项目 `page.html`） |
| 开发反馈 | 改界面只按 F5；改宿主才重启（写进文档，节省大量调试时间） |
| 版本号 | 对外 `package.json` 语义化；内部可另留构建戳（`BUILD`），但要在文档说明区别 |
| 默认值 | **不要写死作者本机路径**，全部留空 + 首次配置引导 [坑：默认值指向 `D:\...`，别人装了看似正常实则全错] |
| 首次运行 | 缺配置时**快速失败并给出指引**，不要挂起或写相对路径 [坑：没参考音时试听卡 180 秒超时；导入写到相对 `ref\` 污染目录] |
| 安全 | 所有文件读接口做路径白名单 [坑：`/audio?path=` 曾接受任意路径，可读任意文件] |

**验收**：新机器、空配置下，每个按钮要么能用，要么给出一句可执行的修复提示。

---

## 阶段 2 · 元数据与许可

`package.json` 必须齐：

```json
{
  "name": "dsh-voice-studio",
  "version": "1.0.0",
  "private": false,          // 去掉 private 才能发
  "description": "一句话说清是什么",
  "keywords": ["dsh", "dsh-plugin", "..."],
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/<user>/<repo>.git" },
  "homepage": "https://github.com/<user>/<repo>#readme",
  "bugs": { "url": "https://github.com/<user>/<repo>/issues" },
  "author": "<user> <https://github.com/<user>>",
  "files": ["lib", "tools", "docs", "README.md", "CHANGELOG.md", "LICENSE"],
  "os": ["win32"],
  "engines": { "node": ">=22" }
}
```

- 加 `LICENSE` 文件（不是只写字段）[坑：`files` 里声明了 LICENSE 但文件不存在]
- `.gitignore`：`node_modules`、`__pycache__`、日志、venv、临时产物
- `.gitattributes`：`* text=auto eol=lf`，避免 Windows 换行污染 diff

**验收**：`npm pack --dry-run` 列出的文件里没有多余/缺失，体积合理（本项目 40KB / 12 文件）。

---

## 阶段 3 · 文档

| 文件 | 内容 |
|---|---|
| `README.md` | 一句话定位 → 英文速览 → **截图** → 功能清单 → 环境要求 → 安装 → 首次配置 → 使用 → 目录结构 → 开发 → 已知限制 → FAQ → 合规 → 许可 |
| `CHANGELOG.md` | 按版本倒序，首条放最新 |
| `AGENTS.md` | 给接手的人/AI：路径、改哪生效、命令、关键设计、踩过的坑 |
| `docs/example-settings.json` | 脱敏示例配置 |
| `docs/screenshots/` | 3 张起步：主功能页、第二功能页、设置页 |

**截图很关键**：没有图的项目基本没人点。压到 1400px 宽（本项目 3 张共 300KB×3）。

**验收**：陌生人只看 README 能装起来；第二次打开能查到“改哪里生效”。

---

## 阶段 4 · 质量保障

1. **语法检查**（每个入口文件）：`node --check lib/*.js`
2. **页面脚本检查**：从 HTML 里抽出 `<script>` 再 `node --check`
   [坑：PowerShell 读文件默认 GBK，中文注释会误报语法错误 → 必须 `-Encoding UTF8`]
3. **接口冒烟**：临时数据目录起独立实例，逐项打接口（本项目 `scripts/test-api.mjs`，19 项）
4. **CI**：GitHub Actions 跑上面全部；提交即验证
5. **初始状态测试**：空配置下的行为要单独测（守卫、报错文案）

**验收**：`npm test` 全绿；CI 在 PR 上也能跑。

---

## 阶段 5 · 合规与免责

- 不下载、不分发模型/音色/音频内容
- 第三方组件（模型、推理引擎、ffmpeg）各自许可，README 里点名
- **音色克隆必须获得授权**（人格权/著作权风险）
- 不提供平台抓取（音乐平台条款风险）
- 明确“按 MIT 提供，后果自负”

**验收**：README 有一节「合规与免责」，不是一句话敷衍。

---

## 阶段 6 · 仓库与首次推送

```powershell
cd <项目>
git init
git config user.name "<user>"
git config user.email "<user>@users.noreply.github.com"
git add -A
git commit -m "chore: 初始发布 v1.0.0"
git branch -M main
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

- 先在 GitHub 建**空仓库**（不要勾 README/LICENSE/.gitignore）
- 提交作者要统一 [坑：用默认机器名提交，历史里全是 `voice-studio <voice-studio@localhost>`；用 `git filter-branch --env-filter` 批量改]
- **网络**：国内直连 `github.com:443` 常被重置
  [坑：浏览器能打开是因为走系统代理，git 默认不走 → `Failed to connect` / `Connection was reset`]
  - 有代理：`git config --global http.proxy http://127.0.0.1:7890`（同样设 https.proxy）
  - 代理关了要 `--unset`，否则 git 报“走代理连不上”
  - `api.github.com` 可能通而 `github.com` 不通，别用 api 能不能通判断 git 能不能推

**验收**：`git ls-remote origin` 能返回 refs；仓库页能看到文件。

---

## 阶段 7 · 版本与 Release

1. 语义化版本：修 bug → `1.0.1`；加功能 → `1.1.0`；破坏性 → `2.0.0`
2. 打 tag 并推送：`git tag -a v1.0.1 -m "..."` + `git push origin v1.0.1`
3. GitHub → Releases → Draft a new release → **必须选 tag**（不选会报 `tag name can't be blank`）[坑]
4. 标题写版本号，描述写变更（按文档/工具/修复分组好读）
5. 需要的话附 tarball（`npm pack` 产物），不附也行

**本项目的自动化**：`node scripts/release.mjs 1.1.0 "说明"` → 改版本 + 插 CHANGELOG + commit + tag + push。

用 token 全自动建 Release（可选）：Fine-grained token，仅该仓库 `Contents: Read and write`，7 天过期；
调 `POST /repos/{owner}/{repo}/releases`。**用完立刻撤销，别把 token 写进仓库或聊天记录。**

**验收**：Releases 列表有新版且标 Latest；`/releases/tag/vX.Y.Z` 返回 200。

---

## 阶段 8 · 曝光

- 仓库 **Topics**：`dsh-plugin` 这类分发关键字 + 领域词（`tts`、`rvc`、`voice`）
  [坑：粘贴一串逗号分隔会被当成一个标签（含空格），必须逐个回车]
- README 顶部有截图、有安装命令、有“需要什么依赖”
- Release 写清“装了就能用 / 还要额外配什么”
- 可选：npm 发布（`npm publish --access public`）、提交到第三方插件目录

**验收**：在 GitHub 搜索 `dsh-plugin` 能找到自己。

---

## 阶段 9 · 发布后维护

- Issue 模板（Bug 必填：版本、系统、显卡、复现步骤、诊断包）
- PR 模板（自测勾选项：跑过测试、F5 验证、重启验证）
- 每次发版：跑测试 → 更新 README/CHANGELOG → `release.mjs` → 网页或 API 建 Release
- 回归清单（本项目）：
  - 空配置启动 → 每个按钮都给出指引
  - 引擎离线/启动中 → 不误报
  - 翻唱：分离 → 变声 → 混音 全链路
  - 导入：配置/RVC 模型/参考音 三种
  - 安全：越界路径被拒

---

## 最快路径：推 tag 即发布

本仓库配置了两个工作流：

| 工作流 | 触发 | 做什么 |
|---|---|---|
| `ci.yml` | push / PR | 语法检查 + 19 项接口冒烟 |
| `release.yml` | push tag `v*` | 从 CHANGELOG 抽本节说明，自动建 GitHub Release |

所以发版退化成两条命令：

```powershell
node scripts/release.mjs 1.0.2 "修了什么"   # 改版本 + CHANGELOG + commit + tag + push
# 完了。1~2 分钟后 Release 自动出现，无需点网页
```

想再快：直接用 `gh` CLI（需要本机装 gh 并登录）

```powershell
gh release create v1.0.2 --notes-file notes.md
```

## 最小可行路径（只求“能发出去”，约 1 小时）

1. `package.json` 填齐 + `LICENSE`
2. README 写：是什么 / 需要什么 / 怎么装 / 怎么用
3. 语法检查能过
4. 建空仓库 → push → 打 tag → 建 Release
5. 加 Topics

## 完整路径（求“有人用、能维护”，约 3~5 小时）

上面 0~9 全做。本项目实际耗时：代码整理与修复 ≈ 2h，文档与截图 ≈ 1h，
CI + 测试 + 模板 ≈ 1h，发布与排错（代理、tag、topics）≈ 30min。

---

## 本次踩坑速查（按出现顺序）

| 坑 | 现象 | 解法 |
|---|---|---|
| 默认值写死作者路径 | 别人装后“看似正常实则全错” | 默认空 + 首次引导 |
| 空配置挂起 | 试听卡 180 秒 | 前置校验，快速失败 |
| 相对路径写入 | `ref\` 落到工作目录 | 路径白名单 + 先校验根目录 |
| 任意路径读文件 | 安全漏洞 | 白名单前缀匹配 |
| PowerShell 编码 | 中文注释误报语法错误 | 显式 `-Encoding UTF8` |
| 提交作者是机器名 | 历史难看 | `filter-branch --env-filter` |
| git 不走代理 | `Failed to connect` | 配 `http.proxy`；代理关了要 unset |
| Release 没选 tag | `tag name can't be blank` | 先选 Existing tag |
| Topics 带空格 | `must start with a lowercase letter` | 逐个回车 |
| 依赖引擎升级覆盖 | 本地补丁失效 | 加“守卫”在启动时自动重打 |
