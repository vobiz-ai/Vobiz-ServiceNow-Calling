# Contributing

## Setup

Node 18 or newer. There are no runtime dependencies — the backend is Node's own
`http`, and JsSIP is vendored in `agent-phone/lib/`.

```bash
cp backend/.env.example backend/.env    # then fill it in
npm start                               # backend on :8092
npm run tunnel                          # public HTTPS, in a second shell
npm test                                # the suite, against a mock Vobiz API
```

`cloudflared` must be on your PATH. The binary is not committed.

---

## Rules that are not style preferences

**Never commit a credential.** `backend/.env` is gitignored. `agents.json` is
committed, so it holds display names and SIP usernames only — putting a password
there publishes it. There is no hardcoded fallback password anywhere in this
codebase, and adding one undoes a fixed vulnerability.

**Never fetch a caller-supplied URL with credentials attached.** If you need a
new media endpoint, take an id, resolve the URL server-side, and check it
against `MEDIA_HOST_ALLOWLIST` — before the request and again after every
redirect. This is the single defect that has recurred most across the Vobiz CRM
integrations.

**A new route that spends money, changes configuration, or reads call data
starts with `if (!requireSession(req, res)) return;`.** The default is closed.

**A test that cannot fail is worse than no test.** Assert on the thing that
would break, and make the process exit non-zero. `fetch()` normalises `/../`
before sending, so a path-traversal test written with it passes against a
vulnerable server — use a raw socket, as `verify-integration.js` does in the
sibling ClickUp repository.

**Do not reintroduce wildcard CORS.** Add the origin to `ORIGIN_ALLOWLIST` or
set `ALLOWED_ORIGINS`.

---

## The architecture, in one line

The browser is the A leg: the softphone sends the INVITE, the backend answers
`<Dial><Number>`. Do not "simplify" this into a backend-originated call bridged
with `<Dial><User>` — routing into a registered WebRTC endpoint is blocked
platform-side, and the symptom is a customer who answers, hears ringback, and is
told the agent could not be reached. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Pull requests

1. Branch from `main`.
2. `npm test` must pass, and new behaviour needs an assertion.
3. Describe what you verified and how — "ran the suite" and "placed a live call
   to +91…, two-way audio, `DialBLegUUID` present" are different claims, and the
   second is the one that matters for anything touching call flow.
4. Update `CHANGELOG.md` for anything user-visible, and `ISSUES.md` if you close
   or discover a limitation.

## Reporting a vulnerability

`support@vobiz.ai`, not a public issue. See [SECURITY.md](SECURITY.md).
