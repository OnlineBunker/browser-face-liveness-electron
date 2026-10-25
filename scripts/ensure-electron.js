// Makes sure the Electron binary is installed before `npm start`.
// Electron's own installer can silently fail to unzip on Node 26, leaving
// node_modules/electron/dist empty. If so, download it again and unzip it
// with the operating system's own tool.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const binPaths = {
  darwin: 'Electron.app/Contents/MacOS/Electron',
  win32: 'electron.exe',
  linux: 'electron',
};

async function main() {
  const binPath = binPaths[process.platform];
  if (fs.existsSync(path.join(electronDir, 'dist', binPath))) return; // already fine

  console.log('Electron binary missing - downloading and unpacking it...');
  const { downloadArtifact } = require('@electron/get');
  const { version } = require(path.join(electronDir, 'package.json'));
  const zip = await downloadArtifact({ version, artifactName: 'electron', platform: process.platform, arch: process.arch });

  const dist = path.join(electronDir, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist);
  if (process.platform === 'darwin') execFileSync('ditto', ['-x', '-k', zip, dist]);
  else if (process.platform === 'win32') execFileSync('tar', ['-xf', zip, '-C', dist]);
  else execFileSync('unzip', ['-q', zip, '-d', dist]);
  fs.writeFileSync(path.join(electronDir, 'path.txt'), binPath);
  console.log(`Electron ${version} installed.`);
}

main().catch((err) => {
  console.error('Could not install Electron:', err.message);
  process.exit(1);
});
