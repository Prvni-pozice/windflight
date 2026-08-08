// Připraví DALEKÝ terén — skutečné Alpy do ~120 km kolem Chamonix.
//
// Proč: za okrajem herní mapy dřív začínal plochý zelený talíř a papírová
// silueta hřebenů. Horizont přitom dělá v plachtění půlku zážitku. Místo
// fotky (která by neseděla na terén a při stoupání by se rozpadla) sem jde
// SKUTEČNÁ geometrie: Mont Blanc, Aravis, Beaufortain, Vanoise, Jura —
// každý hřeben tam, kde ve skutečnosti je.
//
// Zdroj: Copernicus GLO-90 DEM (3 arcsec ≈ 90 m), public S3 bez klíče.
// Výstup: public/terrain/alps-far.bin (Uint16 metry) + alps-far.json
// Použití: node scripts/fetch_far_terrain.mjs [adresář s .tif]
//   Bez argumentu si dlaždice stáhne sám do /tmp.
import { fromFile } from 'geotiff'
import { writeFileSync, mkdirSync, existsSync, statSync } from 'fs'
import { execFileSync } from 'child_process'

// oblast: ±~120 km kolem Chamonix (45.92 N, 6.87 E)
const LON0 = 5.32, LON1 = 8.42
const LAT0 = 44.84, LAT1 = 47.00
const GW = 384, GH = 352 // ≈ 630 × 680 m na buňku — na dálku bohatě stačí

const CACHE = process.argv[2] || '/tmp/copernicus-far'
mkdirSync(CACHE, { recursive: true })

const tileName = (lat, lon) =>
  `Copernicus_DSM_COG_30_N${String(lat).padStart(2, '0')}_00_E${String(lon).padStart(3, '0')}_00_DEM`

/** Stáhne dlaždici, pokud ji ještě nemáme. Vrací cestu nebo null. */
function ensureTile(lat, lon) {
  const name = tileName(lat, lon)
  const path = `${CACHE}/${name}.tif`
  if (existsSync(path) && statSync(path).size > 100000) return path
  const url = `https://copernicus-dem-90m.s3.amazonaws.com/${name}/${name}.tif`
  process.stdout.write(`stahuji ${name}… `)
  try {
    execFileSync('curl', ['-sfL', '-o', path, url], { timeout: 300000 })
    console.log(`${(statSync(path).size / 1e6).toFixed(1)} MB`)
    return path
  } catch {
    console.log('není (moře/mimo pokrytí)')
    return null
  }
}

const out = new Uint16Array(GW * GH)
let hmin = Infinity, hmax = -Infinity
let filled = 0

for (let tLat = Math.floor(LAT0); tLat <= Math.floor(LAT1); tLat++) {
  for (let tLon = Math.floor(LON0); tLon <= Math.floor(LON1); tLon++) {
    const path = ensureTile(tLat, tLon)
    if (!path) continue
    const img = await (await fromFile(path)).getImage()
    const [ox, oy] = img.getOrigin()
    const [rx, ry] = img.getResolution()
    const sw = img.getWidth(), sh = img.getHeight()
    const src = (await img.readRasters())[0]

    // do kterých výstupních buněk tahle dlaždice sahá
    const cx0 = Math.max(0, Math.ceil((tLon - LON0) / (LON1 - LON0) * (GW - 1)))
    const cx1 = Math.min(GW - 1, Math.floor((tLon + 1 - LON0) / (LON1 - LON0) * (GW - 1)))
    const cz0 = Math.max(0, Math.ceil((LAT1 - (tLat + 1)) / (LAT1 - LAT0) * (GH - 1)))
    const cz1 = Math.min(GH - 1, Math.floor((LAT1 - tLat) / (LAT1 - LAT0) * (GH - 1)))

    for (let gz = cz0; gz <= cz1; gz++) {
      const lat = LAT1 - gz / (GH - 1) * (LAT1 - LAT0)
      const fy = (lat - oy) / ry
      if (fy < 0 || fy > sh - 1) continue
      for (let gx = cx0; gx <= cx1; gx++) {
        const lon = LON0 + gx / (GW - 1) * (LON1 - LON0)
        const fx = (lon - ox) / rx
        if (fx < 0 || fx > sw - 1) continue
        // bilineárně — hrany dlaždic tak na sebe navazují bez schodů
        const x0 = Math.floor(fx), y0 = Math.floor(fy)
        const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1)
        const tx = fx - x0, ty = fy - y0
        const h =
          src[y0 * sw + x0] * (1 - tx) * (1 - ty) + src[y0 * sw + x1] * tx * (1 - ty) +
          src[y1 * sw + x0] * (1 - tx) * ty + src[y1 * sw + x1] * tx * ty
        const v = Math.max(0, Math.min(65535, Math.round(h)))
        out[gz * GW + gx] = v
        if (v < hmin) hmin = v
        if (v > hmax) hmax = v
        filled++
      }
    }
  }
}

// Zacelení děr: na hranách dlaždic pár buněk vypadne (zaokrouhlení oken).
// Nula = díra v terénu, tak ji doplníme průměrem sousedů.
for (let pass = 0; pass < 4; pass++) {
  let holes = 0
  for (let gz = 0; gz < GH; gz++) {
    for (let gx = 0; gx < GW; gx++) {
      if (out[gz * GW + gx] !== 0) continue
      let sum = 0, n = 0
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const z = gz + dz, x = gx + dx
          if (z < 0 || x < 0 || z >= GH || x >= GW) continue
          const v = out[z * GW + x]
          if (v) { sum += v; n++ }
        }
      }
      if (n) out[gz * GW + gx] = Math.round(sum / n)
      else holes++
    }
  }
  if (!holes) break
}

mkdirSync('public/terrain', { recursive: true })
writeFileSync('public/terrain/alps-far.bin', Buffer.from(out.buffer))
writeFileSync('public/terrain/alps-far.json', JSON.stringify({
  name: 'Alpy kolem Chamonix (daleký horizont)',
  lon0: LON0, lon1: LON1, lat0: LAT0, lat1: LAT1,
  gw: GW, gh: GH, hmin, hmax,
  source: 'Copernicus GLO-90 DEM (ESA), řádky od severu',
}, null, 2))

console.log(`hotovo: ${GW}×${GH}, vyplněno ${(filled / (GW * GH) * 100).toFixed(1)} %, ` +
  `výšky ${hmin}–${hmax} m, ${(out.byteLength / 1024).toFixed(0)} kB`)
