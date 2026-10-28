// Voice Studio —— DSH 宿主半边
// 注册两条路由：/voice-studio/api（数据）与 /voice-studio/app（面板 HTML）。
import { pathToFileURL } from 'node:url'
import { createApp, serveStandalone } from './app.js'

export const name = 'voice-studio'

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

function loopback(req) {
  const a = req.socket?.remoteAddress || ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

export function apply(ctx) {
  const app = createApp()
  setTimeout(() => { try { app.ensureEngine() } catch {} }, 2500)
  // 看门狗：每 60 秒探一次，引擎掉了就自动拉起
  ctx.effect(() => {
    const t = setInterval(() => { try { app.ensureEngine() } catch {} }, 60000)
    return () => clearInterval(t)
  }, 'voice-studio: watchdog')

  const mount = () => {
    const web = ctx.get('webServer')
    if (!web) return

    ctx.effect(
      () =>
        web.register({
          kind: 'exact',
          path: '/voice-studio/api',
          handler: async (req, res) => {
            if (!loopback(req)) {
              res.writeHead(403)
              res.end('forbidden')
              return
            }
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            const body = req.method === 'POST' ? await readBody(req) : {}
            try {
              const out = await app.api(url.searchParams.get('action'), body, url.searchParams)
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify(out))
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, message: error.message }))
            }
          },
        }),
      'voice-studio: api',
    )

    ctx.effect(
      () =>
        web.register({
          kind: 'exact',
          path: '/voice-studio/say',
          handler: async (req, res) => {
            if (!loopback(req)) { res.writeHead(403); res.end('forbidden'); return }
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            try {
              const buf = await app.speak(url.searchParams.get('text') || '你好', url.searchParams.get('voice') || undefined)
              res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': buf.length })
              res.end(buf)
            } catch (error) {
              res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
              res.end(String(error.message))
            }
          },
        }),
      'voice-studio: say',
    )

    ctx.effect(
      () =>
        web.register({
          kind: 'exact',
          path: '/voice-studio/upload',
          handler: async (req, res) => {
            if (!loopback(req)) { res.writeHead(403); res.end('forbidden'); return }
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            const chunks = []
            for await (const c of req) chunks.push(c)
            try {
              const file = app.saveUpload(url.searchParams.get('name'), Buffer.concat(chunks))
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: true, path: file }))
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, message: error.message }))
            }
          },
        }),
      'voice-studio: upload',
    )

    ctx.effect(
      () =>
        web.register({
          kind: 'exact',
          path: '/voice-studio/app',
          handler: (req, res) => {
            if (!loopback(req)) {
              res.writeHead(403)
              res.end('forbidden')
              return
            }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0' })
            res.end(app.page())
          },
        }),
      'voice-studio: page',
    )
  }

  if (ctx.get('webServer') !== undefined) mount()
  else ctx.inject(['webServer'], () => mount())
}

// 独立跑：node lib/index.js --standalone 9909
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--standalone')) {
  const port = Number(process.argv[process.argv.indexOf('--standalone') + 1]) || 9909
  const app = createApp()
  setTimeout(() => { try { app.ensureEngine() } catch {} }, 2500)
  setInterval(() => { try { app.ensureEngine() } catch {} }, 60000)
  const server = await serveStandalone(app, port)
  console.log(`voice-studio standalone: http://127.0.0.1:${port}/voice-studio/app`)
}
