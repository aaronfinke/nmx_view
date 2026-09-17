/**
 * UI-thread handle for the HDF5 worker.
 *
 * Wraps postMessage in promises and forwards progress messages to a callback.
 * One worker is reused for the life of the page; `open` replaces whatever file
 * was mounted before.
 */
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerResultMap,
  OpenResult,
  LoadEventPanelsResult,
  ImagesResult,
  LauetofSlicesResult,
  TofProfileWire,
  Panels3DResult,
} from "./h5-worker-protocol";
import type { BoxRegion } from "./event-data";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export type ProgressHandler = (label: string, value: number) => void;

export class H5Client {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private onProgress: ProgressHandler | null = null;

  constructor() {
    this.worker = new Worker(new URL("./h5-worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.kind === "progress") {
        this.onProgress?.(msg.label, msg.value);
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.kind === "error") entry.reject(new Error(msg.message));
      else entry.resolve(msg.result);
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message || "HDF5 worker crashed");
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    };
  }

  /** Progress messages arrive between calls; only the latest handler is used. */
  setProgressHandler(handler: ProgressHandler | null) {
    this.onProgress = handler;
  }

  private send<K extends WorkerRequest["op"]>(
    req: Omit<Extract<WorkerRequest, { op: K }>, "id">
  ): Promise<WorkerResultMap[K]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...req, id } as WorkerRequest);
    });
  }

  open(file: File): Promise<OpenResult> {
    return this.send<"open">({ op: "open", file });
  }

  loadEventPanels(numBins: number): Promise<LoadEventPanelsResult> {
    return this.send<"loadEventPanels">({ op: "loadEventPanels", numBins });
  }

  computeImages(
    tofRange: [number, number],
    indices: number[] | null = null
  ): Promise<ImagesResult> {
    return this.send<"computeImages">({ op: "computeImages", tofRange, indices });
  }

  lauetofSlices(
    center: number | null,
    indices: number[] | null = null
  ): Promise<LauetofSlicesResult> {
    return this.send<"lauetofSlices">({ op: "lauetofSlices", center, indices });
  }

  boxTofProfile(
    panelIndex: number,
    box: BoxRegion,
    numBins = 256,
    tofRange: [number, number] | null = null
  ): Promise<TofProfileWire> {
    return this.send<"boxTofProfile">({
      op: "boxTofProfile",
      panelIndex,
      box,
      numBins,
      tofRange,
    });
  }

  panels3d(): Promise<Panels3DResult> {
    return this.send<"panels3d">({ op: "panels3d" });
  }

  close(): Promise<null> {
    return this.send<"close">({ op: "close" });
  }

  terminate() {
    this.worker.terminate();
    this.pending.clear();
  }
}
