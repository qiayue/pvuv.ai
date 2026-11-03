#!/usr/bin/env node
/**
 * pvuv.ai MCP server (PROJECT_PLAN.md §10) — exposes a site's analytics and
 * invalid-traffic data as MCP tools, so an owner can ask their own chatbot
 * questions like "how much of yesterday's traffic was bots?".
 *
 * Deliberately dependency-free: it speaks the MCP stdio protocol (JSON-RPC 2.0
 * over newline-delimited stdin/stdout) directly. A self-hosted analytics tool
 * should not require an npm install — `node mcp/index.mjs` is the whole setup,
 * and there is no supply chain to audit for something holding a read token.
 *
 * Configure (e.g. in Claude Desktop's config):
 *   {"mcpServers":{"pvuv":{"command":"node","args":["/path/to/pvuv.ai/mcp/index.mjs"],
 *     "env":{"PVUV_API_URL":"https://api.example.com","PVUV_TOKEN":"pvuv_…"}}}}
 *
 * The token is a read-only personal API token minted in the console. This
 * server performs GETs only — it can never mutate a deployment.
 */

import { createInterface } from 'node:readline';
import { PROTOCOL_VERSION, SERVER_INFO, TOOLS, callTool, requireConfig } from './tools.mjs';

const rl = createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function reply(id, result) {
  if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, result });
}
function fail(id, code, message) {
  if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // notifications carry no id and expect no response
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      try {
        const text = await callTool(name, params?.arguments ?? {});
        return reply(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        // Report tool failures as tool results, not protocol errors: the model
        // should see "that site id doesn't exist" and correct itself rather
        // than the conversation breaking.
        return reply(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `unknown method: ${method}`);
  }
}

rl.on('line', async (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { return fail(null, -32700, 'parse error'); }
  try { await handle(msg); } catch (err) { fail(msg?.id, -32603, err.message); }
});

// Fail loudly at startup rather than on the first tool call — a misconfigured
// server that looks healthy until the user asks a question is worse than one
// that refuses to start with a clear message.
try {
  requireConfig();
} catch (err) {
  process.stderr.write(`pvuv-mcp: ${err.message}\n`);
  process.exit(1);
}
process.stderr.write(`pvuv-mcp ready (${process.env.PVUV_API_URL})\n`);
