import React, { useCallback, useMemo } from "react";
import { HeatmapVis, ScaleType } from "@h5web/lib";
import type { ColorScaleType, DefaultInteractionsConfig } from "@h5web/lib";
import type { Domain } from "@h5web/lib";
import ndarray from "ndarray";
import type { DetectorImageResult } from "../lib/event-data";
import { computePixelDSpacing, type PanelGeometry } from "../lib/dspacing";

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
  /** Panel geometry for d-spacing (NXlauetof only) */
  panelGeometry?: PanelGeometry | null;
  /** Current TOF center in nanoseconds (NXlauetof only) */
  tofCenterNs?: number;
}

export const DetectorImage: React.FC<DetectorImageProps> = ({
  imageResult,
  panelName,
  colorScale = ScaleType.Log,
  size,
  domain,
  singlePanel = false,
  panelGeometry,
  tofCenterNs,
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

  const renderTooltip = useCallback(
    (data: { xi: number; yi: number }) => {
      const { xi, yi } = data;
      const col = xi;
      const row = yi;
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
          renderTooltip={renderTooltip}
        />
      </div>
    </div>
  );
};
