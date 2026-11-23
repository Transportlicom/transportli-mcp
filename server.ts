/**
 * Transportli MCP server: lets AI agents get car shipping price ranges, create real shipping requests and read real carrier bids.
 * It is a thin wrapper over the public API (app/api/v1). Remote MCP over HTTP (stateless Streamable HTTP) at POST /mcp.
 * The agent's API key is the Bearer token of the MCP connection and is forwarded to the API; estimates work without a key.
 *   TL_API_BASE=https://app.transportli.com PORT=3200 npx tsx server.ts
 * Two endpoints: /mcp (all five tools, API key optional) and /mcp/estimate (keyless, the price estimate only).
 * Safety by design: no tool books, pays, or contacts carriers directly. Creating a request emails the customer to confirm first.
 */
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const API = (process.env.TL_API_BASE || 'https://app.transportli.com').replace(/\/$/, '');
const PORT = Number(process.env.PORT || 3200);
// Keyless public endpoint (POST /mcp/estimate): only the read-only price estimate, no account needed. It calls the API with an internal key
// (TL_PUBLIC_KEY, sandbox mode, high per-minute limit) so that many agents behind one shared IP (e.g. a hosted AI client) are not throttled together;
// abuse is limited here instead: a per-IP bucket in this process plus a global ceiling.
const PUBLIC_KEY = process.env.TL_PUBLIC_KEY || undefined;
const PUBLIC_PER_IP = Number(process.env.PUBLIC_PER_IP || 120), PUBLIC_GLOBAL = Number(process.env.PUBLIC_GLOBAL || 1500);
const buckets = new Map<string, { n: number; reset: number }>();
export function allow(bucket: string, max: number, now = Date.now()) {
  const b = buckets.get(bucket);
  if (!b || b.reset <= now) { buckets.set(bucket, { n: 1, reset: now + 60_000 }); return true; }
  return ++b.n <= max;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of buckets) if (v.reset <= t) buckets.delete(k); }, 60_000).unref();

const place = z.object({
  zip: z.string().regex(/^\d{5}$/).optional().describe('5-digit US ZIP code'),
  city: z.string().max(80).optional(),
  state: z.string().length(2).optional().describe('2-letter state code, e.g. FL'),
}).describe('A US location: give a ZIP code, or a city and a state.');
const vehicle = z.object({
  year: z.number().int().optional(), make: z.string().max(40).optional(), model: z.string().max(60).optional(),
  type: z.enum(['sedan', 'suv', 'pickup', 'van']).optional().describe('Vehicle class. Required if make and model are not given.'),
  running: z.boolean().optional().describe('false if the vehicle does not run (adds cost)'),
});

async function api(path: string, key: string | undefined, ip: string | undefined, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(API + path, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', 'user-agent': 'transportli-mcp/1.0', ...(key ? { authorization: 'Bearer ' + key } : {}), ...(ip ? { 'x-forwarded-for': ip } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = { error: { code: 'bad_response', message: text.slice(0, 200) } }; }
  return { ok: res.ok, status: res.status, json };
}
const out = (r: { ok: boolean; json: any }) => ({ content: [{ type: 'text' as const, text: JSON.stringify(r.json, null, 2) }], ...(r.ok ? {} : { isError: true }) });
const needKey = { content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: 'unauthorized', message: 'This tool needs a Transportli API key. Ask the user to get one at https://transportli.com/ and connect this server with it as the Bearer token.' } }) }], isError: true };

