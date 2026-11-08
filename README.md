# Agent Docket

Your open threads with AI agents, at a glance.

A small, agent-agnostic Cloudflare Worker API backed by KV. Any HTTP-capable agent can add topics, reminders, and todos, move them between **Needs you** and **Waiting on others**, or remove them. Changes push a compact dashboard to a TRMNL private plugin. No model or agent SDK is required at runtime.

## Setup and agent guidance

- [Setup runbook](docs/setup.md): Worker, CLI, TRMNL, credential scopes, and verification checkpoints.
- [Agent instructions](AGENTS.md): item lifecycle, safe retries, shared-access limits, and permission boundaries.

## Try the API

### Agent CLI

The dependency-free Node CLI is the preferred interface for agents. Run `node bin/docket.js --help` from this checkout, or `npm run docket -- --help`. Optionally run `npm link` once to expose `docket` on your PATH; this only installs the command and does not store credentials.

The CLI automatically reads `.local/cli.json` in this checkout, including when invoked from another directory or through `npm link`. This directory is git-ignored. The JSON keys are `DOCKET_URL`, `DOCKET_TOKEN`, and optional `DOCKET_TIMEOUT_MS`, all strings. Restrict the file to your user account; never commit or print its contents.

Alternatively supply `DOCKET_URL` (the deployed Worker HTTPS origin) and `DOCKET_TOKEN` through your agent's environment or secret manager. If both are supplied, the default local file is skipped. Otherwise environment variables override values loaded from the local file. `DOCKET_CONFIG` selects another JSON configuration path, which is always read. The CLI never asks for secrets as arguments or writes configuration. `DOCKET_TIMEOUT_MS` optionally changes its 15-second timeout. For local development only, HTTP localhost/loopback origins are allowed. Keep secrets out of shell history and source control. Run `node bin/docket.js list` to use the saved configuration without exporting any variables.

```sh
node bin/docket.js add --title "Review proposal" --group needs-you --source "Planning agent"
node bin/docket.js list --json
node bin/docket.js get ITEM_ID
node bin/docket.js update ITEM_ID --detail "Ready for review" --due 2027-01-01
node bin/docket.js move ITEM_ID waiting-on-others
node bin/docket.js update ITEM_ID --due ""
node bin/docket.js delete ITEM_ID
node bin/docket.js publish
```

`--json` emits the API response on stdout for automation; diagnostics go to stderr. Groups accept underscore or hyphen spelling. `remove` aliases `delete`. Optional fields can be cleared with empty strings. Use the returned ID for subsequent updates rather than adding duplicates.

Exit status: **0** success, **1** API/read failure, **2** usage/configuration error, **3** item saved but display not updated, **4** mutation outcome uncertain after a network/response failure. On status 3, retry `publish` only. On status 4, inspect `list`/`get` before retrying a mutation. The CLI never automatically retries or follows redirects with credentials. All agents using the token share the same docket access.

### Development and direct HTTP

Tests have no dependencies and run on Node 18+:

```sh
npm test
```

For the Cloudflare local emulator, use Node 22+ and Wrangler 4:

```sh
npm install --save-dev wrangler@4
cp .dev.vars.example .dev.vars
# Set DOCKET_TOKEN in .dev.vars; leave TRMNL_WEBHOOK_URL blank for offline development.
npm run dev
```

Local Wrangler uses local KV storage; replace the namespace placeholder in `wrangler.toml` with your own namespace ID before deployment. Do not use `--remote` for local tests. No Wrangler dependency is required to run unit tests.

Examples below use a POSIX shell, with `DOCKET_TOKEN` and `DOCKET_URL` supplied in your environment. Use `http://localhost:8787` locally; use HTTPS for a deployed Worker.

```sh
curl "$DOCKET_URL/api/items" -H "Authorization: Bearer $DOCKET_TOKEN"
curl "$DOCKET_URL/api/items" -X POST \
  -H "Authorization: Bearer $DOCKET_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @examples/create.json
# Copy item.id from that response:
curl "$DOCKET_URL/api/items/ITEM_ID" -X PATCH \
  -H "Authorization: Bearer $DOCKET_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @examples/waiting.json
curl "$DOCKET_URL/api/items/ITEM_ID" -X DELETE -H "Authorization: Bearer $DOCKET_TOKEN"
curl "$DOCKET_URL/api/publish" -X POST -H "Authorization: Bearer $DOCKET_TOKEN"
```

## API contract

All `/api/*` endpoints require `Authorization: Bearer <DOCKET_TOKEN>`. A missing server token disables the API. Only `GET /` is public and returns service health, without docket data. Responses are not cached.

| Method | Endpoint | Result |
| --- | --- | --- |
| GET | `/api/items` | Full docket including IDs and reference URLs |
| POST | `/api/items` | Create item; returns 201, item, saved and delivery status |
| GET | `/api/items/:id` | One item |
| PATCH | `/api/items/:id` | Change supplied fields; preserve ID and creation date |
| DELETE | `/api/items/:id` | Remove item; return deleted ID and delivery status |
| GET | `/api/payload` | Exact TRMNL webhook JSON for inspection |
| POST | `/api/publish` | Retry delivery of current state; 200 sent or 502 otherwise |

