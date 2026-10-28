/**
 * Mock 工具实现（模拟 SAP OData 响应）
 * 对照后端的 ZCL_AI_INVENTORY_TOOLS / ZCL_AI_DDIC_TOOLS / ZCL_AI_SQL_EXECUTOR
 */

/**
 * 根据领域返回可用工具列表
 */
function getToolsForDomain(domain) {
  const allTools = {
    // 库存工具（对照 ZCL_AI_INVENTORY_TOOLS）
    resolve_material: {
      id: 'resolve_material',
      description: '根据料号关键词查找物料主数据',
      parameters: [
        { name: 'keyword', type: 'string', required: true, description: '料号或料号片段' },
        { name: 'plant', type: 'string', required: false, description: '工厂代码' }
      ]
    },
    get_stock: {
      id: 'get_stock',
      description: '查询物料的当前库存',
      parameters: [
        { name: 'material', type: 'string', required: true, description: '料号' },
        { name: 'plant', type: 'string', required: true, description: '工厂' }
      ]
    },
    get_movements: {
      id: 'get_movements',
      description: '查询物料的收发记录',
      parameters: [
        { name: 'material', type: 'string', required: true, description: '料号' },
        { name: 'plant', type: 'string', required: true, description: '工厂' },
        { name: 'date', type: 'string', required: true, description: '过账日期 YYYYMMDD' }
      ]
    },

    // SQL 工具（对照 ZCL_AI_DDIC_TOOLS / ZCL_AI_SQL_EXECUTOR）
    search_tables: {
      id: 'search_tables',
      description: '按关键词搜索 SAP 表',
      parameters: [
        { name: 'keyword', type: 'string', required: true, description: '搜索关键词，中英文均可' }
      ]
    },
    describe_table: {
      id: 'describe_table',
      description: '查看表的字段结构',
      parameters: [
        { name: 'table', type: 'string', required: true, description: '表名，例如 MARA' }
      ]
    },
    run_sql: {
      id: 'run_sql',
      description: '执行一条 SAP Open SQL 只读 SELECT。首选表 AS 别名、字段使用别名~字段、显式 JOIN ... ON；非聚合字段全部写入 GROUP BY；聚合字段使用英文 ASCII 别名；不要 SELECT * 或中文别名。禁止 INTO/UP TO/PACKAGE SIZE、子查询、CTE、窗口函数。',
      parameters: [
        { name: 'sql', type: 'string', required: true, description: '完整的 SELECT 语句' },
        { name: 'purpose', type: 'string', required: true, description: '查询目的说明' }
      ]
    }
  };

  if (domain === 'INVENTORY') {
    return [allTools.resolve_material, allTools.get_stock, allTools.get_movements];
  } else if (domain === 'DATA') {
    return [allTools.search_tables, allTools.describe_table, allTools.run_sql];
  } else {
    return [];
  }
}

/**
 * Mock 数据源
 */
