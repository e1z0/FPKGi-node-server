const fs = require("fs");
const path = require("path");

const CACHE_VERSION = 1;
const CACHE_FILENAME = "title-metadata.json";
const OVERRIDES_FILENAME = "title-metadata-overrides.json";
const PS4_PLATFORM_ID = 48;
const DAY_MS = 24 * 60 * 60 * 1000;

function emptyCache() {
    return { version: CACHE_VERSION, titles: {} };
}

function normalizeTitle(value) {
    return String(value || "")
        .replace(/[™®©]/g, "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function titleSimilarity(left, right) {
    const a = normalizeTitle(left);
    const b = normalizeTitle(right);
    if (!a || !b) return 0;
    if (a === b) return 1;

    const aTokens = new Set(a.split(" "));
    const bTokens = new Set(b.split(" "));
    const intersection = [...aTokens].filter(token => bTokens.has(token)).length;
    const union = new Set([...aTokens, ...bTokens]).size;
    let score = union ? intersection / union : 0;
    if (a.startsWith(b) || b.startsWith(a)) score = Math.max(score, 0.8);
    return score;
}

function safeSearchTitle(value) {
    return String(value || "")
        .replace(/["\\\r\n\t]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
}

function loadCache(filePath, onLog) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (parsed.version !== CACHE_VERSION || !parsed.titles || typeof parsed.titles !== "object") {
            throw new Error("unsupported metadata cache format");
        }
        return parsed;
    } catch (error) {
        if (error.code !== "ENOENT") onLog(`Ignoring title metadata cache: ${error.message}`);
        return emptyCache();
    }
}

function loadOverrides(filePath, onLog) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const entries = parsed.titles && typeof parsed.titles === "object" ? parsed.titles : parsed;
        if (!entries || Array.isArray(entries) || typeof entries !== "object") {
            throw new Error("overrides must be an object keyed by Title ID");
        }
        return Object.fromEntries(Object.entries(entries).map(([titleId, value]) => [
            String(titleId).toUpperCase(),
            value
        ]));
    } catch (error) {
        if (error.code !== "ENOENT") onLog(`Ignoring title metadata overrides: ${error.message}`);
        return {};
    }
}

function writeJsonIfChanged(filePath, value) {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    try {
        if (fs.readFileSync(filePath, "utf8") === content) return false;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    const temporaryPath = `${filePath}.tmp-${process.pid}`;
    try {
        fs.writeFileSync(temporaryPath, content, { mode: 0o644 });
        fs.renameSync(temporaryPath, filePath);
    } finally {
        try { fs.unlinkSync(temporaryPath); } catch (_) {}
    }
    return true;
}

function positiveEntryIsFresh(entry, refreshDays, nowMs) {
    if (!entry || entry.status !== "found" || !entry.description) return false;
    if (refreshDays === 0) return true;
    const fetchedAt = Date.parse(entry.fetchedAt || "");
    return Number.isFinite(fetchedAt) && nowMs - fetchedAt < refreshDays * DAY_MS;
}

function negativeEntryIsFresh(entry, negativeCacheDays, nowMs) {
    if (!entry || entry.status !== "not_found") return false;
    const fetchedAt = Date.parse(entry.fetchedAt || "");
    return Number.isFinite(fetchedAt) && nowMs - fetchedAt < negativeCacheDays * DAY_MS;
}

function normalizeOverride(value) {
    if (typeof value === "string") return { description: value };
    if (!value || typeof value !== "object") return null;
    return value;
}

function descriptionForTitleId(titleId, cache, overrides) {
    const override = normalizeOverride(overrides[titleId]);
    if (override && typeof override.description === "string") {
        return override.description.trim() || null;
    }
    const cached = cache.titles[titleId];
    return cached?.status === "found" && typeof cached.description === "string"
        ? cached.description.trim() || null
        : null;
}

async function fetchWithTimeout(fetchFn, url, options, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetchFn(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

function createIgdbClient(config, options = {}) {
    const fetchFn = options.fetch || globalThis.fetch;
    if (typeof fetchFn !== "function") throw new Error("IGDB enrichment requires Node.js 18 or newer");
    const sleep = options.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const timeoutMs = config.timeoutMs || 10000;
    const requestIntervalMs = config.requestIntervalMs ?? 275;
    let accessToken = null;
    let lastRequestAt = 0;

    async function getAccessToken() {
        if (accessToken) return accessToken;
        const query = new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            grant_type: "client_credentials"
        });
        const response = await fetchWithTimeout(fetchFn, `https://id.twitch.tv/oauth2/token?${query}`, {
            method: "POST",
            headers: { Accept: "application/json" }
        }, timeoutMs);
        if (!response.ok) throw new Error(`Twitch authentication returned HTTP ${response.status}`);
        const body = await response.json();
        if (!body.access_token) throw new Error("Twitch authentication did not return an access token");
        accessToken = body.access_token;
        return accessToken;
    }

    async function lookup(title) {
        const searchTitle = safeSearchTitle(title);
        if (!searchTitle) return null;
        const waitMs = Math.max(0, requestIntervalMs - (Date.now() - lastRequestAt));
        if (waitMs) await sleep(waitMs);
        const token = await getAccessToken();
        lastRequestAt = Date.now();
        const response = await fetchWithTimeout(fetchFn, "https://api.igdb.com/v4/games", {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "text/plain",
                "Client-ID": config.clientId,
                Authorization: `Bearer ${token}`
            },
            body: `fields id,name,summary,storyline,first_release_date,genres.name; search "${searchTitle}"; where platforms = (${PS4_PLATFORM_ID}); limit 10;`
        }, timeoutMs);
        if (!response.ok) throw new Error(`IGDB returned HTTP ${response.status}`);
        const candidates = await response.json();
        if (!Array.isArray(candidates)) throw new Error("IGDB returned an invalid response");

        const ranked = candidates
            .map(game => ({ game, score: titleSimilarity(title, game.name) }))
            .filter(candidate => candidate.game && (candidate.game.summary || candidate.game.storyline))
            .sort((left, right) => right.score - left.score);
        const best = ranked[0];
        if (!best || best.score < (config.matchThreshold ?? 0.72)) return null;
        return {
            source: "igdb",
            sourceId: best.game.id,
            sourceTitle: best.game.name,
            description: String(best.game.summary || best.game.storyline).trim(),
            genres: Array.isArray(best.game.genres)
                ? best.game.genres.map(genre => genre?.name).filter(Boolean)
                : [],
            firstReleaseDate: best.game.first_release_date || null,
            matchScore: Number(best.score.toFixed(3))
        };
    }

    return { lookup };
}

