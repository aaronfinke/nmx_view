import type { EventData } from "./h5wasm-loader";

export interface TofHistogramResult {
  binEdges: Float64Array; // length = numBins + 1
  counts: Float64Array; // length = numBins
  tofMin: number;
  tofMax: number;
}

/**
 * Compute a TOF histogram from pre-processed event data.
 * Uses the pre-sorted TOF array for fast min/max.
 */
export function computeTofHistogram(
  eventData: EventData,
  numBins: number = 500
): TofHistogramResult {
  const { tofMin, tofMax, tofSorted } = eventData;

  const range = tofMax - tofMin;
  const binWidth = range / numBins;
  const binEdges = new Float64Array(numBins + 1);
  for (let i = 0; i <= numBins; i++) {
    binEdges[i] = tofMin + i * binWidth;
  }

  const counts = new Float64Array(numBins);
  for (let i = 0; i < tofSorted.length; i++) {
    const bin = Math.floor((tofSorted[i] - tofMin) / binWidth);
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

/**
 * Find the first index where tofSorted[index] >= value (lower bound).
 */
function lowerBound(arr: Float64Array, value: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Find the first index where tofSorted[index] > value (upper bound).
 */
function upperBound(arr: Float64Array, value: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Bin events into a 2D detector image for a given TOF range.
 * Uses binary search on pre-sorted TOF to find the event range in O(log N),
 * then iterates only the events within the range.
 * Uses cached pixel-to-flat mapping (computed once at load time).
 */
export function computeDetectorImage(
  eventData: EventData,
  tofRange: [number, number]
): DetectorImageResult {
  const { detectorShape, panelPixelIdMin, pixelToFlat, isIdentity,
          eventIdF64, tofSorted, sortedIndices } = eventData;
  const [rows, cols] = detectorShape;
  const totalPixels = rows * cols;
  const image = new Float64Array(totalPixels);

  const [tofLow, tofHigh] = tofRange;

  // Binary search: find slice of sorted events within [tofLow, tofHigh]
  const iStart = lowerBound(tofSorted, tofLow);
  const iEnd = upperBound(tofSorted, tofHigh);

  let totalEvents = 0;

  if (isIdentity) {
    // Fast path: pixel ID is the flat index directly
    for (let s = iStart; s < iEnd; s++) {
      const origIdx = sortedIndices[s];
      const pid = eventIdF64[origIdx] - panelPixelIdMin;
      if (pid >= 0 && pid < totalPixels) {
        image[pid]++;
        totalEvents++;
      }
    }
  } else {
    // General path: use cached pixel-to-flat map
    for (let s = iStart; s < iEnd; s++) {
      const origIdx = sortedIndices[s];
      const pid = eventIdF64[origIdx] - panelPixelIdMin;
      if (pid >= 0 && pid < totalPixels) {
        const flatIdx = pixelToFlat[pid];
        if (flatIdx >= 0) {
          image[flatIdx]++;
          totalEvents++;
        }
      }
    }
  }

  console.log(
    `[DetectorImage] totalEvents=${totalEvents}, rangeEvents=${iEnd - iStart}, ` +
    `totalInData=${eventIdF64.length}, isIdentity=${isIdentity}, ` +
    `tofRange=[${tofLow}, ${tofHigh}]`
  );

  return { image, shape: [rows, cols], totalEvents };
}
