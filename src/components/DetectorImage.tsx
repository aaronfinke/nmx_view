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
  /** Called with integrated profile after a box is drawn */
  onBoxDrawn?: (profile: number[], axisStart: number, axisEnd: number, axis: "slow" | "fast") => void;
  /** Increment to imperatively clear all drawings */
  clearLine?: number;
}

/**
 * Integrate a box region.
 * integrateAlong="slow": sum over rows → profile vs column (fast axis)
 * integrateAlong="fast": sum over columns → profile vs row (slow axis)
 */
function extractBoxProfile(
  image: Float64Array,
  shape: [number, number],
  detStart: [number, number],
  detEnd: [number, number],
  integrateAlong: "slow" | "fast" = "slow"
): { profile: number[]; axisStart: number; axisEnd: number } {
  const [rows, cols] = shape;
  const c0 = Math.max(0, Math.min(cols - 1, Math.round(Math.min(detStart[0], detEnd[0]))));
  const c1 = Math.max(0, Math.min(cols - 1, Math.round(Math.max(detStart[0], detEnd[0]))));
  const r0 = Math.max(0, Math.min(rows - 1, Math.round(Math.min(detStart[1], detEnd[1]))));
  const r1 = Math.max(0, Math.min(rows - 1, Math.round(Math.max(detStart[1], detEnd[1]))));
  const profile: number[] = [];
  if (integrateAlong === "slow") {
    for (let c = c0; c <= c1; c++) {
      let sum = 0;
      for (let r = r0; r <= r1; r++) sum += image[r * cols + c];
      profile.push(sum);
    }
    return { profile, axisStart: c0, axisEnd: c1 };
  } else {
    for (let r = r0; r <= r1; r++) {
      let sum = 0;
      for (let c = c0; c <= c1; c++) sum += image[r * cols + c];
      profile.push(sum);
    }
    return { profile, axisStart: r0, axisEnd: r1 };
  }
}

/** Sum pixel values along a line with a perpendicular box of given thickness. */
function extractLineProfile(
  image: Float64Array,
  shape: [number, number],
  start: [number, number],
  end: [number, number],
  numSamples = 256,
  thickness = 1
): number[] {
  const [rows, cols] = shape;
  const [c0, r0] = start;
  const [c1, r1] = end;
  const dx = c1 - c0;
  const dy = r1 - r0;
  const len = Math.sqrt(dx * dx + dy * dy);
  // Perpendicular unit vector
  const px = len > 0 ? -dy / len : 0;
  const py = len > 0 ?  dx / len : 0;
  const halfT = Math.floor(thickness / 2);
  const profile: number[] = [];
  for (let i = 0; i <= numSamples; i++) {
    const t = i / numSamples;
    const cx = c0 + t * dx;
    const cy = r0 + t * dy;
    let sum = 0;
    for (let k = -halfT; k <= halfT; k++) {
      const col = Math.round(cx + k * px);
      const row = Math.round(cy + k * py);
      if (col >= 0 && col < cols && row >= 0 && row < rows) {
        sum += image[row * cols + col];
      }
    }
    profile.push(sum);
  }
  return profile;
}

