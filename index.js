require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, PermissionFlagsBits,
  ChannelType, AttachmentBuilder, Collection, Events,
  REST, Routes, SlashCommandBuilder, RoleSelectMenuBuilder,
} = require('discord.js');
const fs   = require('fs');
const path = require('path');

// ─── Persistent Config ────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'config.json');
function loadConfig()             { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } }
function saveConfig(c)            { fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); }
function gc(guildId)              { const c = loadConfig(); return c[guildId] || {}; }
function setGC(guildId, key, val) { const c = loadConfig(); if (!c[guildId]) c[guildId] = {}; c[guildId][key] = val; saveConfig(c); }
function getPrefix(guildId)       { return (gc(guildId).prefix || 'c.').toLowerCase(); }

// ─── Client ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

const BOT_NAME = 'ceas';
const OWNER_ID = process.env.OWNER_ID || '';

// ─── Stores (replace with DB for persistence across restarts) ─────────────────
const warnings   = new Map(); // userId  → [{reason,date,moderator}]
const openTickets= new Map(); // chId    → {userId,createdAt}
const afkUsers   = new Map(); // userId  → {reason,since,originalNick}
const vouches    = new Map(); // targetId→ [{fromId,fromTag,comment,date}]

// ─── Anti-Nuke Store ─────────────────────────────────────────────────────────
// guildId → userId → { bans:[], kicks:[], chDel:[], roleDel:[], webhooks:[] }
const nukeLog = new Map();
const NUKE_WINDOW = 10_000; // 10 second rolling window
const NUKE_DEFAULTS = { ban: 3, kick: 3, chDel: 3, roleDel: 3, webhook: 2 };

function getNukeLog(guildId, userId) {
  if (!nukeLog.has(guildId)) nukeLog.set(guildId, new Map());
  const g = nukeLog.get(guildId);
  if (!g.has(userId)) g.set(userId, { bans: [], kicks: [], chDel: [], roleDel: [], webhooks: [] });
  return g.get(userId);
}

function recentCount(arr) {
  const now = Date.now();
  while (arr.length && now - arr[0] > NUKE_WINDOW) arr.shift();
  return arr.length;
}

function isNukeWhitelisted(guild, userId) {
  if (userId === guild.ownerId) return true;
  if (userId === OWNER_ID) return true;
  const cfg = gc(guild.id);
  return (cfg.nukeWhitelist || []).includes(userId);
}

async function punishNuker(guild, userId, reason) {
  const cfg = gc(guild.id);
  if (!cfg.antinuke) return;
  const logCh = cfg.logChannel ? guild.channels.cache.get(cfg.logChannel) : null;
  const nukeEmbed = new EmbedBuilder()
    .setColor(0xff0000).setTitle('🚨 ANTI-NUKE TRIGGERED')
    .setDescription(`**User:** <@${userId}> (\`${userId}\`)\n**Action:** ${reason}\n**Result:** Banned & roles stripped`)
    .setTimestamp();
  if (logCh) logCh.send({ content: '@here', embeds: [nukeEmbed] }).catch(() => {});
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      await member.roles.set([], `Anti-Nuke: ${reason}`).catch(() => {});
      await member.ban({ reason: `[ANTI-NUKE] ${reason}`, deleteMessageSeconds: 0 }).catch(() => {});
    } else {
      await guild.bans.create(userId, { reason: `[ANTI-NUKE] ${reason}` }).catch(() => {});
    }
  } catch (e) { console.error('Anti-nuke punish error:', e.message); }
}

// ─── Embed helpers ────────────────────────────────────────────────────────────
const ok   = (t, d) => new EmbedBuilder().setColor(0x57f287).setTitle(`✅ ${t}`).setDescription(d).setTimestamp();
const err  = (d)    => new EmbedBuilder().setColor(0xed4245).setTitle('❌ Error').setDescription(d).setTimestamp();
const info = (t, d) => new EmbedBuilder().setColor(0x5865f2).setTitle(t).setDescription(d).setTimestamp();
const warn = (t, d) => new EmbedBuilder().setColor(0xfee75c).setTitle(`⚠️ ${t}`).setDescription(d).setTimestamp();

