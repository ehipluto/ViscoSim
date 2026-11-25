import { ScaleRange, VisualizationMode } from '../types/rheology';
import {
  packRGBA,
  SHEAR_BYTES,
  SHEAR_LUT,
  VELOCITY_BYTES,
  VELOCITY_LUT,
  VORTICITY_BYTES,
  VORTICITY_LUT,
} from './colormaps';

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

function parseHexColor(hex: string): [number, number, number] {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return [6, 182, 212];
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

interface GlHandles {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  vs: WebGLShader;
  fs: WebGLShader;
  vbo: WebGLBuffer | null;
  fieldTex: WebGLTexture;
  fieldTexSize: number;
  lutTexVel: WebGLTexture;
  lutTexVort: WebGLTexture;
  lutTexShear: WebGLTexture;
  uTexSizeLoc: WebGLUniformLocation | null;
  uModeLoc: WebGLUniformLocation | null;
  uFluidColorLoc: WebGLUniformLocation | null;
  uLutTexLoc: WebGLUniformLocation | null;
}

export class FluidViewportRenderer {
  private glHandles: GlHandles | null = null;
  private fallbackCanvas: HTMLCanvasElement | null = null;
  private fallbackCtx: CanvasRenderingContext2D | null = null;
  private fallbackImageData: ImageData | null = null;
  private fallbackBuf32: Uint32Array | null = null;
  private fallbackGridN = 0;

  public init(canvas: HTMLCanvasElement, initialGridN = 96): void {
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: true,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      this.ensureFallback2D(initialGridN);
      return;
    }

    const compileShader = (type: number, source: string): WebGLShader | null => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, source);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };

    const vs = compileShader(gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
    const fs = compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      this.ensureFallback2D(initialGridN);
      return;
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      this.ensureFallback2D(initialGridN);
      return;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      this.ensureFallback2D(initialGridN);
      return;
    }

    gl.useProgram(program);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const aPosLoc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(aPosLoc);
    gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

    const createLUTTex = (bytes: Uint8Array): WebGLTexture | null => {
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

    const fieldTex = gl.createTexture();
    const lutTexVel = createLUTTex(VELOCITY_BYTES);
    const lutTexVort = createLUTTex(VORTICITY_BYTES);
    const lutTexShear = createLUTTex(SHEAR_BYTES);

    if (!fieldTex || !lutTexVel || !lutTexVort || !lutTexShear) {
      if (fieldTex) gl.deleteTexture(fieldTex);
      if (lutTexVel) gl.deleteTexture(lutTexVel);
      if (lutTexVort) gl.deleteTexture(lutTexVort);
      if (lutTexShear) gl.deleteTexture(lutTexShear);
      gl.deleteBuffer(vbo);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      this.ensureFallback2D(initialGridN);
      return;
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
      initialGridN,
      initialGridN,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(initialGridN * initialGridN * 4)
    );

    const uFieldTexLoc = gl.getUniformLocation(program, 'u_fieldTex');
    const uLutTexLoc = gl.getUniformLocation(program, 'u_lutTex');
    const uTexSizeLoc = gl.getUniformLocation(program, 'u_texSize');
    const uModeLoc = gl.getUniformLocation(program, 'u_mode');
    const uFluidColorLoc = gl.getUniformLocation(program, 'u_fluidColor');

    gl.uniform1i(uFieldTexLoc, 0);
    gl.uniform1i(uLutTexLoc, 1);
    gl.uniform1f(uTexSizeLoc, initialGridN);

    this.glHandles = {
      gl,
      program,
      vs,
      fs,
      vbo,
      fieldTex,
      fieldTexSize: initialGridN,
      lutTexVel,
      lutTexVort,
      lutTexShear,
      uTexSizeLoc,
      uModeLoc,
      uFluidColorLoc,
      uLutTexLoc,
    };
  }

  private ensureFallback2D(gridN: number): void {
    if (typeof document === 'undefined') return;
    if (!this.fallbackCanvas || this.fallbackGridN !== gridN) {
      const c = document.createElement('canvas');
      c.width = gridN;
      c.height = gridN;
      const ctx = c.getContext('2d');
      if (ctx) {
        const img = ctx.createImageData(gridN, gridN);
        this.fallbackCanvas = c;
        this.fallbackCtx = ctx;
        this.fallbackImageData = img;
        this.fallbackBuf32 = new Uint32Array(img.data.buffer);
        this.fallbackGridN = gridN;
      }
    }
  }

  public renderFluidField(
    canvas: HTMLCanvasElement,
    fieldBytes: Uint8Array,
    gridN: number,
    width: number,
    height: number,
    mode: VisualizationMode,
    colorHex: string
  ): void {
    const [tr, tg, tb] = parseHexColor(colorHex);

    if (this.glHandles) {
      const r = this.glHandles;
      const gl = r.gl;

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, r.fieldTex);
      if (r.fieldTexSize !== gridN) {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gridN,
          gridN,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          fieldBytes
        );
        r.fieldTexSize = gridN;
        gl.uniform1f(r.uTexSizeLoc, gridN);
      } else {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          gridN,
          gridN,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          fieldBytes
        );
      }

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
      return;
    }

    this.ensureFallback2D(gridN);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx || !this.fallbackCanvas || !this.fallbackCtx || !this.fallbackImageData || !this.fallbackBuf32) {
      return;
    }

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const lut =
      mode === 'velocity'
        ? VELOCITY_LUT
        : mode === 'vorticity'
        ? VORTICITY_LUT
        : mode === 'shear'
        ? SHEAR_LUT
        : null;

    const total = gridN * gridN;
    for (let p = 0; p < total; p++) {
      const off = p * 4;
      const aByte = fieldBytes[off];
      const bByte = fieldBytes[off + 1];
      if (lut) {
        this.fallbackBuf32[p] = lut[aByte];
      } else {
        const shade = 1 - (aByte / 255) * 0.22;
        const sheen = (bByte / 255) * 26;
        this.fallbackBuf32[p] = packRGBA(tr * shade + sheen, tg * shade + sheen, tb * shade + sheen, 255);
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

  public drawVectorOverlay(
    ctx: CanvasRenderingContext2D,
    vectors: Float32Array | null,
    vectorCount: number,
    gridN: number,
    width: number,
    height: number,
    scaleRange: ScaleRange
  ): void {
    if (!vectors || vectorCount <= 0) return;
    const step = 6;
    const maxLen = (step / gridN) * width * 0.78;
    const refSpeed = Math.max(0.2, scaleRange.max || 0.25);

    ctx.strokeStyle = 'rgba(226, 232, 240, 0.72)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();

    for (let k = 0; k < vectorCount; k++) {
      const off = k * 4;
      const cx = vectors[off] * width;
      const cy = vectors[off + 1] * height;
      const uc = vectors[off + 2];
      const vc = vectors[off + 3];
      const sp = Math.hypot(uc, vc);
      if (sp < 0.005) continue;

      const len = Math.min(maxLen, (sp / refSpeed) * maxLen);
      const ux = uc / sp;
      const uy = vc / sp;
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

    ctx.stroke();
  }

  public dispose(): void {
    if (this.glHandles) {
      const r = this.glHandles;
      const gl = r.gl;
      gl.deleteTexture(r.fieldTex);
      gl.deleteTexture(r.lutTexVel);
      gl.deleteTexture(r.lutTexVort);
      gl.deleteTexture(r.lutTexShear);
      if (r.vbo) gl.deleteBuffer(r.vbo);
      gl.deleteProgram(r.program);
      gl.deleteShader(r.vs);
      gl.deleteShader(r.fs);
      this.glHandles = null;
    }
    this.fallbackCanvas = null;
    this.fallbackCtx = null;
    this.fallbackImageData = null;
    this.fallbackBuf32 = null;
    this.fallbackGridN = 0;
  }
}
