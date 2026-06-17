require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, PermissionFlagsBits,
  ChannelType, AttachmentBuilder, Collection, Events,
  REST, Routes, SlashCommandBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

// ─── Persistent Config (config.json) ──────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function getGuildConfig(guildId) {
  const cfg = loadConfig();
  if (!cfg[guildId]) cfg[guildId] = {};
  return cfg[guildId];
}

function setGuildConfig(guildId, key, value) {
  const cfg = loadConfig();
  if (!cfg[guildId]) cfg[guildId] = {};
  cfg[guildId][key] = value;
  saveConfig(cfg);
}

// ─── Client ────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

const BOT_NAME = 'ceas';
const OWNER_ID = process.env.OWNER_ID || '';

// ─── In-memory stores ─────────────────────────────────────────────────────────
const warnings  = new Map(); // userId → [{reason,date,moderator}]
const openTickets = new Map(); // channelId → {userId,createdAt}
const afkUsers  = new Map(); // userId → {reason,since,originalNick}
const vouches   = new Map(); // targetId → [{fromId,fromTag,comment,date}]

// ─── Per-guild config shortcuts ───────────────────────────────────────────────
function gc(guildId) { return getGuildConfig(guildId); }

function getPrefix(guildId) {
  return (gc(guildId).prefix || 'c.').toLowerCase();
}

// ─── Embed Helpers ────────────────────────────────────────────────────────────
const successEmbed = (t, d) => new EmbedBuilder().setColor(0x57f287).setTitle(`✅ ${t}`).setDescription(d).setTimestamp();
const errorEmbed   = (d)    => new EmbedBuilder().setColor(0xed4245).setTitle('❌ Error').setDescription(d).setTimestamp();
const infoEmbed    = (t, d) => new EmbedBuilder().setColor(0x5865f2).setTitle(t).setDescription(d).setTimestamp();
const warnEmbed    = (t, d) => new EmbedBuilder().setColor(0xfee75c).setTitle(`⚠️ ${t}`).setDescription(d).setTimestamp();

async function sendLog(guild, embed) {
  const logId = gc(guild.id).logChannel;
  if (!logId) return;
  const ch = guild.channels.cache.get(logId);
  if (ch) ch.send({ embeds: [embed] }).catch(() => {});
}

function hasModPerms(member) {
  if (!member) return false;
  if (member.id === OWNER_ID) return true;
  if (member.id === member.guild.ownerId) return true;
  const cfg = gc(member.guild.id);
  if (cfg.modRole   && member.roles.cache.has(cfg.modRole))   return true;
  if (cfg.adminRole && member.roles.cache.has(cfg.adminRole)) return true;
  return member.permissions.has(PermissionFlagsBits.ModerateMembers);
}

function hasAdminPerms(member) {
  if (!member) return false;
  if (member.id === OWNER_ID) return true;
  if (member.id === member.guild.ownerId) return true;
  const cfg = gc(member.guild.id);
  if (cfg.adminRole && member.roles.cache.has(cfg.adminRole)) return true;
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

// ─── AFK ──────────────────────────────────────────────────────────────────────
async function setAfk(member, reason) {
  const original = member.nickname || member.user.username;
  afkUsers.set(member.id, { reason, since: Date.now(), originalNick: original });
  try { await member.setNickname(`[AFK] ${original}`.slice(0, 32)); } catch {}
}

async function removeAfk(member) {
  const data = afkUsers.get(member.id);
  if (!data) return;
  afkUsers.delete(member.id);
  try { await member.setNickname(data.originalNick === member.user.username ? null : data.originalNick); } catch {}
}

// ─── Ticket Transcript ────────────────────────────────────────────────────────
async function buildTranscript(channel) {
  const messages = [];
  let lastId;
  for (let i = 0; i < 5; i++) {
    const opts = { limit: 100 };
    if (lastId) opts.before = lastId;
    const batch = await channel.messages.fetch(opts).catch(() => new Collection());
    if (!batch.size) break;
    batch.forEach(m => messages.push(m));
    lastId = batch.last()?.id;
    if (batch.size < 100) break;
  }
  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const lines = messages.map(m => {
    const t = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
    const body = m.content || (m.embeds.length ? '[Embed]' : '') || (m.attachments.size ? '[Attachment]' : '');
    return `[${t}] ${m.author.tag}: ${body}`;
  });
  const header = [
    '==============================',
    ' TICKET TRANSCRIPT',
    ` Channel : #${channel.name}`,
    ` Server  : ${channel.guild.name}`,
    ` Date    : ${new Date().toUTCString()}`,
    ` Messages: ${lines.length}`,
    '==============================\n',
  ].join('\n');
  return Buffer.from(header + lines.join('\n'), 'utf8');
}

// ─── Ticket Create / Close ────────────────────────────────────────────────────
async function createTicket(guild, member) {
  for (const [chId, data] of openTickets.entries()) {
    if (data.userId === member.id) {
      const ch = guild.channels.cache.get(chId);
      if (ch) return { channel: ch, existing: true };
    }
  }
  const cfg = gc(guild.id);
  const opts = {
    name: `ticket-${member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)}`,
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
      { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
    ],
  };
  if (cfg.ticketCategory) opts.parent = cfg.ticketCategory;
  if (cfg.modRole) opts.permissionOverwrites.push({
    id: cfg.modRole,
    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
  });

  const channel = await guild.channels.create(opts);
  openTickets.set(channel.id, { userId: member.id, createdAt: new Date() });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2).setTitle('🎫 Ticket Opened')
    .setDescription(`Welcome ${member}!\nDescribe your issue and staff will be with you shortly.`)
    .addFields({ name: 'Close', value: 'Click the button below or use `close`' })
    .setFooter({ text: guild.name, iconURL: guild.iconURL() }).setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim').setEmoji('✋').setStyle(ButtonStyle.Success),
  );
  await channel.send({ content: `${member}${cfg.modRole ? ` <@&${cfg.modRole}>` : ''}`, embeds: [embed], components: [row] });
  return { channel, existing: false };
}

