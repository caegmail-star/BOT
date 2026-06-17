# 🤖 Ceas Discord Bot

A fully-featured Discord bot — moderation, tickets with transcripts, AFK system, vouch system, reply-trigger system, welcome images, and an interactive dropdown help menu.

---

## ✨ Features

| Feature | Description |
|---|---|
| 🔨 **Moderation** | ban, unban, kick, mute, unmute, warn, warnings, clearwarns, purge, lock, unlock, slowmode, nickname, role |
| 🎫 **Tickets** | Button panel, claim, close — transcript auto-DM'd to creator on close |
| 😴 **AFK System** | `c.afk` or `/afk` — nick changes to `[AFK] Name`, auto-removed on next message |
| ⭐ **Vouch System** | Vouch for members, view vouch counts, leaderboard |
| ↩️ **Reply Triggers** | Reply to any message with `ban`, `kick`, etc. → action taken on that person |
| 🎭 **Role Triggers** | Reply to a message with just a role name → instantly give/remove that role |
| 📢 **Say / Embed** | Send plain text or fully customizable rich embeds |
| 👋 **Welcome** | Auto embed with image support when members join |
| 📚 **Help Menu** | Dropdown menu organized by category |
| ⚡ **Dual Prefix** | `c.` / `C.` (customizable) **or** natural language `ceas <command>` |
| 🔷 **Slash Commands** | `/afk`, `/vouch`, `/vouches`, `/userinfo`, `/avatar` |

---

## 🚀 Setup

### 1. Create the Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. **New Application** → name it **Ceas** → go to **Bot** → **Add Bot**
3. Copy your **Bot Token**
4. Enable **Privileged Gateway Intents**:
   - ✅ Server Members Intent
   - ✅ Message Content Intent
   - ✅ Presence Intent
5. **OAuth2 → URL Generator** → scope: `bot` + `applications.commands` → permissions:
   - Manage Channels, Manage Roles, Manage Nicknames
   - Kick/Ban Members, Moderate Members
   - Manage Messages, Send Messages, Embed Links, Read Message History
6. Copy the invite URL and add the bot to your server

---

### 2. Configure

```bash
cp .env.example .env
```

Fill in `.env`:

```env
BOT_TOKEN=your_token_here
PREFIX=c.
GUILD_ID=your_server_id
WELCOME_CHANNEL_ID=...
LOG_CHANNEL_ID=...
TICKET_CATEGORY_ID=...
MOD_ROLE_ID=...
ADMIN_ROLE_ID=...
WELCOME_IMAGE_URL=https://example.com/banner.png
OWNER_ID=your_discord_id
```

### 3. Run

```bash
npm install
npm start
```

---

## ☁️ Deploy on Railway (24/7 Hosting — Free)

1. Push this folder to a **GitHub repo**
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub Repo**
3. Select your repo
4. Go to **Variables** tab → add all values from your `.env`
5. Done — your bot runs 24/7 automatically!

---

## 📋 Commands

### 🔨 Moderation
| Command | Usage |
|---|---|
| ban | `c.ban @user [reason]` |
| unban | `c.unban <userId> [reason]` |
| kick | `c.kick @user [reason]` |
| mute | `c.mute @user [minutes] [reason]` |
| unmute | `c.unmute @user` |
| warn | `c.warn @user [reason]` |
| warnings | `c.warnings @user` |
| clearwarns | `c.clearwarns @user` |
| purge | `c.purge <1-100> [@user]` |
| lock | `c.lock [reason]` |
| unlock | `c.unlock` |
| slowmode | `c.slowmode <seconds>` |
| nickname | `c.nickname @user <nick>` |
| role | `c.role @user <role name>` |

### ↩️ Reply Trigger System
Reply to **any message** with a command word — no need to mention the user:

```
[reply to a message] ban
[reply to a message] kick too many warnings
[reply to a message] mute 30 spamming
[reply to a message] Member        ← any role name → instantly give/remove it
```

### 😴 AFK System
```
c.afk                    ← set AFK with no reason
c.afk studying for exams ← set AFK with reason
c.afk                    ← run again to remove AFK
/afk reason:studying     ← slash command version
```
- Nickname auto-updates to `[AFK] YourName`
- AFK removed automatically when you send any message
- If someone mentions an AFK user, they get notified with reason + time

### ⭐ Vouch System
```
c.vouch @user great seller!
c.vouches @user
c.unvouch @user
c.vouchleader
/vouch user:@someone comment:trustworthy
```

### 🎫 Tickets
```
c.ticket setup     ← post the ticket panel (admin)
c.close [reason]   ← close current ticket
```
- Users click **Open Ticket** → private channel created
- Staff can **Claim** or **Close** via buttons
- On close → full transcript (all messages) DM'd to ticket creator

### 🛠️ Utility
```
c.say Hello everyone!
c.say embed Announcement | This is important!
c.embed Title | Description | #ff5500 | https://image.url
c.userinfo @user
c.serverinfo
c.avatar @user
c.ping
```

### ⚡ No-Prefix Mode
Any command works without a prefix if you start with `ceas`:
```
ceas ban @user reason
ceas help
ceas vouches @user
```

---

## 📁 Files

```
ceas-bot/
├── index.js         ← entire bot
├── package.json     ← dependencies
├── railway.json     ← Railway deploy config
├── .env.example     ← config template
├── .gitignore
└── README.md
```
