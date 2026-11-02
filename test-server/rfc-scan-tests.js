/**
 * RFC 函数执行：登记规则测试（功能计划书/RFC函数执行/01 §3）
 * 运行: node rfc-scan-tests.js   （或 npm run test:rfcscan）
 *
 * 跑本地参考实现 rfc-scan-ref.js，锁住 ABAP 版要遵守的规则：
 *   ZCL_AI_RFC_EXEC=>name_danger / scan_source（写入类检查）、
 *   ZCL_AI_RPT_SCANNER=>scan_function（接口 → 参数草稿）、ZCL_AI_RFC_EXEC=>default_result。
 * 源码样本：仓库里的 Z_AI_ODATA_GET（只读函数）、10.28 记录附件 ZRPP_IDP_0299（带 BAPI 提交），其余手写。
 */
const fs = require('fs');
const path = require('path');
const ref = require('./rfc-scan-ref');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
const codes = (hits, level) => hits.filter((h) => !level || h.level === level).map((h) => h.code);
const TRANSP = new Set(['ZAI_RPT_RUN', 'ZTSD_LOG', 'MARA', 'EKKO']);

console.log('\n━━ 函数名');
check('写入类词命中（CREATE / POST / UPDATE …）', ref.nameDanger('BAPI_PO_CREATE1') === 'CREATE' &&
  ref.nameDanger('BAPI_GOODSMVT_CREATE') === 'CREATE' && ref.nameDanger('Z_GET_LAST_UPDATE') === 'UPDATE');
check('只读名不误判（GETLIST / GETDETAIL / Z_AI_ODATA_GET）', !ref.nameDanger('BAPI_PO_GETDETAIL') &&
  !ref.nameDanger('BAPI_MATERIAL_GETLIST') && !ref.nameDanger('Z_AI_ODATA_GET'));

console.log('\n━━ 源码：提交 / 异步写入');
{
  const r = ref.checkWrites('Z_X', [
    'FUNCTION z_x.',
    '  SELECT * FROM mara INTO TABLE @DATA(lt) UP TO 10 ROWS.',
    '  CALL FUNCTION \'BAPI_TRANSACTION_COMMIT\' EXPORTING wait = \'X\'.',
    '  CALL FUNCTION \'Z_LOG\' IN UPDATE TASK EXPORTING iv = 1.',
    '  CALL FUNCTION \'Z_ASYNC\' STARTING NEW TASK \'T1\'.',
    '  CALL FUNCTION \'Z_TRFC\' IN BACKGROUND TASK.',
    '  COMMIT',
    '    WORK AND WAIT.',
    'ENDFUNCTION.'
  ], TRANSP);
  check('BAPI_TRANSACTION_COMMIT / UPDATE TASK / NEW TASK / BACKGROUND TASK / COMMIT WORK 全部 BLOCK',
    ['BAPICOMMIT', 'UPDTASK', 'NEWTASK', 'BGTASK', 'COMMIT'].every((c) => codes(r, 'BLOCK').indexOf(c) >= 0), JSON.stringify(codes(r)));
  const cw = r.filter((h) => h.code === 'COMMIT')[0] || {};
  check('跨行语句记在开始那一行（COMMIT 在第 7 行）', cw.line === 7, JSON.stringify(cw));
}

console.log('\n━━ 源码：注释和字面量不算');
{
  const r = ref.checkWrites('Z_X', [
    '* COMMIT WORK.  整行注释',
    '  lv_txt = \'COMMIT WORK\'. " 字面量里的不算',
    '  WRITE / `IN UPDATE TASK`.',
    '  lv_a = 1. " COMMIT WORK 行内注释',
    '  lv_q = \'他说"好"\'.  " 字面量里的双引号不是注释开头'
  ], TRANSP);
  check('注释、字面量里的关键字都不命中', codes(r, 'BLOCK').length === 0, JSON.stringify(r));
  const sc = ref.stripComment('  lv_q = \'他说"好"\'.  " 注释');
  check('字面量里的 " 不当注释开头；清空版只剩引号', sc.code.trim() === 'lv_q = \'他说"好"\'.' && sc.nolit.trim() === "lv_q = ''.", JSON.stringify(sc));
}

