import React, { useMemo } from "react";

export const LINE_SCAN_PLOT_WIDTH = 320;

const PAD = { top: 16, right: 16, bottom: 44, left: 52 };

interface LineScanPlotProps {
  profile: number[] | null;
  /** Length of the drawn line in detector pixels */
  lineLength: number;
  /** Height in px to match the adjacent detector panel */
  height: number;
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
  onClear,
  title = "Line Profile",
  xAxisLabel = "Position (px)",
  xOffset = 0,
}) => {
  const HEADER_H = 32;
  const svgH = height - HEADER_H;
  const plotW = LINE_SCAN_PLOT_WIDTH - PAD.left - PAD.right;
  const plotH = Math.max(svgH - PAD.top - PAD.bottom, 60);

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

  return (
    <div className="line-scan-plot">
      <div className="line-scan-plot-header">
        <span className="line-scan-plot-title">{title}</span>
        {profile && (
          <button className="line-scan-clear-btn" onClick={onClear}>
            Clear
          </button>
        )}
      </div>

      {!profile ? (
        <div className="line-scan-empty" />
      ) : (
        <svg
          width={LINE_SCAN_PLOT_WIDTH}
          height={svgH}
          style={{ overflow: "visible", display: "block" }}
        >
          {/* Plot area */}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={plotW}
            height={plotH}
            fill="rgba(0,51,102,0.03)"
            stroke="rgba(0,51,102,0.2)"
            strokeWidth={1}
          />

          {/* Horizontal grid lines + Y ticks */}
          {yTicks.map((t, i) => (
            <g key={i}>
              <line
                x1={PAD.left}
                y1={t.y}
                x2={PAD.left + plotW}
                y2={t.y}
                stroke="rgba(0,51,102,0.1)"
                strokeWidth={1}
              />
              <line
                x1={PAD.left - 4}
                y1={t.y}
                x2={PAD.left}
                y2={t.y}
                stroke="#003366"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 6}
                y={t.y + 4}
                textAnchor="end"
                fontSize={10}
                fill="#003366"
              >
                {t.label}
              </text>
            </g>
          ))}

          {/* X ticks */}
          {xTicks.map((t, i) => (
            <g key={i}>
              <line
                x1={t.x}
                y1={PAD.top + plotH}
                x2={t.x}
                y2={PAD.top + plotH + 4}
                stroke="#003366"
                strokeWidth={1}
              />
              <text
                x={t.x}
                y={PAD.top + plotH + 16}
                textAnchor="middle"
                fontSize={10}
                fill="#003366"
              >
                {t.label}
              </text>
            </g>
          ))}

          {/* Axis labels */}
          <text
            x={PAD.left + plotW / 2}
            y={PAD.top + plotH + 34}
            textAnchor="middle"
            fontSize={11}
            fill="#003366"
          >
            {xAxisLabel}
          </text>
          <text
            x={10}
            y={PAD.top + plotH / 2}
            textAnchor="middle"
            fontSize={11}
            fill="#003366"
            transform={`rotate(-90, 10, ${PAD.top + plotH / 2})`}
          >
            Counts
          </text>

          {/* Profile polyline */}
          {polylinePoints && (
            <polyline
              points={polylinePoints}
              fill="none"
              stroke="#0099DC"
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          )}
        </svg>
      )}
    </div>
  );
};
