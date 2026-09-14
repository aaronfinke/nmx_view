import h5wasm, {
  File as H5File,
  Group as H5Group,
  Dataset as H5Dataset,
  FS,
} from "h5wasm";

import type { DetectorImageResult } from "./event-data";
import type { PanelGeometry } from "./dspacing";

// Plugin .so filenames to load for filter support (bitshuffle, lz4, etc.)
const PLUGIN_NAMES = [
  "bshuf", "blosc", "blosc2", "bz2", "jpeg", "lz4", "lzf", "zfp", "zstd",
  "bitgroom", "bitround",
];

let h5wasmReady: Promise<void> | null = null;

export async function initH5Wasm(): Promise<void> {
  if (!h5wasmReady) {
    h5wasmReady = (async () => {
      const module = await h5wasm.ready;
      // Get the plugin search path from h5wasm and ensure directory exists
      const pluginPath = module.get_plugin_search_paths()[0];
      module.FS.mkdirTree(pluginPath);
      // Fetch .so plugin files from our public directory and write into WASM FS
      const base = import.meta.env.BASE_URL || "/";
      const fetches = PLUGIN_NAMES.map(async (name) => {
        const filename = `libH5Z${name}.so`;
        try {
          const resp = await fetch(`${base}h5wasm-plugins/${filename}`);
          if (!resp.ok) {
            console.warn(`Plugin ${filename}: HTTP ${resp.status}`);
            return;
          }
          const buf = await resp.arrayBuffer();
          module.FS.writeFile(`${pluginPath}/${filename}`, new Uint8Array(buf));
        } catch (e) {
          console.warn(`Failed to load plugin ${filename}:`, e);
        }
      });
      await Promise.all(fetches);
      console.log("h5wasm plugins installed:", PLUGIN_NAMES);
    })();
  }
  return h5wasmReady;
}

export async function openFile(file: File): Promise<H5File> {
  await initH5Wasm();
  const buf = await file.arrayBuffer();
  const filename = file.name;
  FS!.writeFile(filename, new Uint8Array(buf));
  return new H5File(filename, "r");
}

const WORKERFS_MOUNT = "/work";
let workerfsMounted = false;

/**
 * Open a file without copying it into memory.
 *
 * `openFile` reads the whole file into an ArrayBuffer and then copies that into
 * the Emscripten heap — two full copies, against a wasm32 address space capped
 * at 4 GB, so anything past ~1.5 GB dies before a single dataset is read.
 * WORKERFS instead backs the mount with the `File` itself and reads only the
 * chunks HDF5 asks for, which for a typical event file skips `event_index`
 * entirely (over half the bytes on disk).
 *
 * Only available inside a Worker: WORKERFS asserts on `ENVIRONMENT_IS_WORKER`
 * because it reads through `FileReaderSync`. Falls back to the copying path
 * elsewhere, so this stays safe to call from anywhere.
 */
export async function openFileLazy(file: File): Promise<H5File> {
  await initH5Wasm();
  const fs = FS as unknown as {
    filesystems: Record<string, unknown>;
    mkdir(path: string): void;
    mount(type: unknown, opts: unknown, mountpoint: string): void;
    unmount(mountpoint: string): void;
  };

  const inWorker = typeof WorkerGlobalScope !== "undefined"
    && typeof (globalThis as { FileReaderSync?: unknown }).FileReaderSync !== "undefined";
  const workerfs = fs?.filesystems?.WORKERFS;
  if (!inWorker || !workerfs) {
    console.warn("WORKERFS unavailable — falling back to in-memory file copy");
    return openFile(file);
  }

  // A mount pins its File, so drop the previous one before remounting.
  if (workerfsMounted) {
    try { fs.unmount(WORKERFS_MOUNT); } catch { /* already gone */ }
    workerfsMounted = false;
  }
  try { fs.mkdir(WORKERFS_MOUNT); } catch { /* EEXIST */ }

  fs.mount(workerfs, { files: [file] }, WORKERFS_MOUNT);
  workerfsMounted = true;
  return new H5File(`${WORKERFS_MOUNT}/${file.name}`, "r");
}

// ── File type detection ──────────────────────────────────────

export type NexusFileType = "NXevent_data" | "NXlauetof" | "unknown";

/**
 * Try to read a string value from an HDF5 dataset (handles typed arrays, Uint8Array, etc.)
 */
function readStringValue(ds: H5Dataset): string {
  const val = ds.value;
  if (typeof val === "string") return val.trim();
  if (val instanceof Uint8Array) return new TextDecoder().decode(val).trim();
  return String(val ?? "").trim();
}

