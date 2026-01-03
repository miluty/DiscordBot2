/**
 * index.js - Single-file Discord bot for Render (discord.js v14 + pg)
 * Features:
 *  - Welcome + logs
 *  - Levels/XP
 *  - Economy (daily, balance, pay)
 *  - Tickets
 *  - Moderation (kick/ban/purge)
 *  - Vouches (/vouch, /checkvouch)
 *
 * Deps (install in Render build command):
 *   npm i discord.js pg dotenv express
 */

require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
} = require("discord.js");

// ---------------------------
// Basic validation
// ---------------------------
const REQUIRED_ENVS = ["DISCORD_TOKEN", "DISCORD_CLIENT_ID", "DATABASE_URL"];
for (const k of REQUIRED_ENVS) {
  if (!process.env[k] || !String(process.env[k]).trim()) {
    console.error(`[FATAL] Missing env var: ${k}`);
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = (process.env.NODE_ENV || "").toLowerCase() === "production";

// ---------------------------
// Tiny web server for Render health checks
// ---------------------------
const app = express();
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
app.listen(PORT, () => console.log(`[WEB] Listening on :${PORT}`));

// ---------------------------
// Postgres pool
// ---------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: IS_PROD ? { rejectUnauthorized: false } : undefined,
});

async function dbQuery(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// ---------------------------
// Minimal "auto-migration" safety (creates tables if missing)
// (You still have schema.sql for proper provisioning.)
// ---------------------------
async function ensureSchema() {
  const sql = `
  BEGIN;

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
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guild_settings_updated_at') THEN
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
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_users_updated_at') THEN
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
    action_type   TEXT NOT NULL,
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
    action      TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_message_logs_guild_time ON message_logs (guild_id, created_at DESC);

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
  `;
  await dbQuery(sql);
  console.log("[DB] Schema ensured");
}

// ---------------------------
// Guild settings helpers
// ---------------------------
async function getGuildSettings(guildId) {
  const { rows } = await dbQuery(`SELECT * FROM guild_settings WHERE guild_id = $1`, [guildId]);
  return rows[0] || null;
}

async function upsertGuildSettings(guildId, patch) {
  const current = (await getGuildSettings(guildId)) || {};
  const merged = { ...current, ...patch, guild_id: guildId };

  await dbQuery(
    `
    INSERT INTO guild_settings (guild_id, welcome_channel_id, welcome_message, log_channel_id, ticket_category_id, ticket_counter)
    VALUES ($1, $2, $3, $4, $5, COALESCE($6, 0))
    ON CONFLICT (guild_id) DO UPDATE
      SET welcome_channel_id = EXCLUDED.welcome_channel_id,
          welcome_message    = EXCLUDED.welcome_message,
          log_channel_id     = EXCLUDED.log_channel_id,
          ticket_category_id = EXCLUDED.ticket_category_id,
          ticket_counter     = EXCLUDED.ticket_counter,
          updated_at         = NOW()
    `,
    [
      merged.guild_id,
      merged.welcome_channel_id || null,
      merged.welcome_message || null,
      merged.log_channel_id || null,
      merged.ticket_category_id || null,
      Number.isFinite(merged.ticket_counter) ? merged.ticket_counter : 0,
    ]
  );

  return getGuildSettings(guildId);
}

async function sendLog(guild, embed) {
  try {
    const settings = await getGuildSettings(guild.id);
    const channelId = settings?.log_channel_id;
    if (!channelId) return;

    const ch = await guild.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.isTextBased()) return;

    await ch.send({ embeds: [embed] }).catch(() => null);
  } catch {
    // ignore logging errors
  }
}

// ---------------------------
// XP/Level helpers
// ---------------------------
function xpForNext(level) {
  return 5 * level * level + 50 * level + 100;
}

async function ensureUserRow(guildId, userId) {
  await dbQuery(
    `
    INSERT INTO users (guild_id, user_id)
    VALUES ($1, $2)
    ON CONFLICT (guild_id, user_id) DO NOTHING
    `,
    [guildId, userId]
  );
}

async function addXp(guildId, userId, amount) {
  await ensureUserRow(guildId, userId);

  const { rows } = await dbQuery(
    `
    UPDATE users
    SET xp = xp + $3
    WHERE guild_id = $1 AND user_id = $2
    RETURNING xp, level
    `,
    [guildId, userId, amount]
  );

  if (!rows[0]) return null;

  let { xp, level } = rows[0];
  let leveledUp = false;

  while (xp >= xpForNext(level)) {
    xp -= xpForNext(level);
    level += 1;
    leveledUp = true;
  }

  if (leveledUp) {
    await dbQuery(
      `
      UPDATE users
      SET xp = $3, level = $4
      WHERE guild_id = $1 AND user_id = $2
      `,
      [guildId, userId, xp, level]
    );
  }

  return { xp, level, leveledUp };
}

// In-memory XP cooldown per (guild:user)
const xpCooldown = new Map();
function canEarnXp(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const last = xpCooldown.get(key) || 0;
  if (now - last < 60_000) return false; // 60s cooldown
  xpCooldown.set(key, now);
  return true;
}
