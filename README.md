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
| `COMMANDS` | Enables or disables slash commands. Set a command to `false` to prevent registration. Available commands are `speedrun`, `contribs`, `wiki`, `parse`, `user`, `random`, and `tracker`. |
| `INLINE_TEXT` | Enables parsing inline wiki syntax such as `[[Page]]` and `{{Template}}`. Set it to `false` to disable those message triggers while keeping slash commands available. |
| `EMOJIS` | Optional feature emojis: `speedrun` is used on speedrun buttons and `contribs` is used in contribution score leaderboards. Leave either value empty or unset to omit that emoji. |
| `WEB_SERVER` | Starts the small status web server when `true`. Set it to `false` to disable the server; `PORT` is then not required. |
| `DELETION_CHANNEL_ID` | Channel the bot posts newly added candidates from `Category:Candidates_for_deletion` to. Accepts a text channel, or a forum channel (a dedicated "New pages for deletion" post is created/reused and notifications go there). Set to an empty value to disable the watcher. |
| `DELETION_CHECK_INTERVAL_MS` | How often the deletion watcher checks the category. The default is five minutes. |
| `DELETION_ROLE_PING` | Optional. When set (`<@&role_id>` or a bare role ID), new candidate messages include a silent `-# <@&role_id>` subtext line below the heading and are sent with notifications suppressed. Leave empty to disable. |
| `TALK_CHANNEL_ID` | Channel the bot posts newly created Talk-namespace topics to. Messages are sent through a webhook with the topic author's name and wiki profile avatar. Set to an empty value to disable the watcher. |
| `TALK_CHECK_INTERVAL_MS` | How often the talk watcher checks recent changes. The default is five minutes. |
| `STATUS_OPTIONS` | Customizes the bot’s rotating Discord status messages and activity types. |
| `STATUS_INTERVAL_MS` | Controls how often the bot rotates its status. The default is five minutes. |
| `PAGE_CACHE_MS` | Controls how long page lookups stay cached in memory. The default is 30 minutes. |
| `NOT_FOUND_DELETE_MS` | Controls how long "not found" messages stay visible before being deleted. This applies to both single and multiple page links. The default is 5 seconds. |
| `TRACKER` | Configure the Roblox tracker. Set `roleId` to the role that should be pinged, `distribution` to map Discord channel IDs to one or more Roblox universe IDs (not place IDs); an entry may also be an object such as `{ universeId: "123", ping: false }` to suppress role pings for that universe (plain string entries ping as usual). `frequency` is the visit milestone interval. `updatePingAfterMs` controls the quiet period before a single update can ping the role, while `updateBatchWindowMs` controls how updates within five minutes are compiled. `intervalMs` controls how often Roblox is checked and defaults to three minutes. |

The tracker announces visit milestones, public game updates, newly added subplaces, and subplace updates. Visit milestone and subplace update messages never ping a role. On its first launch with no tracker state, it silently records the current baselines and waits `updatePingAfterMs` before announcing new milestones or updates. Cookie-free update detection compares each place's `updated` timestamp from the public `develop.roblox.com/v2/universes/{universeId}/places` endpoint: root place changes use the regular update message, while each subplace change gets its own message without a ping. Detected bursts of updates are compiled without pinging the role, and last-seen values are stored in [`tracker/visitchecker.json`](tracker/visitchecker.json). Set `COMMANDS.tracker` to `false` to disable all tracker checks and role pings; the tracker will not start at all in that mode.

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

Without `DELETION_ROLE_PING`, the `-#` line is omitted and the message starts with `## New pages for deletion`. With a forum channel, the post is created (or reused) with this starter message:

```
This post will notify future files that are candidates for deletion.
```

Every notification then lands as a reply inside that post, keeping the forum itself tidy:

```
This post will notify future files that are candidates for deletion.

## New pages for deletion
-# <@&1570491422321148044>
* **[Icon lighter2.png](<https://doorsgame.wiki/wiki/File:Icon_lighter2.png>)** [(delete)](<https://doorsgame.wiki/wiki/File:Icon_lighter2.png?action=delete>) — Duplicate file.
```

If the check announces new candidates and some members from the previous check are still there, an extra plain message (no heading, no role ping) goes out right after the announcement(s), listing them comma-separated (files without the `File:` namespace):

```
[Icon lighter2.png](<https://doorsgame.wiki/wiki/File:Icon_lighter2.png>), [Luva skin camo.webp](<https://doorsgame.wiki/wiki/File:Luva_skin_camo.webp>) have not been deleted since the previous check.
```

Once everything is gone — the category was non-empty at the previous check and is empty now — a plain message is sent instead:

```
All pages have been deleted. Whew!
```

After every check, candidates that disappeared from the category (deleted or removed) are struck through in the previously sent messages by editing them in place — the line (or individual link in the stale reminder) is wrapped in `||~~…~~||`, keeping the `*` bullet outside:

```
* ||~~**[Icon lighter2.png](<https://doorsgame.wiki/wiki/File:Icon_lighter2.png>)** [(delete)](<https://doorsgame.wiki/wiki/File:Icon_lighter2.png?action=delete>) — Duplicate file.~~||
* **[Night Vision Scanner 3000](<https://doorsgame.wiki/wiki/Night_Vision_Scanner_3000>)** [(delete)](<https://doorsgame.wiki/wiki/Night_Vision_Scanner_3000?action=delete>)
```

