// terrain.js — reálný terén Chamonix / Mont Blanc z Copernicus GLO-30 DEM.
// Souřadnice světa v METRECH: x na východ (0..sizeX), z na jih (0..sizeZ),
// y = nadmořská výška. Řádek 0 dat = severní okraj (z=0).
import * as THREE from 'three'

export class Terrain {
  /** Načte public/terrain/chamonix.{bin,json} a postaví mesh. */
  static async load() {
    const [meta, buf, cover] = await Promise.all([
      fetch('/terrain/chamonix.json').then(r => r.json()),
      fetch('/terrain/chamonix.bin').then(r => r.arrayBuffer()),
      // pokrytí je nepovinné — bez něj se barví jen podle výšky a sklonu
      fetch('/terrain/chamonix-cover.bin')
        .then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null),
    ])
    return new Terrain(meta, new Uint16Array(buf), cover && new Uint8Array(cover))
  }

  constructor(meta, heights, cover = null) {
    this.cover = cover
    this.meta = meta
    this.gw = meta.gw
    this.gh = meta.gh
    this.sizeX = meta.widthM
    this.sizeZ = meta.heightM
    this.heights = heights
    this._buildMesh()
  }

  /** @param withSkirt zástěra pod okrajem mapy — netřeba, když je za mapou
   *  daleký terén (jinak by ho plocha zakrývala). */
  addTo(scene, { withSkirt = true } = {}) {
    scene.add(this.mesh)
    if (withSkirt) scene.add(this.skirt)
  }

  /** Třída pokrytí v daném místě (10 les, 30 tráva, 60 skála, 70 led, 80 voda…).
   *  Bez načtených dat vrací 0. */
  coverAt(x, z) {
    if (!this.cover) return 0
    const gx = Math.round(Math.min(this.gw - 1, Math.max(0, x / this.sizeX * (this.gw - 1))))
    const gz = Math.round(Math.min(this.gh - 1, Math.max(0, z / this.sizeZ * (this.gh - 1))))
    return this.cover[gz * this.gw + gx]
  }

  /** Výška terénu v metrech (bilineárně), mimo mapu drží okraj. */
  heightAt(x, z) {
    const fx = Math.min(this.gw - 1.001, Math.max(0, x / this.sizeX * (this.gw - 1)))
    const fz = Math.min(this.gh - 1.001, Math.max(0, z / this.sizeZ * (this.gh - 1)))
    const x0 = Math.floor(fx), z0 = Math.floor(fz)
    const tx = fx - x0, tz = fz - z0
    const h = this.heights
    const i = z0 * this.gw + x0
    return h[i] * (1 - tx) * (1 - tz) + h[i + 1] * tx * (1 - tz) +
      h[i + this.gw] * (1 - tx) * tz + h[i + this.gw + 1] * tx * tz
  }

  /** Normála terénu (pro svahové proudění a barvy). */
  normalAt(x, z, out = new THREE.Vector3()) {
    const d = 60 // metrů
    const hx = this.heightAt(x + d, z) - this.heightAt(x - d, z)
    const hz = this.heightAt(x, z + d) - this.heightAt(x, z - d)
    return out.set(-hx / (2 * d), 1, -hz / (2 * d)).normalize()
  }

  /** Sklon (0 = rovina, 1 = svislá stěna) a orientace svahu (azimut po svahu dolů). */
  slopeAspect(x, z) {
    const n = this.normalAt(x, z, _n)
    const slope = 1 - n.y
    const aspect = Math.atan2(n.x, n.z) // směr, kam svah "kouká" (x=východ, z=jih)
    return { slope, aspect, n }
  }

  /**
   * Zapečená viditelnost oblohy (ambientní okluze) z heightmapy.
   * Pro každý bod se v 8 směrech hledá nejvyšší horizont do 2,6 km; kolik
   * z oblohy zbude, tolik dopadá rozptýleného světla. Dno údolí tím ztmavne
   * a hřebeny vystoupí — bez toho vypadá terén jako plochý plakát.
   * Počítá se na 4× řidší mřížce a interpoluje (jinak by to byly miliony
   * vzorků a načítání by trvalo vteřiny).
   */
  _bakeSkyOcclusion(step = 4) {
    const aw = Math.ceil(this.gw / step), ah = Math.ceil(this.gh / step)
    const out = new Float32Array(aw * ah)
    const DIRS = 8, STEPS = 8, MAXD = 2600
    const dirs = []
    for (let d = 0; d < DIRS; d++) {
      const a = d / DIRS * Math.PI * 2
      dirs.push([Math.cos(a), Math.sin(a)])
    }
    for (let az = 0; az < ah; az++) {
      for (let ax = 0; ax < aw; ax++) {
        const gx = Math.min(this.gw - 1, ax * step), gz = Math.min(this.gh - 1, az * step)
        const wx = gx / (this.gw - 1) * this.sizeX
        const wz = gz / (this.gh - 1) * this.sizeZ
        const h0 = this.heights[gz * this.gw + gx]
        let open = 0
        for (const [dx, dz] of dirs) {
          let maxT = 0
          for (let s = 1; s <= STEPS; s++) {
            const dist = MAXD * s / STEPS
            const t = (this.heightAt(wx + dx * dist, wz + dz * dist) - h0) / dist
            if (t > maxT) maxT = t
          }
          open += 1 - maxT / Math.hypot(1, maxT) // podíl volné oblohy v tom směru
        }
        out[az * aw + ax] = open / DIRS
      }
    }
    this._aoW = aw; this._aoH = ah; this._aoStep = step
    return out
  }

  /** Okluze v bodě mřížky (bilineárně z řidší mapy). */
  _aoAt(ao, gx, gz) {
    const fx = Math.min(this._aoW - 1.001, gx / this._aoStep)
    const fz = Math.min(this._aoH - 1.001, gz / this._aoStep)
    const x0 = fx | 0, z0 = fz | 0, tx = fx - x0, tz = fz - z0
    const w = this._aoW, i = z0 * w + x0
    return ao[i] * (1 - tx) * (1 - tz) + ao[i + 1] * tx * (1 - tz) +
      ao[i + w] * (1 - tx) * tz + ao[i + w + 1] * tx * tz
  }

  /**
   * Vržené stíny hor pro DANOU polohu slunce. Z každého bodu se vystřelí
   * paprsek ke slunci a hledá se, jestli mu v cestě nestojí hřeben. Ráno
   * a večer tak leží půl údolí ve stínu Aiguilles — teprve tím dostane
   * krajina měřítko a dramatičnost.
   *
   * Krok roste geometricky (blízko jemně, daleko hrubě), takže 25 km stačí
   * projít ~27 vzorky. Počítá se na řidší mřížce a interpoluje — rozmazaná
   * hrana stínu tu nevadí, polostín tak akorát vypadá.
   */
  _bakeSunShadow(sunDir, step = 3) {
    const aw = Math.ceil(this.gw / step), ah = Math.ceil(this.gh / step)
    const out = new Float32Array(aw * ah)
    const sx = sunDir.x, sy = Math.max(0.02, sunDir.y), sz = sunDir.z
    for (let az = 0; az < ah; az++) {
      for (let ax = 0; ax < aw; ax++) {
        const gx = Math.min(this.gw - 1, ax * step), gz = Math.min(this.gh - 1, az * step)
        const wx = gx / (this.gw - 1) * this.sizeX
        const wz = gz / (this.gh - 1) * this.sizeZ
        const h0 = this.heights[gz * this.gw + gx] + 3
        let worst = 0
        for (let d = 70; d < 25000; d *= 1.25) {
          const ray = h0 + sy * d
          if (ray > this.meta.hmax) break // nad nejvyšším vrcholem už nic nestíní
          const hx = this.heightAt(wx + sx * d, wz + sz * d)
          const excess = (hx - ray) / d
          if (excess > worst) worst = excess
        }
        // měkký přechod: hrana stínu není nikdy ostrá jako nůž
        const t = Math.min(1, Math.max(0, worst / 0.02))
        out[az * aw + ax] = 1 - t * t * (3 - 2 * t)
      }
    }
    this._shW = aw; this._shH = ah; this._shStep = step
    return out
  }

  /** Hodnota z řidší mřížky (bilineárně) — společné pro okluzi i stíny. */
  _sampleCoarse(arr, w, h, step, gx, gz) {
    const fx = Math.min(w - 1.001, gx / step)
    const fz = Math.min(h - 1.001, gz / step)
    const x0 = fx | 0, z0 = fz | 0, tx = fx - x0, tz = fz - z0
    const i = z0 * w + x0
    return arr[i] * (1 - tx) * (1 - tz) + arr[i + 1] * tx * (1 - tz) +
      arr[i + w] * (1 - tx) * tz + arr[i + w + 1] * tx * tz
  }

  /**
   * Nasadit stíny: vržené stíny hřebenů jako atribut vrcholu a stíny mraků
   * jako textura promítnutá shora. Obojí se v shaderu násobí JEN do přímého
   * světla slunce — rozptýlené světlo oblohy ve stínu zůstává, takže stíny
   * jsou modré a prokreslené, ne černé díry.
   */
  applyShadows(sunDir, cloudTex) {
    const lit = this._bakeSunShadow(sunDir)
    for (const ch of this._chunks) {
      const arr = new Float32Array(ch.w * ch.h)
      const wat = new Float32Array(ch.w * ch.h)
      let vi = 0
      for (let gz = ch.z0; gz <= ch.z1; gz++) {
        for (let gx = ch.x0; gx <= ch.x1; gx++) {
          arr[vi] = this._sampleCoarse(lit, this._shW, this._shH, this._shStep, gx, gz)
          wat[vi] = (this.cover && this.cover[gz * this.gw + gx] === 80) ? 1 : 0
          vi++
        }
      }
      ch.mesh.geometry.setAttribute('aShadow', new THREE.BufferAttribute(arr, 1))
      ch.mesh.geometry.setAttribute('aWater', new THREE.BufferAttribute(wat, 1))
    }

    const mat = this._mat
    mat.onBeforeCompile = shader => {
      shader.uniforms.uCloudTex = { value: cloudTex }
      shader.uniforms.uCloudRect = { value: new THREE.Vector4(0, 0, this.sizeX, this.sizeZ) }
      shader.uniforms.uSunDir = { value: sunDir.clone() }
      this._terrainShader = shader // kvůli výměně stínů mraků za letu
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float aShadow;
          attribute float aWater;
          varying float vShadow;
          varying float vWater;
          varying vec2 vWXZ;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vShadow = aShadow;
          vWater = aWater;
          vWXZ = position.xz;`) // terén je přímo ve světových metrech
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying float vShadow;
          varying float vWater;
          varying vec2 vWXZ;
          uniform sampler2D uCloudTex;
          uniform vec4 uCloudRect;
          uniform vec3 uSunDir;`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          vec2 cuv = (vWXZ - uCloudRect.xy) / uCloudRect.zw;
          float cloud = texture2D(uCloudTex, cuv).r;
          float lit = vShadow * (1.0 - 0.6 * cloud);
          reflectedLight.directDiffuse *= lit;
          // Třpyt vody: sluneční odlesk jen na vodních plochách (aWater).
          // Lambert specular nesčítá, proto jde odlesk do directDiffuse.
          // Normála i pohled jsou ve view space → slunce převést tamtéž.
          vec3 sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
          float spec = pow(max(dot(reflect(-sunV, normal), geometryViewDir), 0.0), 80.0);
          reflectedLight.directDiffuse += vWater * spec * vec3(1.0, 0.98, 0.9) * 2.4 * lit;`)
    }
    mat.needsUpdate = true
  }

  /** Vyměnit mapu stínů mraků — mraky driftují, stíny musí plout s nimi. */
  updateCloudShadows(tex) {
    const sh = this._terrainShader
    if (!sh) { tex.dispose(); return } // materiál ještě není zkompilovaný
    const old = sh.uniforms.uCloudTex.value
    sh.uniforms.uCloudTex.value = tex
    if (old) old.dispose()
  }

  _buildMesh() {
    const { gw, gh } = this
    const cell = this.sizeX / (gw - 1)
    const ao = this._bakeSkyOcclusion(4)

    // 1) barvy + výšky + ANALYTICKÉ normály pro celou mřížku (normály ze
    //    spádu heightmapy — spojité i přes hranice dlaždic, žádné švy)
    const colors = new Float32Array(gw * gh * 3)
    const normals = new Float32Array(gw * gh * 3)
    const c = new THREE.Color()
    // Alpská paleta, kolo 2: víc chromy ve vegetaci (šťavnaté údolí, zlatavé
    // hole), skála a suť lehce do tepla. Sytost dělá "malovaný" dojem,
    // hloubku pak dodají velké barevné laloky a teplé jižní svahy níže.
    const rock = new THREE.Color(0x8d8478)
    const rockDark = new THREE.Color(0x5d584f)
    const scree = new THREE.Color(0xa19484)   // suť pod stěnami
    const snow = new THREE.Color(0xf2f6fb)
    const glacier = new THREE.Color(0xd6e6f0)
    const crevasse = new THREE.Color(0x6f93ad) // led v hloubce trhlin
    const forest = new THREE.Color(0x39603c)
    const alpine = new THREE.Color(0x9aa858)  // hole nad lesem, do zlatova
    const valley = new THREE.Color(0x6f9c50)
    const water = new THREE.Color(0x3f6f8e)
    const town = new THREE.Color(0x8e877e)
    const heather = new THREE.Color(0x9b7f8e) // vřes a kvetoucí hole

    for (let gz = 0; gz < gh; gz++) {
      for (let gx = 0; gx < gw; gx++) {
        const i = gz * gw + gx
        const h = this.heights[i]
        const xl = this.heights[gz * gw + Math.max(0, gx - 1)]
        const xr = this.heights[gz * gw + Math.min(gw - 1, gx + 1)]
        const zu = this.heights[Math.max(0, gz - 1) * gw + gx]
        const zd = this.heights[Math.min(gh - 1, gz + 1) * gw + gx]
        const slope = Math.min(1, Math.hypot(xr - xl, zd - zu) / (4 * cell))

        // normála ze spádu (centrální diference)
        const nx = (xl - xr) / (2 * cell), nz = (zu - zd) / (2 * cell)
        const inv = 1 / Math.hypot(nx, 1, nz)
        normals[i * 3] = nx * inv
        normals[i * 3 + 1] = inv
        normals[i * 3 + 2] = nz * inv

        // hladký šum (ne per-vertex sůl a pepř) — hranice sněhu i lesa
        // se pak vlní v plochách, jak to v horách vypadá
        const n01 = vnoise(gx / 9, gz / 9, 1)
        const n02 = vnoise(gx / 3.5, gz / 3.5, 7)
        // velké laloky (~1,5 km): svěží vs. sušší louky — krajina pak není
        // jedna plocha zelené, ale mozaika jako z výškové fotky
        const n03 = vnoise(gx / 26, gz / 26, 3)

        // Orientace svahu: nz > 0 = svah kouká na JIH (osa z míří k jihu).
        // Na jižních stráních taje dřív → sníh i les sahají výš; severní
        // stěny drží sníh dole. Tohle dělá alpský reliéf čitelným.
        const south = Math.max(-1, Math.min(1, nz * inv * 3))
        // dvě měřítka šumu: velké laloky + drobné roztřepení okraje, jinak
        // hranice sněhu vypadá jako natržený papír
        const snowLine = 2680 + n01 * 240 + n02 * 70 + south * 260
        const treeLine = 1900 + n01 * 160 + n02 * 60 + south * 120

        let snowy = 0
        // ── skutečné pokrytí (ESA WorldCover) má přednost před odhadem ──
        const klass = this.cover ? this.cover[i] : 0
        if (klass) {
          if (klass === 70) {          // trvalý sníh a led = ledovce
            c.copy(slope < 0.3 ? glacier : snow)
            // Trhliny a séraky: modravé příčné pruhy zhruba po vrstevnicích
            // tam, kde ledovec teče (mírný sklon). Z výšky je to TEN detail,
            // který odliší živý ledovec od bílé silnice — viz Mer de Glace.
            if (slope > 0.05 && slope < 0.5) {
              const band = Math.abs(((h + n02 * 14) % 26 + 26) % 26 / 26 - 0.5)
              const crev = Math.max(0, 1 - band / 0.16) * Math.min(1, slope * 6)
              c.lerp(crevasse, crev * 0.4)
            }
            snowy = 1
          } else if (klass === 80) {   // voda
            c.copy(water)
          } else if (klass === 50) {   // zástavba
            c.copy(town)
          } else if (klass === 10) {   // les — s výškou tmavne
            c.copy(forest).lerp(valley, Math.max(0, 1 - (h - 700) / 900) * 0.45)
          } else if (klass === 60) {   // holá půda a skála
            c.copy(scree).lerp(rock, Math.min(1, slope * 1.4))
          } else if (klass === 100 || klass === 20) { // mech, křoviny nad lesem
            c.copy(alpine).lerp(scree, 0.35)
          } else {                     // tráva a pole
            c.copy(h > treeLine ? alpine : valley)
          }
          // ── šťavnatost vegetace: velké laloky svěžести + jižní svahy
          //    do teplé žluti (slunce "vypaluje"), severní chladnější ──
          if (klass === 10 || klass === 20 || klass === 30 || klass === 100 || klass === 40) {
            const lush = (n03 - 0.5) * 2
            c.offsetHSL(-south * 0.012 + lush * 0.008, 0.10 + lush * 0.05, 0.012 + south * 0.008)
            // kvetoucí vřesové fleky nad hranicí lesa
            if (h > treeLine - 100 && n02 > 0.74) c.lerp(heather, Math.min(1, (n02 - 0.74) * 3) * 0.3)
          }
          // Skála přebíjí všechno na stěnách: v 10m datech je na srázech
          // šum a travnatý flek uprostřed severní stěny vypadá divně.
          if (slope > 0.55 && klass !== 70) c.lerp(rockDark, Math.min(1, (slope - 0.55) * 2))
          // sezónní poprašek nad ~3200 m tam, kde nejsou trvalé ledovce
          if (h > 3200 && klass !== 70 && slope < 0.6) {
            const t = Math.min(0.85, (h - 3200) / 500)
            c.lerp(snow, t)
            snowy = Math.max(snowy, t)
          }
          c.offsetHSL((n02 - 0.5) * 0.02, (n01 - 0.5) * 0.05, (n02 - 0.5) * 0.05)
          const aoK = this._aoAt(ao, gx, gz)
          const fK = (0.73 + 0.27 * aoK) * (1 - snowy) + (0.93 + 0.07 * aoK) * snowy
          colors[i * 3] = c.r * fK
          colors[i * 3 + 1] = c.g * fK
          colors[i * 3 + 2] = c.b * fK
          continue
        }

        if (h > snowLine) {
          c.copy(snow)
          snowy = 1
          // firn a ledovec drží na mírných plochách, stěny jsou holé
          if (slope < 0.34 && h > 2950) c.lerp(glacier, 0.5)
          if (slope > 0.62) {
            const bare = Math.min(1, (slope - 0.62) * 1.8)
            c.lerp(rockDark, bare)
            snowy = 1 - bare
          }
        } else if (slope > 0.5) {
          c.copy(rock).lerp(rockDark, Math.min(1, (slope - 0.5) * 2))
        } else if (h > treeLine) {
          // nad lesem: hole → suť → skála, plynule s výškou i sklonem
          const t = Math.min(1, (h - treeLine) / Math.max(300, snowLine - treeLine))
          c.copy(alpine).lerp(scree, Math.min(1, t * 1.2 + slope * 0.5))
          if (t > 0.7) c.lerp(rock, (t - 0.7) * 2)
        } else {
          c.copy(valley).lerp(forest, Math.min(1, (h - 700) / Math.max(400, treeLine - 700)))
          if (slope > 0.34) c.lerp(rock, Math.min(1, (slope - 0.34) * 1.4))
        }
        // šťavnatost vegetace — stejné ladění jako u dat pokrytí výše
        if (h <= snowLine && slope <= 0.5) {
          const lush = (n03 - 0.5) * 2
          c.offsetHSL(-south * 0.012 + lush * 0.008, 0.10 + lush * 0.05, 0.012 + south * 0.008)
          if (h > treeLine - 100 && n02 > 0.74) c.lerp(heather, Math.min(1, (n02 - 0.74) * 3) * 0.3)
        }
        // jemná nepravidelnost, ať plochy nejsou jako z plastu
        c.offsetHSL((n02 - 0.5) * 0.02, (n01 - 0.5) * 0.06, (n02 - 0.5) * 0.055)

        // Bez zapečeného hillshadu: směrové stínování teď dělá skutečné
        // slunce (Lambert + normály), takže se scéna mění s denní dobou.
        // Dřív se stínovalo dvakrát a všechno bylo přesvícené a ploché.
        // Zapečená zůstává jen okluze oblohy — ta na směru slunce nezávisí.
        // Na sněhu se ale tlumí: bílý povrch si světlo mnohonásobně odráží
        // sám mezi sebou, takže stíny ve sněhu nejsou černé, ale modré.
        // Bez téhle výjimky měl masiv v žlabech špinavé černé díry.
        const aoV = this._aoAt(ao, gx, gz)
        // okluze smí tmavit mírněji, než když byla jediným zdrojem hloubky —
        // reliéf teď kreslí hlavně vržené stíny slunce (viz applyShadows)
        const f = (0.73 + 0.27 * aoV) * (1 - snowy) + (0.93 + 0.07 * aoV) * snowy
        const blue = (1 - aoV) * snowy * 0.35 // modrý nádech sněhových stínů
        colors[i * 3] = c.r * f * (1 - blue * 0.09)
        colors[i * 3 + 1] = c.g * f * (1 - blue * 0.04)
        colors[i * 3 + 2] = c.b * f
      }
    }

    // 2) detailní šumová textura (struktura zblízka)
    const dc = document.createElement('canvas')
    dc.width = dc.height = 512
    const dctx = dc.getContext('2d')
    const dimg = dctx.createImageData(512, 512)
    let seed = 12345
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    // dvě oktávy: hrubé skvrny (interpolace mřížky 32×32) + jemné zrno
    const G = 33
    const grid = new Float32Array(G * G)
    for (let i = 0; i < G * G; i++) grid[i] = rnd()
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const fx = x / 512 * (G - 1), fy = y / 512 * (G - 1)
        const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0
        const coarse =
          grid[y0 * G + x0] * (1 - tx) * (1 - ty) + grid[y0 * G + x0 + 1] * tx * (1 - ty) +
          grid[(y0 + 1) * G + x0] * (1 - tx) * ty + grid[(y0 + 1) * G + x0 + 1] * tx * ty
        // kontrast pro strukturu zblízka, ale posunutý nahoru — tmavý šum
        // špinil barvy a sytá paleta pak vypadala zaprášeně
        const v = 186 + coarse * 54 + rnd() * 26
        const i = (y * 512 + x) * 4
        dimg.data[i] = v; dimg.data[i + 1] = v; dimg.data[i + 2] = v
        dimg.data[i + 3] = 255
      }
    }
    dctx.putImageData(dimg, 0, 0)
    const detail = new THREE.CanvasTexture(dc)
    detail.wrapS = detail.wrapT = THREE.RepeatWrapping
    detail.repeat.set(this.sizeX / 190, this.sizeZ / 190)
    detail.anisotropy = 4
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: detail })
    this._mat = mat // applyShadows() do něj později vpíchne stínový kód

    // 3) mřížka rozřezaná na 4×4 dlaždice → frustum culling (kreslí se jen
    //    to, co je ve výhledu; jeden 735k mesh se kreslil vždy celý)
    this.mesh = new THREE.Group()
    this._chunks = []
    const CH = 4
    const xCuts = [], zCuts = []
    for (let k = 0; k <= CH; k++) {
      xCuts.push(Math.round(k * (gw - 1) / CH))
      zCuts.push(Math.round(k * (gh - 1) / CH))
    }
    for (let cz = 0; cz < CH; cz++) {
      for (let cx = 0; cx < CH; cx++) {
        const x0 = xCuts[cx], x1 = xCuts[cx + 1]
        const z0 = zCuts[cz], z1 = zCuts[cz + 1]
        const w = x1 - x0 + 1, hgt = z1 - z0 + 1
        const pos = new Float32Array(w * hgt * 3)
        const nor = new Float32Array(w * hgt * 3)
        const col = new Float32Array(w * hgt * 3)
        const uv = new Float32Array(w * hgt * 2)
        let vi = 0
        for (let gz = z0; gz <= z1; gz++) {
          for (let gx = x0; gx <= x1; gx++) {
            const gi = gz * gw + gx
            pos[vi * 3] = gx / (gw - 1) * this.sizeX
            pos[vi * 3 + 1] = this.heights[gi]
            pos[vi * 3 + 2] = gz / (gh - 1) * this.sizeZ
            nor[vi * 3] = normals[gi * 3]
            nor[vi * 3 + 1] = normals[gi * 3 + 1]
            nor[vi * 3 + 2] = normals[gi * 3 + 2]
            col[vi * 3] = colors[gi * 3]
            col[vi * 3 + 1] = colors[gi * 3 + 1]
            col[vi * 3 + 2] = colors[gi * 3 + 2]
            uv[vi * 2] = gx / (gw - 1)
            uv[vi * 2 + 1] = 1 - gz / (gh - 1)
            vi++
          }
        }
        const idx = []
        for (let r = 0; r < hgt - 1; r++) {
          for (let q = 0; q < w - 1; q++) {
            const a = r * w + q
            idx.push(a, a + w, a + 1, a + 1, a + w, a + w + 1)
          }
        }
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
        geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
        geo.setIndex(idx)
        const mesh = new THREE.Mesh(geo, mat)
        this.mesh.add(mesh)
        this._chunks.push({ mesh, x0, x1, z0, z1, w, h: hgt })
      }
    }

    // Okolní "svět" pod okrajem mapy, ať není vidět do prázdna. Barva je
    // vybledlá do oparu — sytě zelená se na obzoru rýsovala jako pruh
    // trávníku za horami.
    this.skirt = new THREE.Mesh(
      new THREE.PlaneGeometry(this.sizeX * 7, this.sizeZ * 7),
      new THREE.MeshLambertMaterial({ color: 0xa2ada0 }),
    )
    this.skirt.rotation.x = -Math.PI / 2
    this.skirt.position.set(this.sizeX / 2, Math.max(0, this.meta.hmin - 12), this.sizeZ / 2)
  }

  /** lat/lon → lokální metry (pro rozmístění bran a startu). */
  fromLatLon(lat, lon) {
    const m = this.meta
    const x = (lon - m.lon0) / (m.lon1 - m.lon0) * this.sizeX
    const z = (m.lat1 - lat) / (m.lat1 - m.lat0) * this.sizeZ
    return { x, z }
  }
}

const _n = new THREE.Vector3()

// hodnotový šum s hladkou interpolací (pro hranice sněhu, lesa a odstíny)
function hash2(x, z, s) {
  const h = Math.imul((x * 73856093) ^ (z * 19349663) ^ (s * 83492791), 2654435761)
  return ((h >>> 8) & 1023) / 1023
}

function vnoise(x, z, s) {
  const x0 = Math.floor(x), z0 = Math.floor(z)
  const tx = x - x0, tz = z - z0
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz)
  const a = hash2(x0, z0, s), b = hash2(x0 + 1, z0, s)
  const c = hash2(x0, z0 + 1, s), d = hash2(x0 + 1, z0 + 1, s)
  return (a * (1 - sx) + b * sx) * (1 - sz) + (c * (1 - sx) + d * sx) * sz
}
