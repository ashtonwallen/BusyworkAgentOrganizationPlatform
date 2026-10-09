# Reproducible demonstration

Start `npm run demo` after building. This is synthetic fixture data in memory, not your business database. The fixture starts no worker, sends no real messages, makes no paid model calls, and records no real revenue.

Install the optional browser binary with `npm exec -- playwright install chromium` if needed. With the fixture listening on port 3099:

```sh
node scripts/ui-screenshots.mjs
node scripts/record-demo.mjs
```

Captures go to ignored `artifacts/`. Only use this fixture for public screenshots. Do not point capture scripts at your real business. Keep captions clear: approval permits the exact proposal; it does not prove a purchase occurred.

The recording produces `artifacts/busywork-approval-demo.webm`, approximately 65 seconds, and a synthetic receipt summary. Restart the fixture before re-recording so the proposal is pending. It shows a synthetic purchase proposal, its reason and maximum cost, owner approval of that exact proposal, and the resulting approved state. Unsupported purchases remain pending owner-assisted execution. Do not edit a video to imply an external purchase or customer result happened.

## A public simulator is built from this fixture

A clickable, backend-free demo of this dashboard is published at
`ashtonwilliamallen.com/busywork-simulator`. It lives in a **separate repo**
(the personal site, `ashtonwilliamallen-portfolio-site`) and is built from two
things in this one:

- a verbatim copy of `apps/dashboard/public`, and
- a recording of the `/v1` responses this fixture serves.

Nothing in this repo is modified to produce it, and no code here imports from
it. But it silently drifts when this repo changes, so if you touch any of the
following, the demo needs a re-sync in that repo:

- **the dashboard's files** — the demo shows the old UI until re-copied;
- **the `/v1/snapshot` shape** — a renamed or added field leaves the recording
  stale, and pages render thin or blank;
- **`/v1` route names** — the demo's shim routes ten of them by hand;
- **status vocabularies** — it depends on action `PENDING`/`EXECUTED`/`REJECTED`,
  task `BLOCKED_APPROVAL`, company `RUNNING`/`PAUSED`, request `OPEN`/`RESOLVED`,
  and events carrying `type` and `sequence`;
- **`scripts/dev-fixture.mjs`'s seed** — the demo's content comes from it.

The re-sync is one command in the site repo (`node tools/sync-busywork.mjs`,
which reads this repo and writes nothing to it), followed by
`node tools/check-simulator.mjs`.

**Worth knowing:** the dashboard swallows its own render errors, so a shape
mismatch presents as a blank page with no console error rather than a stack
trace. That is why the demo has a smoke test at all.

### Three separators were flattened to "?"

`panels/chat.js:37`, `modals/records.js:34` and `pages/documents.js:47` each
contain a literal ASCII `?` where a middle dot belongs — visible in the UI as
`Executive ? Paused`. They were flattened by a save in a non-UTF-8 encoding;
real `·` characters survive elsewhere on the same lines, so it was per-edit
damage rather than a whole-file conversion. Worth fixing here, and worth
checking whatever editor produced it, since em-dashes and arrows are equally at
risk. The site repo patches these three on copy.