async function closeTicket(channel, closedBy, reason = 'No reason') {
  const data = openTickets.get(channel.id);
  if (!data) return;
  const transcriptBuf = await buildTranscript(channel);
  const attachment = new AttachmentBuilder(transcriptBuf, { name: `transcript-${channel.name}.txt` });
  const closeEmbed = new EmbedBuilder()
    .setColor(0xed4245).setTitle('🔒 Ticket Closed')
    .setDescription(`**Closed by:** ${closedBy}\n**Reason:** ${reason}`)
    .setFooter({ text: channel.guild.name, iconURL: channel.guild.iconURL() }).setTimestamp();
  try {
    const creator = await client.users.fetch(data.userId);
    await creator.send({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📄 Ticket Transcript')
        .setDescription(`Your ticket **#${channel.name}** was closed.\n**Reason:** ${reason}\n\nTranscript is attached.`)
        .setTimestamp()],
      files: [attachment],
    });
  } catch {}
  sendLog(channel.guild, closeEmbed);
  openTickets.delete(channel.id);
  await channel.send({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('🔒 Closing in 5 seconds…').setDescription(`Reason: ${reason}`).setTimestamp()] });
  setTimeout(() => channel.delete().catch(() => {}), 5000);
}

// ─── Setup Command ─────────────────────────────────────────────────────────────
const SETUP_OPTIONS = {
  welcome:      { label: 'Welcome channel',        key: 'welcomeChannel',  type: 'channel' },
  logs:         { label: 'Mod log channel',         key: 'logChannel',      type: 'channel' },
  tickets:      { label: 'Ticket category',         key: 'ticketCategory',  type: 'category' },
  modrole:      { label: 'Moderator role',          key: 'modRole',         type: 'role' },
  adminrole:    { label: 'Admin role',              key: 'adminRole',       type: 'role' },
  mutedrole:    { label: 'Muted role',              key: 'mutedRole',       type: 'role' },
  prefix:       { label: 'Command prefix',          key: 'prefix',          type: 'text' },
  welcomeimage: { label: 'Welcome image URL',       key: 'welcomeImage',    type: 'text' },
};

