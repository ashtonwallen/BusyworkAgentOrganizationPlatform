# Mission demonstration scenarios

Build once with `npm run build`, then run one of these isolated fixtures:

```sh
node scripts/dev-fixture.mjs --port 3099
node scripts/dev-fixture.mjs --port 3099 --mission-review
node scripts/dev-fixture.mjs --port 3099 --empty
```

Run only one scenario on the same port at a time. Restarting discards all fixture changes.

- Default: populated business mission, a completed content mission with a versioned checklist and owner-confirmed evidence, and a draft research mission. Explore Missions for history, budget, capabilities and deliverables.
- `--mission-review`: finite content mission awaiting owner acceptance. Review its exact document version and completion evidence, then confirm or return it for further work. The earlier business example remains stopped.
- `--empty`: first-run template selection. Create any of the six mission templates; the team stays paused.

All content, costs, approvals and outcomes are synthetic. No worker starts, no provider is called, and no message is sent. An uncited hypothesis in the checklist illustrates citation limitations rather than claiming researched evidence.

Validate with `node scripts/dashboard-smoke.mjs`, adding `--mission-review` or `--onboarding` for the other scenarios. Each checks all dashboard sections using an isolated browser and in-memory database.

The separate website simulator still needs its own coordinated re-sync of dashboard assets and API recordings. These fixture changes do not deploy or modify that website.
