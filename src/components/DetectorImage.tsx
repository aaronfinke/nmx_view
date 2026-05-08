import React, { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { HeatmapVis, ScaleType } from "@h5web/lib";
import type { ColorMap, ColorScaleType, DefaultInteractionsConfig } from "@h5web/lib";
import type { Domain } from "@h5web/lib";
import ndarray from "ndarray";
import type { DetectorImageResult } from "../lib/event-data";
import { computePixelDSpacing, type PanelGeometry } from "../lib/dspacing";

interface DetectorImageProps {
  imageResult: DetectorImageResult;
  panelName: string;
  colorScale?: ColorScaleType;
  colorMap?: ColorMap | "Greys_r";
  /** Explicit size in px for the square chart; computed from window size by parent */
  size: number;
  /** Shared domain from parent */
  domain: Domain;
  /** Single-panel mode: enables select-to-zoom */
  singlePanel?: boolean;
  /** Panel geometry for d-spacing (NXlauetof only) */
  panelGeometry?: PanelGeometry | null;
  /** Current TOF center in nanoseconds (NXlauetof only) */
  tofCenterNs?: number;
  /** Offer line scan drawing (single panel only) */
  enableLineScan?: boolean;
  /** Called with extracted profile after a line is drawn */
  onLineDrawn?: (
    profile: number[],
    startPx: [number, number],
    endPx: [number, number],
    lengthPx: number
  ) => void;
  /** Increment to imperatively clear the drawn line */
  clearLine?: number;
}

/** Sample pixel values along a line using linear interpolation. */
function extractLineProfile(
  image: Float64Array,
  shape: [number, number],
  start: [number, number],
  end: [number, number],
  numSamples = 256
): number[] {
  const [rows, cols] = shape;
  const [c0, r0] = start;
  const [c1, r1] = end;
  const profile: number[] = [];
  for (let i = 0; i <= numSamples; i++) {
    const t = i / numSamples;
    const col = Math.max(0, Math.min(cols - 1, Math.round(c0 + t * (c1 - c0))));
    const row = Math.max(0, Math.min(rows - 1, Math.round(r0 + t * (r1 - r0))));
    profile.push(image[row * cols + col]);
  }
  return profile;
}

export const DetectorImage: React.FC<DetectorImageProps> = ({
  imageResult,
  panelName,
  colorScale = ScaleType.Log,
  colorMap = "Viridis" as ColorMap | "Greys_r",
  size,
  domain,
  singlePanel = false,
  panelGeometry,
  tofCenterNs,
  enableLineScan = false,
  onLineDrawn,
  clearLine = 0,
}) => {
  const { image, shape, totalEvents } = imageResult;

  const dataNd = useMemo(
    () => ndarray(Array.from(image), shape),
    [image, shape]
  );

  // --- Tool mode & line scan state (two-click model) ---
  // toolMode: "zoom" enables h5web select-to-zoom; "linescan" uses two-click line drawing.
  const [toolMode, setToolMode] = useState<"zoom" | "linescan">("zoom");
  const [drawPhase, setDrawPhase] = useState<"idle" | "awaiting-end">("idle");
  const drawPhaseRef = useRef<"idle" | "awaiting-end">("idle");
  const [svgLine, setSvgLine] = useState<{
    x1: number; y1: number; x2: number; y2: number;
  } | null>(null);
  // Incrementing this key forces HeatmapVis to remount, resetting zoom.
  const [vizKey, setVizKey] = useState(0);
  const svgStartRef = useRef({ x: 0, y: 0 });
  const lineScanStartRef = useRef<[number, number]>([0, 0]);
  // Updated by renderTooltip on every hover move (no button held).
  const detectorPosRef = useRef<[number, number]>([0, 0]);

  // Ref to the heatmap wrapper div.
  const containerRef = useRef<HTMLDivElement>(null);

  // Keyboard shortcuts: Z = zoom mode, L = line scan mode, Esc = cancel line / reset zoom.
  useEffect(() => {
    if (!singlePanel || !enableLineScan) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "z" || e.key === "Z") {
        setToolMode("zoom");
      } else if (e.key === "l" || e.key === "L") {
        setToolMode("linescan");
      } else if (e.key === "Escape") {
        if (drawPhaseRef.current === "awaiting-end") {
          drawPhaseRef.current = "idle";
          setDrawPhase("idle");
          setSvgLine(null);
        } else {
          setVizKey((k) => k + 1);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [singlePanel, enableLineScan]);

  // Clear drawn line when parent requests it.
  useEffect(() => {
    if (clearLine > 0) {
      drawPhaseRef.current = "idle";
      setDrawPhase("idle");
      setSvgLine(null);
    }
  }, [clearLine]);

  // Clear drawn line when exiting line scan mode.
  useEffect(() => {
    if (toolMode !== "linescan") {
      drawPhaseRef.current = "idle";
      setDrawPhase("idle");
      setSvgLine(null);
    }
  }, [toolMode]);

  const handleContainerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (toolMode !== "linescan" || e.button !== 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // detectorPosRef was last updated by renderTooltip on the most recent
      // pointermove (no button held), so it accurately reflects the hover
      // position just before this click.
      const [detX, detY] = detectorPosRef.current;

      if (drawPhaseRef.current === "idle") {
        // First click: record start
        lineScanStartRef.current = [detX, detY];
        svgStartRef.current = { x, y };
        drawPhaseRef.current = "awaiting-end";
        setDrawPhase("awaiting-end");
        setSvgLine({ x1: x, y1: y, x2: x, y2: y });
      } else {
        // Second click: record end and compute profile
        drawPhaseRef.current = "idle";
        setDrawPhase("idle");
        const startDet = lineScanStartRef.current;
        const endDet: [number, number] = [detX, detY];
        const lengthPx = Math.sqrt(
          (endDet[0] - startDet[0]) ** 2 + (endDet[1] - startDet[1]) ** 2
        );
        if (lengthPx < 2) {
          setSvgLine(null);
          return;
        }
        const profile = extractLineProfile(image, shape, startDet, endDet);
        onLineDrawn?.(profile, startDet, endDet, lengthPx);
      }
    },
    [toolMode, image, shape, onLineDrawn]
  );

  // Between the two clicks no button is held — just update the SVG preview.
  const handleContainerPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (drawPhaseRef.current !== "awaiting-end") return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const s = svgStartRef.current;
      setSvgLine({ x1: s.x, y1: s.y, x2: x, y2: y });
    },
    []
  );

  // h5web interactions: enable zoom controls only in zoom mode.
  const interactions: DefaultInteractionsConfig =
    singlePanel && toolMode === "zoom"
      ? {
          selectToZoom: { modifierKey: [] as const },
          zoom: false,
          pan: { modifierKey: "Shift" as const },
          xAxisZoom: false,
          yAxisZoom: false,
          xSelectToZoom: false,
          ySelectToZoom: false,
        }
      : {
          pan: false,
          zoom: false,
          xAxisZoom: false,
          yAxisZoom: false,
          selectToZoom: false,
          xSelectToZoom: false,
          ySelectToZoom: false,
        };

  const renderTooltip = useCallback(
    (data: { xi: number; yi: number }) => {
      const { xi, yi } = data;
      const col = xi;
      const row = yi;
      // Always keep the detector-position ref current so line-scan handlers can
      // read zoom-correct coordinates even when in drawing mode.
      detectorPosRef.current = [col, row];

      const val = row >= 0 && row < shape[0] && col >= 0 && col < shape[1]
        ? image[row * shape[1] + col]
        : 0;

      let dInfo: { dSpacing: number; wavelength: number; twoTheta: number } | null = null;
      if (panelGeometry && tofCenterNs && tofCenterNs > 0) {
        dInfo = computePixelDSpacing(row, col, tofCenterNs, panelGeometry);
      }

      return (
        <div className="detector-tooltip">
          <div>Pixel: ({col}, {row})</div>
          <div>Value: {val.toFixed(0)}</div>
          {dInfo && (
            <>
              <div>d: {dInfo.dSpacing.toFixed(2)} Å</div>
              <div>2θ: {dInfo.twoTheta.toFixed(1)}°</div>
            </>
          )}
        </div>
      );
    },
    [image, shape, panelGeometry, tofCenterNs]
  );

  return (
    <div className="detector-image-panel" data-invert={colorMap === "Greys_r" ? "true" : undefined}>
      <div className="detector-panel-header">
        <h3>
          {panelName} — {totalEvents.toLocaleString()} events
        </h3>
      </div>
      <div
        ref={containerRef}
        style={{
          width: size,
          height: size,
          display: "flex",
          flexDirection: "column",
          position: "relative",
          cursor: toolMode === "linescan" ? "crosshair" : undefined,
        }}
        onPointerDown={handleContainerPointerDown}
        onPointerMove={handleContainerPointerMove}
      >
          <HeatmapVis
            key={vizKey}
            dataArray={dataNd}
            domain={domain}
            colorMap={colorMap === "Greys_r" ? "Greys" : colorMap}
            scaleType={colorScale}
            aspect="equal"
            showGrid={false}
            interactions={interactions}
            renderTooltip={renderTooltip}
          />

        {/* Visual line overlay — pointer-events: none so events reach h5web */}
        {toolMode === "linescan" && (
          <svg
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              pointerEvents: "none",
              zIndex: 5,
            }}
          >
            {/* Prompt / status text */}
            {!svgLine && (
              <text
                x="50%"
                y="50%"
                textAnchor="middle"
                dominantBaseline="middle"
                fill="rgba(255,255,255,0.75)"
                fontSize={13}
                style={{ userSelect: "none" }}
              >
                Click to set start point
              </text>
            )}
            {svgLine && drawPhase === "awaiting-end" && (
              <text
                x="50%"
                y="calc(100% - 12px)"
                textAnchor="middle"
                dominantBaseline="middle"
                fill="rgba(255,255,255,0.65)"
                fontSize={12}
                style={{ userSelect: "none" }}
              >
                Click to set end point — Esc to cancel
              </text>
            )}

            {/* The drawn / in-progress line */}
            {svgLine && (
              <>
                <line
                  x1={svgLine.x1}
                  y1={svgLine.y1}
                  x2={svgLine.x2}
                  y2={svgLine.y2}
                  stroke="rgba(0,0,0,0.5)"
                  strokeWidth={4}
                  strokeLinecap="round"
                />
                <line
                  x1={svgLine.x1}
                  y1={svgLine.y1}
                  x2={svgLine.x2}
                  y2={svgLine.y2}
                  stroke="white"
                  strokeWidth={2}
                  strokeDasharray={drawPhase === "awaiting-end" ? "6 3" : "none"}
                  strokeLinecap="round"
                />
                {/* Start marker always shown once set */}
                <circle
                  cx={svgLine.x1}
                  cy={svgLine.y1}
                  r={5}
                  fill="white"
                  stroke="#0099DC"
                  strokeWidth={2}
                />
                {/* End marker shown only after line is finalised */}
                {drawPhase === "idle" && (
                  <circle
                    cx={svgLine.x2}
                    cy={svgLine.y2}
                    r={5}
                    fill="white"
                    stroke="#0099DC"
                    strokeWidth={2}
                  />
                )}
              </>
            )}
          </svg>
        )}

        {/* Toolbar — absolutely positioned top-left, pointer events enabled */}
        {singlePanel && enableLineScan && (
          <div className="detector-toolbar" style={{ position: "absolute", top: 4, left: 4, zIndex: 10 }}>
            <button
              className={`toolbar-btn${toolMode === "zoom" ? " active" : ""}`}
              onClick={() => setToolMode("zoom")}
              title="Zoom mode (Z) — select-to-zoom; Esc resets zoom"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="7.5" cy="7.5" r="5" stroke="currentColor" strokeWidth="1.8"/>
                <line x1="11.5" y1="11.5" x2="16" y2="16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                <line x1="7.5" y1="5" x2="7.5" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                <line x1="5" y1="7.5" x2="10" y2="7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
            <button
              className={`toolbar-btn${toolMode === "linescan" ? " active" : ""}`}
              onClick={() => setToolMode("linescan")}
              title="Line scan mode (L) — click two points to extract a profile"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="3" cy="15" r="2" fill="currentColor"/>
                <circle cx="15" cy="3" r="2" fill="currentColor"/>
                <line x1="4.4" y1="13.6" x2="13.6" y2="4.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="3 2"/>
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
