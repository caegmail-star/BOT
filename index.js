require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, PermissionFlagsBits,
  ChannelType, AttachmentBuilder, Collection, Events,
  REST, Routes, SlashCommandBuilder,
} = require('discord.js');

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

// ─── Config ───────────────────────────────────────────────────────────────────
const PREFIX        = (process.env.PREFIX || 'c.').toLowerCase();
const BOT_NAME      = 'ceas';
const OWNER_ID      = process.env.OWNER_ID       || '';
const WELCOME_CHANNEL_ID  = process.env.WELCOME_CHANNEL_ID  || '';
const LOG_CHANNEL_ID      = process.env.LOG_CHANNEL_ID      || '';
const TICKET_CATEGORY_ID  = process.env.TICKET_CATEGORY_ID  || '';
const MUTED_ROLE_ID       = process.env.MUTED_ROLE_ID       || '';
const MOD_ROLE_ID         = process.env.MOD_ROLE_ID         || '';
const ADMIN_ROLE_ID       = process.env.ADMIN_ROLE_ID       || '';
const WELCOME_IMAGE_URL   = process.env.WELCOME_IMAGE_URL   || '';
const GUILD_ID            = process.env.GUILD_ID            || '';

// ─── In-Memory Stores ─────────────────────────────────────────────────────────
const warnings   = new Map(); // userId → [{reason, date, moderator}]
const openTickets= new Map(); // channelId → { userId, createdAt, messages:[] }
const afkUsers   = new Map(); // userId → { reason, since, originalNick }
const vouches    = new Map(); // targetId → [{ fromId, fromTag, comment, date }]

// ─── Helpers ──────────────────────────────────────────────────────────────────
const successEmbed = (title, desc) =>
  new EmbedBuilder().setColor(0x57f287).setTitle(`✅ ${title}`).setDescription(desc).setTimestamp();

const errorEmbed = (desc) =>
  new EmbedBuilder().setColor(0xed4245).setTitle('❌ Error').setDescription(desc).setTimestamp();

const infoEmbed = (title, desc) =>
  new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(desc).setTimestamp();

const warnEmbed = (title, desc) =>
  new EmbedBuilder().setColor(0xfee75c).setTitle(`⚠️ ${title}`).setDescription(desc).setTimestamp();

async function sendLog(guild, embed) {
  if (!LOG_CHANNEL_ID) return;
  const ch = guild.channels.cache.get(LOG_CHANNEL_ID);
  if (ch) ch.send({ embeds: [embed] }).catch(() => {});
}

function hasModPerms(member) {
  if (!member) return false;
  if (member.id === OWNER_ID) return true;
  if (MOD_ROLE_ID && member.roles.cache.has(MOD_ROLE_ID)) return true;
  if (ADMIN_ROLE_ID && member.roles.cache.has(ADMIN_ROLE_ID)) return true;
  return member.permissions.has(PermissionFlagsBits.ModerateMembers);
}

function hasAdminPerms(member) {
  if (!member) return false;
  if (member.id === OWNER_ID) return true;
  if (ADMIN_ROLE_ID && member.roles.cache.has(ADMIN_ROLE_ID)) return true;
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

// ─── AFK Helpers ──────────────────────────────────────────────────────────────
async function setAfk(member, reason) {
  const original = member.nickname || member.user.username;
  const newNick   = `[AFK] ${original}`.slice(0, 32);
  afkUsers.set(member.id, { reason, since: Date.now(), originalNick: original });
  try { await member.setNickname(newNick); } catch {}
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
  // Fetch up to 500 messages
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
    const time = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
    const tag  = m.author.bot ? `[BOT] ${m.author.tag}` : m.author.tag;
    const content = m.content || (m.embeds.length ? '[Embed]' : '') || (m.attachments.size ? '[Attachment]' : '');
    return `[${time}] ${tag}: ${content}`;
  });

  const header = [
    `==============================`,
    ` TICKET TRANSCRIPT`,
    ` Channel : #${channel.name}`,
    ` Server  : ${channel.guild.name}`,
    ` Date    : ${new Date().toUTCString()}`,
    ` Messages: ${lines.length}`,
    `==============================\n`,
  ].join('\n');

  return Buffer.from(header + lines.join('\n'), 'utf8');
}

