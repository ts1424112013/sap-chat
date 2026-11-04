/**
 * ABAP 源码静态检查（无 SAP、无网络）—— 部署前把"在 SAP 上才会炸"的低级错误拦在本地
 * 运行: node abap-static-tests.js   （或 npm run test:abap）
 *
 * 覆盖：
 *   1) ZAI_CHAT_CFG 配置键 ≤ 20 字符（CFGKEY 是 CHAR 20；超长键 OPEN SQL 直接抛
 *      CX_SY_OPEN_SQL_DATA_ERROR → 网关 500。10-22 部署实锤：REPORT_CAPTURE_LEGACY 21 字符）
 *   2) Fiori 取数通道（ZCL_AI_ODATA_CLIENT V1.3 + Z_AI_ODATA_GET）：默认走 RFC 新会话、
 *      不再有 URL 通道、现场 DPC 捕获块调用的两个空壳方法还在、函数模块接口与调用一致
 *   3) 权限自助申请（ZCL_AI_AUTH_SERVICE V1.6，20261102）：读写目标表 / 规则映射表只在约定的方法里；USER_ADDR 只在 fill_user_info；
 *      DPC 每个权限 FI 读的参数 = 前端恒发的参数清单（SAP 上 FI 参数全必填）
 *   4) 报表选择项（10.24 记录 #03a）：REPORT_SERVICE V1.0.13 整理 R / C / F、EXEC_SAP V1.1b 组装选择屏
 *   5) 报表自动登记（10.24 记录 #03b）：ZCL_AI_RPT_SCANNER / ZAI_RPT_REG 只在约定处写表；全库行长 ≤ 255
 *   6) 10.27 记录：SCANNER V1.0a 修复补回；EXEC_SAP V1.1c 作业语言 RPT_JOB_LANGU + 作业中止原因落表
 *   8) 10.28 边跑边看：ZCL_AI_AGENT_PROGRESS 只用独立连接写进度表、不碰主事务、写失败只关进度；
 *      AGENT_SERVICE V15.6 的挂点数量与位置；DPC V15.9 的 AgentProgress 分支与前端参数名一致
 *  10) Agent闭环增强/02 第 0 步：LLM_CLIENT V1.5 取用量、AGENT_SERVICE V15.8 用量只写审计
 *      （TOOL_ID = LLM_CALL）、DATA_ANALYSIS V13.4 数据集行数写在明细前面并按整行回填
 *  11) 10.28 #02：SQL_EXECUTOR V1.3 长 SQL 安全断行、SQL_GUARD V1.2.3 写法提示、DDIC_TOOLS V1.3 前导零、
 *      DOMAIN_CARDS V1.4 与技能「生产工单进度」
 *  12) 20261029 思考模式：LLM_CLIENT V1.6 按写法拼 chat_template_kwargs / think、思考与正文分开；
 *      思考只随出参（DPC wrap_think），不落库、不进上下文；Agent 每轮思考挂到进度步骤
 *  15) 20261102 RFC 函数执行：ZCL_AI_RFC_EXEC 调用后立刻 ROLLBACK、不写登记表、S_RFC 两种口径；
 *      EXEC_SAP V1.2 按 REPORT_KIND 分支；SCANNER V1.1 / ZAI_RPT_REG V1.1 函数登记；CODE_PROVIDER V1.1 认函数；
 *      写入类检查的词表与 JS 参考实现 rfc-scan-ref.js 一致
 * 只能查文本层面的约定，语法与运行时仍以 SAP 激活与现场验证为准。
 */
const fs = require('fs');
const path = require('path');

const ABAP = path.join(__dirname, '../backend-abap');
let pass = 0;
let fail = 0;
function check(name, ok, info) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  —— ' + info : '')); }
}
function listAbap(dir) {
  let out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { out = out.concat(listAbap(p)); }
    else if (d.name.endsWith('.abap')) { out.push(p); }
  });
  return out;
}
/** 去掉整行注释（* 开头）与行内注释（" 之后），避免把文件头说明里的旧键名当成代码 */
function codeOnly(src) {
  return src.split(/\r?\n/).map((l) => {
    if (/^\*/.test(l)) { return ''; }
    let inStr = null;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (inStr) { if (c === inStr) { inStr = null; } continue; }
      if (c === "'" || c === '`' || c === '|') { inStr = c; continue; }
      if (c === '"') { return l.slice(0, i); }
    }
    return l;
  }).join('\n');
}
const read = (f) => fs.readFileSync(path.join(ABAP, f), 'utf8');

// ---------------------------------------------------------------- 1) 配置键长度
console.log('\n[1] ZAI_CHAT_CFG 配置键 ≤ 20 字符');
const KEY_PATTERNS = [
  // read_cfg_str( 'K' ) / is_cfg_on( 'K' ) / cfg_int( iv_key = 'K' ... ) / read_cfg_int( iv_key = 'K' ...
  /\b[a-z0-9_]*cfg[a-z0-9_]*\(\s*(?:iv_key\s*=\s*)?'([A-Za-z0-9_]+)'/gi,
  // WHERE cfgkey = 'K' / cfgkey = 'K'（VALUE #( ... )）
  /\bcfgkey\s*=\s*'([A-Za-z0-9_]+)'/gi,
  // 按场景拼的键：WHEN ... THEN 'AGENT_MODELS_xxx'
  /THEN\s+'(AGENT_MODELS[A-Za-z0-9_]*)'/g
];
const seen = {};
listAbap(ABAP).forEach((file) => {
  const src = codeOnly(fs.readFileSync(file, 'utf8'));
  KEY_PATTERNS.forEach((re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const k = m[1].toUpperCase();
      (seen[k] = seen[k] || new Set()).add(path.relative(ABAP, file));
    }
  });
});
const keys = Object.keys(seen).sort();
check('扫到配置键（≥ 20 个，扫描规则没失效）', keys.length >= 20, '只扫到 ' + keys.length + ' 个');
const tooLong = keys.filter((k) => k.length > 20);
check('没有超过 20 字符的键', tooLong.length === 0,
  tooLong.map((k) => k + '(' + k.length + ', ' + Array.from(seen[k]).join('/') + ')').join('; '));
check('报表执行回退键是 RPT_CAPTURE_LEGACY', !!seen.RPT_CAPTURE_LEGACY && !seen.REPORT_CAPTURE_LEGACY);

// ---------------------------------------------------------------- 2) Fiori 取数通道
console.log('\n[2] Fiori 取数通道（ZCL_AI_ODATA_CLIENT V1.3 / Z_AI_ODATA_GET）');
const cliRaw = read('ZCL_AI_ODATA_CLIENT.abap');
const cli = codeOnly(cliRaw);
const fmRaw = read('Z_AI_ODATA_GET.abap');
const fm = codeOnly(fmRaw);

check('客户端版本头有 V1.3', /^\* V1\.3\s/m.test(cliRaw));
check('默认通道 = RFC 新会话（DESTINATION \'NONE\'）', /CALL FUNCTION\s+lv_fm\s+DESTINATION\s+'NONE'/i.test(cli));
check('函数模块名是动态调用（类可先于函数模块激活）', /gc_rfc_fm\s+TYPE\s+rs38l_fnam\s+VALUE\s+'Z_AI_ODATA_GET'/i.test(cli)
  && !/CALL FUNCTION\s+'Z_AI_ODATA_GET'/i.test(cli));
check('函数模块未部署时先查 TFDIR 给提示（不 dump）', /FROM\s+tfdir/i.test(cli));
check('用完关闭 RFC 连接', /RFC_CONNECTION_CLOSE/.test(cli));
check('SM59 通道保留（create_by_destination）', /create_by_destination/i.test(cli));
check('没有 URL 通道（create_by_url / FIORI_SELF_URL）', !/create_by_url/i.test(cli) && !/FIORI_SELF_URL/i.test(cli));
check('不弹登录框', /propertytype_logon_popup\s*=\s*if_http_client=>co_disabled/i.test(cli));
check('现场 DPC 捕获块用到的两个方法仍在（空壳）',
  /CLASS-METHODS set_authorization\s+IMPORTING iv_authorization TYPE string/i.test(cli)
  && /CLASS-METHODS set_hdr_names\s+IMPORTING iv_names\s+TYPE string/i.test(cli));
check('空壳不保存凭据（类里没有 gv_authorization）', !/gv_authorization/i.test(cli));
check('get 有可选参数 iv_channel', /iv_channel\s+TYPE string OPTIONAL/i.test(cli));

