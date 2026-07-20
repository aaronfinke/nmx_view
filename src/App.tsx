import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import "@h5web/lib/dist/styles.css";
import { ScaleType } from "@h5web/lib";
import { ColorBar } from "./components/ViridisColorBar";
import type { ColorMap, ColorScaleType, Domain } from "@h5web/lib";
import { FileLoader } from "./components/FileLoader";
import { DetectorImage } from "./components/DetectorImage";
import { TofRangeSlider } from "./components/TofRangeSlider";
import { LineScanPlot, LINE_SCAN_PLOT_WIDTH } from "./components/LineScanPlot";
import { TofProfilePlot } from "./components/TofProfilePlot";
import {
  openFile,
  detectFileType,
  findDetectorPanels,
  readEventData,
  findLauetofPanels,
  readLauetofSingleSlice,
  readLauetofBoxTofProfile,
  type NexusFileType,
  type DetectorPanelInfo,
  type LauetofPanelInfo,
  type EventData,
} from "./lib/h5wasm-loader";
import {
  computeTofHistogram,
  computeDetectorImage,
  computeBoxTofProfile,
  type DetectorImageResult,
  type BoxRegion,
} from "./lib/event-data";
import type { File as H5File } from "h5wasm";
import "./App.css";

/** Reserve px for header, TOF slider, status bar, padding */
const CHROME_HEIGHT = 160;
/** Width reserved for the shared color bar + domain inputs */
const COLORBAR_WIDTH = 80;
/** Draggable divider width between the detector and the analysis column */
const RESIZER_WIDTH = 8;
/** Smallest the analysis (Box / TOF) column may be dragged */
const MIN_ANALYSIS_WIDTH = 260;
/** Room reserved inside the column for its vertical scrollbar, so plots never clip */
const ANALYSIS_GUTTER = 18;

function useChartSize(panelCount: number, isOverview: boolean, extraWidthReserve = 0) {
  const compute = () => {
    const gap = 8;
    const availW = window.innerWidth - 40 - COLORBAR_WIDTH - extraWidthReserve;
    const availH = window.innerHeight - CHROME_HEIGHT;

    // Overview uses a multi-row grid. Keep panel size moderate so rows can stack
    // and the main viewport scrolls vertically for large panel counts.
    if (isOverview) {
      const cols = Math.min(3, Math.max(panelCount, 1));
      const totalGap = (cols - 1) * gap;
      const perPanel = (availW - totalGap) / cols;
      const s = Math.min(perPanel, 480);
      return Math.max(Math.floor(s), 180);
    }

    // Reserve vertical room for panel title and layout padding in single view
    const singleViewVerticalReserve = 48;
    const safeH = Math.max(availH - singleViewVerticalReserve, 100);
    const s = Math.min(availW, safeH);
    return Math.max(Math.floor(s), 100);
  };

  const [size, setSize] = useState(compute);

  useEffect(() => {
    const onResize = () => setSize(compute());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelCount, isOverview, extraWidthReserve]);

  // Recompute when panelCount changes
  useEffect(() => {
    setSize(compute());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelCount, isOverview, extraWidthReserve]);

  return size;
}

