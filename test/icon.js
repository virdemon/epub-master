/* 把 icon.svg 渲染成多尺寸 PNG，供打包 ICO 用 */
const fs = require('fs'), path = require('path'), puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SVG = path.join(ROOT, 'epubfix', 'assets', 'icon.svg');

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: true,
    args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const p = await b.newPage();
  fs.mkdirSync(path.join(ROOT, 'dist', 'icons'), { recursive: true });
  const svg = fs.readFileSync(SVG, 'utf8');

  for (const size of [256, 128, 64, 48, 32, 16]) {
    await p.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await p.setContent(
      `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>` +
      svg.replace('width="256" height="256"', `width="${size}" height="${size}"`),
      { waitUntil: 'load' });
    await p.screenshot({
      path: path.join(ROOT, 'dist', 'icons', `icon_${size}.png`),
      omitBackground: true, clip: { x: 0, y: 0, width: size, height: size }
    });
    console.log('  ' + size + '×' + size);
  }
  await b.close();
})().catch(e => { console.error(e.message); process.exit(1); });
