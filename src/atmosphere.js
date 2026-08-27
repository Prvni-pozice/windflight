// atmosphere.js — nálada dne nad rámec světla a mraků termiky:
//  • ranní inverze: moře mlhy v údolích, které dopoledne leží pod tratí
//  • cirry podle skutečné vysoké oblačnosti (Open-Meteo cloud_cover_high)
//  • kondenzační pás dopravního letadla v hladině nad tratí
//  • dešťové clony pod tmavými mraky, když v Chamonix opravdu prší
//  • sněžné vlajky z nejvyšších hřebenů, když nahoře fičí
//  • sluneční záblesk (glare) s ručním zákrytem terénem
// Všechno jen vizuální — fyzika letu ani termika se nemění.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { cloudMaterial } from './lift.js'

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Dlaždicovatelný vícefrekvenční šum (pro mlhu) jako textura. */
function fbmTexture(size = 256, seed = 7) {
  const rng = mulberry32(seed)
  const G = 32
  const grid = new Float32Array(G * G)
  for (let i = 0; i < G * G; i++) grid[i] = rng()
  const sample = (x, y, scale) => {
    const fx = ((x * scale) % G + G) % G
    const fy = ((y * scale) % G + G) % G
    const x0 = fx | 0, y0 = fy | 0
    const x1 = (x0 + 1) % G, y1 = (y0 + 1) % G
    const tx = fx - x0, ty = fy - y0
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty)
    return (grid[y0 * G + x0] * (1 - sx) + grid[y0 * G + x1] * sx) * (1 - sy) +
      (grid[y1 * G + x0] * (1 - sx) + grid[y1 * G + x1] * sx) * sy
  }
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  const img = ctx.createImageData(size, size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size
      const n = sample(u * G, v * G, 1) * 0.5 + sample(u * G, v * G, 2.7) * 0.28 +
        sample(u * G, v * G, 6.1) * 0.14 + sample(u * G, v * G, 13.7) * 0.08
      const val = Math.max(0, Math.min(255, n * 255))
      const i = (y * size + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = val
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  return tex
}

export class Atmosphere {
  constructor(scene, terrain, weather, cond, sun, sunDir) {
    this.scene = scene
    this.terrain = terrain
    this.weather = weather
    this.cond = cond
    this.sun = sun
    this.sunDir = sunDir
    this.time = 0
    this.group = new THREE.Group()
    const rng = mulberry32(20260823)
    // zlatá hodinka — stejný vzorec jako světlo v main.js
    this.golden = Math.max(0, Math.min(1, 1 - sun.elevDeg / 22))

    this._buildInversion(rng)
    this._buildCirrus(rng)
    this._buildContrail(rng)
    this._buildRain(rng)
    this._buildSnowBanners(rng)
    this._buildGlare()
    this._buildRainbow()
    scene.add(this.group)
  }

  // ── ranní inverze: moře mlhy v údolí ──
  /** Síla 0–1: jen dopoledne, nízké slunce, slabý vítr. `?inverze=0.8` přebije. */
  _inversionStrength() {
    if (typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search).get('inverze')
      if (q != null) return Math.max(0, Math.min(1, parseFloat(q) || 0))
    }
    if (this.sun.azimuthDeg > 195) return 0     // odpoledne je dávno pryč
    if (this.weather.windSpeed > 6.5) return 0  // vítr moře mlhy rozfouká
    return Math.max(0, Math.min(1, (26 - this.sun.elevDeg) / 20))
  }

  _buildInversion() {
    const strength = this._inversionStrength()
    this.inversion = null
    if (strength < 0.05) return
    const t = this.terrain
    const topAlt = 1400 + 90 * strength // hladina moře mlhy (Chamonix ~1030 m)

    const geo = new THREE.PlaneGeometry(t.sizeX * 2, t.sizeZ * 2, 110, 110)
    geo.rotateX(-Math.PI / 2)
    geo.translate(t.sizeX / 2, 0, t.sizeZ / 2)
    // alfa vrcholu: plná v hlubokém údolí, mizí tam, kde terén vystupuje
    // nad hladinu (pobřeží mlhy), a u okraje plochy (ať není vidět hrana)
    const pos = geo.attributes.position
    const alpha = new Float32Array(pos.count)
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i)
      const h = t.heightAt(x, z)
      let a = Math.max(0, Math.min(1, (topAlt - 60 - h) / 180))
      const ex = Math.max(Math.abs(x - t.sizeX / 2) / t.sizeX, Math.abs(z - t.sizeZ / 2) / t.sizeZ)
      a *= 1 - Math.max(0, Math.min(1, (ex - 0.72) / 0.26))
      alpha[i] = a
    }
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1))

    const makeMat = (scale, off, mul) => new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTex: { value: fbmTexture(256, 11) },
        uTime: { value: 0 },
        uWind: { value: new THREE.Vector2(this.cond.windVec.x, this.cond.windVec.z) },
        uStrength: { value: strength * mul },
        uScale: { value: scale },
        uOff: { value: off },
        uGolden: { value: this.golden },
      },
      vertexShader: /* glsl */`
        attribute float aAlpha;
        varying float vAlpha;
        varying vec2 vUv;
        void main() {
          vAlpha = aAlpha;
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uTex;
        uniform float uTime;
        uniform vec2 uWind;
        uniform float uStrength;
        uniform float uScale;
        uniform float uOff;
        uniform float uGolden;
        varying float vAlpha;
        varying vec2 vUv;
        void main() {
          vec2 drift = uWind * uTime * 0.000012;
          float n1 = texture2D(uTex, vUv * uScale + drift + uOff).r;
          float n2 = texture2D(uTex, vUv * uScale * 3.1 - drift * 1.6 + uOff + 0.37).r;
          float billow = n1 * 0.68 + n2 * 0.32;
          float a = vAlpha * uStrength * clamp(0.1 + 1.15 * smoothstep(0.28, 0.62, billow), 0.0, 1.0);
          vec3 col = mix(vec3(0.84, 0.87, 0.91), vec3(1.0, 0.99, 0.965), billow);
          col = mix(col, col * vec3(1.06, 0.97, 0.86), uGolden * 0.5); // ranní nádech
          // stejná správa barev jako obloha/mraky (viz poznámka v main.js)
          gl_FragColor = vec4(pow(col, vec3(2.2)) * 1.4, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    })

    // dvě hladiny nad sebou = mlha má tloušťku, ne jen víko
    const upper = new THREE.Mesh(geo, makeMat(7.0, 0.0, 1.0))
    upper.position.y = topAlt
    upper.renderOrder = 2
    const lower = new THREE.Mesh(geo, makeMat(11.0, 0.53, 0.7))
    lower.position.y = topAlt - 75
    lower.renderOrder = 2
    this.inversion = [upper, lower]
    this.group.add(upper, lower)
  }

  // ── cirry podle skutečné vysoké oblačnosti ──
  _buildCirrus(rng) {
    const density = this.weather.cloudHigh ?? 0
    if (density < 0.04) return
    // pruhy s háčky (cirrus uncinus) — kreslené tahy, ne pravítkové čáry
    const c = document.createElement('canvas')
    c.width = 512; c.height = 128
    const ctx = c.getContext('2d')
    for (let k = 0; k < 48; k++) {
      const y = rng() * 128
      const x = rng() * 420 - 40
      const len = 90 + rng() * 190
      ctx.strokeStyle = `rgba(255,255,255,${0.06 + rng() * 0.12})`
      ctx.lineWidth = 1 + rng() * 3
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.quadraticCurveTo(x + len * 0.5, y - 4 - rng() * 9, x + len, y + rng() * 5)
      ctx.stroke()
      if (rng() < 0.35) { // háček na konci vlákna
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.quadraticCurveTo(x - 9, y + 4, x - 13, y + 11 + rng() * 8)
        ctx.stroke()
      }
    }
    const tex = new THREE.CanvasTexture(c)
    // DoubleSide je nutný: rovina leží normálou vzhůru a hráč je VŽDY pod ní
    // — s FrontSide se cullovala a cirry nebyly vidět vůbec
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      opacity: 0.3 + 0.4 * density,
    })
    // orientace zhruba po větru — cirry se táhnou ve směru výškového proudění
    const windAng = Math.atan2(this.cond.windVec.x, -this.cond.windVec.z)
    const n = 3 + Math.round(density * 5)
    for (let k = 0; k < n; k++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(26000, 7000), mat)
      m.rotation.x = -Math.PI / 2
      m.rotation.z = windAng + (rng() - 0.5) * 1.0
      m.position.set(rng() * 34000, 7200 + rng() * 1400, rng() * 30000)
      m.renderOrder = 1
      this.group.add(m)
    }
  }

  // ── kondenzační pás: dopravní letadlo v hladině nad tratí ──
  /**
   * Nad Chamonix je jedna z nejfrekventovanějších leteckých cest v Evropě,
   * takže bílá čára pomalu rostoucí přes celou oblohu je tam skoro pořád.
   * Herně je to měřítko: proti pásu je vidět, jak pomalu se svět hýbe.
   *
   * Stuha se kreslí celá dopředu a odkrývá ji `uProg` — takhle roste jen
   * jedno číslo za snímek a nemusí se přepisovat geometrie. Stáří pruhu
   * (`uProg − t`) mu zároveň řídí šířku (pás se rozplývá) a průhlednost.
   */
  _buildContrail(rng) {
    this.contrail = null
    const ALT = 10600 + rng() * 900
    const t = this.terrain
    // dráha vede přes střed mapy, kolmo si ji hráč nikdy nepostaví
    const ang = rng() * Math.PI * 2
    const dir = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang))
    const mid = new THREE.Vector3(t.sizeX * 0.5, ALT, t.sizeZ * 0.5)
    const half = 60000
    const perp = new THREE.Vector3(-dir.z, 0, dir.x)
    // odsazení od středu, ať pás nevede vždycky přesně nad hlavou
    mid.addScaledVector(perp, (rng() - 0.5) * 26000)

    const N = 140
    const pos = new Float32Array((N + 1) * 2 * 3)
    const aT = new Float32Array((N + 1) * 2)
    const aSide = new Float32Array((N + 1) * 2)
    const idx = []
    for (let i = 0; i <= N; i++) {
      const f = i / N
      const p = mid.clone().addScaledVector(dir, (f * 2 - 1) * half)
      for (let s = 0; s < 2; s++) {
        const k = (i * 2 + s)
        pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z
        aT[k] = f
        aSide[k] = s ? 1 : -1
      }
      if (i < N) {
        const a = i * 2
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1))
    geo.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1))
    geo.setIndex(idx)
    geo.computeBoundingSphere()

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uProg: { value: 0 },
        uPerp: { value: perp.clone() },
        uOpacity: { value: 0.42 + 0.34 * (this.weather.cloudHigh ?? 0) },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        attribute float aT;
        attribute float aSide;
        uniform float uProg;
        uniform vec3 uPerp;
        varying float vT;
        varying float vSide;
        varying float vAge;
        void main() {
          vT = aT;
          vSide = aSide;
          vAge = clamp(uProg - aT, 0.0, 1.0);
          // čerstvý pás je tenká nitka, starý se rozfoukne do široka —
          // a ne rovnoměrně, takže se cestou nafukuje do nepravidelných vřeten
          float lump = 0.72 + 0.42 * sin(aT * 47.0) * sin(aT * 13.0 + 2.1);
          float w = 55.0 + 900.0 * pow(vAge, 0.7) * lump;
          vec3 p = position + uPerp * aSide * w;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform float uProg;
        uniform float uOpacity;
        varying float vT;
        varying float vSide;
        varying float vAge;
        void main() {
          if (vT > uProg) discard;               // před letadlem ještě nic není
          float across = 1.0 - vSide * vSide;    // měkké okraje stuhy
          // rozplývání: nejdřív skoro nemizí, na konci života rychle
          float life = 1.0 - smoothstep(0.35, 1.0, vAge);
          // roztrhané kusy, jak pás cestou nestejnoměrně vysychá — čerstvý
          // konec je celistvý, teprve stářím se do něj dělají mezery
          float ragged = 1.0 - vAge * (0.55 + 0.45 * sin(vT * 190.0) * sin(vT * 61.0 + 1.7));
          float a = uOpacity * across * life * ragged;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vec3(1.0), a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = 2
    this.group.add(mesh)

    // samotné letadlo: nepatrný bod v čele pásu (na 10 km ho jinak nevidíš)
    const c = document.createElement('canvas')
    c.width = c.height = 16
    const cx = c.getContext('2d')
    const g = cx.createRadialGradient(8, 8, 0, 8, 8, 8)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    cx.fillStyle = g
    cx.fillRect(0, 0, 16, 16)
    const plane = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false,
      opacity: 0.9,
    }))
    plane.scale.set(320, 320, 1)
    this.group.add(plane)

    // přelet celé oblohy trvá pár minut — spěchat nemá kam
    this.contrail = { mesh, mat, plane, mid, dir, half, speed: 1 / 260, pause: 0 }
  }

  _updateContrail(dt) {
    const c = this.contrail
    if (!c) return
    if (c.pause > 0) { c.pause -= dt; return }
    const p = c.mat.uniforms.uProg
    p.value += c.speed * dt
    const head = c.mid.clone().addScaledVector(c.dir, (Math.min(1, p.value) * 2 - 1) * c.half)
    c.plane.position.copy(head)
    c.plane.material.opacity = p.value < 1 ? 0.9 : 0
    if (p.value > 2.0) { // pás se dorozplynul → za chvíli poletí další
      p.value = 0
      c.pause = 40 + 40 * (1 - (this.weather.cloudHigh ?? 0))
    }
  }

  // ── dešťové clony: šedé závěsy od základny mraků k zemi ──
  _buildRain(rng) {
    this.rainCells = []
    const precip = this.weather.precip ?? 0
    if (precip < 0.05) return
    const t = this.terrain
    const cells = Math.min(4, 1 + Math.floor(precip))

    // textura: svislé šmouhy, nahoře hustší (u základny mraku)
    const c = document.createElement('canvas')
    c.width = 128; c.height = 256
    const ctx = c.getContext('2d')
    const grad = ctx.createLinearGradient(0, 0, 0, 256)
    grad.addColorStop(0, 'rgba(255,255,255,0.5)')
    grad.addColorStop(0.25, 'rgba(255,255,255,0.38)')
    grad.addColorStop(1, 'rgba(255,255,255,0.16)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, 128, 256)
    ctx.globalCompositeOperation = 'destination-out'
    for (let k = 0; k < 46; k++) { // prosvítající pruhy = provazce deště
      const x = rng() * 128
      ctx.fillStyle = `rgba(0,0,0,${0.12 + rng() * 0.3})`
      ctx.fillRect(x, 0, 1 + rng() * 4, 256)
    }
    const tex = new THREE.CanvasTexture(c)
    tex.wrapS = THREE.RepeatWrapping
    const mat = new THREE.MeshBasicMaterial({
      map: tex, color: 0x99a3b0, transparent: true,
      depthWrite: false, side: THREE.DoubleSide, fog: true,
    })
    const darkCloud = cloudMaterial(this.sunDir, {
      base: new THREE.Color(0.24, 0.26, 0.31),
      top: new THREE.Color(0.48, 0.50, 0.54),
      boost: 1.2,
    })

    const wind = this.cond.windVec
    const wl = Math.max(0.001, wind.length())
    for (let k = 0; k < cells; k++) {
      // clona stojí nad údolím nebo nízkým svahem, ne na hřebeni
      let x = 0, z = 0, h = 9e9
      for (let tries = 0; tries < 40 && h > 2400; tries++) {
        x = t.sizeX * (0.15 + rng() * 0.7)
        z = t.sizeZ * (0.15 + rng() * 0.7)
        h = t.heightAt(x, z)
      }
      const top = Math.max(h + 900, this.cond.cloudBase - 150)
      const height = top - h
      const grp = new THREE.Group()
      grp.position.set(x, top, z)
      // závěs se s výškou opírá do větru — kapky cestou dolů snáší vítr
      const tilt = Math.atan(wl * 0.045)
      grp.rotateOnAxis(_axis.set(wind.z / wl, 0, -wind.x / wl).normalize(), tilt)
      const r = 550 + rng() * 250
      const curtain = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r * 0.8, height, 20, 1, true), mat)
      curtain.position.y = -height / 2
      curtain.renderOrder = 3
      grp.add(curtain)
      // tmavý mrak, ze kterého clona visí
      const parts = []
      const lumps = 4 + (rng() * 3 | 0)
      for (let p = 0; p < lumps; p++) {
        const rr = 260 + rng() * 200
        const g = new THREE.SphereGeometry(rr, 10, 8)
        g.scale(1.1 + rng() * 0.5, 0.55 + rng() * 0.25, 1.1 + rng() * 0.5)
        g.translate((rng() - 0.5) * r * 1.9, 120 + rng() * 140, (rng() - 0.5) * r * 1.9)
        parts.push(g)
      }
      const cloud = new THREE.Mesh(mergeGeometries(parts), darkCloud)
      grp.add(cloud)
      this.group.add(grp)
      this.rainCells.push(grp)
    }
  }

  // ── sněžné vlajky: z nejvyšších hřebenů fičí sníh po větru ──
  _findPeaks(minH = 3750, maxPeaks = 7) {
    const t = this.terrain
    const step = 5
    const cand = []
    for (let gz = step * 2; gz < t.gh - step * 2; gz += step) {
      for (let gx = step * 2; gx < t.gw - step * 2; gx += step) {
        const h = t.heights[gz * t.gw + gx]
        if (h < minH) continue
        let isMax = true
        for (let dz = -2; dz <= 2; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (!dx && !dz) continue
            if (t.heights[(gz + dz * step) * t.gw + gx + dx * step] > h) { isMax = false; break }
          }
          if (!isMax) break
        }
        if (isMax) cand.push({ x: gx / (t.gw - 1) * t.sizeX, z: gz / (t.gh - 1) * t.sizeZ, h })
      }
    }
    cand.sort((a, b) => b.h - a.h)
    const peaks = []
    for (const p of cand) {
      if (peaks.length >= maxPeaks) break
      if (peaks.some(q => Math.hypot(q.x - p.x, q.z - p.z) < 2200)) continue
      peaks.push(p)
    }
    return peaks
  }

  _buildSnowBanners(rng) {
    this.banners = null
    if ((this.weather.windSpeed ?? 0) < 5) return // vlajka chce vítr
    const peaks = this._findPeaks()
    if (!peaks.length) return
    const PER = 48
    const n = peaks.length * PER
    const origins = new Float32Array(n * 3)
    const seeds = new Float32Array(n)
    let i = 0
    for (const p of peaks) {
      for (let k = 0; k < PER; k++, i++) {
        origins[i * 3] = p.x + (rng() - 0.5) * 120
        origins[i * 3 + 1] = p.h + 6 + rng() * 24
        origins[i * 3 + 2] = p.z + (rng() - 0.5) * 120
        seeds[i] = rng()
      }
    }
    const geo = new THREE.BufferGeometry()
    // position je povinný atribut; skutečnou polohu počítá shader z aOrigin
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
    geo.setAttribute('aOrigin', new THREE.BufferAttribute(origins, 3))
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(
      this.terrain.sizeX / 2, 4000, this.terrain.sizeZ / 2), 25000)

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uWind: { value: this.cond.windVec },
      },
      vertexShader: /* glsl */`
        attribute vec3 aOrigin;
        attribute float aSeed;
        uniform float uTime;
        uniform vec3 uWind;
        varying float vA;
        void main() {
          float speed = 0.06 + 0.05 * fract(aSeed * 7.31);
          float f = fract(uTime * speed + aSeed);
          float wl = max(length(uWind), 0.001);
          vec3 dir = uWind / wl;
          vec3 perp = normalize(vec3(-dir.z, 0.0, dir.x));
          float L = 90.0 * wl; // délka vlajky roste s větrem
          vec3 p = aOrigin
            + dir * (f * L)
            + perp * sin(f * 14.0 + aSeed * 43.0) * (6.0 + f * 55.0)
            + vec3(0.0, 1.0, 0.0) * (f * 40.0 - f * f * 130.0 + sin(f * 9.0 + aSeed * 20.0) * 12.0);
          vA = (1.0 - f) * 0.75;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (16.0 + f * 95.0) * (380.0 / max(1.0, -mv.z));
        }`,
      fragmentShader: /* glsl */`
        varying float vA;
        void main() {
          float a = smoothstep(0.5, 0.12, length(gl_PointCoord - 0.5)) * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4(pow(vec3(0.97, 0.98, 1.0), vec3(2.2)) * 1.5, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    })
    this.banners = new THREE.Points(geo, mat)
    this.banners.renderOrder = 2
    this.group.add(this.banners)
  }

  // ── sluneční glare: přes objektiv šlehne slunce, když není za horou ──
  _buildGlare() {
    const c = document.createElement('canvas')
    c.width = c.height = 256
    const ctx = c.getContext('2d')
    const core = ctx.createRadialGradient(128, 128, 2, 128, 128, 70)
    core.addColorStop(0, 'rgba(255,250,240,0.9)')
    core.addColorStop(0.4, 'rgba(255,240,215,0.28)')
    core.addColorStop(1, 'rgba(255,240,215,0)')
    ctx.fillStyle = core
    ctx.fillRect(0, 0, 256, 256)
    const streak = (sx, sy, alpha) => {
      ctx.save()
      ctx.translate(128, 128)
      ctx.scale(sx, sy)
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 128)
      g.addColorStop(0, `rgba(255,246,228,${alpha})`)
      g.addColorStop(1, 'rgba(255,246,228,0)')
      ctx.fillStyle = g
      ctx.fillRect(-128 / sx, -128 / sy, 256 / sx, 256 / sy)
      ctx.restore()
    }
    streak(1, 0.06, 0.55)  // vodorovný paprsek
    streak(0.05, 0.5, 0.3) // krátký svislý
    const tex = new THREE.CanvasTexture(c)
    const mat = new THREE.SpriteMaterial({
      map: tex, blending: THREE.AdditiveBlending, transparent: true,
      depthTest: false, depthWrite: false, opacity: 0,
    })
    const g = this.golden
    mat.color.setRGB(1, 0.97 - 0.2 * g, 0.9 - 0.4 * g)
    this.glare = new THREE.Sprite(mat)
    this.glare.scale.set(9000, 9000, 1)
    this.glare.renderOrder = 20
    this.scene.add(this.glare)

    // duchové odlesky objektivu: barevné kotoučky na ose slunce—střed obrazu
    const gc = document.createElement('canvas')
    gc.width = gc.height = 64
    const gctx = gc.getContext('2d')
    // plochý disk s měkkým okrajem — rozmlžený gradient se v obloze ztrácel
    const gg = gctx.createRadialGradient(32, 32, 2, 32, 32, 30)
    gg.addColorStop(0, 'rgba(255,255,255,0.5)')
    gg.addColorStop(0.72, 'rgba(255,255,255,0.42)')
    gg.addColorStop(1, 'rgba(255,255,255,0)')
    gctx.fillStyle = gg
    gctx.fillRect(0, 0, 64, 64)
    const gtex = new THREE.CanvasTexture(gc)
    // Barvy jsou ZÁMĚRNĚ bledé. Sytější duchové se přes aditivní míchání
    // otiskli na zasněžený svah jako fialová skvrna — vypadalo to jako chyba
    // vykreslování, ne jako odlesk v objektivu.
    this.ghosts = [
      { f: 0.45, s: 900, color: 0xb9e6da },
      { f: -0.28, s: 620, color: 0xffdcb4 },
      { f: -0.7, s: 1500, color: 0xd2c4f2 },
    ].map(({ f, s, color }) => {
      const m = new THREE.SpriteMaterial({
        map: gtex, blending: THREE.AdditiveBlending, transparent: true,
        depthTest: false, depthWrite: false, opacity: 0, color,
      })
      const spr = new THREE.Sprite(m)
      spr.scale.set(s, s, 1)
      spr.renderOrder = 21
      this.scene.add(spr)
      return { f, spr }
    })
  }

  // ── duha: když prší a slunce je dost nízko, na protisluneční straně ──
  _buildRainbow() {
    this.rainbow = null
    if ((this.weather.precip ?? 0) < 0.05) return
    const elev = Math.max(0, this.sun.elevDeg)
    const vis = Math.max(0, Math.min(1, (40 - elev) / 12)) // nad 40° se duha nevejde nad obzor
    if (vis <= 0) return
    const c = document.createElement('canvas')
    c.width = c.height = 512
    const ctx = c.getContext('2d')
    // per-pixel, ne tahy štětcem: překrývající se oblouky sčítaly alfu
    // a z duhy byl bílý pruh. Pás fialová uvnitř (r 216) → červená vně (r 246).
    const img = ctx.createImageData(512, 512)
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const r = Math.hypot(x - 256, y - 256)
        if (r < 216 || r > 246) continue
        const t = (r - 216) / 30
        const col = new THREE.Color().setHSL((270 * (1 - t)) / 360, 0.95, 0.55)
        const i = (y * 512 + x) * 4
        img.data[i] = col.r * 255
        img.data[i + 1] = col.g * 255
        img.data[i + 2] = col.b * 255
        img.data[i + 3] = 235 * Math.sin(Math.PI * Math.pow(t, 0.72)) // vrchol k červené
      }
    }
    ctx.putImageData(img, 0, 0)
    const tex = new THREE.CanvasTexture(c)
    // plátno je sRGB — bez anotace by se barvy vyplavily do pastelu
    tex.colorSpace = THREE.SRGBColorSpace
    // Normální průhlednost, NE additive: na syté modré obloze aditivní
    // sčítání červenou nikdy nevyrobí (jen přisvětlí do bílo-modra).
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true,
      // depthTest ANO: hory duhu zakrývají, takže z ní kouká jen oblouk
      // nad hřebeny — přesně jak to v údolí vypadá
      depthTest: true, depthWrite: false, opacity: 0.6 * vis,
    })
    this.rainbow = new THREE.Sprite(mat)
    // kruh 42° kolem protislunečního bodu: poloměr = D·tan(42°); textura má
    // střed pásu na 231/256 poloviny plátna → měřítko dorovná poměr
    const D = 30000
    const s = 2 * D * Math.tan(42 * Math.PI / 180) * (256 / 231)
    this.rainbow.scale.set(s, s, 1)
    this.scene.add(this.rainbow)
  }

  /** Je slunce z pohledu kamery schované za terénem? (pochod po heightmapě) */
  _sunBlocked(camPos) {
    const t = this.terrain, s = this.sunDir
    for (let d = 250; d < 45000; d *= 1.35) {
      const x = camPos.x + s.x * d, z = camPos.z + s.z * d
      if (x < 0 || x > t.sizeX || z < 0 || z > t.sizeZ) return false
      const y = camPos.y + s.y * d
      if (y > t.meta.hmax + 80) return false
      if (t.heightAt(x, z) > y) return true
    }
    return false
  }

  /** Animace světa (volat jen když neběží pauza). */
  update(dt) {
    this.time += dt
    if (this.inversion) {
      for (const m of this.inversion) m.material.uniforms.uTime.value = this.time
    }
    if (this.banners) this.banners.material.uniforms.uTime.value = this.time
    this._updateContrail(dt)
    for (const cell of this.rainCells) {
      cell.position.x += this.cond.windVec.x * dt
      cell.position.z += this.cond.windVec.z * dt
    }
  }

  /** Glare sedí na slunci a hasne za horami — volat každý snímek po kameře. */
  updateGlare(camera, dt) {
    if (!this.glare) return
    this.glare.position.copy(camera.position).addScaledVector(this.sunDir, 45000)
    // zákryt stačí přepočítat občas — kamera se mezi snímky skoro nehne
    this._glareT = (this._glareT ?? 9) + dt
    if (this._glareT > 0.12) {
      this._glareT = 0
      // po západu slunce žádný odlesk být nemůže — bez téhle podmínky
      // visely nad soumračným údolím barevné koule z ničeho
      const above = Math.max(0, Math.min(1, (this.sun.elevDeg + 0.5) / 3))
      this._glareTarget = this._sunBlocked(camera.position) ? 0 : (0.42 + this.golden * 0.35) * above
    }
    const o = this.glare.material.opacity
    this.glare.material.opacity = o + ((this._glareTarget ?? 0) - o) * Math.min(1, dt * 3.5)

    // duchové odlesky: zrcadlení polohy slunce přes střed obrazu.
    // NDC hloubka je nelineární — bod z unprojectu proto ukotvit na pevnou
    // vzdálenost od kamery, jinak sprite skončí metr před objektivem.
    if (this.ghosts) {
      _ndc.copy(this.glare.position).project(camera)
      const inView = _ndc.z < 1 && Math.abs(_ndc.x) < 1.25 && Math.abs(_ndc.y) < 1.25
      for (const { f, spr } of this.ghosts) {
        if (!inView) { spr.material.opacity = 0; continue }
        _tmpV.set(_ndc.x * f, _ndc.y * f, 0.5).unproject(camera)
          .sub(camera.position).normalize()
        spr.position.copy(camera.position).addScaledVector(_tmpV, 8000)
        spr.material.opacity = this.glare.material.opacity * 0.3
      }
    }

    // duha stojí na protisluneční straně a jede s kamerou (jako doopravdy)
    if (this.rainbow) {
      this.rainbow.position.copy(camera.position).addScaledVector(this.sunDir, -30000)
    }
  }
}

const _axis = new THREE.Vector3()
const _ndc = new THREE.Vector3()
const _tmpV = new THREE.Vector3()
