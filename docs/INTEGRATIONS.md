# Optional integrations

No integration is configured in the public source. An adapter being implemented does not mean your provider account is ready or authorized.

## Models

The default local connection is LM Studio at `http://localhost:1234/v1`. Load any compatible model with enough context for the task, start its server, and refresh availability. Set `LMSTUDIO_BASE_URL` and optional `LMSTUDIO_MODEL` to use another loopback endpoint or pin a model. Additional local/LAN workers go in a private `models.json` based on the registry example. A LAN endpoint must be intentionally configured; never expose an unauthenticated local server to the internet.

OpenAI, Anthropic and Gemini use your private environment keys. Configure model IDs on the dashboard. Unknown token prices need to be established before paid inference. Model selection, inference approval, cost caps, and external-action approvals are separate controls.

## Gmail / Workspace

Set `HIVE_BUSINESS_EMAIL`, create your own Google OAuth web client, enable the Gmail API, and configure client ID, secret and the exact redirect URI. The default is `http://127.0.0.1:3001/email/oauth/callback`; change it when changing the port. Restart and connect the matching account through Email. Tokens stay encrypted on the server; do not paste them into agent chat.

The adapter uses `gmail.readonly` and `gmail.send`. Gmail read-only access is a restricted scope. Google consent, testing, Workspace-internal use, and public app distribution have different requirements. This project supplies no centrally verified OAuth application and makes no promise that a newly created client is immediately approved. Consult [Google's scope guide](https://developers.google.com/workspace/gmail/api/auth/scopes) and [restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) for your deployment.

The configured mailbox must match the authenticated account. Changing configuration does not rewrite old frozen messages or transfer approvals to another sender. Use a separate data directory for a different business; do not treat changing the email environment variable as a mailbox migration tool.

## Twilio

Set the account credentials, `HIVE_SMS_FROM`, `HIVE_SMS_TO`, positive per-notification and daily cost bounds, then explicitly enable notifications in Controls. Notification-only use does not need a webhook. Signed approve/deny replies additionally need a public HTTPS endpoint and Twilio webhook configuration. Account restrictions, sender registration, geographic requirements and campaign approval may apply. Do not reuse someone else's privacy policy or claim an opt-in flow exists before implementing it.

## Netlify

Provide a token for your own account, a site ID, enablement and explicit deployment/total bounds. This adapter uses a supplied token; it does not require every self-hosting user to publish a shared OAuth application. Prepared static releases freeze document versions before owner approval. Unknown costs and uncertain creation remain unresolved until evidence supports reconciliation.

## Python workspace programs

Docker is optional for the application. The Python tool requires a Linux container engine and its pinned image. See `packages/runtime/src/sandbox.ts` for the exact image and resource limits. The runtime does not automatically pull images. Pull the documented digest deliberately before enabling this capability. The sandbox copies bounded text inputs and outputs, provides no network or host mounts, and does not let agents edit the platform source.