function LineOverlay({ svgLine, drawPhase, size, shape }: {
  svgLine: { x1: number; y1: number; x2: number; y2: number };
  drawPhase: "idle" | "awaiting-end";
  size: number;
  shape: [number, number];
}) {
  const detScale = size / Math.max(shape[0], shape[1]);
  const sw = Math.max(2, detScale);
  const inProgress = drawPhase === "awaiting-end";
  return (
    <>
      <line x1={svgLine.x1} y1={svgLine.y1} x2={svgLine.x2} y2={svgLine.y2}
        stroke="rgba(0,0,0,0.25)" strokeWidth={sw + 2} strokeLinecap="round" />
      <line x1={svgLine.x1} y1={svgLine.y1} x2={svgLine.x2} y2={svgLine.y2}
        stroke="rgba(255,255,255,0.35)" strokeWidth={sw}
        strokeDasharray={inProgress ? "6 3" : "none"} strokeLinecap="round" />
      <circle cx={svgLine.x1} cy={svgLine.y1} r={5} fill="white" stroke="#0099DC" strokeWidth={2} />
      {drawPhase === "idle" && (
        <circle cx={svgLine.x2} cy={svgLine.y2} r={5} fill="white" stroke="#0099DC" strokeWidth={2} />
      )}
    </>
  );
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
  onBoxDrawn,
  clearLine = 0,
}) => {
  const { image, shape, totalEvents } = imageResult;

  const dataNd = useMemo(
    () => ndarray(Array.from(image), shape),
    [image, shape]
  );

  // --- Tool mode & line scan state (two-click model) ---
  // toolMode: "zoom" enables h5web select-to-zoom; "linescan" uses two-click line drawing.
  const [boxIntegAxis, setBoxIntegAxis] = useState<"slow" | "fast">("slow");
  const [toolMode, setToolMode] = useState<"zoom" | "linescan" | "box">("zoom");
  const [drawPhase, setDrawPhase] = useState<"idle" | "awaiting-end">("idle");
  const drawPhaseRef = useRef<"idle" | "awaiting-end">("idle");
  const [svgLine, setSvgLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [svgBox, setSvgBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // Incrementing this key forces HeatmapVis to remount, resetting zoom.
  const [vizKey, setVizKey] = useState(0);
  const svgStartRef = useRef({ x: 0, y: 0 });
  const lineScanStartRef = useRef<[number, number]>([0, 0]);
  const boxStartDetRef = useRef<[number, number]>([0, 0]);
  const [committedLine, setCommittedLine] = useState<{
    start: [number, number]; end: [number, number]; length: number;
  } | null>(null);
  const [committedBox, setCommittedBox] = useState<{
    detStart: [number, number]; detEnd: [number, number];
  } | null>(null);
  // Updated by renderTooltip on every hover move (no button held).
  const detectorPosRef = useRef<[number, number]>([0, 0]);

  // Ref to the heatmap wrapper div.
  const containerRef = useRef<HTMLDivElement>(null);

  // Keyboard shortcuts: Z = zoom, L = line scan, B = box, Esc = cancel / reset zoom.
  useEffect(() => {
    if (!singlePanel || !enableLineScan) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "z" || e.key === "Z") setToolMode("zoom");
      else if (e.key === "l" || e.key === "L") setToolMode("linescan");
      else if (e.key === "b" || e.key === "B") setToolMode("box");
      else if (e.key === "Escape") {
        if (drawPhaseRef.current === "awaiting-end") {
          drawPhaseRef.current = "idle";
          setDrawPhase("idle");
          setSvgLine(null);
          setSvgBox(null);
        } else {
          setVizKey((k) => k + 1);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [singlePanel, enableLineScan]);

  // Clear all drawings when parent requests it.
  useEffect(() => {
    if (clearLine > 0) {
      drawPhaseRef.current = "idle";
      setDrawPhase("idle");
      setSvgLine(null);
      setCommittedLine(null);
      setSvgBox(null);
      setCommittedBox(null);
    }
  }, [clearLine]);

  // Clear drawings when switching tool mode.
  useEffect(() => {
    drawPhaseRef.current = "idle";
    setDrawPhase("idle");
    setSvgLine(null);
    setCommittedLine(null);
    setSvgBox(null);
    setCommittedBox(null);
  }, [toolMode]);

  // Recompute line profile when thickness or image changes.
  useEffect(() => {
    if (!committedLine) return;
    const { start, end, length } = committedLine;
    const profile = extractLineProfile(image, shape, start, end, 256, 1);
    onLineDrawn?.(profile, start, end, length);
  }, [image]); // eslint-disable-line react-hooks/exhaustive-deps

  // Recompute box profile when image or integration axis changes.
  useEffect(() => {
    if (!committedBox) return;
    const { detStart, detEnd } = committedBox;
    const { profile, axisStart, axisEnd } = extractBoxProfile(image, shape, detStart, detEnd, boxIntegAxis);
    onBoxDrawn?.(profile, axisStart, axisEnd, boxIntegAxis);
  }, [image, boxIntegAxis]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleContainerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || (toolMode !== "linescan" && toolMode !== "box")) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const [detX, detY] = detectorPosRef.current;

      if (drawPhaseRef.current === "idle") {
        svgStartRef.current = { x, y };
        drawPhaseRef.current = "awaiting-end";
        setDrawPhase("awaiting-end");
        if (toolMode === "linescan") {
          lineScanStartRef.current = [detX, detY];
          setSvgLine({ x1: x, y1: y, x2: x, y2: y });
        } else {
          boxStartDetRef.current = [detX, detY];
          setSvgBox({ x1: x, y1: y, x2: x, y2: y });
        }
      } else {
        drawPhaseRef.current = "idle";
        setDrawPhase("idle");
        if (toolMode === "linescan") {
          const startDet = lineScanStartRef.current;
          const endDet: [number, number] = [detX, detY];
          const lengthPx = Math.sqrt((endDet[0] - startDet[0]) ** 2 + (endDet[1] - startDet[1]) ** 2);
          if (lengthPx < 2) { setSvgLine(null); return; }
          const profile = extractLineProfile(image, shape, startDet, endDet, 256, 1);
          setCommittedLine({ start: startDet, end: endDet, length: lengthPx });
          onLineDrawn?.(profile, startDet, endDet, lengthPx);
        } else {
          const startDet = boxStartDetRef.current;
          const endDet: [number, number] = [detX, detY];
          if (Math.abs(endDet[0] - startDet[0]) < 2 && Math.abs(endDet[1] - startDet[1]) < 2) {
            setSvgBox(null); return;
          }
          setSvgBox({ x1: svgStartRef.current.x, y1: svgStartRef.current.y, x2: x, y2: y });
          const { profile, axisStart, axisEnd } = extractBoxProfile(image, shape, startDet, endDet, boxIntegAxis);
          setCommittedBox({ detStart: startDet, detEnd: endDet });
          onBoxDrawn?.(profile, axisStart, axisEnd, boxIntegAxis);
        }
      }
    },
    [toolMode, image, shape, onLineDrawn, onBoxDrawn]
  );

  // Between the two clicks no button is held — just update the SVG preview.
  const handleContainerPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (drawPhaseRef.current !== "awaiting-end") return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const s = svgStartRef.current;
      if (toolMode === "linescan") setSvgLine({ x1: s.x, y1: s.y, x2: x, y2: y });
      else if (toolMode === "box") setSvgBox({ x1: s.x, y1: s.y, x2: x, y2: y });
    },
    [toolMode]
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

        {/* Drawing overlay — pointer-events: none so events reach h5web */}
        {(toolMode === "linescan" || toolMode === "box") && (
          <svg style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 5 }}>
            {/* Prompt text */}
            {!svgLine && !svgBox && (
              <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle"
                fill="rgba(255,255,255,0.75)" fontSize={13} style={{ userSelect: "none" }}>
                Click to set start point
              </text>
            )}
            {(svgLine || svgBox) && drawPhase === "awaiting-end" && (
              <text x="50%" y="calc(100% - 12px)" textAnchor="middle" dominantBaseline="middle"
                fill="rgba(255,255,255,0.65)" fontSize={12} style={{ userSelect: "none" }}>
                Click to set end point — Esc to cancel
              </text>
            )}
            {svgLine && (
              <LineOverlay svgLine={svgLine} drawPhase={drawPhase} size={size} shape={shape} />
            )}
            {svgBox && (() => {
              const x = Math.min(svgBox.x1, svgBox.x2);
              const y = Math.min(svgBox.y1, svgBox.y2);
              const w = Math.abs(svgBox.x2 - svgBox.x1);
              const h = Math.abs(svgBox.y2 - svgBox.y1);
              return (
                <rect x={x} y={y} width={w} height={h}
                  fill="rgba(0,153,220,0.12)"
                  stroke="rgba(255,255,255,0.6)"
                  strokeWidth={1.5}
                  strokeDasharray={drawPhase === "awaiting-end" ? "6 3" : "none"}
                />
              );
            })()}
          </svg>
        )}

        {/* Toolbar — absolutely positioned top-left, pointer events enabled */}
        {singlePanel && enableLineScan && (
          <div className="detector-toolbar" style={{ position: "absolute", top: 4, left: 4, zIndex: 10 }} onPointerDown={(e) => e.stopPropagation()}>
            <button className={`toolbar-btn${toolMode === "zoom" ? " active" : ""}`}
              onClick={() => setToolMode("zoom")} title="Zoom mode (Z) — select-to-zoom; Esc resets zoom">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="7.5" cy="7.5" r="5" stroke="currentColor" strokeWidth="1.8"/>
                <line x1="11.5" y1="11.5" x2="16" y2="16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                <line x1="7.5" y1="5" x2="7.5" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                <line x1="5" y1="7.5" x2="10" y2="7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
            <button className={`toolbar-btn${toolMode === "linescan" ? " active" : ""}`}
              onClick={() => setToolMode("linescan")} title="Line scan mode (L) — click two points to extract a profile">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="3" cy="15" r="2" fill="currentColor"/>
                <circle cx="15" cy="3" r="2" fill="currentColor"/>
                <line x1="4.4" y1="13.6" x2="13.6" y2="4.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="3 2"/>
              </svg>
            </button>
            <button className={`toolbar-btn${toolMode === "box" ? " active" : ""}`}
              onClick={() => setToolMode("box")} title="Box integration mode (B) — click two corners to integrate along rows">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="5" width="14" height="8" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
                <line x1="9" y1="5" x2="9" y2="13" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2"/>
              </svg>
            </button>
            {toolMode === "box" && (
              <button
                className="toolbar-btn"
                onClick={() => setBoxIntegAxis((a) => a === "slow" ? "fast" : "slow")}
                title={boxIntegAxis === "slow" ? "Integrating along slow axis (Y) — click to switch to fast axis (X)" : "Integrating along fast axis (X) — click to switch to slow axis (Y)"}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                  {boxIntegAxis === "slow" ? (
                    <>
                      <line x1="3" y1="3" x2="3" y2="15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                      <line x1="3" y1="15" x2="15" y2="15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                      <path d="M5 12 Q9 4 13 12" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
                    </>
                  ) : (
                    <>
                      <line x1="3" y1="3" x2="3" y2="15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                      <line x1="3" y1="15" x2="15" y2="15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                      <path d="M6 13 Q6 7 12 7" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
                    </>
                  )}
                </svg>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
