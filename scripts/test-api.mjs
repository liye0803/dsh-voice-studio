// 接口级冒烟测试：起一个独立实例（临时 DSH_HOME），按初装状态逐项打接口。
// 用法：node scripts/test-api.mjs
// 退出码 0 = 全部通过，1 = 有失败项。
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const port = 9900 + Math.floor(Math.random() * 90)
const home = mkdtempSync(join(tmpdir(), 'vs-test-'))

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const child = spawn(process.execPath, [join(root, 'lib', 'index.js'), '--standalone', String(port)], {
  cwd: root,
  env: { ...process.env, DSH_HOME: home },
  stdio: 'ignore',
  windowsHide: true,
})

const base = `http://127.0.0.1:${port}/voice-studio/api`
const get = async (action) => {
  const r = await fetch(`${base}?action=${action}`)
  return r.json()
}
const post = async (action, body) => {
  const r = await fetch(`${base}?action=${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  return r.json()
}

async function waitReady(ms = 20000) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    try {
      const r = await fetch(`${base}?action=version`)
      if (r.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

try {
  const ready = await waitReady()
  check('服务启动', ready, ready ? `端口 ${port}` : '20 秒内没起来')
  if (!ready) throw new Error('服务没起来，后续检查跳过')

  const version = await get('version')
  check('version 返回 ok', version.ok === true, version.build || '')

  const state = await get('state')
  check('state 可用', state.ok === true)
  check('初装 installRoot 为空', state.settings?.installRoot === '', JSON.stringify(state.settings?.installRoot ?? null))
  check('初装有零样本音色', (state.voices || []).some((v) => v.id === 'zero-shot'))

  const env = await get('env')
  check('env 可用', env.ok === true)
  check('env 至少 8 项', (env.items || []).length >= 8, `${(env.items || []).length} 项`)
  check('初装能指出缺项', (env.items || []).some((i) => !i.ok))

  const plan = await get('plan')
  check('plan 可用', plan.ok === true, plan.mode || '')

  const rvc = await get('rvc-check')
  check('rvc-check 可用', rvc.ok === true)

  const refs = await get('refs')
  check('refs 可用', refs.ok === true)

  const jobs = await get('jobs')
  check('jobs 可用', jobs.ok === true)

  const say = await post('say', { text: '测试' })
  check('未配置参考音时 say 快速失败', say.ok === false && /参考音/.test(say.message || ''), say.message || '')

  const train = await post('train', { name: 't1', audio: 'C:/nope.wav' })
  check('未配置安装目录时 train 拒绝', train.ok === false, train.message || '')

  const cover = await post('rvc-cover', { audio: 'C:/nope.wav' })
  check('未配置 RVC 根目录时翻唱拒绝', cover.ok === false && /RVC/.test(cover.message || ''), cover.message || '')

  const audioBad = await post('audio', { path: process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/passwd' })
  check('audio 拒绝越界路径', audioBad.ok === false, audioBad.message || '')

  const tmpJson = join(home, 'not-a-config.json')
  writeFileSync(tmpJson, JSON.stringify({ hello: 'world' }), 'utf8')
  const imp = await post('import-auto', { path: tmpJson })
  check('import 拒绝非配置 json', imp.ok === false && /配置文件/.test(imp.message || ''), imp.message || '')

  const page = await fetch(`http://127.0.0.1:${port}/voice-studio/app`)
  const html = await page.text()
  check('页面可打开', page.ok && html.includes('音色工坊'))
  check('页面含三个页签', ['说话', '翻唱', '设置'].every((t) => html.includes(`>${t}<`)))
} catch (e) {
  check('测试过程未抛异常', false, String(e.message || e))
} finally {
  try {
    child.kill()
  } catch {}
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {}
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.name).join('、'))
  process.exit(1)
}
