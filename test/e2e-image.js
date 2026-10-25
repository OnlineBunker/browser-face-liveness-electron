// End-to-end check of the real app pipeline (ONNX Runtime Web inside Electron).
// Usage:  npx electron test/e2e-image.js <image.png|jpg> [more images...]
// It starts the normal app, waits for the models to load, then calls the page's
// analyzeImage() on each image and prints the face box, P(live) and timings.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const images = process.argv.slice(2).filter((a) => /\.(png|jpe?g)$/i.test(a));
if (images.length === 0) {
  console.error('Pass at least one image path.');
  process.exit(2);
}

require('../src/main.js'); // the real app: same protocol, security settings and page

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', async () => {
    try {
      const page = (js) => win.webContents.executeJavaScript(js);
      // Wait up to 30 s for loadModels() to finish.
      for (let i = 0; i < 300; i++) {
        const state = await page('document.body.dataset.models || ""');
        if (state === 'ready') break;
        if (state === 'error') throw new Error(await page("document.getElementById('message').textContent"));
        await new Promise((r) => setTimeout(r, 100));
      }
      console.log('models:', await page("document.getElementById('totalSize').textContent"),
        '|', await page("document.getElementById('runtime').textContent"));

      for (const file of images) {
        const mime = file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        const url = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
        const runs = [];
        for (let i = 0; i < 5; i++) runs.push(await page(`analyzeImage(${JSON.stringify(url)})`));
        const r = runs[runs.length - 1];
        const median = (k) => runs.map((x) => x.timings[k]).sort((a, b) => a - b)[2];
        console.log(JSON.stringify({
          image: path.basename(file),
          faces: r.faceCount,
          face: r.face && { x: Math.round(r.face.x), y: Math.round(r.face.y), w: Math.round(r.face.width), score: +r.face.score.toFixed(3) },
          logits: r.logits && r.logits.map((v) => +v.toFixed(3)),
          pLive: r.pReal == null ? null : +r.pReal.toFixed(4),
          medianMs: { detection: +median('detection').toFixed(1), antispoof: r.logits ? +median('antispoof').toFixed(1) : null, total: +median('total').toFixed(1) },
        }));
      }
      app.exit(0);
    } catch (err) {
      console.error('E2E FAILED:', err.message);
      app.exit(1);
    }
  });
});
