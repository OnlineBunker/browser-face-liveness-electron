# Models

Both models come from [facenox/face-antispoof-onnx](https://github.com/facenox/face-antispoof-onnx)
(commit `2f8dd93`), licensed under **Apache-2.0** (see `LICENSE-face-antispoof-onnx.txt`).
They are used unmodified.

| File | Original name | Size | Purpose |
|---|---|---|---|
| `antispoof_minifas_int8.onnx` | `models/best/98.20/best_model_quantized.onnx` | 626,197 B | MiniFASNetV2-SE liveness classifier (INT8) |
| `face_detector_yunet.onnx` | `models/detector.onnx` | 232,589 B | YuNet face detector (FP32) |

Combined: **858,786 bytes (~0.86 MB)**, well below the 5 MB budget.

## Anti-spoof model contract (verified by running it)
- Input `input`: float32 `[1, 3, 128, 128]`, **RGB**, values `0..1`, CHW.
- Output `output`: float32 `[1, 2]` raw logits `[real, spoof]`.
- The face crop is a square of `1.5 × max(face width, height)` around the face centre,
  reflection-padded at image borders (same as upstream `src/inference/preprocess.py`).
- `P(real) = sigmoid(real − spoof)`; upstream treats `P(real) ≥ 0.5` as real.

## Face detector contract (verified by running it)
- Input `input`: float32 `[1, 3, 640, 640]`, BGR, values `0..255` (fixed size).
- Outputs `cls_*`, `obj_*`, `bbox_*`, `kps_*` for strides 8/16/32, decoded in
  `src/renderer/liveness.js` the same way OpenCV's `FaceDetectorYN` does.

The upstream `detector_quantized.onnx` was **not** used: it fails in ONNX Runtime 1.20
(`DequantizeLinear ... block_size must be 0 for per-tensor quantization`).

Upstream-reported accuracy (CelebA-Spoof test set): 98.20% overall. That number was
not re-measured in this project.
