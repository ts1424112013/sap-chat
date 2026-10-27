/**
 * 报表自动登记：解析规则测试（10.24 记录 #03b）
 * 运行: node rpt-scan-tests.js   （或 npm run test:rptscan）
 *
 * 用 功能计划书/报表执行/ 下 8 份真实报表源码（+ 10.24 记录里的 ZRSD_IDP_0022_NEW，找不到就跳过）
 * 跑 JS 参考实现 rpt-scan-ref.js，锁住 ABAP 版 ZCL_AI_RPT_SCANNER 要遵守的规则：
 * 链式声明、小写关键字、说明文字（FOR FIELD / 同一行 / INITIALIZATION 赋值、优先中文）、
 * 单选组（默认项、组标题）、复选框默认、默认值（字面量 / sy-datum / INITIALIZATION 里 sy-datum - 1）、
 * 程序必填但有默认 → 选填、危险项（输出 / FTP / 邮件 / 删除 / 布局变式）与输出方式组 → 固定值。
 * 本地没有 TEXTPOOL / DDIC：0012 的选择文本按 10.24 截图手工给出，其余只看源码。
 */
const fs = require('fs');
const path = require('path');
const ref = require('./rpt-scan-ref');

const DIR = path.join(__dirname, '../功能计划书/报表执行');
const F0022 = path.join(__dirname, '../功能计划书/项目进度/10.24进度/交付_20261024_记录汇总/原始附件/源码_ZRSD_IDP_0022_NEW.txt');
const SRC = {};
fs.readdirSync(DIR).filter((f) => f.endsWith('.txt')).forEach((f) => {
  const s = fs.readFileSync(path.join(DIR, f), 'utf8');
  const m = /REPORT\s+(\w+)/i.exec(s);
  if (m) { SRC[m[1].toUpperCase()] = s; }
});
if (fs.existsSync(F0022)) { SRC.ZRSD_IDP_0022_NEW = fs.readFileSync(F0022, 'utf8'); }

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
const row = (d, id) => d.params.filter((r) => r.param_id === id)[0] || {};
const ids = (d, pred) => d.params.filter(pred).map((r) => r.param_id);

console.log('\n━━ 语句切分');
{
  const st = ref.statements("PARAMETERS: a TYPE c DEFAULT 'x.y', \"注释\n b LIKE sy-datum.\n* 整行注释\nSELECT-OPTIONS s FOR t-f.").stmts.map((x) => x.text);
  check('链式冒号展开、字面量里的句点不切、行内 " 注释去掉', st[0] === "PARAMETERS a TYPE c DEFAULT 'x.y'" && st[1] === 'PARAMETERS b LIKE sy-datum' && st[st.length - 1] === 'SELECT-OPTIONS s FOR t-f', JSON.stringify(st));
  check('默认值解析：字面量 / 数字 / sy-datum / sy-datum - 1 / 表达式不认', ref.parseDefault("'ABG1'").value === 'ABG1' && ref.parseDefault('05').value === '05' &&
    ref.parseDefault('sy-datum').type === 'TODAY' && ref.parseDefault('sy-datum - 1').value === '-1' && ref.parseDefault('gv_x') === null);
  check('危险名：p_ftp / p_send / s_down / alv_def / l_dele；业务名不误判（p_usec / p_plant / p_bu）',
    ['P_FTP', 'P_SEND', 'S_DOWN', 'ALV_DEF', 'L_DELE', 'P_BAKJOB', 'P_CACHE'].every((n) => ref.isDanger(n, '', '')) &&
    !['P_USEC', 'P_PLANT', 'P_BU', 'P_PD', 'P_CD', 'S_MATNR'].some((n) => ref.isDanger(n, '', '')));
  check('危险标签：上傳到FTP / 發送郵件 / 刪除；「基於物料文件日期」「基於過帳日期」不算',
    ref.isDanger('X1', '上傳到FTP', '') && ref.isDanger('X1', '發送郵件通知', '') && ref.isDanger('X1', '只查詢已刪除單據', '') &&
    !ref.isDanger('X1', '基於物料文件日期', '') && !ref.isDanger('X1', '基於過帳日期', '') && !ref.isDanger('X1', '使用緩存數據', ''));
}

