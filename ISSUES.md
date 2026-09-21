# Known issues

Last reviewed **21 September 2026**, after the security rewrite in
[CHANGELOG 2.1.0](CHANGELOG.md).

For symptom-driven debugging see [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

---

## Open

### 1. No live call since the security rewrite

`npm test` covers the HTTP surface, the answer XML for both directions, the CDR
ledger and the security regressions — 46 assertions against a mock Vobiz API.
What it does not do is place a real call. The changes in 2.1.0 touched
authentication on every route the softphone uses, so **the next thing this
repository needs is one outbound and one inbound call against a live account,
with two-way audio confirmed**, in both sign-in modes.

### 2. Quick tunnels invalidate three things at once

A restarted `cloudflared` quick tunnel gets a new hostname, and `TUNNEL_URL`,
the Vobiz application's `answer_url`, and the ServiceNow
`vobiz.calling.tunnel_url` property plus the OpenFrame URL all go stale
together. Nothing warns you; calls simply stop.

**Fix:** a stable hostname. Until then, the checklist is in the README.

### 3. `SIGNING_SECRET` defaults to a per-process random value

Left unset, every restart invalidates every playback link already written into a
ServiceNow work note. Set it explicitly in production.

### 4. The backend is single-account, and `agentId` is self-asserted

It binds to one Vobiz account through `.env`, and every agent who signs in
account-mode shares one SIP endpoint. Two agents on one install would register
as the same endpoint and race for calls. Real multi-agent use needs an endpoint
per agent and an identity store.

`agentId` selects a label, not an identity: it chooses the display name and the
ServiceNow user the interaction is assigned to. It is not a credential.

### 5. SIP-direct sign-in does not verify the password

`/login-sip` checks that the caller ID is a number the account owns and issues a
session scoped to SIP-direct mode. The password itself is proven only when the
softphone REGISTERs with Vobiz — so a wrong password shows as "not Ready" rather
than a failed sign-in. That session deliberately cannot read `/agent`.

### 6. Recording playback links expire in five minutes by default

`RECORDING_URL_TTL_SECONDS` is 300. A link in a work note read an hour later is
dead, and the agent must re-open the recording from the softphone. Raising it
widens the window in which a leaked link is useful; this is the trade, and 900
is a reasonable production value.

### 7. Call history is in memory

`recentCalls` is capped at 200 and does not survive a restart. The CDRs
themselves live in Vobiz and in the ServiceNow `interaction` table; this is only
the softphone's recent-calls panel.

### 8. The ServiceNow app is not a scoped application

`servicenow-app/` is configuration and a UI Action script to paste in, not an
update set or a scoped app. There is nothing to install from the ServiceNow
Store. See [MARKETPLACE.md](MARKETPLACE.md).

---

## Platform behaviour to know

- **`<Record>` must be a self-closing sibling before `<Dial>`.** Nested,
  FreeSWITCH rejects the document and the caller hears a bogus "Busy".
- **`<Dial>` needs `action` and `redirect="false"`.** Without them Vobiz
  re-executes the answer document and one call dials repeatedly.
- **Inbound `callerId` must be E.164.** Otherwise B-leg creation is refused
  silently.
- **`Event=Hangup` must be answered with an empty `<Response>`**, not with call
  XML.
- **Vobiz posts webhooks form-encoded**, not as JSON. A JSON-only reader sees
  every parameter as `undefined`, which looks exactly like Vobiz sending
  nothing.
- **A space in the SIP User-Agent string makes Vobiz block its own INVITE.**
  Keep it a single token.
