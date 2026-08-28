// main.js — WINDFLIGHT: větroněm nad Mont Blankem. Reálný terén (Copernicus
// DEM), skutečné dnešní počasí (Open-Meteo), viditelné proudění vzduchu.
// Úkol: prolétnout všemi branami — bez využití termiky a svahů to nejde.
import * as THREE from 'three'
import { Terrain } from './terrain.js'
import { FarTerrain } from './far-terrain.js'
import { loadWeather, deriveConditions, sunPosition, sunDirVector } from './weather.js'
import { LiftField } from './lift.js'
import { Glider, V_STALL, V_MIN_SINK, polarSink } from './glider.js'
import { Gates, GATE_R } from './gates.js'
import { Vario } from './vario.js'
import { FlightControls } from './controls.js'
import { UI } from './ui.js'
import { buildScenery } from './scenery.js'
import { SnowSpray } from './spray.js'
import { Forest } from './trees.js'
import * as settings from './settings.js'
import { PostFX } from './postfx.js'
import { Atmosphere } from './atmosphere.js'

const START = { lat: 45.9290, lon: 6.8560, alt: 2600, headingDeg: 20 } // nad Chamonix, čelem k Bréventu

class Game {
  constructor(terrain, weather, far) {
    this.terrain = terrain
    this.weather = weather
    this.far = far
    this.state = 'menu' // menu | flying | done | crashed
    this.runMs = 0      // čas letu (jen běžící simulace, bez pauz)
    this.paused = false
    this.isTouch = matchMedia('(pointer: coarse)').matches

    this._setupRenderer()
    this._setupScene()
    this._applyQuality()

    this.controls = new FlightControls()
    this.vario = new Vario()
    this.glider = new Glider(this.scene)
    this.glider.initTrails(this.scene)
    this._camZoom = 1
    addEventListener('wheel', e => {
      this._camZoom = Math.max(0.6, Math.min(2.1, this._camZoom + e.deltaY * 0.0011))
    }, { passive: true })

    this.ui = new UI({
      weatherLabel: `${weather.label} · vítr ${Math.round(weather.windSpeed)} m/s ` +
        `${dirName(weather.windDirDeg)} · oblačnost ${Math.round(weather.cloudCover * 100)} %` +
        (weather.precip > 0.05 ? ` · déšť ${weather.precip.toFixed(1)} mm/h` : ''),
      gateTotal: this.gates.total,
      onStart: async () => {
        this.vario.init()
        if (this.isTouch) {
          await this.controls.enableTilt() // sám nastaví režim (náklon / dotyk)
          this._syncSettings()
        }
        this._startRun()
      },
      onRetry: () => this._startRun(this.runMode),
      onPause: () => this._pause(),
      onResume: () => this._resume(),
      onFree: async () => {
        this.vario.init()
        if (this.isTouch) { await this.controls.enableTilt(); this._syncSettings() }
        this._startRun('free')
      },
      onContinue: () => this._continueFromGate(),
    })

    // pauza: ESC/P, tlačítko ⏸, a hlavně AUTOMATICKY při odchodu z okna
    // (příchozí hovor / notifikace / přepnutí panelu) — let se jinak
    // "odehrával" bez hráče a čas běžel dál
    addEventListener('keydown', e => {
      if (e.code === 'Escape' || e.code === 'KeyP') {
        e.preventDefault()
        this.paused ? this._resume() : this._pause()
      }
    })
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._pause('Hra se sama zastavila, když jsi přepnul jinam')
    })
    // Ztráta fokusu okna pauzne jen na desktopu (klik do jiného okna).
    // Na mobilu NE: prohlížeče tam window blur střílejí i při dotycích a
    // systémových gestech, takže tah prstem po obrazovce zastavoval let.
    // Skutečný odchod ze hry (hovor, přepnutí aplikace) jistí visibilitychange.
    if (!this.isTouch) addEventListener('blur', () => this._pause())

    this.ui.buildMinimap(this.terrain, this.gates)
    this.ui.onMuteToggle = () => this.vario.toggleMute()
    this.ui.onModeToggle = () => {
      const m = this.controls.toggleMode()
      this.ui.setControlUi(this.controls)
      this.ui.toast(m === 'tilt'
        ? '📱 Náklon telefonu — drž ho chvíli v klidu (kalibrace)'
        : '✋ Knipl prstem — táhni kamkoli po obrazovce')
    }
    this.camMode = settings.get('camera') === 'cockpit' ? 'cockpit' : 'chase'
    this._applyCamMode()
    this.ui.onViewToggle = () => this._toggleView()
    addEventListener('keydown', e => { if (e.code === 'KeyC') this._toggleView() })
    this.ui.onInvertToggle = () => {
      const inv = this.controls.toggleInvertY()
      this._syncSettings()
      this.ui.toast(inv ? 'Náklon/tah k sobě = nos DOLŮ' : 'Náklon/tah k sobě = nos NAHORU')
    }
    this.ui.onInvertSet = v => { this.controls.setInvertY(v); this._syncSettings() }
    this.ui.onSens = v => this.controls.setSens(v)
    this.ui.onQuality = v => {
      settings.set('quality', v)
      this._applyQuality()
      this.ui.toast('Kvalita: ' + { auto: 'automaticky', low: 'nízká', med: 'střední', high: 'vysoká' }[v])
    }
    this._syncSettings()
    document.getElementById('mute-btn').textContent = this.vario.muted ? '🔇' : '🔊'
    this._spawn()

    this.clock = new THREE.Clock()
    this.renderer.setAnimationLoop(() => this._tick())
    addEventListener('resize', () => this._onResize())
    // ladicí hák pro screenshotové kontroly (viz ?cas= ve weather.js)
    if (new URLSearchParams(location.search).has('debug')) window.__wf = this
  }

  _setupRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this._prMax = Math.min(devicePixelRatio, this.isTouch ? 1.6 : 2)
    this._pr = this._prMax
    this.renderer.setPixelRatio(this._pr)
    this.renderer.setSize(innerWidth, innerHeight)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.02
    document.body.appendChild(this.renderer.domElement)
    this.camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 2, 90000)
  }

  _setupScene() {
    this.scene = new THREE.Scene()

    // slunce podle skutečného času v Chamonix
    this.sun = sunPosition()
    this.sunDir = sunDirVector(this.sun)
    this.cond = deriveConditions(this.weather, this.sun.elevDeg)

    // nálada dne: zataženo = měkčí slunce, víc rozptylu, šedavější opar
    const cc = this.weather.cloudCover
    // zlatá hodinka: nízké slunce = teplé světlo (skutečný čas v Chamonix)
    const golden = Math.max(0, Math.min(1, 1 - this.sun.elevDeg / 22))
    const sunCol = new THREE.Color(0xfff3dd).lerp(new THREE.Color(0xffb066), golden * 0.85)
    // Světelný rozpočet: dřív dir 2,1 + hemi 0,85 přes už zapečený hillshade
    // = přes trojnásobek, všechno vypálené do sytě zelené. Teď stínuje jen
    // skutečné slunce a součet drží pod ~1,8, takže terén má tvar a barvu.
    const sunLight = new THREE.DirectionalLight(sunCol, 1.5 * (1 - 0.5 * cc))
    sunLight.position.copy(this.sunDir).multiplyScalar(20000)
    this.scene.add(sunLight)
    // oblohové světlo vyplňuje stíny domodra, odraz od země dozelena
    // Oblohové světlo musí být silné: v horách svítí i stinná strana hřebene
    // rozptýleným světlem oblohy (proto jsou stíny modré, ne černé).
    // Barva musí být bledá: sytě modré nebe obarvilo celou severní stěnu
    // masivu do ocelova, přitom sníh ve stínu je světle modrobílý.
    // odraz od země zeleněji — sytá vegetace si říká o sytější bounce
    this.scene.add(new THREE.HemisphereLight(0xc2d8ee, 0x86975e, 0.8 + 0.5 * cc))

    // obloha: gradient + sluneční kotouč + opar u horizontu
    // barva oparu se počítá dřív než obloha — sdílejí ji (viz uHorizon)
    const fogCol = new THREE.Color().lerpColors(
      new THREE.Color(0xcfe0ee), new THREE.Color(0xc2c9d1), cc)

    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uSunDir: { value: this.sunDir },
        uHaze: { value: 0.5 + this.weather.cloudCover * 0.4 },
        uGolden: { value: golden },
        // obzor musí mít PŘESNĚ barvu oparu, jinak je vidět šev tam, kde
        // vzdálené hory přecházejí do oblohy
        uHorizon: { value: fogCol },
      },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uSunDir;
        uniform float uHaze;
        uniform float uGolden;
        uniform vec3 uHorizon;
        varying vec3 vDir;
        void main() {
          float h = max(vDir.y, 0.0);
          vec3 zenith = mix(vec3(0.13, 0.34, 0.72), vec3(0.20, 0.28, 0.54), uGolden);
          vec3 horizon = mix(uHorizon, vec3(0.98, 0.72, 0.45), uGolden * 0.7);
          // mocnina 0.42 drží modrou níž k obzoru — obloha nad horami
          // není bílá až do půli nebe
          vec3 col = mix(horizon, zenith, pow(h, 0.42));
          float s = max(dot(vDir, uSunDir), 0.0);
          vec3 sunTint = mix(vec3(1.0, 0.93, 0.8), vec3(1.0, 0.62, 0.3), uGolden);
          col += sunTint * (pow(s, 800.0) * 1.4 + pow(s, 32.0) * (0.18 + uGolden * 0.25));
          // pod obzorem plynule do oparu, ať tam není ostrá hrana
          col = mix(col, uHorizon, smoothstep(0.03, -0.08, vDir.y));
          // Barvy nahoře jsou psané "jak to má vypadat na displeji", takže
          // je tu převedeme do lineárního prostoru a necháme projít stejným
          // tónovým mapováním jako zbytek scény. Bez toho vypadá obloha bez
          // efektů jinak než s nimi (post-processing ji převáděl podruhé).
          gl_FragColor = vec4(pow(col, vec3(2.2)) * 1.35, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    })
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(70000, 32, 16), skyMat)
    this.scene.add(this.sky)

    // Vzdušná perspektiva: v horách je hloubka vidět hlavně přes opar.
    // Lineární mlha ubírala i ve 20 km sotva pětinu, takže vzdálené hřebeny
    // vypadaly jako kulisa nalepená na blízké. Exponenciální mlha odpovídá
    // tomu, jak světlo v atmosféře ubývá doopravdy.
    this.scene.fog = new THREE.FogExp2(fogCol, 0.000026 * (1 + cc * 0.5))

    this._fogDensity0 = this.scene.fog.density
    // Horizont: skutečné Alpy do ~120 km (FarTerrain). Když se data
    // nenačtou, zůstane aspoň zástěra pod okrajem mapy, ať není vidět
    // do prázdna.
    this.terrain.addTo(this.scene, { withSkirt: !this.far })
    if (this.far) this.far.addTo(this.scene)
    buildScenery(this.scene, this.terrain, this.sun)
    // les staví až _applyQuality() — jeho hustota závisí na nastavení
    this.gates = new Gates(this.scene, this.terrain)
    const route = [this.startPoint()].concat(this.gates.list.map(g => ({ x: g.x, z: g.z })))
    this.lift = new LiftField(this.scene, this.terrain, this.cond, this.sunDir, route)

    // stíny až tady: potřebují znát slunce (terén se staví dřív) i mraky
    this.terrain.applyShadows(this.sunDir, this.lift.cloudShadowTexture(this.sunDir, this.terrain))

    // nálada dne: ranní inverze, cirry, dešťové clony, sněžné vlajky, glare
    this.atmo = new Atmosphere(this.scene, this.terrain, this.weather, this.cond, this.sun, this.sunDir)
    this.spray = new SnowSpray(this.scene)
  }

  startPoint() {
    return this.terrain.fromLatLon(START.lat, START.lon)
  }

  _spawn() {
    const { x, z } = this.startPoint()
    this.glider.reset(new THREE.Vector3(x, START.alt, z), START.headingDeg * Math.PI / 180)
    this.gates.reset()
    // kamera hned za kluzák (ať se menu nedívá do země)
    this._updateCamera(1)
  }

  /** @param runMode 'race' = trať na čas, 'free' = trénink bez bran a bez času */
  _startRun(runMode = 'race') {
    if (this._inSm) { this._inSm.pitch = 0; this._inSm.roll = 0 }
    this.runMode = runMode === 'free' ? 'free' : 'race'
    this.scoring = this.runMode === 'race'
    this._spawn()
    this.gates.group.visible = this.runMode === 'race'
    this.state = 'flying'
    this.paused = false
    this._resumeT = 0
    this.runMs = 0 // čas letu se sčítá z kroků simulace → pauza se nepočítá
    this.stats = { maxAlt: 0, maxClimb: 0, maxSpeed: 0, distM: 0, thermals: 0 }
    this._climbRun = 0
    this._climbCounted = false
    this.ui.beginRun()
    this.ui.showFlying(this.isTouch, this.runMode)
  }

  /**
   * Restart u poslední proleté brány. Náraz v páté bráně po dvaceti
   * minutách jinak znamená celou trať znovu — to hráče od hry odradí víc
   * než těžká termika. Takový let se ale do žebříčku nepočítá.
   */
  _continueFromGate() {
    const done = this.gates.current
    const from = done > 0 ? this.gates.list[done - 1] : null
    const start = this.startPoint()
    const p = from
      ? new THREE.Vector3(from.x, from.y + 120, from.z)
      : new THREE.Vector3(start.x, START.alt, start.z)
    const nxt = this.gates.next
    const heading = nxt
      ? Math.atan2(nxt.x - p.x, -(nxt.z - p.z))
      : START.headingDeg * Math.PI / 180
    if (this._inSm) { this._inSm.pitch = 0; this._inSm.roll = 0 }
    this.glider.reset(p, heading)
    this.scoring = false
    this.state = 'flying'
    this.paused = false
    this._resumeT = 0
    this.ui.showFlying(this.isTouch, this.runMode)
    this.ui.toast('Pokračuješ od brány — tenhle let se do žebříčku nepočítá', 2600)
  }

  /** Čísla do výsledkovky — co se z letu dá vyprávět. */
  _collectStats(dt) {
    const g = this.glider, s = this.stats
    if (!s) return
    s.maxAlt = Math.max(s.maxAlt, g.pos.y)
    s.maxSpeed = Math.max(s.maxSpeed, g.v * 3.6)
    s.maxClimb = Math.max(s.maxClimb, this._varioAvg ?? 0)
    // dráha nad zemí (i s driftem po větru) — to hráč reálně uletěl
    const vx = Math.sin(g.heading) * g.v + this.cond.windVec.x
    const vz = -Math.cos(g.heading) * g.v + this.cond.windVec.z
    s.distM += Math.hypot(vx, vz) * dt
    // termika se počítá až jako souvislé stoupání přes 6 s (ne každý poryv)
    if (g.vario > 0.8) {
      this._climbRun += dt
      if (this._climbRun > 6 && !this._climbCounted) { s.thermals++; this._climbCounted = true }
    } else if (g.vario < 0.2) {
      this._climbRun = 0
      this._climbCounted = false
    }
  }

  /** 'auto' → podle zařízení; jinak co si hráč vybral. */
  _quality() {
    const q = settings.get('quality')
    return (q === 'low' || q === 'med' || q === 'high') ? q : (this.isTouch ? 'med' : 'high')
  }

  /** Přestavět les, dohlednost a rozlišení podle kvality (platí hned). */
  _applyQuality() {
    const q = this._quality()
    this._prMax = Math.min(devicePixelRatio, { low: 1, med: 1.5, high: 2 }[q])
    this._pr = this._prMax
    this.renderer.setPixelRatio(this._pr)
    // nižší kvalita = hustší opar, tím se schová kratší dohlednost
    this.scene.fog.density = this._fogDensity0 * { low: 1.8, med: 1.25, high: 1 }[q]
    if (this.forest) this.forest.dispose()
    this.forest = new Forest(this.scene, this.terrain, q)
    this.forest.update(this.camera.position.x, this.camera.position.z)

    // obrazové efekty stojí několik celoobrazovkových průchodů — jen "vysoká"
    if (q === 'high' && !this.postfx) {
      this.postfx = new PostFX(this.renderer, this.scene, this.camera)
    } else if (q !== 'high' && this.postfx) {
      this.postfx.dispose()
      this.postfx = null
    }
  }

  _syncSettings() {
    this.ui.setControlUi(this.controls)
    this.ui.syncSettings({
      sens: this.controls.sens,
      invertY: this.controls.invertY,
      isTouch: this.isTouch,
      quality: settings.get('quality'),
    })
  }

  _toggleView() {
    this.camMode = this.camMode === 'cockpit' ? 'chase' : 'cockpit'
    settings.set('camera', this.camMode)
    this._applyCamMode()
    this.ui.setViewUi(this.camMode)
    this.ui.toast(this.camMode === 'cockpit' ? '👁 Pohled z kokpitu' : '🎥 Pohled za kluzákem')
  }

  _applyCamMode() {
    // v kokpitu je nos 1,6 m před okem — bez posunu near roviny by zmizel
    this.camera.near = this.camMode === 'cockpit' ? 1.2 : 2
    this.camera.updateProjectionMatrix()
    this.ui.setViewUi(this.camMode)
  }

  _pause(info) {
    if (this.state !== 'flying' || this.paused) return
    this.paused = true
    this._resumeT = 0
    this.vario.silence()
    this.ui.showPause(info)
  }

  _resume() {
    if (!this.paused || this._resumeT > 0) return
    this._resumeT = 3.0 // 3…2…1, ať hráč stihne chytit knipl
    this.ui.hidePause()
  }

  _finish() {
    this.state = 'done'
    this.vario.silence() // fanfáru brány to neutne, jede po vlastních uzlech
    this.ui.showWin(this.runMs, this.scoring, this.stats)
  }

  _crash() {
    this.state = 'crashed'
    this.vario.crashSound()
    this.vario.silence()
    const wasStall = this.glider.stalled > 0
    const free = this.runMode === 'free'
    this.ui.showCrash(this.gates.current, free ? 0 : this.gates.total,
      wasStall ? 'Přetažení u země — hlídej rychlost nad 60 km/h.'
        : 'Náraz do terénu — přes hřebeny si vytoč výšku v termice.',
      !free && this.gates.current > 0)
    if (navigator.vibrate) navigator.vibrate(180)
  }

  _tick() {
    const rawDt = this.clock.getDelta()
    const dt = Math.min(rawDt, 0.05)
    const t = this.clock.elapsedTime

    // adaptivní kvalita: EMA fps → pixelRatio (plynulost > ostrost)
    this._fps = (this._fps ?? 60) * 0.95 + (1 / Math.max(rawDt, 1e-3)) * 0.05
    this._qT = (this._qT ?? 0) + rawDt
    if (this._qT > 2) {
      this._qT = 0
      const prBefore = this._pr
      if (this._fps < 45 && this._pr > 1) this._pr = Math.max(1, this._pr - 0.25)
      else if (this._fps > 57 && this._pr < this._prMax) this._pr = Math.min(this._prMax, this._pr + 0.25)
      if (this._pr !== prBefore) {
        this.renderer.setPixelRatio(this._pr)
        if (this.postfx) this.postfx.setSize(innerWidth, innerHeight)
      }
    }

    // pauza: svět stojí, běží jen kamera a odpočet návratu do hry
    if (this.paused) {
      if (this._resumeT > 0) {
        this._resumeT -= rawDt
        this.ui.setCountdown(Math.max(1, Math.ceil(this._resumeT)))
        if (this._resumeT <= 0) { this.paused = false; this.ui.setCountdown(0) }
      }
    }

    if (this.state === 'flying' && !this.paused) {
      const raw = this.controls.getInput()
      if (raw.reset && !this._resetHeld) { this._resetHeld = true; this._startRun(); return }
      if (!raw.reset) this._resetHeld = false
      // plynulá rampa vstupu — klávesy dávají skoky, kniple ne
      if (!this._inSm) this._inSm = { pitch: 0, roll: 0 }
      const k = Math.min(1, dt * 6.5)
      // na mobilu (tilt) chráníme před nechtěným přetažením: max přitažení 0.8
      const pitchIn = (this.isTouch && this.controls.mode === 'tilt') ? Math.max(-0.8, raw.pitch) : raw.pitch
      this._inSm.pitch += (pitchIn - this._inSm.pitch) * k
      this._inSm.roll += (raw.roll - this._inSm.roll) * k
      const input = this._inSm
      const lift = this.lift.liftAt(this.glider.pos)
      this.glider.update(dt, input, lift, this.cond.windVec, this.terrain)

      if (this.glider.crashed) this._crash()

      if (this.runMode !== 'free' && this.gates.check(this.glider.pos)) {
        this.ui.gatePassed(this.gates.current, this.gates.total)
        this.vario.gateChime(!this.gates.next)
        if (navigator.vibrate) navigator.vibrate(60)
        if (!this.gates.next) { this._finish() }
      }
      // varování před terénem: houkání + vibrace, dokud je svah v dráze
      const ttc = this._terrainAlert()
      this.ui.setTerrainWarn(ttc)
      if (ttc > 0) {
        this._gpwsT = (this._gpwsT ?? 9) + dt
        if (this._gpwsT > (ttc < 4 ? 0.45 : 0.8)) { // blíž = hustěji
          this._gpwsT = 0
          this.vario.blip({ freq: 340, dur: 0.24, type: 'square', vol: 0.1, to: 210 })
          if (navigator.vibrate) navigator.vibrate(35)
        }
      } else this._gpwsT = 9

      if (this.glider.stalled > 0 && !this._stallBuzz) {
        this._stallBuzz = true
        this.vario.noise({ dur: 0.45, cutoff: 1100, to: 400, vol: 0.16 }) // třepetání
        if (navigator.vibrate) navigator.vibrate([40, 60, 40])
      } else if (this.glider.stalled <= 0) this._stallBuzz = false

      this.runMs += dt * 1000
      this._collectStats(dt)
      this.ui.updateHud({
        ms: this.runMs,
        speedKmh: this.glider.v * 3.6,
        altM: this.glider.pos.y,
        aglM: this.glider.pos.y - this.terrain.heightAt(this.glider.pos.x, this.glider.pos.z),
        vario: this.glider.vario + 0, // m/s
        stalled: this.glider.stalled > 0,
        slow: this.glider.v < V_STALL + 2.5,
        headingDeg: this.glider.heading * 180 / Math.PI,
        windDirDeg: this.weather.windDirDeg,
        stfKmh: (27 + Math.max(0, -(this.glider.vario + 0.6)) * 3.6) * 3.6,
      })
      this.vario.update(this.glider.vario, dt)
      this.vario.updateWind(this.glider.v, this.glider.stalled > 0)
      this._updateGateMarker()
      this._updateThermalMarker()
      this.ui.updateMinimap(this.glider.pos, this.glider.heading, this.gates.current)

      // 20s průměrovač varia (co mi ta termika reálně dává?)
      this._avgAcc = (this._avgAcc ?? 0) + this.glider.vario * dt
      this._avgT = (this._avgT ?? 0) + dt
      if (this._avgT > 0.5) {
        this._varioAvg = (this._varioAvg ?? 0) * 0.9 + (this._avgAcc / this._avgT) * 0.1
        this.ui.setVarioAvg(this._varioAvg)
        this._avgAcc = 0; this._avgT = 0
      }
    } else {
      this.vario.update(0, dt)
      this.vario.updateWind(0, false)
    }

    // v pauze svět stojí (částice, prstence, vlečky) — jen kamera dojíždí
    if (!this.paused) {
      this._worldT = t
      this.lift.update(dt)
      this.atmo.update(dt)
      this.spray.update(dt, this.glider, this.terrain, innerHeight)
      this.glider.updateTrails()
      // stíny mraků plují s mraky — přepéct občas (drift za 4 s je pod
      // desetinou poloměru stínu, takže skok není vidět)
      this._cloudShT = (this._cloudShT ?? 0) + dt
      if (this._cloudShT > 4) {
        this._cloudShT = 0
        this.terrain.updateCloudShadows(this.lift.cloudShadowTexture(this.sunDir, this.terrain))
      }
    }
    this.gates.update(this._worldT ?? t)
    this.glider.updateShadow(this.terrain)
    this.forest.update(this.camera.position.x, this.camera.position.z)
    this._updateCamera(dt)

    // FOV dýchá s rychlostí (pocit svištění)
    const fovT = 64 + Math.min(18, Math.max(0, (this.glider.v - 24) * 0.5))
    if (Math.abs(this.camera.fov - fovT) > 0.1) {
      this.camera.fov += (fovT - this.camera.fov) * Math.min(1, dt * 2.5)
      this.camera.updateProjectionMatrix()
    }
    this.sky.position.copy(this.camera.position)
    this.atmo.updateGlare(this.camera, dt)
    if (this.postfx) this.postfx.setThermals(this._shimmerCols(), this._worldT ?? t)
    if (this.postfx) this.postfx.render()
    else this.renderer.render(this.scene, this.camera)
  }

  _updateCamera(dt) {
    // v menu: pomalý orbit nad údolím, pohled na masiv Mont Blancu
    if (this.state === 'menu') {
      const t = this.clock ? this.clock.elapsedTime : 0
      const cx = this.terrain.sizeX * 0.52, cz = this.terrain.sizeZ * 0.30
      const ang = t * 0.045
      this.camera.position.set(
        cx + Math.cos(ang) * 6500,
        3300 + Math.sin(t * 0.11) * 300,
        cz + Math.sin(ang) * 6500,
      )
      const mb = this.terrain.fromLatLon(45.8326, 6.8652)
      this.camera.lookAt(mb.x, 3400, mb.z)
      return
    }
    const g = this.glider
    // kokpit: kamera sedí pilotovi na místě, orientaci bere přímo z modelu
    // (nos = −z, stejně jako se dívá kamera) → vidíš křídla i sklon v zatáčce
    if (this.camMode === 'cockpit') {
      _camTarget.set(0, 0.62, -1.5)
      g.model.localToWorld(_camTarget)
      this.camera.position.copy(_camTarget)
      this.camera.quaternion.copy(g.model.quaternion)
      return
    }
    // chase kamera za kluzákem, jemně zpožděná, výš při pohledu do údolí
    const back = (26 + g.v * 0.25) * (this._camZoom || 1)
    const sh = Math.sin(g.heading), ch = Math.cos(g.heading)
    _camTarget.set(
      g.pos.x - sh * back,
      g.pos.y + 8.5,
      g.pos.z + ch * back,
    )
    const k = Math.min(1, dt * 3.4)
    this.camera.position.lerp(_camTarget, k)
    _lookTarget.set(g.pos.x + sh * 60, g.pos.y - 4, g.pos.z - ch * 60)
    this.camera.lookAt(_lookTarget)
    this.camera.rotation.z += -g.bank * 0.35 // náklon horizontu v zatáčce
  }

  /**
   * Rozpálené svahy promítnuté do obrazu — vstup pro tepelné chvění.
   *
   * Kotví se na ZEM v místě, odkud termika startuje (`th.x/th.z/th.ground`),
   * ne do komína ve výšce: horký vzduch, který láme světlo, leží v přízemní
   * vrstvě. Komín se navíc s výškou naklání po větru, takže kotva ve výšce
   * vlnila prázdný vzduch šikmo vedle kopce.
   *
   * Promítají se tři body: kotva (poloha), kotva + poloměr doprava od kamery
   * (šířka v obraze) a kotva + PŘÍZEMNÍ VRSTVA vzhůru (dosah nahoru).
   */
  _shimmerCols() {
    const cols = []
    const gp = this.glider.pos
    const LAYER = 130 // m — dokud je vzduch od kamení znatelně teplejší
    // bez slunce se nic nerozpálí: k večeru chvění mizí i nad skálou
    const sunHeat = Math.max(0, Math.min(1, (this.sun.elevDeg - 6) / 22))
    if (sunHeat <= 0) return cols
    _shRight.setFromMatrixColumn(this.camera.matrixWorld, 0)
    for (const th of this.lift.thermals) {
      const d = Math.hypot(th.x - gp.x, th.z - gp.z)
      const d3 = Math.hypot(d, gp.y - th.ground)
      if (d3 > 2600) continue
      _shA.set(th.x, th.ground + 12, th.z)
      _shB.copy(_shA).addScaledVector(_shRight, th.r)
      _shC.set(th.x, th.ground + LAYER, th.z)
      _shA.project(this.camera)
      _shB.project(this.camera)
      _shC.project(this.camera)
      if (_shA.z > 1 || Math.abs(_shA.x) > 1.7 || Math.abs(_shA.y) > 2) continue
      const r = Math.abs(_shB.x - _shA.x) * 0.5
      const h = Math.abs(_shC.y - _shA.y) * 0.5
      if (r < 0.006 || h < 0.002) continue
      // Vidět je to jen z určité vzdálenosti: zblízka chybí srovnání
      // s okolím, z kilometrů to spolkne opar.
      const near = Math.max(0, Math.min(1, (d3 - 120) / 320))
      const far = 1 - Math.max(0, Math.min(1, (d3 - 1400) / 1200))
      const s = Math.min(1, th.strength / 3) * near * far * sunHeat
      if (s < 0.03) continue
      cols.push({
        x: _shA.x * 0.5 + 0.5,
        y: _shA.y * 0.5 + 0.5,
        r: Math.min(r, 0.34),
        h: Math.min(h, 0.30),
        s,
        d: d3,
      })
    }
    cols.sort((a, b) => a.d - b.d)
    return cols
  }

  /**
   * Varování před terénem (jako GPWS v dopravním letadle): sonda po
   * současné dráze letu — kurz + vítr + aktuální opadání. Vrací počet
   * sekund do nárazu (0 = čisto). Rovná dráha je záměrně konzervativní:
   * v zatáčce svah minu, ale radši varovat dřív než později.
   */
  _terrainAlert() {
    const g = this.glider
    const vx = Math.sin(g.heading) * g.v + this.cond.windVec.x
    const vz = -Math.cos(g.heading) * g.v + this.cond.windVec.z
    for (let s = 1; s <= 8; s++) {
      const x = g.pos.x + vx * s, z = g.pos.z + vz * s, y = g.pos.y + g.vario * s
      if (y < this.terrain.heightAt(x, z) + 30) return s
    }
    return 0
  }

  /**
   * Doklouzání na další bránu — nejdůležitější údaj plachtaře: o kolik
   * metrů nad (▲) nebo pod (▼) ni doletím, když teď zamířím přímo tam.
   * Počítá se s reálnou polárou, se složkou větru do směru letu (protivítr
   * klouzavost nad zemí ničí) a s hřebeny po trase — mnohdy nerozhoduje
   * brána, ale hora před ní.
   */
  _finalGlide() {
    const gate = this.gates.next
    if (!gate) return null
    const p = this.glider.pos
    const dx = gate.x - p.x, dz = gate.z - p.z
    const dist = Math.hypot(dx, dz)
    if (dist < 1) return { margin: p.y - gate.y, ridge: false }
    const ux = dx / dist, uz = dz / dist
    const w = this.cond.windVec
    const vAir = V_MIN_SINK + 3 // rozumná přeskoková rychlost (~94 km/h)
    const vGround = Math.max(5, vAir + w.x * ux + w.z * uz)
    const ld = vGround / polarSink(vAir)
    let need = gate.y + dist / ld
    let ridge = false
    const steps = Math.min(40, Math.max(2, Math.ceil(dist / 300)))
    for (let i = 1; i < steps; i++) {
      const f = i / steps
      const h = this.terrain.heightAt(p.x + dx * f, p.z + dz * f) + 60 + (dist * (1 - f)) / ld
      if (h > need) { need = h; ridge = true }
    }
    return { margin: p.y - need, ridge }
  }

  // marker nejbližšího použitelného stoupáku (🌀) — navádění na termiku
  _updateThermalMarker() {
    const el = document.getElementById('thermal-marker')
    const th = this.lift.nearestThermal(this.glider.pos)
    if (!th || th.d < 220) { el.style.display = 'none'; return } // v termice netřeba
    _proj.set(th.x, th.y, th.z).project(this.camera)
    if (_proj.z > 1) { el.style.display = 'none'; return } // za zády: neukazovat (nemást s bránou)
    const sx = (_proj.x * 0.5 + 0.5) * innerWidth
    const sy = (-_proj.y * 0.5 + 0.5) * innerHeight
    const pad = 26
    if (sx < pad || sx > innerWidth - pad || sy < pad || sy > innerHeight - pad) {
      el.style.display = 'none'
      return
    }
    el.style.display = 'flex'
    el.style.left = sx + 'px'
    el.style.top = sy + 'px'
    el.querySelector('.dist').textContent = th.d > 1500 ? (th.d / 1000).toFixed(1) + ' km' : Math.round(th.d) + ' m'
  }

  _updateGateMarker() {
    const g = this.runMode === 'free' ? null : this.gates.next
    const el = this.ui.gateMarker
    if (!g) { el.style.display = 'none'; return }
    _proj.set(g.x, g.y, g.z).project(this.camera)
    const behind = _proj.z > 1
    let sx = (_proj.x * 0.5 + 0.5) * innerWidth
    let sy = (-_proj.y * 0.5 + 0.5) * innerHeight
    if (behind) { sx = innerWidth - sx; sy = innerHeight - 40 }
    const pad = 30
    const off = behind || sx < pad || sx > innerWidth - pad || sy < pad || sy > innerHeight - pad
    if (off) {
      sx = Math.max(pad, Math.min(innerWidth - pad, sx))
      sy = Math.max(pad, Math.min(innerHeight - pad, sy))
    }
    el.style.display = 'flex'
    el.style.left = sx + 'px'
    el.style.top = sy + 'px'
    const d = Math.hypot(g.x - this.glider.pos.x, g.y - this.glider.pos.y, g.z - this.glider.pos.z)
    this.ui.setGateInfo(this.gates.current + 1, this.gates.total, g.name, d, this._finalGlide())
  }

  _onResize() {
    this.camera.aspect = innerWidth / innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(innerWidth, innerHeight)
    if (this.postfx) this.postfx.setSize(innerWidth, innerHeight)
  }
}

