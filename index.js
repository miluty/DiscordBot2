/**
 * AuroraHud Discord Bot (NO DB, in-memory only)
 * - Welcome + logs
 * - Levels/XP (message-based)
 * - Economy (daily, balance, pay)
 * - Tickets
 * - Moderation (kick/ban/purge)
 * - Vouches (/vouch, /checkvouch)
 * - Bug tracker (/bug report|status|view|list) + Bug Panel + status workflow (tags reporter on resolve)
 * - Panels (/panel create) with buttons + modal bug report
 *
 * NOTE: Everything resets on restart/redeploy.
 *
 * Deps:
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
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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
const ENABLE_GUILD_MEMBERS_INTENT = String(process.env.ENABLE_GUILD_MEMBERS_INTENT || "false").toLowerCase() === "true";
const ENABLE_MESSAGE_CONTENT_INTENT = String(process.env.ENABLE_MESSAGE_CONTENT_INTENT || "false").toLowerCase() === "true";

// ---------------------------
// Tiny web server for Render health checks
// ---------------------------
const app = express();
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
app.listen(PORT, () => console.log(`[WEB] Listening on :${PORT}`));

// ---------------------------
// In-memory storage
// ---------------------------
/**
 * guildSettings: Map<guildId, {
 *   welcome_channel_id, welcome_message,
 *   log_channel_id,
 *   ticket_category_id, ticket_counter,
 *   bug_reports_channel_id, bug_updates_channel_id
 * }>
 *
 * users: Map<`${guildId}:${userId}`, { xp, level, balance, lastDailyMs }>
 * tickets: Map<channelId, { guildId, ownerId, status, createdAtMs, closedAtMs, closedById }>
 * vouches: Map<guildId, Array<{ voucherId, vouchedId, message, createdAtMs }>>
 *
 * bugs: Map<guildId, { counter: number, items: Map<number, BugItem> }>
 * BugItem: {
 *   id, reporterId, title, description,
 *   status, createdAtMs, updatedAtMs,
 *   reportChannelId, reportMessageId,
 *   assignedToId
 * }
 */
const guildSettings = new Map();
const users = new Map();
const tickets = new Map();
const vouches = new Map();
const bugs = new Map();

