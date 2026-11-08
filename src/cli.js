import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';

export const HELP = `Agent Docket — shared CLI for agentic workflows

Usage: docket COMMAND [ID] [options]
  add --title TEXT --group needs_you|waiting_on_others
  list                         List all items, with IDs
  get ID                       Read one item
  update ID --FIELD VALUE       Change only supplied fields
  move ID needs_you|waiting_on_others
  delete ID                    Remove an item
  publish                      Send current dashboard to TRMNL

Fields: --title, --group, --kind topic|reminder|todo,
        --detail, --source, --url, --due YYYY-MM-DD
Pass an empty string to clear an optional field.
Options: --json (machine-readable output), --help / -h
Aliases: remove = delete; needs-you / waiting-on-others for groups.

Environment (never passed as CLI flags):
  DOCKET_URL          Worker HTTPS origin (HTTP loopback allowed locally)
  DOCKET_TOKEN        Bearer token shared with the Worker
  DOCKET_TIMEOUT_MS   Optional timeout, 1000–120000 (default 15000)
  DOCKET_CONFIG       Optional path to a local JSON configuration file
Default config: .local/cli.json in this checkout. Environment values override it.

Examples:
  docket add --title "Review proposal" --group needs-you --source "Planning agent"
  docket list --json
  docket update ITEM_ID --detail "Ready for review" --due 2027-01-01
  docket move ITEM_ID waiting-on-others
  docket delete ITEM_ID
  docket publish

Exit codes: 0 success; 1 API/read error; 2 usage/configuration error;
  3 saved but display not updated (retry publish, not add);
  4 mutation outcome uncertain (inspect list/get before retrying).
No automatic retries. KV updates should be sparse and sequential.
Without installation: node bin/docket.js COMMAND ... or npm run docket -- COMMAND ...
`;

class UsageError extends Error {}
export async function loadConfig(env, configPath) {
  // A fully configured agent environment need not read another user's local file.
  if (!configPath && !env.DOCKET_CONFIG && env.DOCKET_URL && env.DOCKET_TOKEN) return env;
  configPath ??= env.DOCKET_CONFIG || new URL('../.local/cli.json', import.meta.url);
  let text;
  try { text = await readFile(configPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' && !env.DOCKET_CONFIG) return env;
    throw new UsageError('Cannot read CLI configuration. Check DOCKET_CONFIG and file permissions.');
  }
  try {
    const data = JSON.parse(text);
    const allowed = ['DOCKET_URL', 'DOCKET_TOKEN', 'DOCKET_TIMEOUT_MS'];
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        Object.entries(data).some(([key, value]) => !allowed.includes(key) || typeof value !== 'string')) throw new Error();
    return { ...data, ...env };
  } catch { throw new UsageError('Invalid CLI configuration: expected JSON with string DOCKET_URL, DOCKET_TOKEN and optional DOCKET_TIMEOUT_MS.'); }
}
const fieldNames = ['title', 'group', 'kind', 'detail', 'source', 'url', 'due'];
const normalizeGroup = value => value?.replaceAll('-', '_');
function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      ...Object.fromEntries(fieldNames.map(name => [name, { type: 'string' }])),
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
    } });
  } catch { throw new UsageError('Invalid options. Run docket --help.'); }
  const { values, positionals } = parsed;
  if (values.help || !argv.length || positionals[0] === 'help') return { help: true };
  let [command, id, group] = positionals;
  if (command === 'remove') command = 'delete';
  if (!['add', 'list', 'get', 'update', 'move', 'delete', 'publish'].includes(command))
    throw new UsageError('Unknown command. Run docket --help.');
  const count = command === 'move' ? 3 : ['get', 'update', 'delete'].includes(command) ? 2 : 1;
  if (positionals.length !== count) throw new UsageError(`Wrong arguments for ${command}. Run docket --help.`);
  if (count > 1 && !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new UsageError('Invalid item ID.');
  const fields = Object.fromEntries(fieldNames.filter(name => values[name] !== undefined).map(name => [name, values[name]]));
  if (command === 'move') {
    if (Object.keys(fields).length) throw new UsageError('move accepts an ID and a group, without field options.');
    fields.group = group;
  }
  if (fields.group !== undefined) {
    fields.group = normalizeGroup(fields.group);
    if (!['needs_you', 'waiting_on_others'].includes(fields.group)) throw new UsageError('Invalid group. Use needs_you or waiting_on_others.');
  }
  if (command === 'add' && (!fields.title?.trim() || !fields.group)) throw new UsageError('add requires --title and --group.');
  if (command === 'update' && !Object.keys(fields).length) throw new UsageError('update requires at least one field.');
  if (!['add', 'update', 'move'].includes(command) && Object.keys(fields).length)
    throw new UsageError(`${command} does not accept field options.`);
  const method = { add: 'POST', list: 'GET', get: 'GET', update: 'PATCH', move: 'PATCH', delete: 'DELETE', publish: 'POST' }[command];
  const path = command === 'publish' ? '/api/publish' : '/api/items' + (count > 1 ? `/${id}` : '');
  return { command, method, path, fields, json: values.json };
}