console.log('\n━━ ZRSD_IDP_0012（13 个选择项 + 两组单选；选择文本按截图）');
{
  const d = ref.scan(SRC.ZRSD_IDP_0012, { textpool: {
    S: { P1: '已出貨報表', P2: '未出貨報表', P3: '全部', P_PLANT: '工廠', Q1: '單體包裝', Q2: '多體包裝', Q3: '所有包裝', S_ERDAT: '創建日期' }
  }, ddic: { 'LIKP-ERDAT': { type: 'D', len: 8 } } });
  check('头注释：模块 SD、事务码 ZDPSD012、用途', d.header.module === 'SD' && d.header.tcode === 'ZDPSD012' && /Issued\/Open DN/.test(d.header.purpose));
  check('两组单选 → R：选项文字来自选择文本，默认项照程序 DEFAULT（P1、Q3）',
    row(d, 'RB_GP1').allowed_ops === 'P1=已出貨報表*;P2=未出貨報表;P3=全部' && row(d, 'RB_GP2').allowed_ops === 'Q1=單體包裝;Q2=多體包裝;Q3=所有包裝*', row(d, 'RB_GP1').allowed_ops);
  check('S_ERDAT（DDIC 日期）→ DATE + 范围、必填；P_PLANT 是 SELECT-OPTIONS（名字是 p_ 也按 S）必填多值',
    row(d, 'S_ERDAT').data_type === 'DATE' && row(d, 'S_ERDAT').range_allowed && row(d, 'S_ERDAT').required &&
    row(d, 'P_PLANT').sel_kind === 'S' && row(d, 'P_PLANT').multi_value && row(d, 'P_PLANT').required);
  check('S_LGORT NO INTERVALS → 多值；全部 15 行都登记', row(d, 'S_LGORT').multi_value && d.params.length === 15 && d.params.every((r) => r.include));
  check('单选组插在第一个按钮的位置（选择项之后），SORT_NO 连续', d.params[13].param_id === 'RB_GP1' && d.params[14].sort_no === 150);
}

console.log('\n━━ ZRSD_IDP_0033（说明写在参数后面、没写 FOR FIELD；组标题在前一行）');
{
  const d = ref.scan(SRC.ZRSD_IDP_0033, {});
  const r = row(d, 'RB_V1');
  check('同一行里参数后面的说明 → 选项文字（优先中文赋值）', /^SO_ALL=銷售報表- all\*;SO_OPEN=已銷售但沒出貨的報表;/.test(r.allowed_ops), r.allowed_ops);
  check('组标题 = 前面单独一行的说明「狀態選項」', r.label === '狀態選項' && r.label_src === 'COMMENT', r.label);
  check('五个选项、120 字符以内、登记', (r.allowed_ops.match(/=/g) || []).length === 5 && r.allowed_ops.length <= 120 && r.include);
}

console.log('\n━━ ZRMM_IDP_0129_A（小写关键字）');
{
  const d = ref.scan(SRC.ZRMM_IDP_0129_A, {});
  check('selection-SCREEN / obligatory 小写也认；p_werks 程序必填但 DEFAULT ABG1 → 选填 + 静态默认',
    row(d, 'P_WERKS').sel_kind === 'P' && !row(d, 'P_WERKS').required && row(d, 'P_WERKS').default_type === 'STATIC' && row(d, 'P_WERKS').default_value === 'ABG1');
  check('INCLUDE STRUCTURE 不当成参数；共 2 行', d.params.length === 2);
}

console.log('\n━━ ZRMM_IDP_0003C（说明写死在 INITIALIZATION；输出方式组；FTP 区块）');
{
  const d = ref.scan(SRC.ZRMM_IDP_0003C, {});
  check('标签取 INITIALIZATION 里的中文赋值（不取英文那支）', row(d, 'P_DATE').label === '基準日期' && row(d, 'P_NCO').label === '包含非成本庫存');
  check('p_date 程序必填、INITIALIZATION 里 = sy-datum - 1 → 选填 + TODAY -1', row(d, 'P_DATE').data_type === 'DATE' && !row(d, 'P_DATE').required &&
    row(d, 'P_DATE').default_type === 'TODAY' && row(d, 'P_DATE').default_value === '-1');
  check('层级 / 日期基准 → R（默认 P_LOC / P_PD），组标题有中文', row(d, 'RB_GP1').allowed_ops === 'P_BU=公司層級;P_PLA=工廠層級;P_LOC=倉碼層級*;P_WL=WBS層級' &&
    row(d, 'RB_GP2').allowed_ops === 'P_PD=基於過帳日期*;P_CD=基於物料文件日期' && /[一-鿿]/.test(row(d, 'RB_GP1').label + row(d, 'RB_GP2').label));
  check('复选框 → C：P_USEC / P_NEW 默认勾（ALLOWED_OPS = X），其余空', row(d, 'P_USEC').sel_kind === 'C' && row(d, 'P_USEC').allowed_ops === 'X' &&
    row(d, 'P_NEW').allowed_ops === 'X' && row(d, 'P_NCO').allowed_ops === '' && row(d, 'P_AGE07').sel_kind === 'C');
  const outs = d.params.filter((r) => r.sel_kind === 'F');
  check('输出方式组 → F：P_ALV = X，FTP / 下载 / BI / 缓存 = 空，不出 R', outs.length === 6 && row(d, 'OUT_P_ALV').allowed_ops === 'X' &&
    outs.filter((r) => r.allowed_ops === '').length === 5 && !row(d, 'RB_GP3').param_id);
  check('FTP 地址 / 帐号 / 密码 / 目录 / 文件名、下载路径、作业名一律不登记', ['P_FTP', 'P_USER', 'P_PWD', 'P_PATH', 'P_FILE', 'P_FILENA', 'P_JOB'].every((n) => row(d, n).include === false));
  check('12 个天数 OBLIGATORY + DEFAULT → 选填 + 静态默认（TYPE n 按 CHAR 保留前导零）', ids(d, (r) => /^T_DAY/.test(r.param_id) && !r.required && r.default_type === 'STATIC' && r.data_type === 'CHAR').length === 12);
  check('p_proc TYPE i DEFAULT 1 → NUM 选填默认 1', row(d, 'P_PROC').data_type === 'NUM' && row(d, 'P_PROC').default_value === '1' && !row(d, 'P_PROC').required);
}