function getMetadataConfig(settings = {}) {
    const configured = settings.metadata?.igdb || {};
    const clientId = configured.clientId || process.env.IGDB_CLIENT_ID || "";
    const clientSecret = configured.clientSecret || process.env.IGDB_CLIENT_SECRET || "";
    const integer = (value, fallback) => {
        const parsed = Number.parseInt(value, 10);
        return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
    };
    return {
        clientId,
        clientSecret,
        enabled: Boolean(clientId && clientSecret && configured.enabled !== false),
        refreshDays: integer(configured.refreshDays ?? process.env.IGDB_REFRESH_DAYS, 0),
        negativeCacheDays: integer(configured.negativeCacheDays ?? process.env.IGDB_NEGATIVE_CACHE_DAYS, 7),
        requestIntervalMs: integer(configured.requestIntervalMs, 275),
        timeoutMs: integer(configured.timeoutMs, 10000),
        matchThreshold: configured.matchThreshold
    };
}

function isBaseGame(game, category) {
    const packageCategory = String(game.package_category || "").toLowerCase();
    if (["gd", "gda", "gdo"].includes(packageCategory)) return true;
    return !packageCategory && ["game", "games"].includes(String(category).toLowerCase());
}

async function enrichGamesWithTitleMetadata(gamesByCategory, jsonOutputDir, settings = {}, options = {}) {
    const onLog = options.onLog || (() => {});
    const nowMs = options.now ? options.now() : Date.now();
    const config = getMetadataConfig(settings);
    const cachePath = path.join(jsonOutputDir, CACHE_FILENAME);
    const overridesPath = path.join(jsonOutputDir, OVERRIDES_FILENAME);
    const cache = loadCache(cachePath, onLog);
    const overrides = loadOverrides(overridesPath, onLog);
    const candidates = new Map();
    const stats = {
        enabled: config.enabled,
        candidates: 0,
        cacheHits: 0,
        negativeHits: 0,
        overrides: 0,
        fetched: 0,
        notFound: 0,
        failed: 0,
        cacheWritten: false
    };

    for (const [category, games] of Object.entries(gamesByCategory)) {
        for (const game of games) {
            const titleId = String(game.title_id || "").toUpperCase();
            if (!/^[A-Z]{4}\d{5}$/.test(titleId) || !isBaseGame(game, category) || candidates.has(titleId)) continue;
            candidates.set(titleId, game.title);
        }
    }
    stats.candidates = candidates.size;

    const igdb = config.enabled ? createIgdbClient(config, options) : null;
    let cacheChanged = false;

    for (const [titleId, title] of candidates) {
        const override = normalizeOverride(overrides[titleId]);
        if (override && typeof override.description === "string") {
            stats.overrides++;
            continue;
        }

        const cached = cache.titles[titleId];
        if (positiveEntryIsFresh(cached, config.refreshDays, nowMs)) {
            stats.cacheHits++;
            continue;
        }
        if (negativeEntryIsFresh(cached, config.negativeCacheDays, nowMs)) {
            stats.negativeHits++;
            continue;
        }
        if (!igdb) continue;

        try {
            const result = await igdb.lookup(title);
            const fetchedAt = new Date(nowMs).toISOString();
            if (result) {
                cache.titles[titleId] = { status: "found", queryTitle: title, fetchedAt, ...result };
                stats.fetched++;
            } else {
                cache.titles[titleId] = { status: "not_found", queryTitle: title, fetchedAt, source: "igdb" };
                stats.notFound++;
            }
            cacheChanged = true;
        } catch (error) {
            stats.failed++;
            onLog(`  IGDB lookup failed for ${titleId}: ${error.message}`);
        }
    }

    for (const games of Object.values(gamesByCategory)) {
        for (const game of games) {
            const titleId = String(game.title_id || "").toUpperCase();
            const description = descriptionForTitleId(titleId, cache, overrides);
            if (description) game.description = description;
        }
    }

    if (cacheChanged) stats.cacheWritten = writeJsonIfChanged(cachePath, cache);
    return stats;
}

module.exports = {
    CACHE_FILENAME,
    OVERRIDES_FILENAME,
    createIgdbClient,
    enrichGamesWithTitleMetadata,
    getMetadataConfig,
    normalizeTitle,
    titleSimilarity
};
