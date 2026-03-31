import React, { useMemo, useState, useEffect } from "react";
import {
  HeatmapVis,
  ScaleType,
  getDomain,
  DefaultInteractions,
} from "@h5web/lib";
import type { ColorScaleType } from "@h5web/lib";
import ndarray from "ndarray";
import type { DetectorImageResult } from "../lib/event-data";

interface DetectorImageProps {
  imageResult: DetectorImageResult;
  panelName: string;
  colorScale?: ColorScaleType;
  /** Explicit size in px for the square chart; computed from window size by parent */
  size: number;
  /** User-overridden domain [min, max]; null entries use auto-computed value */
  userDomain?: [number | null, number | null];
  /** Called when user edits the domain min/max on the color bar */
  onDomainChange?: (which: "min" | "max", value: string) => void;
  /** Current user-entered string values for domain min/max (for controlled inputs) */
  domainMinStr?: string;
  domainMaxStr?: string;
}

const LOG_SCALES: readonly string[] = [ScaleType.Log, ScaleType.SymLog];

export const DetectorImage: React.FC<DetectorImageProps> = ({
  imageResult,
  panelName,
  colorScale = ScaleType.Log,
  size,
  userDomain,
  onDomainChange,
  domainMinStr = "",
  domainMaxStr = "",
}) => {
  const { image, shape, totalEvents } = imageResult;

  const dataNd = useMemo(
    () => ndarray(Array.from(image), shape),
    [image, shape]
  );

  const domain = useMemo(() => {
    const raw = getDomain(Array.from(image));
    if (!raw) return [0.1, 1] as [number, number];
    let [lo, hi] = raw;
    if (LOG_SCALES.includes(colorScale)) {
      lo = Math.max(lo, 0.1);
    }
    if (hi <= lo) hi = lo + 1;
    // Apply user overrides
    if (userDomain) {
      if (userDomain[0] != null) lo = userDomain[0];
      if (userDomain[1] != null) hi = userDomain[1];
    }
    if (LOG_SCALES.includes(colorScale)) {
      lo = Math.max(lo, 0.1);
    }
    if (hi <= lo) hi = lo + 1;
    return [lo, hi] as [number, number];
  }, [image, colorScale, userDomain]);

  if (size <= 0) return null;

  return (
    <div className="detector-image-panel">
      <h3>
        {panelName} — {totalEvents.toLocaleString()} events in TOF range
      </h3>
      <div
        style={{
          width: size,
          height: size,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          position: "relative",
        }}
      >
        <HeatmapVis
          dataArray={dataNd}
          domain={domain}
          colorMap="Viridis"
          scaleType={colorScale}
          aspect="equal"
          showGrid={false}
          abscissaParams={{ label: "x" }}
          ordinateParams={{ label: "y" }}
        >
          <DefaultInteractions />
        </HeatmapVis>
        {onDomainChange && (
          <>
            <input
              type="number"
              className="colorbar-domain-input colorbar-domain-max"
              value={domainMaxStr}
              placeholder={String(Math.round(domain[1]))}
              title="Color bar max"
              onChange={(e) => onDomainChange("max", e.target.value)}
            />
            <input
              type="number"
              className="colorbar-domain-input colorbar-domain-min"
              value={domainMinStr}
              placeholder={String(Math.round(domain[0]))}
              title="Color bar min"
              onChange={(e) => onDomainChange("min", e.target.value)}
            />
          </>
        )}
      </div>
    </div>
  );
};
