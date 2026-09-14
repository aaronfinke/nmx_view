import { useCallback, useEffect, useRef, useState } from "react";
import { ScaleType } from "@h5web/lib";
import type { ColorMap, ColorScaleType, Domain } from "@h5web/lib";
import type { DetectorImageResult } from "../lib/event-data";
import { LUTS } from "./ViridisColorBar";

/**
 * Overview-grid panel drawn with Canvas2D instead of `HeatmapVis`.
 *
 * Every HeatmapVis is a three.js WebGL canvas, and browsers cap a page at
 * roughly 16 live WebGL contexts — MANDI alone produces 41 panels, so the
 * surplus contexts get force-evicted and render as Chrome's crashed-canvas
 * placeholder. Those contexts are not reclaimed when the panels unmount, so
 * mounting lazily does not help; the grid has to stop using WebGL entirely.
 *
 * Overview panels only ever needed a picture and a hover readout — zoom, line
 * scan and box integration are single-panel tools — so a LUT blit covers it,
 * and costs one canvas per panel with no context limit.
 */
interface Props {
  imageResult: DetectorImageResult;
  panelName: string;
  size: number;
  domain: Domain;
  colorScale?: ColorScaleType;
  colorMap?: ColorMap | "Greys_r";
}

/** Map a value to [0,1] within `domain` under the active colour scale. */
function normalize(v: number, lo: number, hi: number, scale: ColorScaleType): number {
  if (scale === ScaleType.Log) {
    const sLo = Math.log10(Math.max(lo, 1e-6));
    const sHi = Math.log10(Math.max(hi, 1e-6));
    if (v <= 0 || sHi <= sLo) return 0;
    return (Math.log10(v) - sLo) / (sHi - sLo);
  }
  if (scale === ScaleType.SymLog) {
    const f = (x: number) => Math.sign(x) * Math.log10(1 + Math.abs(x));
    const sLo = f(lo);
    const sHi = f(hi);
    if (sHi <= sLo) return 0;
    return (f(v) - sLo) / (sHi - sLo);
  }
  if (hi <= lo) return 0;
  return (v - lo) / (hi - lo);
}

export function PanelThumbnail({
  imageResult,
  panelName,
  size,
  domain,
  colorScale = ScaleType.Linear,
  colorMap = "Viridis" as ColorMap | "Greys_r",
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; row: number; col: number; value: number } | null>(null);

  const { image, shape, totalEvents } = imageResult;
  const [rows, cols] = shape;
  const [lo, hi] = domain;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Draw at detector resolution, then let CSS scale the element to `size`.
    canvas.width = cols;
    canvas.height = rows;

    // Greys_r is a real LUT here, so the canvas is never CSS-inverted (the
    // WebGL path fakes it with filter: invert(1) because h5web has no
    // reversed colormaps).
    const lut = LUTS[colorMap] ?? LUTS["Viridis"];
    const img = ctx.createImageData(cols, rows);
    const px = img.data;

    for (let r = 0; r < rows; r++) {
      // h5web puts row 0 at the bottom; match that so a panel looks the same
      // in the grid as it does in single-panel view.
      const srcRow = rows - 1 - r;
      for (let c = 0; c < cols; c++) {
        const v = image[srcRow * cols + c];
        const t = normalize(v, lo, hi, colorScale);
        const idx = Math.max(0, Math.min(255, Math.round(t * 255)));
        const [cr, cg, cb] = lut[idx];
        const o = (r * cols + c) * 4;
        px[o] = cr;
        px[o + 1] = cg;
        px[o + 2] = cb;
        px[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [image, rows, cols, lo, hi, colorScale, colorMap]);

  const handleMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      const col = Math.floor(fx * cols);
      // Invert back into detector row space (row 0 at the bottom)
      const row = rows - 1 - Math.floor(fy * rows);
      if (col < 0 || col >= cols || row < 0 || row >= rows) return setHover(null);
      setHover({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        row,
        col,
        value: image[row * cols + col],
      });
    },
    [image, rows, cols]
  );

  return (
    <div className="detector-image-panel">
      <div className="detector-panel-header">
        <h3>
          {panelName} — {totalEvents.toLocaleString()} events
        </h3>
      </div>
      <div style={{ position: "relative", width: size, height: size }}>
        <canvas
          ref={canvasRef}
          style={{
            width: "100%",
            height: "100%",
            display: "block",
            imageRendering: "pixelated",
          }}
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        />
        {hover && (
          <div className="thumb-tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
            Pixel: ({hover.col}, {hover.row})
            <br />
            Value: {hover.value}
          </div>
        )}
      </div>
    </div>
  );
}
