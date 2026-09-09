# Security

Busywork is experimental software that processes untrusted model output, websites, documents, and email. A local installation can spend through supplied credentials and perform authorized external actions. The operator remains responsible for reviewing and limiting those capabilities.

## Reporting vulnerabilities

Use the public repository's **Security > Report a vulnerability** flow once private reporting is enabled. Do not put keys, customer records, exploitation details, email bodies, owner tokens or database copies in a public issue. If private reporting is unavailable, open a minimal issue asking the maintainers to provide a private channel, with no sensitive details. Enabling and verifying that channel is a release prerequisite. No response-time SLA is offered.

## Default boundaries

- The API binds to `127.0.0.1`; dashboard sign-in and origin checks are enabled. Do not expose it to the internet by simply changing a bind address or opening a tunnel.
- Company execution starts paused on a new database. The owner chooses the CEO model and controls headcount, concurrency, approvals and spending caps.
- Provider credentials stay server-side. Agent prompts and workspace programs do not receive them as general-purpose capabilities.
- Approval is bound to the exact action proposal. Dispatch rechecks current controls. Uncertain dispatches must be reconciled, not blindly replayed.
- Restricted public-page readers reject private-network destinations. Explicit local-model endpoints are separate from public browsing permissions.
- Optional Python programs run with no network or host mounts, a read-only root filesystem, resource limits and bounded copied text inputs/outputs. This is not general host access.
- Workspace scope and employee email permissions restrict retrieval. Possessing a record ID does not grant access to private records.

## Limits

These controls are not a proof against prompt injection, malicious dependencies, compromised providers or runtime vulnerabilities. An approved message can still be misleading; a provider's acceptance receipt is not proof of customer receipt or satisfaction. The ledger is not an independent bank statement. Source links and audit records support investigation without making agent reasoning trustworthy by default.

The local administrator controls files and database access and can change this software. Database audit triggers prevent ordinary application updates/deletes; they are not tamper-proof protection against that administrator. Keep encrypted backups and protect the local machine.

Never commit `.env`, real `config/*.json`, payment destinations, `data/`, backups, tokens, OAuth encryption keys or captured live-business screenshots. Demo captures must use the isolated fixture. Test sign-in bypass is only for isolated local testing and should remain disabled in real deployments.
