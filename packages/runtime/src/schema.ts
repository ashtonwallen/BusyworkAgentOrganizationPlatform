export const migration1 = `
CREATE TABLE company (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  status TEXT NOT NULL DEFAULT 'PAUSED' CHECK(status IN ('RUNNING','PAUSED','KILLED')),
  daily_cap BIGINT NOT NULL CHECK(daily_cap >= 0),
  live_cap BIGINT NOT NULL DEFAULT 0 CHECK(live_cap >= 0),
  capital_allocation BIGINT NOT NULL DEFAULT 200000000 CHECK(capital_allocation >= 0),
  max_depth INTEGER NOT NULL DEFAULT 6 CHECK(max_depth BETWEEN 0 AND 6),
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, parent_id TEXT REFERENCES tasks(id), root_id TEXT NOT NULL,
  objective TEXT NOT NULL, role TEXT NOT NULL, depth INTEGER NOT NULL CHECK(depth BETWEEN 0 AND 6),
  status TEXT NOT NULL CHECK(status IN ('PLAN_PENDING','READY','RUNNING','REVIEW','COMPLETED','BLOCKED_BUDGET','BLOCKED_APPROVAL','FAILED','EXPIRED','CANCELLED')),
  phase TEXT NOT NULL DEFAULT 'PLAN' CHECK(phase IN ('PLAN','WORK','REVIEW')),
  budget BIGINT NOT NULL CHECK(budget >= 0), token_budget INTEGER NOT NULL CHECK(token_budget > 0),
  expires_at TIMESTAMPTZ NOT NULL, model_id TEXT NOT NULL, review_model_id TEXT NOT NULL,
  plan JSONB, artifact JSONB, review JSONB, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE calls (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), phase TEXT NOT NULL,
  attempt INTEGER NOT NULL, model_id TEXT NOT NULL, provider TEXT NOT NULL, is_live BOOLEAN NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('RESERVED','DISPATCHED','SUCCEEDED','FAILED','UNCERTAIN','RECONCILED')),
  reserved BIGINT NOT NULL CHECK(reserved >= 0), settled BIGINT CHECK(settled >= 0),
  token_reserved INTEGER NOT NULL CHECK(token_reserved >= 0), input_tokens INTEGER, output_tokens INTEGER,
  request_id TEXT, usage JSONB, result JSONB, error TEXT,
  budget_day DATE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ,
  UNIQUE(task_id, phase, attempt)
);
CREATE TABLE experiments (
  id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('DRAFT','VALIDATING','DELIVERING','REPEATING','KILLED','ARCHIVED')),
  hypothesis TEXT NOT NULL, customer TEXT NOT NULL, offer TEXT NOT NULL, channel TEXT NOT NULL,
  price TEXT NOT NULL, max_loss BIGINT NOT NULL CHECK(max_loss >= 0), success_criteria TEXT NOT NULL,
  kill_criteria TEXT NOT NULL, deadline TIMESTAMPTZ NOT NULL, evidence JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE grants (
  id TEXT PRIMARY KEY, action_type TEXT NOT NULL, target TEXT NOT NULL, experiment_id TEXT REFERENCES experiments(id),
  max_transaction BIGINT NOT NULL CHECK(max_transaction >= 0), total_cap BIGINT NOT NULL CHECK(total_cap >= 0),
  expires_at TIMESTAMPTZ NOT NULL, revoked BOOLEAN NOT NULL DEFAULT false,
  rationale TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE actions (
  id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), experiment_id TEXT REFERENCES experiments(id),
  action_type TEXT NOT NULL, target TEXT NOT NULL, payload JSONB NOT NULL, rationale TEXT NOT NULL,
  max_cost BIGINT NOT NULL CHECK(max_cost >= 0), expires_at TIMESTAMPTZ NOT NULL,
  action_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED','EXECUTING','EXECUTED','UNCERTAIN','CANCELLED','EXPIRED')),
  grant_id TEXT REFERENCES grants(id), reservation BIGINT NOT NULL DEFAULT 0 CHECK(reservation >= 0),
  settled BIGINT CHECK(settled >= 0), result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES actions(id), action_hash TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('APPROVE','REJECT')), rationale TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(action_id)
);
CREATE TABLE ledger (
  id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, account TEXT NOT NULL CHECK(account IN ('OPERATING','BUSINESS','TEST')),
  kind TEXT NOT NULL CHECK(kind IN ('COST','REVENUE','REFUND','FUNDING')),
  amount BIGINT NOT NULL CHECK(amount >= 0), task_id TEXT REFERENCES tasks(id),
  experiment_id TEXT REFERENCES experiments(id), call_id TEXT REFERENCES calls(id), action_id TEXT REFERENCES actions(id),
  description TEXT NOT NULL, external_reference TEXT, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE owner_requests (
  id TEXT PRIMARY KEY, experiment_id TEXT REFERENCES experiments(id), title TEXT NOT NULL,
  details TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','DONE','DECLINED')),
  response TEXT, minutes INTEGER NOT NULL DEFAULT 0 CHECK(minutes >= 0), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE events (
  sequence BIGSERIAL PRIMARY KEY, type TEXT NOT NULL, entity_id TEXT,
  actor TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION forbid_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit records are append-only'; END; $$;
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE OR TRUNCATE ON events FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE OR TRUNCATE ON ledger FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER immutable_approvals BEFORE UPDATE OR DELETE OR TRUNCATE ON approvals FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
CREATE INDEX tasks_status ON tasks(status, created_at);
CREATE INDEX calls_budget ON calls(budget_day, status);
CREATE INDEX ledger_experiment ON ledger(experiment_id, occurred_at);
CREATE INDEX actions_status ON actions(status);
`;