// ---------------------------
// Settings helpers
// ---------------------------
function getSettings(guildId) {
  return (
    guildSettings.get(guildId) || {
      welcome_channel_id: null,
      welcome_message: null,
      log_channel_id: null,
      ticket_category_id: null,
      ticket_counter: 0,
      bug_reports_channel_id: null,
      bug_updates_channel_id: null,
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
// Small helpers
// ---------------------------
function nowMs() {
  return Date.now();
}
function clampText(str, max) {
  const s = String(str || "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
function makeMessageLink(guildId, channelId, messageId) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
async function safeReply(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.followUp(payload);
    return await interaction.reply(payload);
  } catch {
    // ignore
  }
}
async function safeEdit(interaction, payload) {
  try {
    return await interaction.editReply(payload);
  } catch {
    // ignore
  }
}
// ---------------------------
// XP / Levels (no message content needed)
// ---------------------------
function xpForNext(level) {
  return 5 * level * level + 50 * level + 100;
}

function getUserKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function ensureUser(guildId, userId) {
  const key = getUserKey(guildId, userId);
  if (!users.has(key)) users.set(key, { xp: 0, level: 0, balance: 0, lastDailyMs: 0 });
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

// XP cooldown per user
const xpCooldown = new Map(); // Map<key, lastMs>
function canEarnXp(guildId, userId) {
  const key = getUserKey(guildId, userId);
  const now = nowMs();
  const last = xpCooldown.get(key) || 0;
  if (now - last < 60_000) return false;
  xpCooldown.set(key, now);
  return true;
}

// ---------------------------
// Economy
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
  const now = nowMs();
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

// ---------------------------
// Tickets
// ---------------------------
function nextTicketNumber(guildId) {
  const s = getSettings(guildId);
  const next = (Number(s.ticket_counter) || 0) + 1;
  setSettings(guildId, { ticket_counter: next });
  return next;
}

async function findOrCreateTicketCategory(guild) {
  const s = getSettings(guild.id);
  let categoryId = s.ticket_category_id || null;

  if (categoryId) {
    const existing = await guild.channels.fetch(categoryId).catch(() => null);
    if (existing && existing.type === ChannelType.GuildCategory) return existing;
  }

  const created = await guild.channels
    .create({
      name: "Tickets",
      type: ChannelType.GuildCategory,
      reason: "Ticket category auto-created by AuroraHud",
    })
    .catch(() => null);

  if (created) {
    setSettings(guild.id, { ticket_category_id: created.id });
    return created;
  }

  return null;
}

async function createTicketChannel(guild, ownerMember, reasonText) {
  const category = await findOrCreateTicketCategory(guild);
  const num = nextTicketNumber(guild.id);
  const channelName = `ticket-${String(num).padStart(4, "0")}`;

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: ownerMember.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    {
      id: guild.members.me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];

  const ch = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category?.id || undefined,
    permissionOverwrites: overwrites,
    reason: `Ticket created by ${ownerMember.user?.tag || ownerMember.id}`,
  });

  tickets.set(ch.id, {
    guildId: guild.id,
    ownerId: ownerMember.id,
    status: "open",
    createdAtMs: nowMs(),
    closedAtMs: 0,
    closedById: null,
  });

  const embed = new EmbedBuilder()
    .setTitle("🎫 Support Ticket Created")
    .setDescription(
      [
        `**Owner:** <@${ownerMember.id}>`,
        reasonText ? `**Reason:** ${clampText(reasonText, 900)}` : null,
        "",
        "A staff member will assist you soon.",
        "To close this ticket: use `/ticket close` in this channel.",
      ]
        .filter(Boolean)
        .join("\n")
    )
    .setTimestamp(new Date());

  await ch.send({ content: `<@${ownerMember.id}>`, embeds: [embed], allowedMentions: { users: [ownerMember.id] } }).catch(() => null);

  await sendLog(
    guild,
    new EmbedBuilder()
      .setTitle("🎫 Ticket Created")
      .addFields(
        { name: "Channel", value: `<#${ch.id}>`, inline: true },
        { name: "Owner", value: `<@${ownerMember.id}>`, inline: true }
      )
      .setDescription(reasonText ? `Reason: ${clampText(reasonText, 900)}` : "Reason: (none)")
      .setTimestamp(new Date())
  );

  return ch;
}

async function closeTicketChannel(guild, channel, closedById) {
  const t = tickets.get(channel.id);
  if (!t || t.guildId !== guild.id || t.status !== "open") {
    return { ok: false, reason: "This channel is not an open ticket." };
  }

  t.status = "closed";
  t.closedAtMs = nowMs();
  t.closedById = closedById;

  await sendLog(
    guild,
    new EmbedBuilder()
      .setTitle("✅ Ticket Closed")
      .addFields(
        { name: "Channel", value: `<#${channel.id}>`, inline: true },
        { name: "Closed by", value: `<@${closedById}>`, inline: true }
      )
      .setTimestamp(new Date())
  );

  await channel
    .send({
      embeds: [
        new EmbedBuilder()
          .setTitle("✅ Ticket Closed")
          .setDescription("This channel will be deleted in **10 seconds**.")
          .setTimestamp(new Date()),
      ],
    })
    .catch(() => null);

  setTimeout(() => channel.delete("Ticket closed").catch(() => null), 10_000);
  return { ok: true };
}
// ---------------------------
// Vouches
// ---------------------------
function addVouch(guildId, voucherId, vouchedId, message) {
  if (!vouches.has(guildId)) vouches.set(guildId, []);
  vouches.get(guildId).push({
    voucherId,
    vouchedId,
    message: String(message || ""),
    createdAtMs: nowMs(),
  });
}

function getVouchStats(guildId, userId) {
  const list = vouches.get(guildId) || [];
  const received = list.filter((v) => v.vouchedId === userId);
  const given = list.filter((v) => v.voucherId === userId);
  return { received, given };
}

// ---------------------------
// Bug tracker
// ---------------------------
const BUG_STATUSES = ["OPEN", "IN_PROGRESS", "WAITING", "CANT_FIX", "CANT_REPRODUCE", "RESOLVED"];

function getBugStore(guildId) {
  if (!bugs.has(guildId)) bugs.set(guildId, { counter: 0, items: new Map() });
  return bugs.get(guildId);
}

function createBug(guildId, reporterId, title, description) {
  const store = getBugStore(guildId);
  const id = ++store.counter;

  const item = {
    id,
    reporterId,
    title: String(title || "").trim() || "Untitled",
    description: String(description || "").trim() || "(no description)",
    status: "OPEN",
    createdAtMs: nowMs(),
    updatedAtMs: nowMs(),
    reportChannelId: null,
    reportMessageId: null,
    assignedToId: null,
  };

  store.items.set(id, item);
  return item;
}

function getBug(guildId, id) {
  const store = getBugStore(guildId);
  return store.items.get(Number(id)) || null;
}

function setBugStatus(guildId, id, status, assignedToId) {
  const bug = getBug(guildId, id);
  if (!bug) return null;
  bug.status = status;
  bug.updatedAtMs = nowMs();
  if (assignedToId !== undefined) bug.assignedToId = assignedToId;
  return bug;
}

function bugStatusEmoji(status) {
  switch (status) {
    case "OPEN":
      return "🟥";
    case "IN_PROGRESS":
      return "🟨";
    case "WAITING":
      return "🟦";
    case "CANT_FIX":
      return "⬛";
    case "CANT_REPRODUCE":
      return "🟪";
    case "RESOLVED":
      return "🟩";
    default:
      return "❔";
  }
}

function buildBugEmbed(guildId, bug) {
  const status = bug.status || "OPEN";
  const title = `🐞 Bug #${bug.id} — ${bugStatusEmoji(status)} ${status}`;
  const link =
    bug.reportChannelId && bug.reportMessageId
      ? makeMessageLink(guildId, bug.reportChannelId, bug.reportMessageId)
      : null;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(
      [
        `**Title:** ${clampText(bug.title, 200)}`,
        `**Reporter:** <@${bug.reporterId}>`,
        bug.assignedToId ? `**Assigned:** <@${bug.assignedToId}>` : "**Assigned:** (none)",
        "",
        `**Description:**`,
        clampText(bug.description, 1500),
        "",
        link ? `**Link:** ${link}` : null,
        `**Note:** Data resets on bot restart/redeploy.`,
      ]
        .filter(Boolean)
        .join("\n")
    )
    .setTimestamp(new Date(bug.updatedAtMs));

  return embed;
}

async function postBugToChannel(guild, bug) {
  const s = getSettings(guild.id);
  const reportsChannelId = s.bug_reports_channel_id;
  const reportsChannel =
    (reportsChannelId ? await guild.channels.fetch(reportsChannelId).catch(() => null) : null) || null;

  const target = reportsChannel && reportsChannel.isTextBased() ? reportsChannel : null;
  if (!target) return { ok: false, reason: "Bug reports channel is not set (use /setbugchannels)." };

  const placeholder = await target.send({ embeds: [buildBugEmbed(guild.id, bug)] }).catch(() => null);
  if (!placeholder) return { ok: false, reason: "I couldn't post the bug report (missing permissions?)." };

  bug.reportChannelId = target.id;
  bug.reportMessageId = placeholder.id;

  await placeholder.edit({ embeds: [buildBugEmbed(guild.id, bug)] }).catch(() => null);
  return { ok: true, message: placeholder };
}

async function updateBugMessage(guild, bug) {
  if (!bug.reportChannelId || !bug.reportMessageId) return;
  const ch = await guild.channels.fetch(bug.reportChannelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return;
  const msg = await ch.messages.fetch(bug.reportMessageId).catch(() => null);
  if (!msg) return;
  await msg.edit({ embeds: [buildBugEmbed(guild.id, bug)] }).catch(() => null);
}

async function announceBugStatus(guild, bug, changedById, note) {
  const s = getSettings(guild.id);
  const updatesChannelId = s.bug_updates_channel_id || s.bug_reports_channel_id;
  const ch = updatesChannelId ? await guild.channels.fetch(updatesChannelId).catch(() => null) : null;
  if (!ch || !ch.isTextBased()) return;

  const link =
    bug.reportChannelId && bug.reportMessageId ? makeMessageLink(guild.id, bug.reportChannelId, bug.reportMessageId) : null;

  const embed = new EmbedBuilder()
    .setTitle(`🐞 Bug #${bug.id} Status Updated`)
    .setDescription(
      [
        `**Status:** ${bugStatusEmoji(bug.status)} **${bug.status}**`,
        `**Changed by:** <@${changedById}>`,
        note ? `**Note:** ${clampText(note, 900)}` : null,
        link ? `**Bug Link:** ${link}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    )
    .setTimestamp(new Date());

  const shouldTagReporter = bug.status === "RESOLVED";
  await ch
    .send({
      content: shouldTagReporter ? `<@${bug.reporterId}> Your bug report was marked as **RESOLVED** ✅` : undefined,
      allowedMentions: { users: shouldTagReporter ? [bug.reporterId] : [] },
      embeds: [embed],
    })
    .catch(() => null);
}

// ---------------------------
// Discord client (avoid privileged intents unless enabled)
// ---------------------------
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (ENABLE_GUILD_MEMBERS_INTENT) intents.push(GatewayIntentBits.GuildMembers);
if (ENABLE_MESSAGE_CONTENT_INTENT) intents.push(GatewayIntentBits.MessageContent);

const client = new Client({
  intents,
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

// ---------------------------
// Slash commands (ALL ENGLISH)
// ---------------------------
const bugStatusChoices = BUG_STATUSES.map((s) => ({ name: s, value: s }));

const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Pong + latency."),

  new SlashCommandBuilder().setName("settings").setDescription("Show server settings."),

  new SlashCommandBuilder()
    .setName("setwelcome")
    .setDescription("Set welcome channel + welcome message (use {user} and {guild}).")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName("channel").setDescription("Welcome channel").setRequired(true))
    .addStringOption((o) => o.setName("message").setDescription("Welcome message").setRequired(true)),

  new SlashCommandBuilder()
    .setName("setlog")
    .setDescription("Set the logs channel for AuroraHud.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName("channel").setDescription("Logs channel").setRequired(true)),

  new SlashCommandBuilder()
    .setName("setbugchannels")
    .setDescription("Set channels for bug reports and bug status updates.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName("reports").setDescription("Bug reports channel").setRequired(true))
    .addChannelOption((o) => o.setName("updates").setDescription("Bug updates channel (optional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Show your XP/level (or someone else's).")
    .addUserOption((o) => o.setName("user").setDescription("User (optional)").setRequired(false)),

  new SlashCommandBuilder().setName("leaderboard").setDescription("Top 10 levels in this server."),

  new SlashCommandBuilder().setName("daily").setDescription("Claim your daily coins."),

  new SlashCommandBuilder()
    .setName("balance")
    .setDescription("Show your balance (or someone else's).")
    .addUserOption((o) => o.setName("user").setDescription("User (optional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("pay")
    .setDescription("Send coins to someone.")
    .addUserOption((o) => o.setName("user").setDescription("Recipient").setRequired(true))
    .addIntegerOption((o) => o.setName("amount").setDescription("Amount").setMinValue(1).setRequired(true)),

  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Ticket system.")
    .addSubcommand((s) =>
      s
        .setName("create")
        .setDescription("Create a ticket.")
        .addStringOption((o) => o.setName("reason").setDescription("Reason (optional)").setRequired(false))
    )
    .addSubcommand((s) => s.setName("close").setDescription("Close the current ticket.")),

  new SlashCommandBuilder()
    .setName("vouch")
    .setDescription("Vouch for a user (PUBLIC).")
    .addUserOption((o) => o.setName("user").setDescription("User to vouch").setRequired(true))
    .addStringOption((o) => o.setName("message").setDescription("Message (optional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("checkvouch")
    .setDescription("Check vouches for a user (PUBLIC).")
    .addUserOption((o) => o.setName("user").setDescription("User (optional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("bug")
    .setDescription("Bug tracker.")
    .addSubcommand((s) =>
      s
        .setName("report")
        .setDescription("Report a bug (posts to the bug reports channel).")
        .addStringOption((o) => o.setName("title").setDescription("Short title").setRequired(true))
        .addStringOption((o) => o.setName("description").setDescription("Full description").setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName("status")
        .setDescription("Update bug status (staff).")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addIntegerOption((o) => o.setName("id").setDescription("Bug ID").setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName("status").setDescription("New status").setRequired(true).addChoices(...bugStatusChoices))
        .addUserOption((o) => o.setName("assign").setDescription("Assign to (optional)").setRequired(false))
        .addStringOption((o) => o.setName("note").setDescription("Note (optional)").setRequired(false))
    )
    .addSubcommand((s) =>
      s
        .setName("view")
        .setDescription("View a bug by ID.")
        .addIntegerOption((o) => o.setName("id").setDescription("Bug ID").setRequired(true).setMinValue(1))
    )
    .addSubcommand((s) => s.setName("list").setDescription("List recent bugs (last 10).")),

  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Create a support panel (buttons).")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName("create").setDescription("Post the AuroraHud support panel here.")),

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason (optional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason (optional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Bulk delete messages (1-100).")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((o) => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1).setMaxValue(100)),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const guildId = String(process.env.DISCORD_GUILD_ID || "").trim();

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guildId), { body: commands });
    console.log(`[DISCORD] Registered GUILD commands for ${guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
    console.log("[DISCORD] Registered GLOBAL commands");
  }
}
// ---------------------------
// Events
// ---------------------------
client.once("ready", async () => {
  console.log(`[DISCORD] Logged in as ${client.user.tag}`);
  console.log(`[DISCORD] Privileged intents enabled (runtime): GuildMembers=${ENABLE_GUILD_MEMBERS_INTENT}, MessageContent=${ENABLE_MESSAGE_CONTENT_INTENT}`);
});

// Welcome (requires ENABLE_GUILD_MEMBERS_INTENT=true AND enabled in Discord Developer Portal)
client.on("guildMemberAdd", async (member) => {
  try {
    const s = getSettings(member.guild.id);
    if (!s.welcome_channel_id || !s.welcome_message) return;

    const ch = await member.guild.channels.fetch(s.welcome_channel_id).catch(() => null);
    if (!ch || !ch.isTextBased()) return;

    const rendered = String(s.welcome_message)
      .replaceAll("{user}", `<@${member.id}>`)
      .replaceAll("{guild}", member.guild.name);

    await ch.send({ content: rendered, allowedMentions: { users: [member.id] } }).catch(() => null);

    await sendLog(
      member.guild,
      new EmbedBuilder()
        .setTitle("👋 Member Joined")
        .setDescription(`<@${member.id}> (${member.user.tag})`)
        .setTimestamp(new Date())
    );
  } catch {}
});

client.on("guildMemberRemove", async (member) => {
  try {
    await sendLog(
      member.guild,
      new EmbedBuilder()
        .setTitle("🚪 Member Left")
        .setDescription(`${member.user?.tag || member.id}`)
        .setTimestamp(new Date())
    );
  } catch {}
});

// XP on messages (works without MessageContent intent)
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;

    if (!canEarnXp(message.guild.id, message.author.id)) return;

    const gain = 15 + Math.floor(Math.random() * 11); // 15-25
    const res = addXp(message.guild.id, message.author.id, gain);

    if (res?.leveledUp) {
      await message.channel
        .send({
          embeds: [
            new EmbedBuilder()
              .setTitle("🎉 Level Up!")
              .setDescription(`<@${message.author.id}> reached **Level ${res.level}**!`)
              .setTimestamp(new Date()),
          ],
          allowedMentions: { users: [message.author.id] },
        })
        .catch(() => null);

      await sendLog(
        message.guild,
        new EmbedBuilder()
          .setTitle("📈 Level Up")
          .setDescription(`<@${message.author.id}> → **Level ${res.level}**`)
          .setTimestamp(new Date())
      );
    }
  } catch {}
});

// ---------------------------
// Panel UI (buttons + modal)
// ---------------------------
const PANEL_TICKET_CREATE = "panel_ticket_create";
const PANEL_BUG_REPORT = "panel_bug_report";
const PANEL_MY_VOUCHES = "panel_my_vouches";
const MODAL_BUG_REPORT = "modal_bug_report";

// Create the support panel embed + buttons
function buildSupportPanel() {
  const embed = new EmbedBuilder()
    .setTitle("🌌 AuroraHud Support Panel")
    .setDescription(
      [
        "Use the buttons below to quickly create a ticket or report a bug.",
        "",
        "✅ **Create Ticket** — private support channel",
        "🐞 **Report Bug** — posts to the configured bug channel",
        "📌 **My Vouches** — shows your vouch stats",
        "",
        "Public commands:",
        "• `/vouch @user message`",
        "• `/checkvouch @user`",
      ].join("\n")
    )
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PANEL_TICKET_CREATE).setLabel("Create Ticket").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(PANEL_BUG_REPORT).setLabel("Report Bug").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(PANEL_MY_VOUCHES).setLabel("My Vouches").setStyle(ButtonStyle.Secondary)
  );

  return { embed, components: [row] };
}

// ---------------------------
// Interaction handler
// ---------------------------
client.on("interactionCreate", async (interaction) => {
  // ---- Buttons ----
  if (interaction.isButton()) {
    const guild = interaction.guild;
    if (!guild) return;

    if (interaction.customId === PANEL_TICKET_CREATE) {
      const member = await guild.members.fetch(interaction.user.id).catch(() => null);
      if (!member) return safeReply(interaction, { content: "I couldn't fetch your member profile.", ephemeral: true });

      const ch = await createTicketChannel(guild, member, "Created via panel");
      return safeReply(interaction, { content: `✅ Ticket created: <#${ch.id}>`, ephemeral: true });
    }

    if (interaction.customId === PANEL_MY_VOUCHES) {
      const stats = getVouchStats(guild.id, interaction.user.id);
      const last = stats.received.slice().sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 5);

      const lines =
        last.length > 0
          ? last.map((v, i) => `**${i + 1}.** <@${v.voucherId}> — ${v.message ? clampText(v.message, 120) : "*no message*"}`)
          : ["*No vouches yet.*"];

      const embed = new EmbedBuilder()
        .setTitle("📌 My Vouches")
        .setDescription(
          [
            `**Received:** ${stats.received.length}`,
            `**Given:** ${stats.given.length}`,
            "",
            "**Latest 5 received:**",
            ...lines,
            "",
            "_Note: Data resets if the bot restarts._",
          ].join("\n")
        )
        .setTimestamp(new Date());

      return safeReply(interaction, { embeds: [embed], ephemeral: true });
    }

    if (interaction.customId === PANEL_BUG_REPORT) {
      const modal = new ModalBuilder().setCustomId(MODAL_BUG_REPORT).setTitle("Report a Bug");

      const title = new TextInputBuilder()
        .setCustomId("title")
        .setLabel("Bug title (short)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);

      const desc = new TextInputBuilder()
        .setCustomId("description")
        .setLabel("Bug description (steps, expected, actual)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000);

      modal.addComponents(new ActionRowBuilder().addComponents(title), new ActionRowBuilder().addComponents(desc));
      return interaction.showModal(modal).catch(() => null);
    }
  }

  // ---- Modals ----
  if (interaction.isModalSubmit()) {
    const guild = interaction.guild;
    if (!guild) return;

    if (interaction.customId === MODAL_BUG_REPORT) {
      const s = getSettings(guild.id);
      if (!s.bug_reports_channel_id) {
        return safeReply(interaction, {
          content: "Bug reports channel is not configured. Ask an admin to run `/setbugchannels`.",
          ephemeral: true,
        });
      }

      const title = interaction.fields.getTextInputValue("title");
      const description = interaction.fields.getTextInputValue("description");

      const bug = createBug(guild.id, interaction.user.id, title, description);
      const posted = await postBugToChannel(guild, bug);

      if (!posted.ok) {
        return safeReply(interaction, { content: `❌ Could not post bug report: ${posted.reason}`, ephemeral: true });
      }

      await updateBugMessage(guild, bug);

      const link = makeMessageLink(guild.id, bug.reportChannelId, bug.reportMessageId);
      return safeReply(interaction, { content: `✅ Bug reported as **#${bug.id}**: ${link}`, ephemeral: true });
    }
  }
  // ---- Slash commands ----
  if (!interaction.isChatInputCommand()) return;

  const guild = interaction.guild;
  if (!guild) {
    await safeReply(interaction, { content: "This bot only works inside servers.", ephemeral: true });
    return;
  }

  try {
    if (interaction.commandName === "ping") {
      const sent = nowMs();
      await safeReply(interaction, { content: "Pong..." });
      const latency = nowMs() - sent;
      await safeEdit(interaction, { content: `Pong! 🏓 (${latency}ms)` });
      return;
    }

    if (interaction.commandName === "settings") {
      const s = getSettings(guild.id);
      const embed = new EmbedBuilder()
        .setTitle("⚙️ Server Settings")
        .setDescription(
          [
            `**Welcome channel:** ${s.welcome_channel_id ? `<#${s.welcome_channel_id}>` : "(not set)"}`,
            `**Logs channel:** ${s.log_channel_id ? `<#${s.log_channel_id}>` : "(not set)"}`,
            `**Ticket category:** ${s.ticket_category_id ? `<#${s.ticket_category_id}>` : "(auto)"}`,
            `**Bug reports channel:** ${s.bug_reports_channel_id ? `<#${s.bug_reports_channel_id}>` : "(not set)"}`,
            `**Bug updates channel:** ${s.bug_updates_channel_id ? `<#${s.bug_updates_channel_id}>` : "(not set)"}`,
            "",
            `**Privileged intents (runtime):** GuildMembers=${ENABLE_GUILD_MEMBERS_INTENT}, MessageContent=${ENABLE_MESSAGE_CONTENT_INTENT}`,
          ].join("\n")
        )
        .setTimestamp(new Date());

      await safeReply(interaction, { embeds: [embed], ephemeral: true });
      return;
    }

    if (interaction.commandName === "setwelcome") {
      const channel = interaction.options.getChannel("channel", true);
      const message = interaction.options.getString("message", true);

      if (!channel.isTextBased()) return safeReply(interaction, { content: "That channel is not text-based.", ephemeral: true });

      setSettings(guild.id, { welcome_channel_id: channel.id, welcome_message: message });
      await safeReply(interaction, { content: `✅ Welcome configured in ${channel}.`, ephemeral: true });

      await sendLog(
        guild,
        new EmbedBuilder()
          .setTitle("⚙️ Welcome Updated")
          .setDescription(`Channel: <#${channel.id}>\nMessage: ${clampText(message, 900)}`)
          .setTimestamp(new Date())
      );
      return;
    }

    if (interaction.commandName === "setlog") {
      const channel = interaction.options.getChannel("channel", true);
      if (!channel.isTextBased()) return safeReply(interaction, { content: "That channel is not text-based.", ephemeral: true });

      setSettings(guild.id, { log_channel_id: channel.id });
      await safeReply(interaction, { content: `✅ Logs configured in ${channel}.`, ephemeral: true });
      return;
    }

    if (interaction.commandName === "setbugchannels") {
      const reports = interaction.options.getChannel("reports", true);
      const updates = interaction.options.getChannel("updates", false);

      if (!reports.isTextBased()) return safeReply(interaction, { content: "Reports channel must be text-based.", ephemeral: true });
      if (updates && !updates.isTextBased()) return safeReply(interaction, { content: "Updates channel must be text-based.", ephemeral: true });

      setSettings(guild.id, {
        bug_reports_channel_id: reports.id,
        bug_updates_channel_id: updates ? updates.id : null,
      });

      await safeReply(interaction, {
        content: `✅ Bug channels set.\n• Reports: ${reports}\n• Updates: ${updates ? updates : "(same as reports)"}`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === "rank") {
      const target = interaction.options.getUser("user") || interaction.user;
      const u = ensureUser(guild.id, target.id);

      const embed = new EmbedBuilder()
        .setTitle("🏅 Rank")
        .setDescription(
          [`**User:** <@${target.id}>`, `**Level:** ${u.level}`, `**XP:** ${u.xp} / ${xpForNext(u.level)}`, "", "_Data resets on restart._"].join("\n")
        )
        .setTimestamp(new Date());

      await safeReply(interaction, { embeds: [embed], ephemeral: true });
      return;
    }

    if (interaction.commandName === "leaderboard") {
      const rows = [];
      for (const [key, val] of users.entries()) {
        const [gId, uId] = key.split(":");
        if (gId !== guild.id) continue;
        rows.push({ user_id: uId, level: val.level, xp: val.xp });
      }
      rows.sort((a, b) => (b.level - a.level) || (b.xp - a.xp));
      const top = rows.slice(0, 10);

      if (!top.length) return safeReply(interaction, { content: "No leaderboard data yet.", ephemeral: true });

      const lines = top.map((r, i) => `**${i + 1}.** <@${r.user_id}> — **Lv ${r.level}** (XP ${r.xp})`);
      const embed = new EmbedBuilder().setTitle("🏆 Leaderboard").setDescription(lines.join("\n")).setTimestamp(new Date());

      await safeReply(interaction, { embeds: [embed] });
      return;
    }

    if (interaction.commandName === "daily") {
      const res = claimDaily(guild.id, interaction.user.id);
      if (!res.ok) {
        return safeReply(interaction, { content: `⏳ You already claimed daily. Try again in ${formatDuration(res.remainingMs)}.`, ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setTitle("💰 Daily Claimed")
        .setDescription(`You received **${res.reward}** coins.\nNew balance: **${res.balance}**`)
        .setTimestamp(new Date());

      await safeReply(interaction, { embeds: [embed], ephemeral: true });
      return;
    }

    if (interaction.commandName === "balance") {
      const target = interaction.options.getUser("user") || interaction.user;
      const u = ensureUser(guild.id, target.id);

      const embed = new EmbedBuilder()
        .setTitle("💳 Balance")
        .setDescription(`**User:** <@${target.id}>\n**Coins:** ${u.balance}\n\n_Data resets on restart._`)
        .setTimestamp(new Date());

      await safeReply(interaction, { embeds: [embed], ephemeral: true });
      return;
    }

    if (interaction.commandName === "pay") {
      const to = interaction.options.getUser("user", true);
      const amount = interaction.options.getInteger("amount", true);

      if (to.bot) return safeReply(interaction, { content: "You can't pay a bot.", ephemeral: true });
      if (to.id === interaction.user.id) return safeReply(interaction, { content: "You can't pay yourself.", ephemeral: true });

      try {
        transferBalance(guild.id, interaction.user.id, to.id, amount);
      } catch (e) {
        if (String(e?.message || "").includes("insufficient")) return safeReply(interaction, { content: "Insufficient funds.", ephemeral: true });
        throw e;
      }

      await safeReply(interaction, { content: `✅ Sent **${amount}** coins to <@${to.id}>.`, ephemeral: true });

      await sendLog(
        guild,
        new EmbedBuilder()
          .setTitle("💸 Payment")
          .setDescription(`<@${interaction.user.id}> → <@${to.id}>: **${amount}** coins`)
          .setTimestamp(new Date())
      );
      return;
    }

    if (interaction.commandName === "ticket") {
      const sub = interaction.options.getSubcommand(true);

      if (sub === "create") {
        const reason = interaction.options.getString("reason") || "";
        const member = await guild.members.fetch(interaction.user.id);
        const ch = await createTicketChannel(guild, member, reason);
        return safeReply(interaction, { content: `✅ Ticket created: <#${ch.id}>`, ephemeral: true });
      }

      if (sub === "close") {
        const channel = interaction.channel;
        if (!channel || channel.type !== ChannelType.GuildText) return safeReply(interaction, { content: "Invalid channel for this command.", ephemeral: true });

        const result = await closeTicketChannel(guild, channel, interaction.user.id);
        if (!result.ok) return safeReply(interaction, { content: result.reason, ephemeral: true });

        return safeReply(interaction, { content: "✅ Closing ticket...", ephemeral: true });
      }
    }

    // VOUCH (PUBLIC + decorated)
    if (interaction.commandName === "vouch") {
      const target = interaction.options.getUser("user", true);
      const msg = interaction.options.getString("message") || "";

      if (target.bot) return safeReply(interaction, { content: "You can't vouch for a bot.", ephemeral: true });
      if (target.id === interaction.user.id) return safeReply(interaction, { content: "You can't vouch for yourself.", ephemeral: true });

      addVouch(guild.id, interaction.user.id, target.id, msg);
      const stats = getVouchStats(guild.id, target.id);

      const embed = new EmbedBuilder()
        .setTitle("🤝 New Vouch")
        .setDescription(
          [
            `**From:** <@${interaction.user.id}>`,
            `**To:** <@${target.id}>`,
            msg ? `**Message:** ${clampText(msg, 900)}` : "**Message:** (none)",
            "",
            `⭐ **Total vouches for <@${target.id}>:** ${stats.received.length}`,
          ].join("\n")
        )
        .setTimestamp(new Date());

      await safeReply(interaction, { embeds: [embed], allowedMentions: { users: [interaction.user.id, target.id] } });

      await sendLog(
        guild,
        new EmbedBuilder()
          .setTitle("🤝 Vouch Logged")
          .setDescription(`<@${interaction.user.id}> vouched for <@${target.id}>`)
          .setTimestamp(new Date())
      );
      return;
    }

    // CHECKVOUCH (PUBLIC + decorated)
    if (interaction.commandName === "checkvouch") {
      const target = interaction.options.getUser("user") || interaction.user;
      const stats = getVouchStats(guild.id, target.id);
      const received = stats.received.slice().sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 10);

      const lines =
        received.length > 0
          ? received.map((v, i) => `**${i + 1}.** <@${v.voucherId}> — ${v.message ? clampText(v.message, 120) : "*no message*"}`)
          : ["*No vouches yet.*"];

      const embed = new EmbedBuilder()
        .setTitle("📌 Vouch Profile")
        .setDescription(
          [
            `**User:** <@${target.id}>`,
            `**Received:** ${stats.received.length}`,
            `**Given:** ${stats.given.length}`,
            "",
            "**Latest (up to 10):**",
            ...lines,
            "",
            "_Note: Data resets on bot restart/redeploy._",
          ].join("\n")
        )
        .setTimestamp(new Date());

      await safeReply(interaction, { embeds: [embed], allowedMentions: { users: [target.id] } });
      return;
    }

    // BUG COMMANDS
    if (interaction.commandName === "bug") {
      const sub = interaction.options.getSubcommand(true);
      const s = getSettings(guild.id);

      if (sub === "report") {
        if (!s.bug_reports_channel_id) {
          return safeReply(interaction, { content: "Bug reports channel is not configured. Use `/setbugchannels` first.", ephemeral: true });
        }

        const title = interaction.options.getString("title", true);
        const description = interaction.options.getString("description", true);

        const bug = createBug(guild.id, interaction.user.id, title, description);
        const posted = await postBugToChannel(guild, bug);

        if (!posted.ok) return safeReply(interaction, { content: `❌ Could not post bug report: ${posted.reason}`, ephemeral: true });

        await updateBugMessage(guild, bug);

        const link = makeMessageLink(guild.id, bug.reportChannelId, bug.reportMessageId);
        await safeReply(interaction, { content: `✅ Bug reported as **#${bug.id}**: ${link}`, ephemeral: true });
        return;
      }

      if (sub === "view") {
        const id = interaction.options.getInteger("id", true);
        const bug = getBug(guild.id, id);
        if (!bug) return safeReply(interaction, { content: `Bug #${id} not found.`, ephemeral: true });

        const embed = buildBugEmbed(guild.id, bug);
        await safeReply(interaction, { embeds: [embed], ephemeral: true });
        return;
      }

      if (sub === "list") {
        const store = getBugStore(guild.id);
        const all = Array.from(store.items.values()).sort((a, b) => b.id - a.id).slice(0, 10);

        if (!all.length) return safeReply(interaction, { content: "No bugs reported yet.", ephemeral: true });

        const lines = all.map((b) => {
          const link = b.reportChannelId && b.reportMessageId ? makeMessageLink(guild.id, b.reportChannelId, b.reportMessageId) : null;
          return `${bugStatusEmoji(b.status)} **#${b.id}** ${clampText(b.title, 60)} — **${b.status}**${link ? ` — ${link}` : ""}`;
        });

        const embed = new EmbedBuilder()
          .setTitle("🐞 Recent Bugs (Last 10)")
          .setDescription(lines.join("\n"))
          .setTimestamp(new Date());

        await safeReply(interaction, { embeds: [embed], ephemeral: true });
        return;
      }

      if (sub === "status") {
        const id = interaction.options.getInteger("id", true);
        const status = interaction.options.getString("status", true);
        const assign = interaction.options.getUser("assign", false);
        const note = interaction.options.getString("note", false) || "";

        if (!BUG_STATUSES.includes(status)) return safeReply(interaction, { content: "Invalid status.", ephemeral: true });

        const updated = setBugStatus(guild.id, id, status, assign ? assign.id : undefined);
        if (!updated) return safeReply(interaction, { content: `Bug #${id} not found.`, ephemeral: true });

        await updateBugMessage(guild, updated);
        await announceBugStatus(guild, updated, interaction.user.id, note);

        await safeReply(interaction, { content: `✅ Bug #${id} updated to **${status}**.`, ephemeral: true });
        return;
      }
    }

    // PANEL
    if (interaction.commandName === "panel") {
      const sub = interaction.options.getSubcommand(true);
      if (sub === "create") {
        const panel = buildSupportPanel();
        await safeReply(interaction, { content: "✅ Panel posted.", ephemeral: true });
        await interaction.channel.send({ embeds: [panel.embed], components: panel.components }).catch(() => null);
        return;
      }
    }

    // Moderation
    if (interaction.commandName === "kick") {
      const target = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "No reason provided.";

      const member = await guild.members.fetch(target.id).catch(() => null);
      if (!member) return safeReply(interaction, { content: "Member not found.", ephemeral: true });

      await member.kick(reason).catch((e) => {
        throw new Error(`Kick failed: ${e?.message || e}`);
      });

      await safeReply(interaction, { content: `✅ Kicked <@${target.id}>.`, ephemeral: true });
      await sendLog(
        guild,
        new EmbedBuilder()
          .setTitle("👢 Kick")
          .setDescription(`**Target:** <@${target.id}>\n**Moderator:** <@${interaction.user.id}>\n**Reason:** ${clampText(reason, 900)}`)
          .setTimestamp(new Date())
      );
      return;
    }

    if (interaction.commandName === "ban") {
      const target = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "No reason provided.";

      await guild.members.ban(target.id, { reason }).catch((e) => {
        throw new Error(`Ban failed: ${e?.message || e}`);
      });

      await safeReply(interaction, { content: `✅ Banned <@${target.id}>.`, ephemeral: true });
      await sendLog(
        guild,
        new EmbedBuilder()
          .setTitle("🔨 Ban")
          .setDescription(`**Target:** <@${target.id}>\n**Moderator:** <@${interaction.user.id}>\n**Reason:** ${clampText(reason, 900)}`)
          .setTimestamp(new Date())
      );
      return;
    }

    if (interaction.commandName === "purge") {
      const amount = interaction.options.getInteger("amount", true);
      const channel = interaction.channel;
      if (!channel || !channel.isTextBased()) return safeReply(interaction, { content: "Invalid channel.", ephemeral: true });

      const deleted = await channel.bulkDelete(amount, true).catch(() => null);
      const count = deleted ? deleted.size : 0;

      await safeReply(interaction, { content: `✅ Deleted ${count} messages.`, ephemeral: true });
      await sendLog(
        guild,
        new EmbedBuilder()
          .setTitle("🧹 Purge")
          .setDescription(`**Moderator:** <@${interaction.user.id}>\n**Channel:** <#${channel.id}>\n**Deleted:** ${count}`)
          .setTimestamp(new Date())
      );
      return;
    }

    await safeReply(interaction, { content: "Command not handled.", ephemeral: true });
  } catch (err) {
    console.error("[ERROR]", err);
    await safeReply(interaction, { content: "An error occurred while running this command.", ephemeral: true });
  }
});

// ---------------------------
// Startup
// ---------------------------
async function main() {
  await registerCommands();
  await client.login(process.env.DISCORD_TOKEN);
}

main()
  .then(() => console.log("[START] Bot started"))
  .catch((e) => {
    console.error("[FATAL]", e);
    process.exit(1);
  });

process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
