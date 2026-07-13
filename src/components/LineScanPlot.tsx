import React, { useMemo, useState, useEffect } from "react";
import { gsd } from "ml-gsd";

export const LINE_SCAN_PLOT_WIDTH = 320;

const PAD = { top: 16, right: 16, bottom: 44, left: 52 };

interface AnnotatedPeak {
  x: number;
  y: number;
  width: number;
  index: number;
  fromIdx: number;
  toIdx: number;
  integral: number;
  snr: number;
}

interface LineScanPlotProps {
  profile: number[] | null;
  /** Length of the drawn line in detector pixels */
  lineLength: number;
  /** Height in px to match the adjacent detector panel */
  height: number;
  /** Outer width in px (resizable); defaults to LINE_SCAN_PLOT_WIDTH */
  width?: number;
  onClear: () => void;
  title?: string;
  xAxisLabel?: string;
  /** Value added to x-tick labels (e.g. first column index for box profiles) */
  xOffset?: number;
}

export const LineScanPlot: React.FC<LineScanPlotProps> = ({
  profile,
  lineLength,
  height,
  width = LINE_SCAN_PLOT_WIDTH,
  onClear,
  title = "Line Profile",
  xAxisLabel = "Position (px)",
  xOffset = 0,
}) => {
  const HEADER_H = 32;
  const svgH = height - HEADER_H;
  // Inner drawing width — subtract the panel's left border + padding.
  const innerW = width - 12;
  const plotW = innerW - PAD.left - PAD.right;
  const plotH = Math.max(svgH - PAD.top - PAD.bottom, 60);

  const [peaks, setPeaks] = useState<AnnotatedPeak[] | null>(null);

  // Clear analysis whenever the profile changes.
  useEffect(() => { setPeaks(null); }, [profile]);

  const handleAnalyze = () => {
    if (!profile || profile.length < 5) return;

    // Build x array in absolute detector pixel coordinates.
    const x = Array.from({ length: profile.length }, (_, i) => xOffset + i);

    // Robust noise estimate: median of the lowest quartile.
    const sorted = [...profile].sort((a, b) => a - b);
    const q25idx = Math.max(1, Math.floor(sorted.length * 0.25));
    const noiseLevel = Math.max(sorted[Math.floor(q25idx / 2)], 1);

    const detected = gsd(
      { x, y: profile },
      {
        noiseLevel,
        minMaxRatio: 0.01,
        realTopDetection: true,
        smoothY: true,
        peakDetectionAlgorithm: "auto",
      }
    );

    const annotated: AnnotatedPeak[] = detected.map((peak) => {
      const fromIdx = peak.inflectionPoints.from.index;
      const toIdx = peak.inflectionPoints.to.index;
      const fromY = profile[fromIdx] ?? 0;
      const toY = profile[toIdx] ?? 0;
      const span = Math.max(toIdx - fromIdx, 1);

      // Baseline-subtracted integral between inflection points.
      let integral = 0;
      for (let i = fromIdx; i <= toIdx; i++) {
        const baseline = fromY + ((toY - fromY) * (i - fromIdx)) / span;
        integral += Math.max((profile[i] ?? 0) - baseline, 0);
      }

      // Poisson SNR: (signal - background) / sqrt(background).
      const snr = (peak.y - noiseLevel) / Math.sqrt(noiseLevel);

      return {
        x: peak.x,
        y: peak.y,
        width: peak.width,
        index: peak.index,
        fromIdx,
        toIdx,
        integral: Math.round(integral),
        snr,
      };
    });

    setPeaks(annotated);
  };

  const handleClear = () => {
    setPeaks(null);
    onClear();
  };

  const maxVal = useMemo(
    () => (profile && profile.length > 0 ? Math.max(...profile, 1) : 1),
    [profile]
  );

  const polylinePoints = useMemo(() => {
    if (!profile || profile.length < 2) return "";
    return profile
      .map((v, i) => {
        const x = PAD.left + (i / (profile.length - 1)) * plotW;
        const y = PAD.top + (1 - v / maxVal) * plotH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [profile, maxVal, plotW, plotH]);

  const xTicks = [0, 0.25, 0.5, 0.75, 1.0].map((t) => ({
    x: PAD.left + t * plotW,
    label: xOffset + Math.round(t * lineLength),
  }));

  const yTicks = [0, 0.5, 1.0].map((t) => ({
    y: PAD.top + (1 - t) * plotH,
    label: Math.round(t * maxVal),
  }));

  // Map absolute detector x → SVG x coordinate.
  const detToSvgX = (detX: number) =>
    PAD.left + ((detX - xOffset) / Math.max(lineLength, 1)) * plotW;

  return (
    <div className="line-scan-plot" style={{ width, boxSizing: "border-box" }}>
      <div className="line-scan-plot-header">
        <span className="line-scan-plot-title">{title}</span>
        <div className="line-scan-plot-actions">
          {profile && (
            <button className="line-scan-analyze-btn" onClick={handleAnalyze}>
              Analyze
            </button>
          )}
          {profile && (
            <button className="line-scan-clear-btn" onClick={handleClear}>
              Clear
            </button>
          )}
        </div>
      </div>

      {!profile ? (
        <div className="line-scan-empty" />
      ) : (
        <>
          <svg
            width={innerW}
            height={svgH}
            style={{ overflow: "visible", display: "block" }}
          >
            {/* Plot area */}
            <rect
              x={PAD.left} y={PAD.top}
              width={plotW} height={plotH}
              fill="rgba(0,51,102,0.03)"
              stroke="rgba(0,51,102,0.2)"
              strokeWidth={1}
            />

            {/* Y grid + ticks */}
            {yTicks.map((t, i) => (
              <g key={i}>
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
              <g key={i}>
                <line x1={t.x} y1={PAD.top + plotH} x2={t.x} y2={PAD.top + plotH + 4}
                  stroke="#003366" strokeWidth={1} />
                <text x={t.x} y={PAD.top + plotH + 16} textAnchor="middle"
                  fontSize={10} fill="#003366">{t.label}</text>
              </g>
            ))}

            {/* Axis labels */}
            <text x={PAD.left + plotW / 2} y={PAD.top + plotH + 34}
              textAnchor="middle" fontSize={11} fill="#003366">{xAxisLabel}</text>
            <text x={10} y={PAD.top + plotH / 2} textAnchor="middle"
              fontSize={11} fill="#003366"
              transform={`rotate(-90, 10, ${PAD.top + plotH / 2})`}>Counts</text>

            {/* Profile polyline */}
            {polylinePoints && (
              <polyline points={polylinePoints} fill="none"
                stroke="#0099DC" strokeWidth={1.5} strokeLinejoin="round" />
            )}

            {/* Peak markers */}
            {peaks && peaks.map((pk, i) => {
              const svgX = detToSvgX(pk.x);
              const peakSvgY = PAD.top + (1 - pk.y / maxVal) * plotH;
              return (
                <g key={i}>
                  <line x1={svgX} y1={PAD.top} x2={svgX} y2={PAD.top + plotH}
                    stroke="rgba(255,80,0,0.4)" strokeWidth={1} strokeDasharray="3 2" />
                  <circle cx={svgX} cy={peakSvgY} r={3}
                    fill="#ff5000" stroke="white" strokeWidth={1} />
                  <text x={svgX} y={PAD.top - 4} textAnchor="middle"
                    fontSize={9} fill="#ff5000">{i + 1}</text>
                </g>
              );
            })}
          </svg>

          {/* Analysis results table */}
          {peaks && (
            <div className="peak-analysis">
              {peaks.length === 0 ? (
                <p className="peak-analysis-empty">No peaks found</p>
              ) : (
                <>
                  <p className="peak-analysis-subtitle">
                    {peaks.length} peak{peaks.length !== 1 ? "s" : ""} found
                  </p>
                  <table className="peak-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Position</th>
                        <th>Height</th>
                        <th>Width</th>
                        <th>Integral</th>
                        <th>SNR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {peaks.map((pk, i) => (
                        <tr key={i}>
                          <td>{i + 1}</td>
                          <td>{pk.x.toFixed(1)}</td>
                          <td>{Math.round(pk.y).toLocaleString()}</td>
                          <td>{pk.width.toFixed(1)}</td>
                          <td>{pk.integral.toLocaleString()}</td>
                          <td>{pk.snr.toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};