const mockData = {
  // 物料主数据
  materials: [
    { matnr: 'MAT001', maktx: '钢板 Q235', mtart: 'ROH', meins: 'KG', werks: '1000' },
    { matnr: 'MAT002', maktx: '电机 YE3-100', mtart: 'FERT', meins: 'EA', werks: '1000' },
    { matnr: 'MAT003', maktx: '螺栓 M8', mtart: 'HIBE', meins: 'PC', werks: '1000' }
  ],

  // 库存快照
  stock: [
    { matnr: 'MAT001', werks: '1000', lgort: '1001', labst: 5000, meins: 'KG' },
    { matnr: 'MAT001', werks: '1000', lgort: '1002', labst: 3000, meins: 'KG' },
    { matnr: 'MAT002', werks: '1000', lgort: '1001', labst: 120, meins: 'EA' }
  ],

  // 收发明细
  movements: [
    { matnr: 'MAT001', werks: '1000', budat: '20261005', menge: 1000, meins: 'KG', shkzg: 'S', bwart: '101' },
    { matnr: 'MAT001', werks: '1000', budat: '20261005', menge: 500, meins: 'KG', shkzg: 'H', bwart: '261' }
  ],

  // 表目录（须与领域卡【常用业务表】一致：卡片里提到的表必须存在，否则模型会反复搜索）
  tables: {
    MARA: { desc_cn: '物料主数据', desc_en: 'General Material Data' },
    MARC: { desc_cn: '物料工厂视图', desc_en: 'Plant Data for Material' },
    MARD: { desc_cn: '库位库存', desc_en: 'Storage Location Data for Material' },
    MSEG: { desc_cn: '收发行项目', desc_en: 'Document Segment: Material' },
    MKPF: { desc_cn: '收发凭证头', desc_en: 'Header: Material Document' },
    EKKO: { desc_cn: '采购订单头', desc_en: 'Purchasing Document Header' },
    EKPO: { desc_cn: '采购订单行项目', desc_en: 'Purchasing Document Item' },
    VBAK: { desc_cn: '销售订单头', desc_en: 'Sales Document: Header Data' },
    VBAP: { desc_cn: '销售订单行项目', desc_en: 'Sales Document: Item Data' },
    KNA1: { desc_cn: '客户主数据', desc_en: 'General Data in Customer Master' },
    ZIDPPP_TEST01: { desc_cn: '生产工单(自建测试表)', desc_en: 'Custom Test Table: Production Orders' }
  },

  // 表字段（必须覆盖 tables 目录里的全部表，否则 describe_table 与 search_tables 结果矛盾）
  fields: {
    MARA: [
      { fieldname: 'MATNR', desc: '物料号', datatype: 'CHAR', length: 18 },
      { fieldname: 'MTART', desc: '物料类型', datatype: 'CHAR', length: 4 },
      { fieldname: 'MEINS', desc: '基本单位', datatype: 'UNIT', length: 3 },
      { fieldname: 'MAKTX', desc: '物料描述', datatype: 'CHAR', length: 40 }
    ],
    MARC: [
      { fieldname: 'MATNR', desc: '物料号', datatype: 'CHAR', length: 18 },
      { fieldname: 'WERKS', desc: '工厂', datatype: 'CHAR', length: 4 },
      { fieldname: 'PSTAT', desc: '维护状态', datatype: 'CHAR', length: 15 },
      { fieldname: 'DISPO', desc: 'MRP控制者', datatype: 'CHAR', length: 3 }
    ],
    MARD: [
      { fieldname: 'MATNR', desc: '物料号', datatype: 'CHAR', length: 18 },
      { fieldname: 'WERKS', desc: '工厂', datatype: 'CHAR', length: 4 },
      { fieldname: 'LGORT', desc: '库位', datatype: 'CHAR', length: 4 },
      { fieldname: 'LABST', desc: '非限制库存', datatype: 'QUAN', length: 13 }
    ],
    EKKO: [
      { fieldname: 'EBELN', desc: '采购订单号', datatype: 'CHAR', length: 10 },
      { fieldname: 'BUKRS', desc: '公司代码', datatype: 'CHAR', length: 4 },
      { fieldname: 'LIFNR', desc: '供应商', datatype: 'CHAR', length: 10 },
      { fieldname: 'BEDAT', desc: '凭证日期', datatype: 'DATS', length: 8 }
    ],
    EKPO: [
      { fieldname: 'EBELN', desc: '采购订单号', datatype: 'CHAR', length: 10 },
      { fieldname: 'EBELP', desc: '行项目号', datatype: 'NUMC', length: 5 },
      { fieldname: 'MATNR', desc: '物料号', datatype: 'CHAR', length: 18 },
      { fieldname: 'MENGE', desc: '数量', datatype: 'QUAN', length: 13 },
      { fieldname: 'NETPR', desc: '净价', datatype: 'CURR', length: 11 }
    ],
    VBAK: [
      { fieldname: 'VBELN', desc: '销售订单号', datatype: 'CHAR', length: 10 },
      { fieldname: 'ERDAT', desc: '创建日期', datatype: 'DATS', length: 8 },
      { fieldname: 'KUNNR', desc: '客户编号', datatype: 'CHAR', length: 10 },
      { fieldname: 'NETWR', desc: '净值', datatype: 'CURR', length: 15 }
    ],
    VBAP: [
      { fieldname: 'VBELN', desc: '销售订单号', datatype: 'CHAR', length: 10 },
      { fieldname: 'POSNR', desc: '行项目号', datatype: 'NUMC', length: 6 },
      { fieldname: 'MATNR', desc: '物料号', datatype: 'CHAR', length: 18 },
      { fieldname: 'KWMENG', desc: '订单数量', datatype: 'QUAN', length: 13 },
      { fieldname: 'NETWR', desc: '净值', datatype: 'CURR', length: 15 }
    ],
    KNA1: [
      { fieldname: 'KUNNR', desc: '客户编号', datatype: 'CHAR', length: 10 },
      { fieldname: 'NAME1', desc: '客户名称', datatype: 'CHAR', length: 30 },
      { fieldname: 'LAND1', desc: '国家', datatype: 'CHAR', length: 3 },
      { fieldname: 'ORT01', desc: '城市', datatype: 'CHAR', length: 25 }
    ],
    MSEG: [
      { fieldname: 'MBLNR', desc: '收发凭证号', datatype: 'CHAR', length: 10 },
      { fieldname: 'ZEILE', desc: '行项目号', datatype: 'NUMC', length: 4 },
      { fieldname: 'MATNR', desc: '物料号', datatype: 'CHAR', length: 18 },
      { fieldname: 'MENGE', desc: '数量', datatype: 'QUAN', length: 13 },
      { fieldname: 'SHKZG', desc: '借贷标识(S收/H发)', datatype: 'CHAR', length: 1 },
      { fieldname: 'BUDAT', desc: '过账日期', datatype: 'DATS', length: 8 }
    ],
    MKPF: [
      { fieldname: 'MBLNR', desc: '收发凭证号', datatype: 'CHAR', length: 10 },
      { fieldname: 'BUDAT', desc: '过账日期', datatype: 'DATS', length: 8 },
      { fieldname: 'USNAM', desc: '用户名', datatype: 'CHAR', length: 12 }
    ],
    ZIDPPP_TEST01: [
      { fieldname: 'AUFNR', desc: '工单号', datatype: 'CHAR', length: 12 },
      { fieldname: 'WERKS', desc: '工厂', datatype: 'CHAR', length: 4 },
      { fieldname: 'MATNR', desc: '物料号', datatype: 'CHAR', length: 18 },
      { fieldname: 'AUART', desc: '工单类型', datatype: 'CHAR', length: 4 },
      { fieldname: 'GSTRP', desc: '基本开始日期', datatype: 'DATS', length: 8 },
      { fieldname: 'MENGE', desc: '订单数量', datatype: 'QUAN', length: 13 },
      { fieldname: 'MEINS', desc: '单位', datatype: 'UNIT', length: 3 },
      { fieldname: 'STATUS', desc: '系统状态', datatype: 'CHAR', length: 4 }
    ]
  }
};

