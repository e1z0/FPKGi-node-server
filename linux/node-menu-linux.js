const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { startHttpServer, stopHttpServer, validateSettings } = require("./app/processor");
const { startJsonLibraryServer, stopJsonLibraryServer } = require("./app/json-library-server");
const { inspectPs4Pkg, extractPs4Icon } = require("./app/ps4-pkg");
const { buildPackageUrl } = require("./app/package-url");
const { enrichGamesWithTitleMetadata } = require("./app/title-metadata");

let httpServerInstance = null;
let jsonLibraryServerInstance = null;

function log(message = "") {
    process.stdout.write(`${message}\n`);
}

function error(message) {
    process.stderr.write(`${message}\n`);
}

function defaultSettings() {
    return {
        serverAddress: "localhost:8080",
        httpServer: {
            enabled: true,
            address: "localhost",
            port: 8080
        },
        jsonLibraryServer: {
            enabled: false,
            address: "localhost",
            port: 3000
        },
        paths: {
            pkgScan: "",
            covers: ""
        },
        output: {
            path: ""
        }
    };
}

function getConfigPath() {
    const argIndex = process.argv.indexOf("--config");
    if (argIndex !== -1 && process.argv[argIndex + 1]) {
        return path.resolve(process.argv[argIndex + 1]);
    }
    return path.join(process.cwd(), "node-settings-linux.json");
}

function saveSettings(settings) {
    fs.writeFileSync(getConfigPath(), JSON.stringify(settings, null, 4));
}

function loadOrCreateSettings() {
    const configPath = getConfigPath();
    const defaults = defaultSettings();

    if (!fs.existsSync(configPath)) {
        fs.writeFileSync(configPath, JSON.stringify(defaults, null, 4));
        return defaults;
    }

    const loaded = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return {
        ...defaults,
        ...loaded,
        httpServer: { ...defaults.httpServer, ...(loaded.httpServer || {}) },
        jsonLibraryServer: { ...defaults.jsonLibraryServer, ...(loaded.jsonLibraryServer || {}) },
        paths: { ...defaults.paths, ...(loaded.paths || {}) },
        output: { ...defaults.output, ...(loaded.output || {}) }
    };
}

function detectRegion(contentId) {
    if (!contentId) return "UNK";
    if (contentId.startsWith("UP")) return "USA";
    if (contentId.startsWith("EP")) return "EUR";
    if (contentId.startsWith("JP")) return "JAP";
    return "UNK";
}