Notes:

- On a fresh deployment (no state file yet), the first check is sent immediately with all current candidates; later checks run every `DELETION_CHECK_INTERVAL_MS`. Pages removed from the category and later re-added are announced again. The stale reminder only fires when the check announces something new, and covers all candidates (files and articles). The all-deleted message only fires when the previous check had members and the category is empty now — it is not sent on a fresh deployment with an empty category.
- The bot tracks the IDs of the messages it sends (stored in `deletion-watch-state.json`). On every check it edits those messages: any candidate no longer in the category is wrapped in `||~~…~~||`. Fully struck messages are dropped from tracking, and already-wrapped text is never double-wrapped.
- Messages that overflow into additional chunks carry no `-#` ping line or heading, just the extra lines. When the reason is "No reason provided", the ` — No reason provided.` suffix is omitted.
- When the role ping is configured, only that role may be mentioned (`allowedMentions: { roles: [roleId] }`); wiki text can never ping anyone.
- The reason is read from the `.notice-template .doorswiki-deletion-reason` element on each page. MediaWiki rendering (bold, italic, strikethrough, code, links) is converted to Discord markdown; anything else is flattened to plain text.
- The link text strips the namespace prefix (e.g. `File:Icon lighter2.png` shows as `Icon lighter2.png`); links themselves point at the full page.
- Mentions in wiki text are dropped so a reason can never ping a channel, and messages are chunked to stay under Discord's 2000 character limit.
- If `DELETION_CHANNEL_ID` points at a **forum channel**, the bot finds (or creates) a post titled `New pages for deletion` — with starter message `This post will notify future files that are candidates for deletion.` — and posts every notification into that post instead of the forum. The post's ID is stored in `deletion-watch-state.json` and it is also rediscovered by title if the state is lost. If the post is ever locked or archived, the bot unlocks and reopens it before posting.
- If the forum channel requires tags, the post cannot be created — the log shows `deletionWatch: failed to create forum post: A tag is required to create a forum post in this channel`. To work around this: temporarily disable tag requirements (or make tags optional) for the forum channel, restart the server/bot so the post gets created on the next check, then re-enable tag requirements — the existing post keeps working without tags.
- The bot account still needs permission to view and send messages in `DELETION_CHANNEL_ID`. Deleting the pages themselves is a manual action; the bot only links to `?action=delete`.

## Talk page watcher

`bot/talkWatch.js` watches the default wiki's Talk namespace (`Talk:`) for new topics. On startup and then every `TALK_CHECK_INTERVAL_MS` (five minutes by default), it checks recent changes for entries tagged `discussiontools-newtopic` (with a fallback to MediaWiki's standard `/* Section */ new section` summary). Replies are ignored. Processed change IDs are stored in `talk-watch-state.json` (gitignored), so each topic is announced once.

Topics are posted to `TALK_CHANNEL_ID` through a webhook, which lets each message override the bot's name and avatar with the topic author's name and wiki profile avatar. A message looks like this:

```
## Section name
hello!
-# [Reply here](<https://doorsgame.wiki/wiki/Talk:Item_Skins#Section_name>) · <t:1795737694:F>
```

Notes:

- The bot fetches the exact revision that created the topic, so replies added later are never included, even when the watcher is running behind. Only the opening post's section is read.
- The date comes from the author's signature on the post and is converted to a Discord dynamic timestamp (`<t:unix:F>`), so each viewer sees it in their own timezone. MediaWiki's `HH:MM, D Month YYYY (TZ)` format, American formats (`November 20, 2026 1:13 PM`, `11/20/2026`), and ISO-style dates are supported, including named timezones and numeric offsets such as `(UTC+2)`. When there is no signature, the revision timestamp is used instead.
- Wiki formatting (links, bold, italic) is converted to Discord markdown. Images in the post are fetched and attached with `AttachmentBuilder`: the wiki `alt=` value is used as the attachment description when present, otherwise the file name is used for both the description and `.setName()`. Up to ten images are attached.
- Wiki text cannot ping anyone (`allowedMentions: { parse: [] }`), and overlong posts are truncated to stay under Discord's 2000 character limit.
- The bot needs **Manage Webhooks** permission in `TALK_CHANNEL_ID` the first time it runs, so it can create the webhook. Its ID is saved in `talk-watch-state.json` and reused afterwards.
- If `TALK_CHANNEL_ID` is a **forum channel**, notifications go into a dedicated `Talk page watcher` post (created or reused, and reopened if locked/archived) instead of the forum itself.
- On the first run there is no state file, so every new topic currently in recent changes is announced at once. Later checks only announce topics seen after the previous check (with a one-minute overlap to avoid missing late-arriving changes).

## Web server and Instatus

`bot/server.js` starts a small web server so Instatus can check whether the bot is active. It listens on `0.0.0.0` and uses the `PORT` value from `.env` (or port `3000` when it is unset). Set `WEB_SERVER` to `false` to skip starting it; in that case, `PORT` is not required.
