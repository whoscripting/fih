// Periodically watches the wiki's talk namespaces (except User talk and
// Blog talk) for new topics and mirrors
// only the opening post of each topic to a Discord channel.
//
// How it works:
//   1. On bot ready (and then every TALK_CHECK_INTERVAL_MS), it asks the
//      MediaWiki API for recent changes in every talk namespace (discovered
//      from siteinfo, excluding User talk and Blog talk). Changes tagged
//      `discussiontools-newtopic` — or whose edit summary is a "new section"
//      summary — are new topics. Replies (`discussiontools-reply`) are ignored.
//   2. Processed recent-change IDs are stored in a gitignored state file, so a
//      topic is only announced once. The query overlaps the previous check by
//      a minute to cope with recent changes being inserted slightly out of order.
//      On a fresh deployment (no state file), only topics from the last 15
//      minutes are considered, so a restart does not spam old discussions.
//   3. The revision that created the topic is fetched by ID. Because parsing
//      happens at that exact revision, replies added later never leak in, even
//      if the bot is running behind.
//   4. The topic's section wikitext is converted to Discord markdown, images
//      are attached with an alt text (falling back to the file name), and the
//      signature date is converted to a Discord `<t:unix:F>` timestamp.
//   5. The message is sent through a webhook so the author's name and wiki
//      profile avatar can be used as per-message overrides.

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const { AttachmentBuilder, ChannelType } = require("discord.js");

const { fetch } = require("../functions/utils.js");
const { getUserProfile } = require("../functions/user.js");
const { getBotName } = require("./name.js");
const {
    WIKIS,
    TALK_CHANNEL_ID,
    TALK_CHECK_INTERVAL_MS,
} = require("../config.js");

// MediaWiki convention: even namespaces are subject pages, odd ones are their
// talk pages. User talk (3) and Blog talk are deliberately excluded.
const EXCLUDED_TALK_NAMESPACES = new Set([3]);
const EXCLUDED_TALK_NAMESPACE_NAMES = new Set(["blog talk"]);
const FALLBACK_TALK_NAMESPACES = [1, 5, 7, 9, 11, 13, 15];
const NAMESPACE_CACHE_MS = 60 * 60 * 1000;
let talkNamespacesCache = { ids: null, expiresAt: 0 };

const STATE_FILE = path.join(__dirname, "..", "talk-watch-state.json");
const MAX_MESSAGE_LENGTH = 2000;
const MAX_PROCESSED_IDS = 500;
const MAX_ATTACHMENTS = 10;
const OVERLAP_MS = 60 * 1000;
const FRESH_DEPLOYMENT_WINDOW_MS = 15 * 60 * 1000;
const WEBHOOK_NAME = "Talk Page Watcher (Fih bot)";
const FORUM_POST_TITLE = "Talk page watcher";
const FORUM_STARTER_MESSAGE = "New topics from the wiki's talk pages will be posted here.";

const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

const getBotUserAgent = () => `${getBotName()} Discord bot`;

function getDefaultWiki() {
    return Object.values(WIKIS).find(wiki => wiki.default) || Object.values(WIKIS)[0];
}

// --- STATE FILE ---

// { webhookId, forumThreadId, processedIds: string[], lastCheck: ISO timestamp }
// `fresh` is runtime-only (it is not saved): true when there is no usable state
// file yet, meaning the watcher should limit its first check to a short window.
function loadState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        const fresh = !(parsed && typeof parsed === "object"
            && (typeof parsed.lastCheck === "string" || Array.isArray(parsed.processedIds)));
        return {
            webhookId: parsed?.webhookId ? String(parsed.webhookId) : null,
            forumThreadId: parsed?.forumThreadId ? String(parsed.forumThreadId) : null,
            processedIds: Array.isArray(parsed?.processedIds)
                ? parsed.processedIds.map(String).slice(-MAX_PROCESSED_IDS)
                : [],
            lastCheck: typeof parsed?.lastCheck === "string" ? parsed.lastCheck : null,
            fresh,
        };
    } catch (err) {
        if (err.code !== "ENOENT") {
            console.warn("talkWatch: failed to read state file, starting fresh:", err.message);
        }
        return { webhookId: null, forumThreadId: null, processedIds: [], lastCheck: null, fresh: true };
    }
}

