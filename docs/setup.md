# Setup and verification runbook

This guide covers one-time operator setup, everyday agent access, and verification of your installation.

## Choose the task first

- **Use an existing docket:** obtain approved CLI configuration, then start at [Agent access](#agent-access). No Cloudflare or TRMNL account login is needed.
- **Set up your own installation:** configure the Worker and KV, create a TRMNL private plugin, then connect agents.
- **Manage a TRMNL account or playlist:** use the TRMNL UI or an appropriately authorized account tool. That is separate from sending docket data.

Read [AGENTS.md](../AGENTS.md) before agent-driven operations.

## Credential and permission boundaries

| Credential | Used by | Purpose and boundary |
| --- | --- | --- |
| Cloudflare Wrangler login or deployment API token | Operator tooling | Manage Worker/KV/secrets in the approved Cloudflare account. Not a Docket API token. |
| `DOCKET_TOKEN` | Worker secret and agent CLI | Shared bearer access to every Docket API operation. No per-agent, read-only, or item-specific scopes. |
| `TRMNL_WEBHOOK_URL` | Worker secret | Send dashboard variables to one private plugin. Treat the entire URL as a secret. |
| TRMNL plugin-specific MCP credential | Compatible plugin tools | Plugin-scoped operations such as markup editing. Do not assume it grants account-wide access or playlist management. |
| TRMNL CLI OAuth grant/cache | Official TRMNL CLI | Account API access within the granted scopes. Not interchangeable with the plugin MCP key or webhook URL. |

Normal Docket updates use only the Docket bearer token. The application does not implement OAuth or an MCP server, and does not call the official TRMNL CLI.

Request the least permission needed. An initial read-only TRMNL check uses **read content** access; that does not authorize playlist changes or other writes. Inspect the current CLI and consent screen for exact supported scopes before authorizing additional operations. Do not invent scope strings, request broad grants merely to diagnose a read, or claim that a plugin-scoped credential can manage a playlist.

Keep credentials out of chat, screenshots, logs, command arguments, source control, and item content. Use interactive secret entry or an approved secret manager. Do not copy an OAuth callback URL or token cache into an issue. Review grants before consenting and follow your agent host's approval requirements.

## Worker and storage

1. Install Node 22+ for Wrangler development. The runtime CLI and unit tests need only Node 18+.
2. From the checkout, run `npm test`. Unit tests use in-memory KV and mocked webhooks; they do not provision cloud resources or prove live delivery.
3. Install Wrangler 4 if needed: `npm install --save-dev wrangler@4`. Review dependency/lockfile changes before committing.
4. Authenticate with Cloudflare using `npx wrangler login` and check the selected account with `npx wrangler whoami`. This is **Cloudflare** login, not TRMNL OAuth.
5. For a new installation, create a KV namespace with `npx wrangler kv namespace create DOCKET_KV`. Set the returned namespace ID and your account ID in `wrangler.toml`. Choose a distinct Worker name if needed. Existing project operators should confirm the current binding rather than creating duplicate storage.
6. Use a strong, randomly generated Docket bearer secret. Set it interactively with `npx wrangler secret put DOCKET_TOKEN`; provision the same value to authorized CLI users through an approved secret path.
7. Configure the webhook secret after creating the TRMNL plugin below: `npx wrangler secret put TRMNL_WEBHOOK_URL`.
8. Deploy only when authorized: `npm run deploy`. Record the actual HTTPS origin reported by deployment.

Replace the account and KV namespace placeholders in `wrangler.toml` with your own values before deployment. Review Wrangler's target and prompts before any remote change; secret operations may affect an existing live Worker.

For offline development, copy `.dev.vars.example` to `.dev.vars`, set a development-only Docket token, leave the webhook blank, and run `npm run dev`. Do not use `--remote`. Use `http://localhost:8787` only for local tests.

## TRMNL private plugin and display

1. Confirm the account already has the required Private Plugin/Developer access. This guide does not authorize a paid upgrade.
2. Create a private plugin named **Agent Docket** with the **Webhook** strategy.
3. Paste [templates/full.liquid](../templates/full.liquid) into its full-screen markup editor. Set the plugin option `no_screen_padding=yes`; the template supplies its own padding. The layout targets 800×480 with up to four rows per group. Use plain text without emoji in display content for reliable monochrome e-ink rendering.
4. Copy the plugin's webhook URL into the Worker secret through the approved secret-entry flow. Accepted shape: `https://trmnl.com/api/custom_plugins/YOUR_UUID`; legacy `usetrmnl.com` is also accepted. Paths with queries, fragments, credentials, or redirects are not supported.
5. Finish Worker deployment, then complete [Agent access](#agent-access) to configure `DOCKET_URL` and `DOCKET_TOKEN`. Verify `node bin/docket.js list --json` succeeds. After authorization to send the current docket to this plugin, run `node bin/docket.js publish --json`. This sends existing data without creating a test item.
6. Check the plugin editor's variables and full-screen preview. Confirm titles, grouping, overflow, and timestamp.
7. Check the intended device playlist first to avoid duplicate entries. If missing, add the plugin through the UI, or through account tooling with explicitly authorized write scope and operation. A plugin MCP key alone is not a playlist-management credential.
8. Wait for the device's refresh schedule and verify the physical display separately.

Webhook failure responses can include a safe `reason`: `redirect_blocked`, `timeout`, or `network_error`. Redirects are reported but never followed; do not disable the restriction or send the webhook secret to a redirect destination. Fix configuration or connectivity before republishing.

Each successful mutation attempts a webhook push. Keep updates sparse; the documented standard allowance is 12 webhook submissions/hour. Verify current account limits with TRMNL. A successful webhook means acceptance by the service, not that the screen has refreshed. The payload is capped by this implementation at 4500 UTF-8 bytes. Detailed item URLs remain in the API rather than the display payload.

## Agent access

The dependency-free Docket CLI is already in this checkout:

```sh
node bin/docket.js --help
```

Supply `DOCKET_URL` (the Worker origin only, without an API path) and `DOCKET_TOKEN` through an approved environment/secret manager, or use the git-ignored `.local/cli.json` file at the repository root:

```json
{
  "DOCKET_URL": "https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev",
  "DOCKET_TOKEN": "REPLACE_VIA_APPROVED_SECRET_ENTRY"
}
```

This is a shape example, not a usable credential. Do not paste the real token into a shell command or a committed file. Restrict local file permissions to the intended user; environment values and plaintext JSON are not encrypted storage. Optional `DOCKET_TIMEOUT_MS` must be a string containing an integer from 1000 to 120000.

Configuration resolution:
- Both URL and token in the environment skip the default file.
- Otherwise, environment variables override the loaded file.
- `DOCKET_CONFIG` selects an alternate JSON file, which is always read.
- The default path is relative to the CLI checkout, not the current working directory.
- `npm link` optionally exposes `docket` on PATH but neither creates nor stores credentials.

After supplying configuration, run `node bin/docket.js list --json` before any write or publish. A successful public health request to `/` proves neither authentication nor webhook delivery. HTTP 503 can mean the server token is missing; HTTP 401 means authentication failed. Do not print tokens while troubleshooting.

For mutations, follow the exit-code and retry rules in [AGENTS.md](../AGENTS.md). There are no per-agent permissions: all holders of the shared token can read, edit, and delete the entire docket. To revoke a holder, rotate the Worker token and update remaining approved clients. Rotation is an operator action, not an automatic troubleshooting step.

## Completion checklist

Record these independently, with secrets redacted:

- [ ] Unit tests pass for the checked-out commit.
- [ ] Correct Worker/account/KV binding confirmed.
- [ ] Authenticated Docket list succeeds.
- [ ] An authorized mutation is saved and read back, allowing for KV propagation.
- [ ] Webhook reports `sent`.
- [ ] Plugin option `no_screen_padding=yes` is set.
- [ ] TRMNL editor variables and preview are correct.
- [ ] Intended device playlist contains the plugin.
- [ ] Physical screen refresh is observed.
- [ ] Optional TRMNL OAuth read succeeds, if account tooling was needed.

Do not mark untested stages complete. A callback, API response, or successful local test does not prove end-to-end display operation.