console.log('\n━━ ZRMM_IDP_0018（发邮件组）');
{
  const d = ref.scan(SRC.ZRMM_IDP_0018, {});
  check('ALV / 发邮件组 → F（P_ALV = X、P_SEND = 空）；邮件主题 / 地址不登记', row(d, 'OUT_P_ALV').allowed_ops === 'X' && row(d, 'OUT_P_SEND').allowed_ops === '' &&
    row(d, 'P_SBT').include === false && row(d, 'P_MAIL').include === false);
  check('COMMENT … FOR  FIELD（两个空格）也认；P_LA 默认勾', row(d, 'P_PLANT').label === '工廠' && row(d, 'P_LA').allowed_ops === 'X');
}

console.log('\n━━ ZRSD_IDP_0021（链式单选组、NO-DISPLAY）');
{
  const d = ref.scan(SRC.ZRSD_IDP_0021, {});
  check('PARAMETERS: h1 RADIOBUTTON GROUP h1, h2 … 链式 → 一组；没写 DEFAULT 默认第一个', /^H1=[^;]*\*;H2=/.test(row(d, 'RB_H1').allowed_ops) && /^R1=[^;]*\*;R2=/.test(row(d, 'RB_RAD1').allowed_ops));
  check('NO-DISPLAY 的 s_loadno / s_datum 跳过', !row(d, 'S_LOADNO').param_id && !row(d, 'S_DATUM').param_id);
  check('TYPE c AS CHECKBOX DEFAULT X → C 默认勾', row(d, 'P_C1').sel_kind === 'C' && row(d, 'P_C1').allowed_ops === 'X');
}

console.log('\n━━ ZRMM_IDP_0159 / ZRMM_IDP_0161');
{
  const d = ref.scan(SRC.ZRMM_IDP_0159, {});
  check('布局变式 alv_def、「只查詢已刪除單據」默认不登记，并写明原因', row(d, 'ALV_DEF').include === false && /布局变式/.test(row(d, 'ALV_DEF').note) && row(d, 'L_DELE').include === false && /^疑似/.test(row(d, 'L_DELE').note));
  check('SELECT-OPTIONS … DEFAULT sy-datum → TODAY 0', row(d, 'BADAT').default_type === 'TODAY' && row(d, 'BADAT').default_value === '0');
  const e = ref.scan(SRC.ZRMM_IDP_0161, {});
  check('0161：下载复选框 s_down 不登记；PARAMETERS p_chara(02) TYPE n DEFAULT 05（无冒号、数字默认）', row(e, 'S_DOWN').include === false &&
    row(e, 'P_CHARA').type_length === 2 && row(e, 'P_CHARA').default_value === '05');
}

if (SRC.ZRSD_IDP_0022_NEW) {
  console.log('\n━━ ZRSD_IDP_0022_NEW（头注释 T-CODE 为空；EDI / 手工组）');
  const d = ref.scan(SRC.ZRSD_IDP_0022_NEW, {});
  check('头注释事务码为空、模块 SD', d.header.tcode === '' && d.header.module === 'SD');
  check('p_box1 / p_box2（中间夹着选择项）仍是一组，没写 DEFAULT → 默认 P_BOX1', /^P_BOX1=[^;]*\*;P_BOX2=/.test(row(d, 'RB_BOX').allowed_ops));
  check('p_date1 / p_date2 OBLIGATORY DEFAULT sy-datum → 选填 + TODAY 0', ['P_DATE1', 'P_DATE2'].every((n) => !row(d, n).required && row(d, n).default_type === 'TODAY'));
} else {
  console.log('\n（没找到 ZRSD_IDP_0022_NEW 源码，跳过）');
}

