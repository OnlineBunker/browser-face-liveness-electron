// Electron main process: creates the window, serves the app files over a
// private app:// scheme, and only allows camera (video) permission.
const { app, BrowserWindow, protocol, net, session, systemPreferences } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const APP_ROOT = path.join(__dirname, '..'); // folder that contains src/ and models/

// app:// behaves like a normal secure website origin, so fetch(), WebAssembly
// and getUserMedia() all work, which plain file:// URLs do not fully support.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function serveAppFiles() {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const filePath = path.normalize(path.join(APP_ROOT, decodeURIComponent(pathname)));

    // Never serve anything outside the app folder (e.g. app://local/../../etc).
    if (!filePath.startsWith(APP_ROOT + path.sep)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function allowOnlyCamera() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const videoOnly = permission === 'media' && (details.mediaTypes || []).every((t) => t === 'video');
    callback(videoOnly);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    title: 'Face Liveness Detector',
    backgroundColor: '#0f1420',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // page JS cannot touch preload/Electron internals
      nodeIntegration: false, // page JS cannot require() Node modules
      sandbox: true,
    },
  });

  // Block navigation and pop-ups: the app is a single local page.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  win.loadURL('app://local/src/renderer/index.html');
  return win;
}

app.whenReady().then(async () => {
  serveAppFiles();
  allowOnlyCamera();

  // On macOS, trigger the system camera prompt up front. If the user denies it,
  // getUserMedia() fails later and the page shows a clear error.
  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('camera').catch(() => false);
  }

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
