import {
  computeApparentViscosityPaS,
  getEffectiveBaseViscosityMpas,
} from '../constants/fluids';
import {
  FluidConfig,
  ProbeSample,
  ScaleRange,
  SimulationMetrics,
  VisualizationMode,
} from '../types/rheology';

export const GRID_N = 96;
const ROW_SIZE = GRID_N + 2;
const GRID_SIZE = ROW_SIZE * ROW_SIZE;
const MG_LEVELS = 5;

const IS_LITTLE_ENDIAN = (() => {
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = 0x01020304;
  return new Uint8Array(buf)[0] === 0x04;
})();

function packRGBA(r: number, g: number, b: number, a = 255): number {
  const ri = r < 0 ? 0 : r > 255 ? 255 : r | 0;
  const gi = g < 0 ? 0 : g > 255 ? 255 : g | 0;
  const bi = b < 0 ? 0 : b > 255 ? 255 : b | 0;
  const ai = a < 0 ? 0 : a > 255 ? 255 : a | 0;
  if (IS_LITTLE_ENDIAN) {
    return ((ai << 24) | (bi << 16) | (gi << 8) | ri) >>> 0;
  }
  return ((ri << 24) | (gi << 16) | (bi << 8) | ai) >>> 0;
}

function buildGradientLUTBytes(stops: Array<[number, number, number, number]>): Uint8Array {
  const bytes = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let s0 = stops[0];
    let s1 = stops[stops.length - 1];
    for (let k = 0; k < stops.length - 1; k++) {
      if (t >= stops[k][0] && t <= stops[k + 1][0]) {
        s0 = stops[k];
        s1 = stops[k + 1];
        break;
      }
    }
    const span = s1[0] - s0[0] || 1;
    const f = (t - s0[0]) / span;
    const off = i * 4;
    bytes[off] = Math.round(s0[1] + (s1[1] - s0[1]) * f);
    bytes[off + 1] = Math.round(s0[2] + (s1[2] - s0[2]) * f);
    bytes[off + 2] = Math.round(s0[3] + (s1[3] - s0[3]) * f);
    bytes[off + 3] = 255;
  }
  return bytes;
}

function bytesToPacked32(bytes: Uint8Array): Uint32Array {
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const off = i * 4;
    lut[i] = packRGBA(bytes[off], bytes[off + 1], bytes[off + 2], 255);
  }
  return lut;
}

const VELOCITY_BYTES = buildGradientLUTBytes([
  [0.0, 10, 15, 28],
  [0.25, 14, 78, 122],
  [0.5, 6, 182, 212],
  [0.75, 52, 211, 153],
  [1.0, 253, 224, 71],
]);

const VORTICITY_BYTES = buildGradientLUTBytes([
  [0.0, 56, 189, 248],
  [0.25, 29, 78, 216],
  [0.5, 17, 24, 39],
  [0.75, 217, 119, 6],
  [1.0, 244, 63, 94],
]);

const SHEAR_BYTES = buildGradientLUTBytes([
  [0.0, 11, 14, 23],
  [0.25, 88, 28, 135],
  [0.55, 220, 38, 38],
  [0.8, 245, 158, 11],
  [1.0, 254, 249, 195],
]);

const VELOCITY_LUT = bytesToPacked32(VELOCITY_BYTES);
const VORTICITY_LUT = bytesToPacked32(VORTICITY_BYTES);
const SHEAR_LUT = bytesToPacked32(SHEAR_BYTES);

const VERTEX_SHADER_SRC = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER_SRC = `
  precision mediump float;
  varying vec2 v_uv;

  uniform sampler2D u_fieldTex;
  uniform sampler2D u_lutTex;
  uniform float u_texSize;
  uniform int u_mode;
  uniform vec3 u_fluidColor;

  vec4 cubic(float v) {
    vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
    vec4 s = n * n * n;
    float x = s.x;
    float y = s.y - 4.0 * s.x;
    float z = s.z - 4.0 * s.y + 6.0 * s.x;
    float w = 6.0 - x - y - z;
    return vec4(x, y, z, w) * (1.0 / 6.0);
  }

  vec2 sampleBicubicRG(sampler2D tex, vec2 uv) {
    vec2 texCoords = uv * u_texSize - 0.5;
    vec2 fxy = fract(texCoords);
    texCoords -= fxy;

    vec4 xcubic = cubic(fxy.x);
    vec4 ycubic = cubic(fxy.y);

    vec4 c = texCoords.xxyy + vec2(-0.5, 1.5).xyxy;
    vec4 s = vec4(xcubic.xz + xcubic.yw, ycubic.xz + ycubic.yw);
    vec4 offset = c + vec4(xcubic.yw, ycubic.yw) / s;
    offset *= (1.0 / u_texSize);

    vec2 s0 = texture2D(tex, offset.xz).rg;
    vec2 s1 = texture2D(tex, offset.yz).rg;
    vec2 s2 = texture2D(tex, offset.xw).rg;
    vec2 s3 = texture2D(tex, offset.yw).rg;

    float sx = s.x / (s.x + s.y);
    float sy = s.z / (s.z + s.w);

    return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
  }

  void main() {
    vec2 flippedUv = vec2(v_uv.x, 1.0 - v_uv.y);
    float dist = length(flippedUv - 0.5);
    float inside = 1.0 - smoothstep(0.448, 0.451, dist);

    vec3 bg = vec3(0.0274, 0.0353, 0.0549);
    if (inside <= 0.001) {
      gl_FragColor = vec4(bg, 1.0);
      return;
    }

    vec2 val = sampleBicubicRG(u_fieldTex, flippedUv);
    vec3 col;

    if (u_mode == 0) {
      float eps = 1.0 / u_texSize;
      float wR = sampleBicubicRG(u_fieldTex, flippedUv + vec2(eps, 0.0)).r;
      float wL = sampleBicubicRG(u_fieldTex, flippedUv - vec2(eps, 0.0)).r;
      float wU = sampleBicubicRG(u_fieldTex, flippedUv + vec2(0.0, eps)).r;
      float wD = sampleBicubicRG(u_fieldTex, flippedUv - vec2(0.0, eps)).r;

      float relief = (wL - wR + wU - wD) * 0.65;
      float rimShade = 1.0 - 0.22 * smoothstep(0.34, 0.45, dist);
      float groove = clamp(val.r, 0.0, 1.0);
      float sheen = clamp(val.g, 0.0, 1.0);

      vec3 baseFluid = u_fluidColor * rimShade;
      vec3 grooved = mix(baseFluid, baseFluid * 0.72, groove * 0.55);
      col = grooved + vec3(relief * 0.28 + sheen * 0.10);
    } else {
      float t = clamp(val.r, 0.002, 0.998);
      col = texture2D(u_lutTex, vec2(t, 0.5)).rgb;
    }

    gl_FragColor = vec4(mix(bg, col, inside), 1.0);
  }
`;

interface GalerkinLevel {
  n: number;
  rs: number;
  size: number;
  active: Uint8Array;
  selfDiag: Float32Array;
  diag: Float32Array;
  cE: Float32Array;
  cN: Float32Array;
  x: Float32Array;
  rhs: Float32Array;
  res: Float32Array;
}

interface WebGLRenderer {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  vs: WebGLShader;
  fs: WebGLShader;
  vbo: WebGLBuffer | null;
  fieldTex: WebGLTexture;
  lutTexVel: WebGLTexture;
  lutTexVort: WebGLTexture;
  lutTexShear: WebGLTexture;
  uModeLoc: WebGLUniformLocation | null;
  uFluidColorLoc: WebGLUniformLocation | null;
  uLutTexLoc: WebGLUniformLocation | null;
}

interface StirrerState {
  active: boolean;
  gx0: number;
  gy0: number;
  gx1: number;
  gy1: number;
  rodRadiusGrid: number;
  tipVx: number;
  tipVy: number;
}

