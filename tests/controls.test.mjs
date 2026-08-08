// Test směru ovládání náklonem — bez prohlížeče, nad reálným controls.js.
//
// Proč existuje: směr výšky u náklonu se v historii projektu otočil "od
// stolu" špatným směrem a přišlo se na to až na telefonu. Tenhle test drží
// dohodnutou konvenci: VÝCHOZÍ (invertY = true) je "telefon k sobě = nos
// dolů". Když ji někdo bude chtít změnit, ať to udělá vědomě i tady.
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
assert.equal(new FlightControls().invertY, true,
  'výchozí je invertY = true, tedy telefon k sobě = nos dolů')

function fresh() {
  const c = new FlightControls()
  c.tiltAvailable = true
  c.setMode('tilt')
  c.setInvertY(true) // nastavení je společné pro celý modul, sjednotit start
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

// 2) výchozí směr: telefon K SOBĚ (strmější displej) = nos DOLŮ (pitch > 0)
{
  const c = fresh()
  for (let i = 0; i < 30; i++) orient(c, { gamma: -60 }) // k sobě
  assert.ok(c.getInput().pitch > 0.1, 'k sobě musí dát nos dolů')
  for (let i = 0; i < 30; i++) orient(c, { gamma: -20 }) // od sebe
  assert.ok(c.getInput().pitch < -0.1, 'od sebe musí dát nos nahoru')
}

// 3) přepnutí směru obrátí obojí
{
  const c = fresh()
  c.setInvertY(false)
  for (let i = 0; i < 30; i++) orient(c, { gamma: -60 })
  assert.ok(c.getInput().pitch < -0.1, 'po přepnutí je k sobě nos nahoru')
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
  c.stick.dy = 1 // tah dolů po obrazovce
  assert.ok(c.getInput().pitch > 0.1, 'tah dolů = nos dolů (stejně jako náklon)')
  c.setInvertY(false)
  assert.ok(c.getInput().pitch < -0.1, 'po přepnutí je tah dolů nos nahoru')
}

// 7) bez povoleného senzoru se do náklonu přepnout nelze
{
  const c = new FlightControls()
  c.tiltAvailable = false
  assert.equal(c.setMode('tilt'), 'touch', 'bez senzoru vždy dotyk')
}

console.log('OK — ovládání drží dohodnutou konvenci (7 testů)')
