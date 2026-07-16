<script>
  import { onMount, tick } from 'svelte';
  import { zipSync } from 'fflate';
  import * as THREE from 'three';
  import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

  let fileInput;
  let previewCanvas;
  let logEl;
  let worker = null;
  let meshTriangles = null;
  let bbox = null;
  let preparedZipBlob = null;
  let preparedZipName = 'job.zip';
  let progress = 'idle';
  let selectedModelName = 'No model loaded';
  let theme = 'light';
  let logs = [];
  let previewMax = 1;
  let previewLayer = 1;
  let previewBlobs = new Map();
  let previewAutoFollow = true;
  let isSlicing = false;

  let profile = {
    pixW: 320,
    pixH: 240,
    buildW: 40.8,
    buildH: 30.6,
    layerH: 0.05,
    baseLayers: 8,
    invert: false,
    mirror: true,
    aa: 'none',
    jobName: 'job',
    normalExposure: 6,
    bottomExposure: 50,
    liftHeight: 5,
    liftSpeed: 65,
    retractSpeed: 150,
    lightDelay: 0,
    lightPwm: 255,
    machineHeight: 54
  };

  $: canSlice = Boolean(meshTriangles) && !isSlicing;
  $: canDownload = Boolean(preparedZipBlob);
  $: if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme;
  }

  onMount(() => {
    const savedTheme = localStorage.getItem('tinybox-theme');
    if (savedTheme === 'dark' || savedTheme === 'light') {
      theme = savedTheme;
    } else if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
      theme = 'dark';
    }
  });

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('tinybox-theme', theme);
  }

  function formatNumber(value, decimals = 3) {
    return Number(value).toFixed(decimals).replace(/\.?0+$/, '');
  }

  function generateRunGcode(totalImages, sliceProfile) {
    const lines = [
      'G21;',
      'G90;',
      'M106 S0;',
      'G28 Z0;',
      ''
    ];
    const useOddImages = sliceProfile.layerH > 0.06;
    const printableLayers = useOddImages ? Math.ceil(totalImages / 2) : totalImages;

    for (let layer = 1; layer <= printableLayers; layer++) {
      const imageIndex = useOddImages ? ((layer - 1) * 2) + 1 : layer;
      if (imageIndex > totalImages) break;

      const currPos = imageIndex * sliceProfile.exportStep;
      const risePos = currPos + sliceProfile.liftHeight;
      const exposureSeconds = layer <= sliceProfile.baseLayers
        ? sliceProfile.bottomExposure
        : sliceProfile.normalExposure;

      lines.push(
        `;LAYER_START:${layer - 1}`,
        `;currPos:${formatNumber(currPos)}`,
        `M6054 "${imageIndex}.png";show Image`,
        `G0 Z${formatNumber(risePos)} F${formatNumber(sliceProfile.liftSpeed)};`,
        `G0 Z${formatNumber(currPos)} F${formatNumber(sliceProfile.retractSpeed)};`,
        `G4 P${Math.round(sliceProfile.lightDelay * 1000)};`,
        `M106 S${Math.round(sliceProfile.lightPwm)};light on`,
        `G4 P${Math.round(exposureSeconds * 1000)};`,
        'M106 S0; light off',
        ';LAYER_END',
        ''
      );
    }

    lines.push(
      'M106 S0;',
      `G1 Z${formatNumber(sliceProfile.machineHeight)} F25;`,
      'M18;',
      ''
    );

    return lines.join('\n');
  }

  async function logMsg(...args) {
    logs = [...logs, args.join(' ')];
    await tick();
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }

  function resetPreparedZip() {
    preparedZipBlob = null;
    preparedZipName = 'job.zip';
  }

  function resetPreview() {
    previewMax = 1;
    previewLayer = 1;
    previewBlobs = new Map();
    previewAutoFollow = true;
    if (previewCanvas) {
      const ctx = previewCanvas.getContext('2d', { alpha: false });
      ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    }
  }

  function setModel(triangles, bounds) {
    meshTriangles = triangles;
    bbox = bounds;
    resetPreparedZip();
    resetPreview();
  }

  async function renderPreviewLayer(layer) {
    const blob = previewBlobs.get(layer);
    if (!blob || !previewCanvas) return;

    const bitmap = await createImageBitmap(blob);
    const ctx = previewCanvas.getContext('2d', { alpha: false });
    ctx.drawImage(bitmap, 0, 0, previewCanvas.width, previewCanvas.height);
    bitmap.close?.();
  }

  function clampLayer(layer) {
    return Math.min(Math.max(Number(layer) || 1, 1), previewMax);
  }

  async function setPreviewLayer(layer, { manual = true } = {}) {
    previewLayer = clampLayer(layer);
    if (manual) previewAutoFollow = false;
    await renderPreviewLayer(previewLayer);
  }

  function stepPreview(delta) {
    setPreviewLayer(previewLayer + delta);
  }

  function handlePreviewWheel(event) {
    if (previewMax <= 1) return;
    event.preventDefault();
    stepPreview(event.deltaY > 0 ? 1 : -1);
  }

  async function handleFileChange(event) {
    const files = event.target?.files;
    if (!files || files.length === 0) return;
    selectedModelName = files[0].name;
    await loadMeshFromFile(files[0]);
  }

  async function loadMeshFromFile(file) {
    const buffer = await file.arrayBuffer();
    const name = file.name.toLowerCase();
    if (!name.endsWith('.stl')) {
      await logMsg('Unsupported format. Only STL supported in this MVP.');
      return;
    }

    const loader = new STLLoader();
    const geometry = loader.parse(buffer);
    const posAttr = geometry.getAttribute('position');
    const triCount = posAttr.count / 3;
    const tris = new Float32Array(triCount * 9);

    for (let t = 0; t < triCount; t++) {
      for (let v = 0; v < 3; v++) {
        const i = t * 3 + v;
        tris[t * 9 + v * 3 + 0] = posAttr.getX(i);
        tris[t * 9 + v * 3 + 1] = posAttr.getY(i);
        tris[t * 9 + v * 3 + 2] = posAttr.getZ(i);
      }
    }

    setModel(tris, new THREE.Box3().setFromBufferAttribute(posAttr));
    await logMsg('Loaded STL:', file.name, 'triangles:', triCount);
  }

  async function loadSample() {
    const size = 20;
    const half = size / 2;
    const verts = [
      -half, -half, -half,
      half, -half, -half,
      half, half, -half,
      -half, half, -half,
      -half, -half, half,
      half, -half, half,
      half, half, half,
      -half, half, half
    ];
    const faces = [
      0, 1, 2, 0, 2, 3,
      1, 5, 6, 1, 6, 2,
      5, 4, 7, 5, 7, 6,
      4, 0, 3, 4, 3, 7,
      3, 2, 6, 3, 6, 7,
      4, 5, 1, 4, 1, 0
    ];
    const tris = new Float32Array(faces.length * 3);

    for (let i = 0; i < faces.length; i++) {
      const vi = faces[i] * 3;
      tris[i * 3 + 0] = verts[vi + 0];
      tris[i * 3 + 1] = verts[vi + 1];
      tris[i * 3 + 2] = verts[vi + 2];
    }

    setModel(tris, {
      min: { x: -half, y: -half, z: -half },
      max: { x: half, y: half, z: half }
    });
    if (fileInput) fileInput.value = '';
    selectedModelName = 'Sample cube';
    await logMsg('Loaded sample cube.');
  }

  async function sliceModel() {
    if (!meshTriangles) {
      await logMsg('No mesh loaded');
      return;
    }

    resetPreparedZip();
    resetPreview();

    const sliceProfile = {
      pixW: Number(profile.pixW),
      pixH: Number(profile.pixH),
      buildW: Number(profile.buildW),
      buildH: Number(profile.buildH),
      layerH: Number(profile.layerH),
      baseLayers: Number(profile.baseLayers),
      invert: profile.invert,
      mirror: profile.mirror,
      aa: profile.aa,
      jobName: profile.jobName || 'job',
      normalExposure: Number(profile.normalExposure),
      bottomExposure: Number(profile.bottomExposure),
      liftHeight: Number(profile.liftHeight),
      liftSpeed: Number(profile.liftSpeed),
      retractSpeed: Number(profile.retractSpeed),
      lightDelay: Number(profile.lightDelay),
      lightPwm: Number(profile.lightPwm),
      machineHeight: Number(profile.machineHeight)
    };

    sliceProfile.exportStep = sliceProfile.layerH <= 0.06 ? sliceProfile.layerH : sliceProfile.layerH / 2;
    await logMsg('Profile:', JSON.stringify(sliceProfile));

    const zMin = bbox ? bbox.min.z : 0;
    const zMax = bbox ? bbox.max.z : 0;
    const estimatedLayers = Math.ceil((zMax - zMin) / sliceProfile.exportStep);

    if (estimatedLayers > 1080) {
      await logMsg('ERROR: Estimated layers', estimatedLayers, 'exceeds firmware limit 1080. Reduce model height or increase layer height.');
      alert('Estimated layers > 1080. Change layer height or scale model.');
      return;
    }

    progress = 'Starting slicing...';
    isSlicing = true;

    if (worker) worker.terminate();
    worker = new Worker(new URL('./slicer-worker.js', import.meta.url), { type: 'module' });

    const zipFiles = {};
    const pngWrites = [];
    const jobFolder = sliceProfile.jobName.replace(/[\\/:*?"<>|]/g, '_');

    worker.onmessage = async (event) => {
      const msg = event.data;

      if (msg.type === 'progress') {
        progress = `Layer ${msg.current}/${msg.total} (${Math.round(100 * msg.current / msg.total)}%)`;
        previewMax = msg.total;
        if (previewAutoFollow) previewLayer = msg.current;
        if (msg.previewBitmap && previewCanvas) {
          const ctx = previewCanvas.getContext('2d', { alpha: false });
          previewCanvas.width = sliceProfile.pixW;
          previewCanvas.height = sliceProfile.pixH;
          if (previewAutoFollow || previewLayer === msg.current) {
            ctx.drawImage(msg.previewBitmap, 0, 0, previewCanvas.width, previewCanvas.height);
          }
          msg.previewBitmap.close?.();
        }
      } else if (msg.type === 'png') {
        const path = `${jobFolder}/${msg.name}`;
        const layer = Number.parseInt(msg.name, 10);
        if (Number.isFinite(layer)) {
          previewBlobs = new Map(previewBlobs).set(layer, msg.blob);
        }
        const write = msg.blob.arrayBuffer().then(async (buffer) => {
          zipFiles[path] = new Uint8Array(buffer);
          await logMsg('Added', path);
        });
        pngWrites.push(write);
      } else if (msg.type === 'done') {
        try {
          await Promise.all(pngWrites);
          const manifest = {
            jobName: jobFolder,
            profile: sliceProfile,
            producedLayers: msg.total
          };
          zipFiles[`${jobFolder}/manifest.json`] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
          zipFiles[`${jobFolder}/run.gcode`] = new TextEncoder().encode(generateRunGcode(msg.total, sliceProfile));

          const zipped = zipSync(zipFiles);
          preparedZipBlob = new Blob([zipped], { type: 'application/zip' });
          preparedZipName = `${jobFolder}.zip`;
          progress = 'Done - zip ready';
          await logMsg('Slicing complete. Produced layers:', msg.total, 'zip size (bytes):', preparedZipBlob.size);
        } catch (err) {
          await logMsg('Zip error:', err.message || String(err));
          progress = 'Error';
        } finally {
          isSlicing = false;
        }
      } else if (msg.type === 'error') {
        await logMsg('Worker error:', msg.error);
        progress = 'Error';
        isSlicing = false;
      }
    };

    const triangleBuffer = meshTriangles.buffer.slice(0);
    worker.postMessage(
      { type: 'start', triangles: triangleBuffer, bbox, profile: sliceProfile },
      [triangleBuffer]
    );
  }

  async function downloadZip() {
    if (!preparedZipBlob) {
      await logMsg('No zip ready. Slice a model first.');
      return;
    }

    const url = URL.createObjectURL(preparedZipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = preparedZipName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    progress = 'Zip downloaded';
    await logMsg('Downloaded', preparedZipName);
  }

  function resumePreviewFollow() {
    previewAutoFollow = true;
    setPreviewLayer(previewMax, { manual: false });
  }
</script>

<div class="app">
  <header class="app-header">
    <div class="brand">
      <div class="brand-title-row">
        <div class="brand-mark" aria-hidden="true"></div>
        <h1>TinyBox</h1>
      </div>
      <p class="tagline">A compact browser slicer for TinyMaker printers. Load an STL, prepare the image stack, then save a ZIP for the SD card.</p>
    </div>
    <div class="header-actions">
      <a class="icon-link" href="https://github.com/justinh-rahb/TinyBox" target="_blank" rel="noreferrer" aria-label="Open TinyBox on GitHub">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2C6.48 2 2 6.58 2 12.22c0 4.51 2.87 8.34 6.84 9.69.5.09.68-.22.68-.49v-1.9c-2.78.62-3.37-1.21-3.37-1.21-.45-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.05A9.36 9.36 0 0 1 12 6.91c.85 0 1.7.12 2.5.34 1.91-1.32 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.8-4.57 5.05.36.32.68.94.68 1.9v2.81c0 .27.18.59.69.49A10.05 10.05 0 0 0 22 12.22C22 6.58 17.52 2 12 2Z" />
        </svg>
      </a>
      <button class="theme-toggle" type="button" on:click={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
        {#if theme === 'dark'}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 4.75a1 1 0 0 1 1-1h.01a1 1 0 0 1 0 2H13a1 1 0 0 1-1-1Zm0 14.5a1 1 0 0 1 1-1h.01a1 1 0 0 1 0 2H13a1 1 0 0 1-1-1ZM4.75 12a1 1 0 0 1-1-1v-.01a1 1 0 0 1 2 0V11a1 1 0 0 1-1 1Zm14.5 0a1 1 0 0 1-1-1v-.01a1 1 0 0 1 2 0V11a1 1 0 0 1-1 1ZM6.52 6.52a1 1 0 0 1 0-1.41l.01-.01a1 1 0 1 1 1.41 1.41l-.01.01a1 1 0 0 1-1.41 0Zm10.25 10.25a1 1 0 0 1 0-1.41l.01-.01a1 1 0 0 1 1.41 1.41l-.01.01a1 1 0 0 1-1.41 0ZM6.52 17.48a1 1 0 0 1-1.41 0l-.01-.01a1 1 0 0 1 1.41-1.41l.01.01a1 1 0 0 1 0 1.41ZM16.77 7.23a1 1 0 0 1-1.41 0l-.01-.01a1 1 0 0 1 1.41-1.41l.01.01a1 1 0 0 1 0 1.41ZM12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" />
          </svg>
        {:else}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20.28 15.78A8.45 8.45 0 0 1 8.22 3.72a.8.8 0 0 0-.87-1.22A10.25 10.25 0 1 0 21.5 16.65a.8.8 0 0 0-1.22-.87Z" />
          </svg>
        {/if}
      </button>
      <div class="status-pill" aria-live="polite">
        <span class="status-dot" aria-hidden="true"></span>
        <span>{progress}</span>
      </div>
    </div>
  </header>

  <main class="workspace">
    <div class="stack">
      <section class="panel" aria-labelledby="model-title">
        <div class="panel-header">
          <div>
            <h2 class="panel-title" id="model-title">Model</h2>
            <p class="panel-subtitle">Choose an STL or start with the cube sample.</p>
          </div>
        </div>
        <div class="panel-body">
          <div class="file-row">
            <div class="field file-field">
              <span>Model file</span>
              <div class="file-control">
                <label class="file-trigger">
                  Choose STL
                  <input bind:this={fileInput} class="visually-hidden" type="file" accept=".stl" on:change={handleFileChange}>
                </label>
                <span class="file-name">{selectedModelName}</span>
              </div>
            </div>
            <button class="sample-btn" on:click={loadSample}>Load sample</button>
          </div>
        </div>
      </section>

      <section class="panel" aria-labelledby="profile-title">
        <div class="panel-header">
          <div>
            <h2 class="panel-title" id="profile-title">Printer Profile</h2>
            <p class="panel-subtitle">Pixel output, build area, layer behavior, and job naming.</p>
          </div>
        </div>
        <div class="panel-body">
          <div class="controls-grid">
            <label class="field">Pixel Width
              <input bind:value={profile.pixW} type="number" min="1">
            </label>
            <label class="field">Pixel Height
              <input bind:value={profile.pixH} type="number" min="1">
            </label>
            <label class="field">Build W (mm)
              <input bind:value={profile.buildW} type="number" step="1">
            </label>
            <label class="field">Build H (mm)
              <input bind:value={profile.buildH} type="number" step="1">
            </label>
            <label class="field">Device Layer Height (mm)
              <input bind:value={profile.layerH} type="number" step="0.01" min="0.01">
            </label>
            <label class="field">Base Layers
              <input bind:value={profile.baseLayers} type="number" min="0">
            </label>
            <label class="field">Antialiasing
              <select bind:value={profile.aa}>
                <option value="none">None (binary)</option>
                <option value="smooth">Smooth</option>
              </select>
            </label>
            <label class="field">Job name
              <input bind:value={profile.jobName} type="text">
            </label>
            <label class="checkbox-field">
              <input bind:checked={profile.invert} type="checkbox">
              <span>Invert mask</span>
            </label>
            <label class="checkbox-field">
              <input bind:checked={profile.mirror} type="checkbox">
              <span>Mirror mask</span>
            </label>
          </div>
          <p class="note">Firmware special rule: if device layer height is greater than 0.06 mm, TinyMaker firmware loads odd-indexed images, so TinyBox slices at half-step automatically.</p>
        </div>
      </section>

      <section class="panel" aria-labelledby="gcode-title">
        <div class="panel-header">
          <div>
            <h2 class="panel-title" id="gcode-title">G-code</h2>
            <p class="panel-subtitle">Exposure and Z motion settings for the generated run.gcode file.</p>
          </div>
        </div>
        <div class="panel-body">
          <div class="controls-grid">
            <label class="field">Normal Exposure (s)
              <input bind:value={profile.normalExposure} type="number" step="0.1" min="0">
            </label>
            <label class="field">Bottom Exposure (s)
              <input bind:value={profile.bottomExposure} type="number" step="0.1" min="0">
            </label>
            <label class="field">Lift Height (mm)
              <input bind:value={profile.liftHeight} type="number" step="0.1" min="0">
            </label>
            <label class="field">Lift Speed
              <input bind:value={profile.liftSpeed} type="number" step="1" min="0">
            </label>
            <label class="field">Retract Speed
              <input bind:value={profile.retractSpeed} type="number" step="1" min="0">
            </label>
            <label class="field">Light Delay (s)
              <input bind:value={profile.lightDelay} type="number" step="0.1" min="0">
            </label>
            <label class="field">Light PWM
              <input bind:value={profile.lightPwm} type="number" step="1" min="0" max="255">
            </label>
            <label class="field">Machine Height (mm)
              <input bind:value={profile.machineHeight} type="number" step="0.1" min="0">
            </label>
          </div>
        </div>
      </section>

      <section class="panel" aria-labelledby="actions-title">
        <div class="panel-header">
          <div>
            <h2 class="panel-title" id="actions-title">Output</h2>
            <p class="panel-subtitle">Slice first. Download becomes available when the ZIP is ready.</p>
          </div>
        </div>
        <div class="panel-body">
          <div class="action-row">
            <button class="primary" disabled={!canSlice} on:click={sliceModel}>Slice</button>
            <button disabled={!canDownload} on:click={downloadZip}>Download Zip</button>
            <div class="progress-box" aria-hidden="true">{preparedZipName}</div>
          </div>
        </div>
      </section>

      <section class="panel debug-panel" aria-labelledby="debug-title">
        <div class="panel-header">
          <div>
            <h2 class="panel-title" id="debug-title">Debug Output</h2>
            <p class="panel-subtitle">Slice events, ZIP contents, and worker errors show up here.</p>
          </div>
        </div>
        <div class="panel-body">
          <pre bind:this={logEl}>{logs.join('\n')}</pre>
        </div>
      </section>
    </div>

    <aside class="stack">
      <section class="panel" aria-labelledby="preview-title">
        <div class="panel-header">
          <div>
            <h2 class="panel-title" id="preview-title">Preview</h2>
            <p class="panel-subtitle">The latest rendered layer appears while slicing.</p>
          </div>
          <button class="small-button" disabled={!meshTriangles || previewMax <= 1} on:click={resumePreviewFollow}>Follow</button>
        </div>
        <div class="panel-body">
          <div class="preview-tools">
            <button class="icon-button" disabled={previewMax <= 1} aria-label="Previous layer" on:click={() => stepPreview(-1)}>‹</button>
            <label class="scrubber-field">Layer {previewLayer} / {previewMax}
              <input
                class="layer-scrubber"
                type="range"
                min="1"
                max={previewMax}
                value={previewLayer}
                disabled={previewMax <= 1}
                on:input={(event) => setPreviewLayer(event.currentTarget.value)}
              >
            </label>
            <button class="icon-button" disabled={previewMax <= 1} aria-label="Next layer" on:click={() => stepPreview(1)}>›</button>
          </div>
          <div class="preview-frame" on:wheel={handlePreviewWheel}>
            <canvas bind:this={previewCanvas} width="320" height="240"></canvas>
          </div>
        </div>
      </section>

      <section class="panel" aria-labelledby="instructions-title">
        <div class="panel-header">
          <div>
            <h2 class="panel-title" id="instructions-title">Instructions</h2>
          </div>
        </div>
        <div class="panel-body">
          <ol>
            <li>Slice the loaded model.</li>
            <li>Download job.zip after slicing finishes.</li>
            <li>Extract job.zip to the SD card root so you have /job/1.png, /job/2.png,...</li>
            <li>Set TinyMaker Layer_Height to the Device Layer Height chosen here.</li>
          </ol>
        </div>
      </section>
    </aside>
  </main>

  <footer class="app-footer">
    Made with 🤖 by Justin Hayes
  </footer>
</div>

<style>
  :global(:root) {
    color-scheme: light;
    --bg: #f4f6f8;
    --panel: #ffffff;
    --panel-muted: #f8fafb;
    --control: #ffffff;
    --console: #11191c;
    --console-text: #dce7e9;
    --preview-check: #edf2f4;
    --ink: #172126;
    --muted: #61717a;
    --line: #d9e1e6;
    --line-strong: #b8c5cc;
    --accent: #0f7b74;
    --accent-dark: #0a5f5a;
    --accent-soft: #dff4f1;
    --warn-soft: #fff1d8;
    --warn: #8a5a00;
    --shadow: 0 18px 45px rgba(27, 43, 51, 0.08);
    --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  :global(:root[data-theme="dark"]) {
    color-scheme: dark;
    --bg: #11181c;
    --panel: #172126;
    --panel-muted: #1d2a30;
    --control: #10181c;
    --console: #071012;
    --console-text: #d7e5e8;
    --preview-check: #223137;
    --ink: #ecf3f4;
    --muted: #9aadb5;
    --line: #2c3b42;
    --line-strong: #4a5d66;
    --accent: #40c3b5;
    --accent-dark: #7adbd1;
    --accent-soft: #153f3d;
    --warn-soft: #3b2d12;
    --warn: #f2c56b;
    --shadow: 0 18px 45px rgba(0, 0, 0, 0.28);
  }

  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    min-height: 100vh;
    background: var(--bg);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.45;
  }

  button, input, select {
    font: inherit;
  }

  button {
    min-height: 40px;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background: var(--control);
    color: var(--ink);
    cursor: pointer;
    font-weight: 700;
    padding: 0 14px;
  }

  button:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent-dark);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.48;
  }

  input, select {
    width: 100%;
    min-height: 40px;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background: var(--control);
    color: var(--ink);
    padding: 7px 9px;
  }

  input:focus, select:focus, button:focus-visible {
    outline: 3px solid rgba(15, 123, 116, 0.22);
    outline-offset: 1px;
  }

  input[type="checkbox"] {
    width: 18px;
    min-height: 18px;
    accent-color: var(--accent);
  }

  .app {
    width: min(1120px, calc(100% - 32px));
    margin: 0 auto;
    padding: 28px 0 36px;
  }

  .app-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 20px;
    align-items: end;
    margin-bottom: 18px;
  }

  .brand {
    display: grid;
    gap: 8px;
  }

  .brand-title-row {
    display: flex;
    gap: 16px;
    align-items: flex-start;
  }

  .brand-mark {
    position: relative;
    width: 48px;
    height: 48px;
    margin-top: 7px;
    flex: 0 0 auto;
    border: 1px solid #103e3b;
    border-radius: 8px;
    background: #0f2f33;
    box-shadow: inset 0 0 0 6px #163f42;
  }

  .brand-mark::before,
  .brand-mark::after {
    content: "";
    position: absolute;
    left: 12px;
    right: 12px;
    border-radius: 2px;
    background: var(--accent-soft);
  }

  .brand-mark::before {
    top: 15px;
    height: 5px;
    box-shadow: 0 8px 0 #91d8d0;
  }

  .brand-mark::after {
    bottom: 10px;
    height: 5px;
    background: #f2b84b;
  }

  h1 {
    margin: 0;
    font-size: clamp(32px, 5vw, 56px);
    line-height: 0.95;
    letter-spacing: 0;
  }

  .tagline {
    max-width: 720px;
    margin: 0 0 0 64px;
    color: var(--muted);
    font-size: 16px;
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 38px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--panel);
    color: var(--muted);
    padding: 0 14px;
    box-shadow: var(--shadow);
    white-space: nowrap;
  }

  .header-actions {
    display: flex;
    align-items: center;
    justify-content: end;
    gap: 10px;
  }

  .icon-link,
  .theme-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 38px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--panel);
    color: var(--muted);
    box-shadow: var(--shadow);
    text-decoration: none;
  }

  .icon-link {
    width: 38px;
  }

  .theme-toggle {
    width: 38px;
    padding: 0;
  }

  .icon-link svg,
  .theme-toggle svg {
    width: 20px;
    height: 20px;
    fill: currentColor;
  }

  .icon-link:hover,
  .theme-toggle:hover {
    border-color: var(--accent);
    color: var(--accent-dark);
  }

  .status-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--accent);
  }

  .workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 370px;
    gap: 16px;
    align-items: start;
  }

  .stack {
    display: grid;
    gap: 16px;
  }

  .panel {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid var(--line);
    padding: 13px 16px;
  }

  .panel-title {
    margin: 0;
    font-size: 15px;
    font-weight: 800;
  }

  .panel-subtitle {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .panel-body {
    padding: 14px 16px 16px;
  }

  .debug-panel .panel-header {
    background: var(--panel-muted);
  }

  .debug-panel .panel-body {
    padding: 12px;
  }

  .debug-panel pre {
    border-radius: 8px;
  }

  .controls-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(135px, 1fr));
    gap: 12px;
  }

  .field {
    display: grid;
    grid-template-rows: 36px auto;
    gap: 5px;
    color: var(--muted);
    font-size: 13px;
    font-weight: 700;
  }

  .file-field,
  .scrubber-field {
    grid-template-rows: none;
  }

  .field > input,
  .field > select {
    align-self: end;
  }

  .file-field {
    min-width: 0;
  }

  .file-control {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    min-height: 40px;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background: var(--control);
    overflow: hidden;
  }

  .file-trigger {
    display: inline-flex;
    align-items: center;
    align-self: stretch;
    border-right: 1px solid var(--line-strong);
    background: var(--panel-muted);
    color: var(--ink);
    cursor: pointer;
    font-size: 13px;
    font-weight: 800;
    padding: 0 13px;
    white-space: nowrap;
  }

  .file-trigger:hover {
    color: var(--accent-dark);
  }

  .file-name {
    min-width: 0;
    overflow: hidden;
    color: var(--ink);
    font-size: 13px;
    font-weight: 700;
    padding: 0 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .checkbox-field {
    display: inline-flex;
    grid-template-columns: auto 1fr;
    align-items: center;
    align-self: end;
    justify-self: start;
    min-height: 40px;
    gap: 9px;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background: var(--control);
    padding: 0 12px;
    color: var(--ink);
    font-size: 13px;
    font-weight: 800;
    white-space: nowrap;
  }

  .file-row,
  .action-row {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }

  .file-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    column-gap: 12px;
  }

  .preview-tools {
    display: grid;
    grid-template-columns: 40px minmax(0, 1fr) 40px;
    gap: 10px;
    align-items: end;
  }

  .file-row .field {
    min-width: 0;
  }

  .primary {
    border-color: var(--accent);
    background: var(--accent);
    color: #fff;
  }

  .primary:hover:not(:disabled) {
    border-color: var(--accent-dark);
    background: var(--accent-dark);
    color: #fff;
  }

  .sample-btn {
    min-width: 132px;
    white-space: nowrap;
  }

  .icon-button {
    width: 40px;
    min-height: 40px;
    padding: 0;
    color: var(--muted);
    font-size: 25px;
    line-height: 1;
  }

  .small-button {
    min-height: 32px;
    padding: 0 11px;
    font-size: 13px;
  }

  .scrubber-field {
    display: grid;
    gap: 6px;
    min-width: 0;
    color: var(--muted);
    font-size: 13px;
    font-weight: 700;
  }

  .layer-scrubber {
    min-height: 28px;
    padding: 0;
    border: 0;
    accent-color: var(--accent);
    cursor: pointer;
  }

  .layer-scrubber:disabled {
    cursor: not-allowed;
  }

  .progress-box {
    min-height: 40px;
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel-muted);
    color: var(--muted);
    font-family: var(--mono);
    font-size: 13px;
    padding: 0 12px;
  }

  .note {
    margin: 14px 0 0;
    border-left: 3px solid #f2b84b;
    background: var(--warn-soft);
    color: var(--warn);
    padding: 10px 12px;
    font-size: 13px;
  }

  .preview-frame {
    display: grid;
    place-items: center;
    margin-top: 12px;
    min-height: 270px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background:
      linear-gradient(45deg, var(--preview-check) 25%, transparent 25%),
      linear-gradient(-45deg, var(--preview-check) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, var(--preview-check) 75%),
      linear-gradient(-45deg, transparent 75%, var(--preview-check) 75%);
    background-position: 0 0, 0 8px, 8px -8px, -8px 0;
    background-size: 16px 16px;
    overscroll-behavior: contain;
  }

  canvas {
    width: min(100%, 320px);
    height: auto;
    aspect-ratio: 4 / 3;
    border: 1px solid #9eabb2;
    border-radius: 4px;
    background: #050708;
    image-rendering: pixelated;
  }

  ol {
    margin: 0;
    padding-left: 22px;
    color: var(--muted);
  }

  li + li {
    margin-top: 8px;
  }

  pre {
    min-height: 260px;
    max-height: 460px;
    margin: 0;
    overflow: auto;
    border-radius: 6px;
    background: var(--console);
    color: var(--console-text);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.45;
    padding: 16px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .app-footer {
    margin-top: 20px;
    color: var(--muted);
    font-size: 13px;
    font-weight: 700;
    text-align: center;
  }

  @media (max-width: 900px) {
    .app-header,
    .workspace {
      grid-template-columns: 1fr;
    }

    .status-pill {
      justify-self: start;
    }

    .header-actions {
      justify-content: start;
    }
  }

  @media (max-width: 680px) {
    .app {
      width: min(100% - 20px, 1120px);
      padding-top: 18px;
    }

    .controls-grid {
      grid-template-columns: 1fr 1fr;
    }

    .panel-header {
      align-items: flex-start;
      flex-direction: column;
    }

    .file-row {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 480px) {
    .controls-grid {
      grid-template-columns: 1fr;
    }

    .brand-title-row {
      align-items: flex-start;
    }

    .brand-mark {
      width: 42px;
      height: 42px;
      margin-top: 4px;
    }

    .tagline {
      margin-left: 58px;
    }

    button {
      width: 100%;
    }

    .action-row button {
      flex: 1 1 100%;
    }

    .preview-tools button {
      width: 40px;
    }

    .small-button {
      width: auto;
    }
  }
</style>
