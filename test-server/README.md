# SAP Agent 本地测试环境

## 快速开始

### 1. 安装依赖

```bash
cd test-server
npm install
```

### 2. 配置 DeepSeek API Key

```bash
export DEEPSEEK_API_KEY=your-key-here
```

或者在 `agent-loop.js` 第 10 行直接改：

```javascript
const DEEPSEEK_API_KEY = 'your-key-here';
```

### 3. 启动 Mock 服务器

```bash
npm start
```

服务器默认运行在 `http://localhost:3000`

### 4. 测试工作流

**终端测试**：

```bash
# 库存查询测试
curl -X POST http://localhost:3000/AnalyzeAgent \
  -H "Content-Type: application/json" \
  -d '{"question":"查询物料 MAT001 在工厂 1000 的库存"}'

# SQL 分析测试
curl -X POST http://localhost:3000/AnalyzeAgent \
  -H "Content-Type: application/json" \
  -d '{"question":"统计采购订单数量，按供应商分组"}'
```

**前端测试**：

修改 `webapp/service/ChatService.js` 第 20 行：

```javascript
// 原来
// var sServiceUrl = "/sap/opu/odata/sap/ZSAP_AI_CHAT_SRV";

// 改成
var sServiceUrl = "http://localhost:3000";
```

然后启动前端：

```bash
cd ..
npm start
```

访问 `http://localhost:8080`，正常对话即可。

---

## 架构说明

```
前端 webapp/
  ↓ HTTP POST /AnalyzeAgent
test-server/
  ├── server.js          ← Express 服务器，模拟 OData 端点
  ├── agent-loop.js      ← Agent 循环逻辑（对照 ZCL_AI_AGENT_SERVICE）
  ├── mock-tools.js      ← Mock 工具（模拟库存/SQL 工具）
  └── mock-data          ← 内存数据（物料/库存/表结构）
       ↓
  DeepSeek API (外网模型)
```

---

## Mock 数据说明

### 物料主数据（3 条）

| 料号   | 描述         | 类型 | 单位 |
|--------|--------------|------|------|
| MAT001 | 钢板 Q235    | ROH  | KG   |
| MAT002 | 电机 YE3-100 | FERT | EA   |
| MAT003 | 螺栓 M8      | HIBE | PC   |

### 库存数据（工厂 1000）

| 料号   | 库位 | 非限制库存 |
|--------|------|------------|
| MAT001 | 1001 | 5000 KG    |
| MAT001 | 1002 | 3000 KG    |
| MAT002 | 1001 | 120 EA     |

### 表目录（6 张表）

- MARA（物料主数据）
- MARC（物料工厂视图）
- MARD（库位库存）
- EKKO（采购订单头）
- EKPO（采购订单行项目）
- VBAK（销售订单头）

每张表都有字段定义，`describe_table` 会返回。

---

## 测试用例

### 用例 1：库存查询（工具链：resolve_material → get_stock）

```json
{
  "question": "查询钢板在工厂 1000 的库存"
}
```

**预期流程**：
1. 意图路由 → INVENTORY 域
2. 第 1 轮：模型调用 `resolve_material`，关键词 "钢板"
3. 工具返回：MAT001（钢板 Q235）
4. 第 2 轮：模型调用 `get_stock`，料号 MAT001，工厂 1000
5. 工具返回：库位 1001（5000 KG）+ 库位 1002（3000 KG）
6. 第 3 轮：模型 `action=final`，回答 "合计 8000 KG"

### 用例 2：SQL 分析（工具链：search_tables → describe_table → run_sql）

```json
{
  "question": "统计销售订单，按客户分组"
}
```

**预期流程**：
1. 意图路由 → DATA 域（领域卡里有 SQL 规范）
2. 第 1 轮：模型调用 `search_tables`，关键词 "销售订单"
3. 工具返回：VBAK（销售订单头）
4. 第 2 轮：模型调用 `describe_table`，表 VBAK
5. 工具返回：字段列表（VBELN/KUNNR/NETWR/ERDAT）
6. 第 3 轮：模型调用 `run_sql`，SQL: `SELECT KUNNR, COUNT(*) AS CNT, SUM(NETWR) AS TOTAL FROM VBAK GROUP BY KUNNR`
7. 工具返回：3 行聚合结果
8. 第 4 轮：模型 `action=final`，回答 "共 3 个客户，C001 有 2 单..."

### 用例 3：安全拦截测试（验证 SQL 校验）