// ─── Ticket Logic ─────────────────────────────────────────────────────────────
async function createTicket(guild, member) {
  for (const [chId, data] of openTickets.entries()) {
    if (data.userId === member.id) {
      const ch = guild.channels.cache.get(chId);
      if (ch) return { channel: ch, existing: true };
    }
  }

  const opts = {
    name: `ticket-${member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)}`,
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
      { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
    ],
  };
  if (TICKET_CATEGORY_ID) opts.parent = TICKET_CATEGORY_ID;
  if (MOD_ROLE_ID) opts.permissionOverwrites.push({ id: MOD_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });

  const channel = await guild.channels.create(opts);
  openTickets.set(channel.id, { userId: member.id, createdAt: new Date() });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎫 Ticket Opened')
    .setDescription(`Welcome ${member}!\nPlease describe your issue and staff will assist you shortly.`)
    .addFields({ name: 'Close Ticket', value: 'Use the button below or `close` command' })
    .setFooter({ text: guild.name, iconURL: guild.iconURL() })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim').setEmoji('✋').setStyle(ButtonStyle.Success),
  );

  await channel.send({ content: `${member}${MOD_ROLE_ID ? ` <@&${MOD_ROLE_ID}>` : ''}`, embeds: [embed], components: [row] });
  return { channel, existing: false };
}

async function closeTicket(channel, closedBy, reason = 'No reason provided') {
  const ticketData = openTickets.get(channel.id);
  if (!ticketData) return;

  // Build transcript
  const transcriptBuf = await buildTranscript(channel);
  const attachment = new AttachmentBuilder(transcriptBuf, { name: `transcript-${channel.name}.txt` });

  const closeEmbed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('🔒 Ticket Closed')
    .setDescription(`**Closed by:** ${closedBy}\n**Reason:** ${reason}\n**Channel:** #${channel.name}`)
    .setFooter({ text: channel.guild.name, iconURL: channel.guild.iconURL() })
    .setTimestamp();

  // DM transcript to ticket creator
  try {
    const creator = await client.users.fetch(ticketData.userId);
    await creator.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📄 Ticket Transcript')
          .setDescription(`Your ticket **#${channel.name}** in **${channel.guild.name}** has been closed.\n**Reason:** ${reason}\n\nYour full transcript is attached below.`)
          .setTimestamp(),
      ],
      files: [attachment],
    });
  } catch {}

  // Log to log channel
  sendLog(channel.guild, closeEmbed);

  // Delete ticket after 5s
  openTickets.delete(channel.id);
  await channel.send({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('🔒 Closing in 5 seconds…').setDescription(`Reason: ${reason}`).setTimestamp()] });
  setTimeout(() => channel.delete(`Ticket closed by ${closedBy}`).catch(() => {}), 5000);
}

