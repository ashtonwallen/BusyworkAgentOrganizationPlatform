# Initial public release checklist

This directory is a candidate, not a published repository. Do not publish the private development repository or its Git history.

Before creating a fresh public repository:

- Confirm the Busywork name and repository availability; a source-code name is not trademark clearance.
- Confirm `AGPL-3.0-only` licensing and decide the contributor agreement. Do not assume DCO sign-offs grant proprietary relicensing rights.
- Enable private vulnerability reporting and identify a moderation contact; confirm both paths work.
- Run `node scripts/package-source.mjs` and manually inspect its manifest and archive under `artifacts/source-package/`. It uses source allowlists and rejects private keys and symlinks. No scanner guarantees absence of sensitive content; inspect fixtures and documentation as well.
- Verify no `.git`, private `.env`, real config, data, backup, owner notes or live-business captures are included.
- Run the clean-install quickstart, build and tests. Record the tested OS; do not advertise untested platforms as verified.
- Generate demo media against the fixture only and label its transactions synthetic.
- Review provider setup documentation and known limitations.
- Initialize a new Git repository inside the approved clean source directory, review the author identity, make one initial commit, then create the public remote. Do not copy old Git objects.
- Set package version and changelog to `0.1.0`, tag `v0.1.0`, and publish only after the owner reviews the prepared result.

No multi-tenancy, hosted service, earnings claim or shared credential service is part of this release.
