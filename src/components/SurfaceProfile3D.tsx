import React, { useMemo } from "react";
import { SurfaceVis, ScaleType } from "@h5web/lib";
import type { ColorScaleType, Domain } from "@h5web/lib";
import ndarray from "ndarray";
import { getDomain } from "@h5web/lib";

interface SurfaceProfile3DProps {
  /** Flat array of counts for the selected sub-region (row-major) */
  data: Float64Array;
  /** [rows, cols] of the sub-region */
  shape: [number, number];
  /** Size in px for the container */
  size: number;
  colorScale?: ColorScaleType;
}

export const SurfaceProfile3D: React.FC<SurfaceProfile3DProps> = ({
  data,
  shape,
  size,
  colorScale = ScaleType.Linear,
}) => {
  // Normalize Z values so height is proportional to XY extent.
  // SurfaceVis uses raw values as Z coordinates — if counts are 0–100000
  // but grid is 50×50, the surface shoots up and looks flat.
  const { normalizedData, originalDomain } = useMemo(() => {
    const arr = Array.from(data);
    let min = Infinity, max = -Infinity;
    for (const v of arr) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (max <= min) max = min + 1;
    const xyExtent = Math.max(shape[0], shape[1]);
    const scale = xyExtent / (max - min);
    const normalized = arr.map((v) => (v - min) * scale);
    return { normalizedData: normalized, originalDomain: [min, max] as Domain };
  }, [data, shape]);

  const dataNd = useMemo(
    () => ndarray(normalizedData, shape),
    [normalizedData, shape]
  );

  // Domain for color mapping uses the normalized range
  const domain: Domain = useMemo(() => {
    const d = getDomain(normalizedData);
    if (!d) return [0, 1];
    let [lo, hi] = d;
    if (hi <= lo) hi = lo + 1;
    return [lo, hi];
  }, [normalizedData]);

  return (
    <div className="surface-profile-panel">
      <h4>3D Profile ({shape[1]}×{shape[0]})</h4>
      <p className="profile-range">
        Counts: {originalDomain[0].toFixed(0)}–{originalDomain[1].toFixed(0)}
      </p>
      <div
        style={{
          width: size,
          height: size,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <SurfaceVis
          dataArray={dataNd}
          domain={domain}
          colorMap="Viridis"
          scaleType={ScaleType.Linear}
        />
      </div>
    </div>
  );
};
