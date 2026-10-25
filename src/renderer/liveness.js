// Pure pre- and post-processing for the two ONNX models.
// No DOM and no ONNX Runtime here, so the same file runs in the app
// (as window.Liveness) and in the Node unit tests (via require).
(function (root) {
  const DETECTOR_SIZE = 640; // YuNet model has a fixed 640x640 input
  const MODEL_SIZE = 128; // MiniFASNet input is 128x128
  const BBOX_EXPANSION = 1.5; // crop 1.5x the face box, as the model was trained
  const DETECT_THRESHOLD = 0.8; // minimum face-detector score (upstream default)
  const NMS_IOU = 0.3;
  const MIN_FACE_PX = 64; // upstream: faces smaller than this lose spoof texture
  const LIVE_AT = 0.7; // P(real) at or above this -> likely live
  const SPOOF_AT = 0.3; // P(real) at or below this -> possible spoof

  // RGBA pixels (from canvas getImageData) -> Float32 CHW tensor data.
  // order 'rgb' or 'bgr'; scale multiplies every value (1/255 to get 0..1).
  function rgbaToCHW(rgba, width, height, order, scale) {
    const plane = width * height;
    const out = new Float32Array(3 * plane);
    const channels = order === 'bgr' ? [2, 1, 0] : [0, 1, 2];
    for (let i = 0; i < plane; i++) {
      out[i] = rgba[i * 4 + channels[0]] * scale;
      out[plane + i] = rgba[i * 4 + channels[1]] * scale;
      out[2 * plane + i] = rgba[i * 4 + channels[2]] * scale;
    }
    return out;
  }

  function intersectionOverUnion(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return inter / (a.width * a.height + b.width * b.height - inter);
  }

  // Non-maximum suppression: keep the best box, drop boxes that overlap it.
  function nms(boxes, iouThreshold) {
    const sorted = [...boxes].sort((a, b) => b.score - a.score);
    const kept = [];
    for (const box of sorted) {
      if (kept.every((k) => intersectionOverUnion(k, box) < iouThreshold)) kept.push(box);
    }
    return kept;
  }

  // Turn YuNet's raw outputs into face boxes (in 640x640 detector pixels).
  // Same maths as OpenCV's FaceDetectorYN: one prediction per grid cell for
  // strides 8, 16 and 32; score = sqrt(class * objectness).
  function decodeYuNet(outputs, threshold = DETECT_THRESHOLD) {
    const faces = [];
    for (const stride of [8, 16, 32]) {
      const cls = outputs[`cls_${stride}`];
      const obj = outputs[`obj_${stride}`];
      const bbox = outputs[`bbox_${stride}`];
      const cols = DETECTOR_SIZE / stride;
      for (let i = 0; i < cls.length; i++) {
        const clamp = (v) => Math.min(Math.max(v, 0), 1);
        const score = Math.sqrt(clamp(cls[i]) * clamp(obj[i]));
        if (score < threshold) continue;
        const row = Math.floor(i / cols);
        const col = i % cols;
        const cx = (col + bbox[i * 4]) * stride;
        const cy = (row + bbox[i * 4 + 1]) * stride;
        const w = Math.exp(bbox[i * 4 + 2]) * stride;
        const h = Math.exp(bbox[i * 4 + 3]) * stride;
        faces.push({ x: cx - w / 2, y: cy - h / 2, width: w, height: h, score });
      }
    }
    return nms(faces, NMS_IOU);
  }

  // Mirror an out-of-range index back into [0, size-1] (like OpenCV BORDER_REFLECT_101).
  function reflect(i, size) {
    if (size === 1) return 0;
    while (i < 0 || i >= size) {
      if (i < 0) i = -i;
      if (i >= size) i = 2 * size - 2 - i;
    }
    return i;
  }

  // The square region the anti-spoof model should see: 1.5x the face box,
  // centred on the face, truncated to whole pixels (upstream preprocess.crop()).
  function cropRegion(face) {
    const size = Math.max(face.width, face.height) * BBOX_EXPANSION;
    return {
      x: Math.trunc(face.x + face.width / 2 - size / 2),
      y: Math.trunc(face.y + face.height / 2 - size / 2),
      size: Math.trunc(size),
    };
  }

  // For one axis: which source pixels each output pixel covers, and by how much.
  // Output pixel o spans source range [start + o*step, start + (o+1)*step).
  function areaWeights(start, step, outSize, srcSize) {
    const table = [];
    for (let o = 0; o < outSize; o++) {
      const a = start + o * step;
      const b = a + step;
      const items = [];
      for (let s = Math.floor(a); s < b; s++) {
        const overlap = Math.min(b, s + 1) - Math.max(a, s);
        if (overlap > 1e-6) items.push([reflect(s, srcSize), overlap / step]);
      }
      table.push(items);
    }
    return table;
  }

  // Cut the crop region out of the full frame and resize it to 128x128.
  // Each output pixel is the coverage-weighted average of the source pixels it
  // overlaps (area resampling, like OpenCV INTER_AREA). Pixels outside the
  // frame are reflected. Returns RGBA bytes, outSize*outSize*4.
  function cropAndResize(rgba, width, height, region, outSize = MODEL_SIZE) {
    const out = new Uint8ClampedArray(outSize * outSize * 4);
    const step = region.size / outSize; // source pixels per output pixel
    const cols = areaWeights(region.x, step, outSize, width);
    const rows = areaWeights(region.y, step, outSize, height);
    for (let oy = 0; oy < outSize; oy++) {
      for (let ox = 0; ox < outSize; ox++) {
        let r = 0, g = 0, b = 0;
        for (const [sy, wy] of rows[oy]) {
          for (const [sx, wx] of cols[ox]) {
            const p = (sy * width + sx) * 4;
            const w = wy * wx;
            r += rgba[p] * w;
            g += rgba[p + 1] * w;
            b += rgba[p + 2] * w;
          }
        }
        const o = (oy * outSize + ox) * 4;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = 255;
      }
    }
    return out;
  }

  // Model logits [real, spoof] -> probability that the face is real.
  // sigmoid(real - spoof) equals the softmax probability of the "real" class.
  function realProbability(logits) {
    return 1 / (1 + Math.exp(-(logits[0] - logits[1])));
  }

  // Probability -> one of three verdicts shown to the user.
  function verdict(pReal) {
    if (pReal >= LIVE_AT) return 'live';
    if (pReal <= SPOOF_AT) return 'spoof';
    return 'uncertain';
  }

  const api = {
    DETECTOR_SIZE,
    MODEL_SIZE,
    MIN_FACE_PX,
    LIVE_AT,
    SPOOF_AT,
    rgbaToCHW,
    nms,
    decodeYuNet,
    reflect,
    cropRegion,
    cropAndResize,
    realProbability,
    verdict,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Liveness = api;
})(typeof window !== 'undefined' ? window : globalThis);
