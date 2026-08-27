// Test směru ovládání náklonem — bez prohlížeče, nad reálným controls.js.
//
// Proč existuje: směr výšky se v historii projektu už dvakrát otočil "od
// stolu". Dohodnutá konvence: VÝCHOZÍ (invertY = false) je "telefon k sobě
// = nos nahoru, stoupám" — jako knipl. Když ji někdo bude chtít změnit, ať
// to udělá vědomě i tady.
//
// Pozor: znaménko vstupu je jen půlka pravdy. `pitch > 0` znamená v celé hře
// NOS DOLŮ (glider.js: theta > 0 → vyšší rovnovážná rychlost → klesání).
// Test to hlídá i z téhle strany, protože právě rozpor mezi vstupem, fyzikou
// a kreslením modelu byl původní chybou.
//
// Spuštění: node tests/controls.test.mjs
import assert from 'node:assert/strict'

// ── minimální stub prohlížeče ──
const store = new Map()
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
}
globalThis.addEventListener = () => {}
globalThis.document = { getElementById: () => null }
globalThis.performance = { now: () => 0 }
globalThis.screen = { orientation: { angle: 90 } } // telefon na šířku
globalThis.navigator = { getGamepads: () => [] }
globalThis.window = globalThis

const { FlightControls } = await import('../src/controls.js')

/**
 * Poloha telefonu na šířku (angle 90): beta = náklon do stran (roll),
 * gamma = sklon "dopředu/dozadu" (pitch). gamma = −40 znamená displej
 * odkloněný 40° od vodorovné roviny, tedy pohodlné držení v ruce.
 */
const orient = (c, { beta = 0, gamma = -40 }) => c._onOrient({ beta, gamma })

// 0) výchozí konvence — čte se z prázdného úložiště, než ji cokoli přepíše
assert.equal(new FlightControls().invertY, false,
  'výchozí je invertY = false, tedy telefon k sobě = nos nahoru')

function fresh() {
  const c = new FlightControls()
  c.tiltAvailable = true
  c.setMode('tilt')
  c.setInvertY(false) // nastavení je společné pro celý modul, sjednotit start
  c.calibrate()
  for (let i = 0; i < 45; i++) orient(c, { gamma: -40 }) // neutrál = 40°
  return c
}

// 1) neutrál nic neřídí
{
  const c = fresh()
  orient(c, { gamma: -40 })
  const i = c.getInput()
  assert.ok(Math.abs(i.pitch) < 0.02, `neutrál nesmí řídit, je ${i.pitch}`)
  assert.ok(Math.abs(i.roll) < 0.02, `neutrál nesmí zatáčet, je ${i.roll}`)
}

// 2) výchozí směr: telefon K SOBĚ (strmější displej) = nos NAHORU (pitch < 0)
{
  const c = fresh()
  for (let i = 0; i < 30; i++) orient(c, { gamma: -60 }) // k sobě
  assert.ok(c.getInput().pitch < -0.1, 'k sobě musí zvedat nos')
  for (let i = 0; i < 30; i++) orient(c, { gamma: -20 }) // od sebe
  assert.ok(c.getInput().pitch > 0.1, 'od sebe musí dát nos dolů')
}

// 2b) stejně to musí platit na výšku (portrét) — Zdeněk hraje takhle.
// V portrétu nese sklon telefonu beta, ne gamma; převod na osy displeje
// dělá _orientedTilt a nesmí u toho směr otočit.
{
  globalThis.screen.orientation.angle = 0
  const c = new FlightControls()
  c.tiltAvailable = true
  c.setMode('tilt')
  c.setInvertY(false)
  c.calibrate()
  for (let i = 0; i < 45; i++) c._onOrient({ beta: 50, gamma: 0 }) // neutrál
  for (let i = 0; i < 30; i++) c._onOrient({ beta: 70, gamma: 0 }) // k sobě
  assert.ok(c.getInput().pitch < -0.1, 'portrét: k sobě musí zvedat nos')
  for (let i = 0; i < 30; i++) c._onOrient({ beta: 30, gamma: 0 }) // od sebe
  assert.ok(c.getInput().pitch > 0.1, 'portrét: od sebe musí dát nos dolů')
  globalThis.screen.orientation.angle = 90
}

