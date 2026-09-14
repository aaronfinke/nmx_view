/// <reference lib="webworker" />
/**
 * HDF5 worker: owns the open file and all per-event arrays.
 *
 * Everything that touches raw events runs here, so the UI thread never holds
 * more than the images it draws. Running in a worker is also what makes the
 * zero-copy WORKERFS mount possible (see `openFileLazy`).
 */
import {
  openFileLazy,
  detectFileType,
  findDetectorPanels,
  findLauetofPanels,
  readEventData,
  readLauetofSingleSlice,
  readLauetofBoxTofProfile,
  parseInstrumentIdf,
  type DetectorPanelInfo,
  type LauetofPanelInfo,
  type EventData,
} from "./h5wasm-loader";
import {
  computeTofHistogram,
  computeDetectorImage,
  computeBoxTofProfile,
  type DetectorImageResult,
} from "./event-data";
import type {
  WorkerRequest,
  WorkerResponse,
  OpenResult,
  LoadEventPanelsResult,
  ImagesResult,
  LauetofSlicesResult,
  TofProfileWire,
} from "./h5-worker-protocol";
import { buildPanels3D } from "./panel3d";
import type { Panels3DResult } from "./h5-worker-protocol";
import type { File as H5File } from "h5wasm";

let h5file: H5File | null = null;
let panels: DetectorPanelInfo[] = [];
let lauetofPanels: LauetofPanelInfo[] = [];
const eventData = new Map<number, EventData>();

function progress(label: string, value: number) {
  const msg: WorkerResponse = { kind: "progress", label, value };
  self.postMessage(msg);
}

function closeFile() {
  if (h5file) {
    try { h5file.close(); } catch { /* already closed */ }
    h5file = null;
  }
  panels = [];
  lauetofPanels = [];
  eventData.clear();
}

function requireFile(): H5File {
  if (!h5file) throw new Error("No file is open");
  return h5file;
}

/** Panel indices to act on; null means all of them. */
function resolveIndices(indices: number[] | null, count: number): number[] {
  if (!indices) return Array.from({ length: count }, (_, i) => i);
  return indices.filter((i) => i >= 0 && i < count);
}

/** Index of the bin centre nearest `center`. */
function nearestBin(bins: Float64Array, center: number): number {
  let best = 0;
  let bestDist = Math.abs(bins[0] - center);
  for (let j = 1; j < bins.length; j++) {
    const d = Math.abs(bins[j] - center);
    if (d < bestDist) { bestDist = d; best = j; }
  }
  return best;
}

async function handleOpen(file: File): Promise<OpenResult> {
  closeFile();
  progress("Opening HDF5 file…", 0);
  h5file = await openFileLazy(file);

  progress("Detecting file type…", 0);
  const fileType = detectFileType(h5file);

  if (fileType === "NXlauetof") {
    lauetofPanels = findLauetofPanels(h5file);
  } else {
    panels = findDetectorPanels(h5file);
  }
  return { fileType, panels, lauetofPanels };
}

function handleLoadEventPanels(numBins: number): LoadEventPanelsResult {
  const file = requireFile();
  eventData.clear();
  let tofMin = Infinity;
  let tofMax = -Infinity;

  for (let i = 0; i < panels.length; i++) {
    progress(
      `Reading ${panels[i].name} (${panels[i].numEvents.toLocaleString()} events)…`,
      (i / (panels.length + 1)) * 100
    );
    const ed = readEventData(file, panels[i].path);
    eventData.set(i, ed);
    const hist = computeTofHistogram(ed, numBins);
    if (hist.tofMin < tofMin) tofMin = hist.tofMin;
    if (hist.tofMax > tofMax) tofMax = hist.tofMax;
  }

  if (!isFinite(tofMin)) { tofMin = 0; tofMax = 0; }
  return { tofMin, tofMax };
}

