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
