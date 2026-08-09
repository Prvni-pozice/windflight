// trees.js — hustý les z billboardů (dva zkřížené kvady na strom, staticky).
// Klasika starých her: zblízka rychlost, z výšky bohatá struktura lesa.
import * as THREE from 'three'

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// místa, kde les nechceme (vesnice) — [lat je řešeno v terénních metrech přes fromLatLon v main? ne — tady natvrdo souřadnice měst ze scenery]
const TOWN_CLEAR = [
  [45.9237, 6.8694, 950], [45.9790, 6.9260, 550], [45.8905, 6.7990, 600], [45.9450, 6.8880, 350],
]

// počty stromů podle nastavené kvality (les je zdaleka nejdražší část scény)
export const FOREST_LEVELS = {
  low: { near: 4500, r: 1000, far: 3500 },
  med: { near: 9000, r: 1500, far: 7000 },
  high: { near: 22000, r: 2300, far: 14000 },
}

export class Forest {
  constructor(scene, terrain, level = 'med') {
    this.terrain = terrain
    this.scene = scene
    const L = FOREST_LEVELS[level] || FOREST_LEVELS.med
    this.NEAR = L.near
    this.CELL = 400
    this.R = L.r
    this.perCell = Math.floor(this.NEAR / ((Math.ceil(this.R / this.CELL) * 2 + 1) ** 2) * 1.35)
    this.towns = TOWN_CLEAR.map(([lat, lon, r]) => ({ ...terrain.fromLatLon(lat, lon), r }))

    const { geo, mat } = buildTreeAssets()
    // blízká HUSTÁ vrstva: instance se přeskládají, když kamera opustí buňku
    this.near = new THREE.InstancedMesh(geo, mat, this.NEAR)
    this.near.frustumCulled = false
    this.near.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    scene.add(this.near)
    this._lastCell = null
    // dálková řídká vrstva (větší siluety, statická) — les je vidět i z výšky
    this.far = buildFarLayer(scene, terrain, this.towns, L.far)
  }

  /** Uvolnit les (přepnutí kvality za běhu). */
  dispose() {
    for (const m of [this.near, this.far]) {
      if (!m) continue
      this.scene.remove(m)
      m.geometry.dispose()
      m.material.map?.dispose()
      m.material.dispose()
    }
    this.near = this.far = null
  }

  update(camX, camZ) {
    const ccx = Math.floor(camX / this.CELL), ccz = Math.floor(camZ / this.CELL)
    if (this._lastCell && ccx === this._lastCell[0] && ccz === this._lastCell[1]) return
    this._lastCell = [ccx, ccz]
    const t = this.terrain
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const sc = new THREE.Vector3()
    const range = Math.ceil(this.R / this.CELL)
    let i = 0
    for (let dz = -range; dz <= range && i < this.NEAR; dz++) {
      for (let dx = -range; dx <= range && i < this.NEAR; dx++) {
        const gx = ccx + dx, gz = ccz + dz
        // deterministický les: stejná buňka = stejné stromy (žádné blikání)
        const rng = mulberry32(((gx * 73856093) ^ (gz * 19349663)) >>> 0)
        for (let k = 0; k < this.perCell && i < this.NEAR; k++) {
          const x = (gx + rng()) * this.CELL
          const z = (gz + rng()) * this.CELL
          const rr = rng(), rs = rng()
          if (x < 200 || z < 200 || x > t.sizeX - 200 || z > t.sizeZ - 200) continue
          // Kde roste les, říkají data (ESA WorldCover), ne odhad z výšky.
          // Mýtiny, pastviny i horní hranice lesa jsou pak na svém místě.
          const klass = t.coverAt(x, z)
          if (klass && klass !== 10 && klass !== 20) continue
          const h = t.heightAt(x, z)
          if (h < 720 || h > 2200) continue
          const { slope } = t.slopeAspect(x, z)
          if (slope > 0.55) continue
          if (!klass) { // bez dat aspoň starý odhad, ať mapa nezůstane holá
            const density = h > 1800 ? (2000 - h) / 200 : 1
            if (rr > density) continue
          } else if (klass === 20 && rr > 0.35) continue // křoviny jsou řídké
          if (this.towns.some(tw => Math.hypot(tw.x - x, tw.z - z) < tw.r)) continue
          const s = 0.7 + rs * 0.7
          q.setFromAxisAngle(up, rr * Math.PI * 2)
          sc.set(s, s * (0.9 + rr * 0.3), s)
          m.compose(_v.set(x, h - 1, z), q, sc)
          this.near.setMatrixAt(i, m)
          i++
        }
      }
    }
    this.near.count = i
    this.near.instanceMatrix.needsUpdate = true
  }
}

