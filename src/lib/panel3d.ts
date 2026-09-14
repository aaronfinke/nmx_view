/**
 * Lab-frame placement of a detector panel, for the 3D instrument view.
 *
 * The three file families we read describe geometry three different ways, so
 * everything is normalised to this one struct before it reaches the renderer:
 *
 * - NXlauetof      — explicit `origin` / `fast_axis` / `slow_axis` datasets
 * - NeXus standard — a `depends_on` chain of NXtransformations (NMX)
 * - Mantid IDF     — `<location>` plus nested `<rot>` elements (MANDI, SNS)
 *
 * All three place the panel by its **centre**, which is also how
 * `dspacing.ts` already interprets `origin`.
 *
 * Plain arrays, no three.js: this runs in the worker.
 */
import type { File as H5File, Dataset as H5Dataset } from "h5wasm";
import type { PanelGeometry } from "./dspacing";
import type { IdfPanelGeometry } from "./h5wasm-loader";

export type Vec3 = [number, number, number];
/** Row-major 3×3. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export interface Panel3D {
  name: string;
  /** Panel centre in the lab frame (metres) */
  center: Vec3;
  /** Unit vector along increasing column (fast axis) */
  fastAxis: Vec3;
  /** Unit vector along increasing row (slow axis) */
  slowAxis: Vec3;
  /** Extent along fast/slow in metres */
  width: number;
  height: number;
  nRows: number;
  nCols: number;
}

// ── small vector / matrix helpers ────────────────────────────

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function matMul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[r * 3 + k] * b[k * 3 + c];
      out[r * 3 + c] = s;
    }
  }
  return out;
}

export function matApply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n === 0 ? [0, 0, 0] : [v[0] / n, v[1] / n, v[2] / n];
}

/** Right-handed rotation of `deg` about `axis` (Rodrigues). */
export function rotationMatrix(axis: Vec3, deg: number): Mat3 {
  const [x, y, z] = normalize(axis);
  if (x === 0 && y === 0 && z === 0) return [...IDENTITY] as Mat3;
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const k = 1 - c;
  return [
    c + x * x * k,     x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k,     y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ];
}

// ── NXlauetof: explicit axes ─────────────────────────────────

export function panel3dFromPanelGeometry(name: string, g: PanelGeometry): Panel3D {
  return {
    name,
    center: [...g.origin] as Vec3,
    fastAxis: normalize(g.fastAxis as Vec3),
    slowAxis: normalize(g.slowAxis as Vec3),
    width: g.nCols * g.xPixelSize,
    height: g.nRows * g.yPixelSize,
    nRows: g.nRows,
    nCols: g.nCols,
  };
}

// ── Mantid IDF: <location> + nested <rot> ────────────────────

/**
 * Nested `<rot>` elements compose outermost-first, and an element with no
 * `axis-*` attributes rotates about z. Determined empirically against MANDI:
 * this ordering points all 40 banks at the sample (normal·(-r̂) ≥ 0.999),
 * the reverse does not (min −0.66).
 */
export function idfRotationMatrix(rotations: { axis: Vec3; deg: number }[]): Mat3 {
  let m: Mat3 = [...IDENTITY] as Mat3;
  for (const r of rotations) m = matMul(m, rotationMatrix(r.axis, r.deg));
  return m;
}

export function panel3dFromIdf(name: string, g: IdfPanelGeometry): Panel3D | null {
  if (!g.position || !g.rotations) return null;
  const m = idfRotationMatrix(g.rotations);
  return {
    name,
    center: [...g.position] as Vec3,
    // The rectangular_detector lies in its local xy-plane: x is fast, y is slow.
    fastAxis: normalize(matApply(m, [1, 0, 0])),
    slowAxis: normalize(matApply(m, [0, 1, 0])),
    width: g.nx * (g.xStep ?? 0),
    height: g.ny * (g.yStep ?? 0),
    nRows: g.ny,
    nCols: g.nx,
  };
}

// ── NeXus standard: depends_on → NXtransformations ───────────

