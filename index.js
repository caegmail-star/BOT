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
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

const BOT_NAME = 'ceas';
const OWNER_ID = process.env.OWNER_ID || '';

// ─── In-Memory Stores (loaded from MongoDB on ready) ────────────────────────
const warnings    = new Map(); // userId    → [{reason,date,moderator}]
const openTickets = new Map(); // channelId → {userId,createdAt}
const vouches     = new Map(); // targetId  → [{fromId,fromTag,comment,date}]
const nickHistory = new Map(); // userId    → [{oldNick,newNick,by,date}]
const activeDeals = new Map(); // dealId    → deal object
const inviteCache = new Map(); // session only
const inviteJoins = new Map(); // session only
const afkUsers    = new Map(); // session only
const snipeStore  = new Map(); // session only

// Save helpers — update in-memory Map then fire-and-forget to MongoDB

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

// ─── Custom Emoji Constants ───────────────────────────────────────────────────
// Helper: parse <:name:id> / <a:name:id> strings into the object Discord.js
// components (buttons, select-menu options) require for custom emoji fields.
function parseEmoji(str) {
  const m = str.match(/<(a?):([^:]+):(\d+)>/);
  if (m) return { animated: m[1] === 'a', name: m[2], id: m[3] };
  return { name: str }; // unicode fallback
}

const E = {
  check:   '<:emoji_26:1518572775470530641>',  // success
  deny:    '<:emoji_3:1518572085746597970>',   // error
  warn:    '<a:1000003084:1518572069896323174>',
  info:    '<:info:1518572049042378886>',
  arrow:   '<a:arrow_arrow:1518572000413487117>',
  hash:    '<a:pb_y_chat:1518572054981509152>',
  stock:   '<a:stock:1518571994508038156>',
  gift:    '<a:giftbox:1518572043002581082>',
  nitroA:  '<a:Boost:1518570980136718367>',
  nitro:   '<:10337sparklesnitroboostt:1518572012975427685>',
  boost:   '<a:Boost:1518570980136718367>',
  flower:  '<:emoji_26:1518572775470530641>',
  emoji10: '<:emoji_10:1518571988984139906>',
  secure:  '<:antinuke:1518570604553437285>',
  rules:   '<:RULES_RULES:1518572006453547038>',
  cart:    '<:cart:1518572036803264583>',
  setting: '<:spider_setting:1518572018658705448>',
  staff:   '<:emoji_4:1518570431995576443>',
  mod:     '<:emoji_5:1518570463788535949>',
  bots:    '<:ml_f_bots:1433637091622916116>',
  card:    '<:card:1518572030801219624>',
  chat:    '<a:pb_y_chat:1518572054981509152>',
  updates: '<a:pb_y_updates:1518572060551548938>',
  wifi:    '<:wifi:1518570787383021738>',
  sinfo:   '<:spider_info:1518572024241328230>',
  antinuke:'<:antinuke:1518570604553437285>',
  e1:  '<:emoji_1:1518570328559845539>',
  e2:  '<:emoji_2:1518570359262154793>',
  e3:  '<:emoji_3:1518570406825562303>',
  e3b: '<:emoji_3:1518572085746597970>',
  e4:  '<:emoji_4:1518570431995576443>',
  e5:  '<:emoji_5:1518570463788535949>',
  e10: '<:emoji_10:1518571988984139906>',
  e26: '<:emoji_26:1518572775470530641>',
  e27: '<:emoji_27:1518573391244951572>',
  e28: '<:emoji_28:1518576868486283274>',
};

// ─── Embed helpers ────────────────────────────────────────────────────────────
const ok   = (t, d) => new EmbedBuilder().setColor(0x57f287).setTitle(`${E.check} ${t}`).setDescription(d).setTimestamp();
const err  = (d)    => new EmbedBuilder().setColor(0xed4245).setTitle(`${E.deny} Error`).setDescription(d).setTimestamp();
const info = (t, d) => new EmbedBuilder().setColor(0x5865f2).setTitle(`${E.arrow} ${t}`).setDescription(d).setTimestamp();
const warn = (t, d) => new EmbedBuilder().setColor(0xfee75c).setTitle(`${E.warn} ${t}`).setDescription(d).setTimestamp();

// ─── Professional mod embed ───────────────────────────────────────────────────
// Rich embed with target thumbnail, moderator footer, action-specific color
const MOD_COLORS = { ban:0xe74c3c, kick:0xe67e22, mute:0xf39c12, unmute:0x2ecc71, warn:0xfee75c, unban:0x2ecc71, clearwarns:0x3498db, nickname:0x9b59b6, role:0x5865f2 };
function modEmbed(action, mod, target, reason, fields = []) {
  const color = MOD_COLORS[action.toLowerCase()] ?? 0x5865f2;
  const icons  = { ban:E.mod, kick:E.mod, mute:E.warn, unmute:E.check, warn:E.warn, unban:E.check, clearwarns:E.check, nickname:E.setting, role:E.staff };
  const icon   = icons[action.toLowerCase()] ?? E.warn;
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: `${action}`, iconURL: target.user.displayAvatarURL() })
    .setDescription(`**User:** ${target.user.tag}\n**ID:** \`${target.id}\`\n**Reason:** ${reason}`)
    .setThumbnail(target.user.displayAvatarURL({ size: 256 }))
    .addFields(fields.map(([n, v]) => ({ name: n, value: v, inline: true })))
    .setFooter({ text: `Moderator: ${mod.tag}`, iconURL: mod.displayAvatarURL() })
    .setTimestamp();
}

// DM a user before a moderation action so they receive it even after removal
async function dmAction(user, action, guildName, reason, extra = '') {
  const colors = { Banned:0xe74c3c, Kicked:0xe67e22, Muted:0xf39c12, Warned:0xfee75c };
  return user.send({ embeds: [new EmbedBuilder()
    .setColor(colors[action] ?? 0x5865f2)
    .setTitle(`${action} from ${guildName}`)
    .setDescription(`You have been **${action.toLowerCase()}** from **${guildName}**.\n**Reason:** ${reason}${extra}`)
    .setFooter({ text: 'Contact a staff member if you believe this is a mistake.' })
    .setTimestamp()] }).catch(() => {});
}

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
    // fetchReply:true makes slash reply return a Message (needed for .react())
    if (!ephemeral) return interaction.reply({ ...payload, fetchReply: true });
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
  try { await member.setNickname(`[A F K] ${original}`.slice(0, 32)); } catch {}
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
  let channel;
  try {
    channel = await guild.channels.create(opts);
  } catch (e) {
    console.error('createTicket error:', e.message);
    return { error: e.message };
  }
  openTickets.set(channel.id, { userId: member.id, createdAt: new Date() });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setEmoji({ id: '1518570359262154793', name: 'emoji_2' }).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim').setEmoji({ id: '1518570406825562303', name: 'emoji_3' }).setStyle(ButtonStyle.Success),
  );
  await channel.send({
    content: `${member}${cfg.modRole ? ` <@&${cfg.modRole}>` : ''}`,
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${E.hash} Ticket Opened`).setDescription(`Welcome ${member}!\nDescribe your issue and staff will help shortly.`).addFields({ name: 'Close', value: 'Button below or `close` command' }).setFooter({ text: guild.name, iconURL: guild.iconURL() }).setTimestamp()],
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
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${E.info} Your Ticket Transcript`).setDescription(`Your ticket **#${channel.name}** was closed.\n**Reason:** ${reason}\n\nFull transcript attached.`).setTimestamp()],
      files: [file],
    });
  } catch {}
  sendLog(channel.guild, new EmbedBuilder().setColor(0xed4245).setTitle(`${E.deny} Ticket Closed`).setDescription(`**Channel:** #${channel.name}\n**Closed by:** ${closedBy}\n**Reason:** ${reason}`).setTimestamp());
  openTickets.delete(channel.id);
  await channel.send({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle(`${E.deny} Closing in 5 seconds…`).setDescription(`Reason: ${reason}`).setTimestamp()] });
  setTimeout(() => channel.delete().catch(() => {}), 5000);
}

// ─── Setup command logic ──────────────────────────────────────────────────────
const SETUP_KEYS = {
  welcome:      { label: 'Welcome channel',    key: 'welcomeChannel', type: 'channel'  },
  logs:         { label: 'Mod log channel',    key: 'logChannel',     type: 'channel'  },
  tickets:      { label: 'Ticket category',    key: 'ticketCategory', type: 'category' },
  modrole:      { label: 'Moderator role',     key: 'modRole',        type: 'role'     },
  adminrole:    { label: 'Admin role',         key: 'adminRole',      type: 'role'     },
  mutedrole:    { label: 'Muted role',         key: 'mutedRole',      type: 'role'     },
  prefix:       { label: 'Command prefix',     key: 'prefix',         type: 'text'     },
  welcomeimage: { label: 'Welcome image URL',  key: 'welcomeImage',   type: 'text'     },
  welcomemsg:   { label: 'Welcome message',    key: 'welcomeMsg',     type: 'text'     },
};

