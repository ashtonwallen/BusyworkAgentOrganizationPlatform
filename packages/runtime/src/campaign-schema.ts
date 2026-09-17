export const migration20=`
CREATE TABLE outreach_campaigns(id TEXT PRIMARY KEY,mission_id TEXT REFERENCES missions(id),task_id TEXT REFERENCES tasks(id),author_id TEXT NOT NULL,
 definition JSONB NOT NULL,approval_hash TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TRIGGER campaign_mission BEFORE INSERT ON outreach_campaigns FOR EACH ROW EXECUTE FUNCTION attribute_mission_work();
CREATE TABLE campaign_decisions(sequence BIGSERIAL UNIQUE,id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES outreach_campaigns(id),approval_hash TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('APPROVE','REJECT','REVOKE')),created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE campaign_sends(message_id TEXT PRIMARY KEY REFERENCES email_messages(id),campaign_id TEXT NOT NULL REFERENCES outreach_campaigns(id),
 recipient TEXT NOT NULL,approval_hash TEXT NOT NULL,reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(campaign_id,recipient));
CREATE TABLE do_not_contact(address TEXT PRIMARY KEY,reason TEXT NOT NULL,source_message_id TEXT REFERENCES email_messages(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TRIGGER immutable_campaigns BEFORE UPDATE OR DELETE OR TRUNCATE ON outreach_campaigns FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER immutable_campaign_decisions BEFORE UPDATE OR DELETE OR TRUNCATE ON campaign_decisions FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER immutable_campaign_sends BEFORE UPDATE OR DELETE OR TRUNCATE ON campaign_sends FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER immutable_optouts BEFORE UPDATE OR DELETE OR TRUNCATE ON do_not_contact FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
`;
