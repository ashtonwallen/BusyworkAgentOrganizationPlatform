# Busywork

Self-hosted agent teams pursuing missions with approvals, spending controls, and an audit trail. Bring your own API keys or local model workers.

Busywork runs a persistent organization of agents: a CEO plans work, hires and delegates, and coordinates through messages, shared documents, and follow-ups. You define the mission's objective, boundaries and acceptance conditions; the team chooses its strategy. Templates cover research, outreach, comparisons, content, business operation and custom work. Commerce-enabled missions retain customer orders and revenue tracking.

The engineering focus is accountable execution:

- Approval binds to an exact action and its recorded hash. Editing a proposal requires a new approval.
- Model-call cost is reserved before dispatch and settled after usage is known. Uncertain outcomes retain their exposure until reconciled.
- Ledger entries, events, and approval records reject ordinary database updates and deletes through database triggers.
- A proposal or model claim is not proof of execution. External actions retain provider or owner-recorded receipts, including uncertainty.

This is experimental software. The commercial premise is unvalidated: Busywork does not promise revenue, profitability, or reliable autonomous business judgment. Demo transactions are synthetic. Private development usage is not a public benchmark. An audit trail records claims and receipts; it does not independently prove that a customer's payment, acceptance, or an owner's manual receipt is truthful. A machine/database administrator can alter the installation.

## Quickstart

Requires Node.js 22+ and an available port 3001. Docker is optional unless you use the isolated Python tool.

From a downloaded source directory:

```sh
npm exec --yes --package=pnpm@10.34.5 -- pnpm install --frozen-lockfile
npm exec -- pnpm build
npm start
```

On Windows PowerShell, use `npm.cmd` if your execution policy blocks `npm.ps1`.

Open http://127.0.0.1:3001 and sign in with the generated key in `data/owner-token.txt`. Keep the terminal open. Stop the server with Ctrl+C; restart with `npm start`. State persists in `data/postgres` and agent files in `data/workspaces`. The team initially starts **paused**. Restarts preserve the stored state, so pause it in Controls before stopping if you want it to remain paused after restart.

On first run, choose a template or custom mission under **What should your team work on?** Set its outcome, acceptance conditions, boundaries, deliverable and budget. The CEO chooses the strategy. Existing installations keep their original mandate as an ongoing **Run a business** mission.

Choose a worker before starting the team:

1. **Local:** start LM Studio's API server at `http://localhost:1234/v1` with a model loaded. In Models, refresh availability. Busywork discovers the loaded model; no specific model or GPU is required by the application. Model memory, context size, and output quality determine whether your tasks are practical.
2. **Paid:** copy `.env.example` to a private `.env`, add your provider key, and restart. In Models, configure a model ID. Unknown pricing must be established before a paid call can be admitted. A key alone does not authorize spending.
3. Review Controls, select the CEO model, and start the team when ready. You do not launch individual workers manually; the CEO hires within the configured limits.

No local server and no configured keys is a supported setup state: the dashboard works, explains the missing worker, and does not substitute a mock agent for real inference. Public endpoints are not automatically probed with paid inference.

## Start with the fixture if you only want to explore

After building, run `npm run demo` and open http://127.0.0.1:3099. The fixture prints a disposable demo access key. It uses an in-memory database and starts no business scheduler. All customers, receipts, staff, and outcomes in this demo are synthetic.

See [reproducible demo capture](docs/DEMO.md). Demo screenshots and recordings are not evidence of business results.

## Instance configuration

Your keys, model registry, owner details, payment destinations, and data are private instance files, not source code. Never commit them.

| Setting | Purpose | Default |
| --- | --- | --- |
| `HIVE_ENV_FILE` | Path to an external environment file; set before launch | `.env` in the software directory |
| `HIVE_CONFIG_DIR` | Private JSON seed files and extra worker registry | `config` |
| `HIVE_DATA_DIR` | Database, workspaces, and locally generated keys | `data` |
| `HIVE_PAYMENT_INFO_FILE` | Optional receiving-address record | `Payment_Info_Venmo_Crypto.txt` |
| `HIVE_COMPANY_NAME` | The organization identity presented to agents | `My business` |
| `HIVE_BUSINESS_EMAIL` | Account to connect through Gmail OAuth | Unconfigured |
| `PORT` | Loopback dashboard port | `3001` |

