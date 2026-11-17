// Copy this file to config.js and replace the example values.
// --- WIKI CONFIGURATION ---
const BOT_NAME = "";

const WIKIS = {
    "example-wiki": {
        name: "Example Wiki",
        baseUrl: "https://example.com",
        apiEndpoint: "https://example.com/w/api.php",
        articlePath: "https://example.com/",
        prefix: "example",
        default: true
    }
};

// optional: map channel or category IDs to a wiki.
const WIKI_MAP = undefined;

// Enable or disable slash commands. Disabled commands are not registered with Discord.
const COMMANDS = {
    speedrun: true,
    contribs: true,
    wiki: true,
    parse: true,
    user: true,
    random: true,
};

// Enable or disable inline wiki syntax such as [[Page]] and {{Template}}.
const INLINE_TEXT = true;

const EMOJIS = {
    speedrun: "",
    contribs: ""
};
const WEB_SERVER = true;

// Channel ID to post newly added candidates from Category:Candidates_for_deletion to.
const DELETION_CHANNEL_ID = "your_channel_id_here";
const DELETION_CHECK_INTERVAL_MS = 5 * 60 * 1000;
// Optional role shown as a silent "-# <@&role>" subtext line above new candidate messages.
// Accepts "<@&role_id>" or a bare role ID; leave empty to disable.
const DELETION_ROLE_PING = "";

const STATUS_INTERVAL_MS = 5 * 60 * 1000;
const PAGE_CACHE_MS = 30 * 60 * 1000;

// --- DISCORD STATUSES ---
const STATUS_OPTIONS = [
    { type: 4, text: "your wiki" },
];

module.exports = {
    BOT_NAME,
    WIKIS,
    WIKI_MAP: typeof WIKI_MAP !== "undefined" ? WIKI_MAP : undefined,
    COMMANDS,
    INLINE_TEXT,
    EMOJIS,
    WEB_SERVER,
    DELETION_CHANNEL_ID,
    DELETION_CHECK_INTERVAL_MS,
    DELETION_ROLE_PING,
    STATUS_INTERVAL_MS,
    PAGE_CACHE_MS,
    STATUS_OPTIONS
};