// 行数据（run_sql 的内存数据源；表目录里的每张表都必须有数据 —— 数据一致性原则）
mockData.tableRows = {
  MARA: mockData.materials.map(m => ({ MATNR: m.matnr, MAKTX: m.maktx, MTART: m.mtart, MEINS: m.meins })),
  MARC: mockData.materials.map(m => ({ MATNR: m.matnr, WERKS: m.werks, PSTAT: 'KD', DISPO: '001' })),
  MARD: mockData.stock.map(s => ({ MATNR: s.matnr, WERKS: s.werks, LGORT: s.lgort, LABST: String(s.labst) })),
  MSEG: mockData.movements.map((m, i) => ({
    MBLNR: '5900000001', ZEILE: String(1 + i).padStart(4, '0'), MATNR: m.matnr,
    MENGE: String(m.menge), SHKZG: m.shkzg, BUDAT: m.budat
  })),
  MKPF: [{ MBLNR: '5900000001', BUDAT: '20261005', USNAM: 'TANGTANG' }],
  EKKO: [
    { EBELN: '4500000001', BUKRS: '1000', LIFNR: 'V001', BEDAT: '20261001' },
    { EBELN: '4500000002', BUKRS: '1000', LIFNR: 'V002', BEDAT: '20261003' }
  ],
  EKPO: [
    { EBELN: '4500000001', EBELP: '00010', MATNR: 'MAT001', MENGE: '100.000', NETPR: '12.50' },
    { EBELN: '4500000001', EBELP: '00020', MATNR: 'MAT003', MENGE: '500.000', NETPR: '0.80' },
    { EBELN: '4500000002', EBELP: '00010', MATNR: 'MAT002', MENGE: '10.000', NETPR: '850.00' }
  ],
  VBAK: [
    { VBELN: '8000000001', ERDAT: '20260901', KUNNR: 'C001', NETWR: '50000.00' },
    { VBELN: '8000000002', ERDAT: '20260915', KUNNR: 'C002', NETWR: '120000.00' },
    { VBELN: '8000000003', ERDAT: '20261001', KUNNR: 'C001', NETWR: '75000.00' }
  ],
  VBAP: [
    { VBELN: '8000000001', POSNR: '000010', MATNR: 'MAT001', KWMENG: '100.00', NETWR: '50000.00' },
    { VBELN: '8000000002', POSNR: '000010', MATNR: 'MAT002', KWMENG: '10.00', NETWR: '120000.00' },
    { VBELN: '8000000003', POSNR: '000010', MATNR: 'MAT003', KWMENG: '500.00', NETWR: '75000.00' }
  ],
  KNA1: [
    { KUNNR: 'C001', NAME1: '华东机械有限公司', LAND1: 'CN', ORT01: '上海' },
    { KUNNR: 'C002', NAME1: '南方贸易集团', LAND1: 'CN', ORT01: '广州' }
  ],
  ZIDPPP_TEST01: [
    { AUFNR: '000100000001', WERKS: '1000', MATNR: 'MAT001', AUART: 'PP01', GSTRP: '20261001', MENGE: '500.000', MEINS: 'KG', STATUS: 'REL' },
    { AUFNR: '000100000002', WERKS: '1000', MATNR: 'MAT002', AUART: 'PP01', GSTRP: '20261002', MENGE: '20.000', MEINS: 'EA', STATUS: 'REL' },
    { AUFNR: '000100000003', WERKS: '1000', MATNR: 'MAT003', AUART: 'PP01', GSTRP: '20261003', MENGE: '1000.000', MEINS: 'PC', STATUS: 'CRTD' },
    { AUFNR: '000100000004', WERKS: '2000', MATNR: 'MAT001', AUART: 'PP01', GSTRP: '20261004', MENGE: '200.000', MEINS: 'KG', STATUS: 'TECO' },
    { AUFNR: '000100000005', WERKS: '2000', MATNR: 'MAT002', AUART: 'PP01', GSTRP: '20261005', MENGE: '50.000', MEINS: 'EA', STATUS: 'REL' },
    { AUFNR: '000100000006', WERKS: '1000', MATNR: 'MAT001', AUART: 'PP02', GSTRP: '20261006', MENGE: '300.000', MEINS: 'KG', STATUS: 'CNF' }
  ]
};

