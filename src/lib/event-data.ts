import type { EventData } from "./h5wasm-loader";

export interface TofHistogramResult {
  binEdges: Float64Array; // length = numBins + 1
  counts: Float64Array; // length = numBins
  tofMin: number;
  tofMax: number;
}

/**
 * Compute a TOF histogram from pre-processed event data.
 * Uses pre-converted Float64Array (no BigInt conversion needed).
 */
export function computeTofHistogram(
  eventData: EventData,
  numBins: number = 500
): TofHistogramResult {
  const { tofMin, tofMax, tofF64 } = eventData;

  const range = tofMax - tofMin;
  const binWidth = range / numBins;
  const binEdges = new Float64Array(numBins + 1);
  for (let i = 0; i <= numBins; i++) {
    binEdges[i] = tofMin + i * binWidth;
  }

  const counts = new Float64Array(numBins);
  for (let i = 0; i < tofF64.length; i++) {
    const bin = Math.floor((tofF64[i] - tofMin) / binWidth);
    const clampedBin = Math.min(bin, numBins - 1);
    if (clampedBin >= 0) counts[clampedBin]++;
  }

  return { binEdges, counts, tofMin, tofMax };
}

export interface DetectorImageResult {
  image: Float64Array; // flattened 2D array [rows][cols]
  shape: [number, number]; // [rows, cols]
  totalEvents: number;
}

export interface BoxRegion {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export interface TofProfileResult {
  tof: Float64Array; // TOF bin centers (ns)
  counts: Float64Array; // integrated counts per bin over the box region
  tofMin: number;
  tofMax: number;
}

/**
 * Integrated-counts-vs-TOF profile for a rectangular detector region.
 * Histograms the TOF of every event whose pixel falls inside the box.
 * One O(N events) pass; runs only when the box geometry changes.
 */
export function computeBoxTofProfile(
  eventData: EventData,
  box: BoxRegion,
  numBins = 256
): TofProfileResult {
  const { detectorShape, panelPixelIdMin, pixelToFlat, isIdentity,
          eventIdF64, tofF64, tofMin, tofMax } = eventData;
  const [rows, cols] = detectorShape;
  const totalPixels = rows * cols;

  const r0 = Math.max(0, Math.min(rows - 1, box.r0));
  const r1 = Math.max(0, Math.min(rows - 1, box.r1));
  const c0 = Math.max(0, Math.min(cols - 1, box.c0));
  const c1 = Math.max(0, Math.min(cols - 1, box.c1));

  const range = tofMax - tofMin || 1;
  const binWidth = range / numBins;
  const counts = new Float64Array(numBins);

  for (let i = 0; i < tofF64.length; i++) {
    const pid = eventIdF64[i] - panelPixelIdMin;
    if (pid < 0 || pid >= totalPixels) continue;
    const flat = isIdentity ? pid : pixelToFlat[pid];
    if (flat < 0) continue;
    const row = (flat / cols) | 0;
    const col = flat - row * cols;
    if (row < r0 || row > r1 || col < c0 || col > c1) continue;
    let bin = ((tofF64[i] - tofMin) / binWidth) | 0;
    if (bin >= numBins) bin = numBins - 1;
    if (bin >= 0) counts[bin]++;
  }

  const tof = new Float64Array(numBins);
  for (let i = 0; i < numBins; i++) tof[i] = tofMin + (i + 0.5) * binWidth;
  return { tof, counts, tofMin, tofMax };
}

/**
 * Bin events into a 2D detector image for a given TOF range.
 * Scans pre-converted Float64Arrays (no BigInt conversion per call).
 * Uses cached pixel-to-flat mapping (computed once at load time).
 */
export function computeDetectorImage(
  eventData: EventData,
  tofRange: [number, number]
): DetectorImageResult {
  console.time('computeDetectorImage');

  const { detectorShape, panelPixelIdMin, pixelToFlat, isIdentity,
          eventIdF64, tofF64 } = eventData;
  const [rows, cols] = detectorShape;
  const totalPixels = rows * cols;
  const image = new Float64Array(totalPixels);

  const [tofLow, tofHigh] = tofRange;
  let totalEvents = 0;

  if (isIdentity) {
    // Fast path: pixel ID is the flat index directly
    for (let i = 0; i < tofF64.length; i++) {
      const t = tofF64[i];
      if (t < tofLow || t > tofHigh) continue;
      const pid = eventIdF64[i] - panelPixelIdMin;
      if (pid >= 0 && pid < totalPixels) {
        image[pid]++;
        totalEvents++;
      }
    }
  } else {
    // General path: use cached pixel-to-flat map
    for (let i = 0; i < tofF64.length; i++) {
      const t = tofF64[i];
      if (t < tofLow || t > tofHigh) continue;
      const pid = eventIdF64[i] - panelPixelIdMin;
      if (pid >= 0 && pid < totalPixels) {
        const flatIdx = pixelToFlat[pid];
        if (flatIdx >= 0) {
          image[flatIdx]++;
          totalEvents++;
        }
      }
    }
  }
  console.timeEnd('computeDetectorImage');
  return { image, shape: [rows, cols], totalEvents };
}
