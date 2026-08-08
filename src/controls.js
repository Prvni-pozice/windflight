// controls.js — vstup letadla:
//  mobil: náklon telefonu (DeviceOrientation) — beta = pitch, gamma = roll,
//         mapování os podle orientace displeje; plyn ± tlačítka na obrazovce
//  desktop: šipky/WASD = pitch+roll, W/S nebo +/- … plyn = Shift/Ctrl i W/S?
//         → finálně: ↑↓ pitch, ←→ roll, W = plyn +, S = plyn −
// Kalibrace: neutrální náklon se sejme při startu (hráč drží mobil pohodlně).
//
// Režimy na mobilu (přepínatelné za letu, viz setMode): 'tilt' = náklon
// telefonu, 'touch' = virtuální knipl prstem. Náklon je jen NABÍDKA — když
// hráči nesedí (nebo není k dispozici na http://), musí jít přepnout, ne
// restartovat hru.
import * as settings from './settings.js'

export class FlightControls {
  constructor() {
    this.keys = {}
    this.tilt = { beta: null, gamma: null }
    this.neutralB = null
    this.neutralG = null
    this.thrUpHeld = false
    this.thrDnHeld = false
    this.tiltActive = false      // tečou data z akcelerometru
    this.tiltAvailable = false   // povolení uděleno → jde nabídnout režim náklonu
    this.mode = settings.get('controlMode') === 'touch' ? 'touch' : 'tilt'
    this.invertY = !!settings.get('invertY')
    this.sens = Math.max(0.6, Math.min(1.8, +settings.get('tiltSens') || 1))

    addEventListener('keydown', e => { this.keys[e.code] = true })
    addEventListener('keyup', e => { this.keys[e.code] = false })

    // dotykový virtuální knipl: táhni prstem kdekoli
    this.stick = { active: false, dx: 0, dy: 0, id: null }
    addEventListener('touchstart', e => {
      if (this.mode !== 'touch') return
      if (e.target.closest && e.target.closest('.overlay, button, input')) return
      const t = e.changedTouches[0]
      this.stick.active = true
      this.stick.id = t.identifier
      this.stick.x0 = t.clientX
      this.stick.y0 = t.clientY
      this.stick.dx = 0; this.stick.dy = 0
      const base = document.getElementById('stick-base')
      if (base) {
        base.style.display = 'block'
        base.style.left = t.clientX + 'px'
        base.style.top = t.clientY + 'px'
      }
    }, { passive: true })
    addEventListener('touchmove', e => {
      if (!this.stick.active) return
      for (const t of e.changedTouches) {
        if (t.identifier !== this.stick.id) continue
        this.stick.dx = Math.max(-1, Math.min(1, (t.clientX - this.stick.x0) / 70))
        this.stick.dy = Math.max(-1, Math.min(1, (t.clientY - this.stick.y0) / 70))
        const knob = document.getElementById('stick-knob')
        if (knob) {
          knob.style.transform = `translate(calc(-50% + ${this.stick.dx * 34}px), calc(-50% + ${this.stick.dy * 34}px))`
        }
      }
    }, { passive: true })
    const stickEnd = e => {
      if (!this.stick.active) return
      for (const t of e.changedTouches) {
        if (t.identifier !== this.stick.id) continue
        this._stickCancel()
      }
    }
    addEventListener('touchend', stickEnd, { passive: true })
    addEventListener('touchcancel', stickEnd, { passive: true })

    // myš jako knipl: podržet levé tlačítko a táhnout (desktop)
    this.mouse = { active: false, dx: 0, dy: 0 }
    addEventListener('mousedown', e => {
      if (e.button !== 0 || e.target.closest('.overlay, button, input, #hud')) return
      this.mouse.active = true
      this.mouse.x0 = e.clientX
      this.mouse.y0 = e.clientY
      this.mouse.dx = 0
      this.mouse.dy = 0
    })
    addEventListener('mousemove', e => {
      if (!this.mouse.active) return
      this.mouse.dx = (e.clientX - this.mouse.x0) / 160
      this.mouse.dy = (e.clientY - this.mouse.y0) / 160
    })
    addEventListener('mouseup', () => { this.mouse.active = false; this.mouse.dx = 0; this.mouse.dy = 0 })

    this._calRemaining = 0
    this._calB = 0
    this._calG = 0
    this._onOrient = e => {
      if (e.beta == null || e.gamma == null) return
      this.tilt.beta = e.beta
      this.tilt.gamma = e.gamma
      this.tiltActive = true
      // kalibrace z PRŮMĚRU prvních vzorků, až data reálně tečou — jediný
      // odečet na časovači po kliku chytal ještě pohyb ruky/permission
      // dialog a na šířku dával špatný neutrál (letadlo pak "samo" zatáčelo)
      if (this._calRemaining > 0) {
        const { b, g } = this._orientedTilt()
        this._calB += b; this._calG += g
        this._calRemaining--
        if (this._calRemaining === 0) {
          this.neutralB = this._calB / 45
          this.neutralG = this._calG / 45
        }
      }
    }
    // dvojklep kdekoli na obrazovce = rekalibrace držení telefonu;
    // dvouprstý tap = přepnout minimapu (event 'wf-map')
    let lastTap = 0
    addEventListener('touchend', e => {
      if (e.target.closest && e.target.closest('.overlay, button, input')) return
      if (e.touches.length === 0 && e.changedTouches.length >= 2) {
        dispatchEvent(new Event('wf-map'))
        return
      }
      const now = performance.now()
      if (now - lastTap < 320 && this.mode === 'tilt') this.calibrate()
      lastTap = now
    })
  }

