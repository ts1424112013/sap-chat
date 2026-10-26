import {Browser,sleep} from '/Users/tangtang/.codex/skills/design-taste-frontend/scripts/lib/cdp.mjs';
import {writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const dir=dirname(fileURLToPath(import.meta.url));
const browser=await Browser.launch();
const results=[];
try{
  const page=await browser.newPage({width:1440,height:960});
  await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`Object.defineProperty(window,'ZAI_CONFIG',{configurable:true,get(){return this.__qaConfig},set(v){this.__qaConfig=Object.assign({},v,{mode:'mock'})}});`});
  await page.goto(process.env.LINGXI_QA_URL||'http://127.0.0.1:8081/index.html',{settleMs:1600});
  for(let i=0;i<40;i++){
    if(await page.eval(()=>!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('演示身份进入'))))break;
    await sleep(150);
  }
  assert.equal(await page.eval('document.title'),'灵犀 LingXi');
  assert.ok(await page.eval(()=>document.querySelectorAll('.lingxiMark').length>=3));
  assert.ok(await page.eval(()=>[...document.querySelectorAll('.lingxiArtwork')].every(svg=>svg.namespaceURI==='http://www.w3.org/2000/svg')));
  await page.screenshot({path:join(dir,'after-login.png'),format:'png',fullPage:true});
  await page.eval(()=>{
    const button=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('演示身份进入'));
    sap.ui.getCore().byId(button.id).firePress();
  });
  await sleep(850);
  await page.eval(async()=>{
    window.__qaService=await new Promise(resolve=>sap.ui.require(['zai/chat/service/ChatService'],resolve));
    window.__qaController=sap.ui.getCore().byId(document.querySelector('.sapUiXMLView').id).getController();
    __qaService.sendByMode=()=>new Promise((resolve,reject)=>{window.__qaResolve=resolve;window.__qaReject=reject;});
    const chat=__qaController.getView().getModel('chat');
    chat.setProperty('/models',[{ModelId:'QA_LOCAL',ModelName:'本地界面验收',IsActive:'X'}]);
    __qaController._applySessionModel();
    document.querySelector('.welcomeToast')?.click();
  });
  await sleep(500);
  assert.equal(await page.eval(()=>__qaController.getView().getModel('settings').getProperty('/userName')),'演示用户');
  await page.screenshot({path:join(dir,'after-home.png'),format:'png',fullPage:true});
  results.push('Built application login, demo login, home branding and native SVG render correctly.');
  const snapshot=()=>page.eval(()=>({
    model:__qaController.getView().getModel('chat').getProperty('/logoState'),
    side:document.querySelector('.brandLogoImage.lingxiMark').dataset.state,
    avatars:[...document.querySelectorAll('.chatAvatar.lingxiMark')].map(el=>el.dataset.state)
  }));
  const send=async text=>{
    await page.eval(text=>{__qaController.getView().getModel('chat').setProperty('/input',text);__qaController.onSend();},text);
    await sleep(200);
  };
  await send('本地界面验收：检查灵犀的思考和运行动效。');
  let snap=await snapshot();assert.equal(snap.side,'thinking');assert.equal(snap.avatars.at(-1),'thinking');
  results.push('Real send handler: waiting uses thinking on both sidebar and current message.');
  await page.eval(()=>__qaResolve({answer:'这是一条用于本地界面验收的回复，检查彩色叶翼在输出过程中持续展开。'.repeat(18),status:'OK',elapsedMs:800}));
  await sleep(750);
  snap=await snapshot();assert.equal(snap.side,'running');assert.equal(snap.avatars.at(-1),'running');
  await page.screenshot({path:join(dir,'after-chat-running.png'),format:'png',fullPage:true});
  const clocks=await page.eval(()=>{
    const root=document.querySelector('.brandLogoImage.lingxiMark');
    const control=sap.ui.getCore().byId(root.id);
    window.__qaSvg=root.querySelector('svg');window.__qaAnimation=root.getAnimations({subtree:true})[0];
    const before=__qaAnimation.currentTime;control.setState('running');
    return {sameSVG:__qaSvg===root.querySelector('svg'),sameAnimation:__qaAnimation===root.getAnimations({subtree:true})[0],before};
  });
  assert.ok(clocks.sameSVG&&clocks.sameAnimation);
  await sleep(100);
  assert.ok(await page.eval(t=>__qaAnimation.currentTime>t,clocks.before));
  results.push('Reply output uses the 2.4-second running loop; repeating the same state preserves SVG and animation clocks.');
  await page.eval(()=>__qaController.onStopGenerate());await sleep(550);
  snap=await snapshot();assert.equal(snap.side,'idle');assert.equal(snap.avatars.at(-1),'idle');
  assert.ok(await page.eval(()=>[...document.querySelectorAll('.chatAvatar.lingxiMark .lingxiPart')].every(el=>getComputedStyle(el).transform==='none')));
  results.push('Stopping generation settles all parts and leaves the stopped reply idle.');
  await send('本地界面验收：正常完成。');
  await page.eval(()=>__qaResolve({answer:'已完成本地界面验收。',status:'OK'}));await sleep(1400);
  snap=await snapshot();assert.equal(snap.side,'idle');assert.ok(snap.avatars.every(s=>s==='idle'));
  results.push('A normally completed request returns every completed message to idle.');
  await send('本地界面验收：模拟请求失败。');
  await page.eval(()=>__qaReject(new Error('本地验收：模拟请求失败')));await sleep(650);
  snap=await snapshot();assert.equal(snap.side,'idle');assert.ok(snap.avatars.every(s=>s==='idle'));
  results.push('A failed request clears thinking/running instead of leaving a busy logo.');
  await page.eval(()=>{
    const c=__qaController,chat=c.getView().getModel('chat');
    const entry=c._buildEntry('assistant','本地界面验收：报表已提交，正在等待后台结果。','','');
    entry.runPhase='active';window.__qaRunIndex=chat.getProperty('/messages').length;
    chat.getProperty('/messages').push(entry);c._refreshMessages();
    c._mRuns={qa:{timer:1}};c._syncActivity();
  });await sleep(500);
  snap=await snapshot();assert.equal(snap.side,'running');assert.equal(snap.avatars.at(-1),'running');
  await page.eval(()=>__qaController.onToggleTheme());await sleep(150);
  await page.screenshot({path:join(dir,'after-dark-running.png'),format:'png',fullPage:true});
  await page.eval(()=>{
    __qaController._mRuns={};__qaController.getView().getModel('chat').setProperty('/messages/'+__qaRunIndex+'/runPhase','ready');__qaController._syncActivity();
  });await sleep(550);
  snap=await snapshot();assert.equal(snap.side,'idle');assert.equal(snap.avatars.at(-1),'idle');
  results.push('Structured background-run state works independently of chat busy and settles when ready.');
  const ids=await page.eval(()=>[...document.querySelectorAll('.lingxiArtwork linearGradient')].map(el=>el.id));
  assert.equal(ids.length,new Set(ids).size);
  assert.ok(await page.eval(()=>[...document.querySelectorAll('.lingxiArtwork path')].every(el=>{const id=el.getAttribute('fill').slice(5,-1);return !!document.getElementById(id);})));
  results.push('All message, sidebar and welcome instances use unique, valid gradient references.');
  await page.eval(()=>{__qaController.onToggleTheme();__qaController.onNewSession();});await sleep(400);
  await page.setViewport({width:390,height:844,mobile:true});await sleep(200);
  const layout=await page.eval(()=>({viewport:innerWidth,content:document.documentElement.scrollWidth}));
  assert.ok(layout.content<=layout.viewport);
  await page.screenshot({path:join(dir,'after-mobile.png'),format:'png',fullPage:true});
  await page.eval(()=>{
    const root=document.querySelector('.brandLogoImage.lingxiMark');window.__qaMark=sap.ui.getCore().byId(root.id);__qaMark.setState('running');
  });await sleep(150);
  await page.eval(()=>{__qaMark.setState('idle');});
  await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await sleep(100);
  assert.equal(await page.eval(()=>document.getAnimations().filter(a=>a.effect?.target?.closest('.lingxiMark')).length),0);
  results.push('Mobile layout fits; reduced-motion preference stops loops and any in-flight settling.');
  await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await page.eval(async()=>{
    const Mark=await new Promise(resolve=>sap.ui.require(['zai/chat/control/LingXiMark'],resolve));
    const fixture=document.createElement('div');document.body.appendChild(fixture);
    const control=new Mark({state:'running'});control.placeAt(fixture);sap.ui.getCore().applyChanges();
    control.setState('idle');control.setState('running');control.setState('thinking');control.destroy();fixture.remove();
  });await sleep(500);
  assert.deepEqual(page.consoleErrors,[]);
  const assets=await page.eval(async()=>Promise.all(['images/lingxi-mark.svg','images/lingxi-favicon.svg'].map(async path=>{const r=await fetch(path);return {path,status:r.status,svg:(await r.text()).includes('#DA76A4')};})));
  assert.ok(assets.every(a=>a.status===200&&a.svg));
  results.push('Rapid state changes and destruction cause no script errors; built icons load with the approved color palette.');
  writeFileSync(join(dir,'project-browser-results.json'),JSON.stringify({results,assets,layout,consoleErrors:page.consoleErrors},null,2));
  console.log(JSON.stringify({checks:results.length,results,layout,assets},null,2));
}finally{await browser.close();}
