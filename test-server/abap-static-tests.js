/**
 * ABAP 源码静态检查（无 SAP、无网络）—— 部署前把"在 SAP 上才会炸"的低级错误拦在本地
 * 运行: node abap-static-tests.js   （或 npm run test:abap）
 *
 * 覆盖：
 *   1) ZAI_CHAT_CFG 配置键 ≤ 20 字符（CFGKEY 是 CHAR 20；超长键 OPEN SQL 直接抛
 *      CX_SY_OPEN_SQL_DATA_ERROR → 网关 500。10-22 部署实锤：REPORT_CAPTURE_LEGACY 21 字符）
 *   2) Fiori 取数通道（ZCL_AI_ODATA_CLIENT V1.3 + Z_AI_ODATA_GET）：默认走 RFC 新会话、
 *      不再有 URL 通道、现场 DPC 捕获块调用的两个空壳方法还在、函数模块接口与调用一致
 *   3) 权限自助申请（ZCL_AI_AUTH_SERVICE V1.3，20261024）：读写目标表 / 规则映射表只在约定的方法里；USER_ADDR 只在 fill_user_info；
 *      DPC 每个权限 FI 读的参数 = 前端恒发的参数清单（SAP 上 FI 参数全必填）
 *   4) 报表选择项（10.24 记录 #03a）：REPORT_SERVICE V1.0.13 整理 R / C / F、EXEC_SAP V1.1b 组装选择屏
 *   5) 报表自动登记（10.24 记录 #03b）：ZCL_AI_RPT_SCANNER / ZAI_RPT_REG 只在约定处写表；全库行长 ≤ 255
 *   6) 10.27 记录：SCANNER V1.0a 修复补回；EXEC_SAP V1.1c 作业语言 RPT_JOB_LANGU + 作业中止原因落表
 *   8) 10.28 边跑边看：ZCL_AI_AGENT_PROGRESS 只用独立连接写进度表、不碰主事务、写失败只关进度；
 *      AGENT_SERVICE V15.6 的挂点数量与位置；DPC V15.9 的 AgentProgress 分支与前端参数名一致
 *  10) Agent闭环增强/02 第 0 步：LLM_CLIENT V1.5 取用量、AGENT_SERVICE V15.8 用量只写审计
 *      （TOOL_ID = LLM_CALL）、DATA_ANALYSIS V13.4 数据集行数写在明细前面并按整行回填
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
check('进度调用数：start 1 / sync 7 / finish 2', agCnt(/zcl_ai_agent_progress=>start\(/g) === 1 && agCnt(/zcl_ai_agent_progress=>sync\(/g) === 7 &&
  agCnt(/zcl_ai_agent_progress=>finish\(/g) === 2, 'start ' + agCnt(/zcl_ai_agent_progress=>start\(/g) + ' / sync ' + agCnt(/zcl_ai_agent_progress=>sync\(/g) + ' / finish ' + agCnt(/zcl_ai_agent_progress=>finish\(/g));
check('每轮调模型前写本轮占位（循环里 sync 在 zcl_ai_llm_client=>chat 之前）', /lv_round = lv_round \+ 1\.\s*zcl_ai_agent_progress=>sync\([\s\S]*?is_running = VALUE #\( phase = 'PLANNING'[\s\S]*?zcl_ai_llm_client=>chat\(/.test(ag));
check('工具执行前写模型那句话 + 工具占位：数据分析在 execute_plan 前、扁平参数工具在参数校验后', agCnt(/iv_note\s+= zcl_ai_agent_guard=>sanitize_summary\( ls_out-summary \)/g) === 2 &&
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
  /^\* V1\.5 20261028/m.test(lcRaw) && /ev_finish\s+TYPE string\s+ev_usage\s+TYPE ty_usage\./.test(lc) &&
  lc.indexOf('BEGIN OF ty_usage,') > 0 && lc.indexOf('BEGIN OF ty_usage,') < lc.indexOf('CLASS-METHODS chat') && /CLEAR ev_usage\./.test(lcChat));
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

console.log('\n' + (fail === 0 ? '全部通过: ' + pass + ' 项' : '失败: ' + fail + ' 项 / 通过: ' + pass + ' 项'));
process.exit(fail === 0 ? 0 : 1);