async function runSetup(message, args) {
  if (!hasAdminPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need administrator permissions.')] });

  const sub = args[0]?.toLowerCase();

  // c.setup view — show current config
  if (!sub || sub === 'view') {
    const cfg = gc(message.guild.id);
    const lines = [
      `**Prefix:** \`${cfg.prefix || 'c.'}\``,
      `**Welcome Channel:** ${cfg.welcomeChannel ? `<#${cfg.welcomeChannel}>` : 'Not set'}`,
      `**Log Channel:** ${cfg.logChannel ? `<#${cfg.logChannel}>` : 'Not set'}`,
      `**Ticket Category:** ${cfg.ticketCategory ? `<#${cfg.ticketCategory}>` : 'Not set'}`,
      `**Mod Role:** ${cfg.modRole ? `<@&${cfg.modRole}>` : 'Not set'}`,
      `**Admin Role:** ${cfg.adminRole ? `<@&${cfg.adminRole}>` : 'Not set'}`,
      `**Muted Role:** ${cfg.mutedRole ? `<@&${cfg.mutedRole}>` : 'Not set'}`,
      `**Welcome Image:** ${cfg.welcomeImage ? `[link](${cfg.welcomeImage})` : 'Not set'}`,
    ];
    const embed = infoEmbed('⚙️ Server Configuration', lines.join('\n'))
      .setFooter({ text: `${message.guild.name} • Use c.setup <option> <value> to change` });
    return message.reply({ embeds: [embed] });
  }

  // c.setup reset — clear all config for this guild
  if (sub === 'reset') {
    const cfg = loadConfig();
    delete cfg[message.guild.id];
    saveConfig(cfg);
    return message.reply({ embeds: [successEmbed('Config Reset', 'All settings for this server have been cleared.')] });
  }

  const opt = SETUP_OPTIONS[sub];
  if (!opt) {
    const list = Object.entries(SETUP_OPTIONS).map(([k, v]) => `\`setup ${k}\` — ${v.label}`).join('\n');
    return message.reply({ embeds: [infoEmbed('⚙️ Setup Options', list + '\n\n`setup view` — show current config\n`setup reset` — clear all settings')] });
  }

  const val = args.slice(1).join(' ');

  if (opt.type === 'channel') {
    const channel = message.mentions.channels.first() || message.guild.channels.cache.get(val);
    if (!channel) return message.reply({ embeds: [errorEmbed(`Mention a channel: \`setup ${sub} #channel\``)] });
    setGuildConfig(message.guild.id, opt.key, channel.id);
    return message.reply({ embeds: [successEmbed(`${opt.label} Set`, `${opt.label} is now <#${channel.id}>.`)] });
  }

  if (opt.type === 'category') {
    const category = message.guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && (c.name.toLowerCase() === val.toLowerCase() || c.id === val));
    if (!category) return message.reply({ embeds: [errorEmbed(`Category not found. Provide the category name or ID.\nUsage: \`setup tickets <category name>\``)] });
    setGuildConfig(message.guild.id, opt.key, category.id);
    return message.reply({ embeds: [successEmbed(`${opt.label} Set`, `Tickets will be created under **${category.name}**.`)] });
  }

  if (opt.type === 'role') {
    const role = message.mentions.roles.first() || message.guild.roles.cache.find(r => r.name.toLowerCase() === val.toLowerCase() || r.id === val);
    if (!role) return message.reply({ embeds: [errorEmbed(`Role not found.\nUsage: \`setup ${sub} @Role\` or \`setup ${sub} RoleName\``)] });
    setGuildConfig(message.guild.id, opt.key, role.id);
    return message.reply({ embeds: [successEmbed(`${opt.label} Set`, `${opt.label} is now **${role.name}**.`)] });
  }

  if (opt.type === 'text') {
    if (!val) return message.reply({ embeds: [errorEmbed(`Provide a value.\nUsage: \`setup ${sub} <value>\``)] });
    if (sub === 'prefix' && val.length > 5) return message.reply({ embeds: [errorEmbed('Prefix must be 5 characters or fewer.')] });
    setGuildConfig(message.guild.id, opt.key, val);
    return message.reply({ embeds: [successEmbed(`${opt.label} Set`, `${opt.label} is now \`${val}\`.`)] });
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────
const COMMANDS = {

  // ── Setup ────────────────────────────────────────────────────────────────────
  setup: {
    category: 'admin', usage: 'setup [option] [value]', description: 'Configure the bot — channels, roles, prefix, welcome image',
    async execute(message, args) { await runSetup(message, args); }
  },

  // ── Moderation ───────────────────────────────────────────────────────────────
  ban: {
    category: 'moderation', usage: 'ban @user [reason]', description: 'Ban a member',
    async execute(message, args, replyTarget) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      const target = replyTarget || message.mentions.members.first() || message.guild.members.cache.get(args[0]);
      if (!target) return message.reply({ embeds: [errorEmbed('Please mention a valid member.')] });
      if (!target.bannable) return message.reply({ embeds: [errorEmbed('I cannot ban that member.')] });
      const reason = (replyTarget ? args : args.slice(1)).join(' ') || 'No reason provided';
      await target.ban({ reason, deleteMessageSeconds: 604800 });
      const embed = successEmbed('Banned', `**${target.user.tag}** banned.\n**Reason:** ${reason}`);
      message.reply({ embeds: [embed] });
      sendLog(message.guild, new EmbedBuilder(embed.toJSON()).setFooter({ text: `Mod: ${message.author.tag}` }));
    }
  },
  unban: {
    category: 'moderation', usage: 'unban <userId> [reason]', description: 'Unban a user by ID',
    async execute(message, args) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      if (!args[0]) return message.reply({ embeds: [errorEmbed('Provide a user ID.')] });
      try {
        const user = await client.users.fetch(args[0]);
        await message.guild.bans.remove(args[0], args.slice(1).join(' ') || 'No reason');
        message.reply({ embeds: [successEmbed('Unbanned', `**${user.tag}** unbanned.`)] });
      } catch { message.reply({ embeds: [errorEmbed('Could not unban. Are they banned?')] }); }
    }
  },
  kick: {
    category: 'moderation', usage: 'kick @user [reason]', description: 'Kick a member',
    async execute(message, args, replyTarget) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      const target = replyTarget || message.mentions.members.first() || message.guild.members.cache.get(args[0]);
      if (!target) return message.reply({ embeds: [errorEmbed('Please mention a valid member.')] });
      if (!target.kickable) return message.reply({ embeds: [errorEmbed('I cannot kick that member.')] });
      const reason = (replyTarget ? args : args.slice(1)).join(' ') || 'No reason provided';
      await target.kick(reason);
      const embed = successEmbed('Kicked', `**${target.user.tag}** kicked.\n**Reason:** ${reason}`);
      message.reply({ embeds: [embed] });
      sendLog(message.guild, new EmbedBuilder(embed.toJSON()).setFooter({ text: `Mod: ${message.author.tag}` }));
    }
  },
  mute: {
    category: 'moderation', usage: 'mute @user [minutes] [reason]', description: 'Timeout a member',
    async execute(message, args, replyTarget) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      const target = replyTarget || message.mentions.members.first();
      if (!target) return message.reply({ embeds: [errorEmbed('Please mention a valid member.')] });
      const durIdx = replyTarget ? 0 : 1;
      const duration = parseInt(args[durIdx]) || 10;
      const reason = args.slice(durIdx + (isNaN(parseInt(args[durIdx])) ? 0 : 1)).join(' ') || 'No reason provided';
      try {
        await target.timeout(duration * 60 * 1000, reason);
        const embed = successEmbed('Muted', `**${target.user.tag}** muted for **${duration}m**.\n**Reason:** ${reason}`);
        message.reply({ embeds: [embed] });
        sendLog(message.guild, new EmbedBuilder(embed.toJSON()).setFooter({ text: `Mod: ${message.author.tag}` }));
      } catch { message.reply({ embeds: [errorEmbed('Failed to mute.')] }); }
    }
  },
  unmute: {
    category: 'moderation', usage: 'unmute @user', description: 'Remove timeout',
    async execute(message, args, replyTarget) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      const target = replyTarget || message.mentions.members.first();
      if (!target) return message.reply({ embeds: [errorEmbed('Please mention a valid member.')] });
      await target.timeout(null);
      message.reply({ embeds: [successEmbed('Unmuted', `**${target.user.tag}** unmuted.`)] });
    }
  },
  warn: {
    category: 'moderation', usage: 'warn @user [reason]', description: 'Warn a member',
    async execute(message, args, replyTarget) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      const target = replyTarget || message.mentions.members.first();
      if (!target) return message.reply({ embeds: [errorEmbed('Please mention a valid member.')] });
      const reason = (replyTarget ? args : args.slice(1)).join(' ') || 'No reason provided';
      if (!warnings.has(target.id)) warnings.set(target.id, []);
      warnings.get(target.id).push({ reason, date: new Date().toISOString(), moderator: message.author.tag });
      const count = warnings.get(target.id).length;
      const embed = warnEmbed('Warned', `**${target.user.tag}** warned. Total: **${count}**\n**Reason:** ${reason}`);
      message.reply({ embeds: [embed] });
      sendLog(message.guild, new EmbedBuilder(embed.toJSON()).setFooter({ text: `Mod: ${message.author.tag}` }));
      target.user.send({ embeds: [warnEmbed('You were warned', `Warned in **${message.guild.name}**.\n**Reason:** ${reason}\n**Total:** ${count}`)] }).catch(() => {});
    }
  },
  warnings: {
    category: 'moderation', usage: 'warnings @user', description: 'View warnings for a member',
    async execute(message, args, replyTarget) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      const target = replyTarget || message.mentions.members.first() || message.guild.members.cache.get(args[0]);
      if (!target) return message.reply({ embeds: [errorEmbed('Please mention a valid member.')] });
      const list = warnings.get(target.id) || [];
      if (!list.length) return message.reply({ embeds: [infoEmbed(`Warnings: ${target.user.tag}`, 'No warnings.')] });
      message.reply({ embeds: [infoEmbed(`⚠️ ${target.user.tag} (${list.length})`, list.map((w, i) => `**${i + 1}.** ${w.reason} — *${w.moderator}* <t:${Math.floor(new Date(w.date).getTime() / 1000)}:R>`).join('\n'))] });
    }
  },
  clearwarns: {
    category: 'moderation', usage: 'clearwarns @user', description: 'Clear all warnings',
    async execute(message, args, replyTarget) {
      if (!hasAdminPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need admin permissions.')] });
      const target = replyTarget || message.mentions.members.first();
      if (!target) return message.reply({ embeds: [errorEmbed('Please mention a valid member.')] });
      warnings.delete(target.id);
      message.reply({ embeds: [successEmbed('Cleared', `Warnings for **${target.user.tag}** cleared.`)] });
    }
  },
  purge: {
    category: 'moderation', usage: 'purge <1–100> [@user]', description: 'Bulk delete messages',
    async execute(message, args) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      const n = parseInt(args[0]);
      if (isNaN(n) || n < 1 || n > 100) return message.reply({ embeds: [errorEmbed('Number must be 1–100.')] });
      let msgs = await message.channel.messages.fetch({ limit: n + 1 });
      const filter = message.mentions.users.first();
      if (filter) msgs = msgs.filter(m => m.author.id === filter.id);
      const deleted = await message.channel.bulkDelete(msgs, true);
      const r = await message.channel.send({ embeds: [successEmbed('Purged', `Deleted **${deleted.size}** messages.`)] });
      setTimeout(() => r.delete().catch(() => {}), 4000);
    }
  },
  lock: {
    category: 'moderation', usage: 'lock [reason]', description: 'Lock this channel',
    async execute(message, args) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
      message.reply({ embeds: [warnEmbed('Locked', args.join(' ') || 'Channel locked.')] });
    }
  },
  unlock: {
    category: 'moderation', usage: 'unlock', description: 'Unlock this channel',
    async execute(message) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
      message.reply({ embeds: [successEmbed('Unlocked', 'Channel unlocked.')] });
    }
  },
  slowmode: {
    category: 'moderation', usage: 'slowmode <seconds>', description: 'Set slowmode (0 = off)',
    async execute(message, args) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      const s = parseInt(args[0]);
      if (isNaN(s) || s < 0 || s > 21600) return message.reply({ embeds: [errorEmbed('Seconds must be 0–21600.')] });
      await message.channel.setRateLimitPerUser(s);
      message.reply({ embeds: [successEmbed('Slowmode', s === 0 ? 'Disabled.' : `Set to **${s}s**.`)] });
    }
  },
  nickname: {
    category: 'moderation', usage: 'nickname @user <nick>', description: "Change a member's nickname",
    async execute(message, args, replyTarget) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      const target = replyTarget || message.mentions.members.first();
      if (!target) return message.reply({ embeds: [errorEmbed('Please mention a valid member.')] });
      const nick = (replyTarget ? args : args.slice(1)).join(' ') || null;
      await target.setNickname(nick);
      message.reply({ embeds: [successEmbed('Nickname', `**${target.user.tag}** nickname ${nick ? `→ **${nick}**` : 'reset'}.`)] });
    }
  },
  role: {
    category: 'moderation', usage: 'role @user <role name>', description: 'Give or remove a role',
    async execute(message, args, replyTarget) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      const target = replyTarget || message.mentions.members.first();
      if (!target) return message.reply({ embeds: [errorEmbed('Please mention a valid member.')] });
      const roleName = (replyTarget ? args : args.slice(1)).join(' ');
      if (!roleName) return message.reply({ embeds: [errorEmbed('Provide a role name.')] });
      const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
      if (!role) return message.reply({ embeds: [errorEmbed(`No role named **${roleName}** found.`)] });
      if (target.roles.cache.has(role.id)) {
        await target.roles.remove(role);
        return message.reply({ embeds: [successEmbed('Role Removed', `Removed **${role.name}** from ${target.user.tag}.`)] });
      }
      await target.roles.add(role);
      message.reply({ embeds: [successEmbed('Role Added', `Gave **${role.name}** to ${target.user.tag}.`)] });
    }
  },

  // ── AFK ──────────────────────────────────────────────────────────────────────
  afk: {
    category: 'general', usage: 'afk [reason]', description: 'Set/remove your AFK — nick → [AFK] Name',
    async execute(message, args) {
      if (afkUsers.has(message.author.id)) {
        await removeAfk(message.member);
        return message.reply({ embeds: [successEmbed('AFK Removed', 'Welcome back!')] });
      }
      await setAfk(message.member, args.join(' ') || 'AFK');
      message.reply({ embeds: [successEmbed('AFK Set', `You are now AFK.\n**Reason:** ${args.join(' ') || 'AFK'}`)] });
    }
  },

  // ── Vouch ─────────────────────────────────────────────────────────────────────
  vouch: {
    category: 'social', usage: 'vouch @user [comment]', description: 'Vouch for a member',
    async execute(message, args, replyTarget) {
      const target = replyTarget || message.mentions.members.first();
      if (!target) return message.reply({ embeds: [errorEmbed('Mention who to vouch for.')] });
      if (target.id === message.author.id) return message.reply({ embeds: [errorEmbed("You can't vouch for yourself.")] });
      const comment = (replyTarget ? args : args.slice(1)).join(' ') || 'No comment';
      if (!vouches.has(target.id)) vouches.set(target.id, []);
      const list = vouches.get(target.id);
      const idx = list.findIndex(v => v.fromId === message.author.id);
      if (idx !== -1) {
        list[idx] = { fromId: message.author.id, fromTag: message.author.tag, comment, date: new Date().toISOString() };
        return message.reply({ embeds: [successEmbed('Vouch Updated', `Updated your vouch for **${target.user.tag}**.\n💬 *"${comment}"*`)] });
      }
      list.push({ fromId: message.author.id, fromTag: message.author.tag, comment, date: new Date().toISOString() });
      message.reply({ embeds: [successEmbed('Vouched!', `Vouched for **${target.user.tag}**! They have **${list.length}** vouch(es).\n💬 *"${comment}"*`)] });
    }
  },
  vouches: {
    category: 'social', usage: 'vouches [@user]', description: 'View vouches for a member',
    async execute(message, args, replyTarget) {
      const target = replyTarget || message.mentions.members.first() || message.member;
      const list = vouches.get(target.id) || [];
      if (!list.length) return message.reply({ embeds: [infoEmbed(`Vouches — ${target.user.tag}`, 'No vouches yet.')] });
      message.reply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle(`⭐ Vouches — ${target.user.tag} (${list.length})`).setDescription(list.map((v, i) => `**${i + 1}.** <t:${Math.floor(new Date(v.date).getTime() / 1000)}:R> by **${v.fromTag}** — *"${v.comment}"*`).join('\n')).setThumbnail(target.user.displayAvatarURL({ size: 128 })).setTimestamp()] });
    }
  },
  unvouch: {
    category: 'social', usage: 'unvouch @user', description: 'Remove your vouch for someone',
    async execute(message, args, replyTarget) {
      const target = replyTarget || message.mentions.members.first();
      if (!target) return message.reply({ embeds: [errorEmbed('Mention who to unvouch.')] });
      const list = vouches.get(target.id) || [];
      const idx = list.findIndex(v => v.fromId === message.author.id);
      if (idx === -1) return message.reply({ embeds: [errorEmbed("You haven't vouched for that member.")] });
      list.splice(idx, 1);
      message.reply({ embeds: [successEmbed('Vouch Removed', `Removed your vouch for **${target.user.tag}**.`)] });
    }
  },
  vouchleader: {
    category: 'social', usage: 'vouchleader', description: 'Vouch leaderboard',
    async execute(message) {
      const scores = [...vouches.entries()].map(([id, l]) => ({ id, count: l.length })).filter(e => e.count > 0).sort((a, b) => b.count - a.count).slice(0, 10);
      if (!scores.length) return message.reply({ embeds: [infoEmbed('Vouch Leaderboard', 'No vouches yet.')] });
      const medals = ['🥇', '🥈', '🥉'];
      const lines = await Promise.all(scores.map(async (e, i) => {
        const u = await client.users.fetch(e.id).catch(() => null);
        return `${medals[i] || `**${i + 1}.**`} ${u ? u.tag : e.id} — **${e.count}** vouch(es)`;
      }));
      message.reply({ embeds: [infoEmbed('⭐ Vouch Leaderboard', lines.join('\n'))] });
    }
  },

  // ── Utility ──────────────────────────────────────────────────────────────────
  say: {
    category: 'utility', usage: 'say <text>  |  say embed Title | Desc', description: 'Send a message or embed as the bot',
    async execute(message, args) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      message.delete().catch(() => {});
      if (args[0]?.toLowerCase() === 'embed') {
        const parts = args.slice(1).join(' ').split('|');
        message.channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(parts[0]?.trim() || 'Announcement').setDescription(parts[1]?.trim() || '\u200b').setFooter({ text: message.guild.name, iconURL: message.guild.iconURL() }).setTimestamp()] });
      } else {
        const text = args.join(' ');
        if (text) message.channel.send(text);
      }
    }
  },
  embed: {
    category: 'utility', usage: 'embed Title | Desc | #color | imageUrl', description: 'Send a custom embed',
    async execute(message, args) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      message.delete().catch(() => {});
      const p = args.join(' ').split('|').map(s => s.trim());
      const color = p[2] ? parseInt(p[2].replace('#', ''), 16) : 0x5865f2;
      const embed = new EmbedBuilder().setColor(isNaN(color) ? 0x5865f2 : color).setTitle(p[0] || 'Embed').setDescription(p[1] || '\u200b').setFooter({ text: message.guild.name, iconURL: message.guild.iconURL() }).setTimestamp();
      if (p[3]) embed.setImage(p[3]);
      message.channel.send({ embeds: [embed] });
    }
  },
  userinfo: {
    category: 'utility', usage: 'userinfo [@user]', description: 'View info about a user',
    async execute(message, args, replyTarget) {
      const target = replyTarget || message.mentions.members.first() || message.member;
      const afk = afkUsers.get(target.id);
      const vcount = (vouches.get(target.id) || []).length;
      message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`👤 ${target.user.tag}`).setThumbnail(target.user.displayAvatarURL({ size: 256 })).addFields(
        { name: 'ID', value: target.id, inline: true },
        { name: 'Nickname', value: target.nickname || 'None', inline: true },
        { name: 'AFK', value: afk ? `Yes — ${afk.reason}` : 'No', inline: true },
        { name: 'Account Created', value: `<t:${Math.floor(target.user.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Joined Server', value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
        { name: '⭐ Vouches', value: `${vcount}`, inline: true },
        { name: 'Roles', value: target.roles.cache.filter(r => r.id !== message.guild.id).map(r => r.toString()).join(', ') || 'None' },
      ).setTimestamp()] });
    }
  },
  serverinfo: {
    category: 'utility', usage: 'serverinfo', description: 'View server info',
    async execute(message) {
      const g = message.guild; const cfg = gc(g.id);
      message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🏠 ${g.name}`).setThumbnail(g.iconURL({ size: 256 })).addFields(
        { name: 'ID', value: g.id, inline: true },
        { name: 'Owner', value: `<@${g.ownerId}>`, inline: true },
        { name: 'Members', value: `${g.memberCount}`, inline: true },
        { name: 'Channels', value: `${g.channels.cache.size}`, inline: true },
        { name: 'Roles', value: `${g.roles.cache.size}`, inline: true },
        { name: 'Prefix', value: `\`${cfg.prefix || 'c.'}\``, inline: true },
        { name: 'Created', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true },
      ).setTimestamp()] });
    }
  },
  avatar: {
    category: 'utility', usage: 'avatar [@user]', description: "Get a user's avatar",
    async execute(message, args, replyTarget) {
      const target = replyTarget?.user || message.mentions.users.first() || message.author;
      message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🖼️ ${target.tag}`).setImage(target.displayAvatarURL({ size: 1024 })).setTimestamp()] });
    }
  },
  ping: {
    category: 'utility', usage: 'ping', description: 'Check bot latency',
    async execute(message) {
      const m = await message.reply({ embeds: [infoEmbed('🏓 Pinging…', 'Measuring…')] });
      m.edit({ embeds: [infoEmbed('🏓 Pong!', `**Bot:** ${m.createdTimestamp - message.createdTimestamp}ms\n**API:** ${client.ws.ping}ms`)] });
    }
  },

  // ── Tickets ──────────────────────────────────────────────────────────────────
  ticket: {
    category: 'tickets', usage: 'ticket setup', description: 'Post the ticket panel (admin only)',
    async execute(message) {
      if (!hasAdminPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need admin permissions.')] });
      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🎫 Support Tickets').setDescription('Need help? Click below to open a support ticket.\nOur team will assist you shortly.').setFooter({ text: message.guild.name, iconURL: message.guild.iconURL() }).setTimestamp();
      message.channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket_create').setLabel('Open Ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary))] });
      message.reply({ embeds: [successEmbed('Panel Sent', 'Ticket panel posted.')] });
    }
  },
  close: {
    category: 'tickets', usage: 'close [reason]', description: 'Close the current ticket',
    async execute(message, args) {
      if (!openTickets.has(message.channel.id)) return message.reply({ embeds: [errorEmbed('This is not a ticket channel.')] });
      await closeTicket(message.channel, message.member, args.join(' ') || 'No reason');
    }
  },

  // ── Help ─────────────────────────────────────────────────────────────────────
  help: {
    category: 'general', usage: 'help', description: 'Show the interactive help menu',
    async execute(message) { await sendHelpMenu(message); }
  },
};

// ─── Help Menu ────────────────────────────────────────────────────────────────
const CATEGORIES = {
  admin:      { emoji: '⚙️', label: 'Admin',      description: 'Setup & configuration',        color: 0xeb459e },
  moderation: { emoji: '🔨', label: 'Moderation', description: 'Ban, kick, mute, warn & more', color: 0xed4245 },
  utility:    { emoji: '🛠️', label: 'Utility',    description: 'Say, embed, userinfo, ping',   color: 0x5865f2 },
  tickets:    { emoji: '🎫', label: 'Tickets',    description: 'Ticket panel, close & transcript', color: 0xfee75c },
  social:     { emoji: '⭐', label: 'Social',     description: 'Vouch system & leaderboard',   color: 0xf1c40f },
  general:    { emoji: '📋', label: 'General',    description: 'Help, AFK, ping',               color: 0x57f287 },
};

async function sendHelpMenu(message) {
  const prefix = getPrefix(message.guild.id);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2).setTitle('📚 Ceas Bot — Help')
    .setDescription(
      `**Prefix:** \`${prefix}\` or \`${prefix.toUpperCase()}\`\n` +
      `**No-prefix:** \`ceas <command>\`\n` +
      `**Reply trigger:** Reply to any message with a command name\n` +
      `**Role trigger:** Reply to a message with just a role name\n\n` +
      `⚙️ First time? Run \`${prefix}setup\` to configure the bot!\n\nSelect a category ↓`
    )
    .addFields(Object.entries(CATEGORIES).map(([, v]) => ({ name: `${v.emoji} ${v.label}`, value: v.description, inline: true })))
    .setFooter({ text: `${Object.keys(COMMANDS).length} commands total` })
    .setThumbnail(client.user.displayAvatarURL()).setTimestamp();

  const menu = new StringSelectMenuBuilder()
    .setCustomId('help_menu').setPlaceholder('📂 Choose a category…')
    .addOptions(Object.entries(CATEGORIES).map(([key, v]) => ({ label: v.label, value: key, description: v.description, emoji: v.emoji })));

  message.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
}

