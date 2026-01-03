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
  AttachmentBuilder,
} = require("discord.js");

const REQUIRED_ENVS = ["DISCORD_TOKEN", "DISCORD_CLIENT_ID"];
for (const k of REQUIRED_ENVS) {
  if (!process.env[k] || !String(process.env[k]).trim()) {
    console.error(`[FATAL] Missing env var: ${k}`);
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT || 3000);
let RUNTIME_MESSAGE_CONTENT_INTENT =
  String(process.env.ENABLE_MESSAGE_CONTENT_INTENT || "false").toLowerCase() === "true";

const app = express();
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
app.listen(PORT, () => console.log(`[WEB] Listening on :${PORT}`));

function nowMs() {
  return Date.now();
}
function clampText(str, max) {
  const s = String(str ?? "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
function safeUserTag(user) {
  return user?.tag || `${user?.username || "unknown"}#0000`;
}
function parseUserId(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const m1 = raw.match(/^<@!?(\d+)>$/);
  if (m1) return m1[1];
  const m2 = raw.match(/^(\d{15,30})$/);
  if (m2) return m2[1];
  return null;
}
function makeMessageLink(guildId, channelId, messageId) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
async function safeReply(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.followUp(payload);
    return await interaction.reply(payload);
  } catch {
    return null;
  }
}
async function safeEdit(interaction, payload) {
  try {
    return await interaction.editReply(payload);
  } catch {
    return null;
  }
}
function hasManageGuild(interaction) {
  try {
    return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
  } catch {
    return false;
  }
}
function hasManageMessages(interaction) {
  try {
    return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages));
  } catch {
    return false;
  }
}

const guildSettings = new Map();
function getSettings(guildId) {
  return (
    guildSettings.get(guildId) || {
      log_channel_id: null,
      ticket_category_id: null,
      ticket_counter: 0,
      ticket_staff_role_id: null,
      bug_input_channel_id: null,
      bug_board_channel_id: null,
      bug_board_message_id: null,
      bug_updates_channel_id: null,
    }
  );
}
function setSettings(guildId, patch) {
  const merged = { ...getSettings(guildId), ...patch };
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
  } catch {}
}

