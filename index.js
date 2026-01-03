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

// ---------------------------
// Ticket helpers (in-memory)
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
      reason: "Ticket category not configured; auto-created by bot",
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
    createdAtMs: Date.now(),
    closedAtMs: 0,
    closedById: null,
  });

  const embed = new EmbedBuilder()
    .setTitle("🎫 Ticket creado")
    .setDescription(
      [
        `**Owner:** <@${ownerMember.id}>`,
        reasonText ? `**Motivo:** ${reasonText}` : null,
        "",
        "Un moderador te responderá pronto.",
        "Para cerrar: usa `/ticket close` en este canal.",
      ]
        .filter(Boolean)
        .join("\n")
    )
    .setTimestamp(new Date());

  await ch.send({ content: `<@${ownerMember.id}>`, embeds: [embed] }).catch(() => null);

  await sendLog(
    guild,
    new EmbedBuilder()
      .setTitle("🎫 Ticket creado")
      .addFields(
        { name: "Canal", value: `<#${ch.id}>`, inline: true },
        { name: "Owner", value: `<@${ownerMember.id}>`, inline: true }
      )
      .setDescription(reasonText ? `Motivo: ${reasonText}` : "Sin motivo")
      .setTimestamp(new Date())
  );

  return ch;
}

async function closeTicketChannel(guild, channel, closedById) {
  const t = tickets.get(channel.id);
  if (!t || t.guildId !== guild.id || t.status !== "open") {
    return { ok: false, reason: "Este canal no es un ticket abierto." };
  }

  t.status = "closed";
  t.closedAtMs = Date.now();
  t.closedById = closedById;

  await sendLog(
    guild,
    new EmbedBuilder()
      .setTitle("✅ Ticket cerrado")
      .addFields(
        { name: "Canal", value: `<#${channel.id}>`, inline: true },
        { name: "Cerrado por", value: `<@${closedById}>`, inline: true }
      )
      .setTimestamp(new Date())
  );

  await channel
    .send({
      embeds: [
        new EmbedBuilder()
          .setTitle("✅ Ticket cerrado")
          .setDescription("Este canal se eliminará en 10 segundos.")
          .setTimestamp(new Date()),
      ],
    })
    .catch(() => null);

  setTimeout(() => {
    channel.delete("Ticket cerrado").catch(() => null);
  }, 10_000);

  return { ok: true };
}

// ---------------------------
// Vouch helpers (in-memory)
// ---------------------------
function addVouch(guildId, voucherId, vouchedId, message) {
  if (!vouches.has(guildId)) vouches.set(guildId, []);
  vouches.get(guildId).push({
    voucherId,
    vouchedId,
    message: message || "",
    createdAtMs: Date.now(),
  });
}

function getVouchStats(guildId, userId) {
  const list = vouches.get(guildId) || [];
  const received = list.filter((v) => v.vouchedId === userId);
  const given = list.filter((v) => v.voucherId === userId);
  return { received, given };
}

