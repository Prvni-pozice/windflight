// Připraví herní terén z Copernicus GLO-30 DEM (1 arcsec ≈ 30 m).
// Vstup: GeoTIFF dlaždice Copernicus_DSM_COG_10_N45_00_E006_00_DEM.tif
//   (https://copernicus-dem-30m.s3.amazonaws.com/ — public, bez klíče)
// Výstup: public/terrain/chamonix.bin (Uint16 metry, row-major od SZ rohu)
//         public/terrain/chamonix.json (metadata oblasti)
// Použití: node scripts/fetch_terrain.mjs /cesta/k/dlaždici.tif
import { fromFile } from 'geotiff'
import { writeFileSync, mkdirSync } from 'fs'

const TIF = process.argv[2]
if (!TIF) { console.error('chybí cesta k .tif'); process.exit(1) }

// Herní oblast: masiv Mont Blancu + údolí Chamonix
const LON0 = 6.55, LON1 = 7.0    // západ→východ
const LAT0 = 45.72, LAT1 = 46.0  // jih→sever
const GW = 640, GH = 576         // výstupní mřížka (sloupce × řádky)

const tif = await fromFile(TIF)
const img = await tif.getImage()
const [ox, oy] = img.getOrigin()          // levý horní roh (lon, lat)
const [rx, ry] = img.getResolution()      // stupně/pixel (ry záporné)
const px0 = Math.round((LON0 - ox) / rx)
const px1 = Math.round((LON1 - ox) / rx)
const py0 = Math.round((LAT1 - oy) / ry)  // sever = menší řádek
const py1 = Math.round((LAT0 - oy) / ry)
console.log(`okno px: x ${px0}..${px1}, y ${py0}..${py1}`)

const raster = await img.readRasters({ window: [px0, py0, px1, py1] })
const src = raster[0], sw = raster.width, sh = raster.height

// bilineární převzorkování na GW×GH
const out = new Uint16Array(GW * GH)
let hmin = Infinity, hmax = -Infinity
for (let gy = 0; gy < GH; gy++) {
  for (let gx = 0; gx < GW; gx++) {
    const fx = gx / (GW - 1) * (sw - 1)
    const fy = gy / (GH - 1) * (sh - 1)
    const x0 = Math.floor(fx), y0 = Math.floor(fy)
    const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1)
    const tx = fx - x0, ty = fy - y0
    const h =
      src[y0 * sw + x0] * (1 - tx) * (1 - ty) + src[y0 * sw + x1] * tx * (1 - ty) +
      src[y1 * sw + x0] * (1 - tx) * ty + src[y1 * sw + x1] * tx * ty
    const v = Math.max(0, Math.round(h))
    out[gy * GW + gx] = v
    if (v < hmin) hmin = v
    if (v > hmax) hmax = v
  }
}

// rozměry v metrech
const latMid = (LAT0 + LAT1) / 2
const widthM = (LON1 - LON0) * 111320 * Math.cos(latMid * Math.PI / 180)
const heightM = (LAT1 - LAT0) * 110574

mkdirSync('public/terrain', { recursive: true })
writeFileSync('public/terrain/chamonix.bin', Buffer.from(out.buffer))
writeFileSync('public/terrain/chamonix.json', JSON.stringify({
  name: 'Chamonix / Mont Blanc',
  lon0: LON0, lon1: LON1, lat0: LAT0, lat1: LAT1,
  gw: GW, gh: GH,
  widthM: Math.round(widthM), heightM: Math.round(heightM),
  hmin, hmax,
  source: 'Copernicus GLO-30 DEM (ESA), řádky od severu',
}, null, 2))
console.log(`OK: ${GW}×${GH}, ${Math.round(widthM / 1000)}×${Math.round(heightM / 1000)} km, výšky ${hmin}–${hmax} m`)
