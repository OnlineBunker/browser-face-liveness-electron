// Unit tests for the pure pre/post-processing helpers.
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/renderer/liveness.js');

test('rgbaToCHW splits channels into planes in RGB or BGR order', () => {
  const rgba = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]); // 2x1 image
  assert.deepStrictEqual([...L.rgbaToCHW(rgba, 2, 1, 'rgb', 1)], [10, 40, 20, 50, 30, 60]);
  assert.deepStrictEqual([...L.rgbaToCHW(rgba, 2, 1, 'bgr', 1)], [30, 60, 20, 50, 10, 40]);
  const scaled = L.rgbaToCHW(rgba, 2, 1, 'rgb', 1 / 255);
  assert.ok(Math.abs(scaled[0] - 10 / 255) < 1e-6);
});

test('reflect mirrors indices like BORDER_REFLECT_101', () => {
  assert.deepStrictEqual([-2, -1, 0, 4, 5, 6].map((i) => L.reflect(i, 5)), [2, 1, 0, 4, 3, 2]);
});

test('cropRegion is a 1.5x square centred on the face', () => {
  const r = L.cropRegion({ x: 100, y: 50, width: 80, height: 100 });
  assert.deepStrictEqual(r, { x: 65, y: 25, size: 150 });
});

test('cropAndResize keeps colours and handles regions outside the frame', () => {
  const w = 20, h = 10;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([200, 100, 50, 255], i * 4);
  const out = L.cropAndResize(rgba, w, h, { x: -15, y: -15, size: 40 }, 8);
  assert.strictEqual(out.length, 8 * 8 * 4);
  for (let i = 0; i < 64; i++) assert.deepStrictEqual([...out.slice(i * 4, i * 4 + 4)], [200, 100, 50, 255]);
});

test('realProbability is the softmax probability of the real class', () => {
  assert.strictEqual(L.realProbability([0, 0]), 0.5);
  const p = L.realProbability([2, -1]);
  const softmax = Math.exp(2) / (Math.exp(2) + Math.exp(-1));
  assert.ok(Math.abs(p - softmax) < 1e-9);
});

test('verdict uses live / uncertain / spoof bands', () => {
  assert.strictEqual(L.verdict(0.9), 'live');
  assert.strictEqual(L.verdict(L.LIVE_AT), 'live');
  assert.strictEqual(L.verdict(0.5), 'uncertain');
  assert.strictEqual(L.verdict(L.SPOOF_AT), 'spoof');
  assert.strictEqual(L.verdict(0.05), 'spoof');
});

// Builds fake YuNet outputs with every score 0 except the given cells.
function fakeYuNet(cells) {
  const out = {};
  for (const s of [8, 16, 32]) {
    const n = (640 / s) ** 2;
    out[`cls_${s}`] = new Float32Array(n);
    out[`obj_${s}`] = new Float32Array(n);
    out[`bbox_${s}`] = new Float32Array(n * 4);
  }
  for (const c of cells) {
    const i = c.row * (640 / c.stride) + c.col;
    out[`cls_${c.stride}`][i] = c.score;
    out[`obj_${c.stride}`][i] = c.score;
    out[`bbox_${c.stride}`].set([0.5, 0.5, Math.log(c.size / c.stride), Math.log(c.size / c.stride)], i * 4);
  }
  return out;
}

test('decodeYuNet converts a grid cell into a pixel box', () => {
  const faces = L.decodeYuNet(fakeYuNet([{ stride: 32, row: 5, col: 10, score: 0.9, size: 160 }]));
  assert.strictEqual(faces.length, 1);
  const f = faces[0];
  // centre = (10.5 * 32, 5.5 * 32) = (336, 176); box 160x160
  assert.ok(Math.abs(f.x - 256) < 1e-3 && Math.abs(f.y - 96) < 1e-3);
  assert.ok(Math.abs(f.width - 160) < 1e-3 && Math.abs(f.score - 0.9) < 1e-6);
});

test('decodeYuNet drops low scores and merges overlapping boxes (NMS)', () => {
  const faces = L.decodeYuNet(fakeYuNet([
    { stride: 32, row: 5, col: 10, score: 0.9, size: 160 },
    { stride: 16, row: 11, col: 21, score: 0.8, size: 160 }, // same face, other scale
    { stride: 8, row: 2, col: 2, score: 0.3, size: 20 }, // below threshold
  ]));
  assert.strictEqual(faces.length, 1);
  assert.ok(Math.abs(faces[0].score - 0.9) < 1e-6);
});

test('cropAndResize averages by pixel coverage (2x downscale of a stripe pattern)', () => {
  // Columns alternate black/white, so every 2x2 block averages to mid-grey.
  const w = 4, h = 4;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(x % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * w + x) * 4);
  const out = L.cropAndResize(rgba, w, h, { x: 0, y: 0, size: 4 }, 2);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(out[i * 4] - 127.5) <= 1);
});
