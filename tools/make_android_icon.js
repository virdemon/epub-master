/* 导出安卓图标：ic_launcher / ic_launcher_round / ic_launcher_foreground
   设计：蓝色渐变底 + 白色书本（左侧书脊）+ 深蓝向下箭头 = 把书压小 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const RES = path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'res');

const BG_FROM = '#4a86ff';
const BG_TO = '#1636c4';
const DEEP = '#1530b8';

const DEFS = `
  <defs>
    <linearGradient id="bg" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="${BG_FROM}"/>
      <stop offset="1" stop-color="${BG_TO}"/>
    </linearGradient>
    <linearGradient id="paper" x1="0" y1="0" x2="0.2" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#eaf1ff"/>
    </linearGradient>
    <linearGradient id="arrow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b57e2"/>
      <stop offset="1" stop-color="${DEEP}"/>
    </linearGradient>
    <clipPath id="bookClip"><rect x="248" y="222" width="528" height="580" rx="64"/></clipPath>
    <clipPath id="roundClip"><circle cx="512" cy="512" r="512"/></clipPath>
  </defs>`;

/* 书本 + 箭头这一组图形，单独抽出来方便前景层复用 */
const GLYPH = `
  <g clip-path="url(#bookClip)">
    <rect x="248" y="222" width="528" height="580" fill="url(#paper)"/>
    <rect x="248" y="222" width="126" height="580" fill="#d5e3ff"/>
    <rect x="362" y="222" width="10" height="580" fill="#b3c9f8"/>
  </g>
  <rect x="514" y="292" width="94" height="240" rx="22" fill="url(#arrow)"/>
  <path d="M440 498 H682 L574 672 Z" fill="url(#arrow)" stroke="url(#arrow)"
        stroke-width="40" stroke-linejoin="round"/>
`;

function svgFull(radius) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  ${DEFS}
  <rect width="1024" height="1024" rx="${radius}" fill="url(#bg)"/>
  ${GLYPH}
</svg>`;
}

function svgRound() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  ${DEFS}
  <g clip-path="url(#roundClip)">
    <rect width="1024" height="1024" fill="url(#bg)"/>
    ${GLYPH}
  </g>
</svg>`;
}

/* 前景层：只有图形，透明底；内容要落在 66/108 的安全区里，
   所以把 1024 画布的内容整体缩到 61%，再居中 */
function svgForeground() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  ${DEFS}
  <g transform="translate(512,512) scale(0.72) translate(-512,-512)">
    ${GLYPH}
  </g>
</svg>`;
}

const DENSITIES = [
  { dir: 'mipmap-mdpi', legacy: 48, fg: 108 },
  { dir: 'mipmap-hdpi', legacy: 72, fg: 162 },
  { dir: 'mipmap-xhdpi', legacy: 96, fg: 216 },
  { dir: 'mipmap-xxhdpi', legacy: 144, fg: 324 },
  { dir: 'mipmap-xxxhdpi', legacy: 192, fg: 432 },
];

async function render(browser, svg, size, outPath) {
  const page = await browser.newPage();
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">
      <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"
           width="${size}" height="${size}" style="display:block">
    </body></html>`,
    { waitUntil: 'load' }
  );
  await new Promise((r) => setTimeout(r, 60));
  await page.screenshot({ path: outPath, omitBackground: true });
  await page.close();
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new',
  });

  const full = svgFull(230);   // 圆角方形（老系统直接用这张）
  const round = svgRound();
  const fg = svgForeground();

  for (const d of DENSITIES) {
    const dir = path.join(RES, d.dir);
    fs.mkdirSync(dir, { recursive: true });
    await render(browser, full, d.legacy, path.join(dir, 'ic_launcher.png'));
    await render(browser, round, d.legacy, path.join(dir, 'ic_launcher_round.png'));
    await render(browser, fg, d.fg, path.join(dir, 'ic_launcher_foreground.png'));
    console.log('  ✓', d.dir, d.legacy + 'px / fg ' + d.fg + 'px');
  }

  // 自适应图标的背景改成渐变 drawable，和普通图标保持一致
  const drawableDir = path.join(RES, 'drawable');
  fs.mkdirSync(drawableDir, { recursive: true });
  fs.writeFileSync(path.join(drawableDir, 'ic_launcher_background.xml'),
`<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android"
    android:shape="rectangle">
    <gradient
        android:angle="315"
        android:startColor="${BG_FROM}"
        android:endColor="${BG_TO}"
        android:type="linear" />
</shape>
`);

  const anydpi = path.join(RES, 'mipmap-anydpi-v26');
  fs.mkdirSync(anydpi, { recursive: true });
  fs.writeFileSync(path.join(anydpi, 'ic_launcher.xml'),
`<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`);
  fs.writeFileSync(path.join(anydpi, 'ic_launcher_round.xml'),
`<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`);

  // 供 README / 商店展示备用
  const preview = path.join(ROOT, 'test', 'icon');
  fs.mkdirSync(preview, { recursive: true });
  await render(browser, full, 512, path.join(preview, 'final-512.png'));
  fs.writeFileSync(path.join(preview, 'final.svg'), full);

  console.log('图标导出完成');
  await browser.close();
})();