// 3) přepnutí směru obrátí obojí
{
  const c = fresh()
  c.setInvertY(true)
  for (let i = 0; i < 30; i++) orient(c, { gamma: -60 })
  assert.ok(c.getInput().pitch > 0.1, 'po přepnutí je k sobě nos dolů')
}

// 4) náklon do strany zatáčí na tu stranu, kam se telefon naklonil
{
  const c = fresh()
  for (let i = 0; i < 30; i++) orient(c, { beta: 20, gamma: -40 })
  const r = c.getInput().roll
  assert.ok(Math.abs(r) > 0.1, 'náklon do strany musí zatáčet')
  const c2 = fresh()
  for (let i = 0; i < 30; i++) orient(c2, { beta: -20, gamma: -40 })
  assert.ok(Math.sign(c2.getInput().roll) === -Math.sign(r), 'opačný náklon = opačná zatáčka')
}

// 5) mrtvá zóna: drobný třes rukou neřídí
{
  const c = fresh()
  for (let i = 0; i < 30; i++) orient(c, { gamma: -41 }) // 1° = pod prahem 1,5°
  assert.equal(c.getInput().pitch, 0, 'do 1,5° se nesmí nic dít')
}

// 6) v režimu dotyku náklon neřídí a knipl ano
{
  const c = fresh()
  for (let i = 0; i < 30; i++) orient(c, { gamma: -60 })
  c.setMode('touch')
  assert.equal(c.getInput().pitch, 0, 'v dotykovém režimu náklon neřídí')
  c.stick.active = true
  c.stick.dy = 1 // tah dolů po obrazovce = přitažení kniplu
  assert.ok(c.getInput().pitch < -0.1, 'tah dolů = nos nahoru (jako přitažení)')
  c.setInvertY(true)
  assert.ok(c.getInput().pitch > 0.1, 'po přepnutí je tah dolů nos dolů')
}

// 7) bez povoleného senzoru se do náklonu přepnout nelze
{
  const c = new FlightControls()
  c.tiltAvailable = false
  assert.equal(c.setMode('tilt'), 'touch', 'bez senzoru vždy dotyk')
}

// 8) VŠECHNY vstupy míří stejně a všechny poslouchají ⇅.
// Klávesnice tuhle konvenci dlouho porušovala (↑ = nos nahoru) a přepínač
// na ni vůbec nesahal — na PC to působilo obráceně a nešlo to zapnout.
{
  const desktop = () => {
    const c = new FlightControls()
    c.tiltAvailable = false
    c.setMode('touch')
    c.setInvertY(false)
    return c
  }
  // klávesnice: šipka dolů = přitáhnout = nos nahoru (pitch < 0)
  {
    const c = desktop()
    c.keys.ArrowDown = true
    assert.ok(c.getInput().pitch < -0.1, 'šipka dolů musí zvedat nos')
    c.keys.ArrowDown = false
    c.keys.ArrowUp = true
    assert.ok(c.getInput().pitch > 0.1, 'šipka nahoru musí dát nos dolů')
    c.setInvertY(true)
    assert.ok(c.getInput().pitch < -0.1, 'po ⇅ musí šipka nahoru zvedat nos')
  }
  // myš-knipl: tažení dolů = přitáhnout
  {
    const c = desktop()
    c.mouse.active = true
    c.mouse.dy = 1
    assert.ok(c.getInput().pitch < -0.1, 'tažení myší dolů musí zvedat nos')
    c.setInvertY(true)
    assert.ok(c.getInput().pitch > 0.1, 'po ⇅ dává tažení dolů nos dolů')
  }
  // gamepad: páčka k sobě (axes[1] > 0) = přitáhnout
  {
    globalThis.navigator = { getGamepads: () => [{ axes: [0, 1] }] }
    const c = desktop()
    assert.ok(c.getInput().pitch < -0.1, 'páčka k sobě musí zvedat nos')
    c.setInvertY(true)
    assert.ok(c.getInput().pitch > 0.1, 'po ⇅ dává páčka k sobě nos dolů')
    globalThis.navigator = { getGamepads: () => [] }
  }
}

console.log('OK — ovládání drží dohodnutou konvenci (8 testů)')
