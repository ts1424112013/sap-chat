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
check('源码读取：READ REPORT + Z/Y include 展开（深度 ≤ 3、最多 30 个）；文字：READ TEXTPOOL 依次试四种语言', /READ REPORT iv_prog INTO lt_src STATE 'A'/.test(sc) && /iv_depth >= 3/.test(sc) && /gv_incl < 30/.test(sc) && /READ TEXTPOOL iv_prog INTO lt_tp LANGUAGE lv_l/.test(sc));
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

console.log('\n' + (fail === 0 ? '全部通过: ' + pass + ' 项' : '失败: ' + fail + ' 项 / 通过: ' + pass + ' 项'));
process.exit(fail === 0 ? 0 : 1);
