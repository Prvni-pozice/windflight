// api/_lib.js — sdílená logika Vercel funkcí (soubory s _ nejsou routy).
// Úložiště: jeden JSON klíč ve Vercel KV / Upstash Redis REST.
// Store: { scores: [{name, ms, date, weekId, ts}] } — žebříček jen na jméno.

import crypto from 'node:crypto'

export const KEY = 'windflight-store'
export const TOKEN_MAX_AGE_MS = 2 * 3600 * 1000 // token platí 2 h
export const TIME_TOLERANCE_MS = 2500           // sklouz hodin / latence
export const MIN_TOTAL_MS = 30_000              // rychleji než 30 s celé kolo nedáš
export const MAX_TOTAL_MS = 7_200_000 // i pohodový let se počítá

// ── KV ────────────────────────────────────────────────────────────
export function kvEnv() {
  const e = process.env
  let url = e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL
  let token = e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    // Vercel/Upstash integrace může názvy prefixovat (např. STORAGE_KV_REST_API_URL)
    for (const k of Object.keys(e)) {
      if (!url && (k.endsWith('KV_REST_API_URL') || k.endsWith('UPSTASH_REDIS_REST_URL'))) url = e[k]
      if (!token && (k.endsWith('KV_REST_API_TOKEN') || k.endsWith('UPSTASH_REDIS_REST_TOKEN'))) token = e[k]
    }
  }
  return { url, token }
}

export async function kvGet(url, token) {
  const r = await fetch(`${url}/get/${KEY}`, { headers: { Authorization: `Bearer ${token}` } })
  const data = await r.json()
  const empty = { scores: [] }
  if (!data.result) return empty
  try { return { ...empty, ...JSON.parse(data.result) } } catch { return empty }
}

export async function kvSet(url, token, store) {
  await fetch(`${url}/set/${KEY}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(store),
  })
}

// ── podepsaný session token (anti-cheat) ──────────────────────────
// Klíč je server-only env. Token nese čas vydání; při ukládání ověříme,
// že od vydání uplynul aspoň naměřený čas → nelze poslat falešný
// „instantní" rekord přes curl.
export function signToken(secret) {
  const issued = Date.now()
  const nonce = crypto.randomBytes(8).toString('hex')
  const sig = crypto.createHmac('sha256', secret).update(`${issued}.${nonce}`).digest('hex')
  return `${issued}.${nonce}.${sig}`
}

export function verifyToken(secret, token, ms) {
  if (typeof token !== 'string') return 'missing'
  const parts = token.split('.')
  if (parts.length !== 3) return 'bad'
  const [issuedStr, nonce, sig] = parts
  const issued = parseInt(issuedStr, 10)
  if (!isFinite(issued)) return 'bad'
  const expected = crypto.createHmac('sha256', secret).update(`${issued}.${nonce}`).digest('hex')
  const a = Buffer.from(sig), b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'bad'
  const age = Date.now() - issued
  if (age < 0 || age > TOKEN_MAX_AGE_MS) return 'expired'
  if (age < ms - TIME_TOLERANCE_MS) return 'tooFast' // doběhl rychleji než token žije
  return 'ok'
}

// ── čas / týden (Europe/Prague, ISO týden Po–Ne) ──────────────────
export function todayPrague() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' }).format(new Date())
}

export function isoWeekId(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const dayNum = (date.getUTCDay() + 6) % 7          // Po=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3)    // čtvrtek tohoto týdne
  const jan4 = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  const jan4Day = (jan4.getUTCDay() + 6) % 7
  jan4.setUTCDate(jan4.getUTCDate() - jan4Day + 3)   // první čtvrtek roku
  const week = 1 + Math.round((date - jan4) / (7 * 86400000))
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export function prevWeekId(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() - 7)
  return isoWeekId(date.toISOString().slice(0, 10))
}

// ── validace vstupů ────────────────────────────────────────────────
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return null
  const name = raw.replace(/[<>&"']/g, '').trim().slice(0, 24)
  return name.length >= 1 ? name : null
}

// ── žebříčky ──────────────────────────────────────────────────────
// Řazení: čas vzestupně; při shodě je výš STARŠÍ výsledek (menší ts).
export const byTime = (a, b) => (a.ms - b.ms) || (a.ts - b.ts)

// Nejlepší výsledek na hráče (klíč: jméno), seřazeno.
export function bestPerPlayer(list, limit = 10) {
  const m = new Map()
  for (const s of list) {
    const key = `name:${s.name}`
    const b = m.get(key)
    if (!b || byTime(s, b) < 0) m.set(key, s)
  }
  return [...m.values()].sort(byTime).slice(0, limit)
    .map(({ name, ms, date }) => ({ name, ms, date }))
}

export function boardPayload(store) {
  const today = todayPrague()
  const weekId = isoWeekId(today)
  const athRec = store.scores.length ? [...store.scores].sort(byTime)[0] : null
  return {
    date: today,
    weekId,
    week: bestPerPlayer(store.scores.filter(s => s.weekId === weekId)),
    allTime: bestPerPlayer(store.scores),
    ath: athRec ? { name: athRec.name, ms: athRec.ms, date: athRec.date } : null,
  }
}

/** Načte JSON body (Vercel req.body bývá už objekt, ale pojistíme se). */
export function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  try { return JSON.parse(req.body || '{}') } catch { return {} }
}
