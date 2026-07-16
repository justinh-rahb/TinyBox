// slicer-worker.js
// module worker — performs slicing and rasterization into PNG blobs
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
      // reconstruct triangles
      const triangles = new Float32Array(msg.triangles);
      const bbox = msg.bbox;
      const profile = msg.profile;
      const exportStep = profile.exportStep;
      const zMin = bbox.min.z;
      const zMax = bbox.max.z;
      const modelHeight = Math.max(0.000001, zMax - zMin);
      const totalLayers = Math.max(1, Math.ceil(modelHeight / exportStep));
      // compute pixel mapping
      const pixW = profile.pixW;
      const pixH = profile.pixH;
      const buildW = profile.buildW;
      const buildH = profile.buildH;
      // map model XY bbox to pixels. We will center the model in XY area
      // compute model bbox XY extents from triangles
      let xmin=1e9,xmax=-1e9,ymin=1e9,ymax=-1e9;
      for (let i=0;i<triangles.length;i+=3){
        const x = triangles[i], y = triangles[i+1];
        if (x<xmin) xmin=x; if (x>xmax) xmax=x;
        if (y<ymin) ymin=y; if (y>ymax) ymax=y;
      }
      const modelW = Math.max(1e-6, xmax-xmin);
      const modelH = Math.max(1e-6, ymax-ymin);
      const scaleX = (pixW-2) / modelW; // small 1px padding
      const scaleY = (pixH-2) / modelH;
      const scale = Math.min(scaleX, scaleY);
      // compute translation so model center maps to canvas center
      const modelCx = (xmin + xmax)/2;
      const modelCy = (ymin + ymax)/2;
      const pixelCx = pixW/2;
      const pixelCy = pixH/2;

      // helper: transform model XY -> pixel coords
      function modelToPixel(x,y){
        const px = (x - modelCx) * scale + pixelCx;
        const py = (y - modelCy) * scale + pixelCy;
        return [px, py];
      }

      // iterate layers
      for (let layerIdx = 0; layerIdx < totalLayers; layerIdx++){
        const z = zMin + (layerIdx + 0.5) * exportStep; // sample mid-plane of slice
        // 1) find all triangle-plane intersections -> segments
        const segs = []; // array of [x1,y1,x2,y2]
        for (let t = 0; t < triangles.length; t += 9) {
          const x1 = triangles[t], y1 = triangles[t+1], z1 = triangles[t+2];
          const x2 = triangles[t+3], y2 = triangles[t+4], z2 = triangles[t+5];
          const x3 = triangles[t+6], y3 = triangles[t+7], z3 = triangles[t+8];
          // check which edges cross plane z
          const v1 = z1 - z, v2 = z2 - z, v3 = z3 - z;
          const s1 = Math.sign(v1), s2 = Math.sign(v2), s3 = Math.sign(v3);
          // find edges with different signs (or zero)
          const pts = [];
          if ((v1===0) || (v2===0) || (v3===0) || (s1 !== s2) || (s2 !== s3) || (s3 !== s1)) {
            // for each edge, if it crosses, compute intersection
            const edges = [
              [x1,y1,z1, x2,y2,z2],
              [x2,y2,z2, x3,y3,z3],
              [x3,y3,z3, x1,y1,z1],
            ];
            const inter = [];
            for (const e of edges){
              const [ax,ay,az,bx,by,bz] = e;
              const da = az - z, db = bz - z;
              if ( (da === 0 && db === 0) ) {
                // triangle lies on plane — skip (rare)
              } else if (da === 0) {
                inter.push([ax,ay]);
              } else if (db === 0) {
                inter.push([bx,by]);
              } else if ( (da > 0 && db < 0) || (da < 0 && db > 0) ) {
                const tEdge = da / (da - db); // proportion from a to b where intersects
                const ix = ax + (bx - ax) * tEdge;
                const iy = ay + (by - ay) * tEdge;
                inter.push([ix,iy]);
              }
            }
            if (inter.length === 2) {
              segs.push([inter[0][0], inter[0][1], inter[1][0], inter[1][1]]);
            }
          }
        } // triangles loop

        // 2) join segments into contours
        // naive joining by proximity: build adjacency map
        const EPS = 1e-6;
        // build list of points and adjacency using string keys with rounding
        function key(p){
          return (Math.round(p[0]*10000)/10000) + ',' + (Math.round(p[1]*10000)/10000);
        }
        const adj = new Map(); // key->array of point arrays
        for (const s of segs){
          const a = [s[0], s[1]], b = [s[2], s[3]];
          const ka = key(a), kb = key(b);
          if (!adj.has(ka)) adj.set(ka, []);
          if (!adj.has(kb)) adj.set(kb, []);
          adj.get(ka).push(b);
          adj.get(kb).push(a);
        }

        // traverse adjacency to produce polygons (walk until closed or deadend)
        const visitedEdge = new Set();
        const polygons = [];
        for (const s of segs){
          const a = [s[0], s[1]], b = [s[2], s[3]];
          const edgeKey = key(a) + '|' + key(b);
          if (visitedEdge.has(edgeKey) || visitedEdge.has(key(b)+'|'+key(a))) continue;
          // start walk from a->b
          const poly = [a];
          let cur = b;
          let prev = a;
          visitedEdge.add(edgeKey);
          while (true){
            poly.push(cur);
            const kcur = key(cur);
            const neighbors = adj.get(kcur) || [];
            // pick the neighbor that's not 'prev'
            let next = null;
            for (const nb of neighbors){
              const knb = key(nb);
              if (knb === key(prev)) continue;
              // avoid revisiting very short backtrack
              next = nb;
              break;
            }
            if (!next) break; // dead end
            const ek = kcur + '|' + key(next);
            if (visitedEdge.has(ek)) break;
            visitedEdge.add(ek);
            prev = cur;
            cur = next;
            // if we closed back to first point, break
            if (Math.hypot(cur[0]-poly[0][0], cur[1]-poly[0][1]) < 1e-4) {
              break;
            }
            if (poly.length > 20000) break; // safety
          }
          if (poly.length >= 3) polygons.push(poly);
        }

        // 3) rasterize polygons into OffscreenCanvas
        // create canvas
        let canvas;
        let ctx;
        if (typeof OffscreenCanvas !== 'undefined') {
          canvas = new OffscreenCanvas(pixW, pixH);
          ctx = canvas.getContext('2d');
        } else {
          // fallback (main thread will show preview only during slicing loop in MVP)
          canvas = new self.HTMLCanvasElement ? document.createElement('canvas') : null;
          if (canvas) {
            canvas.width = pixW; canvas.height = pixH;
            ctx = canvas.getContext('2d');
          } else {
            // no canvas support — abort
            throw new Error('Canvas not available in worker.');
          }
        }
        // clear
        ctx.fillStyle = profile.invert ? 'white' : 'black'; // background
        ctx.fillRect(0,0,pixW,pixH);
        // draw polygons: convert model XY to pixel coords using modelToPixel defined earlier in main? replicate mapping
        // We must reconstruct same mapping as main: compute model center and scale
        // For speed, compute modelToPixel here similarly:
        // Compute model bbox XY here (we already used in main but transferred only bbox; re-evaluate)
        // For safety, recompute model bbox from polygons points
        // draw each polygon as path
        ctx.fillStyle = profile.invert ? 'black' : 'white';
        ctx.beginPath();
        for (const poly of polygons){
          if (poly.length < 3) continue;
          // move to first point
          const p0 = modelToPixel(poly[0][0], poly[0][1]);
          ctx.moveTo(p0[0], p0[1]);
          for (let i=1;i<poly.length;i++){
            const p = modelToPixel(poly[i][0], poly[i][1]);
            ctx.lineTo(p[0], p[1]);
          }
          ctx.closePath();
        }
        // fill using even-odd to allow holes
        ctx.fill('evenodd');

        // optional anti-aliasing or threshold
        if (profile.aa === 'none'){
          // threshold to binary: getImageData and threshold at 128
          const im = ctx.getImageData(0,0,pixW,pixH);
          const d = im.data;
          for (let px=0; px<d.length; px+=4){
            const val = d[px]; // red channel; since we used b/w colors
            const out = val > 128 ? 255 : 0;
            d[px]=d[px+1]=d[px+2]=out;
            d[px+3]=255;
          }
          ctx.putImageData(im, 0, 0);
        }

        // 4) export PNG blob
        // canvas.convertToBlob in OffscreenCanvas or canvas.toBlob fallback
        let blob;
        if (canvas.convertToBlob) {
          blob = await canvas.convertToBlob({ type:'image/png' });
        } else {
          // fallback: transfer canvas to ImageBitmap then to blob using createImageBitmap? Not available in worker in all browsers.
          // Use toDataURL via an OffscreenCanvas proxy is complicated; skip fallback for MVP.
          throw new Error('convertToBlob not available in worker in this browser.');
        }

        // name handling: firmware will expect 1..N or odd-index mapping.
        // We are producing sequential files 1..totalLayers at exportStep spacing
        const imgName = (layerIdx+1) + '.png';
        // send PNG to main thread
        self.postMessage({ type:'png', name: imgName, blob: blob });

        // also send a small preview (ImageBitmap) for UI
        let previewBitmap = null;
        try {
          previewBitmap = await createImageBitmap(blob);
        } catch (e){}
        self.postMessage({ type:'progress', current: layerIdx+1, total: totalLayers, previewBitmap }, previewBitmap ? [previewBitmap] : []);
      } // per-layer loop

      // finished
      self.postMessage({ type:'done', total: totalLayers });

    } catch (err){
      self.postMessage({ type:'error', error: (err && err.message) || String(err) });
    }
  }
};

// Helper: modelToPixel mapping uses a center and scale computed at top of worker scope.
// To keep code compact we inline the needed mapping above. If you split code, ensure consistent mapping.