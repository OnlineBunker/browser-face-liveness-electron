// Renderer: webcam handling and UI. The model pipeline is added on top of this.
const $ = (id) => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');

let stream = null; // the active MediaStream, or null when the camera is off

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
    setChip('cameraChip', 'cameraStatus', 'ok', `Camera on · ${video.videoWidth}×${video.videoHeight}`);
  } catch (err) {
    stream = null;
    $('startBtn').disabled = false;
    setChip('cameraChip', 'cameraStatus', 'error', 'Camera error');
    showMessage(cameraErrorText(err));
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
}

$('startBtn').addEventListener('click', startCamera);
$('stopBtn').addEventListener('click', stopCamera);
$('startBtn').disabled = false;
