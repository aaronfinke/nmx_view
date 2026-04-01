import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import "@h5web/lib/dist/styles.css";
import { ScaleType } from "@h5web/lib";
import { ViridisColorBar } from "./components/ViridisColorBar";
import type { ColorScaleType, Domain } from "@h5web/lib";
import { FileLoader } from "./components/FileLoader";
import { DetectorImage } from "./components/DetectorImage";
import { TofRangeSlider } from "./components/TofRangeSlider";
import {
  openFile,
  findDetectorPanels,
  readEventData,
  type DetectorPanelInfo,
  type EventData,
} from "./lib/h5wasm-loader";
import {
  computeTofHistogram,
  computeDetectorImage,
  type DetectorImageResult,
} from "./lib/event-data";
import type { File as H5File } from "h5wasm";
import "./App.css";

/** Reserve px for header, TOF slider, status bar, padding */
const CHROME_HEIGHT = 160;
/** Width reserved for the shared color bar + domain inputs */
const COLORBAR_WIDTH = 80;

function useChartSize(panelCount: number) {
  const compute = () => {
    const gap = 8; // gap between panels
    const totalGap = (Math.max(panelCount, 1) - 1) * gap;
    const availW = window.innerWidth - 40 - totalGap - COLORBAR_WIDTH;
    const availH = window.innerHeight - CHROME_HEIGHT;
    const perPanel = availW / Math.max(panelCount, 1);
    const s = Math.min(perPanel, availH);
    return Math.max(Math.floor(s), 100);
  };

  const [size, setSize] = useState(compute);

  useEffect(() => {
    const onResize = () => setSize(compute());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelCount]);

  // Recompute when panelCount changes
  useEffect(() => {
    setSize(compute());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelCount]);

  return size;
}

