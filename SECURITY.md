# Security

BUNQSY is an always-on agent that holds a bunq session key, can move money and
keeps a local copy of transaction history. This document is the threat model,
the deployment contract, and the list of things a reviewer should check.

## ⚠️ Action required: rotate the sandbox key

`packages/daemon/kairos.db-shm` and `kairos.db-wal` were committed to this
repository before the hardening pass. SQLite write-ahead-log pages contain rows
from the `sessions` table, which stores **the RSA private key used to sign bunq
requests and the session token**. Both files are untracked as of commit
`f7e2a8c`, but **they remain in git history and must be treated as disclosed**:

1. Revoke the affected bunq API key in the bunq app / developer portal.
2. Issue a new key and put it in `.env` (never in the repo).
3. Delete the local database so a fresh session and key pair are generated:
   `rm -f packages/daemon/kairos.db*` (or your `DB_PATH`).
4. If this repository was ever public, treat the key as compromised regardless
   of sandbox/production status.

History rewriting (`git filter-repo`) is deliberately *not* recommended here:
the branch is already merged and shared, and rotation is the control that
actually removes the risk.

## Trust model

| Principal | Trust | Notes |
|---|---|---|
| The local user | trusted | Holds the token file and the database |
| The browser tab | semi-trusted | May run injected content in merchant names, OCR text, LLM narration |
| Any other page in that browser | **untrusted** | Can reach `localhost` — CSRF and WebSocket hijacking are the primary browser threats |
| bunq's webhook sender | semi-trusted | Verified by source IP + RSA signature |
| Anthropic / ElevenLabs responses | **untrusted** | Model output is parsed, validated and bounded before it can act |
| A spoken transcript | **untrusted** | The one attacker-writable input to the planner |

## Controls

**Authentication.** Every route except `/api/health` and `/api/webhook` requires
the API token (`x-bunqsy-token` or `Authorization: Bearer`), compared in constant
time over SHA-256 digests. The token is generated on first boot into
`.bunqsy-token` (mode 0600, gitignored) and injected by the Vite dev proxy in the
Node process — it is never sent to the browser, so an XSS cannot read it and a
malicious page cannot replay it.

**Network exposure.** The daemon binds `127.0.0.1` unless `HOST` says otherwise,
and warns when it does. Note that `npm run demo` opens a public tunnel to the
*frontend*; with the daemon on loopback, only the proxy can reach the API, and
the origin allow-list still applies.

**CSRF / CSWSH.** Any request carrying an `Origin` header must present an
allow-listed origin — all methods, including WebSocket upgrades. Matching is on
exact scheme+host+port (or an explicit `.suffix` entry); `null` origins are
refused.

**Write gateway.** `packages/daemon/src/bunq/execute.ts` is the only place that
issues bunq writes. Every step is validated twice — once when the plan is
created, once before execution — against per-type zod schemas:

- IBANs must match ISO 13616 shape; account/card ids must be positive integers
- amounts are capped by `MAX_PAYMENT_EUR` (default €500) and a plan may hold ≤ 10 steps
- `cardEndpoint` is an enum, and every path segment goes through `pathSegment()`
  (this is what stops `cardEndpoint=../../monetary-account/1/payment`)
- control characters are stripped from all free text
- **outbound payments are denied by default** (`VOICE_PAYMENTS_ENABLED=false`).
  Internal jar transfers, fraud draft-cancels and sandbox funding are unaffected,
  so the deny only removes the prompt-injection path to third-party money movement.

**Webhooks.** Signature verification runs against the raw request bytes (the
previous implementation hashed `JSON.stringify(req.body)`, which cannot reproduce
what bunq signed). Source IP is `req.ip` with `trustProxy` off by default, so
`X-Forwarded-For` cannot be forged; the CIDR check understands IPv4-mapped IPv6.
Signatures are mandatory in production, opt-in elsewhere via
`WEBHOOK_REQUIRE_SIGNATURE`.

**Rate limiting.** Per-IP token buckets in three cost classes; endpoints that
spend money at Anthropic/ElevenLabs, fork the dream worker or rewrite the
database get 8 burst / 0.15 rps.

**Uploads.** 8 MB cap, single file, and magic-byte sniffing — a file declaring
`image/png` that is actually HTML or SVG never reaches Claude Vision.

