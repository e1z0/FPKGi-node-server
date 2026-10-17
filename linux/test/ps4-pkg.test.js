const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { inspectPs4Pkg, extractPs4Icon } = require("../app/ps4-pkg");
const { runJsonOnly } = require("../node-menu-linux");

function buildSfo(values) {
    const keys = [];
    const data = [];
    const records = [];
    let keySize = 0;
    let dataSize = 0;

    for (const [key, value] of values) {
        const keyBuffer = Buffer.from(`${key}\0`);
        const valueBuffer = typeof value === "number"
            ? (() => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; })()
            : Buffer.from(`${value}\0`);
        records.push({ keyOffset: keySize, dataOffset: dataSize, size: valueBuffer.length, format: typeof value === "number" ? 0x0404 : 0x0204 });
        keys.push(keyBuffer);
        data.push(valueBuffer);
        keySize += keyBuffer.length;
        dataSize += valueBuffer.length;
    }

    const keyTableOffset = 20 + records.length * 16;
    const dataTableOffset = keyTableOffset + keySize;
    const output = Buffer.alloc(dataTableOffset + dataSize);
    Buffer.from([0, 0x50, 0x53, 0x46]).copy(output);
    output.writeUInt32LE(0x00000101, 4);
    output.writeUInt32LE(keyTableOffset, 8);
    output.writeUInt32LE(dataTableOffset, 12);
    output.writeUInt32LE(records.length, 16);
    let keyCursor = keyTableOffset;
    let dataCursor = dataTableOffset;

    records.forEach((record, index) => {
        const entryOffset = 20 + index * 16;
        output.writeUInt16LE(record.keyOffset, entryOffset);
        output.writeUInt16LE(record.format, entryOffset + 2);
        output.writeUInt32LE(record.size, entryOffset + 4);
        output.writeUInt32LE(record.size, entryOffset + 8);
        output.writeUInt32LE(record.dataOffset, entryOffset + 12);
        keys[index].copy(output, keyCursor);
        data[index].copy(output, dataCursor);
        keyCursor += keys[index].length;
        dataCursor += data[index].length;
    });
    return output;
}

function buildPackage({
    encryptedIcon = false,
    badIcon = false,
    titleId = "CUSA12345",
    contentId = `UP0000-${titleId}_00-SYNTHETIC000000`,
    title = "Synthetic PS4 Game"
} = {}) {
    const sfo = buildSfo([
        ["TITLE_ID", titleId],
        ["CONTENT_ID", contentId],
        ["TITLE", title],
        ["APP_VER", "01.23"],
        ["CATEGORY", "gd"]
    ]);
    const names = Buffer.from("\0sce_sys/param.sfo\0sce_sys/icon0.png\0");
    const icon = badIcon ? Buffer.from("not-a-png") : Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    const output = Buffer.alloc(0x4000);
    output.writeUInt32BE(0x7f434e54, 0);
    output.writeUInt32BE(1, 4);
    output.writeUInt32BE(3, 0x0c);
    output.writeUInt32BE(3, 0x10);
    output.writeUInt16BE(1, 0x14);
    output.writeUInt16BE(3, 0x16);
    output.writeUInt32BE(0x1000, 0x18);
    Buffer.from(contentId).copy(output, 0x40, 0, 36);
    names.copy(output, 0x2000);
    sfo.copy(output, 0x2100);
    icon.copy(output, 0x3000);

    const entries = [
        [0x0200, 0, 0, 0, 0x2000, names.length],
        [0x1000, 1, 0, 0, 0x2100, sfo.length],
        [0x1200, 19, encryptedIcon ? 0x80000000 : 0, 0, 0x3000, icon.length]
    ];
    entries.forEach((entry, index) => {
        const offset = 0x1000 + index * 0x20;
        entry.forEach((value, field) => output.writeUInt32BE(value, offset + field * 4));
    });
    return output;
}

