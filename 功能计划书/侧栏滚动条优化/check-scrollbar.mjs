import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const dir=dirname(fileURLToPath(import.meta.url));
// 截图时保留浏览器的原生滚动条；不修改共享技能脚本。
const helper=join(dir,'.browser-show-scrollbar.mjs');
writeFileSync(helper,readFileSync('/Users/tangtang/.codex/skills/design-taste-frontend/scripts/lib/cdp.mjs','utf8').replace("'--hide-scrollbars',",''));
const {Browser,sleep}=await import(pathToFileURL(helper));
unlinkSync(helper);
const stage=process.argv[2]||'after';
const browser=await Browser.launch();
try{
 const page=await browser.newPage({width:1440,height:960});
 await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`Object.defineProperty(window,'ZAI_CONFIG',{configurable:true,get(){return this.__qaConfig},set(v){this.__qaConfig=Object.assign({},v,{mode:'mock'})}});`});
 await page.goto('http://127.0.0.1:8081/index.html',{settleMs:1600});
 await page.eval(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('演示身份进入'));sap.ui.getCore().byId(button.id).firePress();});
 await sleep(600);
 await page.eval(async()=>{
  const svc=await new Promise(resolve=>sap.ui.require(['zai/chat/service/ChatService'],resolve));
  const c=window.__qaController=sap.ui.getCore().byId(document.querySelector('.sapUiXMLView').id).getController();
  window.__qaRows=Array.from({length:36},(_,i)=>({SessionId:'SCROLL_QA_'+i,Title:i%3?'选择报表：shipment报表 '+(i+1):'选择报表：采购未清报表 '+(i+1),ChangedAt:'20261026231300',Mode:'AGENT',AgentType:'FIORI',Status:'COMPLETED'}));
  svc.getSessions=options=>Promise.resolve(__qaRows.filter(row=>!options.search||row.Title.toLowerCase().includes(options.search.toLowerCase())).slice(0,options.top||50));
  c._switchWorkspace('AGENT');
  document.querySelector('.welcomeToast')?.click();
 });await sleep(400);
 await page.eval(()=>{const c=__qaController;c._aAllSessions=__qaRows;c._mSessMore={AGENT:false};c._mSessN={CHAT:50,AGENT:50};c._applySessionFilter();c.getView().getModel('session').setProperty('/currentId',__qaRows[0].SessionId);c._syncSessionHighlight();});
 await sleep(200);
 const measure=()=>page.eval(()=>{
  const el=document.querySelector('.sessionList'),css=getComputedStyle(el),bar=getComputedStyle(el,'::-webkit-scrollbar'),track=getComputedStyle(el,'::-webkit-scrollbar-track'),thumb=getComputedStyle(el,'::-webkit-scrollbar-thumb'),r=el.getBoundingClientRect();
  return {overflow:el.scrollHeight>el.clientHeight,scrollTop:el.scrollTop,gutter:el.offsetWidth-el.clientWidth,barBackground:bar.backgroundColor,trackBackground:track.backgroundColor,thumbBackground:thumb.backgroundColor,scrollbarColor:css.scrollbarColor,scheme:css.colorScheme,scrollbarWidth:css.scrollbarWidth,rect:{x:r.x,y:r.y,width:r.width,height:r.height},rows:el.querySelectorAll('.sessionItem').length};
 });
 await page.eval(()=>document.documentElement.setAttribute('data-theme','dark'));
 await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:900,y:100});await sleep(120);
 const dark=await measure();assert.ok(dark.overflow&&dark.rows>=30);
 await page.screenshot({path:join(dir,stage+'-dark.png'),format:'png',fullPage:true});
 await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:dark.rect.x+dark.rect.width-3,y:dark.rect.y+25});await sleep(100);
 const hover=await measure();
 await page.screenshot({path:join(dir,stage+'-dark-hover.png'),format:'png',fullPage:true});
 await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:900,y:100});
 await page.eval(()=>document.documentElement.setAttribute('data-theme','light'));await sleep(100);
 const light=await measure();
 await page.screenshot({path:join(dir,stage+'-light.png'),format:'png',fullPage:true});
 if(stage==='after'){
  assert.ok(dark.gutter<=7&&light.gutter<=7,'Scrollbar should be about 6px wide');
  assert.equal(dark.barBackground,'rgba(0, 0, 0, 0)');
  assert.equal(dark.trackBackground,'rgba(0, 0, 0, 0)');
  assert.notEqual(dark.thumbBackground,hover.thumbBackground);
  assert.notEqual(dark.thumbBackground,light.thumbBackground);
  await page.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:light.rect.x+100,y:light.rect.y+100,deltaX:0,deltaY:420});await sleep(160);
  const wheel=await measure();assert.ok(wheel.scrollTop>100,'Mouse wheel must still scroll the list');
  await page.eval(()=>document.querySelector('.sessionList').scrollTop=0);await sleep(100);
  const x=light.rect.x+light.rect.width-3,y=light.rect.y+18;
  await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
  await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
  for(let i=1;i<=5;i++){await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y:y+i*42,button:'left',buttons:1});await sleep(20);}
  await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y:y+210,button:'left',buttons:0,clickCount:1});await sleep(120);
  const drag=await measure();assert.ok(drag.scrollTop>100,'Dragging the narrow native thumb must still work');
  await page.eval(()=>{const field=__qaController.byId('sessionSearch');field.setValue('shipment');field.fireLiveChange({newValue:'shipment'});});await sleep(450);
  const searched=await page.eval(()=>[...document.querySelectorAll('.sessionItem .sessItemTitle')].map(el=>el.textContent));
  assert.equal(searched.length,24);assert.ok(searched.every(text=>text.includes('shipment')));
  await page.eval(()=>{const list=__qaController.byId('sessionList');list.getItems()[0].firePress();});await sleep(450);
  assert.equal(await page.eval(()=>__qaController.getView().getModel('session').getProperty('/currentId')),'SCROLL_QA_1');
  assert.deepEqual(page.consoleErrors,[]);
  writeFileSync(join(dir,'browser-results.json'),JSON.stringify({dark,hover,light,wheel:wheel.scrollTop,drag:drag.scrollTop,searchCount:searched.length,selection:'SCROLL_QA_1',consoleErrors:page.consoleErrors},null,2));
 }
 console.log(JSON.stringify({stage,dark,hover,light},null,2));
}finally{await browser.close();}