function parseHexColor(hex: string): [number, number, number] {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return [6, 182, 212];
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

function createGalerkinHierarchy(): GalerkinLevel[] {
  const levels: GalerkinLevel[] = [];
  for (let l = 0; l < MG_LEVELS; l++) {
    const n = GRID_N >> l;
    const rs = n + 2;
    const size = rs * rs;
    levels.push({
      n,
      rs,
      size,
      active: new Uint8Array(size),
      selfDiag: new Float32Array(size),
      diag: new Float32Array(size),
      cE: new Float32Array(size),
      cN: new Float32Array(size),
      x: new Float32Array(size),
      rhs: new Float32Array(size),
      res: new Float32Array(size),
    });
  }
  return levels;
}

function coarsenGalerkinHierarchy(levels: GalerkinLevel[]): void {
  for (let l = 0; l < MG_LEVELS - 1; l++) {
    const f = levels[l];
    const c = levels[l + 1];
    c.active.fill(0);
    c.selfDiag.fill(0);
    c.cE.fill(0);
    c.cN.fill(0);
    c.diag.fill(1);

    for (let J = 1; J <= c.n; J++) {
      const fj = 2 * J - 1;
      for (let I = 1; I <= c.n; I++) {
        const fi = 2 * I - 1;
        const cIdx = I + J * c.rs;
        const f00 = fi + fj * f.rs;
        const f10 = f00 + 1;
        const f01 = f00 + f.rs;
        const f11 = f01 + 1;

        const act = f.active[f00] | f.active[f10] | f.active[f01] | f.active[f11];
        c.active[cIdx] = act;
        if (!act) continue;

        c.selfDiag[cIdx] =
          f.selfDiag[f00] + f.selfDiag[f10] + f.selfDiag[f01] + f.selfDiag[f11];
        c.cE[cIdx] = f.cE[f10] + f.cE[f11];
        c.cN[cIdx] = f.cN[f01] + f.cN[f11];
      }
    }

    for (let J = 1; J <= c.n; J++) {
      let cIdx = 1 + J * c.rs;
      for (let I = 1; I <= c.n; I++, cIdx++) {
        if (!c.active[cIdx]) {
          c.diag[cIdx] = 1;
          continue;
        }
        const d =
          c.selfDiag[cIdx] +
          c.cE[cIdx - 1] +
          c.cE[cIdx] +
          c.cN[cIdx - c.rs] +
          c.cN[cIdx];
        c.diag[cIdx] = d > 1e-12 ? d : 1;
      }
    }
  }
}

function smoothGalerkin(lvl: GalerkinLevel, sweeps: number, reverse: boolean): void {
  const active = lvl.active;
  const diag = lvl.diag;
  const cE = lvl.cE;
  const cN = lvl.cN;
  const x = lvl.x;
  const rhs = lvl.rhs;
  const rs = lvl.rs;

  for (let s = 0; s < sweeps; s++) {
    for (let stepColor = 0; stepColor < 2; stepColor++) {
      const color = reverse ? 1 - stepColor : stepColor;
      for (let j = 1; j <= lvl.n; j++) {
        let i = 1 + ((j + color) & 1);
        let idx = i + j * rs;
        for (; i <= lvl.n; i += 2, idx += 2) {
          if (!active[idx]) continue;
          const nb =
            cE[idx - 1] * x[idx - 1] +
            cE[idx] * x[idx + 1] +
            cN[idx - rs] * x[idx - rs] +
            cN[idx] * x[idx + rs];
          x[idx] = (rhs[idx] + nb) / diag[idx];
        }
      }
    }
  }
}

function runGalerkinVCycle(
  levels: GalerkinLevel[],
  l: number,
  preSweeps: number,
  postSweeps: number,
  coarseSweeps: number
): void {
  const lvl = levels[l];
  if (l === MG_LEVELS - 1) {
    smoothGalerkin(lvl, coarseSweeps, false);
    smoothGalerkin(lvl, coarseSweeps, true);
    return;
  }

  smoothGalerkin(lvl, preSweeps, false);

  const active = lvl.active;
  const diag = lvl.diag;
  const cE = lvl.cE;
  const cN = lvl.cN;
  const x = lvl.x;
  const rhs = lvl.rhs;
  const res = lvl.res;
  const rs = lvl.rs;

  for (let j = 1; j <= lvl.n; j++) {
    let idx = 1 + j * rs;
    for (let i = 1; i <= lvl.n; i++, idx++) {
      if (!active[idx]) {
        res[idx] = 0;
        continue;
      }
      const ax =
        diag[idx] * x[idx] -
        (cE[idx - 1] * x[idx - 1] +
          cE[idx] * x[idx + 1] +
          cN[idx - rs] * x[idx - rs] +
          cN[idx] * x[idx + rs]);
      res[idx] = rhs[idx] - ax;
    }
  }

  const coarse = levels[l + 1];
  coarse.x.fill(0);

  for (let J = 1; J <= coarse.n; J++) {
    const fj = 2 * J - 1;
    for (let I = 1; I <= coarse.n; I++) {
      const fi = 2 * I - 1;
      const cIdx = I + J * coarse.rs;
      if (!coarse.active[cIdx]) {
        coarse.rhs[cIdx] = 0;
        continue;
      }
      const f00 = fi + fj * rs;
      const f10 = f00 + 1;
      const f01 = f00 + rs;
      const f11 = f01 + 1;
      coarse.rhs[cIdx] = res[f00] + res[f10] + res[f01] + res[f11];
    }
  }

  runGalerkinVCycle(levels, l + 1, preSweeps, postSweeps, coarseSweeps);

  for (let J = 1; J <= coarse.n; J++) {
    const fj = 2 * J - 1;
    for (let I = 1; I <= coarse.n; I++) {
      const fi = 2 * I - 1;
      const cIdx = I + J * coarse.rs;
      if (!coarse.active[cIdx]) continue;
      const e = coarse.x[cIdx];
      const f00 = fi + fj * rs;
      const f10 = f00 + 1;
      const f01 = f00 + rs;
      const f11 = f01 + 1;
      if (active[f00]) x[f00] += e;
      if (active[f10]) x[f10] += e;
      if (active[f01]) x[f01] += e;
      if (active[f11]) x[f11] += e;
    }
  }

  smoothGalerkin(lvl, postSweeps, true);
}

export class CFDEngine {
  public readonly n = GRID_N;
  public readonly rowSize = ROW_SIZE;
  public readonly tankRadiusGrid = GRID_N * 0.45;
  public readonly midGrid = (GRID_N + 1) * 0.5;

  private u = new Float32Array(GRID_SIZE);
  private v = new Float32Array(GRID_SIZE);
  private uTmp = new Float32Array(GRID_SIZE);
  private vTmp = new Float32Array(GRID_SIZE);
  private uFwd = new Float32Array(GRID_SIZE);
  private vFwd = new Float32Array(GRID_SIZE);
  private uBwd = new Float32Array(GRID_SIZE);
  private vBwd = new Float32Array(GRID_SIZE);

  private p = new Float32Array(GRID_SIZE);
  private dye = new Float32Array(GRID_SIZE);
  private dyeTmp = new Float32Array(GRID_SIZE);
  private dyeFwd = new Float32Array(GRID_SIZE);
  private dyeBwd = new Float32Array(GRID_SIZE);

  private wake = new Float32Array(GRID_SIZE);
  private wakeTmp = new Float32Array(GRID_SIZE);
  private wakeFwd = new Float32Array(GRID_SIZE);
  private wakeBwd = new Float32Array(GRID_SIZE);

  private shearRate = new Float32Array(GRID_SIZE);
  private shearStress = new Float32Array(GRID_SIZE);
  private vorticity = new Float32Array(GRID_SIZE);
  private absVort = new Float32Array(GRID_SIZE);
  private muApp = new Float32Array(GRID_SIZE);
  private speedField = new Float32Array(GRID_SIZE);
  private scalarA = new Float32Array(GRID_SIZE);
  private scalarB = new Float32Array(GRID_SIZE);

  private pMask = new Uint8Array(GRID_SIZE);
  private uMask = new Uint8Array(GRID_SIZE);
  private vMask = new Uint8Array(GRID_SIZE);
  private uWallFactor = new Float32Array(GRID_SIZE);
  private vWallFactor = new Float32Array(GRID_SIZE);
  private wallDeltaE = new Float32Array(GRID_SIZE);
  private wallDeltaW = new Float32Array(GRID_SIZE);
  private wallDeltaN = new Float32Array(GRID_SIZE);
  private wallDeltaS = new Float32Array(GRID_SIZE);
  private uRodWeight = new Float32Array(GRID_SIZE);
  private vRodWeight = new Float32Array(GRID_SIZE);

  private cgX = new Float32Array(GRID_SIZE);
  private cgR = new Float32Array(GRID_SIZE);
  private cgP = new Float32Array(GRID_SIZE);
  private cgAp = new Float32Array(GRID_SIZE);

  private diffLevels: GalerkinLevel[] = createGalerkinHierarchy();
  private pressLevels: GalerkinLevel[] = createGalerkinHierarchy();

  private rimTargetIndices: Int32Array = new Int32Array(0);
  private rimSourceIndices: Int32Array = new Int32Array(0);
  private fluidCellCount = 0;
  private refVariance = 0;
  private elapsedSec = 0;

  private emaMaxSpeed = 0.25;
  private emaMaxVort = 20;
  private emaMaxShear = 5;

  private stirrer: StirrerState = {
    active: false,
    gx0: 0,
    gy0: 0,
    gx1: 0,
    gy1: 0,
    rodRadiusGrid: 3,
    tipVx: 0,
    tipVy: 0,
  };

  private glFieldBytes = new Uint8Array(GRID_N * GRID_N * 4);
  private glRenderer: WebGLRenderer | null = null;

  private fallbackCanvas: HTMLCanvasElement | null = null;
  private fallbackCtx: CanvasRenderingContext2D | null = null;
  private fallbackImageData: ImageData | null = null;
  private fallbackBuf32: Uint32Array | null = null;

  constructor() {
    this.buildMasks();
    this.reset(1.0);
  }

  public initRenderer(glCanvas: HTMLCanvasElement): boolean {
    if (this.glRenderer) return true;
    const gl = glCanvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) return false;

    const compile = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };

    const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      return false;
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return false;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return false;
    }

    gl.useProgram(program);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );

    const posLoc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    const fieldTex = gl.createTexture();
    if (!fieldTex) {
      if (vbo) gl.deleteBuffer(vbo);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return false;
    }
    gl.bindTexture(gl.TEXTURE_2D, fieldTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      GRID_N,
      GRID_N,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.glFieldBytes
    );

    const createLutTex = (bytes: Uint8Array): WebGLTexture | null => {
      const tex = gl.createTexture();
      if (!tex) return null;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      return tex;
    };

    const lutTexVel = createLutTex(VELOCITY_BYTES);
    const lutTexVort = createLutTex(VORTICITY_BYTES);
    const lutTexShear = createLutTex(SHEAR_BYTES);
    if (!lutTexVel || !lutTexVort || !lutTexShear) {
      if (lutTexVel) gl.deleteTexture(lutTexVel);
      if (lutTexVort) gl.deleteTexture(lutTexVort);
      if (lutTexShear) gl.deleteTexture(lutTexShear);
      gl.deleteTexture(fieldTex);
      if (vbo) gl.deleteBuffer(vbo);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return false;
    }

    gl.uniform1f(gl.getUniformLocation(program, 'u_texSize'), GRID_N);
    gl.uniform1i(gl.getUniformLocation(program, 'u_fieldTex'), 0);

    this.glRenderer = {
      gl,
      program,
      vs,
      fs,
      vbo,
      fieldTex,
      lutTexVel,
      lutTexVort,
      lutTexShear,
      uModeLoc: gl.getUniformLocation(program, 'u_mode'),
      uFluidColorLoc: gl.getUniformLocation(program, 'u_fluidColor'),
      uLutTexLoc: gl.getUniformLocation(program, 'u_lutTex'),
    };
    return true;
  }

  public dispose(): void {
    if (this.glRenderer) {
      const {
        gl,
        program,
        vs,
        fs,
        vbo,
        fieldTex,
        lutTexVel,
        lutTexVort,
        lutTexShear,
      } = this.glRenderer;
      gl.deleteTexture(fieldTex);
      gl.deleteTexture(lutTexVel);
      gl.deleteTexture(lutTexVort);
      gl.deleteTexture(lutTexShear);
      if (vbo) gl.deleteBuffer(vbo);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      this.glRenderer = null;
    }
    this.fallbackCanvas = null;
    this.fallbackCtx = null;
    this.fallbackImageData = null;
    this.fallbackBuf32 = null;
  }

  private ensureFallback2D(): void {
    if (this.fallbackCanvas) return;
    const c = document.createElement('canvas');
    c.width = GRID_N;
    c.height = GRID_N;
    const ctx = c.getContext('2d', { alpha: false });
    if (!ctx) return;
    const img = ctx.createImageData(GRID_N, GRID_N);
    this.fallbackCanvas = c;
    this.fallbackCtx = ctx;
    this.fallbackImageData = img;
    this.fallbackBuf32 = new Uint32Array(img.data.buffer);
  }

  private buildMasks(): void {
    const rSq = this.tankRadiusGrid * this.tankRadiusGrid;
    let count = 0;

    for (let j = 1; j <= GRID_N; j++) {
      const dj = j - this.midGrid;
      for (let i = 1; i <= GRID_N; i++) {
        const di = i - this.midGrid;
        const idx = i + j * ROW_SIZE;
        if (di * di + dj * dj < rSq) {
          this.pMask[idx] = 1;
          count++;
        }
      }
    }
    this.fluidCellCount = count;

    const rimTargets: number[] = [];
    const rimSources: number[] = [];
    for (let j = 1; j <= GRID_N; j++) {
      for (let i = 1; i <= GRID_N; i++) {
        const idx = i + j * ROW_SIZE;
        if (this.pMask[idx]) continue;
        let src = 0;
        if (this.pMask[idx - 1]) src = idx - 1;
        else if (this.pMask[idx + 1]) src = idx + 1;
        else if (this.pMask[idx - ROW_SIZE]) src = idx - ROW_SIZE;
        else if (this.pMask[idx + ROW_SIZE]) src = idx + ROW_SIZE;
        else if (this.pMask[idx - 1 - ROW_SIZE]) src = idx - 1 - ROW_SIZE;
        else if (this.pMask[idx + 1 - ROW_SIZE]) src = idx + 1 - ROW_SIZE;
        else if (this.pMask[idx - 1 + ROW_SIZE]) src = idx - 1 + ROW_SIZE;
        else if (this.pMask[idx + 1 + ROW_SIZE]) src = idx + 1 + ROW_SIZE;

        if (src > 0) {
          rimTargets.push(idx);
          rimSources.push(src);
        }
      }
    }
    this.rimTargetIndices = new Int32Array(rimTargets);
    this.rimSourceIndices = new Int32Array(rimSources);

    for (let j = 1; j <= GRID_N; j++) {
      for (let i = 1; i <= GRID_N; i++) {
        const idx = i + j * ROW_SIZE;
        if (this.pMask[idx] && this.pMask[idx - 1]) {
          this.uMask[idx] = 1;
        }
        if (this.pMask[idx] && this.pMask[idx - ROW_SIZE]) {
          this.vMask[idx] = 1;
        }
      }
    }

    const rTank = this.tankRadiusGrid;
    const mid = this.midGrid;
    const axisTheta = (cx: number, cy: number, dx: number, dy: number): number => {
      const rx = cx - mid;
      const ry = cy - mid;
      const b = rx * dx + ry * dy;
      const c = rx * rx + ry * ry - rTank * rTank;
      const disc = b * b - c;
      if (disc <= 0) return 0.35;
      const t = -b + Math.sqrt(disc);
      return Math.max(0.35, Math.min(1.0, t));
    };

    this.uWallFactor.fill(0);
    this.vWallFactor.fill(0);
    this.wallDeltaE.fill(1);
    this.wallDeltaW.fill(1);
    this.wallDeltaN.fill(1);
    this.wallDeltaS.fill(1);

    for (let j = 1; j <= GRID_N; j++) {
      const dj = j - mid;
      for (let i = 1; i <= GRID_N; i++) {
        const di = i - mid;
        const idx = i + j * ROW_SIZE;
        if (this.pMask[idx]) {
          const xSpanSq = Math.max(0, rSq - dj * dj);
          const ySpanSq = Math.max(0, rSq - di * di);
          const xWall = Math.sqrt(xSpanSq);
          const yWall = Math.sqrt(ySpanSq);
          if (!this.pMask[idx + 1]) {
            this.wallDeltaE[idx] = Math.max(0.02, Math.min(1.0, mid + xWall - i));
          }
          if (!this.pMask[idx - 1]) {
            this.wallDeltaW[idx] = Math.max(0.02, Math.min(1.0, i - (mid - xWall)));
          }
          if (!this.pMask[idx + ROW_SIZE]) {
            this.wallDeltaN[idx] = Math.max(0.02, Math.min(1.0, mid + yWall - j));
          }
          if (!this.pMask[idx - ROW_SIZE]) {
            this.wallDeltaS[idx] = Math.max(0.02, Math.min(1.0, j - (mid - yWall)));
          }
        }

        if (this.uMask[idx]) {
          const px = i - 0.5;
          const py = j;
          let wf = 0;
          if (!this.uMask[idx + 1]) wf += 1 / axisTheta(px, py, 1, 0);
          if (!this.uMask[idx - 1]) wf += 1 / axisTheta(px, py, -1, 0);
          if (!this.uMask[idx + ROW_SIZE]) wf += 1 / axisTheta(px, py, 0, 1);
          if (!this.uMask[idx - ROW_SIZE]) wf += 1 / axisTheta(px, py, 0, -1);
          this.uWallFactor[idx] = wf;
        }
        if (this.vMask[idx]) {
          const px = i;
          const py = j - 0.5;
          let wf = 0;
          if (!this.vMask[idx + 1]) wf += 1 / axisTheta(px, py, 1, 0);
          if (!this.vMask[idx - 1]) wf += 1 / axisTheta(px, py, -1, 0);
          if (!this.vMask[idx + ROW_SIZE]) wf += 1 / axisTheta(px, py, 0, 1);
          if (!this.vMask[idx - ROW_SIZE]) wf += 1 / axisTheta(px, py, 0, -1);
          this.vWallFactor[idx] = wf;
        }
      }
    }

    const p0 = this.pressLevels[0];
    p0.active.set(this.pMask);
    p0.selfDiag.fill(0);
    p0.cE.fill(0);
    p0.cN.fill(0);
    p0.diag.fill(1);
    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (!this.pMask[idx]) continue;
        if (this.pMask[idx + 1]) p0.cE[idx] = 1.0;
        if (this.pMask[idx + ROW_SIZE]) p0.cN[idx] = 1.0;
      }
    }
    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (!p0.active[idx]) continue;
        const d =
          p0.cE[idx - 1] + p0.cE[idx] + p0.cN[idx - ROW_SIZE] + p0.cN[idx];
        p0.diag[idx] = d > 1e-12 ? d : 1;
      }
    }
    coarsenGalerkinHierarchy(this.pressLevels);
  }

  public getCellSizeMeters(config: FluidConfig): number {
    const diameterM = Math.max(0.05, config.tankDiameterMm * 0.001);
    return diameterM / (2 * this.tankRadiusGrid);
  }

  public reset(initialMuPaS?: number): void {
    this.u.fill(0);
    this.v.fill(0);
    this.uTmp.fill(0);
    this.vTmp.fill(0);
    this.p.fill(0);
    this.dye.fill(0);
    this.wake.fill(0);
    this.shearRate.fill(0);
    this.shearStress.fill(0);
    this.vorticity.fill(0);
    this.absVort.fill(0);
    this.speedField.fill(0);
    this.uRodWeight.fill(0);
    this.vRodWeight.fill(0);
    this.stirrer.active = false;
    this.elapsedSec = 0;
    this.emaMaxSpeed = 0.25;
    this.emaMaxVort = 20;
    this.emaMaxShear = 5;

    const muFill = initialMuPaS ?? 0.001;
    this.muApp.fill(muFill);

    const blobRadius = this.tankRadiusGrid * 0.48;
    const sigmaSq = 2 * Math.pow(blobRadius * 0.56, 2);

    for (let j = 1; j <= GRID_N; j++) {
      const dj = j - this.midGrid;
      for (let i = 1; i <= GRID_N; i++) {
        const di = i - this.midGrid;
        const idx = i + j * ROW_SIZE;
        if (!this.pMask[idx]) continue;

        const rSq = di * di + dj * dj;
        if (rSq < blobRadius * blobRadius * 1.6) {
          this.dye[idx] = Math.exp(-rSq / sigmaSq);
        }
      }
    }

    this.refVariance = Math.max(1e-4, this.computeDyeVariance());
  }

  public applyStirrerImpulse(
    x0Norm: number,
    y0Norm: number,
    x1Norm: number,
    y1Norm: number,
    dt: number,
    config: FluidConfig
  ): void {
    if (dt <= 0) return;
    const h = this.getCellSizeMeters(config);

    const gx0 = x0Norm * GRID_N + 0.5;
    const gy0 = y0Norm * GRID_N + 0.5;
    const gx1 = x1Norm * GRID_N + 0.5;
    const gy1 = y1Norm * GRID_N + 0.5;

    const segDx = gx1 - gx0;
    const segDy = gy1 - gy0;
    const segLenSq = segDx * segDx + segDy * segDy;

    const rawVx = (segDx * h) / dt;
    const rawVy = (segDy * h) / dt;
    const speed = Math.hypot(rawVx, rawVy);
    const maxTipSpeed = 3.2;
    const clampScale = speed > maxTipSpeed ? maxTipSpeed / speed : 1;

    this.stirrer = {
      active: true,
      gx0,
      gy0,
      gx1,
      gy1,
      rodRadiusGrid: Math.max(1.8, (config.stirrerDiameterMm * 0.0005) / h),
      tipVx: segLenSq > 1e-8 ? rawVx * clampScale : 0,
      tipVy: segLenSq > 1e-8 ? rawVy * clampScale : 0,
    };
  }

  public step(frameDt: number, config: FluidConfig): void {
    const dtTotal = Math.min(0.033, Math.max(0.004, frameDt));
    const h = this.getCellSizeMeters(config);

    let maxVel = Math.hypot(this.stirrer.tipVx, this.stirrer.tipVy);
    for (let i = 0; i < GRID_SIZE; i++) {
      const au = Math.abs(this.u[i]);
      const av = Math.abs(this.v[i]);
      if (au > maxVel) maxVel = au;
      if (av > maxVel) maxVel = av;
    }

    const rho = Math.max(200, config.densityKgM3);
    const effBasePaS = getEffectiveBaseViscosityMpas(config.viscosityMpas) / 1000;
    const baseNu = effBasePaS / rho;
    const baseAlphaEst = dtTotal / (rho * h * h);
    const isViscousDominated = baseNu > 0.02 || baseAlphaEst * effBasePaS > 1.0;

    const cfl = (maxVel * dtTotal) / h;
    const substeps = isViscousDominated
      ? 1
      : cfl > 2.8
      ? 2
      : 1;
    const dt = dtTotal / substeps;

    for (let s = 0; s < substeps; s++) {
      this.stepSub(dt, h, config);
    }

    this.stirrer.active = false;
    this.elapsedSec += dtTotal;
  }

  private buildStirrerPenaltyWeights(baseAlpha: number): void {
    this.uRodWeight.fill(0);
    this.vRodWeight.fill(0);
    if (!this.stirrer.active) return;

    const { gx0, gy0, gx1, gy1, rodRadiusGrid } = this.stirrer;
    const segDx = gx1 - gx0;
    const segDy = gy1 - gy0;
    const segLenSq = segDx * segDx + segDy * segDy;
    const searchPad = Math.ceil(rodRadiusGrid) + 2;

    const minI = Math.max(2, Math.floor(Math.min(gx0, gx1) - searchPad));
    const maxI = Math.min(GRID_N, Math.ceil(Math.max(gx0, gx1) + searchPad));
    const minJ = Math.max(2, Math.floor(Math.min(gy0, gy1) - searchPad));
    const maxJ = Math.min(GRID_N, Math.ceil(Math.max(gy0, gy1) + searchPad));

    for (let j = minJ; j <= maxJ; j++) {
      for (let i = minI; i <= maxI; i++) {
        const idx = i + j * ROW_SIZE;
        if (this.uMask[idx]) {
          const px = i - 0.5;
          const py = j;
          const t =
            segLenSq > 1e-8
              ? Math.max(0, Math.min(1, ((px - gx0) * segDx + (py - gy0) * segDy) / segLenSq))
              : 0;
          const dist = Math.hypot(px - (gx0 + t * segDx), py - (gy0 + t * segDy));
          if (dist < rodRadiusGrid) {
            const s = 1 - dist / rodRadiusGrid;
            const w = s * s * s * (10 + s * (-15 + 6 * s));
            const muLocal = this.muApp[idx];
            this.uRodWeight[idx] = w * 18 * (1 + 4 * baseAlpha * muLocal);
          }
        }
        if (this.vMask[idx]) {
          const px = i;
          const py = j - 0.5;
          const t =
            segLenSq > 1e-8
              ? Math.max(0, Math.min(1, ((px - gx0) * segDx + (py - gy0) * segDy) / segLenSq))
              : 0;
          const dist = Math.hypot(px - (gx0 + t * segDx), py - (gy0 + t * segDy));
          if (dist < rodRadiusGrid) {
            const s = 1 - dist / rodRadiusGrid;
            const w = s * s * s * (10 + s * (-15 + 6 * s));
            const muLocal = this.muApp[idx];
            this.vRodWeight[idx] = w * 18 * (1 + 4 * baseAlpha * muLocal);
          }
        }
      }
    }
  }

  private stepSub(dt: number, h: number, config: FluidConfig): void {
    const rho = Math.max(200, config.densityKgM3);

    this.computeKinematicsAndRheology(h, config);

    const baseNu =
      getEffectiveBaseViscosityMpas(config.viscosityMpas) / (1000 * rho);
    const isCreepingStokes = baseNu > 0.02;

    if (!isCreepingStokes) {
      this.applyVorticityConfinement(dt, h, baseNu);
      this.advectVelocityMacCormack(dt, h);
    }

    const baseAlpha = dt / (rho * h * h);
    this.buildStirrerPenaltyWeights(baseAlpha);

    const effBasePaS = getEffectiveBaseViscosityMpas(config.viscosityMpas) / 1000;
    const isViscousCoupled = baseAlpha * effBasePaS > 0.25;

    if (isViscousCoupled) {
      this.uFwd.set(this.u);
      this.vFwd.set(this.v);
      this.solveDiffusionGalerkin(dt, h, rho, true, 3, 1e-5);
      this.projectPressureGalerkin(dt, h, rho, true, 3, 1e-5);
      this.u.set(this.uFwd);
      this.v.set(this.vFwd);
      this.solveDiffusionGalerkin(dt, h, rho, true, 6, 1e-8);
      this.projectPressureGalerkin(dt, h, rho, true, 6, 1e-8);
    } else {
      this.solveDiffusionGalerkin(dt, h, rho, true, 5, 1e-7);
      this.projectPressureGalerkin(dt, h, rho, true, 5, 1e-7);
    }

    if (isCreepingStokes) {
      let maxV = 0;
      for (let i = 0; i < GRID_SIZE; i++) {
        const av = Math.abs(this.u[i]);
        const bv = Math.abs(this.v[i]);
        if (av > maxV) maxV = av;
        if (bv > maxV) maxV = bv;
      }
      const scalarSteps = (maxV * dt) / h > 2.0 ? 2 : 1;
      const sdt = dt / scalarSteps;
      for (let k = 0; k < scalarSteps; k++) {
        this.advectScalarMacCormack(this.dye, this.dyeFwd, this.dyeBwd, this.dyeTmp, sdt, h);
      }
      this.updatePlasticWake(dt, h, config, effBasePaS);
    } else {
      this.advectScalarMacCormack(this.dye, this.dyeFwd, this.dyeBwd, this.dyeTmp, dt, h);
      this.updatePlasticWake(dt, h, config, effBasePaS);
    }
    this.computeKinematicsAndRheology(h, config);
  }

  private updatePlasticWake(
    dt: number,
    h: number,
    config: FluidConfig,
    effBasePaS: number
  ): void {
    if (this.stirrer.active) {
      const { gx0, gy0, gx1, gy1, rodRadiusGrid } = this.stirrer;
      const segDx = gx1 - gx0;
      const segDy = gy1 - gy0;
      const segLenSq = segDx * segDx + segDy * segDy;
      const speedRod = Math.hypot(this.stirrer.tipVx, this.stirrer.tipVy);
      if (speedRod > 0.01) {
        const searchPad = Math.ceil(rodRadiusGrid) + 2;
        const minI = Math.max(2, Math.floor(Math.min(gx0, gx1) - searchPad));
        const maxI = Math.min(GRID_N, Math.ceil(Math.max(gx0, gx1) + searchPad));
        const minJ = Math.max(2, Math.floor(Math.min(gy0, gy1) - searchPad));
        const maxJ = Math.min(GRID_N, Math.ceil(Math.max(gy0, gy1) + searchPad));

        for (let j = minJ; j <= maxJ; j++) {
          for (let i = minI; i <= maxI; i++) {
            const idx = i + j * ROW_SIZE;
            if (!this.pMask[idx]) continue;
            const t =
              segLenSq > 1e-8
                ? Math.max(0, Math.min(1, ((i - gx0) * segDx + (j - gy0) * segDy) / segLenSq))
                : 0;
            const dist = Math.hypot(i - (gx0 + t * segDx), j - (gy0 + t * segDy));
            if (dist < rodRadiusGrid * 1.15) {
              const s = 1 - dist / (rodRadiusGrid * 1.15);
              const imprint = s * s * Math.min(1, speedRod * 0.65);
              if (imprint > this.wake[idx]) {
                this.wake[idx] = imprint;
              }
            }
          }
        }
      }
    }

    this.advectScalarMacCormack(this.wake, this.wakeFwd, this.wakeBwd, this.wakeTmp, dt, h);

    const yieldRetention =
      config.model === 'herschel-bulkley' ? Math.min(1, config.yieldStressPa / 40) : 0;
    const relaxRate =
      effBasePaS < 0.05
        ? 1.4
        : Math.max(0.02, 0.9 / (1 + Math.pow(effBasePaS, 0.65) * 2.5)) * (1 - 0.92 * yieldRetention);
    const decayFactor = Math.exp(-relaxRate * dt);

    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (!this.pMask[idx]) {
          this.wake[idx] = 0;
          continue;
        }
        const shearMark = Math.min(0.45, this.absVort[idx] * 0.008) * (effBasePaS < 0.1 ? 1 : 0.2);
        const next = Math.max(this.wake[idx] * decayFactor, shearMark);
        this.wake[idx] = next > 1 ? 1 : next;
      }
    }
  }

  private computeKinematicsAndRheology(h: number, config: FluidConfig): void {
    const invH = 1 / h;
    const ucBuf = this.scalarA;
    const vcBuf = this.scalarB;

    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (!this.pMask[idx]) {
          ucBuf[idx] = 0;
          vcBuf[idx] = 0;
          this.shearRate[idx] = 0;
          this.shearStress[idx] = 0;
          this.vorticity[idx] = 0;
          this.absVort[idx] = 0;
          this.speedField[idx] = 0;
          continue;
        }

        const hasW = this.uMask[idx];
        const hasE = this.uMask[idx + 1];
        let uc = 0;
        if (hasW && hasE) {
          uc = 0.5 * (this.u[idx] + this.u[idx + 1]);
        } else if (hasW) {
          const dE = this.wallDeltaE[idx];
          uc = this.u[idx] * (dE / (0.5 + dE));
        } else if (hasE) {
          const dW = this.wallDeltaW[idx];
          uc = this.u[idx + 1] * (dW / (0.5 + dW));
        }

        const hasS = this.vMask[idx];
        const hasN = this.vMask[idx + ROW_SIZE];
        let vc = 0;
        if (hasS && hasN) {
          vc = 0.5 * (this.v[idx] + this.v[idx + ROW_SIZE]);
        } else if (hasS) {
          const dN = this.wallDeltaN[idx];
          vc = this.v[idx] * (dN / (0.5 + dN));
        } else if (hasN) {
          const dS = this.wallDeltaS[idx];
          vc = this.v[idx + ROW_SIZE] * (dS / (0.5 + dS));
        }

        ucBuf[idx] = uc;
        vcBuf[idx] = vc;
        this.speedField[idx] = Math.hypot(uc, vc);
      }
    }

    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (!this.pMask[idx]) continue;

        const hasW = this.uMask[idx];
        const hasE = this.uMask[idx + 1];
        let dudx = 0;
        if (hasW && hasE) {
          dudx = (this.u[idx + 1] - this.u[idx]) * invH;
        } else if (hasW) {
          dudx = -this.u[idx] / ((0.5 + this.wallDeltaE[idx]) * h);
        } else if (hasE) {
          dudx = this.u[idx + 1] / ((0.5 + this.wallDeltaW[idx]) * h);
        }

        const hasS = this.vMask[idx];
        const hasN = this.vMask[idx + ROW_SIZE];
        let dvdy = 0;
        if (hasS && hasN) {
          dvdy = (this.v[idx + ROW_SIZE] - this.v[idx]) * invH;
        } else if (hasS) {
          dvdy = -this.v[idx] / ((0.5 + this.wallDeltaN[idx]) * h);
        } else if (hasN) {
          dvdy = this.v[idx + ROW_SIZE] / ((0.5 + this.wallDeltaS[idx]) * h);
        }

        const pN = this.pMask[idx + ROW_SIZE];
        const pS = this.pMask[idx - ROW_SIZE];
        let dudy = 0;
        if (pN && pS) {
          dudy = (ucBuf[idx + ROW_SIZE] - ucBuf[idx - ROW_SIZE]) * (0.5 * invH);
        } else if (pS) {
          dudy = -ucBuf[idx - ROW_SIZE] / ((1 + this.wallDeltaN[idx]) * h);
        } else if (pN) {
          dudy = ucBuf[idx + ROW_SIZE] / ((1 + this.wallDeltaS[idx]) * h);
        }

        const pE = this.pMask[idx + 1];
        const pW = this.pMask[idx - 1];
        let dvdx = 0;
        if (pE && pW) {
          dvdx = (vcBuf[idx + 1] - vcBuf[idx - 1]) * (0.5 * invH);
        } else if (pW) {
          dvdx = -vcBuf[idx - 1] / ((1 + this.wallDeltaE[idx]) * h);
        } else if (pE) {
          dvdx = vcBuf[idx + 1] / ((1 + this.wallDeltaW[idx]) * h);
        }

        const vort = dvdx - dudy;
        this.vorticity[idx] = vort;
        this.absVort[idx] = Math.abs(vort);

        const gamma = Math.sqrt(
          2 * dudx * dudx + 2 * dvdy * dvdy + (dudy + dvdx) * (dudy + dvdx) + 1e-6
        );
        this.shearRate[idx] = gamma;

        const mu = computeApparentViscosityPaS(gamma, config);
        this.muApp[idx] = mu;
        this.shearStress[idx] = mu * gamma;
      }
    }
  }

  private applyVorticityConfinement(dt: number, h: number, baseNu: number): void {
    const reScale = Math.max(0, Math.min(1, (1e-5 / Math.max(baseNu, 1e-8) - 0.15) * 0.25));
    if (reScale <= 0.01) return;

    const eps = 1.6 * h * reScale * dt;

    for (let j = 2; j < GRID_N; j++) {
      let idx = 2 + j * ROW_SIZE;
      for (let i = 2; i < GRID_N; i++, idx++) {
        if (!this.pMask[idx]) continue;

        const dwDx = (this.absVort[idx + 1] - this.absVort[idx - 1]) * (0.5 / h);
        const dwDy = (this.absVort[idx + ROW_SIZE] - this.absVort[idx - ROW_SIZE]) * (0.5 / h);
        const len = Math.hypot(dwDx, dwDy) + 1e-6;
        const nx = dwDx / len;
        const ny = dwDy / len;

        const fx = ny * this.vorticity[idx] * eps;
        const fy = -nx * this.vorticity[idx] * eps;

        if (this.uMask[idx]) this.u[idx] += fx;
        if (this.uMask[idx + 1]) this.u[idx + 1] += fx;
        if (this.vMask[idx]) this.v[idx] += fy;
        if (this.vMask[idx + ROW_SIZE]) this.v[idx + ROW_SIZE] += fy;
      }
    }
  }

  private sampleFace(
    src: Float32Array,
    gx: number,
    gy: number,
    isU: boolean
  ): [number, number, number] {
    const maxX = isU ? GRID_N + 0.999 : GRID_N - 0.001;
    const maxY = isU ? GRID_N - 0.001 : GRID_N + 0.999;
    const x = gx < 1 ? 1 : gx > maxX ? maxX : gx;
    const y = gy < 1 ? 1 : gy > maxY ? maxY : gy;
    const i0 = x | 0;
    const j0 = y | 0;
    const sx = x - i0;
    const sy = y - j0;
    const idx00 = i0 + j0 * ROW_SIZE;
    const idx10 = idx00 + 1;
    const idx01 = idx00 + ROW_SIZE;
    const idx11 = idx01 + 1;

    const q00 = src[idx00];
    const q10 = src[idx10];
    const q01 = src[idx01];
    const q11 = src[idx11];

    const minV = Math.min(q00, q10, q01, q11);
    const maxV = Math.max(q00, q10, q01, q11);
    const val = (1 - sx) * ((1 - sy) * q00 + sy * q01) + sx * ((1 - sy) * q10 + sy * q11);
    return [val, minV, maxV];
  }

  private advectVelocityMacCormack(dt: number, h: number): void {
    const dtOverH = dt / h;
    const u = this.u;
    const v = this.v;

    this.uFwd.set(u);
    this.vFwd.set(v);

    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (this.uMask[idx]) {
          const vx = u[idx];
          const vy = 0.25 * (v[idx - 1] + v[idx] + v[idx - 1 + ROW_SIZE] + v[idx + ROW_SIZE]);
          const [val] = this.sampleFace(u, i - dtOverH * vx, j - dtOverH * vy, true);
          this.uFwd[idx] = val;
        }
        if (this.vMask[idx]) {
          const vx = 0.25 * (u[idx - ROW_SIZE] + u[idx + 1 - ROW_SIZE] + u[idx] + u[idx + 1]);
          const vy = v[idx];
          const [val] = this.sampleFace(v, i - dtOverH * vx, j - dtOverH * vy, false);
          this.vFwd[idx] = val;
        }
      }
    }

    this.uBwd.set(this.uFwd);
    this.vBwd.set(this.vFwd);

    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (this.uMask[idx]) {
          const vx = u[idx];
          const vy = 0.25 * (v[idx - 1] + v[idx] + v[idx - 1 + ROW_SIZE] + v[idx + ROW_SIZE]);
          const [val] = this.sampleFace(this.uFwd, i + dtOverH * vx, j + dtOverH * vy, true);
          this.uBwd[idx] = val;
        }
        if (this.vMask[idx]) {
          const vx = 0.25 * (u[idx - ROW_SIZE] + u[idx + 1 - ROW_SIZE] + u[idx] + u[idx + 1]);
          const vy = v[idx];
          const [val] = this.sampleFace(this.vFwd, i + dtOverH * vx, j + dtOverH * vy, false);
          this.vBwd[idx] = val;
        }
      }
    }

    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (this.uMask[idx]) {
          const vx = u[idx];
          const vy = 0.25 * (v[idx - 1] + v[idx] + v[idx - 1 + ROW_SIZE] + v[idx + ROW_SIZE]);
          const [fwd, minV, maxV] = this.sampleFace(u, i - dtOverH * vx, j - dtOverH * vy, true);
          const corr = fwd + 0.5 * (u[idx] - this.uBwd[idx]);
          this.uTmp[idx] = corr < minV ? minV : corr > maxV ? maxV : corr;
        } else {
          this.uTmp[idx] = 0;
        }

        if (this.vMask[idx]) {
          const vx = 0.25 * (u[idx - ROW_SIZE] + u[idx + 1 - ROW_SIZE] + u[idx] + u[idx + 1]);
          const vy = v[idx];
          const [fwd, minV, maxV] = this.sampleFace(v, i - dtOverH * vx, j - dtOverH * vy, false);
          const corr = fwd + 0.5 * (v[idx] - this.vBwd[idx]);
          this.vTmp[idx] = corr < minV ? minV : corr > maxV ? maxV : corr;
        } else {
          this.vTmp[idx] = 0;
        }
      }
    }

    this.u.set(this.uTmp);
    this.v.set(this.vTmp);
  }

  private solveDiffusionGalerkin(
    dt: number,
    h: number,
    rho: number,
    includePressure: boolean,
    maxIter: number,
    relTol: number
  ): void {
    const baseAlpha = dt / (rho * h * h);
    const invScale = includePressure ? dt / (rho * h) : 0;

    this.solveComponentDiffusionGalerkin(
      this.u,
      this.uMask,
      this.uWallFactor,
      this.uRodWeight,
      this.stirrer.tipVx,
      baseAlpha,
      invScale,
      1,
      maxIter,
      relTol
    );
    this.solveComponentDiffusionGalerkin(
      this.v,
      this.vMask,
      this.vWallFactor,
      this.vRodWeight,
      this.stirrer.tipVy,
      baseAlpha,
      invScale,
      ROW_SIZE,
      maxIter,
      relTol
    );
  }

  private solveComponentDiffusionGalerkin(
    field: Float32Array,
    mask: Uint8Array,
    wallFactor: Float32Array,
    rodWeight: Float32Array,
    tipVel: number,
    baseAlpha: number,
    invScale: number,
    gradStride: number,
    maxIter: number,
    relTol: number
  ): void {
    const l0 = this.diffLevels[0];
    l0.active.set(mask);
    l0.selfDiag.fill(0);
    l0.cE.fill(0);
    l0.cN.fill(0);
    l0.diag.fill(1);

    const cgX = this.cgX;
    const cgR = this.cgR;
    const cgP = this.cgP;
    const cgAp = this.cgAp;
    cgX.fill(0);
    cgR.fill(0);
    cgP.fill(0);
    cgAp.fill(0);

    const mu = this.muApp;
    const p = this.p;
    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (!mask[idx]) continue;

        const mC = mu[idx];
        if (mask[idx + 1]) {
          const mNb = mu[idx + 1];
          l0.cE[idx] = baseAlpha * ((2 * mC * mNb) / (mC + mNb + 1e-12));
        }
        if (mask[idx + ROW_SIZE]) {
          const mNb = mu[idx + ROW_SIZE];
          l0.cN[idx] = baseAlpha * ((2 * mC * mNb) / (mC + mNb + 1e-12));
        }

        const wallDiag = baseAlpha * mC * wallFactor[idx];
        const rw = rodWeight[idx];
        l0.selfDiag[idx] = 1.0 + rw + wallDiag;

        const pGrad = invScale > 0 ? invScale * (p[idx] - p[idx - gradStride]) : 0;
        const rhsVal = field[idx] + rw * tipVel - pGrad;
        cgR[idx] = rhsVal;
        cgX[idx] = rw > 0 ? tipVel : field[idx] / (1.0 + 0.015 * baseAlpha * mC);
      }
    }

    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (!mask[idx]) continue;
        l0.diag[idx] =
          l0.selfDiag[idx] +
          l0.cE[idx - 1] +
          l0.cE[idx] +
          l0.cN[idx - ROW_SIZE] +
          l0.cN[idx];
      }
    }

    coarsenGalerkinHierarchy(this.diffLevels);

    const diag = l0.diag;
    const cE = l0.cE;
    const cN = l0.cN;

    let r0Sq = 0;
    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (!mask[idx]) continue;
        const ax =
          diag[idx] * cgX[idx] -
          (cE[idx - 1] * cgX[idx - 1] +
            cE[idx] * cgX[idx + 1] +
            cN[idx - ROW_SIZE] * cgX[idx - ROW_SIZE] +
            cN[idx] * cgX[idx + ROW_SIZE]);
        const rVal = cgR[idx] - ax;
        cgR[idx] = rVal;
        r0Sq += rVal * rVal;
      }
    }

    if (r0Sq > 1e-18) {
      l0.rhs.set(cgR);
      l0.x.fill(0);
      runGalerkinVCycle(this.diffLevels, 0, 1, 2, 8);

      let rzOld = 0;
      for (let i = 0; i < l0.size; i++) {
        if (!mask[i]) continue;
        const z = l0.x[i];
        cgP[i] = z;
        rzOld += cgR[i] * z;
      }

      for (let iter = 0; iter < maxIter; iter++) {
        let pAp = 0;
        for (let j = 1; j <= GRID_N; j++) {
          let idx = 1 + j * ROW_SIZE;
          for (let i = 1; i <= GRID_N; i++, idx++) {
            if (!mask[idx]) continue;
            const ap =
              diag[idx] * cgP[idx] -
              (cE[idx - 1] * cgP[idx - 1] +
                cE[idx] * cgP[idx + 1] +
                cN[idx - ROW_SIZE] * cgP[idx - ROW_SIZE] +
                cN[idx] * cgP[idx + ROW_SIZE]);
            cgAp[idx] = ap;
            pAp += cgP[idx] * ap;
          }
        }

        if (pAp <= 1e-22) break;
        const alpha = rzOld / pAp;

        let rSq = 0;
        for (let i = 0; i < l0.size; i++) {
          if (!mask[i]) continue;
          cgX[i] += alpha * cgP[i];
          const rNext = cgR[i] - alpha * cgAp[i];
          cgR[i] = rNext;
          rSq += rNext * rNext;
        }

        if (rSq <= relTol * r0Sq || rSq <= 1e-18) break;

        l0.rhs.set(cgR);
        l0.x.fill(0);
        runGalerkinVCycle(this.diffLevels, 0, 1, 2, 8);

        let rzNew = 0;
        for (let i = 0; i < l0.size; i++) {
          if (mask[i]) rzNew += cgR[i] * l0.x[i];
        }
        if (Math.abs(rzOld) <= 1e-24) break;
        const beta = rzNew / rzOld;
        for (let i = 0; i < l0.size; i++) {
          if (mask[i]) cgP[i] = l0.x[i] + beta * cgP[i];
        }
        rzOld = rzNew;
      }
    }

    for (let i = 0; i < l0.size; i++) {
      field[i] = mask[i] ? cgX[i] : 0;
    }
  }

  private projectPressureGalerkin(
    dt: number,
    h: number,
    rho: number,
    incremental: boolean,
    maxIter: number,
    relTol: number
  ): void {
    const p0 = this.pressLevels[0];
    const scale = (rho * h) / dt;
    const pMask = this.pMask;

    const cgX = this.cgX;
    const cgR = this.cgR;
    const cgP = this.cgP;
    const cgAp = this.cgAp;
    cgX.fill(0);
    cgR.fill(0);
    cgP.fill(0);
    cgAp.fill(0);

    let divSum = 0;
    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (!pMask[idx]) continue;
        const divH = this.u[idx + 1] - this.u[idx] + this.v[idx + ROW_SIZE] - this.v[idx];
        this.uTmp[idx] = divH / h;
        const rawDiv = -divH * scale;
        cgR[idx] = rawDiv;
        cgX[idx] = incremental ? 0 : this.p[idx];
        divSum += rawDiv;
      }
    }

    const divMean = this.fluidCellCount > 0 ? divSum / this.fluidCellCount : 0;
    for (let i = 0; i < p0.size; i++) {
      if (pMask[i]) cgR[i] -= divMean;
    }

    const diag = p0.diag;
    const cE = p0.cE;
    const cN = p0.cN;

    let r0Sq = 0;
    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (!pMask[idx]) continue;
        const ax =
          diag[idx] * cgX[idx] -
          (cE[idx - 1] * cgX[idx - 1] +
            cE[idx] * cgX[idx + 1] +
            cN[idx - ROW_SIZE] * cgX[idx - ROW_SIZE] +
            cN[idx] * cgX[idx + ROW_SIZE]);
        const rVal = cgR[idx] - ax;
        cgR[idx] = rVal;
        r0Sq += rVal * rVal;
      }
    }

    if (r0Sq > 1e-18) {
      p0.rhs.set(cgR);
      p0.x.fill(0);
      runGalerkinVCycle(this.pressLevels, 0, 1, 2, 10);

      let rzOld = 0;
      for (let i = 0; i < p0.size; i++) {
        if (!pMask[i]) continue;
        const z = p0.x[i];
        cgP[i] = z;
        rzOld += cgR[i] * z;
      }

      for (let iter = 0; iter < maxIter; iter++) {
        let pAp = 0;
        for (let j = 1; j <= GRID_N; j++) {
          let idx = 1 + j * ROW_SIZE;
          for (let i = 1; i <= GRID_N; i++, idx++) {
            if (!pMask[idx]) continue;
            const ap =
              diag[idx] * cgP[idx] -
              (cE[idx - 1] * cgP[idx - 1] +
                cE[idx] * cgP[idx + 1] +
                cN[idx - ROW_SIZE] * cgP[idx - ROW_SIZE] +
                cN[idx] * cgP[idx + ROW_SIZE]);
            cgAp[idx] = ap;
            pAp += cgP[idx] * ap;
          }
        }

        if (pAp <= 1e-22) break;
        const alpha = rzOld / pAp;

        let rSq = 0;
        for (let i = 0; i < p0.size; i++) {
          if (!pMask[i]) continue;
          cgX[i] += alpha * cgP[i];
          const rNext = cgR[i] - alpha * cgAp[i];
          cgR[i] = rNext;
          rSq += rNext * rNext;
        }

        if (rSq <= relTol * r0Sq || rSq <= 1e-18) break;

        p0.rhs.set(cgR);
        p0.x.fill(0);
        runGalerkinVCycle(this.pressLevels, 0, 1, 2, 10);

        let rzNew = 0;
        for (let i = 0; i < p0.size; i++) {
          if (pMask[i]) rzNew += cgR[i] * p0.x[i];
        }
        if (Math.abs(rzOld) <= 1e-24) break;
        const beta = rzNew / rzOld;
        for (let i = 0; i < p0.size; i++) {
          if (pMask[i]) cgP[i] = p0.x[i] + beta * cgP[i];
        }
        rzOld = rzNew;
      }
    }

    let pSum = 0;
    for (let i = 0; i < p0.size; i++) {
      if (pMask[i]) {
        const rotTerm = incremental ? this.muApp[i] * this.uTmp[i] : 0;
        const nextP = incremental ? this.p[i] + cgX[i] - rotTerm : cgX[i];
        this.p[i] = nextP;
        pSum += nextP;
      } else {
        this.p[i] = 0;
      }
    }
    const pMean = this.fluidCellCount > 0 ? pSum / this.fluidCellCount : 0;
    for (let i = 0; i < p0.size; i++) {
      if (pMask[i]) this.p[i] -= pMean;
    }

    const invScale = dt / (rho * h);
    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (this.uMask[idx]) {
          this.u[idx] -= invScale * (cgX[idx] - cgX[idx - 1]);
        } else {
          this.u[idx] = 0;
        }
        if (this.vMask[idx]) {
          this.v[idx] -= invScale * (cgX[idx] - cgX[idx - ROW_SIZE]);
        } else {
          this.v[idx] = 0;
        }
      }
    }
  }

  private sampleCellScalar(src: Float32Array, gx: number, gy: number): [number, number, number] {
    let x = gx;
    let y = gy;
    const dx = x - this.midGrid;
    const dy = y - this.midGrid;
    const maxR = this.tankRadiusGrid - 0.5;
    const distSq = dx * dx + dy * dy;
    if (distSq > maxR * maxR) {
      const scale = maxR / Math.sqrt(distSq);
      x = this.midGrid + dx * scale;
      y = this.midGrid + dy * scale;
    }
    if (x < 1) x = 1;
    if (x > GRID_N - 0.001) x = GRID_N - 0.001;
    if (y < 1) y = 1;
    if (y > GRID_N - 0.001) y = GRID_N - 0.001;

    const i0 = x | 0;
    const j0 = y | 0;
    const sx = x - i0;
    const sy = y - j0;

    const idx00 = i0 + j0 * ROW_SIZE;
    const idx10 = idx00 + 1;
    const idx01 = idx00 + ROW_SIZE;
    const idx11 = idx01 + 1;

    const centerVal = src[Math.round(y) + Math.round(x) * ROW_SIZE];
    const q00 = this.pMask[idx00] ? src[idx00] : centerVal;
    const q10 = this.pMask[idx10] ? src[idx10] : centerVal;
    const q01 = this.pMask[idx01] ? src[idx01] : centerVal;
    const q11 = this.pMask[idx11] ? src[idx11] : centerVal;

    const minV = Math.min(q00, q10, q01, q11);
    const maxV = Math.max(q00, q10, q01, q11);
    const val = (1 - sx) * ((1 - sy) * q00 + sy * q01) + sx * ((1 - sy) * q10 + sy * q11);
    return [val, minV, maxV];
  }

  private advectScalarMacCormack(
    field: Float32Array,
    fwdBuf: Float32Array,
    bwdBuf: Float32Array,
    tmpBuf: Float32Array,
    dt: number,
    h: number
  ): void {
    const dtOverH = dt / h;

    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (!this.pMask[idx]) {
          fwdBuf[idx] = 0;
          continue;
        }
        const vx = 0.5 * (this.u[idx] + this.u[idx + 1]);
        const vy = 0.5 * (this.v[idx] + this.v[idx + ROW_SIZE]);
        const [val] = this.sampleCellScalar(field, i - dtOverH * vx, j - dtOverH * vy);
        fwdBuf[idx] = val;
      }
    }

    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (!this.pMask[idx]) {
          bwdBuf[idx] = 0;
          continue;
        }
        const vx = 0.5 * (this.u[idx] + this.u[idx + 1]);
        const vy = 0.5 * (this.v[idx] + this.v[idx + ROW_SIZE]);
        const [val] = this.sampleCellScalar(fwdBuf, i + dtOverH * vx, j + dtOverH * vy);
        bwdBuf[idx] = val;
      }
    }

    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (!this.pMask[idx]) {
          tmpBuf[idx] = 0;
          continue;
        }
        const vx = 0.5 * (this.u[idx] + this.u[idx + 1]);
        const vy = 0.5 * (this.v[idx] + this.v[idx + ROW_SIZE]);
        const [fwd, minV, maxV] = this.sampleCellScalar(field, i - dtOverH * vx, j - dtOverH * vy);
        const corr = fwd + 0.5 * (field[idx] - bwdBuf[idx]);
        const clamped = corr < minV ? minV : corr > maxV ? maxV : corr;
        tmpBuf[idx] = clamped < 0 ? 0 : clamped > 1 ? 1 : clamped;
      }
    }

    field.set(tmpBuf);
  }

  private computeDyeVariance(): number {
    let sum = 0;
    let sumSq = 0;
    const count = this.fluidCellCount || 1;
    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (!this.pMask[idx]) continue;
        const c = this.dye[idx];
        sum += c;
        sumSq += c * c;
      }
    }
    const mean = sum / count;
    return Math.max(0, sumSq / count - mean * mean);
  }

  private extrapolateRim(field: Float32Array): void {
    const targets = this.rimTargetIndices;
    const sources = this.rimSourceIndices;
    for (let k = 0; k < targets.length; k++) {
      field[targets[k]] = field[sources[k]];
    }
  }

  private updateScalesAndPrepareFields(mode: VisualizationMode): void {
    if (mode === 'fluid') {
      this.scalarA.set(this.wake);
      for (let j = 1; j <= GRID_N; j++) {
        let idx = 1 + j * ROW_SIZE;
        for (let i = 1; i <= GRID_N; i++, idx++) {
          if (!this.pMask[idx]) continue;
          const s = this.speedField[idx] * 0.55;
          this.scalarB[idx] = s > 1 ? 1 : s;
        }
      }
      this.extrapolateRim(this.scalarA);
      this.extrapolateRim(this.scalarB);
      return;
    }

    if (mode === 'velocity') {
      let instMax = 0;
      for (let j = 1; j <= GRID_N; j++) {
        let idx = 1 + j * ROW_SIZE;
        for (let i = 1; i <= GRID_N; i++, idx++) {
          if (this.pMask[idx] && this.speedField[idx] > instMax) instMax = this.speedField[idx];
        }
      }
      this.emaMaxSpeed = this.emaMaxSpeed * 0.92 + Math.max(0.15, instMax) * 0.08;
      const invMax = 1 / this.emaMaxSpeed;
      for (let j = 1; j <= GRID_N; j++) {
        let idx = 1 + j * ROW_SIZE;
        for (let i = 1; i <= GRID_N; i++, idx++) {
          if (!this.pMask[idx]) continue;
          const v = this.speedField[idx] * invMax;
          this.scalarA[idx] = v > 1 ? 1 : v;
        }
      }
    } else if (mode === 'vorticity') {
      let instMax = 0;
      for (let j = 1; j <= GRID_N; j++) {
        let idx = 1 + j * ROW_SIZE;
        for (let i = 1; i <= GRID_N; i++, idx++) {
          if (this.pMask[idx] && this.absVort[idx] > instMax) instMax = this.absVort[idx];
        }
      }
      this.emaMaxVort = this.emaMaxVort * 0.92 + Math.max(8, instMax) * 0.08;
      const inv2Max = 0.5 / this.emaMaxVort;
      for (let j = 1; j <= GRID_N; j++) {
        let idx = 1 + j * ROW_SIZE;
        for (let i = 1; i <= GRID_N; i++, idx++) {
          if (!this.pMask[idx]) continue;
          const v = 0.5 + this.vorticity[idx] * inv2Max;
          this.scalarA[idx] = v < 0 ? 0 : v > 1 ? 1 : v;
        }
      }
    } else {
      let instMax = 0;
      for (let j = 1; j <= GRID_N; j++) {
        let idx = 1 + j * ROW_SIZE;
        for (let i = 1; i <= GRID_N; i++, idx++) {
          if (this.pMask[idx] && this.shearStress[idx] > instMax) instMax = this.shearStress[idx];
        }
      }
      this.emaMaxShear = this.emaMaxShear * 0.92 + Math.max(0.5, instMax) * 0.08;
      const invMax = 1 / this.emaMaxShear;
      for (let j = 1; j <= GRID_N; j++) {
        let idx = 1 + j * ROW_SIZE;
        for (let i = 1; i <= GRID_N; i++, idx++) {
          if (!this.pMask[idx]) continue;
          const v = this.shearStress[idx] * invMax;
          this.scalarA[idx] = v > 1 ? 1 : v;
        }
      }
    }

    this.extrapolateRim(this.scalarA);
  }

  public renderFluidLayer(
    glCanvas: HTMLCanvasElement,
    width: number,
    height: number,
    mode: VisualizationMode,
    colorHex: string
  ): ScaleRange {
    this.updateScalesAndPrepareFields(mode);
    const [tr, tg, tb] = parseHexColor(colorHex);

    if (this.glRenderer) {
      const r = this.glRenderer;
      const gl = r.gl;

      if (glCanvas.width !== width || glCanvas.height !== height) {
        glCanvas.width = width;
        glCanvas.height = height;
      }
      gl.viewport(0, 0, width, height);

      const bytes = this.glFieldBytes;
      const a = this.scalarA;
      const b = this.scalarB;
      const isFluid = mode === 'fluid';

      for (let j = 1; j <= GRID_N; j++) {
        let idx = 1 + j * ROW_SIZE;
        let out = (j - 1) * GRID_N * 4;
        for (let i = 1; i <= GRID_N; i++, idx++, out += 4) {
          bytes[out] = (a[idx] * 255 + 0.5) | 0;
          bytes[out + 1] = isFluid ? (b[idx] * 255 + 0.5) | 0 : 0;
          bytes[out + 2] = 0;
          bytes[out + 3] = 255;
        }
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, r.fieldTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        GRID_N,
        GRID_N,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        bytes
      );

      gl.activeTexture(gl.TEXTURE1);
      if (mode === 'velocity') gl.bindTexture(gl.TEXTURE_2D, r.lutTexVel);
      else if (mode === 'vorticity') gl.bindTexture(gl.TEXTURE_2D, r.lutTexVort);
      else if (mode === 'shear') gl.bindTexture(gl.TEXTURE_2D, r.lutTexShear);
      else gl.bindTexture(gl.TEXTURE_2D, r.lutTexVel);

      gl.uniform1i(r.uLutTexLoc, 1);
      gl.uniform1i(
        r.uModeLoc,
        mode === 'fluid' ? 0 : mode === 'velocity' ? 1 : mode === 'vorticity' ? 2 : 3
      );
      gl.uniform3f(r.uFluidColorLoc, tr / 255, tg / 255, tb / 255);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else {
      this.ensureFallback2D();
      const ctx = glCanvas.getContext('2d', { alpha: false });
      if (ctx && this.fallbackCanvas && this.fallbackCtx && this.fallbackImageData && this.fallbackBuf32) {
        if (glCanvas.width !== width || glCanvas.height !== height) {
          glCanvas.width = width;
          glCanvas.height = height;
        }
        const bgPixel = packRGBA(7, 9, 14, 255);
        const lut =
          mode === 'velocity'
            ? VELOCITY_LUT
            : mode === 'vorticity'
            ? VORTICITY_LUT
            : mode === 'shear'
            ? SHEAR_LUT
            : null;

        for (let j = 1; j <= GRID_N; j++) {
          let idx = 1 + j * ROW_SIZE;
          let pIdx = (j - 1) * GRID_N;
          for (let i = 1; i <= GRID_N; i++, idx++, pIdx++) {
            if (!this.pMask[idx]) {
              this.fallbackBuf32[pIdx] = bgPixel;
              continue;
            }
            if (lut) {
              const li = Math.min(255, Math.max(0, (this.scalarA[idx] * 255 + 0.5) | 0));
              this.fallbackBuf32[pIdx] = lut[li];
            } else {
              const shade = 1 - this.scalarA[idx] * 0.22;
              const sheen = this.scalarB[idx] * 26;
              this.fallbackBuf32[pIdx] = packRGBA(
                tr * shade + sheen,
                tg * shade + sheen,
                tb * shade + sheen,
                255
              );
            }
          }
        }
        this.fallbackCtx.putImageData(this.fallbackImageData, 0, 0);
        ctx.fillStyle = '#07090e';
        ctx.fillRect(0, 0, width, height);
        ctx.save();
        ctx.beginPath();
        ctx.arc(width * 0.5, height * 0.5, width * 0.45, 0, Math.PI * 2);
        ctx.clip();
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(this.fallbackCanvas, 0, 0, width, height);
        ctx.restore();
      }
    }

    return this.getActiveScaleRange(mode);
  }

  public getActiveScaleRange(mode: VisualizationMode): ScaleRange {
    if (mode === 'velocity') {
      return {
        min: 0,
        mid: this.emaMaxSpeed * 0.5,
        max: this.emaMaxSpeed,
        unit: 'm/s',
        label: 'Modulo Velocità |u|',
      };
    }
    if (mode === 'vorticity') {
      return {
        min: -this.emaMaxVort,
        mid: 0,
        max: this.emaMaxVort,
        unit: 's⁻¹',
        label: 'Vorticità ω',
      };
    }
    if (mode === 'shear') {
      return {
        min: 0,
        mid: this.emaMaxShear * 0.5,
        max: this.emaMaxShear,
        unit: 'Pa',
        label: 'Sforzo di Taglio τ',
      };
    }
    return {
      min: 0,
      mid: 50,
      max: 100,
      unit: '',
      label: 'Moto del Fluido',
    };
  }

  public drawVectorOverlay(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const step = 6;
    const scaleX = width / GRID_N;
    const scaleY = height / GRID_N;
    const maxLen = step * scaleX * 0.78;
    const refSpeed = Math.max(0.2, this.emaMaxSpeed);

    ctx.strokeStyle = 'rgba(226, 232, 240, 0.72)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();

    for (let j = 3; j <= GRID_N - 2; j += step) {
      for (let i = 3; i <= GRID_N - 2; i += step) {
        const idx = i + j * ROW_SIZE;
        if (!this.pMask[idx]) continue;

        const uc = 0.5 * (this.u[idx] + this.u[idx + 1]);
        const vc = 0.5 * (this.v[idx] + this.v[idx + ROW_SIZE]);
        const sp = Math.hypot(uc, vc);
        if (sp < 0.005) continue;

        const len = Math.min(maxLen, (sp / refSpeed) * maxLen);
        const ux = uc / sp;
        const uy = vc / sp;
        const cx = (i - 0.5) * scaleX;
        const cy = (j - 0.5) * scaleY;
        const ex = cx + ux * len;
        const ey = cy + uy * len;

        ctx.moveTo(cx, cy);
        ctx.lineTo(ex, ey);

        const head = Math.max(2.5, len * 0.28);
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - head * (ux * 0.8 + uy * 0.5), ey - head * (uy * 0.8 - ux * 0.5));
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - head * (ux * 0.8 - uy * 0.5), ey - head * (uy * 0.8 + ux * 0.5));
      }
    }

    ctx.stroke();
  }

  public sampleProbe(xNorm: number, yNorm: number, config: FluidConfig): ProbeSample {
    const i = Math.round(xNorm * GRID_N + 0.5);
    const j = Math.round(yNorm * GRID_N + 0.5);
    if (i < 1 || i > GRID_N || j < 1 || j > GRID_N) {
      return {
        active: false,
        rMm: 0,
        xMm: 0,
        yMm: 0,
        speedMs: 0,
        shearRate: 0,
        shearStressPa: 0,
        apparentViscosityMpas: config.viscosityMpas,
        vorticity: 0,
      };
    }

    const idx = i + j * ROW_SIZE;
    if (!this.pMask[idx]) {
      return {
        active: false,
        rMm: 0,
        xMm: 0,
        yMm: 0,
        speedMs: 0,
        shearRate: 0,
        shearStressPa: 0,
        apparentViscosityMpas: config.viscosityMpas,
        vorticity: 0,
      };
    }

    const hMm = this.getCellSizeMeters(config) * 1000;
    const xMm = (i - this.midGrid) * hMm;
    const yMm = (this.midGrid - j) * hMm;
    const rMm = Math.hypot(xMm, yMm);

    return {
      active: true,
      rMm,
      xMm,
      yMm,
      speedMs: this.speedField[idx],
      shearRate: this.shearRate[idx],
      shearStressPa: this.shearStress[idx],
      apparentViscosityMpas: this.muApp[idx] * 1000,
      vorticity: this.vorticity[idx],
    };
  }

  public getMetrics(config: FluidConfig, scaleRange: ScaleRange): SimulationMetrics {
    const count = this.fluidCellCount || 1;

    let maxSpeed = 0;
    let sumShear = 0;
    let maxShearRate = 0;
    let maxShearStress = 0;
    let sumMu = 0;
    let sumSpeedSq = 0;

    for (let j = 1; j <= GRID_N; j++) {
      let idx = 1 + j * ROW_SIZE;
      for (let i = 1; i <= GRID_N; i++, idx++) {
        if (!this.pMask[idx]) continue;
        const sp = this.speedField[idx];
        if (sp > maxSpeed) maxSpeed = sp;

        sumSpeedSq += sp * sp;
        sumShear += this.shearRate[idx];
        if (this.shearRate[idx] > maxShearRate) maxShearRate = this.shearRate[idx];
        if (this.shearStress[idx] > maxShearStress) maxShearStress = this.shearStress[idx];
        sumMu += this.muApp[idx];
      }
    }

    const meanShearRate = sumShear / count;
    const effMuPaS = sumMu / count;
    const charLengthM = Math.max(0.005, config.stirrerDiameterMm * 0.001);
    const charVelMs = Math.max(0.01, maxSpeed);
    const reynolds = (config.densityKgM3 * charVelMs * charLengthM) / Math.max(1e-6, effMuPaS);

    let regime: SimulationMetrics['regime'] = 'Laminare';
    if (reynolds < 1) {
      regime = 'Stokes / Creeping';
    } else if (reynolds < 2300) {
      regime = 'Laminare';
    } else if (reynolds < 4000) {
      regime = 'Transizione';
    } else {
      regime = 'Turbolento';
    }

    const variance = this.computeDyeVariance();
    const intensityOfSegregation = Math.min(1, variance / Math.max(1e-5, this.refVariance));
    const mixingIndex = Math.max(0, Math.min(100, (1 - Math.sqrt(intensityOfSegregation)) * 100));
    const kineticEnergyMjKg = 0.5 * (sumSpeedSq / count) * 1000;

    return {
      elapsedSec: this.elapsedSec,
      reynolds,
      regime,
      maxSpeedMs: maxSpeed,
      meanShearRate,
      maxShearRate,
      maxShearStressPa: maxShearStress,
      effectiveViscosityMpas: effMuPaS * 1000,
      mixingIndex,
      kineticEnergyMjKg,
      scaleRange,
    };
  }
}
