# Development guidance

Busywork is a control plane for a team pursuing an owner-defined mission. Business operation is one template. Keep one runtime and preserve existing commerce features for missions that enable them.

The agents choose strategy. Owners supply objectives, boundaries, approvals and acceptance; do not design an interface that requires the owner to manage the team's strategy.

Preserve exact-action hashes, cost reservation before dispatch, holds for uncertain charges, append-only audit protections and source-backed execution receipts. Never put credentials in prompts or records. Use isolated fixtures and mock providers for development, never paid calls or live messages.

Use focused tests during development and run full consistency checks at release checkpoints. Keep unrelated local changes intact. If another editor changes files during a single-editor task, stop and report the conflict.

Mission changes must preserve legacy backfill and mission attribution. Add new operations to the shared capability registry and enforce them at execution as well as in prompts. Finite completion must pin recorded evidence and a durable document version, then require owner confirmation. Do not replace source provenance with model confidence or treat search snippets as fetched-page evidence.
