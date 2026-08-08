// vario.js — zvuk variometru (WebAudio): stoupání = pípání (výška i tempo
// rostou se stoupáním), silné klesání = hluboký souvislý tón. Jako v reálu.
export class Vario {
  constructor() {
    this.ctx = null
    this.muted = localStorage.getItem('windflight-muted') === '1'
    this._beepT = 0
  }

  init() {
    if (this.ctx) return
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)()
      this.gain = this.ctx.createGain()
      this.gain.gain.value = 0
      this.osc = this.ctx.createOscillator()
      this.osc.type = 'sine'
      this.osc.frequency.value = 600
      this.osc.connect(this.gain)
      this.gain.connect(this.ctx.destination)
      this.osc.start()

      // šum větru: filtrovaný bílý šum, hlasitost/kmitočet roste s rychlostí
      const len = this.ctx.sampleRate * 2
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
      const src = this.ctx.createBufferSource()
      src.buffer = buf
      src.loop = true
      this.windFilter = this.ctx.createBiquadFilter()
      this.windFilter.type = 'lowpass'
      this.windFilter.frequency.value = 400
      this.windGain = this.ctx.createGain()
      this.windGain.gain.value = 0
      src.connect(this.windFilter)
      this.windFilter.connect(this.windGain)
      this.windGain.connect(this.ctx.destination)
      src.start()
    } catch { this.ctx = null }
  }

  toggleMute() {
    this.muted = !this.muted
    localStorage.setItem('windflight-muted', this.muted ? '1' : '0')
    if (this.muted && this.gain) this.gain.gain.value = 0
    return this.muted
  }

  /** Krátký tón — upozornění, průlet bránou, cíl. Jednorázový oscilátor,
   *  ať se nemíchá s pípáním varia. */
  blip({ freq = 660, dur = 0.12, type = 'sine', vol = 0.12, to = null, delay = 0 } = {}) {
    if (!this.ctx || this.muted) return
    const t = this.ctx.currentTime + delay
    const o = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq, t)
    if (to) o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(vol, t + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g)
    g.connect(this.ctx.destination)
    o.start(t)
    o.stop(t + dur + 0.03)
  }

  /** Šumový úder — náraz do země, třepetání při přetažení. */
  noise({ dur = 0.4, cutoff = 300, vol = 0.25, to = null } = {}) {
    if (!this.ctx || this.muted) return
    const t = this.ctx.currentTime
    if (!this._noiseBuf) {
      const len = Math.floor(this.ctx.sampleRate * 1.0)
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
      const d = buf.getChannelData(0)
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
      this._noiseBuf = buf
    }
    const src = this.ctx.createBufferSource()
    src.buffer = this._noiseBuf
    const f = this.ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.setValueAtTime(cutoff, t)
    if (to) f.frequency.exponentialRampToValueAtTime(Math.max(40, to), t + dur)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(vol, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(f); f.connect(g); g.connect(this.ctx.destination)
    src.start(t)
    src.stop(t + dur + 0.03)
  }

  /** Průlet bránou: dvojité cinknutí; v cíli stoupavá trojka. */
  gateChime(finish = false) {
    if (finish) {
      [660, 880, 1320].forEach((f, i) => this.blip({ freq: f, dur: 0.3, type: 'triangle', vol: 0.13, delay: i * 0.16 }))
    } else {
      this.blip({ freq: 880, dur: 0.09, type: 'triangle', vol: 0.12 })
      this.blip({ freq: 1320, dur: 0.14, type: 'triangle', vol: 0.1, delay: 0.08 })
    }
  }

  /** Náraz do terénu. */
  crashSound() {
    this.noise({ dur: 0.55, cutoff: 900, to: 90, vol: 0.32 })
    this.blip({ freq: 90, dur: 0.5, type: 'sine', vol: 0.2, to: 45 })
  }

  /** Okamžité ticho (pauza, konec letu). */
  silence() {
    if (!this.ctx) return
    const t = this.ctx.currentTime
    if (this.gain) this.gain.gain.setTargetAtTime(0, t, 0.02)
    if (this.windGain) this.windGain.gain.setTargetAtTime(0, t, 0.05)
  }

  /** Šum větru: v = m/s vzdušné rychlosti, buffet = přetažení. */
  updateWind(v, buffet) {
    if (!this.ctx || this.muted || !this.windGain) return
    const t = this.ctx.currentTime
    const g = Math.min(0.16, Math.max(0, (v - 14) / 46) ** 1.6 * 0.16) + (buffet ? 0.05 * Math.random() : 0)
    this.windGain.gain.setTargetAtTime(g, t, 0.08)
    this.windFilter.frequency.setTargetAtTime(300 + v * 22 + (buffet ? Math.random() * 300 : 0), t, 0.1)
  }

  /** @param vario m/s  @param dt s */
  update(vario, dt) {
    if (!this.ctx || this.muted) {
      if (this.windGain && this.muted) this.windGain.gain.value = 0
      return
    }
    const g = this.gain.gain, f = this.osc.frequency
    if (vario > 0.25) {
      // pípání: frekvence 550–1200 Hz, tempo 1.6–5 Hz podle síly stoupání
      const rate = 1.6 + Math.min(5, vario) * 0.75
      this._beepT += dt * rate
      const on = (this._beepT % 1) < 0.42
      f.setTargetAtTime(550 + Math.min(6, vario) * 110, this.ctx.currentTime, 0.03)
      g.setTargetAtTime(on ? 0.14 : 0, this.ctx.currentTime, 0.012)
    } else if (vario < -2.2) {
      f.setTargetAtTime(240 - Math.min(4, -vario - 2.2) * 25, this.ctx.currentTime, 0.05)
      g.setTargetAtTime(0.09, this.ctx.currentTime, 0.05)
    } else {
      g.setTargetAtTime(0, this.ctx.currentTime, 0.04)
    }
  }
}