// ─── Permission helpers ───────────────────────────────────────────────────────
function isMod(member) {
  if (!member) return false;
  if (member.id === OWNER_ID || member.id === member.guild.ownerId) return true;
  const cfg = gc(member.guild.id);
  if (cfg.modRole   && member.roles.cache.has(cfg.modRole))   return true;
  if (cfg.adminRole && member.roles.cache.has(cfg.adminRole)) return true;
  return member.permissions.has(PermissionFlagsBits.ModerateMembers);
}
function isAdmin(member) {
  if (!member) return false;
  if (member.id === OWNER_ID || member.id === member.guild.ownerId) return true;
  const cfg = gc(member.guild.id);
  if (cfg.adminRole && member.roles.cache.has(cfg.adminRole)) return true;
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

// ─── Log helper ───────────────────────────────────────────────────────────────
async function sendLog(guild, embed) {
  const id = gc(guild.id).logChannel;
  if (!id) return;
  guild.channels.cache.get(id)?.send({ embeds: [embed] }).catch(() => {});
}

// ─── Unified Context ──────────────────────────────────────────────────────────
// Wraps a Message or Interaction into a common interface every command uses.
function ctxFromMessage(message) {
  return {
    guild:   message.guild,
    member:  message.member,
    author:  message.author,
    channel: message.channel,
    isSlash: false,
    reply:          (opts) => message.reply(opts),
    replyEphemeral: (opts) => message.reply(opts),   // messages can't be ephemeral
    deleteMsg:      ()     => message.delete().catch(() => {}),
  };
}

function ctxFromInteraction(interaction) {
  let used = false;
  const send = (opts, ephemeral = false) => {
    const payload = ephemeral ? { ...opts, ephemeral: true } : opts;
    if (interaction.deferred || interaction.replied) return interaction.editReply(opts);
    used = true;
    return interaction.reply(payload);
  };
  return {
    guild:   interaction.guild,
    member:  interaction.member,
    author:  interaction.user,
    channel: interaction.channel,
    isSlash: true,
    reply:          (opts) => send(opts, false),
    replyEphemeral: (opts) => send(opts, true),
    deleteMsg:      ()     => Promise.resolve(),
  };
}

// ─── AFK ──────────────────────────────────────────────────────────────────────
async function setAfk(member, reason) {
  const original = member.nickname || member.user.username;
  afkUsers.set(member.id, { reason, since: Date.now(), originalNick: original });
  try { await member.setNickname(`[AFK] ${original}`.slice(0, 32)); } catch {}
}
async function removeAfk(member) {
  const d = afkUsers.get(member.id);
  if (!d) return;
  afkUsers.delete(member.id);
  try { await member.setNickname(d.originalNick === member.user.username ? null : d.originalNick); } catch {}
}

// ─── Ticket helpers ───────────────────────────────────────────────────────────
async function buildTranscript(channel) {
  const msgs = [];
  let lastId;
  for (let i = 0; i < 5; i++) {
    const o = { limit: 100 };
    if (lastId) o.before = lastId;
    const batch = await channel.messages.fetch(o).catch(() => new Collection());
    if (!batch.size) break;
    batch.forEach(m => msgs.push(m));
    lastId = batch.last()?.id;
    if (batch.size < 100) break;
  }
  msgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const lines = msgs.map(m => {
    const t = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
    const body = m.content || (m.embeds.length ? '[Embed]' : m.attachments.size ? '[Attachment]' : '');
    return `[${t}] ${m.author.tag}: ${body}`;
  });
  return Buffer.from(
    `==============================\n TICKET TRANSCRIPT\n Channel : #${channel.name}\n Server  : ${channel.guild.name}\n Date    : ${new Date().toUTCString()}\n Messages: ${lines.length}\n==============================\n\n` + lines.join('\n'),
    'utf8'
  );
}

async function createTicket(guild, member) {
  for (const [chId, d] of openTickets) {
    if (d.userId === member.id) {
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
      { id: member.id,       allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: client.user.id,  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
    ],
  };
  if (cfg.ticketCategory) opts.parent = cfg.ticketCategory;
  if (cfg.modRole) opts.permissionOverwrites.push({ id: cfg.modRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  const channel = await guild.channels.create(opts);
  openTickets.set(channel.id, { userId: member.id, createdAt: new Date() });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim').setEmoji('✋').setStyle(ButtonStyle.Success),
  );
  await channel.send({
    content: `${member}${cfg.modRole ? ` <@&${cfg.modRole}>` : ''}`,
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🎫 Ticket Opened').setDescription(`Welcome ${member}!\nDescribe your issue and staff will help shortly.`).addFields({ name: 'Close', value: 'Button below or `close` command' }).setFooter({ text: guild.name, iconURL: guild.iconURL() }).setTimestamp()],
    components: [row],
  });
  return { channel, existing: false };
}

async function closeTicket(channel, closedBy, reason = 'No reason') {
  const d = openTickets.get(channel.id);
  if (!d) return;
  const buf  = await buildTranscript(channel);
  const file = new AttachmentBuilder(buf, { name: `transcript-${channel.name}.txt` });
  try {
    const creator = await client.users.fetch(d.userId);
    await creator.send({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📄 Your Ticket Transcript').setDescription(`Your ticket **#${channel.name}** was closed.\n**Reason:** ${reason}\n\nFull transcript attached.`).setTimestamp()],
      files: [file],
    });
  } catch {}
  sendLog(channel.guild, new EmbedBuilder().setColor(0xed4245).setTitle('🔒 Ticket Closed').setDescription(`**Channel:** #${channel.name}\n**Closed by:** ${closedBy}\n**Reason:** ${reason}`).setTimestamp());
  openTickets.delete(channel.id);
  await channel.send({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('🔒 Closing in 5 seconds…').setDescription(`Reason: ${reason}`).setTimestamp()] });
  setTimeout(() => channel.delete().catch(() => {}), 5000);
}

// ─── Setup command logic ──────────────────────────────────────────────────────
const SETUP_KEYS = {
  welcome:      { label: 'Welcome channel',   key: 'welcomeChannel',  type: 'channel'  },
  logs:         { label: 'Mod log channel',   key: 'logChannel',      type: 'channel'  },
  tickets:      { label: 'Ticket category',   key: 'ticketCategory',  type: 'category' },
  modrole:      { label: 'Moderator role',    key: 'modRole',         type: 'role'     },
  adminrole:    { label: 'Admin role',        key: 'adminRole',       type: 'role'     },
  mutedrole:    { label: 'Muted role',        key: 'mutedRole',       type: 'role'     },
  prefix:       { label: 'Command prefix',    key: 'prefix',          type: 'text'     },
  welcomeimage: { label: 'Welcome image URL', key: 'welcomeImage',    type: 'text'     },
};

async function runSetup(ctx, args) {
  if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions.')] });
  const sub = (args[0] || 'view').toLowerCase();

  if (sub === 'view') {
    const cfg = gc(ctx.guild.id);
    return ctx.reply({ embeds: [info('⚙️ Server Configuration', [
      `**Prefix:** \`${cfg.prefix || 'c.'}\``,
      `**Welcome Channel:** ${cfg.welcomeChannel  ? `<#${cfg.welcomeChannel}>`         : 'Not set'}`,
      `**Log Channel:**     ${cfg.logChannel       ? `<#${cfg.logChannel}>`             : 'Not set'}`,
      `**Ticket Category:** ${cfg.ticketCategory   ? `<#${cfg.ticketCategory}>`         : 'Not set'}`,
      `**Mod Role:**        ${cfg.modRole          ? `<@&${cfg.modRole}>`               : 'Not set'}`,
      `**Admin Role:**      ${cfg.adminRole        ? `<@&${cfg.adminRole}>`             : 'Not set'}`,
      `**Muted Role:**      ${cfg.mutedRole        ? `<@&${cfg.mutedRole}>`             : 'Not set'}`,
      `**Welcome Image:**   ${cfg.welcomeImage     ? `[link](${cfg.welcomeImage})`      : 'Not set'}`,
    ].join('\n')).setFooter({ text: 'Use c.setup <option> <value> to change' })] });
  }

  if (sub === 'reset') {
    const c = loadConfig(); delete c[ctx.guild.id]; saveConfig(c);
    return ctx.reply({ embeds: [ok('Config Reset', 'All settings cleared.')] });
  }

  const opt = SETUP_KEYS[sub];
  if (!opt) {
    const list = Object.entries(SETUP_KEYS).map(([k, v]) => `\`setup ${k}\` — ${v.label}`).join('\n');
    return ctx.reply({ embeds: [info('⚙️ Setup Options', list + '\n\n`setup view` — current config\n`setup reset` — clear all')] });
  }

  const val = args.slice(1).join(' ').trim();

  if (opt.type === 'channel') {
    const ch = ctx.guild.channels.cache.find(c => c.id === val || `<#${c.id}>` === val || c.name === val);
    if (!ch) return ctx.reply({ embeds: [err(`Mention the channel or use its name/ID.\nExample: \`setup ${sub} #channel-name\``)] });
    setGC(ctx.guild.id, opt.key, ch.id);
    return ctx.reply({ embeds: [ok(`${opt.label} Set`, `${opt.label} → <#${ch.id}>`)] });
  }
  if (opt.type === 'category') {
    const cat = ctx.guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && (c.name.toLowerCase() === val.toLowerCase() || c.id === val));
    if (!cat) return ctx.reply({ embeds: [err(`Category not found. Use the exact name or ID.`)] });
    setGC(ctx.guild.id, opt.key, cat.id);
    return ctx.reply({ embeds: [ok(`${opt.label} Set`, `Tickets → **${cat.name}**`)] });
  }
  if (opt.type === 'role') {
    const role = ctx.guild.roles.cache.find(r => r.id === val || `<@&${r.id}>` === val || r.name.toLowerCase() === val.toLowerCase());
    if (!role) return ctx.reply({ embeds: [err(`Role not found. Mention it or use its name/ID.`)] });
    setGC(ctx.guild.id, opt.key, role.id);
    return ctx.reply({ embeds: [ok(`${opt.label} Set`, `${opt.label} → **${role.name}**`)] });
  }
  if (opt.type === 'text') {
    if (!val) return ctx.reply({ embeds: [err(`Provide a value. Example: \`setup ${sub} !\``)] });
    if (sub === 'prefix' && val.length > 5) return ctx.reply({ embeds: [err('Prefix must be 5 characters or fewer.')] });
    setGC(ctx.guild.id, opt.key, val);
    return ctx.reply({ embeds: [ok(`${opt.label} Set`, `${opt.label} → \`${val}\``)] });
  }
}

// ─── COMMANDS (each takes ctx, args, target?) ─────────────────────────────────
const COMMANDS = {

  // ── Admin ────────────────────────────────────────────────────────────────────
  setup: {
    cat: 'admin', usage: 'setup [option] [value]', desc: 'Configure the bot from inside Discord',
    run: (ctx, args) => runSetup(ctx, args),
  },

  // ── Moderation ───────────────────────────────────────────────────────────────
  ban: {
    cat: 'moderation', usage: 'ban @user [reason]', desc: 'Ban a member from the server',
    async run(ctx, args, target) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      if (!target) return ctx.reply({ embeds: [err('Please provide a member.')] });
      if (!target.bannable) return ctx.reply({ embeds: [err('I cannot ban that member.')] });
      const reason = args.join(' ') || 'No reason provided';
      await target.ban({ reason, deleteMessageSeconds: 604800 });
      const e = ok('Banned', `**${target.user.tag}** was banned.\n**Reason:** ${reason}`);
      ctx.reply({ embeds: [e] });
      sendLog(ctx.guild, new EmbedBuilder(e.toJSON()).setFooter({ text: `Mod: ${ctx.author.tag}` }));
    },
  },
  unban: {
    cat: 'moderation', usage: 'unban <userId> [reason]', desc: 'Unban a user by their ID',
    async run(ctx, args) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      const userId = args[0];
      if (!userId) return ctx.reply({ embeds: [err('Provide a user ID.')] });
      try {
        const user = await client.users.fetch(userId);
        await ctx.guild.bans.remove(userId, args.slice(1).join(' ') || 'No reason');
        ctx.reply({ embeds: [ok('Unbanned', `**${user.tag}** was unbanned.`)] });
      } catch { ctx.reply({ embeds: [err('Could not unban — are they banned?')] }); }
    },
  },
  kick: {
    cat: 'moderation', usage: 'kick @user [reason]', desc: 'Kick a member from the server',
    async run(ctx, args, target) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      if (!target) return ctx.reply({ embeds: [err('Please provide a member.')] });
      if (!target.kickable) return ctx.reply({ embeds: [err('I cannot kick that member.')] });
      const reason = args.join(' ') || 'No reason provided';
      await target.kick(reason);
      const e = ok('Kicked', `**${target.user.tag}** was kicked.\n**Reason:** ${reason}`);
      ctx.reply({ embeds: [e] });
      sendLog(ctx.guild, new EmbedBuilder(e.toJSON()).setFooter({ text: `Mod: ${ctx.author.tag}` }));
    },
  },
  mute: {
    cat: 'moderation', usage: 'mute @user [minutes] [reason]', desc: 'Timeout (mute) a member',
    async run(ctx, args, target) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      if (!target) return ctx.reply({ embeds: [err('Please provide a member.')] });
      const dur    = parseInt(args[0]) || 10;
      const reason = (isNaN(parseInt(args[0])) ? args : args.slice(1)).join(' ') || 'No reason provided';
      try {
        await target.timeout(dur * 60_000, reason);
        const e = ok('Muted', `**${target.user.tag}** muted for **${dur}m**.\n**Reason:** ${reason}`);
        ctx.reply({ embeds: [e] });
        sendLog(ctx.guild, new EmbedBuilder(e.toJSON()).setFooter({ text: `Mod: ${ctx.author.tag}` }));
      } catch { ctx.reply({ embeds: [err('Failed to mute — check my permissions.')] }); }
    },
  },
  unmute: {
    cat: 'moderation', usage: 'unmute @user', desc: 'Remove timeout from a member',
    async run(ctx, args, target) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      if (!target) return ctx.reply({ embeds: [err('Please provide a member.')] });
      await target.timeout(null);
      ctx.reply({ embeds: [ok('Unmuted', `**${target.user.tag}** was unmuted.`)] });
    },
  },
  warn: {
    cat: 'moderation', usage: 'warn @user [reason]', desc: 'Warn a member',
    async run(ctx, args, target) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      if (!target) return ctx.reply({ embeds: [err('Please provide a member.')] });
      const reason = args.join(' ') || 'No reason provided';
      if (!warnings.has(target.id)) warnings.set(target.id, []);
      warnings.get(target.id).push({ reason, date: new Date().toISOString(), moderator: ctx.author.tag });
      const count = warnings.get(target.id).length;
      const e = warn('Warned', `**${target.user.tag}** warned. Total: **${count}**\n**Reason:** ${reason}`);
      ctx.reply({ embeds: [e] });
      sendLog(ctx.guild, new EmbedBuilder(e.toJSON()).setFooter({ text: `Mod: ${ctx.author.tag}` }));
      target.user.send({ embeds: [warn('You were warned', `In **${ctx.guild.name}**\n**Reason:** ${reason}\n**Total warnings:** ${count}`)] }).catch(() => {});
    },
  },
  warnings: {
    cat: 'moderation', usage: 'warnings @user', desc: 'View all warnings for a member',
    async run(ctx, args, target) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      if (!target) return ctx.reply({ embeds: [err('Please provide a member.')] });
      const list = warnings.get(target.id) || [];
      if (!list.length) return ctx.reply({ embeds: [info(`Warnings — ${target.user.tag}`, 'No warnings on record.')] });
      ctx.reply({ embeds: [info(`⚠️ Warnings — ${target.user.tag} (${list.length})`, list.map((w, i) => `**${i + 1}.** ${w.reason} — *${w.moderator}* <t:${Math.floor(new Date(w.date).getTime() / 1000)}:R>`).join('\n'))] });
    },
  },
  clearwarns: {
    cat: 'moderation', usage: 'clearwarns @user', desc: 'Clear all warnings for a member',
    async run(ctx, args, target) {
      if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions.')] });
      if (!target) return ctx.reply({ embeds: [err('Please provide a member.')] });
      warnings.delete(target.id);
      ctx.reply({ embeds: [ok('Warnings Cleared', `All warnings for **${target.user.tag}** removed.`)] });
    },
  },
  purge: {
    cat: 'moderation', usage: 'purge <1–100> [@user]', desc: 'Bulk delete messages',
    async run(ctx, args, filterUser) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      const n = parseInt(args[0]);
      if (isNaN(n) || n < 1 || n > 100) return ctx.reply({ embeds: [err('Provide a number between 1 and 100.')] });
      let msgs = await ctx.channel.messages.fetch({ limit: n + 1 });
      if (filterUser) msgs = msgs.filter(m => m.author.id === filterUser.id);
      const deleted = await ctx.channel.bulkDelete(msgs, true);
      const r = await ctx.channel.send({ embeds: [ok('Purged', `Deleted **${deleted.size}** messages.`)] });
      setTimeout(() => r.delete().catch(() => {}), 4000);
    },
  },
  lock: {
    cat: 'moderation', usage: 'lock [reason]', desc: 'Lock the current channel',
    async run(ctx, args) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      await ctx.channel.permissionOverwrites.edit(ctx.guild.roles.everyone, { SendMessages: false });
      ctx.reply({ embeds: [warn('Channel Locked', args.join(' ') || 'No reason provided.')] });
    },
  },
  unlock: {
    cat: 'moderation', usage: 'unlock', desc: 'Unlock the current channel',
    async run(ctx) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      await ctx.channel.permissionOverwrites.edit(ctx.guild.roles.everyone, { SendMessages: null });
      ctx.reply({ embeds: [ok('Channel Unlocked', 'This channel is now unlocked.')] });
    },
  },
  slowmode: {
    cat: 'moderation', usage: 'slowmode <0–21600>', desc: 'Set slowmode seconds (0 = off)',
    async run(ctx, args) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      const s = parseInt(args[0]);
      if (isNaN(s) || s < 0 || s > 21600) return ctx.reply({ embeds: [err('Seconds must be 0–21600.')] });
      await ctx.channel.setRateLimitPerUser(s);
      ctx.reply({ embeds: [ok('Slowmode Updated', s === 0 ? 'Slowmode disabled.' : `Set to **${s}s**.`)] });
    },
  },
  nickname: {
    cat: 'moderation', usage: 'nickname @user <nick>', desc: "Change a member's nickname",
    async run(ctx, args, target) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      if (!target) return ctx.reply({ embeds: [err('Please provide a member.')] });
      const nick = args.join(' ').trim() || null;
      await target.setNickname(nick);
      ctx.reply({ embeds: [ok('Nickname Updated', `**${target.user.tag}** → ${nick ? `\`${nick}\`` : 'reset'}`)] });
    },
  },
  role: {
    cat: 'moderation', usage: 'role @user <role name>', desc: 'Give or remove a role from a member',
    async run(ctx, args, target, roleObj) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      if (!target) return ctx.reply({ embeds: [err('Please provide a member.')] });
      const role = roleObj || ctx.guild.roles.cache.find(r => r.name.toLowerCase() === args.join(' ').toLowerCase());
      if (!role) return ctx.reply({ embeds: [err(`Role not found.`)] });
      if (target.roles.cache.has(role.id)) {
        await target.roles.remove(role);
        return ctx.reply({ embeds: [ok('Role Removed', `Removed **${role.name}** from **${target.user.tag}**.`)] });
      }
      await target.roles.add(role);
      ctx.reply({ embeds: [ok('Role Added', `Gave **${role.name}** to **${target.user.tag}**.`)] });
    },
  },

  // ── AFK ──────────────────────────────────────────────────────────────────────
  afk: {
    cat: 'general', usage: 'afk [reason]', desc: 'Set/remove your AFK — nick becomes [AFK] Name',
    async run(ctx, args) {
      if (afkUsers.has(ctx.author.id)) {
        await removeAfk(ctx.member);
        return ctx.reply({ embeds: [ok('AFK Removed', 'Welcome back! AFK removed.')] });
      }
      const reason = args.join(' ') || 'AFK';
      await setAfk(ctx.member, reason);
      ctx.reply({ embeds: [ok('AFK Set', `You are now AFK.\n**Reason:** ${reason}`)] });
    },
  },

  // ── Vouch ─────────────────────────────────────────────────────────────────────
  vouch: {
    cat: 'social', usage: 'vouch @user [comment]', desc: 'Vouch for a member',
    async run(ctx, args, target) {
      if (!target) return ctx.reply({ embeds: [err('Please mention who to vouch for.')] });
      if (target.id === ctx.author.id) return ctx.reply({ embeds: [err("You can't vouch for yourself.")] });
      const comment = args.join(' ') || 'No comment';
      if (!vouches.has(target.id)) vouches.set(target.id, []);
      const list = vouches.get(target.id);
      const idx  = list.findIndex(v => v.fromId === ctx.author.id);
      if (idx !== -1) {
        list[idx] = { fromId: ctx.author.id, fromTag: ctx.author.tag, comment, date: new Date().toISOString() };
        return ctx.reply({ embeds: [ok('Vouch Updated', `Updated vouch for **${target.user.tag}**.\n💬 *"${comment}"*`)] });
      }
      list.push({ fromId: ctx.author.id, fromTag: ctx.author.tag, comment, date: new Date().toISOString() });
      ctx.reply({ embeds: [ok('Vouched!', `Vouched for **${target.user.tag}**! They have **${list.length}** vouch(es).\n💬 *"${comment}"*`)] });
    },
  },
  vouches: {
    cat: 'social', usage: 'vouches [@user]', desc: 'View vouches for a member',
    async run(ctx, args, target) {
      const t    = target || ctx.member;
      const list = vouches.get(t.id) || [];
      if (!list.length) return ctx.reply({ embeds: [info(`Vouches — ${t.user.tag}`, 'No vouches yet.')] });
      ctx.reply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle(`⭐ Vouches — ${t.user.tag} (${list.length})`).setDescription(list.map((v, i) => `**${i + 1}.** <t:${Math.floor(new Date(v.date).getTime() / 1000)}:R> by **${v.fromTag}** — *"${v.comment}"*`).join('\n')).setThumbnail(t.user.displayAvatarURL({ size: 128 })).setTimestamp()] });
    },
  },
  unvouch: {
    cat: 'social', usage: 'unvouch @user', desc: 'Remove your vouch for a member',
    async run(ctx, args, target) {
      if (!target) return ctx.reply({ embeds: [err('Please mention who to unvouch.')] });
      const list = vouches.get(target.id) || [];
      const idx  = list.findIndex(v => v.fromId === ctx.author.id);
      if (idx === -1) return ctx.reply({ embeds: [err("You haven't vouched for that member.")] });
      list.splice(idx, 1);
      ctx.reply({ embeds: [ok('Vouch Removed', `Removed your vouch for **${target.user.tag}**.`)] });
    },
  },
  vouchleader: {
    cat: 'social', usage: 'vouchleader', desc: 'Show the vouch leaderboard',
    async run(ctx) {
      const scores = [...vouches.entries()].map(([id, l]) => ({ id, n: l.length })).filter(e => e.n > 0).sort((a, b) => b.n - a.n).slice(0, 10);
      if (!scores.length) return ctx.reply({ embeds: [info('Vouch Leaderboard', 'No vouches yet.')] });
      const medals = ['🥇', '🥈', '🥉'];
      const lines  = await Promise.all(scores.map(async (e, i) => {
        const u = await client.users.fetch(e.id).catch(() => null);
        return `${medals[i] || `**${i + 1}.**`} ${u ? u.tag : e.id} — **${e.n}** vouch(es)`;
      }));
      ctx.reply({ embeds: [info('⭐ Vouch Leaderboard', lines.join('\n'))] });
    },
  },

  // ── Utility ───────────────────────────────────────────────────────────────────
  say: {
    cat: 'utility', usage: 'say <text>  |  say embed Title | Desc', desc: 'Send a message or embed as the bot',
    async run(ctx, args) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      ctx.deleteMsg();
      if (args[0]?.toLowerCase() === 'embed') {
        const parts = args.slice(1).join(' ').split('|');
        ctx.channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(parts[0]?.trim() || 'Announcement').setDescription(parts[1]?.trim() || '\u200b').setFooter({ text: ctx.guild.name, iconURL: ctx.guild.iconURL() }).setTimestamp()] });
        if (ctx.isSlash) ctx.reply({ embeds: [ok('Sent', 'Embed sent.')], ephemeral: true });
      } else {
        const text = args.join(' ');
        if (text) {
          ctx.channel.send(text);
          if (ctx.isSlash) ctx.replyEphemeral({ embeds: [ok('Sent', 'Message sent.')] });
        }
      }
    },
  },
  embed: {
    cat: 'utility', usage: 'embed Title | Desc | #color | imageUrl', desc: 'Send a customizable embed',
    async run(ctx, args) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      ctx.deleteMsg();
      const p     = args.join(' ').split('|').map(s => s.trim());
      const color = p[2] ? parseInt(p[2].replace('#', ''), 16) : 0x5865f2;
      const emb   = new EmbedBuilder().setColor(isNaN(color) ? 0x5865f2 : color).setTitle(p[0] || 'Embed').setDescription(p[1] || '\u200b').setFooter({ text: ctx.guild.name, iconURL: ctx.guild.iconURL() }).setTimestamp();
      if (p[3]) emb.setImage(p[3]);
      ctx.channel.send({ embeds: [emb] });
      if (ctx.isSlash) ctx.replyEphemeral({ embeds: [ok('Sent', 'Embed sent.')] });
    },
  },
  userinfo: {
    cat: 'utility', usage: 'userinfo [@user]', desc: 'View info about a user',
    async run(ctx, args, target) {
      const t    = target || ctx.member;
      const afk  = afkUsers.get(t.id);
      const vc   = (vouches.get(t.id) || []).length;
      const wc   = (warnings.get(t.id) || []).length;
      ctx.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`👤 ${t.user.tag}`).setThumbnail(t.user.displayAvatarURL({ size: 256 })).addFields(
        { name: 'User ID',        value: t.id,                                                         inline: true  },
        { name: 'Nickname',       value: t.nickname || 'None',                                         inline: true  },
        { name: 'AFK',            value: afk ? `Yes — ${afk.reason}` : 'No',                          inline: true  },
        { name: 'Account Created',value: `<t:${Math.floor(t.user.createdTimestamp / 1000)}:R>`,       inline: true  },
        { name: 'Joined Server',  value: `<t:${Math.floor(t.joinedTimestamp / 1000)}:R>`,             inline: true  },
        { name: '⭐ Vouches',     value: `${vc}`,                                                      inline: true  },
        { name: '⚠️ Warnings',   value: `${wc}`,                                                      inline: true  },
        { name: 'Roles',          value: t.roles.cache.filter(r => r.id !== ctx.guild.id).map(r => r.toString()).join(', ') || 'None' },
      ).setTimestamp()] });
    },
  },
  serverinfo: {
    cat: 'utility', usage: 'serverinfo', desc: 'View server information',
    async run(ctx) {
      const g = ctx.guild; const cfg = gc(g.id);
      ctx.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🏠 ${g.name}`).setThumbnail(g.iconURL({ size: 256 })).addFields(
        { name: 'Server ID', value: g.id,                                             inline: true },
        { name: 'Owner',     value: `<@${g.ownerId}>`,                                inline: true },
        { name: 'Members',   value: `${g.memberCount}`,                               inline: true },
        { name: 'Channels',  value: `${g.channels.cache.size}`,                       inline: true },
        { name: 'Roles',     value: `${g.roles.cache.size}`,                          inline: true },
        { name: 'Prefix',    value: `\`${cfg.prefix || 'c.'}\``,                      inline: true },
        { name: 'Created',   value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true },
      ).setTimestamp()] });
    },
  },
  avatar: {
    cat: 'utility', usage: 'avatar [@user]', desc: "Get a user's avatar",
    async run(ctx, args, target) {
      const u = (target ? target.user : null) || ctx.author;
      ctx.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🖼️ ${u.tag}`).setImage(u.displayAvatarURL({ size: 1024 })).setTimestamp()] });
    },
  },
  ping: {
    cat: 'utility', usage: 'ping', desc: 'Check bot latency',
    async run(ctx) {
      const start = Date.now();
      const msg   = await ctx.reply({ embeds: [info('🏓 Pinging…', 'Measuring…')] });
      const el    = Date.now() - start;
      const edit  = info('🏓 Pong!', `**Bot:** ${el}ms\n**API:** ${client.ws.ping}ms`);
      if (msg && msg.edit) msg.edit({ embeds: [edit] });
    },
  },

  // ── Tickets ──────────────────────────────────────────────────────────────────
  ticket: {
    cat: 'tickets', usage: 'ticket', desc: 'Post the ticket creation panel (admin only)',
    async run(ctx) {
      if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions.')] });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_create').setLabel('Open Ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary),
      );
      ctx.channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🎫 Support Tickets').setDescription('Need help? Click below to open a ticket.\nOur team will assist you shortly.').setFooter({ text: ctx.guild.name, iconURL: ctx.guild.iconURL() }).setTimestamp()], components: [row] });
      ctx.reply({ embeds: [ok('Panel Sent', 'Ticket panel posted.')] });
    },
  },
  close: {
    cat: 'tickets', usage: 'close [reason]', desc: 'Close the current ticket channel',
    async run(ctx, args) {
      if (!openTickets.has(ctx.channel.id)) return ctx.reply({ embeds: [err('This is not a ticket channel.')] });
      await closeTicket(ctx.channel, ctx.member, args.join(' ') || 'No reason');
    },
  },

  // ── Help ─────────────────────────────────────────────────────────────────────
  help: {
    cat: 'general', usage: 'help', desc: 'Show the interactive help menu with dropdowns',
    async run(ctx) { await sendHelpMenu(ctx); },
  },

  // ── Anti-Nuke ────────────────────────────────────────────────────────────────
  antinuke: {
    cat: 'antinuke', usage: 'antinuke <on|off|status|whitelist|unwhitelist|threshold> [args]',
    desc: 'Configure the anti-nuke protection system',
    async run(ctx, args) {
      if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions.')] });
      const sub = (args[0] || 'status').toLowerCase();

      if (sub === 'on') {
        setGC(ctx.guild.id, 'antinuke', true);
        return ctx.reply({ embeds: [ok('Anti-Nuke Enabled', '🛡️ Anti-nuke protection is now **ON**.\nAny user who mass-bans, mass-kicks, mass-deletes channels/roles, or creates webhooks beyond the threshold will be instantly banned and stripped of roles.')] });
      }

      if (sub === 'off') {
        setGC(ctx.guild.id, 'antinuke', false);
        return ctx.reply({ embeds: [warn('Anti-Nuke Disabled', 'Anti-nuke protection is now **OFF**.')] });
      }

      if (sub === 'whitelist') {
        const target = ctx.guild.members.cache.get(args[1]?.replace(/[<@!>]/g, '')) || ctx.guild.members.cache.find(m => m.user.tag === args.slice(1).join(' '));
        if (!target) return ctx.reply({ embeds: [err('Mention a member or provide their ID.')] });
        const cfg = gc(ctx.guild.id);
        const list = cfg.nukeWhitelist || [];
        if (list.includes(target.id)) return ctx.reply({ embeds: [info('Already Whitelisted', `**${target.user.tag}** is already whitelisted.`)] });
        list.push(target.id);
        setGC(ctx.guild.id, 'nukeWhitelist', list);
        return ctx.reply({ embeds: [ok('Whitelisted', `**${target.user.tag}** is now exempt from anti-nuke.`)] });
      }

      if (sub === 'unwhitelist') {
        const targetId = args[1]?.replace(/[<@!>]/g, '');
        if (!targetId) return ctx.reply({ embeds: [err('Mention a member or provide their ID.')] });
        const cfg  = gc(ctx.guild.id);
        const list = (cfg.nukeWhitelist || []).filter(id => id !== targetId);
        setGC(ctx.guild.id, 'nukeWhitelist', list);
        const u = await client.users.fetch(targetId).catch(() => null);
        return ctx.reply({ embeds: [ok('Removed from Whitelist', `${u ? u.tag : targetId} is no longer whitelisted.`)] });
      }

      if (sub === 'threshold') {
        // antinuke threshold ban 5
        const type  = args[1]?.toLowerCase();
        const value = parseInt(args[2]);
        const valid = ['ban', 'kick', 'chdel', 'roledel', 'webhook'];
        if (!type || !valid.includes(type) || isNaN(value) || value < 1) {
          return ctx.reply({ embeds: [info('Threshold Usage', `\`antinuke threshold <ban|kick|chDel|roleDel|webhook> <number>\`\n\nExample: \`antinuke threshold ban 2\``)] });
        }
        const cfg = gc(ctx.guild.id);
        const thr = cfg.nukeThresholds || { ...NUKE_DEFAULTS };
        const keyMap = { ban: 'ban', kick: 'kick', chdel: 'chDel', roledel: 'roleDel', webhook: 'webhook' };
        thr[keyMap[type]] = value;
        setGC(ctx.guild.id, 'nukeThresholds', thr);
        return ctx.reply({ embeds: [ok('Threshold Updated', `**${type}** threshold set to **${value}** actions per 10 seconds.`)] });
      }

      // status (default)
      const cfg = gc(ctx.guild.id);
      const thr = cfg.nukeThresholds || NUKE_DEFAULTS;
      const wl  = cfg.nukeWhitelist || [];
      const wlUsers = await Promise.all(wl.map(id => client.users.fetch(id).catch(() => id)));
      return ctx.reply({ embeds: [new EmbedBuilder()
        .setColor(cfg.antinuke ? 0x57f287 : 0xed4245)
        .setTitle(`🛡️ Anti-Nuke — ${cfg.antinuke ? '✅ Enabled' : '❌ Disabled'}`)
        .setDescription('Monitors and auto-bans users who attempt to nuke (destroy) the server.')
        .addFields(
          { name: '⚡ Thresholds (per 10s)', value: [
            `**Ban:** ${thr.ban} actions`,
            `**Kick:** ${thr.kick} actions`,
            `**Channel Delete:** ${thr.chDel} actions`,
            `**Role Delete:** ${thr.roleDel} actions`,
            `**Webhook Create:** ${thr.webhook} actions`,
          ].join('\n'), inline: true },
          { name: '🔒 Monitored Events', value: '• Mass ban\n• Mass kick\n• Mass channel delete\n• Mass role delete\n• Webhook creation\n• Bot additions', inline: true },
          { name: `✅ Whitelist (${wl.length})`, value: wlUsers.length ? wlUsers.map(u => typeof u === 'string' ? `\`${u}\`` : u.tag).join(', ') : 'None' },
        )
        .setFooter({ text: 'Use: antinuke on | off | whitelist @user | threshold ban 2' })
        .setTimestamp()
      ] });
    },
  },
};

