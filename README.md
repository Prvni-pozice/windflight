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
- Desktop: šipky (**↓ přitáhnout = stoupat**, ↑ potlačit) NEBO tažení myší
  (knipl) nebo gamepad, R restart, TAB minimapa, ESC pauza, C kokpit.
- Mobil: **náklon telefonu** (dvojklep = rekalibrace) nebo **knipl prstem** —
  přepíná se za letu tlačítkem vpravo dole, stejně jako směr výšky (⇅),
  pohled (👁) a pauza (⏸). Dvouprstý tap = minimapa.
- Směr výšky: výchozí je **přitažení = nos nahoru, stoupám**
  (`invertY = false` v `src/settings.js`), tedy klasika jako knipl.
  Přitažení znamená: telefon/prst k sobě, myš dolů, páčka k sobě, šipka ↓.
  Řídí to JEDNO znaménko (`s` v `getInput`) pro všechny vstupy a přepínač ⇅
  je od 27. 8. 2026 i na desktopu (⚙ Nastavení). Dřív měla klávesnice směr
  opačný než zbytek hry a přepínač na ni nesahal.
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

## Grafika (přestavba 8. 8. 2026, ověřená screenshoty)
- **Světlo**: stínuje jen skutečné slunce. Dřív se stínovalo dvakrát
  (zapečený hillshade × Lambert) a scéna byla přepálená do sytě zelené.
- **Barvy terénu**: alpská hypsometrie — sněžná čára i horní hranice lesa
  jdou výš na jižních svazích (`nz` normály), mezi holemi a skálou je suť.
- **Okluze oblohy** zapečená z heightmapy (8 směrů do 2,6 km): údolí ztmavne,
  hřebeny vystoupí. Na sněhu se tlumí — bílý povrch nemá černé stíny.
- **Vzdušná perspektiva**: FogExp2 v barvě, kterou má i obzor na obloze
  (uniforma `uHorizon`), takže mezi horami a nebem není šev.
- **Daleký horizont**: skutečné Alpy do ~120 km, viz `src/far-terrain.js`.
- **Kumuly** mají plochou základnu a květákový vršek, vlastní shader
  (vršek svítí, základna šedomodrá) místo průsvitného Lambertu.
- **Vržené stíny** hřebenů podle skutečné polohy slunce (paprsek nad
  heightmapou, zapečený do atributu vrcholu) + **stíny kumulů** promítnuté
  pod slunečním úhlem. Násobí se jen do přímého světla, takže stín zůstává
  modrý a prokreslený. Stíny mraků zároveň prozrazují, kde je termika.
- **Post-processing** (jen vysoká kvalita): záře, barevné doladění, FXAA.
  Pořadí průchodů je zásadní — `OutputPass` za září a před doladěním.
  Vlastní shadery (obloha, mraky) musí projít stejným tónovým mapováním
  jako zbytek scény, jinak s efekty vyblednou.
- **Skutečné pokrytí** (ESA WorldCover 10 m): les roste tam, kde roste,
  ledovce jsou ledovce, Arve je v údolí vidět. Řídí barvu terénu i to,
  kam se sázejí stromy. Ledovce mají modravé příčné pruhy trhlin tam,
  kde tečou (mírný sklon).
- **Nálada dne** (`src/atmosphere.js`, vše jen vizuální, fyziku nemění):
  - ranní **inverze** — moře mlhy v údolích (dopoledne, nízké slunce,
    slabý vítr), dvě šumové hladiny s driftem po větru;
  - **cirry** podle skutečné vysoké oblačnosti (`cloud_cover_high`);
  - **dešťové clony** od základny mraků k zemi, když v Chamonix prší
    (`precipitation`), opřené do větru, s tmavým mrakem nahoře;
  - **sněžné vlajky** z hřebenů nad ~3750 m při větru ≥ 5 m/s (GPU částice);
  - **sluneční glare** s ručním zákrytem terénem (za hřebenem zhasne).