/**
 * 轻量 SELECT 引擎（Mock 版）
 * 支持: 列选择/别名/聚合(COUNT,SUM,AVG,MIN,MAX)/WHERE(AND,=,<>,!=,>,<,>=,<=,LIKE)/GROUP BY/ORDER BY(ASC,DESC,DESCENDING)
 * 目的: 让 Mock 的 SQL 语义贴近真实执行（否则模型要聚合却拿到原始行，会反复重查）
 * 内部错误时返回空集（保工作流不中断）
 */
function execMockSelect(sql) {
  try {
    let flat = String(sql).replace(/\s+/g, ' ').trim();

    // ---- JOIN 解析（先从原文提取等值连接，再从 SQL 中移除）----
    // 支持: [LEFT|RIGHT|INNER][OUTER] JOIN t2 ON a.col = b.col（. 或 ~ 限定符均可）
    const joins = [];
    const joinRe = /\b((?:left|right|inner)\s+(?:outer\s+)?join|join)\s+([a-z0-9_]+)\s+on\s+([a-z0-9_]+)(?:\.|~)([a-z0-9_]+)\s*=\s*([a-z0-9_]+)(?:\.|~)([a-z0-9_]+)/gi;
    let jm;
    while ((jm = joinRe.exec(flat)) !== null) {
      joins.push({
        type: jm[1].toUpperCase(), table: jm[2].toUpperCase(),
        ltab: jm[3].toUpperCase(), lcol: jm[4].toUpperCase(),
        rtab: jm[5].toUpperCase(), rcol: jm[6].toUpperCase()
      });
    }
    flat = flat.replace(joinRe, ' ');

    const m = flat.match(/^select\s+([\s\S]+?)\s+from\s+([a-z0-9_]+)([\s\S]*)$/i);
    if (!m) return [];
    let colsPart = m[1];
    const table = m[2].toUpperCase();
    let tail = m[3] || '';

    // 去掉表名限定符（vbak~kunnr / VBAK.KUNNR → KUNNR；单数据源 Mock 无歧义）
    const qualRe = /\b[a-z_][a-z0-9_]*(?:\.|~)(?=[a-z_][a-z0-9_]*\b)/gi;
    colsPart = colsPart.replace(qualRe, '');
    tail = tail.replace(qualRe, '');

    let rows = mockData.tableRows[table] || [];
    // 依次应用 JOIN（累积行 与 右表按 ON 等值合并；列冲突时右表覆盖）
    for (const j of joins) {
      const right = mockData.tableRows[j.table] || [];
      const leftKey = j.ltab === j.table ? j.rcol : j.lcol;   // 属于累积侧行的键
      const rightKey = j.ltab === j.table ? j.lcol : j.rcol;  // 属于 join 表的键
      rows = applyJoin(rows, right, j.type, leftKey, rightKey);
    }

    const whereM = tail.match(/\swhere\s+([\s\S]+?)(?=\sgroup\sby\s|\sorder\sby\s|$)/i);
    const groupM = tail.match(/\sgroup\sby\s+([\s\S]+?)(?=\sorder\sby\s|$)/i);
    const orderM = tail.match(/\sorder\sby\s+([\s\S]+?)$/i);

    if (whereM) {
      const clause = whereM[1].trim();
      rows = rows.filter(r => clause.split(/\s+and\s+/i).every(c => evalWhereCond(r, c.trim())));
    }

    const items = parseSelectItems(colsPart);
    const hasAgg = items.some(it => it.agg);
    // GROUP BY 支持多列（GROUP BY a, b → 复合键）
    const groupCols = groupM
      ? groupM[1].split(',').map(s => s.trim().split(/\s+/)[0].toUpperCase()).filter(Boolean)
      : null;

    let out;
    if (groupCols && groupCols.length) {
      const groups = new Map();
      rows.forEach(r => {
        const k = JSON.stringify(groupCols.map(c => r[c]));
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      });
      out = [...groups.keys()].sort().map(k => projectRow(groups.get(k), items));
    } else if (hasAgg) {
      out = [projectRow(rows, items)];
    } else {
      out = rows.map(r => projectRow([r], items));
    }

    if (orderM) {
      // 排序键可能是别名（含中文）或聚合表达式（ORDER BY SUM(NETWR) DESC）
      const om = orderM[1].trim().match(/^([\s\S]+?)(?:\s+(asc|desc|descending))?$/i);
      const keyExpr = om[1].replace(/\s+/g, '');
      const desc = /^DESC(ENDING)?$/i.test(om[2] || '');
      // 表达式 → 别名映射（按 items 反查）
      const exprToAlias = {};
      for (const it of items) {
        if (it.agg) exprToAlias[`${it.agg}(${it.col})`] = it.alias;
        else if (it.col) exprToAlias[it.col] = it.alias;
      }
      const alias = exprToAlias[keyExpr.toUpperCase()];
      out.sort((a, b) => {
        const av = a[keyExpr] !== undefined ? a[keyExpr] : (alias !== undefined ? a[alias] : undefined);
        const bv = b[keyExpr] !== undefined ? b[keyExpr] : (alias !== undefined ? b[alias] : undefined);
        let cmp;
        if (av === undefined || bv === undefined) cmp = 0;
        else if (av !== null && av !== '' && bv !== null && bv !== '' && !isNaN(parseFloat(av)) && !isNaN(parseFloat(bv))) cmp = parseFloat(av) - parseFloat(bv);
        else cmp = String(av).localeCompare(String(bv));
        return desc ? -cmp : cmp;
      });
    }

    return out;
  } catch (e) {
    return [];
  }
}