function getCategoryEmbed(category, guildId) {
  const prefix = getPrefix(guildId);
  const info = CATEGORIES[category] || { emoji: '📋', label: category, color: 0x5865f2 };
  const cmds = Object.entries(COMMANDS).filter(([, c]) => c.category === category);
  return new EmbedBuilder()
    .setColor(info.color).setTitle(`${info.emoji} ${info.label} Commands`)
    .setDescription(cmds.map(([name, c]) => `\`${prefix}${name}\` — ${c.description}`).join('\n'))
    .setFooter({ text: `Prefix: ${prefix} | Also works: ceas ${cmds[0]?.[0] || 'help'}` }).setTimestamp();
}

// ─── Slash Commands ───────────────────────────────────────────────────────────
const slashCommands = [
  new SlashCommandBuilder().setName('afk').setDescription('Set or remove your AFK status')
    .addStringOption(o => o.setName('reason').setDescription('AFK reason').setRequired(false)),
  new SlashCommandBuilder().setName('vouch').setDescription('Vouch for a member')
    .addUserOption(o => o.setName('user').setDescription('Who to vouch for').setRequired(true))
    .addStringOption(o => o.setName('comment').setDescription('Your comment').setRequired(false)),
  new SlashCommandBuilder().setName('vouches').setDescription('View vouches for a member')
    .addUserOption(o => o.setName('user').setDescription('Member to check').setRequired(false)),
  new SlashCommandBuilder().setName('userinfo').setDescription('View info about a user')
    .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(false)),
  new SlashCommandBuilder().setName('avatar').setDescription("Get a user's avatar")
    .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(false)),
  new SlashCommandBuilder().setName('setup').setDescription('Configure the bot (admin only)')
    .addStringOption(o => o.setName('option').setDescription('What to configure').setRequired(false)
      .addChoices(
        { name: 'view — Show current config', value: 'view' },
        { name: 'welcome — Welcome channel', value: 'welcome' },
        { name: 'logs — Mod log channel', value: 'logs' },
        { name: 'tickets — Ticket category', value: 'tickets' },
        { name: 'modrole — Moderator role', value: 'modrole' },
        { name: 'adminrole — Admin role', value: 'adminrole' },
        { name: 'prefix — Command prefix', value: 'prefix' },
        { name: 'welcomeimage — Welcome image URL', value: 'welcomeimage' },
        { name: 'reset — Clear all settings', value: 'reset' },
      ))
    .addStringOption(o => o.setName('value').setDescription('The value to set (channel/role mention, ID, or text)').setRequired(false)),
];