// ---------------------------
// Discord client
// ---------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});
// ---------------------------
// Slash commands definition
// ---------------------------
const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Responde pong y latencia."),

  new SlashCommandBuilder().setName("config").setDescription("Ver configuración del servidor."),

  new SlashCommandBuilder()
    .setName("setwelcome")
    .setDescription("Configura el canal y mensaje de bienvenida.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName("channel").setDescription("Canal de bienvenida").setRequired(true))
    .addStringOption((o) =>
      o.setName("message").setDescription("Mensaje (usa {user} y {guild})").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("setlog")
    .setDescription("Configura el canal de logs.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName("channel").setDescription("Canal de logs").setRequired(true)),

  new SlashCommandBuilder()
    .setName("level")
    .setDescription("Muestra tu nivel/XP o el de otra persona.")
    .addUserOption((o) => o.setName("user").setDescription("Usuario (opcional)").setRequired(false)),

  new SlashCommandBuilder().setName("leaderboard").setDescription("Top 10 de niveles en este servidor."),

  new SlashCommandBuilder().setName("daily").setDescription("Reclama tu recompensa diaria."),

  new SlashCommandBuilder()
    .setName("balance")
    .setDescription("Muestra tu balance o el de otra persona.")
    .addUserOption((o) => o.setName("user").setDescription("Usuario (opcional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("pay")
    .setDescription("Envía monedas a alguien.")
    .addUserOption((o) => o.setName("user").setDescription("Destino").setRequired(true))
    .addIntegerOption((o) => o.setName("amount").setDescription("Cantidad").setMinValue(1).setRequired(true)),

  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Sistema de tickets.")
    .addSubcommand((s) =>
      s
        .setName("create")
        .setDescription("Crear un ticket.")
        .addStringOption((o) => o.setName("reason").setDescription("Motivo (opcional)").setRequired(false))
    )
    .addSubcommand((s) => s.setName("close").setDescription("Cerrar el ticket actual.")),

  new SlashCommandBuilder()
    .setName("vouch")
    .setDescription("Dar un vouch/reputación a un usuario.")
    .addUserOption((o) => o.setName("user").setDescription("Usuario a vouch").setRequired(true))
    .addStringOption((o) => o.setName("message").setDescription("Mensaje (opcional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("checkvouch")
    .setDescription("Ver vouches de un usuario.")
    .addUserOption((o) => o.setName("user").setDescription("Usuario (opcional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Expulsa a un usuario.")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((o) => o.setName("user").setDescription("Usuario").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Razón (opcional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Banea a un usuario.")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((o) => o.setName("user").setDescription("Usuario").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Razón (opcional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Borra mensajes en masa (hasta 100).")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("Cantidad (1-100)").setRequired(true).setMinValue(1).setMaxValue(100)
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  const guildId = (process.env.DISCORD_GUILD_ID || "").trim();
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guildId), { body: commands });
    console.log(`[DISCORD] Registered GUILD commands for ${guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
    console.log("[DISCORD] Registered GLOBAL commands");
  }
}

// ---------------------------
// Event handlers
// ---------------------------
client.once("ready", async () => {
  console.log(`[DISCORD] Logged in as ${client.user.tag}`);
});

client.on("guildMemberAdd", async (member) => {
  try {
    const s = getSettings(member.guild.id);
    const chId = s.welcome_channel_id;
    const msg = s.welcome_message;

    if (chId && msg) {
      const ch = await member.guild.channels.fetch(chId).catch(() => null);
      if (ch && ch.isTextBased()) {
        const rendered = String(msg)
          .replaceAll("{user}", `<@${member.id}>`)
          .replaceAll("{guild}", member.guild.name);
        await ch.send({ content: rendered }).catch(() => null);
      }
    }

    await sendLog(
      member.guild,
      new EmbedBuilder()
        .setTitle("👋 Member joined")
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
        .setTitle("🚪 Member left")
        .setDescription(`${member.user?.tag || member.id}`)
        .setTimestamp(new Date())
    );
  } catch {}
});

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
              .setDescription(`<@${message.author.id}> subió a **nivel ${res.level}**`)
              .setTimestamp(new Date()),
          ],
        })
        .catch(() => null);

      await sendLog(
        message.guild,
        new EmbedBuilder()
          .setTitle("📈 Level Up")
          .setDescription(`<@${message.author.id}> → nivel **${res.level}**`)
          .setTimestamp(new Date())
      );
    }
  } catch {}
});

client.on("messageDelete", async (message) => {
  try {
    if (!message.guild) return;

    const content = (message.content || "").slice(0, 1800);
    const embed = new EmbedBuilder()
      .setTitle("🗑️ Mensaje borrado")
      .addFields(
        { name: "Canal", value: message.channel ? `<#${message.channel.id}>` : "unknown", inline: true },
        { name: "Autor", value: message.author ? `<@${message.author.id}>` : "unknown", inline: true }
      )
      .setDescription(content ? content : "*Sin contenido (posible embed/adjunto)*")
      .setTimestamp(new Date());

    await sendLog(message.guild, embed);
  } catch {}
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "Este bot solo funciona en servidores.", ephemeral: true }).catch(() => null);
    return;
  }

  try {
    if (interaction.commandName === "ping") {
      const sent = Date.now();
      await interaction.reply({ content: "Pong..." });
      const latency = Date.now() - sent;
      await interaction.editReply(`Pong! 🏓 (${latency}ms)`).catch(() => null);
      return;
    }

    if (interaction.commandName === "config") {
      const s = getSettings(guild.id);
      const embed = new EmbedBuilder()
        .setTitle("⚙️ Configuración")
        .addFields(
          {
            name: "Welcome channel",
            value: s.welcome_channel_id ? `<#${s.welcome_channel_id}>` : "No configurado",
            inline: true,
          },
          { name: "Log channel", value: s.log_channel_id ? `<#${s.log_channel_id}>` : "No configurado", inline: true },
          {
            name: "Ticket category",
            value: s.ticket_category_id ? `<#${s.ticket_category_id}>` : "Auto",
            inline: true,
          }
        )
        .addFields({
          name: "Welcome message",
          value: s.welcome_message ? s.welcome_message.slice(0, 900) : "No configurado",
        })
        .setTimestamp(new Date());

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (interaction.commandName === "setwelcome") {
      const channel = interaction.options.getChannel("channel", true);
      const message = interaction.options.getString("message", true);

      if (!channel.isTextBased()) {
        await interaction.reply({ content: "Ese canal no es de texto.", ephemeral: true });
        return;
      }

      setSettings(guild.id, { welcome_channel_id: channel.id, welcome_message: message });

      await interaction.reply({ content: `✅ Welcome configurado en ${channel}.`, ephemeral: true });

      await sendLog(
        guild,
        new EmbedBuilder()
          .setTitle("⚙️ Welcome actualizado")
          .setDescription(`Canal: <#${channel.id}>\nMensaje: ${message}`)
          .setTimestamp(new Date())
      );
      return;
    }

    if (interaction.commandName === "setlog") {
      const channel = interaction.options.getChannel("channel", true);

      if (!channel.isTextBased()) {
        await interaction.reply({ content: "Ese canal no es de texto.", ephemeral: true });
        return;
      }

      setSettings(guild.id, { log_channel_id: channel.id });

      await interaction.reply({ content: `✅ Logs configurados en ${channel}.`, ephemeral: true });

      await sendLog(
        guild,
        new EmbedBuilder().setTitle("⚙️ Logs actualizados").setDescription(`Canal: <#${channel.id}>`).setTimestamp(new Date())
      );
      return;
    }

    if (interaction.commandName === "level") {
      const target = interaction.options.getUser("user") || interaction.user;
      const u = ensureUser(guild.id, target.id);

      const embed = new EmbedBuilder()
        .setTitle("🏅 Nivel")
        .setDescription(
          [`**Usuario:** <@${target.id}>`, `**Nivel:** ${u.level}`, `**XP:** ${u.xp} / ${xpForNext(u.level)}`].join("\n")
        )
        .setTimestamp(new Date());

      await interaction.reply({ embeds: [embed], ephemeral: true });
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

      if (!top.length) {
        await interaction.reply({ content: "Aún no hay datos de niveles.", ephemeral: true });
        return;
      }

      const lines = top.map((r, i) => `**${i + 1}.** <@${r.user_id}> — lvl **${r.level}** (xp ${r.xp})`);
      const embed = new EmbedBuilder().setTitle("🏆 Leaderboard").setDescription(lines.join("\n")).setTimestamp(new Date());

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (interaction.commandName === "daily") {
      const res = claimDaily(guild.id, interaction.user.id);
      if (!res.ok) {
        await interaction.reply({
          content: `⏳ Ya reclamaste tu daily. Vuelve en ${formatDuration(res.remainingMs)}.`,
          ephemeral: true,
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle("💰 Daily")
        .setDescription(`Reclamaste **${res.reward}** monedas.\nBalance: **${res.balance}**`)
        .setTimestamp(new Date());

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (interaction.commandName === "balance") {
      const target = interaction.options.getUser("user") || interaction.user;
      const u = ensureUser(guild.id, target.id);

      const embed = new EmbedBuilder()
        .setTitle("💳 Balance")
        .setDescription(`**Usuario:** <@${target.id}>\n**Monedas:** ${u.balance}`)
        .setTimestamp(new Date());

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (interaction.commandName === "pay") {
      const to = interaction.options.getUser("user", true);
      const amount = interaction.options.getInteger("amount", true);

      if (to.bot) {
        await interaction.reply({ content: "No puedes pagarle a un bot.", ephemeral: true });
        return;
      }
      if (to.id === interaction.user.id) {
        await interaction.reply({ content: "No puedes pagarte a ti mismo.", ephemeral: true });
        return;
      }

      try {
        transferBalance(guild.id, interaction.user.id, to.id, amount);
      } catch (e) {
        const msg = String(e?.message || "error");
        if (msg.includes("insufficient")) {
          await interaction.reply({ content: "Fondos insuficientes.", ephemeral: true });
          return;
        }
        throw e;
      }

      await interaction.reply({ content: `✅ Transferiste **${amount}** monedas a <@${to.id}>.`, ephemeral: true });

      await sendLog(
        guild,
        new EmbedBuilder()
          .setTitle("💸 Transferencia")
          .setDescription(`<@${interaction.user.id}> → <@${to.id}>: **${amount}**`)
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
        await interaction.reply({ content: `✅ Ticket creado: <#${ch.id}>`, ephemeral: true });
        return;
      }

      if (sub === "close") {
        const channel = interaction.channel;
        if (!channel || channel.type !== ChannelType.GuildText) {
          await interaction.reply({ content: "Comando inválido aquí.", ephemeral: true });
          return;
        }

        const result = await closeTicketChannel(guild, channel, interaction.user.id);
        if (!result.ok) {
          await interaction.reply({ content: result.reason, ephemeral: true });
          return;
        }

        await interaction.reply({ content: "✅ Cerrando ticket...", ephemeral: true });
        return;
      }
    }

    if (interaction.commandName === "vouch") {
      const target = interaction.options.getUser("user", true);
      const msg = interaction.options.getString("message") || "";

      if (target.bot) {
        await interaction.reply({ content: "No puedes vouchear a un bot.", ephemeral: true });
        return;
      }
      if (target.id === interaction.user.id) {
        await interaction.reply({ content: "No puedes vouchearte a ti mismo.", ephemeral: true });
        return;
      }

      addVouch(guild.id, interaction.user.id, target.id, msg);

      const embed = new EmbedBuilder()
        .setTitle("✅ Vouch agregado")
        .setDescription(
          [
            `**De:** <@${interaction.user.id}>`,
            `**Para:** <@${target.id}>`,
            msg ? `**Mensaje:** ${msg.slice(0, 900)}` : null,
          ].filter(Boolean).join("\n")
        )
        .setTimestamp(new Date());

      await interaction.reply({ embeds: [embed], ephemeral: true });

      await sendLog(
        guild,
        new EmbedBuilder()
          .setTitle("🤝 Vouch")
          .setDescription(`<@${interaction.user.id}> voucheó a <@${target.id}>${msg ? `\nMensaje: ${msg}` : ""}`)
          .setTimestamp(new Date())
      );
      return;
    }

    if (interaction.commandName === "checkvouch") {
      const target = interaction.options.getUser("user") || interaction.user;
      const stats = getVouchStats(guild.id, target.id);
      const received = stats.received.slice().sort((a, b) => b.createdAtMs - a.createdAtMs);
      const last5 = received.slice(0, 5);

      const lines =
        last5.length > 0
          ? last5.map((v, i) => `**${i + 1}.** <@${v.voucherId}> — ${v.message ? v.message.slice(0, 120) : "*sin mensaje*"}`)
          : ["*No tiene vouches aún.*"];

      const embed = new EmbedBuilder()
        .setTitle("📌 Vouches")
        .setDescription(
          [
            `**Usuario:** <@${target.id}>`,
            `**Recibidos:** ${stats.received.length}`,
            `**Dados:** ${stats.given.length}`,
            "",
            "**Últimos 5:**",
            ...lines,
          ].join("\n")
        )
        .setTimestamp(new Date());

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }
    if (interaction.commandName === "kick") {
      const target = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "Sin razón";

      const member = await guild.members.fetch(target.id).catch(() => null);
      if (!member) {
        await interaction.reply({ content: "No encontré ese miembro.", ephemeral: true });
        return;
      }

      await member.kick(reason).catch((e) => {
        throw new Error(`No pude kickear: ${e?.message || e}`);
      });

      await interaction.reply({ content: `✅ Kick a <@${target.id}>.`, ephemeral: true });

      await sendLog(
        guild,
        new EmbedBuilder()
          .setTitle("👢 Kick")
          .addFields(
            { name: "Target", value: `<@${target.id}>`, inline: true },
            { name: "Mod", value: `<@${interaction.user.id}>`, inline: true }
          )
          .setDescription(`Razón: ${reason}`)
          .setTimestamp(new Date())
      );
      return;
    }

    if (interaction.commandName === "ban") {
      const target = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "Sin razón";

      await guild.members.ban(target.id, { reason }).catch((e) => {
        throw new Error(`No pude banear: ${e?.message || e}`);
      });

      await interaction.reply({ content: `✅ Ban a <@${target.id}>.`, ephemeral: true });

      await sendLog(
        guild,
        new EmbedBuilder()
          .setTitle("🔨 Ban")
          .addFields(
            { name: "Target", value: `<@${target.id}>`, inline: true },
            { name: "Mod", value: `<@${interaction.user.id}>`, inline: true }
          )
          .setDescription(`Razón: ${reason}`)
          .setTimestamp(new Date())
      );
      return;
    }

    if (interaction.commandName === "purge") {
      const amount = interaction.options.getInteger("amount", true);
      const channel = interaction.channel;

      if (!channel || !channel.isTextBased()) {
        await interaction.reply({ content: "Canal inválido.", ephemeral: true });
        return;
      }

      const deleted = await channel.bulkDelete(amount, true).catch(() => null);
      const count = deleted ? deleted.size : 0;

      await interaction.reply({ content: `✅ Borrados ${count} mensajes.`, ephemeral: true });

      await sendLog(
        guild,
        new EmbedBuilder()
          .setTitle("🧹 Purge")
          .setDescription(`<@${interaction.user.id}> borró **${count}** mensajes en <#${channel.id}>`)
          .setTimestamp(new Date())
      );
      return;
    }

    await interaction.reply({ content: "Comando no manejado.", ephemeral: true });
  } catch (err) {
    console.error("[ERROR]", err);

    const msg = "Ocurrió un error ejecutando el comando.";
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: msg, ephemeral: true }).catch(() => null);
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => null);
    }
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