function parseSelectItems(colsPart) {
  const c = colsPart.trim();
  if (c === '*') return [{ star: true }];
  // 列名/别名允许中文（模型常写 AS 客户编号 这类中文别名）
  const NAME = '[a-z0-9_\\u4e00-\\u9fa5]+';
  return c.split(',').map(s => s.trim()).filter(Boolean).map(seg => {
    const agg = seg.match(new RegExp(`^(count|sum|avg|min|max)\\s*\\(\\s*(distinct\\s+)?(\\*|${NAME})\\s*\\)(?:\\s+as\\s+(${NAME}))?$`, 'i'));
    if (agg) {
      return { agg: agg[1].toUpperCase(), col: agg[3] === '*' ? '*' : agg[3].toUpperCase(), distinct: !!agg[2], alias: (agg[4] || agg[1]).toUpperCase() };
    }
    const plain = seg.match(new RegExp(`^(${NAME})(?:\\s+as\\s+(${NAME}))?$`, 'i'));
    if (plain) return { col: plain[1].toUpperCase(), alias: (plain[2] || plain[1]).toUpperCase() };
    return { col: seg.toUpperCase(), alias: seg.toUpperCase() };
  });
}

function projectRow(groupRows, items) {
  const out = {};
  for (const it of items) {
    if (it.star) { Object.assign(out, groupRows[0] || {}); continue; }
    const key = it.alias;
    if (it.agg) {
      const vals = it.col === '*' ? groupRows : groupRows.map(r => r[it.col]).filter(v => v !== undefined && v !== '');
      const nums = vals.map(v => parseFloat(v)).filter(n => !isNaN(n));
      switch (it.agg) {
        case 'COUNT': out[key] = it.distinct && it.col !== '*' ? new Set(vals.map(v => String(v))).size : vals.length; break;
        case 'SUM': out[key] = round2(nums.reduce((s, n) => s + n, 0)); break;
        case 'AVG': out[key] = nums.length ? round2(nums.reduce((s, n) => s + n, 0) / nums.length) : 0; break;
        case 'MIN': out[key] = nums.length ? Math.min(...nums) : null; break;
        case 'MAX': out[key] = nums.length ? Math.max(...nums) : null; break;
      }
    } else {
      out[key] = groupRows[0] ? groupRows[0][it.col] : null;
    }
  }
  return out;
}

