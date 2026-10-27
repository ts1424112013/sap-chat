const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Skills = require('../webapp/utils/SkillCatalog');
const {runAgent} = require('./agent-loop');
function loadUI(overrides) {
  const mem = new Map();
  const registry = Object.assign({'sap/base/Log': {}, 'sap/ui/model/odata/v2/ODataModel': function () {},
    'sap/ui/model/Filter': function () {}, 'sap/ui/model/FilterOperator': {}, 'sap/ui/model/Sorter': function () {}}, overrides || {});
  class Model {
    constructor(data) {this.data=data;}
    getProperty(p) {return p.split('/').filter(Boolean).reduce((o,k)=>o == null ? undefined : o[k],this.data);}
    setProperty(p,v) {const keys=p.split('/').filter(Boolean);const last=keys.pop();let o=this.data;for(const k of keys) o=o[k] || (o[k]={});o[last]=v;}
  }
  registry['sap/ui/model/json/JSONModel']=Model;
  function load(name) {
    if (registry[name]) return registry[name];
    if (name.startsWith('sap/')) return function () {};
    let out;
    const sandbox = {sap:{ui:{define:(deps, fn)=>{out = fn(...deps.map(load));}}},
      window:{localStorage:{getItem:k=>mem.get(k)||null, setItem:(k,v)=>mem.set(k,v)}},
      console, Promise, JSON, Object, Array, Number, String, Error, Date, Math, RegExp,
      setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, Uint8Array,
      jQuery:{extend:(...args)=>Object.assign({}, ...args.filter(a=>typeof a === 'object'))}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../webapp',name.replace(/^zai\/chat\//,'')+'.js'),'utf8'),sandbox);
    registry[name] = out; return out;
  }
  const service=load('zai/chat/service/ChatService');service._testLoad=load;return service;
}
test('8 个内置技能均满足长度、场景、工具和版本约束', () => {
  assert.equal(Skills.builtin.length, 8);
  for (const s of Skills.builtin) assert.equal(Skills.validate(s).id, s.id);
});
test('拒绝自动场景、保留编号、未知工具、跨场景工具、超长正文和非法轮数', () => {
  const s = Skills.builtin[0];
  for (const patch of [{scenes:['AUTO']},{id:'NONE'},{tools:['delete_anything']},
    {scenes:['CODE','REPORT'],tools:['read_program_source']},{body:'x'.repeat(3001)},
    {maxRounds:11},{maxRounds:2.5},{visibility:'PRIVATE'},{version:-1},{version:2147483647}]) {
    assert.throws(()=>Skills.validate({...s,...patch}));
  }
});
test('工具交集：空子集沿用场景，报表始终无工具，不认识的场景无工具', () => {
  assert.deepEqual(Skills.allowedTools('CODE',{tools:['read_program_source','run_sql']}),['read_program_source']);
  assert.deepEqual(Skills.allowedTools('CODE',{tools:[]}), Skills.sceneTools.CODE);
  assert.deepEqual(Skills.allowedTools('FIORI',{tools:['run_sql']}), []);
  assert.deepEqual(Skills.allowedTools('AUTO',null), []);
});
test('目录权限、停用状态、搜索和斜杠解析', () => {
  assert.equal(Skills.available({...Skills.builtin[0],visibility:'ADMIN'},'CODE',false), false);
  assert.equal(Skills.available({...Skills.builtin[0],active:false},'CODE',true), false);
  assert.equal(Skills.available(Skills.builtin[0],'DATA',true), false);
  assert.equal(Skills.filter(Skills.builtin,'解读')[0].id,'CODE_EXPLAIN');
  assert.equal(Skills.slash('/性能'), '性能');
  assert.equal(Skills.slash('正常 / 问题'), null);
  assert.equal(Skills.slash('/a\nb'), null);
  const s=loadUI(), evals=s._testLoad('zai/chat/utils/AgentEval');
  assert.equal(evals.normalizeCases({cases:[{id:'F1',scene:'FIORI',question:'分析结果'}]}).cases[0].scene,'FIORI');
});
test('演示目录：按场景过滤，非管理员不能维护，保存有乐观版本检查', async () => {
  const s = loadUI(); s._sAppUser={userId:'A',role:'USER'};
  let r=await s.getSkills({scene:'CODE',sessionId:'S'});
  assert.equal(r.skills.length,4);
  await assert.rejects(()=>s.saveSkill(Skills.builtin[0]), /管理员/);
  await assert.rejects(()=>s.getSkills({includeInactive:true}), /管理员/);
  s._sAppUser.role='ADMIN';
  const saved=await s.saveSkill({...Skills.builtin[0],name:'新版性能审查'});
  assert.equal(saved.version,2);
  await assert.rejects(()=>s.saveSkill(Skills.builtin[0]), /版本/);
  r=await s.getSkills({scene:'CODE'}); assert.equal(r.skills[0].name,'代码解读');
});
test('演示任务：选择、沿用、取消、任务/账号/会话隔离', async () => {
  const s=loadUI(); s._sAppUser={userId:'A',role:'ADMIN'};
  s._mockSendAgent=async()=>({trace:[],answer:'演示',status:'OK'});
  const p={scene:'CODE',sessionId:'S',taskId:'T',skillId:'CODE_EXPLAIN'};
  let r=await s.sendByMode({...p,mode:'AGENT'}); assert.equal(r.skillId,'CODE_EXPLAIN');
  r=await s.sendTask({...p,skillId:''}); assert.equal(r.skillId,'CODE_EXPLAIN');
  assert.equal((await s.getSkills({...p,taskId:'OTHER'})).selectedId,'');
  assert.equal((await s.getSkills({...p,sessionId:'OTHER'})).selectedId,'');
  s._sAppUser.userId='B'; assert.equal((await s.getSkills(p)).selectedId,''); s._sAppUser.userId='A';
  r=await s.sendTask({...p,skillId:'NONE'}); assert.equal(r.skillId,undefined);
  r=await s.sendTask({...p,skillId:''}); assert.equal(r.skillId,undefined);
  await assert.rejects(()=>s.sendTask({...p,scene:'DATA'}), /不适用/);
});
test('旧 metadata 不显示技能；带技能的请求不允许静默回退', async () => {
  const s=loadUI(); s._sConfig.mode='backend';
  s._getModel=()=>({metadataLoaded:()=>Promise.resolve(),getServiceMetadata:()=>({})});
  let r=await s.getSkills({scene:'CODE'}); assert.equal(r.supported,false);
  await assert.rejects(()=>s.sendTask({skillId:'CODE_EXPLAIN'}), /不支持/);
  await assert.rejects(()=>s.sendAgent({skillId:'CODE_EXPLAIN'}), /不能降级/);
  s._taskApiAvailable=false;
  await assert.rejects(()=>s.sendTask({skillId:'CODE_EXPLAIN'}), /尚未部署/);
});
test('新 metadata 始终传 SkillId（包括空值），不把正文拼入 Question', async () => {
  const s=loadUI(); s._sConfig.mode='backend'; s._fiHasParam=()=>true; s._prepareQuestion=async q=>q;
  let sent;
  s._getModel=()=>({callFunction:(name,opts)=>{sent=opts.urlParameters; opts.success({Answer:'ok',Status:'OK',TraceJson:'[]'});}});
  await s.sendByMode({mode:'AGENT',sessionId:'S',scene:'CODE',question:'代码问题',skillId:'CODE_EXPLAIN'});
  assert.equal(sent.SkillId,'CODE_EXPLAIN'); assert.equal(sent.Question,'代码问题');
  await s.sendTask({sessionId:'S',question:'追问'}); assert.equal(sent.SkillId,'');
});
test('技能保存走长文本通道，正文与说明按普通文本传递', async () => {
  const s=loadUI(); s._sConfig.mode='backend'; s._sAppUser={userId:'A',role:'ADMIN'};
  let prepared, sent;
  s._prepareQuestion=async q=>{prepared=JSON.parse(q);return '@@ZAI_TEXT:TEST';};
  s._taskCall=async (action,params)=>{sent={action,params};return {success:true,result:{...prepared,version:2}};};
  await s.saveSkill({...Skills.builtin[0],body:'<script>仅作为正文</script>'});
  assert.equal(sent.action,'SkillSave'); assert.equal(sent.params.Payload,'@@ZAI_TEXT:TEST');
  assert.equal(prepared.scenes,'CODE'); assert.equal(prepared.body,'<script>仅作为正文</script>');
});
test('本地 Agent 在调用执行器之前拦截技能范围外的工具', async () => {
  let calls=0;
  const r=await runAgent('统计', {scene:'DATA',skillId:'DATA_MULTI_DIM',
    callLLM:async()=>({content:JSON.stringify({action:'tool',tool:'get_stock',summary:'越界测试',args:{}})}),
    executeTool:async()=>{calls++; return {status:'OK',data:{}};}});
  assert.equal(calls,0); assert.equal(r.status,'ERROR');
  assert.equal(JSON.parse(r.trace_json).some(t=>t.status==='REJECTED'),true);
});
test('本地 Agent 把做法放在协议之前，仍可正常收口', async () => {
  let prompt;
  const r=await runAgent('统计', {scene:'DATA',skillId:'DATA_MULTI_DIM',callLLM:async messages=>{
    prompt=messages[0].content; return {content:JSON.stringify({action:'final',summary:'完成',answer:'未取数，不编造统计结果'})};
  }});
  assert.equal(r.status,'OK'); assert.ok(prompt.indexOf('【技能：')<prompt.indexOf('【协议要求】'));
});
test('SAP 源码：所有工具分支之前检查交集，参数和审计接线齐全', () => {
  const src=fs.readFileSync(path.join(__dirname,'../backend-abap/ZCL_AI_AGENT_SERVICE.abap'),'utf8');
  const guard=src.indexOf('AND NOT line_exists( lt_allowed_tools');
  assert.ok(guard>0 && guard<src.indexOf('IF ls_out-tool = zcl_ai_tool_registry=>gc_tool_data_analysis'));
  assert.ok(src.includes('iv_skill_id   TYPE string OPTIONAL'));
  assert.ok(src.includes('zcl_ai_skill_service=>audit('));
  const service=fs.readFileSync(path.join(__dirname,'../backend-abap/ZCL_AI_SKILL_SERVICE.abap'),'utf8');
  assert.ok(service.includes('AND version = @es_skill-version'));
  assert.ok(service.includes('AND owner = @sy-uname'));
});

test('历史标记使用当时版本；目录请求失败仍保留原有消息', async () => {
  const s=loadUI();
  s.getSkills=async()=>({uses:[{userSeq:11,name:'旧名称',version:2}]});
  const rows=await s._skillHistory('S',[{MsgSeq:'000011'},{MsgSeq:'000012'},{MsgSeq:'000013'}]);
  assert.equal(rows[0].SkillMeta,'技能：旧名称 v2');assert.equal(rows[1].SkillMeta,'技能：旧名称 v2');assert.equal(rows[2].SkillMeta,'');
  s.getSkills=async()=>{throw new Error('离线');};
  const original=[{Content:'原文'}];assert.equal(await s._skillHistory('S',original),original);
});
test('切换会话和同会话强制刷新时，迟到的技能目录不能覆盖最新状态', async () => {
  const s=loadUI(), Model=s._testLoad('sap/ui/model/json/JSONModel');
  const models={chat:new Model({currentSession:{id:'A'},currentTask:null})};
  const view={getModel:name=>models[name],setModel:(m,name)=>{models[name]=m;}};
  const panel=Object.assign({},s._testLoad('zai/chat/controller/mixin/SkillPanel'),{
    getView:()=>view,_curScene:()=> 'CODE',_wsMode:()=> 'AGENT',_paintSkill:()=>{},_renderHeroBubbles:()=>{}});
  const pending=[];s.getSkills=()=>new Promise(resolve=>pending.push(resolve));
  panel._syncSkills();models.chat.setProperty('/currentSession/id','B');panel._syncSkills();
  pending[1]({supported:true,enabled:true,skills:[Skills.builtin[1]],selectedId:'CODE_EXPLAIN'});await Promise.resolve();
  pending[0]({supported:true,enabled:true,skills:[Skills.builtin[0]],selectedId:'CODE_PERFORMANCE'});await Promise.resolve();
  assert.equal(models.skill.getProperty('/selected/id'),'CODE_EXPLAIN');
  panel._syncSkills(true);panel._syncSkills(true);
  pending[3]({supported:true,enabled:true,skills:[Skills.builtin[2]],selectedId:'CODE_ENHANCEMENTS'});await Promise.resolve();
  pending[2]({supported:true,enabled:true,skills:[Skills.builtin[0]],selectedId:'CODE_PERFORMANCE'});await Promise.resolve();
  assert.equal(models.skill.getProperty('/selected/id'),'CODE_ENHANCEMENTS');
});
test('技能总开关（演示）：关时聊天拿不到技能、管理照常；只有管理员能开关（10.27 #03）', async () => {
  const s=loadUI(); s._sAppUser={userId:'A',role:'USER'};
  assert.equal(await s.getSkillEnabled(), true);                      // 演示没设过 = 开
  await assert.rejects(()=>s.setSkillEnabled(false), /管理员/);
  s._sAppUser.role='ADMIN';
  assert.equal(await s.setSkillEnabled(false), false);
  assert.equal(await s.getSkillEnabled(), false);                     // 关能存住（不是删键回到默认开）
  let r=await s.getSkills({scene:'CODE',sessionId:'S'});
  assert.equal(r.enabled,false); assert.equal(r.skills.length,0);
  r=await s.getSkills({includeInactive:true}); assert.equal(r.skills.length,8);
  s._mockSendAgent=async()=>({trace:[],answer:'演示',status:'OK'});
  await assert.rejects(()=>s.sendTask({scene:'CODE',sessionId:'S',taskId:'T',skillId:'CODE_EXPLAIN'}), /尚未启用/);
  await s.setSkillEnabled(true);
  r=await s.getSkills({scene:'CODE',sessionId:'S'}); assert.equal(r.enabled,true); assert.equal(r.skills.length,4);
});
test('技能胶囊选不了时仍可点：管理员直达技能管理，普通用户看到原因，能选时照常打开（10.27 #03）', async () => {
  const toasts=[];
  const s=loadUI({'zai/chat/utils/Toast':{show:t=>toasts.push(t)}}), Model=s._testLoad('sap/ui/model/json/JSONModel');
  const models={chat:new Model({currentSession:{id:'A'},currentTask:null,busy:false})};
  const view={getModel:name=>models[name],setModel:(m,name)=>{models[name]=m;}};
  let opened=0, managed=0, synced=0;
  const panel=Object.assign({},s._testLoad('zai/chat/controller/mixin/SkillPanel'),{
    getView:()=>view,byId:()=>null,_curScene:()=> 'CODE',_wsMode:()=> 'AGENT',_renderHeroBubbles:()=>{},
    _openSkills:()=>{opened++;},onOpenSkillManager:()=>{managed++;}});
  const ev={getSource:()=>({getId:()=> 'x--skillBtnDock'})};
  const m=panel._skillModel();
  m.setProperty('/supported',true); m.setProperty('/enabled',false); m.setProperty('/loading',false);
  s._sAppUser={userId:'A',role:'ADMIN'}; panel._paintSkill();
  assert.match(m.getProperty('/tooltip'), /技能管理/);
  panel.onOpenSkills(ev); assert.equal(managed,1); assert.equal(opened,0);
  s._sAppUser.role='USER'; panel._paintSkill();
  panel.onOpenSkills(ev); assert.equal(managed,1); assert.match(toasts.pop(), /联系管理员/);
  const sync=panel._syncSkills; panel._syncSkills=()=>{synced++;};
  m.setProperty('/error','离线'); panel._paintSkill(); panel.onOpenSkills(ev); assert.equal(synced,1);
  panel._syncSkills=sync; m.setProperty('/error','');
  m.setProperty('/enabled',true); panel._paintSkill(); assert.equal(m.getProperty('/canPick'),true);
  panel.onOpenSkills(ev); assert.equal(opened,1);
  models.chat.setProperty('/busy',true); m.setProperty('/enabled',false); panel._paintSkill();
  panel.onOpenSkills(ev); assert.equal(managed,1); assert.equal(opened,1);
});
