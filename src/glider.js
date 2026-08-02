// glider.js — fyzika a model větroně.
// Zjednodušená, ale poctivá plachtařská fyzika:
//  - rychlostní polára: opadání roste kvadraticky od rychlosti minimálního opadání
//  - pitch input řídí CÍLOVOU rychlost; změna rychlosti si bere/dává výšku (výměna energie)
//  - zatáčení náklonem: dψ/dt = g·tan(φ)/v, v náklonu roste opadání (1/cos φ)^1.5
//  - přetažení pod ~60 km/h: čumák padá, chvilkově nejde řídit
//  - vítr snáší kluzák (poloha = vzduchová rychlost + vítr)
import * as THREE from 'three'

const G = 9.81
export const V_MIN_SINK = 23   // m/s (~83 km/h) rychlost minimálního opadání
export const V_STALL = 16.5    // m/s (~59 km/h)
export const V_MAX = 58        // m/s (~209 km/h)
const SINK_MIN = 0.58          // m/s opadání při V_MIN_SINK (výkonný větroň, L/D ~42)

export function polarSink(v) {
  const dv = v - V_MIN_SINK
  return SINK_MIN + (dv > 0 ? 0.0042 : 0.010) * dv * dv
}

export class Glider {
  constructor(scene) {
    this.pos = new THREE.Vector3()
    this.heading = 0        // rad, 0 = sever (−z), kladně po směru hodin
    this.bank = 0           // rad, kladně doprava
    this.theta = 0          // letová poloha (podélný sklon), + = nos dolů
    this.v = 28             // vzdušná rychlost m/s
    this.vario = 0          // aktuální vertikální rychlost m/s
    this.stalled = 0        // >0 = zbývající čas přetažení
    this.crashed = false

    this._buildModel(scene)
  }

  reset(pos, heading) {
    this.pos.copy(pos)
    this.heading = heading
    this.bank = 0
    this.theta = 0
    this.v = 28
    this.vario = 0
    this.stalled = 0
    this._stallSink = 0
    this.crashed = false
    if (this.model) {
      this.model.position.copy(pos)
      this.model.rotation.set(0, 0, 0)
      this.model.rotateY(-heading)
    }
  }

  /** @param input {pitch,roll} -1..1; lift = svislá rychlost vzduchu; wind = vektor větru
   *
   * Podélná dynamika se SETRVAČNOSTÍ:
   *  - stav `theta` (podélný sklon) se k požadavku blíží omezenou úhlovou
   *    rychlostí — letadlo nikdy "necvakne" do nové polohy
   *  - účinnost kormidel roste s dynamickým tlakem (~v²): pod pádovkou jsou
   *    kormidla měkká, kontrola se vrací až s rychlostí
   *  - rychlost se k rovnovážné pro daný sklon blíží pomalu (nabírání trvá)
   *  - přetažení: nos padá SÁM, řízení skoro nefunguje, zotavení = až je
   *    rychlost zpět a odezní (žádné skákání nahoru-dolů jako hračka)
   */
  update(dt, input, lift, wind, terrain) {
    if (this.crashed) return

    // účinnost kormidel podle rychlosti (dynamický tlak)
    const eff = Math.min(1, (this.v / 24) ** 2)

    // náklon: pomalejší při malé rychlosti, v přetažení skoro neřídí
    const bankTarget = input.roll * 0.96 * (this.stalled > 0 ? 0.25 : 1)
    this.bank += (bankTarget - this.bank) * Math.min(1, dt * (0.7 + 2.6 * eff))

    // požadovaný podélný sklon (+ = nos dolů → rychleji)
    let thetaTarget = input.pitch * 0.40
    if (this.stalled > 0) {
      this.stalled -= dt
      thetaTarget = 0.5 // nos padá sám, dokud se neobnoví proudění
      this.bank += Math.sin(performance.now() * 0.006) * 0.22 * dt // buffet
      if (this.v > V_STALL + 3 && this.stalled > 0.6) this.stalled = 0.6 // rychlost zpět → dozotavení
    } else if (this.v < V_STALL) {
      this.stalled = 2.4
    }

    // setrvačnost v klopení: omezená úhlová rychlost, měkká kormidla pomalu
    const maxRate = 0.85 * (0.3 + 0.7 * eff) // rad/s
    let dTh = (thetaTarget - this.theta) * Math.min(1, dt * 2.0)
    dTh = Math.max(-maxRate * dt, Math.min(maxRate * dt, dTh))
    this.theta += dTh

    // rychlost: pomalu k rovnovážné pro daný sklon; podélné zrychlení
    // omezeno na ~1/3 g (větroň není auto — nabírání/vybíjení trvá)
    const vEq = Math.max(9, Math.min(V_MAX, 27 + (this.theta / 0.40) * 17))
    const accel = Math.max(-3.2, Math.min(3.2, (vEq - this.v) * 0.45))
    const dv = accel * dt
    this.v += dv
    const zoom = -(this.v * dv) / G // dh = −v·dv/g (výměna energie)

    // zatáčka
    if (this.v > 4) this.heading += G * Math.tan(this.bank) / this.v * dt

    // opadání (v náklonu horší) + prostředí; propad z přetažení nabíhá
    // plynule (odtržení proudění není skokové) — žádné cuknutí
    const sink = polarSink(this.v) * Math.pow(1 / Math.max(0.35, Math.cos(this.bank)), 1.5)
    const stallTarget = this.stalled > 0 ? -2.8 : 0
    this._stallSink += (stallTarget - this._stallSink) * Math.min(1, dt * 2.2)
    const wAir = lift - sink + this._stallSink
    this.vario = wAir

    // pohyb: vzdušný vektor + vítr
    const sh = Math.sin(this.heading), ch = Math.cos(this.heading)
    this.pos.x += (sh * this.v + wind.x) * dt
    this.pos.z += (-ch * this.v + wind.z) * dt
    this.pos.y += wAir * dt + zoom

    // kolize s terénem
    const ground = terrain.heightAt(this.pos.x, this.pos.z)
    if (this.pos.y < ground + 1.2) {
      this.pos.y = ground + 1.2
      this.crashed = true
    }

    // vizuální model = skutečná letová poloha
    this.model.position.copy(this.pos)
    this.model.rotation.set(0, 0, 0)
    this.model.rotateY(-this.heading)
    this.model.rotateX(this.theta * 1.15 + (this.stalled > 0 ? 0.08 * Math.sin(performance.now() * 0.008) : 0))
    this.model.rotateZ(-this.bank)
  }

