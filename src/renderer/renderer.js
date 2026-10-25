// Renderer: webcam handling, model loading, the per-frame pipeline and the UI.
// Pipeline: video frame -> YuNet face detector -> 1.5x face crop (128x128)
//           -> MiniFASNet anti-spoof model -> P(live) -> verdict.
const L = window.Liveness;
const $ = (id) => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');

const MODEL_URLS = {
  detector: '../../models/face_detector_yunet.onnx',
  antispoof: '../../models/antispoof_minifas_int8.onnx',
};
const SMOOTHING_FRAMES = 5; // average P(live) over the last few frames
const FRAME_GAP_MS = 60; // pause between analysed frames to keep CPU use modest

let stream = null; // the active MediaStream, or null when the camera is off
let detector = null; // ONNX Runtime sessions
let antispoof = null;
let history = []; // recent P(live) values for smoothing

// Off-screen canvases used to read pixels. Nothing is ever saved or uploaded.
const frameCanvas = document.createElement('canvas');
const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
const detCanvas = document.createElement('canvas');
detCanvas.width = detCanvas.height = L.DETECTOR_SIZE;
const detCtx = detCanvas.getContext('2d', { willReadFrequently: true });

// ---------- Model loading ----------

// ONNX Runtime Web, CPU (WebAssembly) backend, single thread: no extra workers
// or cross-origin isolation needed, and fast enough for these small models.
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL('../vendor/ort/', location.href).href;