function App() {
  const RECOMPUTE_OVERLAY_DELAY_MS = 1000;
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [fileType, setFileType] = useState<NexusFileType>("unknown");
  // NXevent_data state
  const [panels, setPanels] = useState<DetectorPanelInfo[]>([]);
  // NXlauetof state
  const [lauetofPanels, setLauetofPanels] = useState<LauetofPanelInfo[]>([]);
  // Shared state
  const [detectorImages, setDetectorImages] = useState<
    (DetectorImageResult | null)[]
  >([]);
  const [tofRange, setTofRange] = useState<[number, number]>([0, 0]);
  const tofUnit = "µs";
  const [tofAbsMin, setTofAbsMin] = useState(0);
  const [tofAbsMax, setTofAbsMax] = useState(0);
  const [colorScale] = useState<ColorScaleType>(ScaleType.Linear);
  const [colorMap, setColorMap] = useState<ColorMap | "Greys_r">("Viridis");
  const [numBins] = useState(500);
  const [imageComputing, setImageComputing] = useState(false);
  const [domainMin, setDomainMin] = useState<string>("");
  const [domainMax, setDomainMax] = useState<string>("");
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadProgressLabel, setLoadProgressLabel] = useState("");
  const [fileName, setFileName] = useState("");
  const [viewMode, setViewMode] = useState<"overview" | number>("overview");
  const [showHelp, setShowHelp] = useState(false);
  // Line scan / box integration state (single-panel only)
  const [lineScanProfile, setLineScanProfile] = useState<number[] | null>(null);
  const [lineScanLength, setLineScanLength] = useState(0);
  const [boxProfile, setBoxProfile] = useState<number[] | null>(null);
  const [boxColStart, setBoxColStart] = useState(0);
  const [boxColEnd, setBoxColEnd] = useState(0);
  const [boxAxis, setBoxAxis] = useState<"slow" | "fast">("slow");
  const [clearLineSignal, setClearLineSignal] = useState(0);
  // Integrated-counts-vs-TOF profile for the selected box (single-panel only)
  const [tofProfile, setTofProfile] = useState<{ tof: Float64Array; counts: Float64Array } | null>(null);
  const [tofRoi, setTofRoi] = useState<[number, number] | null>(null);
  // User-resizable width of the analysis (Box / TOF profile) column.
  const [analysisWidth, setAnalysisWidth] = useState(LINE_SCAN_PLOT_WIDTH);

  const hasPanels =
    fileType === "NXlauetof" ? lauetofPanels.length > 0 : panels.length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "h" || e.key === "H") {
        e.preventDefault();
        setShowHelp((v) => !v);
      }
      if (e.key === "Escape") setShowHelp(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!hasPanels) return;

    const preventWindowFileDrop = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "dragover") e.dataTransfer.dropEffect = "copy";
    };

    // Capture phase ensures we block browser default navigation/download behavior.
    window.addEventListener("dragover", preventWindowFileDrop, true);
    window.addEventListener("drop", preventWindowFileDrop, true);
    return () => {
      window.removeEventListener("dragover", preventWindowFileDrop, true);
      window.removeEventListener("drop", preventWindowFileDrop, true);
    };
  }, [hasPanels]);

  const activePanelCount = fileType === "NXlauetof" ? lauetofPanels.length : panels.length;
  const isOverview = viewMode === "overview";
  const displayPanelCount = viewMode === "overview" ? activePanelCount : 1;
  // Reserve space for the resizable analysis column in single-panel mode
  // (column width + divider + inter-panel gaps).
  const lineScanReserve = isOverview ? 0 : analysisWidth + RESIZER_WIDTH + 24;
  const chartSize = useChartSize(displayPanelCount, isOverview, lineScanReserve);

  // Clear line scan state whenever the user switches view mode.
  useEffect(() => {
    setLineScanProfile(null);
    setClearLineSignal((s) => s + 1);
    boxRegionRef.current = null;
    setTofProfile(null);
    setTofRoi(null);
  }, [viewMode]);

  // Keep the TOF-profile ROI in sync with the bottom TOF slider. Fires only on
  // slider changes (tofRange), not when a fresh box resets the ROI to full range.
  useEffect(() => {
    if (!tofProfile) return;
    const lo = tofProfile.tof[0];
    const hi = tofProfile.tof[tofProfile.tof.length - 1];
    setTofRoi([
      Math.max(lo, Math.min(hi, tofRange[0])),
      Math.max(lo, Math.min(hi, tofRange[1])),
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tofRange]);

  const h5fileRef = useRef<H5File | null>(null);
  const eventDataRef = useRef<Map<number, EventData>>(new Map());
  const browserFileRef = useRef<File | null>(null);
  // Last box region a TOF profile was computed for — avoids recomputing when
  // onBoxDrawn re-fires only because the underlying image changed.
  const boxRegionRef = useRef<BoxRegion | null>(null);
  // Active drag origin for the analysis-column resizer.
  const resizeStartRef = useRef<{ x: number; w: number } | null>(null);
  const recomputeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recomputeRunIdRef = useRef(0);

  const clearRecomputeTimer = useCallback(() => {
    if (recomputeTimerRef.current) {
      clearTimeout(recomputeTimerRef.current);
      recomputeTimerRef.current = null;
    }
  }, []);

  const beginRecompute = useCallback(
    (type: NexusFileType) => {
      const runId = ++recomputeRunIdRef.current;
      clearRecomputeTimer();
      setImageComputing(false);
      if (type !== "NXlauetof") {
        recomputeTimerRef.current = setTimeout(() => {
          if (recomputeRunIdRef.current === runId) {
            setImageComputing(true);
          }
        }, RECOMPUTE_OVERLAY_DELAY_MS);
      }
      return runId;
    },
    [clearRecomputeTimer]
  );

  const endRecompute = useCallback(
    (runId: number) => {
      if (recomputeRunIdRef.current !== runId) return;
      clearRecomputeTimer();
      setImageComputing(false);
    },
    [clearRecomputeTimer]
  );

  useEffect(() => {
    return () => {
      clearRecomputeTimer();
    };
  }, [clearRecomputeTimer]);

  /** Yield to the event loop so React can render progress updates */
  const yieldToUI = () =>
    new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  /** Load ALL NXevent_data panels from the file */
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

  /** Load ALL NXlauetof panels — read TOF bins and show first slice */
  const loadAllLauetofPanels = useCallback(
    async (h5file: H5File, foundPanels: LauetofPanelInfo[]) => {
      const totalSteps = foundPanels.length + 1;
      let step = 0;

      // Compute global TOF range across all panels
      let globalTofMin = Infinity;
      let globalTofMax = -Infinity;
      for (const p of foundPanels) {
        const pMin = p.tofBins[0];
        const pMax = p.tofBins[p.tofBins.length - 1];
        if (pMin < globalTofMin) globalTofMin = pMin;
        if (pMax > globalTofMax) globalTofMax = pMax;
      }

      // Bin width = spacing between consecutive TOF bin centers
      const binWidth = foundPanels[0].tofBins.length > 1
        ? foundPanels[0].tofBins[1] - foundPanels[0].tofBins[0]
        : 1;

      setTofAbsMin(globalTofMin);
      setTofAbsMax(globalTofMax);
      // Set initial range to first bin
      const initialRange: [number, number] = [
        globalTofMin,
        globalTofMin + binWidth,
      ];
      setTofRange(initialRange);

      // Read first slice for all panels
      const images: DetectorImageResult[] = [];
      for (let i = 0; i < foundPanels.length; i++) {
        const p = foundPanels[i];
        const label = `Reading ${p.name} slice 1/${p.shape[2]}...`;
        setLoadProgressLabel(label);
        setLoadProgress(((++step) / totalSteps) * 100);
        setStatus(label);
        await yieldToUI();

        images.push(readLauetofSingleSlice(h5file, p.path, 0));
      }
      setDetectorImages(images);

      setLoadProgress(100);
      setLoadProgressLabel("Done!");
      const totalCounts = images.reduce((s, img) => s + img.totalEvents, 0);
      setStatus(
        `Loaded ${foundPanels.length} panels — slice 1/${foundPanels[0]?.shape[2] ?? 0} — ${totalCounts.toLocaleString()} counts`
      );
    },
    []
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

        setStatus("Detecting file type...");
        const detectedType = detectFileType(h5file);
        setFileType(detectedType);

        setLoadProgress(0);
        setLoadProgressLabel("Starting...");

        if (detectedType === "NXlauetof") {
          const foundPanels = findLauetofPanels(h5file);
          if (foundPanels.length === 0) {
            setStatus("No detector panels found in NXlauetof file.");
            setLoading(false);
            return;
          }
          await loadAllLauetofPanels(h5file, foundPanels);
          setLauetofPanels(foundPanels);
        } else {
          setStatus("Scanning for detector panels...");
          const foundPanels = findDetectorPanels(h5file);
          if (foundPanels.length === 0) {
            setStatus("No NXevent_data detector panels found in this file.");
            setLoading(false);
            return;
          }
          await loadAllPanels(h5file, foundPanels);
          setPanels(foundPanels);
        }
      } catch (err) {
        setStatus(`Error: ${(err as Error).message}`);
        console.error(err);
      } finally {
        setLoading(false);
      }
    },
    [loadAllPanels, loadAllLauetofPanels]
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

      const detectedType = detectFileType(h5file);
      setFileType(detectedType);
      setLoadProgress(0);
      setLoadProgressLabel("Reloading...");

      if (detectedType === "NXlauetof") {
        const foundPanels = findLauetofPanels(h5file);
        if (foundPanels.length === 0) {
          setStatus("No detector panels found after reload.");
          setLoading(false);
          return;
        }
        setLauetofPanels(foundPanels);
        await loadAllLauetofPanels(h5file, foundPanels);
      } else {
        const foundPanels = findDetectorPanels(h5file);
        if (foundPanels.length === 0) {
          setStatus("No NXevent_data detector panels found after reload.");
          setLoading(false);
          return;
        }
        setPanels(foundPanels);
        await loadAllPanels(h5file, foundPanels);
      }
    } catch (err) {
      setStatus(`Reload error: ${(err as Error).message}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [loadAllPanels, loadAllLauetofPanels]);

  const handleTofRangeChange = useCallback(
    (range: [number, number]) => {
      setTofRange(range);
      const runId = beginRecompute(fileType);
      setTimeout(() => {
        if (recomputeRunIdRef.current !== runId) return;
        if (fileType === "NXlauetof" && h5fileRef.current) {
          // NXlauetof: find closest bin center and read that single slice
          const center = (range[0] + range[1]) / 2;
          setDetectorImages((prev) => {
            const images = [...prev];
            for (let i = 0; i < lauetofPanels.length; i++) {
              // In single-panel mode, skip panels not being viewed
              if (viewMode !== "overview" && i !== viewMode) continue;
              const p = lauetofPanels[i];
              let bestIdx = 0;
              let bestDist = Math.abs(p.tofBins[0] - center);
              for (let j = 1; j < p.tofBins.length; j++) {
                const dist = Math.abs(p.tofBins[j] - center);
                if (dist < bestDist) {
                  bestDist = dist;
                  bestIdx = j;
                }
              }
              images[i] = readLauetofSingleSlice(h5fileRef.current!, p.path, bestIdx);
            }
            return images;
          });
          endRecompute(runId);
          const sliceIdx = (() => {
            const p = lauetofPanels[0];
            if (!p) return 0;
            let best = 0;
            let bestD = Math.abs(p.tofBins[0] - center);
            for (let j = 1; j < p.tofBins.length; j++) {
              const d = Math.abs(p.tofBins[j] - center);
              if (d < bestD) { bestD = d; best = j; }
            }
            return best;
          })();
          setStatus(`${lauetofPanels.length} panels — slice ${sliceIdx + 1}/${lauetofPanels[0]?.shape[2] ?? 0}`);
        } else {
          // NXevent_data: bin events only for visible panel(s)
          setDetectorImages((prev) => {
            const images = [...prev];
            for (let i = 0; i < panels.length; i++) {
              // In single-panel mode, skip panels not being viewed
              if (viewMode !== "overview" && i !== viewMode) continue;
              const ed = eventDataRef.current.get(i);
              if (ed) {
                images[i] = computeDetectorImage(ed, range);
              }
            }
            return images;
          });
          endRecompute(runId);
          const totalEvents = detectorImages.reduce(
            (s, img) => s + (img?.totalEvents ?? 0),
            0
          );
          setStatus(
            `${panels.length} panels — ${totalEvents.toLocaleString()} events in TOF range`
          );
        }
      }, 0);
    },
    [beginRecompute, endRecompute, fileType, panels, lauetofPanels, viewMode, detectorImages]
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

  const handleLineDrawn = useCallback(
    (
      profile: number[],
      _startPx: [number, number],
      _endPx: [number, number],
      lengthPx: number
    ) => {
      setLineScanProfile(profile);
      setLineScanLength(Math.round(lengthPx));
      setBoxProfile(null);
      // A line replaces the box — drop its TOF profile.
      boxRegionRef.current = null;
      setTofProfile(null);
      setTofRoi(null);
    },
    []
  );

  /**
   * Compute the integrated-counts-vs-TOF profile for the current box region.
   * For raw events an optional `range` re-bins over just that TOF window (finer
   * bins on zoom); NXlauetof bins are fixed by the file, so `range` is ignored.
   */
  const computeBoxTof = useCallback(
    (box: BoxRegion, range?: [number, number] | null) => {
      try {
        if (typeof viewMode !== "number") return;
        if (fileType === "NXlauetof" && h5fileRef.current) {
          const panel = lauetofPanels[viewMode];
          if (!panel) return;
          const counts = readLauetofBoxTofProfile(h5fileRef.current, panel.path, box);
          setTofProfile({ tof: panel.tofBins, counts });
          setTofRoi([panel.tofBins[0], panel.tofBins[panel.tofBins.length - 1]]);
        } else {
          const ed = eventDataRef.current.get(viewMode);
          if (!ed) return;
          const { tof, counts } = computeBoxTofProfile(ed, box, 256, range ?? undefined);
          setTofProfile({ tof, counts });
          setTofRoi([tof[0], tof[tof.length - 1]]);
        }
      } catch (err) {
        console.error("TOF profile error:", err);
        setTofProfile(null);
        setTofRoi(null);
      }
    },
    [fileType, viewMode, lauetofPanels]
  );

  const handleBoxDrawn = useCallback(
    (
      profile: number[],
      axisStart: number,
      axisEnd: number,
      axis: "slow" | "fast",
      box: BoxRegion
    ) => {
      setBoxProfile(profile);
      setBoxColStart(axisStart);
      setBoxColEnd(axisEnd);
      setBoxAxis(axis);
      setLineScanProfile(null);
      // Recompute the TOF profile only when the box region itself changes,
      // not when onBoxDrawn re-fires because the displayed image changed.
      const prev = boxRegionRef.current;
      const changed =
        !prev || prev.r0 !== box.r0 || prev.r1 !== box.r1 ||
        prev.c0 !== box.c0 || prev.c1 !== box.c1;
      if (changed) {
        boxRegionRef.current = box;
        computeBoxTof(box);
      }
    },
    [computeBoxTof]
  );

  /** Re-bin the raw-event TOF profile over a zoom range (null = full range). */
  const handleTofZoom = useCallback(
    (range: [number, number] | null) => {
      const box = boxRegionRef.current;
      if (!box) return;
      computeBoxTof(box, range);
    },
    [computeBoxTof]
  );

  const handleLineScanClear = useCallback(() => {
    setLineScanProfile(null);
    setBoxProfile(null);
    setClearLineSignal((s) => s + 1);
    boxRegionRef.current = null;
    setTofProfile(null);
    setTofRoi(null);
  }, []);

  // ── Analysis-column resizer ─────────────────────────────────
  const handleResizerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      resizeStartRef.current = { x: e.clientX, w: analysisWidth };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [analysisWidth]
  );

  const handleResizerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const s = resizeStartRef.current;
    if (!s) return;
    // Dragging left widens the analysis column (and shrinks the detector).
    const delta = s.x - e.clientX;
    const maxW = Math.max(MIN_ANALYSIS_WIDTH, window.innerWidth - 460);
    setAnalysisWidth(Math.min(maxW, Math.max(MIN_ANALYSIS_WIDTH, s.w + delta)));
  }, []);

  const handleResizerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    resizeStartRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  // Show file loader during initial load (no panels yet) or while loading without images
  if (!hasPanels || (loading && detectorImages.every((d) => !d))) {
    return (
      <div className="app" data-filetype={fileType}>
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
    <div className="app" data-filetype={fileType}>
      <header className="app-header">
        <h1>NMX Event Data Viewer</h1>
        {fileName && <span className="file-name-badge">{fileName}</span>}
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
              setFileType("unknown");
              setPanels([]);
              setLauetofPanels([]);
              setDetectorImages([]);
              setTofRange([0, 0]);
              setTofAbsMin(0);
              setTofAbsMax(0);
              setDomainMin("");
              setDomainMax("");
              setStatus("");
              setViewMode("overview");
              setLineScanProfile(null);
              setBoxProfile(null);
              boxRegionRef.current = null;
              setTofProfile(null);
              setTofRoi(null);
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
            <label>View:</label>
            <select
              value={viewMode === "overview" ? "overview" : String(viewMode)}
              onChange={(e) => {
                const v = e.target.value;
                setViewMode(v === "overview" ? "overview" : Number(v));
              }}
            >
              <option value="overview">Overview</option>
              {(fileType === "NXlauetof" ? lauetofPanels : panels).map((p, i) => (
                <option key={p.path} value={i}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* <div className="control-group">
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
          </div> */}
          <div className="control-group">
            <label>Color map:</label>
            <select
              value={colorMap}
              onChange={(e) => setColorMap(e.target.value as ColorMap | "Greys_r")}
            >
              <option value="Viridis">Viridis</option>
              <option value="Inferno">Inferno</option>
              <option value="Greys_r">Greys</option>
            </select>
          </div>
          {fileType === "NXlauetof" && (
            <span className="filetype-badge">NXLaueTOF</span>
          )}
          <button
            className="help-btn"
            onClick={() => setShowHelp((v) => !v)}
            title="Help (H)"
          >
            ?
          </button>
        </div>
      </header>

      <main className={`app-main ${isOverview ? "overview-main" : "single-panel-main"}`}>
        {detectorImages.length > 0 && (
          <>
            <div className="detector-layout">
              {imageComputing && fileType !== "NXlauetof" && (
                <div className="computing-overlay">Recomputing...</div>
              )}
              <div className={`detector-panels-grid ${isOverview ? "overview" : "single"}`}>
                {(fileType === "NXlauetof" ? lauetofPanels : panels)
                  .map((panel, i) => ({ panel, i }))
                  .filter(({ i }) => viewMode === "overview" || i === viewMode)
                  .map(({ panel, i }) => {
                    const img = detectorImages[i];
                    if (!img) return null;
                    const lauetofPanel = fileType === "NXlauetof" ? lauetofPanels[i] : null;
                    return (
                      <DetectorImage
                        key={panel.path}
                        imageResult={img}
                        panelName={panel.name}
                        colorScale={colorScale}
                        colorMap={colorMap}
                        size={chartSize}
                        domain={sharedDomain}
                        singlePanel={viewMode !== "overview"}
                        panelGeometry={lauetofPanel?.geometry}
                        tofCenterNs={
                          lauetofPanel
                            ? (tofRange[0] + tofRange[1]) / 2
                            : undefined
                        }
                        enableLineScan={viewMode !== "overview"}
                        onLineDrawn={handleLineDrawn}
                        onBoxDrawn={handleBoxDrawn}
                        clearLine={clearLineSignal}
                      />
                    );
                  })}
              </div>
              <div
                className={`shared-colorbar ${isOverview ? "shared-colorbar-overview" : "shared-colorbar-single"}`}
                style={isOverview ? undefined : { height: chartSize }}
              >
                <input
                  type="number"
                  className="colorbar-domain-input colorbar-domain-max"
                  value={domainMax}
                  placeholder={String(Math.round(sharedDomain[1]))}
                  title="Color bar max"
                  onChange={(e) => setDomainMax(e.target.value)}
                />
                <div className="colorbar-gradient-wrapper">
                  <ColorBar width={30} colorMap={colorMap} />
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
              {/* Draggable divider — resize the detector vs. the analysis column */}
              {!isOverview && (
                <div
                  className="panel-resizer"
                  style={{ width: RESIZER_WIDTH, height: chartSize }}
                  onPointerDown={handleResizerDown}
                  onPointerMove={handleResizerMove}
                  onPointerUp={handleResizerUp}
                  onPointerCancel={handleResizerUp}
                  title="Drag to resize panels"
                  role="separator"
                  aria-orientation="vertical"
                />
              )}
              {/* Profile plots — line scan / box integration, plus box TOF profile.
                  Single-panel mode only. */}
              {!isOverview && (
                <div className="analysis-column" style={{ width: analysisWidth, maxHeight: chartSize + 36 }}>
                  <LineScanPlot
                    profile={boxProfile ?? lineScanProfile}
                    lineLength={boxProfile ? boxColEnd - boxColStart : lineScanLength}
                    height={Math.round((chartSize + 36) / 2)}
                    width={analysisWidth - ANALYSIS_GUTTER}
                    onClear={handleLineScanClear}
                    title={boxProfile ? "Box Profile" : "Line Profile"}
                    xAxisLabel={boxProfile ? (boxAxis === "slow" ? "Fast Axis (px)" : "Row (px)") : "Slow Axis (px)"}
                    xOffset={boxProfile ? boxColStart : 0}
                  />
                  {boxProfile && (
                    <TofProfilePlot
                      tof={tofProfile?.tof ?? null}
                      counts={tofProfile?.counts ?? null}
                      height={Math.round((chartSize + 36) / 2)}
                      width={analysisWidth - ANALYSIS_GUTTER}
                      roi={tofRoi}
                      onRoiChange={setTofRoi}
                      onApply={handleTofRangeChange}
                      onZoom={handleTofZoom}
                      rebinOnZoom={fileType !== "NXlauetof"}
                      unit={tofUnit}
                    />
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </main>

      {detectorImages.length > 0 && (
        <div className="tof-dock">
          <TofRangeSlider
            tofMin={tofAbsMin}
            tofMax={tofAbsMax}
            tofRange={tofRange}
            onTofRangeChange={handleTofRangeChange}
            unit={tofUnit}
            forceWindowMode={fileType === "NXlauetof"}
            fixedWindowWidthNs={
              fileType === "NXlauetof" && lauetofPanels.length > 0 && lauetofPanels[0].tofBins.length > 1
                ? lauetofPanels[0].tofBins[1] - lauetofPanels[0].tofBins[0]
                : undefined
            }
            snapValuesNs={
              fileType === "NXlauetof" && lauetofPanels.length > 0
                ? Array.from(lauetofPanels[0].tofBins)
                : undefined
            }
            totalFlightPathM={
              fileType === "NXlauetof" && lauetofPanels.length > 0 && lauetofPanels[0].geometry
                ? lauetofPanels[0].geometry.sourceDistance +
                  Math.sqrt(
                    lauetofPanels[0].geometry.origin[0] ** 2 +
                    lauetofPanels[0].geometry.origin[1] ** 2 +
                    lauetofPanels[0].geometry.origin[2] ** 2
                  )
                : undefined
            }
          />
        </div>
      )}

      <div className="status-bar">{status}</div>

      {showHelp && (
        <div className="help-overlay" onClick={() => setShowHelp(false)}>
          <div className="help-modal" onClick={(e) => e.stopPropagation()}>
            <button className="help-close" onClick={() => setShowHelp(false)}>✕</button>
            <h2>NMX Event Data Viewer — Help</h2>
            <h3>Loading Data</h3>
            <ul>
              <li>Drag & drop an HDF5/NeXus file onto the drop zone, or click to browse</li>
              <li>Supported formats: <strong>NXevent_data</strong> (raw events) and <strong>NXLaueTOF</strong> (pre-binned)</li>
              <li>Use <strong>↻ Reload</strong> to re-read the file (useful for SWMR live data)</li>
              <li>Use <strong>📂 New File</strong> to load a different file</li>
            </ul>
            <h3>TOF Slider</h3>
            <ul>
              <li>Drag the two thumbs to set a TOF range for filtering events</li>
              <li>Enable <strong>Window</strong> mode to lock the range width and slide it as a unit</li>
              <li>Press <strong>← / →</strong> arrow keys to step by one current-slice width</li>
              <li>For NXLaueTOF files, the slider snaps to TOF bin centers</li>
            </ul>
            <h3>Views</h3>
            <ul>
              <li><strong>Overview</strong>: all detector panels in a vertically scrollable grid</li>
              <li><strong>Single panel</strong>: select a panel from the View dropdown for a larger view with zoom</li>
            </ul>
            <h3>Toolbar (Single Panel View)</h3>
            <p>The vertical toolbar to the left of the image switches between two modes:</p>
            <ul>
              <li><strong>🔍 Zoom mode</strong> (<kbd>Z</kbd>) — click &amp; drag to draw a selection box and zoom in; <strong>Shift&nbsp;+&nbsp;drag</strong> to pan; <kbd>Esc</kbd> resets zoom</li>
              <li><strong>Line Scan mode</strong> (<kbd>L</kbd>) — click to set the start point, then click again to set the end point; a 1D intensity profile is plotted to the right; <kbd>Esc</kbd> cancels a line in progress</li>
            </ul>
            <h3>Color Scale</h3>
            <ul>
              <li>Choose scale type (Linear, Log, SymLog, Sqrt) from the dropdown</li>
              <li>Type values in the <strong>Min / Max</strong> inputs on the color bar to override the range</li>
              <li>Click <strong>Auto</strong> to reset to the optimal range (µ&nbsp;+&nbsp;2σ outlier rejection)</li>
            </ul>
            <p className="help-shortcut">Press <kbd>H</kbd> to toggle this help</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