function App() {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [panels, setPanels] = useState<DetectorPanelInfo[]>([]);
  const [detectorImages, setDetectorImages] = useState<
    (DetectorImageResult | null)[]
  >([]);
  const [tofRange, setTofRange] = useState<[number, number]>([0, 0]);
  const [tofUnit, setTofUnit] = useState("µs");
  const [tofAbsMin, setTofAbsMin] = useState(0);
  const [tofAbsMax, setTofAbsMax] = useState(0);
  const [colorScale, setColorScale] = useState<ColorScaleType>(ScaleType.Linear);
  const [numBins] = useState(500);
  const [imageComputing, setImageComputing] = useState(false);
  const [domainMin, setDomainMin] = useState<string>("");
  const [domainMax, setDomainMax] = useState<string>("");
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadProgressLabel, setLoadProgressLabel] = useState("");
  const [fileName, setFileName] = useState("");

  const chartSize = useChartSize(panels.length);

  const h5fileRef = useRef<H5File | null>(null);
  const eventDataRef = useRef<Map<number, EventData>>(new Map());
  const browserFileRef = useRef<File | null>(null);

  /** Yield to the event loop so React can render progress updates */
  const yieldToUI = () =>
    new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  /** Load ALL panels from the file */
  const loadAllPanels = useCallback(
    async (h5file: H5File, foundPanels: DetectorPanelInfo[]) => {
      eventDataRef.current = new Map();
      let globalTofMin = Infinity;
      let globalTofMax = -Infinity;
      const totalSteps = foundPanels.length * 2 + 1; // read + image per panel + final
      let step = 0;

      // Read event data for all panels
      for (let i = 0; i < foundPanels.length; i++) {
        const label = `Reading ${foundPanels[i].name} (${foundPanels[i].numEvents.toLocaleString()} events)...`;
        setLoadProgressLabel(label);
        setLoadProgress(((++step) / totalSteps) * 100);
        setStatus(label);
        await yieldToUI();

        const ed = readEventData(h5file, foundPanels[i].path);
        eventDataRef.current.set(i, ed);
        const hist = computeTofHistogram(ed, numBins);
        if (hist.tofMin < globalTofMin) globalTofMin = hist.tofMin;
        if (hist.tofMax > globalTofMax) globalTofMax = hist.tofMax;
      }

      const range: [number, number] = [globalTofMin, globalTofMax];
      setTofRange(range);
      setTofAbsMin(globalTofMin);
      setTofAbsMax(globalTofMax);

      // Compute images for all panels
      const images: DetectorImageResult[] = [];
      for (let i = 0; i < foundPanels.length; i++) {
        const label = `Computing image for ${foundPanels[i].name}...`;
        setLoadProgressLabel(label);
        setLoadProgress(((++step) / totalSteps) * 100);
        setStatus(label);
        await yieldToUI();

        const ed = eventDataRef.current.get(i)!;
        images.push(computeDetectorImage(ed, range));
      }
      setDetectorImages(images);

      setLoadProgress(100);
      setLoadProgressLabel("Done!");
      const totalEvents = images.reduce((s, img) => s + img.totalEvents, 0);
      setStatus(
        `Loaded ${foundPanels.length} panels — ${totalEvents.toLocaleString()} total events`
      );
    },
    [numBins]
  );

  const handleFileLoaded = useCallback(
    async (file: File) => {
      setLoading(true);
      setStatus("Opening HDF5 file...");
      try {
        browserFileRef.current = file;
        setFileName(file.name);
        const h5file = await openFile(file);
        h5fileRef.current = h5file;

        setStatus("Scanning for detector panels...");
        const foundPanels = findDetectorPanels(h5file);

        if (foundPanels.length === 0) {
          setStatus("No NXEventData detector panels found in this file.");
          setLoading(false);
          return;
        }

        setLoadProgress(0);
        setLoadProgressLabel("Starting...");
        await loadAllPanels(h5file, foundPanels);
        setPanels(foundPanels);
      } catch (err) {
        setStatus(`Error: ${(err as Error).message}`);
        console.error(err);
      } finally {
        setLoading(false);
      }
    },
    [loadAllPanels]
  );

  const handleReload = useCallback(async () => {
    if (!browserFileRef.current) return;
    setLoading(true);
    setStatus("Reloading file...");
    try {
      if (h5fileRef.current) {
        h5fileRef.current.close();
        h5fileRef.current = null;
      }
      const file = browserFileRef.current;
      const h5file = await openFile(file);
      h5fileRef.current = h5file;

      const foundPanels = findDetectorPanels(h5file);
      if (foundPanels.length === 0) {
        setStatus("No NXEventData detector panels found after reload.");
        setLoading(false);
        return;
      }

      setPanels(foundPanels);
      setLoadProgress(0);
      setLoadProgressLabel("Reloading...");
      await loadAllPanels(h5file, foundPanels);
    } catch (err) {
      setStatus(`Reload error: ${(err as Error).message}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [loadAllPanels]);

  const handleTofRangeChange = useCallback(
    (range: [number, number]) => {
      setTofRange(range);
      setImageComputing(true);
      setTimeout(() => {
        const images: (DetectorImageResult | null)[] = [];
        for (let i = 0; i < panels.length; i++) {
          const ed = eventDataRef.current.get(i);
          if (ed) {
            images.push(computeDetectorImage(ed, range));
          } else {
            images.push(null);
          }
        }
        setDetectorImages(images);
        setImageComputing(false);
        const totalEvents = images.reduce(
          (s, img) => s + (img?.totalEvents ?? 0),
          0
        );
        setStatus(
          `${panels.length} panels — ${totalEvents.toLocaleString()} events in TOF range`
        );
      }, 0);
    },
    [panels]
  );

  // Compute auto domain: min=0, max=min(vals.max(), mu + 2*sigma)
  const LOG_SCALES: readonly string[] = [ScaleType.Log, ScaleType.SymLog];
  const autoDomain: Domain = useMemo(() => {
    // Gather all non-zero pixel values across all panels
    const allVals: number[] = [];
    let valMax = 0;
    for (const img of detectorImages) {
      if (!img) continue;
      for (let j = 0; j < img.image.length; j++) {
        const v = img.image[j];
        if (v > valMax) valMax = v;
        if (v > 0) allVals.push(v);
      }
    }
    if (allVals.length === 0) return [0.1, 1];
    // Compute mean and std of non-zero values
    const n = allVals.length;
    let sum = 0;
    for (let j = 0; j < n; j++) sum += allVals[j];
    const mu = sum / n;
    let sumSq = 0;
    for (let j = 0; j < n; j++) sumSq += (allVals[j] - mu) ** 2;
    const sigma = Math.sqrt(sumSq / n);
    const hi = Math.min(valMax, mu + 2 * sigma);
    return [0, Math.max(hi, 1)];
  }, [detectorImages]);

  const sharedDomain: Domain = useMemo(() => {
    let lo = autoDomain[0];
    let hi = autoDomain[1];
    // Apply user overrides
    if (domainMin !== "") lo = Number(domainMin);
    if (domainMax !== "") hi = Number(domainMax);
    if (LOG_SCALES.includes(colorScale)) lo = Math.max(lo, 0.1);
    if (hi <= lo) hi = lo + 1;
    return [lo, hi];
  }, [autoDomain, colorScale, domainMin, domainMax]);

  const handleAutoDomain = useCallback(() => {
    setDomainMin("");
    setDomainMax("");
  }, []);

  // Show file loader during initial load (no panels yet) or while loading without images
  if (panels.length === 0 || (loading && detectorImages.every((d) => !d))) {
    return (
      <div className="app">
        <FileLoader
          onFileLoaded={handleFileLoaded}
          loading={loading}
          progress={loadProgress}
          progressLabel={loadProgressLabel}
        />
        {status && <div className="status-bar">{status}</div>}
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>NMX Event Data Viewer</h1>
        <div className="controls">
          <button
            className="reload-btn"
            onClick={() => {
              if (h5fileRef.current) {
                h5fileRef.current.close();
                h5fileRef.current = null;
              }
              browserFileRef.current = null;
              eventDataRef.current = new Map();
              setFileName("");
              setPanels([]);
              setDetectorImages([]);
              setTofRange([0, 0]);
              setTofAbsMin(0);
              setTofAbsMax(0);
              setDomainMin("");
              setDomainMax("");
              setStatus("");
            }}
            title="Load a different file"
          >
            &#x1F4C2; New File
          </button>
          <button
            className="reload-btn"
            onClick={handleReload}
            disabled={loading}
            title="Reload file (for SWMR / live data)"
          >
            &#x21bb; Reload
          </button>
          <div className="control-group">
            <label>TOF unit:</label>
            <select value={tofUnit} onChange={(e) => setTofUnit(e.target.value)}>
              <option value="ns">ns</option>
              <option value="µs">µs</option>
              <option value="ms">ms</option>
            </select>
          </div>
          <div className="control-group">
            <label>Color scale:</label>
            <select
              value={colorScale}
              onChange={(e) => setColorScale(e.target.value as ColorScaleType)}
            >
              <option value={ScaleType.Log}>Log</option>
              <option value={ScaleType.Linear}>Linear</option>
              <option value={ScaleType.SymLog}>SymLog</option>
              <option value={ScaleType.Sqrt}>Sqrt</option>
            </select>
          </div>
          {fileName && <span className="file-name-badge">{fileName}</span>}
        </div>
      </header>

      <main className="app-main">
        {detectorImages.length > 0 && (
          <>
            <div className="detector-panels-row">
              {imageComputing && (
                <div className="computing-overlay">Recomputing...</div>
              )}
              {panels.map((panel, i) => {
                const img = detectorImages[i];
                if (!img) return null;
                return (
                  <DetectorImage
                    key={panel.path}
                    imageResult={img}
                    panelName={panel.name}
                    colorScale={colorScale}
                    size={chartSize}
                    domain={sharedDomain}
                  />
                );
              })}
              <div className="shared-colorbar" style={{ height: chartSize }}>
                <input
                  type="number"
                  className="colorbar-domain-input colorbar-domain-max"
                  value={domainMax}
                  placeholder={String(Math.round(sharedDomain[1]))}
                  title="Color bar max"
                  onChange={(e) => setDomainMax(e.target.value)}
                />
                <div className="colorbar-gradient-wrapper">
                  <ViridisColorBar width={30} height={chartSize - 70} />
                </div>
                <input
                  type="number"
                  className="colorbar-domain-input colorbar-domain-min"
                  value={domainMin}
                  placeholder={String(Math.round(sharedDomain[0]))}
                  title="Color bar min"
                  onChange={(e) => setDomainMin(e.target.value)}
                />
                <button
                  className="colorbar-auto-btn"
                  onClick={handleAutoDomain}
                  title="Reset to optimal range (µ + 2σ)"
                >
                  Auto
                </button>
              </div>
            </div>
            <TofRangeSlider
              tofMin={tofAbsMin}
              tofMax={tofAbsMax}
              tofRange={tofRange}
              onTofRangeChange={handleTofRangeChange}
              unit={tofUnit}
            />
          </>
        )}
      </main>

      <div className="status-bar">{status}</div>
    </div>
  );
}

export default App;
