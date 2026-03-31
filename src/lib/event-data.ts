import type { EventData } from "./h5wasm-loader";

/**
 * Convert BigInt64Array to number[] if needed for arithmetic.
 */
function toNumberArray(
  arr: Int32Array | BigInt64Array | Float64Array
): Float64Array {
  if (arr instanceof Float64Array) return arr;
  const out = new Float64Array(arr.length);
  if (arr instanceof BigInt64Array) {
    for (let i = 0; i < arr.length; i++) {
      out[i] = Number(arr[i]);
    }
  } else {
    for (let i = 0; i < arr.length; i++) {
      out[i] = arr[i];
    }
  }
  return out;
}

export interface TofHistogramResult {
  binEdges: Float64Array; // length = numBins + 1
  counts: Float64Array; // length = numBins
  tofMin: number;
  tofMax: number;
}

/**
 * Compute a TOF histogram from event data.
 */
export function computeTofHistogram(
  eventData: EventData,
  numBins: number = 500
): TofHistogramResult {
  const tof = toNumberArray(eventData.eventTimeOffset);

  let tofMin = Infinity;
  let tofMax = -Infinity;
  for (let i = 0; i < tof.length; i++) {
    if (tof[i] < tofMin) tofMin = tof[i];
    if (tof[i] > tofMax) tofMax = tof[i];
  }

  // Add small epsilon to max so the max value falls in the last bin
  const range = tofMax - tofMin;
  const binWidth = range / numBins;
  const binEdges = new Float64Array(numBins + 1);
  for (let i = 0; i <= numBins; i++) {
    binEdges[i] = tofMin + i * binWidth;
  }

  const counts = new Float64Array(numBins);
  for (let i = 0; i < tof.length; i++) {
    const bin = Math.floor((tof[i] - tofMin) / binWidth);
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
 * Build a reverse lookup from pixel ID to flat detector index.
 * detector_number[flatIdx] = pixelId => pixelToFlat[pixelId - panelMin] = flatIdx
 */
function buildPixelMap(
  detectorNumber: Int32Array,
  panelMin: number,
  totalPixels: number
): Int32Array {
  const pixelToFlat = new Int32Array(totalPixels);
  pixelToFlat.fill(-1);
  for (let i = 0; i < detectorNumber.length; i++) {
    const pid = detectorNumber[i] - panelMin;
    if (pid >= 0 && pid < totalPixels) {
      pixelToFlat[pid] = i;
    }
  }
  return pixelToFlat;
}

/**
 * Bin events into a 2D detector image for a given TOF range.
 * Uses the detector_number mapping to convert event_id -> (row, col).
 */
export function computeDetectorImage(
  eventData: EventData,
  tofRange: [number, number]
): DetectorImageResult {
  const [rows, cols] = eventData.detectorShape;
  const totalPixels = rows * cols;
  const image = new Float64Array(totalPixels);
  const eventId = toNumberArray(eventData.eventId);
  const tof = toNumberArray(eventData.eventTimeOffset);
  const panelMin = eventData.panelPixelIdMin;

  const pixelToFlat = buildPixelMap(
    eventData.detectorNumber,
    panelMin,
    totalPixels
  );

  // Check if the pixel map is identity (pixelToFlat[i] === i for all i)
  let isIdentity = true;
  for (let i = 0; i < totalPixels; i++) {
    if (pixelToFlat[i] !== i) {
      isIdentity = false;
      break;
    }
  }

  const [tofLow, tofHigh] = tofRange;
  let totalEvents = 0;
  let skippedOutOfRange = 0;
  let skippedUnmapped = 0;

  for (let i = 0; i < eventId.length; i++) {
    const t = tof[i];
    if (t < tofLow || t > tofHigh) continue;

    const pid = eventId[i] - panelMin;
    if (pid < 0 || pid >= totalPixels) {
      skippedOutOfRange++;
      continue;
    }

    if (isIdentity) {
      // Direct mapping: pixel ID IS the flat index
      image[pid]++;
      totalEvents++;
    } else {
      const flatIdx = pixelToFlat[pid];
      if (flatIdx >= 0) {
        image[flatIdx]++;
        totalEvents++;
      } else {
        skippedUnmapped++;
      }
    }
  }

  console.log(
    `[DetectorImage] totalEvents=${totalEvents}, eventsInData=${eventId.length}, ` +
    `skippedOutOfRange=${skippedOutOfRange}, skippedUnmapped=${skippedUnmapped}, ` +
    `isIdentity=${isIdentity}, panelMin=${panelMin}, totalPixels=${totalPixels}, ` +
    `imageMax=${Math.max(...image.slice(0, 1000))}, tofRange=[${tofLow}, ${tofHigh}]`
  );

  return { image, shape: [rows, cols], totalEvents };
}
