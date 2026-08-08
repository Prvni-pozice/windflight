// Test, že si vstup, fyzika a kresba modelu neodporují.
//
// Původní chyba (nalezena 8. 8. 2026 na telefonu): letadlo se kreslilo
// s nosem nahoru, zatímco fyzika zrychlovala a klesala. Vizuál se totiž
// otáčel opačným znaménkem než theta. Kdo bude sahat na pitch, musí projít
// tímhle testem — kontroluje OBĚ strany najednou.
//
// Spuštění: node tests/pitch-consistency.test.mjs
import assert from 'node:assert/strict'

// canvas stub (Glider si kreslí texturu stínu)
const ctxStub = new Proxy({}, { get: (t, p) => (p === 'canvas' ? {} : () => ctxStub), set: () => true })
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }) }
globalThis.performance = { now: () => 0 }

const THREE = await import('../node_modules/three/build/three.module.js')
const { Glider } = await import('../src/glider.js')

const scene = { add() {} }
const terrain = { heightAt: () => 0 }
const wind = new THREE.Vector3(0, 0, 0)

/** Odletí 3 s s daným vstupem a vrátí, co se stalo. */
function fly(pitch) {
  const g = new Glider(scene)
  g.reset(new THREE.Vector3(0, 3000, 0), 0)
  const v0 = g.v, y0 = g.pos.y
  for (let i = 0; i < 30; i++) g.update(0.1, { pitch, roll: 0 }, 0, wind, terrain)
  // kam ukazuje nos modelu (model má nos na −z)
  const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(g.model.quaternion)
  return { dv: g.v - v0, dy: g.pos.y - y0, noseY: nose.y, theta: g.theta }
}

// přitažení (pitch < 0): nos nahoru, zpomaluji, stoupám
{
  const r = fly(-0.8)
  assert.ok(r.theta < 0, `přitažení musí dát theta < 0, je ${r.theta.toFixed(2)}`)
  assert.ok(r.dv < -3, `přitažení musí zpomalit, změna je ${r.dv.toFixed(1)} m/s`)
  assert.ok(r.dy > 5, `přitažení musí vynést výš, změna je ${r.dy.toFixed(1)} m`)
  assert.ok(r.noseY > 0.05, `model musí mít nos NAHOŘE, noseY = ${r.noseY.toFixed(2)}`)
}

// potlačení (pitch > 0): nos dolů, zrychluji, klesám
{
  const r = fly(0.8)
  assert.ok(r.theta > 0, `potlačení musí dát theta > 0, je ${r.theta.toFixed(2)}`)
  assert.ok(r.dv > 3, `potlačení musí zrychlit, změna je ${r.dv.toFixed(1)} m/s`)
  assert.ok(r.dy < -5, `potlačení musí ztratit výšku, změna je ${r.dy.toFixed(1)} m`)
  assert.ok(r.noseY < -0.05, `model musí mít nos DOLE, noseY = ${r.noseY.toFixed(2)}`)
}

console.log('OK — vstup, fyzika i kresba modelu míří stejným směrem')
