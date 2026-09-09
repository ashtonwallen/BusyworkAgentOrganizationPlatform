# Architecture

Busywork is a single-instance TypeScript monorepo. The Node API serves a plain JavaScript dashboard and persists state using embedded PostgreSQL through PGlite. Node.js 22+ is required. There is no multi-tenant service or separate required PostgreSQL server.

| Component | Responsibility |
| --- | --- |
| `apps/api` | Owner authentication, HTTP API, lifecycle and provider wiring |
| `apps/dashboard` | Owner dashboard, approvals and agent conversations |
| `packages/runtime` | Organization, worker cycles, persistent state, migrations and execution adapters |
| `packages/providers` | Model-provider transport and normalized failures/usage |
| `packages/policy` | Policy helpers |
| `packages/core` | Shared primitives, including exact money representation |

An agent produces a plan, work artifact and self-check. Reviewed operations become internal changes or external proposals. Policy and dispatch controls determine whether execution can proceed. A successful plan or self-check is not an external receipt. Supervisors and peers can provide additional review when the organization chooses.

Agent task token/dollar allocations are estimates. Actual model context/output limits, configured spending caps, deadlines and concurrency are enforced. Monetary values use integer micro-USD for reservations and settlement. Unknown usage or dispatch outcomes stay explicit and can retain financial holds.

The supported external adapters are specific capabilities, not unrestricted browser or host access. Customers bring their own accounts; no shared platform key or mailbox exists. One process uses one immutable startup identity. Existing private instances can retain their own environment, config and data directories across source upgrades.

Active schema definitions and migrations are in `packages/runtime/src/schema.ts` and `db.ts`. Old design schemas and personal planning documents are deliberately absent from the public distribution.