export const migration2 = `
ALTER TABLE company DROP CONSTRAINT company_max_depth_check;
ALTER TABLE company ADD CONSTRAINT company_max_depth_check CHECK(max_depth BETWEEN 0 AND 64);
ALTER TABLE tasks DROP CONSTRAINT tasks_depth_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_depth_check CHECK(depth BETWEEN 0 AND 64);
ALTER TABLE company ADD COLUMN max_agents INTEGER NOT NULL DEFAULT 8 CHECK(max_agents BETWEEN 1 AND 1000);
ALTER TABLE company ADD COLUMN max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK(max_concurrency BETWEEN 1 AND 32);
ALTER TABLE company ADD COLUMN mandate TEXT NOT NULL DEFAULT 'Build a legitimate, profitable micro-business. Find a reachable buyer and a small credible test. Hire and collaborate when useful. All expenses and external actions require owner approval initially.';
ALTER TABLE company ADD COLUMN approval_policy JSONB NOT NULL DEFAULT '{"expenses":true,"modelCalls":true,"communications":true,"publishing":true,"accounts":true,"smsEnabled":false}';
ALTER TABLE company ADD COLUMN ceo_model_id TEXT NOT NULL DEFAULT 'local-qwen';
ALTER TABLE company ADD COLUMN ceo_review_model_id TEXT NOT NULL DEFAULT 'local-qwen';
ALTER TABLE company ADD COLUMN cycle_budget BIGINT NOT NULL DEFAULT 1000000 CHECK(cycle_budget>=0);
ALTER TABLE company ADD COLUMN cycle_tokens INTEGER NOT NULL DEFAULT 100000 CHECK(cycle_tokens>0);
ALTER TABLE company ADD COLUMN cycle_interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK(cycle_interval_minutes>=1);
CREATE TABLE departments(id TEXT PRIMARY KEY,name TEXT NOT NULL,purpose TEXT NOT NULL);
INSERT INTO departments VALUES
 ('executive','Executive','Strategy, priorities, and capital allocation'),
 ('research','Research','Find actionable market evidence and testable offers'),
 ('build','Build','Create useful products and fulfillment systems'),
 ('sales','Sales & growth','Reach buyers through authorized channels'),
 ('operations','Operations','Delivery, quality, costs, and customer outcomes'),
 ('compliance','Compliance','Find workable, authorized operating paths');
CREATE TABLE employees(
 id TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL,department_id TEXT NOT NULL REFERENCES departments(id),
 manager_id TEXT REFERENCES employees(id),depth INTEGER NOT NULL CHECK(depth>=0),charter TEXT NOT NULL,
 model_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','PAUSED','RETIRED')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX only_one_ceo ON employees(role) WHERE role='CEO' AND status='ACTIVE';
ALTER TABLE tasks ADD COLUMN employee_id TEXT REFERENCES employees(id);
ALTER TABLE tasks ADD COLUMN operations_applied BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE calls ADD COLUMN approval_action_id TEXT REFERENCES actions(id);
CREATE TABLE messages(
 id TEXT PRIMARY KEY,sender_id TEXT NOT NULL,recipient_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('MESSAGE','ESCALATION','REQUEST','DECISION')),
 subject TEXT NOT NULL,body TEXT NOT NULL,task_id TEXT REFERENCES tasks(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE meetings(
 id TEXT PRIMARY KEY,title TEXT NOT NULL,objective TEXT NOT NULL,organizer_id TEXT NOT NULL,
 participants JSONB NOT NULL,scheduled_at TIMESTAMPTZ NOT NULL,budget BIGINT NOT NULL CHECK(budget>=0),
 status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK(status IN ('SCHEDULED','RUNNING','COMPLETED','CANCELLED')),
 task_id TEXT REFERENCES tasks(id),decisions JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE operations(
 id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),operation_index INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('APPLIED','BLOCKED')),result JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(task_id,operation_index)
);
CREATE TABLE notifications(
 id TEXT PRIMARY KEY,action_id TEXT REFERENCES actions(id),request_id TEXT REFERENCES owner_requests(id),
 code TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DISPATCHED','SENT','FAILED','UNCERTAIN','DISABLED')),
 provider_id TEXT,error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),sent_at TIMESTAMPTZ,
 CHECK ((action_id IS NOT NULL)::integer+(request_id IS NOT NULL)::integer=1)
);
CREATE UNIQUE INDEX notification_action_once ON notifications(action_id) WHERE action_id IS NOT NULL;
CREATE TABLE sms_replies(provider_id TEXT PRIMARY KEY,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
`;

