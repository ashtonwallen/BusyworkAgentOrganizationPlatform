// Global company events belong to the current mission; linked work keeps its source mission.
export const migration21=`
CREATE OR REPLACE FUNCTION attribute_mission_work() RETURNS trigger LANGUAGE plpgsql AS $$
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
  SELECT mission_id INTO linked FROM tasks WHERE id=COALESCE(data->'payload'->>'taskId',data->'payload'->>'sourceTaskId',data->>'entity_id');
  inherited=COALESCE(inherited,linked);
  IF inherited IS NULL THEN
   SELECT id INTO inherited FROM missions WHERE id=COALESCE(data->'payload'->>'missionId',data->>'entity_id');
  END IF;
  IF inherited IS NULL AND data->>'entity_id'<>'company' THEN
   SELECT mission_id INTO inherited FROM events WHERE entity_id=data->>'entity_id' AND mission_id IS NOT NULL ORDER BY sequence LIMIT 1;
  END IF;
 END IF;
 IF inherited IS NOT NULL AND NEW.mission_id IS NOT NULL AND inherited<>NEW.mission_id THEN
  RAISE EXCEPTION 'Work cannot change its source mission';
 END IF;
 NEW.mission_id=COALESCE(inherited,NEW.mission_id,current_mission_id());
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION bound_delegation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source tasks%ROWTYPE; money bigint; tokens bigint; parent text;
BEGIN
 IF TG_TABLE_NAME='tasks' THEN
  parent=NEW.parent_id;
  IF NEW.meeting_id IS NOT NULL THEN RETURN NEW; END IF;
 ELSE parent=NEW.source_task_id;
 END IF;
 IF parent IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO source FROM tasks WHERE id=parent FOR UPDATE;
 SELECT COALESCE(sum(budget),0),COALESCE(sum(token_budget),0) INTO money,tokens FROM tasks WHERE parent_id=parent AND meeting_id IS NULL;
 SELECT money+COALESCE(sum(budget),0),tokens+COALESCE(sum(token_budget),0) INTO money,tokens FROM meetings WHERE source_task_id=parent AND status<>'CANCELLED';
 SELECT money+COALESCE(sum(COALESCE(settled,0)+CASE WHEN status IN ('RESERVED','DISPATCHED','UNCERTAIN') THEN reserved ELSE 0 END),0),
 tokens+COALESCE(sum(CASE WHEN status IN ('RESERVED','DISPATCHED','UNCERTAIN') OR (status='RECONCILED' AND (input_tokens IS NULL OR output_tokens IS NULL)) THEN token_reserved ELSE COALESCE(input_tokens,0)+COALESCE(output_tokens,0) END),0)
 INTO money,tokens FROM calls WHERE task_id=parent;
 SELECT money+(SELECT COALESCE(sum(amount),0) FROM ledger WHERE task_id=parent AND call_id IS NULL AND account<>'TEST' AND kind='COST')+
 (SELECT COALESCE(sum(reservation),0) FROM actions WHERE task_id=parent AND action_type<>'MODEL_CALL') INTO money;
 IF money+NEW.budget>source.budget OR tokens+NEW.token_budget>source.token_budget THEN
  RAISE EXCEPTION 'Delegated allocation exceeds parent remaining money or tokens';
 END IF;
 RETURN NEW;
END $$;
`;
