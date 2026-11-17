// Periodically checks the DOORS Wiki's "Candidates for deletion" category and
// posts newly added pages to a Discord channel.
//
// How it works:
//   1. On bot ready (and then every DELETION_CHECK_INTERVAL_MS), it asks the
//      MediaWiki API for the current members of Category:Candidates_for_deletion.
//   2. It diffs the members against a small JSON state file (gitignored).
//      Anything that was not in the previous check counts as new. The first
//      run seeds the state file silently so existing candidates are not
//      re-announced as "new".
//   3. For each new page it fetches the rendered page HTML and reads the
//      reason from `.notice-template .doorswiki-deletion-reason`.
//   4. MediaWiki formatting inside the reason (bold, italic, links, code, ...)
//      rendered as HTML is converted to Discord markdown.
//   5. One message (chunked to respect Discord's 2000 char limit) is sent to
//      DELETION_CHANNEL_ID. Mentions are disabled so wiki text cannot ping.

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const { fetch } = require("../functions/utils.js");
const { getBotName } = require("./name.js");
const {
    WIKIS,
    DELETION_CHANNEL_ID,
    DELETION_CHECK_INTERVAL_MS,
} = require("../config.js");

const CATEGORY_TITLE = "Category:Candidates_for_deletion";
const STATE_FILE = path.join(__dirname, "..", "deletion-watch-state.json");
const MAX_MESSAGE_LENGTH = 2000;

const getBotUserAgent = () => `${getBotName()} Discord bot`;

function getDefaultWiki() {
    return Object.values(WIKIS).find(wiki => wiki.default) || Object.values(WIKIS)[0];
}

// --- STATE FILE ---

function loadState() {
    try {
        const raw = fs.readFileSync(STATE_FILE, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.members)) {
            return { members: parsed.members.map(String) };
        }
    } catch (err) {
        if (err.code !== "ENOENT") {
            console.warn("deletionWatch: failed to read state file, starting fresh:", err.message);
        }
    }
    return null;
}

function saveState(members) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({ members }, null, 2));
    } catch (err) {
        console.error("deletionWatch: failed to write state file:", err.message);
    }
}

// --- WIKI API ---

