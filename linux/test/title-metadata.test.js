const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    CACHE_FILENAME,
    OVERRIDES_FILENAME,
    enrichGamesWithTitleMetadata,
    normalizeTitle,
    titleSimilarity
} = require("../app/title-metadata");

function jsonResponse(status, value) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => value
    };
}

function library(title = "Bloodborne™") {
    return {
        games: [{ title_id: "CUSA00900", title, package_category: "gd" }],
        updates: [{ title_id: "CUSA00900", title: `${title} Update`, package_category: "gp" }],
        DLC: [{ title_id: "CUSA00900", title: "The Old Hunters", package_category: "ac" }]
    };
}

test("normalizes titles and rejects weak matches", () => {
    assert.equal(normalizeTitle("Bloodborne™: Game of the Year"), "bloodborne game of the year");
    assert.equal(titleSimilarity("Bloodborne™", "Bloodborne"), 1);
    assert.ok(titleSimilarity("Bloodborne", "Completely Different Game") < 0.72);
});

test("fetches one base-game description and reuses it by Title ID", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "title-metadata-test-"));
    try {
        const games = library();
        const calls = [];
        const fetch = async (url, options) => {
            calls.push({ url: String(url), options });
            if (String(url).startsWith("https://id.twitch.tv/")) {
                return jsonResponse(200, { access_token: "test-token" });
            }
            return jsonResponse(200, [{
                id: 7334,
                name: "Bloodborne",
                summary: "Hunt your nightmares in the ancient city of Yharnam.",
                genres: [{ name: "Role-playing (RPG)" }],
                first_release_date: 1427068800
            }]);
        };
        const settings = {
            metadata: {
                igdb: {
                    clientId: "client-id",
                    clientSecret: "client-secret",
                    requestIntervalMs: 0
                }
            }
        };

        const first = await enrichGamesWithTitleMetadata(games, directory, settings, {
            fetch,
            now: () => Date.parse("2026-10-17T12:00:00Z")
        });
        assert.equal(first.fetched, 1);
        assert.equal(calls.length, 2);
        assert.match(calls[1].options.body, /where platforms = \(48\)/);
        for (const entries of Object.values(games)) {
            assert.equal(entries[0].description, "Hunt your nightmares in the ancient city of Yharnam.");
        }

        const cache = JSON.parse(fs.readFileSync(path.join(directory, CACHE_FILENAME), "utf8"));
        assert.equal(cache.titles.CUSA00900.sourceId, 7334);
        assert.equal(cache.titles.CUSA00900.source, "igdb");

        const cachedGames = library();
        const second = await enrichGamesWithTitleMetadata(cachedGames, directory, settings, {
            fetch: async () => { throw new Error("cache should prevent a request"); },
            now: () => Date.parse("2026-10-18T12:00:00Z")
        });
        assert.equal(second.cacheHits, 1);
        assert.equal(second.fetched, 0);
        assert.equal(cachedGames.updates[0].description, cache.titles.CUSA00900.description);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("negative results are cached and manual overrides take precedence", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "title-metadata-negative-test-"));
    try {
        const settings = {
            metadata: {
                igdb: {
                    clientId: "client-id",
                    clientSecret: "client-secret",
                    requestIntervalMs: 0,
                    negativeCacheDays: 7
                }
            }
        };
        let requests = 0;
        const fetch = async url => {
            requests++;
            if (String(url).startsWith("https://id.twitch.tv/")) {
                return jsonResponse(200, { access_token: "test-token" });
            }
            return jsonResponse(200, [{ id: 1, name: "Unrelated Racing Game", summary: "Wrong result." }]);
        };

        const first = await enrichGamesWithTitleMetadata(library(), directory, settings, {
            fetch,
            now: () => Date.parse("2026-10-17T12:00:00Z")
        });
        assert.equal(first.notFound, 1);
        assert.equal(requests, 2);

        const second = await enrichGamesWithTitleMetadata(library(), directory, settings, {
            fetch: async () => { throw new Error("negative cache should prevent a request"); },
            now: () => Date.parse("2026-10-18T12:00:00Z")
        });
        assert.equal(second.negativeHits, 1);

        fs.writeFileSync(path.join(directory, OVERRIDES_FILENAME), JSON.stringify({
            CUSA00900: "A curator-supplied description."
        }));
        const overriddenGames = library();
        const overridden = await enrichGamesWithTitleMetadata(overriddenGames, directory, {}, {
            now: () => Date.parse("2026-10-18T12:00:00Z")
        });
        assert.equal(overridden.overrides, 1);
        assert.equal(overriddenGames.games[0].description, "A curator-supplied description.");
        assert.equal(overriddenGames.DLC[0].description, "A curator-supplied description.");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
