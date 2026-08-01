// Vercel Serverless Function: /api/scores — žebříček (GET board / POST výsledek).
// Úložiště: Vercel KV / Upstash Redis REST (env KV_REST_API_URL/TOKEN nebo
// UPSTASH_REDIS_REST_*). Bez nich vrací 501.
//
// GET ?session=1 → podepsaný anti-cheat token; GET → board.
// POST: { name, ms, token } — token váže celkový čas (viz _lib.verifyToken).
// Stejná logika běží lokálně ve vite.config.js middleware.

import {
  kvEnv, kvGet, kvSet, signToken, verifyToken, todayPrague, isoWeekId,
  sanitizeName, boardPayload, MIN_TOTAL_MS, MAX_TOTAL_MS, readBody,
} from './_lib.js'

export default async function handler(req, res) {
  const { url, token } = kvEnv()
  if (!url || !token) {
    res.status(501).json({ error: 'Žebříček není nakonfigurován (chybí Vercel KV / Upstash).' })
    return
  }
  // podpisový klíč: dedikovaný env, jinak KV token (taky server-only)
  const secret = process.env.SIGNING_SECRET || token

  if (req.method === 'GET') {
    if (req.query && req.query.session) {
      res.status(200).json({ token: signToken(secret) })
      return
    }
    const store = await kvGet(url, token)
    res.status(200).json(boardPayload(store))
    return
  }

  if (req.method === 'POST') {
    const { name: rawName, ms, token: runToken } = readBody(req)
    const name = sanitizeName(rawName)
    const total = Number(ms)
    if (!name || !isFinite(total) || total < MIN_TOTAL_MS || total > MAX_TOTAL_MS) {
      res.status(400).json({ error: 'Neplatné jméno nebo čas.' })
      return
    }
    const v = verifyToken(secret, runToken, total)
    if (v !== 'ok') {
      const msg = v === 'tooFast' ? 'Čas neodpovídá délce hry.'
        : v === 'expired' ? 'Platnost kola vypršela, zahraj znovu.'
        : 'Kolo nelze ověřit, zahraj znovu.'
      res.status(403).json({ error: msg })
      return
    }

    const store = await kvGet(url, token)
    const date = todayPrague()
    store.scores.push({
      name, ms: Math.round(total),
      date, weekId: isoWeekId(date), ts: Date.now(),
    })
    if (store.scores.length > 5000) store.scores = store.scores.slice(-5000)

    await kvSet(url, token, store)
    res.status(200).json({ board: boardPayload(store) })
    return
  }

  res.status(405).json({ error: 'Method not allowed' })
}