- **Stříbrné lemování mraků**: přes mrak proti slunci prosvítá obrys
  (rim + protisvětlo ve shaderu mraku, bloom si ho rozzáří).
- **Pohyblivé stíny mraků**: mapa stínů kumulů se každé ~4 s přepéká,
  takže stíny plují krajinou s mraky (drift mezi snímky je pod desetinou
  poloměru stínu — skok není vidět).
- **Třpyt vody**: sluneční odlesk na Arve a jezerech (třída voda
  z WorldCoveru, spec ve vlastní větvi Lambert shaderu terénu).
- **Lens flare duchové**: barevné kotoučky na ose slunce—střed obrazu,
  svázané s glarem (za hřebenem zhasnou).
- **Duha**: když prší a slunce je pod ~40°, na protisluneční straně
  (42° kruh, hory ji zakrývají). Normální průhlednost, ne additive —
  na syté modré obloze aditivní míchání červenou nevyrobí.
- **Šťavnatá krajina** (kolo 2 palety): sytější vegetace, velké laloky
  svěží vs. sušší louky (~1,5 km šum), jižní svahy do teplé žluti a
  severní chladnější, vřesové fleky nad hranicí lesa, barevná variace
  stromů per instance (instanceColor), světlejší detailní šum (tmavý
  špinil barvy), mírně teplejší slunce + vibrance v grade shaderu.
- **Objem v kumulech** (kolo 3): silueta se odhryzává 3D šumem ve světových
  metrech (`uErode` v `cloudMaterial`) — jen na obrysu, uvnitř by mrak
  prosvítal. Stejný šum jde i do barvy, takže chuchvalce mají vlastní
  světlo a stín.
- **Tepelné chvění** nad stoupákem (jen vysoká kvalita, `ShimmerShader`
  v `src/postfx.js`): sloupce dodává `_shimmerCols()` v `main.js` v uv
  souřadnicích. Vidět je z pár set metrů — uvnitř termiky není proti čemu
  ho poměřit, z dálky splyne s oparem.
- **Světla Chamonix** za soumraku (`src/scenery.js`): okna se rozsvítí pod
  7° výšky slunce, barva je nad jedničkou, aby přetekla do záře.
- **Kondenzační pás** letadla v hladině (`_buildContrail`): stuha se kreslí
  celá dopředu a odkrývá ji `uProg`, stáří jí řídí šířku i rozpad.
- **Zvířený sníh** při průletu pod 26 m nad ledovcem (`src/spray.js`),
  spouští ho třída pokrytí 70 (trvalý led) nebo výška nad 3 050 m.
- Ladění bez čekání na počasí (URL): `?cas=8:00` (UTC),
  `?mraky=70&cirry=80&dest=2&vitr=9&inverze=0.9`, `?debug` → `window.__wf`.

## Stack a data
- Vite + Three.js, WebAudio (vario + šum větru). Port dev serveru **5185**.
- Terén: `scripts/fetch_terrain.mjs` (Copernicus GLO-30 z AWS Open Data →
  `public/terrain/chamonix.bin`, Uint16 metry, 640×576).
- Pokrytí: `scripts/fetch_landcover.mjs` (ESA WorldCover 10 m 2021 →
  `public/terrain/chamonix-cover.bin`, Uint8 třídy na mřížce terénu, 360 kB;
  zmenšuje se většinovým hlasováním, ne průměrem — průměr čísel tříd nedává
  smysl). Chamonix: 35 % tráva, 34 % les, 14 % trvalý sníh a led, 12 % skála.
- Horizont: `scripts/fetch_far_terrain.mjs` (Copernicus GLO-90, 12 dlaždic →
  `public/terrain/alps-far.bin`, 384×352, ≈650 m/buňku, 264 kB). Používá
  stejný přepočet stupňů na metry jako blízká mapa, takže na ni navazuje;
  uvnitř mapy se zanořuje pod ni, aby nikde neprobleskla.
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
