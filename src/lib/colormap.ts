/**
 * Colour lookup tables and value→RGB mapping, shared by everything that paints
 * detector counts without WebGL shading: the Canvas2D overview thumbnails, the
 * sidebar colour bar, and the 3D view's panel textures.
 *
 * `Greys_r` is a real reversed LUT here. The h5web/WebGL path cannot do that —
 * it fakes it with `filter: invert(1)` — so anything using these tables must
 * stay outside the `[data-invert]` CSS rule or it will double-invert.
 */
import { ScaleType } from "@h5web/lib";
import type { ColorScaleType } from "@h5web/lib";

function lerpColor(
  a: number[],
  b: number[],
  t: number,
): [number, number, number] {
  return [
    Math.round(a[0] * (1 - t) + b[0] * t),
    Math.round(a[1] * (1 - t) + b[1] * t),
    Math.round(a[2] * (1 - t) + b[2] * t),
  ];
}

function buildLut(data: number[][]): [number, number, number][] {
  const lut: [number, number, number][] = [];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const idx = t * (data.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, data.length - 1);
    const frac = idx - lo;
    const a = data[lo].map((v) => v * 255);
    const b = data[hi].map((v) => v * 255);
    lut.push(lerpColor(a, b, frac));
  }
  return lut;
}

const VIRIDIS_DATA = [
  [0.267004, 0.004874, 0.329415],
  [0.282327, 0.140926, 0.457517],
  [0.253935, 0.265254, 0.529983],
  [0.206756, 0.371758, 0.553117],
  [0.163625, 0.471133, 0.558148],
  [0.127568, 0.566949, 0.550556],
  [0.134692, 0.658636, 0.517649],
  [0.266941, 0.748751, 0.440573],
  [0.477504, 0.821444, 0.318195],
  [0.741388, 0.873449, 0.149561],
  [0.993248, 0.906157, 0.143936],
];

const INFERNO_DATA = [
  [0.001462, 0.000466, 0.013866],
  [0.087411, 0.044556, 0.224944],
  [0.258234, 0.038571, 0.406485],
  [0.416331, 0.090937, 0.433109],
  [0.578304, 0.148039, 0.404411],
  [0.735683, 0.215906, 0.330245],
  [0.865006, 0.316782, 0.226055],
  [0.955454, 0.454109, 0.113072],
  [0.995131, 0.618590, 0.034631],
  [0.987622, 0.790524, 0.170931],
  [0.988362, 0.998364, 0.644924],
];

const GREYS_DATA = [
  [0.0, 0.0, 0.0],
  [1.0, 1.0, 1.0],
];

const GREYS_R_DATA = [
  [1.0, 1.0, 1.0],
  [0.0, 0.0, 0.0],
];

/** 256-entry RGB lookup tables, shared with the Canvas2D overview thumbnails. */
export const LUTS: Record<string, [number, number, number][]> = {
  Viridis: buildLut(VIRIDIS_DATA),
  Inferno: buildLut(INFERNO_DATA),
  Greys: buildLut(GREYS_DATA),
  Greys_r: buildLut(GREYS_R_DATA),
};


/** Map a value to [0,1] within `domain` under the active colour scale. */
export function normalizeValue(
  v: number,
  lo: number,
  hi: number,
  scale: ColorScaleType
): number {
  if (scale === ScaleType.Log) {
    const sLo = Math.log10(Math.max(lo, 1e-6));
    const sHi = Math.log10(Math.max(hi, 1e-6));
    if (v <= 0 || sHi <= sLo) return 0;
    return (Math.log10(v) - sLo) / (sHi - sLo);
  }
  if (scale === ScaleType.SymLog) {
    const f = (x: number) => Math.sign(x) * Math.log10(1 + Math.abs(x));
    const sLo = f(lo);
    const sHi = f(hi);
    if (sHi <= sLo) return 0;
    return (f(v) - sLo) / (sHi - sLo);
  }
  if (hi <= lo) return 0;
  return (v - lo) / (hi - lo);
}

/**
 * Paint a detector image into an RGBA byte buffer.
 *
 * `flipRows` selects the row order of the destination. Canvas2D draws top-down
 * while h5web puts detector row 0 at the bottom, so the 2D thumbnails flip;
 * a three.js DataTexture already samples bottom-up, so the 3D view does not.
 */
export function imageToRGBA(
  image: Float64Array,
  rows: number,
  cols: number,
  domain: [number, number],
  scale: ColorScaleType,
  colorMap: string,
  flipRows: boolean,
  out?: Uint8ClampedArray
): Uint8ClampedArray {
  const lut = LUTS[colorMap] ?? LUTS["Viridis"];
  const px = out ?? new Uint8ClampedArray(rows * cols * 4);
  const [lo, hi] = domain;

  for (let r = 0; r < rows; r++) {
    const srcRow = flipRows ? rows - 1 - r : r;
    for (let c = 0; c < cols; c++) {
      const t = normalizeValue(image[srcRow * cols + c], lo, hi, scale);
      const idx = Math.max(0, Math.min(255, Math.round(t * 255)));
      const rgb = lut[idx];
      const o = (r * cols + c) * 4;
      px[o] = rgb[0];
      px[o + 1] = rgb[1];
      px[o + 2] = rgb[2];
      px[o + 3] = 255;
    }
  }
  return px;
}