function saveState(state) {
    try {
        const data = {
            webhookId: state.webhookId || null,
            forumThreadId: state.forumThreadId || null,
            processedIds: (state.processedIds || []).slice(-MAX_PROCESSED_IDS),
            lastCheck: state.lastCheck || null,
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error("talkWatch: failed to write state file:", err.message);
    }
}

// --- WIKI API ---

// Discovers the wiki's talk namespaces from siteinfo so custom talk namespaces
// are included automatically. Cached for an hour; falls back to the built-ins.
async function getTalkNamespaces(wikiConfig) {
    if (talkNamespacesCache.ids && Date.now() < talkNamespacesCache.expiresAt) {
        return talkNamespacesCache.ids;
    }
    try {
        const params = new URLSearchParams({
            action: "query",
            meta: "siteinfo",
            siprop: "namespaces",
            format: "json",
        });
        const res = await fetch(`${wikiConfig.apiEndpoint}?${params.toString()}`, {
            headers: { "User-Agent": getBotUserAgent() },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const namespaces = (await res.json()).query?.namespaces || {};
        const ids = Object.values(namespaces)
            .filter(namespace => {
                const id = Number(namespace.id);
                const canonical = String(namespace.canonical || "").trim().toLowerCase();
                return Number.isInteger(id) && id > 0 && id % 2 === 1
                    && !EXCLUDED_TALK_NAMESPACES.has(id)
                    && !EXCLUDED_TALK_NAMESPACE_NAMES.has(canonical);
            })
            .map(namespace => Number(namespace.id))
            .sort((left, right) => left - right);
        if (ids.length) {
            talkNamespacesCache = { ids, expiresAt: Date.now() + NAMESPACE_CACHE_MS };
            return ids;
        }
    } catch (err) {
        console.warn("talkWatch: failed to discover talk namespaces, using defaults:", err.message);
    }
    return FALLBACK_TALK_NAMESPACES;
}

function isNewTopic(change) {
    const tags = Array.isArray(change.tags) ? change.tags : [];
    if (tags.includes("discussiontools-reply")) return false;
    if (tags.includes("discussiontools-newtopic")) return true;
    // Fallback for topics started in a plain wikitext editor: MediaWiki's
    // standard summary for those is "/* Section */ new section".
    return /\/\*[\s\S]*?\*\/\s*new section\b/i.test(String(change.comment || ""));
}

function sectionNameFromSummary(change) {
    const match = String(change.comment || "").match(/\/\*\s*([\s\S]*?)\s*\*\/\s*new section\b/i);
    if (!match) return null;
    return decodeEntities(match[1]).replace(/\s+/g, " ").trim() || null;
}

function buildRecentChangesParams(state, namespaces) {
    const ids = Array.isArray(namespaces) && namespaces.length
        ? namespaces
        : FALLBACK_TALK_NAMESPACES;
    const params = new URLSearchParams({
        action: "query",
        list: "recentchanges",
        format: "json",
        rcnamespace: ids.join("|"),
        rctype: "edit|new",
        rcprop: "title|ids|timestamp|user|comment|tags",
        rclimit: "500",
    });

    // rcstart is the LOWER bound: with rcdir=newer, MediaWiki returns changes
    // from rcstart up to now. Using rcdir=older here would walk backwards from
    // that bound into months-old history instead of the recent window.
    let startMs = Date.now() - FRESH_DEPLOYMENT_WINDOW_MS;
    if (!state.fresh) {
        const last = Date.parse(state.lastCheck);
        if (Number.isFinite(last)) startMs = last - OVERLAP_MS;
    }
    params.set("rcstart", new Date(startMs).toISOString());
    params.set("rcdir", "newer");
    return params;
}

async function getNewTopicChanges(wikiConfig, state) {
    const namespaces = await getTalkNamespaces(wikiConfig);
    const params = buildRecentChangesParams(state, namespaces);

    const res = await fetch(`${wikiConfig.apiEndpoint}?${params.toString()}`, {
        headers: { "User-Agent": getBotUserAgent() },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const json = await res.json();

    const processed = new Set(state.processedIds);
    return (json.query?.recentchanges || [])
        .filter(isNewTopic)
        .filter(change => !processed.has(String(change.rcid)))
        .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

async function getRevision(wikiConfig, revid) {
    const params = new URLSearchParams({
        action: "query",
        format: "json",
        prop: "revisions",
        revids: String(revid),
        rvprop: "content|timestamp|user",
        rvslots: "main",
    });
    const res = await fetch(`${wikiConfig.apiEndpoint}?${params.toString()}`, {
        headers: { "User-Agent": getBotUserAgent() },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const page = Object.values((await res.json()).query?.pages || {})[0];
    const revision = page?.revisions?.[0];
    if (!revision) return null;
    return {
        wikitext: revision.slots?.main?.["*"] ?? revision["*"] ?? "",
        timestamp: revision.timestamp,
        user: revision.user,
    };
}

// --- WIKITEXT PARSING ---

// Decodes the entities MediaWiki leaves in edit summaries and wikitext without
// running the text through an HTML parser, which would eat the `<url>` part of
// generated Discord markdown links.
function decodeEntities(value) {
    return String(value ?? "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&");
}

function cleanInline(value) {
    return decodeEntities(value)
        .replace(/'{2,}/g, "")
        .replace(/\[\[|\]\]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeHeading(value) {
    return cleanInline(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Returns only the wikitext of the topic's section at the revision that
// created it. Later replies are on a different revision and cannot appear here.
function extractSectionWikitext(wikitext, sectionName) {
    const wanted = normalizeHeading(sectionName);
    const rawWanted = cleanInline(sectionName).toLowerCase();
    if (!wanted && !rawWanted) return null;

    const lines = String(wikitext || "").split(/\r?\n/);
    const headings = [];
    lines.forEach((line, index) => {
        const match = line.match(/^(={2,6})\s*(.*?)\s*\1\s*$/);
        if (match) headings.push({ index, level: match[1].length, name: match[2] });
    });
    if (!headings.length) return null;

    const section = (wanted && headings.find(h => normalizeHeading(h.name) === wanted))
        || headings.find(h => cleanInline(h.name).toLowerCase() === rawWanted)
        || (wanted && headings.find(h => {
            const name = normalizeHeading(h.name);
            return name.includes(wanted) || wanted.includes(name);
        }));
    if (!section) return null;

    const next = headings.find(h => h.index > section.index && h.level <= section.level);
    return lines.slice(section.index + 1, next ? next.index : lines.length).join("\n").trim();
}

const MONTH_LOOKUP = new Map();
MONTHS.forEach((name, index) => {
    MONTH_LOOKUP.set(name.toLowerCase(), index);
    MONTH_LOOKUP.set(name.slice(0, 3).toLowerCase(), index);
});

// Offsets in minutes from UTC for common signature timezones. CST is treated
// as US Central (wiki signatures are overwhelmingly US-centric); numeric
// offsets such as (UTC+2) and (GMT-05:00) are handled separately below.
const NAMED_OFFSETS = {
    UTC: 0, GMT: 0, Z: 0,
    EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360,
    PST: -480, PDT: -420, AKST: -540, AKDT: -480, HST: -600,
    WET: 0, WEST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180,
    MSK: 180, IST: 330, JST: 540, KST: 540,
    AEST: 600, AEDT: 660, ACST: 570, ACDT: 630, NZST: 720, NZDT: 780,
};

function timezoneOffsetMinutes(token) {
    const value = String(token || "").trim().toUpperCase();
    if (!value) return 0;
    if (Object.prototype.hasOwnProperty.call(NAMED_OFFSETS, value)) return NAMED_OFFSETS[value];
    const match = value.match(/^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/);
    if (match) {
        const sign = match[1] === "-" ? -1 : 1;
        return sign * (Number(match[2]) * 60 + Number(match[3] || 0));
    }
    return 0;
}

function partsToUnix(parts, offsetMinutes) {
    if (!parts || parts.month === undefined || parts.month < 0 || parts.month > 11) return null;
    let hour = parts.hour;
    if (parts.meridiem) {
        if (parts.meridiem === "PM" && hour < 12) hour += 12;
        if (parts.meridiem === "AM" && hour === 12) hour = 0;
    }
    if (parts.day < 1 || parts.day > 31 || hour > 23 || parts.minute > 59 || parts.second > 59) return null;

    const localMs = Date.UTC(parts.year, parts.month, parts.day, hour, parts.minute, parts.second);
    const local = new Date(localMs);
    // Date.UTC rolls invalid values over (e.g. month 13), so verify the parts.
    if (local.getUTCFullYear() !== parts.year
        || local.getUTCMonth() !== parts.month
        || local.getUTCDate() !== parts.day) return null;
    return Math.floor((localMs - offsetMinutes * 60 * 1000) / 1000);
}

// Converts a wiki signature date into Unix seconds, accepting MediaWiki's
// default format as well as American and ISO-style dates. Discord renders
// `<t:unix:F>` in each viewer's own timezone, so the signature's timezone
// abbreviation/offset is applied when computing the instant.
function parseSignatureTimestamp(raw, fallback) {
    const fallbackMs = Date.parse(fallback);
    const fallbackUnix = Number.isFinite(fallbackMs) ? Math.floor(fallbackMs / 1000) : null;

    let text = String(raw || "").trim();
    if (!text) return fallbackUnix;

    let offset = 0;
    const parenthesized = text.match(/\(([^)]+)\)\s*$/);
    if (parenthesized) {
        offset = timezoneOffsetMinutes(parenthesized[1]);
        text = text.slice(0, parenthesized.index).trim();
    } else {
        const trailing = text.match(/\s+([A-Z]{2,6}|(?:UTC|GMT)[+-]\d{1,2}(?::?\d{2})?)$/i);
        if (trailing) {
            offset = timezoneOffsetMinutes(trailing[1]);
            text = text.slice(0, trailing.index).trim();
        }
    }
    text = text.replace(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?[,. ]+/i, "");
    text = text.replace(/\s+at\s+/i, " ");

    // Put time-first signatures (01:13, 20 November 2026 / 1:13 PM, November 20,
    // 2026) into date-first order so the patterns below handle both styles.
    const timeFirst = text.match(/^(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?),\s*(.+)$/i);
    if (timeFirst) text = `${timeFirst[2]} ${timeFirst[1]}`.trim();

    let parts = null;
    let m;

    // 20 November 2026, 01:13
    if (!parts) {
        m = text.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
        if (m) {
            parts = {
                year: +m[3], month: MONTH_LOOKUP.get(m[2].toLowerCase()), day: +m[1],
                hour: +m[4], minute: +m[5], second: +(m[6] || 0), meridiem: m[7]?.toUpperCase(),
            };
        }
    }

    // November 20, 2026 01:13 (American month-first)
    if (!parts) {
        m = text.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
        if (m) {
            parts = {
                year: +m[3], month: MONTH_LOOKUP.get(m[1].toLowerCase()), day: +m[2],
                hour: +m[4], minute: +m[5], second: +(m[6] || 0), meridiem: m[7]?.toUpperCase(),
            };
        }
    }

    // 11/20/2026 1:13 AM (American month-first, with a day-first guard)
    if (!parts) {
        m = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
        if (m) {
            const first = +m[1];
            const second = +m[2];
            const dayFirst = first > 12 && second <= 12;
            parts = {
                year: +m[3], month: dayFirst ? second - 1 : first - 1, day: dayFirst ? first : second,
                hour: +m[4], minute: +m[5], second: +(m[6] || 0), meridiem: m[7]?.toUpperCase(),
            };
        }
    }

    // 2026-11-20 01:13 / 2026-11-20T01:13:56
    if (!parts) {
        m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        if (m) {
            parts = {
                year: +m[1], month: +m[2] - 1, day: +m[3],
                hour: +m[4], minute: +m[5], second: +(m[6] || 0),
            };
        }
    }

    if (parts) {
        const unix = partsToUnix(parts, offset);
        if (unix !== null) return unix;
    }

    // Last resort for anything else. Parse explicitly as UTC so the result
    // does not depend on the machine running the bot, then apply any offset.
    const asUtc = Date.parse(`${text} UTC`);
    const loose = Number.isFinite(asUtc) ? asUtc : Date.parse(text);
    return Number.isFinite(loose) ? Math.floor((loose - offset * 60 * 1000) / 1000) : fallbackUnix;
}

// Signatures can use any of the formats parseSignatureTimestamp understands,
// not just MediaWiki's default. The last date-like string in the section is
// the signature; the same regexes are used globally, so each is reset first.
const SIGNATURE_DATE_PATTERNS = [
    /\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?,\s*[A-Za-z]+\s+\d{1,2},?\s+\d{4}(?:\s*\([^)]*\))?/gi,
    /\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?,\s*\d{1,2}\s+[A-Za-z]+\s+\d{4}(?:\s*\([^)]*\))?/gi,
    /\d{1,2}\s+[A-Za-z]+\s+\d{4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?(?:\s*\([^)]*\))?/gi,
    /[A-Za-z]+\s+\d{1,2},?\s+\d{4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?(?:\s*\([^)]*\))?/gi,
    /\d{1,2}[/-]\d{1,2}[/-]\d{4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?(?:\s*\([^)]*\))?/gi,
    /\d{4}-\d{1,2}-\d{1,2}[T ,]+\d{1,2}:\d{2}(?::\d{2})?Z?(?:\s*\([^)]*\))?/gi,
];

function findSignatureDate(text) {
    let best = null;
    for (const pattern of SIGNATURE_DATE_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            if (!best || match.index > best.index) {
                best = { index: match.index, value: match[0] };
            }
            if (match[0].length === 0) pattern.lastIndex += 1;
        }
    }
    return best;
}

// Splits the opening post into its body and the signature's date. The
// signature is kept in wikitext (MediaWiki expands ~~~~ on save), so any
// timezone the user chose is preserved instead of forcing UTC.
function extractSignatureAndBody(sectionWikitext, revisionTimestamp) {
    const signature = findSignatureDate(String(sectionWikitext || ""));
    const timestamp = signature ? signature.value.trim() : "";
    const unix = parseSignatureTimestamp(timestamp, revisionTimestamp);
    if (!signature) return { body: String(sectionWikitext || "").trim(), timestamp, unix };

    let cut = signature.index;
    // Cut the signature off at its user link, not just at the timestamp, so
    // nothing like `[[User:X|X]] ([[User talk:X|talk]])` survives in the body.
    // `lastIndexOf` keeps an earlier user link in the actual post intact.
    const lookback = Math.max(0, cut - 1000);
    const before = String(sectionWikitext).slice(lookback, cut).toLowerCase();
    const starts = [
        before.lastIndexOf("[[user:"),
        before.lastIndexOf("[[special:contributions/"),
        before.lastIndexOf("[[user_talk:"),
    ].filter(index => index !== -1);
    if (starts.length) cut = lookback + Math.max(...starts);

    const body = String(sectionWikitext).slice(0, cut)
        .replace(/--*\s*~~~~?\s*$/, "")
        .trim();
    return { body, timestamp, unix };
}

function wikitextToDiscord(wikitext, wikiConfig) {
    let text = String(wikitext || "");
    text = text.replace(/<!--[\s\S]*?-->/g, "");
    // Strip literal HTML before inserting Discord links: otherwise the
    // `<...>` around a URL would be mistaken for an HTML tag and removed.
    text = text.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");

    // Pull file links out first so they become Discord attachments, not links.
    const images = [];
    text = text.replace(/\[\[\s*(?:File|Image)\s*:\s*([^\]|]+)((?:\|[^\]]*)?)\]\]/gi, (_, rawName, rawParams) => {
        const fileName = String(rawName).trim();
        if (!fileName) return "";
        const params = String(rawParams).split("|").map(part => part.trim()).filter(Boolean);
        const altParam = params.find(part => /^alt\s*=/i.test(part));
        images.push({
            fileName,
            alt: altParam ? altParam.replace(/^alt\s*=\s*/i, "") : null,
        });
        return "";
    });

    text = text.replace(/\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, rawTarget, fragment, rawLabel) => {
        const page = String(rawTarget).replace(/^:/, "").trim();
        if (!page) return "";
        const parts = page.split(":").map(part => encodeURIComponent(part.trim().replace(/ /g, "_")));
        const anchor = fragment ? `#${encodeURIComponent(String(fragment).slice(1).trim().replace(/ /g, "_"))}` : "";
        const label = cleanInline(rawLabel || page);
        return label ? `[${label}](<${wikiConfig.articlePath}wiki/${parts.join(":")}${anchor}>)` : "";
    });

    text = text.replace(/\[(https?:\/\/[^\s\]]+)(?:\s+([^\]]+))?\]/g, (_, url, rawLabel) => {
        const label = cleanInline(rawLabel || url);
        return label ? `[${label}](<${url}>)` : "";
    });

    text = text
        .replace(/'''([^']+)'''/g, "**$1**")
        .replace(/''([^']+)''/g, "*$1*");

    text = decodeEntities(text);
    text = text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
    return { text, images };
}

async function buildAttachments(wikiConfig, images) {
    const files = [];
    for (const image of images.slice(0, MAX_ATTACHMENTS)) {
        const fileName = String(image.fileName).split(/[\\/]/).pop().trim();
        if (!fileName) continue;
        try {
            const params = new URLSearchParams({
                action: "query",
                format: "json",
                prop: "imageinfo",
                titles: `File:${fileName}`,
                iiprop: "url",
                iiurlwidth: "1024",
            });
            const res = await fetch(`${wikiConfig.apiEndpoint}?${params.toString()}`, {
                headers: { "User-Agent": getBotUserAgent() },
            });
            const page = Object.values((await res.json()).query?.pages || {})[0];
            const info = page?.imageinfo?.[0];
            const url = info?.thumburl || info?.url;
            if (!url) continue;

            const imageResponse = await fetch(url, { headers: { "User-Agent": getBotUserAgent() } });
            const buffer = Buffer.from(await imageResponse.arrayBuffer());
            const alt = String(image.alt || "").trim() || fileName;
            files.push(
                new AttachmentBuilder(buffer)
                    .setName(fileName)
                    .setDescription(alt)
            );
        } catch (err) {
            console.warn(`talkWatch: could not attach "${fileName}":`, err.message);
        }
    }
    return files;
}

// --- DISCORD TARGET ---

async function ensureOpen(thread) {
    try {
        if (thread.locked) await thread.setLocked(false);
        if (thread.archived) await thread.setArchived(false);
    } catch (err) {
        console.error("talkWatch: failed to unlock/open forum post:", err.message);
    }
}

async function resolveForumPost(client, forumChannel, preferredId) {
    if (preferredId) {
        try {
            const thread = await client.channels.fetch(preferredId);
            if (thread) {
                await ensureOpen(thread);
                return thread;
            }
        } catch (err) {
            console.warn("talkWatch: stored forum post not found, searching for it:", err.message);
        }
    }

    const findIn = result => {
        const collection = result?.threads ?? result;
        return collection?.find?.(thread => thread.name === FORUM_POST_TITLE) || null;
    };

    let found = null;
    try {
        found = findIn(await forumChannel.threads.fetchActive());
    } catch (err) {
        console.warn("talkWatch: failed to fetch active forum posts:", err.message);
    }
    if (!found) {
        try {
            found = findIn(await forumChannel.threads.fetchArchived({ limit: 50 }));
        } catch (err) {
            console.warn("talkWatch: failed to fetch archived forum posts:", err.message);
        }
    }
    if (found) {
        await ensureOpen(found);
        return found;
    }

    try {
        return await forumChannel.threads.create({
            name: FORUM_POST_TITLE,
            message: { content: FORUM_STARTER_MESSAGE },
        });
    } catch (err) {
        console.error("talkWatch: failed to create forum post:", err.message);
        return null;
    }
}

async function resolveTarget(client, state) {
    let channel;
    try {
        channel = await client.channels.fetch(TALK_CHANNEL_ID);
    } catch (err) {
        console.error("talkWatch: failed to fetch channel:", err.message);
        return null;
    }

    if (channel?.type === ChannelType.GuildForum) {
        const post = await resolveForumPost(client, channel, state.forumThreadId);
        if (!post) return null;
        return { channel, threadId: post.id };
    }
    return { channel, threadId: state.forumThreadId };
}

// Webhooks allow the per-message `username` / `avatarURL` overrides that a
// regular bot message cannot use. The webhook is created once and its ID is
// persisted so restarts reuse it.
async function resolveWebhook(client, channel, state) {
    if (state.webhookId) {
        try {
            const webhook = await client.fetchWebhook(state.webhookId);
            if (webhook?.channelId === channel.id) return webhook;
        } catch (err) {
            console.warn("talkWatch: stored webhook not usable, looking for another:", err.message);
        }
    }

    try {
        const existing = (await channel.fetchWebhooks()).find(webhook =>
            webhook.name === WEBHOOK_NAME
            && (webhook.applicationId === client.application?.id || webhook.owner?.id === client.user?.id)
        );
        if (existing) {
            state.webhookId = existing.id;
            return existing;
        }
    } catch (err) {
        console.warn("talkWatch: could not list channel webhooks:", err.message);
    }

    try {
        const webhook = await channel.createWebhook({
            name: WEBHOOK_NAME,
            reason: "Talk page watcher notifications",
        });
        state.webhookId = webhook.id;
        return webhook;
    } catch (err) {
        console.error("talkWatch: failed to create webhook (needs Manage Webhooks permission):", err.message);
        return null;
    }
}

// --- MESSAGE BUILDING ---

function buildMessage({ sectionName, body, unix, sectionUrl, pageLabel, talkPageUrl }) {
    const header = `## ${sectionName}\n`;
    const parts = [`[Reply here](<${sectionUrl}>)`];
    if (pageLabel && talkPageUrl) parts.push(`[${pageLabel}](<${talkPageUrl}>)`);
    if (unix) parts.push(`<t:${unix}:F>`);
    const footer = `\n-# ${parts.join(" · ")}`;
    const maxBody = Math.max(0, MAX_MESSAGE_LENGTH - header.length - footer.length - 3);
    let content = body;
    if (content.length > maxBody) {
        content = content.slice(0, maxBody).replace(/\s+\S*$/, "") + "...";
    }
    return `${header}${content}${footer}`.trim();
}

function discordUsername(name) {
    return String(name || "Anonymous").replace(/[\r\n]+/g, " ").trim().slice(0, 32) || "Anonymous";
}

function sectionUrl(pageTitle, sectionName, wikiConfig) {
    const page = encodeURI(pageTitle.replace(/ /g, "_"));
    const anchor = encodeURIComponent(sectionName.replace(/ /g, "_"));
    return `${wikiConfig.articlePath}wiki/${page}#${anchor}`;
}

function talkPageUrl(pageTitle, wikiConfig) {
    return `${wikiConfig.articlePath}wiki/${encodeURI(pageTitle.replace(/ /g, "_"))}`;
}

function displayPageName(pageTitle) {
    const title = String(pageTitle || "");
    return title.replace(/^Talk\s*:/i, "").trim() || title;
}

// --- MAIN CHECK ---

async function checkForNewTopics(client) {
    const wikiConfig = getDefaultWiki();
    if (!wikiConfig) {
        console.error("talkWatch: no wiki configured, skipping check.");
        return;
    }

    const state = loadState();
    let changes;
    try {
        changes = await getNewTopicChanges(wikiConfig, state);
    } catch (err) {
        console.error("talkWatch: failed to fetch recent changes:", err.message);
        return;
    }
    state.lastCheck = new Date().toISOString();

    if (!changes.length) {
        saveState(state);
        return;
    }

    const resolved = await resolveTarget(client, state);
    if (!resolved) {
        saveState(state); // keep Webhook/forum IDs, but allow a retry next check
        return;
    }
    const webhook = await resolveWebhook(client, resolved.channel, state);
    if (!webhook) {
        saveState(state);
        return;
    }

    for (const change of changes) {
        const sectionName = sectionNameFromSummary(change);
        if (!sectionName) continue;

        try {
            const revision = await getRevision(wikiConfig, change.revid);
            if (!revision) continue;
            const sectionWikitext = extractSectionWikitext(revision.wikitext, sectionName);
            if (sectionWikitext === null) continue;

            const { body: rawBody, unix } = extractSignatureAndBody(sectionWikitext, revision.timestamp);
            const { text, images } = wikitextToDiscord(rawBody, wikiConfig);
            const author = revision.user || change.user || "Anonymous";
            const profile = await getUserProfile(author, wikiConfig);
            const files = await buildAttachments(wikiConfig, images);

            await webhook.send({
                content: buildMessage({
                    sectionName,
                    body: text,
                    unix,
                    sectionUrl: sectionUrl(change.title, sectionName, wikiConfig),
                    pageLabel: displayPageName(change.title),
                    talkPageUrl: talkPageUrl(change.title, wikiConfig),
                }),
                username: discordUsername(author),
                ...(profile?.avatarUrl ? { avatarURL: profile.avatarUrl } : {}),
                ...(files.length ? { files } : {}),
                ...(resolved.threadId ? { threadId: resolved.threadId } : {}),
                allowedMentions: { parse: [] },
            });

            state.processedIds.push(String(change.rcid));
            state.processedIds = state.processedIds.slice(-MAX_PROCESSED_IDS);
            saveState(state);
        } catch (err) {
            // Leave the change unprocessed so the next check can retry it.
            console.error(`talkWatch: failed to post topic "${sectionName}" on ${change.title}:`, err.message);
        }
    }

    saveState(state);
}

function startTalkWatch(client) {
    if (!TALK_CHANNEL_ID) {
        console.warn("talkWatch: TALK_CHANNEL_ID is not set, watcher disabled.");
        return;
    }

    const intervalMs = TALK_CHECK_INTERVAL_MS || 5 * 60 * 1000;
    checkForNewTopics(client);
    setInterval(() => checkForNewTopics(client), intervalMs);
    console.log(`talkWatch: watching talk namespaces (except User talk and Blog talk) every ${Math.round(intervalMs / 1000)}s.`);
}

module.exports = {
    startTalkWatch,
    checkForNewTopics,
    getTalkNamespaces,
    buildRecentChangesParams,
    isNewTopic,
    sectionNameFromSummary,
    extractSectionWikitext,
    extractSignatureAndBody,
    parseSignatureTimestamp,
    wikitextToDiscord,
    buildMessage,
    displayPageName,
};