// ─── Help menu ────────────────────────────────────────────────────────────────
const CATS = {
  admin:      { emoji: '⚙️', label: 'Admin',      desc: 'Setup & configuration',          color: 0xeb459e },
  moderation: { emoji: '🔨', label: 'Moderation', desc: 'Ban, kick, mute, warn & more',   color: 0xed4245 },
  antinuke:   { emoji: '🛡️', label: 'Anti-Nuke',  desc: 'Server nuke protection',         color: 0xff4444 },
  utility:    { emoji: '🛠️', label: 'Utility',    desc: 'Say, embed, userinfo, ping',     color: 0x5865f2 },
  tickets:    { emoji: '🎫', label: 'Tickets',    desc: 'Ticket panel, close, transcript',color: 0xfee75c },
  social:     { emoji: '⭐', label: 'Social',     desc: 'Vouch system & leaderboard',     color: 0xf1c40f },
  general:    { emoji: '📋', label: 'General',    desc: 'Help, AFK, ping',                color: 0x57f287 },
};

async function sendHelpMenu(ctx) {
  const prefix = getPrefix(ctx.guild.id);
  const embed  = new EmbedBuilder()
    .setColor(0x5865f2).setTitle('📚 Ceas Bot — Help')
    .setDescription(
      `**Prefix:** \`${prefix}\` or \`${prefix.toUpperCase()}\`  |  **No-prefix:** \`ceas <cmd>\`\n` +
      `↩️ **Reply trigger** — reply to any message with a command name\n` +
      `🎭 **Role trigger** — reply to a message with just a role name\n\n` +
      `⚙️ First time? Run \`${prefix}setup\` to configure!\n\nSelect a category ↓`
    )
    .addFields(Object.values(CATS).map(v => ({ name: `${v.emoji} ${v.label}`, value: v.desc, inline: true })))
    .setFooter({ text: `${Object.keys(COMMANDS).length} commands | All also available as /slash commands` })
    .setThumbnail(client.user.displayAvatarURL()).setTimestamp();

  const menu = new StringSelectMenuBuilder().setCustomId('help_menu').setPlaceholder('📂 Select a category…')
    .addOptions(Object.entries(CATS).map(([key, v]) => ({ label: v.label, value: key, description: v.desc, emoji: v.emoji })));

  ctx.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
}