export const migration3 = `
ALTER TABLE notifications ADD COLUMN reserved BIGINT NOT NULL DEFAULT 0 CHECK(reserved>=0);
ALTER TABLE notifications ADD COLUMN settled BIGINT CHECK(settled>=0);
ALTER TABLE notifications ADD COLUMN budget_day DATE NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE ledger ADD COLUMN notification_id TEXT REFERENCES notifications(id);
ALTER TABLE calls ADD COLUMN pricing JSONB;
ALTER TABLE meetings ADD COLUMN source_task_id TEXT REFERENCES tasks(id);
ALTER TABLE meetings ADD COLUMN token_budget INTEGER NOT NULL DEFAULT 180000 CHECK(token_budget>0);
ALTER TABLE tasks ADD COLUMN meeting_id TEXT REFERENCES meetings(id);
ALTER TABLE tasks ADD COLUMN meeting_phase TEXT CHECK(meeting_phase IN ('CONTRIBUTION','SUMMARY'));
CREATE FUNCTION immutable_action_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.task_id,NEW.experiment_id,NEW.action_type,NEW.target,NEW.payload,NEW.rationale,NEW.max_cost,NEW.expires_at,NEW.action_hash)
 IS DISTINCT FROM ROW(OLD.task_id,OLD.experiment_id,OLD.action_type,OLD.target,OLD.payload,OLD.rationale,OLD.max_cost,OLD.expires_at,OLD.action_hash)
 THEN RAISE EXCEPTION 'Action proposal is immutable; submit a new proposal'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER immutable_action_fields BEFORE UPDATE ON actions FOR EACH ROW EXECUTE FUNCTION immutable_action_proposal();
`;

export const migration4 = `
ALTER TABLE company ALTER COLUMN approval_policy SET DEFAULT '{"expenses":true,"modelCalls":true,"communications":true,"publishing":true,"accounts":true,"research":true,"otherExternal":true,"smsEnabled":false}';
UPDATE company SET approval_policy='{"research":true,"otherExternal":true}'::jsonb || approval_policy;
CREATE TABLE task_artifacts(
 id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),call_id TEXT NOT NULL REFERENCES calls(id),
 filename TEXT NOT NULL,media_type TEXT NOT NULL,content TEXT NOT NULL,sha256 TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(call_id,filename)
);
CREATE TRIGGER immutable_artifacts BEFORE UPDATE OR DELETE OR TRUNCATE ON task_artifacts FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
`;

export const migration5 = `
CREATE TABLE directions(
 id TEXT PRIMARY KEY,headline TEXT NOT NULL,statement TEXT NOT NULL,
 set_by TEXT NOT NULL,set_by_role TEXT NOT NULL,task_id TEXT REFERENCES tasks(id),
 superseded_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_current_direction ON directions((1)) WHERE superseded_at IS NULL;
CREATE INDEX directions_history ON directions(created_at DESC);
`;

export const migration6 = `
ALTER TABLE tasks ADD COLUMN finished_at TIMESTAMPTZ;
UPDATE tasks SET finished_at=updated_at WHERE status IN ('COMPLETED','FAILED','EXPIRED','CANCELLED');
CREATE FUNCTION touch_task_timestamps() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.updated_at=now();
 -- finished_at records when work actually reached a terminal state, so later
 -- bookkeeping updates to the same row cannot make old work look recent.
 IF NEW.status IN ('COMPLETED','FAILED','EXPIRED','CANCELLED') AND NEW.finished_at IS NULL THEN
  NEW.finished_at=now();
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER tasks_touch_timestamps BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION touch_task_timestamps();
CREATE INDEX tasks_finished ON tasks(finished_at);
`;