test("reads PS4 metadata and extracts icon0.png", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ps4-pkg-test-"));
    try {
        const pkgPath = path.join(directory, "game.pkg");
        const iconPath = path.join(directory, "covers", "CUSA12345.png");
        fs.writeFileSync(pkgPath, buildPackage());
        const pkg = inspectPs4Pkg(pkgPath);
        assert.equal(pkg.titleId, "CUSA12345");
        assert.equal(pkg.contentId, "UP0000-CUSA12345_00-SYNTHETIC000000");
        assert.equal(pkg.sfo.TITLE, "Synthetic PS4 Game");
        assert.equal(pkg.sfo.APP_VER, "01.23");
        assert.equal(pkg.isFakePackage, true);
        assert.equal(extractPs4Icon(pkg, iconPath).status, "extracted");
        assert.deepEqual(fs.readFileSync(iconPath).subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        assert.equal(extractPs4Icon(pkg, iconPath).status, "existing");
        fs.truncateSync(iconPath, 0);
        assert.equal(extractPs4Icon(pkg, iconPath, { overwrite: true }).status, "extracted");
        assert.ok(fs.statSync(iconPath).size > 8);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("refuses encrypted and invalid icon entries", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ps4-pkg-test-"));
    try {
        for (const [name, options, expected] of [
            ["encrypted", { encryptedIcon: true }, "encrypted"],
            ["invalid", { badIcon: true }, "invalid"]
        ]) {
            const pkgPath = path.join(directory, `${name}.pkg`);
            fs.writeFileSync(pkgPath, buildPackage(options));
            const result = extractPs4Icon(inspectPs4Pkg(pkgPath), path.join(directory, `${name}.png`));
            assert.equal(result.status, expected);
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("rejects non-PS4 and out-of-bounds packages", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ps4-pkg-test-"));
    try {
        const wrongPath = path.join(directory, "wrong.pkg");
        fs.writeFileSync(wrongPath, Buffer.alloc(0x100));
        assert.throws(() => inspectPs4Pkg(wrongPath), /not a PS4 CNT package/);

        const brokenPath = path.join(directory, "broken.pkg");
        const broken = buildPackage();
        broken.writeUInt32BE(0xfffffff0, 0x1000 + 16);
        fs.writeFileSync(brokenPath, broken);
        assert.throws(() => inspectPs4Pkg(brokenPath), /outside the package/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("incremental scan reuses metadata, preserves unchanged JSON, and handles changes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ps4-cache-test-"));
    try {
        const pkgsDir = path.join(directory, "pkgs");
        const gamesDir = path.join(pkgsDir, "games");
        const collectionDir = path.join(gamesDir, "my PS4 collection [A]");
        const coversDir = path.join(directory, "covers");
        const jsonDir = path.join(directory, "json");
        fs.mkdirSync(collectionDir, { recursive: true });
        const firstPkg = path.join(collectionDir, "first game.pkg");
        fs.writeFileSync(firstPkg, buildPackage());

        const settings = {
            serverAddress: "192.0.2.10:8080",
            httpServer: { enabled: true, address: "0.0.0.0", port: 8080 },
            paths: { pkgScan: pkgsDir, covers: coversDir },
            output: { path: jsonDir }
        };

        const first = await runJsonOnly(settings);
        assert.equal(first.inspected, 1);
        assert.equal(first.reused, 0);
        assert.equal(first.catalogsWritten, 1);
        assert.equal(first.iconStats.extracted, 1);

        const catalogPath = path.join(jsonDir, "games.json");
        const cachePath = path.join(jsonDir, ".fpkgi-cache-v1");
        const firstCatalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
        assert.deepEqual(Object.keys(firstCatalog.DATA), [
            "http://192.0.2.10:8080/pkg/games/my%20PS4%20collection%20%5BA%5D/first%20game.pkg"
        ]);
        const oldTime = new Date("2020-01-02T03:04:05Z");
        fs.utimesSync(catalogPath, oldTime, oldTime);
        fs.utimesSync(cachePath, oldTime, oldTime);

        const second = await runJsonOnly(settings);
        assert.equal(second.inspected, 0);
        assert.equal(second.reused, 1);
        assert.equal(second.catalogsWritten, 0);
        assert.equal(second.catalogsUnchanged, 1);
        assert.equal(second.cacheWritten, false);
        assert.equal(fs.statSync(catalogPath).mtimeMs, oldTime.getTime());
        assert.equal(fs.statSync(cachePath).mtimeMs, oldTime.getTime());

        const firstCover = path.join(coversDir, "games", "CUSA12345.png");
        fs.truncateSync(firstCover, 0);
        const repaired = await runJsonOnly(settings);
        assert.equal(repaired.inspected, 0);
        assert.equal(repaired.reused, 1);
        assert.equal(repaired.iconStats.extracted, 1);
        assert.ok(fs.statSync(firstCover).size > 8);
        assert.equal(repaired.catalogsWritten, 0);

        const secondPkg = path.join(collectionDir, "second.pkg");
        fs.writeFileSync(secondPkg, buildPackage({
            titleId: "CUSA54321",
            contentId: "EP0000-CUSA54321_00-SECONDSYNTHETIC0",
            title: "Second Synthetic Game"
        }));
        const added = await runJsonOnly(settings);
        assert.equal(added.inspected, 1);
        assert.equal(added.reused, 1);
        assert.equal(added.catalogsWritten, 1);
        assert.equal(Object.keys(JSON.parse(fs.readFileSync(catalogPath, "utf8")).DATA).length, 2);
        assert.ok(fs.existsSync(path.join(coversDir, "games", "CUSA54321.png")));

        fs.unlinkSync(secondPkg);
        const removed = await runJsonOnly(settings);
        assert.equal(removed.inspected, 0);
        assert.equal(removed.reused, 1);
        assert.equal(removed.removed, 1);
        assert.equal(removed.catalogsWritten, 1);
        assert.equal(Object.keys(JSON.parse(fs.readFileSync(catalogPath, "utf8")).DATA).length, 1);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("adds cached IGDB descriptions to generated catalogs", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ps4-description-test-"));
    try {
        const pkgsDir = path.join(directory, "pkgs");
        const gamesDir = path.join(pkgsDir, "games");
        const coversDir = path.join(directory, "covers");
        const jsonDir = path.join(directory, "json");
        fs.mkdirSync(gamesDir, { recursive: true });
        fs.writeFileSync(path.join(gamesDir, "game.pkg"), buildPackage());

        const settings = {
            serverAddress: "192.0.2.10:8080",
            httpServer: { enabled: true, address: "0.0.0.0", port: 8080 },
            paths: { pkgScan: pkgsDir, covers: coversDir },
            output: { path: jsonDir },
            metadata: {
                igdb: {
                    clientId: "client-id",
                    clientSecret: "client-secret",
                    requestIntervalMs: 0
                }
            }
        };
        const fetch = async url => String(url).startsWith("https://id.twitch.tv/")
            ? { ok: true, status: 200, json: async () => ({ access_token: "test-token" }) }
            : {
                ok: true,
                status: 200,
                json: async () => [{
                    id: 123,
                    name: "Synthetic PS4 Game",
                    summary: "A description fetched once and stored by Title ID."
                }]
            };

        const result = await runJsonOnly(settings, {
            fetch,
            now: () => Date.parse("2026-10-17T12:00:00Z")
        });
        assert.equal(result.metadataStats.fetched, 1);
        const catalog = JSON.parse(fs.readFileSync(path.join(jsonDir, "games.json"), "utf8"));
        const game = Object.values(catalog.DATA)[0];
        assert.equal(game.title_id, "CUSA12345");
        assert.equal(game.description, "A description fetched once and stored by Title ID.");
        const metadata = JSON.parse(fs.readFileSync(path.join(jsonDir, "title-metadata.json"), "utf8"));
        assert.equal(metadata.titles.CUSA12345.description, game.description);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
