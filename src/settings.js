// settings.js — trvalé volby hráče (jeden JSON klíč v localStorage).
// Vše, co si hráč jednou nastaví, musí přežít restart i zavření prohlížeče.
const KEY = 'windflight-settings'

const DEFAULTS = {
  // dotykové ovládání (náklon i prstový knipl): true = pohyb K SOBĚ / DOLŮ
  // po obrazovce dává nos dolů. Ověřeno na telefonu — opačné mapování
  // hráčům nesedělo. Přepínatelné za letu tlačítkem ⇅.
  invertY: true,
  tiltSens: 1,          // násobič citlivosti náklonu (0.6–1.8)
  controlMode: 'tilt',  // 'tilt' | 'touch'
  camera: 'chase',      // 'chase' | 'cockpit'
  quality: 'auto',      // 'auto' | 'low' | 'high'
}

let cache = null

function all() {
  if (!cache) {
    cache = { ...DEFAULTS }
    try { Object.assign(cache, JSON.parse(localStorage.getItem(KEY) || '{}')) } catch { /* smazaný/rozbitý storage */ }
  }
  return cache
}

export function get(k) { return all()[k] }

export function set(k, v) {
  all()[k] = v
  try { localStorage.setItem(KEY, JSON.stringify(cache)) } catch { /* private mode */ }
  return v
}
