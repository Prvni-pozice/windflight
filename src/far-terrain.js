// far-terrain.js — daleký horizont: SKUTEČNÉ Alpy do ~120 km kolem Chamonix
// (Copernicus GLO-90, viz scripts/fetch_far_terrain.mjs).
//
// Dřív za okrajem mapy ležel plochý zelený talíř a prstenec papírových
// siluet. Teď tam pokračuje pravý terén — na konci údolí se rýsují hřebeny,
// které tam doopravdy jsou, a při stoupání se odkrývají další, protože je to
// skutečná geometrie, ne kulisa.
//
// Detail je hrubý (~650 m na buňku), ale všechno tohle je 15–120 km daleko
// a schované v oparu; blízkou mapu kreslí Terrain v plném rozlišení.
import * as THREE from 'three'

const FAR_BLUE = new THREE.Color(0x8fa6bd) // barva vzduchu mezi mnou a hřebenem

export class FarTerrain {
  /** @param near Terrain — kvůli sdílené soustavě souřadnic (metry).
   *  @param step 2 = poloviční hustota (slabší zařízení) */
  static async load(near, step = 1) {
    const [meta, buf] = await Promise.all([
      fetch('/terrain/alps-far.json').then(r => r.json()),
      fetch('/terrain/alps-far.bin').then(r => r.arrayBuffer()),
    ])
    return new FarTerrain(meta, new Uint16Array(buf), near, step)
  }

  constructor(meta, heights, near, step = 1) {
    // řidší mřížka pro nízkou kvalitu: 4× méně trojúhelníků, na dálku
    // v oparu to nikdo nepozná
    if (step > 1) {
      const gw = Math.ceil(meta.gw / step), gh = Math.ceil(meta.gh / step)
      const dec = new Uint16Array(gw * gh)
      for (let z = 0; z < gh; z++) {
        for (let x = 0; x < gw; x++) {
          dec[z * gw + x] = heights[Math.min(meta.gh - 1, z * step) * meta.gw + Math.min(meta.gw - 1, x * step)]
        }
      }
      heights = dec
      meta = { ...meta, gw, gh }
    }
    this.meta = meta
    this.heights = heights
    // metry na stupeň bereme z blízké mapy, jinak by na sebe nenavázaly
    this.mPerLon = near.sizeX / (near.meta.lon1 - near.meta.lon0)
    this.mPerLat = near.sizeZ / (near.meta.lat1 - near.meta.lat0)
    this.near = near
    this._build()
  }

  worldX(lon) { return (lon - this.near.meta.lon0) * this.mPerLon }
  worldZ(lat) { return (this.near.meta.lat1 - lat) * this.mPerLat }

