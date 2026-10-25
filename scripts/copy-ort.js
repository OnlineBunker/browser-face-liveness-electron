// Copies only the ONNX Runtime Web files the app needs (WASM CPU backend)
// from node_modules into src/vendor/ort, so the packaged app stays small.
const fs = require('fs');
const path = require('path');

const from = path.join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist');
const to = path.join(__dirname, '..', 'src', 'vendor', 'ort');
const files = ['ort.wasm.min.js', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];

fs.mkdirSync(to, { recursive: true });
for (const file of files) {
  fs.copyFileSync(path.join(from, file), path.join(to, file));
}
console.log(`Copied ${files.length} ONNX Runtime Web files to src/vendor/ort`);
