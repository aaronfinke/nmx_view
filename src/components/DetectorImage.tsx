import React, { useMemo } from "react";
import { HeatmapVis, ScaleType } from "@h5web/lib";
import type { ColorScaleType, DefaultInteractionsConfig } from "@h5web/lib";
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
  /** Single-panel mode: enables select-to-zoom */
  singlePanel?: boolean;
}

export const DetectorImage: React.FC<DetectorImageProps> = ({
  imageResult,
  panelName,
  colorScale = ScaleType.Log,
  size,
  domain,
  singlePanel = false,
}) => {
  const { image, shape, totalEvents } = imageResult;

  const dataNd = useMemo(
    () => ndarray(Array.from(image), shape),
    [image, shape]
  );

  const interactions: DefaultInteractionsConfig = singlePanel
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
          interactions={interactions}
        />
      </div>
    </div>
  );
};
