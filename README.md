# NMX Viewer

Interactive browser-based viewer for NMX detector data stored in NeXus/HDF5 files.

Designed for fast exploration of time-of-flight neutron event data, with support for both raw event streams and pre-binned Laue TOF data. All processing runs entirely in the browser — no server, no upload.

## Features

### File Handling
- Load local HDF5/NeXus (`.h5`, `.hdf`, `.nxs`) files via drag-and-drop or file picker
- Auto-detect file type:
  - `NXevent_data` — raw neutron event streams, binned on the fly
  - `NXlauetof` — pre-binned 3D TOF slices
- Reload workflow for live/SWMR-style updates

### Detector View
- Multi-panel overview grid (up to 3 columns) and single-panel inspection modes
- Colour maps: Viridis, Inferno, Greys (inverted)
- Shared colour bar with manual min/max domain inputs and auto-scaling (µ + 2σ)
- d-spacing and 2θ readout in pixel tooltip (NXlauetof, requires panel geometry)

### TOF Controls
- Dual-thumb range slider with draggable selection window
- Keyboard stepping: `←` / `→` shift the selection window by its current width
- TOF histogram display

### Single-Panel Analysis Tools

Activated from the floating toolbar (top-left of the panel) or keyboard shortcuts:

| Tool | Key | Description |
|------|-----|-------------|
| Zoom | `Z` | Select-to-zoom; `Esc` resets |
| Line scan | `L` | Click two points → 1D intensity profile along the line |
| Box integration | `B` | Click two corners → 1D projection integrated across the box |

**Line scan**: extracts pixel values along an arbitrary line. Profile updates live when the TOF window changes.

**Box integration**: integrates counts within a rectangular region. Toggle between integrating along the slow axis (→ profile vs. column) or fast axis (→ profile vs. row) using the axis button in the toolbar. Profile updates live when the TOF window changes.

**Peak analysis**: click **Analyze** on any line or box profile to run automatic Bragg peak detection ([ml-gsd](https://github.com/mljs/gsd)):
- Peak position, height, inflection-point width
- Baseline-subtracted integral between inflection points
- Poisson SNR: (peak − noise) / √noise
- Numbered peak markers overlaid on the plot
- Scrollable results table

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `H` | Toggle help overlay |
| `Esc` | Close help / cancel drawing / reset zoom |
| `←` / `→` | Shift TOF selection window |
| `Z` | Zoom mode (single panel) |
| `L` | Line scan mode (single panel) |
| `B` | Box integration mode (single panel) |

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Install

```bash
npm install
```

### Run Development Server

```bash
npm run dev
```

Open the local Vite URL (typically `http://localhost:5173`).

### Build for Production

```bash
npm run build
```

### Preview Production Build

```bash
npm run preview
```

## Project Structure

```text
src/
  components/
    DetectorImage.tsx   — panel heatmap, drawing tools, toolbar
    FileLoader.tsx      — drag-and-drop / file picker
    LineScanPlot.tsx    — 1D profile SVG chart + peak analysis
    TofRangeSlider.tsx  — dual-thumb TOF slider
    TofHistogram.tsx    — histogram display
    ViridisColorBar.tsx — custom colour bar (Viridis, Inferno, Greys_r)
  lib/
    event-data.ts       — TOF histogram + detector image computation
    h5wasm-loader.ts    — HDF5 reading, panel discovery, NXlauetof slicing
    dspacing.ts         — d-spacing / 2θ from panel geometry
  App.tsx               — main app state and layout
```

## Tech Stack

- React 18 + TypeScript + Vite
- [h5wasm](https://github.com/usnistgov/h5wasm) — in-browser HDF5 via WebAssembly
- [@h5web/lib](https://github.com/silx-kit/h5web) — WebGL heatmap renderer
- [ml-gsd](https://github.com/mljs/gsd) — browser-side peak detection

## Notes

- All computation (HDF5 reading, event binning, peak analysis) runs client-side. Large files may require noticeable memory and processing time.
- The JS bundle includes WebAssembly and 3D rendering dependencies; expect ~1.4 MB gzipped.

## License

MIT License