const tickets = new Map();
function nextTicketNumber(guildId) {
  const s = getSettings(guildId);
  const next = (Number(s.ticket_counter) || 0) + 1;
  setSettings(guildId, { ticket_counter: next });
  return next;
}
async function getMeMember(guild) {
  const cached = guild.members.me;
  if (cached) return cached;
  return await guild.members.fetchMe().catch(() => null);
}
async function findOrCreateTicketCategory(guild) {
  const s = getSettings(guild.id);
  if (s.ticket_category_id) {
    const existing = await guild.channels.fetch(s.ticket_category_id).catch(() => null);
    if (existing && existing.type === ChannelType.GuildCategory) return existing;
  }
  const created = await guild.channels
    .create({ name: "Tickets", type: ChannelType.GuildCategory, reason: "Auto-created ticket category" })
    .catch(() => null);
  if (created) {
    setSettings(guild.id, { ticket_category_id: created.id });
    return created;
  }
  return null;
}
function getTicket(channelId) {
  return tickets.get(channelId) || null;
}
function isTicketStaffMember(guild, member) {
  const s = getSettings(guild.id);
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  if (s.ticket_staff_role_id && member.roles?.cache?.has(s.ticket_staff_role_id)) return true;
  return false;
}
function canManageTicket(guild, member, ticket) {
  if (!member || !ticket) return false;
  if (isTicketStaffMember(guild, member)) return true;
  if (ticket.ownerId === member.id) return true;
  if (ticket.assignedStaffIds?.has(member.id)) return true;
  return false;
}
async function grantTicketAccess(channel, userId) {
  await channel.permissionOverwrites
    .edit(userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    })
    .catch(() => null);
}
async function revokeTicketAccess(channel, userId) {
  await channel.permissionOverwrites.delete(userId).catch(() => null);
}
async function createTicketChannel(guild, ownerMember, reasonText) {
  const category = await findOrCreateTicketCategory(guild);
  const s = getSettings(guild.id);
  const num = nextTicketNumber(guild.id);
  const channelName = `ticket-${String(num).padStart(4, "0")}`;

  const me = await getMeMember(guild);
  if (!me) throw new Error("Bot member not found in guild.");

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
      id: me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    },
  ];

  if (s.ticket_staff_role_id) {
    overwrites.push({
      id: s.ticket_staff_role_id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    });
  }

  const ch = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category?.id || undefined,
    permissionOverwrites: overwrites,
    reason: `Ticket created by ${safeUserTag(ownerMember.user)}`,
  });

  const t = {
    guildId: guild.id,
    ownerId: ownerMember.id,
    status: "open",
    createdAtMs: nowMs(),
    closedAtMs: 0,
    assignedStaffIds: new Set(),
    addedUserIds: new Set(),
  };
  tickets.set(ch.id, t);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🎫 Support Ticket Created")
    .setDescription(
      [
        `**Owner:** <@${ownerMember.id}>`,
        reasonText ? `**Reason:** ${clampText(reasonText, 900)}` : null,
        "",
        "A staff member will assist you here.",
        "Use **/ticket close** when finished.",
      ]
        .filter(Boolean)
        .join("\n")
    )
    .setTimestamp(new Date());

  const staffPing = s.ticket_staff_role_id ? `<@&${s.ticket_staff_role_id}>` : "";
  await ch
    .send({
      content: [staffPing, `<@${ownerMember.id}>`].filter(Boolean).join(" "),
      embeds: [embed],
      allowedMentions: { users: [ownerMember.id], roles: s.ticket_staff_role_id ? [s.ticket_staff_role_id] : [] },
    })
    .catch(() => null);

  await sendLog(
    guild,
    new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("✅ Ticket Created")
      .setDescription(`**Channel:** <#${ch.id}>\n**Owner:** <@${ownerMember.id}>`)
      .setTimestamp(new Date())
  );

  return ch;
}
async function closeTicketChannel(guild, channel, closedById) {
  const ticket = getTicket(channel.id);
  if (!ticket || ticket.guildId !== guild.id || ticket.status !== "open") {
    return { ok: false, reason: "This channel is not an open ticket." };
  }

  ticket.status = "closed";
  ticket.closedAtMs = nowMs();

  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🔒 Ticket Closed")
    .setDescription("This channel will be deleted in **10 seconds**.")
    .setTimestamp(new Date());

  await channel.send({ embeds: [embed] }).catch(() => null);

  await sendLog(
    guild,
    new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle("🔒 Ticket Closed")
      .setDescription(`**Channel:** <#${channel.id}>\n**Closed by:** <@${closedById}>`)
      .setTimestamp(new Date())
  );

  setTimeout(() => channel.delete("Ticket closed").catch(() => null), 10_000);
  return { ok: true };
}
async function buildTicketTranscript(channel, limit = 200) {
  const fetched = await channel.messages.fetch({ limit }).catch(() => null);
  if (!fetched) return "Transcript unavailable (missing permissions).";
  const msgs = Array.from(fetched.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const lines = [];
  for (const m of msgs) {
    const time = new Date(m.createdTimestamp).toISOString();
    const author = m.author ? safeUserTag(m.author) : "unknown";
    const content = (m.content || "").replace(/\r/g, "");
    const attachments = [...m.attachments.values()].map((a) => a.url);
    lines.push(`[${time}] ${author}: ${content}`);
    if (attachments.length) for (const url of attachments.slice(0, 10)) lines.push(`  attachment: ${url}`);
  }
  return lines.join("\n");
}

const vouchStore = new Map();
function getVouchData(guildId) {
  if (!vouchStore.has(guildId)) vouchStore.set(guildId, { counter: 0, items: [] });
  return vouchStore.get(guildId);
}
function addVouch(guildId, voucherId, vouchedId, message) {
  const store = getVouchData(guildId);
  const id = ++store.counter;
  store.items.push({
    id,
    voucherId,
    vouchedId,
    message: String(message || "").slice(0, 900),
    createdAtMs: nowMs(),
  });
  return id;
}
function getVouchStats(guildId, userId) {
  const store = getVouchData(guildId);
  const received = store.items.filter((v) => v.vouchedId === userId);
  const given = store.items.filter((v) => v.voucherId === userId);
  return { received, given, total: store.items.length };
}
function removeVouchById(guildId, vouchId) {
  const store = getVouchData(guildId);
  const idx = store.items.findIndex((v) => v.id === Number(vouchId));
  if (idx === -1) return null;
  const removed = store.items[idx];
  store.items.splice(idx, 1);
  return removed;
}
function topVouched(guildId, limit = 10) {
  const store = getVouchData(guildId);
  const counts = new Map();
  for (const v of store.items) counts.set(v.vouchedId, (counts.get(v.vouchedId) || 0) + 1);
  return Array.from(counts.entries())
    .map(([userId, count]) => ({ userId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

const bugStore = new Map();
const BUG_STATUSES = ["OPEN", "IN_PROGRESS", "WAITING", "CANT_FIX", "CANT_REPRODUCE", "RESOLVED"];

function getBugStore(guildId) {
  if (!bugStore.has(guildId)) bugStore.set(guildId, { counter: 0, items: new Map() });
  return bugStore.get(guildId);
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
function createBug(guildId, reporterId, title, description, sourceChannelId, sourceMessageId) {
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
    sourceChannelId: sourceChannelId || null,
    sourceMessageId: sourceMessageId || null,
    sourceMessageUrl:
      sourceChannelId && sourceMessageId ? makeMessageLink(guildId, sourceChannelId, sourceMessageId) : null,
    assignedToId: null,
    lastNote: "",
    comments: [],
  };

  store.items.set(id, item);
  return item;
}
function getBug(guildId, id) {
  return getBugStore(guildId).items.get(Number(id)) || null;
}
function setBugStatus(guildId, id, status, assignedToId, note) {
  const bug = getBug(guildId, id);
  if (!bug) return null;
  bug.status = status;
  bug.updatedAtMs = nowMs();
  if (assignedToId !== undefined) bug.assignedToId = assignedToId;
  if (note) bug.lastNote = String(note).slice(0, 900);
  return bug;
}
function addBugComment(guildId, id, byId, text) {
  const bug = getBug(guildId, id);
  if (!bug) return null;
  const t = String(text || "").trim();
  if (!t) return null;
  bug.comments.push({ byId, text: t.slice(0, 900), atMs: nowMs() });
  bug.updatedAtMs = nowMs();
  return bug;
}
function reopenBug(guildId, id, note) {
  const bug = getBug(guildId, id);
  if (!bug) return null;
  bug.status = "OPEN";
  bug.updatedAtMs = nowMs();
  if (note) bug.lastNote = String(note).slice(0, 900);
  return bug;
}
function buildBugCardLine(bug) {
  const link = bug.sourceMessageUrl ? bug.sourceMessageUrl : "(no link)";
  const assigned = bug.assignedToId ? ` • <@${bug.assignedToId}>` : "";
  return `${bugStatusEmoji(bug.status)} **#${bug.id}** ${clampText(bug.title, 60)} — **${bug.status}**${assigned}\n↳ ${link}`;
}
function buildBugBoardEmbed(guildId) {
  const store = getBugStore(guildId);
  const all = Array.from(store.items.values()).sort((a, b) => b.id - a.id);

  const open = all.filter((b) => b.status !== "RESOLVED");
  const resolved = all.filter((b) => b.status === "RESOLVED");

  const show = all.slice(0, 20);
  const lines = show.length ? show.map(buildBugCardLine) : ["No bug reports yet."];

  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("🐞 Bug Board")
    .setDescription(
      [
        `**Open:** ${open.length} • **Resolved:** ${resolved.length} • **Total:** ${all.length}`,
        "",
        ...lines,
        "",
        `**Message content capture:** ${RUNTIME_MESSAGE_CONTENT_INTENT ? "ON" : "OFF"}`,
      ].join("\n")
    )
    .setTimestamp(new Date());
}
const BUG_BOARD_REFRESH = "bug_board_refresh";
const BUG_BOARD_STATUS_PREFIX = "bug_board_status:";
const BUG_BOARD_COMMENT = "bug_board_comment";
const BUG_BOARD_REOPEN = "bug_board_reopen";
const BUG_BOARD_VIEW = "bug_board_view";

const MODAL_BUG_STATUS_PREFIX = "modal_bug_status:";
const MODAL_BUG_COMMENT = "modal_bug_comment";
const MODAL_BUG_REOPEN = "modal_bug_reopen";
const MODAL_BUG_VIEW = "modal_bug_view";

function buildBugBoardComponents() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BUG_BOARD_REFRESH).setLabel("Refresh").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${BUG_BOARD_STATUS_PREFIX}OPEN`).setLabel("Set OPEN").setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${BUG_BOARD_STATUS_PREFIX}IN_PROGRESS`)
      .setLabel("Set IN_PROGRESS")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${BUG_BOARD_STATUS_PREFIX}WAITING`)
      .setLabel("Set WAITING")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${BUG_BOARD_STATUS_PREFIX}RESOLVED`)
      .setLabel("Set RESOLVED")
      .setStyle(ButtonStyle.Success)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BUG_BOARD_VIEW).setLabel("View Bug").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(BUG_BOARD_COMMENT).setLabel("Add Comment").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(BUG_BOARD_REOPEN).setLabel("Reopen").setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2];
}
async function ensureBugBoardMessage(guild) {
  const s = getSettings(guild.id);
  if (!s.bug_board_channel_id) return null;

  const ch = await guild.channels.fetch(s.bug_board_channel_id).catch(() => null);
  if (!ch || !ch.isTextBased()) return null;

  if (s.bug_board_message_id) {
    const msg = await ch.messages.fetch(s.bug_board_message_id).catch(() => null);
    if (msg) return msg;
  }

  const created = await ch
    .send({ embeds: [buildBugBoardEmbed(guild.id)], components: buildBugBoardComponents() })
    .catch(() => null);
  if (!created) return null;

  setSettings(guild.id, { bug_board_message_id: created.id });
  return created;
}
async function refreshBugBoard(guild) {
  const msg = await ensureBugBoardMessage(guild);
  if (!msg) return false;
  await msg.edit({ embeds: [buildBugBoardEmbed(guild.id)], components: buildBugBoardComponents() }).catch(() => null);
  return true;
}
async function announceBugUpdate(guild, bug, changedById, extraText) {
  const s = getSettings(guild.id);
  const targetChannelId = s.bug_updates_channel_id || s.bug_board_channel_id || s.bug_input_channel_id;
  if (!targetChannelId) return;

  const ch = await guild.channels.fetch(targetChannelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setColor(bug.status === "RESOLVED" ? 0x57f287 : 0x5865f2)
    .setTitle(`🐞 Bug #${bug.id} Updated`)
    .setDescription(
      [
        `**Status:** ${bugStatusEmoji(bug.status)} **${bug.status}**`,
        `**Changed by:** <@${changedById}>`,
        bug.assignedToId ? `**Assigned:** <@${bug.assignedToId}>` : null,
        bug.lastNote ? `**Note:** ${clampText(bug.lastNote, 900)}` : null,
        extraText ? `**Update:** ${clampText(extraText, 900)}` : null,
        bug.sourceMessageUrl ? `**Link:** ${bug.sourceMessageUrl}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    )
    .setTimestamp(new Date());

  const tagReporter = bug.status === "RESOLVED";
  await ch
    .send({
      content: tagReporter ? `<@${bug.reporterId}> Your report **#${bug.id}** was marked **RESOLVED** ✅` : undefined,
      allowedMentions: { users: tagReporter ? [bug.reporterId] : [] },
      embeds: [embed],
    })
    .catch(() => null);
}
function bugFromMessage(message) {
  const content = String(message.content || "").trim();
  const attachments = [...message.attachments.values()].map((a) => a.url).slice(0, 5);
  const title = content ? content.split("\n")[0].slice(0, 100) : "Bug report";
  const desc = content ? content.slice(0, 900) : "(Message content not available.)";
  const extra = attachments.length ? `\n\nAttachments:\n${attachments.map((u) => `- ${u}`).join("\n")}` : "";
  return { title, description: `${desc}${extra}` };
}

const PANEL_TICKET_CREATE = "panel_ticket_create";
const PANEL_BUG_REPORT = "panel_bug_report";
const PANEL_BUG_BOARD = "panel_bug_board";
const PANEL_MY_VOUCHES = "panel_my_vouches";
const PANEL_TOP_VOUCHES = "panel_top_vouches";
const MODAL_BUG_REPORT = "modal_bug_report";

function buildPanelEmbed(guild) {
  const s = getSettings(guild.id);
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🌌 AuroraHud Support")
    .setDescription(
      [
        "Use the buttons below to open tickets, report bugs, or check reputation.",
        "",
        `**Ticket Staff Role:** ${s.ticket_staff_role_id ? `<@&${s.ticket_staff_role_id}>` : "(not set)"}`,
        `**Bug Input Channel:** ${s.bug_input_channel_id ? `<#${s.bug_input_channel_id}>` : "(not set)"}`,
        `**Bug Board Channel:** ${s.bug_board_channel_id ? `<#${s.bug_board_channel_id}>` : "(not set)"}`,
        "",
        "Public commands:",
        "• `/vouch @user [message]`",
        "• `/checkvouch [@user]`",
        "• `/topvouches`",
      ].join("\n")
    )
    .setTimestamp(new Date());
}
function buildPanelComponents() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PANEL_TICKET_CREATE).setLabel("Create Ticket").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(PANEL_BUG_REPORT).setLabel("Report Bug").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(PANEL_BUG_BOARD).setLabel("Bug Board").setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PANEL_MY_VOUCHES).setLabel("My Vouches").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(PANEL_TOP_VOUCHES).setLabel("Top Vouches").setStyle(ButtonStyle.Secondary)
  );
  return [row1, row2];
}

