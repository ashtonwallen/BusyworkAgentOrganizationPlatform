export const migration19=`
CREATE TABLE source_records (
 id TEXT PRIMARY KEY,action_id TEXT NOT NULL UNIQUE REFERENCES actions(id),task_id TEXT REFERENCES tasks(id),
 mission_id TEXT REFERENCES missions(id),url TEXT NOT NULL,retrieved_at TIMESTAMPTZ NOT NULL,
 content_hash TEXT NOT NULL,content TEXT NOT NULL,truncated BOOLEAN NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('PAGE','SEARCH_RESULTS')),
 trust TEXT NOT NULL DEFAULT 'UNTRUSTED_EXTERNAL_SOURCE'
);
CREATE INDEX source_records_mission ON source_records(mission_id,retrieved_at);
CREATE TRIGGER source_mission BEFORE INSERT ON source_records FOR EACH ROW EXECUTE FUNCTION attribute_mission_work();
CREATE TRIGGER immutable_sources BEFORE UPDATE OR DELETE OR TRUNCATE ON source_records FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
CREATE TABLE document_claims (
 document_id TEXT NOT NULL,version INTEGER NOT NULL,claim_index INTEGER NOT NULL,
 claim TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('OBSERVATION','INFERENCE','HYPOTHESIS')),
 PRIMARY KEY(document_id,version,claim_index),FOREIGN KEY(document_id,version) REFERENCES document_versions(document_id,version)
);
CREATE TABLE claim_sources (
 document_id TEXT NOT NULL,version INTEGER NOT NULL,claim_index INTEGER NOT NULL,
 source_id TEXT NOT NULL REFERENCES source_records(id),PRIMARY KEY(document_id,version,claim_index,source_id),
 FOREIGN KEY(document_id,version,claim_index) REFERENCES document_claims(document_id,version,claim_index)
);
CREATE TRIGGER immutable_claims BEFORE UPDATE OR DELETE OR TRUNCATE ON document_claims FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER immutable_citations BEFORE UPDATE OR DELETE OR TRUNCATE ON claim_sources FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
`;
