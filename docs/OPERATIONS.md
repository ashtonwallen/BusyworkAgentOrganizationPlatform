# Private instances and operations

Keep source separate from private instance files. For example, store an instance environment file outside the repository containing absolute `HIVE_DATA_DIR`, `HIVE_CONFIG_DIR`, and optional `HIVE_PAYMENT_INFO_FILE` paths. Set `HIVE_COMPANY_NAME` and `HIVE_BUSINESS_EMAIL` for that business. Select the environment file when starting:

```sh
HIVE_ENV_FILE=/absolute/path/to/instance.env npm start
```

PowerShell:

```powershell
$env:HIVE_ENV_FILE = 'C:/private-instance/instance.env'
npm.cmd start
```

The API loads that file before runtime configuration. Process environment takes precedence. Do not add your personal instance file to the repository or public release archive. Keep distinct instances on distinct ports and data directories. A lock guards each server's data directory; never delete a live server's lock to force a second process to open it.

Pause the business in Controls before stopping the API with Ctrl+C. Starting the API preserves stored company status. The dashboard can be available while the business is paused. SMS notifications are a separately enabled workflow; pausing ordinary business work is not a revocation of previously enabled notification permissions.

## Updating a private installation

Maintain one checkout of Busywork. Keep instance configuration and data outside it, and launch that checkout with `HIVE_ENV_FILE` as above. No separate personal fork or copying of application files is required. Public-source changes apply to the private installation after rebuilding and restarting it.

Pause work and stop the API before updating. Make an offline backup, review release notes for migrations, install dependencies with the locked versions, run `npm run build`, then restart using the same instance environment file. Confirm the dashboard shows the expected records and configuration before resuming the business. Do not run old and new servers against the same database. An older source version may require restoration of its matching database backup if an update changes the schema.

## Backups

Stop the API and other workspace writers before backing up. Never copy a live database directory.

```sh
node scripts/backup.mjs backup /private/data /private/backups/checkpoint-01
node scripts/backup.mjs restore /private/backups/checkpoint-01 /private/restored-data
```

Backup and restore destinations must be new directories. The tool inventories and hashes the database and workspaces, refuses an existing server lock, verifies restoration, and restores the company paused. It does not include `.env`, owner tokens or the Gmail encryption key. Those credentials require separate protected handling; an OAuth connection whose original encryption key is unavailable must be reconnected.

Backups contain private records even though credentials are excluded. Protect them accordingly. Source code, configuration and credentials are not interchangeable with database state.