// ─── Message Handler ───────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();
  const lower   = content.toLowerCase();
  const PREFIX  = getPrefix(message.guild.id);

  // AFK: auto-remove on talk
  if (afkUsers.has(message.author.id)) {
    await removeAfk(message.member);
    const r = await message.reply({ embeds: [successEmbed('Welcome back!', 'Your AFK has been removed.')] });
    setTimeout(() => r.delete().catch(() => {}), 5000);
  }

  // AFK: notify on ping
  for (const mentioned of message.mentions.members.values()) {
    if (afkUsers.has(mentioned.id)) {
      const d = afkUsers.get(mentioned.id);
      const ago = Math.floor((Date.now() - d.since) / 1000);
      const t = ago < 60 ? `${ago}s` : ago < 3600 ? `${Math.floor(ago / 60)}m` : `${Math.floor(ago / 3600)}h`;
      message.reply({ embeds: [warnEmbed('User is AFK', `**${mentioned.user.tag}** has been AFK for **${t}**.\n**Reason:** ${d.reason}`)] }).catch(() => {});
      break;
    }
  }

  // Reply Trigger System
  if (message.reference?.messageId) {
    const ref = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    if (ref && !ref.author.bot && ref.author.id !== message.author.id) {
      const stripped = content.replace(new RegExp(`^(${PREFIX}|${BOT_NAME}\\s+)`, 'i'), '').trim();
      const parts    = stripped.split(/\s+/);
      const trigger  = parts[0].toLowerCase();
      const tArgs    = parts.slice(1);

      // Command trigger
      if (COMMANDS[trigger] && hasModPerms(message.member)) {
        const tMember = await message.guild.members.fetch(ref.author.id).catch(() => null);
        if (tMember) {
          try { await COMMANDS[trigger].execute(message, tArgs, tMember); } catch (e) { console.error(e); }
          return;
        }
      }

      // Role name trigger
      if (hasModPerms(message.member) && stripped.length > 0 && !COMMANDS[trigger]) {
        const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === stripped.toLowerCase());
        if (role) {
          const tMember = await message.guild.members.fetch(ref.author.id).catch(() => null);
          if (tMember) {
            try {
              if (tMember.roles.cache.has(role.id)) {
                await tMember.roles.remove(role);
                message.reply({ embeds: [successEmbed('Role Removed', `Removed **${role.name}** from ${tMember.user.tag}.`)] });
              } else {
                await tMember.roles.add(role);
                message.reply({ embeds: [successEmbed('Role Added', `Gave **${role.name}** to ${tMember.user.tag}.`)] });
              }
            } catch { message.reply({ embeds: [errorEmbed('Failed to manage role.')] }); }
            return;
          }
        }
      }
    }
  }

  // Prefix / no-prefix parsing
  let commandName = null, args = [];
  if (lower.startsWith(PREFIX)) {
    const split = content.slice(PREFIX.length).trim().split(/\s+/);
    commandName = split[0].toLowerCase(); args = split.slice(1);
  } else if (lower.startsWith(BOT_NAME + ' ') || lower === BOT_NAME) {
    const split = content.slice(BOT_NAME.length).trim().split(/\s+/);
    commandName = split[0]?.toLowerCase(); args = split.slice(1);
  } else return;

  if (!commandName) return message.reply({ embeds: [infoEmbed('👋 Hey!', `Use \`${PREFIX}help\` or \`ceas help\` to see all commands.\nFirst time? Run \`${PREFIX}setup\` to configure the bot!`)] });

  const command = COMMANDS[commandName];
  if (!command) return message.reply({ embeds: [errorEmbed(`Unknown command \`${commandName}\`. Use \`${PREFIX}help\`.`)] });

  try { await command.execute(message, args, null); }
  catch (e) { console.error(`Error in ${commandName}:`, e); message.reply({ embeds: [errorEmbed('An error occurred.')] }).catch(() => {}); }
});

