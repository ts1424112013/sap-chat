import {Browser,sleep} from '/Users/tangtang/.codex/skills/design-taste-frontend/scripts/lib/cdp.mjs';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const dir=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const browser=await Browser.launch();
const result={};
try{
  const page=await browser.newPage({width:1440,height:1000});
  await page.goto(pathToFileURL(join(dir,'叶翼运行动态预览.html')).href,{settleMs:300});
  assert.deepEqual(page.consoleErrors,[]);
  const ids=await page.eval(()=>[...document.querySelectorAll('linearGradient')].map(el=>el.id));
  assert.equal(ids.length,new Set(ids).size);
  result.uniqueGradients=ids.length;
  const transforms=()=>page.eval(()=>[...document.querySelectorAll('.large-mark .wing-stem,.large-mark .wing-upper,.large-mark .wing-lower')].map(el=>getComputedStyle(el).transform));
  const frames=[await transforms()];
  for(let i=0;i<3;i++){await sleep(950);frames.push(await transforms());}
  for(let i=0;i<3;i++)assert.ok(new Set(frames.map(frame=>frame[i])).size>1,'Part '+i+' did not move');
  result.running='stem, upper and lower parts all move';
  await page.eval(()=>document.getElementById('pause').click());
  await sleep(100);
  const times=()=>page.eval(()=>document.getAnimations().filter(a=>a.effect?.target?.closest('.wing-mark')).map(a=>({time:a.currentTime,state:a.playState})));
  const before=await times();await sleep(300);const after=await times();
  assert.ok(after.every((a,i)=>a.state==='paused'&&Math.abs(a.time-before[i].time)<1));
  await page.eval(()=>document.getElementById('pause').click());
  result.pause='all animation clocks stopped and resumed';
  await page.eval(()=>document.querySelector('button[data-state="idle"]').click());
  await sleep(500);
  assert.ok((await transforms()).every(t=>t==='none'));
  assert.equal((await times()).length,0);
  result.stopping='returns to the original pose; no loop left running';
  await page.eval(()=>document.querySelector('button[data-state="thinking"]').click());
  await sleep(400);
  const durations=await page.eval(()=>document.querySelector('.large-mark').getAnimations({subtree:true}).map(a=>a.effect.getTiming().duration));
  assert.ok(durations.every(d=>d===5600));
  result.thinking='separate slower motion';
  await page.eval(()=>document.getElementById('demo').click());
  await sleep(8450);
  assert.equal(await page.eval('document.querySelector(".large-mark svg").dataset.state'),'idle');
  assert.ok((await transforms()).every(t=>t==='none'));
  result.demo='one run finishes and settles automatically';
  await page.eval(()=>document.querySelector('button[data-state="running"]').click());
  await sleep(1000);
  await page.screenshot({path:join(dir,'运行效果总览.png'),format:'png',fullPage:true});
  await page.eval(()=>document.getElementById('tone').click());
  await sleep(100);
  await page.screenshot({path:join(dir,'qa','dark-preview.png'),format:'png',fullPage:true});
  result.layouts=[];
  for(const width of [1440,768,390]){
    await page.setViewport({width,height:width===390?844:1000,mobile:width===390});
    const size=await page.eval(()=>({viewport:innerWidth,content:document.documentElement.scrollWidth}));
    assert.ok(size.content<=size.viewport);result.layouts.push(size);
  }
  mkdirSync(join(dir,'qa','downloads'),{recursive:true});
  await page.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:join(dir,'qa','downloads')});
  await page.eval(()=>document.getElementById('download').click());await sleep(600);
  assert.ok(readdirSync(join(dir,'qa','downloads')).includes('LingXi-叶翼-running.svg'));
  result.download='actual SVG file saved';
  await page.eval(()=>document.querySelector('button[data-state="idle"]').click());
  await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await sleep(150);
  assert.equal((await times()).length,0);
  result.reducedMotion='all motion stopped, including settling transitions';
  for(const state of ['idle','thinking','running']){
    const svg=readFileSync(join(dir,'exports','LingXi-叶翼-'+state+'.svg'),'utf8');
    assert.ok(svg.includes('data-state="'+state+'"'));
    const valid=await page.eval(text=>!new DOMParser().parseFromString(text,'image/svg+xml').querySelector('parsererror'),svg);
    assert.equal(valid,true);
  }
  result.offline='self-contained preview and SVG exports work offline';
  assert.deepEqual(page.consoleErrors,[]);
  writeFileSync(join(dir,'qa','behavior-results.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
