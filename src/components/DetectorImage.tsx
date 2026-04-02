import React, { useMemo, useCallback, useRef, useState } from "react";
import { HeatmapVis, ScaleType } from "@h5web/lib";
import type { ColorScaleType, DefaultInteractionsConfig } from "@h5web/lib";
import type { Domain } from "@h5web/lib";
import ndarray from "ndarray";
import type { DetectorImageResult } from "../lib/event-data";

export type InteractionMode = "zoom" | "profile";

export interface SelectionRegion {
  rows: [number, number];
  cols: [number, number];
}

interface DetectorImageProps {
  imageResult: DetectorImageResult;
  panelName: string;
  colorScale?: ColorScaleType;
  size: number;
  domain: Domain;
  singlePanel?: boolean;
  interactionMode?: InteractionMode;
  onProfileSelection?: (region: SelectionRegion) => void;
}

export const DetectorImage: React.FC<DetectorImageProps> = ({
  imageResult,
  panelName,
  colorScale = ScaleType.Log,
  size,
  domain,
  singlePanel = false,
  interactionMode = "zoom",
  onProfileSelection,
}) => {
  const { image, shape, totalEvents } = imageResult;

  const dataNd = useMemo(
    () => ndarray(Array.from(image), shape),
    [image, shape]
  );

  const isProfileMode = singlePanel && interactionMode === "profile";

  const interactions: DefaultInteractionsConfig = singlePanel
    ? isProfileMode
      ? {
          selectToZoom: false,
          zoom: false,
          pan: false,
          xAxisZoom: false,
          yAxisZoom: false,
          xSelectToZoom: false,
          ySelectToZoom: false,
        }
      : {
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

  /* ---- HTML overlay selection for profile mode ---- */
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragEnd, setDragEnd] = useState<{ x: number; y: number } | null>(null);
  const [selRect, setSelRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const toDataCoords = useCallback(
    (px: number, py: number, containerRect: DOMRect, container: Element) => {
      // Find the actual Three.js canvas inside the h5web container —
      // the data region is the canvas, not the full container (axis margins, color bar area).
      const canvas = container.querySelector("canvas");
      let dataRect = containerRect;
      if (canvas) {
        dataRect = canvas.getBoundingClientRect();
      }
      // Map pixel position relative to the canvas
      const relX = (px + containerRect.left) - dataRect.left;
      const relY = (py + containerRect.top) - dataRect.top;
      const col = Math.round((relX / dataRect.width) * shape[1]);
      const row = Math.round(((dataRect.height - relY) / dataRect.height) * shape[0]); // y-axis is inverted
      return {
        col: Math.max(0, Math.min(shape[1] - 1, col)),
        row: Math.max(0, Math.min(shape[0] - 1, row)),
      };
    },
    [shape]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!isProfileMode) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      setDragStart({ x, y });
      setDragEnd({ x, y });
      setSelRect(null);
    },
    [isProfileMode]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isProfileMode || !dragStart) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      setDragEnd({ x, y });
    },
    [isProfileMode, dragStart]
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (!isProfileMode || !dragStart || !dragEnd) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const endX = e.clientX - rect.left;
      const endY = e.clientY - rect.top;

      const startData = toDataCoords(dragStart.x, dragStart.y, rect, e.currentTarget);
      const endData = toDataCoords(endX, endY, rect, e.currentTarget);

      const rowStart = Math.min(startData.row, endData.row);
      const rowEnd = Math.max(startData.row, endData.row);
      const colStart = Math.min(startData.col, endData.col);
      const colEnd = Math.max(startData.col, endData.col);

      // Keep the visual rectangle
      const sx = Math.min(dragStart.x, endX);
      const sy = Math.min(dragStart.y, endY);
      setSelRect({ x: sx, y: sy, w: Math.abs(endX - dragStart.x), h: Math.abs(endY - dragStart.y) });

      setDragStart(null);
      setDragEnd(null);

      if (colEnd > colStart && rowEnd > rowStart && onProfileSelection) {
        onProfileSelection({ rows: [rowStart, rowEnd], cols: [colStart, colEnd] });
      }
    },
    [isProfileMode, dragStart, dragEnd, toDataCoords, onProfileSelection]
  );

  // Compute the in-progress drag rectangle
  const liveRect =
    dragStart && dragEnd
      ? {
          x: Math.min(dragStart.x, dragEnd.x),
          y: Math.min(dragStart.y, dragEnd.y),
          w: Math.abs(dragEnd.x - dragStart.x),
          h: Math.abs(dragEnd.y - dragStart.y),
        }
      : null;

  const showRect = liveRect || selRect;

  return (
    <div className="detector-image-panel">
      <h3>
        {panelName} — {totalEvents.toLocaleString()} events
      </h3>
      <div
        ref={containerRef}
        style={{
          width: size,
          height: size,
          display: "flex",
          flexDirection: "column",
          position: "relative",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
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
        {isProfileMode && showRect && showRect.w > 2 && showRect.h > 2 && (
          <svg
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              pointerEvents: "none",
              zIndex: 10,
            }}
          >
            <rect
              x={showRect.x}
              y={showRect.y}
              width={showRect.w}
              height={showRect.h}
              fill="rgba(0, 153, 220, 0.2)"
              stroke="#0099DC"
              strokeWidth={2}
            />
          </svg>
        )}
        {isProfileMode && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              cursor: "crosshair",
              zIndex: 5,
            }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          />
        )}
      </div>
    </div>
  );
};
