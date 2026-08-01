import { defineConfig } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

// Sdílená logika s Vercel funkcemi — jeden zdroj pravdy pro token, týdny,
// žebříčky i ověřovací kódy. Lokálně se liší jen úložiště (soubor místo KV)
// a doručení kódu (console.log místo SMTP).
import {
  signToken as libSignToken, verifyToken as libVerifyToken, todayPrague,
  isoWeekId, sanitizeName, boardPayload, MIN_TOTAL_MS, MAX_TOTAL_MS,
} from './api/_lib.js'

// Lokální podpisový klíč platí v rámci běhu serveru (restart = nová sada
// tokenů; pro testovací VPS dostačuje).
const SIGN_SECRET = crypto.randomBytes(32).toString('hex')
const signToken = () => libSignToken(SIGN_SECRET)
const verifyToken = (token, ms) => libVerifyToken(SIGN_SECRET, token, ms)

// ── Lokální store (data/scores.json, gitignored) ─────────────────────
const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'scores.json')

function readStore() {
  const empty = { scores: [] }
  try { return { ...empty, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) } } catch { return empty }
}
function writeStore(d) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
  fs.writeFileSync(DATA_FILE, JSON.stringify(d))
}

const rateMap = new Map() // ip → [timestamps]
function rateLimited(ip) {
  const now = Date.now()
  const arr = (rateMap.get(ip) || []).filter(t => now - t < 60_000)
  arr.push(now)
  rateMap.set(ip, arr)
  return arr.length > 12
}

function json(res, code, obj) {
  res.statusCode = code
  res.end(JSON.stringify(obj))
}

function collectBody(req, cb) {
  let body = ''
  req.on('data', c => { body += c; if (body.length > 4096) req.destroy() })
  req.on('end', () => {
    try { cb(JSON.parse(body)) } catch { cb(null) }
  })
}

function apiMiddleware(req, res, next) {
  if (!req.url.startsWith('/api/')) return next()
  res.setHeader('Content-Type', 'application/json; charset=utf-8')

  // ── /api/scores ──
  if (req.url.startsWith('/api/scores')) {
    if (req.method === 'GET') {
      if (req.url.includes('session=')) return json(res, 200, { token: signToken() })
      return json(res, 200, boardPayload(readStore()))
    }
    if (req.method === 'POST') {
      if (rateLimited(req.socket.remoteAddress || '?')) {
        return json(res, 429, { error: 'Příliš mnoho pokusů, zkus to za chvíli.' })
      }
      collectBody(req, data => {
        if (!data) return json(res, 400, { error: 'Neplatný požadavek.' })
        const { name: rawName, ms, token: runToken } = data
        const name = sanitizeName(rawName)
        const total = Number(ms)
        if (!name || !isFinite(total) || total < MIN_TOTAL_MS || total > MAX_TOTAL_MS) {
          return json(res, 400, { error: 'Neplatné jméno nebo čas.' })
        }
        const v = verifyToken(runToken, total)
        if (v !== 'ok') {
          const msg = v === 'tooFast' ? 'Čas neodpovídá délce hry.'
            : v === 'expired' ? 'Platnost kola vypršela, zahraj znovu.'
            : 'Kolo nelze ověřit, zahraj znovu.'
          return json(res, 403, { error: msg })
        }
        const store = readStore()
        const date = todayPrague()
        store.scores.push({
          name, ms: Math.round(total),
          date, weekId: isoWeekId(date), ts: Date.now(),
        })
        writeStore(store)
        json(res, 200, { board: boardPayload(store) })
      })
      return
    }
    return json(res, 405, { error: 'Method not allowed' })
  }

  return next()
}

const apiPlugin = {
  name: 'windflight-api-local',
  configureServer(server) { server.middlewares.use(apiMiddleware) },
  configurePreviewServer(server) { server.middlewares.use(apiMiddleware) },
}

export default defineConfig({
  server: { host: true, port: 5185 },
  preview: { host: true, port: 5185 },
  build: { target: 'es2019' },
  plugins: [apiPlugin],
})
