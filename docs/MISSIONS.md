# Missions

Busywork uses one organization runtime. Research, outreach, content and business work differ through mission templates and capabilities, not separate execution modes.

## Set up and start

The first Overview asks what the team should work on. Choose Research brief, Outreach campaign, Market or competitor scan, Content production, Run a business, or Custom. Edit the objective, observable completion conditions, boundaries, deliverable, total spending cap and optional deadline. Templates seed departments; the CEO can propose additional departments for owner approval within headcount limits.

Finite missions require document capability for their durable completion deliverable. Ongoing missions may leave completion conditions empty. A blank mission budget means no additional mission cap; zero means no further execution capacity, not unlimited spending. Provider, daily and lifetime controls remain independent.

Creation does not start agents. Configure a usable worker in Models and the CEO assignment in Controls, review approval settings, then start the team. The owner defines the desired outcome and authority; the CEO decides strategy and staffing. Missing search or other integrations should be recorded as dependencies, never disguised as completed work.

Only one mission may be ACTIVE or COMPLETING. Stop or complete it, pause the team, then activate another draft. Historical staff and shared reference material remain available, while task, direction, communication and cost records retain mission attribution. Use new document paths for new missions to preserve prior deliverables.

## Progress and completion

Overview shows the active objective, acceptance conditions, settled spend, unresolved reservations and owner requests. Recorded activity is evidence of work, not a percentage estimate of success. Directions report tasks, sources, documents and cost for the current mission; commercial metrics appear only with commerce enabled.

The CEO uses `COMPLETE_MISSION` after saving the deliverable as a versioned document. Every completion condition must cite existing mission evidence: a document version, completed task, executed action receipt or fetched source record. The submission hashes the mission revision, conditions, evidence and exact deliverable version. Work pauses in COMPLETING until the owner reviews and confirms or returns it to active work. Generic request responses cannot bypass this decision.

A configurable number of CEO cycles without new recorded task results, document versions, sources or non-model approvals pauses a finite mission and raises an owner request. The CEO's own repeated cycle completions do not count as progress. Ongoing missions keep their interval behavior. Budget and deadline pauses use the same visible mission status; review and resume can adjust limits without releasing uncertain holds.

Stopping cancels unfinished mission tasks but does not delete records, refund charges or recall dispatched actions. Active dispatch must finish before a mission can be stopped. The Missions page retains final recorded spend and submitted deliverable versions. Unresolved exposure remains visible rather than being declared zero.

## Capabilities and evidence

Families: organization/communication, documents/workspaces, research/web, email/outreach, commerce/orders, accounting, code execution, and releases/deployment. Disabled operations are absent from the requested model schema and instructions, and rejected at execution. Some actions need multiple families, such as email attachments needing documents. Tool installation, employee permissions, exact approvals and spending checks still apply.

`SEARCH_WEB` currently supports Brave through a provider interface. Configure `HIVE_SEARCH_PROVIDER`, `BRAVE_SEARCH_API_KEY`, and `HIVE_SEARCH_COST_USD`; an explicit zero price is allowed for a free allowance. Search results are untrusted discovery snippets. Read a source URL through the existing gateway before citing its page contents.

Confirmed retrieval stores a source ID, originating action/task, URL, retrieval time, retained text, SHA-256 hash and truncation marker. Document versions accept structured claims with source IDs. OBSERVATION requires a recorded source; uncited claims are INFERENCE or HYPOTHESIS. The viewer flags uncited or unassessed content. Neither a source receipt nor a citation proves a claim is true. Include source IDs in report text to retain them in plain-text exports.

## Outreach

In Email, open Campaign approvals. The owner or an agent can propose an exact template, explicit recipient list, send cap and time window. Approval freezes these under a hash; changes require a new proposal. V1 has no dynamic recipient selection or template substitutions. Agent-supplied addresses need a fetched-page source containing the exact address; never guess or scrape personal addresses. Address provenance alone is not permission to contact someone.

Approved campaigns allow one exact message per listed recipient, with no cc/bcc, reply routing or attachments under campaign authority. A message outside these bounds needs its own exact approval, even if routine communication approval is disabled. A slot is consumed before dispatch and remains consumed for uncertain or failed sends. Revocation prevents subsequent campaign-authorized dispatch. Normal employee permissions, mailbox limits, mission admission and recipient restrictions apply to every send.

New email proposals include a frozen sender identity and opt-out line. Explicit STOP/unsubscribe replies add the sender to the do-not-contact list during ingestion. The owner can record other opt-outs in the same Email panel. Every To/Cc/Bcc address is checked again immediately before dispatch, including on previously approved messages. Ambiguous replies need review; automatic re-subscription is deliberately unsupported.

## Compatibility

Existing installations are backfilled into one ongoing Run a business mission using their mandate, with all prior capabilities and no new total mission cap. Audit rows are attributed without updating or deleting their existing contents. Migration runs when the installation next opens its database; back up the private instance first. This development work does not itself restart or migrate that instance.

The separate website simulator is downstream of this application. Coordinate its snapshot and UI sync separately; it is not modified by mission development.
