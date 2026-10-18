# Security policy

## Reporting a vulnerability

Email `support@vobiz.ai`. Please do not open a public issue.

Include the request that demonstrates it — a `curl` line is ideal — the endpoint
affected, and what you were able to read or do. We aim to acknowledge within one
working day.

---

## What this service holds

A running instance holds:

- in memory only, the Vobiz **Auth Token of every account signed in to it**.
  Each is enough to place calls billed to that account and read every recording
  on it. They are never written to disk, logged or returned.
- in memory only, the **SIP password set at each sign-in**, served only to that
  browser session
- in `backend/data/endpoints.json` (0600), endpoint **ids and usernames** per
  account and agent, with no passwords
- in `backend/.env`, **ServiceNow instance credentials** with write access to
  `interaction`. No Vobiz credential goes in `.env`.

It is normally exposed to the internet through a tunnel, because Vobiz has to
reach `/answer`. Treat any endpoint on it as internet-facing, because it is.

---

## Rules this codebase follows

These are enforced by the test suite, which fails if any is undone.

**No credential ever leaves on a caller's instruction.** The recording proxy
takes a recording *id*, resolves the media URL server-side, and refuses any host
off an allowlist — checked before the first request and again after every
redirect, dropping our headers on the way, because a presigned storage URL
carries its own authorisation. An endpoint that fetches a caller-supplied URL
with credentials attached is a credential-exfiltration primitive, not merely
SSRF.

**Playback links prove themselves.** They are HMAC-signed over account, id and
expiry, so a link can never be pointed at another account's audio.
They end up in ServiceNow work notes, where every agent on the instance can read
them for as long as the record exists, so they must never carry credentials and
must expire.

**Credentials are proven, not assumed.** Sign-in validates against Vobiz. There
is no "looks like a key" fallback.

**Secrets are served only to a session.** The SIP password is generated at sign-in
and goes only to that session. `agents.json` is committed, so it holds display
names only.

**Unauthenticated endpoints describe, they do not reveal.** `/health` reports
whether things are configured, not what they are.

**CORS is an allowlist.** `*.service-now.com`, localhost, and `ALLOWED_ORIGINS`.

**Anything that spends money is authenticated.** `/start-call` requires the
shared secret or an account session; in account mode, caller ID must be on the
account's own number list.

---

## Operating one safely

- Set `SIGNING_SECRET` explicitly. Left unset it is random per process, so
  playback links stop working whenever the server restarts.
- Set `VOBIZ_SHARED_SECRET` and the matching `vobiz.calling.shared_secret`
  property — the ServiceNow UI Action cannot place calls without it.
- Keep `backend/.env` out of git. It is gitignored; check before you force-add.
- Prefer a stable hostname over a quick tunnel in production. A quick tunnel
  hostname is reassigned to someone else after you release it.
