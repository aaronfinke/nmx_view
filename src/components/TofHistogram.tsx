import React, { useMemo, useCallback, useRef, useState, useEffect } from "react";
import {
  LineVis,
  getDomain,
  DefaultInteractions,
} from "@h5web/lib";
import ndarray from "ndarray";
import type { TofHistogramResult } from "../lib/event-data";

interface TofHistogramProps {
  histogram: TofHistogramResult;
  tofRange: [number, number];
  onTofRangeChange: (range: [number, number]) => void;
  unit?: string;
}

export const TofHistogram: React.FC<TofHistogramProps> = ({
  histogram,
  tofRange,
  onTofRangeChange,
  unit = "ns",
}) => {
  const { binEdges, counts, tofMin, tofMax } = histogram;

  // Scale factor for display
  const displayScale = unit === "µs" ? 1e-3 : unit === "ms" ? 1e-6 : 1;
  const displayUnit = unit;

  // Bin centers for x-axis
  const scaledBinCenters = useMemo(() => {
    const centers = new Float64Array(counts.length);
    for (let i = 0; i < counts.length; i++) {
      centers[i] = ((binEdges[i] + binEdges[i + 1]) / 2) * displayScale;
    }
    return centers;
  }, [binEdges, counts.length, displayScale]);

  const dataNd = useMemo(
    () => ndarray(Array.from(counts), [counts.length]),
    [counts]
  );

  const domain = useMemo(
    () => getDomain(Array.from(counts)),
    [counts]
  );

  const xValues = useMemo(
    () => Array.from(scaledBinCenters),
    [scaledBinCenters]
  );

  // Range slider state
  const [localRange, setLocalRange] = useState<[number, number]>(tofRange);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalRange(tofRange);
  }, [tofRange]);

  const handleRangeChange = useCallback(
    (idx: 0 | 1, value: number) => {
      const nsValue = value / displayScale;
      const newRange: [number, number] = [...localRange];
      newRange[idx] = nsValue;
      if (newRange[0] > newRange[1]) {
        if (idx === 0) newRange[0] = newRange[1];
        else newRange[1] = newRange[0];
      }
      setLocalRange(newRange);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onTofRangeChange(newRange);
      }, 300);
    },
    [localRange, onTofRangeChange, displayScale]
  );

  const displayMin = tofMin * displayScale;
  const displayMax = tofMax * displayScale;
  const step = (displayMax - displayMin) / 1000;

  return (
    <div className="tof-histogram-panel">
      <h3>TOF Histogram</h3>
      <div className="tof-chart" style={{ height: 180 }}>
        <LineVis
          dataArray={dataNd}
          domain={domain}
          abscissaParams={{
            value: xValues,
            label: `TOF (${displayUnit})`,
          }}
          ordinateLabel="Counts"
          showGrid
        >
          <DefaultInteractions />
        </LineVis>
      </div>
      <div className="tof-range-controls">
        <label>
          TOF Min ({displayUnit}):
          <input
            type="range"
            min={displayMin}
            max={displayMax}
            step={step}
            value={localRange[0] * displayScale}
            onChange={(e) => handleRangeChange(0, parseFloat(e.target.value))}
          />
          <input
            type="number"
            value={(localRange[0] * displayScale).toFixed(1)}
            step={step}
            onChange={(e) => handleRangeChange(0, parseFloat(e.target.value))}
            style={{ width: 100 }}
          />
        </label>
        <label>
          TOF Max ({displayUnit}):
          <input
            type="range"
            min={displayMin}
            max={displayMax}
            step={step}
            value={localRange[1] * displayScale}
            onChange={(e) => handleRangeChange(1, parseFloat(e.target.value))}
          />
          <input
            type="number"
            value={(localRange[1] * displayScale).toFixed(1)}
            step={step}
            onChange={(e) => handleRangeChange(1, parseFloat(e.target.value))}
            style={{ width: 100 }}
          />
        </label>
      </div>
    </div>
  );
};