const _v = new THREE.Vector3()

function buildTreeAssets() {
  const rng = mulberry32(4242)
  // textura smrku: tmavý jehlan s roztřepenými patry
  const c = document.createElement('canvas')
  c.width = 64; c.height = 128
  const ctx = c.getContext('2d')
  ctx.clearRect(0, 0, 64, 128)
  for (let layer = 0; layer < 9; layer++) {
    const y = 12 + layer * 12
    const half = 5 + layer * 3.1
    // Smrk je tmavý, ale ne černý — z letu se les jinak čte jako pepř.
    // Spodní patra do stínu, horní k slunci.
    const g = 92 + rng() * 34 - layer * 4
    ctx.fillStyle = `rgb(${34 + layer * 3}, ${g | 0}, ${44 + layer * 2})`
    ctx.beginPath()
    ctx.moveTo(32, y - 14)
    for (let k = -4; k <= 4; k++) {
      ctx.lineTo(32 + (k / 4) * half + (rng() - 0.5) * 3, y + Math.abs(k / 4) * 6 - 2)
    }
    ctx.closePath()
    ctx.fill()
  }
  ctx.fillStyle = '#4a3220'
  ctx.fillRect(29, 108, 6, 20)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace

  // dva zkřížené kvady (bez per-frame natáčení — z letu vypadá dobře)
  const q1 = new THREE.PlaneGeometry(16, 30)
  const q2 = q1.clone().rotateY(Math.PI / 2)
  const geo = mergeGeo(q1, q2)
  geo.translate(0, 15, 0)

  // Lambert dělal ze stromů černé tečky (smrk je tmavý a ještě se stínoval).
  // Basic + jemné dobarvení podle výšky drží les čitelný i z letu.
  const mat = new THREE.MeshBasicMaterial({
    map: tex, alphaTest: 0.45, side: THREE.DoubleSide,
    color: 0xd6e0cd, // jemné prosvětlení textury (násobí se do ní)
  })
  return { geo, mat }
}

// dálková vrstva: řídší, větší siluety po celé mapě
function buildFarLayer(scene, terrain, towns, COUNT) {
  const rng = mulberry32(989898)
  const { geo, mat } = buildTreeAssets()
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const sc = new THREE.Vector3()
  let i = 0
  let guard = 0
  while (i < COUNT && guard++ < COUNT * 12) {
    const x = 400 + rng() * (terrain.sizeX - 800)
    const z = 400 + rng() * (terrain.sizeZ - 800)
    const klass = terrain.coverAt(x, z) // i dálková vrstva ctí skutečný les
    if (klass && klass !== 10 && klass !== 20) continue
    const h = terrain.heightAt(x, z)
    if (h < 720 || h > 2200) continue
    const { slope } = terrain.slopeAspect(x, z)
    if (slope > 0.55) continue
    if (!klass) {
      const density = h > 1800 ? (2000 - h) / 200 : 1
      if (rng() > density) continue
    } else if (klass === 20 && rng() > 0.35) continue
    if (towns.some(t => Math.hypot(t.x - x, t.z - z) < t.r)) continue
    const s = 1.2 + rng() * 0.9 // větší — čitelné i z dálky
    q.setFromAxisAngle(up, rng() * Math.PI)
    sc.set(s, s, s)
    m.compose(new THREE.Vector3(x, h - 1, z), q, sc)
    mesh.setMatrixAt(i, m)
    i++
  }
  mesh.count = i
  mesh.instanceMatrix.needsUpdate = true
  mesh.frustumCulled = false
  scene.add(mesh)
  return mesh
}

// mini-merge dvou geometrií se stejnými atributy (bez importu utils)
function mergeGeo(a, b) {
  const geo = new THREE.BufferGeometry()
  for (const name of ['position', 'normal', 'uv']) {
    const A = a.getAttribute(name), B = b.getAttribute(name)
    const arr = new Float32Array(A.array.length + B.array.length)
    arr.set(A.array, 0)
    arr.set(B.array, A.array.length)
    geo.setAttribute(name, new THREE.BufferAttribute(arr, A.itemSize))
  }
  const ia = a.getIndex().array, ib = b.getIndex().array
  const off = a.getAttribute('position').count
  const idx = new Uint16Array(ia.length + ib.length)
  idx.set(ia, 0)
  for (let k = 0; k < ib.length; k++) idx[ia.length + k] = ib[k] + off
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  return geo
}
