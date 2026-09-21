# Contributing

Bug reports, questions and pull requests are welcome.

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

## Reporting a problem

Open an issue with what you did, what happened, and what you expected. The
backend log is the useful evidence — it names every webhook, the dial result and
the recording callback. `DialBLegUUID` present means the call connected; empty
means no B leg was ever created, whatever the UI said.

For a security problem, do not open an issue — see [SECURITY.md](SECURITY.md).

## House rules

These are not style preferences.

**Never commit a credential.** `backend/.env` is gitignored, and `agents.json`
is committed — so it holds display names and SIP usernames only.

**Never fetch a caller-supplied URL with credentials attached.** A new media
endpoint takes an id, resolves the URL server-side, and checks it against
`MEDIA_HOST_ALLOWLIST` — before the request and again after every redirect.

**A new route that spends money, changes configuration, or reads call data
starts with `if (!requireSession(req, res)) return;`.** The default is closed.

**Keep CORS an allowlist.** Add an origin to `ORIGIN_ALLOWLIST`, or set
`ALLOWED_ORIGINS`.

**A test that cannot fail is worse than no test.** Assert on the thing that
would break, and make the process exit non-zero.

## The architecture, in one line

The browser is the A leg: the softphone sends the INVITE and the backend answers
`<Dial><Number>`. Do not turn this into a backend-originated call bridged with
`<Dial><User>` — a call cannot be routed into a registered WebRTC endpoint, and
the symptom is a customer who answers, hears ringback, and is told the agent
could not be reached. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Pull requests

1. Branch from `main`.
2. `npm test` must pass, and new behaviour needs an assertion.
3. Say what you verified and how. For anything touching call flow, that means a
   real call with two-way audio, not just a green suite.
4. Update [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