function buildCatEmbed(cat, guildId) {
  const prefix = getPrefix(guildId);
  const c      = CATS[cat] || { emoji: '📋', label: cat, color: 0x5865f2 };
  const cmds   = Object.entries(COMMANDS).filter(([, v]) => v.cat === cat);
  return new EmbedBuilder()
    .setColor(c.color).setTitle(`${c.emoji} ${c.label} Commands`)
    .setDescription(cmds.map(([n, v]) => `\`${prefix}${n}\` — ${v.desc}`).join('\n'))
    .setFooter({ text: `Prefix: ${prefix} | Also /slash  | ceas <cmd>` }).setTimestamp();
}

// ─── Slash command definitions (one for every command) ────────────────────────
const SLASH_DEFS = [
  // Admin
  new SlashCommandBuilder().setName('setup').setDescription('Configure the bot (admin only)')
    .addStringOption(o => o.setName('option').setDescription('What to configure').setRequired(false)
      .addChoices(
        { name: 'view  — Show current settings',   value: 'view'         },
        { name: 'welcome — Welcome channel',        value: 'welcome'      },
        { name: 'logs — Mod log channel',           value: 'logs'         },
        { name: 'tickets — Ticket category name',   value: 'tickets'      },
        { name: 'modrole — Moderator role',         value: 'modrole'      },
        { name: 'adminrole — Admin role',           value: 'adminrole'    },
        { name: 'prefix — Command prefix',          value: 'prefix'       },
        { name: 'welcomeimage — Welcome image URL', value: 'welcomeimage' },
        { name: 'reset — Clear all settings',       value: 'reset'        },
      ))
    .addStringOption(o => o.setName('value').setDescription('Channel mention, role mention, ID, or text').setRequired(false)),

  // Moderation
  new SlashCommandBuilder().setName('ban').setDescription('Ban a member').setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o => o.setName('user').setDescription('Member to ban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

  new SlashCommandBuilder().setName('unban').setDescription('Unban a user by ID').setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption(o => o.setName('userid').setDescription('User ID to unban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

  new SlashCommandBuilder().setName('kick').setDescription('Kick a member').setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(o => o.setName('user').setDescription('Member to kick').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

  new SlashCommandBuilder().setName('mute').setDescription('Timeout a member').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Member to mute').setRequired(true))
    .addIntegerOption(o => o.setName('duration').setDescription('Duration in minutes (default 10)').setMinValue(1).setMaxValue(40320).setRequired(false))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

  new SlashCommandBuilder().setName('unmute').setDescription('Remove timeout from a member').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Member to unmute').setRequired(true)),

  new SlashCommandBuilder().setName('warn').setDescription('Warn a member').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Member to warn').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

  new SlashCommandBuilder().setName('warnings').setDescription('View warnings for a member').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Member to check').setRequired(true)),

  new SlashCommandBuilder().setName('clearwarns').setDescription('Clear all warnings for a member').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)),

  new SlashCommandBuilder().setName('purge').setDescription('Bulk delete messages').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(o => o.setName('amount').setDescription('Number of messages (1–100)').setMinValue(1).setMaxValue(100).setRequired(true))
    .addUserOption(o => o.setName('user').setDescription('Only delete from this user').setRequired(false)),

  new SlashCommandBuilder().setName('lock').setDescription('Lock the current channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

  new SlashCommandBuilder().setName('unlock').setDescription('Unlock the current channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder().setName('slowmode').setDescription('Set slowmode (0 = off)').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption(o => o.setName('seconds').setDescription('Seconds (0–21600)').setMinValue(0).setMaxValue(21600).setRequired(true)),

  new SlashCommandBuilder().setName('nickname').setDescription("Change a member's nickname").setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('nick').setDescription('New nickname (empty = reset)').setRequired(false)),

  new SlashCommandBuilder().setName('role').setDescription('Give or remove a role from a member').setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Role to give/remove').setRequired(true)),

  // General
  new SlashCommandBuilder().setName('afk').setDescription('Set or remove your AFK')
    .addStringOption(o => o.setName('reason').setDescription('AFK reason').setRequired(false)),

  new SlashCommandBuilder().setName('help').setDescription('Show the help menu'),

  // Social
  new SlashCommandBuilder().setName('vouch').setDescription('Vouch for a member')
    .addUserOption(o => o.setName('user').setDescription('Who to vouch for').setRequired(true))
    .addStringOption(o => o.setName('comment').setDescription('Your comment').setRequired(false)),

  new SlashCommandBuilder().setName('vouches').setDescription('View vouches for a member')
    .addUserOption(o => o.setName('user').setDescription('Member to check').setRequired(false)),

  new SlashCommandBuilder().setName('unvouch').setDescription('Remove your vouch for a member')
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)),

  new SlashCommandBuilder().setName('vouchleader').setDescription('Vouch leaderboard'),

  // Utility
  new SlashCommandBuilder().setName('say').setDescription('Send a message as the bot').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption(o => o.setName('message').setDescription('Text to send (use "embed Title | Description" for an embed)').setRequired(true)),

  new SlashCommandBuilder().setName('embed').setDescription('Send a custom embed').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption(o => o.setName('title').setDescription('Title').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Description').setRequired(true))
    .addStringOption(o => o.setName('color').setDescription('Hex color e.g. #ff5500').setRequired(false))
    .addStringOption(o => o.setName('image').setDescription('Image URL').setRequired(false)),

  new SlashCommandBuilder().setName('userinfo').setDescription('View info about a user')
    .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(false)),

  new SlashCommandBuilder().setName('serverinfo').setDescription('View server information'),

  new SlashCommandBuilder().setName('avatar').setDescription("Get a user's avatar")
    .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(false)),

  new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),

  // Tickets
  new SlashCommandBuilder().setName('ticket').setDescription('Post the ticket panel').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('close').setDescription('Close the current ticket')
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

  // Anti-Nuke
  new SlashCommandBuilder().setName('antinuke').setDescription('Configure anti-nuke protection').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('action').setDescription('What to do').setRequired(true)
      .addChoices(
        { name: 'status — View current settings',       value: 'status'      },
        { name: 'on — Enable anti-nuke',                value: 'on'          },
        { name: 'off — Disable anti-nuke',              value: 'off'         },
        { name: 'whitelist — Whitelist a user',         value: 'whitelist'   },
        { name: 'unwhitelist — Remove from whitelist',  value: 'unwhitelist' },
      ))
    .addUserOption(o => o.setName('user').setDescription('User to whitelist/unwhitelist').setRequired(false))
    .addStringOption(o => o.setName('threshold_type').setDescription('Threshold to change (ban/kick/chdel/roledel/webhook)').setRequired(false))
    .addIntegerOption(o => o.setName('threshold_value').setDescription('New threshold value (min 1)').setMinValue(1).setRequired(false)),
];