// ─── Commands ─────────────────────────────────────────────────────────────────
const COMMANDS = {

  // ── Moderation ──────────────────────────────────────────────────────────────
  ban: {
    category: 'moderation', usage: 'ban @user [reason]', description: 'Ban a member from the server',
    async execute(message, args, replyTarget) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      const target = replyTarget || message.mentions.members.first() || message.guild.members.cache.get(args[0]);
      if (!target) return message.reply({ embeds: [errorEmbed('Please mention a valid member.')] });
      if (!target.bannable) return message.reply({ embeds: [errorEmbed('I cannot ban that member.')] });
      const reason = (replyTarget ? args.join(' ') : args.slice(message.mentions.members.size ? 1 : 0).join(' ')) || 'No reason provided';
      await target.ban({ reason, deleteMessageSeconds: 604800 });
      const embed = successEmbed('Member Banned', `**${target.user.tag}** has been banned.\n**Reason:** ${reason}`);
      message.reply({ embeds: [embed] });
      sendLog(message.guild, new EmbedBuilder(embed.toJSON()).setFooter({ text: `Mod: ${message.author.tag}` }));
    }
  },
  unban: {
    category: 'moderation', usage: 'unban <userId> [reason]', description: 'Unban a user by ID',
    async execute(message, args) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      const userId = args[0];
      if (!userId) return message.reply({ embeds: [errorEmbed('Provide a user ID.')] });
      try {
        const user = await client.users.fetch(userId);
        await message.guild.bans.remove(userId, args.slice(1).join(' ') || 'No reason');
        message.reply({ embeds: [successEmbed('User Unbanned', `**${user.tag}** has been unbanned.`)] });
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
      const reason = (replyTarget ? args.join(' ') : args.slice(1).join(' ')) || 'No reason provided';
      await target.kick(reason);
      const embed = successEmbed('Member Kicked', `**${target.user.tag}** has been kicked.\n**Reason:** ${reason}`);
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
        const embed = successEmbed('Member Muted', `**${target.user.tag}** muted for **${duration}m**.\n**Reason:** ${reason}`);
        message.reply({ embeds: [embed] });
        sendLog(message.guild, new EmbedBuilder(embed.toJSON()).setFooter({ text: `Mod: ${message.author.tag}` }));
      } catch { message.reply({ embeds: [errorEmbed('Failed to mute.')] }); }
    }
  },
  unmute: {
    category: 'moderation', usage: 'unmute @user', description: 'Remove timeout from a member',
    async execute(message, args, replyTarget) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      const target = replyTarget || message.mentions.members.first();
      if (!target) return message.reply({ embeds: [errorEmbed('Please mention a valid member.')] });
      await target.timeout(null);
      message.reply({ embeds: [successEmbed('Member Unmuted', `**${target.user.tag}** has been unmuted.`)] });
    }
  },
  warn: {
    category: 'moderation', usage: 'warn @user [reason]', description: 'Warn a member',
    async execute(message, args, replyTarget) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      const target = replyTarget || message.mentions.members.first();
      if (!target) return message.reply({ embeds: [errorEmbed('Please mention a valid member.')] });
      const reason = (replyTarget ? args.join(' ') : args.slice(1).join(' ')) || 'No reason provided';
      if (!warnings.has(target.id)) warnings.set(target.id, []);
      warnings.get(target.id).push({ reason, date: new Date().toISOString(), moderator: message.author.tag });
      const count = warnings.get(target.id).length;
      const embed = warnEmbed('Member Warned', `**${target.user.tag}** warned. Total: **${count}**\n**Reason:** ${reason}`);
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
      if (!list.length) return message.reply({ embeds: [infoEmbed(`Warnings: ${target.user.tag}`, 'No warnings on record.')] });
      const text = list.map((w, i) => `**${i + 1}.** ${w.reason} — *${w.moderator}* <t:${Math.floor(new Date(w.date).getTime() / 1000)}:R>`).join('\n');
      message.reply({ embeds: [infoEmbed(`⚠️ Warnings — ${target.user.tag} (${list.length})`, text)] });
    }
  },
  clearwarns: {
    category: 'moderation', usage: 'clearwarns @user', description: 'Clear all warnings for a member',
    async execute(message, args, replyTarget) {
      if (!hasAdminPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need admin permissions.')] });
      const target = replyTarget || message.mentions.members.first();
      if (!target) return message.reply({ embeds: [errorEmbed('Please mention a valid member.')] });
      warnings.delete(target.id);
      message.reply({ embeds: [successEmbed('Warnings Cleared', `All warnings for **${target.user.tag}** cleared.`)] });
    }
  },
  purge: {
    category: 'moderation', usage: 'purge <amount> [@user]', description: 'Bulk delete messages (max 100)',
    async execute(message, args) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      const amount = parseInt(args[0]);
      if (isNaN(amount) || amount < 1 || amount > 100) return message.reply({ embeds: [errorEmbed('Number must be 1–100.')] });
      let msgs = await message.channel.messages.fetch({ limit: amount + 1 });
      const filter = message.mentions.users.first();
      if (filter) msgs = msgs.filter(m => m.author.id === filter.id);
      const deleted = await message.channel.bulkDelete(msgs, true);
      const r = await message.channel.send({ embeds: [successEmbed('Purged', `Deleted **${deleted.size}** messages.`)] });
      setTimeout(() => r.delete().catch(() => {}), 4000);
    }
  },
  lock: {
    category: 'moderation', usage: 'lock [reason]', description: 'Lock the current channel',
    async execute(message, args) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
      message.reply({ embeds: [warnEmbed('Channel Locked', `Reason: ${args.join(' ') || 'None'}`)] });
    }
  },
  unlock: {
    category: 'moderation', usage: 'unlock', description: 'Unlock the current channel',
    async execute(message) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
      message.reply({ embeds: [successEmbed('Channel Unlocked', 'Channel unlocked.')] });
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
      message.reply({ embeds: [successEmbed('Nickname', `**${target.user.tag}** nickname ${nick ? `set to **${nick}**` : 'reset'}.`)] });
    }
  },
  role: {
    category: 'moderation', usage: 'role @user <role name>', description: 'Give or remove a role from a member',
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
        message.reply({ embeds: [successEmbed('Role Removed', `Removed **${role.name}** from ${target.user.tag}.`)] });
      } else {
        await target.roles.add(role);
        message.reply({ embeds: [successEmbed('Role Added', `Gave **${role.name}** to ${target.user.tag}.`)] });
      }
    }
  },

  // ── AFK ──────────────────────────────────────────────────────────────────────
  afk: {
    category: 'general', usage: 'afk [reason]', description: 'Set yourself as AFK — nick changes to [AFK] Name',
    async execute(message, args) {
      const reason = args.join(' ') || 'AFK';
      if (afkUsers.has(message.author.id)) {
        await removeAfk(message.member);
        return message.reply({ embeds: [successEmbed('AFK Removed', 'Welcome back! Your AFK has been removed.')] });
      }
      await setAfk(message.member, reason);
      message.reply({ embeds: [successEmbed('AFK Set', `You are now AFK.\n**Reason:** ${reason}\n\nYour nickname has been updated to \`[AFK] ${message.member.nickname || message.author.username}\`.`)] });
    }
  },

  // ── Vouch ─────────────────────────────────────────────────────────────────────
  vouch: {
    category: 'social', usage: 'vouch @user [comment]', description: 'Vouch for a member',
    async execute(message, args, replyTarget) {
      const target = replyTarget || message.mentions.members.first();
      if (!target) return message.reply({ embeds: [errorEmbed('Please mention who you want to vouch for.')] });
      if (target.id === message.author.id) return message.reply({ embeds: [errorEmbed("You can't vouch for yourself.")] });
      if (target.user.bot) return message.reply({ embeds: [errorEmbed("You can't vouch for a bot.")] });
      const comment = (replyTarget ? args : args.slice(1)).join(' ') || 'No comment';
      if (!vouches.has(target.id)) vouches.set(target.id, []);
      const list = vouches.get(target.id);
      const existing = list.findIndex(v => v.fromId === message.author.id);
      if (existing !== -1) {
        list[existing] = { fromId: message.author.id, fromTag: message.author.tag, comment, date: new Date().toISOString() };
        return message.reply({ embeds: [successEmbed('Vouch Updated', `Updated your vouch for **${target.user.tag}**.\n💬 *"${comment}"*`)] });
      }
      list.push({ fromId: message.author.id, fromTag: message.author.tag, comment, date: new Date().toISOString() });
      message.reply({ embeds: [successEmbed('Vouch Added', `You vouched for **${target.user.tag}**! They now have **${list.length}** vouch(es).\n💬 *"${comment}"*`)] });
    }
  },
  vouches: {
    category: 'social', usage: 'vouches [@user]', description: 'View vouches for a member',
    async execute(message, args, replyTarget) {
      const target = replyTarget || message.mentions.members.first() || message.member;
      const list = vouches.get(target.id) || [];
      if (!list.length) return message.reply({ embeds: [infoEmbed(`Vouches — ${target.user.tag}`, 'No vouches yet.')] });
      const text = list.map((v, i) => `**${i + 1}.** <t:${Math.floor(new Date(v.date).getTime() / 1000)}:R> by **${v.fromTag}** — *"${v.comment}"*`).join('\n');
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle(`⭐ Vouches for ${target.user.tag} (${list.length})`)
        .setDescription(text)
        .setThumbnail(target.user.displayAvatarURL({ size: 128 }))
        .setTimestamp();
      message.reply({ embeds: [embed] });
    }
  },
  unvouch: {
    category: 'social', usage: 'unvouch @user', description: 'Remove your vouch for a member',
    async execute(message, args, replyTarget) {
      const target = replyTarget || message.mentions.members.first();
      if (!target) return message.reply({ embeds: [errorEmbed('Please mention who to unvouch.')] });
      const list = vouches.get(target.id) || [];
      const idx = list.findIndex(v => v.fromId === message.author.id);
      if (idx === -1) return message.reply({ embeds: [errorEmbed("You haven't vouched for that member.")] });
      list.splice(idx, 1);
      message.reply({ embeds: [successEmbed('Vouch Removed', `Removed your vouch for **${target.user.tag}**.`)] });
    }
  },
  vouchleader: {
    category: 'social', usage: 'vouchleader', description: 'Show the vouch leaderboard',
    async execute(message) {
      const scores = [...vouches.entries()]
        .map(([id, list]) => ({ id, count: list.length }))
        .filter(e => e.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
      if (!scores.length) return message.reply({ embeds: [infoEmbed('Vouch Leaderboard', 'No vouches yet.')] });
      const medals = ['🥇', '🥈', '🥉'];
      const lines = await Promise.all(scores.map(async (e, i) => {
        const user = await client.users.fetch(e.id).catch(() => null);
        return `${medals[i] || `**${i + 1}.**`} ${user ? user.tag : e.id} — **${e.count}** vouch(es)`;
      }));
      message.reply({ embeds: [infoEmbed('⭐ Vouch Leaderboard', lines.join('\n'))] });
    }
  },

  // ── Utility ──────────────────────────────────────────────────────────────────
  say: {
    category: 'utility', usage: 'say <text>  |  say embed Title | Desc', description: 'Make the bot send a message or embed',
    async execute(message, args) {
      if (!hasModPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need moderation permissions.')] });
      message.delete().catch(() => {});
      if (args[0]?.toLowerCase() === 'embed') {
        const parts = args.slice(1).join(' ').split('|');
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(parts[0]?.trim() || 'Announcement')
          .setDescription(parts[1]?.trim() || '\u200b')
          .setFooter({ text: message.guild.name, iconURL: message.guild.iconURL() })
          .setTimestamp();
        const embed = new EmbedBuilder()
          .setColor(0x5865f2).setTitle(parts[0]?.trim() || 'Announcement')
          .setDescription(parts[1]?.trim() || '\u200b')
          .setFooter({ text: message.guild.name, iconURL: message.guild.iconURL() })
          .setTimestamp();
        message.channel.send({ embeds: [embed] });
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
      const embed = new EmbedBuilder()
        .setColor(isNaN(color) ? 0x5865f2 : color)
        .setTitle(p[0] || 'Embed')
        .setDescription(p[1] || '\u200b')
        .setFooter({ text: message.guild.name, iconURL: message.guild.iconURL() })
        .setTimestamp();
      if (p[3]) embed.setImage(p[3]);
      message.channel.send({ embeds: [embed] });
    }
  },
  userinfo: {
    category: 'utility', usage: 'userinfo [@user]', description: 'View info about a user',
    async execute(message, args, replyTarget) {
      const target = replyTarget || message.mentions.members.first() || message.member;
      const afk = afkUsers.get(target.id);
      const vouchCount = (vouches.get(target.id) || []).length;
      const embed = new EmbedBuilder()
        .setColor(0x5865f2).setTitle(`👤 ${target.user.tag}`)
        .setThumbnail(target.user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'User ID', value: target.id, inline: true },
          { name: 'Nickname', value: target.nickname || 'None', inline: true },
          { name: 'AFK', value: afk ? `Yes — ${afk.reason}` : 'No', inline: true },
          { name: 'Account Created', value: `<t:${Math.floor(target.user.createdTimestamp / 1000)}:R>`, inline: true },
          { name: 'Joined Server', value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
          { name: '⭐ Vouches', value: `${vouchCount}`, inline: true },
          { name: 'Roles', value: target.roles.cache.filter(r => r.id !== message.guild.id).map(r => r.toString()).join(', ') || 'None' },
        ).setTimestamp();
      message.reply({ embeds: [embed] });
    }
  },
  serverinfo: {
    category: 'utility', usage: 'serverinfo', description: 'View server info',
    async execute(message) {
      const g = message.guild;
      const embed = new EmbedBuilder()
        .setColor(0x5865f2).setTitle(`🏠 ${g.name}`)
        .setThumbnail(g.iconURL({ size: 256 }))
        .addFields(
          { name: 'Server ID', value: g.id, inline: true },
          { name: 'Owner', value: `<@${g.ownerId}>`, inline: true },
          { name: 'Members', value: `${g.memberCount}`, inline: true },
          { name: 'Channels', value: `${g.channels.cache.size}`, inline: true },
          { name: 'Roles', value: `${g.roles.cache.size}`, inline: true },
          { name: 'Created', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true },
        ).setTimestamp();
      message.reply({ embeds: [embed] });
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
    category: 'utility', usage: 'ping', description: "Check bot latency",
    async execute(message) {
      const m = await message.reply({ embeds: [infoEmbed('🏓 Pinging...', 'Measuring...')] });
      m.edit({ embeds: [infoEmbed('🏓 Pong!', `**Bot:** ${m.createdTimestamp - message.createdTimestamp}ms\n**API:** ${client.ws.ping}ms`)] });
    }
  },

  // ── Tickets ──────────────────────────────────────────────────────────────────
  ticket: {
    category: 'tickets', usage: 'ticket setup', description: 'Post the ticket panel (admin only)',
    async execute(message) {
      if (!hasAdminPerms(message.member)) return message.reply({ embeds: [errorEmbed('You need admin permissions.')] });
      const embed = new EmbedBuilder()
        .setColor(0x5865f2).setTitle('🎫 Support Tickets')
        .setDescription('Need help? Click the button below to open a ticket.\nOur team will assist you shortly.')
        .setFooter({ text: message.guild.name, iconURL: message.guild.iconURL() }).setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_create').setLabel('Open Ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary)
      );
      message.channel.send({ embeds: [embed], components: [row] });
      message.reply({ embeds: [successEmbed('Panel Sent', 'Ticket panel posted.')] });
    }
  },
  close: {
    category: 'tickets', usage: 'close [reason]', description: 'Close the current ticket',
    async execute(message, args) {
      if (!openTickets.has(message.channel.id)) return message.reply({ embeds: [errorEmbed('This is not a ticket channel.')] });
      await closeTicket(message.channel, message.member, args.join(' ') || 'No reason provided');
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
  moderation: { emoji: '🔨', label: 'Moderation',  description: 'Ban, kick, mute, warn, purge & more', color: 0xed4245 },
  utility:    { emoji: '🛠️', label: 'Utility',     description: 'Say, embed, userinfo, serverinfo',    color: 0x5865f2 },
  tickets:    { emoji: '🎫', label: 'Tickets',     description: 'Ticket panel, close, transcript',     color: 0xfee75c },
  social:     { emoji: '⭐', label: 'Social',      description: 'Vouch system, leaderboard',           color: 0xf1c40f },
  general:    { emoji: '📋', label: 'General',     description: 'Help, AFK, ping',                     color: 0x57f287 },
};

async function sendHelpMenu(message) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📚 Ceas Bot — Help')
    .setDescription(
      `**Prefix:** \`${PREFIX}\` or \`${PREFIX.toUpperCase()}\`\n` +
      `**No-prefix:** \`ceas <command> [args]\`\n` +
      `**Reply trigger:** Reply to any message with \`ban\`, \`kick\`, etc.\n` +
      `**Role trigger:** Reply with a role name to instantly give/remove it\n\n` +
      `Select a category below ↓`
    )
    .addFields(Object.entries(CATEGORIES).map(([, v]) => ({ name: `${v.emoji} ${v.label}`, value: v.description, inline: true })))
    .setFooter({ text: `${Object.keys(COMMANDS).length} commands total` })
    .setThumbnail(client.user.displayAvatarURL())
    .setTimestamp();

  const menu = new StringSelectMenuBuilder()
    .setCustomId('help_menu')
    .setPlaceholder('📂 Choose a category…')
    .addOptions(Object.entries(CATEGORIES).map(([key, v]) => ({ label: v.label, value: key, description: v.description, emoji: v.emoji })));

  message.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
}

function getCategoryEmbed(category) {
  const info = CATEGORIES[category] || { emoji: '📋', label: category, color: 0x5865f2 };
  const cmds = Object.entries(COMMANDS).filter(([, c]) => c.category === category);
  return new EmbedBuilder()
    .setColor(info.color)
    .setTitle(`${info.emoji} ${info.label} Commands`)
    .setDescription(cmds.map(([name, c]) => `\`${PREFIX}${name}\` — ${c.description}`).join('\n'))
    .setFooter({ text: `Usage: ${PREFIX}<command> | ceas <command>` })
    .setTimestamp();
}

// ─── Slash Commands Registration ──────────────────────────────────────────────
const slashCommands = [
  new SlashCommandBuilder()
    .setName('afk')
    .setDescription('Set yourself as AFK')
    .addStringOption(o => o.setName('reason').setDescription('AFK reason').setRequired(false)),
  new SlashCommandBuilder()
    .setName('vouch')
    .setDescription('Vouch for a member')
    .addUserOption(o => o.setName('user').setDescription('Who to vouch for').setRequired(true))
    .addStringOption(o => o.setName('comment').setDescription('Your comment').setRequired(false)),
  new SlashCommandBuilder()
    .setName('vouches')
    .setDescription('View vouches for a member')
    .addUserOption(o => o.setName('user').setDescription('Member to check').setRequired(false)),
  new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('View info about a user')
    .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(false)),
  new SlashCommandBuilder()
    .setName('avatar')
    .setDescription("Get a user's avatar")
    .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(false)),
];

