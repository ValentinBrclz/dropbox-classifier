-- dropbox-classifier: authoritative job registry.
-- Queue and Workflow history are NOT authoritative (24 h / 3 day retention on Free).
-- No document content is stored here; classification_json holds metadata only.

CREATE TABLE jobs (
  job_id               TEXT PRIMARY KEY,            -- 'j' + 24 hex of sha256(file_id|rev)
  dropbox_file_id      TEXT NOT NULL,
  dropbox_rev          TEXT NOT NULL,
  source_path          TEXT NOT NULL,               -- path_lower at discovery
  source_name          TEXT NOT NULL,
  size                 INTEGER,
  content_hash         TEXT,
  server_modified      TEXT,

  status               TEXT NOT NULL DEFAULT 'DISCOVERED'
    CHECK (status IN ('DISCOVERED','QUEUED','PROCESSING','CLASSIFIED',
                      'COMPLETED','REVIEW_REQUIRED','FAILED','DRY_RUN_DONE')),
  last_step            TEXT,                        -- last step that finished
  mode                 TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live','dry_run')),
  generation           INTEGER NOT NULL DEFAULT 0,  -- bumped by reprocess / stale recovery
  workflow_instance_id TEXT,

  -- transactional outbox
  dispatch_state       TEXT NOT NULL DEFAULT 'PENDING' CHECK (dispatch_state IN ('PENDING','SENT')),
  dispatch_attempts    INTEGER NOT NULL DEFAULT 0,
  dispatched_at        INTEGER,

  processing_date      TEXT NOT NULL,               -- YYYY-MM-DD, Europe/Zurich, frozen at creation

  -- results of durable steps
  classification_json  TEXT,
  classification_model TEXT,
  needs_review         INTEGER,
  review_reason        TEXT,
  dest_folder          TEXT,                        -- planned
  dest_name            TEXT,                        -- planned
  dest_path            TEXT,                        -- final, verified (path_display)
  archive_path         TEXT,                        -- where the source was moved
  gemini_file          TEXT,                        -- 'files/...' to delete

  notify_status        TEXT NOT NULL DEFAULT 'NONE' CHECK (notify_status IN ('NONE','SENDING','SENT','SKIPPED')),
  notify_attempts      INTEGER NOT NULL DEFAULT 0,
  error_notified       INTEGER NOT NULL DEFAULT 0,

  retry_count          INTEGER NOT NULL DEFAULT 0,  -- automatic re-queues after failure
  error_category       TEXT,                        -- transient|permanent|auth|config|dispatch
  error_code           TEXT,                        -- short code, never document content

  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  completed_at         INTEGER,

  UNIQUE (dropbox_file_id, dropbox_rev)
);

CREATE INDEX jobs_dispatch ON jobs (dispatch_state, created_at) WHERE dispatch_state = 'PENDING';
CREATE INDEX jobs_open ON jobs (updated_at) WHERE completed_at IS NULL;
CREATE INDEX jobs_failed ON jobs (updated_at) WHERE status = 'FAILED';

CREATE TABLE folder_state (
  folder     TEXT PRIMARY KEY,                      -- lower-cased normalised path
  cursor     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Worker 1 (epost-to-dropbox) ledger. Created here because both Workers share
-- this database; Worker 1 only reads/writes this table.
CREATE TABLE epost_letters (
  letter_id    TEXT PRIMARY KEY,
  state        TEXT NOT NULL CHECK (state IN ('DOWNLOADING','UPLOADED','ARCHIVED','RESET')),
  dropbox_path TEXT,
  size         INTEGER,
  content_hash TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX epost_letters_open ON epost_letters (updated_at) WHERE state IN ('DOWNLOADING','UPLOADED');
