import React, { useMemo } from "react";
import {
  HeatmapVis,
  ScaleType,
  DefaultInteractions,
} from "@h5web/lib";
import type { ColorScaleType } from "@h5web/lib";
import type { Domain } from "@h5web/lib";
import ndarray from "ndarray";
import type { DetectorImageResult } from "../lib/event-data";

interface DetectorImageProps {
  imageResult: DetectorImageResult;
  panelName: string;
  colorScale?: ColorScaleType;
  /** Explicit size in px for the square chart; computed from window size by parent */
  size: number;
  /** Shared domain from parent */
  domain: Domain;
}

export const DetectorImage: React.FC<DetectorImageProps> = ({
  imageResult,
  panelName,
  colorScale = ScaleType.Log,
  size,
  domain,
}) => {
  const { image, shape, totalEvents } = imageResult;

  const dataNd = useMemo(
    () => ndarray(Array.from(image), shape),
    [image, shape]
  );

  if (size <= 0) return null;

  return (
    <div className="detector-image-panel">
      <h3>
        {panelName} — {totalEvents.toLocaleString()} events
      </h3>
      <div
        style={{
          width: size,
          height: size,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <HeatmapVis
          dataArray={dataNd}
          domain={domain}
          colorMap="Viridis"
          scaleType={colorScale}
          aspect="equal"
          showGrid={false}
        >
          <DefaultInteractions />
        </HeatmapVis>
      </div>
    </div>
  );
};
