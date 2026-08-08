// settings.js — trvalé volby hráče (jeden JSON klíč v localStorage).
// Vše, co si hráč jednou nastaví, musí přežít restart i zavření prohlížeče.
const KEY = 'windflight-settings'

const DEFAULTS = {
  // Dotykové ovládání (náklon i prstový knipl): false = klasika jako knipl,
  // tedy pohyb K SOBĚ zvedá nos a stoupá se. Ověřeno na telefonu 8. 8. 2026.
  // (Dřív to působilo obráceně kvůli chybě v kreslení sklonu modelu, ne
  // kvůli mapování vstupu — viz komentář u model.rotateX v glider.js.)
  // Přepínatelné za letu tlačítkem ⇅.
  invertY: false,
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
