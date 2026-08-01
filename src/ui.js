// ui.js — overlaye (start / cíl / náraz / žebříček) + letový HUD
// (čas, rychlost, výška, variometr, brány). Jména jen přes textContent.
import { fetchBoard, submitScore, requestSession, getSavedName, saveName } from './leaderboard.js'

const BEST_KEY = 'windflight-best-ms'

export function formatTime(ms) {
  const s = ms / 1000
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`
}

export class UI {
  constructor({ weatherLabel, gateTotal, onStart, onRetry }) {
    this.startScreen = document.getElementById('start-screen')
    this.winOverlay = document.getElementById('win-overlay')
    this.crashOverlay = document.getElementById('crash-overlay')
    this.boardOverlay = document.getElementById('board-overlay')
    this.hud = document.getElementById('hud')
    this.gateMarker = document.getElementById('gate-marker')
    this.nameInput = document.getElementById('player-name')
    this.saveStatus = document.getElementById('save-status')
    this.saveScoreBox = document.getElementById('save-score')
    this.lastMs = null
    this.runToken = null
    this.lastBoard = null

    document.getElementById('weather-line').textContent = weatherLabel
    for (const el of document.querySelectorAll('.gate-n')) el.textContent = gateTotal

    document.getElementById('start-btn').addEventListener('click', onStart)
    document.getElementById('retry-btn').addEventListener('click', onRetry)
    document.getElementById('crash-retry-btn').addEventListener('click', onRetry)
    document.getElementById('board-link').addEventListener('click', () => this.showBoard())
    document.getElementById('board-close').addEventListener('click', () => this.boardOverlay.classList.add('hidden'))
    document.getElementById('save-score-btn').addEventListener('click', () => this._submit())
    this.nameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') this._submit()
      e.stopPropagation()
    })
    this.nameInput.value = getSavedName()

    const muteBtn = document.getElementById('mute-btn')
    this.onMuteToggle = null
    muteBtn.addEventListener('click', () => {
      if (this.onMuteToggle) muteBtn.textContent = this.onMuteToggle() ? '🔇' : '🔊'
    })

    this._refreshBest()
    this.refreshBoards()
  }

  get best() {
    const v = localStorage.getItem(BEST_KEY)
    return v ? parseInt(v, 10) : null
  }

  _refreshBest() {
    const b = this.best
    document.getElementById('start-best').textContent = b ? `Tvůj rekord: ${formatTime(b)}` : ''
  }

  async refreshBoards() {
    try {
      this.lastBoard = await fetchBoard()
      this._renderBoards()
    } catch {
      document.getElementById('start-top3').replaceChildren(this._muted('Žebříček není dostupný'))
    }
  }

  _muted(text) {
    const el = document.createElement('div')
    el.className = 'muted'
    el.textContent = text
    return el
  }

  _renderBoards() {
    const b = this.lastBoard
    if (!b) return
    const medals = ['🥇', '🥈', '🥉']
    const src = (b.week && b.week.length) ? b.week : (b.allTime || [])
    const box = document.getElementById('start-top3')
    box.replaceChildren()
    if (src.length) {
      box.appendChild(this._muted('Nejrychlejší piloti:'))
      src.slice(0, 3).forEach((e, i) => {
        const row = document.createElement('div')
        row.className = 'row'
        const m = document.createElement('span'); m.textContent = medals[i]
        const n = document.createElement('span'); n.className = 'name'; n.textContent = e.name
        const t = document.createElement('span'); t.className = 'time'; t.textContent = formatTime(e.ms)
        row.append(m, n, t)
        box.appendChild(row)
      })
    }
    this._fillList(document.getElementById('board-week'), b.week)
    this._fillList(document.getElementById('board-alltime'), b.allTime)
    document.getElementById('board-ath').textContent = b.ath
      ? `👑 Rekord: ${b.ath.name} · ${formatTime(b.ath.ms)} (${b.ath.date})` : ''
    const wb = document.getElementById('win-board')
    wb.replaceChildren()
    if (b.week && b.week.length) {
      wb.appendChild(this._muted('TOP 10 tento týden:'))
      b.week.forEach((e, i) => {
        const row = document.createElement('div')
        row.className = 'row'
        const m = document.createElement('span'); m.textContent = medals[i] || `${i + 1}.`
        const n = document.createElement('span'); n.className = 'name'; n.textContent = e.name
        const t = document.createElement('span'); t.className = 'time'; t.textContent = formatTime(e.ms)
        row.append(m, n, t)
        wb.appendChild(row)
      })
    }
  }

  _fillList(ol, entries) {
    ol.replaceChildren()
    if (!entries || !entries.length) {
      const li = document.createElement('li')
      li.className = 'empty'
      li.textContent = 'Zatím žádný let'
      ol.appendChild(li)
      return
    }
    for (const e of entries) {
      const li = document.createElement('li')
      const n = document.createElement('span'); n.className = 'name'; n.textContent = e.name
      const t = document.createElement('span'); t.className = 'time'; t.textContent = formatTime(e.ms)
      li.append(n, t)
      ol.appendChild(li)
    }
  }

  async beginRun() {
    this.runToken = null
    try { this.runToken = await requestSession() } catch { /* offline */ }
  }

  // ── obrazovky ──
  showFlying(isTouch) {
    this.startScreen.classList.add('hidden')
    this.winOverlay.classList.add('hidden')
    this.crashOverlay.classList.add('hidden')
    this.boardOverlay.classList.add('hidden')
    this.hud.classList.add('visible')
    document.getElementById('gate-info').style.display = 'block'
    document.getElementById('vario-gauge').classList.add('visible')
    document.getElementById('tilt-hint').style.display = isTouch ? 'block' : 'none'
  }

  _hideFlightHud() {
    this.hud.classList.remove('visible')
    document.getElementById('gate-info').style.display = 'none'
    document.getElementById('vario-gauge').classList.remove('visible')
    document.getElementById('tilt-hint').style.display = 'none'
    this.gateMarker.style.display = 'none'
  }

  showWin(ms) {
    this.lastMs = ms
    const prev = this.best
    const rec = !prev || ms < prev
    if (rec) localStorage.setItem(BEST_KEY, String(Math.round(ms)))
    document.getElementById('final-time').textContent = formatTime(ms)
    document.getElementById('record-badge').classList.toggle('show', rec)
    this.saveScoreBox.classList.remove('done')
    this.saveStatus.textContent = ''
    const btn = document.getElementById('save-score-btn')
    btn.disabled = false
    btn.textContent = 'Uložit výsledek'
    this.nameInput.value = getSavedName()
    this.winOverlay.classList.remove('hidden')
    this._hideFlightHud()
    this._refreshBest()
    this.refreshBoards()
  }

  showCrash(gatesDone, gateTotal) {
    document.getElementById('crash-info').textContent =
      `Proletěno bran: ${gatesDone} z ${gateTotal}`
    this.crashOverlay.classList.remove('hidden')
    this._hideFlightHud()
  }

  showBoard() {
    this.refreshBoards()
    this.boardOverlay.classList.remove('hidden')
  }

  // ── HUD ──
  gatePassed(done, total) {
    const el = document.getElementById('gate-flash')
    el.textContent = done >= total ? '🏁 CÍL!' : `✔ Brána ${done}/${total}`
    el.classList.remove('show')
    void el.offsetWidth
    el.classList.add('show')
  }

  setGateInfo(num, total, name, distM) {
    document.getElementById('gate-info').textContent =
      `⭘ ${num}/${total} ${name} · ${distM > 1500 ? (distM / 1000).toFixed(1) + ' km' : Math.round(distM) + ' m'}`
  }

  setVarioAvg(v) {
    document.getElementById('hud-vario-avg').textContent = (v > 0 ? '+' : '') + v.toFixed(1)
  }

  updateHud({ ms, speedKmh, altM, aglM, vario, stalled, slow, headingDeg, windDirDeg }) {
    document.getElementById('hud-time').textContent = formatTime(ms)
    document.getElementById('hud-speed').textContent = Math.round(speedKmh)
    document.getElementById('hud-alt').textContent = Math.round(altM)
    document.getElementById('hud-agl').textContent = Math.round(aglM)
    const v = document.getElementById('hud-vario')
    v.textContent = (vario > 0 ? '+' : '') + vario.toFixed(1)
    v.className = vario > 0.2 ? 'up' : vario < -2 ? 'down' : ''
    const needle = document.getElementById('vario-needle')
    needle.style.transform = `translateY(${-Math.max(-5, Math.min(5, vario)) * 9}px)`
    document.getElementById('stall-warn').classList.toggle('show', stalled || slow)
    document.getElementById('hud-agl').classList.toggle('low', aglM < 150)
    // šipka: KAM vítr fouká, v souřadnicích obrazovky (nahoře = můj kurz)
    const rel = (windDirDeg + 180) - headingDeg
    document.getElementById('wind-arrow').style.transform = `rotate(${rel}deg)`
  }

  async _submit() {
    if (this.lastMs == null) return
    const name = this.nameInput.value.trim()
    if (!name) { this.nameInput.focus(); return }
    saveName(name)
    const btn = document.getElementById('save-score-btn')
    btn.disabled = true
    btn.textContent = 'Ukládám…'
    try {
      if (!this.runToken) this.runToken = await requestSession()
      const resp = await submitScore(name, this.lastMs, this.runToken)
      this.lastBoard = resp.board || resp
      this._renderBoards()
      this.saveScoreBox.classList.add('done')
      this.saveStatus.textContent = '✅ Uloženo do žebříčku.'
      this.saveStatus.className = 'ok'
    } catch (e) {
      btn.textContent = 'Zkusit znovu'
      this.saveStatus.textContent = `Uložení selhalo: ${e.message}`
      this.saveStatus.className = 'err'
    } finally {
      btn.disabled = false
      if (this.saveScoreBox.classList.contains('done')) btn.textContent = 'Uložit výsledek'
    }
  }
}