// ─── Resolve a guild member from interaction options ──────────────────────────
async function resolveMember(guild, user) {
  if (!user) return null;
  return guild.members.fetch(user.id).catch(() => null);
}

// ─── Interaction Handler ──────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {

  // Help dropdown
  if (interaction.isStringSelectMenu() && interaction.customId === 'help_menu') {
    return interaction.update({ embeds: [buildCatEmbed(interaction.values[0], interaction.guild.id)], components: interaction.message.components });
  }

  // Ticket buttons
  if (interaction.isButton()) {
    if (interaction.customId === 'ticket_create') {
      await interaction.deferReply({ ephemeral: true });
      const r = await createTicket(interaction.guild, interaction.member);
      return interaction.editReply({ content: r.existing ? `⚠️ You already have a ticket: ${r.channel}` : `✅ Ticket created: ${r.channel}` });
    }
    if (interaction.customId === 'ticket_close') {
      if (!openTickets.has(interaction.channel.id)) return interaction.reply({ embeds: [err('Not a ticket channel.')], ephemeral: true });
      if (!isMod(interaction.member) && interaction.user.id !== openTickets.get(interaction.channel.id)?.userId)
        return interaction.reply({ embeds: [err('Only staff or the ticket owner can close this.')], ephemeral: true });
      await interaction.reply({ embeds: [warn('Closing…', 'Ticket will be deleted shortly.')], ephemeral: true });
      return closeTicket(interaction.channel, interaction.member);
    }
    if (interaction.customId === 'ticket_claim') {
      if (!isMod(interaction.member)) return interaction.reply({ embeds: [err('Only staff can claim.')], ephemeral: true });
      return interaction.update({ embeds: [...interaction.message.embeds, ok('Claimed', `Claimed by ${interaction.member}`)], components: [] });
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const ctx  = ctxFromInteraction(interaction);
  const { commandName, options, guild } = interaction;

  // Route every slash command to its COMMANDS[].run() with resolved args
  try {
    switch (commandName) {
      case 'setup': {
        const opt = options.getString('option') || 'view';
        const val = options.getString('value')  || '';
        return await runSetup(ctx, [opt, ...val.split(/\s+/).filter(Boolean)]);
      }
      case 'ban': {
        const member = await resolveMember(guild, options.getUser('user'));
        const reason = options.getString('reason') || '';
        return await COMMANDS.ban.run(ctx, reason ? [reason] : [], member);
      }
      case 'unban': {
        const userId = options.getString('userid');
        const reason = options.getString('reason') || '';
        return await COMMANDS.unban.run(ctx, [userId, ...reason.split(' ')].filter(Boolean));
      }
      case 'kick': {
        const member = await resolveMember(guild, options.getUser('user'));
        const reason = options.getString('reason') || '';
        return await COMMANDS.kick.run(ctx, reason ? [reason] : [], member);
      }
      case 'mute': {
        const member   = await resolveMember(guild, options.getUser('user'));
        const duration = options.getInteger('duration') || 10;
        const reason   = options.getString('reason') || '';
        return await COMMANDS.mute.run(ctx, [String(duration), ...reason.split(' ')].filter(Boolean), member);
      }
      case 'unmute': {
        const member = await resolveMember(guild, options.getUser('user'));
        return await COMMANDS.unmute.run(ctx, [], member);
      }
      case 'warn': {
        const member = await resolveMember(guild, options.getUser('user'));
        const reason = options.getString('reason') || '';
        return await COMMANDS.warn.run(ctx, reason ? [reason] : [], member);
      }
      case 'warnings': {
        const member = await resolveMember(guild, options.getUser('user'));
        return await COMMANDS.warnings.run(ctx, [], member);
      }
      case 'clearwarns': {
        const member = await resolveMember(guild, options.getUser('user'));
        return await COMMANDS.clearwarns.run(ctx, [], member);
      }
      case 'purge': {
        const amount = options.getInteger('amount');
        const user   = options.getUser('user');
        const fMember= user ? await resolveMember(guild, user) : null;
        return await COMMANDS.purge.run(ctx, [String(amount)], fMember);
      }
      case 'lock':    return await COMMANDS.lock.run(ctx,    [options.getString('reason') || '']);
      case 'unlock':  return await COMMANDS.unlock.run(ctx,  []);
      case 'slowmode':return await COMMANDS.slowmode.run(ctx,[String(options.getInteger('seconds'))]);
      case 'nickname': {
        const member = await resolveMember(guild, options.getUser('user'));
        const nick   = options.getString('nick') || '';
        return await COMMANDS.nickname.run(ctx, nick ? [nick] : [], member);
      }
      case 'role': {
        const member  = await resolveMember(guild, options.getUser('user'));
        const roleObj = options.getRole('role');
        const fullRole= guild.roles.cache.get(roleObj?.id);
        return await COMMANDS.role.run(ctx, [], member, fullRole);
      }
      case 'afk':    return await COMMANDS.afk.run(ctx,  [options.getString('reason') || ''].filter(Boolean));
      case 'help':   return await COMMANDS.help.run(ctx, []);
      case 'vouch': {
        const member  = await resolveMember(guild, options.getUser('user'));
        const comment = options.getString('comment') || '';
        return await COMMANDS.vouch.run(ctx, comment ? [comment] : [], member);
      }
      case 'vouches': {
        const user   = options.getUser('user');
        const member = user ? await resolveMember(guild, user) : ctx.member;
        return await COMMANDS.vouches.run(ctx, [], member);
      }
      case 'unvouch': {
        const member = await resolveMember(guild, options.getUser('user'));
        return await COMMANDS.unvouch.run(ctx, [], member);
      }
      case 'vouchleader': return await COMMANDS.vouchleader.run(ctx, []);
      case 'say': {
        const msg = options.getString('message');
        return await COMMANDS.say.run(ctx, msg.split(' '));
      }
      case 'embed': {
        const title = options.getString('title');
        const desc  = options.getString('description');
        const color = options.getString('color') || '';
        const image = options.getString('image') || '';
        return await COMMANDS.embed.run(ctx, [title, '|', desc, color ? '|' : '', color, image ? '|' : '', image].filter(Boolean));
      }
      case 'userinfo': {
        const member = options.getUser('user') ? await resolveMember(guild, options.getUser('user')) : ctx.member;
        return await COMMANDS.userinfo.run(ctx, [], member);
      }
      case 'serverinfo': return await COMMANDS.serverinfo.run(ctx, []);
      case 'avatar': {
        const member = options.getUser('user') ? await resolveMember(guild, options.getUser('user')) : ctx.member;
        return await COMMANDS.avatar.run(ctx, [], member);
      }
      case 'ping':   return await COMMANDS.ping.run(ctx, []);
      case 'ticket': return await COMMANDS.ticket.run(ctx, []);
      case 'close':  return await COMMANDS.close.run(ctx, [options.getString('reason') || ''].filter(Boolean));
      case 'antinuke': {
        const action = options.getString('action');
        const user   = options.getUser('user');
        const tType  = options.getString('threshold_type');
        const tVal   = options.getInteger('threshold_value');
        const args   = [action];
        if (user)   args.push(user.id);
        if (tType && tVal) { args[0] = 'threshold'; args.push(tType, String(tVal)); }
        return await COMMANDS.antinuke.run(ctx, args);
      }
    }
  } catch (e) {
    console.error(`Slash error [${commandName}]:`, e);
    try { ctx.reply({ embeds: [err('An error occurred.')] }); } catch {}
  }
});

