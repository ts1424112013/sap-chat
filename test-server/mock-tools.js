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
      description: '执行只读 SELECT 语句',
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

  // 表目录
  tables: {
    MARA: { desc_cn: '物料主数据', desc_en: 'General Material Data' },
    MARC: { desc_cn: '物料工厂视图', desc_en: 'Plant Data for Material' },
    MARD: { desc_cn: '库位库存', desc_en: 'Storage Location Data for Material' },
    EKKO: { desc_cn: '采购订单头', desc_en: 'Purchasing Document Header' },
    EKPO: { desc_cn: '采购订单行项目', desc_en: 'Purchasing Document Item' },
    VBAK: { desc_cn: '销售订单头', desc_en: 'Sales Document: Header Data' }
  },

  // 表字段
  fields: {
    MARA: [
      { fieldname: 'MATNR', desc: '物料号', datatype: 'CHAR', length: 18 },
      { fieldname: 'MTART', desc: '物料类型', datatype: 'CHAR', length: 4 },
      { fieldname: 'MEINS', desc: '基本单位', datatype: 'UNIT', length: 3 },
      { fieldname: 'MAKTX', desc: '物料描述', datatype: 'CHAR', length: 40 }
    ],
    EKKO: [
      { fieldname: 'EBELN', desc: '采购订单号', datatype: 'CHAR', length: 10 },
      { fieldname: 'BUKRS', desc: '公司代码', datatype: 'CHAR', length: 4 },
      { fieldname: 'LIFNR', desc: '供应商', datatype: 'CHAR', length: 10 },
      { fieldname: 'BEDAT', desc: '凭证日期', datatype: 'DATS', length: 8 }
    ],
    VBAK: [
      { fieldname: 'VBELN', desc: '销售订单号', datatype: 'CHAR', length: 10 },
      { fieldname: 'ERDAT', desc: '创建日期', datatype: 'DATS', length: 8 },
      { fieldname: 'KUNNR', desc: '客户编号', datatype: 'CHAR', length: 10 },
      { fieldname: 'NETWR', desc: '净值', datatype: 'CURR', length: 15 }
    ]
  }
};

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
      const matches = Object.entries(mockData.tables)
        .filter(([name, info]) =>
          name.toLowerCase().includes(keyword) ||
          info.desc_cn.includes(args.keyword) ||
          info.desc_en.toLowerCase().includes(keyword)
        )
        .map(([name, info]) => ({ tabname: name, ...info }));
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

      // 简单模拟 SQL 校验（对照 ZCL_AI_SQL_GUARD）
      const sqlUpper = sql.toUpperCase();
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

      // 简单模拟执行结果（根据 FROM 子句）
      let mockResult = [];
      if (/FROM\s+MARA/i.test(sql)) {
        mockResult = mockData.materials.map(m => ({
          MATNR: m.matnr,
          MAKTX: m.maktx,
          MTART: m.mtart,
          MEINS: m.meins
        }));
      } else if (/FROM\s+EKKO/i.test(sql)) {
        mockResult = [
          { EBELN: '4500000001', BUKRS: '1000', LIFNR: 'V001', BEDAT: '20261001' },
          { EBELN: '4500000002', BUKRS: '1000', LIFNR: 'V002', BEDAT: '20261003' }
        ];
      } else if (/FROM\s+VBAK/i.test(sql)) {
        mockResult = [
          { VBELN: '8000000001', ERDAT: '20260901', KUNNR: 'C001', NETWR: '50000.00' },
          { VBELN: '8000000002', ERDAT: '20260915', KUNNR: 'C002', NETWR: '120000.00' },
          { VBELN: '8000000003', ERDAT: '20261001', KUNNR: 'C001', NETWR: '75000.00' }
        ];
      }

      return {
        status: mockResult.length > 0 ? 'OK' : 'ERROR',
        summary: mockResult.length > 0
          ? `${purpose}: ${mockResult.length} 行`
          : `查询无结果`,
        rows: mockResult.length,
        data: {
          dataset: {
            name: purpose,
            columns: mockResult.length > 0 ? Object.keys(mockResult[0]) : [],
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

module.exports = { getToolsForDomain, execute };
