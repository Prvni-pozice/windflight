// main.js — WINDFLIGHT: větroněm nad Mont Blankem. Reálný terén (Copernicus
// DEM), skutečné dnešní počasí (Open-Meteo), viditelné proudění vzduchu.
// Úkol: prolétnout všemi branami — bez využití termiky a svahů to nejde.
import * as THREE from 'three'
import { Terrain } from './terrain.js'
import { loadWeather, deriveConditions, sunPosition, sunDirVector } from './weather.js'
import { LiftField } from './lift.js'
import { Glider, V_STALL, V_MIN_SINK, polarSink } from './glider.js'
import { Gates, GATE_R } from './gates.js'
import { Vario } from './vario.js'
import { FlightControls } from './controls.js'
import { UI } from './ui.js'
import { buildScenery } from './scenery.js'
import { Forest } from './trees.js'
import * as settings from './settings.js'

const START = { lat: 45.9290, lon: 6.8560, alt: 2600, headingDeg: 20 } // nad Chamonix, čelem k Bréventu

class Game {
  constructor(terrain, weather) {
    this.terrain = terrain
    this.weather = weather
    this.state = 'menu' // menu | flying | done | crashed
    this.runMs = 0      // čas letu (jen běžící simulace, bez pauz)
    this.paused = false

    this._setupRenderer()
    this._setupScene()

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
        `${dirName(weather.windDirDeg)} · oblačnost ${Math.round(weather.cloudCover * 100)} %`,
      gateTotal: this.gates.total,
      onStart: async () => {
        this.vario.init()
        if (this.isTouch) {
          await this.controls.enableTilt() // sám nastaví režim (náklon / dotyk)
          this.ui.setControlUi(this.controls)
        }
        this._startRun()
      },
      onRetry: () => this._startRun(),
      onPause: () => this._pause(),
      onResume: () => this._resume(),
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
    addEventListener('blur', () => this._pause())

    this.isTouch = matchMedia('(pointer: coarse)').matches
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
      this.ui.setControlUi(this.controls)
      this.ui.toast(inv ? 'Náklon/tah k sobě = nos DOLŮ' : 'Náklon/tah k sobě = nos NAHORU')
    }
    document.getElementById('mute-btn').textContent = this.vario.muted ? '🔇' : '🔊'
    this._spawn()

