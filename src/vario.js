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
    } catch { this.ctx = null }
  }

  toggleMute() {
    this.muted = !this.muted
    localStorage.setItem('windflight-muted', this.muted ? '1' : '0')
    if (this.muted && this.gain) this.gain.gain.value = 0
    return this.muted
  }

  /** @param vario m/s  @param dt s */
  update(vario, dt) {
    if (!this.ctx || this.muted) return
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