/**
 * Read the "units" attribute from a dataset and return a multiplier to convert to nanoseconds.
 * Recognized units: s, ms, us/µs, ns. Defaults to 1.0 (assumes ns) if not found.
 */
function getTofToNsFactor(ds: H5Dataset): number {
  const attrs = ds.attrs;
  const unitAttr = attrs?.["units"] ?? attrs?.["unit"];
  if (!unitAttr) return 1.0; // assume ns
  let unit: string;
  const val = unitAttr.value;
  if (typeof val === "string") {
    unit = val.trim().toLowerCase();
  } else if (val instanceof Uint8Array) {
    unit = new TextDecoder().decode(val).trim().toLowerCase();
  } else {
    unit = String(val ?? "").trim().toLowerCase();
  }
  switch (unit) {
    case "s":
    case "second":
    case "seconds":
      return 1e9;
    case "ms":
    case "millisecond":
    case "milliseconds":
      return 1e6;
    case "us":
    case "µs":
    case "microsecond":
    case "microseconds":
      return 1e3;
    case "ns":
    case "nanosecond":
    case "nanoseconds":
      return 1.0;
    default:
      console.warn(`Unknown TOF unit "${unit}", assuming nanoseconds`);
      return 1.0;
  }
}

/**
 * Find an NXevent_data group within a panel group.
 * Checks: (1) direct child datasets, (2) 'data' subgroup, (3) any subgroup with NX_class=NXevent_data.
 */
function findEventDataGroup(
  _h5file: H5File,
  _panelPath: string,
  panelGroup: H5Group
): H5Group | null {
  // Check if event_id exists directly in the panel group
  const directEventId = panelGroup.get("event_id") as H5Dataset | null;
  if (directEventId) return panelGroup;

  // Check 'data' subgroup
  const dataChild = panelGroup.get("data");
  if (dataChild && dataChild instanceof H5Group) {
    const eid = dataChild.get("event_id") as H5Dataset | null;
    if (eid) return dataChild;
  }

  // Scan all child groups for one containing event_id or NX_class=NXevent_data
  for (const childKey of panelGroup.keys()) {
    const child = panelGroup.get(childKey);
    if (!(child instanceof H5Group)) continue;
    const nxAttr = child.attrs?.["NX_class"];
    if (nxAttr) {
      const nxVal = nxAttr.value;
      if (typeof nxVal === "string" && nxVal === "NXevent_data") return child;
    }
    const eid = child.get("event_id") as H5Dataset | null;
    if (eid) return child;
  }

  return null;
}

export function detectFileType(h5file: H5File): NexusFileType {
  // Check /entry/definition or /entry/definitions
  for (const path of ["entry/definition", "entry/definitions"]) {
    const ds = h5file.get(path) as H5Dataset | null;
    if (!ds) continue;
    if (readStringValue(ds) === "NXlauetof") return "NXlauetof";
  }
  // Fall back: scan all groups under /entry/instrument/ for NXevent_data content
  const instrument = h5file.get("entry/instrument");
  if (instrument && instrument instanceof H5Group) {
    for (const key of instrument.keys()) {
      const child = instrument.get(key);
      if (!(child instanceof H5Group)) continue;
      const evGroup = findEventDataGroup(h5file, `entry/instrument/${key}`, child);
      if (evGroup) return "NXevent_data";
    }
  }
  return "unknown";
}

// ── Mantid IDF geometry (instrument_xml) ─────────────────────

/**
 * Rectangular-detector geometry parsed from the Mantid IDF embedded at
 * /entry/instrument/instrument_xml. SNS event files (MANDI, TOPAZ, ...) carry
 * no detector_number and no x/y_pixel_offset on their NXdetector groups, so the
 * IDF is the only record of the per-bank pixel grid and of the event-id origin
 * (bank N's ids start at `idstart`, not at 0).
 */
export interface IdfPanelGeometry {
  /** pixels along x (image columns) */
  nx: number;
  /** pixels along y (image rows) */
  ny: number;
  /** detector id of the panel's first pixel */
  idStart: number;
  /** id increment between successive rows (x steps) */
  idStepByRow: number;
  /** true when ids run along y before x (idfillbyfirst="y") */
  fillByY: boolean;
}

/** Pull `name="value"` pairs out of a raw XML tag body. */
function parseXmlAttrs(tagBody: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][\w.:-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagBody)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

const idfCache = new WeakMap<object, Map<string, IdfPanelGeometry>>();

