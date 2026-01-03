/**
 * AuroraHud Discord Bot (Option B: NO DB, in-memory only)
 * - Welcome + logs
 * - Levels/XP
 * - Economy (daily, balance, pay)
 * - Tickets
 * - Moderation (kick/ban/purge)
 * - Vouches (/vouch, /checkvouch)
 *
 * NOTE: Everything resets on restart/redeploy.
 *
 * Deps (install in Render build command):
 *   npm i discord.js dotenv express
 */

require("dotenv").config();

const express = require("express");
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
const REQUIRED_ENVS = ["DISCORD_TOKEN", "DISCORD_CLIENT_ID"];
for (const k of REQUIRED_ENVS) {
  if (!process.env[k] || !String(process.env[k]).trim()) {
    console.error(`[FATAL] Missing env var: ${k}`);
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT || 3000);

// ---------------------------
// Tiny web server for Render health checks
// ---------------------------
const app = express();
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
app.listen(PORT, () => console.log(`[WEB] Listening on :${PORT}`));

// ---------------------------
// In-memory storage (Option B)
// ---------------------------
/**
 * guildSettings: Map<guildId, { welcome_channel_id, welcome_message, log_channel_id, ticket_category_id, ticket_counter }>
 * users: Map<`${guildId}:${userId}`, { xp, level, balance, lastDailyMs }>
 * tickets: Map<channelId, { guildId, ownerId, status, createdAtMs, closedAtMs, closedById }>
 * vouches: Map<guildId, Array<{ voucherId, vouchedId, message, createdAtMs }>>
 */
const guildSettings = new Map();
const users = new Map();
const tickets = new Map();
const vouches = new Map();

// ---------------------------
// Helpers
// ---------------------------
function getSettings(guildId) {
  return (
    guildSettings.get(guildId) || {
      welcome_channel_id: null,
      welcome_message: null,
      log_channel_id: null,
      ticket_category_id: null,
      ticket_counter: 0,
    }
  );
}

function setSettings(guildId, patch) {
  const current = getSettings(guildId);
  const merged = { ...current, ...patch };
  guildSettings.set(guildId, merged);
  return merged;
}

async function sendLog(guild, embed) {
  try {
    const s = getSettings(guild.id);
    if (!s.log_channel_id) return;
    const ch = await guild.channels.fetch(s.log_channel_id).catch(() => null);
    if (!ch || !ch.isTextBased()) return;
    await ch.send({ embeds: [embed] }).catch(() => null);
  } catch {
    // ignore
  }
}

// ---------------------------
// XP/Level helpers
// ---------------------------
function xpForNext(level) {
  return 5 * level * level + 50 * level + 100;
}

function getUserKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function ensureUser(guildId, userId) {
  const key = getUserKey(guildId, userId);
  if (!users.has(key)) {
    users.set(key, { xp: 0, level: 0, balance: 0, lastDailyMs: 0 });
  }
  return users.get(key);
}

function addXp(guildId, userId, amount) {
  const u = ensureUser(guildId, userId);
  u.xp += amount;

  let leveledUp = false;
  while (u.xp >= xpForNext(u.level)) {
    u.xp -= xpForNext(u.level);
    u.level += 1;
    leveledUp = true;
  }

  return { xp: u.xp, level: u.level, leveledUp };
}

// Cooldown XP per user
const xpCooldown = new Map(); // Map<key, lastMs>
function canEarnXp(guildId, userId) {
  const key = getUserKey(guildId, userId);
  const now = Date.now();
  const last = xpCooldown.get(key) || 0;
  if (now - last < 60_000) return false; // 60s
  xpCooldown.set(key, now);
  return true;
}

// ---------------------------
// Economy helpers
// ---------------------------
function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(" ");
}

function claimDaily(guildId, userId) {
  const u = ensureUser(guildId, userId);
  const now = Date.now();
  const COOLDOWN = 24 * 60 * 60 * 1000;

  if (u.lastDailyMs && now - u.lastDailyMs < COOLDOWN) {
    return { ok: false, remainingMs: COOLDOWN - (now - u.lastDailyMs) };
  }

  const reward = 250 + Math.floor(Math.random() * 251); // 250-500
  u.lastDailyMs = now;
  u.balance += reward;
  return { ok: true, reward, balance: u.balance };
}

function transferBalance(guildId, fromId, toId, amount) {
  if (amount <= 0) throw new Error("amount must be > 0");
  const from = ensureUser(guildId, fromId);
  const to = ensureUser(guildId, toId);
  if (from.balance < amount) throw new Error("insufficient funds");
  from.balance -= amount;
  to.balance += amount;
  return true;
}