function applyJoin(leftRows, rightRows, type, leftKey, rightKey) {
  const idx = new Map();
  rightRows.forEach(r => {
    const k = r[rightKey];
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(r);
  });
  const out = [];
  leftRows.forEach(l => {
    const ms = idx.get(l[leftKey]) || [];
    if (ms.length) ms.forEach(r => out.push(Object.assign({}, l, r)));
    else if (/^LEFT/i.test(type)) out.push(Object.assign({}, l));  // LEFT JOIN 无匹配保留左行
  });
  return out;
}

function evalWhereCond(r, cond) {
  let m = cond.match(/^([a-z0-9_]+)\s+is\s+(not\s+)?null$/i);
  if (m) {
    const v = r[m[1].toUpperCase()];
    const isNull = v === undefined || v === null || v === '';
    return m[2] ? !isNull : isNull;
  }
  m = cond.match(/^([a-z0-9_]+)\s+like\s+'([^']*)'$/i);
  if (m) {
    const pat = m[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
    return new RegExp(`^${pat}$`, 'i').test(String(r[m[1].toUpperCase()] ?? ''));
  }
  m = cond.match(/^([a-z0-9_]+)\s*(<>|!=|>=|<=|=|>|<)\s*(.*)$/i);
  if (!m) return true;
  const col = m[1].toUpperCase(), op = m[2];
  const lv = r[col];
  const rv = (m[3] || '').trim().replace(/^'/, '').replace(/'$/, '');
  const ln = parseFloat(lv), rn = parseFloat(rv);
  const bothNum = lv !== null && lv !== undefined && lv !== '' && !isNaN(ln) && rv !== '' && !isNaN(rn);
  switch (op) {
    case '=': return bothNum ? ln === rn : String(lv ?? '') === rv;
    case '<>': case '!=': return bothNum ? ln !== rn : String(lv ?? '') !== rv;
    case '>': return bothNum && ln > rn;
    case '<': return bothNum && ln < rn;
    case '>=': return bothNum && ln >= rn;
    case '<=': return bothNum && ln <= rn;
    default: return true;
  }
}

function round2(v) { return Math.round(v * 100) / 100; }

/**
 * 工具执行（模拟后端逻辑）
 */