**Output handling.** CSV exports neutralise formula injection (`=`, `+`, `-`,
`@`, tab, CR) because merchant names and OCR text land in an accountant's
spreadsheet; MT940 fields are stripped of newlines and colons so a payee name
cannot forge a statement record; export filenames are sanitised before they
reach `Content-Disposition`.

**Error handling.** 5xx responses carry `{ error: "Internal error", requestId }`.
bunq and LLM error bodies quote IBANs, account ids and payloads, and stay in the
operator log only.

**Logging.** Voice transcripts are redacted unless `LOG_TRANSCRIPTS=true`.
Webhook category/event strings are stripped to `[A-Za-z0-9_-]` before logging.
The token is never logged — only a 6-character fingerprint.

**Data at rest.** The SQLite database (and its `-wal`/`-shm`) is chmod 0600 on
open. It still holds the bunq private key in plaintext: full-disk encryption is
the assumed control, and the file must never be committed or synced.

**Frontend.** CSP restricts scripts to same-origin, blocks objects and pins
`base-uri`/`form-action`. The dev server has an explicit `allowedHosts` list
(DNS-rebinding protection), `cors: false` (it previously answered cross-origin
fetches with `Access-Control-Allow-Origin: *`, which would have exposed
token-authenticated proxy responses), and `fs.deny` for `.env`, `.bunqsy-token`,
`*.pem`, `*.key` and `*.db*`.

## Production checklist

`assertSafeConfig()` refuses to boot in production when any of these is wrong:

- `BUNQ_*_URL` must be https and on a bunq host
- `WEBHOOK_PUBLIC_URL` must be https
- `ALLOWED_ORIGINS` (or `FRONTEND_URL`) must be set
- `BUNQ_OFFLINE_MODE` must not be `true`
- `MAX_PAYMENT_EUR` must be a positive number

Plus, by hand:

- [ ] `BUNQSY_API_TOKEN` set from a secret manager, not the generated file
- [ ] Daemon behind TLS; `TRUST_PROXY=true` only if the proxy sets `X-Forwarded-For`
- [ ] Database on an encrypted volume, backups encrypted
- [ ] bunq API key scoped to the smallest permission set that works
- [ ] `VOICE_PAYMENTS_ENABLED` left `false` unless the payment flow is required

## Data protection (GDPR posture)

**What leaves the machine.** Three processors receive user data:

| Processor | Data | Trigger |
|---|---|---|
| bunq | account, payment and card operations | heartbeat + confirmed plans |
| Anthropic (Claude) | transaction descriptions, amounts, merchant names, receipt **images**, voice transcripts | oracle, dream, planner, receipt scan |
| ElevenLabs | raw microphone audio, narration text | voice command + spoken responses |

Receipt photographs routinely contain more than the purchase (loyalty numbers,
partial card numbers, a shop's address). Users should be told this before the
first scan; the daemon does not redact images before upload.

**What stays local.** Everything else: the SQLite database holds transactions,
patterns, interventions, receipts, journal entries and the bunq session key. It
never leaves the machine and is chmod 0600.

**Retention.** `tick_log` and `score_log` are pruned to 30 days at every boot.
Transactions, receipts and journal entries are retained indefinitely because the
bookkeeping and VAT features depend on them — Dutch tax law requires seven years.

**Erasure.** This is a single-user, local-first deployment: the right to erasure
is exercised by deleting the database file (`rm -f $DB_PATH*`), which removes all
personal data and the bunq session in one step. There is no server-side copy.

**Minimisation gap.** Voice transcripts and receipt images are sent in full to
third-party models rather than a redacted subset. Reducing that is a product
decision (on-device STT, OCR masking) rather than a configuration one.

## Known residual risks

1. **Single-user model.** One token, one dataset, no per-user isolation. Adding a
   second user requires real sessions and row-level scoping.
2. **Prompt injection into narration.** A merchant name can influence the text
   the guardian speaks. It cannot influence *actions* beyond the validated step
   schema, but a convincing narration is a social-engineering surface.
3. **Private key at rest.** Plaintext in SQLite, protected by file permissions
   and disk encryption only.
4. **Sandbox webhook IPs.** In sandbox mode any source IP may deliver webhooks
   (bunq's sandbox callers are not on a fixed range); the effect is limited to
   triggering an early heartbeat tick.

## Reporting

Open a private security advisory on the repository rather than a public issue.

## Verifying

```bash
npm test          # 50-check security suite + signing round-trip
npm audit         # expected: 0 vulnerabilities
npm run typecheck
```