function createDiscordClient(messageContent) {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
  if (messageContent) intents.push(GatewayIntentBits.MessageContent);
  return new Client({
    intents,
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
  });
}

let client = null;
let intentsFallbackUsed = false;

const bugStatusChoices = BUG_STATUSES.map((s) => ({ name: s, value: s }));

const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Pong + latency."),

  new SlashCommandBuilder().setName("settings").setDescription("Show server settings."),

  new SlashCommandBuilder()
    .setName("setlog")
    .setDescription("Set the logs channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName("channel").setDescription("Logs channel").setRequired(true)),

  new SlashCommandBuilder()
    .setName("setticketstaffrole")
    .setDescription("Set the staff role that can view and manage tickets.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addRoleOption((o) => o.setName("role").setDescription("Staff role").setRequired(true)),

  new SlashCommandBuilder()
    .setName("clearticketstaffrole")
    .setDescription("Clear the ticket staff role.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("setbugchannels")
    .setDescription("Configure bug channels (input + board + optional updates).")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName("input").setDescription("Bug Input Channel").setRequired(true))
    .addChannelOption((o) => o.setName("board").setDescription("Bug Board Channel").setRequired(true))
    .addChannelOption((o) => o.setName("updates").setDescription("Bug Updates Channel (optional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Post the support panel in this channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Ticket commands.")
    .addSubcommand((s) =>
      s
        .setName("create")
        .setDescription("Create a ticket.")
        .addStringOption((o) => o.setName("reason").setDescription("Reason (optional)").setRequired(false))
    )
    .addSubcommand((s) => s.setName("close").setDescription("Close the current ticket channel."))
    .addSubcommand((s) =>
      s
        .setName("info")
        .setDescription("Show ticket details (owner, status, assigned).")
    )
    .addSubcommand((s) =>
      s
        .setName("add")
        .setDescription("Add a user to this ticket (staff).")
        .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName("remove")
        .setDescription("Remove a user from this ticket (staff).")
        .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
    )
    .addSubcommand((s) => s.setName("claim").setDescription("Claim this ticket (staff)."))
    .addSubcommand((s) =>
      s
        .setName("assign")
        .setDescription("Assign a staff member to this ticket (staff).")
        .addUserOption((o) => o.setName("user").setDescription("Staff member").setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName("unassign")
        .setDescription("Unassign a staff member from this ticket (staff).")
        .addUserOption((o) => o.setName("user").setDescription("Staff member").setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName("transcript")
        .setDescription("Export a transcript for this ticket.")
        .addIntegerOption((o) =>
          o.setName("limit").setDescription("Messages (10-200)").setRequired(false).setMinValue(10).setMaxValue(200)
        )
    ),

  new SlashCommandBuilder()
    .setName("vouch")
    .setDescription("Vouch for a user (public).")
    .addUserOption((o) => o.setName("user").setDescription("User to vouch").setRequired(true))
    .addStringOption((o) => o.setName("message").setDescription("Message (optional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("checkvouch")
    .setDescription("Check vouches for a user (public).")
    .addUserOption((o) => o.setName("user").setDescription("User (optional)").setRequired(false)),

  new SlashCommandBuilder().setName("topvouches").setDescription("Show the most vouched users (public)."),

  new SlashCommandBuilder()
    .setName("vouchremove")
    .setDescription("Remove a vouch by ID (voucher or Manage Server).")
    .addIntegerOption((o) => o.setName("id").setDescription("Vouch ID").setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName("bug")
    .setDescription("Bug tools.")
    .addSubcommand((s) => s.setName("board").setDescription("Refresh bug board (Manage Server)."))
    .addSubcommand((s) =>
      s
        .setName("view")
        .setDescription("View a bug by ID.")
        .addIntegerOption((o) => o.setName("id").setDescription("Bug ID").setRequired(true).setMinValue(1))
    )
    .addSubcommand((s) => s.setName("list").setDescription("List recent bugs (last 10)."))
    .addSubcommand((s) =>
      s
        .setName("search")
        .setDescription("Search bugs by keyword.")
        .addStringOption((o) => o.setName("query").setDescription("Keyword").setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName("status")
        .setDescription("Update bug status (Manage Server).")
        .addIntegerOption((o) => o.setName("id").setDescription("Bug ID").setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName("status").setDescription("New status").setRequired(true).addChoices(...bugStatusChoices))
        .addUserOption((o) => o.setName("assign").setDescription("Assign to (optional)").setRequired(false))
        .addStringOption((o) => o.setName("note").setDescription("Note (optional)").setRequired(false))
    )
    .addSubcommand((s) =>
      s
        .setName("comment")
        .setDescription("Add a comment to a bug (Manage Server).")
        .addIntegerOption((o) => o.setName("id").setDescription("Bug ID").setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName("text").setDescription("Comment").setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName("reopen")
        .setDescription("Reopen a bug (Manage Server).")
        .addIntegerOption((o) => o.setName("id").setDescription("Bug ID").setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName("note").setDescription("Note (optional)").setRequired(false))
    ),

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

function wireClientEvents(c) {
  c.once("ready", () => {
    console.log(`[DISCORD] Logged in as ${c.user.tag}`);
    console.log(`[DISCORD] MessageContentIntent=${RUNTIME_MESSAGE_CONTENT_INTENT ? "ON" : "OFF"}`);
  });

  c.on("messageCreate", async (message) => {
    try {
      if (!message.guild) return;
      if (message.author?.bot) return;

      const s = getSettings(message.guild.id);
      if (!s.bug_input_channel_id) return;
      if (message.channel.id !== s.bug_input_channel_id) return;

      const parsed = bugFromMessage(message);
      const bug = createBug(message.guild.id, message.author.id, parsed.title, parsed.description, message.channel.id, message.id);

      message.react("✅").catch(() => null);

      const ackEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("✅ Bug Saved")
        .setDescription(
          [
            `**ID:** #${bug.id}`,
            `**Reporter:** <@${message.author.id}>`,
            `**Title:** ${clampText(bug.title, 100)}`,
            bug.sourceMessageUrl ? `**Link:** ${bug.sourceMessageUrl}` : null,
          ]
            .filter(Boolean)
            .join("\n")
        )
        .setTimestamp(new Date());

      await message.reply({ embeds: [ackEmbed], allowedMentions: { users: [message.author.id] } }).catch(() => null);

      await refreshBugBoard(message.guild).catch(() => null);

      await sendLog(
        message.guild,
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("🐞 Bug Saved")
          .setDescription(`**Bug:** #${bug.id}\n**Reporter:** <@${message.author.id}>\n**Channel:** <#${message.channel.id}>`)
          .setTimestamp(new Date())
      );
    } catch (e) {
      console.error("[BUG READER ERROR]", e);
    }
  });

  c.on("interactionCreate", async (interaction) => {
    const guild = interaction.guild;

    if (interaction.isButton()) {
      if (!guild) return;

      if (interaction.customId === PANEL_TICKET_CREATE) {
        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) return safeReply(interaction, { content: "Could not fetch your member.", ephemeral: true });

        const ch = await createTicketChannel(guild, member, "Created via panel");
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("🎫 Ticket Created")
          .setDescription(`Your ticket is ready: <#${ch.id}>`)
          .setTimestamp(new Date());

        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }

      if (interaction.customId === PANEL_BUG_BOARD) {
        const s = getSettings(guild.id);
        if (!s.bug_board_channel_id) {
          const embed = new EmbedBuilder()
            .setColor(0xed4245)
            .setTitle("Bug Board Not Configured")
            .setDescription("Ask an admin to run **/setbugchannels**.")
            .setTimestamp(new Date());
          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }
        const link = `https://discord.com/channels/${guild.id}/${s.bug_board_channel_id}`;
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("🐞 Bug Board")
          .setDescription(`Open the board here:\n${link}`)
          .setTimestamp(new Date());
        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }

      if (interaction.customId === PANEL_MY_VOUCHES) {
        const stats = getVouchStats(guild.id, interaction.user.id);
        const received = stats.received.slice().sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 10);
        const lines =
          received.length > 0
            ? received.map((v) => `**#${v.id}** • <@${v.voucherId}> — ${v.message ? clampText(v.message, 120) : "_(no message)_"}`)
            : ["No vouches yet."];

        const embed = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("⭐ My Vouches")
          .setDescription([`**Received:** ${stats.received.length}`, `**Given:** ${stats.given.length}`, "", ...lines].join("\n"))
          .setTimestamp(new Date());

        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }

      if (interaction.customId === PANEL_TOP_VOUCHES) {
        const top = topVouched(guild.id, 10);
        const lines = top.length ? top.map((r, i) => `**${i + 1}.** <@${r.userId}> — **${r.count}**`) : ["No vouches yet."];
        const embed = new EmbedBuilder().setColor(0xfee75c).setTitle("🏆 Top Vouches").setDescription(lines.join("\n")).setTimestamp(new Date());
        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }

      if (interaction.customId === PANEL_BUG_REPORT) {
        const s = getSettings(guild.id);
        if (!s.bug_input_channel_id) {
          const embed = new EmbedBuilder()
            .setColor(0xed4245)
            .setTitle("Bug Channels Not Configured")
            .setDescription("Ask an admin to run **/setbugchannels**.")
            .setTimestamp(new Date());
          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }

        const modal = new ModalBuilder().setCustomId(MODAL_BUG_REPORT).setTitle("Report a Bug");

        const title = new TextInputBuilder()
          .setCustomId("title")
          .setLabel("Bug title")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100);

        const desc = new TextInputBuilder()
          .setCustomId("description")
          .setLabel("Steps / expected / actual")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000);

        modal.addComponents(new ActionRowBuilder().addComponents(title), new ActionRowBuilder().addComponents(desc));
        return interaction.showModal(modal).catch(() => null);
      }

      if (interaction.customId === BUG_BOARD_REFRESH) {
        if (!hasManageGuild(interaction)) return safeReply(interaction, { content: "Manage Server required.", ephemeral: true });
        await refreshBugBoard(guild).catch(() => null);
        const embed = new EmbedBuilder().setColor(0x57f287).setTitle("✅ Bug Board Refreshed").setTimestamp(new Date());
        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }

      if (interaction.customId.startsWith(BUG_BOARD_STATUS_PREFIX)) {
        if (!hasManageGuild(interaction)) return safeReply(interaction, { content: "Manage Server required.", ephemeral: true });
        const status = interaction.customId.split(":")[1];
        if (!BUG_STATUSES.includes(status)) return safeReply(interaction, { content: "Invalid status.", ephemeral: true });

        const modal = new ModalBuilder().setCustomId(`${MODAL_BUG_STATUS_PREFIX}${status}`).setTitle(`Set Status: ${status}`);

        const idInput = new TextInputBuilder()
          .setCustomId("id")
          .setLabel("Bug ID (number)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(12);

        const assignInput = new TextInputBuilder()
          .setCustomId("assign")
          .setLabel("Assign to (optional: @mention or user ID)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(40);

        const noteInput = new TextInputBuilder()
          .setCustomId("note")
          .setLabel("Note (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(900);

        modal.addComponents(
          new ActionRowBuilder().addComponents(idInput),
          new ActionRowBuilder().addComponents(assignInput),
          new ActionRowBuilder().addComponents(noteInput)
        );

        return interaction.showModal(modal).catch(() => null);
      }

      if (interaction.customId === BUG_BOARD_COMMENT) {
        if (!hasManageGuild(interaction)) return safeReply(interaction, { content: "Manage Server required.", ephemeral: true });

        const modal = new ModalBuilder().setCustomId(MODAL_BUG_COMMENT).setTitle("Add Bug Comment");

        const idInput = new TextInputBuilder()
          .setCustomId("id")
          .setLabel("Bug ID (number)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(12);

        const textInput = new TextInputBuilder()
          .setCustomId("text")
          .setLabel("Comment")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(900);

        modal.addComponents(new ActionRowBuilder().addComponents(idInput), new ActionRowBuilder().addComponents(textInput));
        return interaction.showModal(modal).catch(() => null);
      }

      if (interaction.customId === BUG_BOARD_REOPEN) {
        if (!hasManageGuild(interaction)) return safeReply(interaction, { content: "Manage Server required.", ephemeral: true });

        const modal = new ModalBuilder().setCustomId(MODAL_BUG_REOPEN).setTitle("Reopen Bug");

        const idInput = new TextInputBuilder()
          .setCustomId("id")
          .setLabel("Bug ID (number)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(12);

        const noteInput = new TextInputBuilder()
          .setCustomId("note")
          .setLabel("Note (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(900);

        modal.addComponents(new ActionRowBuilder().addComponents(idInput), new ActionRowBuilder().addComponents(noteInput));
        return interaction.showModal(modal).catch(() => null);
      }

      if (interaction.customId === BUG_BOARD_VIEW) {
        const modal = new ModalBuilder().setCustomId(MODAL_BUG_VIEW).setTitle("View Bug");

        const idInput = new TextInputBuilder()
          .setCustomId("id")
          .setLabel("Bug ID (number)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(12);

        modal.addComponents(new ActionRowBuilder().addComponents(idInput));
        return interaction.showModal(modal).catch(() => null);
      }
    }

    if (interaction.isModalSubmit()) {
      if (!guild) return;

      if (interaction.customId === MODAL_BUG_REPORT) {
        const s = getSettings(guild.id);
        if (!s.bug_input_channel_id) {
          const embed = new EmbedBuilder()
            .setColor(0xed4245)
            .setTitle("Bug Channels Not Configured")
            .setDescription("Ask an admin to run **/setbugchannels**.")
            .setTimestamp(new Date());
          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }

        const title = interaction.fields.getTextInputValue("title");
        const description = interaction.fields.getTextInputValue("description");

        const bugChannel = await guild.channels.fetch(s.bug_input_channel_id).catch(() => null);
        if (!bugChannel || !bugChannel.isTextBased()) {
          const embed = new EmbedBuilder().setColor(0xed4245).setTitle("Bug Channel Invalid").setTimestamp(new Date());
          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }

        const posted = await bugChannel
          .send({
            embeds: [
              new EmbedBuilder()
                .setColor(0xfee75c)
                .setTitle("🐞 Bug Report")
                .setDescription([`**From:** <@${interaction.user.id}>`, `**Title:** ${clampText(title, 200)}`, "", clampText(description, 1500)].join("\n"))
                .setTimestamp(new Date()),
            ],
            allowedMentions: { users: [interaction.user.id] },
          })
          .catch(() => null);

        if (!posted) {
          const embed = new EmbedBuilder().setColor(0xed4245).setTitle("Failed to Post Bug Report").setTimestamp(new Date());
          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }

        const bug = createBug(guild.id, interaction.user.id, title, description, posted.channel.id, posted.id);
        await refreshBugBoard(guild).catch(() => null);

        const embed = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("✅ Bug Saved")
          .setDescription([`**ID:** #${bug.id}`, bug.sourceMessageUrl ? `**Link:** ${bug.sourceMessageUrl}` : null].filter(Boolean).join("\n"))
          .setTimestamp(new Date());

        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }

      if (interaction.customId.startsWith(MODAL_BUG_STATUS_PREFIX)) {
        if (!hasManageGuild(interaction)) return safeReply(interaction, { content: "Manage Server required.", ephemeral: true });

        const status = interaction.customId.split(":")[1];
        if (!BUG_STATUSES.includes(status)) return safeReply(interaction, { content: "Invalid status.", ephemeral: true });

        const idRaw = interaction.fields.getTextInputValue("id");
        const id = Number(String(idRaw || "").trim());
        if (!Number.isFinite(id) || id <= 0) return safeReply(interaction, { content: "Invalid Bug ID.", ephemeral: true });

        const assignRaw = interaction.fields.getTextInputValue("assign");
        const note = interaction.fields.getTextInputValue("note") || "";

        let assignedId = undefined;
        if (String(assignRaw || "").trim()) {
          const parsed = parseUserId(assignRaw);
          if (!parsed) return safeReply(interaction, { content: "Invalid assign value. Use @mention or user ID.", ephemeral: true });
          assignedId = parsed;
        }

        const updated = setBugStatus(guild.id, id, status, assignedId, note);
        if (!updated) return safeReply(interaction, { content: `Bug #${id} not found.`, ephemeral: true });

        await refreshBugBoard(guild).catch(() => null);
        await announceBugUpdate(guild, updated, interaction.user.id).catch(() => null);

        const embed = new EmbedBuilder()
          .setColor(status === "RESOLVED" ? 0x57f287 : 0x5865f2)
          .setTitle("✅ Bug Updated")
          .setDescription(
            [
              `**Bug:** #${updated.id}`,
              `**Status:** ${bugStatusEmoji(updated.status)} ${updated.status}`,
              updated.assignedToId ? `**Assigned:** <@${updated.assignedToId}>` : null,
              updated.lastNote ? `**Note:** ${clampText(updated.lastNote, 900)}` : null,
            ]
              .filter(Boolean)
              .join("\n")
          )
          .setTimestamp(new Date());

        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }

      if (interaction.customId === MODAL_BUG_COMMENT) {
        if (!hasManageGuild(interaction)) return safeReply(interaction, { content: "Manage Server required.", ephemeral: true });

        const idRaw = interaction.fields.getTextInputValue("id");
        const id = Number(String(idRaw || "").trim());
        if (!Number.isFinite(id) || id <= 0) return safeReply(interaction, { content: "Invalid Bug ID.", ephemeral: true });

        const text = interaction.fields.getTextInputValue("text");
        const updated = addBugComment(guild.id, id, interaction.user.id, text);
        if (!updated) return safeReply(interaction, { content: `Bug #${id} not found.`, ephemeral: true });

        await refreshBugBoard(guild).catch(() => null);
        await announceBugUpdate(guild, updated, interaction.user.id, "Comment added").catch(() => null);

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("💬 Comment Added")
          .setDescription(`**Bug:** #${updated.id}\n**By:** <@${interaction.user.id}>\n**Text:** ${clampText(text, 900)}`)
          .setTimestamp(new Date());

        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }

      if (interaction.customId === MODAL_BUG_REOPEN) {
        if (!hasManageGuild(interaction)) return safeReply(interaction, { content: "Manage Server required.", ephemeral: true });

        const idRaw = interaction.fields.getTextInputValue("id");
        const id = Number(String(idRaw || "").trim());
        if (!Number.isFinite(id) || id <= 0) return safeReply(interaction, { content: "Invalid Bug ID.", ephemeral: true });

        const note = interaction.fields.getTextInputValue("note") || "";
        const updated = reopenBug(guild.id, id, note);
        if (!updated) return safeReply(interaction, { content: `Bug #${id} not found.`, ephemeral: true });

        await refreshBugBoard(guild).catch(() => null);
        await announceBugUpdate(guild, updated, interaction.user.id, "Bug reopened").catch(() => null);

        const embed = new EmbedBuilder()
          .setColor(0xfee75c)
          .setTitle("♻️ Bug Reopened")
          .setDescription(
            [`**Bug:** #${updated.id}`, `**Status:** ${bugStatusEmoji(updated.status)} ${updated.status}`, note ? `**Note:** ${clampText(note, 900)}` : null]
              .filter(Boolean)
              .join("\n")
          )
          .setTimestamp(new Date());

        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }

      if (interaction.customId === MODAL_BUG_VIEW) {
        const idRaw = interaction.fields.getTextInputValue("id");
        const id = Number(String(idRaw || "").trim());
        if (!Number.isFinite(id) || id <= 0) return safeReply(interaction, { content: "Invalid Bug ID.", ephemeral: true });

        const bug = getBug(guild.id, id);
        if (!bug) return safeReply(interaction, { content: `Bug #${id} not found.`, ephemeral: true });

        const commentPreview = bug.comments.slice(-3).map((c) => `• <@${c.byId}>: ${clampText(c.text, 120)}`);

        const embed = new EmbedBuilder()
          .setColor(0xfee75c)
          .setTitle(`🐞 Bug #${bug.id} ${bugStatusEmoji(bug.status)} ${bug.status}`)
          .setDescription(
            [
              `**Title:** ${clampText(bug.title, 200)}`,
              `**Reporter:** <@${bug.reporterId}>`,
              bug.assignedToId ? `**Assigned:** <@${bug.assignedToId}>` : "**Assigned:** (none)",
              "",
              clampText(bug.description, 1500),
              "",
              bug.sourceMessageUrl ? `**Link:** ${bug.sourceMessageUrl}` : null,
              bug.lastNote ? `**Note:** ${clampText(bug.lastNote, 900)}` : null,
              bug.comments.length ? `**Comments (${bug.comments.length}):**` : null,
              bug.comments.length ? commentPreview.join("\n") : null,
            ]
              .filter(Boolean)
              .join("\n")
          )
          .setTimestamp(new Date(bug.updatedAtMs));

        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }
    }

    if (!interaction.isChatInputCommand()) return;
    if (!guild) return safeReply(interaction, { content: "This bot works in servers only.", ephemeral: true });

    try {
      if (interaction.commandName === "ping") {
        const sent = nowMs();
        await safeReply(interaction, { content: "Pong..." });
        return safeEdit(interaction, { content: `Pong (${nowMs() - sent}ms)` });
      }

      if (interaction.commandName === "settings") {
        const s = getSettings(guild.id);
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("⚙️ Server Settings")
          .setDescription(
            [
              `**Logs Channel:** ${s.log_channel_id ? `<#${s.log_channel_id}>` : "(not set)"}`,
              `**Ticket Category:** ${s.ticket_category_id ? `<#${s.ticket_category_id}>` : "(auto)"}`,
              `**Ticket Staff Role:** ${s.ticket_staff_role_id ? `<@&${s.ticket_staff_role_id}>` : "(not set)"}`,
              "",
              `**Bug Input:** ${s.bug_input_channel_id ? `<#${s.bug_input_channel_id}>` : "(not set)"}`,
              `**Bug Board:** ${s.bug_board_channel_id ? `<#${s.bug_board_channel_id}>` : "(not set)"}`,
              `**Bug Updates:** ${s.bug_updates_channel_id ? `<#${s.bug_updates_channel_id}>` : "(not set)"}`,
              "",
              `**Message Content Intent:** ${RUNTIME_MESSAGE_CONTENT_INTENT ? "ON" : "OFF"}`,
            ].join("\n")
          )
          .setTimestamp(new Date());

        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }

      if (interaction.commandName === "setlog") {
        const channel = interaction.options.getChannel("channel", true);
        if (!channel.isTextBased()) return safeReply(interaction, { content: "Channel must be text-based.", ephemeral: true });

        setSettings(guild.id, { log_channel_id: channel.id });
        const embed = new EmbedBuilder().setColor(0x57f287).setTitle("✅ Logs Channel Set").setDescription(`${channel}`).setTimestamp(new Date());
        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }

      if (interaction.commandName === "setticketstaffrole") {
        const role = interaction.options.getRole("role", true);
        setSettings(guild.id, { ticket_staff_role_id: role.id });
        const embed = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("✅ Ticket Staff Role Set")
          .setDescription(`Staff role: <@&${role.id}>`)
          .setTimestamp(new Date());
        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }

      if (interaction.commandName === "clearticketstaffrole") {
        setSettings(guild.id, { ticket_staff_role_id: null });
        const embed = new EmbedBuilder().setColor(0xfee75c).setTitle("⚠️ Ticket Staff Role Cleared").setTimestamp(new Date());
        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }

      if (interaction.commandName === "setbugchannels") {
        const input = interaction.options.getChannel("input", true);
        const board = interaction.options.getChannel("board", true);
        const updates = interaction.options.getChannel("updates", false);

        if (!input.isTextBased()) return safeReply(interaction, { content: "Input must be text-based.", ephemeral: true });
        if (!board.isTextBased()) return safeReply(interaction, { content: "Board must be text-based.", ephemeral: true });
        if (updates && !updates.isTextBased()) return safeReply(interaction, { content: "Updates must be text-based.", ephemeral: true });

        setSettings(guild.id, {
          bug_input_channel_id: input.id,
          bug_board_channel_id: board.id,
          bug_updates_channel_id: updates ? updates.id : null,
          bug_board_message_id: null,
        });

        await refreshBugBoard(guild).catch(() => null);

        const embed = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("✅ Bug Channels Configured")
          .setDescription([`**Input:** ${input}`, `**Board:** ${board}`, `**Updates:** ${updates ? updates : "(not set)"}`].join("\n"))
          .setTimestamp(new Date());

        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }

      if (interaction.commandName === "panel") {
        await safeReply(interaction, { content: "Panel posted.", ephemeral: true });
        await interaction.channel
          .send({ embeds: [buildPanelEmbed(guild)], components: buildPanelComponents() })
          .catch(() => null);
        return;
      }

      if (interaction.commandName === "ticket") {
        const sub = interaction.options.getSubcommand(true);

        if (sub === "create") {
          const reason = interaction.options.getString("reason") || "";
          const member = await guild.members.fetch(interaction.user.id).catch(() => null);
          if (!member) return safeReply(interaction, { content: "Could not fetch your member.", ephemeral: true });

          const ch = await createTicketChannel(guild, member, reason);
          const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle("🎫 Ticket Created")
            .setDescription(`Open: <#${ch.id}>`)
            .setTimestamp(new Date());

          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }

        const channel = interaction.channel;
        if (!channel || channel.type !== ChannelType.GuildText) {
          return safeReply(interaction, { content: "Use this inside a ticket channel.", ephemeral: true });
        }

        const ticket = getTicket(channel.id);
        if (!ticket) return safeReply(interaction, { content: "This is not a ticket channel.", ephemeral: true });

        const member = await guild.members.fetch(interaction.user.id).catch(() => null);

        if (sub === "info") {
          if (!canManageTicket(guild, member, ticket)) return safeReply(interaction, { content: "No access to this ticket.", ephemeral: true });

          const assigned = [...ticket.assignedStaffIds.values()];
          const added = [...ticket.addedUserIds.values()];
          const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle("🎫 Ticket Info")
            .setDescription(
              [
                `**Owner:** <@${ticket.ownerId}>`,
                `**Status:** ${ticket.status === "open" ? "OPEN" : "CLOSED"}`,
                `**Created:** <t:${Math.floor(ticket.createdAtMs / 1000)}:R>`,
                assigned.length ? `**Assigned Staff:** ${assigned.map((id) => `<@${id}>`).join(", ")}` : "**Assigned Staff:** (none)",
                added.length ? `**Added Users:** ${added.map((id) => `<@${id}>`).join(", ")}` : "**Added Users:** (none)",
              ].join("\n")
            )
            .setTimestamp(new Date());

          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }

        if (sub === "close") {
          if (!canManageTicket(guild, member, ticket)) {
            return safeReply(interaction, { content: "You do not have permission to close this ticket.", ephemeral: true });
          }
          const result = await closeTicketChannel(guild, channel, interaction.user.id);
          if (!result.ok) return safeReply(interaction, { content: result.reason, ephemeral: true });
          return safeReply(interaction, { content: "Closing ticket...", ephemeral: true });
        }

        const staff = isTicketStaffMember(guild, member);
        if (!staff) return safeReply(interaction, { content: "Staff only.", ephemeral: true });

        if (sub === "add") {
          const user = interaction.options.getUser("user", true);
          if (user.bot) return safeReply(interaction, { content: "You cannot add a bot.", ephemeral: true });

          await grantTicketAccess(channel, user.id);
          ticket.addedUserIds.add(user.id);

          const embed = new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle("✅ User Added")
            .setDescription(`Added <@${user.id}> to this ticket.`)
            .setTimestamp(new Date());

          await channel.send({ embeds: [embed] }).catch(() => null);
          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }

        if (sub === "remove") {
          const user = interaction.options.getUser("user", true);

          await revokeTicketAccess(channel, user.id);
          ticket.addedUserIds.delete(user.id);
          ticket.assignedStaffIds.delete(user.id);

          const embed = new EmbedBuilder()
            .setColor(0xfee75c)
            .setTitle("⚠️ User Removed")
            .setDescription(
              [
                `Removed <@${user.id}> from this ticket.`,
                "If they still have access through a role overwrite, remove that role or adjust permissions.",
              ].join("\n")
            )
            .setTimestamp(new Date());

          await channel.send({ embeds: [embed] }).catch(() => null);
          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }

        if (sub === "claim") {
          ticket.assignedStaffIds.add(interaction.user.id);
          await grantTicketAccess(channel, interaction.user.id);

          const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle("🛡️ Ticket Claimed")
            .setDescription(`Claimed by <@${interaction.user.id}>`)
            .setTimestamp(new Date());

          await channel.send({ embeds: [embed] }).catch(() => null);
          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }

        if (sub === "assign") {
          const user = interaction.options.getUser("user", true);
          const m = await guild.members.fetch(user.id).catch(() => null);
          if (!m) return safeReply(interaction, { content: "Member not found.", ephemeral: true });
          if (!isTicketStaffMember(guild, m)) {
            return safeReply(interaction, { content: "That user is not staff (missing staff role / Manage Server).", ephemeral: true });
          }

          ticket.assignedStaffIds.add(user.id);
          await grantTicketAccess(channel, user.id);

          const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle("✅ Staff Assigned")
            .setDescription(`Assigned <@${user.id}> to this ticket.`)
            .setTimestamp(new Date());

          await channel.send({ embeds: [embed] }).catch(() => null);
          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }

        if (sub === "unassign") {
          const user = interaction.options.getUser("user", true);
          ticket.assignedStaffIds.delete(user.id);
          await revokeTicketAccess(channel, user.id);

          const embed = new EmbedBuilder()
            .setColor(0xfee75c)
            .setTitle("⚠️ Staff Unassigned")
            .setDescription(`Unassigned <@${user.id}> from this ticket.`)
            .setTimestamp(new Date());

          await channel.send({ embeds: [embed] }).catch(() => null);
          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }

        if (sub === "transcript") {
          const allowed = canManageTicket(guild, member, ticket);
          if (!allowed) return safeReply(interaction, { content: "No access to export this transcript.", ephemeral: true });

          const limit = interaction.options.getInteger("limit") || 200;
          await safeReply(interaction, { content: "Generating transcript...", ephemeral: true });

          const text = await buildTicketTranscript(channel, Math.min(200, Math.max(10, limit)));
          const file = new AttachmentBuilder(Buffer.from(text, "utf8"), { name: `ticket-${channel.id}-transcript.txt` });

          const embed = new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle("📄 Transcript Ready")
            .setDescription("Attached below.")
            .setTimestamp(new Date());

          return safeEdit(interaction, { embeds: [embed], files: [file], content: "" });
        }
      }

      if (interaction.commandName === "vouch") {
        const target = interaction.options.getUser("user", true);
        const msg = interaction.options.getString("message") || "";

        if (target.bot) return safeReply(interaction, { content: "You cannot vouch for a bot.", ephemeral: true });
        if (target.id === interaction.user.id) return safeReply(interaction, { content: "You cannot vouch for yourself.", ephemeral: true });

        const id = addVouch(guild.id, interaction.user.id, target.id, msg);
        const stats = getVouchStats(guild.id, target.id);

        const embed = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("⭐ Vouch Added")
          .setDescription(
            [
              `**Vouch ID:** #${id}`,
              `**From:** <@${interaction.user.id}>`,
              `**To:** <@${target.id}>`,
              msg ? `**Message:** ${clampText(msg, 900)}` : "**Message:** _(none)_",
              "",
              `**Total for <@${target.id}>:** ${stats.received.length}`,
            ].join("\n")
          )
          .setTimestamp(new Date());

        await sendLog(
          guild,
          new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle("Vouch Added")
            .setDescription(`**#${id}** • <@${interaction.user.id}> → <@${target.id}>`)
            .setTimestamp(new Date())
        );

        return safeReply(interaction, { embeds: [embed], allowedMentions: { users: [interaction.user.id, target.id] } });
      }

      if (interaction.commandName === "checkvouch") {
        const target = interaction.options.getUser("user") || interaction.user;
        const stats = getVouchStats(guild.id, target.id);
        const received = stats.received.slice().sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 10);

        const lines =
          received.length > 0
            ? received.map((v) => `**#${v.id}** • <@${v.voucherId}> — ${v.message ? clampText(v.message, 120) : "_(no message)_"}`
              )
            : ["No vouches yet."];

        const embed = new EmbedBuilder()
          .setColor(0xfee75c)
          .setTitle("📌 Vouch Profile")
          .setDescription(
            [
              `**User:** <@${target.id}>`,
              `**Received:** ${stats.received.length}`,
              `**Given:** ${stats.given.length}`,
              "",
              "**Latest 10 received:**",
              ...lines,
            ].join("\n")
          )
          .setTimestamp(new Date());

        return safeReply(interaction, { embeds: [embed] });
      }

      if (interaction.commandName === "topvouches") {
        const top = topVouched(guild.id, 10);
        const lines = top.length ? top.map((r, i) => `**${i + 1}.** <@${r.userId}> — **${r.count}**`) : ["No vouches yet."];

        const embed = new EmbedBuilder().setColor(0xfee75c).setTitle("🏆 Top Vouches").setDescription(lines.join("\n")).setTimestamp(new Date());
        return safeReply(interaction, { embeds: [embed] });
      }

      if (interaction.commandName === "vouchremove") {
        const id = interaction.options.getInteger("id", true);
        const store = getVouchData(guild.id);
        const entry = store.items.find((v) => v.id === id);
        if (!entry) return safeReply(interaction, { content: `Vouch #${id} not found.`, ephemeral: true });

        const isStaff = hasManageGuild(interaction);
        const isVoucher = entry.voucherId === interaction.user.id;
        if (!isStaff && !isVoucher) {
          return safeReply(interaction, { content: "You can only remove your own vouches (or have Manage Server).", ephemeral: true });
        }

        const removed = removeVouchById(guild.id, id);
        if (!removed) return safeReply(interaction, { content: `Vouch #${id} not found.`, ephemeral: true });

        const embed = new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle("🗑️ Vouch Removed")
          .setDescription(`Removed **#${id}**`)
          .setTimestamp(new Date());

        await sendLog(
          guild,
          new EmbedBuilder()
            .setColor(0xed4245)
            .setTitle("Vouch Removed")
            .setDescription(`**#${id}** removed by <@${interaction.user.id}>`)
            .setTimestamp(new Date())
        );

        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }

      if (interaction.commandName === "bug") {
        const sub = interaction.options.getSubcommand(true);

        if (sub === "board") {
          if (!hasManageGuild(interaction)) return safeReply(interaction, { content: "Manage Server required.", ephemeral: true });
          await refreshBugBoard(guild).catch(() => null);
          const embed = new EmbedBuilder().setColor(0x57f287).setTitle("✅ Bug Board Refreshed").setTimestamp(new Date());
          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }

        if (sub === "view") {
          const id = interaction.options.getInteger("id", true);
          const bug = getBug(guild.id, id);
          if (!bug) return safeReply(interaction, { content: `Bug #${id} not found.`, ephemeral: true });

          const commentPreview = bug.comments.slice(-3).map((c) => `• <@${c.byId}>: ${clampText(c.text, 120)}`);
          const embed = new EmbedBuilder()
            .setColor(0xfee75c)
            .setTitle(`🐞 Bug #${bug.id} ${bugStatusEmoji(bug.status)} ${bug.status}`)
            .setDescription(
              [
                `**Title:** ${clampText(bug.title, 200)}`,
                `**Reporter:** <@${bug.reporterId}>`,
                bug.assignedToId ? `**Assigned:** <@${bug.assignedToId}>` : "**Assigned:** (none)",
                "",
                clampText(bug.description, 1500),
                "",
                bug.sourceMessageUrl ? `**Link:** ${bug.sourceMessageUrl}` : null,
                bug.lastNote ? `**Note:** ${clampText(bug.lastNote, 900)}` : null,
                bug.comments.length ? `**Comments (${bug.comments.length}):**` : null,
                bug.comments.length ? commentPreview.join("\n") : null,
              ]
                .filter(Boolean)
                .join("\n")
            )
            .setTimestamp(new Date(bug.updatedAtMs));

          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }

        if (sub === "list") {
          const store = getBugStore(guild.id);
          const all = Array.from(store.items.values()).sort((a, b) => b.id - a.id).slice(0, 10);
          const lines = all.length ? all.map(buildBugCardLine) : ["No bug reports yet."];

          const embed = new EmbedBuilder()
            .setColor(0xfee75c)
            .setTitle("🐞 Recent Bugs (Last 10)")
            .setDescription(lines.join("\n\n"))
            .setTimestamp(new Date());

          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }

        if (sub === "search") {
          const q = interaction.options.getString("query", true).toLowerCase().trim();
          const store = getBugStore(guild.id);
          const all = Array.from(store.items.values()).sort((a, b) => b.id - a.id);

          const matches = all.filter((b) => {
            const hay = `${b.title}\n${b.description}\n${b.lastNote}`.toLowerCase();
            return hay.includes(q);
          });

          const top = matches.slice(0, 10);
          const lines = top.length ? top.map(buildBugCardLine) : ["No matches."];

          const embed = new EmbedBuilder()
            .setColor(0xfee75c)
            .setTitle(`🔎 Bug Search`)
            .setDescription([`Query: **${clampText(q, 40)}**`, "", ...lines].join("\n"))
            .setTimestamp(new Date());

          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }

        if (sub === "status") {
          if (!hasManageGuild(interaction)) return safeReply(interaction, { content: "Manage Server required.", ephemeral: true });

          const id = interaction.options.getInteger("id", true);
          const status = interaction.options.getString("status", true);
          const assign = interaction.options.getUser("assign", false);
          const note = interaction.options.getString("note", false) || "";

          if (!BUG_STATUSES.includes(status)) return safeReply(interaction, { content: "Invalid status.", ephemeral: true });

          const updated = setBugStatus(guild.id, id, status, assign ? assign.id : undefined, note);
          if (!updated) return safeReply(interaction, { content: `Bug #${id} not found.`, ephemeral: true });

          await refreshBugBoard(guild).catch(() => null);
          await announceBugUpdate(guild, updated, interaction.user.id).catch(() => null);

          const embed = new EmbedBuilder()
            .setColor(status === "RESOLVED" ? 0x57f287 : 0x5865f2)
            .setTitle("✅ Bug Updated")
            .setDescription(`Bug **#${id}** is now **${status}**.`)
            .setTimestamp(new Date());

          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }

        if (sub === "comment") {
          if (!hasManageGuild(interaction)) return safeReply(interaction, { content: "Manage Server required.", ephemeral: true });

          const id = interaction.options.getInteger("id", true);
          const text = interaction.options.getString("text", true);

          const updated = addBugComment(guild.id, id, interaction.user.id, text);
          if (!updated) return safeReply(interaction, { content: `Bug #${id} not found.`, ephemeral: true });

          await refreshBugBoard(guild).catch(() => null);
          await announceBugUpdate(guild, updated, interaction.user.id, "Comment added").catch(() => null);

          const embed = new EmbedBuilder().setColor(0x5865f2).setTitle("💬 Comment Added").setDescription(`Bug **#${id}** updated.`).setTimestamp(new Date());
          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }

        if (sub === "reopen") {
          if (!hasManageGuild(interaction)) return safeReply(interaction, { content: "Manage Server required.", ephemeral: true });

          const id = interaction.options.getInteger("id", true);
          const note = interaction.options.getString("note", false) || "";

          const updated = reopenBug(guild.id, id, note);
          if (!updated) return safeReply(interaction, { content: `Bug #${id} not found.`, ephemeral: true });

          await refreshBugBoard(guild).catch(() => null);
          await announceBugUpdate(guild, updated, interaction.user.id, "Bug reopened").catch(() => null);

          const embed = new EmbedBuilder().setColor(0xfee75c).setTitle("♻️ Bug Reopened").setDescription(`Bug **#${id}** is now **OPEN**.`).setTimestamp(new Date());
          return safeReply(interaction, { embeds: [embed], ephemeral: true });
        }
      }

      if (interaction.commandName === "purge") {
        const amount = interaction.options.getInteger("amount", true);
        if (!hasManageMessages(interaction)) return safeReply(interaction, { content: "Manage Messages required.", ephemeral: true });

        const channel = interaction.channel;
        if (!channel || !channel.isTextBased()) return safeReply(interaction, { content: "Invalid channel.", ephemeral: true });

        const deleted = await channel.bulkDelete(amount, true).catch(() => null);
        const count = deleted ? deleted.size : 0;

        const embed = new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle("🧹 Messages Deleted")
          .setDescription(`Deleted **${count}** messages.`)
          .setTimestamp(new Date());

        return safeReply(interaction, { embeds: [embed], ephemeral: true });
      }
    } catch (err) {
      console.error("[ERROR]", err);
      return safeReply(interaction, { content: "An error occurred.", ephemeral: true });
    }
  });
}

async function startDiscord(messageContent) {
  const c = createDiscordClient(messageContent);
  wireClientEvents(c);
  await c.login(process.env.DISCORD_TOKEN);
  return c;
}

async function main() {
  await registerCommands();

  try {
    client = await startDiscord(RUNTIME_MESSAGE_CONTENT_INTENT);
    console.log("[START] Bot started");
  } catch (e) {
    const msg = String(e?.message || e || "");
    if (msg.toLowerCase().includes("disallowed intents") && !intentsFallbackUsed) {
      intentsFallbackUsed = true;
      RUNTIME_MESSAGE_CONTENT_INTENT = false;
      try {
        await client?.destroy?.();
      } catch {}
      console.warn("[WARN] Privileged intents rejected. Restarting without Message Content Intent.");
      client = await startDiscord(false);
      console.log("[START] Bot started (fallback intents)");
      return;
    }
    console.error("[FATAL]", e);
    process.exit(1);
  }
}

process.on("unhandledRejection", (err) => {
  const msg = String(err?.message || err || "");
  if (msg.toLowerCase().includes("disallowed intents") && !intentsFallbackUsed) {
    intentsFallbackUsed = true;
    RUNTIME_MESSAGE_CONTENT_INTENT = false;
    (async () => {
      try {
        await client?.destroy?.();
      } catch {}
      console.warn("[WARN] Privileged intents rejected. Restarting without Message Content Intent.");
      client = await startDiscord(false);
      console.log("[START] Bot started (fallback intents)");
    })().catch((e) => {
      console.error("[FATAL]", e);
      process.exit(1);
    });
    return;
  }
  console.error("[unhandledRejection]", err);
});

process.on("uncaughtException", (err) => {
  const msg = String(err?.message || err || "");
  if (msg.toLowerCase().includes("disallowed intents") && !intentsFallbackUsed) {
    intentsFallbackUsed = true;
    RUNTIME_MESSAGE_CONTENT_INTENT = false;
    (async () => {
      try {
        await client?.destroy?.();
      } catch {}
      console.warn("[WARN] Privileged intents rejected. Restarting without Message Content Intent.");
      client = await startDiscord(false);
      console.log("[START] Bot started (fallback intents)");
    })().catch((e) => {
      console.error("[FATAL]", e);
      process.exit(1);
    });
    return;
  }
  console.error("[uncaughtException]", err);
});

main();
