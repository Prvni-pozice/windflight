// main.js — WINDFLIGHT: větroněm nad Mont Blankem. Reálný terén (Copernicus
// DEM), skutečné dnešní počasí (Open-Meteo), viditelné proudění vzduchu.
// Úkol: prolétnout všemi branami — bez využití termiky a svahů to nejde.
import * as THREE from 'three'
import { Terrain } from './terrain.js'
import { loadWeather, deriveConditions, sunPosition, sunDirVector } from './weather.js'
import { LiftField } from './lift.js'
import { Glider, V_STALL } from './glider.js'
import { Gates, GATE_R } from './gates.js'
import { Vario } from './vario.js'
import { FlightControls } from './controls.js'
import { UI } from './ui.js'
import { buildScenery } from './scenery.js'

const START = { lat: 45.9290, lon: 6.8560, alt: 2600, headingDeg: 20 } // nad Chamonix, čelem k Bréventu

class Game {
  constructor(terrain, weather) {
    this.terrain = terrain
    this.weather = weather
    this.state = 'menu' // menu | flying | done | crashed
    this.runStart = 0

    this._setupRenderer()
    this._setupScene()

    this.controls = new FlightControls()
    this.vario = new Vario()
    this.glider = new Glider(this.scene)

    this.ui = new UI({
      weatherLabel: `${weather.label} · vítr ${Math.round(weather.windSpeed)} m/s ` +
        `${dirName(weather.windDirDeg)} · oblačnost ${Math.round(weather.cloudCover * 100)} %`,
      gateTotal: this.gates.total,
      onStart: async () => {
        this.vario.init()
        if (this.isTouch) await this.controls.enableTilt().then(r => { if (r === 'ok') this.controls.calibrate() })
        this._startRun()
      },
      onRetry: () => this._startRun(),
    })

    this.isTouch = matchMedia('(pointer: coarse)').matches
    this.ui.onMuteToggle = () => this.vario.toggleMute()
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
    const sunLight = new THREE.DirectionalLight(0xfff3dd, 2.1 * (1 - 0.45 * cc))
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
        varying vec3 vDir;
        void main() {
          float h = max(vDir.y, 0.0);
          vec3 zenith = vec3(0.16, 0.38, 0.75);
          vec3 horizon = mix(vec3(0.78, 0.86, 0.93), vec3(0.85, 0.88, 0.9), uHaze);
          vec3 col = mix(horizon, zenith, pow(h, 0.5));
          float s = max(dot(vDir, uSunDir), 0.0);
          col += vec3(1.0, 0.93, 0.8) * (pow(s, 800.0) * 1.4 + pow(s, 32.0) * 0.18);
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
    this.runStart = performance.now()
    this.ui.beginRun()
    this.ui.showFlying(this.isTouch)
  }

  _finish() {
    this.state = 'done'
    this.ui.showWin(performance.now() - this.runStart)
  }

  _crash() {
    this.state = 'crashed'
    this.ui.showCrash(this.gates.current, this.gates.total)
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

    if (this.state === 'flying') {
      const raw = this.controls.getInput()
      if (raw.reset && !this._resetHeld) { this._resetHeld = true; this._startRun(); return }
      if (!raw.reset) this._resetHeld = false
      // plynulá rampa vstupu — klávesy dávají skoky, kniple ne
      if (!this._inSm) this._inSm = { pitch: 0, roll: 0 }
      const k = Math.min(1, dt * 6.5)
      this._inSm.pitch += (raw.pitch - this._inSm.pitch) * k
      this._inSm.roll += (raw.roll - this._inSm.roll) * k
      const input = this._inSm
      const lift = this.lift.liftAt(this.glider.pos)
      this.glider.update(dt, input, lift, this.cond.windVec, this.terrain)

      if (this.glider.crashed) this._crash()

      if (this.gates.check(this.glider.pos)) {
        this.ui.gatePassed(this.gates.current, this.gates.total)
        if (!this.gates.next) { this._finish() }
      }

      const ms = performance.now() - this.runStart
      this.ui.updateHud({
        ms,
        speedKmh: this.glider.v * 3.6,
        altM: this.glider.pos.y,
        aglM: this.glider.pos.y - this.terrain.heightAt(this.glider.pos.x, this.glider.pos.z),
        vario: this.glider.vario + 0, // m/s
        stalled: this.glider.stalled > 0,
        slow: this.glider.v < V_STALL + 2.5,
        headingDeg: this.glider.heading * 180 / Math.PI,
        windDirDeg: this.weather.windDirDeg,
      })
      this.vario.update(this.glider.vario, dt)
      this.vario.updateWind(this.glider.v, this.glider.stalled > 0)
      this._updateGateMarker()

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

    this.lift.update(dt)
    this.gates.update(t)
    this.glider.updateShadow(this.terrain)
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
    // chase kamera za kluzákem, jemně zpožděná, výš při pohledu do údolí
    const g = this.glider
    const back = 26 + g.v * 0.25
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
    this.ui.setGateInfo(this.gates.current + 1, this.gates.total, g.name, d)
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
