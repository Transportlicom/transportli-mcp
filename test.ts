// Starts a stand-in API and the MCP server, connects a real MCP client and checks tools, key forwarding and errors.
import http from 'node:http';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const seen: { method: string; url: string; auth?: string; body?: any; xff?: string }[] = [];
const fake = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, xff: String(req.headers['x-forwarded-for'] ?? ''), body: raw ? JSON.parse(raw) : undefined });
  const send = (s: number, j: any) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  if (req.url === '/api/v1/estimates') return send(200, { lowest: 760, medium: 890, highest: 1190, currency: 'USD', miles: 1280 });
  if (!req.headers.authorization) return send(401, { error: { code: 'unauthorized', message: 'no key' } });
  if (req.url === '/api/v1/requests') return send(201, { id: 'TL-ABC234', status: 'awaiting_customer_confirmation' });
  if (req.url === '/api/v1/requests/TL-ABC234/quotes') return send(200, { quotes: [{ price: 800 }], summary: { count: 1, lowest: 800, medium: 800, highest: 800 } });
  if (req.url === '/api/v1/requests/TL-ABC234/cancel') return send(200, { status: 'cancelled' });
  return send(404, { error: { code: 'not_found', message: 'x' } });
});
await new Promise<void>((r) => fake.listen(3991, r));
process.env.TL_API_BASE = 'http://localhost:3991';
const { startServer } = await import('./server.ts');
const mcpHttp = await startServer(3992);

const connect = async (key?: string) => {
  const c = new Client({ name: 'test-agent', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3992/mcp'), key ? { requestInit: { headers: { authorization: 'Bearer ' + key } } } : undefined));
  return c;
};
const text = (r: any) => JSON.parse(r.content[0].text);
const KEY = 'tl_live_' + 'k'.repeat(30);

const anon = await connect();
const tools = (await anon.listTools()).tools;
assert.deepEqual(tools.map((t) => t.name).sort(), ['cancel_request', 'create_shipping_request', 'estimate_car_shipping', 'get_quotes', 'get_request']);
assert.equal(tools.find((t) => t.name === 'estimate_car_shipping')!.annotations?.readOnlyHint, true);
assert.equal(tools.find((t) => t.name === 'cancel_request')!.annotations?.destructiveHint, true);

// estimate works without a key and returns the three prices
const e = await anon.callTool({ name: 'estimate_car_shipping', arguments: { pickup: { zip: '33101' }, delivery: { city: 'Austin', state: 'TX' } } });
assert.equal(text(e).lowest, 760); assert.ok(!e.isError); assert.equal(seen.at(-1)!.auth, undefined); assert.ok(seen.at(-1)!.xff, 'the caller IP is forwarded to the API');
assert.deepEqual(seen.at(-1)!.body.pickup, { zip: '33101' });
// keyed tools refuse politely without a key, and never call the API
const n = seen.length;
const noKey = await anon.callTool({ name: 'create_shipping_request', arguments: { customer: { first_name: 'A', email: 'a@x.test' }, pickup: { zip: '33101' }, delivery: { zip: '73301' }, vehicles: [{ type: 'sedan' }] } });
assert.equal(noKey.isError, true); assert.equal(text(noKey).error.code, 'unauthorized'); assert.equal(seen.length, n);
// input validation happens before anything is sent
await assert.rejects(anon.callTool({ name: 'get_quotes', arguments: { request_id: '../etc/passwd' } }).then((r: any) => { if (r.isError) throw new Error('rejected'); }));

// with a key: the key is forwarded as the Bearer token
const agent = await connect(KEY);
const c = await agent.callTool({ name: 'create_shipping_request', arguments: { customer: { first_name: 'Ann', email: 'ann@x.test' }, pickup: { zip: '33101' }, delivery: { zip: '73301' }, vehicles: [{ year: 2019, make: 'Honda', model: 'Civic' }] } });
assert.equal(text(c).id, 'TL-ABC234'); assert.equal(seen.at(-1)!.auth, 'Bearer ' + KEY); assert.equal(seen.at(-1)!.method, 'POST');
const q = await agent.callTool({ name: 'get_quotes', arguments: { request_id: 'TL-ABC234' } });
assert.equal(text(q).summary.lowest, 800); assert.equal(seen.at(-1)!.url, '/api/v1/requests/TL-ABC234/quotes');
const x = await agent.callTool({ name: 'cancel_request', arguments: { request_id: 'TL-ABC234' } });
assert.equal(text(x).status, 'cancelled');
const missing = await agent.callTool({ name: 'get_request', arguments: { request_id: 'TL-NOPE99' } });
assert.equal(missing.isError, true); assert.equal(text(missing).error.code, 'not_found');
// a bad key is passed on and the API's 401 comes back as a tool error
const nk = await (await connect('not-a-key')).callTool({ name: 'get_quotes', arguments: { request_id: 'TL-ABC234' } });
assert.equal(nk.isError, true);
// GET on /mcp is refused (stateless server)
assert.equal((await fetch('http://localhost:3992/mcp')).status, 405);
assert.equal((await fetch('http://localhost:3992/health')).status, 200);
console.log('MCP server test passed');
process.exit(0);
