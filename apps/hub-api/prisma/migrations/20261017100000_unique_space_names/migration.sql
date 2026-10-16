DO $$
DECLARE item RECORD; current_account TEXT := NULL; used_names TEXT[] := ARRAY[]::TEXT[]; base TEXT; candidate TEXT; candidate_key TEXT; suffix INTEGER;
BEGIN
  FOR item IN SELECT id, owner_id, name, space_name, COALESCE(owner_id,id) AS account_id FROM users ORDER BY COALESCE(owner_id,id), owner_id NULLS FIRST, created_at, id LOOP
    IF current_account IS DISTINCT FROM item.account_id THEN current_account := item.account_id; used_names := ARRAY[]::TEXT[]; END IF;
    base := COALESCE(NULLIF(btrim(item.space_name),''), CASE WHEN item.owner_id IS NULL THEN CASE WHEN btrim(item.name) = '' OR split_part(btrim(item.name),' ',1) LIKE '%@%' THEN 'My space' ELSE split_part(btrim(item.name),' ',1) || '''s space' END ELSE 'Untitled space' END);
    candidate := base; suffix := 1;
    LOOP
      candidate_key := lower(normalize(regexp_replace(btrim(candidate),'\s+',' ','g'),NFKC));
      EXIT WHEN NOT(candidate_key = ANY(used_names));
      suffix := suffix + 1; candidate := left(base, 75-length(suffix::TEXT)) || ' (' || suffix::TEXT || ')';
    END LOOP;
    used_names := array_append(used_names,candidate_key);
    IF item.space_name IS DISTINCT FROM candidate THEN UPDATE users SET space_name = candidate WHERE id = item.id; END IF;
  END LOOP;
END $$;
