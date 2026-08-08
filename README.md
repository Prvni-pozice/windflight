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
- Desktop: šipky NEBO tažení myší (knipl) nebo gamepad, R restart,
  TAB minimapa, ESC pauza, C kokpit.
- Mobil: **náklon telefonu** (dvojklep = rekalibrace) nebo **knipl prstem** —
  přepíná se za letu tlačítkem vpravo dole, stejně jako směr výšky (⇅),
  pohled (👁) a pauza (⏸). Dvouprstý tap = minimapa.
- Směr výšky: výchozí je **náklon/tah k sobě = nos nahoru, stoupám**
  (`invertY = false` v `src/settings.js`), tedy klasika jako knipl.
  Že to dřív působilo obráceně, nezpůsobilo mapování vstupu, ale **opačné
  znaménko při kreslení sklonu modelu** (nos modelu míří na −z, takže
  `rotateX(+theta)` ho zvedal, přestože `theta > 0` je nos dolů). Vizuál
  a fyzika si tak odporovaly. Hlídají to testy — hlavně
  `tests/pitch-consistency.test.mjs`, který kontroluje vstup, fyziku
  i natočení modelu najednou.
- Volby (režim, směr, citlivost náklonu, kvalita grafiky, kamera) se ukládají
  do localStorage — panel ⚙ na úvodní obrazovce i v pauze.

## Co hráči pomáhá
- **Doklouzání** u brány: ▲ +180 m = doletím s rezervou, ▼ = tolik chybí
  (⛰ = limituje hřeben po trase, ne brána samotná). Počítá se s polárou
  i se složkou větru do směru letu.
- **Varování před terénem** (GPWS): sonda 8 s po dráze letu, houkání a vibrace.
- **Pauza**: ESC / ⏸ a automaticky při odchodu z okna; čas letu se sčítá
  z kroků simulace, takže pauza se do výsledku nezapočítá.
- **Volný let** (trénink bez bran) a po nárazu **pokračování od poslední
  brány** — takový let je označený jako mimo žebříček.

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
`npm test` — směr a režimy ovládání (`tests/controls.test.mjs`, i portrét)
a soulad vstup ↔ fyzika ↔ kresba modelu (`tests/pitch-consistency.test.mjs`).
Stub prohlížeče, žádné závislosti navíc.

AI pilot letí trať nad reálným kódem hry (terén+proudění+fyzika): čte terén
po trase, vybírá termiky s čistou cestou, konturuje svahy, klesá na brány.
8 povětrnostních scénářů (slabý den, silný vítr, zataženo, ráno, jiné seedy)
— vše dokončitelné za 20–30 min. Skript: scratchpad `test_windflight.mjs`.

## Deploy (Vercel)
Živě na **https://windflight.vercel.app** — Vercel projekt (preset Vite) je
napojený na GitHub `Prvni-pozice/windflight`, push do `master` = deploy.
Ovládání náklonem funguje jen tady (DeviceOrientation vyžaduje HTTPS),
na lokálním dev serveru na portu 5185 naskočí knipl prstem.

Žebříček potřebuje Storage → Upstash Redis (env `KV_REST_API_URL/TOKEN`) —
lze sdílet stejnou DB jako ostatní hry (vlastní klíč `windflight-store`).