export const migration7=`
ALTER TABLE employees ADD COLUMN candidate_id TEXT;
ALTER TABLE employees ADD COLUMN bio TEXT;
ALTER TABLE employees ADD COLUMN traits JSONB;
CREATE UNIQUE INDEX employee_candidate_once ON employees(candidate_id) WHERE candidate_id IS NOT NULL;
`;

export const migration8=`
CREATE TABLE company_records(
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('ASSET','ACCOUNT','CONSTRAINT','NOTE')),
 title TEXT NOT NULL, body TEXT NOT NULL,
 archived BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX company_records_active ON company_records(archived, kind);
`;


// Reviewer fields remain readable for historical records; new assignments have no hidden reviewer.
export const migration9=`
ALTER TABLE tasks ALTER COLUMN review_model_id DROP NOT NULL;
ALTER TABLE company ALTER COLUMN ceo_review_model_id DROP NOT NULL;
ALTER TABLE company ALTER COLUMN ceo_review_model_id DROP DEFAULT;
UPDATE company SET ceo_review_model_id=NULL;
`;

export const migration10=`
CREATE TABLE documents (
 id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0), updated_by TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE document_versions (
 document_id TEXT NOT NULL REFERENCES documents(id), version INTEGER NOT NULL,
 content TEXT NOT NULL, title TEXT NOT NULL, author_id TEXT NOT NULL, task_id TEXT REFERENCES tasks(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(document_id,version)
);
CREATE FUNCTION immutable_document_version() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'Document versions are immutable'; END; $$;
CREATE TRIGGER document_versions_immutable BEFORE UPDATE OR DELETE ON document_versions
 FOR EACH ROW EXECUTE FUNCTION immutable_document_version();
`;

export const migration11=`
CREATE TABLE static_releases (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider='netlify'),
 site_id TEXT NOT NULL, manifest JSONB NOT NULL, content_hash TEXT NOT NULL,
 source_versions JSONB NOT NULL, request_hash TEXT NOT NULL, author_id TEXT NOT NULL,
 task_id TEXT REFERENCES tasks(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION immutable_static_release() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'Static releases are immutable'; END; $$;
CREATE TRIGGER static_releases_immutable BEFORE UPDATE OR DELETE ON static_releases
 FOR EACH ROW EXECUTE FUNCTION immutable_static_release();
`;

export const migration12=`
CREATE TABLE deployments (
 action_id TEXT PRIMARY KEY REFERENCES actions(id),
 release_id TEXT NOT NULL REFERENCES static_releases(id),
 site_id TEXT NOT NULL, content_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('CREATING','UNCERTAIN','ACTIVE','READY','FAILED')),
 provider_id TEXT, provider_state JSONB, error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK((status IN ('CREATING','UNCERTAIN') AND provider_id IS NULL) OR
       (status IN ('ACTIVE','READY','FAILED') AND provider_id IS NOT NULL)),
 UNIQUE(site_id,provider_id)
);
CREATE FUNCTION preserve_deployment_identity() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Deployment records cannot be deleted'; END IF;
 IF NEW.action_id<>OLD.action_id OR NEW.release_id<>OLD.release_id OR
 NEW.site_id<>OLD.site_id OR NEW.content_hash<>OLD.content_hash OR
 (OLD.provider_id IS NOT NULL AND NEW.provider_id IS DISTINCT FROM OLD.provider_id)
 THEN RAISE EXCEPTION 'Deployment identity is immutable'; END IF;
 RETURN NEW;
 END; $$;
CREATE TRIGGER deployments_identity BEFORE UPDATE OR DELETE ON deployments
 FOR EACH ROW EXECUTE FUNCTION preserve_deployment_identity();
`;

export const migration13=`
ALTER TABLE actions DROP CONSTRAINT actions_status_check;
ALTER TABLE actions ADD CONSTRAINT actions_status_check CHECK(status IN
 ('PENDING','APPROVED','REJECTED','EXECUTING','EXECUTED','UNCERTAIN','CANCELLED','EXPIRED','FAILED'));
`;

export const migration14=`
ALTER TABLE actions DROP CONSTRAINT actions_status_check;
ALTER TABLE actions ADD CONSTRAINT actions_status_check CHECK(status IN
 ('PENDING','APPROVED','REJECTED','EXECUTING','EXECUTED','UNCERTAIN','CANCELLED','EXPIRED','FAILED','AWAITING_COST'));
UPDATE actions SET status='AWAITING_COST' WHERE status='EXECUTING' AND settled IS NULL
 AND EXISTS(SELECT 1 FROM deployments d WHERE d.action_id=actions.id AND d.status IN ('READY','FAILED'));
`;

