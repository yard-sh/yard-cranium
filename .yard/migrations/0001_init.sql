-- Cranium schema. Every statement is idempotent: migration files are not
-- transactional, so a mid-file failure leaves earlier statements applied and
-- the file unrecorded in _yard_migrations, which re-runs it from the top on
-- the next deploy. IF NOT EXISTS makes that re-run harmless.
--
-- Document text is not here. Each document's content lives inside its
-- object as a log of CRDT updates, next to the live connections; the
-- database only knows who belongs where, which documents exist, and a
-- title and preview the object writes back now and then.
--
-- Times are milliseconds since the epoch, written by the service.

-- One row per person who has opened the app.
CREATE TABLE IF NOT EXISTS users (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  email   TEXT NOT NULL DEFAULT '',
  seen_at INTEGER NOT NULL DEFAULT 0
);

-- personal = 1 marks the workspace everyone gets on their first visit. The
-- partial unique index makes creating it race-proof: two first requests at
-- once both INSERT OR IGNORE, and only one row survives.
CREATE TABLE IF NOT EXISTS workspaces (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  personal     INTEGER NOT NULL DEFAULT 0,
  invite_token TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_personal ON workspaces (owner_id) WHERE personal = 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_invite ON workspaces (invite_token);

-- role is 'owner' or 'member'. The owner is listed here too, so "who is in
-- this workspace" is one table.
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member',
  joined_at    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_members_user ON workspace_members (user_id);

CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  author_id    TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  preview      TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0,
  updated_by   TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents (workspace_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_documents_created ON documents (workspace_id, created_at);

-- One row per (document, person), refreshed each time they open it. ticket
-- is a one-use pass for the next WebSocket upgrade; opened_at is how a
-- removal finds the documents someone may still have open (a connection
-- never outlives 24 hours).
CREATE TABLE IF NOT EXISTS doc_sessions (
  doc_id         TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  ticket         TEXT,
  ticket_expires INTEGER NOT NULL DEFAULT 0,
  opened_at      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (doc_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON doc_sessions (user_id, opened_at);
