// Render build/icon.svg to build/icon.png (1024) and build/icon.icns. Run: npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '../build/icon.svg'), 'utf8');
  const w = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const png = img.resize({ width: 1024, height: 1024 });
  fs.writeFileSync(path.join(__dirname, '../build/icon.png'), png.toPNG());
  const set = path.join(require('os').tmpdir(), 'pelican.iconset');
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(set, `icon_${s}x${s}.png`), png.resize({ width: s, height: s, quality: 'best' }).toPNG());
    fs.writeFileSync(path.join(set, `icon_${s}x${s}@2x.png`), png.resize({ width: s * 2, height: s * 2, quality: 'best' }).toPNG());
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(__dirname, '../build/icon.icns')]);
  console.log('icon written');
  app.quit();
});
