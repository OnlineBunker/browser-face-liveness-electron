// Builds the browser version into _site/ (used by the GitHub Pages workflow).
// It is the same renderer code as the Electron app, served as a normal website:
// the relative paths ../vendor/ort and ../../models keep working because the
// folder layout is copied as-is.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, '_site');

fs.rmSync(out, { recursive: true, force: true });
for (const dir of ['src/renderer', 'src/vendor/ort', 'models']) {
  fs.cpSync(path.join(root, dir), path.join(out, dir), { recursive: true });
}
fs.writeFileSync(
  path.join(out, 'index.html'),
  '<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=src/renderer/index.html"><a href="src/renderer/index.html">Open Face Liveness Detector</a>\n'
);
console.log('Web version written to _site/');