function config(env) {
  let url;
  try { url = new URL(env.DOCKET_URL); } catch { throw new UsageError('Set DOCKET_URL to the Worker HTTPS origin.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && local) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new UsageError('DOCKET_URL must be an HTTPS origin without credentials, path, query or fragment (HTTP loopback allowed).');
  if (!env.DOCKET_TOKEN?.trim()) throw new UsageError('Set DOCKET_TOKEN in the environment.');
  const timeout = Number(env.DOCKET_TIMEOUT_MS ?? 15000);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000)
    throw new UsageError('DOCKET_TIMEOUT_MS must be an integer from 1000 to 120000.');
  return { origin: url.origin, token: env.DOCKET_TOKEN, timeout };
}

// Strip terminal controls from untrusted item text. Token values never appear in output.
const terminalText = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
function summary(data, command) {
  if (command === 'list') return data.items?.length ? data.items.map(item =>
    `${item.id}\t${item.group}\t${item.title}`).join('\n') : 'No items.';
  if (command === 'get') return JSON.stringify(data, null, 2);
  if (command === 'publish') return `Display: ${data.delivery?.status || 'unknown'}`;
  return data.deleted ? `Deleted ${data.deleted}` : `Saved ${data.item?.id || 'item'}: ${data.item?.title || ''}`;
}

export async function run(argv, { env = process.env, fetcher = fetch,
  stdout = text => console.log(text), stderr = text => console.error(text), configPath } = {}) {
  let args, settings;
  try {
    args = parse(argv);
    if (args.help) { stdout(HELP); return 0; }
    settings = config(await loadConfig(env, configPath));
  } catch (error) { stderr(error instanceof UsageError ? error.message : 'Invalid CLI configuration.'); return 2; }
  const safe = text => String(text).split(settings.token).join('[REDACTED]');
  let response, data;
  try {
    response = await fetcher(settings.origin + args.path, {
      method: args.method, redirect: 'error', signal: AbortSignal.timeout(settings.timeout),
      headers: { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json' },
      ...(['add', 'update', 'move'].includes(args.command) ? { body: JSON.stringify(args.fields) } : {})
    });
    data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid response');
  } catch {
    const mutation = args.method !== 'GET';
    stderr(mutation ? 'Request failed or response was unreadable; outcome uncertain. Inspect list/get before retrying. No automatic retry was made.' :
      'Request failed or response was unreadable. Check connection, DOCKET_URL and timeout.');
    return mutation ? 4 : 1;
  }
  if (!response.ok) {
    if (args.json) stdout(safe(JSON.stringify(data)));
    stderr(safe(`API HTTP ${response.status}: ${terminalText(data.error || data.delivery?.status || 'Request rejected')}`));
    return 1;
  }
  stdout(safe(args.json ? JSON.stringify(data) : summary(data, args.command).split('\n').map(terminalText).join('\n')));
  if (data.saved && data.delivery?.status !== 'sent') {
    stderr(safe(`Saved, but display ${terminalText(data.delivery?.status || 'unknown')}. Retry docket publish; do not repeat add.`));
    return 3;
  }
  return 0;
}
