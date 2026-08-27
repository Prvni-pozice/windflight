// scenery.js — orientační body v údolí: Chamonix, vesnice, letiště.
// Nízkopolygonové "domečky" (InstancedMesh) — z výšky čitelné, levné.
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

// [lat, lon, počet domů, poloměr m]
const TOWNS = [
  [45.9237, 6.8694, 160, 900, 'Chamonix'],
  [45.9790, 6.9260, 60, 500, 'Argentière'],
  [45.8905, 6.7990, 70, 550, 'Les Houches'],
  [45.9450, 6.8880, 30, 300, 'Les Praz'],
]

/** Měkký kulatý bod pro rozsvícená okna. */
function glowSprite(rgb) {
  const c = document.createElement('canvas')
  c.width = c.height = 32
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16)
  g.addColorStop(0, `rgba(${rgb},1)`)
  g.addColorStop(0.35, `rgba(${rgb},0.5)`)
  g.addColorStop(1, `rgba(${rgb},0)`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 32, 32)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

export function buildScenery(scene, terrain, sun = { elevDeg: 90 }) {
  const rng = mulberry32(777)
  let total = 0
  for (const t of TOWNS) total += t[2]

  // Stěny byly skoro bílé a z výšky z nich bylo bílé konfety rozsypané po
  // stráni. Savojská vesnice je tlumené dřevo a šedé šindele.
  const houseGeo = new THREE.BoxGeometry(14, 9, 20)
  const houseMat = new THREE.MeshLambertMaterial({ color: 0xb3a894 })
  const houses = new THREE.InstancedMesh(houseGeo, houseMat, total)
  const roofGeo = new THREE.ConeGeometry(13, 7, 4)
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x5c4a40 })
  const roofs = new THREE.InstancedMesh(roofGeo, roofMat, total)

  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const sc = new THREE.Vector3()
  // Za soumraku se v údolí rozsvítí okna. Nemá to vliv na let, ale večerní
  // Chamonix pod křídlem je půlka důvodu, proč se létá do tmy.
  const dusk = Math.max(0, Math.min(1, (7 - sun.elevDeg) / 11))
  const windows = []
  let i = 0
  for (const [lat, lon, count, radius] of TOWNS) {
    const c = terrain.fromLatLon(lat, lon)
    const baseH = terrain.heightAt(c.x, c.z)
    for (let k = 0; k < count && i < total; k++) {
      const ang = rng() * Math.PI * 2
      const r = Math.sqrt(rng()) * radius
      const x = c.x + Math.cos(ang) * r
      const z = c.z + Math.sin(ang) * r * 0.6 // údolí je protáhlé
      const h = terrain.heightAt(x, z)
      if (h > baseH + 220 || h < baseH - 120) continue // jen dno údolí
      const rot = rng() * Math.PI
      const s = 0.7 + rng() * 0.8
      q.setFromAxisAngle(up, rot)
      sc.set(s, s, s)
      m.compose(new THREE.Vector3(x, h + 4.5 * s, z), q, sc)
      houses.setMatrixAt(i, m)
      m.compose(new THREE.Vector3(x, h + (9 + 3.5) * s, z), q.clone().multiply(
        new THREE.Quaternion().setFromAxisAngle(up, Math.PI / 4)), sc)
      roofs.setMatrixAt(i, m)
      // ne každé okno svítí — prázdné domy dělají v řadě světel rytmus
      if (dusk > 0.01 && rng() < 0.72) windows.push(x, h + 6 * s, z)
      i++
    }
  }
  houses.count = i
  roofs.count = i
  houses.instanceMatrix.needsUpdate = true
  roofs.instanceMatrix.needsUpdate = true
  scene.add(houses)
  scene.add(roofs)

  // světla oken: bod na každý osvětlený dům. Barva je záměrně NAD jedničkou —
  // teprve tím přeteče přes práh záře (1,02 v postfx) a rozsvícené údolí
  // dostane měkký nádech místo tvrdých teček.
  if (windows.length) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(windows, 3))
    const lights = new THREE.Points(geo, new THREE.PointsMaterial({
      color: new THREE.Color(0xffcf87).multiplyScalar(1.4 + 1.6 * dusk),
      size: 48, map: glowSprite('255,214,150'), transparent: true,
      opacity: Math.min(1, 0.25 + dusk),
      sizeAttenuation: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }))
    scene.add(lights)
  }

  // letiště Chamonix (u cíle) — světlý pás v ose údolí
  const strip = terrain.fromLatLon(45.9286, 6.8622)
  const stripH = terrain.heightAt(strip.x, strip.z)
  const runway = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 620),
    new THREE.MeshLambertMaterial({ color: 0xb8bcc0 }),
  )
  runway.rotation.x = -Math.PI / 2
  runway.rotation.z = 0.5 // podél údolí
  runway.position.set(strip.x, stripH + 1, strip.z)
  scene.add(runway)
  // cirry se přestěhovaly do atmosphere.js — řídí je skutečná vysoká oblačnost
}