async function fetchModel(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model file missing: ${url.split('/').pop()} (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

const formatBytes = (n) => `${(n / 1024).toFixed(0)} KB`;

async function loadModels() {
  setChip('modelChip', 'modelStatus', 'busy', 'Loading models…');
  try {
    const detBytes = await fetchModel(MODEL_URLS.detector);
    const spoofBytes = await fetchModel(MODEL_URLS.antispoof);
    detector = await ort.InferenceSession.create(detBytes, { executionProviders: ['wasm'] });
    antispoof = await ort.InferenceSession.create(spoofBytes, { executionProviders: ['wasm'] });

    // One warm-up run each so the first real frame is not slower than the rest.
    await detector.run({ input: new ort.Tensor('float32', new Float32Array(3 * 640 * 640), [1, 3, 640, 640]) });
    await antispoof.run({ input: new ort.Tensor('float32', new Float32Array(3 * 128 * 128), [1, 3, 128, 128]) });

    $('detSize').textContent = formatBytes(detBytes.byteLength);
    $('spoofSize').textContent = formatBytes(spoofBytes.byteLength);
    $('totalSize').textContent = `${((detBytes.byteLength + spoofBytes.byteLength) / 1024 / 1024).toFixed(2)} MB`;
    $('runtime').textContent = `ORT Web ${ort.env.versions.web} · WASM`;
    setChip('modelChip', 'modelStatus', 'ok', 'Models ready');
    document.body.dataset.models = 'ready';
    $('startBtn').disabled = false;
  } catch (err) {
    setChip('modelChip', 'modelStatus', 'error', 'Model error');
    showMessage(`Could not load the AI models: ${err.message}. Reinstall the app or check the models/ folder.`);
    document.body.dataset.models = 'error';
  }
}

// ---------- Per-frame pipeline ----------

// Runs the full pipeline on anything drawable (the <video>, or an <img> in tests).
// Returns the detected face, P(live) and timings in milliseconds.
async function analyzeSource(source, width, height) {
  const t0 = performance.now();

  // 1. Full-resolution pixels (used later for the face crop).
  frameCanvas.width = width;
  frameCanvas.height = height;
  frameCtx.drawImage(source, 0, 0, width, height);
  const frame = frameCtx.getImageData(0, 0, width, height);

  // 2. Detector input: frame scaled into a black 640x640 square, BGR 0..255.
  const scale = L.DETECTOR_SIZE / Math.max(width, height);
  detCtx.fillStyle = '#000';
  detCtx.fillRect(0, 0, L.DETECTOR_SIZE, L.DETECTOR_SIZE);
  detCtx.drawImage(source, 0, 0, width * scale, height * scale);
  const detPixels = detCtx.getImageData(0, 0, L.DETECTOR_SIZE, L.DETECTOR_SIZE).data;
  const detInput = L.rgbaToCHW(detPixels, L.DETECTOR_SIZE, L.DETECTOR_SIZE, 'bgr', 1);

  const t1 = performance.now();
  const detOut = await detector.run({ input: new ort.Tensor('float32', detInput, [1, 3, 640, 640]) });
  const t2 = performance.now();

  // 3. Decode boxes, map back to frame pixels, keep the largest face.
  const raw = Object.fromEntries(Object.entries(detOut).map(([name, t]) => [name, t.data]));
  const faces = L.decodeYuNet(raw).map((f) => ({
    x: f.x / scale, y: f.y / scale, width: f.width / scale, height: f.height / scale, score: f.score,
  }));
  const timings = { detection: t2 - t1 };
  if (faces.length === 0) return { face: null, faceCount: 0, timings: { ...timings, total: t2 - t0 } };
  const face = faces.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  if (face.width < L.MIN_FACE_PX) {
    return { face, faceCount: faces.length, tooSmall: true, timings: { ...timings, total: t2 - t0 } };
  }

  // 4. Anti-spoof input: 1.5x square crop, 128x128, RGB 0..1.
  const crop = L.cropAndResize(frame.data, width, height, L.cropRegion(face));
  const spoofInput = L.rgbaToCHW(crop, L.MODEL_SIZE, L.MODEL_SIZE, 'rgb', 1 / 255);

  const t3 = performance.now();
  const { output } = await antispoof.run({ input: new ort.Tensor('float32', spoofInput, [1, 3, 128, 128]) });
  const t4 = performance.now();

  return {
    face,
    faceCount: faces.length,
    logits: [output.data[0], output.data[1]],
    pReal: L.realProbability(output.data),
    timings: { ...timings, antispoof: t4 - t3, total: t4 - t0 },
  };
}

// For tests and debugging: run the pipeline on an image URL (e.g. a data: URL).
async function analyzeImage(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  return analyzeSource(img, img.naturalWidth, img.naturalHeight);
}

// ---------- UI updates ----------

function setResult(state, title, detail, pLive) {
  $('resultCard').dataset.state = state;
  $('verdict').textContent = title;
  $('verdictDetail').textContent = detail;
  $('meterFill').style.width = pLive == null ? '0%' : `${(pLive * 100).toFixed(0)}%`;
  $('probText').textContent = pLive == null ? 'P(live) –' : `P(live) ${(pLive * 100).toFixed(1)}%`;
}

const COLORS = { live: '#2ecc71', spoof: '#ff5a5f', uncertain: '#f5b942' };

function drawFace(face, state) {
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!face) return;
  ctx.strokeStyle = COLORS[state] || COLORS.uncertain;
  ctx.lineWidth = 3;
  ctx.strokeRect(face.x, face.y, face.width, face.height);
}

function showTimings(t) {
  const ms = (v) => (v == null ? '–' : `${v.toFixed(1)} ms`);
  $('detMs').textContent = ms(t.detection);
  $('spoofMs').textContent = ms(t.antispoof);
  $('totalMs').textContent = ms(t.total);
}

function showAnalysis(result) {
  showTimings(result.timings);
  if (!result.face) {
    history = [];
    drawFace(null);
    setResult('noface', 'No face detected', 'Look straight at the camera in good, even light.', null);
    return;
  }
  if (result.tooSmall) {
    history = [];
    drawFace(result.face, 'uncertain');
    setResult('uncertain', 'Uncertain', 'Face is too small for a reliable check. Move closer to the camera.', null);
    return;
  }

  history.push(result.pReal);
  if (history.length > SMOOTHING_FRAMES) history.shift();
  const avg = history.reduce((a, b) => a + b, 0) / history.length;
  const state = L.verdict(avg);
  const titles = { live: 'Likely live', spoof: 'Possible spoof', uncertain: 'Uncertain' };
  const extra = result.faceCount > 1 ? ` ${result.faceCount} faces seen; checking the largest.` : '';
  const detail = `Average of last ${history.length} frame(s). This frame: P(live) ${(result.pReal * 100).toFixed(1)}%.${extra}`;
  drawFace(result.face, state);
  setResult(state, titles[state], detail, avg);
}

// Analyse frames one after another while the camera is on.
async function loop() {
  if (!stream) return;
  try {
    if (video.readyState >= 2) {
      const result = await analyzeSource(video, video.videoWidth, video.videoHeight);
      if (stream) showAnalysis(result);
    }
  } catch (err) {
    setResult('uncertain', 'Inference error', err.message, null);
  }
  if (stream) setTimeout(loop, FRAME_GAP_MS);
}

function setChip(chipId, textId, state, text) {
  $(chipId).className = `chip ${state}`;
  $(textId).textContent = text;
}

function showMessage(text) {
  $('message').textContent = text;
  $('message').hidden = !text;
}

// Turn getUserMedia errors into something a user can act on.
function cameraErrorText(err) {
  switch (err.name) {
    case 'NotAllowedError':
      return 'Camera permission was denied. On macOS open System Settings › Privacy & Security › Camera, allow this app, then restart it.';
    case 'NotFoundError':
      return 'No camera was found. Connect a webcam and try again.';
    case 'NotReadableError':
      return 'The camera is in use by another application. Close it and try again.';
    default:
      return `Could not start the camera: ${err.message || err.name}`;
  }
}

async function startCamera() {
  showMessage('');
  $('startBtn').disabled = true;
  setChip('cameraChip', 'cameraStatus', 'busy', 'Starting camera…');
  // If the OS permission prompt is open, getUserMedia() waits until it is answered.
  const hint = setTimeout(() => {
    if (!stream) showMessage('Waiting for camera permission. Look for a system prompt and click Allow.');
  }, 4000);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
    $('placeholder').hidden = true;
    $('stopBtn').disabled = false;
    showMessage('');
    setChip('cameraChip', 'cameraStatus', 'ok', `Camera on · ${video.videoWidth}×${video.videoHeight}`);
    history = [];
    loop();
  } catch (err) {
    stream = null;
    $('startBtn').disabled = false;
    setChip('cameraChip', 'cameraStatus', 'error', 'Camera error');
    showMessage(cameraErrorText(err));
  } finally {
    clearTimeout(hint);
  }
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
  $('placeholder').hidden = false;
  $('stopBtn').disabled = true;
  $('startBtn').disabled = false;
  setChip('cameraChip', 'cameraStatus', '', 'Camera off');
  setResult('idle', 'Waiting for camera', 'The model runs once a face is visible.', null);
}

$('startBtn').addEventListener('click', startCamera);
$('stopBtn').addEventListener('click', stopCamera);
loadModels();
