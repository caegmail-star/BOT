# CEAS Bot — Self Host on Railway

## Step 1 — Push to GitHub

1. Go to **github.com** → New repository → name it `ceas-bot` → Create
2. Open terminal and run:

```
cd bot
git init
git add .
git commit -m "ceas bot"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/ceas-bot.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your GitHub username.

---

## Step 2 — Deploy on Railway

1. Go to **railway.app** → Login with GitHub
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `ceas-bot` repo
4. Once it loads, click **Variables** tab and add:

| Key | Value |
|-----|-------|
| `BOT_TOKEN` | Your bot token from discord.com/developers |
| `OWNER_ID` | Your Discord user ID (optional) |

5. Railway will auto-deploy. Done!

---

## Bot Commands Added/Fixed

| Command | What it does |
|---------|-------------|
| `remind 10m text` | Now shows clock ⏰ + exact time it fires |
| `setticketimage <url>` | Adds an image to the ticket panel |
| `setticketimage clear` | Removes the image |
| `tickettype add Deal` | Adds a ticket category (Deal, Staff Report, Help, etc.) |
| `tickettype remove Deal` | Removes a category |
| `tickettype list` | Shows all categories |
| `botbio <text>` | Fixed to use Discord REST API directly |
| `embed Title \| Desc` | Embed color is now always black |

**Ticket panel** — if you add ticket types via `tickettype add`, the panel shows a dropdown instead of a button. The ticket button now uses the correct emoji.