```json
{
  "question": "删除 MARA 表里的所有数据"
}
```

**预期流程**：
1. 意图路由 → DATA 域
2. 模型可能尝试调用 `run_sql`，SQL 含 `DELETE`
3. Mock 工具检测到 `DELETE` 关键字 → 返回 `status: REJECTED`
4. 模型收到拒绝 → `action=final`，回答 "抱歉，只能执行只读查询"

---

## 如何扩展 Mock 数据

### 加新物料

编辑 `mock-tools.js` 第 80 行：

```javascript
materials: [
  { matnr: 'MAT004', maktx: '你的新物料', mtart: 'FERT', meins: 'EA', werks: '1000' }
]
```

### 加新表

编辑 `mock-tools.js` 第 100 行：

```javascript
tables: {
  YOUR_TABLE: { desc_cn: '你的表描述', desc_en: 'Your Table' }
}
```

编辑 `mock-tools.js` 第 115 行：

```javascript
fields: {
  YOUR_TABLE: [
    { fieldname: 'FIELD1', desc: '字段1', datatype: 'CHAR', length: 10 }
  ]
}
```

编辑 `mock-tools.js` 第 230 行（run_sql 的模拟执行）：

```javascript
else if (/FROM\s+YOUR_TABLE/i.test(sql)) {
  mockResult = [ /* 你的模拟数据 */ ];
}
```

---

## 与真实 SAP 的差异

| 项目 | Mock 版本 | 真实 SAP |
|------|-----------|----------|
| 数据源 | 内存 JS 对象 | S/4HANA 数据库 |
| SQL 校验 | 简单正则（只拦黑名单关键字） | ZCL_AI_SQL_GUARD 完整校验 |
| 表权限 | 无 | VIEW_AUTHORITY_CHECK |
| 审计日志 | 无 | ZAI_SQL_LOG / ZAI_AGENT_STEP |
| 模型 | DeepSeek | Azure OpenAI（可配） |
| 工具数量 | 6 个（库存 3 + SQL 3） | 11 个（含批次/收发/受控取数） |

**结论**：Mock 版本只能验证 **Agent 工作流逻辑**（意图路由 → 工具调用 → 循环收口），**不能验证安全性**（表权限/黑名单/审计）和真实数据。

---

## 真实部署后的切换

把前端 `ChatService.js` 改回：

```javascript
var sServiceUrl = "/sap/opu/odata/sap/ZSAP_AI_CHAT_SRV";
```

其余代码无需改动，前端会自动请求真实的 SAP Gateway。

---

## 故障排查

### 问题 1：DeepSeek API 超时

**症状**：`ECONNREFUSED` 或 `timeout`  
**原因**：网络/API Key 错误/配额用尽  
**解决**：检查 API Key，或换成本地 Ollama：

```javascript
// agent-loop.js 第 50 行改成
const response = await axios.post(
  'http://localhost:11434/api/chat',  // Ollama
  { model: 'qwen2.5', messages: messages }
);
```

### 问题 2：前端 CORS 错误

**症状**：`Access-Control-Allow-Origin`  
**原因**：浏览器跨域限制  
**解决**：已在 `server.js` 加了 `cors()`，重启服务器

### 问题 3：模型不调用工具

**症状**：直接 `action=final`，没有 EXECUTING 步骤  
**原因**：领域卡没命中，或模型判断不需要工具  
**调试**：
1. 检查 `matchDomain()` 是否正确路由
2. 终端看 `console.log('模型输出:', parsed)`
3. 如果模型说"我无法查询"，说明领域卡没生效，检查 systemPrompt

---

## 下一步

1. **验证工作流**：用 Mock 版本跑通库存/SQL 两个场景，确认意图路由、工具调用、循环收口都正确
2. **真实 SAP 部署**：按《SE11对象与配置清单》激活后端
3. **逐步迁移数据**：Mock 里验证过的场景，在真实 SAP 上重测，对比差异
4. **扩展工具**：需要新业务功能时，先在 Mock 版本加工具验证流程，再写 ABAP

---

## 文件清单

```
test-server/
├── package.json       ← 依赖声明
├── server.js          ← Express 服务器（114 行）
├── agent-loop.js      ← Agent 循环（153 行）
├── mock-tools.js      ← Mock 工具实现（267 行）
└── README.md          ← 本文件
```

**总计 534 行 JS 代码，完整复现后端 Agent 工作流。**
