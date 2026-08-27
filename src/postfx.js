// postfx.js — obrazové dokončení scény: záře, barevné doladění, FXAA.
//
// Tohle je to, co odděluje "3D scénu" od "obrázku". Sníh a slunce začnou
// zářit do okolí, světla dostanou teplo a stíny chlad, rohy lehce ztmavnou.
// Stojí to ale výkon (několik celoobrazovkových průchodů), takže se to
// zapíná jen na vysoké kvalitě — jinde se kreslí přímo, bez composeru.
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js'

const MAX_COLS = 3

/**
 * Tepelné chvění nad stoupákem. Termika je ohřátý vzduch, který má jiný
 * index lomu než okolí — hory za ní se vlní. Herně je to nejlevnější způsob,
 * jak stoupák prozradit i tam, kde nejsou částice ani kumulus: hráč uvidí,
 * že se kus krajiny „vaří", a zamíří tam.
 *
 * Sloupce dodává main.js v souřadnicích obrazu (uv), protože jen ten ví,
 * kde termika po driftu větrem opravdu stojí.
 */
const ShimmerShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAspect: { value: 1.6 },
    uCount: { value: 0 },
    // x, y = střed sloupce v uv; z = poloměr v uv; w = síla 0–1
    uCols: { value: Array.from({ length: MAX_COLS }, () => new THREE.Vector4()) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAspect;
    uniform int uCount;
    uniform vec4 uCols[${MAX_COLS}];
    varying vec2 vUv;
    void main() {
      vec2 uv = vUv;
      for (int i = 0; i < ${MAX_COLS}; i++) {
        if (i >= uCount) break;
        vec4 c = uCols[i];
        float dx = (uv.x - c.x) * uAspect;
        float dy = uv.y - c.y;
        float r = max(c.z, 0.004);
        // sloupec: úzký napříč, vysoký podél — a bez ostré hranice,
        // jinak by se v obraze rýsoval obdélník
        float m = exp(-(dx * dx) / (r * r)) * exp(-(dy * dy) / (r * r * 9.0));
        m *= c.w;
        if (m < 0.004) continue;
        // dvě frekvence stoupající vzhůru — jedna hrubá, druhá jemná
        float w1 = sin(uv.y * 210.0 - uTime * 3.1 + uv.x * 40.0);
        float w2 = sin(uv.y * 470.0 - uTime * 5.3 + c.x * 60.0);
        uv.x += (w1 * 0.0040 + w2 * 0.0018) * m;
        uv.y += (w1 * 0.0016) * m;
      }
      gl_FragColor = texture2D(tDiffuse, uv);
    }`,
}

/** Závěrečné doladění barev: kontrastní křivka, teplo/chlad, vinětace. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uWarm: { value: 0.18 },     // kolik tepla do světel
    uVignette: { value: 0.28 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uWarm;
    uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // jemná S-křivka: prohloubí stíny, přidrží světla (film, ne kontrast++)
      c = c * c * (3.0 - 2.0 * c) * 0.35 + c * 0.65;
      // světla do tepla, stíny do chladu — takhle vypadá sluneční den
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      // vibrance: přisytit, ale málo — sytost je hlavně v barvách terénu
      c = mix(vec3(l), c, 1.12);
      c += vec3(0.055, 0.022, -0.03) * uWarm * smoothstep(0.45, 1.0, l);
      c += vec3(-0.02, 0.0, 0.045) * uWarm * (1.0 - smoothstep(0.0, 0.5, l));
      // vinětace: oko pak drží pohled uprostřed
      float d = distance(vUv, vec2(0.5));
      c *= 1.0 - uVignette * smoothstep(0.35, 0.95, d);
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
}

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer
    const size = renderer.getSize(new THREE.Vector2())
    const pr = renderer.getPixelRatio()

    // MSAA uvnitř composeru — bez toho by se ztratilo vyhlazení hran,
    // které dělá `antialias: true` na plátně
    const target = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, {
      type: THREE.HalfFloatType, samples: 4,
    })
    this.composer = new EffectComposer(renderer, target)
    this.composer.setSize(size.x, size.y)
    this.composer.setPixelRatio(pr)

    // POŘADÍ JE ZÁSADNÍ. Uvnitř composeru se kreslí lineárně a v HDR;
    // teprve OutputPass udělá tónové mapování a převod do sRGB. Bez něj
    // jde na plátno lineární barva a obraz je skoro černý (jen mraky svítí
    // jako žárovky). Záře musí být PŘED ním (počítá se z HDR), doladění
    // barev a FXAA až ZA ním (pracují s tím, co uvidí oko).
    this.composer.addPass(new RenderPass(scene, camera))
    // chvění hned za scénou: vlní obraz dřív, než se z něj počítá záře
    this.shimmer = new ShaderPass(ShimmerShader)
    this.shimmer.material.uniforms.uAspect.value = size.x / Math.max(1, size.y)
    this.composer.addPass(this.shimmer)
    // Práh musí být NAD 1,0. Mraky mají v HDR nejvýš jednotku, takže se
    // do záře nedostanou; přeteče jen osluněný sníh a kotouč slunce. S nižším
    // prahem zapařil bílý pás oblačnosti celou oblohu do šeda.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.22, 0.45, 1.02)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
    this.grade = new ShaderPass(GradeShader)
    this.composer.addPass(this.grade)
    this.fxaa = new ShaderPass(FXAAShader)
    this._setFxaaSize(size.x * pr, size.y * pr)
    this.composer.addPass(this.fxaa)
  }

  _setFxaaSize(w, h) {
    this.fxaa.material.uniforms.resolution.value.set(1 / w, 1 / h)
  }

  setSize(w, h) {
    const pr = this.renderer.getPixelRatio()
    this.composer.setPixelRatio(pr)
    this.composer.setSize(w, h)
    this.bloom.setSize(w, h)
    this.shimmer.material.uniforms.uAspect.value = w / Math.max(1, h)
    this._setFxaaSize(w * pr, h * pr)
  }

  /** cols: [{x, y, r, s}] ve souřadnicích obrazu (uv), nejvýš MAX_COLS. */
  setThermals(cols, time) {
    const u = this.shimmer.material.uniforms
    u.uTime.value = time
    const n = Math.min(cols.length, MAX_COLS)
    u.uCount.value = n
    this.shimmer.enabled = n > 0 // bez stoupáku v dohledu je průchod zbytečný
    for (let i = 0; i < n; i++) u.uCols.value[i].set(cols[i].x, cols[i].y, cols[i].r, cols[i].s)
  }

  render() { this.composer.render() }

  dispose() { this.composer.dispose() }
}