console.log('\n━━ 源码：写库只认透明表');
{
  const r = ref.checkWrites('Z_X', [
    '  UPDATE ztsd_log SET status = \'X\' WHERE id = @lv_id.',
    '  INSERT INTO ekko VALUES @ls_ekko.',
    '  MODIFY mara FROM @ls_mara.',
    '  DELETE FROM zai_rpt_run WHERE report_run_id = @lv_id.',
    '  INSERT ls_row INTO TABLE lt_rows.',
    '  MODIFY lt_rows FROM ls_row INDEX 1.',
    '  DELETE lt_rows WHERE matnr IS INITIAL.',
    '  DELETE ADJACENT DUPLICATES FROM lt_rows.',
    '  INSERT LINES OF lt_a INTO TABLE lt_b.',
    '  MODIFY TABLE lt_rows FROM ls_row.',
    '  UPDATE (lv_tab) SET x = 1.',
    '  ls_mara-matnr = \'1\'.'
  ], TRANSP);
  const db = r.filter((h) => h.code === 'DBWRITE').map((h) => h.text);
  check('UPDATE / INSERT INTO / MODIFY / DELETE FROM 透明表 → 4 条 BLOCK', db.length === 4 &&
    ['ZTSD_LOG', 'EKKO', 'MARA', 'ZAI_RPT_RUN'].every((t) => db.some((x) => x.indexOf(t) >= 0)), JSON.stringify(db));
  check('内表操作（INTO TABLE / MODIFY lt / DELETE lt / ADJACENT / LINES OF / MODIFY TABLE）不命中',
    !r.some((h) => /LT_|LS_/.test(h.text)));
  check('动态表名写库 → BLOCK DYNWRITE', codes(r, 'BLOCK').indexOf('DYNWRITE') >= 0);
}

console.log('\n━━ 源码：链式与跳出类');
{
  const r = ref.checkWrites('Z_X', [
    '  UPDATE: ztsd_log FROM ls_a, mara FROM ls_b.',
    '  SUBMIT zreport AND RETURN.',
    '  CALL TRANSACTION \'VA03\'.',
    '  CALL FUNCTION \'POPUP_TO_CONFIRM\'.'
  ], TRANSP);
  check('链式 UPDATE: 取第一个目标', r.some((h) => h.code === 'DBWRITE' && h.text.indexOf('ZTSD_LOG') >= 0));
  check('SUBMIT / CALL TRANSACTION / POPUP_ 只是 WARN', ['SUBMIT', 'CALLUI', 'POPUP'].every((c) => codes(r, 'WARN').indexOf(c) >= 0) &&
    codes(r, 'BLOCK').indexOf('SUBMIT') < 0);
}

console.log('\n━━ 真实源码');
{
  const fodata = path.join(__dirname, '../backend-abap/Z_AI_ODATA_GET.abap');
  const src = fs.readFileSync(fodata, 'utf8').split(/\r?\n/);
  const r = ref.checkWrites('Z_AI_ODATA_GET', src, TRANSP);
  check('Z_AI_ODATA_GET（只读函数）没有 BLOCK、名字不疑似', codes(r, 'BLOCK').length === 0 && codes(r, 'NAME').length === 0, JSON.stringify(r));
  const f0299 = path.join(__dirname, '../功能计划书/项目进度/10.28进度/交付_20261028_记录汇总/原始附件/源码_ZRPP_IDP_0299.txt');
  if (fs.existsSync(f0299)) {
    const r2 = ref.checkWrites('Z_X', fs.readFileSync(f0299, 'utf8').split(/\r?\n/), TRANSP);
    check('ZRPP_IDP_0299（调 BAPI 并提交）→ BAPICOMMIT', codes(r2, 'BLOCK').indexOf('BAPICOMMIT') >= 0);
  } else {
    console.log('  (跳过 ZRPP_IDP_0299：附件不在)');
  }
}