/**
 * Parse the embedded Mantid IDF into a bank-name → geometry map.
 * Returns an empty map for files with no instrument_xml (e.g. NMX).
 */
export function parseInstrumentIdf(h5file: H5File): Map<string, IdfPanelGeometry> {
  const cached = idfCache.get(h5file as unknown as object);
  if (cached) return cached;

  const map = new Map<string, IdfPanelGeometry>();
  const ds = h5file.get("entry/instrument/instrument_xml/data") as H5Dataset | null;
  if (ds) {
    const val = ds.value;
    let xml = "";
    if (typeof val === "string") xml = val;
    else if (Array.isArray(val)) xml = val.join("");
    else if (val instanceof Uint8Array) xml = new TextDecoder().decode(val);

    if (xml) {
      // <type ... xpixels="256" ypixels="256" name="panel1" is="rectangular_detector"/>
      const typeDims = new Map<string, [number, number]>();
      for (const m of xml.matchAll(/<type\b([^>]*)>/g)) {
        const a = parseXmlAttrs(m[1]);
        if (a.name && a.xpixels && a.ypixels) {
          typeDims.set(a.name, [Number(a.xpixels), Number(a.ypixels)]);
        }
      }

      // <component type="panel1" idstart="65536" idfillbyfirst="y" idstepbyrow="256">
      //   <location ... name="bank1"> ... </location>
      // </component>
      for (const m of xml.matchAll(/<component\b([^>]*)>([\s\S]*?)<\/component>/g)) {
        // A self-closing <component .../> has no body of its own, so the lazy
        // match would run on to the next </component> and steal that
        // component's locations. It carries no locations either way — skip it.
        if (m[1].trimEnd().endsWith("/")) continue;
        const a = parseXmlAttrs(m[1]);
        const dims = a.type ? typeDims.get(a.type) : undefined;
        if (!dims || a.idstart === undefined) continue;
        const [nx, ny] = dims;
        const fillByY = (a.idfillbyfirst ?? "y").toLowerCase() === "y";
        const idStepByRow = a.idstepbyrow ? Number(a.idstepbyrow) : fillByY ? ny : nx;
        const perPanel = nx * ny;
        let i = 0;
        for (const loc of m[2].matchAll(/<location\b([^>]*)>/g)) {
          const la = parseXmlAttrs(loc[1]);
          if (la.name) {
            map.set(la.name, {
              nx,
              ny,
              idStart: Number(a.idstart) + i * perPanel,
              idStepByRow,
              fillByY,
            });
          }
          i++;
        }
      }
    }
  }

  idfCache.set(h5file as unknown as object, map);
  return map;
}

/** Most common pixel grid in the IDF — used for banks the IDF omits. */
function idfMajorityGrid(
  idf: Map<string, IdfPanelGeometry>
): IdfPanelGeometry | null {
  const tally = new Map<string, { g: IdfPanelGeometry; n: number }>();
  for (const g of idf.values()) {
    const key = `${g.nx}x${g.ny}:${g.idStepByRow}:${g.fillByY}`;
    const e = tally.get(key);
    if (e) e.n++;
    else tally.set(key, { g, n: 1 });
  }
  let best: { g: IdfPanelGeometry; n: number } | null = null;
  for (const e of tally.values()) if (!best || e.n > best.n) best = e;
  return best ? { ...best.g, idStart: 0 } : null;
}

/**
 * Resolve a bank's pixel grid from the IDF.
 *
 * Banks named in the IDF are used verbatim. Banks the IDF omits (MANDI's
 * bank14, for instance) fall back to the instrument's majority grid with
 * `idStart` snapped down to the enclosing id block. Returns null when the
 * observed id span cannot fit that grid — which is how Mantid's synthetic
 * `bank_error` (ids with bit 31 set, spanning every bank) gets rejected.
 */
export function resolveIdfGrid(
  idf: Map<string, IdfPanelGeometry>,
  bankName: string,
  idRange: { min: number; max: number } | null
): IdfPanelGeometry | null {
  const exact = idf.get(bankName);
  if (exact) return exact;
  if (idf.size === 0 || !idRange) return null;

  const base = idfMajorityGrid(idf);
  if (!base) return null;
  const perPanel = base.nx * base.ny;
  if (idRange.max - idRange.min >= perPanel) return null;
  const idStart = Math.floor(idRange.min / perPanel) * perPanel;
  if (idRange.max - idStart >= perPanel) return null;
  return { ...base, idStart };
}