function attrString(ds: H5Dataset, key: string): string | null {
  const a = ds.attrs?.[key];
  if (!a) return null;
  const v = a.value;
  if (typeof v === "string") return v.trim();
  if (v instanceof Uint8Array) return new TextDecoder().decode(v).trim();
  if (Array.isArray(v) && typeof v[0] === "string") return String(v[0]).trim();
  return String(v ?? "").trim();
}

function attrNumbers(ds: H5Dataset, key: string): number[] | null {
  const a = ds.attrs?.[key];
  if (!a) return null;
  const v = a.value;
  if (typeof v === "number") return [v];
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>, Number);
  if (Array.isArray(v)) return v.map(Number);
  return null;
}

function scalar(ds: H5Dataset): number {
  const v = ds.value;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (ArrayBuffer.isView(v)) return Number((v as unknown as ArrayLike<number>)[0]);
  if (Array.isArray(v)) return Number(v[0]);
  return Number(v ?? 0);
}

/** Multiplier converting a length in `unit` to metres. */
function lengthToM(unit: string | null): number {
  switch ((unit ?? "m").toLowerCase()) {
    case "mm": case "millimetre": case "millimeter": return 1e-3;
    case "cm": case "centimetre": case "centimeter": return 1e-2;
    case "um": case "µm": return 1e-6;
    default: return 1;
  }
}

/** Multiplier converting an angle in `unit` to degrees. */
function angleToDeg(unit: string | null): number {
  const u = (unit ?? "degrees").toLowerCase();
  if (u === "rad" || u === "radian" || u === "radians") return 180 / Math.PI;
  return 1;
}

/** h5wasm paths have no leading slash. */
function normalizePath(p: string): string {
  return p.replace(/^\/+/, "");
}

interface ResolvedTransform {
  rotation: Mat3;
  translation: Vec3;
}

/**
 * Walk a `depends_on` chain and compose it into a single rotation+translation.
 *
 * NeXus applies the chain starting at the component's own `depends_on` and
 * following each transformation's `depends_on` outward to ".", so a point in
 * the local frame is acted on by the first link first. Each link is
 * `T(offset) · (rotation | translation)`.
 */
export function resolveDependsOn(
  h5file: H5File,
  startPath: string,
  maxLinks = 32
): ResolvedTransform {
  let rotation: Mat3 = [...IDENTITY] as Mat3;
  let translation: Vec3 = [0, 0, 0];

  let path: string | null = normalizePath(startPath);
  const seen = new Set<string>();

  for (let i = 0; i < maxLinks && path && path !== "." && !seen.has(path); i++) {
    seen.add(path);
    const ds = h5file.get(path) as H5Dataset | null;
    if (!ds) break;

    const type = (attrString(ds, "transformation_type") ?? "").toLowerCase();
    const vec = (attrNumbers(ds, "vector") ?? [0, 0, 1]) as Vec3;
    const offset = (attrNumbers(ds, "offset") ?? [0, 0, 0]) as Vec3;
    const offScale = lengthToM(attrString(ds, "offset_units"));
    const value = scalar(ds);

    let linkRot: Mat3 = [...IDENTITY] as Mat3;
    let linkTrans: Vec3 = [0, 0, 0];
    if (type === "rotation") {
      linkRot = rotationMatrix(vec, value * angleToDeg(attrString(ds, "units")));
    } else if (type === "translation") {
      const d = value * lengthToM(attrString(ds, "units"));
      const u = normalize(vec);
      linkTrans = [u[0] * d, u[1] * d, u[2] * d];
    }
    // `offset` is a fixed translation applied with this link.
    linkTrans = [
      linkTrans[0] + offset[0] * offScale,
      linkTrans[1] + offset[1] * offScale,
      linkTrans[2] + offset[2] * offScale,
    ];

    // Pre-multiply: later links in the chain act on the result of earlier ones.
    translation = [
      linkTrans[0] + matApply(linkRot, translation)[0],
      linkTrans[1] + matApply(linkRot, translation)[1],
      linkTrans[2] + matApply(linkRot, translation)[2],
    ];
    rotation = matMul(linkRot, rotation);

    path = attrString(ds, "depends_on");
    if (path) path = normalizePath(path);
  }

  return { rotation, translation };
}

