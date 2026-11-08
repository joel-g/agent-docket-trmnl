import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { run, loadConfig } from '../src/cli.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../src/index.js';
globalThis.crypto ??= webcrypto;

const env = { DOCKET_URL: 'https://docket.example', DOCKET_TOKEN: 'test-only-secret' };
test('local JSON config loads, environment wins, malformed content never leaks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'docket-config-test-'));
  const file = join(dir, 'cli.json');
  try {
    await writeFile(file, JSON.stringify({ DOCKET_URL: 'https://file.example', DOCKET_TOKEN: 'test-file-secret' }));
    assert.equal((await loadConfig({}, file)).DOCKET_TOKEN, 'test-file-secret');
    assert.equal((await loadConfig(env, file)).DOCKET_TOKEN, env.DOCKET_TOKEN);
    const result = await invoke(['list'], { env: {}, configPath: file, fetcher: async (url, options) => {
      assert.equal(url, 'https://file.example/api/items');
      assert.equal(options.headers.Authorization, 'Bearer test-file-secret');
      return new Response('{"items":[]}');
    } });
    assert.equal(result.code, 0);
    await writeFile(file, '{bad-json-test-file-secret');
    const bad = await invoke(['list'], { env: {}, configPath: file });
    assert.equal(bad.code, 2); assert.doesNotMatch(bad.err, /test-file-secret/);
    assert.equal((await invoke(['--help'], { env: {}, configPath: file })).code, 0);
    await assert.rejects(loadConfig({ DOCKET_CONFIG: join(dir, 'missing.json') }), /Cannot read/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
function invoke(args, options = {}) {
  const out = [], err = [];
  const pending = run(args, { env, stdout: x => out.push(x), stderr: x => err.push(x), ...options });
  return pending.then(code => ({ code, out: out.join('\n'), err: err.join('\n') }));
}
test('executable help works without configuration', () => {
  const result = spawnSync(process.execPath, ['bin/docket.js', '--help'], { encoding: 'utf8', env: {} });
  assert.equal(result.status, 0); assert.match(result.stdout, /move ID/); assert.match(result.stdout, /DOCKET_TOKEN/);
});
test('usage and insecure configuration fail before network', async () => {
  const fetcher = () => { assert.fail('No network expected'); };
  for (const args of [['add'], ['get'], ['move', 'id', 'bad'], ['update', 'id'], ['delete', '../all'],
    ['list', '--title', 'x'], ['list', '--token', 'secret'], ['publish', 'extra']])
    assert.equal((await invoke(args, { fetcher })).code, 2);
  for (const value of ['', 'http://remote.example', 'https://example.test/path', 'https://user:pass@example.test', 'https://example.test/?token=secret'])
    assert.equal((await invoke(['list'], { fetcher, env: { ...env, DOCKET_URL: value } })).code, 2);
});
test('CLI talks to real Worker handler across full item lifecycle', async () => {
  let stored = null;
  const workerEnv = { DOCKET_TOKEN: env.DOCKET_TOKEN, DOCKET_KV: {
    get: async () => stored && JSON.parse(stored), put: async (_, value) => { stored = value; }
  } };
  const fetcher = (url, options) => worker.fetch(new Request(url, options), workerEnv);
  const call = args => invoke(args, { fetcher });
  const created = await call(['add', '--title', 'Review proposal', '--group', 'needs-you', '--json']);
  assert.equal(created.code, 3); assert.match(created.err, /do not repeat add/);
  const id = JSON.parse(created.out).item.id;
  assert.equal(JSON.parse((await call(['list', '--json'])).out).items.length, 1);
  await call(['update', id, '--detail', 'Ready', '--source', 'Agent']);
  await call(['move', id, 'waiting-on-others']);
  await call(['update', id, '--detail', '']);
  const item = JSON.parse((await call(['get', id, '--json'])).out);
  assert.equal(item.group, 'waiting_on_others'); assert.equal(item.detail, ''); assert.equal(item.source, 'Agent');
  assert.equal((await call(['publish'])).code, 1);
  assert.equal((await call(['remove', id])).code, 3);
  assert.equal((await call(['list'])).out, 'No items.');
  assert.equal((await call(['get', id])).code, 1);
});
test('no redirect or automatic retry, credentials redacted, mutation uncertainty explicit', async () => {
  let calls = 0;
  const fetcher = async (_, options) => {
    calls++; assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    assert.equal(options.headers.Authorization, `Bearer ${env.DOCKET_TOKEN}`);
    throw new Error(env.DOCKET_TOKEN);
  };
  const result = await invoke(['delete', 'id'], { fetcher });
  assert.equal(result.code, 4); assert.equal(calls, 1); assert.doesNotMatch(result.err, /test-only-secret/);
  assert.equal((await invoke(['list'], { fetcher })).code, 1);
  const rejected = await invoke(['list', '--json'], { fetcher: async () =>
    new Response(JSON.stringify({ error: env.DOCKET_TOKEN }), { status: 401 }) });
  assert.equal(rejected.code, 1); assert.doesNotMatch(rejected.out + rejected.err, /test-only-secret/);
});
test('success output and loopback configuration work; API rejection has nonzero status', async () => {
  const result = await invoke(['publish', '--json'], { env: { ...env, DOCKET_URL: 'http://127.0.0.1:8787' },
    fetcher: async () => new Response(JSON.stringify({ delivery: { status: 'sent' } })) });
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.out).delivery.status, 'sent');
  const invalid = await invoke(['add', '--title', 'X', '--group', 'needs_you'], {
    fetcher: async () => new Response('{"error":"Docket full"}', { status: 409 }) });
  assert.equal(invalid.code, 1); assert.match(invalid.err, /409/);
});
