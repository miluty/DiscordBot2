-- schema.sql (PostgreSQL)

BEGIN;

-- Updated-at trigger helper
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id              TEXT PRIMARY KEY,
  welcome_channel_id    TEXT,
  welcome_message       TEXT,
  log_channel_id        TEXT,
  ticket_category_id    TEXT,
  ticket_counter        INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guild_settings_updated_at'
  ) THEN
    CREATE TRIGGER trg_guild_settings_updated_at
    BEFORE UPDATE ON guild_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS users (
  guild_id      TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  xp            BIGINT NOT NULL DEFAULT 0,
  level         INTEGER NOT NULL DEFAULT 0,
  balance       BIGINT NOT NULL DEFAULT 0,
  last_daily    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_users_updated_at'
  ) THEN
    CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS tickets (
  id           BIGSERIAL PRIMARY KEY,
  guild_id     TEXT NOT NULL,
  channel_id   TEXT NOT NULL UNIQUE,
  owner_id     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at    TIMESTAMPTZ,
  closed_by    TEXT
);

CREATE INDEX IF NOT EXISTS idx_tickets_guild_status ON tickets (guild_id, status);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id            BIGSERIAL PRIMARY KEY,
  guild_id      TEXT NOT NULL,
  action_type   TEXT NOT NULL, -- kick/ban/purge/etc
  target_id     TEXT,
  moderator_id  TEXT NOT NULL,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mod_actions_guild_time ON moderation_actions (guild_id, created_at DESC);

CREATE TABLE IF NOT EXISTS message_logs (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  message_id  TEXT,
  author_id   TEXT,
  content     TEXT,
  action      TEXT NOT NULL, -- delete/edit
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_logs_guild_time ON message_logs (guild_id, created_at DESC);

-- Vouches (reputación)
CREATE TABLE IF NOT EXISTS vouches (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  voucher_id  TEXT NOT NULL,
  vouched_id  TEXT NOT NULL,
  message     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vouches_guild_vouched_time ON vouches (guild_id, vouched_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vouches_guild_voucher_time ON vouches (guild_id, voucher_id, created_at DESC);

COMMIT;
