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
  constructor({ weatherLabel, gateTotal, onStart, onRetry, onPause, onResume, onFree, onContinue }) {
    this.startScreen = document.getElementById('start-screen')
    this.winOverlay = document.getElementById('win-overlay')
    this.crashOverlay = document.getElementById('crash-overlay')
    this.boardOverlay = document.getElementById('board-overlay')
    this.pauseOverlay = document.getElementById('pause-overlay')
    this.hud = document.getElementById('hud')
    this.gateMarker = document.getElementById('gate-marker')
    this.nameInput = document.getElementById('player-name')
    this.saveStatus = document.getElementById('save-status')
    this.saveScoreBox = document.getElementById('save-score')
    this.lastMs = null
    this.runToken = null
    this.lastBoard = null

    document.getElementById('weather-line').textContent = weatherLabel
    this.weatherLabel = weatherLabel
    for (const el of document.querySelectorAll('.gate-n')) el.textContent = gateTotal

    document.getElementById('start-btn').addEventListener('click', onStart)
    document.getElementById('retry-btn').addEventListener('click', onRetry)
    document.getElementById('crash-retry-btn').addEventListener('click', onRetry)
    document.getElementById('free-btn').addEventListener('click', () => onFree && onFree())
    document.getElementById('crash-continue-btn').addEventListener('click', () => onContinue && onContinue())
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

    document.getElementById('pause-btn').addEventListener('click', () => onPause && onPause())
    document.getElementById('pause-restart-btn').addEventListener('click', onRetry)
    // stejné okno slouží jako pauza i jako nastavení z úvodní obrazovky
    document.getElementById('pause-resume-btn').addEventListener('click', () => {
      if (this._settingsMode) { this.hidePause(); this._settingsMode = false; return }
      if (onResume) onResume()
    })
    document.getElementById('settings-link').addEventListener('click', () => this.openSettings())

    this.onSens = null
    const sens = document.getElementById('tilt-sens')
    sens.addEventListener('input', () => {
      document.getElementById('tilt-sens-val').textContent = Math.round(sens.value * 100) + ' %'
      if (this.onSens) this.onSens(+sens.value)
    })
    document.getElementById('invert-chk').addEventListener('change', e => {
      if (this.onInvertSet) this.onInvertSet(e.target.checked)
    })
    document.getElementById('quality-sel').addEventListener('change', e => {
      if (this.onQuality) this.onQuality(e.target.value)
    })
    document.getElementById('rotate-dismiss').addEventListener('click', () => {
      document.body.classList.add('allow-portrait') // hráč trvá na portrétu
    })

    this.onModeToggle = null
    this.onInvertToggle = null
    this.onViewToggle = null
    document.getElementById('mode-btn').addEventListener('click', () => this.onModeToggle && this.onModeToggle())
    document.getElementById('invert-btn').addEventListener('click', () => this.onInvertToggle && this.onInvertToggle())
    document.getElementById('view-btn').addEventListener('click', () => this.onViewToggle && this.onViewToggle())

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

  /** Minimapa: podklad z heightmapy (hypsometrie+stín), trať, hráč. */
  buildMinimap(terrain, gates) {
    const W = 240
    const H = Math.round(W * terrain.sizeZ / terrain.sizeX)
    this.mmW = W; this.mmH = H
    this.mmTerrain = terrain
    this.mmGates = gates
    const base = document.createElement('canvas')
    base.width = W; base.height = H
    const ctx = base.getContext('2d')
    const img = ctx.createImageData(W, H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const wx = x / (W - 1) * terrain.sizeX
        const wz = y / (H - 1) * terrain.sizeZ
        const h = terrain.heightAt(wx, wz)
        const hr = terrain.heightAt(Math.min(terrain.sizeX, wx + 120), wz)
        const shade = Math.max(0.6, Math.min(1.25, 1 - (hr - h) / 260))
        let r, g, b
        if (h > 2800) { r = 244; g = 247; b = 250 }
        else if (h > 2100) { r = 150; g = 142; b = 132 }
        else if (h > 1500) { r = 118; g = 148; b = 98 }
        else { r = 96; g = 138; b = 82 }
        const i = (y * W + x) * 4
        img.data[i] = r * shade; img.data[i + 1] = g * shade; img.data[i + 2] = b * shade
        img.data[i + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
    this.mmBase = base
    const cv = document.getElementById('minimap')
    cv.width = W; cv.height = H
    this.mmCtx = cv.getContext('2d')

    document.getElementById('map-btn').addEventListener('click', () => this.toggleMinimap())
    addEventListener('wf-map', () => this.toggleMinimap())
    addEventListener('keydown', e => {
      if (e.code === 'Tab') { e.preventDefault(); this.toggleMinimap() }
    })
  }

  toggleMinimap() {
    this.mmOn = !this.mmOn
    document.getElementById('minimap').style.display = this.mmOn ? 'block' : 'none'
  }

  updateMinimap(pos, heading, currentGate) {
    if (!this.mmOn || !this.mmCtx) return
    const c = this.mmCtx, W = this.mmW, H = this.mmH, t = this.mmTerrain
    c.drawImage(this.mmBase, 0, 0)
    const px = x => x / t.sizeX * W
    const pz = z => z / t.sizeZ * H
    // trať
    c.strokeStyle = 'rgba(255,255,255,0.55)'
    c.lineWidth = 1.5
    c.beginPath()
    this.mmGates.list.forEach((g, i) => i ? c.lineTo(px(g.x), pz(g.z)) : c.moveTo(px(g.x), pz(g.z)))
    c.stroke()
    this.mmGates.list.forEach((g, i) => {
      c.fillStyle = g.done ? 'rgba(55,214,122,0.65)' : (i === currentGate ? '#37d67a' : 'rgba(255,255,255,0.85)')
      c.beginPath()
      c.arc(px(g.x), pz(g.z), i === currentGate ? 5 : 3.4, 0, Math.PI * 2)
      c.fill()
    })
    // hráč: trojúhelníček po směru letu
    const x = px(pos.x), y = pz(pos.z)
    c.save()
    c.translate(x, y)
    c.rotate(heading)
    c.fillStyle = '#ffd23f'
    c.beginPath()
    c.moveTo(0, -7); c.lineTo(4.5, 5); c.lineTo(-4.5, 5); c.closePath()
    c.fill()
    c.restore()
  }

  /** @param secToImpact 0 = čisto, jinak sekundy do nárazu podle dráhy letu */
  setTerrainWarn(secToImpact) {
    const el = document.getElementById('terrain-warn')
    el.classList.toggle('show', secToImpact > 0)
    if (secToImpact > 0) {
      el.textContent = secToImpact < 4 ? '⛰ TERÉN — VYBER TO!' : '⛰ terén v dráze letu'
      el.classList.toggle('urgent', secToImpact < 4)
    }
  }

  showPause(info) {
    this._settingsMode = false
    document.getElementById('pause-title').textContent = '⏸ Pauza'
    document.getElementById('pause-info').textContent = info || 'Čas letu stojí'
    document.getElementById('pause-resume-btn').innerHTML = '▶&nbsp; Pokračovat'
    document.getElementById('pause-restart-btn').style.display = ''
    this.pauseOverlay.classList.remove('hidden')
    this.setCountdown(0)
  }

  openSettings() {
    this._settingsMode = true
    document.getElementById('pause-title').textContent = '⚙ Nastavení'
    document.getElementById('pause-info').textContent = 'Platí hned a pamatuje se'
    document.getElementById('pause-resume-btn').textContent = 'Zavřít'
    document.getElementById('pause-restart-btn').style.display = 'none'
    this.pauseOverlay.classList.remove('hidden')
  }

  /** Naplnit ovládací prvky nastavení podle skutečného stavu. */
  syncSettings({ sens, invertY, isTouch, quality }) {
    document.getElementById('tilt-sens').value = sens
    document.getElementById('tilt-sens-val').textContent = Math.round(sens * 100) + ' %'
    document.getElementById('invert-chk').checked = !!invertY
    document.getElementById('quality-sel').value = quality || 'auto'
    // citlivost náklonu nemá na desktopu co ovlivnit
    document.getElementById('row-sens').classList.toggle('hidden', !isTouch)
    document.getElementById('row-invert').classList.toggle('hidden', !isTouch)
  }

  hidePause() { this.pauseOverlay.classList.add('hidden') }

  /** n>0 = zobraz číslo odpočtu, 0 = schovej. */
  setCountdown(n) {
    const el = document.getElementById('countdown')
    el.classList.toggle('show', n > 0)
    if (n > 0) el.textContent = String(n)
  }

  /** Krátká zpráva uprostřed nahoře (přepnutí režimu, kamera, pauza…). */
  toast(text, ms = 1900) {
    const el = document.getElementById('toast')
    el.textContent = text
    el.classList.add('show')
    clearTimeout(this._toastT)
    this._toastT = setTimeout(() => el.classList.remove('show'), ms)
  }

  setViewUi(camMode) {
    document.getElementById('view-btn').textContent = camMode === 'cockpit' ? '👁 Kokpit' : '🎥 Zvenku'
  }

  /** Stav přepínačů ovládání podle FlightControls. */
  setControlUi({ mode, invertY, tiltAvailable }) {
    const mb = document.getElementById('mode-btn')
    mb.textContent = mode === 'tilt' ? '📱 Náklon' : '✋ Dotyk'
    // bez povoleného senzoru není mezi čím přepínat
    mb.style.display = tiltAvailable ? 'block' : 'none'
    document.getElementById('invert-btn').textContent = invertY ? '⇅ Obráceně' : '⇅ Klasicky'
    document.getElementById('tilt-hint').textContent = mode === 'tilt'
      ? 'Náklon telefonu · dvojklep = rekalibrace držení'
      : (tiltAvailable
        ? 'Táhni prstem po obrazovce = knipl'
        : 'Táhni prstem = knipl (náklon jde jen přes HTTPS)')
  }

  async beginRun() {
    this.runToken = null
    try { this.runToken = await requestSession() } catch { /* offline */ }
  }

  // ── obrazovky ──
  showFlying(isTouch, runMode = 'race') {
    this.startScreen.classList.add('hidden')
    this.winOverlay.classList.add('hidden')
    this.crashOverlay.classList.add('hidden')
    this.boardOverlay.classList.add('hidden')
    this.pauseOverlay.classList.add('hidden')
    this.setCountdown(0)
    this.hud.classList.add('visible')
    const free = runMode === 'free'
    document.getElementById('gate-info').style.display = free ? 'none' : 'block'
    document.getElementById('free-badge').style.display = free ? 'block' : 'none'
    document.getElementById('vario-gauge').classList.add('visible')
    document.getElementById('tilt-hint').style.display = isTouch ? 'block' : 'none'
    document.getElementById('ctrl-btns').classList.toggle('visible', !!isTouch)
  }

  _hideFlightHud() {
    this.hud.classList.remove('visible')
    document.getElementById('gate-info').style.display = 'none'
    document.getElementById('free-badge').style.display = 'none'
    document.getElementById('vario-gauge').classList.remove('visible')
    document.getElementById('tilt-hint').style.display = 'none'
    document.getElementById('ctrl-btns').classList.remove('visible')
    document.getElementById('stall-warn').classList.remove('show')
    this.setTerrainWarn(0)
    this.pauseOverlay.classList.add('hidden')
    this.setCountdown(0)
    this.gateMarker.style.display = 'none'
  }

  /** Statistika letu na výsledkovce — z čeho se dá poučit i chlubit. */
  _renderStats(stats) {
    const box = document.getElementById('win-stats')
    box.replaceChildren()
    if (!stats) return
    const items = [
      ['Nejvyšší bod', `${Math.round(stats.maxAlt)} m`],
      ['Nejlepší stoupák', `${stats.maxClimb > 0 ? '+' : ''}${stats.maxClimb.toFixed(1)} m/s`],
      ['Nejvyšší rychlost', `${Math.round(stats.maxSpeed)} km/h`],
      ['Uletěno', `${(stats.distM / 1000).toFixed(1)} km`],
      ['Vykroužených stoupáků', String(stats.thermals)],
    ]
    for (const [label, value] of items) {
      const cell = document.createElement('div')
      cell.className = 'stat'
      const l = document.createElement('small'); l.textContent = label
      const v = document.createElement('b'); v.textContent = value
      cell.append(l, v)
      box.appendChild(cell)
    }
  }

  showWin(ms, scoring = true, stats = null) {
    this._renderStats(stats)
    this.lastMs = scoring ? ms : null
    const prev = this.best
    const rec = scoring && (!prev || ms < prev)
    if (rec) localStorage.setItem(BEST_KEY, String(Math.round(ms)))
    document.getElementById('final-time').textContent = formatTime(ms)
    document.getElementById('win-cond').textContent = this.weatherLabel
    document.getElementById('record-badge').classList.toggle('show', rec)
    // let restartovaný u brány se do žebříčku nepočítá
    this.saveScoreBox.classList.toggle('done', !scoring)
    this.saveStatus.textContent = scoring ? '' : 'Let pokračoval od brány — mimo žebříček.'
    this.saveStatus.className = scoring ? '' : 'muted'
    const btn = document.getElementById('save-score-btn')
    btn.disabled = false
    btn.textContent = 'Uložit výsledek'
    this.nameInput.value = getSavedName()
    this.winOverlay.classList.remove('hidden')
    this._hideFlightHud()
    this._refreshBest()
    this.refreshBoards()
  }

  showCrash(gatesDone, gateTotal, tip, canContinue) {
    document.getElementById('crash-info').textContent = gateTotal
      ? `Proletěno bran: ${gatesDone} z ${gateTotal}`
      : 'Konec volného letu'
    document.getElementById('crash-tip').textContent = tip || ''
    document.getElementById('crash-continue-btn').style.display = canContinue ? '' : 'none'
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

  setGateInfo(num, total, name, distM, glide) {
    document.getElementById('gate-text').textContent =
      `⭘ ${num}/${total} ${name} · ${distM > 1500 ? (distM / 1000).toFixed(1) + ' km' : Math.round(distM) + ' m'}`
    const el = document.getElementById('gate-glide')
    if (!glide) { el.textContent = ''; return }
    const m = Math.round(glide.margin)
    // ▲ = tolik metrů přiletím nad bránu, ▼ = tolik mi chybí
    el.textContent = `${glide.ridge ? '⛰' : ''}${m >= 0 ? '▲ +' : '▼ '}${m} m`
    el.className = m > 150 ? 'ok' : (m >= 0 ? 'tight' : 'short')
  }

  setVarioAvg(v) {
    document.getElementById('hud-vario-avg').textContent = (v > 0 ? '+' : '') + v.toFixed(1)
  }

  updateHud({ ms, speedKmh, altM, aglM, vario, stalled, slow, headingDeg, windDirDeg, stfKmh }) {
    document.getElementById('hud-time').textContent = formatTime(ms)
    document.getElementById('hud-speed').textContent = Math.round(speedKmh)
    document.getElementById('hud-alt').textContent = Math.round(altM)
    document.getElementById('hud-agl').textContent = Math.round(aglM)
    const v = document.getElementById('hud-vario')
    v.textContent = (vario > 0 ? '+' : '') + vario.toFixed(1)
    v.className = vario > 0.2 ? 'up' : vario < -2 ? 'down' : ''
    const needle = document.getElementById('vario-needle')
    needle.style.transform = `translateY(${-Math.max(-5, Math.min(5, vario)) * 9}px)`
    needle.style.background = vario > 0.2 ? '#7dffb0' : (vario < -2 ? '#ff9c8f' : '#dfe9f2')
    document.getElementById('stall-warn').classList.toggle('show', stalled || slow)
    document.getElementById('hud-agl').classList.toggle('low', aglM < 150)
    // šipka: KAM vítr fouká, v souřadnicích obrazovky (nahoře = můj kurz)
    const rel = (windDirDeg + 180) - headingDeg
    document.getElementById('wind-arrow').style.transform = `rotate(${rel}deg)`
    // speed-to-fly: ve stoupání zpomal k minimálnímu opadání, v klesáku utíkej
    const stf = vario > 0.4 ? 85 : Math.round(Math.min(175, stfKmh) / 5) * 5
    document.getElementById('hud-stf').textContent = stf
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
