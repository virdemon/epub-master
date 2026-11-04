const path=require('path'),puppeteer=require('puppeteer-core');
const ROOT=path.resolve(__dirname,'..');
(async()=>{
  const b=await puppeteer.launch({executablePath:'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true,args:['--no-sandbox','--allow-file-access-from-files']});
  const p=await b.newPage();
  await p.setViewport({width:940,height:1000});
  await p.goto('file://'+path.join(ROOT,'dist','epubfix-standalone.html').replace(/\\/g,'/'),{waitUntil:'load'});
  await p.screenshot({path:path.join(ROOT,'test','standalone_idle.png'),fullPage:true});
  console.log('ok');
  await b.close();
})().catch(e=>{console.error(e.message);process.exit(1)});
