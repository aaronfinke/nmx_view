/**
 * Message contract between the UI thread and the HDF5 worker.
 *
 * The worker owns the H5File handle and every per-event array. Only results
 * that are small relative to the events they came from cross the boundary:
 * panel metadata, detector images, and 1D profiles. A 2.5M-event bank is ~20 MB
 * of typed arrays but its image is 256 KB, so keeping the events worker-side is
 * what makes multi-GB files viable.
 */
import type { DetectorImageResult, BoxRegion } from "./event-data";
import type {
  NexusFileType,
  DetectorPanelInfo,
  LauetofPanelInfo,
} from "./h5wasm-loader";
import type { Panel3D } from "./panel3d";

export interface OpenResult {
  fileType: NexusFileType;
  panels: DetectorPanelInfo[];
  lauetofPanels: LauetofPanelInfo[];
}

export interface Panels3DResult {
  /** Empty when the file carries no resolvable panel geometry. */
  panels3d: Panel3D[];
}

export interface LoadEventPanelsResult {
  tofMin: number;
  tofMax: number;
}

/** Images are sparse: entry `i` is null when panel `i` was not requested. */
export interface ImagesResult {
  images: (DetectorImageResult | null)[];
}

export interface LauetofSlicesResult extends ImagesResult {
  /** Chosen bin index per panel, aligned with `images`. */
  sliceIndices: number[];
}

export interface TofProfileWire {
  tof: Float64Array;
  counts: Float64Array;
}

export type WorkerRequest =
  | { id: number; op: "open"; file: File }
  | { id: number; op: "loadEventPanels"; numBins: number }
  | {
      id: number;
      op: "computeImages";
      tofRange: [number, number];
      /** null = every panel */
      indices: number[] | null;
    }
  | {
      id: number;
      op: "lauetofSlices";
      /** TOF centre to snap to the nearest bin; null selects bin 0. */
      center: number | null;
      indices: number[] | null;
    }
  | {
      id: number;
      op: "boxTofProfile";
      panelIndex: number;
      box: BoxRegion;
      numBins: number;
      tofRange: [number, number] | null;
    }
  | { id: number; op: "panels3d" }
  | { id: number; op: "close" };

export type WorkerOp = WorkerRequest["op"];

/** Maps each op to what its `ok` response carries. */
export interface WorkerResultMap {
  open: OpenResult;
  loadEventPanels: LoadEventPanelsResult;
  computeImages: ImagesResult;
  lauetofSlices: LauetofSlicesResult;
  boxTofProfile: TofProfileWire;
  panels3d: Panels3DResult;
  close: null;
}

export type WorkerResponse =
  | { id: number; kind: "ok"; result: unknown }
  | { id: number; kind: "error"; message: string }
  /** Unsolicited: drives the load progress bar. */
  | { kind: "progress"; label: string; value: number };
