import { useRef, useEffect } from "react";

// Viridis colormap sampled at 256 points (RGB 0–255)
const VIRIDIS: [number, number, number][] = [];
// We'll generate from the standard Viridis control points
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

// Build 256-entry LUT
for (let i = 0; i < 256; i++) {
  const t = i / 255;
  const idx = t * (VIRIDIS_DATA.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, VIRIDIS_DATA.length - 1);
  const frac = idx - lo;
  const a = VIRIDIS_DATA[lo].map((v) => v * 255);
  const b = VIRIDIS_DATA[hi].map((v) => v * 255);
  VIRIDIS.push(lerpColor(a, b, frac));
}

interface Props {
  width: number;
  height: number;
}

export function ViridisColorBar({ width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Draw vertical gradient: top = high values (yellow), bottom = low values (purple)
    for (let y = 0; y < height; y++) {
      const t = 1 - y / (height - 1); // top=1, bottom=0
      const idx = Math.round(t * 255);
      const [r, g, b] = VIRIDIS[idx];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, y, width, 1);
    }
  }, [width, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, display: "block", borderRadius: 3 }}
    />
  );
}
