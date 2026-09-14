import { useState, useCallback, useRef, useEffect, useMemo, useLayoutEffect } from "react";
import "@h5web/lib/dist/styles.css";
import { ScaleType } from "@h5web/lib";
import { ColorBar } from "./components/ViridisColorBar";
import type { ColorMap, ColorScaleType, Domain } from "@h5web/lib";
import { FileLoader } from "./components/FileLoader";
import { DetectorImage } from "./components/DetectorImage";
import { PanelThumbnail } from "./components/PanelThumbnail";
import { TofRangeSlider } from "./components/TofRangeSlider";
import { LineScanPlot, LINE_SCAN_PLOT_WIDTH } from "./components/LineScanPlot";
import { TofProfilePlot } from "./components/TofProfilePlot";
import type {
  NexusFileType,
  DetectorPanelInfo,
  LauetofPanelInfo,
} from "./lib/h5wasm-loader";
import type { DetectorImageResult, BoxRegion } from "./lib/event-data";
import { H5Client } from "./lib/h5-client";
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

/** Demo dataset served from public/ so users without their own data can try the app */
const DEMO_FILE_NAME = "nmx-demo.h5";
const DEMO_FILE_URL_PATH = `demo/${DEMO_FILE_NAME}`;

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

  // The worker owns the open file and every per-event array; this thread only
  // ever holds the images it draws.
  const clientRef = useRef<H5Client | null>(null);
  // Mirrors `detectorImages`. Worker results arrive for a subset of panels and
  // have to be merged onto the current set; reading that (and the event total)
  // out of a setState updater would depend on when React runs it.
  const detectorImagesRef = useRef<(DetectorImageResult | null)[]>([]);
  const browserFileRef = useRef<File | null>(null);
  // Last box region a TOF profile was computed for — avoids recomputing when
  // onBoxDrawn re-fires only because the underlying image changed.
  const boxRegionRef = useRef<BoxRegion | null>(null);
  // Active drag origin for the analysis-column resizer.
  const resizeStartRef = useRef<{ x: number; w: number } | null>(null);
  const recomputeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recomputeRunIdRef = useRef(0);

  const newFileBtnRef = useRef<HTMLButtonElement>(null);
  const reloadBtnRef = useRef<HTMLButtonElement>(null);
  const viewSelectRef = useRef<HTMLSelectElement>(null);
  const colorMapSelectRef = useRef<HTMLSelectElement>(null);
  const colorBarRef = useRef<HTMLDivElement>(null);
  const tofDockRef = useRef<HTMLDivElement>(null);
  const lineScanPlotRef = useRef<HTMLDivElement>(null);
  const lineScanAnalysisRef = useRef<HTMLDivElement>(null);
  const [helpRects, setHelpRects] = useState<Record<string, DOMRect>>({});

  useLayoutEffect(() => {
    if (!showHelp) return;
    const rects: Record<string, DOMRect> = {};
    if (newFileBtnRef.current) rects.newFile = newFileBtnRef.current.getBoundingClientRect();
    if (reloadBtnRef.current) rects.reload = reloadBtnRef.current.getBoundingClientRect();
    if (viewSelectRef.current) rects.viewSelect = viewSelectRef.current.getBoundingClientRect();
    if (colorMapSelectRef.current) rects.colorMap = colorMapSelectRef.current.getBoundingClientRect();
    if (colorBarRef.current) rects.colorBar = colorBarRef.current.getBoundingClientRect();
    if (tofDockRef.current) rects.tofDock = tofDockRef.current.getBoundingClientRect();
    if (lineScanPlotRef.current) rects.lineScanPlot = lineScanPlotRef.current.getBoundingClientRect();
    if (lineScanAnalysisRef.current) rects.lineScanAnalysis = lineScanAnalysisRef.current.getBoundingClientRect();
    setHelpRects(rects);
  }, [showHelp]);

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

  /** The worker is created on first use and reused for the life of the page. */
  /** Single write path for detector images, keeping the mirror ref in step. */
  const applyImages = useCallback((next: (DetectorImageResult | null)[]) => {
    detectorImagesRef.current = next;
    setDetectorImages(next);
  }, []);

  /** Merge a partial worker result onto the images currently displayed. */
  const mergeImages = useCallback((incoming: (DetectorImageResult | null)[]) => {
    const merged = [...detectorImagesRef.current];
    incoming.forEach((img, i) => { if (img) merged[i] = img; });
    applyImages(merged);
    let totalEvents = 0;
    for (const img of merged) totalEvents += img?.totalEvents ?? 0;
    return totalEvents;
  }, [applyImages]);

  const getClient = useCallback(() => {
    if (!clientRef.current) {
      const client = new H5Client();
      client.setProgressHandler((label, value) => {
        setLoadProgressLabel(label);
        setLoadProgress(value);
        setStatus(label);
      });
      clientRef.current = client;
    }
    return clientRef.current;
  }, []);

  useEffect(() => () => { clientRef.current?.terminate(); }, []);

  /** Load ALL NXevent_data panels from the file */
  /** Bin every NXevent_data panel in the worker, then pull back the images. */
  const loadAllPanels = useCallback(
    async (client: H5Client, foundPanels: DetectorPanelInfo[]) => {
      const { tofMin, tofMax } = await client.loadEventPanels(numBins);
      const range: [number, number] = [tofMin, tofMax];
      setTofRange(range);
      setTofAbsMin(tofMin);
      setTofAbsMax(tofMax);
      await yieldToUI();

      const { images } = await client.computeImages(range);
      applyImages(images);

      setLoadProgress(100);
      setLoadProgressLabel("Done!");
      const totalEvents = images.reduce((sum, img) => sum + (img?.totalEvents ?? 0), 0);
      setStatus(
        `Loaded ${foundPanels.length} panels — ${totalEvents.toLocaleString()} events`
      );
    },
    [numBins, applyImages]
  );

  const loadAllLauetofPanels = useCallback(
    async (client: H5Client, foundPanels: LauetofPanelInfo[]) => {
      // Global TOF range across all panels
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
      setTofRange([globalTofMin, globalTofMin + binWidth]);

      // Read first slice for all panels
      const { images } = await client.lauetofSlices(null);
      applyImages(images);

      setLoadProgress(100);
      setLoadProgressLabel("Done!");
      const totalCounts = images.reduce((sum, img) => sum + (img?.totalEvents ?? 0), 0);
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
        const client = getClient();
        const { fileType: detectedType, panels: foundPanels, lauetofPanels: foundLauetof } =
          await client.open(file);
        setFileType(detectedType);

        setLoadProgress(0);
        setLoadProgressLabel("Starting...");

        if (detectedType === "NXlauetof") {
          if (foundLauetof.length === 0) {
            setStatus("No detector panels found in NXlauetof file.");
            setLoading(false);
            return;
          }
          setLauetofPanels(foundLauetof);
          await loadAllLauetofPanels(client, foundLauetof);
        } else {
          if (foundPanels.length === 0) {
            setStatus("No NXevent_data detector panels found in this file.");
            setLoading(false);
            return;
          }
          setPanels(foundPanels);
          await loadAllPanels(client, foundPanels);
        }
      } catch (err) {
        setStatus(`Error: ${(err as Error).message}`);
        console.error(err);
      } finally {
        setLoading(false);
      }
    },
    [getClient, loadAllPanels, loadAllLauetofPanels]
  );

  /** Fetch the bundled demo dataset (streaming download progress) and load it */
  const handleLoadDemo = useCallback(async () => {
    setLoading(true);
    setStatus("Downloading demo dataset…");
    setLoadProgress(0);
    setLoadProgressLabel("Downloading demo dataset…");
    try {
      const base = import.meta.env.BASE_URL || "/";
      const resp = await fetch(`${base}${DEMO_FILE_URL_PATH}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching demo dataset`);

      const total = Number(resp.headers.get("Content-Length")) || 0;
      const reader = resp.body?.getReader();
      let file: File;
      if (reader) {
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          chunks.push(value);
          received += value.length;
          const mb = (received / 1e6).toFixed(0);
          if (total) {
            // Reserve the last 10% of the bar for h5wasm parsing in handleFileLoaded
            setLoadProgress((received / total) * 90);
            setLoadProgressLabel(
              `Downloading demo dataset… ${mb} / ${(total / 1e6).toFixed(0)} MB`
            );
          } else {
            setLoadProgressLabel(`Downloading demo dataset… ${mb} MB`);
          }
        }
        file = new File(chunks as BlobPart[], DEMO_FILE_NAME);
      } else {
        const blob = await resp.blob();
        file = new File([blob], DEMO_FILE_NAME);
      }

      await handleFileLoaded(file);
    } catch (err) {
      setStatus(`Demo load error: ${(err as Error).message}`);
      console.error(err);
      setLoading(false);
    }
  }, [handleFileLoaded]);

  const handleReload = useCallback(async () => {
    if (!browserFileRef.current) return;
    setLoading(true);
    setStatus("Reloading file...");
    try {
      const file = browserFileRef.current;
      const client = getClient();
      const { fileType: detectedType, panels: foundPanels, lauetofPanels: foundLauetof } =
        await client.open(file);
      setFileType(detectedType);
      setLoadProgress(0);
      setLoadProgressLabel("Reloading...");

      if (detectedType === "NXlauetof") {
        if (foundLauetof.length === 0) {
          setStatus("No detector panels found after reload.");
          setLoading(false);
          return;
        }
        setLauetofPanels(foundLauetof);
        await loadAllLauetofPanels(client, foundLauetof);
      } else {
        if (foundPanels.length === 0) {
          setStatus("No NXevent_data detector panels found after reload.");
          setLoading(false);
          return;
        }
        setPanels(foundPanels);
        await loadAllPanels(client, foundPanels);
      }
    } catch (err) {
      setStatus(`Reload error: ${(err as Error).message}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [getClient, loadAllPanels, loadAllLauetofPanels]);

  const handleTofRangeChange = useCallback(
    (range: [number, number]) => {
      setTofRange(range);
      const client = clientRef.current;
      if (!client) return;
      const runId = beginRecompute(fileType);
      // Only the visible panel(s) need re-binning in single-panel mode.
      const indices = viewMode === "overview" ? null : [viewMode];

      void (async () => {
        try {
          if (fileType === "NXlauetof") {
            // Snap to the bin centre nearest the middle of the requested range
            const center = (range[0] + range[1]) / 2;
            const { images, sliceIndices } = await client.lauetofSlices(center, indices);
            if (recomputeRunIdRef.current !== runId) return;
            mergeImages(images);
            const shown = indices ? indices[0] : 0;
            setStatus(
              `${lauetofPanels.length} panels — slice ${(sliceIndices[shown] ?? 0) + 1}/${lauetofPanels[0]?.shape[2] ?? 0}`
            );
          } else {
            const { images } = await client.computeImages(range, indices);
            if (recomputeRunIdRef.current !== runId) return;
            const totalEvents = mergeImages(images);
            setStatus(
              `${panels.length} panels — ${totalEvents.toLocaleString()} events in TOF range`
            );
          }
        } catch (err) {
          console.error("TOF range recompute failed:", err);
          setStatus(`Error: ${(err as Error).message}`);
        } finally {
          if (recomputeRunIdRef.current === runId) endRecompute(runId);
        }
      })();
    },
    [beginRecompute, endRecompute, fileType, panels, lauetofPanels, viewMode, mergeImages]
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
      if (typeof viewMode !== "number") return;
      const client = clientRef.current;
      if (!client) return;
      void (async () => {
        try {
          const { tof, counts } = await client.boxTofProfile(
            viewMode,
            box,
            256,
            range ?? null
          );
          setTofProfile({ tof, counts });
          setTofRoi([tof[0], tof[tof.length - 1]]);
        } catch (err) {
          console.error("TOF profile error:", err);
          setTofProfile(null);
          setTofRoi(null);
        }
      })();
    },
    [viewMode]
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
          onLoadDemo={handleLoadDemo}
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
            ref={newFileBtnRef}
            className="reload-btn"
            onClick={() => {
              void clientRef.current?.close();
              browserFileRef.current = null;
              setFileName("");
              setFileType("unknown");
              setPanels([]);
              setLauetofPanels([]);
              detectorImagesRef.current = [];
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
            ref={reloadBtnRef}
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
              ref={viewSelectRef}
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
              ref={colorMapSelectRef}
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
                    // Overview draws with Canvas2D: one WebGL context per panel
                    // blows past the browser's ~16-context cap (see PanelThumbnail).
                    if (viewMode === "overview") {
                      return (
                        <PanelThumbnail
                          key={panel.path}
                          imageResult={img}
                          panelName={panel.name}
                          size={chartSize}
                          domain={sharedDomain}
                          colorScale={colorScale}
                          colorMap={colorMap}
                        />
                      );
                    }
                    return (
                      <DetectorImage
                        key={panel.path}
                        imageResult={img}
                        panelName={panel.name}
                        colorScale={colorScale}
                        colorMap={colorMap}
                        size={chartSize}
                        domain={sharedDomain}
                        singlePanel
                        panelGeometry={lauetofPanel?.geometry}
                        tofCenterNs={
                          lauetofPanel
                            ? (tofRange[0] + tofRange[1]) / 2
                            : undefined
                        }
                        enableLineScan
                        onLineDrawn={handleLineDrawn}
                        onBoxDrawn={handleBoxDrawn}
                        clearLine={clearLineSignal}
                      />
                    );
                  })}
              </div>
              <div
                ref={colorBarRef}
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
                    outerRef={lineScanPlotRef}
                    analysisRef={lineScanAnalysisRef}
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
        <div ref={tofDockRef} className="tof-dock">
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

      {showHelp && (() => {
        type CalloutAlign = "center" | "left" | "right";
        const callouts: Array<{ id: string; text: string; dir: "below" | "above" | "left"; wide?: boolean; align?: CalloutAlign }> = [
          {
            id: "viewSelect",
            text: isOverview
              ? "Overview mode — all panels in a grid. Pick a panel name to enter single-panel view with zoom & analysis."
              : "Single-panel view — zoom, line scan & box tools available. Choose Overview to see all panels.",
            dir: "below",
            wide: true,
            align: "right",
          },
          { id: "colorMap", text: "Change colormap for all panels (Viridis / Inferno / Greys)", dir: "below", align: "left" },
          ...(detectorImages.length > 0 ? [
            { id: "colorBar", text: "Override display range — type min/max, or click Auto for µ+2σ auto-range", dir: "left" as const, wide: true },
            {
              id: "tofDock",
              text: fileType === "NXlauetof"
                ? "TOF slider — snaps to bin centers. Use ← → to step one bin."
                : "Filter events by time-of-flight range. Enable Window mode to slide a fixed-width window. Use ← → to step.",
              dir: "above" as const,
              wide: true,
            },
          ] : []),
          ...(!isOverview ? [
            { id: "lineScanPlot", text: "Draw a line (L) or box (B) on the detector image to plot a 1D profile. Click Analyze to detect peaks — centroid, width, integral, and Poisson SNR.", dir: "below" as const, wide: true, align: "right" as const },
          ] : []),
        ];
        return (
          <div className="help-visual-overlay" onClick={() => setShowHelp(false)}>
            <div className="help-kb-panel" onClick={(e) => e.stopPropagation()}>
              <div className="help-kb-title">Keyboard Shortcuts</div>
              <div className="help-kb-list">
                <div className="help-kb-item"><kbd>H</kbd><span>Toggle help</span></div>
                <div className="help-kb-item"><kbd>Esc</kbd><span>Close / cancel / reset zoom</span></div>
                {detectorImages.length > 0 && (
                  <>
                    <div className="help-kb-section">TOF Navigation</div>
                    <div className="help-kb-item">
                      <span className="help-kb-keys"><kbd>←</kbd><kbd>→</kbd></span>
                      <span>Step TOF window by bin width</span>
                    </div>
                  </>
                )}
                {!isOverview && (
                  <>
                    <div className="help-kb-section">Drawing Tools</div>
                    <div className="help-kb-item"><kbd>Z</kbd><span>Zoom (drag to zoom in)</span></div>
                    <div className="help-kb-item"><kbd>L</kbd><span>Line scan (two clicks)</span></div>
                    <div className="help-kb-item"><kbd>B</kbd><span>Box integration</span></div>
                    <div className="help-kb-item">
                      <span className="help-kb-keys"><kbd>⇧</kbd>+drag</span>
                      <span>Pan (in zoom mode)</span>
                    </div>
                  </>
                )}
              </div>
              <div className="help-kb-dismiss">Click anywhere to close</div>
            </div>
            {callouts.map(({ id }) => {
              const rect = helpRects[id];
              if (!rect) return null;
              return (
                <div
                  key={`ring-${id}`}
                  className="help-highlight-ring"
                  style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }}
                />
              );
            })}
            {callouts.map(({ id, text, dir, wide, align = "center" }) => {
              const rect = helpRects[id];
              if (!rect) return null;
              const calloutW = wide ? 300 : 210;
              const arrowX = align === "left"  ? `${(rect.width + 8) / 2}px`
                           : align === "right" ? `${calloutW - (rect.width + 8) / 2}px`
                           : "50%";
              const alignClass = align !== "center" ? ` help-callout-align-${align}` : "";
              return (
                <div
                  key={`callout-${id}`}
                  style={{ position: "fixed", top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8, zIndex: 1002, pointerEvents: "none" }}
                >
                  <div
                    className={`help-callout help-callout-${dir}${alignClass}`}
                    style={{ width: calloutW, "--help-arrow-x": arrowX } as React.CSSProperties}
                  >{text}</div>
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}

export default App;
