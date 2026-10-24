#!/usr/bin/env node
/**
 * Mmail · Windows portable build
 * ---------------------------------------------------------------------------
 * Assembles dist/Mmail-win-x64 from the local Electron runtime and the Mmail
 * sources, then zips the folder with PowerShell (no packaging dependency).
 *
 * Output: dist/Mmail-<version>-win-x64.zip
 * Usage:  npm run build:win
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const dist = path.join(root, 'dist');
const outDir = path.join(dist, 'Mmail-win-x64');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

if (!fs.existsSync(electronDist)) {
  console.error('node_modules/electron/dist is missing. Run npm install first.');
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

/* 1. Electron runtime */
fs.cpSync(electronDist, outDir, { recursive: true });

/* 2. Launcher name */
const exeOld = path.join(outDir, 'electron.exe');
const exeNew = path.join(outDir, 'Mmail.exe');
if (fs.existsSync(exeOld)) fs.renameSync(exeOld, exeNew);

/* 3. Application files */
const appDir = path.join(outDir, 'resources', 'app');
fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });

['package.json', 'electron', 'web', 'assets', 'LICENSE', 'README.md'].forEach((item) => {
  const from = path.join(root, item);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(appDir, item), { recursive: true });
});

/* 4. Trim what a release does not need */
const locales = path.join(outDir, 'locales');
if (fs.existsSync(locales)) {
  fs.readdirSync(locales)
    .filter((name) => name.endsWith('.pak') && name !== 'en-US.pak' && name !== 'zh-CN.pak')
    .forEach((name) => fs.rmSync(path.join(locales, name), { force: true }));
}
fs.rmSync(path.join(appDir, 'assets', 'icon-source.jpg'), { force: true });
fs.rmSync(path.join(outDir, 'resources', 'default_app.asar'), { force: true });

/* 5. Portable readme */
fs.writeFileSync(
  path.join(outDir, 'README.txt'),
  [
    'Mmail ' + pkg.version + ' (portable)',
    '',
    'Run Mmail.exe to start the application.',
    'Data is stored in %APPDATA%\\Mmail.',
    'Closing the window keeps Mmail in the tray; quit from the tray menu.',
    '',
    'Mmail launches the official sign-in pages of mail providers. It is not',
    'affiliated with any provider and never collects web credentials.',
    '',
  ].join('\r\n'),
  'utf8'
);

/* 6. Zip */
const zipPath = path.join(dist, 'Mmail-' + pkg.version + '-win-x64.zip');
fs.rmSync(zipPath, { force: true });
const result = spawnSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    "Compress-Archive -Path '" + outDir + "\\*' -DestinationPath '" + zipPath + "' -CompressionLevel Optimal -Force",
  ],
  { stdio: 'inherit' }
);
if (result.status !== 0) {
  console.error('zip failed');
  process.exit(1);
}

const mb = (file) => (fs.statSync(file).size / 1024 / 1024).toFixed(1) + ' MB';
console.log('folder: ' + outDir);
console.log('zip:    ' + zipPath + ' (' + mb(zipPath) + ')');
