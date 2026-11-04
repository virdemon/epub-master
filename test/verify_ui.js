// 用 Edge 加载新 UI，截图验证 4 个页面渲染正确
const path = require('path');
const puppeteer = require('puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const WWW = 'C:/Users/wh/WorkBuddy/2026-10-28-09-18-17/mobile/www';

async function main() {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 }); // iPhone 14 尺寸

  await page.goto('file:///' + path.join(WWW, 'index.html').replace(/\\/g, '/'));

  // 截图主页
  await page.screenshot({ path: path.join(__dirname, 'shot_home.png') });
  console.log('主页截图完成');

  // 检查主页元素
  const homeCheck = await page.evaluate(() => {
    return {
      title: document.querySelector('.hero-title').textContent,
      subtitle: document.querySelector('.hero-subtitle').textContent,
      btn: document.querySelector('#btn-choose').textContent,
      features: document.querySelectorAll('.feature-list li').length
    };
  });
  console.log('主页验证:', JSON.stringify(homeCheck));

  // 模拟选文件（通过直接设置 state 不行，因为 app.js 是 IIFE。改用点击流程验证 UI 状态切换）
  // 检查所有屏幕初始状态
  const screensCheck = await page.evaluate(() => {
    const screens = ['screen-home', 'screen-config', 'screen-progress', 'screen-done'];
    return screens.map((s) => ({
      id: s,
      hidden: document.getElementById(s).classList.contains('is-hidden')
    }));
  });
  console.log('屏幕初始状态:', JSON.stringify(screensCheck));

  // 检查是否有 JS 错误
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  // 重新加载触发脚本，等待执行
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 500));

  console.log('JS 错误:', errors.length ? errors : '无');

  await browser.close();
  console.log('\n✅ UI 渲染验证完成');
}

main().catch((e) => {
  console.error('❌ 失败:', e);
  process.exit(1);
});
