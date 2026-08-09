// Připraví POKRYTÍ terénu — co na kterém místě doopravdy roste a leží.
//
// Dosud se les, skála i ledovec odhadovaly z výšky a sklonu. Výsledek byl
// pravděpodobný, ale ne pravdivý: les rostl i tam, kde je odjakživa holá
// mýtina, a Mer de Glace vypadalo jako obyčejný sníh. Tohle je stejný krok
// jako u terénu a horizontu — vzít skutečná data.
//
// Zdroj: ESA WorldCover 10 m (2021, v200), public S3 bez klíče.
// Třídy: 10 les · 20 křoviny · 30 travní porost · 40 pole · 50 zástavba
//        60 holá půda/skála · 70 sníh a led · 80 voda · 90 mokřad · 95 rákosí
// Výstup: public/terrain/chamonix-cover.bin (Uint8, mřížka jako chamonix.bin)
// Použití: node scripts/fetch_landcover.mjs
import { fromFile } from 'geotiff'
import { writeFileSync, mkdirSync, existsSync, statSync, readFileSync } from 'fs'
import { execFileSync } from 'child_process'

const meta = JSON.parse(readFileSync('public/terrain/chamonix.json', 'utf8'))
const { lon0, lon1, lat0, lat1, gw, gh } = meta

const CACHE = '/tmp/esa-worldcover'
mkdirSync(CACHE, { recursive: true })

/** Dlaždice WorldCover jsou po 3°, pojmenované levým dolním rohem. */
function tileFor(lat, lon) {
  const tLat = Math.floor(lat / 3) * 3
  const tLon = Math.floor(lon / 3) * 3
  const ns = tLat >= 0 ? 'N' : 'S'
  const ew = tLon >= 0 ? 'E' : 'W'
  return `ESA_WorldCover_10m_2021_v200_${ns}${String(Math.abs(tLat)).padStart(2, '0')}` +
    `${ew}${String(Math.abs(tLon)).padStart(3, '0')}_Map`
}

const name = tileFor(lat0, lon0)
const path = `${CACHE}/${name}.tif`
if (!existsSync(path) || statSync(path).size < 1e6) {
  const url = `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/${name}.tif`
  process.stdout.write(`stahuji ${name}… `)
  execFileSync('curl', ['-sfL', '-o', path, url], { timeout: 1800000 })
  console.log(`${(statSync(path).size / 1e6).toFixed(0)} MB`)
}

const img = await (await fromFile(path)).getImage()
const [ox, oy] = img.getOrigin()
const [rx, ry] = img.getResolution()

// okno dlaždice, které pokrývá herní mapu
const px0 = Math.floor((lon0 - ox) / rx), px1 = Math.ceil((lon1 - ox) / rx)
const py0 = Math.floor((lat1 - oy) / ry), py1 = Math.ceil((lat0 - oy) / ry)
console.log(`čtu okno ${px1 - px0}×${py1 - py0} px (10 m)`)
const raster = await img.readRasters({ window: [px0, py0, px1, py1] })
const src = raster[0], sw = raster.width, sh = raster.height

// Zmenšení na herní mřížku VĚTŠINOVÝM hlasováním, ne průměrem — průměr
// z čísel tříd by dal nesmysl (les 10 + voda 80 = "něco kolem 45").
const out = new Uint8Array(gw * gh)
const votes = new Map()
for (let gz = 0; gz < gh; gz++) {
  const sy0 = Math.floor(gz / gh * sh), sy1 = Math.max(sy0 + 1, Math.floor((gz + 1) / gh * sh))
  for (let gx = 0; gx < gw; gx++) {
    const sx0 = Math.floor(gx / gw * sw), sx1 = Math.max(sx0 + 1, Math.floor((gx + 1) / gw * sw))
    votes.clear()
    for (let y = sy0; y < sy1; y++) {
      for (let x = sx0; x < sx1; x++) {
        const v = src[y * sw + x]
        if (!v) continue
        votes.set(v, (votes.get(v) || 0) + 1)
      }
    }
    let best = 30, bestN = 0
    for (const [v, n] of votes) if (n > bestN) { bestN = n; best = v }
    out[gz * gw + gx] = best
  }
}

const counts = {}
for (const v of out) counts[v] = (counts[v] || 0) + 1
const NAMES = { 10: 'les', 20: 'křoviny', 30: 'tráva', 40: 'pole', 50: 'zástavba', 60: 'skála/holá', 70: 'sníh a led', 80: 'voda', 90: 'mokřad', 95: 'rákosí', 100: 'mech' }

mkdirSync('public/terrain', { recursive: true })
writeFileSync('public/terrain/chamonix-cover.bin', Buffer.from(out.buffer))
console.log(`hotovo: ${gw}×${gh}, ${(out.byteLength / 1024).toFixed(0)} kB`)
for (const [v, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${(NAMES[v] || v).padEnd(12)} ${(n / out.length * 100).toFixed(1)} %`)
}
