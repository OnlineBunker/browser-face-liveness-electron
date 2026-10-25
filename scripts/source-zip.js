// Creates release/browser-face-liveness-electron-source.zip from the files
// tracked by git (so node_modules, builds and local files are left out).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'release', 'browser-face-liveness-electron-source.zip');
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync('git', ['archive', '--format=zip', '--prefix=browser-face-liveness-electron/', '-o', out, 'HEAD']);
console.log(`Wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
