import { useRef, useEffect } from "react";
import type { ColorMap } from "@h5web/lib";
import { LUTS } from "../lib/colormap";

interface Props {
  width: number;
  height?: number;
  colorMap?: ColorMap | "Greys_r";
}

export function ColorBar({ width, height, colorMap = "Viridis" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lut = LUTS[colorMap] ?? LUTS["Viridis"];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const h = canvas.offsetHeight;
      if (h === 0) return;
      canvas.width = width;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      for (let y = 0; y < h; y++) {
        const t = 1 - y / (h - 1);
        const idx = Math.round(t * 255);
        const [r, g, b] = lut[idx];
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(0, y, width, 1);
      }
    };

    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    draw();
    return () => ro.disconnect();
  }, [width, lut]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height: height ?? "100%", display: "block", borderRadius: 3 }}
    />
  );
}

/** @deprecated use ColorBar */
export const ViridisColorBar = ColorBar;
