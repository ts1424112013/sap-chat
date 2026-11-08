import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP 通过灵犀登录后调用 SAP，并遵守场景权限', async (t) => {
  let scenes = 'REPORT';
  let allowLogin = true;
  let allowReport = true;
  const calls = [];
  const sap = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push({ path: url.pathname, params: url.searchParams, cookie: req.headers.cookie });
    assert.equal(req.headers.authorization, `Basic ${Buffer.from('TEST:secret').toString('base64')}`);
    assert.equal(url.searchParams.get('sap-client'), '470');
    if (url.pathname.endsWith('/$metadata')) {
      res.writeHead(200, { 'x-csrf-token': 'test-token', 'set-cookie': 'SAP_SESSIONID=test; Path=/' });
      return res.end('<metadata/>');
    }
    if (url.pathname.endsWith('/Login')) {
      assert.equal(req.method, 'POST');
      assert.equal(req.headers['x-csrf-token'], 'test-token');
      assert.match(req.headers.cookie, /SAP_SESSIONID=test/);
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'LOGIN=yes; Path=/' });
      return res.end(JSON.stringify({ d: { Login: { Success: allowLogin ? 'X' : '', Message: allowLogin ? '' : '账号未开通', Json: JSON.stringify({ Role: 'USER', Scenes: scenes }) } } }));
    }
    assert.match(req.headers.cookie, /LOGIN=yes/);
    res.writeHead(200, { 'content-type': 'application/json' });
    const result = url.pathname.endsWith('/ReportDefinitions') ? (allowReport ? [{ REPORT_ID: 'R1' }] : []) : { artifactId: 'A1', reportId: 'R1', rowsJson: '[]' };
    res.end(JSON.stringify({ d: { Success: 'X', Message: '', ResultJson: JSON.stringify(result) } }));
  });
  await new Promise((resolve) => sap.listen(0, '127.0.0.1', resolve));
  t.after(() => sap.close());
  const script = fileURLToPath(new URL('../src/server.js', import.meta.url));
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [script],
    env: { PATH: process.env.PATH, SAP_ODATA_URL: `http://127.0.0.1:${sap.address().port}/odata/`, SAP_CLIENT: '470', SAP_USER: 'TEST', SAP_PASSWORD: 'secret' }
  });
  await client.connect(transport);
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['sap_fiori_report_definitions', 'sap_report_definitions', 'sap_report_result']);
  const definitions = await client.callTool({ name: 'sap_report_definitions', arguments: {} });
  assert.equal(definitions.isError, undefined);
  assert.equal(JSON.parse(definitions.content[0].text).data[0].REPORT_ID, 'R1');
  const result = await client.callTool({ name: 'sap_report_result', arguments: { artifactId: "A'B&" } });
  assert.equal(result.isError, undefined);
  assert.equal(calls.find((c) => c.path.endsWith('/ReportResult')).params.get('ArtifactId'), "'A''B&'");
  allowReport = false;
  const revoked = await client.callTool({ name: 'sap_report_result', arguments: { artifactId: 'A1' } });
  assert.equal(revoked.isError, true);
  assert.match(revoked.content[0].text, /权限/);
  const blocked = await client.callTool({ name: 'sap_fiori_report_definitions', arguments: {} });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /未开放/);
  assert.equal(calls.some((c) => c.path.endsWith('/FioriReportDefs')), false);
  allowLogin = false;
  const denied = await client.callTool({ name: 'sap_report_definitions', arguments: {} });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /账号未开通/);
  assert.equal(calls.filter((c) => c.path.endsWith('/ReportDefinitions')).length, 3);
});
