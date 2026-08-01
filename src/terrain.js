// terrain.js — reálný terén Chamonix / Mont Blanc z Copernicus GLO-30 DEM.
// Souřadnice světa v METRECH: x na východ (0..sizeX), z na jih (0..sizeZ),
// y = nadmořská výška. Řádek 0 dat = severní okraj (z=0).
import * as THREE from 'three'

export class Terrain {
  /** Načte public/terrain/chamonix.{bin,json} a postaví mesh. */
  static async load() {
    const [meta, buf] = await Promise.all([
      fetch('/terrain/chamonix.json').then(r => r.json()),
      fetch('/terrain/chamonix.bin').then(r => r.arrayBuffer()),
    ])
    return new Terrain(meta, new Uint16Array(buf))
  }

  constructor(meta, heights) {
    this.meta = meta
    this.gw = meta.gw
    this.gh = meta.gh
    this.sizeX = meta.widthM
    this.sizeZ = meta.heightM
    this.heights = heights
    this._buildMesh()
  }

  addTo(scene) {
    scene.add(this.mesh)
    scene.add(this.skirt)
  }

  /** Výška terénu v metrech (bilineárně), mimo mapu drží okraj. */
  heightAt(x, z) {
    const fx = Math.min(this.gw - 1.001, Math.max(0, x / this.sizeX * (this.gw - 1)))
    const fz = Math.min(this.gh - 1.001, Math.max(0, z / this.sizeZ * (this.gh - 1)))
    const x0 = Math.floor(fx), z0 = Math.floor(fz)
    const tx = fx - x0, tz = fz - z0
    const h = this.heights
    const i = z0 * this.gw + x0
    return h[i] * (1 - tx) * (1 - tz) + h[i + 1] * tx * (1 - tz) +
      h[i + this.gw] * (1 - tx) * tz + h[i + this.gw + 1] * tx * tz
  }

  /** Normála terénu (pro svahové proudění a barvy). */
  normalAt(x, z, out = new THREE.Vector3()) {
    const d = 60 // metrů
    const hx = this.heightAt(x + d, z) - this.heightAt(x - d, z)
    const hz = this.heightAt(x, z + d) - this.heightAt(x, z - d)
    return out.set(-hx / (2 * d), 1, -hz / (2 * d)).normalize()
  }

  /** Sklon (0 = rovina, 1 = svislá stěna) a orientace svahu (azimut po svahu dolů). */
  slopeAspect(x, z) {
    const n = this.normalAt(x, z, _n)
    const slope = 1 - n.y
    const aspect = Math.atan2(n.x, n.z) // směr, kam svah "kouká" (x=východ, z=jih)
    return { slope, aspect, n }
  }

