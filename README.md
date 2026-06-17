# 🤖 Ceas Discord Bot

A fully-featured Discord bot with moderation, tickets + transcripts, AFK system, vouch system, reply-trigger system, welcome images, and an interactive dropdown help menu.

**Everything is configured inside Discord** — no need to edit `.env` for channels or roles.

---

## ✨ Features

| Feature | Description |
|---|---|
| ⚙️ **In-Discord Setup** | Configure everything with `c.setup` — no env editing needed |
| 🔨 **Moderation** | ban, unban, kick, mute, unmute, warn, warnings, clearwarns, purge, lock, unlock, slowmode, nickname, role |
| 🎫 **Tickets** | Button panel, claim, close — full transcript auto-DM'd to creator |
| 😴 **AFK System** | `c.afk` or `/afk` — nick shows `[AFK] Name`, removed on next message |
| ⭐ **Vouch System** | Vouch for members, view counts, leaderboard |
| ↩️ **Reply Triggers** | Reply to any message with `ban`, `kick`, etc. → action on that person |
| 🎭 **Role Triggers** | Reply to a message with a role name → instantly give/remove the role |
| 📢 **Say / Embed** | Send plain text or custom rich embeds |
| 👋 **Welcome** | Auto embed + optional banner image when members join |
| 📚 **Help Menu** | Dropdown organized by category |
| ⚡ **Dual Prefix** | `c.` / `C.` (changeable via setup) **or** natural `ceas <command>` |
| 🔷 **Slash Commands** | `/afk`, `/vouch`, `/vouches`, `/userinfo`, `/avatar`, `/setup` |

---

## 🚀 Setup — 3 Steps

### Step 1 — Create the bot on Discord

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. **New Application** → name it **Ceas** → go to **Bot** → **Add Bot**
3. Copy your **Bot Token**
4. Enable **Privileged Gateway Intents**:
   - ✅ Server Members Intent
   - ✅ Message Content Intent
   - ✅ Presence Intent
5. **OAuth2 → URL Generator** → scope: `bot` + `applications.commands` → permissions:
   - Manage Channels, Manage Roles, Manage Nicknames
   - Kick Members, Ban Members, Moderate Members
   - Manage Messages, Send Messages, Embed Links, Read Message History, Attach Files
6. Copy the invite URL → add the bot to your server

### Step 2 — Add your token

Copy `.env.example` to `.env` and fill in your token:

```bash
cp .env.example .env
```

```env
BOT_TOKEN=paste_your_token_here
OWNER_ID=your_discord_user_id   # optional
```

That's it for the file. Everything else is done in Discord.

### Step 3 — Configure in Discord

Once the bot is online, run:

```
c.setup
```

This shows all available options. Then configure one by one:

```
c.setup welcome   #welcome-channel
c.setup logs      #mod-logs
c.setup tickets   Tickets            ← category name
c.setup modrole   @Moderator
c.setup adminrole @Admin
c.setup prefix    !                  ← change prefix (default: c.)
c.setup welcomeimage https://i.imgur.com/example.png
```

To see your current config at any time:
```
c.setup view
```

---

## ☁️ Deploy on Railway (Free, 24/7)

1. Push this folder to a **GitHub repository**
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub Repo**
3. Select your repo
4. **Variables** tab → add `BOT_TOKEN` and optionally `OWNER_ID`
5. Deploy — bot runs 24/7, no PC needed!

> `railway.json` is already included and pre-configured.

---

## 📋 All Commands

### ⚙️ Admin / Setup
| Command | Description |
|---|---|
| `c.setup` | Show all setup options |
| `c.setup view` | Show current configuration |
| `c.setup welcome #channel` | Set welcome channel |
| `c.setup logs #channel` | Set mod log channel |
| `c.setup tickets CategoryName` | Set ticket category |
| `c.setup modrole @Role` | Set moderator role |
| `c.setup adminrole @Role` | Set admin role |
| `c.setup prefix !` | Change command prefix |
| `c.setup welcomeimage <url>` | Set welcome banner image |
| `c.setup reset` | Clear all server settings |

### 🔨 Moderation
| Command | Usage |
|---|---|
| ban | `c.ban @user [reason]` |
| unban | `c.unban <userId>` |
| kick | `c.kick @user [reason]` |
| mute | `c.mute @user [minutes] [reason]` |
| unmute | `c.unmute @user` |
| warn | `c.warn @user [reason]` |
| warnings | `c.warnings @user` |
| clearwarns | `c.clearwarns @user` |
| purge | `c.purge <1–100> [@user]` |
| lock | `c.lock [reason]` |
| unlock | `c.unlock` |
| slowmode | `c.slowmode <seconds>` |
| nickname | `c.nickname @user <nick>` |
| role | `c.role @user <role name>` |

### ↩️ Reply Trigger System
Reply to **any message** — no mention needed:
```
[reply]  ban
[reply]  kick too many warnings
[reply]  mute 30 spamming
[reply]  VIP Role        ← any role name to give/remove it
```

### 😴 AFK
```
c.afk                   ← set AFK (no reason)
c.afk brb eating        ← set AFK with reason
c.afk                   ← run again to remove AFK
/afk reason:studying    ← slash command
```

### ⭐ Vouch
```
c.vouch @user great trader!
c.vouches @user
c.unvouch @user
c.vouchleader
```

### 🎫 Tickets
```
c.ticket setup    ← post ticket panel (admin)
c.close [reason]  ← close ticket + DM transcript to creator
```

### 🛠️ Utility
```
c.say Hello!
c.say embed Title | Description
c.embed Title | Desc | #ff5500 | https://img.url
c.userinfo @user
c.serverinfo
c.avatar @user
c.ping
```

### ⚡ No-Prefix Mode
```
ceas ban @user reason
ceas help
ceas afk studying
```

---

## 📁 Files
```
ceas-bot/
├── index.js       ← entire bot
├── config.json    ← auto-created when you run c.setup (do not edit manually)
├── package.json
├── railway.json
├── .env.example
├── .gitignore
└── README.md
```

> ⚠️ Add `config.json` to `.gitignore` if you don't want settings committed to GitHub.