async function runSetup(ctx, args) {
  if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions.')] });
  const sub = (args[0] || 'view').toLowerCase();

  if (sub === 'view') {
    const cfg = gc(ctx.guild.id);
    return ctx.reply({ embeds: [info('Server Configuration', [
      `**Prefix:** \`${cfg.prefix || 'c.'}\``,
      `**No-Prefix Mode:** ${cfg.noprefix ? E.check + ' Enabled (mods only)' : E.deny + ' Disabled'}`,
      `**Welcome Channel:** ${cfg.welcomeChannel  ? `<#${cfg.welcomeChannel}>`         : 'Not set'}`,
      `**Welcome Message:** ${cfg.welcomeMsg      ? `\`${cfg.welcomeMsg.slice(0,60)}${cfg.welcomeMsg.length>60?'…':''}\`` : 'Default'}`,
      `**Welcome Image:**   ${cfg.welcomeImage    ? `[link](${cfg.welcomeImage})`       : 'Not set'}`,
      `**Log Channel:**     ${cfg.logChannel      ? `<#${cfg.logChannel}>`              : 'Not set'}`,
      `**Ticket Category:** ${cfg.ticketCategory  ? `<#${cfg.ticketCategory}>`          : 'Not set'}`,
      `**Ticket Note:**     ${cfg.ticketNote      ? `\`${cfg.ticketNote.slice(0,50)}${cfg.ticketNote.length>50?'…':''}\`` : 'Default'}`,
      `**Goodbye Channel:** ${cfg.goodbyeChannel  ? `<#${cfg.goodbyeChannel}>`          : 'Not set'}`,
      `**Goodbye Message:** ${cfg.goodbyeMsg      ? `\`${cfg.goodbyeMsg.slice(0,60)}${cfg.goodbyeMsg.length>60?'…':''}\`` : 'Default'}`,
      `**Deal Log:**        ${cfg.dealLogChannel  ? `<#${cfg.dealLogChannel}>`                : 'Not set (use setdeallog)'}`,
      `**Media-Only:**      ${(cfg.mediaChannels||[]).length ? (cfg.mediaChannels||[]).map(id=>`<#${id}>`).join(', ') : 'None set'}`,
      `**Media Whitelist:** ${(cfg.mediaWhitelist||[]).length ? `${(cfg.mediaWhitelist||[]).length} entries` : 'None'}`,
      `**Mod Role:**        ${cfg.modRole         ? `<@&${cfg.modRole}>`                : 'Not set'}`,
      `**Admin Role:**      ${cfg.adminRole       ? `<@&${cfg.adminRole}>`              : 'Not set'}`,
      `**Muted Role:**      ${cfg.mutedRole       ? `<@&${cfg.mutedRole}>`              : 'Not set'}`,
    ].join('\n')).setFooter({ text: 'Use the individual set commands to change settings' })] });
  }

  if (sub === 'reset') {
    const c = loadConfig(); delete c[ctx.guild.id]; saveConfig(c);
    return ctx.reply({ embeds: [ok('Config Reset', 'All settings cleared.')] });
  }

  const opt = SETUP_KEYS[sub];
  if (!opt) {
    const list = Object.entries(SETUP_KEYS).map(([k, v]) => `\`setup ${k}\` — ${v.label}`).join('\n');
    return ctx.reply({ embeds: [info('Setup Options', list + '\n\n`setup view` — current config\n`setup reset` — clear all')] });
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
    if (!val) {
      if (sub === 'welcomemsg') {
        return ctx.reply({ embeds: [info('Welcome Message Variables', [
          '`{user}` — mentions the member (e.g. @John)',
          '`{tag}` — their Discord tag (e.g. John#1234)',
          '`{server}` — server name',
          '`{count}` — current member count',
          '',
          '**Example:**',
          '`setup welcomemsg Welcome {user} to {server}! You are member #{count}!`',
          '',
          'Leave it unset to use the default welcome message.',
        ].join('\n'))] });
      }
      return ctx.reply({ embeds: [err(`Provide a value for **${opt.label}**.`)] });
    }
    if (sub === 'prefix' && val.length > 5) return ctx.reply({ embeds: [err('Prefix must be 5 characters or fewer.')] });
    setGC(ctx.guild.id, opt.key, val);
    const preview = sub === 'welcomemsg'
      ? `\n\n**Preview:** ${val.replace('{user}','@Member').replace('{tag}','Member#0001').replace('{server}', ctx.guild.name).replace('{count}', ctx.guild.memberCount)}`
      : '';
    return ctx.reply({ embeds: [ok(`${opt.label} Set`, `${opt.label} saved.${preview}`)] });
  }
}

// ─── COMMANDS (each takes ctx, args, target?) ─────────────────────────────────
const COMMANDS = {

  // ── Admin ────────────────────────────────────────────────────────────────────
  config: {
    cat: 'admin', usage: 'config', desc: 'View current server configuration',
    run: (ctx) => runSetup(ctx, ['view']),
  },
  setwelcome: {
    cat: 'admin', usage: 'setwelcome #channel', desc: 'Set the welcome channel',
    run: (ctx, args) => runSetup(ctx, ['welcome', ...args]),
  },
  setlogs: {
    cat: 'admin', usage: 'setlogs #channel', desc: 'Set the mod log channel',
    run: (ctx, args) => runSetup(ctx, ['logs', ...args]),
  },
  settickets: {
    cat: 'admin', usage: 'settickets <category name>', desc: 'Set the ticket category',
    run: (ctx, args) => runSetup(ctx, ['tickets', ...args]),
  },
  setmodrole: {
    cat: 'admin', usage: 'setmodrole @role', desc: 'Set the moderator role',
    run: (ctx, args) => runSetup(ctx, ['modrole', ...args]),
  },
  setadminrole: {
    cat: 'admin', usage: 'setadminrole @role', desc: 'Set the admin role',
    run: (ctx, args) => runSetup(ctx, ['adminrole', ...args]),
  },
  setmutedrole: {
    cat: 'admin', usage: 'setmutedrole @role', desc: 'Set the muted role',
    run: (ctx, args) => runSetup(ctx, ['mutedrole', ...args]),
  },
  setprefix: {
    cat: 'admin', usage: 'setprefix <prefix>', desc: 'Change the command prefix',
    run: (ctx, args) => runSetup(ctx, ['prefix', ...args]),
  },
  setwelcomeimage: {
    cat: 'admin', usage: 'setwelcomeimage <url>', desc: 'Set a welcome banner image URL',
    run: (ctx, args) => runSetup(ctx, ['welcomeimage', ...args]),
  },
  setwelcomemsg: {
    cat: 'admin', usage: 'setwelcomemsg <text>', desc: 'Set custom welcome message ({user} {server} {count} {tag})',
    run: (ctx, args) => runSetup(ctx, ['welcomemsg', ...args]),
  },
  setgoodbye: {
    cat: 'admin', usage: 'setgoodbye #channel', desc: 'Set the goodbye/leave channel',
    async run(ctx, args) {
      if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions.')] });
      const chId = args[0]?.replace(/[^0-9]/g, '');
      if (!chId) return ctx.reply({ embeds: [err('Please mention a channel: `setgoodbye #channel`')] });
      const ch = ctx.guild.channels.cache.get(chId);
      if (!ch) return ctx.reply({ embeds: [err('Channel not found.')] });
      setGC(ctx.guild.id, 'goodbyeChannel', chId);
      ctx.reply({ embeds: [ok('Goodbye Channel Set', `Goodbye messages will be sent to ${ch}.\nCustomize with \`setgoodbyemsg <text>\`.\nVariables: \`{user}\` \`{tag}\` \`{server}\` \`{count}\``)] });
    },
  },
  setgoodbyemsg: {
    cat: 'admin', usage: 'setgoodbyemsg <text>', desc: 'Set custom goodbye message ({user} {tag} {server} {count})',
    async run(ctx, args) {
      if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions.')] });
      const text = args.join(' ');
      if (!text) return ctx.reply({ embeds: [err('Please provide a message. Variables: `{user}` `{tag}` `{server}` `{count}`')] });
      setGC(ctx.guild.id, 'goodbyeMsg', text);
      ctx.reply({ embeds: [ok('Goodbye Message Set', `> ${text}`)] });
    },
  },
  resetconfig: {
    cat: 'admin', usage: 'resetconfig', desc: 'Reset all server settings to defaults',
    run: (ctx) => runSetup(ctx, ['reset']),
  },
  setmedia: {
    cat: 'admin', usage: 'setmedia #channel [off]', desc: 'Make a channel media-only (images/videos/files only)',
    async run(ctx, args) {
      if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions.')] });
      const chId = args[0]?.replace(/[^0-9]/g, '');
      if (!chId) return ctx.reply({ embeds: [err('Please mention a channel: `setmedia #channel`')] });
      const ch   = ctx.guild.channels.cache.get(chId);
      if (!ch) return ctx.reply({ embeds: [err('Channel not found.')] });
      const cfg  = gc(ctx.guild.id);
      const list = cfg.mediaChannels || [];
      if (args[1]?.toLowerCase() === 'off') {
        setGC(ctx.guild.id, 'mediaChannels', list.filter(id => id !== chId));
        return ctx.reply({ embeds: [ok('Media-Only Removed', `${ch} is no longer a media-only channel.`)] });
      }
      if (!list.includes(chId)) setGC(ctx.guild.id, 'mediaChannels', [...list, chId]);
      ctx.reply({ embeds: [ok('Media-Only Channel Set', `${ch} is now **media-only**.\n\nOnly images, videos, GIFs, and files are allowed.\nModerators are always exempt. Use \`mediawhitelist add @role\` to exempt other roles.`)] });
    },
  },
  mediawhitelist: {
    cat: 'admin', usage: 'mediawhitelist <add|remove|list> [@role|@user]', desc: 'Manage who can bypass media-only channels',
    async run(ctx, args) {
      if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions.')] });
      const sub  = args[0]?.toLowerCase() || 'list';
      const cfg  = gc(ctx.guild.id);
      const list = cfg.mediaWhitelist || [];
      if (sub === 'list') {
        if (!list.length) return ctx.reply({ embeds: [info('Media Whitelist', 'No entries.\nUse `mediawhitelist add @role` to exempt a role.')] });
        return ctx.reply({ embeds: [info('Media Whitelist', list.map(id => `• <@&${id}> / <@${id}>`).join('\n') + '\n\n*Each shows role & user format — only the correct type will resolve.*')] });
      }
      const rawId = args[1]?.replace(/[^0-9]/g, '');
      if (!rawId) return ctx.reply({ embeds: [err('Please mention a role or user.')] });
      const isRole = args[1]?.startsWith('<@&');
      const label  = isRole ? `<@&${rawId}>` : `<@${rawId}>`;
      if (sub === 'add') {
        if (list.includes(rawId)) return ctx.reply({ embeds: [warn('Already Whitelisted', `${label} is already in the media whitelist.`)] });
        setGC(ctx.guild.id, 'mediaWhitelist', [...list, rawId]);
        return ctx.reply({ embeds: [ok('Whitelisted', `${label} can now post text in media-only channels.`)] });
      }
      if (sub === 'remove') {
        if (!list.includes(rawId)) return ctx.reply({ embeds: [err(`${label} is not in the media whitelist.`)] });
        setGC(ctx.guild.id, 'mediaWhitelist', list.filter(id => id !== rawId));
        return ctx.reply({ embeds: [ok('Removed', `${label} has been removed from the media whitelist.`)] });
      }
      ctx.reply({ embeds: [err('Usage: `mediawhitelist <add|remove|list> [@role/@user]`')] });
    },
  },
  setticketnote: {
    cat: 'admin', usage: 'setticketnote <text>', desc: 'Set the description shown on the ticket panel (leave blank to reset)',
    async run(ctx, args) {
      if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions.')] });
      if (!args.length) {
        setGC(ctx.guild.id, 'ticketNote', null);
        return ctx.reply({ embeds: [ok('Ticket Note Cleared', 'The ticket panel will now show the default description.')] });
      }
      const text = args.join(' ');
      if (text.length > 1024) return ctx.reply({ embeds: [err('Description too long (max 1024 characters).')] });
      setGC(ctx.guild.id, 'ticketNote', text);
      ctx.reply({ embeds: [ok('Ticket Note Set', `The ticket panel will now show:\n\n> ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}`)] });
    },
  },
  setnoprefix: {
    cat: 'admin', usage: 'setnoprefix <on|off>', desc: 'Let mods run commands with no prefix at all (e.g. just "ban @user")',
    async run(ctx, args) {
      if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions.')] });
      const toggle = args[0]?.toLowerCase();
      const cfg    = gc(ctx.guild.id);
      if (toggle === 'on') {
        setGC(ctx.guild.id, 'noprefix', true);
        return ctx.reply({ embeds: [ok('No-Prefix Mode Enabled',
          'Moderators can now use commands with no prefix at all.\n\n' +
          '**Examples:** `ban @user spam` • `kick @user` • `mute @user 10 caps`\n\n' +
          E.warn + ' Only members with the Mod or Admin role can trigger commands this way.')] });
      }
      if (toggle === 'off') {
        setGC(ctx.guild.id, 'noprefix', false);
        return ctx.reply({ embeds: [ok('No-Prefix Mode Disabled', `Commands now require \`${getPrefix(ctx.guild.id)}\` or \`ceas <cmd>\`.`)] });
      }
      ctx.reply({ embeds: [info('No-Prefix Mode', `**Status:** ${cfg.noprefix ? E.check + ' Enabled' : E.deny + ' Disabled'}\n\nUse \`setnoprefix on\` or \`setnoprefix off\`.`)] });
    },
  },

  // ── Moderation ───────────────────────────────────────────────────────────────
  ban: {
    cat: 'moderation', usage: 'ban @user [reason]', desc: 'Ban a member from the server',
    async run(ctx, args, target) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      if (!target) return ctx.reply({ embeds: [err('Please provide a member to ban.')] });
      if (target.id === ctx.author.id) return ctx.reply({ embeds: [err('You cannot ban yourself.')] });
      if (!target.bannable) return ctx.reply({ embeds: [err('I cannot ban that member — they may be above me in the role hierarchy.')] });
      const reason = args.join(' ') || 'No reason provided';
      await dmAction(target.user, 'Banned', ctx.guild.name, reason);
      await target.ban({ reason, deleteMessageSeconds: 604800 });
      const e = modEmbed('Ban', ctx.author, target, reason);
      ctx.reply({ embeds: [e] });
      sendLog(ctx.guild, e);
    },
  },
  unban: {
    cat: 'moderation', usage: 'unban <userId> [reason]', desc: 'Unban a user by their ID',
    async run(ctx, args) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      const userId = args[0];
      if (!userId) return ctx.reply({ embeds: [err('Provide a user ID.')] });
      try {
        const user   = await client.users.fetch(userId);
        const reason = args.slice(1).join(' ') || 'No reason provided';
        await ctx.guild.bans.remove(userId, reason);
        const e = new EmbedBuilder().setColor(0x2ecc71).setAuthor({ name: `Unbanned`, iconURL: user.displayAvatarURL() })
          .setDescription(`**User:** ${user.tag}\n**ID:** \`${user.id}\`\n**Reason:** ${reason}`)
          .setThumbnail(user.displayAvatarURL({ size: 256 }))
          .setFooter({ text: `Moderator: ${ctx.author.tag}`, iconURL: ctx.author.displayAvatarURL() }).setTimestamp();
        ctx.reply({ embeds: [e] });
        sendLog(ctx.guild, e);
      } catch { ctx.reply({ embeds: [err('Could not unban — are they actually banned?')] }); }
    },
  },
  kick: {
    cat: 'moderation', usage: 'kick @user [reason]', desc: 'Kick a member from the server',
    async run(ctx, args, target) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      if (!target) return ctx.reply({ embeds: [err('Please provide a member to kick.')] });
      if (target.id === ctx.author.id) return ctx.reply({ embeds: [err('You cannot kick yourself.')] });
      if (!target.kickable) return ctx.reply({ embeds: [err('I cannot kick that member — they may be above me in the role hierarchy.')] });
      const reason = args.join(' ') || 'No reason provided';
      await dmAction(target.user, 'Kicked', ctx.guild.name, reason);
      await target.kick(reason);
      const e = modEmbed('Kick', ctx.author, target, reason);
      ctx.reply({ embeds: [e] });
      sendLog(ctx.guild, e);
    },
  },
  mute: {
    cat: 'moderation', usage: 'mute @user [minutes] [reason]', desc: 'Timeout (mute) a member',
    async run(ctx, args, target) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      if (!target) return ctx.reply({ embeds: [err('Please provide a member to mute.')] });
      if (target.id === ctx.author.id) return ctx.reply({ embeds: [err('You cannot mute yourself.')] });
      const rawDur = parseInt(args[0]);
      const hasExplicitDur = args[0] && !isNaN(rawDur);
      const dur    = hasExplicitDur ? rawDur : 10;
      const reason = (hasExplicitDur ? args.slice(1) : args).join(' ') || 'No reason provided';
      if (args[0] && isNaN(parseInt(args[0])) && !/^\d/.test(args[0]) === false) {/* not a number, treat as reason */}
      if (hasExplicitDur && (dur < 1 || dur > 40320)) return ctx.reply({ embeds: [err('❌ Invalid time! Duration must be between 1 and 40320 minutes (28 days max).')] });
      try {
        await dmAction(target.user, 'Muted', ctx.guild.name, reason, `\n**Duration:** ${dur} minute${dur !== 1 ? 's' : ''}`);
        await target.timeout(dur * 60_000, reason);
        const e = modEmbed('Mute', ctx.author, target, reason, [['Duration', `${dur}m`]]);
        ctx.reply({ embeds: [e] });
        sendLog(ctx.guild, e);
      } catch { ctx.reply({ embeds: [err('Failed to mute — check my role permissions.')] }); }
    },
  },
  unmute: {
    cat: 'moderation', usage: 'unmute @user', desc: 'Remove timeout from a member',
    async run(ctx, args, target) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      if (!target) return ctx.reply({ embeds: [err('Please provide a member to unmute.')] });
      await target.timeout(null);
      const e = modEmbed('Unmute', ctx.author, target, 'Timeout removed');
      ctx.reply({ embeds: [e] });
      sendLog(ctx.guild, e);
    },
  },
  warn: {
    cat: 'moderation', usage: 'warn @user [reason]', desc: 'Warn a member',
    async run(ctx, args, target) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      if (!target) return ctx.reply({ embeds: [err('Please provide a member to warn.')] });
      const reason = args.join(' ') || 'No reason provided';
      if (!warnings.has(target.id)) warnings.set(target.id, []);
      warnings.get(target.id).push({ reason, date: new Date().toISOString(), moderator: ctx.author.tag });
      const count = warnings.get(target.id).length;
      const e = modEmbed('Warn', ctx.author, target, reason, [['Total Warnings', `${count}`]]);
      ctx.reply({ embeds: [e] });
      sendLog(ctx.guild, e);
      target.user.send({ embeds: [new EmbedBuilder().setColor(0xfee75c)
        .setTitle(`${E.warn} Warning — ${ctx.guild.name}`)
        .setDescription(`You received a warning in **${ctx.guild.name}**.\n**Reason:** ${reason}`)
        .addFields({ name: 'Total Warnings', value: `${count}`, inline: true }, { name: 'Issued by', value: ctx.author.tag, inline: true })
        .setFooter({ text: 'Contact a staff member if you believe this is a mistake.' })
        .setTimestamp()] }).catch(() => {});
    },
  },
  warnings: {
    cat: 'moderation', usage: 'warnings @user', desc: 'View all warnings for a member',
    async run(ctx, args, target) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      if (!target) return ctx.reply({ embeds: [err('Please provide a member.')] });
      const list = warnings.get(target.id) || [];
      if (!list.length) return ctx.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2)
        .setAuthor({ name: `Warnings — ${target.user.tag}`, iconURL: target.user.displayAvatarURL() })
        .setDescription(`${E.check} No warnings on record for this member.`)
        .setThumbnail(target.user.displayAvatarURL({ size: 256 })).setTimestamp()] });
      ctx.reply({ embeds: [new EmbedBuilder().setColor(0xfee75c)
        .setAuthor({ name: `Warnings — ${target.user.tag} (${list.length})`, iconURL: target.user.displayAvatarURL() })
        .setDescription(list.map((w, i) => `\`${i + 1}.\` **${w.reason}**\n↳ *${w.moderator}* • <t:${Math.floor(new Date(w.date).getTime() / 1000)}:R>`).join('\n\n'))
        .setThumbnail(target.user.displayAvatarURL({ size: 256 })).setTimestamp()] });
    },
  },
  clearwarns: {
    cat: 'moderation', usage: 'clearwarns @user', desc: 'Clear all warnings for a member',
    async run(ctx, args, target) {
      if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions.')] });
      if (!target) return ctx.reply({ embeds: [err('Please provide a member.')] });
      const count = (warnings.get(target.id) || []).length;
      warnings.delete(target.id);
      const e = modEmbed('Clearwarns', ctx.author, target, `${count} warning${count !== 1 ? 's' : ''} removed`);
      ctx.reply({ embeds: [e] });
      sendLog(ctx.guild, e);
    },
  },
  purge: {
    cat: 'moderation', usage: 'purge <1–100> [@user]', desc: 'Bulk delete messages',
    async run(ctx, args, filterUser) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      const n = parseInt(args[0]);
      if (isNaN(n) || n < 1 || n > 100) return ctx.reply({ embeds: [err('Provide a number between 1 and 100.')] });
      let msgs = await ctx.channel.messages.fetch({ limit: 100 });
      msgs = msgs.first(n);
      if (filterUser) msgs = msgs.filter(m => m.author.id === filterUser.id);
      const col = Array.isArray(msgs) ? msgs : [...msgs.values()];
      const deleted = await ctx.channel.bulkDelete(col, true);
      const r = await ctx.channel.send({ embeds: [new EmbedBuilder().setColor(0x57f287)
        .setTitle(`${E.check} Purge Complete`)
        .setDescription(`Deleted **${deleted.size}** message${deleted.size !== 1 ? 's' : ''}${filterUser ? ` from ${filterUser.user.tag}` : ''}.`)
        .setFooter({ text: `Moderator: ${ctx.author.tag}`, iconURL: ctx.author.displayAvatarURL() }).setTimestamp()] });
      setTimeout(() => r.delete().catch(() => {}), 5000);
    },
  },
  lock: {
    cat: 'moderation', usage: 'lock [reason]', desc: 'Lock the current channel',
    async run(ctx, args) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      await ctx.channel.permissionOverwrites.edit(ctx.guild.roles.everyone, { SendMessages: false });
      ctx.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle(`${E.staff} Channel Locked`)
        .setDescription(`${ctx.channel} has been locked.\n**Reason:** ${args.join(' ') || 'No reason provided'}`)
        .setFooter({ text: `Moderator: ${ctx.author.tag}`, iconURL: ctx.author.displayAvatarURL() }).setTimestamp()] });
    },
  },
  unlock: {
    cat: 'moderation', usage: 'unlock', desc: 'Unlock the current channel',
    async run(ctx) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      await ctx.channel.permissionOverwrites.edit(ctx.guild.roles.everyone, { SendMessages: null });
      ctx.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle(`${E.check} Channel Unlocked`)
        .setDescription(`${ctx.channel} is now open.`)
        .setFooter({ text: `Moderator: ${ctx.author.tag}`, iconURL: ctx.author.displayAvatarURL() }).setTimestamp()] });
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
    cat: 'moderation', usage: 'nickname @user [new nick]', desc: "Change or reset a member's nickname",
    async run(ctx, args, target) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      if (!target) return ctx.reply({ embeds: [err('Please provide a member.')] });
      const oldNick = target.nickname || target.user.username;
      const nick    = args.join(' ').trim() || null;
      await target.setNickname(nick, `Nickname changed by ${ctx.author.tag}`);
      // Record history (keep last 15)
      const hist = nickHistory.get(target.id) || [];
      hist.push({ oldNick, newNick: nick || target.user.username, by: ctx.author.tag, date: new Date().toISOString() });
      nickHistory.set(target.id, hist.slice(-15));
      const e = modEmbed('Nickname', ctx.author, target, nick ? `Changed to \`${nick}\`` : 'Reset to username',
        [['Before', `\`${oldNick}\``, 'After', nick ? `\`${nick}\`` : `\`${target.user.username}\``]].flatMap(([n1,v1,n2,v2])=>[{name:n1,value:v1,inline:true},{name:n2,value:v2,inline:true}])
      );
      ctx.reply({ embeds: [e] });
      sendLog(ctx.guild, e);
    },
  },
  nick: {
    cat: 'moderation', usage: 'nick @user [new nick]', desc: "Shorthand for nickname — set or reset",
    async run(ctx, args, target) { return COMMANDS.nickname.run(ctx, args, target); },
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
    cat: 'general', usage: 'afk [reason]', desc: 'Set/remove your AFK — nick becomes [A F K] Name',
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
        const msg = await ctx.reply({ embeds: [ok('Vouch Updated', `Updated vouch for **${target.user.tag}**.\n${E.chat} *"${comment}"*`)] });
        if (!ctx.isSlash && msg) setTimeout(() => msg.delete().catch(() => {}), 6000);
        return;
      }
      list.push({ fromId: ctx.author.id, fromTag: ctx.author.tag, comment, date: new Date().toISOString() });
      const msg = await ctx.reply({ embeds: [new EmbedBuilder()
        .setColor(0x57f287)
        .setAuthor({ name: `Vouched!`, iconURL: target.user.displayAvatarURL() })
        .setDescription(`**${ctx.author.tag}** vouched for **${target.user.tag}**.\n${E.chat} *"${comment}"*`)
        .addFields({ name: 'Total Vouches', value: `${list.length}`, inline: true })
        .setThumbnail(target.user.displayAvatarURL({ size: 128 }))
        .setTimestamp()] });
      if (!ctx.isSlash && msg) setTimeout(() => msg.delete().catch(() => {}), 6000);
    },
  },
  vouches: {
    cat: 'social', usage: 'vouches [@user]', desc: 'View vouches for a member',
    async run(ctx, args, target) {
      const t    = target || ctx.member;
      const list = vouches.get(t.id) || [];
      if (!list.length) return ctx.reply({ embeds: [info(`Vouches — ${t.user.tag}`, 'No vouches yet.')] });
      ctx.reply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle(`${E.stock} Vouches — ${t.user.tag} (${list.length})`).setDescription(list.map((v, i) => `**${i + 1}.** <t:${Math.floor(new Date(v.date).getTime() / 1000)}:R> by **${v.fromTag}** — *"${v.comment}"*`).join('\n')).setThumbnail(t.user.displayAvatarURL({ size: 128 })).setTimestamp()] });
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
      const msg = await ctx.reply({ embeds: [ok('Vouch Removed', `Removed your vouch for **${target.user.tag}**.`)] });
      if (!ctx.isSlash && msg) setTimeout(() => msg.delete().catch(() => {}), 6000);
    },
  },
  deal: {
    cat: 'social', usage: 'deal <product name>', desc: 'Propose a deal to the other party in a ticket',
    async run(ctx, args) {
      const product = args.join(' ').trim();
      if (!product) return ctx.reply({ embeds: [err('Please provide a product name: `deal <product name>`')] });
      const ticketData = openTickets.get(ctx.channel.id);
      if (!ticketData) return ctx.reply({ embeds: [err('This command can only be used inside a ticket channel.')] });
      const proposerId = ctx.author.id;
      const creatorId  = ticketData.userId;
      const targetId   = proposerId === creatorId ? null : creatorId;
      const dealId     = `${ctx.guild.id}_${ctx.channel.id}_${Date.now()}`;
      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle(`${E.cart} Deal Proposal`)
        .addFields(
          { name: `${E.cart} Product`,    value: product,                                            inline: true  },
          { name: `${E.e4} Proposed by`, value: `<@${proposerId}>`,                                 inline: true  },
          { name: `${E.arrow} Proposed to`, value: targetId ? `<@${targetId}>` : 'Staff in ticket',   inline: true  },
          { name: `${E.info} Status`,  value: `${E.warn} Pending — waiting for response`,   inline: false },
        )
        .setFooter({ text: 'Only the intended recipient can accept or reject' })
        .setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`deal_accept_${dealId}`).setLabel('Accept Deal').setEmoji({ id: '1518570328559845539', name: 'emoji_1' }).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`deal_reject_${dealId}`).setLabel('Reject Deal').setEmoji({ id: '1518570359262154793', name: 'emoji_2' }).setStyle(ButtonStyle.Danger),
      );
      const mention = targetId ? `<@${targetId}>` : '';
      const msg = await ctx.channel.send({ content: mention || undefined, embeds: [embed], components: [row] });
      activeDeals.set(dealId, { proposerId, targetId, product, channelId: ctx.channel.id, guildId: ctx.guild.id, messageId: msg.id, status: 'pending', at: Date.now() });
      if (ctx.isSlash) return ctx.replyEphemeral({ content: `${E.check} Deal proposal sent!` });
    },
  },
  setdeallog: {
    cat: 'admin', usage: 'setdeallog #channel', desc: 'Set the channel where all deal results are logged',
    async run(ctx, args) {
      if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions.')] });
      const chId = args[0]?.replace(/[^0-9]/g, '');
      if (!chId) return ctx.reply({ embeds: [err('Please mention a channel: `setdeallog #channel`')] });
      const ch = ctx.guild.channels.cache.get(chId);
      if (!ch) return ctx.reply({ embeds: [err('Channel not found.')] });
      setGC(ctx.guild.id, 'dealLogChannel', chId);
      ctx.reply({ embeds: [ok('Deal Log Channel Set', `All deal outcomes will be logged to ${ch}.\n\nMods can type \`deal <product>\` inside a ticket to propose a deal.`)] });
    },
  },
  // ── Bot Management (owner only) ───────────────────────────────────────────────
  botavatar: {
    cat: 'botmgmt', usage: 'botavatar <url or attach image>', desc: "Change the bot's avatar (admin only)",
    async run(ctx, args) {
      if (!isAdmin(ctx.member) && ctx.author.id !== OWNER_ID)
        return ctx.reply({ embeds: [err('You need Administrator permissions to change the bot avatar.')] });
      let url = args[0] || null;
      if (!url && !ctx.isSlash) {
        const msgs = await ctx.channel.messages.fetch({ limit: 2 }).catch(() => null);
        const last = msgs?.find(m => m.id !== ctx.channel?.lastMessageId);
        const attach = last?.attachments.first();
        if (attach) url = attach.url;
      }
      if (!url) return ctx.reply({ embeds: [err('Provide an image URL or attach an image.\nExample: `botavatar https://i.imgur.com/abc.png`')] });
      try {
        await client.user.setAvatar(url);
        ctx.reply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle(`${E.bots} Bot Avatar Updated`).setDescription('The bot\'s avatar has been changed.').setThumbnail(client.user.displayAvatarURL()).setTimestamp()] });
      } catch (e) { ctx.reply({ embeds: [err(`Failed to update avatar: ${e.message}`)] }); }
    },
  },
  botname: {
    cat: 'botmgmt', usage: 'botname <new username>', desc: "Change the bot's username (admin only, 2/hour limit)",
    async run(ctx, args) {
      if (!isAdmin(ctx.member) && ctx.author.id !== OWNER_ID)
        return ctx.reply({ embeds: [err('You need Administrator permissions to change the bot username.')] });
      const name = args.join(' ').trim();
      if (!name) return ctx.reply({ embeds: [err('Provide a username. Example: `botname MyCoolBot`')] });
      if (name.length < 2 || name.length > 32) return ctx.reply({ embeds: [err('Username must be 2–32 characters.')] });
      try {
        await client.user.setUsername(name);
        ctx.reply({ embeds: [ok('Bot Username Updated', `Username changed to **${name}**.\n${E.warn} Discord allows only **2 username changes per hour**.`)] });
      } catch (e) { ctx.reply({ embeds: [err(`Failed: ${e.message}`)] }); }
    },
  },
  botstatus: {
    cat: 'botmgmt', usage: 'botstatus <watching|playing|listening|competing> <text>', desc: "Change the bot's status activity (admin only)",
    async run(ctx, args) {
      if (!isAdmin(ctx.member) && ctx.author.id !== OWNER_ID)
        return ctx.reply({ embeds: [err('You need Administrator permissions to change the bot status.')] });
      const types = { watching: 3, playing: 0, listening: 2, competing: 5, streaming: 1 };
      const typeKey = args[0]?.toLowerCase();
      const text    = args.slice(1).join(' ').trim();
      if (!typeKey || !types[typeKey] === undefined || !text)
        return ctx.reply({ embeds: [info('botstatus Usage', '`botstatus <watching|playing|listening|competing> <text>`\n\nExample: `botstatus watching over the server`')] });
      client.user.setActivity(text, { type: types[typeKey] ?? 3 });
      ctx.reply({ embeds: [ok('Bot Status Updated', `Now **${typeKey}** *${text}*`)] });
    },
  },

  // ── Unique Features ───────────────────────────────────────────────────────────
  botbanner: {
    cat: 'botmgmt', usage: 'botbanner <image url>', desc: "Change the bot's banner image (admin only)",
    async run(ctx, args) {
      if (!isAdmin(ctx.member) && ctx.author.id !== OWNER_ID)
        return ctx.reply({ embeds: [err('You need Administrator permissions to change the bot banner.')] });
      const url = args[0];
      if (!url) return ctx.reply({ embeds: [err('Provide an image URL.\nExample: `botbanner https://i.imgur.com/abc.png`')] });
      try {
        await client.user.setBanner(url);
        ctx.reply({ embeds: [new EmbedBuilder().setColor(0x9b59b6).setTitle(`${E.bots} Bot Banner Updated`).setDescription('The bot\'s banner has been changed successfully.').setImage(url).setTimestamp()] });
      } catch (e) { ctx.reply({ embeds: [err(`Failed: ${e.message}\n\n*Note: Banner changing may require your bot to have boosted status on Discord.*`)] }); }
    },
  },
  botbio: {
    cat: 'botmgmt', usage: 'botbio <text>', desc: "Change the bot's About Me / bio (admin only)",
    async run(ctx, args) {
      if (!isAdmin(ctx.member) && ctx.author.id !== OWNER_ID)
        return ctx.reply({ embeds: [err('You need Administrator permissions to change the bot bio.')] });
      const bio = args.join(' ').trim();
      if (!bio) return ctx.reply({ embeds: [err('Provide a bio text.\nExample: `botbio I am CEAS Bot, here to help!`')] });
      if (bio.length > 190) return ctx.reply({ embeds: [err('Bio must be 190 characters or less.')] });
      try {
        await client.user.edit({ bio });
        ctx.reply({ embeds: [new EmbedBuilder().setColor(0x9b59b6).setTitle(`${E.bots} Bot Bio Updated`).setDescription(`New bio:\n> ${bio}`).setTimestamp()] });
      } catch (e) { ctx.reply({ embeds: [err(`Failed: ${e.message}\n\n*Note: Bots may need verified bot status to set a bio.*`)] }); }
    },
  },
  serveravatar: {
    cat: 'botmgmt', usage: 'serveravatar <image url>', desc: "Change this server's icon/avatar (admin only)",
    async run(ctx, args) {
      if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions to change the server avatar.')] });
      const url = args[0] || ctx.message?.attachments?.first()?.url;
      if (!url) return ctx.reply({ embeds: [err('Provide an image URL or attach an image.\nExample: `serveravatar https://i.imgur.com/abc.png`')] });
      try {
        await ctx.guild.setIcon(url);
        ctx.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${E.bots} Server Avatar Updated`).setDescription('The server icon has been changed.').setThumbnail(ctx.guild.iconURL({ size: 256 })).setTimestamp()] });
      } catch (e) { ctx.reply({ embeds: [err(`Failed: ${e.message}`)] }); }
    },
  },
  serverbanner: {
    cat: 'botmgmt', usage: 'serverbanner <image url>', desc: "Change this server's banner image (admin only, requires Level 2 boost)",
    async run(ctx, args) {
      if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions to change the server banner.')] });
      const url = args[0];
      if (!url) return ctx.reply({ embeds: [err('Provide an image URL.\nExample: `serverbanner https://i.imgur.com/abc.png`')] });
      try {
        await ctx.guild.setBanner(url);
        ctx.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${E.bots} Server Banner Updated`).setDescription('The server banner has been changed.').setImage(url).setTimestamp()] });
      } catch (e) { ctx.reply({ embeds: [err(`Failed: ${e.message}\n\n*Note: Server banner requires the server to be at Boost Level 2 or higher.*`)] }); }
    },
  },
  autorespond: {
    cat: 'unique', usage: 'autorespond <add|remove|list> [trigger | response]', desc: 'Bot auto-replies when a trigger word is detected in messages',
    async run(ctx, args) {
      if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions.')] });
      const sub  = args[0]?.toLowerCase();
      const cfg  = gc(ctx.guild.id);
      const list = cfg.autoResponds || [];
      if (sub === 'list') {
        if (!list.length) return ctx.reply({ embeds: [info('Auto-Respond List', 'No triggers set.\nUse `autorespond add trigger | response` to add one.')] });
        return ctx.reply({ embeds: [info('Auto-Respond Triggers', list.map((r, i) => `**${i + 1}.** \`${r.trigger}\` → ${r.response.slice(0, 60)}${r.response.length > 60 ? '…' : ''}`).join('\n'))] });
      }
      if (sub === 'add') {
        const full = args.slice(1).join(' ');
        const sep  = full.indexOf('|');
        if (sep === -1) return ctx.reply({ embeds: [err('Format: `autorespond add <trigger> | <response>`\nExample: `autorespond add hello | Hey there! 👋`')] });
        const trigger  = full.slice(0, sep).trim().toLowerCase();
        const response = full.slice(sep + 1).trim();
        if (!trigger || !response) return ctx.reply({ embeds: [err('Both trigger and response are required.')] });
        if (list.length >= 25) return ctx.reply({ embeds: [err('Maximum 25 auto-respond triggers per server.')] });
        const exists = list.findIndex(r => r.trigger === trigger);
        if (exists !== -1) list[exists].response = response;
        else list.push({ trigger, response });
        setGC(ctx.guild.id, 'autoResponds', list);
        return ctx.reply({ embeds: [ok('Auto-Respond Added', `When someone says **"${trigger}"** I will reply:\n> ${response}`)] });
      }
      if (sub === 'remove') {
        const trigger = args.slice(1).join(' ').trim().toLowerCase();
        const before  = list.length;
        const newList = list.filter(r => r.trigger !== trigger);
        if (newList.length === before) return ctx.reply({ embeds: [err(`No trigger found for \`${trigger}\`.`)] });
        setGC(ctx.guild.id, 'autoResponds', newList);
        return ctx.reply({ embeds: [ok('Trigger Removed', `Auto-respond for \`${trigger}\` deleted.`)] });
      }
      ctx.reply({ embeds: [info('Auto-Respond', '`autorespond add <trigger> | <response>`\n`autorespond remove <trigger>`\n`autorespond list`')] });
    },
  },
  addcmd: {
    cat: 'unique', usage: 'addcmd <name> <response>', desc: 'Create a custom command for this server',
    async run(ctx, args) {
      if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions.')] });
      const name     = args[0]?.toLowerCase();
      const response = args.slice(1).join(' ').trim();
      if (!name || !response) return ctx.reply({ embeds: [err('Usage: `addcmd <name> <response>`\nExample: `addcmd rules Check #rules for server rules!`')] });
      if (COMMANDS[name]) return ctx.reply({ embeds: [err(`\`${name}\` is a built-in command and cannot be overwritten.`)] });
      const cfg  = gc(ctx.guild.id);
      const cmds = cfg.customCmds || {};
      if (Object.keys(cmds).length >= 50) return ctx.reply({ embeds: [err('Maximum 50 custom commands per server.')] });
      cmds[name] = response;
      setGC(ctx.guild.id, 'customCmds', cmds);
      ctx.reply({ embeds: [ok('Custom Command Created', `\`${getPrefix(ctx.guild.id)}${name}\` will now reply:\n> ${response.slice(0, 200)}`)] });
    },
  },
  delcmd: {
    cat: 'unique', usage: 'delcmd <name>', desc: 'Delete a custom command',
    async run(ctx, args) {
      if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions.')] });
      const name = args[0]?.toLowerCase();
      if (!name) return ctx.reply({ embeds: [err('Usage: `delcmd <name>`')] });
      const cfg  = gc(ctx.guild.id);
      const cmds = cfg.customCmds || {};
      if (!cmds[name]) return ctx.reply({ embeds: [err(`No custom command named \`${name}\`.`)] });
      delete cmds[name];
      setGC(ctx.guild.id, 'customCmds', cmds);
      ctx.reply({ embeds: [ok('Custom Command Deleted', `\`${name}\` has been removed.`)] });
    },
  },
  cmds: {
    cat: 'unique', usage: 'cmds', desc: 'List all custom commands for this server',
    async run(ctx) {
      const cfg  = gc(ctx.guild.id);
      const cmds = cfg.customCmds || {};
      const keys = Object.keys(cmds);
      if (!keys.length) return ctx.reply({ embeds: [info('Custom Commands', 'No custom commands set.\nAdmins can add one with `addcmd <name> <response>`.')] });
      ctx.reply({ embeds: [info(`Custom Commands (${keys.length})`, keys.map(k => `\`${getPrefix(ctx.guild.id)}${k}\``).join(' • '))] });
    },
  },
  restart: {
    cat: 'botmgmt', usage: 'restart', desc: 'Restart the bot process (owner only)',
    async run(ctx) {
      if (ctx.author.id !== OWNER_ID)
        return ctx.reply({ embeds: [err('This command is restricted to the bot owner only.')] });
      await ctx.reply({ embeds: [new EmbedBuilder().setColor(0xf39c12).setTitle(`${E.warn} Restarting…`).setDescription('The bot is restarting. It will be back online in a few seconds.').setTimestamp()] });
      setTimeout(() => process.exit(0), 1500);
    },
  },

  vouchleader: {
    cat: 'social', usage: 'vouchleader', desc: 'Show the vouch leaderboard',
    async run(ctx) {
      const scores = [...vouches.entries()].map(([id, l]) => ({ id, n: l.length })).filter(e => e.n > 0).sort((a, b) => b.n - a.n).slice(0, 10);
      if (!scores.length) return ctx.reply({ embeds: [info('Vouch Leaderboard', 'No vouches yet.')] });
      const medals = [E.e26, E.e27, E.e28];
      const lines  = await Promise.all(scores.map(async (e, i) => {
        const u = await client.users.fetch(e.id).catch(() => null);
        return `${medals[i] || `**${i + 1}.**`} ${u ? u.tag : e.id} — **${e.n}** vouch(es)`;
      }));
      ctx.reply({ embeds: [info('Vouch Leaderboard', lines.join('\n'))] });
    },
  },
  invites: {
    cat: 'social', usage: 'invites [@user]', desc: 'Check how many people a member has invited',
    async run(ctx, args, target) {
      const gJoins = inviteJoins.get(ctx.guild.id) || new Map();
      const checkId = target ? target.id : ctx.author.id;
      const checkTag= target ? target.user.tag : ctx.author.tag;
      const checkAvatar = target ? target.user.displayAvatarURL({ size: 256 }) : ctx.author.displayAvatarURL({ size: 256 });
      const count  = [...gJoins.values()].filter(j => j.inviterId === checkId).length;
      ctx.reply({ embeds: [new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: `Invites — ${checkTag}`, iconURL: checkAvatar })
        .setDescription(`**${checkTag}** has invited **${count}** member${count !== 1 ? 's' : ''} this session.`)
        .setFooter({ text: 'Invite counts reset when the bot restarts' })
        .setTimestamp()] });
    },
  },
  inviteleader: {
    cat: 'social', usage: 'inviteleader', desc: 'Invite leaderboard — top inviters',
    async run(ctx) {
      const gJoins = inviteJoins.get(ctx.guild.id) || new Map();
      if (!gJoins.size) return ctx.reply({ embeds: [info('Invite Leaderboard', 'No invite data yet this session.')] });
      const tally = new Map();
      for (const { inviterId } of gJoins.values()) tally.set(inviterId, (tally.get(inviterId) || 0) + 1);
      const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      const medals = [E.e26, E.e27, E.e28];
      const lines  = await Promise.all(sorted.map(async ([id, n], i) => {
        const u = await client.users.fetch(id).catch(() => null);
        return `${medals[i] || `**${i + 1}.**`} ${u ? u.tag : id} — **${n}** invite${n !== 1 ? 's' : ''}`;
      }));
      ctx.reply({ embeds: [info('Invite Leaderboard', lines.join('\n') + '\n\n*Resets on bot restart*')] });
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
      ctx.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${E.e4} ${t.user.tag}`).setThumbnail(t.user.displayAvatarURL({ size: 256 })).addFields(
        { name: 'User ID',        value: t.id,                                                         inline: true  },
        { name: 'Nickname',       value: t.nickname || 'None',                                         inline: true  },
        { name: 'AFK',            value: afk ? `Yes — ${afk.reason}` : 'No',                          inline: true  },
        { name: 'Account Created',value: `<t:${Math.floor(t.user.createdTimestamp / 1000)}:R>`,       inline: true  },
        { name: 'Joined Server',  value: `<t:${Math.floor(t.joinedTimestamp / 1000)}:R>`,             inline: true  },
        { name: `${E.stock} Vouches`,  value: `${vc}`,                                                      inline: true  },
        { name: `${E.warn} Warnings`,  value: `${wc}`,                                                      inline: true  },
        { name: 'Roles',          value: t.roles.cache.filter(r => r.id !== ctx.guild.id).map(r => r.toString()).join(', ') || 'None' },
      ).setTimestamp()] });
    },
  },
  serverinfo: {
    cat: 'utility', usage: 'serverinfo', desc: 'View server information',
    async run(ctx) {
      const g = ctx.guild; const cfg = gc(g.id);
      ctx.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${E.setting} ${g.name}`).setThumbnail(g.iconURL({ size: 256 })).addFields(
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
      ctx.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${E.bots} ${u.tag}`).setImage(u.displayAvatarURL({ size: 1024 })).setTimestamp()] });
    },
  },
  ping: {
    cat: 'utility', usage: 'ping', desc: 'Check bot latency',
    async run(ctx) {
      const start = Date.now();
      const msg   = await ctx.reply({ embeds: [info('Pinging…', 'Measuring…')] });
      const el    = Date.now() - start;
      const edit  = info('Pong!', `**Bot:** ${el}ms\n**API:** ${client.ws.ping}ms`);
      if (msg && msg.edit) msg.edit({ embeds: [edit] });
    },
  },

  // ── Tickets ──────────────────────────────────────────────────────────────────
  ticket: {
    cat: 'tickets', usage: 'ticket', desc: 'Post the ticket creation panel (admin only)',
    async run(ctx) {
      if (!isAdmin(ctx.member)) return ctx.reply({ embeds: [err('You need Administrator permissions.')] });
      const cfg  = gc(ctx.guild.id);
      const note = cfg.ticketNote || 'Click below to open a support ticket.\nOur staff team will assist you as soon as possible.';
      const row  = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_create').setLabel('Open Ticket').setEmoji({ id: '1518572054981509152', name: 'pb_y_chat', animated: true }).setStyle(ButtonStyle.Primary),
      );
      ctx.channel.send({ embeds: [new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`${E.hash} Support Tickets`)
        .setDescription(note)
        .setFooter({ text: ctx.guild.name, iconURL: ctx.guild.iconURL() })
        .setTimestamp()], components: [row] });
      ctx.reply({ embeds: [ok('Panel Sent', `Ticket panel posted in ${ctx.channel}.\nCustomize the description with \`setticketnote <text>\`.`)] });
    },
  },
  close: {
    cat: 'tickets', usage: 'close [reason]', desc: 'Close the current ticket channel',
    async run(ctx, args) {
      if (!openTickets.has(ctx.channel.id)) return ctx.reply({ embeds: [err('This is not a ticket channel.')] });
      await closeTicket(ctx.channel, ctx.member, args.join(' ') || 'No reason');
    },
  },
  adduser: {
    cat: 'tickets', usage: 'adduser @user', desc: 'Add a user to the current ticket channel',
    async run(ctx, args, target) {
      if (!isMod(ctx.member)) return ctx.reply({ embeds: [err('You need moderation permissions.')] });
      if (!openTickets.has(ctx.channel.id)) return ctx.reply({ embeds: [err('This command can only be used inside a ticket channel.')] });
      if (!target) return ctx.reply({ embeds: [err('Please mention a member to add.')] });
      await ctx.channel.permissionOverwrites.edit(target, {
        ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
      });
      ctx.reply({ embeds: [ok('User Added', `${target} has been added to this ticket.`)] });
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
        return ctx.reply({ embeds: [ok('Anti-Nuke Enabled', `${E.antinuke} Anti-nuke protection is now **ON**.\nAny user who mass-bans, mass-kicks, mass-deletes channels/roles, or creates webhooks beyond the threshold will be instantly banned and stripped of roles.`)] });
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
        .setTitle(`${E.secure} Anti-Nuke — ${cfg.antinuke ? E.check + ' Enabled' : E.deny + ' Disabled'}`)
        .setDescription('Monitors and auto-bans users who attempt to nuke (destroy) the server.')
        .addFields(
          { name: `${E.warn} Thresholds (per 10s)`, value: [
            `**Ban:** ${thr.ban} actions`,
            `**Kick:** ${thr.kick} actions`,
            `**Channel Delete:** ${thr.chDel} actions`,
            `**Role Delete:** ${thr.roleDel} actions`,
            `**Webhook Create:** ${thr.webhook} actions`,
          ].join('\n'), inline: true },
          { name: `${E.secure} Monitored Events`, value: '• Mass ban\n• Mass kick\n• Mass channel delete\n• Mass role delete\n• Webhook creation\n• Bot additions', inline: true },
          { name: `${E.check} Whitelist (${wl.length})`, value: wlUsers.length ? wlUsers.map(u => typeof u === 'string' ? `\`${u}\`` : u.tag).join(', ') : 'None' },
        )
        .setFooter({ text: 'Use: antinuke on | off | whitelist @user | threshold ban 2' })
        .setTimestamp()
      ] });
    },
  },

  // ── Snipe ──────────────────────────────────────────────────────────────────
  snipe: {
    cat: 'general', usage: 'snipe', desc: 'Show the last deleted message in this channel',
    async run(ctx) {
      const d = snipeStore.get(ctx.channel.id);
      if (!d) return ctx.reply({ embeds: [err('Nothing to snipe — no recently deleted message found.')] });
      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setAuthor({ name: d.author, iconURL: d.avatarURL })
        .setDescription(d.content || '*[no text content]*')
        .setFooter({ text: 'Message deleted' })
        .setTimestamp(d.timestamp);
      if (d.imageURL) embed.setImage(d.imageURL);
      ctx.reply({ embeds: [embed] });
    },
  },

  // ── Poll ───────────────────────────────────────────────────────────────────
  poll: {
    cat: 'general', usage: 'poll <question> [| Option1 | Option2 ...]', desc: 'Create a poll — yes/no or up to 5 custom options',
    async run(ctx, args) {
      const full     = args.join(' ');
      const parts    = full.split('|').map(s => s.trim()).filter(Boolean);
      const question = parts[0];
      if (!question) return ctx.reply({ embeds: [err('Provide a question. Example: `poll Is this bot cool?`')] });
      const options  = parts.slice(1);
      const emojis   = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣'];
      const desc     = options.length
        ? `**${question}**\n\n${options.map((o, i) => `${emojis[i]} ${o}`).join('\n')}`
        : `**${question}**\n\n✅ Yes   ❌ No`;
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('📊 Poll')
        .setDescription(desc)
        .setFooter({ text: `Poll by ${ctx.author.tag}` })
        .setTimestamp();
      const sent = await ctx.reply({ embeds: [embed] });
      if (sent) {
        if (options.length) {
          for (let i = 0; i < Math.min(options.length, 5); i++) await sent.react(emojis[i]).catch(() => {});
        } else {
          await sent.react('✅').catch(() => {});
          await sent.react('❌').catch(() => {});
        }
      }
    },
  },

  // ── Remind ─────────────────────────────────────────────────────────────────
  remind: {
    cat: 'general', usage: 'remind <time> <message>  (e.g. remind 30m check the oven)', desc: 'Set a reminder — bot DMs you after the given time',
    async run(ctx, args) {
      const raw = args[0];
      if (!raw) return ctx.reply({ embeds: [err('Usage: `remind 10m grab lunch`\nUnits: s, m, h')] });
      const match = raw.match(/^(\d+)([smh])$/i);
      if (!match) return ctx.reply({ embeds: [err('❌ Invalid time format. Use: `30s`, `10m`, `2h`')] });
      const val  = parseInt(match[1]);
      const unit = match[2].toLowerCase();
      const ms   = unit === 's' ? val * 1000 : unit === 'm' ? val * 60_000 : val * 3_600_000;
      if (ms > 24 * 3_600_000) return ctx.reply({ embeds: [err('❌ Maximum reminder time is 24 hours.')] });
      const note = args.slice(1).join(' ') || 'Your reminder is up!';
      await ctx.reply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('⏰ Reminder Set').setDescription(`I'll DM you in **${raw}**.\n**Note:** ${note}`).setTimestamp()] });
      const userId   = ctx.author.id;
      const guildName = ctx.guild.name;
      setTimeout(async () => {
        try {
          const user = await client.users.fetch(userId);
          await user.send({ embeds: [new EmbedBuilder().setColor(0xf39c12).setTitle('⏰ Reminder').setDescription(`**${note}**\n\n*Set ${raw} ago in ${guildName}*`).setTimestamp()] });
        } catch { /* DMs closed */ }
      }, ms);
    },
  },

};

