# TinyBox

TinyBox is a small browser-based slicer for TinyMaker resin printers.

It loads STL files locally in your browser, slices them into 320x240 PNG mask layers, and packages the result as a `job.zip` ready to copy to an SD card.

## Features

- STL loading in the browser
- Sample cube for quick testing
- TinyMaker-style PNG layer export: `1.png`, `2.png`, `3.png`, ...
- ZIP output with a top-level job folder and `manifest.json`
- Layer preview with scrubber and mouse-wheel stepping
- Invert and mirror mask options
- Light and dark mode
- No server-side upload; slicing happens on your machine

## Quick Start

```bash
npm install
npm run dev
```

Open the Vite URL, usually:

```text
http://127.0.0.1:5173/
```

Then load an STL or the sample cube, adjust the printer profile, click `Slice`, and download the ZIP when it is ready.

## Build

```bash
npm run build
```

The production build is written to `dist/`.

## GitHub Pages

This repo includes a GitHub Actions workflow at `.github/workflows/pages.yml`.

On pushes to `main`, it installs dependencies, builds the Vite app, uploads `dist/`, and deploys to GitHub Pages.

## TinyMaker Notes

The default profile is based on a TinyMaker/ChituBox-style configuration:

- Resolution: `320 x 240`
- Build area: `40.8 x 30.6 mm`
- Layer height: `0.05 mm`
- Bottom/base layers: `8`
- Mirror mask: enabled by default

TinyMaker firmware has a layer-height quirk: when device layer height is greater than `0.06 mm`, the firmware loads odd-indexed images. TinyBox handles this by slicing at half-step automatically.

The firmware layer limit is `1080`; TinyBox warns and stops if the estimated layer count exceeds that.

## Project Structure

- `src/App.svelte` - UI, app state, STL loading, ZIP preparation, preview controls
- `src/slicer-worker.js` - slicing and rasterization Web Worker
- `src/main.js` - Svelte entry point
- `index.html` - Vite mount point
- `vite.config.js` - Vite/Svelte config

## Current Limits

This is still an MVP slicer. Complex or non-manifold models may need better polygon cleanup in the future, likely via a clipping library.

## License

MIT. See [LICENSE](./LICENSE).
