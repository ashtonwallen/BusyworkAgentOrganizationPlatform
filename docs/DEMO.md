# Reproducible demonstration

Start `npm run demo` after building. This is synthetic fixture data in memory, not your business database. The fixture starts no worker, sends no real messages, makes no paid model calls, and records no real revenue.

Install the optional browser binary with `npm exec -- playwright install chromium` if needed. With the fixture listening on port 3099:

```sh
node scripts/ui-screenshots.mjs
node scripts/record-demo.mjs
```

Captures go to ignored `artifacts/`. Only use this fixture for public screenshots. Do not point capture scripts at your real business. Keep captions clear: approval permits the exact proposal; it does not prove a purchase occurred.

The recording produces `artifacts/busywork-approval-demo.webm`, approximately 65 seconds, and a synthetic receipt summary. Restart the fixture before re-recording so the proposal is pending. It shows a synthetic purchase proposal, its reason and maximum cost, owner approval of that exact proposal, and the resulting approved state. Unsupported purchases remain pending owner-assisted execution. Do not edit a video to imply an external purchase or customer result happened.
