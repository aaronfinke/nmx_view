import h5wasm, {
  File as H5File,
  Group as H5Group,
  Dataset as H5Dataset,
  FS,
} from "h5wasm";

let h5wasmReady: Promise<void> | null = null;

export async function initH5Wasm(): Promise<void> {
  if (!h5wasmReady) {
    h5wasmReady = h5wasm.ready.then(() => {});
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

  const group = instrument;
  const keys = group.keys();
  for (const key of keys) {
    if (!key.startsWith("detector_panel")) continue;
    const panelPath = `entry/instrument/${key}`;
    const dataGroup = h5file.get(`${panelPath}/data`);
    if (!dataGroup) continue;

    const dataG = dataGroup as H5Group;
    const attrs = dataG.attrs;
    const nxClass = attrs?.["NX_class"];
    // Check it's NXevent_data
    if (nxClass) {
      const nxVal = nxClass.value;
      if (typeof nxVal === "string" && nxVal !== "NXevent_data") continue;
    }

    const eventIdDs = dataG.get("event_id") as H5Dataset | null;
    if (!eventIdDs) continue;

    const detNumDs = h5file.get(`${panelPath}/detector_number`) as
      | H5Dataset
      | undefined;
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
  eventId: Int32Array | BigInt64Array;
  eventTimeOffset: Int32Array | BigInt64Array;
  detectorNumber: Int32Array;
  detectorShape: [number, number];
  panelPixelIdMin: number;
}

export function readEventData(h5file: H5File, panelPath: string): EventData {
  const eventIdDs = h5file.get(
    `${panelPath}/data/event_id`
  ) as H5Dataset;
  const etoDs = h5file.get(
    `${panelPath}/data/event_time_offset`
  ) as H5Dataset;
  const detNumDs = h5file.get(
    `${panelPath}/detector_number`
  ) as H5Dataset;

  const eventId = eventIdDs.value as Int32Array | BigInt64Array;
  const eventTimeOffset = etoDs.value as Int32Array | BigInt64Array;
  const detectorNumber = detNumDs.value as Int32Array;
  const detectorShape: [number, number] = [
    detNumDs.shape![0],
    detNumDs.shape![1],
  ];

  // Find panelPixelIdMin from detector_number
  let minId = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < detectorNumber.length; i++) {
    if (detectorNumber[i] < minId) minId = detectorNumber[i];
  }

  return {
    eventId,
    eventTimeOffset,
    detectorNumber,
    detectorShape,
    panelPixelIdMin: minId,
  };
}
