const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { startHttpServer, stopHttpServer, validateSettings } = require("./app/processor");
const { startJsonLibraryServer, stopJsonLibraryServer } = require("./app/json-library-server");

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

function readBytes(fd, offset, length) {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, offset);
    return buf;
}

function parseSFO(buffer) {
    const keyTableOffset = buffer.readUInt32LE(8);
    const dataOffset = buffer.readUInt32LE(12);
    const numEntries = buffer.readUInt32LE(16);
    const keyTable = buffer.slice(keyTableOffset);
    const gameInfo = {};

    for (let i = 0; i < numEntries; i++) {
        const entryOffset = 20 + i * 16;
        if (entryOffset + 16 > buffer.length) continue;

        const keyOffset = buffer.readUInt16LE(entryOffset);
        const valueType = buffer.readUInt16LE(entryOffset + 2);
        const valueSize = buffer.readUInt32LE(entryOffset + 4);
        const relativeDataOffset = buffer.readUInt32LE(entryOffset + 12);
        const absoluteDataOffset = dataOffset + relativeDataOffset;

        if (keyOffset >= keyTable.length) continue;

        let keyEnd = keyTable.indexOf(0, keyOffset);
        if (keyEnd === -1) keyEnd = keyTable.length;
        const key = keyTable.slice(keyOffset, keyEnd).toString("utf8");

        if (absoluteDataOffset + valueSize > buffer.length) continue;

        if (valueType === 0x0204) {
            gameInfo[key] = buffer.slice(absoluteDataOffset, absoluteDataOffset + valueSize).toString("utf8").replace(/\0/g, "");
        } else if (valueType === 0x0404) {
            gameInfo[key] = buffer.readUInt32LE(absoluteDataOffset);
        }
    }

    return gameInfo;
}

function extractGameDetails(pkgPath) {
    let fd;

    try {
        fd = fs.openSync(pkgPath, "r");
        const fileSize = fs.statSync(pkgPath).size;
        let offset = 0;
        let foundOffset = null;

        while (offset < fileSize) {
            const buf = readBytes(fd, offset, Math.min(1048576, fileSize - offset));
            const match = buf.indexOf(Buffer.from("\x00PSF\x01\x01\x00\x00", "binary"));
            if (match !== -1) {
                foundOffset = offset + match;
                break;
            }
            offset += 1048576;
        }

        if (foundOffset === null) return null;
        return parseSFO(readBytes(fd, foundOffset, 2048));
    } catch (_) {
        return null;
    } finally {
        if (typeof fd === "number") fs.closeSync(fd);
    }
}

function readPkgMetadata(pkgPath) {
    let fd;

    try {
        fd = fs.openSync(pkgPath, "r");
        const buffer = Buffer.alloc(0x800);
        fs.readSync(fd, buffer, 0, 0x800, 0);
        const contentId = buffer.slice(0x30, 0x50).toString("utf8").replace(/\0/g, "");
        const titleIdMatch = contentId.match(/-(CUSA\d+)/);
        return {
            contentId: contentId || null,
            titleId: titleIdMatch ? titleIdMatch[1] : null
        };
    } catch (_) {
        return { contentId: null, titleId: null };
    } finally {
        if (typeof fd === "number") fs.closeSync(fd);
    }
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
                pkgsByCategory[categoryEntry.name] = pkgFiles;
                pkgFiles.forEach(pkgPath => pkgList.push({ pkgPath, category: categoryEntry.name }));
            }
        });

    return { pkgList, pkgsByCategory };
}

function findCoverImage(coversDir, serverAddress, titleId, contentId, category) {
    const extensions = [".png", ".jpg", ".jpeg"];
    const isDlcOrTheme = category === "DLC" || category === "themes";
    const primaryKey = isDlcOrTheme ? (contentId || titleId) : titleId;
    const secondaryKey = titleId;
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

function generateJSON(jsonOutputDir, serverAddress, category, games) {
    const jsonFilePath = path.join(jsonOutputDir, `${category}.json`);
    const jsonData = { DATA: {} };

    games.forEach(game => {
        const pkgUrl = `http://${serverAddress}/pkg/${category}/${path.basename(game.pkgPath)}`;
        jsonData.DATA[encodeURI(pkgUrl)] = {
            region: game.region,
            title_id: game.title_id,
            name: game.title,
            version: game.version,
            release: game.release,
            size: game.size,
            min_fw: null,
            cover_url: game.cover_url
        };
    });

    fs.writeFileSync(jsonFilePath, JSON.stringify(jsonData, null, 4));
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

async function runJsonOnly(settings) {
    validateSettings(settings);

    const baseDir = settings.paths.pkgScan;
    const coversDir = settings.paths.covers;
    const jsonOutputDir = settings.output.path;
    const serverAddress = settings.httpServer?.enabled
        ? `${settings.httpServer.address}:${settings.httpServer.port}`
        : settings.serverAddress;

    if (!fs.existsSync(baseDir)) throw new Error(`PKG scan directory not found: ${baseDir}`);

    fs.mkdirSync(coversDir, { recursive: true });
    fs.mkdirSync(jsonOutputDir, { recursive: true });

    const { pkgList, pkgsByCategory } = collectPkgFiles(baseDir);
    if (pkgList.length === 0) {
        log("No PKG files found in any category subfolder.");
        return;
    }

    log(`Found ${pkgList.length} PKG(s) across ${Object.keys(pkgsByCategory).length} categories`);
    log("-".repeat(55));
    log("STEP 1: Generating JSON Files");

    let totalProcessed = 0;

    for (const [category, pkgFiles] of Object.entries(pkgsByCategory)) {
        log(`  Category: ${category}`);
        const games = [];

        for (const pkgPath of pkgFiles) {
            log(`     Processing ${path.basename(pkgPath)}`);
            const details = extractGameDetails(pkgPath) || {};
            const pkgMeta = readPkgMetadata(pkgPath);
            const titleId = details.TITLE_ID || pkgMeta.titleId || path.basename(pkgPath, ".pkg");
            const contentId = details.CONTENT_ID || pkgMeta.contentId || null;
            const version = (() => {
                const v = parseFloat(details.VERSION) || 0;
                const a = parseFloat(details.APP_VER) || 0;
                return (v >= a ? details.VERSION : details.APP_VER) || "0.00";
            })();

            games.push({
                pkgPath,
                region: detectRegion(contentId),
                title_id: titleId,
                content_id: contentId,
                title: details.TITLE || "Unknown",
                version,
                release: getFormattedDate(pkgPath),
                size: fs.statSync(pkgPath).size.toString(),
                cover_url: findCoverImage(coversDir, serverAddress, titleId, contentId, category)
            });
            totalProcessed++;
        }

        if (games.length > 0) {
            generateJSON(jsonOutputDir, serverAddress, category, games);
            log(`     ${games.length} PKG(s) -> ${category}.json`);
        } else {
            log(`     No valid PKGs in ${category}`);
        }
    }

    log(`JSON done. ${totalProcessed} PKG(s) processed`);
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

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch(err => {
    error(err.message);
    process.exit(1);
});
