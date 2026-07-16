// module worker - performs slicing and rasterization into PNG blobs
// API:
// postMessage({type:'start', triangles: ArrayBuffer (Float32), bbox: {min:{x,y,z},max:{x,y,z}}, profile })
// posts messages:
// {type:'progress', current, total, previewBitmap (ImageBitmap optional)}
// {type:'png', name: '1.png', blob: Blob}
// {type:'done', total}
// {type:'error', error}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'start') {
    try {
      const triangles = new Float32Array(msg.triangles);
      const bbox = msg.bbox;
      const profile = msg.profile;
      const exportStep = profile.exportStep;
      const zMin = bbox.min.z;
      const zMax = bbox.max.z;
      const modelHeight = Math.max(0.000001, zMax - zMin);
      const totalLayers = Math.max(1, Math.ceil(modelHeight / exportStep));
      const pixW = profile.pixW;
      const pixH = profile.pixH;

      let xmin = 1e9, xmax = -1e9, ymin = 1e9, ymax = -1e9;
      for (let i = 0; i < triangles.length; i += 3) {
        const x = triangles[i], y = triangles[i + 1];
        if (x < xmin) xmin = x; if (x > xmax) xmax = x;
        if (y < ymin) ymin = y; if (y > ymax) ymax = y;
      }

      const modelW = Math.max(1e-6, xmax - xmin);
      const modelH = Math.max(1e-6, ymax - ymin);
      const scale = Math.min((pixW - 2) / modelW, (pixH - 2) / modelH);
      const modelCx = (xmin + xmax) / 2;
      const modelCy = (ymin + ymax) / 2;
      const pixelCx = pixW / 2;
      const pixelCy = pixH / 2;

      function modelToPixel(x, y) {
        const px = (x - modelCx) * scale + pixelCx;
        return [
          profile.mirror ? pixW - px : px,
          (y - modelCy) * scale + pixelCy
        ];
      }

      for (let layerIdx = 0; layerIdx < totalLayers; layerIdx++) {
        const z = zMin + (layerIdx + 0.5) * exportStep;
        const segs = [];

        for (let t = 0; t < triangles.length; t += 9) {
          const x1 = triangles[t], y1 = triangles[t + 1], z1 = triangles[t + 2];
          const x2 = triangles[t + 3], y2 = triangles[t + 4], z2 = triangles[t + 5];
          const x3 = triangles[t + 6], y3 = triangles[t + 7], z3 = triangles[t + 8];
          const v1 = z1 - z, v2 = z2 - z, v3 = z3 - z;
          const s1 = Math.sign(v1), s2 = Math.sign(v2), s3 = Math.sign(v3);

          if ((v1 === 0) || (v2 === 0) || (v3 === 0) || (s1 !== s2) || (s2 !== s3) || (s3 !== s1)) {
            const edges = [
              [x1, y1, z1, x2, y2, z2],
              [x2, y2, z2, x3, y3, z3],
              [x3, y3, z3, x1, y1, z1]
            ];
            const inter = [];

            for (const e of edges) {
              const [ax, ay, az, bx, by, bz] = e;
              const da = az - z, db = bz - z;
              if (da === 0 && db === 0) {
                // Triangle lies on plane; skip to avoid duplicate coplanar edges.
              } else if (da === 0) {
                inter.push([ax, ay]);
              } else if (db === 0) {
                inter.push([bx, by]);
              } else if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
                const tEdge = da / (da - db);
                inter.push([
                  ax + (bx - ax) * tEdge,
                  ay + (by - ay) * tEdge
                ]);
              }
            }

            if (inter.length === 2) {
              segs.push([inter[0][0], inter[0][1], inter[1][0], inter[1][1]]);
            }
          }
        }

        function key(p) {
          return `${Math.round(p[0] * 10000) / 10000},${Math.round(p[1] * 10000) / 10000}`;
        }

        const adj = new Map();
        for (const s of segs) {
          const a = [s[0], s[1]], b = [s[2], s[3]];
          const ka = key(a), kb = key(b);
          if (!adj.has(ka)) adj.set(ka, []);
          if (!adj.has(kb)) adj.set(kb, []);
          adj.get(ka).push(b);
          adj.get(kb).push(a);
        }

        const visitedEdge = new Set();
        const polygons = [];
        for (const s of segs) {
          const a = [s[0], s[1]], b = [s[2], s[3]];
          const edgeKey = `${key(a)}|${key(b)}`;
          if (visitedEdge.has(edgeKey) || visitedEdge.has(`${key(b)}|${key(a)}`)) continue;

          const poly = [a];
          let cur = b;
          let prev = a;
          visitedEdge.add(edgeKey);

          while (true) {
            poly.push(cur);
            const kcur = key(cur);
            const neighbors = adj.get(kcur) || [];
            let next = null;

            for (const nb of neighbors) {
              if (key(nb) === key(prev)) continue;
              next = nb;
              break;
            }

            if (!next) break;
            const ek = `${kcur}|${key(next)}`;
            if (visitedEdge.has(ek)) break;
            visitedEdge.add(ek);
            prev = cur;
            cur = next;

            if (Math.hypot(cur[0] - poly[0][0], cur[1] - poly[0][1]) < 1e-4) break;
            if (poly.length > 20000) break;
          }

          if (poly.length >= 3) polygons.push(poly);
        }

        if (typeof OffscreenCanvas === 'undefined') {
          throw new Error('OffscreenCanvas not available in worker.');
        }

        const canvas = new OffscreenCanvas(pixW, pixH);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = profile.invert ? 'white' : 'black';
        ctx.fillRect(0, 0, pixW, pixH);
        ctx.fillStyle = profile.invert ? 'black' : 'white';
        ctx.beginPath();

        for (const poly of polygons) {
          if (poly.length < 3) continue;
          const p0 = modelToPixel(poly[0][0], poly[0][1]);
          ctx.moveTo(p0[0], p0[1]);
          for (let i = 1; i < poly.length; i++) {
            const p = modelToPixel(poly[i][0], poly[i][1]);
            ctx.lineTo(p[0], p[1]);
          }
          ctx.closePath();
        }

        ctx.fill('evenodd');

        if (profile.aa === 'none') {
          const im = ctx.getImageData(0, 0, pixW, pixH);
          const d = im.data;
          for (let px = 0; px < d.length; px += 4) {
            const out = d[px] > 128 ? 255 : 0;
            d[px] = d[px + 1] = d[px + 2] = out;
            d[px + 3] = 255;
          }
          ctx.putImageData(im, 0, 0);
        }

        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const imgName = `${layerIdx + 1}.png`;
        self.postMessage({ type: 'png', name: imgName, blob });

        let previewBitmap = null;
        try {
          previewBitmap = await createImageBitmap(blob);
        } catch (e) {
          previewBitmap = null;
        }
        self.postMessage(
          { type: 'progress', current: layerIdx + 1, total: totalLayers, previewBitmap },
          previewBitmap ? [previewBitmap] : []
        );
      }

      self.postMessage({ type: 'done', total: totalLayers });
    } catch (err) {
      self.postMessage({ type: 'error', error: (err && err.message) || String(err) });
    }
  }
};
