// leaderboard.js — klient žebříčku: GET/POST /api/scores. Jméno hráče
// v localStorage. Server je lokální Vite middleware (VPS) nebo Vercel
// funkce — stejné relativní URL.
const NAME_KEY = 'windflight-name'

export function getSavedName() {
  return localStorage.getItem(NAME_KEY) || ''
}
export function saveName(name) {
  localStorage.setItem(NAME_KEY, name)
}

export async function fetchBoard() {
  const r = await fetch('/api/scores')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

// Podepsaný token na začátku kola — server jím ověří platnost času.
export async function requestSession() {
  const r = await fetch('/api/scores?session=1')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const d = await r.json()
  return d.token || null
}

// ms = celkový čas hledání fotek; server jej ověří proti tokenu.
export async function submitScore(name, ms, token) {
  const r = await fetch('/api/scores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ms, token }),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data
}