console.log('\n━━ 接口 → 参数草稿');
{
  const P = (o) => Object.assign({ optional: false, defval: '', text: '', label: '', data_type: 'CHAR', type_length: 10 }, o);
  const params = [
    P({ name: 'IV_WERKS', kind: 'I', shape: 'SCALAR', type_length: 4, text: '工厂', label: '工厂' }),
    P({ name: 'IV_DATE', kind: 'I', shape: 'SCALAR', data_type: 'DATE', type_length: 8, optional: true, defval: 'SY-DATUM', label: '日期' }),
    P({ name: 'IV_MAX', kind: 'I', shape: 'SCALAR', data_type: 'NUM', optional: true, defval: '100', label: 'IV_MAX' }),
    P({ name: 'IV_OPEN', kind: 'I', shape: 'FLAG', optional: true, defval: "'X'", label: '只看未清' }),
    P({ name: 'IS_HEAD', kind: 'I', shape: 'STRUCT', optional: true }),
    P({ name: 'IT_MATNR', kind: 'T', shape: 'RANGE', optional: true, label: '物料' }),
    P({ name: 'IT_BUDAT', kind: 'I', shape: 'RANGE', data_type: 'DATE', optional: true, label: '过账日期' }),
    P({ name: 'ET_DATA', kind: 'T', shape: 'TABLE', optional: true }),
    P({ name: 'RETURN', kind: 'T', shape: 'TABLE', optional: true }),
    P({ name: 'EV_COUNT', kind: 'E', shape: 'SCALAR' }),
    P({ name: 'NOT_FOUND', kind: 'X', shape: 'EXC' })
  ];
  const d = ref.draftParams(params);
  const row = (id) => d.rows.filter((r) => r.param_id === id)[0] || {};
  check('单值 → P；必填按 OPTIONAL；标签来源 FUNCT', row('IV_WERKS').sel_kind === 'P' && row('IV_WERKS').required && row('IV_WERKS').label_src === 'FUNCT');
  check('默认 SY-DATUM → TODAY；数字 → STATIC', row('IV_DATE').default_type === 'TODAY' && !row('IV_DATE').required &&
    row('IV_MAX').default_type === 'STATIC' && row('IV_MAX').default_value === '100');
  check("标记 → C 复选框，默认 'X' → allowed_ops X", row('IV_OPEN').sel_kind === 'C' && row('IV_OPEN').data_type === 'BOOL' && row('IV_OPEN').allowed_ops === 'X');
  check('范围表 → S：日期 = 范围，其余 = 多值；TABLES 范围也认', row('IT_MATNR').sel_kind === 'S' && row('IT_MATNR').multi_value &&
    row('IT_BUDAT').range_allowed && !row('IT_BUDAT').multi_value);
  check('选填结构不登记并写原因；输出表 / RETURN / EXPORTING / 例外不进参数卡', row('IS_HEAD').include === false && row('IS_HEAD').note &&
    !d.rows.some((r) => ['ET_DATA', 'RETURN', 'EV_COUNT', 'NOT_FOUND'].indexOf(r.param_id) >= 0));
  check('没有错误；排序号按登记行递增', d.error === '' && row('IV_WERKS').sort_no === 10 && row('IT_BUDAT').sort_no === 60, JSON.stringify(d.rows.map((r) => [r.param_id, r.sort_no])));
  check('主结果默认取第一个非 RETURN 的表', ref.defaultResult(params) === 'ET_DATA');

  const d2 = ref.draftParams([P({ name: 'IS_KEY', kind: 'I', shape: 'STRUCT' })]);
  check('必填结构 → 不能登记', d2.error.indexOf('IS_KEY') >= 0);
  const d3 = ref.draftParams([P({ name: 'ET_DATA', kind: 'T', shape: 'TABLE', optional: true })]);
  check('没有输入参数 → 一期不能登记（参数卡至少要一项）', d3.error.indexOf('没有可填的输入参数') >= 0);
  check('SY-DATUM - 1 → TODAY -1；空字面量不认', ref.parseFmDefault('SY-DATUM - 1').value === '-1' && ref.parseFmDefault("''") === null &&
    ref.parseFmDefault('SY-DATUM').value === '0');
  check('只有 RETURN 一张表 → 没有默认主结果', ref.defaultResult([P({ name: 'RETURN', kind: 'T', shape: 'TABLE' })]) === '');
}

console.log(`\n━━ 结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