// ─── Message Handler ───────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();
  const lower   = content.toLowerCase();

  // ── AFK: Remove AFK when user talks ─────────────────────────────────────────
  if (afkUsers.has(message.author.id)) {
    await removeAfk(message.member);
    const reply = await message.reply({ embeds: [successEmbed('Welcome back!', 'Your AFK has been removed.')] });
    setTimeout(() => reply.delete().catch(() => {}), 5000);
  }

  // ── AFK: Notify if pinging an AFK user ──────────────────────────────────────
  for (const mentioned of message.mentions.members.values()) {
    const afkData = afkUsers.get(mentioned.id);
    if (afkData) {
      const ago = Math.floor((Date.now() - afkData.since) / 1000);
      const timeStr = ago < 60 ? `${ago}s` : ago < 3600 ? `${Math.floor(ago / 60)}m` : `${Math.floor(ago / 3600)}h`;
      message.reply({ embeds: [warnEmbed('User is AFK', `**${mentioned.user.tag}** is AFK for **${timeStr}**.\n**Reason:** ${afkData.reason}`)] }).catch(() => {});
      break;
    }
  }

  // ── Reply Trigger System ─────────────────────────────────────────────────────
  if (message.reference?.messageId) {
    const referencedMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    if (referencedMsg && !referencedMsg.author.bot && referencedMsg.author.id !== message.author.id) {
      const replyContent = content.replace(new RegExp(`^(${PREFIX}|${BOT_NAME}\\s+)`, 'i'), '').trim();
      const parts = replyContent.split(/\s+/);
      const trigger = parts[0].toLowerCase();
      const triggerArgs = parts.slice(1);

      // Check if the reply is a command trigger
      if (COMMANDS[trigger] && hasModPerms(message.member)) {
        const targetMember = await message.guild.members.fetch(referencedMsg.author.id).catch(() => null);
        if (targetMember) {
          try { await COMMANDS[trigger].execute(message, triggerArgs, targetMember); } catch (e) { console.error(e); }
          return;
        }
      }

      // Check if the reply is a role name trigger (mods only)
      if (hasModPerms(message.member) && replyContent.length > 0 && !COMMANDS[trigger]) {
        const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === replyContent.toLowerCase());
        if (role) {
          const targetMember = await message.guild.members.fetch(referencedMsg.author.id).catch(() => null);
          if (targetMember) {
            try {
              if (targetMember.roles.cache.has(role.id)) {
                await targetMember.roles.remove(role);
                message.reply({ embeds: [successEmbed('Role Removed', `Removed **${role.name}** from ${targetMember.user.tag}.`)] });
              } else {
                await targetMember.roles.add(role);
                message.reply({ embeds: [successEmbed('Role Added', `Gave **${role.name}** to ${targetMember.user.tag}.`)] });
              }
            } catch { message.reply({ embeds: [errorEmbed('Failed to manage role. Check my permissions.')] }); }
            return;
          }
        }
      }
    }
  }

  // ── Prefix / No-prefix command parsing ──────────────────────────────────────
  let commandName = null, args = [];

  if (lower.startsWith(PREFIX)) {
    const split = content.slice(PREFIX.length).trim().split(/\s+/);
    commandName = split[0].toLowerCase();
    args = split.slice(1);
  } else if (lower.startsWith(BOT_NAME + ' ') || lower === BOT_NAME) {
    const split = content.slice(BOT_NAME.length).trim().split(/\s+/);
    commandName = split[0]?.toLowerCase();
    args = split.slice(1);
  } else {
    return;
  }

  if (!commandName) {
    return message.reply({ embeds: [infoEmbed('👋 Hey!', `Use \`${PREFIX}help\` or \`ceas help\` to see commands.`)] });
  }

  const command = COMMANDS[commandName];
  if (!command) {
    return message.reply({ embeds: [errorEmbed(`Unknown command: \`${commandName}\`\nUse \`${PREFIX}help\` for a list.`)] });
  }

  try { await command.execute(message, args, null); }
  catch (e) { console.error(`Error in ${commandName}:`, e); message.reply({ embeds: [errorEmbed('An error occurred.')] }).catch(() => {}); }
});

