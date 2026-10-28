// Voice Studio —— 插件主体逻辑（与 DSH 解耦，可独立跑）
// 环境自检 / 智能推荐 / 音色库（增删改）/ 训练队列与历史 / 试听 / 对外接口 / 配置导入导出。
import { execFile, execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { cpus, homedir, totalmem } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

const run = promisify(execFile)
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUILD = '2026-10-28 20:50 (v2.3)'

const DEFAULTS = {
  installRoot: '',
  ttsUrl: 'http://127.0.0.1:9880',
  refAudio: 'D:\\AI_Tools\\dania-voice\\ref\\yinlang-ref-norm.wav',
  refText: '我喜欢的游戏总在同一天更新版本。他们是约好了吗？',
  logRoot: '',
  nameTemplate: '{name}-e{epoch}',
  autoPauseTts: true,
  autoStartEngine: true,
  rvcRoot: '',
  outDir: '',
  setupDone: false,
}

export function createApp({ home = process.env.DSH_HOME || join(homedir(), '.dsh') } = {}) {
  const dir = join(home, 'voice-studio')
  mkdirSync(dir, { recursive: true })
  const settingsFile = join(dir, 'settings.json')
  const voicesFile = join(dir, 'voices.json')
  const jobsFile = join(dir, 'jobs.json')
  const uploadDir = join(dir, 'uploads')
  mkdirSync(uploadDir, { recursive: true })

  const readJson = (file, fallback) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return fallback
    }
  }
  const writeJson = (file, value) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  }

  const settings = () => ({ ...DEFAULTS, ...readJson(settingsFile, {}) })
  const saveSettings = (patch) => {
    const next = { ...settings(), ...patch }
    writeJson(settingsFile, next)
    return next
  }

  const dirs = () => {
    const s = settings()
    return {
      root: s.installRoot,
      gpt: join(s.installRoot, 'gpt-sovits'),
      gptW: join(s.installRoot, 'gpt-sovits', 'GPT_weights'),
      sovitsW: join(s.installRoot, 'gpt-sovits', 'SoVITS_weights'),
      models: join(s.installRoot, 'gpt-sovits', 'GPT_SoVITS', 'pretrained_models'),
      py: join(s.installRoot, 'venv', 'Scripts', 'python.exe'),
      asrPy: join(s.installRoot, 'asr-venv', 'Scripts', 'python.exe'),
      logs: s.logRoot || join(dir, 'logs'),
    }
  }

  // ---------- 环境自检 ----------
  async function envCheck() {
    const d = dirs()
    const s = settings()
    const check = (key, label, ok, detail, fix) => ({ key, label, ok, detail, fix: ok ? '' : fix })
    const out = []

    let vram = 0
    try {
      const { stdout } = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { timeout: 8000 })
      const gpu = String(stdout).trim()
      vram = Number((gpu.match(/(\d+)\s*MiB/) || [])[1] || 0)
      out.push(check('gpu', 'NVIDIA 显卡', vram > 0, `${gpu}（${Math.round(vram / 1024)} GB 显存）`, '没有显卡也可以跑，但训练很慢'))
      const vramOk = vram >= 5120
      const vramDetail = vram >= 8192 ? '≥8G，可训 v2ProPlus（s1+s2）' : vram >= 5120 ? '6G 档：可用 v2 小模型训练（已实测），v2ProPlus 会 OOM' : '显存偏低，建议只用零样本'
      out.push(check('vram', '训练档位', vramOk, vramDetail, '换 8G 以上显卡，或只用零样本'))
    } catch {
      out.push(check('gpu', 'NVIDIA 显卡', false, '未检测到 nvidia-smi', '没有显卡仍可推理（CPU 很慢）'))
      out.push(check('vram', '显存够训练', false, '未知', ''))
    }

    out.push(check('venv', 'Python 运行环境', existsSync(d.py), d.py, '按 README 重新部署，或改「安装根目录」'))
    out.push(check('asr', '转写环境', existsSync(d.asrPy), d.asrPy, '同上'))
    out.push(check('repo', 'GPT-SoVITS 源码', existsSync(join(d.gpt, 'api_v2.py')), d.gpt, '把整合包解压到安装根目录下的 gpt-sovits'))
    const need = ['s1v3.ckpt', 'v2Pro/s2Gv2ProPlus.pth', 'chinese-roberta-wwm-ext-large/pytorch_model.bin', 'chinese-hubert-base/pytorch_model.bin', 'sv/pretrained_eres2netv2w24s4ep4.ckpt']
    const missing = need.filter((f) => !existsSync(join(d.models, f)))
    out.push(check('models', '底模', missing.length === 0, missing.length ? '缺：' + missing.join('、') : '5 个底模齐全', '从 ModelScope 补下底模到 pretrained_models'))
    out.push(check('ref', '参考音', existsSync(s.refAudio), s.refAudio, '选一段 5~10 秒干净人声，或上传后填路径'))

    let online = false
    let control = false
    try {
      const r = await fetch(`${s.ttsUrl}/control?command=config`, { signal: AbortSignal.timeout(4000) })
      online = r.ok
      control = true
    } catch {}
    let booting = false
    if (!online) {
      try {
        const { stdout } = await run('powershell', ['-NoProfile', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -match 'api_v2' }).Count"], { timeout: 5000 })
        booting = Number(String(stdout).trim()) > 0
      } catch {}
    }
    out.push(check(
      'tts',
      '语音引擎',
      online || booting,
      online ? `${s.ttsUrl} 在线` : booting ? '启动中…模型加载约 40 秒，稍后点「重新检测」' : `${s.ttsUrl} 没应答`,
      '点「启动引擎」，或双击 start-tts.cmd',
    ))

    let listening = false
    try {
      const ports = await run('powershell', ['-NoProfile', '-Command', "(Get-NetTCPConnection -LocalPort 9880 -State Listen -ErrorAction SilentlyContinue).OwningProcess"], { timeout: 6000 })
      listening = String(ports.stdout).trim().length > 0
    } catch {}
    out.push(check('port', '端口没被乱占', online || !listening, listening ? (online ? '9880 被本插件引擎占用' : '9880 被别的程序占用') : '9880 空闲', '换端口：改引擎地址，同时用 -p 启动 api_v2'))

    let writable = false
    try {
      mkdirSync(d.gptW, { recursive: true })
      writable = statSync(d.gptW).isDirectory()
    } catch {}
    out.push(check('weights', '权重目录可写', writable, d.gptW, '检查磁盘权限或改安装根目录'))

    return { ok: true, items: out, settings: s }
  }

  async function plan() {
    const s = settings()
    const vs = voices().items.filter((v) => v.id !== 'zero-shot')
    const trained = vs.filter((v) => v.gpt && v.sovits)
    let vram = 0
    try {
      const { stdout } = await run('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { timeout: 8000 })
      vram = Number(String(stdout).trim().split('\n')[0]) || 0
    } catch {}
    let online = false
    try {
      online = (await fetch(`${s.ttsUrl}/control?command=config`, { signal: AbortSignal.timeout(2500) })).ok
    } catch {}
    const canTrain = vram >= 8000
    let mode, label, detail
    if (trained.length) {
      mode = 'use-trained'
      label = '用已训练音色'
      detail = `已有 ${trained.length} 个完整音色，直接切换即可`
    } else if (canTrain) {
      mode = 'train'
      label = '本机可训练'
      detail = '显存 ≥8G，可以训 s1+s2，训完更像本人'
    } else {
      mode = 'zero-shot'
      label = '零样本（推荐）'
      detail = `显存 ${vram ? Math.round(vram / 1024) + 'G' : '未知'}：v2ProPlus 训练会 OOM，可试 v2 小模型（6G 实测可训），或直接用零样本`
    }
    return { ok: true, vramMB: vram, engineOnline: online, trained: trained.length, mode, label, detail, canTrain, autoStartEngine: s.autoStartEngine }
  }

  // ---------- 引擎 ----------
  async function ensureEngine() {
    const s = settings()
    if (!s.autoStartEngine) return false
    try {
      const r = await fetch(`${s.ttsUrl}/control?command=config`, { signal: AbortSignal.timeout(2500) })
      if (r.ok) return true
    } catch {}
    startTts()
    return false
  }

  async function ttsPids() {
    try {
      const { stdout } = await run('powershell', ['-NoProfile', '-Command', "(Get-NetTCPConnection -LocalPort 9880 -State Listen -ErrorAction SilentlyContinue).OwningProcess"], { timeout: 8000 })
      return String(stdout).split(/\s+/).filter(Boolean)
    } catch {
      return []
    }
  }
  async function stopTts() {
    for (const pid of await ttsPids()) {
      try {
        await run('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`], { timeout: 8000 })
      } catch {}
    }
  }
  function startTts() {
    const d = dirs()
    try { writeFileSync(join(d.root, 'logs', 'start.log'), '[' + new Date().toISOString() + '] startTts called\n', { flag: 'a' }) } catch {}
    const bg = join(d.root, 'start-tts-bg.cmd')
    try {
      // 用 WMI 创建进程：父进程是 WmiPrvSE，不挂在 DSH 的进程树上，
      // DSH 退出时不会把引擎一起带走。
      const ps = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='cmd /c ${bg}'} | Out-Null`
      run('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }).catch(() => {})
      try { writeFileSync(join(d.root, 'logs', 'start.log'), '[' + new Date().toISOString() + '] spawn ok\n', { flag: 'a' }) } catch {}
    } catch {
      try {
        spawn(d.py, ['api_v2.py', '-a', '127.0.0.1', '-p', '9880', '-c', 'GPT_SoVITS/configs/tts_infer.yaml'], {
          cwd: d.gpt, detached: true, stdio: 'ignore', windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', NO_PROXY: '127.0.0.1,localhost' },
        }).unref()
      } catch {}
    }
  }

  // ---------- 音色库 ----------
  const meta = () => readJson(voicesFile, { active: '', items: [] })
  const saveMeta = (m) => writeJson(voicesFile, m)

  const voices = () => {
    const d = dirs()
    const s = settings()
    const saved = meta()
    const list = (p) => (existsSync(p) ? readdirSync(p).filter((f) => /\.(ckpt|pth)$/i.test(f)) : [])
    const found = []
    for (const f of list(d.gptW)) found.push({ name: f.replace(/\.[^.]+$/, ''), gpt: join(d.gptW, f) })
    for (const f of list(d.sovitsW)) {
      const name = f.replace(/\.[^.]+$/, '')
      const hit = found.find((v) => v.name === name)
      if (hit) hit.sovits = join(d.sovitsW, f)
      else found.push({ name, sovits: join(d.sovitsW, f) })
    }
    const savedItems = saved.items || []
    const merged = found.map((v) => {
      const m = savedItems.find((x) => x.id === v.name) || {}
      return {
        id: v.name,
        name: m.displayName || v.name,
        note: m.note || '',
        gpt: v.gpt || '',
        sovits: v.sovits || '',
        refAudio: m.refAudio || s.refAudio,
        refText: m.refText || s.refText,
        status: v.gpt && v.sovits ? 'ready' : 'incomplete',
      }
    })
    merged.unshift({ id: 'zero-shot', name: '零样本（参考音）', note: savedItems.find((x) => x.id === 'zero-shot')?.note || '', gpt: '', sovits: '', refAudio: s.refAudio, status: 'ready' })
    return { items: merged, active: saved.active || 'zero-shot' }
  }

  function setVoice(id, patch) {
    const m = meta()
    const items = m.items || []
    const hit = items.find((x) => x.id === id)
    if (hit) Object.assign(hit, patch)
    else items.push({ id, ...patch })
    saveMeta({ active: m.active || 'zero-shot', items })
  }

  function voiceNote(id, note) {
    setVoice(id, { note })
    return { ok: true }
  }

  function voiceRename(id, newName) {
    if (!/^[\w\u4e00-\u9fa5-]{1,24}$/.test(newName || '')) throw new Error('名字不合法（中英文/数字/下划线，最多 24 字）')
    const d = dirs()
    const v = voices().items.find((x) => x.id === id)
    if (!v || id === 'zero-shot') throw new Error('零样本不能改名')
    for (const [file, dirPath] of [[v.gpt, d.gptW], [v.sovits, d.sovitsW]]) {
      if (!file) continue
      const base = file.split('\\').pop()
      const next = base.replace(id, newName)
      if (next !== base) renameSync(file, join(dirPath, next))
    }
    const m = meta()
    const items = (m.items || []).filter((x) => x.id !== id)
    items.push({ id: newName, displayName: newName, note: v.note || '' })
    saveMeta({ active: m.active === id ? newName : m.active, items })
    return { ok: true, id: newName }
  }

  function voiceDelete(id, removeFiles) {
    if (id === 'zero-shot') throw new Error('零样本不能删除')
    const d = dirs()
    const v = voices().items.find((x) => x.id === id)
    if (removeFiles && v) {
      for (const f of [v.gpt, v.sovits]) {
        try {
          if (f && existsSync(f)) unlinkSync(f)
        } catch {}
      }
    }
    const m = meta()
    saveMeta({ active: m.active === id ? 'zero-shot' : m.active, items: (m.items || []).filter((x) => x.id !== id) })
    return { ok: true }
  }

  // ---------- 训练队列与历史 ----------
  const jobs = new Map()
  let runningId = ''
  const jobsFileData = readJson(jobsFile, { items: [] })
  for (const j of jobsFileData.items || []) {
    if (j.status === 'running' || j.status === 'queued') j.status = 'interrupted'
    jobs.set(j.id, j)
  }
  const persist = () => writeJson(jobsFile, { items: [...jobs.values()].map(({ child, ...rest }) => rest) })

  function enqueue(params) {
    const s = settings()
    const d = dirs()
    const { name, audio, logDir } = params
    if (!name || !/^[\w\u4e00-\u9fa5-]{1,24}$/.test(name)) throw new Error('名字只能包含中英文、数字、下划线，最长 24 字')
    if (!audio || !existsSync(audio)) throw new Error('音频文件不存在：' + audio)
    if (audio.toLowerCase().endsWith('.m4s')) throw new Error('m4s 是 B 站缓存格式，请先用 ffmpeg 转成 wav')
    const id = randomUUID().slice(0, 8)
    const log = join(logDir || join(d.logs, name), 'train.log')
    mkdirSync(dirname(log), { recursive: true })
    const job = {
      id,
      name,
      params: { name, audio, logDir, version: params.version || 'v2ProPlus' },
      status: 'queued',
      phase: '排队中',
      steps: [],
      log,
      startedAt: Date.now(),
      autoPause: s.autoPauseTts,
    }
    jobs.set(id, job)
    persist()
    startNext()
    return job
  }

  function startNext() {
    if (runningId) return
    const next = [...jobs.values()].find((j) => j.status === 'queued')
    if (!next) return
    runningId = next.id
    void runJob(next)
  }

  async function runJob(job) {
    const s = settings()
    const d = dirs()
    job.status = 'running'
    job.phase = '准备中'
    persist()
    try {
      if (job.autoPause) {
        job.phase = '暂停语音服务腾显存'
        await stopTts()
      }
      const args = [
        join(PLUGIN_ROOT, 'tools', 'train_pipeline.py'),
        '--name', job.params.name,
        '--audio', job.params.audio,
        '--root', d.gpt,
        '--py', d.py,
        '--asrpy', d.asrPy,
        '--workdir', join(dir, 'dataset', job.params.name),
        '--ref-text', s.refText,
        '--name-template', s.nameTemplate,
        '--version', job.params.version || 'v2ProPlus',
      ]
      const child = spawn(d.py, args, { cwd: d.gpt, windowsHide: true })
      job.child = child
      const onData = (buf) => {
        const text = String(buf)
        for (const line of text.split(/\r?\n/)) {
          if (line.includes('::step::')) {
            const step = line.replace(/.*::step::/, '').trim()
            job.steps.push(step)
            job.phase = step
          }
        }
        try {
          writeFileSync(job.log, text, { flag: 'a' })
        } catch {}
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      await new Promise((resolve) => {
        child.on('close', (code) => {
          job.status = code === 0 ? 'done' : 'failed'
          job.exitCode = code
          job.endedAt = Date.now()
          try {
            writeFileSync(job.log, `\n[exit ${code}]\n`, { flag: 'a' })
          } catch {}
          resolve()
        })
      })
    } catch (e) {
      job.status = 'failed'
      job.phase = String(e.message || e)
      job.endedAt = Date.now()
    } finally {
      if (job.autoPause) startTts()
      runningId = ''
      persist()
      startNext()
    }
  }

  function jobState(id) {
    const job = jobs.get(id)
    if (!job) return null
    let tail = ''
    try {
      tail = readFileSync(job.log, 'utf8').slice(-6000)
    } catch {}
    return {
      id: job.id,
      name: job.name,
      status: job.status,
      phase: job.phase,
      steps: job.steps || [],
      output: job.output || '',
      tail,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      elapsed: Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000),
    }
  }

  function jobsList() {
    return [...jobs.values()]
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
      .slice(0, 20)
      .map((j) => ({ id: j.id, name: j.name, status: j.status, phase: j.phase, startedAt: j.startedAt, endedAt: j.endedAt }))
  }

  function retryJob(id) {
    const old = jobs.get(id)
    if (!old) throw new Error('任务不存在')
    return enqueue(old.params)
  }

  // ---------- 翻唱（RVC 变声 / 完整翻唱） ----------
  function rvcPaths() {
    const s = settings()
    const root = s.rvcRoot || ''
    return {
      root,
      python: join(root, 'env', 'Scripts', 'python.exe'),
      separator: join(root, 'env', 'Scripts', 'audio-separator.exe'),
      applio: join(root, 'Applio'),
      models: join(root, 'models'),
      separatorModels: join(root, 'separator-models'),
      ffmpeg: join(root, 'bin', 'ffmpeg.exe'),
      work: join(dir, 'rvc-work'),
      out: s.outDir && s.outDir.trim() ? s.outDir.trim() : join(dir, 'samples'),
    }
  }

  function rvcVoices() {
    const p = rvcPaths()
    if (!existsSync(p.models)) return { ok: true, items: [], ready: existsSync(p.python) }
    let names = []
    try {
      names = readdirSync(p.models)
    } catch {
      names = []
    }
    const items = names
      .filter((n) => /\.pth$/i.test(n))
      .map((n) => {
        const id = n.replace(/\.pth$/i, '')
        const idx = names.find((m) => /\.index$/i.test(m) && m.toLowerCase().includes(id.toLowerCase()))
        return { id, pth: join(p.models, n), index: idx ? join(p.models, idx) : '' }
      })
    return {
      ok: true,
      items,
      ready: existsSync(p.python) && existsSync(join(p.applio, 'core.py')),
      separatorReady: existsSync(p.separator),
      ffmpegReady: existsSync(p.ffmpeg),
      seedModels: existsSync(p.separatorModels) ? readdirSync(p.separatorModels).filter((n) => /\.(ckpt|onnx|yaml)$/i.test(n)).length : 0,
    }
  }

  function rvcImport({ path: src }) {
    const p = rvcPaths()
    if (!src || !existsSync(src)) throw new Error('文件不存在：' + src)
    mkdirSync(p.models, { recursive: true })
    const name = basename(src).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
    const lower = name.toLowerCase()
    if (lower.endsWith('.pth') || lower.endsWith('.index')) {
      copyFileSync(src, join(p.models, name))
      return { ok: true, added: [name] }
    }
    if (lower.endsWith('.zip')) {
      const tmp = join(p.work, 'unzip-' + Date.now())
      mkdirSync(tmp, { recursive: true })
      const sevenZip = 'D:\\7-Zip\\7z.exe'
      let ok = false
      try {
        if (existsSync(sevenZip)) {
          execFileSync(sevenZip, ['x', src, '-o' + tmp, '-y'], { windowsHide: true })
          ok = true
        }
      } catch {}
      if (!ok) {
        try {
          execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${src}' -DestinationPath '${tmp}' -Force`], { windowsHide: true })
          ok = true
        } catch {}
      }
      if (!ok) throw new Error('解压失败（没有 7z，也没解压成）')
      const added = []
      const walk = (d) => {
        for (const n of readdirSync(d)) {
          const full = join(d, n)
          if (statSync(full).isDirectory()) {
            walk(full)
            continue
          }
          if (/\.(pth|index)$/i.test(n)) {
            copyFileSync(full, join(p.models, n))
            added.push(n)
          }
        }
      }
      walk(tmp)
      rmSync(tmp, { recursive: true, force: true })
      if (!added.length) throw new Error('压缩包里没有 .pth/.index')
      return { ok: true, added }
    }
    throw new Error('只支持 .pth / .index / .zip')
  }

  function newJob(kind, name, steps) {
    const id = randomUUID().slice(0, 8)
    const log = join(dir, 'logs', kind, id + '.log')
    mkdirSync(dirname(log), { recursive: true })
    const job = { id, kind, name, status: 'running', startedAt: Date.now(), log, steps, phase: steps[0] || '', tail: '' }
    jobs.set(id, job)
    persist()
    return job
  }

  function rvcStep(job, phase) {
    job.phase = phase
    job.steps = job.steps || []
    if (!job.steps.includes(phase)) job.steps.push(phase)
    job.phase = phase
    persist()
  }

  function rvcRun(job, cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      const binDir = join(rvcPaths().root, 'bin')
      const basePath = existsSync(binDir) ? binDir + ';' + (process.env.PATH || '') : (process.env.PATH || '')
      const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, env: { ...process.env, PATH: basePath, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } })
      job.child = child
      job.pid = child.pid
      try {
        writeFileSync(job.log, '\n$ ' + cmd + ' ' + args.join(' ') + '\n', { flag: 'a' })
      } catch {}
      const onData = (b) => {
        const text = String(b)
        try {
          writeFileSync(job.log, text, { flag: 'a' })
        } catch {}
        job.tail = ((job.tail || '') + text).slice(-4000)
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('error', (e) => reject(e))
      child.on('close', (code) => {
        job.child = null
        if (job.canceled) return reject(new Error('已取消'))
        code === 0 ? resolve() : reject(new Error(`${basename(cmd)} 退出码 ${code}`))
      })
    })
  }

  const BASE_SEPARATOR = 'model_bs_roformer_ep_317_sdr_12.9755'

  function pickSeparator(p) {
    try {
      const names = readdirSync(p.separatorModels)
      const hit = names.find((n) => n.toLowerCase().includes('roformer') && /\.(ckpt|onnx)$/i.test(n))
      if (hit) return hit
    } catch {}
    return BASE_SEPARATOR + '.ckpt'
  }

  function rvcJob({ audio, voice, pitch, mode, vocalVolume, instVolume, clipSeconds }) {
    const p = rvcPaths()
    if (!existsSync(p.python)) throw new Error('RVC 环境不存在：' + p.python)
    if (!existsSync(join(p.applio, 'core.py'))) throw new Error('Applio 不存在：' + p.applio)
    if (!audio || !existsSync(audio)) throw new Error('音频文件不存在：' + audio)
    const v = rvcVoices().items.find((x) => x.id === voice) || rvcVoices().items[0]
    if (!v) throw new Error('没有 RVC 音色，先把 .pth 放进 ' + p.models)
    const full = mode === 'cover'
    mkdirSync(p.work, { recursive: true })
    mkdirSync(p.out, { recursive: true })
    const job = newJob('rvc', (full ? 'complete:' : 'convert:') + v.id, full ? ['人声分离', '变声', '混音'] : ['变声'])
    persist()
    void (async () => {
      const s0 = settings()
      const paused = Boolean(s0.autoPauseTts)
      try {
        if (paused) await stopTts()
        const work = join(p.work, job.id)
        mkdirSync(work, { recursive: true })
        let vocals = audio
        let inst = ''
        const clipSec = Math.max(0, Number(clipSeconds) || 0)
        if (clipSec > 0) {
          rvcStep(job, '截取片段')
          const cut = join(work, 'clip.wav')
          await rvcRun(job, p.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', audio, '-t', String(clipSec), '-ac', '2', '-ar', '44100', cut], {})
          vocals = cut
          audio = cut
        }
        if (full) {
          if (!existsSync(p.separator)) throw new Error('没有人声分离程序：' + p.separator)
          if (!existsSync(p.ffmpeg)) throw new Error('没有 ffmpeg：' + p.ffmpeg)
          rvcStep(job, '人声分离')
          const model = pickSeparator(p)
          await rvcRun(job, p.separator, [audio, '--model_filename', model, '--model_file_dir', p.separatorModels, '--output_dir', work, '--output_format', 'WAV'], {})
          const files = readdirSync(work)
          const vf = files.find((f) => /\(vocals\)/i.test(f))
          const inf = files.find((f) => /\(instrumental\)/i.test(f) || /\(other\)/i.test(f))
          if (!vf) throw new Error('分离没产出人声')
          vocals = join(work, vf)
          inst = inf ? join(work, inf) : ''
        }
        rvcStep(job, '变声')
        const rvcOut = join(work, 'vocals_rvc.wav')
        await rvcRun(job, p.python, [
          'core.py', 'infer',
          '--input-path', vocals,
          '--output-path', rvcOut,
          '--pth-path', v.pth,
          '--index-path', v.index || '',
          '--pitch', String(Number(pitch) || 0),
          '--index-rate', v.index ? '0.5' : '0',
          '--protect', '0.33',
          '--f0-method', 'rmvpe',
          '--export-format', 'WAV',
        ], { cwd: p.applio })
        if (!existsSync(rvcOut)) throw new Error('变声没产出文件')
        let out = rvcOut
        if (full && inst) {
          rvcStep(job, '混音')
          out = join(p.out, 'cover-' + job.id + '.mp3')
          await rvcRun(job, p.ffmpeg, [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', rvcOut, '-i', inst,
            '-filter_complex', '[0:a]volume=' + (Number(vocalVolume) || 1) + '[v];[1:a]volume=' + (Number(instVolume) || 0.8) + '[i];[v][i]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95',
            '-ac', '2', '-ar', '44100', '-b:a', '192k', out,
          ], {})
        } else {
          out = join(p.out, 'rvc-' + job.id + '.wav')
          copyFileSync(rvcOut, out)
        }
        job.output = out
        job.status = 'done'
        job.phase = '完成'
      } catch (e) {
        job.status = job.canceled ? 'canceled' : 'failed'
        job.phase = job.canceled ? '已取消' : '失败：' + String(e.message || e)
        if (job.status === 'failed') {
          try {
            writeFileSync(job.log, '\n[error] ' + String(e.stack || e) + '\n', { flag: 'a' })
          } catch {}
        }
      } finally {
        job.endedAt = Date.now()
        if (paused) startTts()
        persist()
      }
    })()
    return job
  }

  function rvcStop(id) {
    const job = jobs.get(id)
    if (!job) throw new Error('任务不存在')
    job.canceled = true
    try {
      if (job.pid) execFileSync('taskkill.exe', ['/PID', String(job.pid), '/T', '/F'], { windowsHide: true })
    } catch {}
    job.status = 'canceled'
    job.phase = '已取消'
    persist()
    return { ok: true }
  }

  // ---------- 打开目录 / 翻唱自检 / 一键导入 ----------
  function openPathAction({ path: target }) {
    const p = String(target || '').trim()
    if (!p) throw new Error('没有路径')
    if (!existsSync(p)) throw new Error('路径不存在：' + p)
    spawn('explorer.exe', [p], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return { ok: true, path: p }
  }

  function rvcCheck() {
    const p = rvcPaths()
    const v = rvcVoices()
    const parts = [
      { key: 'python', label: 'Python 环境', ok: existsSync(p.python), detail: p.python },
      { key: 'applio', label: 'Applio 引擎', ok: existsSync(join(p.applio, 'core.py')), detail: p.applio },
      { key: 'separator', label: '人声分离程序', ok: existsSync(p.separator), detail: p.separator },
      { key: 'ffmpeg', label: 'ffmpeg', ok: existsSync(p.ffmpeg), detail: p.ffmpeg },
      { key: 'rmvpe', label: '音高预测模型', ok: existsSync(join(p.applio, 'rvc', 'models', 'predictors', 'rmvpe.pt')), detail: 'rmvpe.pt' },
    ]
    return {
      ok: true,
      root: p.root,
      parts,
      models: v.items,
      separatorModels: v.seedModels || 0,
      ready: parts.every((x) => x.ok) && v.items.length > 0,
    }
  }

  function unzipTo(src, dest) {
    mkdirSync(dest, { recursive: true })
    const sevenZip = 'D:\\7-Zip\\7z.exe'
    if (existsSync(sevenZip)) {
      execFileSync(sevenZip, ['x', src, '-o' + dest, '-y'], { windowsHide: true })
      return
    }
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${src}' -DestinationPath '${dest}' -Force`], { windowsHide: true })
  }

  function walkFiles(dirPath, out = []) {
    for (const n of readdirSync(dirPath)) {
      const full = join(dirPath, n)
      if (statSync(full).isDirectory()) walkFiles(full, out)
      else out.push(full)
    }
    return out
  }

  function importAuto({ path: src }) {
    if (!src || !existsSync(src)) throw new Error('文件不存在：' + src)
    const lower = basename(src).toLowerCase()
    const d = dirs()
    const p = rvcPaths()
    // 配置
    if (lower.endsWith('.json')) {
      const cfg = readJson(src, null)
      if (!cfg || typeof cfg !== 'object') throw new Error('不是合法的 JSON')
      try {
        copyFileSync(settingsFile, settingsFile + '.bak-import-' + Date.now())
      } catch {}
      if (cfg.settings) saveSettings(cfg.settings)
      if (cfg.voices) writeJson(voicesFile, cfg.voices)
      return { ok: true, kind: 'config', placed: [basename(src)], note: '已恢复设置与音色列表' }
    }
    // RVC 单文件
    if (lower.endsWith('.pth') || lower.endsWith('.index')) {
      const r = rvcImport({ path: src })
      return { ok: true, kind: 'rvc', placed: r.added, note: '已导入 RVC 音色' }
    }
    // 参考音
    if (/\.(wav|mp3|m4a|flac)$/i.test(lower)) {
      const refDir = join(d.root, 'ref')
      mkdirSync(refDir, { recursive: true })
      const name = basename(src)
      let target = join(refDir, name)
      if (existsSync(target)) target = join(refDir, Date.now() + '-' + name)
      copyFileSync(src, target)
      return { ok: true, kind: 'ref', placed: [target], note: '已放进参考音库，可在「说话 → 参考音库」里设为当前' }
    }
    // 压缩包：解压后按内容分流
    if (lower.endsWith('.zip')) {
      const tmp = join(dir, 'unzip-' + Date.now())
      unzipTo(src, tmp)
      const files = walkFiles(tmp)
      const pths = files.filter((f) => /\.pth$/i.test(f))
      const idxs = files.filter((f) => /\.index$/i.test(f))
      const ckpts = files.filter((f) => /\.ckpt$/i.test(f))
      const placed = []
      if (ckpts.length && pths.length) {
        mkdirSync(d.gptW, { recursive: true })
        mkdirSync(d.sovitsW, { recursive: true })
        for (const f of ckpts) {
          copyFileSync(f, join(d.gptW, basename(f)))
          placed.push('GPT_weights/' + basename(f))
        }
        for (const f of pths) {
          copyFileSync(f, join(d.sovitsW, basename(f)))
          placed.push('SoVITS_weights/' + basename(f))
        }
        rmSync(tmp, { recursive: true, force: true })
        return { ok: true, kind: 'weights', placed, note: '已导入 GPT-SoVITS 权重对，刷新音色列表可见' }
      }
      if (pths.length || idxs.length) {
        mkdirSync(p.models, { recursive: true })
        for (const f of [...pths, ...idxs]) {
          copyFileSync(f, join(p.models, basename(f)))
          placed.push(basename(f))
        }
        rmSync(tmp, { recursive: true, force: true })
        return { ok: true, kind: 'rvc', placed, note: '已导入 RVC 音色包' }
      }
      rmSync(tmp, { recursive: true, force: true })
      throw new Error('压缩包里没有认识的模型文件')
    }
    throw new Error('不认识的文件类型：' + basename(src))
  }

  function pickDir() {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.TopMost = $true',
      '$owner.ShowInTaskbar = $false',
      '$owner.Left = -3000',
      '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$f.Description = '选择保存位置'",
      "if ($f.ShowDialog($owner) -eq 'OK') { $f.SelectedPath }",
      '$owner.Dispose()',
    ].join('; ')
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-STA', '-NoProfile', '-Command', ps], { timeout: 120000, windowsHide: false }, (err, stdout) => {
        const picked = String(stdout || '').trim()
        resolve({ ok: !!picked, path: picked, message: err ? String(err.message) : '' })
      })
    })
  }

  // ---------- 合成 / 上传 ----------
  async function speak(text, voice, opts = {}) {
    const s = settings()
    const v = voices().items.find((x) => x.id === (voice || voices().active))
    const ref = v?.refAudio || s.refAudio
    const q = new URLSearchParams({
      text,
      text_lang: 'zh',
      ref_audio_path: ref,
      prompt_text: v?.refText || s.refText,
      prompt_lang: 'zh',
      media_type: 'wav',
    })
    if (opts.speed) q.set('speed_factor', String(opts.speed))
    if (opts.temperature) q.set('temperature', String(opts.temperature))
    if (opts.topK) q.set('top_k', String(opts.topK))
    if (opts.topP) q.set('top_p', String(opts.topP))
    const r = await fetch(`${s.ttsUrl}/tts?${q}`, { signal: AbortSignal.timeout(180000) })
    if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 200)}`)
    return Buffer.from(await r.arrayBuffer())
  }

  // 参考音库：列出 ref 目录与上传目录里的音频
  function refList() {
    const d = dirs()
    const out = []
    for (const [tag, dirPath] of [['内置', join(d.root, 'ref')], ['上传', uploadDir]]) {
      if (!existsSync(dirPath)) continue
      for (const f of readdirSync(dirPath)) {
        if (!/\.(wav|mp3|m4a)$/i.test(f)) continue
        const p = join(dirPath, f)
        try {
          out.push({ name: f, path: p, tag, size: statSync(p).size })
        } catch {}
      }
    }
    return out
  }

  async function transcribeRef(file) {
    const d = dirs()
    const out = join(dir, 'tmp-transcribe.json')
    const modelDir = join(d.root, 'models', 'faster-whisper-medium')
    const script = join(d.root, 'tools', 'transcribe.py')
    if (!existsSync(script)) throw new Error('缺少转写脚本：' + script)
    await new Promise((resolve, reject) => {
      const child = spawn(d.asrPy, [script, file, out, modelDir], { windowsHide: true })
      let err = ''
      child.stderr.on('data', (b) => (err += b))
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-300) || '转写失败'))))
    })
    const j = readJson(out, { segments: [] })
    return (j.segments || []).map((s) => s.text).join('').trim()
  }

  function saveUpload(name, buffer) {
    const safe = String(name || 'audio.wav').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
    const file = join(uploadDir, `${Date.now()}-${safe}`)
    writeFileSync(file, buffer)
    return file
  }

  // ---------- 诊断 ----------
  function tailFile(file, bytes = 6000) {
    try {
      const buf = readFileSync(file)
      return buf.slice(Math.max(0, buf.length - bytes)).toString('utf8')
    } catch {
      return ''
    }
  }

  async function diagnostics() {
    const s = settings()
    const d = dirs()
    const env = await envCheck()
    const latest = [...jobs.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0]
    let engine = false
    try {
      engine = (await fetch(`${s.ttsUrl}/control?command=config`, { signal: AbortSignal.timeout(2500) })).ok
    } catch {}
    const bundle = {
      version: 1,
      generatedAt: new Date().toISOString(),
      plugin: 'dsh-voice-studio',
      system: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cpus: cpus().length,
        ramGB: Math.round(totalmem() / 1024 ** 3),
      },
      engineOnline: engine,
      settings: s,
      dirs: d,
      env: env.items,
      voices: voices().items.map((v) => ({ id: v.id, name: v.name, status: v.status, gpt: v.gpt, sovits: v.sovits, note: v.note })),
      jobs: jobsList(),
      logs: {
        tts: tailFile(join(d.root, 'logs', 'tts.log'), 4000),
        ttsErr: tailFile(join(d.root, 'logs', 'tts.err.log'), 2000),
        lastJob: latest ? tailFile(latest.log, 8000) : '',
      },
    }
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const name = `voice-studio-diag-${stamp}.json`
    const file = join(dir, name)
    const text = JSON.stringify(bundle, null, 2)
    writeFileSync(file, text, 'utf8')
    return { ok: true, name, path: file, content: text }
  }
  // ---------- Aurabot 机械音兜底守卫 ----------
  // Aurabot 升级会覆盖 node_modules，这里在每次启动/同步时检查并重新打补丁。
  function ensureAurabotNoFallback() {
    const f = join(home, 'profiles', 'desktop', 'node_modules', 'dsh-aurabot-qq', 'src', 'voice', 'tts.js')
    try {
      if (!existsSync(f)) return { ok: false, reason: '找不到 Aurabot 的 tts.js' }
      let src = readFileSync(f, 'utf8')
      if (src.includes('机械音兜底')) return { ok: true, patched: false }
      const oldCatch = '    } catch (error) {\n      log?.warn(`${opt.engine} 失败：${error.message} → 改用 Windows 语音`)\n    }'
      const newCatch = '    } catch (error) {\n      log?.warn(`${opt.engine} 失败：${error.message}（已禁用机械音兜底，改发文字）`)\n      throw error\n    }'
      const oldFb = '  if (!file) {\n    file = await windowsSynth(clean)\n    engine = \'windows\'\n  }'
      const newFb = '  if (!file) throw new Error(\'没有可用的语音引擎（机械音兜底已关闭）\')'
      if (!src.includes(oldCatch) || !src.includes(oldFb)) return { ok: false, reason: 'Aurabot 代码结构变了，需要手动适配' }
      writeFileSync(f + '.bak-guard-' + Date.now(), src, 'utf8')
      src = src.replace(oldCatch, newCatch).replace(oldFb, newFb)
      writeFileSync(f, src, 'utf8')
      return { ok: true, patched: true }
    } catch (e) {
      return { ok: false, reason: String(e.message || e) }
    }
  }

  // ---------- 同步到 Aurabot ----------
  function aurabotConfigPath() {
    return join(home, 'plugins-data', 'aurabot', 'config.json')
  }

  async function syncAurabot() {
    ensureAurabotNoFallback()
    const file = aurabotConfigPath()
    if (!existsSync(file)) throw new Error('找不到 Aurabot 配置：' + file)
    const s = settings()
    const v = voices()
    const cur = v.items.find((x) => x.id === v.active) || {}
    const refAudio = cur.refAudio || s.refAudio
    const refText = cur.refText || s.refText
    const cfg = readJson(file, null)
    if (!cfg || typeof cfg !== 'object') throw new Error('Aurabot 配置不是合法 JSON')
    try {
      writeFileSync(file + '.bak-sync-' + Date.now(), JSON.stringify(cfg, null, 2), 'utf8')
    } catch {}
    cfg.voice = cfg.voice || {}
    cfg.voice.enabled = true
    cfg.voice.engine = 'gptsovits'
    cfg.voice.gptsovits = cfg.voice.gptsovits || {}
    cfg.voice.gptsovits.url = s.ttsUrl
    cfg.voice.gptsovits.refAudio = refAudio
    cfg.voice.gptsovits.promptText = refText
    cfg.voice.gptsovits.promptLang = 'zh'
    cfg.voice.gptsovits.textLang = 'zh'
    writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8')
    let engineStarted = false
    try {
      const r = await fetch(s.ttsUrl + '/control?command=config', { signal: AbortSignal.timeout(2500) })
      if (!r.ok) throw new Error('offline')
    } catch {
      startTts()
      engineStarted = true
    }
    return { ok: true, file, voice: cur.name || v.active, refAudio, refText, url: s.ttsUrl, engineStarted }
  }

  // ---------- 清理 ----------
  function cleanCaches() {
    let removed = 0
    const rm = (p) => {
      try {
        rmSync(p, { recursive: true, force: true })
        removed++
      } catch {}
    }
    try {
      for (const f of readdirSync(dir)) if (f.startsWith('voice-studio-diag-')) rm(join(dir, f))
    } catch {}
    rm(join(dir, 'tmp-transcribe.json'))
    // 训练日志：同名目录只留最新，超过 20 个目录删最旧的
    const logRoot = join(dir, 'logs')
    try {
      const dirsList = readdirSync(logRoot).filter((n) => statSync(join(logRoot, n)).isDirectory())
      dirsList.sort().slice(0, Math.max(0, dirsList.length - 20)).forEach((n) => rm(join(logRoot, n)))
    } catch {}
    // 上传目录里 30 天前的素材
    try {
      const now = Date.now()
      for (const f of readdirSync(uploadDir)) {
        const p = join(uploadDir, f)
        if (now - statSync(p).mtimeMs > 30 * 86400_000) rm(p)
      }
    } catch {}
    return { ok: true, removed }
  }
  // ---------- 配置导入导出 ----------
  function exportConfig() {
    return { ok: true, config: { version: 1, settings: settings(), voices: meta() } }
  }
  function importConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') throw new Error('配置格式不对')
    if (cfg.settings) saveSettings(cfg.settings)
    if (cfg.voices) saveMeta(cfg.voices)
    return { ok: true }
  }

  async function api(action, body, params) {
    const s = settings()
    switch (action) {
      case 'version':
        return { ok: true, build: BUILD }
      case 'state': {
        const v = voices()
        return { ok: true, settings: s, voices: v.items, active: v.active, jobs: jobsList() }
      }
      case 'settings':
        return { ok: true, settings: saveSettings(body || {}) }
      case 'env':
        return envCheck()
      case 'plan':
        return plan()
      case 'train':
        return { ok: true, job: { id: enqueue(body || {}).id } }
      case 'job':
        return { ok: true, job: jobState(params?.get('id') || body?.id) }
      case 'jobs':
        return { ok: true, items: jobsList() }
      case 'retry':
        return { ok: true, job: { id: retryJob(body?.id).id } }
      case 'voice-note':
        return voiceNote(body.id, body.note || '')
      case 'voice-rename':
        return voiceRename(body.id, body.name)
      case 'voice-delete':
        return voiceDelete(body.id, !!body.removeFiles)
      case 'pick-dir':
        return pickDir()
      case 'open':
        return openPathAction(body || {})
      case 'rvc-check':
        return rvcCheck()
      case 'import-auto':
        return importAuto(body || {})
      case 'rvc-voices':
        return rvcVoices()
      case 'rvc-start':
        return { ok: true, job: { id: rvcJob(body || {}).id } }
      case 'rvc-cover':
        return { ok: true, job: { id: rvcJob({ ...(body || {}), mode: 'cover' }).id } }
      case 'rvc-import':
        return rvcImport(body || {})
      case 'rvc-stop':
        return rvcStop(body?.id)
      case 'audio': {
        const file = String(body?.path || params?.get('path') || '')
        if (!file || !existsSync(file)) throw new Error('文件不存在')
        const buf = readFileSync(file)
        return { ok: true, mime: file.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav', base64: buf.toString('base64') }
      }
      case 'say': {
        const buf = await speak(body?.text || '你好呀，我是大肥鱼', body?.voice, body || {})
        return { ok: true, mime: 'audio/wav', base64: buf.toString('base64') }
      }
      case 'ab': {
        const text = body?.text || '你好呀，我是大肥鱼'
        const s0 = settings()
        const cur = await speak(text, body?.voice, body || {})
        const zero = await speak(text, 'zero-shot', body || {})
        return {
          ok: true,
          current: { voice: body?.voice || voices().active, mime: 'audio/wav', base64: cur.toString('base64') },
          zero: { voice: 'zero-shot', ref: s0.refAudio, mime: 'audio/wav', base64: zero.toString('base64') },
        }
      }
      case 'batch': {
        const texts = (body?.texts || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 30)
        const out = []
        for (const t of texts) {
          try {
            const buf = await speak(t, body?.voice, body || {})
            out.push({ text: t, ok: true, base64: buf.toString('base64') })
          } catch (e) {
            out.push({ text: t, ok: false, message: String(e.message || e) })
          }
        }
        return { ok: true, items: out }
      }
      case 'refs':
        return { ok: true, items: refList(), current: settings().refAudio, currentText: settings().refText }
      case 'ref-transcribe':
        return { ok: true, text: await transcribeRef(body?.path) }
      case 'voice-ref': {
        setVoice(body.id, { refAudio: body.refAudio || '', refText: body.refText || '' })
        return { ok: true }
      }
      case 'tts-start':
        startTts()
        return { ok: true }
      case 'tts-stop':
        await stopTts()
        return { ok: true }
      case 'tts-ensure':
        await ensureEngine()
        return { ok: true }
      case 'active': {
        const m = meta()
        saveMeta({ active: body.id, items: m.items || [] })
        try {
          const item = voices().items.find((x) => x.id === body.id)
          if (item?.gpt) await fetch(`${s.ttsUrl}/set_gpt_weights?` + new URLSearchParams({ weights_path: item.gpt }))
          if (item?.sovits) await fetch(`${s.ttsUrl}/set_sovits_weights?` + new URLSearchParams({ weights_path: item.sovits }))
        } catch (e) {
          return { ok: true, warning: '已设为当前，但切换权重失败：' + e.message }
        }
        return { ok: true }
      }
      case 'setup-done':
        return { ok: true, settings: saveSettings({ setupDone: true }) }
      case 'setup-reset':
        return { ok: true, settings: saveSettings({ setupDone: false }) }
      case 'sync-aurabot':
        return syncAurabot()
      case 'guard-aurabot':
        return ensureAurabotNoFallback()
      case 'clean':
        return cleanCaches()
      case 'diag':
        return diagnostics()
      case 'export-config':
        return exportConfig()
      case 'import-config':
        return importConfig(body?.config)
      default:
        return { ok: false, message: '未知操作：' + action }
    }
  }

  const pageFile = join(PLUGIN_ROOT, 'lib', 'page.html')
  const page = () => readFileSync(pageFile, 'utf8')

  return { api, page, voices, settings, saveSettings, jobs, jobState, jobsList, enqueue, speak, saveUpload, envCheck, plan, ensureEngine, exportConfig, importConfig, diagnostics }
}

export function serveStandalone(app, port = 9909) {
  return import('node:http').then(({ createServer }) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const json = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      }
      if (url.pathname === '/voice-studio/app') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0' })
        return res.end(app.page())
      }
      if (url.pathname === '/voice-studio/say') {
        try {
          const buf = await app.speak(url.searchParams.get('text') || '你好', url.searchParams.get('voice') || undefined)
          res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': buf.length })
          return res.end(buf)
        } catch (e) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          return res.end(String(e.message))
        }
      }
      if (url.pathname === '/voice-studio/upload' && req.method === 'POST') {
        const chunks = []
        for await (const c of req) chunks.push(c)
        try {
          return json(200, { ok: true, path: app.saveUpload(url.searchParams.get('name'), Buffer.concat(chunks)) })
        } catch (e) {
          return json(500, { ok: false, message: e.message })
        }
      }
      if (url.pathname === '/voice-studio/api') {
        let body = {}
        if (req.method === 'POST') {
          let raw = ''
          for await (const chunk of req) raw += chunk
          try {
            body = JSON.parse(raw || '{}')
          } catch {}
        }
        try {
          return json(200, await app.api(url.searchParams.get('action'), body, url.searchParams))
        } catch (e) {
          return json(500, { ok: false, message: e.message })
        }
      }
      res.writeHead(404)
      res.end('not found')
    })
    server.listen(port, '127.0.0.1')
    return server
  })
}