// 函数模块接口（注释块）与 via_rfc 的调用参数一一对应
const iface = (fmRaw.match(/\*"\s+VALUE\((\w+)\)/g) || []).map((s) => s.replace(/.*VALUE\((\w+)\).*/, '$1').toUpperCase());
const viaRfc = (cli.match(/METHOD via_rfc\.[\s\S]*?ENDMETHOD\./i) || [''])[0];
const callArgs = ((viaRfc.match(/EXPORTING([\s\S]*?)EXCEPTIONS/i) || ['', ''])[1].match(/\b([ie]v_\w+)\s*=/gi) || [])
  .map((s) => s.replace(/\s*=$/, '').toUpperCase());
check('函数模块接口 8 个参数', iface.length === 8, iface.join(','));
check('via_rfc 传的参数都在函数模块接口里', callArgs.length === 8 && callArgs.every((a) => iface.indexOf(a) >= 0),
  'call=' + callArgs.join(',') + ' iface=' + iface.join(','));
check('函数模块全部值传递（RFC 要求）', (fmRaw.match(/\*"\s+(?!VALUE\()\w+\s+TYPE/g) || []).length === 0);
check('函数模块调 http_get 且不传 iv_dest（= create_internal）',
  /zcl_ai_odata_client=>http_get\(/i.test(fm) && !/iv_dest/i.test(fm));

// 调用方：业务代码都走 get（不直接调 http_get）
['ZCL_AI_FIORI_REPORT_SERVICE.abap', 'ZAI_FRPT_MAINT.abap'].forEach((f) => {
  const s = codeOnly(read(f));
  check(f + ' 走 get、不直接调 http_get', /zcl_ai_odata_client=>get\(/i.test(s) && !/zcl_ai_odata_client=>http_get/i.test(s));
});
const t = codeOnly(read('tests/ZAI_TEST_ODATA_INTERNAL.abap'));
check('G0 测试程序可指定通道（P_CHAN → iv_channel）', /p_chan\s+TYPE c LENGTH 32/i.test(t) && /iv_channel\s*=\s*condense\(\s*p_chan\s*\)/i.test(t));

// ---------------------------------------------------------------- 3) 权限自助申请（ZCL_AI_AUTH_SERVICE V1.2）
console.log('\n[3] 权限自助申请：DPC / 服务类 / 前端参数一致，规则字段映射（V1.2）');
const authRaw = read('ZCL_AI_AUTH_SERVICE.abap');
const auth = codeOnly(authRaw);
const dpc = codeOnly(read('ZCL_ZAI_CHAT_DPC_EXT.abap'));
const chatSvc = fs.readFileSync(path.join(__dirname, '../webapp/service/ChatService.js'), 'utf8');
/** 类实现里每个方法的正文：{ 方法名(小写): 代码 } */
const methods = {};
(auth.match(/^\s*METHOD\s+\w+\.[\s\S]*?^\s*ENDMETHOD\./gim) || []).forEach((m) => {
  methods[m.match(/METHOD\s+(\w+)\./i)[1].toLowerCase()] = m;
});
const inMethods = (re) => Object.keys(methods).filter((k) => re.test(methods[k])).sort();

check('服务类版本头有 V1.2', /^\* V1\.2 20261023/m.test(authRaw));
check('save_rule 有可选参数 iv_fmap_json（DPC 可先于 / 后于类重贴）', /CLASS-METHODS save_rule[\s\S]*?iv_fmap_json\s+TYPE string OPTIONAL[\s\S]*?RETURNING/i.test(auth));
check('写目标表只在 grant_row（INSERT ( ）', inMethods(/INSERT\s+\(/i).join() === 'grant_row', inMethods(/INSERT\s+\(/i).join());
check('删目标表只在 revoke_row（DELETE FROM ( ）', inMethods(/DELETE FROM\s+\(/i).join() === 'revoke_row', inMethods(/DELETE FROM\s+\(/i).join());
check('ZAI_AUTH_RMAP 只在 save_rule / apply_rule_map / get_config', inMethods(/zai_auth_rmap/i).join() === 'apply_rule_map,get_config,save_rule', inMethods(/zai_auth_rmap/i).join());
check('映射校验共用 check_fmap（save_table 与 save_rule 都调）', inMethods(/\bcheck_fmap\(/i).join() === 'save_rule,save_table', inMethods(/\bcheck_fmap\(/i).join());
check('规则映射在申请（find_tables）与审批（decide）两处套用', inMethods(/\bapply_rule_map\(/i).join() === 'decide,find_tables', inMethods(/\bapply_rule_map\(/i).join());
check('decide 按当前规则重选映射（find_rule 后比对目标表）', /find_rule\([\s\S]*?IF ls_rule-tabname = ls_tab-tabname/i.test(methods.decide || ''));
check('删除规则时一并删映射', /iv_delete = 'X'[\s\S]*?DELETE FROM zai_auth_rule[\s\S]*?DELETE FROM zai_auth_rmap[\s\S]*?RETURN\./i.test(methods.save_rule || ''));
check('规则不指定权限表时拒绝单独映射', /lv_json IS NOT INITIAL[\s\S]*?lv_tab IS INITIAL/i.test(methods.save_rule || ''));
// V1.3 20261024（10.24 记录 #00a）：审批卡显示申请人姓名 / 部门
check('服务类版本头有 V1.3', /^\* V1\.3 20261024/m.test(authRaw));
check('申请记录 ty_request 有 target_name / target_dept（DPC camelCase → targetName / targetDept）', /BEGIN OF ty_request,[\s\S]*?target_name\s+TYPE string,[\s\S]*?target_dept\s+TYPE string,[\s\S]*?END OF ty_request/i.test(auth));
check('USER_ADDR 只在 fill_user_info 里读', inMethods(/\buser_addr\b/i).join() === 'fill_user_info', inMethods(/\buser_addr\b/i).join());
check('list_requests 末尾调 fill_user_info', /fill_user_info\(\s*CHANGING ct_requests = rs-requests\s*\)[\s\S]*?ENDMETHOD\./i.test(methods.list_requests || ''));
check('fill_user_info 字段列表动态 + 捕获动态 SQL 异常（字段名不符只是查不到，不影响激活）', /SELECT \(lv_cols\) FROM user_addr/i.test(methods.fill_user_info || '') && /CATCH cx_sy_dynamic_osql_error/i.test(methods.fill_user_info || ''));
check('fill_user_info 只读（没有 INSERT / UPDATE / MODIFY / DELETE）', !/\b(INSERT|UPDATE|MODIFY|DELETE)\b/i.test(methods.fill_user_info || ''));
// V1.5 20261027（10.27 记录 #02）：递增序号 SEQ / 规则组合 RULE
check('服务类版本头有 V1.5', /^\* V1\.5 20261027/m.test(authRaw));
check('check_fmap 认 SEQ / RULE，并调 check_rule 校验参数', /'RANDOM' OR 'SEQ' OR 'RULE'/.test(methods.check_fmap || '') && /check_rule\( is_field = ls_f iv_type = ls_in-t iv_c = ls_in-c \)/.test(methods.check_fmap || ''));
check('SEQ / RULE 的参数存进 CONST_VAL（其他类型清空）', /WHEN ls_in-t = 'CONST' OR ls_in-t = 'SEQ' THEN lv_const[\s\S]*?WHEN ls_in-t = 'RULE' THEN lv_rule/.test(methods.check_fmap || ''));
check('build_row 的 SEQ / RULE 走 gen_value（逐行现算）', /WHEN 'SEQ' OR 'RULE'\.[\s\S]*?gen_value\(/.test(methods.build_row || ''));
check('读目标表取序号只在 seq_max（动态 SELECT ( 只读，没有写）', inMethods(/SELECT\s+\(\s*iv_fieldname\s*\)\s+FROM\s+\(/i).join() === 'seq_max' && !/\b(INSERT|UPDATE|MODIFY|DELETE)\b/i.test(methods.seq_max || ''),
  inMethods(/SELECT\s+\(\s*iv_fieldname\s*\)\s+FROM\s+\(/i).join());
check('seq_max 名字过 safe_name、LIKE 值走 quote + ESCAPE #，异常捕获', /safe_name\( iv_tabname \)[\s\S]*?safe_name\( iv_fieldname \)/.test(methods.seq_max || '') &&
  /LIKE \{ quote\( iv_like \) \} ESCAPE '#'/.test(methods.seq_max || '') && /CATCH cx_root/.test(methods.seq_max || ''));
check('like_escape 先转 # 再转 _ %', /`#` IN rv WITH `##`[\s\S]*?`_` IN rv WITH `#_`[\s\S]*?`%` IN rv WITH `#%`/.test(methods.like_escape || ''));
check('gen_value：序号不小于起始值、到位数上限报错、左补零', /lv_max \+ 1 > lv_next/.test(methods.gen_value || '') && /lv_next >= lv_limit/.test(methods.gen_value || '') && /lv_seq = `0` && lv_seq/.test(methods.gen_value || ''));
check('parse_rule：一条规则最多一个 SEQn、占位白名单', /lv_seqs > 1/.test(methods.parse_rule || '') && /'\^\(SEQ\|RAND\|NUM\)/.test(methods.parse_rule || ''));
check('grant_row：生成值作主键碰撞报错（随机 / 序号 / 含 SEQ RAND NUM TIME 的规则），其余仍是 EXISTS', /map_type = 'RANDOM' OR ls_f-map_type = 'SEQ'[\s\S]*?CS '\{SEQ'[\s\S]*?CS '\{TIME'[\s\S]*?ev_status = 'EXISTS'/.test(methods.grant_row || ''));
check('string 模板里没有未转义的花括号文字（{ 必须是占位）', !/\|[^|\n]*[^\\]\{[A-Z]/.test(auth));
// V1.6 20261102：固定值可选值（域固定值 + 表里已用过的值）+ 字段说明 + 备注
check('服务类版本头有 V1.6', /^\* V1\.6 20261102/m.test(authRaw));
check('ty_field 有 note / ddtext / opts（tt_opt: val / txt / cnt）', /BEGIN OF ty_opt,\s*val\s+TYPE string,\s*txt\s+TYPE string,\s*cnt\s+TYPE i,/i.test(auth) &&
  /BEGIN OF ty_field,[\s\S]*?note\s+TYPE string,[\s\S]*?ddtext\s+TYPE string,[\s\S]*?opts\s+TYPE tt_opt,[\s\S]*?END OF ty_field/i.test(auth));
check('FmapJson 每行认 n（备注）', /BEGIN OF ty_fmap_in,[\s\S]*?n TYPE string,[\s\S]*?END OF ty_fmap_in/i.test(auth));
check('动态 GROUP BY 读目标表只在 fill_hints，且只读、名字过 safe_name、异常捕获',
  inMethods(/GROUP BY\s+\(/i).join() === 'fill_hints' && !/\b(INSERT|UPDATE|MODIFY|DELETE)\b/i.test(methods.fill_hints || '') &&
  /safe_name\( iv_tabname \)/.test(methods.fill_hints || '') && /safe_name\( <ls_f>-fieldname \)/.test(methods.fill_hints || '') && /CATCH cx_root/.test(methods.fill_hints || ''),
  inMethods(/GROUP BY\s+\(/i).join());
check('fill_hints 只在 describe_table 调（配置页 / 申请不多查）', inMethods(/\bfill_hints\(/i).join() === 'describe_table', inMethods(/\bfill_hints\(/i).join());
check('不同值超过 200 个不列（账号列之类）', /lines\( lt_grp \) > 200/.test(methods.fill_hints || '') && /UP TO 201 ROWS/.test(methods.fill_hints || ''));
check('备注只在 CONST 时保存，最长 80', /lv_note = condense\( ls_in-n \)[\s\S]*?strlen\( lv_note \) > 80[\s\S]*?ELSE\.\s*CLEAR lv_note\./.test(methods.check_fmap || ''));
check('save_table / save_rule 写入 note', /note\s+= ls_m-note \) TO lt_save/.test(methods.save_table || '') && /note\s+= ls_m-note \) TO lt_rmap/.test(methods.save_rule || ''));
check('回读备注：fields_with_map（权限表）与 get_config（规则映射）', /<ls_f>-note\s+= ls_m-note/.test(methods.fields_with_map || '') && /<ls_rf>-note\s+= ls_rm-note/.test(methods.get_config || ''));

// DPC 每个权限 FI 读的参数名 == 前端 _authCall 恒发的参数清单（SAP 上 FI 参数全必填，多一个少一个都会 404）
const dpcParams = {};
(dpc.match(/WHEN 'AUTH\w+'\.[\s\S]*?(?=WHEN '|ENDCASE)/g) || []).forEach((blk) => {
  const fi = blk.match(/WHEN '(AUTH\w+)'/)[1];
  dpcParams[fi] = (blk.match(/iv_name\s*=\s*'(\w+)'/g) || []).map((x) => x.replace(/.*'(\w+)'/, '$1'));
});
const feBlock = (chatSvc.match(/var mAuthParams = \{([\s\S]*?)\};/) || ['', ''])[1];
const feParams = {};
(feBlock.match(/(Auth\w+):\s*\[([^\]]*)\]/g) || []).forEach((line) => {
  const m = line.match(/(Auth\w+):\s*\[([^\]]*)\]/);
  feParams[m[1].toUpperCase()] = (m[2].match(/"(\w+)"/g) || []).map((x) => x.replace(/"/g, ''));
});
check('前端参数清单有 8 个带参数的权限 FI', Object.keys(feParams).length === 8, Object.keys(feParams).join(','));
Object.keys(feParams).forEach((fi) => {
  const a = (dpcParams[fi] || []).slice().sort().join(','), b = feParams[fi].slice().sort().join(',');
  check(fi + ' 的参数：DPC 读的 = 前端发的', a === b, 'DPC=' + a + ' 前端=' + b);
});
check('AUTHRULESAVE 把 FmapJson 传给 iv_fmap_json', /iv_fmap_json\s*=\s*v8_param\(\s*it_parameter\s*=\s*it_parameter\s+iv_name\s*=\s*'FmapJson'\s*\)/i.test(
  (dpc.match(/WHEN 'AUTHRULESAVE'\.[\s\S]*?WHEN '/) || [''])[0]));

// ---------------------------------------------------------------- 4) 报表选择项（10.24 记录 #03a）
console.log('\n[4] 报表选择项：单选组 R / 复选框 C / 固定值 F（REPORT_SERVICE V1.0.13 · EXEC_SAP V1.1b）');
const rsRaw = read('ZCL_AI_REPORT_SERVICE.abap');
const rs = codeOnly(rsRaw);
const exRaw = read('ZCL_AI_REPORT_EXEC_SAP.abap');
const ex = codeOnly(exRaw);
const methodOf = (src, name) => (src.match(new RegExp('^\\s*METHOD\\s+' + name + '\\.[\\s\\S]*?^\\s*ENDMETHOD\\.', 'im')) || [''])[0];
const getParams = methodOf(rs, 'get_params');
const validate = methodOf(rs, 'validate_params');
const parseOpt = methodOf(rs, 'parse_options');
const seltab = methodOf(ex, 'build_seltab');
check('REPORT_SERVICE 版本头有 V1.0.13', /^\* V1\.0\.13 20261024/m.test(rsRaw));
check('EXEC_SAP 版本头有 V1.1b', /^\* V1\.1b\s+20261024/m.test(exRaw));
check('ty_param 有 sel_kind / enum_json', /BEGIN OF ty_param,[\s\S]*?sel_kind\s+TYPE string,[\s\S]*?enum_json\s+TYPE string,[\s\S]*?END OF ty_param/i.test(rs));
check('选项结构不用 key 当组件名（rt[ key = … ] 会被当成二级键语法）', /BEGIN OF ty_opt,\s*name\s+TYPE string,/i.test(rs) && !/\[\s*key\s*=/i.test(rs + ex));
check('get_params 的 SELECT 清单含 sel_kind（逗号分隔）', /validation_rule, help_text, sort_no, active, sel_kind\s+FROM zai_rpt_param/i.test(getParams));
check('get_params：F 不返回（WHEN \'F\' → CONTINUE）', /WHEN 'F'\.\s*CONTINUE\./i.test(getParams));
check('get_params：R 整理成 ENUM（validation_rule = 选项键、enum_json、默认项 → STATIC）', /WHEN 'R'\.[\s\S]*?parse_options\([\s\S]*?default_type\s*=\s*'STATIC'[\s\S]*?data_type\s*=\s*'ENUM'[\s\S]*?validation_rule\s*=\s*lv_keys/i.test(getParams));
check('get_params：C 整理成 BOOL 并清掉 default_type（校验不套默认）', /WHEN 'C'\.[\s\S]*?data_type\s*=\s*'BOOL'[\s\S]*?CLEAR ls_np-default_type\./i.test(getParams));
check('parse_options：键限 A-Z 0-9 _ 且 ≤ 8 位、去重、只认第一个默认项', /strlen\( lv_key \) > 8/.test(parseOpt) && /CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'/.test(parseOpt) && /line_exists\( rt\[ name = lv_key \] \)/.test(parseOpt) && /lv_hasd/.test(parseOpt));
check('validate_params：复选框在默认值处理之前单独处理（空 = 不勾，记进快照）', validate.indexOf("IF ls_p-sel_kind = 'C'.") > 0 && validate.indexOf("IF ls_p-sel_kind = 'C'.") < validate.indexOf('CASE to_upper( ls_p-default_type )'));
check('validate_params：单选组值统一大写再校验', /IF ls_p-sel_kind = 'R'\.\s*lv_val = to_upper\( condense\( lv_val \) \)\./i.test(validate));
check('build_seltab 的 SELECT 含 allowed_ops', /SELECT param_id, abap_name, sel_kind, multi_value, range_allowed, allowed_ops\s+FROM zai_rpt_param/i.test(seltab));
check('build_seltab：F 在读用户参数之前下发登记值', seltab.indexOf("IF lv_kind = 'F'.") > 0 && seltab.indexOf("IF lv_kind = 'F'.") < seltab.indexOf('READ TABLE lt_kv'));
check('build_seltab：C 找到就下发 X / 空格（取消勾选也下发）', /IF lv_kind = 'C'\.\s*IF lv_found = abap_true\.[\s\S]*?WHEN to_upper\( ls_kv-value \) = 'X' THEN 'X' ELSE space/i.test(seltab));
check('build_seltab：R 用 parse_options 展开全组，值不在选项里报错不提交', /IF lv_kind = 'R'\.[\s\S]*?zcl_ai_report_service=>parse_options\([\s\S]*?IF NOT line_exists\( lt_opt\[ name = lv_val \] \)\.\s*ev_err[\s\S]*?RETURN\.[\s\S]*?LOOP AT lt_opt/i.test(seltab));
check('parse_options 是公开方法（EXEC_SAP 要调）', /PUBLIC SECTION\.[\s\S]*?CLASS-METHODS parse_options[\s\S]*?PRIVATE SECTION\./i.test(rs));
// 通用：语句结束符写成分号（这次写代码时出过一次 ENDIF;）
const semi = [];
listAbap(ABAP).forEach((file) => {
  codeOnly(fs.readFileSync(file, 'utf8')).split('\n').forEach((l, i) => {
    if (/^\s*(ENDIF|ENDLOOP|ENDCASE|ENDTRY|ENDMETHOD|ENDWHILE|ENDDO|CONTINUE|RETURN|EXIT|ELSE)\s*;/i.test(l)) { semi.push(path.basename(file) + ':' + (i + 1)); }
  });
});
check('没有把语句结束符写成分号（ENDIF; 之类）', semi.length === 0, semi.join(', '));

// ---------------------------------------------------------------- 5) 报表自动登记（10.24 记录 #03b）
console.log('\n[5] 报表自动登记：ZCL_AI_RPT_SCANNER V1.0 / ZAI_RPT_REG V1.0 / REPORT_SERVICE V1.0.14');
const scRaw = read('ZCL_AI_RPT_SCANNER.abap');
const sc = codeOnly(scRaw);
const regRaw = read('ZAI_RPT_REG.abap');
const reg = codeOnly(regRaw);
const scMethods = {};
(sc.match(/^\s*METHOD\s+\w+\.[\s\S]*?^\s*ENDMETHOD\./gim) || []).forEach((m) => { scMethods[m.match(/METHOD\s+(\w+)\./i)[1].toLowerCase()] = m; });
const scIn = (re) => Object.keys(scMethods).filter((k) => re.test(scMethods[k])).sort();
check('扫描类版本头 V1.0、有 scan / save / class_constructor', /^\* V1\.0\s+20261024/m.test(scRaw) && !!scMethods.scan && !!scMethods.save && !!scMethods.class_constructor);
check('写登记表（INSERT / UPDATE zai_rpt_*）只在 save', scIn(/\b(INSERT|UPDATE|MODIFY|DELETE)\s+(FROM\s+)?zai_rpt_/i).join() === 'save', scIn(/\b(INSERT|UPDATE|MODIFY|DELETE)\s+(FROM\s+)?zai_rpt_/i).join());
check('save 先校验 ADMIN、事务码不被别的报表占用、出错 ROLLBACK', /v8_get_role\( \) <> 'ADMIN'/.test(scMethods.save || '') && /tcode = @lv_tc AND report_id <> @lv_rid/.test(scMethods.save || '') && /ROLLBACK WORK/.test(scMethods.save || ''));
check('写入用新配置版本 R + 日期时间（旧版本参数行保留）', /lv_ver = \|R\{ sy-datum \}\{ sy-uzeit \}\|/.test(scMethods.save || ''));
check('不用 SCAN ABAP-SOURCE / FIND PCRE（自己切语句，规则与 JS 参考一致）', !/SCAN\s+ABAP-SOURCE/i.test(sc) && !/FIND\s+(ALL\s+OCCURRENCES\s+OF\s+)?PCRE/i.test(sc));
check('源码读取：READ REPORT + Z/Y include 展开（深度 ≤ 3、最多 30 个）；文字：READ TEXTPOOL 依次试四种语言', /READ REPORT lv_pname INTO lt_src STATE 'A'/.test(sc) && /iv_depth >= 3/.test(sc) && /gv_incl < 30/.test(sc) && /READ TEXTPOOL lv_pname INTO lt_tp LANGUAGE lv_l/.test(sc));
check('键值结构不叫 key（x[ key = … ] 会被当成二级键语法）', /BEGIN OF ty_kv,\s*k\s+TYPE string,\s*v\s+TYPE string,/i.test(sc) && !/\[\s*key\s*=/i.test(sc));
check('类实现里方法之间没有注释（SE24 源码视图约定）', (() => {
  const lines = scRaw.slice(scRaw.indexOf('CLASS zcl_ai_rpt_scanner IMPLEMENTATION')).split(/\r?\n/);
  let between = false, bad = 0;
  lines.forEach((l) => {
    if (/^\s*ENDMETHOD\./i.test(l)) { between = true; return; }
    if (/^\s*(METHOD\s|ENDCLASS)/i.test(l)) { between = false; return; }
    if (between && l.trim()) { bad++; }
  });
  return bad === 0;
})());
check('build_rows 排序号不用 sy-tabix（内层 LOOP 会改掉）', /lv_no = lv_no \+ 1\.\s*<ls_r>-sort_no = lv_no \* 10\./.test(scMethods.build_rows || ''));
check('SE38 程序：三种模式、默认只演练、写前 POPUP_TO_CONFIRM、后台跑不弹窗', /p_list RADIOBUTTON/.test(reg) && /p_scan RADIOBUTTON GROUP g1 DEFAULT 'X'/.test(reg) && /p_test AS CHECKBOX DEFAULT 'X'/.test(reg) &&
  /CALL FUNCTION 'POPUP_TO_CONFIRM'/.test(reg) && /IF sy-batch = abap_false\./.test(reg));
check('SE38 程序：只调 ZCL_AI_RPT_SCANNER，不直接写登记表', /zcl_ai_rpt_scanner=>scan\(/.test(reg) && /zcl_ai_rpt_scanner=>save\(/.test(reg) && !/\b(INSERT|UPDATE|MODIFY|DELETE)\s+(FROM\s+)?zai_rpt_/i.test(reg));
check('WRITE 里不直接写字符串模板（先赋给变量）', !/WRITE:[^.]*\|/.test(reg));
check('REPORT_SERVICE V1.0.14：DEFAULT_TYPE TODAY = sy-datum + 偏移', /^\* V1\.0\.14 20261024/m.test(rsRaw) && /WHEN 'TODAY'\.[\s\S]*?lv_dday = sy-datum \+ lv_off\./.test(validate));
// 通用：每行 ≤ 255 字符（ABAP 源码行上限）；INDEX 后面不写算术式
const longs = [], idxExpr = [];
listAbap(ABAP).forEach((file) => {
  const raw = fs.readFileSync(file, 'utf8');
  raw.split(/\r?\n/).forEach((l, i) => { if (l.length > 255) { longs.push(path.basename(file) + ':' + (i + 1)); } });
  codeOnly(raw).split('\n').forEach((l, i) => {
    if (/\bINDEX\s+\w+\s*[-+]\s*\d/i.test(l)) { idxExpr.push(path.basename(file) + ':' + (i + 1)); }
  });
});
check('所有 ABAP 源码每行 ≤ 255 字符', longs.length === 0, longs.slice(0, 5).join(', '));
check('READ TABLE … INDEX 后面不写算术式（先算进变量）', idxExpr.length === 0, idxExpr.slice(0, 5).join(', '));

// ---------------------------------------------------------------- 6) 10.27 记录
console.log('\n[6] 10.27：SCANNER V1.0a 补回 / EXEC_SAP V1.1c 作业语言与中止原因');
check('SCANNER 头注释有 V1.0a 20261026 修复标记（00c：防止再贴回修复前版本）', /^\* V1\.0a\s+20261026: 修 3 处编译错/m.test(scRaw));
check('SCANNER class_constructor 声明在 PUBLIC SECTION（不在 PRIVATE）', /PUBLIC SECTION\.[\s\S]*?CLASS-METHODS class_constructor\.[\s\S]*?PRIVATE SECTION\./.test(sc) &&
  !/PRIVATE SECTION\.[\s\S]*?CLASS-METHODS class_constructor\.[\s\S]*?ENDCLASS\./.test(sc.slice(0, sc.indexOf('CLASS zcl_ai_rpt_scanner IMPLEMENTATION'))));
check('SCANNER READ REPORT / READ TEXTPOOL 都用 PROGNAME 变量，不直接传 string 形参', !/READ (REPORT|TEXTPOOL) iv_prog\b/i.test(sc) &&
  /lv_pname TYPE progname[\s\S]*?lv_pname = iv_prog\.[\s\S]*?READ REPORT lv_pname/.test(scMethods.read_source || '') &&
  /lv_pname TYPE progname[\s\S]*?lv_pname = iv_prog\.[\s\S]*?READ TEXTPOOL lv_pname/.test(scMethods.read_texts || ''));
const exMethods = {};
(ex.match(/^\s*METHOD\s+\w+\.[\s\S]*?^\s*ENDMETHOD\./gim) || []).forEach((m) => { exMethods[m.match(/METHOD\s+(\w+)\./i)[1].toLowerCase()] = m; });
check('EXEC_SAP 版本头有 V1.1c', /^\* V1\.1c\s+20261027/m.test(exRaw));
check('两处 SUBMIT … VIA JOB 都带 LANGUAGE lv_langu，语言来自 job_langu( )', (exMethods.submit || '').split(/LANGUAGE lv_langu/).length - 1 === 2 &&
  /lv_langu = job_langu\( \)\./.test(exMethods.submit || '') && !/VIA JOB lv_jobname NUMBER lv_jobcnt\s*\n/.test(exMethods.submit || ''));
check('job_langu：读 RPT_JOB_LANGU，1 位按语言键、2 位按 T002-LAISO，查不到退回 sy-langu', /read_cfg_str\( 'RPT_JOB_LANGU' \)/.test(exMethods.job_langu || '') &&
  /WHERE spras = @lv_key/.test(exMethods.job_langu || '') && /WHERE laiso = @lv_iso/.test(exMethods.job_langu || '') && /rv = sy-langu\./.test(exMethods.job_langu || ''));
check('abort_reason：读作业日志、TBTC5 列按名取、跳过 00/518、0K/530 附语言提示', /CALL FUNCTION 'BP_JOBLOG_READ'/.test(exMethods.abort_reason || '') &&
  /ASSIGN COMPONENT 'MSGTYPE' OF STRUCTURE/.test(exMethods.abort_reason || '') && !/ls_log-(text|msgid|msgno|msgtype)/i.test(exMethods.abort_reason || '') &&
  /lv_id = '00' AND lv_no = '518'/.test(exMethods.abort_reason || '') && /lv_id = '0K' AND lv_no = '530'/.test(exMethods.abort_reason || ''));
check('poll 作业取消：原因写 ERROR_MESSAGE（JOB_ABORT），已有原因不覆盖', /WHEN 'A'\.[\s\S]*?abort_reason\([\s\S]*?error_code\s+= 'JOB_ABORT',[\s\S]*?AND error_code\s+= ' '\./.test(exMethods.poll || ''));
check('EXEC_SAP 新方法都声明在 PRIVATE SECTION', /PRIVATE SECTION\.[\s\S]*?CLASS-METHODS job_langu[\s\S]*?CLASS-METHODS abort_reason[\s\S]*?ENDCLASS\./.test(ex));
// 10.27 记录 #04（下午）：参数卡复选框按原选择屏的块分组 —— GROUP_LABEL
console.log('\n[7] 10.27 #04：选择屏块标题 GROUP_LABEL（SCANNER V1.0b / REPORT_SERVICE V1.0.15 / ZAI_RPT_REG V1.0a）');
check('SCANNER V1.0b：ty_param 有 group_label，build_rows 用 text_of_var( 块 ) 填（普通行 + 单选组 / 固定组）', /^\* V1\.0b\s+20261027/m.test(scRaw) &&
  /BEGIN OF ty_param,[\s\S]*?group_label\s+TYPE string,[\s\S]*?END OF ty_param/i.test(sc) &&
  (scMethods.build_rows || '').split(/group_label\s+=\s+text_of_var\(/).length - 1 === 3);
check('SCANNER save：GROUP_LABEL 按名取列（SE11 没加列也能激活、照常写入并提示）', /ASSIGN COMPONENT 'GROUP_LABEL' OF STRUCTURE ls_db/.test(scMethods.save || '') &&
  !/ls_db-group_label/i.test(scMethods.save || '') && /lv_nogrp = abap_true/.test(scMethods.save || ''));
const rsMethods2 = methodOf(rs, 'get_params');
check('REPORT_SERVICE V1.0.15：ty_param 有 group_label；主 SELECT 清单不变、块标题另用动态列名读并捕获异常', /^\* V1\.0\.15 20261027/m.test(rsRaw) &&
  /BEGIN OF ty_param,[\s\S]*?group_label\s+TYPE string,[\s\S]*?END OF ty_param/i.test(rs) &&
  /validation_rule, help_text, sort_no, active, sel_kind\s+FROM zai_rpt_param/i.test(rsMethods2) && !/sel_kind,\s*group_label/i.test(rsMethods2) &&
  /lv_gcols\s+TYPE string VALUE `PARAM_ID, GROUP_LABEL`/.test(rsMethods2) && /SELECT \(lv_gcols\) FROM zai_rpt_param/.test(rsMethods2) && /CATCH cx_sy_dynamic_osql_error/.test(rsMethods2));
check('ZAI_RPT_REG V1.0a：预览按块分段打【块】标题（先赋给变量再 WRITE）', /^\*& V1\.0a 20261027/m.test(regRaw) && /ls_p-group_label <> lv_blk/.test(reg) && /WRITE: \/ lv_bln COLOR COL_GROUP\./.test(reg));

// ---------------------------------------------------------------- 8) 10.28 边跑边看
console.log('\n[8] 10.28 边跑边看：ZCL_AI_AGENT_PROGRESS V1.0 / AGENT_SERVICE V15.6 / DPC V15.9');
const prRaw = read('ZCL_AI_AGENT_PROGRESS.abap'), pr = codeOnly(prRaw);
const prM = (n) => methodOf(pr, n);
const agRaw = read('ZCL_AI_AGENT_SERVICE.abap'), ag = codeOnly(agRaw);
const dpRaw = read('ZCL_ZAI_CHAT_DPC_EXT.abap'), dp = codeOnly(dpRaw);
const prWrites = pr.match(/\b(?:INSERT|UPDATE|MODIFY|DELETE FROM)\s+zai_agent_prog\b[^.]*/gi) || [];
check('进度表的写（INSERT / UPDATE / MODIFY / DELETE）都带 CONNECTION (gc_con)', prWrites.length >= 5 && prWrites.every((w) => /CONNECTION \(gc_con\)/i.test(w)),
  prWrites.filter((w) => !/CONNECTION \(gc_con\)/i.test(w)).join(' | '));
check('独立连接是 R/3*AI_PROG；start / sync / finish 写完都 COMMIT CONNECTION', /gc_con\s+TYPE dbcon_name VALUE 'R\/3\*AI_PROG'/i.test(pr) &&
  ['start', 'sync', 'finish'].every((n) => /COMMIT CONNECTION \(gc_con\)/.test(prM(n))));
check('进度类不碰主事务（没有 COMMIT WORK / ROLLBACK）', !/COMMIT WORK|ROLLBACK/i.test(pr));
check('start / sync / finish 都包在 TRY … CATCH cx_root（写失败只关掉进度）', ['start', 'sync', 'finish'].every((n) => /TRY\.[\s\S]*CATCH cx_root\.[\s\S]*CLEAR gv_on/.test(prM(n))));
check('read 只读本人（uname = @sy-uname）且没有写', /uname = @sy-uname/.test(prM('read')) && !/\b(INSERT|UPDATE|MODIFY|DELETE)\b/i.test(prM('read')));
check('开关 AGENT_PROGRESS = OFF 时不记；请求编号超过 32 位不记', /cfgkey = 'AGENT_PROGRESS'/.test(prM('start')) && /'OFF'/.test(prM('start')) && /strlen\( iv_run_id \) > 32/.test(prM('start')));
check('LOOP 的 FROM 不写算术式（先算进 lv_from）', /lv_from = gv_synced \+ 1\.\s*LOOP AT it_trace INTO DATA\(ls_t\) FROM lv_from\./.test(prM('sync')));
check('预览单元格超 60 字截断、参数值超 40 字截断、SQL 原文不进参数小标签', /substring\( val = lv_cell len = 60 \)/.test(prM('preview_of')) &&
  /substring\( val = lv_v len = 40 \)/.test(prM('kv_running')) && /<> 'sql'/.test(prM('kv_running')));
check('AGENT_SERVICE V15.6：analyze_agent 有可选参数 iv_request_id', /^\* V15\.6 20261028/m.test(agRaw) &&
  /CLASS-METHODS analyze_agent[\s\S]*?iv_request_id TYPE string OPTIONAL[\s\S]*?EXPORTING es_result/i.test(ag));
const agCnt = (re) => (ag.match(re) || []).length;
// 20261102 V15.14：call_function 分支多 2 处 sync（调用前写那句话、调用后收口）
// V15.15(11.4): query_result 分支多 2 个 sync(工具前写那句话 + 执行后) —— 9 → 11
check('进度调用数：start 1 / sync 11 / finish 2', agCnt(/zcl_ai_agent_progress=>start\(/g) === 1 && agCnt(/zcl_ai_agent_progress=>sync\(/g) === 11 &&
  agCnt(/zcl_ai_agent_progress=>finish\(/g) === 2, 'start ' + agCnt(/zcl_ai_agent_progress=>start\(/g) + ' / sync ' + agCnt(/zcl_ai_agent_progress=>sync\(/g) + ' / finish ' + agCnt(/zcl_ai_agent_progress=>finish\(/g));
check('每轮调模型前写本轮占位（循环里 sync 在 zcl_ai_llm_client=>chat 之前）', /lv_round = lv_round \+ 1\.\s*zcl_ai_agent_progress=>sync\([\s\S]*?is_running = VALUE #\( phase = 'PLANNING'[\s\S]*?zcl_ai_llm_client=>chat\(/.test(ag));
check('工具执行前写模型那句话 + 工具占位：数据分析在 execute_plan 前、call_function 在 call_sync 前、query_result 在 run 前、扁平参数工具在参数校验后', agCnt(/iv_note\s+= zcl_ai_agent_guard=>sanitize_summary\( ls_out-summary \)/g) === 4 &&
  /iv_note\s+= zcl_ai_agent_guard=>sanitize_summary\( ls_out-summary \) \)\.\s*GET RUN TIME FIELD lv_rq_t0\.\s*zcl_ai_result_query=>run\(/.test(ag) &&
  /iv_note\s+= zcl_ai_agent_guard=>sanitize_summary\( ls_out-summary \) \)\.\s*GET RUN TIME FIELD lv_cf_t0\.\s*zcl_ai_rfc_exec=>call_sync\(/.test(ag) &&
  /plan_running\([^)]*\) \)\.\s*lt_ds = zcl_ai_data_analysis_service=>execute_plan/.test(ag) && /CONTINUE\.\s*ENDIF\.\s*zcl_ai_agent_progress=>sync\([\s\S]*?kv_running\(/.test(ag));
check('数据分析查询后带预览 sync（preview_of 按查询逐条）', /LOOP AT lt_ds INTO DATA\(ls_ds_prev\)\.[\s\S]*?preview_of\([\s\S]*?zcl_ai_agent_progress=>sync\( it_trace = lt_trace it_preview = lt_prog_prev \)/.test(ag));
check('收口：sync + finish 在 trace_json 序列化之前；finish_det 里也有', /zcl_ai_agent_progress=>finish\( \)\.\s*es_result-trace_json = \/ui2\/cl_json=>serialize/.test(ag) &&
  /zcl_ai_agent_progress=>finish\( \)/.test(methodOf(ag, 'finish_det')));
const feCs = fs.readFileSync(path.join(__dirname, '../webapp/service/ChatService.js'), 'utf8');
check('DPC V15.9：AGENTPROGRESS 读 ClientRequestId 调 read；AnalyzeTask 传 iv_request_id = lv_at_rid', /^\* V15\.9 20261028/m.test(dpRaw) &&
  /WHEN 'AGENTPROGRESS'\.[\s\S]*?zcl_ai_agent_progress=>read\(\s*v8_param\( it_parameter = it_parameter iv_name = 'ClientRequestId' \)/.test(dp) && /iv_request_id\s+= lv_at_rid/.test(dp));
check('前端发的 FI 名 / 参数名 = DPC 读的（AgentProgress / ClientRequestId）', /_taskCall\("AgentProgress", \{ ClientRequestId:/.test(feCs) && /_fiHasParam\("AgentProgress", "ClientRequestId"\)/.test(feCs));


// ---------------------------------------------------------------- 9) 10.28 记录 #01：协议失败兜底 + 源码关键词定位
console.log('\n[9] 10.28 #01：协议失败兜底 + 读源码关键词定位（GUARD V1.1.5 / LLM_CLIENT V1.4 / AGENT_SERVICE V15.7 / REGISTRY / DOMAIN_CARDS V1.3）');
const lcRaw = read('ZCL_AI_LLM_CLIENT.abap'), lc = codeOnly(lcRaw);
const gdRaw = read('ZCL_AI_AGENT_GUARD.abap'), gd = codeOnly(gdRaw);
const trRaw = read('ZCL_AI_TOOL_REGISTRY.abap'), tr = codeOnly(trRaw);
const dcRaw = read('ZCL_AI_DOMAIN_CARDS.abap');
check('LLM_CLIENT V1.4：chat 多一个出参 ev_finish（OpenAI finish_reason / Ollama done_reason，转小写）', /^\* V1\.4 20261028/m.test(lcRaw) &&
  /ev_attempts\s+TYPE i\s+ev_finish\s+TYPE string\b/.test(lc) && /ev_finish\s+= to_lower\( ls_choice-finish_reason \)/.test(lc) &&
  /ev_finish\s+= to_lower\( ls_olr-done_reason \)/.test(lc) && /CLEAR: ev_content, ev_elapsed, ev_error, ev_attempts, ev_finish\./.test(lc));
check('AGENT_SERVICE V15.7：两处调模型都取 ev_finish = lv_llm_fin', /^\* V15\.7 20261028/m.test(agRaw) && agCnt(/ev_finish\s+= lv_llm_fin/g) === 2);
const agProto = (ag.match(/IF lv_protocol_ok = abap_false\.\s*lv_plan_ms = lv_plan_ms \+ lv_llm_ms\.[\s\S]*?\n      ENDIF\./) || [''])[0];
check('协议失败：先记一条 REJECTED 步骤（原因 + 输出开头），再决定重写或收口', /lv_cut\) = xsdbool\( lv_llm_fin = 'length' \)/.test(agProto) &&
  /APPEND VALUE #\( phase\s+= 'EXECUTING'[\s\S]*?status\s+= 'REJECTED'[\s\S]*?lv_bad_head[\s\S]*?\) TO lt_trace\.\s*IF lv_repaired = abap_false\./.test(agProto));
check('被截断时修复提示要求压缩回答重写；记下第一次的坏输出', /IF lv_cut = abap_true\.\s*ls_msg-content = \|【协议错误】你上一条输出太长/.test(agProto) &&
  /lv_bad_first = lv_content\./.test(agProto) && /lv_cut_first = lv_cut\./.test(agProto));
check('第二次仍失败：先 salvage 本次、再 salvage 第一次，保留到就按 OK 返回并注明，否则才 ERROR', /salvage_answer\( lv_content \)[\s\S]*?salvage_answer\( lv_bad_first \)[\s\S]*?es_result-status = 'OK'\.[\s\S]*?EXIT\.[\s\S]*?es_result-status\s+= 'ERROR'\./.test(agProto) &&
  /以上是保留下来的内容/.test(agProto));
check('lv_bad_first / lv_cut_first 每次运行开头清空', /CLEAR: lv_answer, lv_bad_first, lv_cut_first\./.test(ag));
check('GUARD V1.1.5：优先取含 "action" 的对象；缺 action 按字段推断（tool → tool，answer → final）', /^\* V1\.1\.5 20261028/m.test(gdRaw) &&
  /extract_json_object\( iv_text = iv_raw iv_key = '"action"' \)/.test(methodOf(gd, 'parse_model_json')) &&
  /IF es_out-tool IS NOT INITIAL\.\s*es_out-action = 'tool'\.\s*ELSEIF es_out-answer IS NOT INITIAL\.\s*es_out-action = 'final'\./.test(methodOf(gd, 'parse_model_json')));
check('extract_json_object：iv_key 可选；含 key 才返回，否则记第一个、最后退回第一个', /CLASS-METHODS extract_json_object\s+IMPORTING iv_text\s+TYPE string\s+iv_key\s+TYPE string OPTIONAL/.test(gd) &&
  /IF iv_key IS INITIAL OR lv_obj CS iv_key\./.test(methodOf(gd, 'extract_json_object')) && /rv = lv_first\./.test(methodOf(gd, 'extract_json_object')));
const gdSalv = methodOf(gd, 'salvage_answer');
check('salvage_answer：PUBLIC；调工具的输出不兜底；取 answer 已输出部分或纯文字；不足 40 字符返回空', /PUBLIC SECTION\.[\s\S]*?CLASS-METHODS salvage_answer[\s\S]*?PRIVATE SECTION\./.test(gd) &&
  /"action"\\s\*:\\s\*"tool"/.test(gdSalv) && /"answer"\\s\*:\\s\*"/.test(gdSalv) && /json_unescape\( lv_body \)/.test(gdSalv) &&
  /\\A\\s\*\(```\[A-Za-z\]\*\\s\*\)\?\\\{/.test(gdSalv) && /< 40\./.test(gdSalv));
check('GUARD 仍只有 3 处 REPLACE ALL OCCURRENCES OF REGEX（V1.1.4 核对标记不变）', (gd.match(/REPLACE ALL OCCURRENCES OF REGEX/g) || []).length === 3);
const agSrc = methodOf(ag, 'exec_read_source');
check('exec_read_source：有 iv_keyword；关键词分支在分页之前 RETURN；LOOP FROM / TO 用变量', /iv_keyword\s+TYPE string OPTIONAL/.test(ag) &&
  /IF lv_kw IS NOT INITIAL\.[\s\S]*?IF lv_line CS lv_kw\.[\s\S]*?LOOP AT lt_lines INTO lv_line FROM lv_from TO lv_to\.[\s\S]*?RETURN\.\s*ENDIF\.\s*lv_start = 1\./.test(agSrc) &&
  /gc_src_hits\s+TYPE i VALUE 20/.test(ag) && /gc_src_ctx\s+TYPE i VALUE 6\./.test(ag));
check('关键词结果带 hits / hit_lines / more_hits，未命中给提示', /"hits":\{ lv_hits \},"hit_lines":\[\{ lv_hl \}\]/.test(agSrc) && /"more_hits":/.test(agSrc) && /"tip":"没有命中/.test(agSrc));
check('分发把 keyword 传给 exec_read_source', /iv_keyword = zcl_ai_agent_guard=>kv_get\( it_kv = lt_norm iv_name = 'keyword' \)/.test(ag));
check('REGISTRY：read_program_source 有 keyword 参数（TEXT、可选），描述里说明 keyword 用法', /APPEND VALUE #\( name = 'keyword' ptype = gc_pt_text required = abap_false \)\s+TO lt_p\.\s+APPEND VALUE #\(\s+tool_id\s+= gc_tool_read_source/.test(tr) &&
  /给 keyword 时按关键词定位/.test(tr));
check('DOMAIN_CARDS V1.3：CODE 卡先 keyword 定位、回答 1500 字以内', /^\* V1\.3\s+20261028/m.test(dcRaw) && /keyword 搜索定位/.test(dcRaw) && /回答控制在 1500 字以内/.test(dcRaw));
check('降级提示的阶段清单不再带 [PHASE] 代码、跳过 TOOL_DECISION', !/- \[\{ ls_s-phase \}\]/.test(methodOf(ag, 'build_degrade_answer')) &&
  /WHERE phase <> 'TOOL_DECISION'/.test(methodOf(ag, 'build_degrade_answer')));
check('进度小标签认得 keyword（关键词）', /WHEN 'keyword'\.\s+rv = '关键词'\./.test(prM('arg_label')));

// ---------------------------------------------------------------- 10) 02 方案第 0 步：模型用量记审计 + 数据集按整行回填
console.log('\n[10] Agent闭环增强/02 第 0 步：用量记审计（LLM_CLIENT V1.5 / AGENT_SERVICE V15.8）+ 数据集按整行回填（DATA_ANALYSIS V13.4）');
const lcChat = methodOf(lc, 'chat');
const lcUsage = methodOf(lc, 'parse_usage');
check('LLM_CLIENT V1.5：chat 新增出参 ev_usage TYPE ty_usage；ty_usage 声明在 chat 之前；单独 CLEAR ev_usage',
  // 20261029：V1.6 在 ev_usage 后面又加了 ev_reasoning、CLEAR 合成一句 —— 只要求 ev_usage 还在、还单独被清
  /^\* V1\.5 20261028/m.test(lcRaw) && /ev_finish\s+TYPE string\s+ev_usage\s+TYPE ty_usage\b/.test(lc) &&
  lc.indexOf('BEGIN OF ty_usage,') > 0 && lc.indexOf('BEGIN OF ty_usage,') < lc.indexOf('CLASS-METHODS chat') && /CLEAR:?[^.]*\bev_usage\b[^.]*\./.test(lcChat));
check('chat：失败分支 RETURN 之后、正文解析 TRY 之前取用量（失败的调用不解析）',
  /IF lv_fail IS NOT INITIAL\.[\s\S]*?RETURN\.\s*ENDIF\.\s*ev_usage = parse_usage\( lv_resp \)\.\s*TRY\./.test(lcChat));
check('parse_usage：PUBLIC；自己的 TRY / CATCH cx_root 清空返回，不影响正文；认 DeepSeek / OpenAI / Ollama 三种字段',
  /PUBLIC SECTION\.[\s\S]*?CLASS-METHODS parse_usage[\s\S]*?PRIVATE SECTION\./.test(lc) &&
  /TRY\.[\s\S]*?\/ui2\/cl_json=>deserialize\([\s\S]*?CATCH cx_root\.\s*CLEAR rs\.\s*RETURN\.\s*ENDTRY\./.test(lcUsage) &&
  /json = 'prompt_cache_hit_tokens'/.test(lcUsage) && /json = 'cached_tokens'/.test(lcUsage) && /json = 'eval_count'/.test(lcUsage) &&
  !/ev_/.test(lcUsage));
const agAudit = methodOf(ag, 'save_audit');
check('AGENT_SERVICE V15.8：三处调模型都取 ev_usage，并各记一次 log_llm_call',
  /^\* V15\.8 20261028/m.test(agRaw) && agCnt(/zcl_ai_llm_client=>chat\(/g) === 3 &&
  agCnt(/ev_usage\s+= ls_(llm|ana)_use/g) === 3 && agCnt(/log_llm_call\( EXPORTING/g) === 3);
check('用量只进审计：LLM_CALL 只出现在 save_audit 里（不进 lt_trace / TraceJson / 进度表）',
  agCnt(/'LLM_CALL'/g) === 1 && /tool_id\s+= 'LLM_CALL'/.test(agAudit) && /row_cnt\s+= ls_c-out_tokens/.test(agAudit) &&
  !/phase\s*=\s*'LLM_CALL'/.test(ag));
check('save_audit 声明 it_calls（OPTIONAL），主流程传入 lt_llm_calls',
  /it_calls\s+TYPE tt_llm_call OPTIONAL/.test(ag) && /it_trace\s+= lt_trace\s+it_calls\s+= lt_llm_calls \)/.test(ag));
check('log_llm_call：SUMMARY 截到 200 字符；网关没返回写"未返回"',
  /IF strlen\( lv_sum \) > 200\.\s*lv_sum = lv_sum\(200\)\./.test(methodOf(ag, 'log_llm_call')) && /`未返回`/.test(methodOf(ag, 'log_llm_call')));
check('两处数据集回填都按整行裁到 GUARD 上限以内；run_sql 回填副本不再改写 total_rows',
  agCnt(/iv_max_chars = zcl_ai_agent_guard=>gc_max_result_chars - 200/g) === 2 && !/ls_feed_ds-total_rows\s*=/.test(ag) &&
  !/ls_feed_ds-error\s*=/.test(ag));
const daRaw = read('ZCL_AI_DATA_ANALYSIS_SERVICE.abap'), da = codeOnly(daRaw);
const daBuild = methodOf(da, 'build_datasets_json');
check('DATA_ANALYSIS V13.4：数据集 JSON 行数与截断写在明细前面（name → lv_head → status/columns → rows → 尾部）',
  /^\* V13\.4\s+20261028/m.test(daRaw) &&
  /rv = rv && `\{"name":` && json_str\( ls_ds-name \) && lv_head && lv_seg && lv_rows && lv_tail\./.test(daBuild) &&
  /lv_head = \|,"total_rows":\{ lv_total \}\|/.test(daBuild));
check('rows_sent / note 只在回填模型（iv_max_chars > 0）且少写了行或查询达上限时出现；按整行裁剪',
  /IF iv_max_chars > 0 AND \( lv_row_n < lv_total OR ls_ds-truncated = abap_true \)\.[\s\S]*?"rows_sent"/.test(daBuild) &&
  /IF lv_cap > 0\s+AND lv_fixed \+ strlen\( lv_rows \) \+ strlen\( lv_row \) \+ 2 > lv_cap\.\s*EXIT\./.test(daBuild) &&
  /lv_cap = COND #\( WHEN iv_max_chars > 0 THEN iv_max_chars \* lv_ds_idx DIV lv_ds_cnt ELSE 0 \)\./.test(daBuild) &&
  /DATA\(lv_ds_idx\) = sy-tabix\.\s*IF lv_ds_idx > 1\./.test(daBuild));
check('build_datasets_json 签名不变（AnalysisJson 仍传 iv_max_chars = 0）',
  /CLASS-METHODS build_datasets_json\s+IMPORTING it_datas\s+TYPE tt_dataset\s+iv_max_chars TYPE i DEFAULT gc_model_chars\s+RETURNING VALUE\(rv\)\s+TYPE string\./.test(da) &&
  /build_datasets_json\( it_datas\s+= it_datas\s+iv_max_chars = 0 \)/.test(da));

// ---------------------------------------------------------------- 11) 10.28 #02：工单分析 SQL 反复失败
console.log('\n[11] 10.28 #02：长 SQL 断行（SQL_EXECUTOR V1.3）/ 写法提示（SQL_GUARD V1.2.3）/ 前导零（DDIC_TOOLS V1.3）/ DATA 域卡 V1.4');
const exRaw2 = read('ZCL_AI_SQL_EXECUTOR.abap'), ex2 = codeOnly(exRaw2), exRun = methodOf(ex2, 'run_sql');
const segMax = +((ex2.match(/CONSTANTS gc_seg_max TYPE i VALUE (\d+)\./) || [])[1] || 0);
const lineLen = +((ex2.match(/ty_srcline TYPE c LENGTH (\d+)/) || [])[1] || 0);
check('EXECUTOR V1.3：每行上限 gc_seg_max + 1（逗号留在本行）< 生成源码行长 ty_srcline',
  /^\* V1\.3 20261028/m.test(exRaw2) && segMax > 0 && lineLen > 0 && segMax + 1 < lineLen, 'gc_seg_max=' + segMax + ' 行长=' + lineLen);
check('不再按 230 断行；断点只取常量之外的空格 / 逗号（数单引号奇偶），找不到就拒绝',
  !/230/.test(exRun) && /IF lv_ch1 = ` ` OR lv_ch1 = `,`\./.test(exRun) && /lv_q = count\( val = lv_lead sub = `'` \)\./.test(exRun) &&
  /IF lv_q MOD 2 = 0\./.test(exRun) && /IF lv_scut < 0\.[\s\S]*?RETURN\./.test(exRun));
check('SQL 段只用 substring( )，不用 offset 写法（教训：offset / length 位置禁表达式）',
  !/lv_clean\+/.test(exRun) && /lv_seg = substring\( val = lv_clean off = lv_spos len = lv_segl \)\./.test(exRun));
check('编译报错回填出错行及上一行（行号转换失败、取不到时退回前 200 字符）',
  /CATCH cx_sy_conversion_error\./.test(exRun) && /READ TABLE lt_source INTO lv_errline INDEX lv_lno\./.test(exRun) && /出错位置附近/.test(exRun));
const sgRaw = read('ZCL_AI_SQL_GUARD.abap'), sg = codeOnly(sgRaw), sgVal = methodOf(sg, 'validate_sql');
check('GUARD V1.2.3："别名.字段" 在通用"语句分隔符"检查之前单独提示改用 ~',
  /^\* V1\.2\.3 20261028/m.test(sgRaw) && sgVal.indexOf('别名~字段') > 0 && sgVal.indexOf('别名~字段') < sgVal.indexOf('检测到语句分隔符'));
check('双引号 / 中文与全角 / LIMIT / 当前日期（带今天）/ 日期函数 / IFNULL 都有可照做的提示',
  /不要加引号/.test(sgVal) && /IF lv_bare CN lv_ascii\./.test(sgVal) && /LIMIT\|TOP/.test(sgVal) && /今天是 '\{ sy-datum \}'/.test(sgVal) &&
  /DATS_DAYS_BETWEEN/.test(sgVal) && /COALESCE/.test(sgVal));
check('原有关键字黑名单与表权限检查保留（INTO / WITH / VIEW_AUTHORITY_CHECK）',
  /APPEND 'INTO'\s+TO lt_kw\./.test(sgVal) && /APPEND 'WITH'\s+TO lt_kw\./.test(sgVal) && /CALL FUNCTION 'VIEW_AUTHORITY_CHECK'/.test(sgVal));
const ddRaw = read('ZCL_AI_DDIC_TOOLS.abap'), dd = codeOnly(ddRaw), ddDesc = methodOf(dd, 'describe_table');
check('DDIC_TOOLS V1.3：describe_table 字段带 decimals / convexit；有 ALPHA 时给补零提示；仍没有 {{ 模板',
  /^\* V1\.3 20261028/m.test(ddRaw) && /"convexit":"/.test(ddDesc) && /"decimals":/.test(ddDesc) && /IF ls_f-convexit = 'ALPHA'\./.test(ddDesc) &&
  /'000000131002'/.test(ddDesc) && !/\{\{/.test(dd));
const dcData = (dcRaw.match(/ELSEIF lv_domain = gc_dom_data\.[\s\S]*?ELSEIF lv_domain = gc_dom_code\./) || [''])[0];
check('DOMAIN_CARDS V1.4：DATA 卡讲前导零、点号、函数写法（带今天日期）、相除、一对多不和 SUM 同 JOIN',
  /^\* V1\.4\s+20261028/m.test(dcRaw) && /'000000131002'/.test(dcData) && /不要写 H\.KUNNR/.test(dcData) &&
  /今天是 \{ sy-datum \}/.test(dcData) && /DIVISION\( 分子, 分母, 2 \)/.test(dcData) && /EXISTS \( SELECT J~OBJNR FROM JEST AS J/.test(dcData) &&
  /AFRU\(报工\)/.test(dcData));
const skills = require('../webapp/utils/SkillCatalog.js');
const ppOrder = skills.builtin.find((x) => x.id === 'DATA_PP_ORDER');
check('技能「生产工单进度」：工单号补零、在制口径（标明暂定）、状态不和 SUM 同 JOIN、比率在回答里算；正文 ≤ 3000',
  !!ppOrder && /'000000131002'/.test(ppOrder.body) && /在制数量（暂定口径/.test(ppOrder.body) && /不要和数量 SUM/.test(ppOrder.body) &&
  /在回答里算/.test(ppOrder.body) && ppOrder.body.length <= 3000);

// ---------------------------------------------------------------- 12) 组合分析二期（20261031）
console.log('\n[12] 组合分析二期：ZCL_AI_COMBO_SERVICE V1.0 / AGENT_SERVICE V15.10 / DPC V15.11');
const cbRaw = read('ZCL_AI_COMBO_SERVICE.abap'), cb = codeOnly(cbRaw);
const cbWrites = (cb.match(/\b(?:INSERT|UPDATE|MODIFY|DELETE FROM)\s+(zai_\w+)/gi) || []).map((x) => x.replace(/.*\s(zai_\w+)$/i, '$1').toLowerCase());
check('COMBO 类只写自己的两张表（ZAI_COMBO_RUN / ZAI_COMBO_DATA），结果登记走 TASK_SERVICE',
  cbWrites.length > 0 && cbWrites.every((t) => t === 'zai_combo_run' || t === 'zai_combo_data') &&
  /zcl_ai_task_service=>register_artifact\(/.test(cb), cbWrites.join(','));
check('来源核对：本人 + AVAILABLE + 运行 READY + 报表登记 ANALYZE_ENABLED（报表执行 / Fiori 两种都查）',
  /owner = @sy-uname/.test(methodOf(cb, 'read_source')) && /ls_art-status <> 'AVAILABLE'/.test(methodOf(cb, 'read_source')) &&
  /FROM zai_rpt_def/.test(methodOf(cb, 'read_report_src')) && /lv_sts <> 'READY'/.test(methodOf(cb, 'read_report_src')) &&
  /FROM zai_frpt_def/.test(methodOf(cb, 'read_fiori_src')) && /run_status <> 'READY'/.test(methodOf(cb, 'read_fiori_src')));
check('来源类型以后端登记为准（不信前端声明）', /cs_src-type = ls_art-artifact_type\./.test(methodOf(cb, 'read_source')));
check('报表执行来源走 ad_read_result（真实 / Mock 两种适配器都能读），Fiori 读 ZAI_FRPT_DATA',
  /zcl_ai_report_service=>ad_read_result\(/.test(methodOf(cb, 'read_report_src')) && /FROM zai_frpt_data/.test(methodOf(cb, 'read_fiori_src')));
check('分析上下文校验会话归属（session_id = 本会话）', /session_id = @lv_sess/.test(methodOf(cb, 'analysis_context')));
check('幂等：同一请求号返回已建结果', /WHERE request_id = @lv_req AND owner = @sy-uname/.test(methodOf(cb, 'create')));
check('不用 DDIC 保留字字段 MODE / LABEL（用 CMODE / LABEL_TEXT）', !/ls_run-mode\b/.test(cb) && !/ls_run-label\b/.test(cb) && /ls_run-cmode/.test(cb));
check('不对方法调用结果直接 LOOP AT（7.50 兼容写法：先存局部表）', !/LOOP AT \w+->\w+\(/.test(cb));
const agRaw12 = read('ZCL_AI_AGENT_SERVICE.abap'), ag12 = codeOnly(agRaw12);
check('AGENT_SERVICE V15.10：组合结果分流在意图路由之前，路由入口加 lv_art_mode = abap_false',
  /^\* V15\.10 20261031/m.test(agRaw12) && ag12.indexOf('zcl_ai_combo_service=>is_combo(') > 0 &&
  ag12.indexOf('zcl_ai_combo_service=>is_combo(') < ag12.indexOf('IF lv_task_on = abap_true AND lv_art_mode = abap_false.') &&
  ag12.indexOf('IF lv_task_on = abap_true AND lv_art_mode = abap_false.') < ag12.indexOf('zcl_ai_intent_router=>quick_route('));
const dpRaw12 = read('ZCL_ZAI_CHAT_DPC_EXT.abap'), dp12 = codeOnly(dpRaw12);
const cbDpBranch = (dp12.match(/WHEN 'COMBOCREATE'\.[\s\S]*?WHEN 'COMBORESULT'\./) || [''])[0];
const cbCsSrc = fs.readFileSync(path.join(__dirname, '../webapp/service/ChatService.js'), 'utf8');
const cbFeCombo = (cbCsSrc.match(/comboCreate: function[\s\S]*?getComboResult: function[\s\S]*?\n                \},/) || [''])[0];
const cbDpParams = (cbDpBranch.match(/iv_name = '(\w+)'/g) || []).map((x) => x.replace(/.*'(\w+)'/, '$1')).sort();
const cbFeParams = ['SessionId', 'SpecJson', 'ClientRequestId'].filter((k) => cbFeCombo.indexOf(k + ':') >= 0).sort();
check('DPC V15.11：COMBOCREATE 读的参数 = 前端恒发的参数（SessionId / SpecJson / ClientRequestId）',
  /^\* V15\.11 20261031/m.test(dpRaw12) && cbDpParams.join(',') === cbFeParams.join(',') && cbFeParams.length === 3, cbDpParams.join(',') + ' vs ' + cbFeParams.join(','));
check('DPC：SpecJson 支持长文本通道（resolve_text）；COMBORESULT 读 ArtifactId',
  /resolve_text\( lv_cb_spec \)/.test(cbDpBranch) && /WHEN 'COMBORESULT'\.[\s\S]*?iv_name = 'ArtifactId'/.test(dp12) && /ArtifactId: sArtifactId/.test(cbFeCombo));

console.log('\n[13] 按用户开放场景 + 报表授权：ZCL_AI_ACCESS V1.1 / AGENT V15.12 / DPC V15.12 / CHAT V2.6');
const acRaw = read('ZCL_AI_ACCESS.abap'), ac = codeOnly(acRaw);
const acWrites = (ac.match(/\b(?:INSERT|UPDATE|MODIFY|DELETE FROM)\s+(zai_\w+)/gi) || []).map((x) => x.replace(/.*\s(zai_\w+)$/i, '$1').toLowerCase());
check('ACCESS 只写 ZAI_RPT_ACL 与 ZAI_CHAT_USER（只改 AGENT_SCENES）',
  acWrites.length > 0 && acWrites.every((t) => t === 'zai_rpt_acl' || t === 'zai_chat_user') &&
  /UPDATE zai_chat_user SET agent_scenes = @lv_sc WHERE userid = @iv_user\./.test(ac), acWrites.join(','));
check('场景：管理员 / 空 = 四个全开；V1.1 AUTO 所有开通的用户可用，INVENTORY 按 DATA',
  /lv_role = 'ADMIN'/.test(methodOf(ac, 'user_scenes')) && /rv = gc_scenes\./.test(methodOf(ac, 'user_scenes')) &&
  /WHEN 'AUTO' OR 'GENERAL' OR ''\.\s+rv = abap_true\./.test(methodOf(ac, 'scene_ok')) &&
  /WHEN 'INVENTORY'\.\s+lv_sc = 'DATA'\./.test(methodOf(ac, 'scene_ok')) &&
  methodOf(ac, 'scene_ok').indexOf('IF lv_have IS INITIAL.') < methodOf(ac, 'scene_ok').indexOf("WHEN 'AUTO'") &&
  /gc_scenes\s+TYPE string VALUE 'REPORT,FIORI,DATA,CODE'/.test(ac));
check('报表：开关不开 / 管理员 → 放行；本人或 * 的授权行；REPORT_ID = * 表示这一类全部',
  /acl_on\( \) = abap_false OR is_admin\( \) = abap_true/.test(methodOf(ac, 'load_acl')) && /gv_free = abap_true/.test(methodOf(ac, 'report_ok')) &&
  /userid = @sy-uname OR userid = '\*'/.test(methodOf(ac, 'load_acl')) && /report_id = gc_all/.test(methodOf(ac, 'report_ok')));
check('保存授权：先删后插（整体覆盖），去重后插入，"*" 不改场景',
  /DELETE FROM zai_rpt_acl WHERE userid = @iv_user\./.test(methodOf(ac, 'save_user_access')) &&
  /INSERT zai_rpt_acl FROM TABLE @lt_ins/.test(methodOf(ac, 'save_user_access')) &&
  /IF iv_user <> gc_all\./.test(methodOf(ac, 'save_user_access')));
const ag13Raw = read('ZCL_AI_AGENT_SERVICE.abap'), ag13 = codeOnly(ag13Raw);
const iOwner = ag13.indexOf("es_result-message = '会话归属校验失败'."), iScene = ag13.indexOf('zcl_ai_access=>scene_ok( lv_scene )'), iSkill = ag13.indexOf('zcl_ai_skill_service=>resolve(');
check('AGENT V15.11：场景校验在会话归属之后、技能与模型之前',
  /^\* V15\.11 20261101/m.test(ag13Raw) && iOwner > 0 && iScene > iOwner && iScene < iSkill);
const iAutoDom = ag13.indexOf('AND zcl_ai_access=>scene_ok( zcl_ai_intent_router=>gc_scene_data ) = abap_false.'),
  iRoute = ag13.indexOf('ls_route = zcl_ai_intent_router=>quick_route('), iOos = ag13.indexOf("iv_label      = '场景边界'"),
  iAutoDeny = ag13.indexOf('IF lv_auto_deny IS NOT INITIAL.'), iRptBranch = ag13.indexOf("AND ls_route-object_kind = 'TCODE'\n         AND lv_art_mode = abap_false.");
check('AGENT V15.12：「自动」只用开放的能力 —— 没开数据分析去掉 SQL / 库存工具；点名报表 / 表 / 物料而场景没开放 → 说明',
  /^\* V15\.12 20261101/m.test(ag13Raw) && iAutoDom > 0 && iAutoDom < iRoute &&
  /lv_domain = zcl_ai_domain_cards=>gc_dom_general\./.test(ag13.substr(iAutoDom, 200)) &&
  iAutoDeny > iOos && iAutoDeny < iRptBranch &&
  /zcl_ai_access=>scene_ok\( zcl_ai_intent_router=>gc_scene_report \) = abap_false/.test(ag13) &&
  /ls_route-object_kind = 'TABLE' OR ls_route-object_kind = 'MATERIAL'/.test(ag13) &&
  !/zcl_ai_combo_service=>is_combo\( iv_focus_artifact_id \) = abap_true \)\./.test(ag13), [iAutoDom, iRoute, iOos, iAutoDeny, iRptBranch].join());
check('AGENT：报表执行按 TCode 出报表卡前核报表授权', ag13.indexOf('zcl_ai_access=>report_ok( iv_src_type  = zcl_ai_access=>gc_src_report') > 0 &&
  ag13.indexOf('zcl_ai_access=>report_ok( iv_src_type  = zcl_ai_access=>gc_src_report') < ag13.indexOf('ev_found = abap_true.'));
const rs13 = codeOnly(read('ZCL_AI_REPORT_SERVICE.abap'));
check('REPORT_SERVICE V1.0.16：list_defs 过滤、start_run 拒绝', /zcl_ai_access=>report_ok\(/.test(methodOf(rs13, 'list_defs')) &&
  /zcl_ai_access=>report_ok\(/.test(methodOf(rs13, 'start_run')) && !/zcl_ai_access/.test(methodOf(rs13, 'get_def')));
const fs13 = codeOnly(read('ZCL_AI_FIORI_REPORT_SERVICE.abap'));
check('FIORI V1.0.2：load_def / list_defs / find_candidates 三处核授权；目录点选补上 load_def 错误判断',
  ['load_def', 'list_defs', 'find_candidates'].every((m) => /zcl_ai_access=>report_ok\(/.test(methodOf(fs13, m))) &&
  /IF lv_err IS NOT INITIAL\.\s+" V1\.0\.2/.test(read('ZCL_AI_FIORI_REPORT_SERVICE.abap')));
const cb13 = codeOnly(read('ZCL_AI_COMBO_SERVICE.abap'));
check('COMBO V1.0.1：两种来源都核报表授权', /zcl_ai_access=>gc_src_report/.test(methodOf(cb13, 'read_report_src')) && /zcl_ai_access=>gc_src_fiori/.test(methodOf(cb13, 'read_fiori_src')));
const ch13Raw = read('ZCL_AI_CHAT_SERVICE.abap'), ch13 = codeOnly(ch13Raw);
check('CHAT V2.6：登录返回 Scenes；用户列表带报表并多一行 *；保存用户收 accessset（无下划线，/ui2/cl_json 按大写名匹配）',
  /"Scenes": "\{ zcl_ai_access=>user_scenes\( \) \}"/.test(ch13Raw) && /zcl_ai_access=>user_reports_csv\(/.test(methodOf(ch13, 'v8_get_users')) &&
  /ls_out-userid\s+= '\*'/.test(methodOf(ch13, 'v8_get_users')) && /accessset TYPE string/.test(methodOf(ch13, 'v8_save_user')) &&
  !/access_set/.test(ch13) && methodOf(ch13, 'v8_save_user').indexOf("IF lv_id = '*'.") < methodOf(ch13, 'v8_save_user').indexOf('FROM usr02'));
const dp13Raw = read('ZCL_ZAI_CHAT_DPC_EXT.abap'), dp13 = codeOnly(dp13Raw);
const suBranch = (dp13.match(/WHEN 'SAVEUSER'\.[\s\S]*?WHEN 'GETCONFIG'\./) || [''])[0];
const suDp = (suBranch.match(/iv_name = '(\w+)'/g) || []).map((x) => x.replace(/.*'(\w+)'/, '$1')).sort();
const cs13 = fs.readFileSync(path.join(__dirname, '../webapp/service/ChatService.js'), 'utf8');
const saveFe = (cs13.match(/saveUserAccess: function[\s\S]*?\n                \},/) || [''])[0];
const suFe = ['UserId', 'UserName', 'Role', 'Active', 'Scenes', 'Reports', 'AccessSet'].filter((k) => saveFe.indexOf(k + ':') >= 0).sort();
check('DPC V15.12：SAVEUSER 读的参数 = 前端保存授权时发的参数；Reports 走长文本；去掉引号和反斜杠',
  /^\* V15\.12 20261101/m.test(dp13Raw) && suDp.join(',') === suFe.join(',') && suFe.length === 7 &&
  /resolve_text\( lv_su_rep \)/.test(suBranch) && /REPLACE ALL OCCURRENCES OF `"` IN lv_su_rep/.test(dp13Raw), suDp.join(',') + ' vs ' + suFe.join(','));

// ---------------------------------------------------------------- 14) 思考模式（20261029，合并进 main 时由 12 改号）
console.log('\n[14] 思考模式：LLM_CLIENT V1.6 拼参数 / 拆思考、CHAT_SERVICE V2.7、AGENT_SERVICE V15.9、PROGRESS V1.1、DPC V15.10');
{
  const lcThinkFrag = methodOf(lc, 'think_fragment');
  const lcThinkCfg = methodOf(lc, 'parse_think_cfg');
  const lcSplit = methodOf(lc, 'split_think');
  const lcReason = methodOf(lc, 'parse_reasoning');
  check('LLM_CLIENT V1.6：chat 新增出参 ev_reasoning（最后一个），开头一并清空',
    /^\* V1\.6 20261029/m.test(lcRaw) && /ev_usage\s+TYPE ty_usage\s+ev_reasoning\s+TYPE string\./.test(lc) &&
    /CLEAR:?[^.]*\bev_reasoning\b[^.]*\./.test(lcChat));
  check('思考设置读 ZAI_CHAT_CFG-MODEL_THINK（≤ 20 字符），读不到 / 异常都返回空（= 不传参数）',
    /cfgkey = 'MODEL_THINK'/.test(methodOf(lc, 'think_mode')) && 'MODEL_THINK'.length <= 20 &&
    /CATCH cx_root\.\s+CLEAR rv\./.test(methodOf(lc, 'think_mode')));
  check('写法只认 DS / QW / OL + 1 / 0；模型 ID 大小写不敏感',
    /to_upper\( condense\( CONV string\( iv_model_id \) \) \)/.test(lcThinkCfg) && /lv_v CP 'DS\+' OR lv_v CP 'QW\+' OR lv_v CP 'OL\+'/.test(lcThinkCfg) &&
    /lv_v CP '\+\+1' OR lv_v CP '\+\+0'/.test(lcThinkCfg));
  check('DeepSeek 用 chat_template_kwargs.thinking，Qwen / GLM 用 chat_template_kwargs.enable_thinking，Ollama 用 think',
    /CP 'DS\+'\.\s+rv = `"chat_template_kwargs":\{"thinking":` && lv_on && `\}`/.test(lcThinkFrag) &&
    /CP 'QW\+'\.\s+rv = `"chat_template_kwargs":\{"enable_thinking":` && lv_on && `\}`/.test(lcThinkFrag) &&
    /= 'OLLAMA'\.\s+rv = `"think":` && lv_on/.test(lcThinkFrag) && /THEN `true` ELSE `false`/.test(lcThinkFrag));
  check('没配思考的模型请求体不变：片段为空不拼；拼在发送循环之前、请求体最后一个 } 之前',
    /IF lv_frag IS NOT INITIAL\.[\s\S]*?find\( val = lv_body sub = `\}` occ = -1 \)/.test(lcChat) &&
    lcChat.indexOf('think_fragment(') > 0 && lcChat.indexOf('think_fragment(') < lcChat.indexOf('DO 2 TIMES'));
  check('思考字段单独解析（独立 TRY，失败返回空），在正文解析之后；不改正文解析结构 ty_choice',
    /CATCH cx_root\.\s+CLEAR rv\.\s+RETURN\./.test(lcReason) && /reasoning_content/.test(lcReason) && /-thinking/.test(lcReason) &&
    lcChat.indexOf('ev_reasoning = parse_reasoning( lv_resp ).') > lcChat.indexOf('响应 JSON 解析失败') &&
    /BEGIN OF ty_choice,\s+message\s+TYPE ty_message,/.test(lc));
  check('正文开头的 <think>…</think> 拆到思考，且在「空内容」判断之前；只有思考没有回答按失败返回',
    lcChat.indexOf('split_think(') > 0 && lcChat.indexOf('split_think(') < lcChat.indexOf('IF ev_error IS INITIAL AND ev_content IS INITIAL.') &&
    /CHANGING\s+cv_content = ev_content/.test(lcChat) && /IF ev_reasoning IS NOT INITIAL\.\s+ev_error = COND #\( WHEN ev_finish = 'length'/.test(lcChat));
  check('split_think 只认开头的思考块（<think> 前只能是空白）；没有开头标签时只在思考开着才拆',
    /regex = `\\S` \) >= 0\.\s+RETURN\./.test(lcSplit) && /ELSEIF lv_open < 0 AND iv_loose = abap_true\./.test(lcSplit) &&
    /iv_loose\s+= lv_think_on/.test(lcChat));
  check('trim_ws 只去首尾空白、不用正则（ABAP 正则 ^ $ 按行匹配，会吃掉回答里代码的缩进和空行）',
    !/regex/.test(methodOf(lc, 'trim_ws')) && /shift_left\(\s+val = rv sub = \|\\n\| \)/.test(methodOf(lc, 'trim_ws')) &&
    /shift_right\( val = rv sub = \|\\r\| \)/.test(methodOf(lc, 'trim_ws')) && /IF strlen\( rv \) = lv_len\./.test(methodOf(lc, 'trim_ws')));
  check('wrap_think：没有思考原样返回；思考里的 </think> 改掉', /IF iv_reasoning IS INITIAL\.\s+rv = iv_answer\.\s+RETURN\./.test(methodOf(lc, 'wrap_think')) &&
    /sub = `<\/think>` with = `<\/ think>`/.test(methodOf(lc, 'wrap_think')));

  const csRaw = read('ZCL_AI_CHAT_SERVICE.abap'), cs = codeOnly(csRaw);
  const csAnalyze = methodOf(cs, 'analyze');
  const csAppends = csAnalyze.match(/append_msg\([\s\S]*?\)\./g) || [];
  check('CHAT_SERVICE V2.7（分支上为 V2.6）：取 ev_reasoning 放出参 reasoning；落库的两次 append_msg 都不带思考；兜底换模型时清掉思考',
    /^\* V2\.7 20261101\(思考模式/m.test(csRaw) && /ev_reasoning = lv_reasoning/.test(csAnalyze) && /es_result-reasoning\s+= lv_reasoning\./.test(csAnalyze) &&
    csAppends.length === 2 && csAppends.every((x) => !/reasoning/.test(x)) && /CLEAR: lv_content, lv_error, lv_fb_model, lv_reasoning\./.test(csAnalyze) &&
    !/reasoning/.test(methodOf(cs, 'get_history')));

  const agLoop = methodOf(ag, 'analyze_agent');
  check('AGENT_SERVICE V15.9：主循环两处 chat 都取 ev_reasoning；思考交给进度 think(，按轮累计到 reasoning',
    /^\* V15\.9 20261029/m.test(agRaw) && (agLoop.match(/ev_reasoning = lv_llm_think/g) || []).length === 2 &&
    /zcl_ai_agent_progress=>think\( lv_llm_think \)/.test(agLoop) && /es_result-reasoning\s+= lv_think_all\./.test(agLoop));
  check('思考不进上下文 / 不落库：lv_llm_think、lv_think_all 不写进 ls_msg / lt_messages，save_chat 不带思考；协议解析仍用 lv_content',
    !/ls_msg-content\s*=[^.]*lv_(llm_think|think_all)/.test(agLoop) && !/APPEND[^.]*lv_(llm_think|think_all)[^.]*TO lt_messages/.test(agLoop) &&
    (agLoop.match(/save_chat\([\s\S]*?\)\./g) || []).every((x) => !/reasoning|think/.test(x)) &&
    /parse_model_json\(\s+EXPORTING iv_raw\s+= lv_content/.test(agLoop));

  check('PROGRESS V1.1：think 挂到运行中的占位上；带思考的占位不被下一条 Trace 接替（先收口）；单步有上限',
    /^\* V1\.1 20261029/m.test(prRaw) && /think\s+TYPE string/.test(pr) && /gs_hold-think = lv_text\./.test(prM('think')) &&
    /IF gv_hold > 0 AND gs_hold-think IS NOT INITIAL\.\s+close_hold\( \)\./.test(prM('sync')) &&
    /strlen\( lv_text \) > gc_think_max/.test(prM('think')) && /COMMIT CONNECTION \(gc_con\)/.test(prM('think')) &&
    !/COMMIT WORK/.test(prM('think')));

  check('输入框按钮 iv_think：只在模型配了写法时换开关位（X → 1，N → 0），写法不变；空 = 按模型配置',
    /iv_think\s+TYPE string OPTIONAL/.test(lc) &&
    /IF lv_think IS NOT INITIAL AND \( iv_think = 'X' OR iv_think = 'N' \)\.\s+lv_think = substring\( val = lv_think len = 2 \) && COND string\( WHEN iv_think = 'X' THEN `1` ELSE `0` \)\./.test(lcChat) &&
    lcChat.indexOf("iv_think = 'X'") < lcChat.indexOf('lv_think_on'));
  check('iv_think 一路透传：DPC 公共参数读 THINK → analyze / analyze_agent → 三处 Agent 调模型 + 对话调模型',
    /WHEN 'THINK'\.\s+lv_think\s+= to_upper\( ls_param-value \)\./.test(dp) &&
    (dp.match(/iv_think\s+= lv_think/g) || []).length === 2 &&
    /iv_think\s+TYPE string OPTIONAL/.test(cs) && /it_messages\s+= lt_messages\s+iv_think\s+= iv_think/.test(csAnalyze) &&
    /iv_think\s+TYPE string OPTIONAL/.test(ag) && (agLoop.match(/it_messages = lt_messages\s+iv_think\s+= iv_think/g) || []).length === 3);
  const dpThink = dp.match(/wrap_think\(/g) || [];
  check('DPC V15.10：只在出参时拼思考（ANALYZECODE 分支 + to_agent_odata，共 2 处）',
    /^\* V15\.10 20261029/m.test(dpRaw) && dpThink.length === 2 &&
    /ls_result-answer = zcl_ai_llm_client=>wrap_think\( iv_reasoning = ls_result-reasoning/.test(dp) &&
    /rs-answer\s+= zcl_ai_llm_client=>wrap_think\( iv_reasoning = is_agent-reasoning/.test(methodOf(dp, 'to_agent_odata')));
}

// ---------------------------------------------------------------- 15) RFC 函数执行
console.log('\n[15] RFC 函数执行：RFC_EXEC V1.0 / EXEC_SAP V1.2 / SCANNER V1.1 / ZAI_RPT_REG V1.1 / CODE_PROVIDER V1.1');
{
  const rfRaw = read('ZCL_AI_RFC_EXEC.abap');
  const rf = codeOnly(rfRaw);
  const rfM = {};
  (rf.match(/^\s*METHOD\s+\w+\.[\s\S]*?^\s*ENDMETHOD\./gim) || []).forEach((m) => { rfM[m.match(/METHOD\s+(\w+)\./i)[1].toLowerCase()] = m; });
  check('RFC_EXEC 版本头 V1.0 / V1.1、有约定的方法', /^\* V1\.0\s+20261102/m.test(rfRaw) && /^\* V1\.1\s+20261102/m.test(rfRaw) &&
    ['read_interface', 'default_result', 'name_danger', 'scan_source', 'check_writes', 'auth_ok', 'precheck', 'run', 'build_bindings',
      'bind_core', 'invoke', 'run_direct', 'call_sync', 'list_callable', 'tool_description'].every((k) => !!rfM[k]));
  const inv = rfM.invoke || '';
  const iCommit = inv.indexOf('COMMIT WORK.');
  const iCall = inv.indexOf('CALL FUNCTION iv_fm PARAMETER-TABLE it_ptab EXCEPTION-TABLE it_etab.');
  const iRb = inv.indexOf('ROLLBACK WORK.', iCall);
  check('invoke：先 COMMIT（调用方自己的写入）→ 动态调用 → 立刻 ROLLBACK，中间不读结果', iCommit > 0 && iCall > iCommit && iRb > iCall &&
    !/table_to|single_row|return_messages/.test(inv.slice(iCall, iRb)));
  check('run 与 run_direct 都只经 invoke 调函数（不另写 CALL FUNCTION lv_fm）', /invoke\(/.test(rfM.run || '') && /invoke\(/.test(rfM.run_direct || '') &&
    !/CALL FUNCTION lv_fm/.test(rf));
  check('动态调用异常（CX_SY_DYN_CALL_*）也 ROLLBACK 并提示重新登记', /CATCH cx_sy_dyn_call_error INTO DATA\(lx_dyn\)\.\s+ROLLBACK WORK\./.test(inv) && /请重新登记/.test(inv));
  check('RFC_EXEC 不写任何数据库表（登记 / 结果由调用方写）', !/\b(INSERT|UPDATE|MODIFY)\s+(INTO\s+)?z\w+\s+(FROM|SET|VALUES)/i.test(rf) && !/DELETE\s+FROM\s+z/i.test(rf));
  check('参数方向：IMPORTING 用 abap_func_exporting、EXPORTING 用 abap_func_importing、TABLES / CHANGING 对应',
    /WHEN ls_p-kind = 'I' THEN abap_func_exporting ELSE abap_func_changing/.test(rfM.bind_core || '') &&
    /ls_pb-kind\s+= abap_func_importing\./.test(rfM.bind_core || '') && /ls_pb-kind\s+= abap_func_tables\./.test(rfM.bind_core || ''));
  check('例外表：登记的例外 + ERROR_MESSAGE + OTHERS', /ls_eb-name\s+= 'ERROR_MESSAGE'/.test(rfM.bind_core || '') && /ls_eb-name\s+= 'OTHERS'/.test(rfM.bind_core || ''));
  // ---- V1.1 数据分析同步调用（03 方案）
  const cs = rfM.call_sync || '';
  check('call_sync：先查可用清单 + validate_params，再 DESTINATION NONE 调 Z_AI_RFC_RUN，接住 SYSTEM_FAILURE 并关连接',
    cs.indexOf('list_callable( )') > 0 && cs.indexOf('validate_params(') > cs.indexOf('list_callable( )') &&
    cs.indexOf("CALL FUNCTION 'Z_AI_RFC_RUN' DESTINATION 'NONE'") > cs.indexOf('validate_params(') &&
    /system_failure\s+= 1 MESSAGE lv_msg/.test(cs) && /RFC_CONNECTION_CLOSE/.test(cs) && /iv_params_json\s+= ls_pv-norm_json/.test(cs));
  check('run_direct：新会话里再核登记 / 授权 / S_RFC，再绑定调用', /def_lookup\(/.test(rfM.run_direct || '') && /auth_ok\( ls_def-progname \)/.test(rfM.run_direct || '') &&
    /zcl_ai_access=>report_ok\(/.test(rfM.def_lookup || '') && /report_kind[\s\S]*?<> 'FUNC'/.test(rfM.def_lookup || ''));
  check('可用清单：FUNC + 活动 + 开放执行 + EXEC_MODE 不是 JOB + 报表授权；开关 RFC_IN_DATA；同一请求只算一次',
    /WHERE report_kind = 'FUNC' AND active = 'X' AND exec_enabled = 'X'/.test(rfM.list_callable || '') && /= 'JOB'/.test(rfM.list_callable || '') &&
    /zcl_ai_access=>report_ok\(/.test(rfM.list_callable || '') && /data_enabled\( \) = abap_false/.test(rfM.list_callable || '') &&
    /IF gv_loaded = abap_true\./.test(rfM.list_callable || '') && /read_cfg_str\( 'RFC_IN_DATA' \)/.test(rfM.data_enabled || ''));
  check('数据集 JSON 键大写（/ui2/cl_json 不设 pretty_name 直接还原）', /"NAME":/.test(rfM.run_direct || '') && /"COLUMNS":\[/.test(rfM.run_direct || '') &&
    /"ROWS":\[/.test(rfM.run_direct || '') && /"TOTAL_ROWS":/.test(rfM.run_direct || '') && !/pretty_name/i.test(rf));
  check('次数上限 RFC_MAX_EXEC：默认 3、最多 10', /rv = 3\./.test(rfM.max_exec || '') && /rv > 10/.test(rfM.max_exec || '') && /'RFC_MAX_EXEC'/.test(rfM.max_exec || ''));
  const zr = codeOnly(read('Z_AI_RFC_RUN.abap'));
  check('Z_AI_RFC_RUN：只调 run_direct，接口全值传递', /FUNCTION z_ai_rfc_run\./.test(zr) && /zcl_ai_rfc_exec=>run_direct\(/.test(zr) &&
    /VALUE\(IV_REPORT_ID\) TYPE  STRING/.test(read('Z_AI_RFC_RUN.abap')) && /VALUE\(EV_RESULT\) TYPE  STRING/.test(read('Z_AI_RFC_RUN.abap')));
  const agRaw3 = read('ZCL_AI_AGENT_SERVICE.abap');
  const ag3 = codeOnly(agRaw3);
  const iCf = ag3.indexOf('IF ls_out-tool = zcl_ai_tool_registry=>gc_tool_call_func.');
  check('AGENT V15.14：call_function 分支在 sap_data_analysis 之后、扁平 kv 解析之前；次数上限；结果进 lt_datasets', /^\* V15\.14 20261102/m.test(agRaw3) &&
    iCf > ag3.indexOf('IF ls_out-tool = zcl_ai_tool_registry=>gc_tool_data_analysis.') && iCf < ag3.indexOf('zcl_ai_agent_guard=>parse_flat_json(') &&
    /lv_cf_execs > zcl_ai_rfc_exec=>max_exec\( \)/.test(ag3) && /APPEND ls_cf_ds TO lt_datasets\./.test(ag3) &&
    /zcl_ai_agent_guard=>parse_function_call\(/.test(ag3));
  const rgRaw = read('ZCL_AI_TOOL_REGISTRY.abap');
  check('工具注册表 V15.9：没有可用函数时不注册 call_function；DATA 白名单带它', /^\* V15\.9 20261102/m.test(rgRaw) &&
    /DATA\(lv_fn_desc\) = zcl_ai_rfc_exec=>tool_description\( \)\.\s*IF lv_fn_desc IS NOT INITIAL\./.test(rgRaw) &&
    /APPEND gc_tool_call_func\s+TO lt_allow\./.test(rgRaw));
  const mtSrc = fs.readFileSync(path.join(__dirname, 'mock-tools.js'), 'utf8');
  const fixed = ['调用系统里已登记的只读查询函数(秒级出数), 返回统一数据集(表格+图表可用)。', '有现成函数能直接回答时优先用它, 不够再用 run_sql 补查。',
    '带 * 的参数必填, 缺了先问用户; 多值用逗号分隔, 范围写 low,high, 复选框写 X 或空, 日期 YYYYMMDD。', '可用函数: ', '未列出, 知道调用名也可以直接调用',
    '范围 low,high', '多值逗号分隔', 'X/空'];
  check('工具说明 / 参数说明的固定文字：ABAP 与本地 mock-tools.js 一致', fixed.every((t) => rfRaw.indexOf(t) >= 0 && mtSrc.indexOf(t) >= 0),
    fixed.filter((t) => rfRaw.indexOf(t) < 0 || mtSrc.indexOf(t) < 0).join(' | '));
  check('SCANNER V1.1a：函数登记 EXEC_MODE 默认 SYNC（报表仍 JOB；已登记的为空才补）', /^\* V1\.1a\s+20261102/m.test(read('ZCL_AI_RPT_SCANNER.abap')) &&
    /ls_def-exec_mode\s+= COND #\( WHEN lv_kind_new = 'FUNC' THEN 'SYNC' ELSE 'JOB' \)/.test(read('ZCL_AI_RPT_SCANNER.abap')) &&
    /IF ls_def-exec_mode IS INITIAL\.\s+ls_def-exec_mode = 'SYNC'\./.test(read('ZCL_AI_RPT_SCANNER.abap')));
  const gdRaw = read('ZCL_AI_AGENT_GUARD.abap');
  check('GUARD V1.1.6：parse_function_call 只认扁平 params、调用名 4–20 位', /^\* V1\.1\.6 20261102/m.test(gdRaw) &&
    /METHOD parse_function_call\./.test(gdRaw) && /IF lv_in CA '\{\['\./.test(gdRaw) && /strlen\( ev_function \) < 4 OR strlen\( ev_function \) > 20/.test(gdRaw));
  check('S_RFC：先按函数（FUNC）再按函数组（FUGR），活动 16；RFC_AUTH_CHECK = N 关闭',
    /ID 'RFC_TYPE' FIELD 'FUNC'/.test(rfM.auth_ok || '') && /ID 'RFC_TYPE' FIELD 'FUGR'/.test(rfM.auth_ok || '') &&
    /ID 'ACTVT'\s+FIELD '16'/.test(rfM.auth_ok || '') && /read_cfg_str\( 'RFC_AUTH_CHECK' \)/.test(rfM.auth_ok || ''));
  check('逐字符扫描用 string（c 类型 && 拼接会丢空格）', !/TYPE c LENGTH 1/.test((rfM.strip_comment || '') + (rfM.add_target || '')) &&
    /lv_c\s+TYPE string/.test(rfM.strip_comment || ''));
  check('不用 FIND PCRE；类实现里方法之间没有注释', !/PCRE/i.test(rf) && (() => {
    const lines = rfRaw.slice(rfRaw.indexOf('CLASS zcl_ai_rfc_exec IMPLEMENTATION')).split(/\r?\n/);
    let between = false, bad = 0;
    lines.forEach((l) => {
      if (/^\s*ENDMETHOD\./i.test(l)) { between = true; return; }
      if (/^\s*(METHOD\s|ENDCLASS)/i.test(l)) { between = false; return; }
      if (between && l.trim()) { bad++; }
    });
    return bad === 0;
  })());
  // 词表与 JS 参考实现一致
  const js = fs.readFileSync(path.join(__dirname, 'rfc-scan-ref.js'), 'utf8');
  const jsWords = (js.match(/NAME_WORDS = \[([^\]]+)\]/) || [])[1].match(/'(\w+)'/g).map((x) => x.replace(/'/g, ''));
  const abWords = ((rfM.name_danger || '').match(/\( `(\w+)` \)/g) || []).map((x) => x.replace(/[(` )]/g, ''));
  check('函数名疑似词表与 rfc-scan-ref.js 一致', jsWords.join() === abWords.join(), abWords.join() + ' / ' + jsWords.join());
  const delJs = (js.match(/\['ADJACENT'[^\]]+\]/) || [''])[0].match(/'(\w+)'/g).map((x) => x.replace(/'/g, ''));
  check('DELETE 排除词与 JS 参考一致', delJs.every((w) => (rfM.scan_source || '').indexOf('lv_t2 <> `' + w + '`') >= 0), delJs.join());
  check('BLOCK 关键词（COMMIT WORK / UPDATE TASK / BACKGROUND TASK / NEW TASK / BAPI_TRANSACTION_COMMIT）两边都有',
    [' COMMIT WORK ', ' IN UPDATE TASK ', ' IN BACKGROUND TASK ', ' STARTING NEW TASK ', "'BAPI_TRANSACTION_COMMIT'"].every((k) =>
      js.indexOf(k) >= 0 && rfRaw.indexOf(k) >= 0));

  const exRaw2 = read('ZCL_AI_REPORT_EXEC_SAP.abap');
  const ex2 = codeOnly(exRaw2);
  const exM2 = {};
  (ex2.match(/^\s*METHOD\s+\w+\.[\s\S]*?^\s*ENDMETHOD\./gim) || []).forEach((m) => { exM2[m.match(/METHOD\s+(\w+)\./i)[1].toLowerCase()] = m; });
  check('EXEC_SAP V1.2：submit 里 FUNC 强制走运行器、改调 precheck', /^\* V1\.2\s+20261102/m.test(exRaw2) &&
    /lv_func = is_func_run\( iv_report_run_id \)\.\s+IF lv_func = abap_true\.\s+lv_legacy = abap_false\./.test(exM2.submit || '') &&
    /zcl_ai_rfc_exec=>precheck\(/.test(exM2.submit || ''));
  const rc = exM2.run_captured || '';
  check('run_captured：登记核验多取 report_kind / result_ref；FUNC → zcl_ai_rfc_exec=>run，否则照旧 ALV 采集',
    /SELECT SINGLE progname, report_kind, result_ref FROM zai_rpt_def/.test(rc) && /zcl_ai_rfc_exec=>run\(/.test(rc) &&
    /zcl_ai_alv_capture=>run\(/.test(rc) && rc.indexOf('zcl_ai_rfc_exec=>run(') < rc.indexOf('zcl_ai_alv_capture=>run('));
  check('元数据行 columns 仍是最后一个键（read_result 按它截取）', /lv_meta = lv_meta && ',"columns":\[' && lv_cols && '\]\}'\./.test(rc) &&
    rc.indexOf(`',"outputs":'`) < rc.indexOf(`',"columns":['`));

  const scRaw2 = read('ZCL_AI_RPT_SCANNER.abap');
  const sc2 = codeOnly(scRaw2);
  const scM2 = {};
  (sc2.match(/^\s*METHOD\s+\w+\.[\s\S]*?^\s*ENDMETHOD\./gim) || []).forEach((m) => { scM2[m.match(/METHOD\s+(\w+)\./i)[1].toLowerCase()] = m; });
  const sf = scM2.scan_function || '';
  check('SCANNER V1.1：scan_function 读接口 + 写入类检查；BLOCK 不能登记，NAME 要强制', /^\* V1\.1\s+20261102/m.test(scRaw2) &&
    /zcl_ai_rfc_exec=>read_interface\(/.test(sf) && /zcl_ai_rfc_exec=>check_writes\( lv_fm \)/.test(sf) &&
    /IF lv_block = abap_true AND rs-error IS INITIAL\./.test(sf) && /lv_namehit = abap_true AND iv_force = abap_false/.test(sf));
  check('调用名规则：Z 开头、4–20 位、只含 A-Z 0-9 _', /strlen\( lv_tc \) > 20 OR strlen\( lv_tc \) < 4 OR lv_first <> 'Z'/.test(sf) &&
    /lv_tc CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'/.test(sf));
  const sv = scM2.save || '';
  check('save：报表 ↔ 函数互不覆盖的检查在写参数之前；新登记按草稿写 REPORT_KIND / RESULT_REF',
    sv.indexOf('lv_kind_cmp <> lv_kind_chk') > 0 && sv.indexOf('lv_kind_cmp <> lv_kind_chk') < sv.indexOf('INSERT zai_rpt_param') &&
    /ls_def-report_kind\s+= lv_kind_new\./.test(sv) && /ls_def-result_ref\s+= is_draft-result_ref\./.test(sv));
  const reg2 = codeOnly(read('ZAI_RPT_REG.abap'));
  check('ZAI_RPT_REG V1.1：S_FUNC → scan_function；主结果 / 强制只对单个函数生效', /SELECT-OPTIONS s_func FOR gv_func NO INTERVALS/.test(reg2) &&
    /zcl_ai_rpt_scanner=>scan_function\(/.test(reg2) && /CLEAR: lv_alias, lv_res\./.test(reg2));

  const cpRaw = read('ZCL_AI_CODE_PROVIDER.abap');
  const cp = codeOnly(cpRaw);
  check('CODE_PROVIDER V1.1：detect_objtype 查 TFDIR、get_source 有 FUNC 分支、function_include 支持命名空间',
    /^\* V1\.1\s+20261102/m.test(cpRaw) && /WHEN 'FUNC'\./.test(cp) && /SELECT SINGLE funcname FROM tfdir/.test(cp) &&
    /FIND 'SAPL' IN lv_p MATCH OFFSET lv_off/.test(cp));
}

console.log('\n[16] 参数卡搜索帮助：VALUE_HELP V1.0 / SCANNER V1.2 / DPC V15.13');
{
  const vhRaw = read('ZCL_AI_VALUE_HELP.abap');
  const vh = codeOnly(vhRaw);
  const vhM = {};
  (vh.match(/^\s*METHOD\s+\w+\.[\s\S]*?^\s*ENDMETHOD\./gim) || []).forEach((m) => { vhM[m.match(/METHOD\s+(\w+)\./i)[1].toLowerCase()] = m; });
  check('VALUE_HELP 版本头 V1.0、有约定的方法', /^\* V1\.0\s+20261103/m.test(vhRaw) &&
    ['meta', 'search', 'search_ref', 'has_help', 'report_refs', 'access_error', 'resolve', 'by_fixed', 'get_shlp', 'by_shlp',
      'shlp_select', 'by_check', 'fill_items', 'like_pat'].every((k) => !!vhM[k]));
  check('VALUE_HELP 源码行不超过 255 字符、没有 FIND PCRE', vhRaw.split('\n').every((l) => l.length <= 255) && !/FIND\s+PCRE/i.test(vh));
  check('取值顺序：固定值 → 搜索帮助 → 检查表（前一个取到就停）', (() => {
    const sr = vhM.search_ref || '';
    const a = sr.indexOf('by_fixed('), b = sr.indexOf('by_shlp('), c = sr.indexOf('by_check(');
    return a > 0 && b > a && c > b && /IF rs-source IS INITIAL\.\s+by_shlp/.test(sr) && /IF rs-source IS INITIAL\.\s+by_check/.test(sr);
  })());
  check('F4IF_SELECT_VALUES 不调搜索帮助出口；所有 F4IF_* 调用都接住 CX_SY_DYN_CALL_ERROR',
    /call_shlp_exit = ' '/.test(vhM.shlp_select || '') &&
    (vh.match(/CALL FUNCTION 'F4IF_/g) || []).length === 5 && (vh.match(/CATCH cx_sy_dyn_call_error/g) || []).length >= 6);
  check('关键字转义后才进动态 WHERE（# % _ 与单引号），检查表读取接住动态 SQL 异常',
    /REPLACE ALL OCCURRENCES OF '%' IN lv WITH '#%'/.test(vhM.like_pat || '') && /cl_abap_dyn_prg=>escape_quotes\( lv \)/.test(vhM.like_pat || '') &&
    /ESCAPE '#'/.test(vhM.by_check || '') && /CATCH cx_sy_dynamic_osql_error cx_sy_open_sql_db INTO DATA\(lx\)/.test(vhM.by_check || ''));
  check('表名 / 字段只从登记 + 字典推出（search 不接受前端传表名）', !/iv_tab|iv_table/i.test(vhM.search || '') &&
    /READ TABLE lt_refs INTO DATA\(ls_ref\) WITH KEY param_id = lv_pid/.test(vhM.search || ''));
  check('权限：登记必须活动；报表授权动态调 ZCL_AI_ACCESS（类不存在跳过）', /active = 'X'/.test(vhM.access_error || '') &&
    /CALL METHOD \('ZCL_AI_ACCESS'\)=>\('REPORT_OK'\)/.test(vhM.access_error || ''));
  check('REF_FIELD 列按名动态读；老登记现场取（函数 FUPARAREF / 报表 scan）', /lv_rcols TYPE string VALUE `PARAM_ID, REF_FIELD`/.test(vhM.report_refs || '') &&
    /FROM fupararef/.test(vhM.report_refs || '') && /zcl_ai_rpt_scanner=>scan\(/.test(vhM.report_refs || ''));
  check('VALUE_HELP 不写任何数据库表', !/\b(INSERT|UPDATE|MODIFY)\s+(INTO\s+)?\w+\s+(FROM|SET|VALUES)/i.test(vh) && !/DELETE\s+FROM/i.test(vh));

  const scRaw3 = read('ZCL_AI_RPT_SCANNER.abap');
  const sc3 = codeOnly(scRaw3);
  check('SCANNER V1.2：ty_param 有 ref_field、build_rows 经 deref 填、函数填接口类型、save 按名写 REF_FIELD',
    /^\* V1\.2\s+20261103/m.test(scRaw3) && /ref_field\s+TYPE string/.test(sc3) && /ls_r-ref_field = deref\( ls_d-ref \)\./.test(sc3) &&
    /ls_r-ref_field\s+= to_upper\( condense\( ls_ip-type_name \) \)\./.test(sc3) && /ASSIGN COMPONENT 'REF_FIELD' OF STRUCTURE ls_db TO <lv_ref>\./.test(sc3) &&
    /METHOD deref\./.test(sc3));
  check('SCANNER 源码行不超过 255 字符', scRaw3.split('\n').every((l) => l.length <= 255));

  const dpRaw = read('ZCL_ZAI_CHAT_DPC_EXT.abap');
  const dp = codeOnly(dpRaw);
  check('DPC V15.13：VALUEHELP 分支 ParamId 空 = meta、有值 = search，经 auth_reply 返回', /^\* V15\.13\s+20261103/m.test(dpRaw) &&
    /WHEN 'VALUEHELP'\./.test(dp) && /zcl_ai_value_help=>meta\(/.test(dp) && /zcl_ai_value_help=>search\(/.test(dp) &&
    /iv_name = 'Query'/.test(dp));
}

console.log('\n[17] 函数表参数粘贴数据：RFC_EXEC V1.2 / SCANNER V1.3 / REG V1.2 / REPORT_SERVICE V1.0.17 / VALUE_HELP V1.1 / DPC V15.14');
{
  const ref = require('./rfc-scan-ref.js');
  const methodsOf = (code) => {
    const m = {};
    (code.match(/^\s*METHOD\s+\w+\.[\s\S]*?^\s*ENDMETHOD\./gim) || []).forEach((x) => { m[x.match(/METHOD\s+(\w+)\./i)[1].toLowerCase()] = x; });
    return m;
  };
  const rfRaw = read('ZCL_AI_RFC_EXEC.abap');
  const rf = codeOnly(rfRaw);
  const rfM = methodsOf(rf);
  check('RFC_EXEC V1.2：版本头、新方法齐全、源码行不超过 255', /^\* V1\.2\s+20261104/m.test(rfRaw) &&
    ['parse_rows', 'fill_table', 'table_columns', 'table_input_name', 'flat_cols'].every((k) => !!rfM[k]) &&
    rfRaw.split('\n').every((l) => l.length <= 255));
  check('TABLES 当输入的名字规则：ABAP 与 rfc-scan-ref.js 同一条正则', /FIND REGEX '\^\(IT\|I\|IN\|INPUT\)_\|\^T_IN' IN lv\./.test(rfM.table_input_name || '') &&
    /\^\(IT\|I\|IN\|INPUT\)_\|\^T_IN/.test(ref.tableInputName.toString()));
  check('行数上限 1000：ABAP 常量、JS 参考、前端 AskCard 一致', /gc_tbl_max_rows\s+TYPE i VALUE 1000/.test(rf) &&
    /TBL_MAX_ROWS = 1000/.test(fs.readFileSync(path.join(__dirname, '../webapp/utils/AskCard.js'), 'utf8')) && /maxRows \|\| 1000/.test(ref.parseRows.toString()));
  check('parse_rows：只用找单个字符的 FIND（不做长串正则）；\\u 用 uccp 还原', !/FIND ALL OCCURRENCES/.test(rfM.parse_rows || '') &&
    /FIND FIRST OCCURRENCE OF REGEX '\["\\\\\]' IN SECTION OFFSET lv_i OF iv_json/.test(rfM.parse_rows || '') &&
    /cl_abap_conv_in_ce=>uccp\( lv_hex \)/.test(rfM.parse_rows || ''));
  check('parse_rows 错误文字与 JS 参考一致', ['表数据里有没闭合的引号', '表数据不完整(行没有结尾的 ])', '请分批'].every((t) =>
    (rfM.parse_rows || '').indexOf(t) >= 0 && ref.parseRows.toString().indexOf(t) >= 0));
  const fl = rfM.fill_table || '';
  check('fill_table：按表头 ASSIGN COMPONENT 对字段、逐格 set_value、数字列去千分位、结构只收一行',
    /ASSIGN COMPONENT lv_h OF STRUCTURE <ls> TO <lv>\./.test(fl) && /set_value\( EXPORTING iv_val = lv_cell/.test(fl) &&
    /type_kind CA 'PIbs8Fae'/.test(fl) && /只能填一行/.test(fl) && /第 \{ lv_rowno \} 行 \{ lv_f \}: \{ lv_err \}/.test(fl));
  check('bind_core：IMPORTING / CHANGING 的表 / 结构与 TABLES 表参数都走 fill_table', /WHEN 'STRUCT' OR 'TABLE'\.\s+(" [^\n]*\n\s+)?fill_table\(/.test(rfM.bind_core || '') &&
    /ls_p-shape = 'TABLE' AND lv_kind = 'T'\.\s+fill_table\(/.test(rfM.bind_core || ''));
  check('classify 算 cols（行展开 include 后全是单值字段）；default_result 跳过当输入的 TABLES 表',
    /cs_p-cols = flat_cols\( lo_sd \)\./.test(rfM.classify || '') && /get_included_view\( \)/.test(rfM.flat_cols || '') &&
    /table_input_name\( ls_p-name \) = abap_true/.test(rfM.default_result || ''));
  check('list_callable：有必填表参数的函数不进数据分析、说明里不列表参数', /line_exists\( lt_par\[ sel_kind = 'T' required = abap_true \] \)/.test(rfM.list_callable || '') &&
    /DELETE lt_par WHERE sel_kind = 'T'\./.test(rfM.list_callable || ''));

  const scRaw = read('ZCL_AI_RPT_SCANNER.abap');
  const scM = methodsOf(codeOnly(scRaw));
  const sf = scM.scan_function || '';
  check('SCANNER V1.3：表 / 扁平结构 → T / TABLE，表 = 多行；TABLES 按名字或点名当输入', /^\* V1\.3\s+20261104/m.test(scRaw) &&
    /ls_r-sel_kind\s+= 'T'\./.test(sf) && /ls_r-data_type\s+= 'TABLE'\./.test(sf) && /ls_r-multi_value = xsdbool\( ls_ip-shape = 'TABLE' \)\./.test(sf) &&
    /table_input_name\( iv_name = ls_ip-name it_tin = lt_tin \)/.test(sf) && scRaw.split('\n').every((l) => l.length <= 255));
  const reg = codeOnly(read('ZAI_RPT_REG.abap'));
  check('ZAI_RPT_REG V1.2：S_TIN 传给 scan_function', /SELECT-OPTIONS s_tin FOR gv_tin NO INTERVALS/.test(reg) && /it_tin\s+= names\( s_tin\[\] \)/.test(reg));

  const rsRaw = read('ZCL_AI_REPORT_SERVICE.abap');
  const rsM = methodsOf(codeOnly(rsRaw));
  check('REPORT_SERVICE V1.0.17：parse_flat_kv 不再用长正则（只找单个字符）', /^\* V1\.0\.17\s+20261104/m.test(rsRaw) &&
    !/FIND ALL OCCURRENCES OF REGEX/.test(rsM.parse_flat_kv || '') && /json_unescape\( lv_raw \)/.test(rsM.parse_flat_kv || '') &&
    rsRaw.split('\n').every((l) => l.length <= 255));
  const vp = rsM.validate_params || '';
  check('validate_params：表参数先于复选框分支处理，必填 / 形状 / 长度，原样进快照', vp.indexOf("IF ls_p-sel_kind = 'T'.") > 0 &&
    vp.indexOf("IF ls_p-sel_kind = 'T'.") < vp.indexOf("IF ls_p-sel_kind = 'C'.") && /lc_tbl_max TYPE i VALUE 400000/.test(vp) &&
    /APPEND VALUE #\( name = to_lower\( ls_p-param_id \) value = lv_tv \) TO lt_norm\./.test(vp));

  const vh = codeOnly(read('ZCL_AI_VALUE_HELP.abap'));
  check('VALUE_HELP V1.1：元数据给表参数带 columns', /columns\s+TYPE zcl_ai_rfc_exec=>tt_tcol/.test(vh) && /zcl_ai_rfc_exec=>table_columns\( ls_ref-ref \)/.test(vh));
  const dp = codeOnly(read('ZCL_ZAI_CHAT_DPC_EXT.abap'));
  check('DPC V15.14：StartReportRun 的 ParamsJson 是长文本引用时换回原文', /IF lv_srun_pj CP '@@ZAI_TEXT:\*'\.\s+lv_srun_pj = resolve_text\( lv_srun_pj \)\./.test(dp) &&
    /iv_params_json = lv_srun_pj/.test(dp));
}


// ---------------------------------------------------------------- 18) 11.4 报表结果全量分析
console.log('\n[18] 11.4 报表结果全量分析：RESULT_QUERY V1.0 / AGENT_SERVICE V15.15 / COMBO V1.0.2 / REGISTRY V15.10 / ROUTER V1.0.7');
{
  const methodsOf = (code) => {
    const m = {};
    (code.match(/^\s*METHOD\s+\w+\.[\s\S]*?^\s*ENDMETHOD\./gim) || []).forEach((x) => { m[x.match(/METHOD\s+(\w+)\./i)[1].toLowerCase()] = x; });
    return m;
  };
  const rqRaw = read('ZCL_AI_RESULT_QUERY.abap'), rq = codeOnly(rqRaw), rqM = methodsOf(rq);
  check('RESULT_QUERY V1.0：版本头、方法齐全、源码行不超过 255', /^\* V1\.0\s+20261104/m.test(rqRaw) &&
    ['enabled', 'tool_description', 'context', 'run', 'load', 'parse_query', 'execute', 'sort_rows', 'row_pass', 'compare'].every((k) => rqM[k]) &&
    rqRaw.split('\n').every((l) => l.length <= 255));
  check('RESULT_QUERY：读全量走 COMBO load_result（报表执行不要求 ANALYZE_ENABLED），同一请求按结果号缓存',
    /zcl_ai_combo_service=>load_result\(/.test(rqM.load || '') && /iv_need_analyze TYPE abap_bool DEFAULT abap_false/.test(rq) &&
    /lv_art = gv_cache_art AND gv_cache_art IS NOT INITIAL/.test(rqM.load || '') && /'REPORT_RESULT'[\s\S]*'FIORI_RESULT'/.test(rqM.load || ''));
  check('context：行数少给全部明细；多则 compute_stats + group_json + 主要数值列全量排序的最大 / 最小行',
    /ev_all\s+= abap_true\./.test(rqM.context || '') && /compute_stats\( ls_ds \)/.test(rqM.context || '') &&
    /zcl_ai_combo_service=>group_json\(/.test(rqM.context || '') && /main_measure\( ls_ds \)/.test(rqM.context || '') &&
    /iv_desc = abap_true[\s\S]*iv_desc = abap_false/.test(rqM.context || ''));
  check('execute：筛选 → 明细排序取前 N / 分组聚合（sum avg max min count count_distinct），排序可按聚合的原列名',
    ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'COUNT_DISTINCT'].every((a) => (rqM.execute || '').indexOf("'" + a + "'") > 0) &&
    /row_pass\( is_row = ls_row it_filters = is_q-filters \)/.test(rqM.execute || '') &&
    /LOOP AT is_q-metrics INTO ls_m WHERE ci = lv_src_ci\./.test(rqM.execute || '') && /DELETE es_out-rows FROM is_q-limit \+ 1\./.test(rqM.execute || ''));
  check('parse_query：列名或标题都认；错列名回可用列清单；limit 受 RESULT_QUERY_MAX_OUT 约束',
    /norm\( ls_c-name \) = lv_n[\s\S]*norm\( ls_c-label \) = lv_n/.test(rqM.find_col || '') && /可用的列: \{ col_list\( is_ds \) \}/.test(rqM.parse_query || '') &&
    /'RESULT_QUERY_MAX_OUT'/.test(rqM.parse_query || ''));
  check('V1.0.1 翻页：offset 解析；明细 / 分组都先跳过 offset 再取 limit；返回 total / more / next_offset',
    /^\* V1\.0\.1\s+20261104/m.test(rqRaw) && /offset\s+TYPE i/.test(rq) && /iv_name = 'offset'/.test(rqM.parse_query || '') &&
    /IF sy-tabix <= is_q-offset\.\s*CONTINUE\./.test(rqM.execute || '') && /DELETE es_out-rows FROM 1 TO lv_skip\./.test(rqM.execute || '') &&
    /"next_offset":/.test(rqM.run || '') && /"more":/.test(rqM.run || '') && /"total":\{ ls_out-total \}/.test(rqM.run || ''));
  check('V1.0.1 翻页不漏行：一页放不进回填上限时按 rows_sent 缩页，next_offset 按缩后的行数算',
    /FIND REGEX '"rows_sent":\(\[0-9\]\+\)' IN lv_dsj SUBMATCHES lv_sent\./.test(rqM.run || '') &&
    /DELETE es_ds-rows FROM lv_keep \+ 1\./.test(rqM.run || '') && /lv_next\) = ls_q-offset \+ lv_ret\./.test(rqM.run || ''));
  check('run：失败也回 ok:false + 原因；成功回 rows_scanned / rows_matched + 数据集（GUARD 上限内）',
    /"ok":false/.test(rqM.run || '') && /"rows_scanned":/.test(rqM.run || '') && /gc_max_result_chars - 1000/.test(rqM.run || ''));

  const cbRaw = read('ZCL_AI_COMBO_SERVICE.abap'), cb = codeOnly(cbRaw);
  const cbPub = (cb.match(/PUBLIC SECTION\.([\s\S]*?)PRIVATE SECTION\./) || ['', ''])[1];
  check('COMBO V1.0.2：load_result / auto_group / group_json / to_num / num_out 在公共区；ANALYZE_ENABLED 只在 iv_need_analyze = X 时要求',
    /^\* V1\.0\.2\s+20261104/m.test(cbRaw) && ['load_result', 'auto_group', 'group_json', 'to_num', 'num_out'].every((k) => new RegExp('CLASS-METHODS ' + k + '\\b').test(cbPub)) &&
    /IF lv_an <> 'X' AND iv_need_analyze = abap_true\./.test(cb) && /iv_need_analyze = iv_need_analyze/.test(cb));

  const trRaw2 = read('ZCL_AI_TOOL_REGISTRY.abap'), tr2 = codeOnly(trRaw2);
  const allow = (tr2.match(/METHOD get_tools_for_module\.[\s\S]*?ENDMETHOD\./) || [''])[0];
  check('REGISTRY V15.10：注册 query_result（开关控制），不进任何模块白名单', /zcl_ai_result_query=>tool_description\( \)/.test(tr2) &&
    /IF zcl_ai_result_query=>enabled\( \) = abap_true\./.test(tr2) && !/result_query/.test(allow));

  const agRaw2 = read('ZCL_AI_AGENT_SERVICE.abap'), ag2 = codeOnly(agRaw2);
  const bac = (ag2.match(/METHOD build_artifact_ctx\.[\s\S]*?ENDMETHOD\./) || [''])[0];
  check('AGENT V15.15：build_artifact_ctx 用 RESULT_QUERY=>context，不再按 gc_art_chars 截断', /^\* V15\.15 20261104/m.test(agRaw2) &&
    /zcl_ai_result_query=>context\(/.test(bac) && !/gc_art_chars/.test(bac) && /ev_all\s+= ev_all/.test(bac));
  check('AGENT：三处 build_artifact_ctx 都取 ev_all 并记下 lv_art_id；Fiori 分析记 ls_fturn-artifact_id',
    (ag2.match(/ev_all\s+= lv_art_all/g) || []).length === 3 && (ag2.match(/lv_art_id = (iv_focus_artifact_id|lv_art_latest)\./g) || []).length === 3 &&
    /lv_art_id\s+= ls_fturn-artifact_id\./.test(ag2));
  check('AGENT：query_result 在技能过滤之后加入；提示词白名单同步（iv_result_query = lv_rq_on）',
    /filter_tools\( EXPORTING is_skill = ls_skill CHANGING ct_tools = lt_allowed_tools \)\.[\s\S]{0,400}DATA\(lv_rq_on\)/.test(ag2) &&
    /iv_result_query = lv_rq_on/.test(ag2) && /ELSEIF ls_tool-tool_id = zcl_ai_result_query=>gc_tool\./.test(ag2));
  check('AGENT：query_result 分支在扁平 kv 之前，结果号用 lv_art_id，数据集进 lt_datasets',
    ag2.indexOf('IF ls_out-tool = zcl_ai_result_query=>gc_tool.') > 0 &&
    ag2.indexOf('IF ls_out-tool = zcl_ai_result_query=>gc_tool.') < ag2.indexOf('zcl_ai_agent_guard=>parse_flat_json(') &&
    /iv_artifact_id = lv_art_id/.test(ag2) && /APPEND ls_rq_ds TO lt_datasets\./.test(ag2));

  const rtRaw = read('ZCL_AI_INTENT_ROUTER.abap'), rt = codeOnly(rtRaw);
  check('ROUTER V1.0.7：规则 4b 认「这张报表的数据」；报表场景库存类问题有结果时按结果追问',
    /^\* V1\.0\.7\s+20261104/m.test(rtRaw) && /这张\|这批/.test(rt) && /\(报表\|运行\)的\?\(结果\|数据\)/.test(rt) &&
    /AND zcl_ai_report_service=>find_latest_artifact\( iv_session_id = iv_session_id \) IS NOT INITIAL\./.test(rt));
  // 规则 4b 正则在 JS 里等价验证(ABAP POSIX 正则这里的写法与 JS 一致)
  const re4b = /(这个|这份|这张|这批|这些|这次|本次|该|此|上面|上述|刚才|刚刚|前面|以上)的?(报表)?的?(运行)?的?(结果|数据)/;
  check('规则 4b 正则：「分析一下这张报表的数据」「这张报表的结果」「上面的数据」命中', ['分析一下这张报表的数据，并看下库存最高的前10项料号', '这张报表的结果', '上面的数据哪个工厂最多'].every((q) => re4b.test(q)));
}


// ---------------------------------------------------------------- 19) 定时任务
console.log('\n[19] 定时任务：SCHEDULE_SERVICE V1.0 / ZAI_SCHED_RUNNER / DPC V15.15');
{
  const methodsOf = (code) => {
    const m = {};
    (code.match(/^\s*METHOD\s+\w+\.[\s\S]*?^\s*ENDMETHOD\./gim) || []).forEach((x) => { m[x.match(/METHOD\s+(\w+)\./i)[1].toLowerCase()] = x; });
    return m;
  };
  const scRaw = read('ZCL_AI_SCHEDULE_SERVICE.abap'), sc = codeOnly(scRaw), scM = methodsOf(sc);
  check('SCHEDULE_SERVICE V1.0：版本头、方法齐全、源码行不超过 255', /^\* V1\.0\s+20261104/m.test(scRaw) &&
    ['save_sched', 'get_list', 'do_action', 'get_runs', 'run_one', 'resolve_params', 'resolve_token', 'due_on', 'next_run',
      'create_job', 'create_jobs', 'drop_jobs', 'merge_dates', 'source_of_artifact', 'param_views', 'log_run'].every((k) => scM[k]) &&
    scRaw.split('\n').every((l) => l.length <= 255));
  check('UPDATE … SET 里不用宿主表达式 @( )（7.50 兼容，统一用宿主变量）',
    !/UPDATE\s+\w+\s+SET[^.]*@\(/.test(sc));
  check('不直接 LOOP AT 方法调用结果；不用 GET RUN TIME（长等待会溢出）', !/LOOP AT \w+\( /.test(sc) && !/GET RUN TIME/.test(sc));
  check('作业：以当前用户建周期作业（PRDDAYS / PRDHOURS），步骤按名字动态 SUBMIT ZAI_SCHED_RUNNER',
    /prddays\s+= lv_days/.test(scM.create_job || '') && /prdhours\s+= lv_hours/.test(scM.create_job || '') &&
    /lv_prog = 'ZAI_SCHED_RUNNER'/.test(scM.create_job || '') && /SUBMIT \(lv_prog\)/.test(scM.create_job || ''));
  check('没有释放权限（job_was_released 空）→ 删作业并如实说明', /lv_rel <> 'X'/.test(scM.create_job || '') &&
    /BP_JOB_DELETE/.test(scM.create_job || '') && /S_BTCH_JOB RELE/.test(scM.create_job || ''));
  check('run_one：只跑本人的定时任务；暂停 / 管理员停用 / 今天不该跑 → 直接结束',
    /ls_db-owner <> sy-uname/.test(scM.run_one || '') && /ls_db-status = 'ADMIN_STOP'/.test(scM.run_one || '') &&
    /due_on\( is_trig = ls_trig iv_date = sy-datum \) = abap_false/.test(scM.run_one || ''));
  check('run_one：防重叠（running_since）、场景再核一遍、报表按保存的参数换算后提交（D5：不由模型定参数）',
    /running_since IS NOT INITIAL/.test(scM.run_one || '') && /zcl_ai_access=>scene_ok\(/.test(scM.run_one || '') &&
    /iv_params_json = ls_run-params_used/.test(scM.run_one || '') && /resolve_params\( iv_json = CONV string\( ls_db-params_json \)/.test(scM.run_one || ''));
  check('run_one：报表执行轮询 get_run_status（等待上限 SCHED_WAIT_MIN），Fiori 同步 run 并在有指令时置 ANALYZED',
    /WAIT UP TO 15 SECONDS/.test(scM.run_one || '') && /zcl_ai_report_service=>get_run_status\(/.test(scM.run_one || '') &&
    /'SCHED_WAIT_MIN'/.test(scM.run_one || '') && /zcl_ai_fiori_report_service=>run\(/.test(scM.run_one || '') &&
    /UPDATE zai_frpt_run SET analyzed = 'X'/.test(scM.run_one || ''));
  check('run_one：有指令 → analyze_agent（聚焦本次结果），失败记 ANALYZE_ERR；写运行记录与上次运行时间',
    /zcl_ai_agent_service=>analyze_agent\(/.test(scM.run_one || '') && /iv_focus_artifact_id = lv_art/.test(scM.run_one || '') &&
    /'ANALYZE_ERR'/.test(scM.run_one || '') && /log_run\( is_db = ls_db is_run = ls_run \)/.test(scM.run_one || '') &&
    /last_run_at\s+= @ls_run-started_at/.test(scM.run_one || ''));
  const sv = scM.save_sched || '';
  check('save_sched：开关 / 用户开通 / 名称 / 指令或数据来源至少一个 / 触发校验 / 每人上限',
    /enabled\( \) = abap_false/.test(sv) && /user_ok\( \) = abap_false/.test(sv) && /请填写名称/.test(sv) &&
    /指令和数据来源至少要有一个/.test(sv) && /parse_triggers\(/.test(sv) && /'SCHED_MAX_PER_USER'/.test(sv));
  check('save_sched：没有数据来源时场景只能 自动 / 数据分析 / 代码分析；有来源时场景跟随来源（D5）',
    /lv_scene = lv_src\./.test(sv) && /lv_scene <> 'AUTO' AND lv_scene <> 'DATA' AND lv_scene <> 'CODE'/.test(sv));
  check('save_sched：数据来源只能来自本人的成功结果（source_of_artifact），参数只认日期（merge_dates），报表按今天换算后预校验',
    /source_of_artifact\(/.test(sv) && /merge_dates\(/.test(sv) && /zcl_ai_report_service=>validate_params\(/.test(sv) &&
    /report_ok\( iv_src_type = lv_src/.test(sv) && /ls_view-data_type <> 'DATE'/.test(scM.merge_dates || ''));
  check('save_sched：新建建专属会话（AGENT）与任务；修改先删旧作业；状态 ACTIVE 才建作业，失败回滚',
    /INSERT zai_chat_sess FROM/.test(sv) && /session_mode = 'AGENT'/.test(sv) && /zcl_ai_task_service=>pick_or_create\(/.test(sv) &&
    /drop_jobs\( CONV string\( lv_id \) \)/.test(sv) && /create_jobs\(/.test(sv) && /DELETE FROM zai_schedule WHERE sched_id = @lv_id/.test(sv));
  const da = scM.do_action || '';
  check('do_action：PREFILL / PAUSE / RESUME / DELETE / RUNNOW / SEEN / ADMIN_STOP / ADMIN_RESUME；停用只有管理员，其余只认本人',
    ['PREFILL', 'PAUSE', 'RESUME', 'DELETE', 'RUNNOW', 'SEEN', 'ADMIN_STOP', 'ADMIN_RESUME'].every((a) => da.indexOf("'" + a + "'") >= 0) &&
    /rs-is_admin = abap_false/.test(da) && /ls_db-owner <> sy-uname/.test(da));
  check('resolve_token：认 @TODAY / @TODAY-N（1-366）/ @WEEK_START / @MONTH_START / @MONTH_END / @LMONTH_START / @LMONTH_END / @YEAR_START',
    ['@TODAY', '@WEEK_START', '@MONTH_START', '@MONTH_END', '@LMONTH_START', '@LMONTH_END', '@YEAR_START', '@TODAY-'].every((t) => (scM.resolve_token || '').indexOf("'" + t + "'") >= 0) &&
    /BETWEEN 1 AND 366/.test(scM.resolve_token || ''));
  check('星期基准 1900-01-01（周一），秒数基准 2020-01-01（不溢出）', /VALUE '19000101'/.test(scM.weekday || '') && /gc_base_date TYPE d VALUE '20200101'/.test(sc));
  check('运行记录只留最近 SCHED_KEEP_RUNS 条', /'SCHED_KEEP_RUNS'/.test(scM.log_run || '') && /DELETE zai_sched_run FROM TABLE @lt_old/.test(scM.log_run || ''));

  const rn = codeOnly(read('ZAI_SCHED_RUNNER.abap'));
  check('ZAI_SCHED_RUNNER：参数 P_SCHED / P_TRIG，只调 run_one', /PARAMETERS: p_sched TYPE c LENGTH 32 OBLIGATORY/.test(rn) &&
    /p_trig\s+TYPE c LENGTH 1/.test(rn) && /zcl_ai_schedule_service=>run_one\(/.test(rn) && !/SUBMIT|CALL FUNCTION/.test(rn));

  const dpRaw2 = read('ZCL_ZAI_CHAT_DPC_EXT.abap'), dp2 = codeOnly(dpRaw2);
  check('DPC V15.15：四个分支，ScheduleJson 长文本换回原文，经 auth_reply 返回', /^\* V15\.15 20261104/m.test(dpRaw2) &&
    ["'SCHEDULESAVE'", "'SCHEDULELIST'", "'SCHEDULEACTION'", "'SCHEDULERUNS'"].every((w) => dp2.indexOf('WHEN ' + w) >= 0) &&
    /lv_sc_json = resolve_text\( lv_sc_json \)/.test(dp2) && /zcl_ai_schedule_service=>save_sched\(/.test(dp2) &&
    /iv_error = ls_scr-error/.test(dp2));
}

console.log('\n' + (fail === 0 ? '全部通过: ' + pass + ' 项' : '失败: ' + fail + ' 项 / 通过: ' + pass + ' 项'));
process.exit(fail === 0 ? 0 : 1);