export const migration15=`
CREATE TABLE email_mailboxes (
 address TEXT PRIMARY KEY, provider TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT false,
 credential_ciphertext TEXT, sync_state JSONB NOT NULL DEFAULT '{}',last_synced_at TIMESTAMPTZ,error TEXT,
 daily_send_limit INTEGER NOT NULL DEFAULT 100 CHECK(daily_send_limit BETWEEN 1 AND 2000)
);
CREATE TABLE email_permissions(employee_id TEXT PRIMARY KEY REFERENCES employees(id),can_read BOOLEAN NOT NULL DEFAULT false,can_send BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE email_messages (
 id TEXT PRIMARY KEY,mailbox TEXT NOT NULL REFERENCES email_mailboxes(address),direction TEXT NOT NULL CHECK(direction IN ('INBOUND','OUTBOUND')),
 status TEXT NOT NULL CHECK(status IN ('QUEUED','DISPATCHING','SENT','UNCERTAIN','FAILED','RECEIVED')),
 provider_message_id TEXT,thread_id TEXT,rfc_message_id TEXT,content JSONB NOT NULL,draft JSONB,raw_mime TEXT,
 action_id TEXT UNIQUE REFERENCES actions(id),author_id TEXT,received_at TIMESTAMPTZ,dispatched_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),error TEXT,UNIQUE(mailbox,provider_message_id)
);
CREATE FUNCTION immutable_email_draft() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF OLD.raw_mime IS NOT NULL AND (NEW.raw_mime IS DISTINCT FROM OLD.raw_mime OR NEW.draft IS DISTINCT FROM OLD.draft OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.action_id IS DISTINCT FROM OLD.action_id OR NEW.rfc_message_id IS DISTINCT FROM OLD.rfc_message_id OR NEW.mailbox<>OLD.mailbox)
 THEN RAISE EXCEPTION 'Outbound email draft is immutable'; END IF;
 IF OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id THEN RAISE EXCEPTION 'Email provider identity is immutable'; END IF;
 RETURN NEW;
 END; $$;
CREATE TRIGGER email_draft_immutable BEFORE UPDATE ON email_messages FOR EACH ROW EXECUTE FUNCTION immutable_email_draft();
CREATE INDEX email_thread ON email_messages(mailbox,thread_id);
CREATE INDEX email_rfc_id ON email_messages(mailbox,rfc_message_id);
CREATE TABLE email_entities(kind TEXT NOT NULL CHECK(kind IN ('CAMPAIGN','PROSPECT','CUSTOMER','PROJECT','EXPERIMENT')),id TEXT NOT NULL,label TEXT NOT NULL,addresses JSONB NOT NULL DEFAULT '[]',PRIMARY KEY(kind,id));
CREATE TABLE email_links(message_id TEXT NOT NULL REFERENCES email_messages(id),kind TEXT NOT NULL,entity_id TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN ('EXPLICIT','THREAD','REFERENCE','ADDRESS')),PRIMARY KEY(message_id,kind,entity_id));
`;

export const migration16=`
CREATE TABLE proposal_revisions (
 action_id TEXT PRIMARY KEY REFERENCES actions(id),
 task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
 feedback TEXT NOT NULL,
 action_hash TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE actions ADD COLUMN revises_action_id TEXT REFERENCES actions(id);
CREATE FUNCTION bind_proposal_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.action_type <> 'MODEL_CALL' AND NEW.task_id IS NOT NULL THEN
  WITH RECURSIVE lineage AS (
   SELECT id,parent_id FROM tasks WHERE id=NEW.task_id
   UNION ALL SELECT t.id,t.parent_id FROM tasks t JOIN lineage l ON t.id=l.parent_id
  ) SELECT r.action_id INTO NEW.revises_action_id FROM proposal_revisions r JOIN lineage l ON l.id=r.task_id LIMIT 1;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bind_proposal_revision BEFORE INSERT ON actions FOR EACH ROW EXECUTE FUNCTION bind_proposal_revision();
CREATE FUNCTION guard_proposal_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.revises_action_id IS NOT NULL AND NEW.status IN ('EXECUTING','EXECUTED') AND OLD.status IS DISTINCT FROM NEW.status
 AND NOT EXISTS(SELECT 1 FROM approvals WHERE action_id=NEW.id AND action_hash=NEW.action_hash AND decision='APPROVE') THEN
  RAISE EXCEPTION 'Revised proposals require fresh owner approval.';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_proposal_revision BEFORE UPDATE ON actions FOR EACH ROW EXECUTE FUNCTION guard_proposal_revision();
`;