Paths may be absolute; relative paths resolve from the software directory. Process environment variables override the selected environment file. One server process operates one business instance. Use different ports, data, and environment/config paths for independent instances; never open the same data directory from two processes.

The optional JSON files are `models.json`, `company-records.json`, `owner-reminders.json`, and `candidates.json`. Examples live in `config/`; nothing is copied automatically into your real configuration. Recruitment can generate applicants as needed without a stored candidate pool. Use the model registry example for additional local or LAN workers; LAN access requires an explicit URL and `allowLan: true`.

## Spending and external actions

This software can spend real money through your API keys, send real email, and publish real sites when configured and authorized. The operator is responsible for their keys, recipients, content, actions, and spending. Read [security and execution boundaries](SECURITY.md) before enabling the team.

Fresh installations require approval for expenses, paid model calls, communications, publishing, and account actions. SMS notifications are off. The dashboard binds to loopback and requires its owner key. The testing-only sign-in bypass is off. Model and task estimates are not deposited funds or independent bank balances.

Approvals are configurable: disabling them changes your exposure. Approval does not install an unsupported executor. Paid inference, SMS notifications, external communications, and publishing have distinct controls. Source content and inbound email are untrusted and can contain prompt injection; controls reduce risk but do not establish immunity.

## Missions and completion

Only one mission can be active (or awaiting completion review) at a time. Finite missions stop scheduling work when the CEO submits completion evidence and a versioned deliverable; only your confirmation marks them completed. Lack of recorded progress triggers a configurable stall escalation. Ongoing missions retain recurring CEO cycles.

A mission's total cap is additional to daily and lifetime controls. Settled costs and unresolved reservations count against it. Delegated tasks cannot allocate more money or tokens than their parent has remaining. A cap or deadline pause appears on Overview with a review/resume control; unresolved charges are never erased by resuming or stopping.

Enabled capability families determine both the instructions agents receive and the operations they may execute. Capability availability does not waive approval. Research documents can attach claims to immutable source receipts; uncited claims must be marked inference or hypothesis. Citation records establish provenance, not truth or complete coverage of unstructured prose.

The Missions page retains prior objectives, recorded spend, acceptance evidence and exact deliverable versions. See [mission setup and operation](docs/MISSIONS.md) and [verification results and prompt measurements](docs/VERIFICATION.md).

## Optional integrations

- **Web search:** configure your own Brave Search key and explicit per-query price. Searches use the research approval gateway and reserve configured costs before dispatch. Unconfigured search is unavailable; agents must not fabricate source URLs.
- **Gmail / Google Workspace:** bring your own OAuth client and mailbox. Configure the Gmail API and appropriate consent settings before connecting. This repository provides no shared verified OAuth application. Exact-template campaigns can be approved for a bounded explicit recipient list, send cap and time window. All sends enforce the do-not-contact list; new proposals freeze sender identification and an opt-out footer.
- **Twilio:** bring your own account, sender, recipient, and explicit SMS cost limits. Outbound notifications work without a reply webhook; signed replies require a publicly reachable endpoint. Country, sender and campaign requirements apply.
- **Netlify:** bring your own token and site ID. Publishing binds an approved release to exact files and the configured destination. No general account creation or arbitrary hosting provisioning is provided.
- **Isolated Python:** optional Docker Linux engine, pinned image, no network or host mounts for agent programs. No unrestricted shell, desktop automation, or agent modification of Busywork source is provided.

See [integration setup](docs/INTEGRATIONS.md), [architecture](docs/ARCHITECTURE.md), and [backup and instance operations](docs/OPERATIONS.md).

## Development and project status

```sh
npm test
```

Tests use isolated data and mock providers. The Docker sandbox test is opt-in. Passing tests do not demonstrate provider reachability, profitability, or resistance to every malicious prompt.

The initial public candidate has not been published or tagged. See [release checklist](docs/RELEASING.md), [contribution policy](CONTRIBUTING.md), and [changelog](CHANGELOG.md).

Licensed under [GNU AGPL version 3](LICENSE), SPDX `AGPL-3.0-only`. This permits commercial use and redistribution under its terms; modified network deployments have source-offer obligations. Internal package names currently retain the `@hive/*` namespace for compatibility.
