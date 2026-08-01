// controls.js — vstup letadla:
//  mobil: náklon telefonu (DeviceOrientation) — beta = pitch, gamma = roll,
//         mapování os podle orientace displeje; plyn ± tlačítka na obrazovce
//  desktop: šipky/WASD = pitch+roll, W/S nebo +/- … plyn = Shift/Ctrl i W/S?
//         → finálně: ↑↓ pitch, ←→ roll, W = plyn +, S = plyn −
// Kalibrace: neutrální náklon se sejme při startu (hráč drží mobil pohodlně).
export class FlightControls {
  constructor() {
    this.keys = {}
    this.tilt = { beta: null, gamma: null }
    this.neutralB = null
    this.neutralG = null
    this.thrUpHeld = false
    this.thrDnHeld = false
    this.tiltActive = false

    addEventListener('keydown', e => { this.keys[e.code] = true })
    addEventListener('keyup', e => { this.keys[e.code] = false })

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
    // dvojklep kdekoli na obrazovce (mimo tlačítka plynu) = rekalibrace
    // aktuálního držení telefonu
    let lastTap = 0
    addEventListener('touchend', e => {
      if (e.target.closest && e.target.closest('.thr, #overlay')) return
      const now = performance.now()
      if (now - lastTap < 320) this.calibrate()
      lastTap = now
    })
  }

  /**
   * Volat z user gesta (Start) — iOS vyžaduje requestPermission.
   * Vrací: 'ok' | 'denied' | 'insecure' | 'unsupported'
   * POZOR: iOS Safari dává DeviceOrientation JEN na HTTPS (secure context) —
   * na http:// API vůbec neexistuje / permission spadne.
   */
  async enableTilt() {
    if (typeof DeviceOrientationEvent === 'undefined') {
      return window.isSecureContext ? 'unsupported' : 'insecure'
    }
    try {
      if (DeviceOrientationEvent.requestPermission) {
        if (!window.isSecureContext) return 'insecure'
        const res = await DeviceOrientationEvent.requestPermission()
        if (res !== 'granted') return 'denied'
      }
      addEventListener('deviceorientation', this._onOrient)
      return 'ok'
    } catch {
      return window.isSecureContext ? 'denied' : 'insecure'
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

    // klávesnice — LETECKY: šipka dolů = přitáhnout (stoupá), nahoru = potlačit
    if (this.keys.ArrowUp) pitch -= 1
    if (this.keys.ArrowDown) pitch += 1
    if (this.keys.ArrowLeft || this.keys.KeyA) roll -= 1
    if (this.keys.ArrowRight || this.keys.KeyD) roll += 1

    // náklon mobilu — oba zdroje (pitch i roll) se poměřují proti
    // ZKALIBROVANÉMU neutrálu (ne proti nule), stejně přeorientovanému
    // podle displeje jako za běhu (viz _orientedTilt). Dokud kalibrace
    // neproběhla, tilt neřídí (jinak by prvních ~1 s řídil špatný neutrál).
    if (this.tiltActive && this.tilt.beta != null && this.neutralB != null && this._calRemaining === 0) {
      const { b, g } = this._orientedTilt()
      // náklon k sobě (beta > neutral) = stoupat, od sebe = klesat
      pitch += Math.max(-1, Math.min(1, (b - this.neutralB) / 44))
      roll += Math.max(-1, Math.min(1, (g - this.neutralG) / 50))
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