// ─── Help menu ────────────────────────────────────────────────────────────────
const CATS = {
  admin:      { emoji: E.setting, label: 'Admin',      desc: 'Setup & configuration',              color: 0xeb459e },
  moderation: { emoji: E.mod,     label: 'Moderation', desc: 'Ban, kick, mute, warn & more',       color: 0xed4245 },
  antinuke:   { emoji: E.secure,  label: 'Anti-Nuke',  desc: 'Server nuke protection',             color: 0xff4444 },
  utility:    { emoji: E.sinfo,   label: 'Utility',    desc: 'Say, embed, userinfo, ping',         color: 0x5865f2 },
  tickets:    { emoji: E.hash,    label: 'Tickets',    desc: 'Ticket panel, close, transcript',    color: 0xfee75c },
  social:     { emoji: E.stock,   label: 'Social',     desc: 'Vouch system, deals & leaderboard', color: 0xf1c40f },
  unique:     { emoji: E.flower,  label: 'Unique',     desc: 'Auto-respond, custom commands',       color: 0xf39c12 },
  botmgmt:    { emoji: E.bots,    label: 'Bot Mgmt',  desc: 'Avatar, banner, bio, username, status + server avatar/banner (admin)', color: 0x9b59b6 },
  general:    { emoji: E.rules,   label: 'General',    desc: 'Help, AFK, ping, poll, snipe, remind',  color: 0x57f287 },
};

