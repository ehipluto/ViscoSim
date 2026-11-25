import { VisualizationMode } from '../types/rheology';

export type ColorStop = readonly [number, number, number, number];

/**
 * Palette percettivamente uniformi e accessibili ai daltonici (deuteranopia, protanopia, tritanopia).
 * Sorgente unica condivisa tra texture LUT WebGL1, fallback Canvas 2D e legende CSS.
 */
export const VELOCITY_STOPS: readonly ColorStop[] = [
  [0.0, 11, 16, 32],
  [0.25, 33, 82, 118],
  [0.5, 42, 138, 128],
  [0.75, 134, 194, 88],
  [1.0, 253, 231, 37],
];

export const VORTICITY_STOPS: readonly ColorStop[] = [
  [0.0, 56, 152, 236],
  [0.25, 30, 80, 148],
  [0.5, 22, 28, 42],
  [0.75, 194, 92, 26],
  [1.0, 251, 158, 60],
];

export const SHEAR_STOPS: readonly ColorStop[] = [
  [0.0, 13, 12, 29],
  [0.25, 87, 16, 110],
  [0.55, 188, 55, 84],
  [0.8, 249, 142, 9],
  [1.0, 252, 255, 164],
];

const IS_LITTLE_ENDIAN = (() => {
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = 0x01020304;
  return new Uint8Array(buf)[0] === 0x04;
})();

export function packRGBA(r: number, g: number, b: number, a = 255): number {
  const ri = r < 0 ? 0 : r > 255 ? 255 : r | 0;
  const gi = g < 0 ? 0 : g > 255 ? 255 : g | 0;
  const bi = b < 0 ? 0 : b > 255 ? 255 : b | 0;
  const ai = a < 0 ? 0 : a > 255 ? 255 : a | 0;
  if (IS_LITTLE_ENDIAN) {
    return ((ai << 24) | (bi << 16) | (gi << 8) | ri) >>> 0;
  }
  return ((ri << 24) | (gi << 16) | (bi << 8) | ai) >>> 0;
}

export function buildGradientLUTBytes(stops: readonly ColorStop[]): Uint8Array {
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

export function bytesToPacked32(bytes: Uint8Array): Uint32Array {
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const off = i * 4;
    lut[i] = packRGBA(bytes[off], bytes[off + 1], bytes[off + 2], 255);
  }
  return lut;
}

export const VELOCITY_BYTES = buildGradientLUTBytes(VELOCITY_STOPS);
export const VORTICITY_BYTES = buildGradientLUTBytes(VORTICITY_STOPS);
export const SHEAR_BYTES = buildGradientLUTBytes(SHEAR_STOPS);

export const VELOCITY_LUT = bytesToPacked32(VELOCITY_BYTES);
export const VORTICITY_LUT = bytesToPacked32(VORTICITY_BYTES);
export const SHEAR_LUT = bytesToPacked32(SHEAR_BYTES);

function stopsToCssGradient(stops: readonly ColorStop[]): string {
  const parts = stops.map(
    ([pos, r, g, b]) => `rgb(${r}, ${g}, ${b}) ${(pos * 100).toFixed(0)}%`
  );
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

export function getLegendGradient(mode: VisualizationMode): string {
  if (mode === 'velocity') return stopsToCssGradient(VELOCITY_STOPS);
  if (mode === 'vorticity') return stopsToCssGradient(VORTICITY_STOPS);
  return stopsToCssGradient(SHEAR_STOPS);
}