async function execute(toolId, args) {
  // 模拟网络延迟
  await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));

  switch (toolId) {
    case 'resolve_material': {
      const keyword = args.keyword.toUpperCase();
      const matches = mockData.materials.filter(m =>
        m.matnr.includes(keyword) || m.maktx.includes(keyword)
      );
      return {
        status: 'OK',
        summary: `找到 ${matches.length} 个物料`,
        rows: matches.length,
        data: { materials: matches }
      };
    }

    case 'get_stock': {
      const { material, plant } = args;
      const stocks = mockData.stock.filter(s =>
        s.matnr === material && s.werks === plant
      );
      const total = stocks.reduce((sum, s) => sum + s.labst, 0);
      return {
        status: stocks.length > 0 ? 'OK' : 'NOT_FOUND',
        summary: `${material} 在 ${plant} 库存 ${total} ${stocks[0]?.meins || ''}`,
        rows: stocks.length,
        data: { stocks, total }
      };
    }

    case 'get_movements': {
      const { material, plant, date } = args;
      const movements = mockData.movements.filter(m =>
        m.matnr === material && m.werks === plant && m.budat === date
      );
      const receipt = movements.filter(m => m.shkzg === 'S').reduce((sum, m) => sum + m.menge, 0);
      const issue = movements.filter(m => m.shkzg === 'H').reduce((sum, m) => sum + m.menge, 0);
      return {
        status: 'OK',
        summary: `${date} 收 ${receipt} 发 ${issue}`,
        rows: movements.length,
        data: { movements, receipt, issue }
      };
    }

    case 'search_tables': {
      const keyword = args.keyword.toLowerCase();
      // 先整词匹配；0 结果时分词回退（对照真实 DDIC 检索的多策略回退）
      let matches = Object.entries(mockData.tables)
        .filter(([name, info]) =>
          name.toLowerCase().includes(keyword) ||
          info.desc_cn.includes(args.keyword) ||
          info.desc_en.toLowerCase().includes(keyword)
        );
      if (matches.length === 0 && args.keyword.length > 2) {
        const terms = args.keyword.match(/[一-龥]{2}|[A-Za-z0-9]+/g) || [];
        matches = Object.entries(mockData.tables)
          .filter(([, info]) =>
            terms.some(t =>
              info.desc_cn.includes(t) ||
              info.desc_en.toLowerCase().includes(t.toLowerCase())
            )
          );
      }
      matches = matches.map(([name, info]) => ({ tabname: name, ...info }));
      return {
        status: 'OK',
        summary: `找到 ${matches.length} 张表`,
        rows: matches.length,
        data: { tables: matches }
      };
    }

    case 'describe_table': {
      const table = args.table.toUpperCase();
      const fields = mockData.fields[table];
      if (!fields) {
        return {
          status: 'NOT_FOUND',
          summary: `表 ${table} 不存在或无权限`,
          rows: 0,
          data: { error: 'Table not found' }
        };
      }
      return {
        status: 'OK',
        summary: `${table} 有 ${fields.length} 个字段`,
        rows: fields.length,
        data: { fields }
      };
    }

    case 'run_sql': {
      const { sql, purpose } = args;

      // 模拟 SQL 校验（对照 ZCL_AI_SQL_GUARD）
      if (!/^SELECT/i.test(sql)) {
        return {
          status: 'REJECTED',
          summary: 'SQL 必须以 SELECT 开头',
          rows: 0,
          data: { error: '只允许 SELECT 语句' }
        };
      }
      if (/DELETE|UPDATE|INSERT|DROP/i.test(sql)) {
        return {
          status: 'REJECTED',
          summary: '检测到写操作关键字',
          rows: 0,
          data: { error: '禁止写操作' }
        };
      }

      // 10.28 #02：与 ZCL_AI_SQL_GUARD V1.2.3 一致，通用 SQL 写法在校验阶段就拒绝并给出改法
      const dialectErr = sqlDialectError(sql);
      if (dialectErr) {
        return { status: 'REJECTED', summary: 'SQL 写法不符合 Open SQL', rows: 0, data: { error: dialectErr } };
      }

      // 执行（轻量 SELECT 引擎：WHERE/GROUP BY/聚合/ORDER BY）
      const mockResult = execMockSelect(sql);
      const columns = mockResult.length > 0 ? Object.keys(mockResult[0]) : [];

      return {
        status: mockResult.length > 0 ? 'OK' : 'ERROR',
        summary: mockResult.length > 0
          ? `${purpose}: ${mockResult.length} 行`
          : `查询无结果`,
        rows: mockResult.length,
        data: {
          dataset: {
            name: purpose,
            columns: columns,
            rows: mockResult,
            total_rows: mockResult.length
          }
        }
      };
    }

    default:
      return {
        status: 'ERROR',
        summary: `未知工具: ${toolId}`,
        rows: 0,
        data: { error: 'Unknown tool' }
      };
  }
}

