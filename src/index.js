const KEY = 'docket:v1';
const GROUPS = ['needs_you', 'waiting_on_others'];
const LIMITS = { title: 100, detail: 240, source: 40, url: 500, due: 10 };
const encoder = new TextEncoder();
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function authorized(request, token) {
  if (!token) return false;
  // Compare fixed-length digests without exposing token contents in responses/logs.
  const digest = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  const [a, b] = await Promise.all([digest(request.headers.get('Authorization') || ''), digest(`Bearer ${token}`)]);
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

async function body(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))
    throw new HttpError(415, 'Use application/json');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Expected JSON object');
  let size = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); throw new HttpError(413, 'Body exceeds 8192 bytes'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, 'Expected JSON object'); }
}

function validate(input, partial = false) {
  const allowed = [...Object.keys(LIMITS), 'group', 'kind'];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new HttpError(400, `Unknown field: ${key}`);
  }
  if (!partial && (!input.title || !input.group)) throw new HttpError(400, 'title and group are required');
  if (partial && !Object.keys(input).length) throw new HttpError(400, 'No changes supplied');
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string') throw new HttpError(400, `${key} must be a string`);
    out[key] = value.trim();
    if (LIMITS[key] && [...out[key]].length > LIMITS[key]) throw new HttpError(400, `${key} is too long`);
  }
  if ('title' in out && !out.title) throw new HttpError(400, 'title cannot be empty');
  if ('group' in out && !GROUPS.includes(out.group)) throw new HttpError(400, 'Invalid group');
  if ('kind' in out && !['topic', 'reminder', 'todo'].includes(out.kind)) throw new HttpError(400, 'Invalid kind');
  if (out.url) {
    try { if (!['https:', 'http:'].includes(new URL(out.url).protocol)) throw new Error(); }
    catch { throw new HttpError(400, 'url must be HTTP(S)'); }
  }
  if (out.due && (!/^\d{4}-\d{2}-\d{2}$/.test(out.due) ||
      !Number.isFinite(Date.parse(out.due)) || new Date(out.due).toISOString().slice(0, 10) !== out.due))
    throw new HttpError(400, 'due must be a valid YYYY-MM-DD date');
  return out;
}

const clip = (text, n) => [...text].length > n ? [...text].slice(0, n - 1).join('') + '…' : text;
export function payload(docket) {
  const vars = { updated: docket.updatedAt || 'No updates yet' };
  for (const group of GROUPS) {
    const items = docket.items.filter(item => item.group === group).sort((a, b) =>
      (a.due || '9999').localeCompare(b.due || '9999') || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    vars[group] = items.slice(0, 4).map(item => ({
      title: clip(item.title, 48), detail: clip(item.detail || '', 70),
      meta: clip([item.kind, item.source, item.due ? `Due ${item.due}` : ''].filter(Boolean).join(' · '), 48)
    }));
    vars[`${group}_count`] = items.length;
    vars[`${group}_more`] = Math.max(0, items.length - 4);
  }
  // Keep even worst-case Unicode content within a conservative 4.5 KB envelope.
  while (encoder.encode(JSON.stringify({ merge_variables: vars })).length > 4500) {
    const rows = GROUPS.flatMap(group => vars[group]);
    const longest = rows.sort((a, b) => [...b.detail].length - [...a.detail].length)[0];
    const detailLength = [...(longest?.detail || '')].length;
    if (detailLength > 4) longest.detail = clip(longest.detail, Math.floor(detailLength / 2));
    else {
      const group = vars.needs_you.length > vars.waiting_on_others.length ? 'needs_you' : 'waiting_on_others';
      vars[group].pop(); vars[`${group}_more`]++;
    }
  }
  return { merge_variables: vars };
}

export async function publish(docket, env, fetcher = fetch) {
  if (!env.TRMNL_WEBHOOK_URL) return { status: 'not_configured' };
  let url;
  try { url = new URL(env.TRMNL_WEBHOOK_URL); }
  catch { return { status: 'invalid_configuration' }; }
  try {
    if (url.protocol !== 'https:' || !['trmnl.com', 'usetrmnl.com'].includes(url.hostname) ||
        !/^\/api\/custom_plugins\/[^/]+$/.test(url.pathname) || url.username || url.password || url.search || url.hash)
      return { status: 'invalid_configuration' };
    const response = await fetcher(url.href, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload(docket)), signal: AbortSignal.timeout(8000)
    });
    // Never echo the upstream body or webhook URL: both may contain private values.
    // Body cleanup must not turn an accepted delivery into a reported failure.
    try { await response.body?.cancel(); } catch {}
    if (response.status >= 300 && response.status < 400)
      return { status: 'failed', httpStatus: response.status, reason: 'redirect_blocked' };
    return { status: response.ok ? 'sent' : 'failed', httpStatus: response.status };
  } catch (error) {
    // Never return exception messages: runtimes may include the credential URL.
    const reason = ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network_error';
    return { status: 'failed', reason, error: reason === 'timeout' ? 'Webhook timed out' : 'Webhook network request failed' };
  }
}

export default {
  async fetch(request, env) {
    try {
      const path = new URL(request.url).pathname;
      const method = request.method;
      if (path === '/' && method === 'GET') return json({ service: 'Agent Docket', status: 'ok' });
      if (!env.DOCKET_TOKEN) return json({ error: 'API is not configured' }, 503);
      if (!await authorized(request, env.DOCKET_TOKEN)) return json({ error: 'Unauthorized' }, 401);
      const match = path.match(/^\/api\/items\/([a-zA-Z0-9_-]{1,80})$/);
      const allowed = path === '/api/items' ? ['GET', 'POST'] : match ? ['GET', 'PATCH', 'DELETE'] :
        path === '/api/payload' ? ['GET'] : path === '/api/publish' ? ['POST'] : [];
      if (!allowed.length) return json({ error: 'Not found' }, 404);
      if (!allowed.includes(method)) return json({ error: `Use ${allowed.join(' or ')}` }, 405);
      const docket = await env.DOCKET_KV.get(KEY, 'json') || { items: [], updatedAt: null };
      if (path === '/api/payload') return json(payload(docket));
      if (path === '/api/publish') {
        const delivery = await publish(docket, env);
        return json({ delivery }, delivery.status === 'sent' ? 200 : 502);
      }
      const index = match ? docket.items.findIndex(item => item.id === match[1]) : -1;
      if (match && index < 0) return json({ error: 'Item not found' }, 404);
      if (method === 'GET') return json(match ? docket.items[index] : docket);
      let item;
      if (method === 'POST') {
        if (docket.items.length >= 100) throw new HttpError(409, 'Docket is full (100 items)');
        const fields = validate(await body(request));
        item = { kind: 'todo', detail: '', source: '', url: '', due: '', ...fields,
          id: crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        docket.items.push(item);
      } else if (method === 'PATCH') {
        item = { ...docket.items[index], ...validate(await body(request), true), updatedAt: new Date().toISOString() };
        docket.items[index] = item;
      } else { item = docket.items.splice(index, 1)[0]; }
      docket.updatedAt = new Date().toISOString();
      await env.DOCKET_KV.put(KEY, JSON.stringify(docket));
      const delivery = await publish(docket, env);
      return json({ saved: true, ...(method === 'DELETE' ? { deleted: item.id } : { item }), delivery }, method === 'POST' ? 201 : 200);
    } catch (error) {
      return json({ error: error instanceof HttpError ? error.message : 'Storage or service unavailable' },
        error instanceof HttpError ? error.status : 503);
    }
  }
};