  _buildModel(scene) {
    const g = new THREE.Group()
    const white = new THREE.MeshLambertMaterial({ color: 0xf2f4f6 })
    const red = new THREE.MeshLambertMaterial({ color: 0xd03a2c })

    // trup: štíhlý, kapkovitý
    const fus = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 6.4, 6, 10), white)
    fus.rotation.x = Math.PI / 2
    g.add(fus)
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.44, 10, 8), red)
    nose.position.z = -3.6
    nose.scale.z = 1.6
    g.add(nose)
    // kabina
    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(0.4, 10, 8),
      new THREE.MeshLambertMaterial({ color: 0x39485e }),
    )
    canopy.position.set(0, 0.32, -2.1)
    canopy.scale.set(0.8, 0.62, 1.7)
    g.add(canopy)
    // křídla: rozpětí 15 m, mírné vzepětí, červené konce
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.13, 1.05), white)
      wing.position.set(side * 3.75, 0.18 + 0.12, -1.4)
      wing.rotation.z = side * 0.055
      g.add(wing)
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 0.8), red)
      tip.position.set(side * 7.35, 0.18 + side * 0 + 0.32, -1.45)
      tip.rotation.z = side * 0.055
      g.add(tip)
    }
    // ocasní T-plochy
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.5, 0.9), white)
    fin.position.set(0, 0.8, 3.2)
    g.add(fin)
    const stab = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.09, 0.7), red)
    stab.position.set(0, 1.5, 3.25)
    g.add(stab)

    this.model = g
    scene.add(g)

    // měkký stín na terénu — zásadní pro odhad výšky nad zemí
    const shadowTex = (() => {
      const c = document.createElement('canvas')
      c.width = c.height = 64
      const ctx = c.getContext('2d')
      const grad = ctx.createRadialGradient(32, 32, 4, 32, 32, 30)
      grad.addColorStop(0, 'rgba(0,0,0,0.42)')
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, 64, 64)
      const t = new THREE.CanvasTexture(c)
      return t
    })()
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 16),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
    )
    this.shadow.rotation.x = -Math.PI / 2
    scene.add(this.shadow)
  }

  /** Vlečky z konců křídel — viditelné při rychlém letu / utažené zatáčce. */
  initTrails(scene) {
    this.trails = []
    for (const side of [-1, 1]) {
      const N = 50
      const pos = new Float32Array(N * 3)
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
      }))
      line.frustumCulled = false
      scene.add(line)
      this.trails.push({ line, pts: [], side, tip: new THREE.Vector3() })
    }
  }

  updateTrails() {
    if (!this.trails) return
    const show = this.v > 36 || Math.abs(this.bank) > 0.72
    for (const tr of this.trails) {
      tr.tip.set(tr.side * 7.35, 0.3, -1.45)
      this.model.localToWorld(tr.tip)
      tr.pts.push(tr.tip.clone())
      if (tr.pts.length > 50) tr.pts.shift()
      const arr = tr.line.geometry.attributes.position.array
      for (let i = 0; i < 50; i++) {
        const p = tr.pts[Math.min(i, tr.pts.length - 1)] || tr.tip
        arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z
      }
      tr.line.geometry.attributes.position.needsUpdate = true
      const target = show ? 0.42 : 0
      tr.line.material.opacity += (target - tr.line.material.opacity) * 0.12
    }
  }

  /** Stín: na terén pod kluzákem, slábne a roste s výškou. */
  updateShadow(terrain) {
    const gy = terrain.heightAt(this.pos.x, this.pos.z)
    const agl = Math.max(0, this.pos.y - gy)
    this.shadow.position.set(this.pos.x, gy + 1.5, this.pos.z)
    const k = Math.max(0.25, 1 - agl / 900)
    const sc = 1 + agl / 90
    this.shadow.scale.set(sc, sc, 1)
    this.shadow.material.opacity = k
    this.shadow.rotation.z = -this.heading
  }
}