function getFormattedDate(filePath) {
    const d = new Date(fs.statSync(filePath).birthtime);
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${d.getFullYear()}`;
}

function safeCoverKey(value) {
    if (!value) return null;
    const safe = String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
    return safe || null;
}

function getCoverKey(category, titleId, contentId) {
    const normalizedCategory = category.toLowerCase();
    const useContentId = normalizedCategory === "dlc" || normalizedCategory === "themes";
    return safeCoverKey(useContentId ? (contentId || titleId) : titleId);
}

function hasValidImageSignature(filePath) {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size < 8) return false;
        const fd = fs.openSync(filePath, "r");
        try {
            const signature = Buffer.alloc(8);
            if (fs.readSync(fd, signature, 0, 8, 0) !== 8) return false;
            const isPng = signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
            const isJpeg = signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
            return isPng || isJpeg;
        } finally {
            fs.closeSync(fd);
        }
    } catch (_) {
        return false;
    }
}

function getCategoryCoverState(coversDir, category, coverKey) {
    if (!coverKey) return { validPath: null, invalidPath: null };
    let invalidPath = null;
    for (const extension of [".png", ".jpg", ".jpeg"]) {
        const candidate = path.join(coversDir, category, `${coverKey}${extension}`);
        if (!fs.existsSync(candidate)) continue;
        if (hasValidImageSignature(candidate)) return { validPath: candidate, invalidPath: null };
        if (!invalidPath) invalidPath = candidate;
    }
    return { validPath: null, invalidPath };
}

function collectPkgFiles(baseDir) {
    const ignoredNames = ["node_modules", ".git", "covers", "_temp"];
    const pkgList = [];
    const pkgsByCategory = {};

    fs.readdirSync(baseDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !ignoredNames.includes(entry.name) && !entry.name.startsWith("."))
        .forEach(categoryEntry => {
            const categoryPath = path.join(baseDir, categoryEntry.name);
            const pkgFiles = [];

            fs.readdirSync(categoryPath, { withFileTypes: true }).forEach(entry => {
                const fullPath = path.join(categoryPath, entry.name);
                if (entry.isDirectory()) {
                    try {
                        fs.readdirSync(fullPath).forEach(fileName => {
                            if (fileName.toLowerCase().endsWith(".pkg")) {
                                pkgFiles.push(path.join(fullPath, fileName));
                            }
                        });
                    } catch (_) {}
                } else if (entry.name.toLowerCase().endsWith(".pkg")) {
                    pkgFiles.push(fullPath);
                }
            });

            if (pkgFiles.length > 0) {
                pkgFiles.sort((a, b) => a.localeCompare(b));
                pkgsByCategory[categoryEntry.name] = pkgFiles;
                pkgFiles.forEach(pkgPath => pkgList.push({ pkgPath, category: categoryEntry.name }));
            }
        });

    pkgList.sort((a, b) => a.pkgPath.localeCompare(b.pkgPath));
    return { pkgList, pkgsByCategory };
}

function findCoverImage(coversDir, serverAddress, titleId, contentId, category) {
    const extensions = [".png", ".jpg", ".jpeg"];
    const normalizedCategory = category.toLowerCase();
    const isDlcOrTheme = normalizedCategory === "dlc" || normalizedCategory === "themes";
    const primaryKey = safeCoverKey(isDlcOrTheme ? (contentId || titleId) : titleId);
    const secondaryKey = safeCoverKey(titleId);
    const allFolders = [category, "games", "apps", "updates", "DLC", "demos", "homebrew", "emulators", "themes", "PS1", "PS2", "PSP"];

    if (primaryKey) {
        for (const ext of extensions) {
            const ownPath = path.join(coversDir, category, `${primaryKey}${ext}`);
            if (fs.existsSync(ownPath)) {
                return `http://${serverAddress}/covers/${category}/${primaryKey}${ext}`;
            }
        }
    }

    if (isDlcOrTheme && secondaryKey && secondaryKey !== primaryKey) {
        for (const folder of allFolders.filter(f => f !== category)) {
            for (const ext of extensions) {
                const fallbackPath = path.join(coversDir, folder, `${secondaryKey}${ext}`);
                if (fs.existsSync(fallbackPath)) {
                    return `http://${serverAddress}/covers/${folder}/${secondaryKey}${ext}`;
                }
            }
        }
    }

    if (primaryKey) {
        for (const folder of allFolders.filter(f => f !== category)) {
            for (const ext of extensions) {
                const fallbackPath = path.join(coversDir, folder, `${primaryKey}${ext}`);
                if (fs.existsSync(fallbackPath)) {
                    return `http://${serverAddress}/covers/${folder}/${primaryKey}${ext}`;
                }
            }
        }
    }

    return `http://${serverAddress}/covers/default.png`;
}

