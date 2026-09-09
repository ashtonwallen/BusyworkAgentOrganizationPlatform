# Contributing

Issues, documentation feedback and reproducible bug reports are welcome. Use synthetic records, remove credentials, and describe the expected and observed behavior.

Outside code contributions are temporarily deferred while the maintainer decides the contributor agreement needed for potential dual licensing. AGPL licensing of this release does not automatically authorize proprietary relicensing of someone else's contribution. A DCO certifies provenance; it is not a substitute for a CLA granting the necessary rights. Do not submit confidential code or customer data.

When code contributions open, follow the agreement and sign-off instructions published here before submitting a pull request. Until then, suggested designs and privately maintained AGPL forks remain possible under the license.

For local development, install the pinned dependencies, run `npm run build` and `npm test`, and keep tests scoped to the behavior changed. Use fake providers and isolated databases; never add tests that send real messages or spend through an inherited key. Avoid tests that merely duplicate implementation details.

Changes to execution must preserve exact proposal binding, reservations, receipts, uncertainty handling, permissions and restart behavior. Describe those effects in the pull request. Changes to user-facing setup should be checked with no keys and no private configuration.