// ─── Message Handler ───────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();
  const lower   = content.toLowerCase();
  const PREFIX  = getPrefix(message.guild.id);

  // AFK: auto-remove when user talks
  if (afkUsers.has(message.author.id)) {
    await removeAfk(message.member);
    const r = await message.reply({ embeds: [ok('Welcome back!', 'Your AFK has been removed.')] });
    setTimeout(() => r.delete().catch(() => {}), 5000);
  }

  // AFK: notify when pinging an AFK user
  for (const mentioned of message.mentions.members.values()) {
    if (afkUsers.has(mentioned.id)) {
      const d   = afkUsers.get(mentioned.id);
      const ago = Date.now() - d.since;
      const t   = ago < 60000 ? `${Math.floor(ago/1000)}s` : ago < 3600000 ? `${Math.floor(ago/60000)}m` : `${Math.floor(ago/3600000)}h`;
      message.reply({ embeds: [warn('User is AFK', `**${mentioned.user.tag}** has been AFK for **${t}**.\n**Reason:** ${d.reason}`)] }).catch(() => {});
      break;
    }
  }

  // ── Reply Trigger System ─────────────────────────────────────────────────────
  if (message.reference?.messageId) {
    const ref = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    if (ref && !ref.author.bot && ref.author.id !== message.author.id) {
      const stripped = content.replace(new RegExp(`^(${PREFIX}|${BOT_NAME}\\s+)`, 'i'), '').trim();
      const parts    = stripped.split(/\s+/);
      const trigger  = parts[0].toLowerCase();
      const tArgs    = parts.slice(1);

      if (COMMANDS[trigger] && isMod(message.member)) {
        const tMember = await message.guild.members.fetch(ref.author.id).catch(() => null);
        if (tMember) {
          const ctx = ctxFromMessage(message);
          try { await COMMANDS[trigger].run(ctx, tArgs, tMember); } catch (e) { console.error(e); }
          return;
        }
      }

      // Role name trigger
      if (isMod(message.member) && stripped && !COMMANDS[trigger]) {
        const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === stripped.toLowerCase());
        if (role) {
          const tMember = await message.guild.members.fetch(ref.author.id).catch(() => null);
          if (tMember) {
            const ctx = ctxFromMessage(message);
            try { await COMMANDS.role.run(ctx, [], tMember, role); } catch { ctx.reply({ embeds: [err('Failed to manage role.')] }); }
            return;
          }
        }
      }
    }
  }

  // ── Prefix / no-prefix parsing ───────────────────────────────────────────────
  let cmdName = null, args = [];
  if (lower.startsWith(PREFIX)) {
    const split = content.slice(PREFIX.length).trim().split(/\s+/);
    cmdName = split[0].toLowerCase(); args = split.slice(1);
  } else if (lower.startsWith(BOT_NAME + ' ') || lower === BOT_NAME) {
    const split = content.slice(BOT_NAME.length).trim().split(/\s+/);
    cmdName = split[0]?.toLowerCase(); args = split.slice(1);
  } else return;

  if (!cmdName) return message.reply({ embeds: [info('👋 Hey!', `Use \`${PREFIX}help\` or \`ceas help\`\nFirst time? Run \`${PREFIX}setup\` to configure!`)] });

  const command = COMMANDS[cmdName];
  if (!command) return message.reply({ embeds: [err(`Unknown command \`${cmdName}\`\nUse \`${PREFIX}help\` for the full list.`)] });

  const ctx = ctxFromMessage(message);

  // Resolve prefix-command target from mentions
  let target = null;
  if (!['purge', 'setup', 'say', 'embed', 'serverinfo', 'ping', 'ticket', 'close', 'help', 'unban', 'lock', 'unlock', 'slowmode', 'afk', 'vouchleader'].includes(cmdName)) {
    const mentioned = message.mentions.members.first();
    if (mentioned) {
      target = mentioned;
      args   = args.filter(a => !a.startsWith('<@') && a !== mentioned.id);
    }
  }
  if (cmdName === 'purge') {
    const fUser = message.mentions.members.first();
    target = fUser || null;
    if (fUser) args = args.filter(a => !a.startsWith('<@'));
  }

  try { await command.run(ctx, args, target); }
  catch (e) { console.error(`Prefix error [${cmdName}]:`, e); message.reply({ embeds: [err('An error occurred.')] }).catch(() => {}); }
});

