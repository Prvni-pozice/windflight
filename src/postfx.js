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
    this._setFxaaSize(w * pr, h * pr)
  }

  render() { this.composer.render() }

  dispose() { this.composer.dispose() }
}