  _buildMesh() {
    const { gw, gh } = this
    const geo = new THREE.PlaneGeometry(this.sizeX, this.sizeZ, gw - 1, gh - 1)
    geo.rotateX(-Math.PI / 2) // do roviny XZ, +z k jihu (řádky jdou od severu)
    geo.translate(this.sizeX / 2, 0, this.sizeZ / 2)

    const pos = geo.attributes.position
    const colors = new Float32Array(pos.count * 3)
    const c = new THREE.Color()
    const rock = new THREE.Color(0x8d8579)
    const rockDark = new THREE.Color(0x6b655c)
    const snow = new THREE.Color(0xf4f7fb)
    const glacier = new THREE.Color(0xcfe4ee)
    const forest = new THREE.Color(0x2f5d33)
    const meadow = new THREE.Color(0x74a04c)
    const valley = new THREE.Color(0x8fae62)

    for (let i = 0; i < pos.count; i++) {
      const gx = i % gw, gz = (i / gw) | 0
      const h = this.heights[gz * gw + gx]
      pos.setY(i, h)

      // sklon z mřížky (rychlejší než heightAt)
      const xl = this.heights[gz * gw + Math.max(0, gx - 1)]
      const xr = this.heights[gz * gw + Math.min(gw - 1, gx + 1)]
      const zu = this.heights[Math.max(0, gz - 1) * gw + gx]
      const zd = this.heights[Math.min(gh - 1, gz + 1) * gw + gx]
      const cell = this.sizeX / (gw - 1)
      const slope = Math.min(1, Math.hypot(xr - xl, zd - zu) / (4 * cell))

      // deterministický šum ať plochy nejsou sterilní
      const n01 = ((Math.imul(gx * 73856093 ^ gz * 19349663, 2654435761) >>> 8) & 1023) / 1023

      const snowLine = 2750 + n01 * 220        // sněžná čára ~2 750–3 000 m
      const treeLine = 1950 + n01 * 150        // hranice lesa
      if (h > snowLine) {
        // sníh; na mírných plochách výš ledovcový nádech
        c.copy(snow)
        if (slope < 0.32 && h > 3000) c.lerp(glacier, 0.55)
        if (slope > 0.62) c.lerp(rockDark, Math.min(1, (slope - 0.62) * 2.2)) // skalní stěny nad sněžnou čárou
      } else if (slope > 0.5) {
        c.copy(rock).lerp(rockDark, (slope - 0.5) * 2)
      } else if (h > treeLine) {
        c.copy(meadow).lerp(rock, Math.min(1, (h - treeLine) / (snowLine - treeLine) * 1.15 + slope * 0.6))
      } else {
        c.copy(h < 1100 ? valley : forest)
        c.lerp(forest, Math.min(1, h / treeLine))
        c.offsetHSL(0, 0, (n01 - 0.5) * 0.05)
        if (slope > 0.34) c.lerp(rock, (slope - 0.34) * 1.4)
      }
      // ledovcové splazy: vysoko položené mírné údolí (Mer de Glace)
      if (h > 1900 && h < 2750 && slope < 0.16) c.lerp(glacier, 0.4)

      // kartografický hillshade (světlo od SZ) — plastika reliéfu nezávislá
      // na dynamickém světle; jemná, ať nepřebije barvy
      {
        const nx = (xl - xr) / (4 * cell), nz = (zu - zd) / (4 * cell)
        const inv = 1 / Math.hypot(nx, 1, nz)
        const shade = Math.max(0, (-0.45 * nx + 0.75 + 0.45 * nz) * inv) // dot s (-0.45,0.75,0.45)
        const f = 0.72 + shade * 0.42
        c.r = Math.min(1, c.r * f); c.g = Math.min(1, c.g * f); c.b = Math.min(1, c.b * f)
      }

      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.computeVertexNormals()

    // jemný šedý šum jako detail-mapa: high-freq struktura zblízka
    const dc = document.createElement('canvas')
    dc.width = dc.height = 256
    const dctx = dc.getContext('2d')
    const dimg = dctx.createImageData(256, 256)
    let seed = 12345
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let i = 0; i < 256 * 256; i++) {
      const v = 215 + rnd() * 40
      dimg.data[i * 4] = v; dimg.data[i * 4 + 1] = v; dimg.data[i * 4 + 2] = v
      dimg.data[i * 4 + 3] = 255
    }
    dctx.putImageData(dimg, 0, 0)
    const detail = new THREE.CanvasTexture(dc)
    detail.wrapS = detail.wrapT = THREE.RepeatWrapping
    detail.repeat.set(this.sizeX / 340, this.sizeZ / 340)

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: detail })
    this.mesh = new THREE.Mesh(geo, mat)

    // okolní "svět" pod okrajem mapy, ať není vidět do prázdna
    this.skirt = new THREE.Mesh(
      new THREE.PlaneGeometry(this.sizeX * 7, this.sizeZ * 7),
      new THREE.MeshLambertMaterial({ color: 0x5f7f52 }),
    )
    this.skirt.rotation.x = -Math.PI / 2
    this.skirt.position.set(this.sizeX / 2, Math.max(0, this.meta.hmin - 12), this.sizeZ / 2)
  }

  /** lat/lon → lokální metry (pro rozmístění bran a startu). */
  fromLatLon(lat, lon) {
    const m = this.meta
    const x = (lon - m.lon0) / (m.lon1 - m.lon0) * this.sizeX
    const z = (m.lat1 - lat) / (m.lat1 - m.lat0) * this.sizeZ
    return { x, z }
  }
}

const _n = new THREE.Vector3()
