import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import worker, { payload, publish } from '../src/index.js';
globalThis.crypto ??= webcrypto;

function harness() {
  const data = new Map();
  const env = { DOCKET_TOKEN: 'test-only', DOCKET_KV: {
    async get(key) { return data.has(key) ? JSON.parse(data.get(key)) : null; },
    async put(key, value) { data.set(key, value); }
  } };
  const call = (path, method = 'GET', value, token = 'test-only') => worker.fetch(new Request(`https://example.test${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {})
  }), env);
  return { env, call, data };
}

test('auth fails closed; public health exposes no docket', async () => {
  const { call, env } = harness();
  assert.equal((await call('/')).status, 200);
  for (const path of ['/api/items', '/api/payload', '/api/publish'])
    assert.equal((await call(path, 'GET', undefined, 'wrong')).status, 401);
  delete env.DOCKET_TOKEN;
  assert.equal((await call('/api/items')).status, 503);
});

test('create/read/update/delete persist and publish configuration is explicit', async () => {
  const { call } = harness();
  const created = await call('/api/items', 'POST', { title: 'Review', group: 'needs_you' });
  assert.equal(created.status, 201);
  const { item, saved, delivery } = await created.json();
  assert.equal(saved, true); assert.equal(delivery.status, 'not_configured');
  const path = `/api/items/${item.id}`;
  assert.equal((await (await call(path)).json()).title, 'Review');
  assert.equal((await call(path, 'PATCH', { group: 'waiting_on_others', due: '2027-01-01' })).status, 200);
  const vars = (await (await call('/api/payload')).json()).merge_variables;
  assert.equal(vars.needs_you_count, 0); assert.equal(vars.waiting_on_others_count, 1);
  assert.equal((await call(path, 'DELETE')).status, 200);
  assert.equal((await call(path)).status, 404);
  assert.deepEqual((await (await call('/api/items')).json()).items, []);
});

test('reject malformed, oversized, invalid and unknown fields without writing', async () => {
  const { call, data, env } = harness();
  for (const value of [null, [], {}, { title: ' ', group: 'needs_you' }, { title: 'X', group: 'bad' },
    { title: 'X', group: 'needs_you', due: '2026-02-30' }, { title: 'X', group: 'needs_you', url: 'javascript:alert(1)' },
    { title: 'X', group: 'needs_you', id: 'overwrite' }, { title: 'X'.repeat(101), group: 'needs_you' }])
    assert.equal((await call('/api/items', 'POST', value)).status, 400);
  assert.equal((await call('/api/items', 'POST', { title: 'x'.repeat(9000) })).status, 413);
  const malformed = new Request('https://example.test/api/items', { method: 'POST', headers: {
    Authorization: 'Bearer test-only', 'Content-Type': 'application/json' }, body: '{' });
  assert.equal((await worker.fetch(malformed, env)).status, 400);
  assert.equal(data.size, 0);
  assert.equal((await call('/api/items', 'DELETE')).status, 405);
  assert.equal((await call('/unknown')).status, 404);
});

test('webhook uses merge_variables and failure never exposes secret URL/body', async () => {
  const docket = { items: [], updatedAt: null };
  const env = { TRMNL_WEBHOOK_URL: 'https://trmnl.com/api/custom_plugins/test-secret' };
  const result = await publish(docket, env, async (url, init) => {
    assert.equal(url, env.TRMNL_WEBHOOK_URL); assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), payload(docket));
    assert.equal(init.redirect, 'manual'); assert.ok(init.signal);
    return new Response('private upstream body', { status: 429 });
  });
  assert.deepEqual(result, { status: 'failed', httpStatus: 429 });
  assert.equal((await publish(docket, env, async () => { throw new Error(env.TRMNL_WEBHOOK_URL); })).status, 'failed');
  assert.equal((await publish(docket, { TRMNL_WEBHOOK_URL: 'http://localhost/private' })).status, 'invalid_configuration');
  assert.equal((await publish(docket, env, async () => new Response('{}'))).status, 'sent');
});

test('webhook diagnostics distinguish blocked redirects and timeouts without leaking credentials', async () => {
  const docket = { items: [], updatedAt: null };
  const env = { TRMNL_WEBHOOK_URL: 'https://trmnl.com/api/custom_plugins/test-secret' };
  let calls = 0;
  const redirect = await publish(docket, env, async () => {
    calls++;
    return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/test-secret' } });
  });
  assert.equal(calls, 1);
  assert.deepEqual(redirect, { status: 'failed', httpStatus: 302, reason: 'redirect_blocked' });
  for (const name of ['TimeoutError', 'AbortError', 'TypeError']) {
    const result = await publish(docket, env, async () => {
      const error = new Error(env.TRMNL_WEBHOOK_URL); error.name = name; throw error;
    });
    assert.equal(result.reason, name === 'TypeError' ? 'network_error' : 'timeout');
    assert.doesNotMatch(JSON.stringify(result), /test-secret|https:/);
  }
  const accepted = await publish(docket, env, async () => ({
    status: 200, ok: true, body: { async cancel() { throw new Error('cleanup'); } }
  }));
  assert.deepEqual(accepted, { status: 'sent', httpStatus: 200 });
});

test('webhook failure preserves mutation; storage failure does not publish', async () => {
  const { call, env } = harness();
  env.TRMNL_WEBHOOK_URL = 'invalid';
  const response = await call('/api/items', 'POST', { title: 'Saved', group: 'needs_you' });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).delivery.status, 'invalid_configuration');
  assert.equal((await (await call('/api/items')).json()).items.length, 1);
  assert.equal((await call('/api/publish', 'POST')).status, 502);
  env.DOCKET_KV.put = async () => { throw new Error('secret storage error'); };
  const failed = await call('/api/items', 'POST', { title: 'No', group: 'needs_you' });
  assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /secret/);
});

test('payload sorts due dates, caps rows, reports overflow and bounds Unicode bytes', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: '😀'.repeat(100),
    detail: '😀'.repeat(240), source: '😀'.repeat(40), kind: 'reminder', group: i % 2 ? 'needs_you' : 'waiting_on_others',
    due: `2027-01-${String(20 - i).padStart(2, '0')}`, updatedAt: '2026-11-04T00:00:00Z' }));
  const p = payload({ items, updatedAt: '2026-11-04T00:00:00Z' });
  assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 4500);
  for (const group of ['needs_you', 'waiting_on_others']) {
    assert.ok(p.merge_variables[group].length <= 4);
    assert.equal(p.merge_variables[group].length + p.merge_variables[`${group}_more`], 10);
  }
  const small = payload({ items: items.map(x => ({ ...x, title: x.due, source: '', detail: '' })) });
  assert.equal(small.merge_variables.needs_you[0].title, '2027-01-01');
});


test('payload terminates at the exact 70-code-point astral detail boundary', () => {
  // Run in a child so a synchronous infinite-loop regression fails within a bound.
  const script = `
    import { payload } from './src/index.js';
    const items = Array.from({ length: 8 }, (_, i) => ({
      id: String(i), title: '😀'.repeat(48), detail: '😀'.repeat(70),
      source: '😀'.repeat(40), kind: 'reminder',
      group: i < 4 ? 'needs_you' : 'waiting_on_others',
      updatedAt: '2026-11-04T00:00:00Z'
    }));
    console.log(JSON.stringify(payload({ items, updatedAt: '2026-11-04T00:00:00Z' })));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 3000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 4500);
  for (const group of ['needs_you', 'waiting_on_others']) {
    const vars = output.merge_variables;
    assert.equal(vars[group].length + vars[`${group}_more`], 4);
    for (const row of vars[group]) {
      assert.ok([...row.detail].length < 70);
      assert.doesNotMatch(row.detail, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    }
  }
});
