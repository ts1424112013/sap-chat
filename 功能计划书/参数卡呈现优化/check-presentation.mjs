import {Browser,sleep} from '/Users/tangtang/.codex/skills/design-taste-frontend/scripts/lib/cdp.mjs';
import {writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const dir=dirname(fileURLToPath(import.meta.url));
const b=await Browser.launch();
try{
 const p=await b.newPage({width:1440,height:960});
 await p.send('Page.addScriptToEvaluateOnNewDocument',{source:`Object.defineProperty(window,'ZAI_CONFIG',{configurable:true,get(){return this.__qaConfig},set(v){this.__qaConfig=Object.assign({},v,{mode:'mock'})}});`});
 await p.goto('http://127.0.0.1:8081/index.html',{settleMs:1600});
 await p.eval(()=>{const button=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('演示身份进入'));sap.ui.getCore().byId(button.id).firePress();});await sleep(600);
 await p.eval(async()=>{
  const svc=window.__qaService=await new Promise(r=>sap.ui.require(['zai/chat/service/ChatService'],r));
  const c=window.__qaController=sap.ui.getCore().byId(document.querySelector('.sapUiXMLView').id).getController();
  const chat=c.getView().getModel('chat');
  chat.setProperty('/models',[{ModelId:'QA',ModelName:'界面验收',IsActive:'X'}]);
  c._setSessionContext({id:'PARAMS_PRESENTATION',mode:'AGENT',agentType:'FIORI',status:'IDLE'});chat.setProperty('/workspaceMode','AGENT');
  svc.sendByMode=()=>new Promise(r=>window.__qaResolve=r);
  svc.runFioriReport=(request)=>{window.__qaSubmitted=request;return Promise.reject(new Error('本地验收：模拟取数失败'));};
  document.querySelector('.welcomeToast')?.click();
  window.__firstCard=null;
  const observe=()=>{
   const card=[...document.querySelectorAll('.askCard')].find(el=>el.getBoundingClientRect().height>0);
   if(card&&!__firstCard){const entry=chat.getProperty('/messages').at(-1);window.__firstCard={streaming:!!entry.streaming,waiting:!!entry.waiting,raw:entry.raw,scrollTop:c.byId('chatScroll').getDomRef().scrollTop};}
  };
  new MutationObserver(observe).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['style','class']});
  c._executeSend({mode:'AGENT',agentType:'FIORI',displayText:'查看 shipment 报表',question:'查看 shipment 报表'});
 });await sleep(200);
 const answer='我找到了 shipment 报表。\n\n这次会按所选维度汇总出货数据，并使用你确认的日期范围。你可以同时选择多个维度，例如 ship mode 和 region。\n\nsite 和 bu 是可选条件，留空时不额外限制。确认参数后才会读取报表；如果范围还没想好，也可以先不取，稍后继续。';
 await p.eval(answer=>__qaResolve({status:'OK',answer,taskId:'PARAMS_TASK',taskModule:'FIORI',taskStatus:'WAITING_INPUT',needsInput:true,pendingParamsJson:JSON.stringify({kind:'FIORI',report_id:'SHIPMENT',report_name:'shipment报表',values:{DIM:'SHMODE',DATE:'20261001,20261031'},params:[{param_id:'DIM',label:'维度',data_type:'ENUM',required:true,multi_value:true,enum_json:[{key:'SHMODE',text:'ship mode'},{key:'REGION',text:'region'},{key:'SITE',text:'SITE'},{key:'BU',text:'BU'},{key:'MODEL',text:'MODEL'}]},{param_id:'DATE',label:'日期区间',data_type:'DATE',range_allowed:true,required:true},{param_id:'SITE',label:'site',multi_value:true},{param_id:'BU',label:'bu',multi_value:true}]})}),answer);
 await sleep(420);
 const typing=await p.eval(()=>{const e=__qaController.getView().getModel('chat').getProperty('/messages').at(-1);return {streaming:e.streaming,rawLength:e.raw.length,cards:[...document.querySelectorAll('.askCard')].filter(el=>el.getBoundingClientRect().height>0).length};});
 assert.equal(typing.streaming,true);assert.equal(typing.cards,0);
 await p.eval(()=>{const c=__qaController;const input=c.byId('msgInput');input.setValue('下一步想按 region 看');c.getView().getModel('chat').setProperty('/input','下一步想按 region 看');input.focus();window.__draftFocus=document.activeElement.id;});
 await p.screenshot({path:join(dir,'after-typing.png'),format:'png',fullPage:true});
 for(let i=0;i<50;i++){if(await p.eval(()=>!__qaController.getView().getModel('chat').getProperty('/busy')))break;await sleep(100);}
 await sleep(350);
 const after=await p.eval(()=>{
  const c=__qaController,entry=c.getView().getModel('chat').getProperty('/messages').at(-1),card=document.querySelector('.askCard');
  const row=card.closest('.chatRow'),body=row.querySelector('.bubbleBody');
  return {first:__firstCard,raw:entry.raw,cardVisible:card.getBoundingClientRect().height>0,focusId:document.activeElement.id,expectedFocus:__draftFocus,draft:c.getView().getModel('chat').getProperty('/input'),autoFocus:entry.ask.autoFocus,scrollTop:c.byId('chatScroll').getDomRef().scrollTop,bodyBeforeCard:!!(body.compareDocumentPosition(card)&Node.DOCUMENT_POSITION_FOLLOWING)};
 });
 assert.equal(after.first.streaming,false);assert.equal(after.first.raw,answer);
 assert.equal(after.raw,answer);assert.ok(after.cardVisible&&after.bodyBeforeCard);
 assert.equal(after.focusId,after.expectedFocus);assert.equal(after.autoFocus,false);
 assert.equal(after.draft,'下一步想按 region 看');
 assert.ok(Math.abs(after.scrollTop-after.first.scrollTop)<3);
 await p.screenshot({path:join(dir,'after-explanation-and-params.png'),format:'png',fullPage:true});
 await p.eval(()=>{
  const field=[...document.querySelectorAll('.askField')].find(el=>el.querySelector('.askFieldLabel')?.textContent==='site');
  const id=field.querySelector('input').closest('.sapMInputBase').id;
  const input=sap.ui.getCore().byId(id);input.setValue('HHZZ');input.fireLiveChange({value:'HHZZ'});
  sap.ui.getCore().byId(document.querySelector('.askConfirm').id).firePress();
 });await sleep(250);
 const submit=await p.eval(()=>({request:__qaSubmitted,state:__qaController.getView().getModel('chat').getProperty('/messages').at(-1).ask.state,values:__qaController.getView().getModel('chat').getProperty('/messages').at(-1).ask.values}));
 assert.equal(JSON.parse(submit.request.paramsJson).SITE,'HHZZ');assert.equal(submit.state,'open');assert.equal(submit.values.SITE,'HHZZ');
 assert.deepEqual(p.consoleErrors,[]);
 writeFileSync(join(dir,'browser-results.json'),JSON.stringify({typing,after,submit,consoleErrors:p.consoleErrors},null,2));
 console.log(JSON.stringify({typing,firstVisible:after.first,focusPreserved:after.focusId===after.expectedFocus,scrollPreserved:true,submitPreserved:true},null,2));
}finally{await b.close();}