  /** Sklopit virtuální knipl do neutrálu a schovat ho. */
  _stickCancel() {
    this.stick.active = false
    this.stick.dx = 0; this.stick.dy = 0
    const base = document.getElementById('stick-base')
    if (base) base.style.display = 'none'
    const knob = document.getElementById('stick-knob')
    if (knob) knob.style.transform = 'translate(-50%, -50%)'
  }

  /** Přepnout ovládání. Bez povoleného náklonu vždy skončí u 'touch'.
   *  persist=false u vynuceného pádu na dotyk (http:// bez senzoru) — ať
   *  nepřepíšeme volbu hráče pro příště, až pojede přes HTTPS. */
  setMode(m, persist = true) {
    this.mode = (m === 'tilt' && this.tiltAvailable) ? 'tilt' : 'touch'
    if (persist) settings.set('controlMode', this.mode)
    this._stickCancel()
    if (this.mode === 'tilt') this.calibrate() // po přepnutí sejmi nové držení
    return this.mode
  }

  toggleMode() { return this.setMode(this.mode === 'tilt' ? 'touch' : 'tilt') }

  setInvertY(v) {
    this.invertY = !!v
    settings.set('invertY', this.invertY)
    return this.invertY
  }

  toggleInvertY() { return this.setInvertY(!this.invertY) }

  /**
   * Volat z user gesta (Start) — iOS vyžaduje requestPermission.
   * Vrací: 'ok' | 'denied' | 'insecure' | 'unsupported'
   * POZOR: iOS Safari dává DeviceOrientation JEN na HTTPS (secure context) —
   * na http:// API vůbec neexistuje / permission spadne.
   */
  async enableTilt() {
    const fail = code => { this.tiltAvailable = false; this.setMode('touch', false); return code }
    if (typeof DeviceOrientationEvent === 'undefined') {
      return fail(window.isSecureContext ? 'unsupported' : 'insecure')
    }
    try {
      if (DeviceOrientationEvent.requestPermission) {
        if (!window.isSecureContext) return fail('insecure')
        const res = await DeviceOrientationEvent.requestPermission()
        if (res !== 'granted') return fail('denied')
      }
      addEventListener('deviceorientation', this._onOrient)
      this.tiltAvailable = true
      this.setMode(this.mode, false) // uložená volba hráče (náklon / dotyk)
      return 'ok'
    } catch {
      return fail(window.isSecureContext ? 'denied' : 'insecure')
    }
  }

  /**
   * Náklon telefonu vůči OBRAZOVCE, spočtený z gravitačního vektoru.
   *
   * Proč ne přímo beta/gamma: Eulerovy úhly z DeviceOrientation se při
   * větším náklonu PŘEKLÁPĚJÍ (gamma umí skočit +85° → −85°, beta o 180°;
   * gimbal ambiguita). Na šířku je gamma zdrojem pitche → při přitažení
   * v letu dolů se vstup náhle obrátil a "nešel zvednout čumák".
   * Gravitační vektor g_d = (−cosβ·sinγ, sinβ, cosβ·cosγ) (třetí řádek
   * rotační matice Rz(α)Rx(β)Ry(γ); alfa/kompas na něj nemá vliv) je vůči
   * této ambiguitě imunní — libovolná Eulerova reprezentace téže polohy
   * dá stejný vektor. Z něj se úhly odvodí spojitě, bez skoků.
   *
   * Otočení do os obrazovky: W3C angle = otočení PROTI směru hodinových
   * ručiček; osy obrazovky v osách zařízení: e_right=(cosθ,−sinθ),
   * e_up=(sinθ,cosθ).
   */
  _orientedTilt() {
    const D = Math.PI / 180
    const be = this.tilt.beta * D, ga = this.tilt.gamma * D
    const cb = Math.cos(be), sb = Math.sin(be)
    const gx = -cb * Math.sin(ga), gy = sb, gz = cb * Math.cos(ga)
    const angDeg = (screen.orientation && typeof screen.orientation.angle === 'number')
      ? screen.orientation.angle
      : (typeof window.orientation === 'number' ? window.orientation : 0)
    const th = ((angDeg + 360) % 360) * D
    const xs = gx * Math.cos(th) - gy * Math.sin(th)   // gravitace podél "doprava po obrazovce"
    const ys = gx * Math.sin(th) + gy * Math.cos(th)   // gravitace podél "nahoru po obrazovce"
    // b ≈ beta v portraitu (0 = naplocho, 90 = svisle); g ≈ gamma, ale
    // spojitě (atan2 s hypot nikdy nepřeskočí) — saturuje u ±90°
    const b = Math.atan2(ys, gz) / D
    const g = Math.atan2(-xs, Math.hypot(ys, gz)) / D
    return { b, g }
  }

