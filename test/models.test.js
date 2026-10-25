// Checks the real model files: size budget and input/output shapes.
// Uses onnxruntime-node (native) only as a test harness; the app itself uses
// onnxruntime-web, which is exercised by test/e2e-image.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ort = require('onnxruntime-node');
const L = require('../src/renderer/liveness.js');

const ANTISPOOF = path.join(__dirname, '..', 'models', 'antispoof_minifas_int8.onnx');
const DETECTOR = path.join(__dirname, '..', 'models', 'face_detector_yunet.onnx');

test('combined model weights are at most 5 MB', () => {
  const total = fs.statSync(ANTISPOOF).size + fs.statSync(DETECTOR).size;
  console.log(`combined model size: ${total} bytes (${(total / 1024 / 1024).toFixed(2)} MiB)`);
  assert.ok(total <= 5 * 1024 * 1024);
});

test('anti-spoof model takes 1x3x128x128 and returns 2 logits', async () => {
  const session = await ort.InferenceSession.create(ANTISPOOF);
  const input = new ort.Tensor('float32', new Float32Array(3 * 128 * 128).fill(0.5), [1, 3, 128, 128]);
  const { output } = await session.run({ input });
  assert.deepStrictEqual(output.dims, [1, 2]);
  const p = L.realProbability(output.data);
  assert.ok(p > 0 && p < 1);
});

test('detector finds no face in a blank grey image', async () => {
  const session = await ort.InferenceSession.create(DETECTOR);
  const input = new ort.Tensor('float32', new Float32Array(3 * 640 * 640).fill(128), [1, 3, 640, 640]);
  const out = await session.run({ input });
  const data = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.data]));
  assert.strictEqual(L.decodeYuNet(data).length, 0);
});