/** Flat image index (row-major, [ny][nx]) → detector id, per the IDF layout. */
export function buildIdfDetectorNumber(g: IdfPanelGeometry): Int32Array {
  const { nx, ny, idStart, idStepByRow, fillByY } = g;
  const out = new Int32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      out[y * nx + x] = fillByY
        ? idStart + x * idStepByRow + y
        : idStart + y * idStepByRow + x;
    }
  }
  return out;
}

/** Min/max over an already-loaded event_id array. */
export function eventIdRange(
  arr: Uint32Array
): { min: number; max: number } | null {
  if (arr.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return isFinite(min) ? { min, max } : null;
}

/** Min/max detector id over a bounded sample of an event_id dataset. */
export function sampleEventIdRange(
  ds: H5Dataset,
  maxSamples = 100000
): { min: number; max: number } | null {
  const n = ds.shape?.[0] ?? 0;
  if (n === 0) return null;
  const take = Math.min(n, maxSamples);
  const raw = ds.slice([[0, take]]) as ArrayLike<number> | BigInt64Array;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < take; i++) {
    const v = Number((raw as ArrayLike<number>)[i]);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return isFinite(min) ? { min, max } : null;
}

// ── NXevent_data panels ───────────────────────────────────────

export interface DetectorPanelInfo {
  path: string;
  name: string;
  numEvents: number;
  detectorShape: [number, number];
  pixelIdMin: number;
  pixelIdMax: number;
}

export function findDetectorPanels(h5file: H5File): DetectorPanelInfo[] {
  const panels: DetectorPanelInfo[] = [];
  const instrument = h5file.get("entry/instrument");
  if (!instrument || !(instrument instanceof H5Group)) return panels;

  const idf = parseInstrumentIdf(h5file);

  for (const key of instrument.keys()) {
    const child = instrument.get(key);
    if (!(child instanceof H5Group)) continue;

    const panelPath = `entry/instrument/${key}`;
    const evGroup = findEventDataGroup(h5file, panelPath, child);
    if (!evGroup) continue;

    const eventIdDs = evGroup.get("event_id") as H5Dataset | null;
    if (!eventIdDs) continue;

    // Look for detector_number in the panel group (not necessarily the event data group)
    let detNumDs = h5file.get(`${panelPath}/detector_number`) as H5Dataset | undefined;
    // Also check parent-level x_pixel_offset / y_pixel_offset for shape
    if (!detNumDs) {
      const xOff = h5file.get(`${panelPath}/x_pixel_offset`) as H5Dataset | undefined;
      const yOff = h5file.get(`${panelPath}/y_pixel_offset`) as H5Dataset | undefined;
      if (xOff?.shape && yOff?.shape) {
        // Construct shape from pixel offsets — each should be 1D with size = dim
        const nx = xOff.shape.length === 1 ? xOff.shape[0] : xOff.shape[1] ?? xOff.shape[0];
        const ny = yOff.shape.length === 1 ? yOff.shape[0] : yOff.shape[0];
        panels.push({
          path: panelPath,
          name: key,
          numEvents: eventIdDs.shape![0],
          detectorShape: [ny, nx],
          pixelIdMin: 0,
          pixelIdMax: ny * nx - 1,
        });
        continue;
      }

      // No per-detector geometry at all: fall back to the embedded Mantid IDF,
      // which also tells us where this bank's event ids start.
      const grid = resolveIdfGrid(idf, key, sampleEventIdRange(eventIdDs));
      if (grid) {
        panels.push({
          path: panelPath,
          name: key,
          numEvents: eventIdDs.shape![0],
          detectorShape: [grid.ny, grid.nx],
          pixelIdMin: grid.idStart,
          pixelIdMax: grid.idStart + grid.nx * grid.ny - 1,
        });
        continue;
      }
      // An IDF exists but this group's ids fit no bank (Mantid's bank_error /
      // bank_unmapped pseudo-detectors) — nothing sensible to render.
      if (idf.size > 0) continue;
    }

    const detShape: [number, number] = detNumDs?.shape
      ? [detNumDs.shape[0], detNumDs.shape[1]]
      : [1280, 1280];

    panels.push({
      path: panelPath,
      name: key,
      numEvents: eventIdDs.shape![0],
      detectorShape: detShape,
      pixelIdMin: 0,
      pixelIdMax: detShape[0] * detShape[1] - 1,
    });
  }

  return panels;
}

export interface EventData {
  /**
   * Event pixel IDs. Uint32 rather than Float64: ids are integers, and 4 bytes
   * holds every value a detector can produce exactly (up to 4.29e9), where
   * Float32 would go inexact above 2^24 = 16,777,216.
   */
  eventId: Uint32Array;
  /**
   * TOF values in nanoseconds. Float32 costs 4 bytes and ~1e-7 relative
   * precision — a few ns across a full pulse period, far below any bin width,
   * and lossless for the float32 µs that event files typically store.
   */
  tof: Float32Array;
  detectorShape: [number, number];
  panelPixelIdMin: number;
  /** Cached pixel-to-flat-index mapping */
  pixelToFlat: Int32Array;
  /** True if pixelToFlat[i] === i for all i (sequential detector_number) */
  isIdentity: boolean;
  /** Pre-computed TOF bounds */
  tofMin: number;
  tofMax: number;
}

/** Any numeric typed array h5wasm may hand back for an event dataset. */
type RawEventArray = ArrayLike<number> | BigInt64Array | BigUint64Array;

function isBigArray(arr: RawEventArray): arr is BigInt64Array | BigUint64Array {
  return arr instanceof BigInt64Array || arr instanceof BigUint64Array;
}

/**
 * Copy event ids into a Uint32Array, avoiding a conversion entirely when the
 * file already stores uint32 (as NeXus event files normally do).
 */
function toUint32(arr: RawEventArray): Uint32Array {
  if (arr instanceof Uint32Array) return arr;
  const out = new Uint32Array(arr.length);
  let overflow = false;
  if (isBigArray(arr)) {
    for (let i = 0; i < arr.length; i++) {
      const v = Number(arr[i]);
      if (v > 0xffffffff) overflow = true;
      out[i] = v;
    }
  } else {
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v > 0xffffffff) overflow = true;
      out[i] = v;
    }
  }
  if (overflow) {
    console.warn("Event ids exceed the uint32 range and were truncated");
  }
  return out;
}