console.log('\n━━ 与 ABAP 版 ZCL_AI_RPT_SCANNER 规则一致');
{
  const abap = fs.readFileSync(path.join(__dirname, '../backend-abap/ZCL_AI_RPT_SCANNER.abap'), 'utf8');
  // class_constructor 里 gc_x = `…` && `…`. 拼起来
  const rx = (name) => {
    const m = new RegExp(name + '\\s*=\\s*([\\s\\S]*?)\\.\\s*\\n').exec(abap);
    return m ? (m[1].match(/`([^`]*)`/g) || []).map((x) => x.slice(1, -1)).join('') : '';
  };
  const words = (src) => src.replace(/\(\?:/g, '(').split(/[|()]/).map((w) => w.trim()).filter((w) => /^[A-Z_\-? \u4e00-\u9fff]+$/i.test(w) && !/^\^|\$$/.test(w)).sort().join('|');
  const jsName = ref.NAME_DANGER.source, abName = rx('gc_name_danger');
  check('危险名清单两边一致', abName && words(jsName.replace(/^\^\(\?:P_\|S_\|L_\)\?/, '')) === words(abName.replace(/^\^\(P_\|S_\|L_\)\?/, '')), words(abName));
  check('危险标签清单两边一致', words(ref.LABEL_DANGER.source) === words(rx('gc_label_danger')), words(rx('gc_label_danger')));
  check('输出方式安全项清单两边一致', words(ref.SAFE_OUT.source) === words(rx('gc_safe_out')), words(rx('gc_safe_out')));
  check('跳过的内部参数、120 字符上限、截到 8 个字两边一致', /'P_AICAP' OR ls_d-name = 'P_RUNID'/.test(abap) && /strlen\( lv_ops \) > 120/.test(abap) && /len = 8 \)/.test(abap));
}

console.log('\n━━ 选择屏块标题 → GROUP_LABEL（10.27 记录 #04，仿 ZDPPP059 工單查核報表）');
{
  const src = [
    'REPORT zrpp_idp_0059.',
    'SELECTION-SCREEN BEGIN OF BLOCK b1 WITH FRAME TITLE text-001.',
    'SELECT-OPTIONS: s_werks FOR t001w-werks, s_aufnr FOR aufk-aufnr.',
    'PARAMETERS: p_nofull AS CHECKBOX, p_head AS CHECKBOX DEFAULT \'X\'.',
    'SELECTION-SCREEN BEGIN OF BLOCK b1a WITH FRAME.',
    'PARAMETERS: r_all RADIOBUTTON GROUP g1 DEFAULT \'X\', r_part RADIOBUTTON GROUP g1.',
    'SELECTION-SCREEN END OF BLOCK b1a.',
    'SELECTION-SCREEN END OF BLOCK b1.',
    'SELECTION-SCREEN BEGIN OF BLOCK b2 WITH FRAME TITLE text-002.',
    'PARAMETERS: p_teco AS CHECKBOX DEFAULT \'X\', p_cnf AS CHECKBOX, p_crtd AS CHECKBOX DEFAULT \'X\'.',
    'SELECTION-SCREEN END OF BLOCK b2.',
    'SELECTION-SCREEN BEGIN OF BLOCK b4 WITH FRAME TITLE t_job.',
    'PARAMETERS p_bak AS CHECKBOX.',
    'SELECTION-SCREEN END OF BLOCK b4.',
    'PARAMETERS p_loose AS CHECKBOX.',
    'INITIALIZATION.',
    "  t_job = '僅在JOB使用'."
  ].join('\n');
  const d = ref.scan(src, { textpool: { I: { '001': '選取範圍', '002': '請選擇無需查詢的工單狀態' } } });
  const g = (id) => row(d, id).group_label;
  check('选择项与复选框带所在块标题（TITLE TEXT-xxx 取文本符号）', g('S_WERKS') === '選取範圍' && g('P_NOFULL') === '選取範圍' && g('P_TECO') === '請選擇無需查詢的工單狀態' && g('P_CRTD') === '請選擇無需查詢的工單狀態');
  check('块标题是变量时取 INITIALIZATION 里的字面量赋值', g('P_BAK') === '僅在JOB使用');
  check('嵌套的无标题块：标题为空（不继承外层）；块外的参数为空', g('RB_G1') === '' && g('P_LOOSE') === '', JSON.stringify([g('RB_G1'), g('P_LOOSE')]));
  check('分组不影响原有排序与登记', d.params.map((r) => r.param_id).join(',') === 'S_WERKS,S_AUFNR,P_NOFULL,P_HEAD,RB_G1,P_TECO,P_CNF,P_CRTD,P_BAK,P_LOOSE' && d.params.every((r) => r.include));
}

console.log(`\n━━ 结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
