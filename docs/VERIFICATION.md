# Mission generalization verification

## Step 0: clean-clone baseline (2026-09-17)

Cloned commit `1b5e6e6` into a disposable ignored directory with no instance configuration or database. Installed locked dependencies offline from the local package cache.

- Build: passed.
- Full test suite: 292 passed, one optional Docker sandbox test skipped (62 passing files, one skipped).
- Typecheck: passed.
- Requested dashboard smoke command: initially failed because the script did not exist in the candidate.

Added `scripts/dashboard-smoke.mjs`. It starts its own in-memory fixture on a temporary loopback port, starts no worker, permits browser requests only to that fixture, checks all navigation sections, and shuts down its browser and fixture. It does not depend on a running personal instance or credentials. Applied that script to the clean clone and verified all 13 sections with zero browser errors. Requires an installed Playwright Chromium binary.

The pre-existing `docs/DEMO.md` edit belongs to the website simulator handoff. It was inspected and deliberately left uncommitted and unchanged. No website files were edited. Snapshot/UI changes in subsequent steps require a separate simulator re-sync by its maintainer.

The owner subsequently requested proportionate testing: focused behavior tests while implementing, then a full consistency check at the end, rather than a full-suite repetition after every commit.

## Step 1: mission foundation

Additive migration 17 attributes historical work and immutable audit records to the legacy business mission using column defaults, without disabling audit triggers or rewriting ledger contents. Inserts inherit mission attribution from linked work; later reassignment is rejected. Orders are event-sourced, so their events carry mission attribution rather than creating a second orders table. Directions retain one current entry per mission. New mission APIs enforce a single active mission and paused activation; template departments and CEO department proposals preserve owner and headcount controls.

Validation: build and typecheck; 3 mission migration/activation/scoping tests, 5 reset tests, 1 persistence test and 36 organization tests passed. The isolated 13-section dashboard smoke check passed. No personal instance was restarted or migrated.

## Step 2: finite lifecycle and spending admission

CEO completion requests pin exact document versions and recorded evidence for each acceptance condition. The request hashes the mission revision, conditions and deliverable; only an authenticated owner decision can complete it. Work stops while confirmation is pending. Finite-cycle stall checks use recorded task results (excluding the CEO's own repetitive cycle completions), document versions, completed reads and non-model approvals. A stall pauses the mission and creates one owner request. Ongoing missions retain their cycle behavior.

Mission admission includes settled ledger costs and unresolved model/action/SMS holds. Dispatch checks cover models, research, email, SMS and publishing. Owner resume can revise mission limits without releasing holds. Migration 18 enforces aggregate parent allocations at the database boundary; child inference also checks its remaining allocation. This intentionally replaces the earlier advisory delegation estimates to meet the requested invariant.

Validation: 80 distinct focused tests passed across lifecycle, organization, research gateway, email, deployments, reset and persistence. A circular schema import found by the gateway tests was fixed by isolating the completion input schema. Build/typecheck and isolated dashboard smoke passed. No live provider calls or messages.

## Step 3: mission accountability

Direction scorecards now isolate their mission's costs and outcomes. All report completed/failed work, spend, recorded activity and cited completion-condition evidence. Only commerce-enabled missions expose revenue, refunds and opportunity metrics. The CEO's cycle guidance and direction card use the same distinction. Activity is explicitly not proof that acceptance conditions are satisfied.

Validation: 37 tests passed (organization and mission-scorecard), including cross-mission financial isolation and absence of commercial metrics in research. Build/typecheck and the 13-section smoke check passed.
