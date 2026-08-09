// gates.js — úkolová trať: sekvence bran (prstenců) nad reálnými místy
// údolí Chamonix. Rozmístěné tak, že bez termiky/svahového proudění
// nedoletíš — mezi branami je třeba nabírat výšku.
import * as THREE from 'three'

// [lat, lon, výška brány m n. m., popisek]
const ROUTE = [
  [45.9360, 6.8520, 2350, 'Brévent'],
  [45.9530, 6.8720, 2400, 'La Flégère'],
  [45.9620, 6.9200, 2300, 'Argentière'],
  [45.9080, 6.8760, 2350, 'Plan de l\'Aiguille'],
  [45.9225, 6.8705, 1550, 'cíl — Chamonix'],
]

export const GATE_R = 125 // poloměr průletu (m)

export class Gates {
  constructor(scene, terrain) {
    this.terrain = terrain
    this.list = []
    this.current = 0
    this.group = new THREE.Group()

    const ringGeo = new THREE.TorusGeometry(GATE_R, 8, 10, 36)
    this.matNext = new THREE.MeshBasicMaterial({ color: 0x37d67a, transparent: true, opacity: 0.95 })
    this.matFar = new THREE.MeshBasicMaterial({ color: 0x9fb4c8, transparent: true, opacity: 0.28 })
    this.matDone = new THREE.MeshBasicMaterial({ color: 0x37d67a, transparent: true, opacity: 0.1 })

    for (let i = 0; i < ROUTE.length; i++) {
      const [lat, lon, alt, name] = ROUTE[i]
      const { x, z } = terrain.fromLatLon(lat, lon)
      // brána nikdy pod terénem: min 150 m nad zemí
      const y = Math.max(alt, terrain.heightAt(x, z) + 150)
      const mesh = new THREE.Mesh(ringGeo, this.matFar)
      mesh.position.set(x, y, z)
      this.group.add(mesh)
      this.list.push({ x, y, z, name, mesh, done: false })
    }
    // prstence natočit kolmo na směr příletu (od předchozí brány)
    for (let i = 0; i < this.list.length; i++) {
      const g = this.list[i]
      const prev = i === 0 ? null : this.list[i - 1]
      if (prev) g.mesh.lookAt(prev.x, g.y, prev.z)
    }
    // světelný sloup nad AKTUÁLNÍ bránou — vidět zdaleka
    // užší a průsvitnější než dřív — sloup má bránu najít, ne přebít krajinu
    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(16, 16, 2600, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x37d67a, transparent: true, opacity: 0.1,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    )
    this.group.add(this.beam)
    this._refreshMats()
    scene.add(this.group)
  }

  get total() { return this.list.length }
  get next() { return this.list[this.current] || null }

  _refreshMats() {
    this.list.forEach((g, i) => {
      g.mesh.material = g.done ? this.matDone : (i === this.current ? this.matNext : this.matFar)
    })
    const n = this.next
    if (this.beam) {
      this.beam.visible = !!n
      if (n) this.beam.position.set(n.x, n.y + 1300, n.z)
    }
  }

  /** Vrátí true, pokud byla právě proletěna další brána. */
  check(pos) {
    const g = this.next
    if (!g) return false
    const d = Math.sqrt((pos.x - g.x) ** 2 + (pos.y - g.y) ** 2 + (pos.z - g.z) ** 2)
    if (d < GATE_R) {
      g.done = true
      this.current++
      this._refreshMats()
      return true
    }
    return false
  }

  reset() {
    this.current = 0
    for (const g of this.list) g.done = false
    this._refreshMats()
  }

  update(t) {
    const g = this.next
    if (g) {
      const s = 1 + Math.sin(t * 3.5) * 0.04
      g.mesh.scale.set(s, s, s)
      this.beam.material.opacity = 0.055 + Math.sin(t * 2.2) * 0.03
    }
  }
}
