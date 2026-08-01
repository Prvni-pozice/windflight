# Windflight 🪂 — větroněm nad Mont Blankem

Browserová 3D hra: plachtění nad **reálným terénem Chamonix / Mont Blanc**
(Copernicus GLO-30 DEM, 35×31 km, 507–4805 m) se **skutečným dnešním počasím**
(Open-Meteo) a viditelným prouděním vzduchu. Úkol: proletět 5 bran nad
skutečnými místy (Brévent → La Flégère → Argentière → Plan de l'Aiguille →
Chamonix). Bez termiky a svahového proudění to nejde — měří se celkový čas.

## Čtení vzduchu (jádro hry)
- **Termika**: sloupce částic + kroužící ptáci + kumulus nad vrcholem stoupáku;
  komíny se s výškou naklánějí po větru, "domovské" termiky jsou vždy podél trati.
- **Svahové proudění**: vítr opřený do svahu zvedá (HUD šipka větru), závětří sráží.
- **Variometr**: pípá ve stoupání, houká v silném klesání; HUD má 20s průměr.

## Ovládání
- Desktop: šipky NEBO tažení myší (knipl), R restart, TAB minimapa.
- Mobil: náklon telefonu (dvojklep = rekalibrace), dvouprstý tap = minimapa.

## Fyzika
Polára (L/D ~42, min. opadání 0,58 m/s), výměna energie rychlost↔výška,
zatáčení náklonem (opadání roste), přetažení pod ~60 km/h, snos větrem.

## Stack a data
- Vite + Three.js, WebAudio (vario + šum větru). Port dev serveru **5185**.
- Terén: `scripts/fetch_terrain.mjs` (Copernicus GLO-30 z AWS Open Data →
  `public/terrain/chamonix.bin`, Uint16 metry, 640×576).
- Počasí: Open-Meteo (vítr 850 hPa, oblačnost, teplota), fallback bez API.
- Slunce dle reálného času (solární výpočet) → termika na osluněných svazích.
- Žebříček: `api/scores.js` (Vercel KV/Upstash, klíč `windflight-store`),
  anti-cheat HMAC token, jen jméno (bez e-mailu). Lokálně middleware ve
  `vite.config.js` (store `data/scores.json`).

## Testy (bez prohlížeče)
AI pilot letí trať nad reálným kódem hry (terén+proudění+fyzika): čte terén
po trase, vybírá termiky s čistou cestou, konturuje svahy, klesá na brány.
8 povětrnostních scénářů (slabý den, silný vítr, zataženo, ráno, jiné seedy)
— vše dokončitelné za 20–30 min. Skript: scratchpad `test_windflight.mjs`.

## Deploy (Vercel)
1. Vercel projekt (preset Vite) napojený na GitHub `Prvni-pozice/windflight`.
2. Storage → Upstash Redis (env `KV_REST_API_URL/TOKEN`) — stačí připojit
   stejnou DB jako u ostatních her (vlastní klíč `windflight-store`).
