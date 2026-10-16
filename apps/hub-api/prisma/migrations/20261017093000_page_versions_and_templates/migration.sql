ALTER TABLE task_pages ADD COLUMN history_saved_at TIMESTAMP(3), ADD COLUMN editor_account_id TEXT;
CREATE TABLE page_revisions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL CONSTRAINT page_revisions_account_lifetime_fkey REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE, page_id TEXT NOT NULL REFERENCES task_pages(id) ON DELETE CASCADE ON UPDATE CASCADE,
 revision INTEGER NOT NULL, title TEXT NOT NULL, content JSONB, annotations JSONB NOT NULL DEFAULT '[]',
 author_account_id TEXT, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX page_revisions_user_id_page_id_created_at_idx ON page_revisions(user_id,page_id,created_at);
CREATE TABLE page_templates (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL CONSTRAINT page_templates_account_lifetime_fkey REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 profile TEXT NOT NULL, title TEXT NOT NULL, content JSONB NOT NULL,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX page_templates_user_id_profile_created_at_idx ON page_templates(user_id,profile,created_at);
