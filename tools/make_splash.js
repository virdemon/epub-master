/* 重新生成启动图：品牌蓝渐变 + 居中的新图标图形 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const RES = path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'res');

const BG_FROM = '#4a86ff';
const BG_TO = '#1636c4';
const DEEP = '#1530b8';

const GLYPH = `
  <defs>
    <linearGradient id="paper" x1="0" y1="0" x2="0.2" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#dce7ff"/>
    </linearGradient>
    <linearGradient id="arrow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b57e2"/>
      <stop offset="1" stop-color="${DEEP}"/>
    </linearGradient>
    <clipPath id="bookClip"><rect x="248" y="222" width="528" height="580" rx="64"/></clipPath>
  </defs>
  <g clip-path="url(#bookClip)">
    <rect x="248" y="222" width="528" height="580" fill="url(#paper)"/>
    <rect x="248" y="222" width="126" height="580" fill="#c9dbff"/>
    <rect x="362" y="222" width="10" height="580" fill="#a8c0f5"/>
  </g>
  <rect x="514" y="292" width="94" height="240" rx="22" fill="url(#arrow)"/>
  <path d="M440 498 H682 L574 672 Z" fill="url(#arrow)" stroke="url(#arrow)"
        stroke-width="40" stroke-linejoin="round"/>`;

function splashSvg(w, h) {
  const short = Math.min(w, h);
  const size = short * 0.42;           // 图形占短边约三分之一
  const scale = size / 1024;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <defs>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.62">
      <stop offset="0" stop-color="#5b93ff"/>
      <stop offset="0.55" stop-color="#2f60ea"/>
      <stop offset="1" stop-color="#1533bd"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#glow)"/>
  <g transform="translate(${w / 2},${h / 2}) scale(${scale}) translate(-512,-512)">
    ${GLYPH}
  </g>
</svg>`;
}

const TARGETS = [
  ['drawable', 480, 320],
  ['drawable-land-mdpi', 480, 320],
  ['drawable-land-hdpi', 800, 480],
  ['drawable-land-xhdpi', 1280, 720],
  ['drawable-land-xxhdpi', 1600, 960],
  ['drawable-land-xxxhdpi', 1920, 1280],
  ['drawable-port-mdpi', 320, 480],
  ['drawable-port-hdpi', 480, 800],
  ['drawable-port-xhdpi', 720, 1280],
  ['drawable-port-xxhdpi', 960, 1600],
  ['drawable-port-xxxhdpi', 1280, 1920],
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new',
  });

  for (const [dir, w, h] of TARGETS) {
    const out = path.join(RES, dir, 'splash.png');
    if (!fs.existsSync(path.join(RES, dir))) continue;
    const svg = splashSvg(w, h);
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.setContent(
      `<html><body style="margin:0"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"
        width="${w}" height="${h}" style="display:block"></body></html>`,
      { waitUntil: 'load' }
    );
    await new Promise((r) => setTimeout(r, 50));
    await page.screenshot({ path: out });
    await page.close();
    console.log('  ✓', dir, w + 'x' + h);
  }

  await browser.close();
  console.log('启动图完成');
})();