/** Copy TOF values into a Float32Array, scaling to nanoseconds in the same pass. */
function toFloat32Ns(arr: RawEventArray, factor: number): Float32Array {
  if (factor === 1.0 && arr instanceof Float32Array) return arr;
  const out = new Float32Array(arr.length);
  if (isBigArray(arr)) {
    for (let i = 0; i < arr.length; i++) out[i] = Number(arr[i]) * factor;
  } else {
    for (let i = 0; i < arr.length; i++) out[i] = arr[i] * factor;
  }
  return out;
}

/**
 * Build reverse lookup: pixelId - panelMin → flat detector index.
 */
function buildPixelMap(
  detectorNumber: Int32Array,
  panelMin: number,
  totalPixels: number
): { pixelToFlat: Int32Array; isIdentity: boolean } {
  const pixelToFlat = new Int32Array(totalPixels);
  pixelToFlat.fill(-1);
  for (let i = 0; i < detectorNumber.length; i++) {
    const pid = detectorNumber[i] - panelMin;
    if (pid >= 0 && pid < totalPixels) pixelToFlat[pid] = i;
  }
  let isIdentity = true;
  for (let i = 0; i < totalPixels; i++) {
    if (pixelToFlat[i] !== i) { isIdentity = false; break; }
  }
  return { pixelToFlat, isIdentity };
}

/**
 * Read event data and pre-process: convert BigInt→Float64, sort by TOF,
 * cache pixel mapping. All heavy work is done here at load time.
 */
