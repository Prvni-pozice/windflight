// lift.js — model a VIZUALIZACE proudění: termické komíny na osluněných
// svazích (částicové víry + kumulus + kroužící ptáci), svahové proudění na
// návětrných hřebenech, klesání v závětří. Jádro hry: pilot čte krajinu.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class LiftField {
  /** routePoints: [{x,z}] — trať; podél ní jsou zaručené „domovské" termiky. */
  constructor(scene, terrain, cond, sunDir, routePoints = [], seed = 20260801) {
    this.terrain = terrain
    this.cond = cond          // {thermalStrength, cloudBase, windVec}
    this.sunDir = sunDir
    this.routePoints = routePoints
    this.group = new THREE.Group()
    this.time = 0
    const rng = mulberry32(seed)

    this._placeThermals(rng)
    this._buildThermalViz(rng)
    scene.add(this.group)
  }

  // ── termika: skóruj náhodná místa podle oslunění svahu a výšky ──
  _placeThermals(rng) {
    this.thermals = []
    const t = this.terrain
    const sunAz = Math.atan2(this.sunDir.x, -this.sunDir.z) // azimut KE slunci v osách světa
    const tries = 4000
    const candidates = []
    for (let i = 0; i < tries; i++) {
      const x = 1500 + rng() * (t.sizeX - 3000)
      const z = 1500 + rng() * (t.sizeZ - 3000)
      const h = t.heightAt(x, z)
      if (h < 900 || h > 3100) continue
      const { slope, aspect } = t.slopeAspect(x, z)
      if (slope < 0.08) continue
      // svah kouká ke slunci → dobrý sběrač; aspect je směr po svahu dolů
      const facing = Math.cos(aspect - sunAz)
      const score = facing * Math.min(0.5, slope) * (1 - Math.abs(h - 1900) / 2400)
      if (score > 0.03) candidates.push({ x, z, h, score })
    }
    candidates.sort((a, b) => b.score - a.score)

    const add = (c, strengthBoost = 1) => {
      const s = this.cond.thermalStrength * (0.75 + rng() * 0.5) * strengthBoost
      this.thermals.push({
        x: c.x, z: c.z, ground: c.h,
        r: 240 + rng() * 160,
        strength: s,
        top: Math.min(this.cond.cloudBase, c.h + 1700 + s * 450),
        phase: rng() * Math.PI * 2,
        birds: rng() < 0.45,
      })
    }

    // 1) DOMOVSKÉ termiky podél trati: u každého bodu trati a mezilehu
    //    najdi nejlepšího kandidáta do 1 500 m — trať je tím vždy letitelná,
    //    hráč je jen musí umět najít a využít.
    const anchors = []
    for (let i = 0; i < this.routePoints.length; i++) {
      anchors.push(this.routePoints[i])
      if (i + 1 < this.routePoints.length) {
        const a = this.routePoints[i], b = this.routePoints[i + 1]
        if (Math.hypot(b.x - a.x, b.z - a.z) > 2600) {
          anchors.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 })
        }
      }
    }
    for (const an of anchors) {
      const near = candidates.find(c =>
        Math.hypot(c.x - an.x, c.z - an.z) < 1500 &&
        !this.thermals.some(q => Math.hypot(q.x - c.x, q.z - c.z) < 900))
      if (near) { add(near, 1.15); continue }
      // žádný kandidát (např. bod nad údolím) → syntetická termika na
      // nejbližším svahu směrem k trati
      let best = null, bestD = 1e9
      for (const c of candidates) {
        const d = Math.hypot(c.x - an.x, c.z - an.z)
        if (d < bestD && !this.thermals.some(q => Math.hypot(q.x - c.x, q.z - c.z) < 900)) {
          bestD = d; best = c
        }
      }
      if (best && bestD < 3000) add(best, 1.15)
    }

    // 2) zbytek mapy — volná krajina (ať se dá létat i mimo trať)
    for (const c of candidates) {
      if (this.thermals.length >= 64) break
      if (this.thermals.some(q => Math.hypot(q.x - c.x, q.z - c.z) < 880)) continue
      add(c)
    }
  }

  /** Nejbližší použitelná termika (jádro v mé výšce, strop nade mnou). */
  nearestThermal(pos) {
    const wind = this.cond.windVec
    const wl = Math.max(1, wind.length())
    let best = null, bestD = Infinity
    for (const th of this.thermals) {
      if (th.top < pos.y + 120) continue // už by mě nezvedla
      const drift = Math.max(0, pos.y - th.ground) * 0.11
      const cx = th.x + wind.x * drift / wl
      const cz = th.z + wind.z * drift / wl
      const d = Math.hypot(pos.x - cx, pos.z - cz)
      if (d < bestD) {
        bestD = d
        best = { x: cx, y: Math.min(th.top - 100, Math.max(pos.y, th.ground + 400)), z: cz, d }
      }
    }
    return best
  }

  /** Vertikální rychlost vzduchu v bodě (m/s, + nahoru) */
  liftAt(pos) {
    let w = -0.35 // plošné mírné klesání mezi stoupáky
    const wind = this.cond.windVec

    for (const th of this.thermals) {
      if (pos.y > th.top + 150 || pos.y < th.ground - 50) continue
      // komín se s výškou naklání po větru
      const drift = (pos.y - th.ground) * 0.11
      const cx = th.x + wind.x * drift / Math.max(1, wind.length())
      const cz = th.z + wind.z * drift / Math.max(1, wind.length())
      const d = Math.hypot(pos.x - cx, pos.z - cz)
      if (d > th.r * 2.2) continue
      const core = Math.exp(-(d * d) / (th.r * th.r * 0.55))
      // slábne u vrcholu, sílí kus nad zemí
      const hFrac = (pos.y - th.ground) / (th.top - th.ground)
      const prof = hFrac < 0 ? 0 : hFrac > 1 ? Math.max(0, 1 - (hFrac - 1) * 4) : 0.8 + 0.2 * Math.sin(Math.min(1, hFrac * 1.15) * Math.PI)
      w += th.strength * core * prof
      // věnec slabého klesání okolo komína
      if (d > th.r && d < th.r * 2.2) w -= 0.5 * (1 - Math.abs(d - th.r * 1.6) / (th.r * 0.6)) * prof
    }

    // svahové proudění: vítr do svahu = stoupání podél svahu (do ~400 m AGL)
    const ground = this.terrain.heightAt(pos.x, pos.z)
    const agl = pos.y - ground
    if (agl < 450 && wind.lengthSq() > 0.4) {
      const n = this.terrain.normalAt(pos.x, pos.z, _nrm)
      const horiz = _tmp.set(n.x, 0, n.z)
      const upslope = -(wind.x * horiz.x + wind.z * horiz.z) // vítr PROTI normále = návětrný svah
      const band = Math.max(0, 1 - agl / 450)
      if (upslope > 0) w += Math.min(4, upslope * 0.9) * band
      else w += Math.max(-2, upslope * 0.5) * band // závětří = klesák (zmírněno, ať je hra fér)
    }
    return w
  }

  /** Měkký kulatý sprite (radiální gradient) pro Points. */
  _softSprite(rgb = '255,242,200') {
    const c = document.createElement('canvas')
    c.width = c.height = 32
    const ctx = c.getContext('2d')
    const g = ctx.createRadialGradient(16, 16, 1, 16, 16, 15)
    g.addColorStop(0, `rgba(${rgb},0.9)`)
    g.addColorStop(1, `rgba(${rgb},0)`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 32, 32)
    return new THREE.CanvasTexture(c)
  }

  // ── vizualizace: částicové sloupce + kumulus + ptáci ──
  _buildThermalViz(rng) {
    const P_PER = (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches) ? 14 : 26
    const n = this.thermals.length * P_PER
    this._pPer = P_PER
    this.partBase = new Float32Array(n * 4) // x,z,phase,radiusFrac
    const positions = new Float32Array(n * 3)
    let pi = 0
    for (let ti = 0; ti < this.thermals.length; ti++) {
      const th = this.thermals[ti]
      for (let k = 0; k < P_PER; k++) {
        this.partBase[pi * 4] = th.x
        this.partBase[pi * 4 + 1] = th.z
        this.partBase[pi * 4 + 2] = rng() * Math.PI * 2
        this.partBase[pi * 4 + 3] = 0.25 + rng() * 0.75
        positions[pi * 3 + 1] = th.ground
        pi++
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this.particles = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffffff, size: 30, transparent: true, opacity: 0.6,
      map: this._softSprite('255,242,200'), sizeAttenuation: true, depthWrite: false,
    }))
    this.group.add(this.particles)

    // svahové proudění: proudící částice na návětrných svazích (vidět, kde zvedá)
    this._buildRidgeViz(rng)

    // kumulus nad každou termikou (pár koulí) — ukazuje strop stoupání
    this.clouds = []
    for (const th of this.thermals) {
      const cl = new THREE.Group()
      // jeden sloučený mesh na mrak (draw-cally!): obláčky + tmavší basa
      const parts = []
      const puffs = 3 + (rng() * 3 | 0)
      for (let p = 0; p < puffs; p++) {
        const r = 130 + rng() * 170
        const gpuff = new THREE.SphereGeometry(r, 10, 8)
        gpuff.scale(1, 0.55, 1)
        gpuff.translate((rng() - 0.5) * 420, (rng() - 0.3) * 90, (rng() - 0.5) * 420)
        parts.push(gpuff)
      }
      const gbase = new THREE.CylinderGeometry(300, 300, 30, 12)
      parts.push(gbase)
      const merged = mergeGeometries(parts)
      const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({
        color: 0xffffff, transparent: true, opacity: 0.92,
      }))
      cl.add(mesh)
      cl.userData.cycle = rng()
      const drift = (th.top - th.ground) * 0.11
      const wl = Math.max(1, this.cond.windVec.length())
      cl.position.set(
        th.x + this.cond.windVec.x * drift / wl,
        th.top + 140,
        th.z + this.cond.windVec.z * drift / wl,
      )
      this.group.add(cl)
      this.clouds.push(cl)
    }

    // ptáci: jednoduché "V" kroužící v termice = jistota stoupání
    this.birds = []
    const birdGeo = new THREE.BufferGeometry()
    birdGeo.setAttribute('position', new THREE.Float32BufferAttribute([
      -14, 0, 0, 0, 3, 4, 0, 0, 0, 14, 0, 0, 0, 3, 4,
    ], 3))
    birdGeo.setIndex([0, 1, 2, 2, 1, 3, 1, 4, 3])
    const birdMat = new THREE.MeshBasicMaterial({ color: 0x222222, side: THREE.DoubleSide })
    for (const th of this.thermals) {
      if (!th.birds) continue
      const flock = []
      const count = 2 + (rng() * 2 | 0)
      for (let b = 0; b < count; b++) {
        const m = new THREE.Mesh(birdGeo, birdMat)
        flock.push({ m, off: rng() * Math.PI * 2, alt: 0.35 + rng() * 0.4, r: 60 + rng() * 60 })
        this.group.add(m)
      }
      this.birds.push({ th, flock })
    }
  }

  _buildRidgeViz(rng) {
    this.ridgeSites = []
    const wind = this.cond.windVec
    if (wind.length() < 2) { this.ridge = null; return }
    const t = this.terrain
    for (let gz = 1200; gz < t.sizeZ - 1200 && this.ridgeSites.length < 240; gz += 620) {
      for (let gx = 1200; gx < t.sizeX - 1200 && this.ridgeSites.length < 240; gx += 620) {
        const n = t.normalAt(gx, gz)
        const upslope = -(wind.x * n.x + wind.z * n.z)
        if (upslope < 1.4) continue
        const h = t.heightAt(gx, gz)
        if (h < 1100 || h > 3400) continue
        // směr po svahu nahoru (proti gradientu)
        const len = Math.hypot(n.x, n.z) || 1
        this.ridgeSites.push({
          x: gx + (rng() - 0.5) * 300, z: gz + (rng() - 0.5) * 300,
          dx: -n.x / len, dz: -n.z / len, s: Math.min(3, upslope),
        })
      }
    }
    const P = 3
    const count = this.ridgeSites.length * P
    if (!count) { this.ridge = null; return }
    this._ridgeP = P
    const pos = new Float32Array(count * 3)
    this.ridgePhase = new Float32Array(count)
    for (let i = 0; i < count; i++) this.ridgePhase[i] = rng()
    const geo2 = new THREE.BufferGeometry()
    geo2.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    this.ridge = new THREE.Points(geo2, new THREE.PointsMaterial({
      color: 0xffffff, size: 20, transparent: true, opacity: 0.34,
      map: this._softSprite('214,232,248'), sizeAttenuation: true, depthWrite: false,
    }))
    this.group.add(this.ridge)
  }

  update(dt) {
    this.time += dt
    const pos = this.particles.geometry.attributes.position
    const wind = this.cond.windVec
    const wl = Math.max(1, wind.length())
    let pi = 0
    for (const th of this.thermals) {
      const span = th.top - th.ground
      const rate = th.strength * 0.55 // vizuální rychlost stoupání částic
      for (let k = 0; k < this._pPer; k++, pi++) {
        const phase = this.partBase[pi * 4 + 2]
        const rf = this.partBase[pi * 4 + 3]
        const cyc = ((this.time * rate + phase * 40) % span)
        const y = th.ground + cyc
        const drift = cyc * 0.11
        const ang = phase + this.time * (0.55 + rf * 0.3)
        pos.array[pi * 3] = th.x + wind.x * drift / wl + Math.cos(ang) * th.r * rf * 0.8
        pos.array[pi * 3 + 1] = y
        pos.array[pi * 3 + 2] = th.z + wind.z * drift / wl + Math.sin(ang) * th.r * rf * 0.8
      }
    }
    pos.needsUpdate = true

    // kumuly: pomalý drift po větru, zrod → rozpad (cyklus ~3 min)
    for (let ci = 0; ci < this.clouds.length; ci++) {
      const cl = this.clouds[ci]
      const th = this.thermals[ci]
      cl.userData.cycle = (cl.userData.cycle + dt / 180) % 1
      const cyc = cl.userData.cycle
      const driftBase = (th.top - th.ground) * 0.11
      cl.position.set(
        th.x + wind.x * driftBase / wl + wind.x * cyc * 140,
        th.top + 140 + cyc * 60,
        th.z + wind.z * driftBase / wl + wind.z * cyc * 140,
      )
      const op = Math.sin(Math.PI * Math.min(1, cyc * 1.25)) // rychlý zrod, pomalý rozpad
      cl.traverse(o => { if (o.isMesh) o.material.opacity = 0.92 * (0.35 + 0.65 * op) })
      const sc2 = 0.7 + op * 0.4
      cl.scale.set(sc2, sc2, sc2)
    }

    // svahové částice: kloužou po svahu vzhůru a rozpouštějí se
    if (this.ridge) {
      const rp = this.ridge.geometry.attributes.position
      for (let i = 0; i < this.ridgePhase.length; i++) {
        const site = this.ridgeSites[(i / this._ridgeP) | 0]
        const f = (this.time * 0.12 * site.s + this.ridgePhase[i]) % 1
        const dist = f * 620
        const x = site.x + site.dx * dist
        const z = site.z + site.dz * dist
        rp.array[i * 3] = x
        rp.array[i * 3 + 1] = this.terrain.heightAt(x, z) + 26 + f * 90
        rp.array[i * 3 + 2] = z
      }
      rp.needsUpdate = true
    }

    for (const grp of this.birds) {
      const th = grp.th
      for (const b of grp.flock) {
        const ang = this.time * 0.5 + b.off
        const y = th.ground + (th.top - th.ground) * b.alt + Math.sin(this.time * 0.4 + b.off) * 30
        const drift = (y - th.ground) * 0.11
        b.m.position.set(
          th.x + wind.x * drift / wl + Math.cos(ang) * b.r,
          y,
          th.z + wind.z * drift / wl + Math.sin(ang) * b.r,
        )
        b.m.rotation.y = -ang - Math.PI / 2
        b.m.rotation.z = 0.3
        b.m.scale.y = 0.6 + Math.abs(Math.sin(this.time * 6 + b.off * 3)) * 0.9 // mávání
      }
    }
  }
}

const _nrm = new THREE.Vector3()
const _tmp = new THREE.Vector3()
