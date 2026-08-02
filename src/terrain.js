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
    const cell = this.sizeX / (gw - 1)

    // 1) barvy + výšky + ANALYTICKÉ normály pro celou mřížku (normály ze
    //    spádu heightmapy — spojité i přes hranice dlaždic, žádné švy)
    const colors = new Float32Array(gw * gh * 3)
    const normals = new Float32Array(gw * gh * 3)
    const c = new THREE.Color()
    const rock = new THREE.Color(0x8d8579)
    const rockDark = new THREE.Color(0x6b655c)
    const snow = new THREE.Color(0xf4f7fb)
    const glacier = new THREE.Color(0xcfe4ee)
    const forest = new THREE.Color(0x2f5d33)
    const meadow = new THREE.Color(0x74a04c)
    const valley = new THREE.Color(0x8fae62)

    for (let gz = 0; gz < gh; gz++) {
      for (let gx = 0; gx < gw; gx++) {
        const i = gz * gw + gx
        const h = this.heights[i]
        const xl = this.heights[gz * gw + Math.max(0, gx - 1)]
        const xr = this.heights[gz * gw + Math.min(gw - 1, gx + 1)]
        const zu = this.heights[Math.max(0, gz - 1) * gw + gx]
        const zd = this.heights[Math.min(gh - 1, gz + 1) * gw + gx]
        const slope = Math.min(1, Math.hypot(xr - xl, zd - zu) / (4 * cell))

        // normála ze spádu (centrální diference)
        const nx = (xl - xr) / (2 * cell), nz = (zu - zd) / (2 * cell)
        const inv = 1 / Math.hypot(nx, 1, nz)
        normals[i * 3] = nx * inv
        normals[i * 3 + 1] = inv
        normals[i * 3 + 2] = nz * inv

        const n01 = ((Math.imul(gx * 73856093 ^ gz * 19349663, 2654435761) >>> 8) & 1023) / 1023
        const snowLine = 2750 + n01 * 220
        const treeLine = 1950 + n01 * 150
        if (h > snowLine) {
          c.copy(snow)
          if (slope < 0.32 && h > 3000) c.lerp(glacier, 0.55)
          if (slope > 0.62) c.lerp(rockDark, Math.min(1, (slope - 0.62) * 2.2))
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
        if (h > 1900 && h < 2750 && slope < 0.16) c.lerp(glacier, 0.4)

        // hillshade od SZ
        const shade = Math.max(0, (-0.45 * nx + 0.75 + 0.45 * nz) * inv)
        const f = 0.72 + shade * 0.42
        colors[i * 3] = Math.min(1, c.r * f)
        colors[i * 3 + 1] = Math.min(1, c.g * f)
        colors[i * 3 + 2] = Math.min(1, c.b * f)
      }
    }

    // 2) detailní šumová textura (struktura zblízka)
    const dc = document.createElement('canvas')
    dc.width = dc.height = 512
    const dctx = dc.getContext('2d')
    const dimg = dctx.createImageData(512, 512)
    let seed = 12345
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    // dvě oktávy: hrubé skvrny (interpolace mřížky 32×32) + jemné zrno
    const G = 33
    const grid = new Float32Array(G * G)
    for (let i = 0; i < G * G; i++) grid[i] = rnd()
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const fx = x / 512 * (G - 1), fy = y / 512 * (G - 1)
        const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0
        const coarse =
          grid[y0 * G + x0] * (1 - tx) * (1 - ty) + grid[y0 * G + x0 + 1] * tx * (1 - ty) +
          grid[(y0 + 1) * G + x0] * (1 - tx) * ty + grid[(y0 + 1) * G + x0 + 1] * tx * ty
        const v = 196 + coarse * 44 + rnd() * 28
        const i = (y * 512 + x) * 4
        dimg.data[i] = v; dimg.data[i + 1] = v; dimg.data[i + 2] = v
        dimg.data[i + 3] = 255
      }
    }
    dctx.putImageData(dimg, 0, 0)
    const detail = new THREE.CanvasTexture(dc)
    detail.wrapS = detail.wrapT = THREE.RepeatWrapping
    detail.repeat.set(this.sizeX / 260, this.sizeZ / 260)
    detail.anisotropy = 4
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: detail })

    // 3) mřížka rozřezaná na 4×4 dlaždice → frustum culling (kreslí se jen
    //    to, co je ve výhledu; jeden 735k mesh se kreslil vždy celý)
    this.mesh = new THREE.Group()
    const CH = 4
    const xCuts = [], zCuts = []
    for (let k = 0; k <= CH; k++) {
      xCuts.push(Math.round(k * (gw - 1) / CH))
      zCuts.push(Math.round(k * (gh - 1) / CH))
    }
    for (let cz = 0; cz < CH; cz++) {
      for (let cx = 0; cx < CH; cx++) {
        const x0 = xCuts[cx], x1 = xCuts[cx + 1]
        const z0 = zCuts[cz], z1 = zCuts[cz + 1]
        const w = x1 - x0 + 1, hgt = z1 - z0 + 1
        const pos = new Float32Array(w * hgt * 3)
        const nor = new Float32Array(w * hgt * 3)
        const col = new Float32Array(w * hgt * 3)
        const uv = new Float32Array(w * hgt * 2)
        let vi = 0
        for (let gz = z0; gz <= z1; gz++) {
          for (let gx = x0; gx <= x1; gx++) {
            const gi = gz * gw + gx
            pos[vi * 3] = gx / (gw - 1) * this.sizeX
            pos[vi * 3 + 1] = this.heights[gi]
            pos[vi * 3 + 2] = gz / (gh - 1) * this.sizeZ
            nor[vi * 3] = normals[gi * 3]
            nor[vi * 3 + 1] = normals[gi * 3 + 1]
            nor[vi * 3 + 2] = normals[gi * 3 + 2]
            col[vi * 3] = colors[gi * 3]
            col[vi * 3 + 1] = colors[gi * 3 + 1]
            col[vi * 3 + 2] = colors[gi * 3 + 2]
            uv[vi * 2] = gx / (gw - 1)
            uv[vi * 2 + 1] = 1 - gz / (gh - 1)
            vi++
          }
        }
        const idx = []
        for (let r = 0; r < hgt - 1; r++) {
          for (let q = 0; q < w - 1; q++) {
            const a = r * w + q
            idx.push(a, a + w, a + 1, a + 1, a + w, a + w + 1)
          }
        }
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
        geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
        geo.setIndex(idx)
        this.mesh.add(new THREE.Mesh(geo, mat))
      }
    }

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