export function readEventData(h5file: H5File, panelPath: string): EventData {
  console.time(`[${panelPath}] total readEventData`);

  const panelGroup = h5file.get(panelPath) as H5Group;
  const evGroup = findEventDataGroup(h5file, panelPath, panelGroup);
  if (!evGroup) throw new Error(`No event data found in ${panelPath}`);

  const eventIdDs = evGroup.get("event_id") as H5Dataset;
  const etoDs = evGroup.get("event_time_offset") as H5Dataset;

  // detector_number can be in the panel group or the event data group
  let detNumDs = h5file.get(`${panelPath}/detector_number`) as H5Dataset | null;
  if (!detNumDs) detNumDs = evGroup.get("detector_number") as H5Dataset | null;

  // Narrow to 4-byte arrays once, up front: ids are integers and TOF only ever
  // needs float precision, so Float64 doubled the footprint for nothing. When
  // the file already stores uint32 ids / float32 TOF these adopt without a copy.
  console.time(`[${panelPath}] typed-array conversion`);
  const eventId = toUint32(eventIdDs.value as RawEventArray);
  const tof = toFloat32Ns(etoDs.value as RawEventArray, getTofToNsFactor(etoDs));
  console.timeEnd(`[${panelPath}] typed-array conversion`);

  let detectorNumber: Int32Array;
  let detectorShape: [number, number];

  if (detNumDs && detNumDs.shape && detNumDs.shape.length >= 2) {
    detectorNumber = detNumDs.value as Int32Array;
    detectorShape = [detNumDs.shape[0], detNumDs.shape[1]];
  } else if (detNumDs && detNumDs.shape && detNumDs.shape.length === 1) {
    // 1D detector_number — infer square shape
    const n = Math.round(Math.sqrt(detNumDs.shape[0]));
    detectorNumber = detNumDs.value as Int32Array;
    detectorShape = [n, n];
  } else {
    // No detector_number — try to infer shape from x/y_pixel_offset
    const xOff = h5file.get(`${panelPath}/x_pixel_offset`) as H5Dataset | null;
    const yOff = h5file.get(`${panelPath}/y_pixel_offset`) as H5Dataset | null;
    const idfGrid = xOff?.shape && yOff?.shape
      ? null
      : resolveIdfGrid(
          parseInstrumentIdf(h5file),
          panelPath.split("/").pop() ?? "",
          eventIdRange(eventId)
        );

    if (xOff?.shape && yOff?.shape) {
      const nx = xOff.shape.length === 1 ? xOff.shape[0] : xOff.shape[1] ?? xOff.shape[0];
      const ny = yOff.shape.length === 1 ? yOff.shape[0] : yOff.shape[0];
      detectorShape = [ny, nx];
    } else if (idfGrid) {
      // Mantid IDF geometry: gives both the pixel grid and the bank's id origin,
      // and (for idfillbyfirst="y") the column-major id → pixel ordering.
      detectorShape = [idfGrid.ny, idfGrid.nx];
    } else {
      detectorShape = [1280, 1280];
    }

    if (idfGrid) {
      detectorNumber = buildIdfDetectorNumber(idfGrid);
    } else {
      // Build identity detector_number
      const totalPx = detectorShape[0] * detectorShape[1];
      detectorNumber = new Int32Array(totalPx);
      for (let i = 0; i < totalPx; i++) detectorNumber[i] = i;
    }
  }

  // Find panelPixelIdMin
  let panelPixelIdMin = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < detectorNumber.length; i++) {
    if (detectorNumber[i] < panelPixelIdMin) panelPixelIdMin = detectorNumber[i];
  }

  // Build + cache pixel map
  const totalPixels = detectorShape[0] * detectorShape[1];
  console.time(`[${panelPath}] buildPixelMap`);
  const { pixelToFlat, isIdentity } = buildPixelMap(detectorNumber, panelPixelIdMin, totalPixels);
  console.timeEnd(`[${panelPath}] buildPixelMap`);

  // Find TOF bounds with a single O(N) pass
  let tofMin = Infinity;
  let tofMax = -Infinity;
  console.time(`[${panelPath}] TOF bounds`);

  for (let i = 0; i < tof.length; i++) {
    const v = tof[i];
    if (v < tofMin) tofMin = v;
    if (v > tofMax) tofMax = v;
  }
  console.timeEnd(`[${panelPath}] TOF bounds`);

  if (!isFinite(tofMin)) { tofMin = 0; tofMax = 0; }
  console.timeEnd(`[${panelPath}] total readEventData`);
  return {
    eventId,
    tof,
    detectorShape,
    panelPixelIdMin,
    pixelToFlat,
    isIdentity,
    tofMin,
    tofMax,
  };
}

// ── NXlauetof panels ────────────────────────────────────────

export interface LauetofPanelInfo {
  path: string;
  name: string;
  shape: [number, number, number]; // [rows, cols, numTofBins]
  tofBins: Float64Array; // TOF bin centers (ns)
  geometry: PanelGeometry | null; // detector geometry for d-spacing
}

/**
 * Find a 3D data dataset and time_of_flight within a panel group.
 * Checks: (1) direct 'data' dataset, (2) any child dataset with ndim=3,
 * and looks for 'time_of_flight' in the panel group or any child group.
 */
