/**
 * ABAP 源码静态检查（无 SAP、无网络）—— 部署前把"在 SAP 上才会炸"的低级错误拦在本地
 * 运行: node abap-static-tests.js   （或 npm run test:abap）
 *
 * 覆盖：
 *   1) ZAI_CHAT_CFG 配置键 ≤ 20 字符（CFGKEY 是 CHAR 20；超长键 OPEN SQL 直接抛
 *      CX_SY_OPEN_SQL_DATA_ERROR → 网关 500。10-22 部署实锤：REPORT_CAPTURE_LEGACY 21 字符）
 *   2) Fiori 取数通道（ZCL_AI_ODATA_CLIENT V1.3 + Z_AI_ODATA_GET）：默认走 RFC 新会话、
 *      不再有 URL 通道、现场 DPC 捕获块调用的两个空壳方法还在、函数模块接口与调用一致
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

console.log('\n' + (fail === 0 ? '全部通过: ' + pass + ' 项' : '失败: ' + fail + ' 项 / 通过: ' + pass + ' 项'));
process.exit(fail === 0 ? 0 : 1);