async function getCategoryMembers(wikiConfig) {
    const params = new URLSearchParams({
        action: "query",
        list: "categorymembers",
        cmtitle: CATEGORY_TITLE,
        cmlimit: "500",
        format: "json",
    });

    const res = await fetch(`${wikiConfig.apiEndpoint}?${params.toString()}`, {
        headers: { "User-Agent": getBotUserAgent() },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const json = await res.json();
    return (json.query?.categorymembers || []).map(member => ({
        title: member.title,
        ns: member.ns,
    }));
}

async function getDeletionReason(pageTitle, wikiConfig) {
    const url = `${wikiConfig.articlePath}wiki/${encodeURI(pageTitle.replace(/ /g, "_"))}`;

    try {
        const res = await fetch(url, {
            headers: { "User-Agent": getBotUserAgent() },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

        const $ = cheerio.load(await res.text());
        const reasonElement = $(".notice-template .doorswiki-deletion-reason").first();
        if (!reasonElement.length) return "No reason provided.";

        return inlineHtmlToDiscord(reasonElement.html(), wikiConfig.baseUrl) || "No reason provided.";
    } catch (err) {
        console.error(`deletionWatch: failed to fetch reason for "${pageTitle}":`, err.message);
        return "Could not fetch the reason from the page.";
    }
}

// --- MARKUP CONVERSION ---
// The reason arrives HTML-rendered from wikitext. Convert the formatting we
// care about into Discord markdown and flatten everything else to text.

function inlineHtmlToDiscord(html, baseUrl) {
    if (!html) return "";
    const $ = cheerio.load(html);

    function convertNode(node) {
        if (node.type === "text") return node.data;

        const children = (node.children || []).map(convertNode).join("");
        const trimmed = children.trim();

        switch (node.name) {
            case "b":
            case "strong":
                return trimmed ? `**${trimmed}**` : "";
            case "i":
            case "em":
                return trimmed ? `*${trimmed}*` : "";
            case "code":
            case "tt":
                return trimmed ? `\`${trimmed}\`` : "";
            case "s":
            case "del":
            case "strike":
                return trimmed ? `~~${trimmed}~~` : "";
            case "br":
                return " ";
            case "a": {
                let href = $(node).attr("href") || "";
                if (href && !/^https?:\/\//i.test(href)) {
                    try {
                        href = new URL(href, baseUrl).href;
                    } catch {
                        // keep href as-is
                    }
                }
                const text = trimmed.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
                return text && href ? `[${text}](<${href}>)` : children;
            }
            default:
                return children;
        }
    }

    let text = $("body").contents().map((_, node) => convertNode(node)).get().join("");

    // Safety net: convert any literal MediaWiki bold/italic markers that reach us unparsed.
    text = text
        .replace(/'''([^']+)'''/g, "**$1**")
        .replace(/''([^']+)''/g, "*$1*");

    return text.replace(/[ \t]+/g, " ").replace(/\n\s*/g, " ").trim();
}

// --- MESSAGE FORMATTING ---

function pageUrl(title, suffix, wikiConfig) {
    const encoded = encodeURI(title.replace(/ /g, "_"));
    return `${wikiConfig.articlePath}wiki/${encoded}${suffix || ""}`;
}

function displayTitle(title, ns) {
    // Strip the namespace prefix for non-article pages (e.g. "File:Icon lighter2.png" -> "Icon lighter2.png").
    if (ns && ns !== 0) {
        const index = title.indexOf(":");
        if (index !== -1) return title.slice(index + 1);
    }
    return title;
}

function buildLine(member, reason, wikiConfig) {
    const display = displayTitle(member.title, member.ns);
    const link = `<${pageUrl(member.title, "", wikiConfig)}>`;
    const deleteLink = `<${pageUrl(member.title, "?action=delete", wikiConfig)}>`;
    return `* **[${display}](${link})** [(delete)](${deleteLink}) — ${reason}`;
}

function chunkMessages(header, lines) {
    const messages = [];
    let current = header;

    for (const rawLine of lines) {
        // Keep a single line small enough to fit after the continued-header prefix.
        const line = rawLine.length > MAX_MESSAGE_LENGTH - header.length - 40
            ? rawLine.slice(0, MAX_MESSAGE_LENGTH - header.length - 43) + "..."
            : rawLine;

        const candidate = `${current}\n${line}`;
        if (candidate.length <= MAX_MESSAGE_LENGTH) {
            current = candidate;
        } else {
            messages.push(current);
            current = `${header} (continued)\n${line}`;
        }
    }

    if (current) messages.push(current);
    return messages;
}

// --- MAIN CHECK ---

async function checkForNewCandidates(client) {
    const wikiConfig = getDefaultWiki();
    if (!wikiConfig) {
        console.error("deletionWatch: no wiki configured, skipping check.");
        return;
    }

    let members;
    try {
        members = await getCategoryMembers(wikiConfig);
    } catch (err) {
        console.error("deletionWatch: failed to fetch category members:", err.message);
        return;
    }

    const titles = members.map(member => member.title);
    const state = loadState();

    if (!state) {
        // First run: seed the state file without announcing the current backlog.
        console.log(`deletionWatch: seeded state with ${titles.length} existing candidate(s).`);
        saveState(titles);
        return;
    }

    const previous = new Set(state.members);
    const newMembers = members.filter(member => !previous.has(member.title));

    if (newMembers.length === 0) {
        saveState(titles);
        return;
    }

    const lines = [];
    for (const member of newMembers) {
        const reason = await getDeletionReason(member.title, wikiConfig);
        lines.push(buildLine(member, reason, wikiConfig));
    }

    let channel;
    try {
        channel = await client.channels.fetch(DELETION_CHANNEL_ID);
    } catch (err) {
        console.error("deletionWatch: failed to fetch channel:", err.message);
        return;
    }

    if (!channel?.isTextBased?.()) {
        console.error("deletionWatch: configured channel is missing or not text-based.");
        return;
    }

    for (const message of chunkMessages("New pages for deletion:", lines)) {
        try {
            // Wiki text is user input; never let it ping anyone.
            await channel.send({ content: message, allowedMentions: { parse: [] } });
        } catch (err) {
            console.error("deletionWatch: failed to send message:", err.message);
        }
    }

    // Save state only after the announcement was attempted so a failure retries next check.
    saveState(titles);
}

function startDeletionWatch(client) {
    if (!DELETION_CHANNEL_ID) {
        console.warn("deletionWatch: DELETION_CHANNEL_ID is not set, watcher disabled.");
        return;
    }

    const intervalMs = DELETION_CHECK_INTERVAL_MS || 5 * 60 * 1000;
    checkForNewCandidates(client);
    setInterval(() => checkForNewCandidates(client), intervalMs);
    console.log(`deletionWatch: watching ${CATEGORY_TITLE} every ${Math.round(intervalMs / 1000)}s.`);
}

module.exports = {
    startDeletionWatch,
    checkForNewCandidates,
    inlineHtmlToDiscord,
    buildLine,
    displayTitle,
    chunkMessages,
};