  /** Zahájit kalibraci: neutrál = průměr příštích 45 vzorků orientace. */
  calibrate() {
    this._calB = 0
    this._calG = 0
    this._calRemaining = 45
  }

  bindThrottleButtons(upEl, dnEl) {
    const bind = (el, prop) => {
      const on = e => { e.preventDefault(); this[prop] = true }
      const off = e => { e.preventDefault(); this[prop] = false }
      el.addEventListener('touchstart', on, { passive: false })
      el.addEventListener('touchend', off)
      el.addEventListener('touchcancel', off)
      el.addEventListener('mousedown', on)
      el.addEventListener('mouseup', off)
      el.addEventListener('mouseleave', off)
    }
    bind(upEl, 'thrUpHeld')
    bind(dnEl, 'thrDnHeld')
  }

  getInput() {
    let pitch = 0, roll = 0

    // myš-knipl: tažení dolů = přitáhnout (letecky)
    if (this.mouse.active) {
      roll += Math.max(-1, Math.min(1, this.mouse.dx))
      pitch += Math.max(-1, Math.min(1, -this.mouse.dy))
    }

    // dotykový knipl: směr podle invertY (viz níže u náklonu)
    if (this.stick.active) {
      roll += this.stick.dx
      pitch += (this.invertY ? 1 : -1) * this.stick.dy
    }

    // gamepad: levá páčka (deadzone 0.15), zatažení = stoupat
    const gp = typeof navigator !== 'undefined' && navigator.getGamepads && navigator.getGamepads()[0]
    if (gp) {
      const dz = v => Math.abs(v) < 0.15 ? 0 : v
      roll += dz(gp.axes[0] || 0)
      pitch += -dz(gp.axes[1] || 0)
    }

    // klávesnice — LETECKY: šipka dolů = přitáhnout (stoupá), nahoru = potlačit
    if (this.keys.ArrowUp) pitch -= 1
    if (this.keys.ArrowDown) pitch += 1
    if (this.keys.ArrowLeft || this.keys.KeyA) roll -= 1
    if (this.keys.ArrowRight || this.keys.KeyD) roll += 1

    // náklon mobilu — oba zdroje (pitch i roll) se poměřují proti
    // ZKALIBROVANÉMU neutrálu (ne proti nule), stejně přeorientovanému
    // podle displeje jako za běhu (viz _orientedTilt). Dokud kalibrace
    // neproběhla, tilt neřídí (jinak by prvních ~1 s řídil špatný neutrál).
    if (this.mode === 'tilt' && this.tiltActive && this.tilt.beta != null
        && this.neutralB != null && this._calRemaining === 0) {
      const { b, g } = this._orientedTilt()
      // Směr výšky: b roste = telefon se zvedá k sobě (displej blíž ke svislé).
      //  invertY = true  → k sobě = nos DOLŮ (výchozí, ověřeno na telefonu)
      //  invertY = false → k sobě = nos NAHORU (klasika jako u kniplu)
      const dir = this.invertY ? 1 : -1
      pitch += dir * Math.max(-1, Math.min(1, (b - this.neutralB) / (44 / this.sens)))
      roll += Math.max(-1, Math.min(1, (g - this.neutralG) / (50 / this.sens)))
    }

    pitch = Math.max(-1, Math.min(1, pitch))
    roll = Math.max(-1, Math.min(1, roll))
    // měkčí střed: u malých výchylek (klidný přímý let) reaguje málo,
    // u velkých (ostrá zatáčka/stoupání) plnou silou — bez skoku na hranici
    // (na rozdíl od tvrdého "dead zone" prahu). Klávesnice dává jen -1/0/1,
    // které křivka nechá beze změny (0^k=0, 1^k=1).
    const shape = v => Math.sign(v) * Math.abs(v) ** 1.8

    return {
      pitch: shape(pitch),
      roll: shape(roll),
      thrUp: this.thrUpHeld || !!this.keys.KeyW,
      thrDn: this.thrDnHeld || !!this.keys.KeyS,
      reset: !!this.keys.KeyR,
    }
  }
}
