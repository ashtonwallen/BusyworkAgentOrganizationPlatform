// Additive migration: defaults attribute historical audit rows without UPDATEs or
// disabling append-only triggers. New inserts inherit their source's mission.
export const migration17 = `
CREATE TABLE missions (
 id TEXT PRIMARY KEY, template TEXT NOT NULL, title TEXT NOT NULL,
 objective TEXT NOT NULL, definition_of_done JSONB NOT NULL DEFAULT '[]',
 boundaries TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL CHECK(kind IN ('FINITE','ONGOING')),
 budget BIGINT CHECK(budget>=0), deadline TIMESTAMPTZ, capabilities JSONB NOT NULL,
 deliverable TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('DRAFT','ACTIVE','COMPLETING','COMPLETED','STOPPED')),
 pause_reason TEXT, stall_cycles INTEGER NOT NULL DEFAULT 5 CHECK(stall_cycles BETWEEN 1 AND 100),
 revision INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ,
 onboarding_completed BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX one_active_mission ON missions((1)) WHERE status IN ('ACTIVE','COMPLETING');
INSERT INTO missions(id,template,title,objective,boundaries,kind,capabilities,deliverable,status,onboarding_completed)
 SELECT 'legacy-business','business','Run a business',mandate,mandate,'ONGOING',
 '["core","documents","research","outreach","commerce","accounting","code","deployment"]',
 'An operating business with recorded payments, costs and delivery outcomes','ACTIVE',
 EXISTS(SELECT 1 FROM tasks) OR EXISTS(SELECT 1 FROM employees) OR EXISTS(SELECT 1 FROM company_records)
 FROM company WHERE id=1;
CREATE FUNCTION current_mission_id() RETURNS text LANGUAGE sql STABLE AS $$
 SELECT id FROM missions WHERE status IN ('ACTIVE','COMPLETING') LIMIT 1
$$;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['tasks','calls','experiments','grants','actions','approvals','ledger','owner_requests','events',
 'messages','meetings','operations','notifications','task_artifacts','directions','documents','document_versions',
 'static_releases','deployments','email_messages','proposal_revisions'] LOOP
  EXECUTE format('ALTER TABLE %I ADD COLUMN mission_id TEXT DEFAULT %L REFERENCES missions(id)',name,'legacy-business');
  EXECUTE format('ALTER TABLE %I ALTER COLUMN mission_id DROP DEFAULT',name);
  EXECUTE format('CREATE INDEX ON %I(mission_id)',name);
 END LOOP;
END $$;
CREATE FUNCTION attribute_mission_work() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data jsonb; inherited text; linked text; pair text[];
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.mission_id IS DISTINCT FROM OLD.mission_id THEN RAISE EXCEPTION 'Mission attribution is immutable'; END IF;
  RETURN NEW;
 END IF;
 data=to_jsonb(NEW);
 FOREACH pair SLICE 1 IN ARRAY ARRAY[
  ['parent_id','tasks'],['task_id','tasks'],['source_task_id','tasks'],['experiment_id','experiments'],
  ['action_id','actions'],['call_id','calls'],['document_id','documents'],['release_id','static_releases']
 ] LOOP
  IF data->>pair[1] IS NOT NULL THEN
   EXECUTE format('SELECT mission_id FROM %I WHERE id=$1',pair[2]) INTO linked USING data->>pair[1];
   IF linked IS NOT NULL THEN
    IF inherited IS NOT NULL AND linked<>inherited THEN RAISE EXCEPTION 'Work cannot link different missions'; END IF;
    inherited=linked;
   END IF;
  END IF;
 END LOOP;
 IF TG_TABLE_NAME='events' THEN
  SELECT mission_id INTO linked FROM tasks WHERE id=COALESCE(data->'payload'->>'taskId',data->>'entity_id');
  inherited=COALESCE(inherited,linked);
  IF inherited IS NULL THEN
   SELECT mission_id INTO inherited FROM events WHERE entity_id=data->>'entity_id' AND mission_id IS NOT NULL ORDER BY sequence LIMIT 1;
  END IF;
 END IF;
 IF inherited IS NOT NULL AND NEW.mission_id IS NOT NULL AND inherited<>NEW.mission_id THEN
  RAISE EXCEPTION 'Work cannot change its source mission';
 END IF;
 NEW.mission_id=COALESCE(inherited,NEW.mission_id,current_mission_id());
 RETURN NEW;
END $$;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['tasks','calls','experiments','grants','actions','approvals','ledger','owner_requests','events',
 'messages','meetings','operations','notifications','task_artifacts','directions','documents','document_versions',
 'static_releases','deployments','email_messages','proposal_revisions'] LOOP
  EXECUTE format('CREATE TRIGGER mission_attribution BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION attribute_mission_work()',name);
 END LOOP;
END $$;
DROP INDEX one_current_direction;
CREATE UNIQUE INDEX one_current_direction ON directions(mission_id) WHERE superseded_at IS NULL;
`;
