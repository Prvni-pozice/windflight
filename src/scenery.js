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

export function buildScenery(scene, terrain) {
  const rng = mulberry32(777)
  let total = 0
  for (const t of TOWNS) total += t[2]

  const houseGeo = new THREE.BoxGeometry(14, 9, 20)
  const houseMat = new THREE.MeshLambertMaterial({ color: 0xd9d2c4 })
  const houses = new THREE.InstancedMesh(houseGeo, houseMat, total)
  const roofGeo = new THREE.ConeGeometry(13, 7, 4)
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x77503c })
  const roofs = new THREE.InstancedMesh(roofGeo, roofMat, total)

  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const sc = new THREE.Vector3()
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
      i++
    }
  }
  houses.count = i
  roofs.count = i
  houses.instanceMatrix.needsUpdate = true
  roofs.instanceMatrix.needsUpdate = true
  scene.add(houses)
  scene.add(roofs)

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

  // cirry vysoko nad masivem — jemné pruhy
  const cirCanvas = document.createElement('canvas')
  cirCanvas.width = 256; cirCanvas.height = 64
  const cctx = cirCanvas.getContext('2d')
  cctx.clearRect(0, 0, 256, 64)
  for (let k = 0; k < 26; k++) {
    cctx.fillStyle = `rgba(255,255,255,${0.05 + rng() * 0.1})`
    const y = rng() * 64
    cctx.fillRect(rng() * 200 - 20, y, 60 + rng() * 120, 1.5 + rng() * 3)
  }
  const cirTex = new THREE.CanvasTexture(cirCanvas)
  for (let k = 0; k < 4; k++) {
    const cir = new THREE.Mesh(
      new THREE.PlaneGeometry(24000, 6000),
      new THREE.MeshBasicMaterial({ map: cirTex, transparent: true, opacity: 0.5, depthWrite: false }),
    )
    cir.rotation.x = -Math.PI / 2
    cir.position.set(6000 + rng() * 24000, 7300 + k * 350, 5000 + rng() * 22000)
    cir.rotation.z = rng() * Math.PI
    scene.add(cir)
  }
}