// ─── Slash Command Handler ────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  // ── Help dropdown ────────────────────────────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === 'help_menu') {
    return interaction.update({ embeds: [getCategoryEmbed(interaction.values[0])], components: interaction.message.components });
  }

  // ── Ticket buttons ───────────────────────────────────────────────────────────
  if (interaction.isButton()) {
    if (interaction.customId === 'ticket_create') {
      await interaction.deferReply({ ephemeral: true });
      const result = await createTicket(interaction.guild, interaction.member);
      if (result.existing) return interaction.editReply({ content: `⚠️ You already have an open ticket: ${result.channel}` });
      return interaction.editReply({ content: `✅ Ticket created: ${result.channel}` });
    }
    if (interaction.customId === 'ticket_close') {
      if (!openTickets.has(interaction.channel.id)) return interaction.reply({ embeds: [errorEmbed('This is not a ticket channel.')], ephemeral: true });
      if (!hasModPerms(interaction.member) && interaction.user.id !== openTickets.get(interaction.channel.id)?.userId) {
        return interaction.reply({ embeds: [errorEmbed('Only staff or the ticket owner can close this.')], ephemeral: true });
      }
      await interaction.reply({ embeds: [warnEmbed('Closing…', 'Ticket will close shortly.')], ephemeral: true });
      return closeTicket(interaction.channel, interaction.member);
    }
    if (interaction.customId === 'ticket_claim') {
      if (!hasModPerms(interaction.member)) return interaction.reply({ embeds: [errorEmbed('Only staff can claim.')], ephemeral: true });
      return interaction.update({
        embeds: [...interaction.message.embeds, successEmbed('Ticket Claimed', `Claimed by ${interaction.member}`)],
        components: []
      });
    }
  }

  // ── Slash commands ───────────────────────────────────────────────────────────
  if (!interaction.isChatInputCommand()) return;
  const { commandName, options, member, guild } = interaction;

  if (commandName === 'afk') {
    const reason = options.getString('reason') || 'AFK';
    if (afkUsers.has(interaction.user.id)) {
      await removeAfk(member);
      return interaction.reply({ embeds: [successEmbed('AFK Removed', 'Welcome back! Your AFK status has been removed.')], ephemeral: true });
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
    const existing = list.findIndex(v => v.fromId === interaction.user.id);
    if (existing !== -1) {
      list[existing] = { fromId: interaction.user.id, fromTag: interaction.user.tag, comment, date: new Date().toISOString() };
      return interaction.reply({ embeds: [successEmbed('Vouch Updated', `Updated vouch for **${targetUser.tag}**.\n💬 *"${comment}"*`)] });
    }
    list.push({ fromId: interaction.user.id, fromTag: interaction.user.tag, comment, date: new Date().toISOString() });
    return interaction.reply({ embeds: [successEmbed('Vouched!', `You vouched for **${targetUser.tag}**! They have **${list.length}** vouch(es).\n💬 *"${comment}"*`)] });
  }

  if (commandName === 'vouches') {
    const targetUser = options.getUser('user') || interaction.user;
    const gMember   = await guild.members.fetch(targetUser.id).catch(() => null);
    const list = vouches.get(targetUser.id) || [];
    if (!list.length) return interaction.reply({ embeds: [infoEmbed(`Vouches — ${targetUser.tag}`, 'No vouches yet.')] });
    const text = list.map((v, i) => `**${i + 1}.** <t:${Math.floor(new Date(v.date).getTime() / 1000)}:R> by **${v.fromTag}** — *"${v.comment}"*`).join('\n');
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle(`⭐ Vouches for ${targetUser.tag} (${list.length})`).setDescription(text).setThumbnail(targetUser.displayAvatarURL({ size: 128 })).setTimestamp()] });
  }

  if (commandName === 'userinfo') {
    const targetUser = options.getUser('user') || interaction.user;
    const gMember    = await guild.members.fetch(targetUser.id).catch(() => null);
    if (!gMember) return interaction.reply({ embeds: [errorEmbed('Could not find that member.')] });
    const afk = afkUsers.get(targetUser.id);
    const vouchCount = (vouches.get(targetUser.id) || []).length;
    return interaction.reply({ embeds: [new EmbedBuilder()
      .setColor(0x5865f2).setTitle(`👤 ${targetUser.tag}`)
      .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: 'User ID', value: targetUser.id, inline: true },
        { name: 'AFK', value: afk ? `Yes — ${afk.reason}` : 'No', inline: true },
        { name: '⭐ Vouches', value: `${vouchCount}`, inline: true },
        { name: 'Account Created', value: `<t:${Math.floor(targetUser.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Joined Server', value: `<t:${Math.floor(gMember.joinedTimestamp / 1000)}:R>`, inline: true },
      ).setTimestamp()] });
  }

  if (commandName === 'avatar') {
    const targetUser = options.getUser('user') || interaction.user;
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🖼️ ${targetUser.tag}`).setImage(targetUser.displayAvatarURL({ size: 1024 })).setTimestamp()] });
  }
});

