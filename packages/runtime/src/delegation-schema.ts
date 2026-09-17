export const migration18=`
CREATE FUNCTION bound_delegation() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF money+NEW.budget>source.budget OR tokens+NEW.token_budget>source.token_budget THEN
  RAISE EXCEPTION 'Delegated allocation exceeds parent remaining money or tokens';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bounded_delegation BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION bound_delegation();
CREATE TRIGGER bounded_meeting BEFORE INSERT ON meetings FOR EACH ROW EXECUTE FUNCTION bound_delegation();
`;
