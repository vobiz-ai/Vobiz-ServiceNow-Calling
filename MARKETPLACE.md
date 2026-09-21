# Distribution on ServiceNow

The integration works as a configured install: a backend you run, an OpenFrame
configuration, two system properties and a UI Action. Publishing it so a
ServiceNow customer can install it in one step is separate work, and it starts
with a decision that is not ours to defer.

---

## Decide first: who hosts the backend

**A Store app cannot ask every customer to run a Node backend on a tunnel.** The
OpenFrame URL and the Vobiz `answer_url` must be stable and reachable, and the
backend holds Vobiz account credentials.

Three ways out, in the order they are usually considered:

1. **Vobiz hosts one multi-tenant backend** at a permanent domain. Best product,
   most work: this repository binds to a single Vobiz account through `.env`, so
   multi-tenancy means real per-account authentication and an endpoint per agent.
2. **Customer-hosted, documented.** What exists today. It stays an integration
   customers deploy themselves, with a published install guide — no Store
   listing.
3. **Listing as an integration only**, pointing at documentation rather than an
   installable artefact.

Until that is settled, everything below is premature.

---

## What a ServiceNow Store listing requires

### Not done yet

- [ ] **A scoped application.** `servicenow-app/` is configuration plus a UI
      Action script to paste in — there is no scoped app, no update set, no
      `sys_app` record. The Store distributes scoped apps.
- [ ] **A ServiceNow Partner account** and membership in the Technology Partner
      Program. Store submission is gated on it; there is no self-serve path.
- [ ] **Application security review.** ServiceNow reviews scoped apps for ACLs,
      script injection, and outbound REST usage. This app makes outbound REST
      calls carrying a shared secret — expect questions about where it is stored
      (`sys_properties` of type `password2`, not `string`).
- [ ] **A stable public hostname** for the OpenFrame URL and `answer_url`.
- [ ] **ACLs and roles.** Today the UI Action is visible per its condition, and
      the backend trusts `gs.getUserName()` for the agent label. A Store app
      needs an explicit role — `vobiz_agent` — and ACLs on anything it creates.
- [ ] Listing assets: logo, description, screenshots, demo video.
- [ ] Terms of Service and Privacy Policy URLs, published.
- [ ] A test instance and credentials for ServiceNow's reviewers.

### Already true

- [x] Uses the standard `interaction` table rather than a custom table.
- [x] No hardcoded instance URL or secret — both come from `sys_properties`.
- [x] OpenFrame is the supported way to embed a softphone; no DOM injection into
      the ServiceNow UI.
- [x] Outbound REST from ServiceNow uses `sn_ws.RESTMessageV2`, server-side.

---

## Worth resolving before a reviewer sees it

- **`vobiz.calling.shared_secret` should be `password2`**, not `string`. As a
  string it is readable by anyone who can list `sys_properties`.
- **The interaction work note embeds a link with `[code]`**, which renders raw
  HTML in the record. It is ours today; if any of it ever becomes caller-
  influenced, that is stored XSS in the agent's workspace.
- **One shared SIP endpoint per install.** Two agents racing for the same
  registration is not something to demonstrate.