// ─── Anti-Nuke Event Listeners ────────────────────────────────────────────────
// Mass Ban detection
client.on(Events.GuildBanAdd, async (ban) => {
  const cfg = gc(ban.guild.id);
  if (!cfg.antinuke) return;
  const audit = await ban.guild.fetchAuditLogs({ type: 22, limit: 1 }).catch(() => null); // 22 = MEMBER_BAN_ADD
  const entry = audit?.entries.first();
  if (!entry || Date.now() - entry.createdTimestamp > 3000) return;
  const executorId = entry.executor?.id;
  if (!executorId || executorId === client.user.id) return;
  if (isNukeWhitelisted(ban.guild, executorId)) return;
  const log = getNukeLog(ban.guild.id, executorId);
  log.bans.push(Date.now());
  const thr = cfg.nukeThresholds?.ban ?? NUKE_DEFAULTS.ban;
  if (recentCount(log.bans) >= thr) {
    await punishNuker(ban.guild, executorId, `Mass ban (≥${thr} bans in 10s)`);
    log.bans = [];
  }
});

// Mass Kick detection (GuildMemberRemove + audit log)
client.on(Events.GuildMemberRemove, async (member) => {
  if (member.user.bot) return;
  const cfg = gc(member.guild.id);
  if (!cfg.antinuke) return;
  const audit = await member.guild.fetchAuditLogs({ type: 20, limit: 1 }).catch(() => null); // 20 = MEMBER_KICK
  const entry = audit?.entries.first();
  if (!entry || Date.now() - entry.createdTimestamp > 3000) return;
  const executorId = entry.executor?.id;
  if (!executorId || executorId === client.user.id) return;
  if (isNukeWhitelisted(member.guild, executorId)) return;
  const log = getNukeLog(member.guild.id, executorId);
  log.kicks.push(Date.now());
  const thr = cfg.nukeThresholds?.kick ?? NUKE_DEFAULTS.kick;
  if (recentCount(log.kicks) >= thr) {
    await punishNuker(member.guild, executorId, `Mass kick (≥${thr} kicks in 10s)`);
    log.kicks = [];
  }
});