export function buildServer(key: string | undefined, ip?: string, publicOnly = false) {
  const s = new McpServer({ name: 'transportli-car-shipping', version: '1.0.0' });

  s.registerTool('estimate_car_shipping', {
    title: 'Estimate car shipping price',
    description: 'Price range for shipping a car in the US: lowest, medium and highest total price in US dollars, plus the distance. Based on Transportli lane data; an estimate, not a committed price. Use this to answer "how much does it cost to ship a car from A to B". Works without an API key.',
    inputSchema: { pickup: place, delivery: place, vehicles: z.array(vehicle).max(6).optional().describe('Default: one running sedan'), trailer: z.enum(['open', 'enclosed']).optional().describe('Default: open') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => {
    if (publicOnly && !allow('ip:' + (ip ?? '?'), PUBLIC_PER_IP)) return out({ ok: false, json: { error: { code: 'rate_limited', message: `Too many estimates from this address. Try again in a minute (limit ${PUBLIC_PER_IP} per minute).` } } });
    if (publicOnly && !allow('global', PUBLIC_GLOBAL)) return out({ ok: false, json: { error: { code: 'busy', message: 'The estimate service is busy. Try again in a minute.' } } });
    return out(await api('/api/v1/estimates', key, ip, { method: 'POST', body: a }));
  });
  if (publicOnly) return s;

  s.registerTool('create_shipping_request', {
    title: 'Create a car shipping request',
    description: 'Creates a REAL shipping request that carriers can bid on. Call it only after the customer has confirmed the route, the vehicle and that we may use their email. The customer is emailed a confirmation link before carriers are alerted; nothing is booked or charged. Afterwards use get_quotes to read the real carrier prices. Needs an API key.',
    inputSchema: {
      customer: z.object({ first_name: z.string().min(1).max(60), last_name: z.string().max(60).optional(), email: z.string().email(), phone: z.string().max(25).optional() }),
      pickup: place, delivery: place, vehicles: z.array(vehicle).min(1).max(6),
      trailer: z.enum(['open', 'enclosed']).optional(), timing: z.enum(['asap', 'few_days', 'this_week', 'flexible']).optional(),
      pickup_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Preferred pickup date, YYYY-MM-DD'), notes: z.string().max(500).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (a) => (key ? out(await api('/api/v1/requests', key, ip, { method: 'POST', body: a })) : needKey));

  s.registerTool('get_quotes', {
    title: 'Get carrier quotes',
    description: 'The real carrier bids for a request: each bid with the carrier name, rating, total price in US dollars, pickup window and transit days, plus the lowest, medium and highest bid so far. New bids arrive over minutes to hours; call again later. Needs an API key.',
    inputSchema: { request_id: z.string().regex(/^[A-Za-z0-9-]{4,32}$/).describe('The id returned by create_shipping_request, e.g. TL-K7M2PQ') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ request_id }) => (key ? out(await api(`/api/v1/requests/${encodeURIComponent(request_id)}/quotes`, key, ip)) : needKey));

  s.registerTool('get_request', {
    title: 'Get a shipping request',
    description: 'Status of a request (awaiting_customer_confirmation, collecting_quotes, booked, cancelled...), its route, vehicles, the price estimate and the bids. Needs an API key.',
    inputSchema: { request_id: z.string().regex(/^[A-Za-z0-9-]{4,32}$/) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ request_id }) => (key ? out(await api(`/api/v1/requests/${encodeURIComponent(request_id)}`, key, ip)) : needKey));

  s.registerTool('cancel_request', {
    title: 'Cancel a shipping request',
    description: 'Cancels a request that has not been booked. Only call it when the customer asked to cancel. Needs an API key.',
    inputSchema: { request_id: z.string().regex(/^[A-Za-z0-9-]{4,32}$/) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ request_id }) => (key ? out(await api(`/api/v1/requests/${encodeURIComponent(request_id)}/cancel`, key, ip, { method: 'POST' })) : needKey));

  return s;
}

export function startServer(port = PORT) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return void res.end('ok'); }
    const publicOnly = url.pathname === '/mcp/estimate' || url.pathname === '/mcp/estimate/';
    if (url.pathname !== '/mcp' && !publicOnly) { res.writeHead(404); return void res.end('not found'); }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This server is stateless: use POST.' }, id: null }));
    }
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 100_000) { res.writeHead(413); return void res.end(); } chunks.push(c as Buffer); }
    let body: unknown; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400); return void res.end('bad json'); }
    const m = /^Bearer\s+(tl_(?:test|live)_[A-Za-z0-9_-]{20,})$/.exec(String(req.headers.authorization ?? '').trim());
    const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || undefined; // the real caller (Caddy sets X-Forwarded-For), so the API's per-IP limit is per agent, not shared
    const mcp = buildServer(publicOnly ? PUBLIC_KEY : m?.[1], ip, publicOnly);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  return new Promise<http.Server>((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) startServer().then(() => console.log(`Transportli MCP server on :${PORT}/mcp -> ${API}`));
