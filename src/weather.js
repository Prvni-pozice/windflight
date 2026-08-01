// weather.js — skutečné počasí pro Chamonix z Open-Meteo (zdarma, bez klíče).
// Když API nejde (offline, limit), letí se záložní pěkný den — hra funguje vždy.
import * as THREE from 'three'

const LAT = 45.9237, LON = 6.8694

export async function loadWeather() {
  const fallback = {
    live: false,
    windSpeed: 4.5,        // m/s v hladině hřebenů
    windDirDeg: 300,       // odkud fouká (meteorologicky) — SZ
    cloudCover: 0.3,
    temp: 18,
    label: 'záložní scénář (API nedostupné)',
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
      '&current=temperature_2m,cloud_cover,wind_speed_10m,wind_direction_10m' +
      '&hourly=wind_speed_850hPa,wind_direction_850hPa&forecast_hours=1&wind_speed_unit=ms&timezone=auto'
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d = await r.json()
    const cur = d.current
    // vítr ve výšce hřebenů (850 hPa ≈ 1500 m) je pro plachtění směrodatnější
    const w850s = d.hourly?.wind_speed_850hPa?.[0]
    const w850d = d.hourly?.wind_direction_850hPa?.[0]
    return {
      live: true,
      windSpeed: Math.max(1, w850s ?? cur.wind_speed_10m * 1.6),
      windDirDeg: w850d ?? cur.wind_direction_10m,
      cloudCover: (cur.cloud_cover ?? 30) / 100,
      temp: cur.temperature_2m ?? 15,
      label: `živé počasí ${new Date().toLocaleDateString('cs-CZ')}`,
    }
  } catch {
    return fallback
  }
}

/** Odvozené letové parametry dne. Termika má vždy hratelné minimum. */
export function deriveConditions(w, sunElevDeg) {
  const sunFactor = Math.max(0, Math.min(1, sunElevDeg / 38)) // slunce nízko = slabá termika
  const cloudFactor = 1 - 0.55 * w.cloudCover
  const thermalStrength = Math.max(3.5, 6.5 * sunFactor * cloudFactor) // m/s v jádru (min. hratelné)
  const cloudBase = Math.round(2900 + 900 * (1 - w.cloudCover) + (w.temp - 10) * 25)
  // vektor větru: meteorologický směr = ODKUD fouká; svět: x=východ, z=jih
  const rad = (w.windDirDeg + 180) * Math.PI / 180 // kam fouká
  // čepice 7 m/s: reálný orkán by hru zabil — směr zůstává reálný, síla hratelná
  const windVec = new THREE.Vector3(Math.sin(rad), 0, -Math.cos(rad)).multiplyScalar(Math.min(7, w.windSpeed))
  return { thermalStrength, cloudBase: Math.min(4100, Math.max(2600, cloudBase)), windVec }
}

/** Poloha slunce pro daný čas v Chamonix (přibližný solární výpočet). */
export function sunPosition(date = new Date()) {
  const rad = Math.PI / 180
  const days = (date - new Date(date.getFullYear(), 0, 0)) / 86400000
  const decl = -23.44 * Math.cos((360 / 365) * (days + 10) * rad) // deklinace
  const solarTime = date.getUTCHours() + date.getUTCMinutes() / 60 + LON / 15
  const hourAng = (solarTime - 12) * 15
  const elev = Math.asin(
    Math.sin(decl * rad) * Math.sin(LAT * rad) +
    Math.cos(decl * rad) * Math.cos(LAT * rad) * Math.cos(hourAng * rad),
  ) / rad
  const az = Math.atan2(
    Math.sin(hourAng * rad),
    Math.cos(hourAng * rad) * Math.sin(LAT * rad) - Math.tan(decl * rad) * Math.cos(LAT * rad),
  ) / rad + 180 // azimut od severu po směru hodin
  return { elevDeg: elev, azimuthDeg: az }
}

/** Směr KE slunci ve světových osách (x=východ, z=jih), pro světlo a termiku. */
export function sunDirVector(sun) {
  const el = Math.max(6, sun.elevDeg) * Math.PI / 180 // v noci drž nízké slunce, ať je vidět
  const az = sun.azimuthDeg * Math.PI / 180
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize()
}
