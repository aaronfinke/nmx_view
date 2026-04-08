// Neutron d-spacing calculation from TOF + detector geometry

const PLANCK = 6.62607015e-34; // J·s
const NEUTRON_MASS = 1.674927471e-27; // kg

export interface PanelGeometry {
  /** Position of the detector center in lab frame (meters) */
  origin: [number, number, number];
  /** Unit vector along fast (column) axis */
  fastAxis: [number, number, number];
  /** Unit vector along slow (row) axis */
  slowAxis: [number, number, number];
  /** Pixel pitch along fast axis (meters) */
  xPixelSize: number;
  /** Pixel pitch along slow axis (meters) */
  yPixelSize: number;
  /** Source-to-sample distance L1 (meters) */
  sourceDistance: number;
  /** Number of rows (slow axis) */
  nRows: number;
  /** Number of columns (fast axis) */
  nCols: number;
}

/** Beam direction: neutrons travel along +z */
const BEAM_DIR: [number, number, number] = [0, 0, 1];

export interface DSpacingResult {
  /** d-spacing in Ångströms */
  dSpacing: number;
  /** Neutron wavelength in Ångströms */
  wavelength: number;
  /** Scattering angle 2θ in degrees */
  twoTheta: number;
}

/**
 * Compute d-spacing for a single pixel at the given TOF.
 * row = slow axis index, col = fast axis index, tofNs = TOF in nanoseconds.
 * Returns null if geometry is incomplete or calculation is undefined.
 */
export function computePixelDSpacing(
  row: number,
  col: number,
  tofNs: number,
  geom: PanelGeometry
): DSpacingResult | null {
  if (geom.sourceDistance <= 0 || tofNs <= 0) return null;

  // Pixel offset from detector center (origin is the detector center)
  const dc = col - (geom.nCols - 1) / 2;
  const dr = row - (geom.nRows - 1) / 2;

  // 3D position of pixel in lab frame (meters)
  const px =
    geom.origin[0] +
    dc * geom.xPixelSize * geom.fastAxis[0] +
    dr * geom.yPixelSize * geom.slowAxis[0];
  const py =
    geom.origin[1] +
    dc * geom.xPixelSize * geom.fastAxis[1] +
    dr * geom.yPixelSize * geom.slowAxis[1];
  const pz =
    geom.origin[2] +
    dc * geom.xPixelSize * geom.fastAxis[2] +
    dr * geom.yPixelSize * geom.slowAxis[2];

  // L2 = sample-to-pixel distance
  const L2 = Math.sqrt(px * px + py * py + pz * pz);
  if (L2 === 0) return null;

  // Total flight path
  const Ltotal = geom.sourceDistance + L2;

  // Wavelength: λ = h·t / (m_n · L) → Ångströms (×1e10)
  const tofSec = tofNs * 1e-9;
  const wavelength = (PLANCK * tofSec / (NEUTRON_MASS * Ltotal)) * 1e10;
  if (wavelength <= 0) return null;

  // Scattering angle 2θ: cos(2θ) = beam · scattered_dir
  const cos2theta =
    (BEAM_DIR[0] * px + BEAM_DIR[1] * py + BEAM_DIR[2] * pz) / L2;
  const twoTheta = Math.acos(Math.max(-1, Math.min(1, cos2theta)));
  const sinTheta = Math.sin(twoTheta / 2);

  if (sinTheta <= 1e-12) return null; // forward beam — 2θ ≈ 0

  // Bragg's law: d = λ / (2·sin(θ))
  const dSpacing = wavelength / (2 * sinTheta);

  return {
    dSpacing,
    wavelength,
    twoTheta: twoTheta * (180 / Math.PI),
  };
}

/**
 * Compute neutron wavelength from TOF and total flight path.
 * λ = h·t / (m_n · L_total), returned in Ångströms.
 * totalDistanceM = L1 + average L2 (meters), tofNs in nanoseconds.
 */
export function tofToWavelength(tofNs: number, totalDistanceM: number): number {
  const tofSec = tofNs * 1e-9;
  return (PLANCK * tofSec / (NEUTRON_MASS * totalDistanceM)) * 1e10;
}