function handleComputeImages(
  tofRange: [number, number],
  indices: number[] | null
): ImagesResult {
  const wanted = resolveIndices(indices, panels.length);
  const images: (DetectorImageResult | null)[] = new Array(panels.length).fill(null);

  wanted.forEach((i, n) => {
    progress(`Computing image for ${panels[i].name}…`, (n / wanted.length) * 100);
    const ed = eventData.get(i);
    if (ed) images[i] = computeDetectorImage(ed, tofRange);
  });
  return { images };
}

function handleLauetofSlices(
  center: number | null,
  indices: number[] | null
): LauetofSlicesResult {
  const file = requireFile();
  const wanted = resolveIndices(indices, lauetofPanels.length);
  const images: (DetectorImageResult | null)[] = new Array(lauetofPanels.length).fill(null);
  const sliceIndices: number[] = new Array(lauetofPanels.length).fill(0);

  wanted.forEach((i, n) => {
    const p = lauetofPanels[i];
    const idx = center === null ? 0 : nearestBin(p.tofBins, center);
    sliceIndices[i] = idx;
    progress(
      `Reading ${p.name} slice ${idx + 1}/${p.shape[2]}…`,
      (n / wanted.length) * 100
    );
    images[i] = readLauetofSingleSlice(file, p.path, idx);
  });
  return { images, sliceIndices };
}

function handleBoxTofProfile(
  panelIndex: number,
  box: { r0: number; r1: number; c0: number; c1: number },
  numBins: number,
  tofRange: [number, number] | null
): TofProfileWire {
  if (lauetofPanels.length > 0) {
    const panel = lauetofPanels[panelIndex];
    if (!panel) throw new Error(`No NXlauetof panel at index ${panelIndex}`);
    const counts = readLauetofBoxTofProfile(requireFile(), panel.path, box);
    // Bins are fixed by the file, so the requested range is ignored here.
    // Copy: the reply transfers `tof`, which would detach the panel's cached
    // tofBins inside the worker and break every later slice and profile.
    return { tof: panel.tofBins.slice(), counts };
  }
  const ed = eventData.get(panelIndex);
  if (!ed) throw new Error(`No event data loaded for panel ${panelIndex}`);
  const { tof, counts } = computeBoxTofProfile(ed, box, numBins, tofRange ?? undefined);
  return { tof, counts };
}

function handlePanels3D(): Panels3DResult {
  const file = requireFile();
  return {
    panels3d: buildPanels3D(file, panels, lauetofPanels, parseInstrumentIdf(file)),
  };
}

/** Buffers to hand over rather than copy — images and profiles are the bulk. */
function transfersFor(result: unknown): Transferable[] {
  const out: Transferable[] = [];
  const push = (v: unknown) => {
    if (ArrayBuffer.isView(v)) out.push(v.buffer as ArrayBuffer);
  };
  const r = result as Partial<ImagesResult & TofProfileWire>;
  if (Array.isArray(r?.images)) {
    for (const img of r.images) if (img) push(img.image);
  }
  push(r?.tof);
  push(r?.counts);
  return out;
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    let result: unknown;
    switch (req.op) {
      case "open":
        result = await handleOpen(req.file);
        break;
      case "loadEventPanels":
        result = handleLoadEventPanels(req.numBins);
        break;
      case "computeImages":
        result = handleComputeImages(req.tofRange, req.indices);
        break;
      case "lauetofSlices":
        result = handleLauetofSlices(req.center, req.indices);
        break;
      case "boxTofProfile":
        result = handleBoxTofProfile(req.panelIndex, req.box, req.numBins, req.tofRange);
        break;
      case "panels3d":
        result = handlePanels3D();
        break;
      case "close":
        closeFile();
        result = null;
        break;
    }
    const msg: WorkerResponse = { id: req.id, kind: "ok", result };
    self.postMessage(msg, transfersFor(result));
  } catch (err) {
    const msg: WorkerResponse = {
      id: req.id,
      kind: "error",
      message: (err as Error)?.message ?? String(err),
    };
    self.postMessage(msg);
  }
};
