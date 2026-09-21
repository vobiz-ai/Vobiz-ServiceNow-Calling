# Security policy

## Reporting a vulnerability

Email `support@vobiz.ai`. Please do not open a public issue.

Include the request that demonstrates it — a `curl` line is ideal — the endpoint
affected, and what you were able to read or do. We aim to acknowledge within one
working day.

---

## What this service holds

A running instance holds, in `backend/.env`:

- a Vobiz **Auth ID and Auth Token** — enough to place calls billed to the
  account and read every recording on it
- a Vobiz **SIP endpoint password** — enough to register as the agent
- **ServiceNow instance credentials** with write access to `interaction`

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

**Playback links prove themselves.** They are HMAC-signed with a short expiry.
They end up in ServiceNow work notes, where every agent on the instance can read
them for as long as the record exists, so they must never carry credentials and
must expire.

**Credentials are proven, not assumed.** Sign-in validates against Vobiz. There
is no "looks like a key" fallback, including on a server not bound to an
account.

**Secrets are served only to a session.** SIP credentials come from the
environment and go only to a signed-in caller. `agents.json` is committed, so it
holds display names and SIP usernames — never a password.

**Unauthenticated endpoints describe, they do not reveal.** `/health` reports
whether things are configured, not what they are.

**CORS is an allowlist.** `*.service-now.com`, localhost, and `ALLOWED_ORIGINS`.

**Anything that spends money is authenticated.** `/start-call` requires the
shared secret or a session; caller ID must be a number the account owns.

---

## Operating one safely

- Set `SIGNING_SECRET` explicitly. Left unset it is random per process, so
  playback links stop working whenever the server restarts.
- Set `VOBIZ_SHARED_SECRET` and the matching `vobiz.calling.shared_secret`
  property — the ServiceNow UI Action cannot place calls without it.
- Keep `backend/.env` out of git. It is gitignored; check before you force-add.
- Prefer a stable hostname over a quick tunnel in production. A quick tunnel
  hostname is reassigned to someone else after you release it.