// ─── Welcome ──────────────────────────────────────────────────────────────────
client.on(Events.GuildMemberAdd, async (member) => {
  if (!WELCOME_CHANNEL_ID) return;
  const ch = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
  if (!ch) return;
  const embed = new EmbedBuilder()
    .setColor(0x57f287).setTitle(`👋 Welcome to ${member.guild.name}!`)
    .setDescription(`Hey ${member}, welcome!\nYou are member **#${member.guild.memberCount}**.\nPlease read the rules and enjoy your stay!`)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: '📅 Account Age', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
      { name: '👥 Members', value: `${member.guild.memberCount}`, inline: true },
    )
    .setFooter({ text: member.guild.name, iconURL: member.guild.iconURL() })
    .setTimestamp();
  if (WELCOME_IMAGE_URL) embed.setImage(WELCOME_IMAGE_URL);
  ch.send({ embeds: [embed] });
});

// ─── Ready ─────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`\n✅ Ceas Bot online as ${client.user.tag}`);
  console.log(`📋 Prefix: ${PREFIX} | ${PREFIX.toUpperCase()}`);
  console.log(`💬 No-prefix trigger: "ceas <command>"`);
  console.log(`↩️  Reply trigger: reply to any message with a command name or role name`);
  console.log(`😴 AFK system: active`);
  console.log(`🎫 Ticket transcript: enabled (DM on close)`);
  console.log(`⭐ Vouch system: active`);
  console.log(`🔧 Commands: ${Object.keys(COMMANDS).length} prefix | ${slashCommands.length} slash\n`);

  client.user.setActivity(`${PREFIX}help | ceas help`, { type: 3 });

  // Register slash commands
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    const route = GUILD_ID
      ? Routes.applicationGuildCommands(client.user.id, GUILD_ID)
      : Routes.applicationCommands(client.user.id);
    await rest.put(route, { body: slashCommands.map(c => c.toJSON()) });
    console.log(`✅ Slash commands registered ${GUILD_ID ? '(guild)' : '(global)'}`);
  } catch (e) {
    console.error('Failed to register slash commands:', e.message);
  }
});

client.on(Events.Error, e => console.error('Client error:', e));
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));

client.login(process.env.BOT_TOKEN);