function findLauetofDatasets(
  h5file: H5File,
  panelPath: string,
  panelGroup: H5Group
): { dataDs: H5Dataset; tofDs: H5Dataset } | null {
  let dataDs: H5Dataset | null = null;
  let tofDs: H5Dataset | null = null;

  // Look for 3D data dataset: check 'data' first, then scan children
  const directData = h5file.get(`${panelPath}/data`) as H5Dataset | null;
  if (directData?.shape?.length === 3) {
    dataDs = directData;
  } else {
    for (const childKey of panelGroup.keys()) {
      const child = panelGroup.get(childKey);
      if (child instanceof H5Dataset && child.shape?.length === 3) {
        dataDs = child;
        break;
      }
    }
  }
  if (!dataDs) return null;

  // Look for time_of_flight: in panel group, then any child group
  tofDs = h5file.get(`${panelPath}/time_of_flight`) as H5Dataset | null;
  if (!tofDs) {
    for (const childKey of panelGroup.keys()) {
      const child = panelGroup.get(childKey);
      if (child instanceof H5Group) {
        const tof = child.get("time_of_flight") as H5Dataset | null;
        if (tof) { tofDs = tof; break; }
      } else if (child instanceof H5Dataset && childKey === "time_of_flight") {
        tofDs = child;
        break;
      }
    }
  }
  if (!tofDs) return null;

  return { dataDs, tofDs };
}

/** Read a scalar float from a dataset, handling typed arrays and BigInt. */
function readScalarFloat(ds: H5Dataset): number {
  const v = ds.value;
  if (typeof v === "number") return v;
  if (v instanceof Float64Array || v instanceof Float32Array) return v[0];
  if (v instanceof BigInt64Array || v instanceof BigUint64Array) return Number(v[0]);
  if (ArrayBuffer.isView(v)) return (v as unknown as ArrayLike<number>)[0];
  return Number(v);
}

/** Read a length-3 float vector from a dataset. */
function readVec3(ds: H5Dataset): [number, number, number] {
  const v = ds.value;
  if (v instanceof Float64Array || v instanceof Float32Array) {
    return [v[0], v[1], v[2]];
  }
  if (Array.isArray(v)) return [Number(v[0]), Number(v[1]), Number(v[2])];
  if (ArrayBuffer.isView(v)) {
    const a = v as unknown as ArrayLike<number>;
    return [a[0], a[1], a[2]];
  }
  return [0, 0, 0];
}

/** Read a distance value from a dataset, converting to meters. */
function readDistanceMeters(ds: H5Dataset): number {
  let val = readScalarFloat(ds);
  const unitAttr = ds.attrs?.["units"] ?? ds.attrs?.["unit"];
  if (unitAttr) {
    const u = typeof unitAttr.value === "string"
      ? unitAttr.value.trim().toLowerCase()
      : String(unitAttr.value ?? "").trim().toLowerCase();
    if (u === "mm") val *= 1e-3;
    else if (u === "cm") val *= 1e-2;
    // "m" is default, no conversion needed
  }
  return val;
}

/**
 * Read panel geometry for d-spacing calculation.
 * Requires: origin (3-vec), fast_axis (3-vec), slow_axis (3-vec),
 * x_pixel_size, y_pixel_size (scalar), and source distance from
 * /entry/instrument/source/distance.
 */
function readPanelGeometry(
  h5file: H5File,
  panelPath: string,
  nRows: number,
  nCols: number
): PanelGeometry | null {
  try {
    const originDs = h5file.get(`${panelPath}/origin`) as H5Dataset | null;
    const fastDs = h5file.get(`${panelPath}/fast_axis`) as H5Dataset | null;
    const slowDs = h5file.get(`${panelPath}/slow_axis`) as H5Dataset | null;
    const xpDs = h5file.get(`${panelPath}/x_pixel_size`) as H5Dataset | null;
    const ypDs = h5file.get(`${panelPath}/y_pixel_size`) as H5Dataset | null;
    const srcDs = h5file.get("entry/instrument/source/distance") as H5Dataset | null;

    if (!originDs || !fastDs || !slowDs || !xpDs || !ypDs || !srcDs) return null;

    return {
      origin: readVec3(originDs),
      fastAxis: readVec3(fastDs),
      slowAxis: readVec3(slowDs),
      xPixelSize: readDistanceMeters(xpDs),
      yPixelSize: readDistanceMeters(ypDs),
      sourceDistance: readDistanceMeters(srcDs),
      nRows,
      nCols,
    };
  } catch {
    return null;
  }
}

