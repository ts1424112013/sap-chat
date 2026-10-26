import { Browser, sleep } from '/Users/tangtang/.codex/skills/design-taste-frontend/scripts/lib/cdp.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const dir=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const browser=await Browser.launch();
const results=[];
try {
  const page=await browser.newPage({width:1440,height:960});
  await page.goto(pathToFileURL(join(dir,'自然动效预览.html')).href,{settleMs:350});
  assert.equal(await page.eval('document.querySelectorAll(".candidate").length'),4);
  assert.deepEqual(page.consoleErrors,[]);
  for (const state of ['idle','thinking','running']) {
    await page.eval(s=>document.querySelector('[data-state-button="'+s+'"]').click(),state);
    await sleep(250);
    const get=()=>page.eval(()=>[...document.querySelectorAll('.candidate')].map(card=>({
      id:card.dataset.concept,state:card.querySelector('.main-mark svg').dataset.state,
      transforms:[...card.querySelectorAll('.main-mark g,.main-mark path,.main-mark ellipse')].map(el=>getComputedStyle(el).transform).join('|'),
      animations:card.querySelector('.main-mark').getAnimations({subtree:true}).filter(a=>a.playState==='running').length
    })));
    const before=await get(); await sleep(1600); const after=await get();
    for(let i=0;i<after.length;i++){
      assert.equal(after[i].state,state);
      assert.ok(after[i].animations>0,after[i].id+' has no animation in '+state);
      assert.notEqual(after[i].transforms,before[i].transforms,after[i].id+' did not move in '+state);
    }
    results.push({state,animatedConcepts:after.map(x=>x.id)});
  }
  await page.eval(()=>document.getElementById('pause').click());
  await sleep(100);
  const time=()=>page.eval(()=>document.getAnimations().filter(a=>a.effect?.target?.closest('.main-mark')).map(a=>({time:a.currentTime,state:a.playState})));
  const paused=await time();await sleep(350);const still=await time();
  assert.ok(still.every(x=>x.state==='paused'));
  assert.ok(still.every((x,i)=>Math.abs(x.time-paused[i].time)<1));
  results.push({pause:'all animation clocks stopped'});
  await page.eval(()=>document.getElementById('pause').click());
  await page.eval(()=>document.getElementById('demo').click());
  assert.equal(await page.eval('document.querySelector(".main-mark svg").dataset.state'),'idle');
  await sleep(3700);
  assert.equal(await page.eval('document.querySelector(".main-mark svg").dataset.state'),'thinking');
  await sleep(6600);
  assert.equal(await page.eval('document.querySelector(".main-mark svg").dataset.state'),'running');
  results.push({demo:'idle → thinking → running'});
  await page.eval(()=>document.getElementById('demo').click());
  await page.eval(()=>document.querySelector('[data-state-button="thinking"]').click());
  await sleep(1100);
  await page.screenshot({path:join(dir,'四款方案总览.png'),format:'png',fullPage:true});
  await page.eval(()=>document.getElementById('tone').click());
  assert.equal(await page.eval('document.body.classList.contains("dark-artboards")'),true);
  await sleep(300);
  assert.equal(await page.eval('getComputedStyle(document.querySelector(".artboard")).backgroundColor'),'rgb(36, 69, 61)');
  await page.screenshot({path:join(dir,'qa','dark-preview.png'),format:'png',fullPage:true});
  await page.eval(()=>document.getElementById('tone').click());
  const dimensions=[];
  for(const width of [1440,768,390]){
    await page.setViewport({width,height:width===390?844:960,mobile:width===390});
    await sleep(100);
    const size=await page.eval(()=>({viewport:innerWidth,content:document.documentElement.scrollWidth}));
    assert.ok(size.content<=size.viewport,'Horizontal overflow at '+width);
    dimensions.push(size);
  }
  results.push({layout:dimensions});
  await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await sleep(150);
  assert.equal(await page.eval('document.getAnimations().length'),0);
  assert.equal(await page.eval('document.getElementById("pause").disabled'),true);
  results.push({reducedMotion:'no animations'});
  const parsed=await page.eval(()=>window.LingXiConcepts.every(c=>!new DOMParser().parseFromString(c.svg,'image/svg+xml').querySelector('parsererror')));
  assert.equal(parsed,true);
  for(const id of ['rhino','sprout','fish','pair']){
    for(const state of ['idle','thinking','running','static']){
      const svg=readFileSync(join(dir,'exports',id+'-'+state+'.svg'),'utf8');
      assert.ok(svg.includes('data-state="'+state+'"'));
      assert.ok(svg.includes('<style>'));
    }
  }
  results.push({exports:'16 self-contained SVG files; states and XML valid'});
  assert.deepEqual(page.consoleErrors,[]);
  results.push({offline:'standalone HTML works directly from file; no script errors'});
  writeFileSync(join(dir,'qa','behavior-results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
} finally {await browser.close();}