    this.clock = new THREE.Clock()
    this.renderer.setAnimationLoop(() => this._tick())
    addEventListener('resize', () => this._onResize())
  }

  _setupRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this._prMax = Math.min(devicePixelRatio, matchMedia('(pointer: coarse)').matches ? 1.6 : 2)
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
    const sunLight = new THREE.DirectionalLight(sunCol, 2.1 * (1 - 0.45 * cc))
    sunLight.position.copy(this.sunDir).multiplyScalar(20000)
    this.scene.add(sunLight)
    this.scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x8ba86e, 0.85 + 0.5 * cc))

    // obloha: gradient + sluneční kotouč + opar u horizontu
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uSunDir: { value: this.sunDir },
        uHaze: { value: 0.5 + this.weather.cloudCover * 0.4 },
        uGolden: { value: golden },
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
        varying vec3 vDir;
        void main() {
          float h = max(vDir.y, 0.0);
          vec3 zenith = mix(vec3(0.16, 0.38, 0.75), vec3(0.22, 0.3, 0.55), uGolden);
          vec3 horizon = mix(vec3(0.78, 0.86, 0.93), vec3(0.85, 0.88, 0.9), uHaze);
          horizon = mix(horizon, vec3(0.98, 0.72, 0.45), uGolden * 0.75); // západ/východ
          vec3 col = mix(horizon, zenith, pow(h, 0.5));
          float s = max(dot(vDir, uSunDir), 0.0);
          vec3 sunTint = mix(vec3(1.0, 0.93, 0.8), vec3(1.0, 0.62, 0.3), uGolden);
          col += sunTint * (pow(s, 800.0) * 1.4 + pow(s, 32.0) * (0.18 + uGolden * 0.25));
          col = mix(col, vec3(0.72, 0.78, 0.83), smoothstep(0.02, -0.1, vDir.y));
          gl_FragColor = vec4(col, 1.0);
        }`,
    })
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(70000, 32, 16), skyMat)
    this.scene.add(this.sky)

    const fogCol = new THREE.Color().lerpColors(
      new THREE.Color(0xdce8f2), new THREE.Color(0xc6ccd3), cc)
    this.scene.fog = new THREE.Fog(fogCol, 9000 - cc * 3500, 60000 - cc * 18000)

    this.terrain.addTo(this.scene)
    buildScenery(this.scene, this.terrain)
    this.forest = new Forest(this.scene, this.terrain)

    // silueta dalekých hřebenů na obzoru (prstenec zubatého pásu v oparu)
    {
      const N = 160, R = 52000
      const pos = []
      const cx = this.terrain.sizeX / 2, cz = this.terrain.sizeZ / 2
      let ph = 0
      for (let i = 0; i <= N; i++) {
        const a = i / N * Math.PI * 2
        ph += 0.9 + Math.sin(i * 12.9898) * 0.4
        const hgt = 2600 + Math.sin(ph) * 900 + Math.sin(ph * 2.7) * 450
        const x = cx + Math.cos(a) * R, z = cz + Math.sin(a) * R
        pos.push(x, -200, z, x, hgt, z)
      }
      const idx = []
      for (let i = 0; i < N; i++) {
        const b = i * 2
        idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2)
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      geo.setIndex(idx)
      geo.computeVertexNormals()
      const ridge = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: new THREE.Color(0x9fb2c4).lerp(new THREE.Color(0xb9bec6), cc),
        side: THREE.DoubleSide, fog: false, transparent: true, opacity: 0.55,
      }))
      this.scene.add(ridge)
    }
    this.gates = new Gates(this.scene, this.terrain)
    const route = [this.startPoint()].concat(this.gates.list.map(g => ({ x: g.x, z: g.z })))
    this.lift = new LiftField(this.scene, this.terrain, this.cond, this.sunDir, route)
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

  _startRun() {
    if (this._inSm) { this._inSm.pitch = 0; this._inSm.roll = 0 }
    this._spawn()
    this.state = 'flying'
    this.paused = false
    this._resumeT = 0
    this.runMs = 0 // čas letu se sčítá z kroků simulace → pauza se nepočítá
    this.ui.beginRun()
    this.ui.showFlying(this.isTouch)
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
    this.ui.showWin(this.runMs)
  }

  _crash() {
    this.state = 'crashed'
    const wasStall = this.glider.stalled > 0
    this.ui.showCrash(this.gates.current, this.gates.total,
      wasStall ? 'Přetažení u země — hlídej rychlost nad 60 km/h.'
        : 'Náraz do terénu — přes hřebeny si vytoč výšku v termice.')
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
      if (this._fps < 45 && this._pr > 1) {
        this._pr = Math.max(1, this._pr - 0.25)
        this.renderer.setPixelRatio(this._pr)
      } else if (this._fps > 57 && this._pr < this._prMax) {
        this._pr = Math.min(this._prMax, this._pr + 0.25)
        this.renderer.setPixelRatio(this._pr)
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

      if (this.gates.check(this.glider.pos)) {
        this.ui.gatePassed(this.gates.current, this.gates.total)
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
          this.vario.blip(340, 0.24, 'square', 0.1, 210)
          if (navigator.vibrate) navigator.vibrate(35)
        }
      } else this._gpwsT = 9

      if (this.glider.stalled > 0 && !this._stallBuzz) {
        this._stallBuzz = true
        if (navigator.vibrate) navigator.vibrate([40, 60, 40])
      } else if (this.glider.stalled <= 0) this._stallBuzz = false

      this.runMs += dt * 1000
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
      this.glider.updateTrails()
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
    this.renderer.render(this.scene, this.camera)
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
    const g = this.gates.next
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
  }
}

function dirName(deg) {
  const names = ['S', 'SV', 'V', 'JV', 'J', 'JZ', 'Z', 'SZ']
  return names[Math.round(((deg % 360) + 360) % 360 / 45) % 8]
}

const _camTarget = new THREE.Vector3()
const _lookTarget = new THREE.Vector3()
const _proj = new THREE.Vector3()

// ── bootstrap: terén + počasí paralelně ──
const loadingEl = document.getElementById('loading')
Promise.all([Terrain.load(), loadWeather()])
  .then(([terrain, weather]) => {
    new Game(terrain, weather)
    loadingEl.style.display = 'none'
  })
  .catch(e => {
    loadingEl.textContent = 'Chyba načítání: ' + e.message
    console.error(e)
  })