function dirName(deg) {
  const names = ['S', 'SV', 'V', 'JV', 'J', 'JZ', 'Z', 'SZ']
  return names[Math.round(((deg % 360) + 360) % 360 / 45) % 8]
}

const _camTarget = new THREE.Vector3()
const _lookTarget = new THREE.Vector3()
const _proj = new THREE.Vector3()
const _shA = new THREE.Vector3()
const _shB = new THREE.Vector3()
const _shC = new THREE.Vector3()
const _shRight = new THREE.Vector3()

// ── bootstrap: terén + počasí paralelně ──
const loadingEl = document.getElementById('loading')
Promise.all([Terrain.load(), loadWeather()])
  .then(async ([terrain, weather]) => {
    // daleký horizont je bonus — když se nepovede, hra se rozjede bez něj
    let far = null
    const q = settings.get('quality')
    const lowEnd = q === 'low' || (q !== 'high' && q !== 'med' && matchMedia('(pointer: coarse)').matches)
    try {
      far = await FarTerrain.load(terrain, lowEnd ? 2 : 1)
    } catch (e) { console.warn('horizont nenačten:', e) }
    new Game(terrain, weather, far)
    loadingEl.style.display = 'none'
  })
  .catch(e => {
    loadingEl.textContent = 'Chyba načítání: ' + e.message
    console.error(e)
  })