Create requires `title` and `group`. Groups: `needs_you`, `waiting_on_others`. Optional `kind`: `topic`, `reminder`, or `todo` (default). Optional strings: `detail`, `source`, `url` (HTTP/S), and `due` (valid YYYY-MM-DD). Empty strings clear optional fields. Limits: title 100, detail 240, source 40, URL 500 characters; request body 8192 bytes; 100 stored items. IDs and timestamps are server-owned; unknown fields are rejected.

Due dates order each group, followed by most recent change. Reminders are displayed items, not alarms or scheduled notifications. Delete completed items. Source is a display label, not an authenticated identity; all agents sharing the bearer token have the same access.

Writes persist before webhook delivery. A successful mutation always returns `saved: true`; `delivery.status` is `sent`, `failed`, `not_configured`, or `invalid_configuration`. A delivery failure does **not** mean the item failed to save. Retry `/api/publish`, not the original POST, to avoid duplicate items. Upstream status (including 429) is returned without upstream body or secret URL. Network timeout is eight seconds. No automatic retry loop or background infrastructure.

## Cloudflare setup

Each installation needs its own Cloudflare Worker and KV namespace. Configure your own account and namespace IDs in `wrangler.toml`; the repository does not provide a shared deployment. Without `DOCKET_TOKEN`, the deployed API returns 503 and cannot read or change docket data.

1. Sign in with Wrangler when ready: `npx wrangler login`.
2. Create storage: `npx wrangler kv namespace create DOCKET_KV`.
3. Set your account and returned namespace IDs in `wrangler.toml`. Choose a Worker name for your installation.
4. Set secrets interactively: `npx wrangler secret put DOCKET_TOKEN` and, after creating the plugin below, `npx wrangler secret put TRMNL_WEBHOOK_URL`.
5. Deploy when ready: `npm run deploy`. Use the HTTPS origin reported by deployment as `DOCKET_URL`.
6. Configure the CLI with that origin and the matching Docket token as described under [Agent CLI](#agent-cli), then verify `node bin/docket.js list --json` before publishing or adding items.

Never commit `.dev.vars`, API tokens, or webhook URLs. `.dev.vars.example` contains placeholders only. No credentials or cloud resources are created by the tests.

## TRMNL setup

1. Create a Private Plugin named **Agent Docket**, using the **Webhook** strategy. Hosted private plugins require the appropriate existing Developer access.
2. Paste `templates/full.liquid` into the full-screen markup editor and set the plugin option `no_screen_padding=yes` so the template controls its own spacing. It targets an 800×480, 7.5-inch display: four rows per group, overflow counts, empty states, and a last-change timestamp in UTC. Text is escaped, single-line clipped, and uses monochrome borders.
3. Copy the plugin Webhook URL into the Worker secret `TRMNL_WEBHOOK_URL`. Expected format: `https://trmnl.com/api/custom_plugins/YOUR_UUID` (legacy `usetrmnl.com` is also accepted).
4. After deployment and CLI configuration, verify `node bin/docket.js list --json`, then run `node bin/docket.js publish --json`. Check Your Variables in the editor, preview the full-screen layout, then add the plugin to your playlist.

Use plain text without emoji in titles, details, and source labels: emoji do not render reliably on a monochrome e-ink display. The payload stays under 4500 UTF-8 bytes, including worst-case Unicode. Full details and URLs stay available via the API. TRMNL currently permits 12 webhook submissions/hour on the standard tier and up to 5 KB of stored data. This POC attempts a push after each change; make sparse updates and use `/api/publish` after a rate limit clears. The screen follows the device/plugin refresh schedule; a successful webhook is not confirmation that the physical screen has refreshed.

## Deliberate POC limits

One small JSON document in KV keeps setup simple. Updates are intended to be sparse and sequential. KV allows one write per key per second, is eventually consistent across locations, and overlapping read/modify/write requests can overwrite changes. Space mutations by at least a second; cross-location reads can lag. There is no concurrency coordination, user system, queue, cron, scheduled reminder engine, or extra service in this POC.

Tests exercise the Worker request handler with an in-memory KV double and mocked webhook fetch. They cover authentication, CRUD/persistence, validation, malformed and oversized bodies, method routing, webhook errors, storage failure, due-date ordering, overflow, and Unicode byte limits. They do not validate a live Cloudflare account or physical display. Complete the markup-editor preview and a device check during setup.

## References

- [TRMNL webhook API](https://docs.trmnl.com/go/private-plugins/webhooks) — payload shape, limits, and refresh behavior.
- [Cloudflare KV writes](https://developers.cloudflare.com/kv/api/write-key-value-pairs/) — persistence and consistency limits.

## License

[MIT](LICENSE). Copyright (c) 2026 Joel Guerra.