async function sendHelpMenu(ctx) {
  const botUser   = await client.user.fetch({ force: true }).catch(() => client.user);
  const bannerURL = botUser.bannerURL?.({ size: 1024 }) ?? null;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${E.rules} Ceas Bot — Help`)
    .addFields(Object.values(CATS).map(v => ({ name: `${v.emoji} ${v.label}`, value: v.desc, inline: true })))
    .setFooter({ text: `${Object.keys(COMMANDS).length} commands  •  All also available as /slash commands` })
    .setThumbnail(client.user.displayAvatarURL())
    .setTimestamp();

  if (bannerURL) embed.setImage(bannerURL);

  const menu = new StringSelectMenuBuilder().setCustomId('help_menu').setPlaceholder('📂 Select a category…')
    .addOptions(Object.entries(CATS).map(([key, v]) => ({ label: v.label, value: key, description: v.desc, emoji: parseEmoji(v.emoji) })));

  ctx.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
}

function buildCatEmbed(cat, guildId) {
  const prefix = getPrefix(guildId);
  const c      = CATS[cat] || { emoji: E.rules, label: cat, color: 0x5865f2 };
  const cmds   = Object.entries(COMMANDS).filter(([, v]) => v.cat === cat);
  return new EmbedBuilder()
    .setColor(c.color).setTitle(`${c.emoji} ${c.label} Commands`)
    .setDescription(cmds.map(([n, v]) => `\`${prefix}${n}\` — ${v.desc}`).join('\n'))
    .setFooter({ text: `Prefix: ${prefix} | Also /slash  | ceas <cmd>` }).setTimestamp();
}

