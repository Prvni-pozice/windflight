# Windflight — zadání pro znovupostavení

Specifikace browserové 3D hry o plachtění nad reálným terénem Chamonix.
Napsaná tak, aby podle ní šlo projekt postavit znovu od nuly — bez přístupu
k původnímu kódu.

Čísla v dokumentu jsou závazná: jsou to hodnoty, na které se hra doladila
během čtyř měsíců iterací, ne odhady. Kde je uvedeno **PROČ**, jde o poučení
z chyby, která se ve vývoji skutečně stala — ty odstavce jsou nejcennější
částí zadání.

Jednotky: délka m, rychlost m/s, čas s, úhly rad (kde je °, jde o stupně).

---

## 1. Co se staví

Prohlížečová 3D hra: hráč pilotuje výkonný větroň nad **reálným terénem
Chamonix / Mont Blanc** (Copernicus DEM, 35 × 31 km, 507–4805 m n. m.) za
**skutečného dnešního počasí** (Open-Meteo). Motor žádný — výška se dá získat
jen čtením proudění vzduchu.

Úkol: proletět 5 bran nad skutečnými místy (Brévent → La Flégère →
Argentière → Plan de l'Aiguille → Chamonix) v co nejkratším čase. Výsledek jde
do žebříčku.

Jádro zážitku je **čtení vzduchu**, ne pilotáž. Hráč musí v krajině poznat,
kde se dá stoupat: termika je vidět (částice, kroužící ptáci, kumulus nad
stoupákem, stín mraku na zemi), svahové proudění se pozná podle větru
opřeného do svahu. Bez využití obojího se trať doletět nedá.

Cílové platformy: desktop (klávesnice, myš, gamepad) i mobil (náklon telefonu
nebo virtuální knipl). Mobil není druhořadý — ovládání náklonem je hlavní
způsob hraní na telefonu a řeší se mu vlastní kalibrace a filtrace.

---

## 2. Stack a struktura

- **Vite** (dev i build), **Three.js** ~0.170, **WebAudio**. Žádný framework,
  žádný state management, žádný TypeScript.
- Dev server na portu **5185**.
- Jediná produkční závislost je `three`. Vývojové: `vite`, `geotiff`
  (jen pro stahovací skripty, do bundlu nejde).
- Build vychází na ~640 kB JS + ~1,4 MB binárních dat terénu.

Rozvržení modulů (jeden soubor = jedna zodpovědnost, celkem ~6100 řádků):

    src/main.js         herní smyčka, orchestrace subsystémů
    src/glider.js       letová fyzika a model kluzáku
    src/controls.js     všechny vstupy sjednocené do jedné dvojice pitch/roll
    src/settings.js     persistence voleb v localStorage
    src/terrain.js      stavba meshe, barvení, zapékané stíny a okluze
    src/far-terrain.js  vzdálený horizont Alp
    src/lift.js         model termiky a svahového proudění + kumuly
    src/weather.js      Open-Meteo, poloha slunce
    src/gates.js        trať a brány
    src/atmosphere.js   nálada dne (inverze, cirry, déšť, duha, vlajky, glare)
    src/postfx.js       post-processing
    src/trees.js        instancovaný les
    src/scenery.js      světla města, kondenzační pás letadla
    src/spray.js        zvířený sníh nad ledovcem
    src/vario.js        zvuk (variometr, vítr, GPWS)
    src/ui.js           HUD, minimapa, panel nastavení
    src/leaderboard.js  klient žebříčku
    scripts/*.mjs       jednorázové stahovače dat (mimo runtime)
    api/*.js            serverless endpointy žebříčku
    tests/*.mjs         testy bez prohlížeče

---

## 3. Letová fyzika

### 3.1 Konstanty

    G             9,81 m/s²    jediná fyzikální konstanta
    V_MIN_SINK    23 m/s       rychlost minimálního opadání (~83 km/h)
    V_STALL       16,5 m/s     pádová rychlost (~59 km/h)
    V_MAX         58 m/s       strop rovnovážné rychlosti (~209 km/h)
    SINK_MIN      0,58 m/s     opadání při V_MIN_SINK
    počáteční v   28 m/s

Hmotnost, plocha křídla, hustota vzduchu ani součinitele vztlaku v modelu
**nejsou**. Polára je empirická křivka výkonného laminátu, hmotnostně
nezávislá — neodvozuj ji z aerodynamiky.

### 3.2 Polára

    polarSink(v) = 0,58 + k · (v − 23)²
      k = 0,0042  pro v > 23 m/s
      k = 0,010   pro v ≤ 23 m/s

Asymetrie je záměrná: pod rychlostí minimálního opadání výkon padá rychleji.
Maximální klouzavost vychází **42,1 při ~25,8 m/s**, ne při V_MIN_SINK — přesně
jak se chová reálná polára. Funkce se nikde neomezuje, volá se i mimo rozsah.

Kontrolní hodnoty (rychlost → opadání → klouzavost):

    16,5 → 1,00 → 16,5
    23   → 0,58 → 39,7
    25,8 → 0,61 → 42,1   ← maximum
    30   → 0,79 → 38,2
    44   → 2,43 → 18,1
    58   → 5,73 → 10,1

### 3.3 Podélná dynamika

**Klíčové rozhodnutí:** vstup neřídí přímo úhel stoupání, ale podélný sklon
`theta`, a ten určuje **cílovou rychlost**. Výška je až důsledek výměny energie
a poláry. Bez tohohle mezikroku hra ztratí pocit setrvačnosti.

Účinnost kormidel podle dynamického tlaku:

    eff = min(1, (v / 24)²)

Plná od 24 m/s, při pádové 0,47, při 12 m/s 0,25. Pod pádovkou jsou kormidla
měkká a kontrola se vrací až s rychlostí.

Cílový sklon a jeho náběh (dvojí omezení — nejdřív exponenciála, pak rate limit,
aby letadlo nikdy necvaklo do nové polohy):

    thetaTarget = pitch · 0,40 rad            (±22,9° při plné výchylce)
    dTh     = (thetaTarget − theta) · min(1, dt · 2,0)      časová konstanta 0,5 s
    maxRate = 0,85 · (0,3 + 0,7 · eff) rad/s               0,255 až 0,85 rad/s
    dTh     = clamp(dTh, ±maxRate · dt)
    theta  += dTh

Rovnovážná rychlost pro sklon (lineární, laděná, ne fyzikální):

    vEq = clamp(27 + (theta / 0,40) · 17, 9, 58)

Náběh rychlosti s omezeným zrychlením (strop ≈ 1/3 g — větroň není auto):

    accel = clamp((vEq − v) · 0,45, ±3,2) m/s²    časová konstanta 2,22 s
    v += accel · dt

### 3.4 Výměna energie

    zoom = −(v · dv) / G     [m]

Přesná diferenciální forma zachování energie, přičítá se k výšce ve stejném
kroku, ve kterém se změnila rychlost. Zrychlení stojí výšku okamžitě, brzdění
ji vrací.

**Pozor na definici varia:** hlášená hodnota obsahuje jen vzduchovou složku
(`lift − sink + stallSink`), **nikoli zoom**. Skutečná změna výšky je
`wAir · dt + zoom`. Je to tedy vario netto vzduchové hmoty, ne totální energie —
při plném přitažení kluzák za 3 s stoupne o 19,9 m, zatímco vario ukazuje
−0,75 m/s. Kdo chce klasické totální vario, přičte `zoom/dt`.

### 3.5 Zatáčka

    bankTarget = roll · 0,96 rad (55°) · (přetažení ? 0,25 : 1)
    bank += (bankTarget − bank) · min(1, dt · (0,7 + 2,6 · eff))
    if (v > 4) heading += G · tan(bank) / v · dt

Časová konstanta náklonu 0,30 s při plné rychlosti, 1,43 s při nulové
účinnosti. Pod 4 m/s se kurz nemění (ochrana proti dělení malým číslem).
Kurz se nenormalizuje do 0–2π.

Opadání v zatáčce:

    sink = polarSink(v) · (1 / max(0,35, cos(bank)))^1,5

Exponent 1,5 odpovídá tomu, že vztlak roste jako 1/cos φ a indukovaný odpor
jako přetížení^1,5. Clamp na cos ≥ 0,35 je pojistka; z běžného vstupu se náklon
zastaví na 55°, kde je násobič 2,30.

Referenčně: plný náklon při 27 m/s dá 29,7°/s, plnou otočku za 12,1 s,
poloměr ~52 m.

### 3.6 Přetažení

Vstup: `v < V_STALL` a kluzák ještě není přetažený → `stalled = 2,4 s`.

Během přetažení:

- `thetaTarget` je natvrdo 0,5 rad (nos dolů), hráčův pitch se ignoruje —
  nos padá sám a kluzák razantně zrychluje (vEq vychází 48,25 m/s)
- náklon má jen 25 % autority
- buffet v řízení: `bank += sin(t · 0,006) · 0,22 · dt` (~0,95 Hz)
- vizuální třepání: k rotaci se přičítá `0,08 · sin(t · 0,008)` rad
- propad −2,8 m/s, ale nabíhá plynule (`+= (cíl − stav) · min(1, dt · 2,2)`) —
  odtržení proudění není skokové, nesmí to cuknout
- zkrácení zotavení: při `v > V_STALL + 3` a `stalled > 0,6` nastav
  `stalled = 0,6`

Filozofie: zotavení až když je rychlost zpět a odezní to — žádné skákání
nahoru-dolů jako v hračce. Při trvale drženém plném přitažení se model ustálí
v cyklu přetažení/zotavení kolem 18–19 m/s a klesá.

### 3.7 Pohyb a kolize

    wAir = lift − sink + stallSink
    pos.x += (sin(heading) · v + wind.x) · dt
    pos.z += (−cos(heading) · v + wind.z) · dt
    pos.y += wAir · dt + zoom

Vítr je **čistý snos**: přičítá se k poloze, neovlivňuje vzdušnou rychlost ani
kurz. Svislá složka větru se ignoruje — veškeré stoupání jde přes `lift`
z modelu proudění. Vítr je v projektu omezen na 7 m/s.

Kolize: pod `terén + 1,2 m` se poloha přichytí na tuto výšku a nastaví
`crashed`; fyzika pak stojí až do resetu. Žádné poškození ani odskok.

### 3.8 Stavový vektor a orientace os

Kluzák drží: `pos` (Vector3, metry), `heading` (rad), `bank` (rad, kladně
doprava), `theta` (rad), `v` (m/s, vzdušná), `vario` (m/s), `stalled` (s),
`crashed` (bool) a interní vyhlazený `stallSink`.

    +y = nahoru,  −z = sever,  +x = východ
    nos modelu míří na −z
    theta > 0 = NOS DOLŮ

Znaménko `theta` je opačné, než na jaké je člověk zvyklý z leteckých konvencí.
To je nejčastější zdroj chyb v celém projektu — viz sekce 4.2.

Kresba modelu, pořadí rotací je závazné:

    model.rotateY(−heading)
    model.rotateX(−theta · 1,15 + buffet)
    model.rotateZ(−bank)

Násobič 1,15 je vizuální nadsázka sklonu pro čitelnost v chase kameře, nemá
fyzikální význam.

### 3.9 Geometrie modelu

Rozpětí 15 m, trup kapsle r 0,42 m / délka 6,4 m, nos na z = −3,6 m, křídla
7,4 × 0,13 × 1,05 m se vzepětím 0,055 rad, T-ocas (kýl na y 0,8, z 3,2;
stabilizátor 3,1 × 0,09 × 0,7 m).

**Stín na terénu je zásadní pro odhad výšky nad zemí** — plocha 16 × 16 m ve
výšce terén + 1,5 m, otočená s kurzem, měřítko `1 + AGL/90`, krytí
`max(0,25; 1 − AGL/900)`.

Vlečky z konců křídel: 50 bodů historie na křídlo, zapnou se při `v > 36 m/s`
nebo `|bank| > 0,72 rad`.

---

## 4. Ovládání

### 4.1 Vstupní režimy

Všechny zdroje se **sčítají** do jedné dvojice `pitch`/`roll` a až pak
ořezávají na ±1. Nejsou vzájemně exkluzivní (kromě náklonu, který je vázaný na
režim).

- **Klávesnice:** ↑/↓ pitch, ←/→ nebo A/D roll, R reset. Čte se `e.code`.
- **Myš jako knipl:** držení levého tlačítka + tažení, normalizace dělením 160 px.
  Gesta začínající nad `.overlay`, `button`, `input` nebo `#hud` se ignorují.
- **Dotykový knipl:** knipl se objeví tam, kde prst dosedne, normalizace 70 px,
  vizuální knoflík ±34 px. Sleduje se konkrétní touch identifier.
- **Gamepad:** osy 0 a 1, tvrdá mrtvá zóna 0,15.
- **Náklon telefonu:** viz 4.3.

Gesta navíc: dvojklep (dva touchend do 320 ms) = rekalibrace náklonu,
dvouprstý tap = přepnutí minimapy.

### 4.2 Znaménko výšky — PROČ je to jediné místo

Konvence: `pitch < 0` = přitažení = nos nahoru. Výchozí `invertY = false`
znamená „jako knipl": pohyb k sobě zvedá nos.

V `getInput()` se spočítá **jediný násobič** a projde jím každý zdroj pitche:

    s = invertY ? −1 : 1

    myš:        pitch += s · clamp(−mouse.dy)
    knipl:      pitch += −s · stick.dy
    gamepad:    pitch += −s · dz(axes[1])
    klávesnice: ↑ → pitch += s      ↓ → pitch −= s
    náklon:     pitch += −s · (odchylka od neutrálu)

**Kdo sem sáhne, ať přepíše `s`, ne jednotlivé řádky — jinak se zase rozejdou.**

Ve vývoji se tady staly dvě různé chyby, které se navzájem maskovaly. Obě stojí
za popsání, protože obě lákaly ke špatné opravě:

**Chyba A — rozejití vstupů.** Klávesnice dlouho porušovala konvenci (↑ = nos
nahoru, tedy opačně než myš, knipl i telefon) a přepínač směru na ni vůbec
nesahal, na desktopu se ani nezobrazoval. Na PC to působilo, že je hra obráceně
a nejde s tím nic dělat. Než otočíš znaménko, ověř, jestli si vstupy neodporují
navzájem — a jestli má hráč vůbec šanci si to přepnout.

**Chyba B — rozejití fyziky a kresby.** Nos modelu míří na −z, takže
`rotateX(+a)` nos **zvedá**. Ale `theta > 0` znamená nos **dolů**. Původní kód
kreslil `rotateX(+theta)`, takže hráč viděl letadlo v nose nahoru, zatímco
fyzika zrychlovala a klesala. Zákeřné bylo, že to vypadalo jako špatné mapování
vstupu a lákalo to k „opravě" otočením `invertY` — to by opravilo pocit, ale
prohodilo konvenci pro všechny ostatní vstupy. Skutečná oprava je mínuska
v kresbě.

Pravidlo: znaménko pitche žije ve **třech vrstvách** — vstup (`s`), fyzika
(`theta → vEq`), kresba (`rotateX`) — a všechny tři se musí ověřovat najednou.
Na to je test v sekci 11.

### 4.3 Náklon telefonu — proč ne syrové beta/gamma

Eulerovy úhly z DeviceOrientation se při větším náklonu překlápějí (gamma umí
skočit +85° → −85°). Na šířku je gamma zdrojem pitche, takže při přitažení se
vstup náhle obrátil a „nešel zvednout čumák".

Řešení: počítá se **gravitační vektor v souřadnicích zařízení**

    g_d = (−cos β · sin γ,  sin β,  cos β · cos γ)

(třetí řádek matice Rz(α)Rx(β)Ry(γ); kompas α na něj nemá vliv). Libovolná
Eulerova reprezentace téže polohy dá stejný vektor, takže je vůči ambiguitě
imunní.

Otočení do os obrazovky podle `screen.orientation.angle` (W3C angle je otočení
proti směru hodinových ručiček):

    xs = gx · cos θ − gy · sin θ
    ys = gx · sin θ + gy · cos θ
    b  = atan2(ys, gz)                  → pitch
    g  = atan2(−xs, hypot(ys, gz))      → roll, saturuje u ±90°

`atan2` s `hypot` nikdy nepřeskočí — to je celý smysl konstrukce.

### 4.4 Filtrace a citlivost

- **Dolní propust** na náklonu: exponenciální filtr 0,25 na vzorek (~70 ms).
  Bez ní se kluzák sám kolébal podle toho, jak hráč dýchá.
- **Kalibrace neutrálu je průměr 45 vzorků**, ne jediný odečet. Jediný odečet na
  časovači po kliknutí chytal ještě pohyb ruky a dialog s oprávněním, a na šířku
  dával špatný neutrál — letadlo pak samo zatáčelo. Během kalibrace náklon
  neřídí.
- **Měkká mrtvá zóna** 1,5°: `dz(v) = sign(v) · max(0, |v| − 1,5)`. Není to práh
  se skokem, na hranici nic necukne.
- **Rozsah plné výchylky:** pitch 44°/sens, roll 50°/sens. Citlivost 0,6–1,8.
- **Tvarovací křivka** společná pro všechny vstupy, až po sečtení:
  `shape(v) = sign(v) · |v|^1,8`. Měkčí střed pro klidný přímý let, plná síla
  u velkých výchylek, bez skoku na hranici.

### 4.5 Persistence a oprávnění

Jeden JSON klíč `windflight-settings` v localStorage: `invertY` (false),
`tiltSens` (1), `controlMode` ('tilt'), `camera` ('chase'), `quality` ('auto').
Čtení i zápis v try/catch kvůli private mode. Co si hráč jednou nastaví, musí
přežít restart prohlížeče.

Povolení senzoru se musí volat **z uživatelského gesta** (tlačítko Start), iOS
vyžaduje `requestPermission`. Rozlišuj návratové stavy `ok` / `denied` /
`insecure` / `unsupported` — DeviceOrientation existuje jen na HTTPS, takže na
lokálním http:// se korektně padá zpět na dotykový knipl. Vynucený pád na
dotyk se **neukládá**, aby nepřepsal volbu hráče pro příště.

---

## 5. Terén a data

### 5.1 Souřadný systém

Svět je v **metrech**, ne ve stupních. `x` na východ (0…34 886), `z` na jih
(0…30 961), `y` = nadmořská výška. **Řádek 0 dat je severní okraj**, tedy
`z = 0`. Záměna os je nejtypičtější chyba při přepisu.

    lat/lon → svět:  x = (lon − lon0)/(lon1 − lon0) · sizeX
                     z = (lat1 − lat)/(lat1 − lat0) · sizeZ     ← pozor na obrácení

Projekce je prostá lineární „plate carrée" na obdélník — žádná Mercatorova
korekce, zkreslení se v tomto výřezu zanedbává.

`heightAt` interpoluje bilineárně a mimo mapu drží hodnotu okraje. Clampuje se
na `gw − 1.001`, **ne** na `gw − 1` — jinak čtení `i+1` vypadne z pole na
východní a jižní hraně.

### 5.2 Zdroje dat

Všechno jsou veřejné S3 buckety bez klíčů a bez podpisu.

**Blízký terén** — Copernicus GLO-30 DEM (1 arcsec ≈ 30 m),
`copernicus-dem-30m.s3.amazonaws.com`, jediná dlaždice
`Copernicus_DSM_COG_10_N45_00_E006_00_DEM.tif`. Skript ji nestahuje sám, bere
ji jako argument. Čte se knihovnou `geotiff`.

Výřez: **6,55–7,00° E, 45,72–46,00° N** (0,45° × 0,28°), obsahuje masiv Mont
Blanku i celé údolí.

**Pokrytí** — ESA WorldCover 10 m, 2021, v200,
`esa-worldcover.s3.eu-central-1.amazonaws.com`, dlaždice `N45E006`. Stahuje se
curlem s třicetiminutovým timeoutem do `/tmp` cache; cache platí jen když
soubor existuje **a má přes 1 MB** — poloviční stažení se stáhne znovu.
Bounding box si nebere vlastní, čte ho z `chamonix.json`, aby pokrytí leželo
vždy na stejné mřížce jako výšky.

**Horizont** — Copernicus GLO-90 (3 arcsec ≈ 90 m), 16 pokusů o dlaždici
v rozsahu 5,32–8,42° E, 44,84–47,00° N, reálně existuje 12. Chybějící se tiše
přeskočí. Pozor: v názvu je `_30_` (3 arcsec), ne `_10_`, a název se opakuje
i v cestě adresáře.

### 5.3 Formáty souborů

Všechny tři `.bin` mají **nulovou hlavičku** — čistý bajtový obraz typovaného
pole, little-endian, row-major, index `gz · gw + gx`. Metadata leží vedle
v `.json`.

    chamonix.bin        640 × 576  Uint16, metry n. m.      737 280 B
    chamonix-cover.bin  640 × 576  Uint8, kód třídy         368 640 B  (nepovinný)
    alps-far.bin        384 × 352  Uint16, metry n. m.      270 336 B

Rozteč buňky blízké mapy ≈ 54,6 m na východ a 53,8 m na jih. Převzorkování
z 30m zdroje je bilineární. Vzdálená mapa má ≈ 627 × 680 m na buňku — na dálku
v oparu to bohatě stačí.

Chybějící `chamonix-cover.bin` hru nezastaví: barví se pak jen podle výšky
a sklonu.

### 5.4 Přepočet stupňů na metry — dvě různá místa

Ve stahovacím skriptu jednorázově z konstant, pro zápis do metadat:

    latMid  = 45,86°
    widthM  = 0,45 · 111320 · cos(latMid) ≈ 34 886 m
    heightM = 0,28 · 110574             ≈ 30 961 m

Ve vzdáleném terénu za běhu se metry na stupeň **odvozují z blízké mapy**:

    mPerLon = sizeX / (lon1 − lon0) = 77 524,4 m/°
    mPerLat = sizeZ / (lat1 − lat0) = 110 575,0 m/°

**PROČ:** kdyby si horizont počítal `cos(lat)` pro svou vlastní střední šířku
(45,92 vs 45,86), vznikl by na hranici mapy schod.

### 5.5 Landcover — hlasování, ne průměr

Kódy tříd jsou **nominální, ne ordinální**. Průměr „les 10 + voda 80" by dal
45, což neodpovídá žádné existující třídě (mezi polem a zástavbou). Zmenšení
z 10 m na herní mřížku (zhruba 5 × 5 pixelů na buňku) proto rozhoduje
**většinovým hlasováním**; hodnota 0 (no-data) se z hlasování vynechává,
fallback při prázdném okně je 30 (tráva) — neutrální, nezaplaví mapu lesem ani
ledem.

Motivace celé vrstvy: dosud se les, skála i ledovec odhadovaly z výšky
a sklonu. Výsledek byl pravděpodobný, ale ne pravdivý — les rostl i tam, kde je
odjakživa holá mýtina, a Mer de Glace vypadalo jako obyčejný sníh.

Číselník: 10 les · 20 křoviny · 30 tráva · 40 pole · 50 zástavba · 60 skála ·
70 sníh a led · 80 voda · 90 mokřad · 95 rákosí · 100 mech.
Zastoupení v Chamonix: 35 % tráva, 34 % les, 14 % trvalý sníh a led, 12 % skála.

### 5.6 Stavba meshe

Mřížka se řeže na **4 × 4 dlaždice** kvůli frustum cullingu — jeden mesh
o 735 tisících trojúhelnících se kreslil vždy celý. Dlaždice sdílejí hraniční
řadu vrcholů, takže je bez děr. Žádný LOD, culling ho nahrazuje.

Terén leží **přímo ve světových metrech**, mesh nemá žádnou transformaci —
v shaderu se `position.xz` používá rovnou jako světové souřadnice.

**Normály se počítají analyticky ze spádu heightmapy přes celou mřížku**,
centrální diferencí s krokem jedné buňky, a to **před** řezáním na dlaždice.
Kdyby se použilo `computeVertexNormals()` per dlaždice, byl by na hranicích
osvětlovací šev. Vzdálený terén naopak `computeVertexNormals()` používá — na
50 km v oparu švy nikdo nevidí.

**Zapečená okluze oblohy:** 8 směrů, 8 vzorků na směr, dohled 2 600 m, počítáno
na 4× řidší mřížce (160 × 144) a interpolováno. Jinak by to bylo 23,6 milionu
vzorků a načítání by trvalo vteřiny. Příspěvek směru je `1 − maxT/hypot(1,maxT)`,
tedy podíl volné oblohy. Bez okluze vypadá terén jako plochý plakát — s ní dno
údolí ztmavne a hřebeny vystoupí.

**Vržené stíny hor:** paprsek nad heightmapou od slunce, start 70 m,
geometrický krok ×1,25, konec ve 25 km — vyjde ~27 vzorků na bod. Zásadní
zrychlení je early exit `if (ray > hmax) break`: nad nejvyšším vrcholem už nic
nestínit nemůže. Hrana se změkčuje smoothstepem s prahem 0,02 (terén musí
paprsek přesáhnout o 2 % vzdálenosti) — hrana stínu není nikdy ostrá jako nůž.
Ráno a večer tím leží půl údolí ve stínu Aiguilles a krajina teprve dostane
měřítko.

**Klíčové pravidlo osvětlení:** stíny hor i mraků se v shaderu násobí
**výhradně do `directDiffuse`**, nikdy do ambientní složky. Rozptýlené světlo
oblohy ve stínu zůstává, takže stíny jsou modré a prokreslené, ne černé díry.
Mraky ubírají nejvýš 60 % přímého světla.

### 5.7 Barvení terénu

Hranice se počítají ze tří měřítek hodnotového šumu (~1400 m laloky, ~490 m,
~190 m roztřepení) a z orientace svahu:

    snowLine = 2680 + n01·240 + n02·70 + south·260   [m]
    treeLine = 1900 + n01·160 + n02·60 + south·120   [m]

`south` je z-složka normály saturovaná při spádu ~18°; na jižních stráních
taje dřív, takže sníh i les sahají výš (sníh 2 420 m na severu až 3 250 m na
jihu). Dvě měřítka šumu jsou nutná — bez nich vypadá hranice sněhu jako
natržený papír.

Pokud jsou data pokrytí, mají **přednost před odhadem**; bez nich se jede
čistá hypsometrie. V obou větvích pak platí:

- **skála přebíjí všechno na stěnách** (sklon > 0,55) — v 10m datech je na
  srázech šum a travnatý flek uprostřed severní stěny vypadá divně;
- ledovce dostávají modravé příčné pruhy trhlin po ~26 m převýšení, ale jen
  kde ledovec teče (sklon 0,05–0,5) — z výšky je to ten detail, který odliší
  živý ledovec od bílé silnice;
- okluze smí ubrat až 27 % jasu na holém terénu, ale jen 7 % na sněhu — bílý
  povrch si světlo mnohonásobně odráží sám mezi sebou, takže stíny ve sněhu
  nejsou černé, ale modré.

**Nesmí se stínovat dvakrát.** Dřív byl do barev zapečený hillshade a navíc
svítilo slunce Lambertem; scéna byla přepálená a plochá. Zapečená zůstává jen
okluze oblohy, která na směru slunce nezávisí.

Vzdálený terén má vlastní jednodušší barvení a povinně `lerp` 28 % do modré
(`0x8fa6bd`) — přes desítky kilometrů vzduchu není zelená zelená. Mlha to dělá
taky, ale až od jisté vzdálenosti; tohle drží dálku barevně v dálce i blíž
k mapě.

### 5.8 Navázání horizontu na mapu

Obě mřížky mají různé rozlišení (54 vs 650 m), takže se v překryvu bijí.
Řešení má dvě vrstvy:

**Zanoření:** `sink = min(600, vzdálenost_od_hrany/1200 · 600)`. Přesně na
hranici mapy je sink nulový, takže výšky navazují beze schodu; směrem dovnitř
lineárně klesá a po 1 200 m je hrubý terén plných 600 m pod jemným.

**Culling:** čtverec se do indexu vůbec nepřidá, když jsou všechny jeho rohy
hlouběji než 2 000 m uvnitř mapy.

Pásmo zanoření (1 200 m) musí být **užší** než culling zóna (2 000 m) — než se
trojúhelníky přestanou generovat, jsou už 600 m pod povrchem.

Alternativa pro případ, že se horizont nenačte, je **zástěra**: plocha 7× větší
než mapa ve výšce `hmin − 12`, barvy `0xa2ada0` vybledlé do oparu. Sytě zelená
se na obzoru rýsovala jako pruh trávníku za horami. Zástěra a horizont se
vzájemně vylučují.

### 5.9 Les a scenérie

Les má dvě vrstvy: **blízkou dynamickou** (přeskládá se, když kamera opustí
buňku 400 m) a **dálkovou statickou**. Počty podle kvality: 4 500 / 9 000 /
22 000 blízkých instancí, dosah 1 000 / 1 500 / 2 300 m.

Determinismus je povinný — seed buňky se počítá z jejích souřadnic, takže
stejná buňka dá vždy stejné stromy a les nebliká.

Filtry umístění v pořadí: okraj mapy 200 m, **třída pokrytí musí být 10 nebo
20** (kde roste les, říkají data, ne odhad z výšky), výška 720–2 200 m, sklon
do 0,55, u křovin projde jen 35 % pokusů, a nakonec čtyři kruhy kolem obcí, kde
neroste nic.

**Stromy jsou `MeshBasicMaterial`, ne Lambert.** Lambert z nich dělal černé
tečky — smrk je tmavý a ještě se stínoval. Basic plus jemné dobarvení podle
výšky drží les čitelný i z letu. Model je dva zkřížené kvady s generovanou
texturou, bez natáčení k pohledu. Barevná variace per instance
(10 % světlých bříz, u ostatních červenější strom = méně modrý) rozpadne
jednolitou plochu na jednotlivé koruny.

Scenérie: čtyři obce (320 domů), barvy tlumeného dřeva a šedých šindelů —
skoro bílé stěny vypadaly z výšky jako konfety rozsypané po stráni. Domy se
drží dna údolí (filtr ±220/120 m od výšky centra obce).

**Světla oken** se rozsvěcují pod 7° výšky slunce, svítí 72 % domů (prázdné
domy dělají v řadě světel rytmus) a jejich **barva je záměrně nad 1,0** —
teprve tím přeteče přes práh záře a rozsvícené údolí dostane měkký nádech
místo tvrdých teček.

---

## 6. Model proudění

Tohle je jádro hry. Bez něj je to jen klouzavý pád.

### 6.1 Počasí

Jediné volání Open-Meteo bez API klíče, šestisekundový timeout, **jednou při
startu** — žádný polling. Reload stránky = nové počasí.

Proměnné: `wind_speed_850hPa` a `wind_direction_850hPa` (hodinové),
`temperature_2m`, `cloud_cover`, `cloud_cover_high`, `precipitation`,
`wind_speed_10m`, `wind_direction_10m` (aktuální).

**PROČ 850 hPa:** vítr v hladině hřebenů (~1500 m) je pro plachtění
směrodatnější než přízemní. Když hodinová data chybí, přízemní se násobí 1,6.

Fallback při jakékoli chybě je tichý — **hra funguje vždy**. Hraje se „záložní
pěkný den": vítr 4,5 m/s ze 300°, oblačnost 30 %, 18 °C.

Odvozené podmínky:

    sunFactor       = clamp(elevace / 38°, 0, 1)
    cloudFactor     = 1 − 0,55 · oblačnost
    thermalStrength = max(3,5 ; 6,5 · sunFactor · cloudFactor)   [m/s v jádru]
    cloudBase       = clamp(2900 + 900·(1−oblačnost) + (teplota−10)·25, 2600, 4100)
    vítr            = směr reálný, síla min(7, rychlost)          [m/s]

**Podlaha termiky 3,5 m/s** je minimum hratelnosti — v noci ani v dešti nesmí
být trať neletitelná. **Čepice větru 7 m/s** je z opačného důvodu: reálný orkán
by hru zabil, směr zůstává pravdivý a síla hratelná.

Poloha slunce se počítá přibližným analytickým vzorcem bez knihovny (deklinace
z dne v roce, hodinový úhel ze středního slunečního času). Chybí časová rovnice,
takže chyba je až ±16 minut — pro osvětlení scény to stačí. Elevace se pro
směrový vektor podlahuje na 6°, aby bylo v noci vidět.

### 6.2 Termika

**Nejsou náhodné.** RNG je `mulberry32` s pevným seedem, takže tentýž seed
a terén dá tytéž termiky. Poloha se vybírá skórováním terénu ze 4 000 pokusů:

    zahoď, když výška < 900 m nebo > 3100 m      (údolí nízko, ledovce vysoko)
    zahoď, když sklon < 0,08
    facing = cos(azimut svahu − azimut ke slunci)
    score  = facing · min(0,5 ; sklon) · (1 − |výška − 1900| / 2400)
    drž, když score > 0,03

Preferují se svahy natočené ke slunci, s výrazným ale ne extrémním sklonem
(nad 0,5 už další strmost nepomáhá) a s výškou blízko 1 900 m — typická hladina
odtrhávání v tomto údolí. Poloha slunce tím mění rozložení termik během dne,
aniž by byly náhodné v rámci jednoho sezení.

Parametry jedné termiky:

    síla     thermalStrength · (0,75…1,25) · boost   [m/s]
    poloměr  240…400 m
    strop    min(cloudBase ; terén + 1700 + síla·450)
    ptáci    u 45 % termik (hráči signalizují jistotu stoupání)

**Domovské termiky podél trati — bez tohohle je hra neletitelná.** Pro každou
kotvu (start, 5 bran a střed každého úseku delšího než 2 600 m) se najde
nejlepší kandidát do 1 500 m a přidá se s boostem 1,15. Když žádný není, bere
se nejbližší vhodný do 3 000 m. Trať je tím vždy letitelná — hráč termiky jen
musí umět najít a využít. Zbytek mapy se doplní do stropu **64 termik**
s minimálním rozestupem 880 m, aby se dalo létat i mimo trať.

**Náklon komína:** střed se s výškou posouvá po větru o **11 % převýšení nad
zemí**, ale normalizovaně — náklon nezávisí na síle větru, jen na jeho směru.

**Stoupání:**

    základ  w = −0,35 m/s        ← klidný vzduch neexistuje, kdo nestoupá, klesá
    jádro   core = exp(−d² / (r²·0,55))                  Gauss, e-fold ≈ 0,74·r
    profil  0,8 u země → 1,0 ve ~43 % výšky → 0,8 u stropu → hasne nad ním
    věnec   d mezi r a 2,2·r: až −0,5 m/s

Příspěvky více termik se **sčítají**. Věnec klesání je klíčový herní prvek: kdo
mine jádro, dostane trest, ne nulu — nutí to kroužit přesně.

### 6.3 Svahové proudění

Aktivuje se pod 450 m nad terénem při větru nad 0,63 m/s.

    horiz    = vodorovný průmět normály terénu   (délka = sin sklonu)
    upslope  = −(wind · horiz)                   (vítr proti normále = návětří)
    band     = max(0, 1 − AGL/450)               (lineární útlum s výškou)

    návětří:  w += min(4  ; upslope · 0,9) · band
    závětří:  w += max(−2 ; upslope · 0,5) · band

**Asymetrie je záměrná:** návětří dává dvojnásobným koeficientem i limitem víc,
než závětří bere. Závětří je klesák zmírněný, aby hra byla fér.

Protože `horiz` má délku `sin(sklonu)`, zdvih automaticky roste se strmostí
i s tím, jak kolmo je svah nastavený větru — přesně jak to plachtař čeká.

### 6.4 Jak se proudění zobrazuje

Hráč musí vzduch **vidět**, jinak hra nefunguje:

- **komíny částic** (26 na termiku, na dotykových zařízeních 14), teplá barva;
- **kroužící ptáci** u 45 % termik;
- **kumulus nad každou termikou** s plochou základnou a květákovým vrškem,
  cyklus zrodu a rozpadu 180 s (rychlý zrod, pomalý rozpad);
- **stíny kumulů na zemi** — a to je herní informace, ne dekorace: kumulus
  stojí nad termikou, takže tmavé fleky v krajině prozradí, kde hledat stoupák.
  Stín **neleží pod mrakem**, ale posunutý podle výšky slunce; ráno to bývají
  kilometry;
- **částice po návětrných svazích** ve studené barvě, aby se nepletly
  s termickými. Vypnou se úplně při větru pod 2 m/s.

**PROČ vlastní shader mraků a ne `MeshLambertMaterial`:** průhledný Lambert
prosvítal vnitřními stěnami a spodek dobarvovala zelená ze země — byly z toho
olivové létající talíře. Materiál musí být neprůhledný a barvu si řídit sám.

---

## 7. Trať a brány

Start nad Chamonix ve výšce 2 600 m, čelem k Bréventu (kurz 20°), rychlost
28 m/s.

Pět bran v pevném pořadí (souřadnice, výška, délka úseku):

    1. Brévent            45,9360 / 6,8520   2 350 m    start→1  0,83 km
    2. La Flégère         45,9530 / 6,8720   2 400 m       1→2   2,44 km
    3. Argentière         45,9620 / 6,9200   2 300 m       2→3   3,85 km
    4. Plan de l'Aiguille 45,9080 / 6,8760   2 350 m       3→4   6,88 km
    5. cíl Chamonix       45,9225 / 6,8705   1 550 m       4→5   1,66 km

Celkem ~15,7 km. Výška brány je `max(zadaná, terén + 150 m)` — brána nikdy pod
terénem. Úseky 2→3 a 3→4 překračují 2 600 m, takže dostávají navíc domovskou
termiku ve svém středu.

**Návrhový záměr:** brány jsou rozmístěné tak, že bez termiky a svahového
proudění se nedoletí. Mezi branami je nutné nabírat výšku.

**Podmínka průletu je kulová, ne prstencová:** stačí se dostat do koule
o poloměru 125 m kolem středu brány, je jedno ze které strany a v jakém úhlu.
Torus je čistě vizuál. Vynechání není možné — testuje se výhradně aktuální
brána, pořadí je striktní.

Nad aktivní branou stojí světelný sloup, ale záměrně velmi slabý (krytí kolem
0,06): sloup má bránu najít, ne přebít krajinu.

### 7.1 Měření času

`runMs` se **nebere z hodin**, ale sčítá z kroků simulace, a to jen ve větvi
„letí a není pauza". Pauza tím čas skutečně zastaví.

Pauzu spouští Escape, tlačítko, ztráta fokusu okna (**jen na desktopu**)
a `visibilitychange`. Návrat má odpočet 3 s, ať hráč stihne chytit knipl.

**PROČ blur jen na desktopu:** mobilní prohlížeče střílejí `window blur`
i při dotycích a systémových gestech, takže tah prstem po obrazovce zastavoval
let.

**Známý důsledek clampu `dt ≤ 0,05 s`:** při propadu pod 20 fps roste `runMs`
pomaleji než reálný čas, takže zpomalený stroj dostane lepší výsledek.
Anti-cheat to nezachytí, protože kontroluje jen „ne rychleji, než token žije".

### 7.2 Režimy a pokračování po nárazu

**Volný let** — brány skryté, kontrola se nevolá, výsledek se nikam neposílá.
Trénink bez tlaku.

**Pokračování od poslední proletěné brány** (jen v závodním režimu): nová
poloha 120 m nad ní, kurz na následující bránu, a **let je natrvalo označený
jako mimo žebříček**.

**PROČ:** náraz v páté bráně po dvaceti minutách jinak znamená celou trať
znovu — a to hráče od hry odradí víc než těžká termika.

### 7.3 Ukazatel doklouzání

Nejdůležitější údaj plachtaře: o kolik metrů nad (▲) nebo pod (▼) bránu
doletím, když teď zamířím přímo tam.

    vAir     = 26 m/s                        rozumná přeskoková rychlost
    vGround  = max(5 ; vAir + složka větru do směru letu)
    ld       = vGround / polarSink(vAir)     bezvětří 42,1 · vítr v zádech 50,2 · proti 34,0
    need     = výška brány + vzdálenost / ld

**Limit hřebene po trase** je to, co dělá ukazatel užitečným: po ~300 m se
vzorkuje terén a hledá se místo, kde `terén + 60 m rezerva + zbytek klouzání`
převýší dosavadní `need`. Mnohdy nerozhoduje brána, ale hora před ní — proto
se v UI zobrazí ⛰.

### 7.4 Varování před terénem (GPWS)

Sonda po **rovné** dráze letu 1–8 s dopředu; když se dráha dostane pod
`terén + 30 m`, houká a vibruje (perioda 0,45 s pod 4 s do nárazu, jinak 0,8 s).

**PROČ rovná dráha a ne zatáčka:** v zatáčce svah minu, ale radši varovat dřív
než později.

## 8. Herní smyčka a grafika

### 8.1 Smyčka

Žádný fixní krok, jedna `setAnimationLoop` s proměnným delta time. Fyzika
větroně je hladká (žádné tuhé pružiny ani kolizní řešič), takže variabilní krok
stačí a nepotřebuje subkrokování.

    rawDt = clock.getDelta()          reálný čas (adaptivní kvalita, odpočet)
    dt    = min(rawDt, 0,05)          simulační krok, tvrdý strop 50 ms

Strop znamená, že při propadu pod 20 fps se svět zpomalí, ale neproskočí
terénem.

Pořadí v jednom snímku: adaptivní kvalita → pauza → blok „letím" (vstup,
proudění, fyzika, kolize, brány, GPWS, čas, HUD, zvuk) → blok „svět běží"
(částice, atmosféra, vlečky, přepečení stínů) → vždy (animace bran ze
**zmrazeného** času, stín kluzáka, les, kamera) → FOV → obloha ke kameře →
glare → render.

**Adaptivní kvalita:** klouzavý průměr fps, každé 2 s se `pixelRatio` sníží
o 0,25 pod 45 fps a zvýší nad 57 fps. Plynulost je přednější než ostrost.

**Rampa vstupu:** `_inSm += (raw − _inSm) · min(1, dt·6,5)` — klávesy dávají
skoky, knipl ne. Na mobilu se v režimu náklonu přitažení ořezává na −0,8 jako
ochrana před nechtěným přetažením.

**Kamera:** chase sleduje kluzák se zpožděním (`lerp dt·3,4`), odstup roste
s rychlostí, horizont se naklání o 35 % náklonu. Kokpit bere kvaternion přímo
z modelu a **přepíná `near` z 2 na 1,2 m** — jinak by zmizel nos, který je
1,6 m před okem. FOV dýchá s rychlostí (64° až 82°).

### 8.2 Pipeline post-processingu

Průchody v tomto pořadí, **jiné pořadí rozbije obraz**:

    RenderPass → Shimmer → Bloom → OutputPass → Grade → FXAA

**PROČ takhle:** uvnitř composeru se kreslí lineárně a v HDR. Teprve
`OutputPass` udělá tónové mapování a převod do sRGB. Bez něj jde na plátno
lineární barva a obraz je skoro černý (jen mraky svítí jako žárovky). Záře musí
být **před** ním, protože se počítá z HDR; doladění barev a FXAA až **za** ním,
protože pracují s tím, co uvidí oko. Chvění je hned za scénou, aby vlnilo obraz
dřív, než se z něj počítá záře.

**Práh záře je 1,02, tedy nad jedničkou.** Mraky mají v HDR nejvýš jednotku,
takže se do záře nedostanou a přeteče jen osluněný sníh a kotouč slunce.
S nižším prahem zapařil bílý pás oblačnosti celou oblohu do šeda. Co má zářit
(světla oken), musí mít barvu záměrně nad 1,0.

MSAA (4 vzorky) patří do render targetu composeru — `antialias: true` na plátně
se při renderu přes composer nepoužije a hrany by se ztratily.

**Každý vlastní shader musí končit stejným trojřádkem:**

    gl_FragColor = vec4(pow(col, vec3(2.2)) * BOOST, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>

Barvy se píšou „jak to má vypadat na displeji", `pow(2.2)` je převede do
lineárního prostoru. Three.js tyhle chunky kompiluje podmíněně, takže při
renderu do targetu jsou to no-op a při přímém renderu se aplikují — jeden zdroj
shaderu vypadá stejně s efekty i bez nich. **Bez toho vypadá obloha bez efektů
jinak než s nimi**, protože post-processing ji převáděl podruhé. Vynechání se
projeví jen v jednom ze dvou režimů kvality, takže se to snadno přehlédne.

### 8.3 Stupně kvality

    stupeň  pixelRatio  opar   les (blízko/dosah/daleko)  postfx  horizont
    low     1           ×1,8   4 500 / 1 000 / 3 500      ne      půlmřížka
    med     1,5         ×1,25  9 000 / 1 500 / 7 000      ne      plný
    high    2           ×1,0   22 000 / 2 300 / 14 000    ano     plný

`auto` znamená `med` na dotykovém zařízení a `high` na desktopu. Les je zdaleka
nejdražší část scény. Nižší kvalita má **hustší opar** — tím se schová kratší
dohlednost. Post-processing je jen na `high`, takže při přepnutí dolů padá
bloom, grade, FXAA i chvění najednou.

### 8.4 Světlo a obloha

Slunce `1,5 · (1 − 0,5 · oblačnost)`, hemisféra `0,8 + 0,5 · oblačnost`, součet
drží pod ~1,8. Dřív bylo 2,1 + 0,85 přes už zapečený hillshade, tedy přes
trojnásobek, a všechno bylo vypálené do sytě zelené.

Oblohové světlo musí být silné a **bledé** — sytě modré nebe obarvilo severní
stěnu masivu do ocelova.

Mlha je `FogExp2`, protože lineární ubírala i ve 20 km sotva pětinu. Její barva
je **přesně** barva obzoru v shaderu oblohy (`uHorizon`) — jinak je vidět šev
tam, kde vzdálené hory přecházejí do oblohy.

### 8.5 Mraky

Nad každou termikou stojí jeden kumulus, posazený na strop komína + 140 m
a posunutý po větru stejným sklonem jako komín.

Geometrie je sloučená sada koulí: **spodní věnec** 3–5 zploštělých koulí
posunutých do kruhu a jen mírně nahoru (to dělá plochou základnu) a **vršek**
2–3 menší koule výš a do stran (květák).

Shader: hodnotový šum kotvený na **světovou pozici v metrech**, takže se
struktura nechvěje, když kolem mraku hráč prolétá. Silueta se odhryzává 3D
šumem, ale **jen na obrysu** (podle úhlu normály k pohledu) — plošný discard by
odkryl vnitřek slepených koulí. Chuchvalce dostávají vlastní světlo a stín,
takže mrak vypadá jako objem, ne jako natřená skořápka.

**Stříbrné lemování:** `rim = pow(1 − |dot(n,V)|, 3)` krát „dívám se přes mrak
proti slunci". Bloom si to sám rozzáří, protože přes boost přeteče přes
jedničku.

Cyklus zrodu a rozpadu 180 s: rychlý zrod, pomalý rozpad. **Pozor na past
v původním kódu:** materiál je sdílený `ShaderMaterial` bez `transparent`,
takže per-mrak animace průhlednosti nefunguje — viditelnou obálku dělá jen
měřítko. Buď to zahodit, nebo protáhnout skutečnou uniformou a materiál dát
per-mrak.

**Stíny mraků** se přepékají každé ~4 s. Drift za tu dobu je pod desetinou
poloměru stínu (mrak urazí max ~28 m, poloměr stínu je 420 m), takže skok není
vidět. **Kdo změní interval nebo poloměr, musí ten poměr znovu ověřit.**

### 8.6 Atmosféra — nálada dne

Všechno je **jen vizuální**, fyziku ani termiku to nemění.

**Ranní inverze** (moře mlhy v údolích): spustí se dopoledne, při slunci pod
26° a větru pod 6,5 m/s. Dvě šumové hladiny nad sebou (mlha má tloušťku, ne jen
víko), hladina kolem 1 400 m, průhlednost per vrchol mizí tam, kde terén
vystupuje nad hladinu — vzniká pobřeží mlhy. Drift po větru, druhá vrstva
opačně a rychleji.

**Cirry** podle skutečné vysoké oblačnosti (práh 4 %): canvasová textura
s 48 kreslenými tahy, z toho 35 % s háčkem (cirrus uncinus), na několika obřích
rovinách ve výšce 7,2–8,6 km, natočených po výškovém proudění.
**`side: DoubleSide` je nutný** — rovina leží normálou vzhůru a hráč je vždy
pod ní, takže s `FrontSide` se cullovala a cirry nebyly vidět vůbec.

**Dešťové clony** při srážkách nad 0,05 mm/h: kužel s pruhovanou texturou
(prosvítající pruhy = provazce deště) plus tmavý mrak nahoře, **nakloněný do
větru** (kapky cestou dolů snáší vítr). Umisťují se nad údolí, ne na hřebeny.

**Sněžné vlajky** z vrcholů nad 3 750 m při větru od 5 m/s: GPU částice, polohu
počítá celou vertex shader. Délka vlajky roste s větrem.

**Sluneční glare** s **ručním zákrytem terénem** — pochod po heightmapě od
kamery ke slunci, přepočítávaný jen každých 0,12 s (kamera se mezi snímky
skoro nehne). Zhasne pod obzorem: po západu slunce žádný odlesk být nemůže,
bez té podmínky visely nad soumračným údolím barevné koule z ničeho.

**Lens flare duchové** na ose slunce—střed obrazu, svázaní s glarem. Barvy jsou
**záměrně bledé**: sytější duchové se přes aditivní míchání otiskli na
zasněžený svah jako fialová skvrna a vypadalo to jako chyba vykreslování.
Ukotvit je nutné na **pevnou vzdálenost** od kamery — NDC hloubka je
nelineární, jinak sprite skončí metr před objektivem.

**Duha** při dešti a slunci pod 40°, 42° kruh na protisluneční straně. Tři
pravidla, každé z chyby:

- **Nikdy aditivně.** Na syté modré obloze aditivní míchání červenou nevyrobí —
  jen přisvětlí do bílomodra. Normální alfa blend barvu pozadí nahrazuje, takže
  červená projde.
- **Per-pixel, ne tahy štětcem.** Překrývající se oblouky sčítaly alfu a z duhy
  byl bílý pruh.
- **`colorSpace = SRGBColorSpace`** na textuře, jinak se barvy vyplaví do
  pastelu.

`depthTest: true` je taky záměr — hory duhu zakrývají, takže z ní kouká jen
oblouk nad hřebeny, přesně jak to v údolí vypadá.

**Tepelné chvění** nad stoupákem (jen `high`): **kotva je na zemi u paty
termiky, ne v komíně ve výšce.** Komín se s výškou naklání po větru, takže
původní verze vlnila kus prázdného vzduchu šikmo vedle kopce. Chvění dělá horký
vzduch u povrchu: přízemní vrstva 130 m vzhůru, dolů skoro nic, a hasne
s klesajícím sluncem. Efekt musí mít **pásmo vzdálenosti** — uvnitř stoupáku
není proti čemu ho poměřit, z kilometrů to spolkne opar.

---

## 9. UI, HUD a zvuk

### 9.1 HUD

Pilulky nahoře uprostřed: čas, km/h, výška + AGL, vario + průměr, vítr,
doporučená rychlost, zvuk, mapa.

- **AGL** zoranžoví pod 150 m.
- **Vario** je zelené nad +0,2 m/s a červené pod −2 m/s.
- **Šipka větru** ukazuje, kam vítr fouká, v souřadnicích obrazovky (nahoře =
  můj kurz).
- **Doporučená rychlost:** ve stoupání natvrdo 85 km/h, jinak roste s klesáním.
  Ve stoupání zpomal k minimálnímu opadání, v klesáku utíkej.

Layout má `flex-wrap: nowrap` a pevné `min-width` v `ch` na každém číselném
poli, aby se hodnota měnila a pilulka nedýchala. Pod 760 px se HUD přepne na
grid 4 × 2, kde má každý ukazatel navždy svou buňku.

**Známá nepřesnost:** popisek průměru varia říká ⌀20s, ale použitá EMA má
časovou konstantu asi 5 s. Je to štítek, ne specifikace. Kdo chce skutečných
20 s, musí snížit koeficient zhruba na čtvrtinu.

**Variometr** má navíc svislou stupnici s jehlou, ryskami po 2,5 m/s
a barevnými prahy shodnými s číslem.

**Markery ve světě:** brána a nejbližší termika se promítají do obrazu
a ořezávají na okraj. Marker termiky se skryje, když jsem blíž než 220 m
(v termice netřeba) nebo když je za zády (nemást s bránou).

**Minimapa** má zapečený podklad (hypsometrie + pseudo-osvětlení od východu)
a živě se do ní kreslí jen trať, brány a hráč. Přepíná se tlačítkem, klávesou
TAB nebo dvouprstým tapem.

**Statistiky letu:** nejvyšší bod, nejlepší stoupák (z průměru, ne z okamžité
hodnoty), nejvyšší rychlost, uletěno km **nad zemí i s driftem větru** (to hráč
reálně uletěl) a počet vykroužených stoupáků — kde se za stoupák počítá jen
souvislé stoupání přes 6 s, ne každý poryv.

### 9.2 Panel nastavení

Jedno okno slouží jako pauza i jako nastavení, liší se jen titulkem a tlačítky.
Tři řádky: citlivost náklonu (skrytá na desktopu, nemá tam co ovlivnit),
obrácení výšky (**zobrazené i na desktopu**, protože tlačítko ⇅ je jen na
mobilu a tohle je tam jediná cesta k přepnutí) a kvalita grafiky, která platí
okamžitě.

Mobilní tlačítka patří vpravo dole — mimo palec na kniplu i mimo minimapu
vlevo.

### 9.3 Zvuk

Kontext se vytváří až z uživatelského gesta, celé v try/catch: když WebAudio
není, všechny metody tiše nedělají nic.

**Variometr je jeden trvalý oscilátor**, který se nikdy nezastavuje —
moduluje se jen gain a frekvence přes `setTargetAtTime`, takže nejsou slyšet
kliky.

- stoupání nad +0,25 m/s: **pípá**, tempo 1,6–5,35 Hz, tón 550–1210 Hz
- klesání pod −2,2 m/s: **houká** souvisle, 240–140 Hz
- mezi tím ticho — záměrné mrtvé pásmo, jinak by vario mlelo pořád

**Šum větru** je smyčka bílého šumu přes lowpass. Ozývá se až nad 14 m/s
a saturuje kolem 60 m/s; exponent 1,6 drží tichý pomalý let. Při přetažení se
přidává nepravidelné třepetání.

**GPWS** houká hranatým tónem klesajícím 340 → 210 Hz, každých 0,45 s pod
4 sekundy do nárazu, jinak každých 0,8 s. Blíž znamená hustěji.

Dál: brána (dvojtón vzhůru), cíl (trojka), náraz (šum s klesajícím sinem),
přetažení (šum). Pauza umlčí jen trvalé zvuky — fanfáru brány to neutne, ta
jede po vlastních uzlech.

### 9.4 Ladicí URL parametry

Přepisy se aplikují **i na záložní počasí**, takže fungují offline.

    ?cas=8:00        čas v UTC → poloha slunce (světlo, stíny, termika, okna, glare)
    ?mraky=0–100     celková oblačnost
    ?cirry=0–100     vysoká oblačnost (cirry, kondenzační pás)
    ?dest=mm/h       srážky (dešťové clony, duha)
    ?vitr=m/s        rychlost větru
    ?inverze=0–1     vynutí inverzi a obejde všechny podmínky
    ?debug           vystaví živou instanci hry do window.__wf

**Pozor na dvojí použití `?vitr`:** fyzika ho stropuje na 7 m/s, ale sněžné
vlajky a inverze testují surovou hodnotu.

`?debug` je nutný pro screenshotové ověřování — kamera se dá zmrazit přepsáním
její aktualizační metody.

---

## 10. Žebříček a anti-cheat

Tok: začátek závodního letu → `GET /api/scores?session=1` vrátí token → doletí
se cíl → hráč zadá jméno → `POST /api/scores { name, ms, token }` → odpověď
rovnou obsahuje vykreslený žebříček.

**Token** je `issued.nonce.HMAC-SHA256(secret, "issued.nonce")`. Podepisuje se
tedy jen čas vydání a nonce — jméno ani čas letu podepsané nejsou.

Server ověří podpis (`timingSafeEqual`), stáří tokenu (max 2 h) a hlavně
nerovnost:

    stáří tokenu ≥ naměřený čas − 2,5 s tolerance

**Co to pokrývá:** nelze poslat falešný instantní rekord přes curl — kdo chce
odeslat čas 45 s, musí si 45 s předtím vyžádat token a počkat.

**Co to nepokrývá** (poctivě, aby si to nikdo nemyslel): token není vázán na
hráče ani na průběh letu, takže lze poslat čas **větší**, než jaký se letěl,
a neověřuje se, že hráč vůbec proletěl brány. Server dostává jen jméno, čas
a token.

Úložiště je **jeden JSON pod jedním klíčem** v Upstash Redis / Vercel KV.
Ukládá se jen jméno (max 24 znaků, sanitizované), čas, datum, ISO týden
a časové razítko. **Žádný e-mail, žádná registrace, žádné cookies.** Žebříček
vrací top 10 týdne, top 10 all-time a absolutní rekord, vždy nejlepší výsledek
na hráče; při shodě času je výš starší výsledek.

Limity: nejrychlejší uznaný čas 30 s, nejpomalejší 2 h (i pohodový let se
počítá).

**Lokální vývoj** má tutéž logiku přes Vite middleware, který importuje
**stejný sdílený modul** jako serverless funkce — jeden zdroj pravdy pro token,
týdny, sanitizaci i řazení. Liší se jen úložiště (soubor místo KV) a podpisový
klíč, který se generuje při startu procesu (restart dev serveru = rozehrané
kolo nejde uložit). Při přepisu tohle rozdělení zachovat, jinak se lokální
a produkční žebříček rozejdou.

---

## 11. Testování a akceptační kritéria

Testy běží **bez prohlížeče**, nad reálnými zdrojovými moduly (žádné duplikované
kopie logiky), se stubem globálních objektů. Žádné závislosti navíc.

**Test směru ovládání** ověřuje deset věcí, z nichž nejdůležitější je poslední:

1. výchozí konvence je „jako knipl" (`invertY = false`)
2. neutrál neřídí (po kalibraci je výchylka pod 0,02)
3. směr na šířku: telefon k sobě = nos nahoru
4. **směr na výšku** (v portrétu nese sklon jiná osa a převod ho nesmí otočit)
5. přepínač ⇅ obrací
6. náklon do strany dává roll opačných znamének
7. mrtvá zóna: 1° od neutrálu dává přesně nulu
8. izolace režimů: v dotykovém režimu náklon neřídí
9. bez senzoru `setMode('tilt')` spadne na dotyk
10. **klávesnice, myš i gamepad míří stejným směrem a všechny poslouchají ⇅**

Desátý bod je přímá obrana proti chybě A ze sekce 4.2.

**Test souladu vstup ↔ fyzika ↔ kresba** je obrana proti chybě B. Odletí 3 s
s konstantním vstupem a požaduje, aby při přitažení platilo **současně**:
`theta < 0`, rychlost klesla o víc než 3 m/s, výška stoupla o víc než 5 m,
a nos modelu v kvaternionu míří nahoru. Při potlačení zrcadlově.

**Test neprojde ani samotné otočení kresby, ani samotné otočení fyziky** — což
je celý smysl. Kdo sahá na pitch, musí projít tímhle testem.

**Past při psaní stubu:** `globalThis.navigator` je od Node 21 getter-only
property, takže prosté přiřazení skončí `TypeError`. Používej
`Object.defineProperty(globalThis, 'navigator', { … })`, jinak testy neběží na
současných verzích Node.

**Regresní AI pilot** létá trať nad reálným kódem hry (terén, proudění, fyzika):
čte terén po trase, vybírá termiky s čistou cestou, konturuje svahy, klesá na
brány. Osm povětrnostních scénářů (slabý den, silný vítr, zataženo, ráno, jiné
seedy), všechny musí být dokončitelné za 20–30 minut. Poučení z jeho stavby:
brány patří podél osluněných svahů a cíl nad střed údolí; fyzikální sanity se
měří simulací, ne odhadem.

**Ověřování vizuálu screenshotem je povinné.** Server nemá prohlížeč, takže se
dlouho stavělo naslepo a byly tam věci, které z kódu vidět nejsou — mraky jako
olivová UFA, přepálené barvy, cirry, které nebyly vidět vůbec. Headless
Chromium se SwiftShaderem hru vyrenderuje. U A/B porovnání efektu je nutné
zmrazit svět, glare i FOV v jednom běhu, jinak se liší všechno a rozdíl neřekne
nic.

---

## 12. Deploy

Vercel s presetem Vite, napojený na GitHub, push do hlavní větve = deploy.
Serverless funkce v `api/` jdou nasadit samy.

Žebříček potřebuje Storage → Upstash Redis. Env proměnné se hledají pod
`KV_REST_API_URL`/`TOKEN` i pod `UPSTASH_REDIS_REST_*`, a navíc se prochází
celé prostředí kvůli integracím, které názvy prefixují. Bez konfigurace vrací
endpoint 501 s českou hláškou, hra běží dál. Podpisový klíč je buď dedikovaný,
nebo se použije KV token — taky server-only.

**Ovládání náklonem funguje jen na HTTPS** (DeviceOrientation vyžaduje secure
context). Na lokálním dev serveru proto naskočí dotykový knipl; není to chyba.

---

## 13. Doporučené pořadí stavby

Původní projekt vznikal ve čtyřech měsících a zhruba čtyřiceti iteracích. Pořadí,
které se osvědčilo:

1. **Data napřed.** Stáhnout terén, ověřit rozměry a orientaci os (sever je
   řádek 0), postavit mesh a dívat se na něj. Bez správného terénu nemá smysl
   dělat nic dalšího.
2. **Fyzika a kamera.** Polára, pitch → cílová rychlost, výměna energie,
   zatáčka. Sem hned patří test souladu vstupu, fyziky a kresby — dřív, než se
   navrství cokoliv dalšího.
3. **Proudění.** Termiky vázané na terén a slunce, svahové stoupání, domovské
   termiky podél trati. Teprve tady hra začne být hra.
4. **Trať, brány, čas, žebříček.** Včetně měření času ze součtu kroků.
5. **Ovládání na všech vstupech.** Klávesnice, myš, gamepad, náklon, knipl —
   a jediné znaménko pro všechny. Testy ovládání.
6. **Čitelnost vzduchu.** Částice, ptáci, kumuly, stíny mraků, marker termiky.
   Bez tohohle hráč neví, kde stoupat, a hra je frustrující.
7. **Pomůcky pro hratelnost.** Doklouzání, GPWS, pauza, volný let, pokračování
   od brány, nastavení kvality. Tohle přišlo v jedné vlně a proměnilo to zážitek
   víc než grafika.
8. **Grafika ve vlnách**, každá ověřená screenshotem: světlo a barvy terénu →
   stíny → skutečné pokrytí → nálada dne → druhá vlna (plující stíny, třpyt
   vody, lens flare, duha) → paleta → detaily (chvění, světla, sníh,
   kondenzační pás).

Zásadní je pořadí 1–7 před 8. Grafika se dá přistavovat donekonečna, ale hru
dělá hratelnou model proudění a pomůcky, ne mraky.

---

## 14. Souhrn pastí

Sesbírané chyby, které se v původním vývoji staly a stály čas. Každá z nich se
dá zopakovat.

**Fyzika a ovládání**

- Znaménko pitche žije ve třech vrstvách (vstup, fyzika, kresba) a musí se
  ověřovat najednou. Rozpor mezi fyzikou a kresbou vypadá jako špatné mapování
  vstupu a láká k opravě na špatné straně.
- Než otočíš znaménko, zkontroluj, jestli si vstupy neodporují navzájem — a
  jestli má hráč vůbec šanci si to přepnout.
- Syrové Eulerovy úhly z DeviceOrientation se překlápějí; počítej gravitační
  vektor.
- Kalibrace neutrálu musí být průměr, ne jediný odečet.

**Terén a data**

- Řádek 0 je sever ve všech datech; záměna os je nejtypičtější chyba.
- Vzdálený terén musí odvodit metry na stupeň z blízké mapy, ne z vlastního
  `cos(lat)`.
- Normály se počítají přes celou mřížku před řezáním na dlaždice, jinak vzniknou
  osvětlovací švy.
- Landcover se zmenšuje hlasováním, ne průměrem.
- Zanoření horizontu musí být užší než culling zóna.
- `heightAt` clampuje na `gw − 1.001`, ne `gw − 1`.

**Grafika**

- Nestínovat dvakrát (zapečený hillshade × Lambert).
- Stíny násobit jen do přímého světla, nikdy do ambientu.
- `OutputPass` za září a před doladěním.
- Práh záře nad 1,0; co má zářit, musí mít barvu nad jedničkou.
- Každý vlastní shader musí projít stejným tónovým mapováním jako zbytek scény.
- Průhledné roviny ve scéně vždy `DoubleSide` — hráč je pod nimi.
- Aditivní míchání na modré obloze nikdy nevyrobí červenou.
- Barevné pásy kreslit per-pixel, ne tahy štětcem.
- `CanvasTexture` s barvami potřebuje `SRGBColorSpace`.
- Erodovat mrak jen na siluetě.
- Lens flare kotvit na pevnou vzdálenost, ne na NDC hloubku.
- Chvění kotvit na zem, ne do komína.
- Stromy `MeshBasicMaterial`, ne Lambert.

**Chování aplikace**

- `blur` na mobilu nepauzovat — prohlížeče ho střílejí i při dotycích.
- Čas letu sčítat z kroků simulace, ne z rozdílu časových razítek.
- Každý grafický efekt ověřit screenshotem, ne kódem.
