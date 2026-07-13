import React, { useMemo, useRef, useCallback } from "react";

export const TOF_PROFILE_PLOT_WIDTH = 320;

const PAD = { top: 14, right: 16, bottom: 44, left: 52 };

interface TofProfilePlotProps {
  /** TOF bin centers in ns (null when no box selected) */
  tof: Float64Array | null;
  /** Integrated counts per bin over the box region */
  counts: Float64Array | null;
  /** Height in px */
  height: number;
  /** Outer width in px (resizable); defaults to TOF_PROFILE_PLOT_WIDTH */
  width?: number;
  /** Current ROI [lo, hi] in ns, or null for the full range */
  roi: [number, number] | null;
  /** Called while the user drags a handle or edits an input (ns) */
  onRoiChange: (roi: [number, number]) => void;
  /** Called when the user applies the ROI to the detector image (ns) */
  onApply: (roi: [number, number]) => void;
  /** Clear the box selection entirely */
  onClear: () => void;
  /** Display unit for the TOF axis ("µs" | "ms" | "ns") */
  unit?: string;
}

export const TofProfilePlot: React.FC<TofProfilePlotProps> = ({
  tof,
  counts,
  height,
  width = TOF_PROFILE_PLOT_WIDTH,
  roi,
  onRoiChange,
  onApply,
  onClear,
  unit = "µs",
}) => {
  const HEADER_H = 32;
  const svgH = height - HEADER_H;
  // Inner drawing width — subtract the panel's left border + padding.
  const innerW = width - 12;
  const plotW = innerW - PAD.left - PAD.right;
  const plotH = Math.max(svgH - PAD.top - PAD.bottom, 60);

  const displayScale = unit === "µs" ? 1e-3 : unit === "ms" ? 1e-6 : 1;

  const svgRef = useRef<SVGSVGElement>(null);
  // Which ROI handle is being dragged, if any.
  const dragRef = useRef<"lo" | "hi" | null>(null);

  const [xMin, xMax] = useMemo(() => {
    if (!tof || tof.length === 0) return [0, 1];
    return [tof[0], tof[tof.length - 1]];
  }, [tof]);

  const maxVal = useMemo(
    () => (counts && counts.length > 0 ? Math.max(...counts, 1) : 1),
    [counts]
  );

  const effRoi = useMemo<[number, number]>(
    () => roi ?? [xMin, xMax],
    [roi, xMin, xMax]
  );

  // ── coordinate mapping ─────────────────────────────────────
  const tofToSvgX = useCallback(
    (t: number) => PAD.left + ((t - xMin) / Math.max(xMax - xMin, 1e-9)) * plotW,
    [xMin, xMax, plotW]
  );
  const svgXToTof = useCallback(
    (x: number) => xMin + ((x - PAD.left) / plotW) * (xMax - xMin),
    [xMin, xMax, plotW]
  );

  const polylinePoints = useMemo(() => {
    if (!tof || !counts || counts.length < 2) return "";
    return Array.from(counts)
      .map((v, i) => {
        const x = tofToSvgX(tof[i]);
        const y = PAD.top + (1 - v / maxVal) * plotH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [tof, counts, maxVal, plotH, tofToSvgX]);

  const roiIntegral = useMemo(() => {
    if (!tof || !counts) return 0;
    const [lo, hi] = effRoi;
    let sum = 0;
    for (let i = 0; i < counts.length; i++) {
      if (tof[i] >= lo && tof[i] <= hi) sum += counts[i];
    }
    return sum;
  }, [tof, counts, effRoi]);

  // ── ROI dragging ───────────────────────────────────────────
  const clientToTof = useCallback(
    (clientX: number) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return xMin;
      const x = clientX - rect.left;
      return Math.max(xMin, Math.min(xMax, svgXToTof(x)));
    },
    [svgXToTof, xMin, xMax]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!tof) return;
      const t = clientToTof(e.clientX);
      const [lo, hi] = effRoi;
      // Grab the nearer handle.
      dragRef.current = Math.abs(t - lo) <= Math.abs(t - hi) ? "lo" : "hi";
      e.currentTarget.setPointerCapture(e.pointerId);
      // Move the grabbed handle to the click position immediately.
      const next: [number, number] = dragRef.current === "lo" ? [Math.min(t, hi), hi] : [lo, Math.max(t, lo)];
      onRoiChange(next);
    },
    [tof, clientToTof, effRoi, onRoiChange]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!dragRef.current || !tof) return;
      const t = clientToTof(e.clientX);
      const [lo, hi] = effRoi;
      const next: [number, number] =
        dragRef.current === "lo" ? [Math.min(t, hi), hi] : [lo, Math.max(t, lo)];
      onRoiChange(next);
    },
    [tof, clientToTof, effRoi, onRoiChange]
  );

  const endDrag = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (dragRef.current) {
      dragRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    }
  }, []);

  const setRoiLo = (uμs: number) => {
    const ns = uμs / displayScale;
    onRoiChange([Math.max(xMin, Math.min(ns, effRoi[1])), effRoi[1]]);
  };
  const setRoiHi = (uμs: number) => {
    const ns = uμs / displayScale;
    onRoiChange([effRoi[0], Math.min(xMax, Math.max(ns, effRoi[0]))]);
  };

  const xTicks = [0, 0.25, 0.5, 0.75, 1.0].map((f) => {
    const t = xMin + f * (xMax - xMin);
    return { x: PAD.left + f * plotW, label: (t * displayScale).toFixed(1) };
  });
  const yTicks = [0, 0.5, 1.0].map((f) => ({
    y: PAD.top + (1 - f) * plotH,
    label: Math.round(f * maxVal),
  }));

  const hasData = !!(tof && counts && counts.length > 1);
  const roiLoX = tofToSvgX(effRoi[0]);
  const roiHiX = tofToSvgX(effRoi[1]);

  return (
    <div className="tof-profile-plot" style={{ width, boxSizing: "border-box" }}>
      <div className="tof-profile-header">
        <span className="tof-profile-title">TOF Profile</span>
        <div className="tof-profile-actions">
          {hasData && (
            <button
              className="tof-profile-apply-btn"
              onClick={() => onApply(effRoi)}
              title="Set the detector image TOF range to this ROI"
            >
              Apply to image
            </button>
          )}
          {hasData && (
            <button className="tof-profile-clear-btn" onClick={onClear}>
              Clear
            </button>
          )}
        </div>
      </div>

      {!hasData ? (
        <div className="tof-profile-empty">
          Draw a box on the detector to plot its integrated TOF profile.
        </div>
      ) : (
        <>
          <svg
            ref={svgRef}
            width={innerW}
            height={svgH}
            style={{ overflow: "visible", display: "block", touchAction: "none", cursor: "ew-resize" }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH}
              fill="rgba(0,51,102,0.03)" stroke="rgba(0,51,102,0.2)" strokeWidth={1} />

            {/* Y grid + ticks */}
            {yTicks.map((t, i) => (
              <g key={`y${i}`}>
                <line x1={PAD.left} y1={t.y} x2={PAD.left + plotW} y2={t.y}
                  stroke="rgba(0,51,102,0.1)" strokeWidth={1} />
                <line x1={PAD.left - 4} y1={t.y} x2={PAD.left} y2={t.y}
                  stroke="#003366" strokeWidth={1} />
                <text x={PAD.left - 6} y={t.y + 4} textAnchor="end"
                  fontSize={10} fill="#003366">{t.label}</text>
              </g>
            ))}

            {/* X ticks */}
            {xTicks.map((t, i) => (
              <g key={`x${i}`}>
                <line x1={t.x} y1={PAD.top + plotH} x2={t.x} y2={PAD.top + plotH + 4}
                  stroke="#003366" strokeWidth={1} />
                <text x={t.x} y={PAD.top + plotH + 16} textAnchor="middle"
                  fontSize={10} fill="#003366">{t.label}</text>
              </g>
            ))}

            {/* Axis labels */}
            <text x={PAD.left + plotW / 2} y={PAD.top + plotH + 34}
              textAnchor="middle" fontSize={11} fill="#003366">TOF ({unit})</text>
            <text x={10} y={PAD.top + plotH / 2} textAnchor="middle"
              fontSize={11} fill="#003366"
              transform={`rotate(-90, 10, ${PAD.top + plotH / 2})`}>Counts</text>

            {/* ROI shaded band */}
            <rect x={Math.min(roiLoX, roiHiX)} y={PAD.top}
              width={Math.abs(roiHiX - roiLoX)} height={plotH}
              fill="rgba(153,190,0,0.18)" />

            {/* Profile polyline */}
            {polylinePoints && (
              <polyline points={polylinePoints} fill="none"
                stroke="#0099DC" strokeWidth={1.5} strokeLinejoin="round" />
            )}

            {/* ROI handles */}
            {[roiLoX, roiHiX].map((hx, i) => (
              <g key={`h${i}`}>
                <line x1={hx} y1={PAD.top} x2={hx} y2={PAD.top + plotH}
                  stroke="#7a9900" strokeWidth={1.5} />
                <rect x={hx - 4} y={PAD.top + plotH / 2 - 9} width={8} height={18}
                  rx={2} fill="#99BE00" stroke="#003300" strokeWidth={0.75} />
              </g>
            ))}
          </svg>

          <div className="tof-profile-roi">
            <div className="tof-profile-roi-inputs">
              <label>
                ROI min
                <input type="number" value={+(effRoi[0] * displayScale).toFixed(2)}
                  step={0.1} onChange={(e) => setRoiLo(Number(e.target.value))} />
              </label>
              <label>
                ROI max
                <input type="number" value={+(effRoi[1] * displayScale).toFixed(2)}
                  step={0.1} onChange={(e) => setRoiHi(Number(e.target.value))} />
              </label>
              <span className="tof-profile-unit">{unit}</span>
            </div>
            <p className="tof-profile-readout">
              ROI integral: <strong>{Math.round(roiIntegral).toLocaleString()}</strong> counts
            </p>
          </div>
        </>
      )}
    </div>
  );
};
