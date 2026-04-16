/**
 * MCP Server for Browser Agent
 * 
 * Exposes the browser extension as an MCP tool so that AI agents
 * (Antigravity, Claude Desktop, Cursor, etc.) can natively discover
 * and call `ask_browser_ai` without custom API configuration.
 *
 * Communicates via Stdio (standard MCP transport).
 * Internally calls the Bridge Server at http://127.0.0.1:3847.
 *
 * Usage:
 *   node server/mcp_server.js
 *
 * Prerequisites:
 *   - Bridge server must be running (node server/bridge.js)
 *   - Browser extension must be active in a browser tab
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const http = require('http');

const BRIDGE_URL = 'http://127.0.0.1:3847';
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes (matches bridge timeout)

// --- Helper: POST JSON to the bridge server ---
function postJSON(path, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const url = new URL(path, BRIDGE_URL);

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, data: body });
          }
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request to bridge server timed out'));
    });

    req.write(payload);
    req.end();
  });
}

// --- Helper: GET JSON from the bridge server ---
function getJSON(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BRIDGE_URL);

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        timeout: 5000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, data: body });
          }
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request to bridge server timed out'));
    });

    req.end();
  });
}

// --- Create MCP Server ---
const server = new McpServer({
  name: 'browser-agent',
  version: '1.0.0',
});

// --- Tool: ask_browser_ai ---
server.tool(
  'ask_browser_ai',
  'Send a prompt to the browser AI (ChatGPT, Claude, Gemini, etc.) via the browser extension and get the response. The bridge server must be running and the extension must be active in a browser tab.',
  {
    prompt: z.string().describe('The prompt/question to send to the browser AI'),
  },
  async ({ prompt }) => {
    try {
      const result = await postJSON('/v1/chat/completions', {
        model: 'gpt-4o-browser',
        messages: [{ role: 'user', content: prompt }],
      });

      if (result.status !== 200) {
        const errMsg = result.data?.error?.message || JSON.stringify(result.data);
        return {
          content: [{ type: 'text', text: `Error (${result.status}): ${errMsg}` }],
          isError: true,
        };
      }

      const content = result.data?.choices?.[0]?.message?.content || '';
      return {
        content: [{ type: 'text', text: content }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to reach bridge server: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Tool: check_bridge_status ---
server.tool(
  'check_bridge_status',
  'Check the health and status of the bridge server (queue length, active jobs, waiting clients).',
  async () => {
    try {
      const result = await getJSON('/api/status');
      return {
        content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          { type: 'text', text: `Bridge server is not reachable: ${err.message}` },
        ],
        isError: true,
      };
    }
  }
);

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so it doesn't interfere with MCP stdio protocol on stdout
  console.error('Browser Agent MCP Server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error starting MCP server:', err);
  process.exit(1);
});
