// 本地 MCP 测试服务器：支持 Streamable HTTP 与 HTTP+SSE 两种传输。
// 仅用于集成测试，绑定 127.0.0.1，端口由 argv[2] 指定。
//
// 用法：
//   node mcp_http_server.mjs <streamable|sse> <port>
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const mode = process.argv[2] ?? 'streamable';
const port = Number(process.argv[3] ?? 8791);

const TOOLS = [{
  name: 'echo',
  description: '返回输入内容。',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}];

function handle(message) {
  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: `agent-llm-test-${mode}`, version: '1.0.0' },
      },
    };
  }
  if (message.method === 'tools/list') {
    return { jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } };
  }
  if (message.method === 'tools/call') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: String(message.params.arguments?.value ?? '') }],
        isError: false,
      },
    };
  }
  if (message.method?.startsWith('notifications/')) return null;
  return {
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: `unknown method ${message.method}` },
  };
}

// ---- Streamable HTTP：POST 到同一路径，按 Accept 决定 JSON 还是 SSE ----
const streamableSessions = new Set();
const streamableHandler = (req, res) => {
  if (req.method === 'DELETE') {
    res.writeHead(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    // 首次请求下发会话 id，客户端后续必须带上。
    const sessionId = req.headers['mcp-session-id'] ?? randomUUID();
    streamableSessions.add(sessionId);

    const response = handle(message);
    const headers = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Mcp-Session-Id': sessionId,
    };
    res.writeHead(200, headers);
    if (response) {
      res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    }
    res.end();
  });
};

// ---- HTTP+SSE：GET 建立长连，先下发 endpoint，再推 message ----
const sseClients = new Set();
const sseHandler = (req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: endpoint\ndata: /messages?sessionId=${randomUUID()}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  res.writeHead(405).end();
};

const messageHandler = (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const response = handle(message);
    if (response) {
      const payload = `event: message\ndata: ${JSON.stringify(response)}\n\n`;
      for (const client of sseClients) client.write(payload);
    }
    // 旧版 SSE 传输：POST 只回 202，结果走长连。
    res.writeHead(202).end();
  });
};

const server = http.createServer((req, res) => {
  if (mode === 'sse') {
    if (req.url.startsWith('/messages')) return messageHandler(req, res);
    return sseHandler(req, res);
  }
  return streamableHandler(req, res);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`listening ${mode} on ${port}\n`);
});