// ─── Slash command definitions (one for every command) ────────────────────────
const SLASH_DEFS = [
  // Admin — individual config commands
  new SlashCommandBuilder().setName('config').setDescription('View current server configuration').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('setwelcome').setDescription('Set the welcome channel').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName('channel').setDescription('Welcome channel').setRequired(true)),

  new SlashCommandBuilder().setName('setlogs').setDescription('Set the mod log channel').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName('channel').setDescription('Log channel').setRequired(true)),

  new SlashCommandBuilder().setName('settickets').setDescription('Set the ticket category').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('category').setDescription('Category name or ID').setRequired(true)),

  new SlashCommandBuilder().setName('setmodrole').setDescription('Set the moderator role').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(o => o.setName('role').setDescription('Moderator role').setRequired(true)),

  new SlashCommandBuilder().setName('setadminrole').setDescription('Set the admin role').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(o => o.setName('role').setDescription('Admin role').setRequired(true)),

  new SlashCommandBuilder().setName('setmutedrole').setDescription('Set the muted role').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(o => o.setName('role').setDescription('Muted role').setRequired(true)),

  new SlashCommandBuilder().setName('setprefix').setDescription('Change the command prefix').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('prefix').setDescription('New prefix (max 5 chars)').setRequired(true)),

  new SlashCommandBuilder().setName('setwelcomeimage').setDescription('Set a welcome banner image URL').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('url').setDescription('Image URL').setRequired(true)),

  new SlashCommandBuilder().setName('setwelcomemsg').setDescription('Set custom welcome message text').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('message').setDescription('Message — use {user} {tag} {server} {count}').setRequired(false)),

  new SlashCommandBuilder().setName('setgoodbye').setDescription('Set the goodbye/leave channel').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName('channel').setDescription('Goodbye channel').setRequired(true)),

  new SlashCommandBuilder().setName('setgoodbyemsg').setDescription('Set custom goodbye message').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('message').setDescription('Message — use {user} {tag} {server} {count}').setRequired(true)),

  new SlashCommandBuilder().setName('resetconfig').setDescription('Reset all server settings to defaults').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

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
    .addStringOption(o => o.setName('nick').setDescription('New nickname (leave blank to reset)').setRequired(false)),

  new SlashCommandBuilder().setName('nick').setDescription("Shorthand — set or reset a member's nickname").setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('nick').setDescription('New nickname (leave blank to reset)').setRequired(false)),

  new SlashCommandBuilder().setName('adduser').setDescription('Add a user to the current ticket channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addUserOption(o => o.setName('user').setDescription('Member to add').setRequired(true)),

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

  // Invite tracker
  new SlashCommandBuilder().setName('invites').setDescription('Check how many people a member has invited')
    .addUserOption(o => o.setName('user').setDescription('Member (leave blank for yourself)').setRequired(false)),

  new SlashCommandBuilder().setName('inviteleader').setDescription('Invite leaderboard — top inviters in this server'),

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

  new SlashCommandBuilder().setName('setticketnote').setDescription('Set the description shown on the ticket creation panel').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('text').setDescription('Description text (leave blank to reset to default)').setRequired(false)),

  new SlashCommandBuilder().setName('setmedia').setDescription('Make a channel media-only (images/videos/files only)').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName('channel').setDescription('Channel to make media-only').setRequired(true))
    .addStringOption(o => o.setName('action').setDescription('Set or remove').setRequired(false)
      .addChoices({ name: 'set — Make media-only', value: 'set' }, { name: 'off — Remove media-only', value: 'off' })),

  new SlashCommandBuilder().setName('mediawhitelist').setDescription('Manage who can bypass media-only channels').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('action').setDescription('What to do').setRequired(true)
      .addChoices({ name: 'add — Whitelist a role/user', value: 'add' }, { name: 'remove — Remove from whitelist', value: 'remove' }, { name: 'list — View whitelist', value: 'list' }))
    .addRoleOption(o => o.setName('role').setDescription('Role to add/remove').setRequired(false))
    .addUserOption(o => o.setName('user').setDescription('User to add/remove').setRequired(false)),

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

  new SlashCommandBuilder().setName('setnoprefix').setDescription('Enable/disable true no-prefix mode for moderators').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(false)
      .addChoices({ name: 'on — Enable (mods type "ban @user" with no prefix)', value: 'on' }, { name: 'off — Disable', value: 'off' })),

  // Deal system
  new SlashCommandBuilder().setName('deal').setDescription('Propose a deal to the other party inside a ticket')
    .addStringOption(o => o.setName('product').setDescription('The product / item being dealt').setRequired(true)),

  new SlashCommandBuilder().setName('setdeallog').setDescription('Set the channel where all deal outcomes are logged').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName('channel').setDescription('Deal log channel').setRequired(true)),

  // Unique features
  new SlashCommandBuilder().setName('cmds').setDescription('List all custom commands for this server'),
  new SlashCommandBuilder().setName('autorespond').setDescription('Manage auto-respond triggers').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('action').setDescription('add, remove, or list').setRequired(true)
      .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }))
    .addStringOption(o => o.setName('trigger').setDescription('Trigger word/phrase').setRequired(false))
    .addStringOption(o => o.setName('response').setDescription('Bot response (required for add)').setRequired(false)),
  new SlashCommandBuilder().setName('restart').setDescription('Restart the bot process (admin only)').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('snipe').setDescription('Show the last deleted message in this channel'),
    new SlashCommandBuilder().setName('poll').setDescription('Create a poll with reactions')
      .addStringOption(o => o.setName('question').setDescription('Poll question').setRequired(true))
      .addStringOption(o => o.setName('options').setDescription('Options separated by | e.g. Yes | No | Maybe').setRequired(false)),
    new SlashCommandBuilder().setName('remind').setDescription('Set a DM reminder')
      .addStringOption(o => o.setName('time').setDescription('Duration e.g. 10m, 2h, 30s').setRequired(true))
      .addStringOption(o => o.setName('note').setDescription('Reminder message').setRequired(false)),

  // Bot management
  new SlashCommandBuilder().setName('botavatar').setDescription("Change the bot's avatar (admin only)")
    .addStringOption(o => o.setName('url').setDescription('Direct image URL').setRequired(true)),
  new SlashCommandBuilder().setName('botbanner').setDescription("Change the bot's banner image (admin only)")
    .addStringOption(o => o.setName('url').setDescription('Direct image URL').setRequired(true)),
  new SlashCommandBuilder().setName('botbio').setDescription("Change the bot's About Me / bio (admin only, max 190 chars)")
    .addStringOption(o => o.setName('bio').setDescription('New bio text (max 190 characters)').setRequired(true)),
  new SlashCommandBuilder().setName('botname').setDescription("Change the bot's username (admin only, 2/hour limit)")
    .addStringOption(o => o.setName('name').setDescription('New username (2–32 chars)').setRequired(true)),
  new SlashCommandBuilder().setName('botstatus').setDescription("Change the bot's activity status (admin only)")
    .addStringOption(o => o.setName('type').setDescription('Activity type').setRequired(true)
      .addChoices({ name: 'watching', value: 'watching' }, { name: 'playing', value: 'playing' }, { name: 'listening', value: 'listening' }, { name: 'competing', value: 'competing' }))
    .addStringOption(o => o.setName('text').setDescription('Status text').setRequired(true)),

  // Server management
  new SlashCommandBuilder().setName('serveravatar').setDescription("Change this server's icon/avatar (admin only)").setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('url').setDescription('Direct image URL').setRequired(true)),
  new SlashCommandBuilder().setName('serverbanner').setDescription("Change this server's banner (admin only, requires Level 2 boost)").setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('url').setDescription('Direct image URL').setRequired(true)),
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
      try {
        const r = await createTicket(interaction.guild, interaction.member);
        if (r.error) return interaction.editReply({ content: `${E.deny} Failed to create ticket: ${r.error}` });
        return interaction.editReply({ content: r.existing ? `${E.warn} You already have a ticket: ${r.channel}` : `${E.check} Ticket created: ${r.channel}` });
      } catch (e) {
        return interaction.editReply({ content: `${E.deny} Error creating ticket: ${e.message}` });
      }
    }
    if (interaction.customId === 'ticket_close') {
      // Detect ticket by Map OR by channel name (survives bot restarts)
      const isTicket = openTickets.has(interaction.channel.id) || interaction.channel.name?.startsWith('ticket-');
      if (!isTicket) return interaction.reply({ embeds: [err('Not a ticket channel.')], ephemeral: true });
      const ticketOwner = openTickets.get(interaction.channel.id)?.userId;
      if (!isMod(interaction.member) && ticketOwner && interaction.user.id !== ticketOwner)
        return interaction.reply({ embeds: [err('Only staff or the ticket owner can close this.')], ephemeral: true });
      await interaction.reply({ embeds: [warn('Closing…', 'Ticket will be deleted shortly.')], ephemeral: true });
      try { await closeTicket(interaction.channel, interaction.member); } catch (e) { console.error('closeTicket error:', e.message); }
      return;
    }
    if (interaction.customId === 'ticket_claim') {
      if (!isMod(interaction.member)) return interaction.reply({ embeds: [err('Only staff can claim.')], ephemeral: true });
      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setEmoji({ id: '1518570359262154793', name: 'emoji_2' }).setStyle(ButtonStyle.Danger),
      );
      return interaction.update({ embeds: [...interaction.message.embeds, ok('Claimed', `Claimed by ${interaction.member}`)], components: [closeRow] });
    }

    // Deal buttons
    if (interaction.customId.startsWith('deal_accept_') || interaction.customId.startsWith('deal_reject_')) {
      const isAccept = interaction.customId.startsWith('deal_accept_');
      const dealId   = interaction.customId.slice(isAccept ? 'deal_accept_'.length : 'deal_reject_'.length);
      const deal     = activeDeals.get(dealId);
      if (!deal) return interaction.reply({ embeds: [err('This deal has expired or was not found.')], ephemeral: true });
      if (deal.status !== 'pending') return interaction.reply({ embeds: [err('This deal has already been decided.')], ephemeral: true });
      if (interaction.user.id === deal.proposerId) return interaction.reply({ embeds: [err('You cannot respond to your own deal proposal.')], ephemeral: true });
      const canRespond = deal.targetId
        ? interaction.user.id === deal.targetId
        : isMod(interaction.member);
      if (!canRespond) return interaction.reply({ embeds: [err('Only the intended recipient can accept or reject this deal.')], ephemeral: true });

      deal.status      = isAccept ? 'accepted' : 'rejected';
      deal.responderId = interaction.user.id;
      deal.respondedAt = Date.now();

      const color  = isAccept ? 0x57f287 : 0xed4245;
      const status = isAccept ? `${E.check} Accepted` : `${E.deny} Rejected`;

      const updatedEmbed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`${E.cart} Deal Proposal`)
        .addFields(
          { name: `${E.cart} Product`,     value: deal.product,                      inline: true  },
          { name: `${E.e4} Proposed by`,  value: `<@${deal.proposerId}>`,           inline: true  },
          { name: `${E.e4} Responded by`, value: `<@${interaction.user.id}>`,       inline: true  },
          { name: `${E.info} Status`,    value: status,                            inline: false },
        )
        .setFooter({ text: `Decision made by ${interaction.user.tag}` })
        .setTimestamp();

      await interaction.update({ embeds: [updatedEmbed], components: [] });

      // Log to deal log channel
      const cfg     = gc(interaction.guild.id);
      const logChId = cfg.dealLogChannel;
      if (logChId) {
        const logCh = interaction.guild.channels.cache.get(logChId);
        if (logCh) {
          logCh.send({ embeds: [new EmbedBuilder()
            .setColor(color)
            .setTitle(`${E.cart} Deal ${isAccept ? 'Accepted' : 'Rejected'}`)
            .addFields(
              { name: `${E.cart} Product`,    value: deal.product,                              inline: true  },
              { name: `${E.hash} Ticket`,     value: `<#${deal.channelId}>`,                  inline: true  },
              { name: `${E.e4} Proposer`,    value: `<@${deal.proposerId}>`,                  inline: true  },
              { name: `${E.e4} Responder`,   value: `<@${interaction.user.id}>`,              inline: true  },
              { name: `${E.info} Decision`,   value: status,                                   inline: true  },
              { name: `${E.arrow} Proposed`, value: `<t:${Math.floor(deal.at / 1000)}:R>`,   inline: true  },
            )
            .setFooter({ text: `Guild: ${interaction.guild.name}` })
            .setTimestamp()
          ] }).catch(() => {});
        }
      }
      // If deal rejected → warn the ticket will close in 3 minutes, then close
      if (!isAccept) {
        const ticketCh = interaction.guild.channels.cache.get(deal.channelId);
        if (ticketCh) {
          ticketCh.send({ embeds: [new EmbedBuilder()
            .setColor(0xed4245)
            .setTitle(`${E.warn} Deal Rejected`)
            .setDescription(`The deal was rejected by <@${interaction.user.id}>.
This ticket will **automatically close in 3 minutes**.`)
            .setTimestamp()] }).catch(() => {});
          setTimeout(async () => {
            try { await closeTicket(ticketCh, interaction.member, 'Deal rejected'); } catch {}
          }, 3 * 60 * 1000);
        }
      }
      return;
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const ctx  = ctxFromInteraction(interaction);
  const { commandName, options, guild } = interaction;

  // Route every slash command to its COMMANDS[].run() with resolved args
  try {
    switch (commandName) {
      case 'config':       return await COMMANDS.config.run(ctx, []);
      case 'resetconfig':  return await COMMANDS.resetconfig.run(ctx, []);
      case 'setwelcome': {
        const ch = options.getChannel('channel');
        return await COMMANDS.setwelcome.run(ctx, ch ? [ch.id] : []);
      }
      case 'setlogs': {
        const ch = options.getChannel('channel');
        return await COMMANDS.setlogs.run(ctx, ch ? [ch.id] : []);
      }
      case 'settickets': {
        const cat = options.getString('category') || '';
        return await COMMANDS.settickets.run(ctx, [cat]);
      }
      case 'setmodrole': {
        const role = options.getRole('role');
        return await COMMANDS.setmodrole.run(ctx, role ? [role.id] : []);
      }
      case 'setadminrole': {
        const role = options.getRole('role');
        return await COMMANDS.setadminrole.run(ctx, role ? [role.id] : []);
      }
      case 'setmutedrole': {
        const role = options.getRole('role');
        return await COMMANDS.setmutedrole.run(ctx, role ? [role.id] : []);
      }
      case 'setprefix': {
        const val = options.getString('prefix') || '';
        return await COMMANDS.setprefix.run(ctx, [val]);
      }
      case 'setwelcomeimage': {
        const url = options.getString('url') || '';
        return await COMMANDS.setwelcomeimage.run(ctx, [url]);
      }
      case 'setwelcomemsg': {
        const msg = options.getString('message') || '';
        return await COMMANDS.setwelcomemsg.run(ctx, msg ? [msg] : []);
      }
      case 'setgoodbye': {
        const ch = options.getChannel('channel');
        return await COMMANDS.setgoodbye.run(ctx, ch ? [ch.id] : []);
      }
      case 'setgoodbyemsg': {
        const msg = options.getString('message') || '';
        return await COMMANDS.setgoodbyemsg.run(ctx, msg ? [msg] : []);
      }
      case 'setnoprefix': {
        const toggle = options.getString('toggle') || '';
        return await COMMANDS.setnoprefix.run(ctx, toggle ? [toggle] : []);
      }
      case 'setticketnote': {
        const text = options.getString('text') || '';
        return await COMMANDS.setticketnote.run(ctx, text ? [text] : []);
      }
      case 'setmedia': {
        const ch     = options.getChannel('channel');
        const action = options.getString('action') || 'set';
        return await COMMANDS.setmedia.run(ctx, ch ? [`<#${ch.id}>`, action] : []);
      }
      case 'mediawhitelist': {
        const action = options.getString('action') || 'list';
        const role   = options.getRole('role');
        const user   = options.getUser('user');
        const target = role ? `<@&${role.id}>` : user ? `<@${user.id}>` : '';
        return await COMMANDS.mediawhitelist.run(ctx, target ? [action, target] : [action]);
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
      case 'nickname':
      case 'nick': {
        const member = await resolveMember(guild, options.getUser('user'));
        const nick   = options.getString('nick') || '';
        return await COMMANDS.nickname.run(ctx, nick ? [nick] : [], member);
      }
      case 'adduser': {
        const member = await resolveMember(guild, options.getUser('user'));
        return await COMMANDS.adduser.run(ctx, [], member);
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
      case 'invites': {
        const user   = options.getUser('user');
        const member = user ? await resolveMember(guild, user) : ctx.member;
        return await COMMANDS.invites.run(ctx, [], member);
      }
      case 'inviteleader': return await COMMANDS.inviteleader.run(ctx, []);
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
      case 'deal': {
        const product = options.getString('product') || '';
        return await COMMANDS.deal.run(ctx, product.split(' '));
      }
      case 'setdeallog': {
        const ch = options.getChannel('channel');
        return await COMMANDS.setdeallog.run(ctx, ch ? [ch.id] : []);
      }
      case 'cmds':       return await COMMANDS.cmds.run(ctx, []);
      case 'autorespond': {
        const action   = options.getString('action') || '';
        const trigger  = options.getString('trigger') || '';
        const response = options.getString('response') || '';
        const combined = action === 'add' ? [action, `${trigger} | ${response}`] : [action, trigger];
        return await COMMANDS.autorespond.run(ctx, combined);
      }
      case 'restart':     return await COMMANDS.restart.run(ctx, []);
        case 'snipe':       return await COMMANDS.snipe.run(ctx, []);
        case 'poll': {
          const q = options.getString('question') || '';
          const o = options.getString('options') || '';
          const allArgs = o ? [q, '|', ...o.split('|').map(s => s.trim())] : q.split(' ');
          return await COMMANDS.poll.run(ctx, allArgs);
        }
        case 'remind': {
          const t = options.getString('time') || '';
          const n = options.getString('note') || '';
          return await COMMANDS.remind.run(ctx, [t, ...n.split(' ')].filter(Boolean));
        }
      case 'botavatar':    return await COMMANDS.botavatar.run(ctx, [options.getString('url') || '']);
      case 'botbanner':    return await COMMANDS.botbanner.run(ctx, [options.getString('url') || '']);
      case 'botbio':       return await COMMANDS.botbio.run(ctx, (options.getString('bio') || '').split(' '));
      case 'botname':      return await COMMANDS.botname.run(ctx, (options.getString('name') || '').split(' '));
      case 'serveravatar': return await COMMANDS.serveravatar.run(ctx, [options.getString('url') || '']);
      case 'serverbanner': return await COMMANDS.serverbanner.run(ctx, [options.getString('url') || '']);
      case 'botstatus': {
        const type = options.getString('type') || '';
        const text = options.getString('text') || '';
        return await COMMANDS.botstatus.run(ctx, [type, ...text.split(' ')]);
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

  // ── Media-only channel enforcement ───────────────────────────────────────────
  {
    const mediaCfg      = gc(message.guild.id);
    const mediaChannels = mediaCfg.mediaChannels || [];
    if (mediaChannels.includes(message.channel.id)) {
      const whitelist     = mediaCfg.mediaWhitelist || [];
      const isWhitelisted = whitelist.some(id =>
        id === message.author.id || message.member.roles.cache.has(id)
      );
      if (!isWhitelisted && !isMod(message.member)) {
        const hasMedia =
          message.attachments.size > 0 ||
          message.embeds.some(e => e.image || e.video || e.thumbnail) ||
          /https?:\/\/\S+\.(gif|jpg|jpeg|png|webp|mp4|mov|webm|svg)/i.test(message.content) ||
          /https?:\/\/(tenor|giphy|imgur|i\.redd\.it)\./i.test(message.content);
        if (!hasMedia) {
          await message.delete().catch(() => {});
          const r = await message.channel.send({
            content: `<@${message.author.id}>`,
            embeds: [new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle('📷 Media Only')
              .setDescription('This channel only allows **images, videos, GIFs, and files**.\nText-only messages are not allowed here.')
              .setFooter({ text: 'Contact a moderator if you have a question.' })
              .setTimestamp()],
          });
          setTimeout(() => r.delete().catch(() => {}), 6000);
          return;
        }
      }
    }
  }

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
      // Escape prefix for safe use in regex (e.g. "c." → "c\.")
      const escapedPrefix = PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Strip any prefix/botname from the front — e.g. "c.ban", "ceas ban", or just "ban"
      const stripped = content.replace(new RegExp(`^(${escapedPrefix}|${BOT_NAME}\\s*)`, 'i'), '').trim();
      const parts    = stripped.split(/\s+/);
      const trigger  = parts[0]?.toLowerCase();
      const tArgs    = parts.slice(1).filter(a => !a.startsWith('<@')); // strip mentions from args

      // Only allow moderation/social commands via reply trigger (not config/admin/utility)
      const REPLY_CMDS = new Set(['ban','kick','mute','unmute','warn','warnings','clearwarns','purge','nickname','nick','role','vouch','unvouch','adduser']);
      if (trigger && REPLY_CMDS.has(trigger) && COMMANDS[trigger] && isMod(message.member)) {
        const tMember = await message.guild.members.fetch(ref.author.id).catch(() => null);
        if (tMember) {
          // Wrap ctx.reply so the response auto-deletes (clean up trigger noise)
          const baseCtx = ctxFromMessage(message);
          const ctx = {
            ...baseCtx,
            reply: async (opts) => {
              const sent = await baseCtx.reply(opts);
              if (sent) setTimeout(() => sent.delete().catch(() => {}), 5000);
              return sent;
            },
          };
          try {
            await COMMANDS[trigger].run(ctx, tArgs, tMember);
            // Delete the trigger message itself (the mod's "ban" / "kick" reply)
            message.delete().catch(() => {});
          } catch (e) { console.error(e); }
          return;
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
  } else {
    // True no-prefix mode: mods can type just "ban @user reason" with nothing before it
    const cfgNP = gc(message.guild.id);
    if (cfgNP.noprefix && isMod(message.member)) {
      const split       = content.trim().split(/\s+/);
      const possibleCmd = split[0]?.toLowerCase();
      if (possibleCmd && COMMANDS[possibleCmd]) {
        cmdName = possibleCmd;
        args    = split.slice(1);
      }
    }
    if (!cmdName) return;
  }

  if (!cmdName) return message.reply({ embeds: [info('Hey!', `Use \`${PREFIX}help\` or \`ceas help\`\nFirst time? Run \`${PREFIX}setup\` to configure!`)] });

  const command = COMMANDS[cmdName];
  if (!command) return message.reply({ embeds: [err(`Unknown command \`${cmdName}\`\nUse \`${PREFIX}help\` for the full list.`)] });

  const ctx = ctxFromMessage(message);

  // Resolve prefix-command target from mentions
  let target = null;
  if (!['purge', 'config', 'setwelcome', 'setlogs', 'settickets', 'setmodrole', 'setadminrole', 'setmutedrole', 'setprefix', 'setwelcomeimage', 'setwelcomemsg', 'setgoodbye', 'setgoodbyemsg', 'resetconfig', 'setnoprefix', 'setmedia', 'mediawhitelist', 'setticketnote', 'say', 'embed', 'serverinfo', 'ping', 'ticket', 'close', 'help', 'unban', 'lock', 'unlock', 'slowmode', 'afk', 'vouchleader', 'inviteleader', 'antinuke', 'invites', 'deal', 'setdeallog', 'botavatar', 'botbanner', 'botbio', 'botname', 'botstatus', 'serveravatar', 'serverbanner', 'autorespond', 'addcmd', 'delcmd', 'cmds', 'restart', 'snipe', 'poll', 'remind'].includes(cmdName)) {
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

// ─── Auto-respond & custom commands ──────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  const cfg = gc(message.guild.id);

  // Auto-respond check
  const list = cfg.autoResponds || [];
  const low  = message.content.toLowerCase();
  for (const { trigger, response } of list) {
    if (low.includes(trigger)) { message.reply(response).catch(() => {}); break; }
  }

  // Custom commands check (only when no prefix was triggered)
  const PREFIX     = getPrefix(message.guild.id);
  const hasPrefix  = message.content.startsWith(PREFIX) || message.content.toLowerCase().startsWith('ceas ');
  if (!hasPrefix) {
    const firstWord = message.content.trim().split(/\s+/)[0]?.toLowerCase();
    const cmds      = cfg.customCmds || {};
    if (firstWord && cmds[firstWord]) message.reply(cmds[firstWord]).catch(() => {});
  }
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
    sendLog(member.guild, info('Bot Added', `Bot **${member.user.tag}** added by <@${executorId}> (whitelisted)`));
    return;
  }
  // Non-whitelisted user added a bot → warn in log
  sendLog(member.guild, new EmbedBuilder().setColor(0xfee75c).setTitle(`${E.warn} Unwhitelisted Bot Added`)
    .setDescription(`Bot **${member.user.tag}** was added by <@${executorId}>.\nIf this looks suspicious, run \`antinuke whitelist\` for trusted admins.`)
    .setTimestamp());
});

// ─── Invite Tracker ───────────────────────────────────────────────────────────
client.on(Events.InviteCreate, async (invite) => {
  const gMap = inviteCache.get(invite.guild.id) || new Map();
  gMap.set(invite.code, { uses: invite.uses ?? 0, inviterId: invite.inviter?.id ?? null });
  inviteCache.set(invite.guild.id, gMap);
});

client.on(Events.InviteDelete, async (invite) => {
  const gMap = inviteCache.get(invite.guild?.id);
  if (gMap) gMap.delete(invite.code);
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.user.bot) return;
  try {
    const cachedMap = inviteCache.get(member.guild.id) || new Map();
    const freshInvs = await member.guild.invites.fetch();
    let usedInvite  = null;
    for (const [code, fresh] of freshInvs) {
      const cached = cachedMap.get(code);
      if ((fresh.uses ?? 0) > (cached?.uses ?? 0)) { usedInvite = fresh; break; }
    }
    // Update cache
    const newMap = new Map();
    freshInvs.forEach(inv => newMap.set(inv.code, { uses: inv.uses ?? 0, inviterId: inv.inviter?.id ?? null }));
    inviteCache.set(member.guild.id, newMap);
    // Record join
    if (usedInvite?.inviter?.id) {
      const gJoins = inviteJoins.get(member.guild.id) || new Map();
      gJoins.set(member.id, { inviterId: usedInvite.inviter.id, code: usedInvite.code, at: Date.now() });
      inviteJoins.set(member.guild.id, gJoins);
    }
  } catch {}
});

// ─── Welcome ──────────────────────────────────────────────────────────────────
client.on(Events.GuildMemberAdd, async (member) => {
  const cfg = gc(member.guild.id);
  if (!cfg.welcomeChannel) return;
  const ch = member.guild.channels.cache.get(cfg.welcomeChannel);
  if (!ch) return;

  // Build description — use custom message if set, with variable substitution
  const defaultMsg = `Hey ${member}!\nYou are member **#${member.guild.memberCount}**.\nPlease read the rules and enjoy your stay! ${E.gift}`;
  const description = cfg.welcomeMsg
    ? cfg.welcomeMsg
        .replace(/\{user\}/gi,   member.toString())
        .replace(/\{tag\}/gi,    member.user.tag)
        .replace(/\{server\}/gi, member.guild.name)
        .replace(/\{count\}/gi,  member.guild.memberCount.toString())
    : defaultMsg;

  const emb = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`${E.gift} Welcome to ${member.guild.name}!`)
    .setDescription(description)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: `${E.info} Account Created`, value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
      { name: `${E.stock} Member Count`,   value: `${member.guild.memberCount}`,                              inline: true },
    )
    .setFooter({ text: member.guild.name, iconURL: member.guild.iconURL() })
    .setTimestamp();

  if (cfg.welcomeImage) emb.setImage(cfg.welcomeImage);
  ch.send({ content: `${member}`, embeds: [emb] });
});

// ─── Goodbye ──────────────────────────────────────────────────────────────────
client.on(Events.GuildMemberRemove, async (member) => {
  if (member.user.bot) return;
  const cfg = gc(member.guild.id);
  if (!cfg.goodbyeChannel) return;
  const ch = member.guild.channels.cache.get(cfg.goodbyeChannel);
  if (!ch) return;

  const defaultMsg = `**{tag}** has left the server. We now have **{count}** members.`;
  const description = (cfg.goodbyeMsg || defaultMsg)
    .replace(/\{user\}/gi,   member.toString())
    .replace(/\{tag\}/gi,    member.user.tag)
    .replace(/\{server\}/gi, member.guild.name)
    .replace(/\{count\}/gi,  member.guild.memberCount.toString());

  ch.send({ embeds: [new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`${E.deny} Goodbye!`)
    .setDescription(description)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: `${E.info} Was Here Since`, value: member.joinedAt ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Unknown', inline: true },
      { name: `${E.stock} Members Left`,  value: `${member.guild.memberCount}`, inline: true },
    )
    .setFooter({ text: member.guild.name, iconURL: member.guild.iconURL() })
    .setTimestamp()] });
});

// ─── Ready ─────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {

  console.log(`\n✅  Ceas Bot online — ${client.user.tag}`);
  console.log(`⚙️   Config stored in config.json | Use c.setup to configure`);
  console.log(`🔷  ${SLASH_DEFS.length} slash commands | ${Object.keys(COMMANDS).length} prefix commands\n`);
  client.user.setActivity('NO LIMIT 💫', { type: 3 }); // type 3 = Watching

  // Cache all guild invites for invite tracking
  for (const [, guild] of client.guilds.cache) {
    guild.invites.fetch().then(invs => {
      const gMap = new Map();
      invs.forEach(inv => gMap.set(inv.code, { uses: inv.uses ?? 0, inviterId: inv.inviter?.id ?? null }));
      inviteCache.set(guild.id, gMap);
    }).catch(() => {});
  }

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
