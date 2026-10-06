-- Legacy domain tables originally used user_id without referencing users.
-- NOT VALID preserves old placeholder/orphan rows, while enforcing ownership
-- for new writes and preventing in-flight work from recreating erased data.
DO $$
DECLARE
    scoped_table RECORD;
BEGIN
    FOR scoped_table IN
        SELECT t.oid, t.relname, a.attnum
        FROM pg_class t
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid
        WHERE n.nspname = 'public' AND t.relkind = 'r'
          AND a.attname = 'user_id' AND NOT a.attisdropped
          AND NOT EXISTS (
              SELECT 1 FROM pg_constraint c
              WHERE c.contype = 'f' AND c.conrelid = t.oid
                AND c.confrelid = 'public.users'::regclass
                AND c.conkey = ARRAY[a.attnum]::smallint[]
          )
    LOOP
        EXECUTE format(
            'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE ON UPDATE CASCADE NOT VALID',
            scoped_table.relname, scoped_table.relname || '_account_lifetime_fkey'
        );
    END LOOP;
END $$;
