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

export function buildForest(scene, terrain) {
  const rng = mulberry32(4242)
  const isTouch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
  const COUNT = isTouch ? 12000 : 26000

  // textura smrku: tmavý jehlan s roztřepenými patry
  const c = document.createElement('canvas')
  c.width = 64; c.height = 128
  const ctx = c.getContext('2d')
  ctx.clearRect(0, 0, 64, 128)
  for (let layer = 0; layer < 9; layer++) {
    const y = 12 + layer * 12
    const half = 5 + layer * 3.1
    const g = 62 + rng() * 30 - layer * 3
    ctx.fillStyle = `rgb(${18 + layer * 2}, ${g | 0}, ${26 + layer * 2})`
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

  const mat = new THREE.MeshLambertMaterial({
    map: tex, alphaTest: 0.45, side: THREE.DoubleSide,
  })
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const sc = new THREE.Vector3()
  const towns = TOWN_CLEAR.map(([lat, lon, r]) => ({ ...terrain.fromLatLon(lat, lon), r }))

  let i = 0
  let guard = 0
  while (i < COUNT && guard++ < COUNT * 12) {
    const x = 400 + rng() * (terrain.sizeX - 800)
    const z = 400 + rng() * (terrain.sizeZ - 800)
    const h = terrain.heightAt(x, z)
    if (h < 720 || h > 2000) continue
    const { slope } = terrain.slopeAspect(x, z)
    if (slope > 0.55) continue
    // hustota: plné lesy 1000–1800 m, řídne k hranici lesa
    const density = h > 1800 ? (2000 - h) / 200 : 1
    if (rng() > density) continue
    if (towns.some(t => Math.hypot(t.x - x, t.z - z) < t.r)) continue
    const s = 0.75 + rng() * 0.7
    q.setFromAxisAngle(up, rng() * Math.PI)
    sc.set(s, s * (0.9 + rng() * 0.3), s)
    m.compose(new THREE.Vector3(x, h - 1, z), q, sc)
    mesh.setMatrixAt(i, m)
    i++
  }
  mesh.count = i
  mesh.instanceMatrix.needsUpdate = true
  mesh.frustumCulled = false // instance jsou po celé mapě; culling řeší dlaždice terénu
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