  _build() {
    const { gw, gh, lon0, lon1, lat0, lat1 } = this.meta
    const nX = this.near.sizeX, nZ = this.near.sizeZ

    // barvy: hrubá hypsometrie, do dálky stejně všechno spolkne opar
    const rock = new THREE.Color(0x87817a)
    const snow = new THREE.Color(0xeef3f8)
    const forest = new THREE.Color(0x47673f)
    const low = new THREE.Color(0x7a9a5e)
    const c = new THREE.Color()

    const xs = new Float32Array(gw), zs = new Float32Array(gh)
    for (let gx = 0; gx < gw; gx++) xs[gx] = this.worldX(lon0 + gx / (gw - 1) * (lon1 - lon0))
    for (let gz = 0; gz < gh; gz++) zs[gz] = this.worldZ(lat1 - gz / (gh - 1) * (lat1 - lat0))

    const pos = new Float32Array(gw * gh * 3)
    const col = new Float32Array(gw * gh * 3)
    for (let gz = 0; gz < gh; gz++) {
      for (let gx = 0; gx < gw; gx++) {
        const i = gz * gw + gx
        const h = this.heights[i]
        const x = xs[gx], z = zs[gz]

        // Uvnitř herní mapy se daleký terén zanoří pod ni: na hranici zůstává
        // ve stejné výšce (aby nebyl schod) a směrem dovnitř klesá, takže ho
        // podrobná mapa spolehlivě překryje a nikde neprobleskne.
        const inside = Math.min(
          Math.min(x, nX - x) / 1200,
          Math.min(z, nZ - z) / 1200,
        )
        const sink = inside > 0 ? Math.min(600, inside * 600) : 0

        pos[i * 3] = x
        pos[i * 3 + 1] = h - sink
        pos[i * 3 + 2] = z

        // sklon z okolí (jen pro barvu skal)
        const xl = this.heights[gz * gw + Math.max(0, gx - 1)]
        const xr = this.heights[gz * gw + Math.min(gw - 1, gx + 1)]
        const zu = this.heights[Math.max(0, gz - 1) * gw + gx]
        const zd = this.heights[Math.min(gh - 1, gz + 1) * gw + gx]
        const slope = Math.min(1, Math.hypot(xr - xl, zd - zu) / 1600)

        if (h > 2500) c.copy(rock).lerp(snow, Math.min(1, (h - 2500) / 500))
        else if (h > 1500) c.copy(forest).lerp(rock, Math.min(1, (h - 1500) / 1000 + slope * 0.5))
        else c.copy(low).lerp(forest, Math.min(1, (h - 300) / 1200))
        // Přes desítky kilometrů vzduchu není zelená zelená — modrá se
        // rozptyluje do cesty. Mlha tohle dělá taky, ale až od jisté
        // vzdálenosti; tohle drží dálku barevně "v dálce" i blíž k mapě.
        c.lerp(FAR_BLUE, 0.28)
        // hřebeny přisvětlit, údolí ztmavit — z dálky je čitelný jen reliéf
        const f = 0.86 + Math.min(0.22, slope * 0.5)
        col[i * 3] = c.r * f
        col[i * 3 + 1] = c.g * f
        col[i * 3 + 2] = c.b * f
      }
    }

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true })
    this.group = new THREE.Group()

    // 6×6 dlaždic kvůli frustum cullingu; uvnitř herní mapy se trojúhelníky
    // vůbec negenerují (tam kreslí Terrain)
    const CH = 6
    const cuts = (n) => {
      const a = []
      for (let k = 0; k <= CH; k++) a.push(Math.round(k * (n - 1) / CH))
      return a
    }
    const xCuts = cuts(gw), zCuts = cuts(gh)
    for (let cz = 0; cz < CH; cz++) {
      for (let cx = 0; cx < CH; cx++) {
        const x0 = xCuts[cx], x1 = xCuts[cx + 1]
        const z0 = zCuts[cz], z1 = zCuts[cz + 1]
        const w = x1 - x0 + 1, hgt = z1 - z0 + 1
        const p = new Float32Array(w * hgt * 3)
        const cc = new Float32Array(w * hgt * 3)
        let vi = 0
        for (let gz = z0; gz <= z1; gz++) {
          for (let gx = x0; gx <= x1; gx++) {
            const gi = gz * gw + gx
            p[vi * 3] = pos[gi * 3]; p[vi * 3 + 1] = pos[gi * 3 + 1]; p[vi * 3 + 2] = pos[gi * 3 + 2]
            cc[vi * 3] = col[gi * 3]; cc[vi * 3 + 1] = col[gi * 3 + 1]; cc[vi * 3 + 2] = col[gi * 3 + 2]
            vi++
          }
        }
        const idx = []
        for (let r = 0; r < hgt - 1; r++) {
          for (let q = 0; q < w - 1; q++) {
            // je celý čtverec hluboko uvnitř herní mapy? pak ho zahoď
            const ax = xs[x0 + q], az = zs[z0 + r]
            const bx = xs[x0 + q + 1], bz = zs[z0 + r + 1]
            if (Math.min(ax, bx) > 2000 && Math.max(ax, bx) < nX - 2000 &&
                Math.min(az, bz) > 2000 && Math.max(az, bz) < nZ - 2000) continue
            const a = r * w + q
            idx.push(a, a + w, a + 1, a + 1, a + w, a + w + 1)
          }
        }
        if (!idx.length) continue
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(p, 3))
        geo.setAttribute('color', new THREE.BufferAttribute(cc, 3))
        geo.setIndex(idx)
        geo.computeVertexNormals()
        this.group.add(new THREE.Mesh(geo, mat))
      }
    }
  }

  addTo(scene) { scene.add(this.group) }
}