function writeTextFileIfChanged(filePath, content) {
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

function generateJSON(jsonOutputDir, serverAddress, category, games, baseDir) {
    const jsonFilePath = path.join(jsonOutputDir, `${category}.json`);
    const jsonData = { DATA: {} };

    games.forEach(game => {
        const pkgUrl = buildPackageUrl(serverAddress, baseDir, game.pkgPath);
        const entry = {
            region: game.region,
            title_id: game.title_id,
            name: game.title,
            version: game.version,
            release: game.release,
            size: game.size,
            min_fw: null,
            cover_url: game.cover_url
        };
        if (game.description) entry.description = game.description;
        jsonData.DATA[pkgUrl] = entry;
    });

    return writeTextFileIfChanged(jsonFilePath, JSON.stringify(jsonData, null, 4));
}

const SCAN_CACHE_VERSION = 1;
const SCAN_CACHE_FILENAME = ".fpkgi-cache-v1";

function emptyScanCache(serverAddress) {
    return { version: SCAN_CACHE_VERSION, serverAddress, packages: {} };
}

function loadScanCache(jsonOutputDir, serverAddress) {
    const cachePath = path.join(jsonOutputDir, SCAN_CACHE_FILENAME);
    try {
        const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        if (parsed.version !== SCAN_CACHE_VERSION || !parsed.packages || typeof parsed.packages !== "object") {
            throw new Error("unsupported cache format");
        }
        return { cachePath, cache: parsed, reset: false };
    } catch (error) {
        if (error.code !== "ENOENT") log(`Ignoring scan cache: ${error.message}`);
        return { cachePath, cache: emptyScanCache(serverAddress), reset: true };
    }
}

function getPkgFingerprint(pkgPath) {
    const stat = fs.statSync(pkgPath, { bigint: true });
    return {
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString()
    };
}

function sameFingerprint(left, right) {
    return Boolean(left && right && left.size === right.size &&
        left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs);
}

function serializableIconEntry(entry) {
    if (!entry) return null;
    return { offset: entry.offset, size: entry.size, encrypted: entry.encrypted };
}

function createPrompt() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const question = prompt => new Promise(resolve => rl.question(prompt, answer => resolve(answer)));
    return { rl, question };
}

async function promptForValue(question, label, currentValue, options = {}) {
    const suffix = currentValue !== undefined && currentValue !== null && currentValue !== ""
        ? ` [${currentValue}]`
        : "";
    const answer = (await question(`${label}${suffix}: `)).trim();
    if (!answer) return currentValue;
    if (options.type === "number") return Number(answer);
    return answer;
}

function printSettings(settings) {
    log("");
    log("Current Settings");
    log("----------------");
    log(`PKG scan path: ${settings.paths.pkgScan || "(not set)"}`);
    log(`Covers path: ${settings.paths.covers || "(not set)"}`);
    log(`JSON output path: ${settings.output.path || "(not set)"}`);
    log(`HTTP server enabled: ${settings.httpServer.enabled}`);
    log(`HTTP server address: ${settings.httpServer.address}:${settings.httpServer.port}`);
    log(`Fallback server address: ${settings.serverAddress || "(not set)"}`);
    log(`JSON library enabled: ${settings.jsonLibraryServer.enabled}`);
    log(`JSON library address: ${settings.jsonLibraryServer.address}:${settings.jsonLibraryServer.port}`);
    log("");
}

async function editSettings(settings, question) {
    while (true) {
        printSettings(settings);
        log("Settings Menu");
        log("1. Change PKG scan path");
        log("2. Change covers path");
        log("3. Change JSON output path");
        log("4. Toggle HTTP server");
        log("5. Change HTTP server IP");
        log("6. Change HTTP server port");
        log("7. Change fallback server address");
        log("8. Toggle JSON library server");
        log("9. Change JSON library IP");
        log("10. Change JSON library port");
        log("11. Save and return");
        log("12. Return without saving");
        const choice = (await question("Choose an option: ")).trim();

        if (choice === "1") settings.paths.pkgScan = await promptForValue(question, "PKG scan path", settings.paths.pkgScan);
        else if (choice === "2") settings.paths.covers = await promptForValue(question, "Covers path", settings.paths.covers);
        else if (choice === "3") settings.output.path = await promptForValue(question, "JSON output path", settings.output.path);
        else if (choice === "4") settings.httpServer.enabled = !settings.httpServer.enabled;
        else if (choice === "5") settings.httpServer.address = await promptForValue(question, "HTTP server IP", settings.httpServer.address);
        else if (choice === "6") settings.httpServer.port = await promptForValue(question, "HTTP server port", settings.httpServer.port, { type: "number" });
        else if (choice === "7") settings.serverAddress = await promptForValue(question, "Fallback server address", settings.serverAddress);
        else if (choice === "8") settings.jsonLibraryServer.enabled = !settings.jsonLibraryServer.enabled;
        else if (choice === "9") settings.jsonLibraryServer.address = await promptForValue(question, "JSON library IP", settings.jsonLibraryServer.address);
        else if (choice === "10") settings.jsonLibraryServer.port = await promptForValue(question, "JSON library port", settings.jsonLibraryServer.port, { type: "number" });
        else if (choice === "11") {
            validateSettings(settings);
            saveSettings(settings);
            log(`Settings saved to ${getConfigPath()}`);
            return settings;
        } else if (choice === "12") {
            return null;
        } else {
            log("Invalid option.");
        }
    }
}