export function findLauetofPanels(h5file: H5File): LauetofPanelInfo[] {
  const panels: LauetofPanelInfo[] = [];
  const instrument = h5file.get("entry/instrument");
  if (!instrument || !(instrument instanceof H5Group)) return panels;

  for (const key of instrument.keys()) {
    const child = instrument.get(key);
    if (!(child instanceof H5Group)) continue;

    const panelPath = `entry/instrument/${key}`;
    const result = findLauetofDatasets(h5file, panelPath, child);
    if (!result) continue;
    const { dataDs, tofDs } = result;

    const tofRaw = tofDs.value;
    let tofBins: Float64Array;
    if (tofRaw instanceof Float64Array) {
      tofBins = tofRaw;
    } else if (tofRaw instanceof BigInt64Array) {
      tofBins = new Float64Array(tofRaw.length);
      for (let i = 0; i < tofRaw.length; i++) tofBins[i] = Number(tofRaw[i]);
    } else if (ArrayBuffer.isView(tofRaw)) {
      tofBins = new Float64Array(tofRaw as ArrayLike<number>);
    } else {
      continue;
    }

    const tofFactor = getTofToNsFactor(tofDs);
    if (tofFactor !== 1.0) {
      for (let i = 0; i < tofBins.length; i++) tofBins[i] *= tofFactor;
    }

    const panelShape: [number, number, number] = [dataDs.shape![0], dataDs.shape![1], dataDs.shape![2]];

    panels.push({
      path: panelPath,
      name: key,
      shape: panelShape,
      tofBins,
      geometry: readPanelGeometry(h5file, panelPath, panelShape[0], panelShape[1]),
    });
  }

  return panels;
}

/**
 * Read a single TOF slice from an NXlauetof panel.
 * sliceIndex is a 0-based index into the TOF dimension.
 */
export function readLauetofSingleSlice(
  h5file: H5File,
  panelPath: string,
  sliceIndex: number
): DetectorImageResult {
  const panelGroup = h5file.get(panelPath) as H5Group;
  const result = findLauetofDatasets(h5file, panelPath, panelGroup);
  if (!result) throw new Error(`No 3D data found in ${panelPath}`);
  const { dataDs } = result;
  const [rows, cols, numBins] = dataDs.shape!;
  const idx = Math.max(0, Math.min(numBins - 1, sliceIndex));

  const image = new Float64Array(rows * cols);
  const raw = dataDs.slice([[0, rows], [0, cols], [idx, idx + 1]]);
  if (raw instanceof BigUint64Array || raw instanceof BigInt64Array) {
    for (let i = 0; i < raw.length; i++) image[i] = Number(raw[i]);
  } else if (ArrayBuffer.isView(raw)) {
    const arr = raw as ArrayLike<number>;
    for (let i = 0; i < arr.length; i++) image[i] = arr[i];
  }

  let totalEvents = 0;
  for (let i = 0; i < image.length; i++) totalEvents += image[i];

  return { image, shape: [rows, cols], totalEvents };
}

/**
 * Integrated-counts-vs-TOF profile for a rectangular region of an NXlauetof panel.
 * Reads the sub-volume data[r0..r1, c0..c1, :] and sums over pixels for each
 * TOF bin. TOF is the fastest-varying (last) dimension, so a flat index k maps
 * to bin `k % numBins`. Returns counts aligned with the panel's tofBins.
 */
export function readLauetofBoxTofProfile(
  h5file: H5File,
  panelPath: string,
  box: { r0: number; r1: number; c0: number; c1: number }
): Float64Array {
  const panelGroup = h5file.get(panelPath) as H5Group;
  const result = findLauetofDatasets(h5file, panelPath, panelGroup);
  if (!result) throw new Error(`No 3D data found in ${panelPath}`);
  const { dataDs } = result;
  const [rows, cols, numBins] = dataDs.shape!;

  const r0 = Math.max(0, Math.min(rows - 1, Math.round(Math.min(box.r0, box.r1))));
  const r1 = Math.max(0, Math.min(rows - 1, Math.round(Math.max(box.r0, box.r1))));
  const c0 = Math.max(0, Math.min(cols - 1, Math.round(Math.min(box.c0, box.c1))));
  const c1 = Math.max(0, Math.min(cols - 1, Math.round(Math.max(box.c0, box.c1))));

  const counts = new Float64Array(numBins);
  const raw = dataDs.slice([[r0, r1 + 1], [c0, c1 + 1], [0, numBins]]);
  if (raw instanceof BigUint64Array || raw instanceof BigInt64Array) {
    for (let k = 0; k < raw.length; k++) counts[k % numBins] += Number(raw[k]);
  } else if (ArrayBuffer.isView(raw)) {
    const arr = raw as ArrayLike<number>;
    for (let k = 0; k < arr.length; k++) counts[k % numBins] += arr[k];
  }
  return counts;
}
