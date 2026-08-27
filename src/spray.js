// spray.js — sníh zvířený průletem těsně nad ledovcem.
//
// Nízký průlet nad firnem je v plachtění zážitek sám o sobě, jenže na hladké
// bílé ploše není vidět rychlost. Vír sněhu za křídlem ji vrátí zpátky:
// čím rychleji letíš a čím níž jsi, tím je oblak hustší.
//
// Spouští se jen nad TRVALÝM sněhem a ledem (třída 70 z ESA WorldCover) nebo
// vysoko nad hranicí věčného sněhu — nad loukou by to byl prach, ne sníh.
import * as THREE from 'three'

const MAX = 220
const AGL_TRIGGER = 26   // m nad povrchem — musí to být opravdu těsně

export class SnowSpray {
  constructor(scene) {
    this.pos = new Float32Array(MAX * 3)
    this.vel = new Float32Array(MAX * 3)
    this.life = new Float32Array(MAX)   // zbývá sekund
    this.age = new Float32Array(MAX)    // 0–1 pro shader
    this.total = new Float32Array(MAX)
    this.next = 0
    this._emit = 0

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    geo.setAttribute('aAge', new THREE.BufferAttribute(this.age, 1))
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7)

    this.points = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: {
        uScale: { value: 380 },
        uMap: { value: this._flake() },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute float aAge;
        uniform float uScale;
        varying float vAge;
        void main() {
          vAge = aAge;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // vír se rozfoukává — starší částice je větší a slabší
          gl_PointSize = (4.0 + 10.0 * aAge) * uScale / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        varying float vAge;
        void main() {
          if (vAge >= 1.0) discard;
          float a = texture2D(uMap, gl_PointCoord).a;
          // náběh je okamžitý, dojezd pozvolný (sníh se snáší, nemizí)
          gl_FragColor = vec4(vec3(1.0, 1.0, 1.0), a * 0.34 * pow(1.0 - vAge, 1.6));
        }`,
    }))
    this.points.frustumCulled = false
    scene.add(this.points)

    // všechny částice startují „mrtvé"
    for (let i = 0; i < MAX; i++) this.age[i] = 1
  }

  _flake() {
    const c = document.createElement('canvas')
    c.width = c.height = 32
    const ctx = c.getContext('2d')
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16)
    g.addColorStop(0, 'rgba(255,255,255,0.95)')
    g.addColorStop(0.45, 'rgba(255,255,255,0.35)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 32, 32)
    return new THREE.CanvasTexture(c)
  }

  /** Je pod tímhle místem sníh nebo led? */
  _onSnow(terrain, x, z, ground) {
    if (terrain.coverAt(x, z) === 70) return true
    return ground > 3050 // nad hranicí věčného sněhu i tam, kde data mlčí
  }

  update(dt, glider, terrain, viewHeight) {
    if (viewHeight) this.points.material.uniforms.uScale.value = viewHeight * 0.5
    const p = this.pos, v = this.vel

    // 1) posun a stárnutí toho, co už letí
    let alive = false
    for (let i = 0; i < MAX; i++) {
      if (this.age[i] >= 1) continue
      alive = true
      this.life[i] -= dt
      this.age[i] = 1 - Math.max(0, this.life[i]) / this.total[i]
      const k = i * 3
      v[k + 1] -= 2.4 * dt              // sníh je lehký, ale padá
      const drag = Math.max(0, 1 - 1.7 * dt)
      v[k] *= drag; v[k + 1] *= drag; v[k + 2] *= drag
      p[k] += v[k] * dt
      p[k + 1] += v[k + 1] * dt
      p[k + 2] += v[k + 2] * dt
    }

    // 2) sype se jen při rychlém průletu těsně nad sněhem
    const g = glider
    const ground = terrain.heightAt(g.pos.x, g.pos.z)
    const agl = g.pos.y - ground
    const active = !g.crashed && agl < AGL_TRIGGER && agl > -5 && g.v > 22 &&
      this._onSnow(terrain, g.pos.x, g.pos.z, ground)

    if (active) {
      // blíž k zemi a rychleji = hustší oblak
      const rate = 115 * (1 - agl / AGL_TRIGGER) * Math.min(1, (g.v - 22) / 20)
      this._emit += rate * dt
      const sh = Math.sin(g.heading), ch = Math.cos(g.heading)
      while (this._emit >= 1) {
        this._emit -= 1
        const i = this.next
        this.next = (this.next + 1) % MAX
        const k = i * 3
        // vzniká pod křídlem, tedy kousek za kluzákem a rozhozeně do stran
        const side = (Math.random() - 0.5) * 16
        const back = 4 + Math.random() * 14
        p[k] = g.pos.x - sh * back + ch * side
        p[k + 1] = ground + 0.5 + Math.random() * 2.5
        p[k + 2] = g.pos.z + ch * back + sh * side
        // vír: kus setrvačnosti dopředu, zbytek nahoru a do stran
        v[k] = sh * g.v * 0.16 + (Math.random() - 0.5) * 7
        v[k + 1] = 2.5 + Math.random() * 5.5
        v[k + 2] = -ch * g.v * 0.16 + (Math.random() - 0.5) * 7
        this.total[i] = 1.1 + Math.random() * 1.1
        this.life[i] = this.total[i]
        this.age[i] = 0
        alive = true
      }
    } else {
      this._emit = 0
    }

    this.points.visible = alive
    if (alive) {
      this.points.geometry.attributes.position.needsUpdate = true
      this.points.geometry.attributes.aAge.needsUpdate = true
    }
  }
}