/**
 * 对照 ZCL_AI_SQL_GUARD V1.2.3（10.28 记录 #02）：单引号常量换成空格后，按 SAP 端同样的顺序检查
 * 模型常写的通用 SQL 写法，返回给模型的提示与 SAP 端一致；返回空串表示通过。
 */
function stripSqlLiterals(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, (m) => ' '.repeat(m.length));
}
function sqlDialectError(sql, today) {
  const work = String(sql || '').trim().replace(/\.+\s*$/, '');
  const bare = stripSqlLiterals(work.toUpperCase());
  const pad = ' ' + bare + ' ';
  if (/[A-Z_][A-Z0-9_]*\.[A-Z_*]/.test(bare)) {
    return '字段请写成 别名~字段(如 K~AUFNR、P~WEMNG), Open SQL 不用点号 . 限定字段; 表别名写在 FROM / JOIN 后(如 FROM AFKO AS K)';
  }
  if (bare.includes(';')) { return '只允许单条 SELECT 语句, 不要写分号 ;'; }
  if (bare.includes('"')) { return '不允许使用双引号: 别名直接写英文(如 AS WIP_QTY), 不要加引号; 字符串常量用单引号'; }
  if (bare.includes('`')) { return '不允许使用反引号, 字符串常量用单引号'; }
  if (/[^A-Z0-9_~,()=<>*+\-/%:@!&|^?[\]{}$#.\\ ']/.test(bare)) {
    return '别名和字段名只能用英文字母、数字、下划线(检测到中文或全角符号); 中文只能出现在单引号常量里, 逗号和括号用半角';
  }
  if (/[^A-Z0-9_](LIMIT|TOP\s+[0-9]+|FETCH\s+FIRST)[^A-Z0-9_]/.test(pad)) {
    return '不支持 LIMIT / TOP / FETCH FIRST: 返回行数由系统控制; 需要前 N 条请 ORDER BY 后在回答里取前 N 条';
  }
  if (/[^A-Z0-9_](CURRENT_DATE|CURRENT_TIMESTAMP|SYSDATE|GETDATE|NOW\s*\(|SY-DATUM|SY-UZEIT)/.test(pad)) {
    const d = today || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `不支持取当前日期的函数或 sy-datum: 请直接写日期常量, 今天是 '${d}'`;
  }
  if (/[^A-Z0-9_](DATEDIFF|DATE_DIFF|DATEADD|DATE_ADD|DATE_FORMAT|TO_CHAR|TO_DATE|EXTRACT|YEAR|MONTH)\s*\(/.test(pad)) {
    return '日期直接按 YYYYMMDD 字符串比较; 日期差用 DATS_DAYS_BETWEEN( 日期1, 日期2 ), 加减天数用 DATS_ADD_DAYS( 日期, 天数 ), 取年月用 SUBSTRING( 日期, 1, 6 )';
  }
  if (/[^A-Z0-9_](IFNULL|NVL|ISNULL)\s*\(/.test(pad)) { return '空值处理请用 COALESCE( 字段, 默认值 )'; }
  return '';
}

/**
 * 对照 ZCL_AI_SQL_EXECUTOR V1.3：模型 SQL 放进生成程序时每行 ≤ 180 字符，
 * 只在常量之外的空格（不保留）或逗号（留在本行）处断开；找不到安全断点返回 null。
 */
function splitSqlLines(sql, max = 180) {
  const out = [];
  let spos = 0;
  while (spos < sql.length) {
    const rest = sql.length - spos;
    if (rest <= max) { out.push(sql.substr(spos, rest)); break; }
    let scut = -1;
    for (let scand = spos + max; scand > spos; scand--) {
      const ch = sql[scand];
      if ((ch === ' ' || ch === ',') && ((sql.slice(0, scand).match(/'/g) || []).length % 2 === 0)) { scut = scand; break; }
    }
    if (scut < 0) { return null; }
    out.push(sql.substr(spos, sql[scut] === ',' ? scut - spos + 1 : scut - spos));
    spos = scut + 1;
  }
  return out;
}

module.exports = { getToolsForDomain, execute, sqlDialectError, splitSqlLines };