// Mass Channel Delete detection
client.on(Events.ChannelDelete, async (channel) => {
  if (!channel.guild) return;
  const cfg = gc(channel.guild.id);
  if (!cfg.antinuke) return;
  const audit = await channel.guild.fetchAuditLogs({ type: 12, limit: 1 }).catch(() => null); // 12 = CHANNEL_DELETE
  const entry = audit?.entries.first();
  if (!entry || Date.now() - entry.createdTimestamp > 3000) return;
  const executorId = entry.executor?.id;
  if (!executorId || executorId === client.user.id) return;
  if (isNukeWhitelisted(channel.guild, executorId)) return;
  const log = getNukeLog(channel.guild.id, executorId);
  log.chDel.push(Date.now());
  const thr = cfg.nukeThresholds?.chDel ?? NUKE_DEFAULTS.chDel;
  if (recentCount(log.chDel) >= thr) {
    await punishNuker(channel.guild, executorId, `Mass channel delete (≥${thr} in 10s)`);
    log.chDel = [];
  }
});

// Mass Role Delete detection
client.on(Events.GuildRoleDelete, async (role) => {
  const cfg = gc(role.guild.id);
  if (!cfg.antinuke) return;
  const audit = await role.guild.fetchAuditLogs({ type: 32, limit: 1 }).catch(() => null); // 32 = ROLE_DELETE
  const entry = audit?.entries.first();
  if (!entry || Date.now() - entry.createdTimestamp > 3000) return;
  const executorId = entry.executor?.id;
  if (!executorId || executorId === client.user.id) return;
  if (isNukeWhitelisted(role.guild, executorId)) return;
  const log = getNukeLog(role.guild.id, executorId);
  log.roleDel.push(Date.now());
  const thr = cfg.nukeThresholds?.roleDel ?? NUKE_DEFAULTS.roleDel;
  if (recentCount(log.roleDel) >= thr) {
    await punishNuker(role.guild, executorId, `Mass role delete (≥${thr} in 10s)`);
    log.roleDel = [];
  }
});

// Webhook creation detection
client.on(Events.WebhooksUpdate, async (channel) => {
  const cfg = gc(channel.guild.id);
  if (!cfg.antinuke) return;
  const audit = await channel.guild.fetchAuditLogs({ type: 101, limit: 1 }).catch(() => null); // 101 = WEBHOOK_CREATE
  const entry = audit?.entries.first();
  if (!entry || Date.now() - entry.createdTimestamp > 3000) return;
  const executorId = entry.executor?.id;
  if (!executorId || executorId === client.user.id) return;
  if (isNukeWhitelisted(channel.guild, executorId)) return;
  const log = getNukeLog(channel.guild.id, executorId);
  log.webhooks.push(Date.now());
  const thr = cfg.nukeThresholds?.webhook ?? NUKE_DEFAULTS.webhook;
  if (recentCount(log.webhooks) >= thr) {
    await punishNuker(channel.guild, executorId, `Suspicious webhook creation (≥${thr} in 10s)`);
    log.webhooks = [];
  }
});

// Bot addition detection (suspicious — nuke bots are added right before attacking)
client.on(Events.GuildMemberAdd, async (member) => {
  if (!member.user.bot) return;
  const cfg = gc(member.guild.id);
  if (!cfg.antinuke) return;
  const audit = await member.guild.fetchAuditLogs({ type: 28, limit: 1 }).catch(() => null); // 28 = BOT_ADD
  const entry = audit?.entries.first();
  if (!entry || Date.now() - entry.createdTimestamp > 5000) return;
  const executorId = entry.executor?.id;
  if (!executorId || executorId === client.user.id) return;
  if (isNukeWhitelisted(member.guild, executorId)) {
    // Whitelisted — just log
    sendLog(member.guild, info('🤖 Bot Added', `Bot **${member.user.tag}** added by <@${executorId}> (whitelisted)`));
    return;
  }
  // Non-whitelisted user added a bot → warn in log
  sendLog(member.guild, new EmbedBuilder().setColor(0xfee75c).setTitle('⚠️ Unwhitelisted Bot Added')
    .setDescription(`Bot **${member.user.tag}** was added by <@${executorId}>.\nIf this looks suspicious, run \`antinuke whitelist\` for trusted admins.`)
    .setTimestamp());
});

// ─── Welcome ──────────────────────────────────────────────────────────────────
client.on(Events.GuildMemberAdd, async (member) => {
  const cfg = gc(member.guild.id);
  if (!cfg.welcomeChannel) return;
  const ch = member.guild.channels.cache.get(cfg.welcomeChannel);
  if (!ch) return;
  const emb = new EmbedBuilder()
    .setColor(0x57f287).setTitle(`👋 Welcome to ${member.guild.name}!`)
    .setDescription(`Hey ${member}!\nYou are member **#${member.guild.memberCount}**.\nPlease read the rules and enjoy your stay!`)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: '📅 Account Age',  value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
      { name: '👥 Member Count', value: `${member.guild.memberCount}`,                              inline: true },
    )
    .setFooter({ text: member.guild.name, iconURL: member.guild.iconURL() }).setTimestamp();
  if (cfg.welcomeImage) emb.setImage(cfg.welcomeImage);
  ch.send({ embeds: [emb] });
});

// ─── Ready ─────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`\n✅  Ceas Bot online — ${client.user.tag}`);
  console.log(`⚙️   Config stored in config.json | Use c.setup to configure`);
  console.log(`🔷  ${SLASH_DEFS.length} slash commands | ${Object.keys(COMMANDS).length} prefix commands\n`);
  client.user.setActivity('NO LIMIT 💫', { type: 3 }); // type 3 = Watching

  // Register slash commands to every guild (instant) + global fallback
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  const body = SLASH_DEFS.map(c => c.toJSON());
  for (const [guildId] of client.guilds.cache) {
    rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body })
      .then(() => console.log(`✅  Slash commands → guild ${guildId}`))
      .catch(e => console.warn(`⚠️   Guild ${guildId}: ${e.message}`));
  }
});

client.on(Events.Error, e => console.error('Client error:', e));
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));
client.login(process.env.BOT_TOKEN);