// ─── Interaction Handler ───────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  // Help dropdown
  if (interaction.isStringSelectMenu() && interaction.customId === 'help_menu') {
    return interaction.update({ embeds: [getCategoryEmbed(interaction.values[0], interaction.guild.id)], components: interaction.message.components });
  }

  // Ticket buttons
  if (interaction.isButton()) {
    if (interaction.customId === 'ticket_create') {
      await interaction.deferReply({ ephemeral: true });
      const result = await createTicket(interaction.guild, interaction.member);
      return interaction.editReply({ content: result.existing ? `⚠️ You already have a ticket: ${result.channel}` : `✅ Ticket created: ${result.channel}` });
    }
    if (interaction.customId === 'ticket_close') {
      if (!openTickets.has(interaction.channel.id)) return interaction.reply({ embeds: [errorEmbed('Not a ticket channel.')], ephemeral: true });
      if (!hasModPerms(interaction.member) && interaction.user.id !== openTickets.get(interaction.channel.id)?.userId)
        return interaction.reply({ embeds: [errorEmbed('Only staff or the ticket owner can close this.')], ephemeral: true });
      await interaction.reply({ embeds: [warnEmbed('Closing…', 'Ticket closing shortly.')], ephemeral: true });
      return closeTicket(interaction.channel, interaction.member);
    }
    if (interaction.customId === 'ticket_claim') {
      if (!hasModPerms(interaction.member)) return interaction.reply({ embeds: [errorEmbed('Only staff can claim.')], ephemeral: true });
      return interaction.update({ embeds: [...interaction.message.embeds, successEmbed('Claimed', `Claimed by ${interaction.member}`)], components: [] });
    }
  }

  // Slash commands
  if (!interaction.isChatInputCommand()) return;
  const { commandName, options, member, guild } = interaction;

  if (commandName === 'setup') {
    if (!hasAdminPerms(member)) return interaction.reply({ embeds: [errorEmbed('You need administrator permissions.')], ephemeral: true });
    const opt = options.getString('option') || 'view';
    const val = options.getString('value') || '';
    // Reuse the text-based setup logic by building fake args
    await runSetup({ member, guild, mentions: { channels: { first: () => null }, roles: { first: () => null } }, reply: (r) => interaction.reply({ ...r, ephemeral: true }) }, [opt, ...val.split(' ')].filter(Boolean));
    return;
  }

  if (commandName === 'afk') {
    const reason = options.getString('reason') || 'AFK';
    if (afkUsers.has(interaction.user.id)) {
      await removeAfk(member);
      return interaction.reply({ embeds: [successEmbed('AFK Removed', 'Welcome back!')], ephemeral: true });
    }
    await setAfk(member, reason);
    return interaction.reply({ embeds: [successEmbed('AFK Set', `You are now AFK.\n**Reason:** ${reason}`)], ephemeral: true });
  }

  if (commandName === 'vouch') {
    const targetUser = options.getUser('user');
    const comment    = options.getString('comment') || 'No comment';
    if (targetUser.id === interaction.user.id) return interaction.reply({ embeds: [errorEmbed("You can't vouch for yourself.")], ephemeral: true });
    if (!vouches.has(targetUser.id)) vouches.set(targetUser.id, []);
    const list = vouches.get(targetUser.id);
    const idx  = list.findIndex(v => v.fromId === interaction.user.id);
    if (idx !== -1) {
      list[idx] = { fromId: interaction.user.id, fromTag: interaction.user.tag, comment, date: new Date().toISOString() };
      return interaction.reply({ embeds: [successEmbed('Vouch Updated', `Updated vouch for **${targetUser.tag}**.\n💬 *"${comment}"*`)] });
    }
    list.push({ fromId: interaction.user.id, fromTag: interaction.user.tag, comment, date: new Date().toISOString() });
    return interaction.reply({ embeds: [successEmbed('Vouched!', `Vouched for **${targetUser.tag}**! **${list.length}** vouch(es).\n💬 *"${comment}"*`)] });
  }

  if (commandName === 'vouches') {
    const targetUser = options.getUser('user') || interaction.user;
    const list = vouches.get(targetUser.id) || [];
    if (!list.length) return interaction.reply({ embeds: [infoEmbed(`Vouches — ${targetUser.tag}`, 'No vouches yet.')] });
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle(`⭐ Vouches — ${targetUser.tag} (${list.length})`).setDescription(list.map((v, i) => `**${i + 1}.** <t:${Math.floor(new Date(v.date).getTime() / 1000)}:R> by **${v.fromTag}** — *"${v.comment}"*`).join('\n')).setThumbnail(targetUser.displayAvatarURL({ size: 128 })).setTimestamp()] });
  }

  if (commandName === 'userinfo') {
    const targetUser = options.getUser('user') || interaction.user;
    const gm = await guild.members.fetch(targetUser.id).catch(() => null);
    if (!gm) return interaction.reply({ embeds: [errorEmbed('Member not found.')] });
    const afk = afkUsers.get(targetUser.id);
    const vc  = (vouches.get(targetUser.id) || []).length;
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`👤 ${targetUser.tag}`).setThumbnail(targetUser.displayAvatarURL({ size: 256 })).addFields(
      { name: 'ID', value: targetUser.id, inline: true },
      { name: 'AFK', value: afk ? `Yes — ${afk.reason}` : 'No', inline: true },
      { name: '⭐ Vouches', value: `${vc}`, inline: true },
      { name: 'Account Created', value: `<t:${Math.floor(targetUser.createdTimestamp / 1000)}:R>`, inline: true },
      { name: 'Joined Server', value: `<t:${Math.floor(gm.joinedTimestamp / 1000)}:R>`, inline: true },
    ).setTimestamp()] });
  }

  if (commandName === 'avatar') {
    const targetUser = options.getUser('user') || interaction.user;
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🖼️ ${targetUser.tag}`).setImage(targetUser.displayAvatarURL({ size: 1024 })).setTimestamp()] });
  }
});

// ─── Welcome ──────────────────────────────────────────────────────────────────
client.on(Events.GuildMemberAdd, async (member) => {
  const cfg = gc(member.guild.id);
  if (!cfg.welcomeChannel) return;
  const ch = member.guild.channels.cache.get(cfg.welcomeChannel);
  if (!ch) return;
  const embed = new EmbedBuilder()
    .setColor(0x57f287).setTitle(`👋 Welcome to ${member.guild.name}!`)
    .setDescription(`Hey ${member}, welcome!\nYou are member **#${member.guild.memberCount}**.\nPlease read the rules and enjoy your stay!`)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: '📅 Account Age', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
      { name: '👥 Member Count', value: `${member.guild.memberCount}`, inline: true },
    )
    .setFooter({ text: member.guild.name, iconURL: member.guild.iconURL() }).setTimestamp();
  if (cfg.welcomeImage) embed.setImage(cfg.welcomeImage);
  ch.send({ embeds: [embed] });
});

// ─── Ready ─────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`\n✅ Ceas Bot online as ${client.user.tag}`);
  console.log(`⚙️  Config: stored in config.json (use c.setup in Discord to configure)`);
  console.log(`🔧 Commands: ${Object.keys(COMMANDS).length} prefix | ${slashCommands.length} slash\n`);
  client.user.setActivity('c.setup | c.help', { type: 3 });

  try {
    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    // Try guild-specific first (instant), then fallback to global
    const guilds = client.guilds.cache;
    for (const [guildId] of guilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: slashCommands.map(c => c.toJSON()) });
        console.log(`✅ Slash commands registered for guild ${guildId}`);
      } catch {}
    }
  } catch (e) { console.error('Slash command registration error:', e.message); }
});

client.on(Events.Error, e => console.error('Client error:', e));
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));
client.login(process.env.BOT_TOKEN);
