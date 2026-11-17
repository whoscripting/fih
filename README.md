<p align="center">
  <img src="https://files.catbox.moe/bbp2yn.png" width="500" alt="banner">
</p>

<h3 align="center">the all-in-one bot for <a href="https://conecorp.cc">CONECORP</a> wikis</h3>

<p align="center">
  <a href="https://discord.com/oauth2/authorize?client_id=1472272697798037524">Add to server</a>
</p>

## Setup

### Requirements

- Node.js 17.3 or newer
- A Discord application and bot token from the [Discord Developer Portal](https://discord.com/developers/applications)

### Installation

1. Clone the repository and enter its directory:

   ```bash
   git clone https://github.com/conecorpwiki/wikiguy.git
   cd wikiguy
   ```

2. Install the dependencies:

   ```bash
   npm install
   ```

3. Create your environment file from the example:

   ```bash
   cp .env.example .env
   ```

4. Open `.env` and replace `your_discord_token_here` with the bot token from the Discord Developer Portal. If `WEB_SERVER` is enabled, the web server uses port `3000` by default; set `PORT` to a different value if needed.

5. Start the bot:

   ```bash
   npm start
   ```

## Configuration

Most bot behavior is configured in [`config.js`](config.js). Restart the bot after making changes.

| Setting | Description |
| --- | --- |
| `BOT_NAME` | Optional display name. If empty or omitted, the bot’s Discord name is used. |
| `WIKIS` | Defines the supported wikis. Each entry contains the wiki name, MediaWiki API endpoint, article URL, message prefix, optional emoji, and optionally `default: true`. |
| `WIKI_MAP` | Optional map of Discord channel or category IDs to wiki keys. Without a channel/category match, the wiki marked `default: true` is used. If none is marked, the first wiki is used. |
| `COMMANDS` | Enables or disables slash commands. Set a command to `false` to prevent registration. Available commands are `speedrun`, `contribs`, `wiki`, `parse`, `user`, and `random`. |
| `INLINE_TEXT` | Enables parsing inline wiki syntax such as `[[Page]]` and `{{Template}}`. Set it to `false` to disable those message triggers while keeping slash commands available. |
| `EMOJIS` | Optional feature emojis: `speedrun` is used on speedrun buttons and `contribs` is used in contribution score leaderboards. Leave either value empty or unset to omit that emoji. |
| `WEB_SERVER` | Starts the small status web server when `true`. Set it to `false` to disable the server; `PORT` is then not required. |
| `DELETION_CHANNEL_ID` | Channel the bot posts newly added candidates from `Category:Candidates_for_deletion` to. Accepts a text channel, or a forum channel (a dedicated "New pages for deletion" post is created/reused and notifications go there). Set to an empty value to disable the watcher. |
| `DELETION_CHECK_INTERVAL_MS` | How often the deletion watcher checks the category. The default is five minutes. |
| `DELETION_ROLE_PING` | Optional. When set (`<@&role_id>` or a bare role ID), new candidate messages include a silent `-# <@&role_id>` subtext line below the heading and are sent with notifications suppressed. Leave empty to disable. |
| `STATUS_OPTIONS` | Customizes the bot’s rotating Discord status messages and activity types. |
| `STATUS_INTERVAL_MS` | Controls how often the bot rotates its status. The default is five minutes. |
| `PAGE_CACHE_MS` | Controls how long page lookups stay cached in memory. The default is 30 minutes. |

Messages can also use interwiki links configured by the channel’s wiki, such as `[[wikipedia:Chicken]]` or `[[commons:Main page]]`. The bot reads the source wiki’s MediaWiki interwiki map, verifies that the destination page exists through its API, and then creates the usual extract embed with a link to the destination wiki. Prefixes configured in `config.js` take precedence over interwiki prefixes.

`{{Name}}` expands to the page `Template:Name`, like a template transclusion. `{{:Name}}` embeds the main-namespace page `Name`, and `{{:Help:Name}}` embeds `Help:Name`. `{{Help:Name}}` also embeds `Help:Name`. Likewise, `[[User:Name]]` shows the user’s profile, while `[[User:Name/subpage]]` embeds the user subpage.

When adding a wiki, add its configuration to `WIKIS` and update `WIKI_MAP` or the relevant status messages as needed. Discord channel, category, and emoji IDs can be copied using Discord’s Developer Mode. Emoji values are optional; unset values are omitted from buttons and contribution score lists.

## Deletion watcher

`bot/deletionWatch.js` watches the default wiki's `Category:Candidates_for_deletion`. On startup and then every `DELETION_CHECK_INTERVAL_MS` (five minutes by default), it asks the MediaWiki API for the category's current members and compares them with the previous check, stored in `deletion-watch-state.json` (gitignored). Any member that wasn't present in the last check is treated as new.

New candidates are posted to the channel configured with `DELETION_CHANNEL_ID` (or its dedicated forum post — see below). With `DELETION_ROLE_PING` set, the message is sent silently (`SuppressNotifications`) and looks like this:

```
## New pages for deletion
-# <@&1570491422321148044>
* **[Icon lighter2.png](<https://doorsgame.wiki/wiki/File:Icon_lighter2.png>)** [(delete)](<https://doorsgame.wiki/wiki/File:Icon_lighter2.png?action=delete>) — Duplicate file.
```

Without `DELETION_ROLE_PING`, the `-#` line is omitted and the message starts with `## New pages for deletion`. Notes:

- On a fresh deployment (no state file yet), the first check is sent immediately with all current candidates; later checks run every `DELETION_CHECK_INTERVAL_MS`. Pages removed from the category and later re-added are announced again.
- Messages that overflow into additional chunks carry no `-#` ping line or heading, just the extra lines. When the reason is "No reason provided", the ` — No reason provided.` suffix is omitted.
- When the role ping is configured, only that role may be mentioned (`allowedMentions: { roles: [roleId] }`); wiki text can never ping anyone.
- The reason is read from the `.notice-template .doorswiki-deletion-reason` element on each page. MediaWiki rendering (bold, italic, strikethrough, code, links) is converted to Discord markdown; anything else is flattened to plain text.
- The link text strips the namespace prefix (e.g. `File:Icon lighter2.png` shows as `Icon lighter2.png`); links themselves point at the full page.
- Mentions in wiki text are dropped so a reason can never ping a channel, and messages are chunked to stay under Discord's 2000 character limit.
- If `DELETION_CHANNEL_ID` points at a **forum channel**, the bot finds (or creates) a post titled `New pages for deletion` — with starter message `This post will notify future files that are candidates for deletion.` — and posts every notification into that post instead of the forum. The post's ID is stored in `deletion-watch-state.json` and it is also rediscovered by title if the state is lost. If the post is ever locked or archived, the bot unlocks and reopens it before posting.
- The bot account still needs permission to view and send messages in `DELETION_CHANNEL_ID`. Deleting the pages themselves is a manual action; the bot only links to `?action=delete`.

## Web server and Instatus

`bot/server.js` starts a small web server so Instatus can check whether the bot is active. It listens on `0.0.0.0` and uses the `PORT` value from `.env` (or port `3000` when it is unset). Set `WEB_SERVER` to `false` to skip starting it; in that case, `PORT` is not required.
