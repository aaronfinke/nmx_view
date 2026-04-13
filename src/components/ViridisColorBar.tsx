import { useRef, useEffect } from "react";
import type { ColorMap } from "@h5web/lib";

function lerpColor(
  a: number[],
  b: number[],
  t: number,
): [number, number, number] {
  return [
    Math.round(a[0] * (1 - t) + b[0] * t),
    Math.round(a[1] * (1 - t) + b[1] * t),
    Math.round(a[2] * (1 - t) + b[2] * t),
  ];
}

function buildLut(data: number[][]): [number, number, number][] {
  const lut: [number, number, number][] = [];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const idx = t * (data.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, data.length - 1);
    const frac = idx - lo;
    const a = data[lo].map((v) => v * 255);
    const b = data[hi].map((v) => v * 255);
    lut.push(lerpColor(a, b, frac));
  }
  return lut;
}

const VIRIDIS_DATA = [
  [0.267004, 0.004874, 0.329415],
  [0.282327, 0.140926, 0.457517],
  [0.253935, 0.265254, 0.529983],
  [0.206756, 0.371758, 0.553117],
  [0.163625, 0.471133, 0.558148],
  [0.127568, 0.566949, 0.550556],
  [0.134692, 0.658636, 0.517649],
  [0.266941, 0.748751, 0.440573],
  [0.477504, 0.821444, 0.318195],
  [0.741388, 0.873449, 0.149561],
  [0.993248, 0.906157, 0.143936],
];

const INFERNO_DATA = [
  [0.001462, 0.000466, 0.013866],
  [0.087411, 0.044556, 0.224944],
  [0.258234, 0.038571, 0.406485],
  [0.416331, 0.090937, 0.433109],
  [0.578304, 0.148039, 0.404411],
  [0.735683, 0.215906, 0.330245],
  [0.865006, 0.316782, 0.226055],
  [0.955454, 0.454109, 0.113072],
  [0.995131, 0.618590, 0.034631],
  [0.987622, 0.790524, 0.170931],
  [0.988362, 0.998364, 0.644924],
];

const GREYS_DATA = [
  [0.0, 0.0, 0.0],
  [1.0, 1.0, 1.0],
];

const LUTS: Record<string, [number, number, number][]> = {
  Viridis: buildLut(VIRIDIS_DATA),
  Inferno: buildLut(INFERNO_DATA),
  Greys: buildLut(GREYS_DATA),
};

interface Props {
  width: number;
  height: number;
  colorMap?: ColorMap;
}

export function ColorBar({ width, height, colorMap = "Viridis" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lut = LUTS[colorMap] ?? LUTS["Viridis"];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Draw vertical gradient: top = high values, bottom = low values
    for (let y = 0; y < height; y++) {
      const t = 1 - y / (height - 1); // top=1, bottom=0
      const idx = Math.round(t * 255);
      const [r, g, b] = lut[idx];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, y, width, 1);
    }
  }, [width, height, lut]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, display: "block", borderRadius: 3 }}
    />
  );
}

/** @deprecated use ColorBar */
export const ViridisColorBar = ColorBar;
