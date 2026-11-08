import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SapClient } from './sap-client.js';

const server = new McpServer({ name: 'lingxi-sap', version: '0.1.0' });

function register(name, description, inputSchema, action, scene, mapParams) {
  server.registerTool(name, {
    description, inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
  }, async (args, extra) => {
    try {
      const sap = new SapClient();
      const result = await sap.call(action, mapParams(args), scene, extra.signal);
      if (action === 'ReportResult') {
        // 原结果接口按所有者校验；再次读取当前可用目录，避免报表授权撤销后仍向模型返回旧结果。
        const id = String(result.data?.reportId ?? result.data?.REPORT_ID ?? result.data?.report_id ?? '').trim().toUpperCase();
        const catalog = await sap.call('ReportDefinitions', {}, 'REPORT', extra.signal);
        if (!id || !Array.isArray(catalog.data) || !catalog.data.some((row) =>
          String(row.REPORT_ID ?? row.reportId ?? row.report_id ?? '').trim().toUpperCase() === id)) {
          throw new Error('无法确认当前用户仍有该报表的权限，已拒绝读取结果。');
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'SAP 调用失败。' }] };
    }
  });
}

register('sap_report_definitions', '获取当前 SAP 用户可使用的已登记报表及参数定义。', {}, 'ReportDefinitions', 'REPORT', () => ({}));
register('sap_report_result', '读取当前 SAP 用户有权访问的已完成报表结果；返回行数受 SAP 配置限制。', {
  artifactId: z.string().trim().min(1).max(128).describe('SAP 报表结果的完整 ArtifactId')
}, 'ReportResult', 'REPORT', ({ artifactId }) => ({ ArtifactId: artifactId }));
register('sap_fiori_report_definitions', '获取当前 SAP 用户可使用的 Fiori 报表目录。', {}, 'FioriReportDefs', 'FIORI', () => ({}));

await server.connect(new StdioServerTransport());