async function startServers(settings) {
    if (settings.httpServer?.enabled && !httpServerInstance) {
        httpServerInstance = await startHttpServer(settings, { onLog: log });
    }
    if (settings.jsonLibraryServer?.enabled && !jsonLibraryServerInstance) {
        jsonLibraryServerInstance = await startJsonLibraryServer(settings, { onLog: log });
    }
}

function getRunningServersSummary(settings) {
    const active = [];

    if (httpServerInstance && settings.httpServer?.enabled) {
        active.push(`HTTP Server: http://${settings.httpServer.address}:${settings.httpServer.port}`);
    }

    if (jsonLibraryServerInstance && settings.jsonLibraryServer?.enabled) {
        active.push(`JSON Library: http://${settings.jsonLibraryServer.address}:${settings.jsonLibraryServer.port}/`);
    }

    return active.length > 0 ? active : ["No servers currently running"];
}

async function stopServers() {
    if (jsonLibraryServerInstance) {
        await stopJsonLibraryServer(jsonLibraryServerInstance, log);
        jsonLibraryServerInstance = null;
    }
    if (httpServerInstance) {
        await stopHttpServer(httpServerInstance, log);
        httpServerInstance = null;
    }
}

async function runJsonOnly(settings, options = {}) {
    validateSettings(settings);

    const baseDir = settings.paths.pkgScan;
    const coversDir = settings.paths.covers;
    const jsonOutputDir = settings.output.path;
    // The address clients use can differ from the interface the HTTP server
    // listens on (for example, when running behind a Docker port mapping).
    const serverAddress = settings.serverAddress ||
        `${settings.httpServer.address}:${settings.httpServer.port}`;

    if (!fs.existsSync(baseDir)) throw new Error(`PKG scan directory not found: ${baseDir}`);

    fs.mkdirSync(coversDir, { recursive: true });
    fs.mkdirSync(jsonOutputDir, { recursive: true });

    const { pkgList, pkgsByCategory } = collectPkgFiles(baseDir);
    const { cachePath, cache: previousCache, reset: cacheReset } = loadScanCache(jsonOutputDir, serverAddress);
    const nextCache = emptyScanCache(serverAddress);
    const gamesByCategory = {};
    const currentKeys = new Set();
    const previousCategories = new Set(Object.values(previousCache.packages)
        .map(entry => entry && entry.category)
        .filter(Boolean));

    log(`Found ${pkgList.length} PKG(s) across ${Object.keys(pkgsByCategory).length} categories`);
    log("-".repeat(55));
    log("STEP 1: Updating PS4 metadata cache and icons");

    let totalProcessed = 0;
    let inspected = 0;
    let reused = 0;
    let removed = 0;
    const iconStats = { extracted: 0, existing: 0, missing: 0, encrypted: 0, invalid: 0, failed: 0 };

    for (const { pkgPath, category } of pkgList) {
        const relativePath = path.relative(baseDir, pkgPath).split(path.sep).join("/");
        currentKeys.add(relativePath);
        let fingerprint;
        try {
            fingerprint = getPkgFingerprint(pkgPath);
        } catch (err) {
            iconStats.failed++;
            log(`  Could not stat ${relativePath}: ${err.message}`);
            continue;
        }

        const previous = previousCache.packages[relativePath];
        const cacheHit = !cacheReset && previous && previous.category === category &&
            sameFingerprint(previous.fingerprint, fingerprint);
        let cached;

        if (cacheHit) {
            reused++;
            cached = { ...previous, fingerprint };
            if (cached.error) {
                iconStats.failed++;
                nextCache.packages[relativePath] = cached;
                continue;
            }
        } else {
            inspected++;
            log(`  Inspecting ${relativePath}`);
            let pkg;
            try {
                pkg = inspectPs4Pkg(pkgPath);
            } catch (err) {
                iconStats.failed++;
                log(`    Skipping invalid PS4 PKG: ${err.message}`);
                nextCache.packages[relativePath] = {
                    fingerprint,
                    category,
                    error: err.message
                };
                continue;
            }

            const details = pkg.sfo || {};
            const titleId = details.TITLE_ID || pkg.titleId || path.basename(pkgPath, ".pkg");
            const contentId = details.CONTENT_ID || pkg.contentId || null;
            const version = (() => {
                const v = parseFloat(details.VERSION) || 0;
                const a = parseFloat(details.APP_VER) || 0;
                return (v >= a ? details.VERSION : details.APP_VER) || "0.00";
            })();

            cached = {
                fingerprint,
                category,
                titleId,
                contentId,
                packageCategory: details.CATEGORY || null,
                iconEntry: serializableIconEntry(pkg.iconEntry),
                game: {
                    region: detectRegion(contentId),
                    title_id: titleId,
                    content_id: contentId,
                    title: details.TITLE || "Unknown",
                    version,
                    release: getFormattedDate(pkgPath),
                    size: fingerprint.size
                }
            };
        }

        const coverKey = getCoverKey(category, cached.titleId, cached.contentId);
        const coverState = getCategoryCoverState(coversDir, category, coverKey);
        let iconResult = { status: "missing" };
        if (coverKey) {
            try {
                iconResult = coverState.validPath
                    ? { status: "existing", path: coverState.validPath }
                    : extractPs4Icon({ path: pkgPath, iconEntry: cached.iconEntry }, path.join(coversDir, category, `${coverKey}.png`), {
                        overwrite: Boolean(coverState.invalidPath)
                    });
            } catch (err) {
                iconResult = { status: "failed", reason: err.message };
            }
        }
        iconStats[iconResult.status] = (iconStats[iconResult.status] || 0) + 1;
        if (iconResult.status === "extracted") {
            log(`    Extracted icon: ${path.relative(coversDir, iconResult.path)}`);
        } else if (["encrypted", "invalid", "failed"].includes(iconResult.status) && !cacheHit) {
            log(`    Icon ${iconResult.status}${iconResult.reason ? `: ${iconResult.reason}` : ""}`);
        }

        cached.coverUrl = findCoverImage(coversDir, serverAddress, cached.titleId, cached.contentId, category);
        nextCache.packages[relativePath] = cached;
        if (!gamesByCategory[category]) gamesByCategory[category] = [];
        gamesByCategory[category].push({
            pkgPath,
            ...cached.game,
            package_category: cached.packageCategory || null,
            cover_url: cached.coverUrl
        });
        totalProcessed++;
    }

    for (const [relativePath, previous] of Object.entries(previousCache.packages)) {
        if (!currentKeys.has(relativePath)) {
            removed++;
            if (previous?.category) previousCategories.add(previous.category);
        }
    }

    const metadataStats = await enrichGamesWithTitleMetadata(gamesByCategory, jsonOutputDir, settings, {
        fetch: options.fetch,
        sleep: options.sleep,
        now: options.now,
        onLog: log
    });

    let catalogsWritten = 0;
    let catalogsUnchanged = 0;
    const currentCategories = new Set(Object.keys(gamesByCategory));
    for (const category of [...currentCategories].sort()) {
        const games = gamesByCategory[category];
        if (generateJSON(jsonOutputDir, serverAddress, category, games, baseDir)) {
            catalogsWritten++;
            log(`  Updated ${category}.json (${games.length} PKG(s))`);
        } else {
            catalogsUnchanged++;
            log(`  Unchanged ${category}.json (${games.length} PKG(s))`);
        }
    }

    for (const category of previousCategories) {
        if (currentCategories.has(category)) continue;
        const stalePath = path.join(jsonOutputDir, `${category}.json`);
        try {
            fs.unlinkSync(stalePath);
            catalogsWritten++;
            log(`  Removed stale ${category}.json`);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }

    const cacheWritten = writeTextFileIfChanged(cachePath, `${JSON.stringify(nextCache, null, 2)}\n`);
    log(`Cache done. Inspected: ${inspected} | Reused: ${reused} | Removed: ${removed} | Manifest: ${cacheWritten ? "updated" : "unchanged"}`);
    log(`Icons done. Extracted: ${iconStats.extracted} | Existing: ${iconStats.existing} | Missing: ${iconStats.missing} | Encrypted: ${iconStats.encrypted} | Invalid/failed: ${iconStats.invalid + iconStats.failed}`);
    if (metadataStats.enabled || metadataStats.cacheHits || metadataStats.overrides) {
        log(`Descriptions done. Fetched: ${metadataStats.fetched} | Cached: ${metadataStats.cacheHits} | Overrides: ${metadataStats.overrides} | Not found/cached: ${metadataStats.notFound + metadataStats.negativeHits} | Failed: ${metadataStats.failed}`);
    } else if (metadataStats.candidates > 0) {
        log("Descriptions disabled. Set IGDB_CLIENT_ID and IGDB_CLIENT_SECRET to enable fetching.");
    }
    log(`JSON done. ${catalogsWritten} updated | ${catalogsUnchanged} unchanged | ${totalProcessed} PKG(s)`);
    return { totalProcessed, inspected, reused, removed, catalogsWritten, catalogsUnchanged, cacheWritten, iconStats, metadataStats };
}

async function main() {
    const prompt = createPrompt();
    let settings = loadOrCreateSettings();
    saveSettings(settings);
    await startServers(settings);

    try {
        while (true) {
            log("");
            log("FPKGi Node Server Linux");
            log("----------------------");
            log(`Config: ${getConfigPath()}`);
            log("Running servers:");
            getRunningServersSummary(settings).forEach(line => log(`- ${line}`));
            log("1. Generate JSON");
            log("2. Edit settings");
            log("3. Start servers");
            log("4. Generate JSON and keep servers running");
            log("5. Stop running servers");
            log("6. Show current settings");
            log("7. Exit");

            const choice = (await prompt.question("Choose an option: ")).trim();

            try {
                if (choice === "1") {
                    await runJsonOnly(settings);
                } else if (choice === "2") {
                    const updated = await editSettings(JSON.parse(JSON.stringify(settings)), prompt.question);
                    if (updated) {
                        settings = loadOrCreateSettings();
                        await stopServers();
                        await startServers(settings);
                    }
                } else if (choice === "3") {
                    validateSettings(settings);
                    await startServers(settings);
                    log("Servers are running in this session.");
                } else if (choice === "4") {
                    validateSettings(settings);
                    await startServers(settings);
                    await runJsonOnly(settings);
                    log("JSON generation complete. Servers are still running.");
                } else if (choice === "5") {
                    await stopServers();
                    log("Servers stopped.");
                } else if (choice === "6") {
                    printSettings(settings);
                } else if (choice === "7") {
                    await stopServers();
                    break;
                } else {
                    log("Invalid option.");
                }
            } catch (err) {
                error(`Error: ${err.message}`);
            }
        }
    } finally {
        prompt.rl.close();
    }
}

async function shutdown() {
    try {
        await stopServers();
    } catch (err) {
        error(`Shutdown error: ${err.message}`);
    } finally {
        process.exit(0);
    }
}

if (require.main === module) {
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    main().catch(err => {
        error(err.message);
        process.exit(1);
    });
}

module.exports = { runJsonOnly };