/** Midpoint and pitch of a pixel-offset axis. */
function offsetStats(arr: ArrayLike<number>): { mid: number; extent: number } {
  const n = arr.length;
  if (n === 0) return { mid: 0, extent: 0 };
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const pitch = n > 1 ? (hi - lo) / (n - 1) : 0;
  return { mid: (lo + hi) / 2, extent: n * pitch };
}

function readNumericArray(ds: H5Dataset | null): Float64Array | null {
  if (!ds) return null;
  const v = ds.value;
  if (ArrayBuffer.isView(v)) {
    const a = v as unknown as ArrayLike<number>;
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = Number(a[i]);
    return out;
  }
  if (Array.isArray(v)) return Float64Array.from(v.map(Number));
  return null;
}

/**
 * Build a Panel3D from the NeXus standard encoding: a `depends_on` chain for
 * placement plus `x/y_pixel_offset` for the pixel grid in the local frame.
 */
export function panel3dFromNexus(
  h5file: H5File,
  panelPath: string,
  name: string,
  fallbackShape: [number, number]
): Panel3D | null {
  const depDs = h5file.get(`${panelPath}/depends_on`) as H5Dataset | null;
  if (!depDs) return null;
  const startPath = attrString(depDs, "__value__") ?? (() => {
    const v = depDs.value;
    if (typeof v === "string") return v.trim();
    if (v instanceof Uint8Array) return new TextDecoder().decode(v).trim();
    if (Array.isArray(v) && typeof v[0] === "string") return String(v[0]).trim();
    return String(v ?? "").trim();
  })();
  if (!startPath || startPath === ".") return null;

  const { rotation, translation } = resolveDependsOn(h5file, startPath);

  const xs = readNumericArray(h5file.get(`${panelPath}/x_pixel_offset`) as H5Dataset | null);
  const ys = readNumericArray(h5file.get(`${panelPath}/y_pixel_offset`) as H5Dataset | null);
  const sx = xs ? offsetStats(xs) : { mid: 0, extent: 0 };
  const sy = ys ? offsetStats(ys) : { mid: 0, extent: 0 };

  const nCols = xs?.length ?? fallbackShape[1];
  const nRows = ys?.length ?? fallbackShape[0];

  // Local pixel-grid centre, carried into the lab frame.
  const localCentre: Vec3 = [sx.mid, sy.mid, 0];
  const rc = matApply(rotation, localCentre);

  return {
    name,
    center: [translation[0] + rc[0], translation[1] + rc[1], translation[2] + rc[2]],
    fastAxis: normalize(matApply(rotation, [1, 0, 0])),
    slowAxis: normalize(matApply(rotation, [0, 1, 0])),
    width: sx.extent,
    height: sy.extent,
    nRows,
    nCols,
  };
}

// ── dispatch ─────────────────────────────────────────────────

/**
 * Build the lab-frame layout for every panel in the open file, picking whichever
 * encoding the file actually carries.
 *
 * Event panels are tried as NeXus-standard first (`depends_on`), then as Mantid
 * IDF; SNS files have only the IDF, ESS files only the transformation chain.
 * Panels whose geometry cannot be resolved are omitted rather than guessed at —
 * a wrong position in a 3D view is worse than a missing one.
 */
export function buildPanels3D(
  h5file: H5File,
  eventPanels: { path: string; name: string; detectorShape: [number, number] }[],
  lauetofPanels: { name: string; geometry: PanelGeometry | null }[],
  idf: Map<string, IdfPanelGeometry>
): Panel3D[] {
  const out: Panel3D[] = [];

  for (const p of lauetofPanels) {
    if (p.geometry) out.push(panel3dFromPanelGeometry(p.name, p.geometry));
  }

  for (const p of eventPanels) {
    const viaNexus = panel3dFromNexus(h5file, p.path, p.name, p.detectorShape);
    if (viaNexus && viaNexus.width > 0 && viaNexus.height > 0) {
      out.push(viaNexus);
      continue;
    }
    const g = idf.get(p.name);
    if (g) {
      const viaIdf = panel3dFromIdf(p.name, g);
      if (viaIdf && viaIdf.width > 0 && viaIdf.height > 0) out.push(viaIdf);
    }
  }

  return out;
}
