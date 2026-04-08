const fs = require("fs");
const path = require("path");
const http = require("http");
const { execSync } = require("child_process");

const DLC_CODES = { ac: true };

function createLogger(onLog) {
    return message => {
        if (onLog) onLog(message);
    };
}

function getPkgInfo(pkgPath, orbisCmdPath) {
    let output = "";
    try {
        output = execSync(`"${orbisCmdPath}" img_info "${pkgPath}"`, {
            stdio: "pipe",
            timeout: 15000
        }).toString();
    } catch (err) {
        output = ((err.stdout || "").toString() + (err.stderr || "").toString());
    }

    const get = key => {
        const match = output.match(new RegExp(`${key}:\\s*(.+)`));
        return match ? match[1].trim() : null;
    };

    const category = get("Category");
    const titleId = get("Title ID");
    const contentId = get("Content ID");
    const isDlc = Boolean(category && DLC_CODES[category]);
    const identifier = isDlc ? (contentId || titleId) : titleId;

    return {
        titleId: titleId || path.basename(pkgPath, ".pkg"),
        contentId: contentId || null,
        identifier: identifier || path.basename(pkgPath, ".pkg"),
        isDlc,
        fallback: !titleId
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

function findFileRecursive(dir, filename) {
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) return full;
            if (entry.isDirectory()) {
                const match = findFileRecursive(full, filename);
                if (match) return match;
            }
        }
    } catch (_) {}
    return null;
}

function extractIcon(pkgPath, identifier, tempDir, orbisCmdPath, log) {
    const safeName = identifier.replace(/[<>:"/\\|?*]/g, "_");
    const outDir = path.join(tempDir, safeName);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const cmd = `"${orbisCmdPath}" img_extract --no_passcode "${pkgPath}:Sc0/icon0.png" "${outDir}"`;
    try {
        execSync(cmd, { stdio: "pipe", timeout: 30000 });
    } catch (err) {
        const out = ((err.stdout || "").toString() + (err.stderr || "").toString()).trim();
        if (out) log(`    ${out.split("\n")[0]}`);
    }

    return findFileRecursive(outDir, "icon0.png");
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

function validateSettings(settings) {
    if (!settings.paths?.pkgScan) throw new Error("PKG scan path is required.");
    if (!settings.paths?.covers) throw new Error("Covers path is required.");
    if (!settings.output?.path) throw new Error("JSON output path is required.");
    if (settings.httpServer?.enabled) {
        if (!settings.httpServer.address) throw new Error("HTTP server IP is required.");
        if (!settings.httpServer.port) throw new Error("HTTP server port is required.");
    } else if (!settings.serverAddress) {
        throw new Error("Server address is required when HTTP server is disabled.");
    }
    if (settings.jsonLibraryServer?.enabled) {
        if (!settings.jsonLibraryServer.address) throw new Error("JSON library IP is required.");
        if (!settings.jsonLibraryServer.port) throw new Error("JSON library port is required.");
    }
}

async function runProcessing(settings, options = {}) {
    validateSettings(settings);
    const log = createLogger(options.onLog);
    const orbisCmdPath = options.orbisCmdPath;
    if (!orbisCmdPath || !fs.existsSync(orbisCmdPath)) throw new Error("orbis-pub-cmd.exe is missing.");

    const baseDir = settings.paths.pkgScan;
    const coversDir = settings.paths.covers;
    const jsonOutputDir = settings.output.path;
    const tempDir = path.join(coversDir, "_temp");
    const serverAddress = settings.httpServer?.enabled
        ? `${settings.httpServer.address}:${settings.httpServer.port}`
        : settings.serverAddress;

    if (!fs.existsSync(baseDir)) throw new Error(`PKG scan directory not found: ${baseDir}`);

    fs.mkdirSync(coversDir, { recursive: true });
    fs.mkdirSync(jsonOutputDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });

    const { pkgList, pkgsByCategory } = collectPkgFiles(baseDir);
    if (pkgList.length === 0) {
        log("No PKG files found in any category subfolder.");
        return { totalPkgs: 0, categories: 0 };
    }

    log(`Found ${pkgList.length} PKG(s) across ${Object.keys(pkgsByCategory).length} categories`);
    log("-".repeat(55));
    log("STEP 1: Extracting Icons");

    let extracted = 0;
    let skipped = 0;
    let failed = 0;

    for (const { pkgPath, category } of pkgList) {
        log(`  Processing ${path.basename(pkgPath)}`);
        const info = getPkgInfo(pkgPath, orbisCmdPath);

        if (info.fallback) log(`     No Title ID found, using filename: ${info.identifier}`);
        else if (info.isDlc) log(`     DLC Content ID: ${info.identifier}`);
        else log(`     Title ID: ${info.titleId}`);

        const coverFolder = path.join(coversDir, category);
        if (!fs.existsSync(coverFolder)) fs.mkdirSync(coverFolder, { recursive: true });

        const outFile = path.join(coverFolder, `${info.identifier}.png`);
        if (fs.existsSync(outFile)) {
            log("     Icon already exists");
            skipped++;
            continue;
        }

        const iconPath = extractIcon(pkgPath, info.identifier, tempDir, orbisCmdPath, log);
        if (iconPath) {
            fs.copyFileSync(iconPath, outFile);
            log(`     Saved: ${outFile}`);
            extracted++;
        } else {
            log("     icon0.png not found in PKG");
            failed++;
        }

        try {
            const tempFolder = path.join(tempDir, info.identifier.replace(/[<>:"/\\|?*]/g, "_"));
            if (fs.existsSync(tempFolder)) fs.rmSync(tempFolder, { recursive: true, force: true });
        } catch (_) {}
    }

    try {
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}

    log(`Icons done. Extracted: ${extracted} | Skipped: ${skipped} | Failed: ${failed}`);
    log("-".repeat(55));
    log("STEP 2: Generating JSON Files");

    let totalProcessed = 0;

    for (const [category, pkgFiles] of Object.entries(pkgsByCategory)) {
        log(`  Category: ${category}`);
        const games = [];

        for (const pkgPath of pkgFiles) {
            log(`     Processing ${path.basename(pkgPath)}`);
            const info = getPkgInfo(pkgPath, orbisCmdPath);
            const details = extractGameDetails(pkgPath);

            if (!info.titleId && !details) {
                log("     No metadata, skipping");
                continue;
            }

            const version = details ? (() => {
                const v = parseFloat(details.VERSION) || 0;
                const a = parseFloat(details.APP_VER) || 0;
                return (v >= a ? details.VERSION : details.APP_VER) || "0.00";
            })() : "0.00";

            games.push({
                pkgPath,
                region: detectRegion(info.contentId),
                title_id: info.titleId,
                content_id: info.contentId,
                title: (details && details.TITLE) || "Unknown",
                version,
                release: getFormattedDate(pkgPath),
                size: fs.statSync(pkgPath).size.toString(),
                cover_url: findCoverImage(coversDir, serverAddress, info.titleId, info.contentId, category)
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
    return { totalPkgs: pkgList.length, categories: Object.keys(pkgsByCategory).length, extracted, skipped, failed, totalProcessed };
}

function sendResponse(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
    res.writeHead(statusCode, { "Content-Type": contentType });
    res.end(body);
}

function serveStaticFile(req, res, urlPrefix, baseDir) {
    const relativePath = decodeURIComponent(req.url.slice(urlPrefix.length)).replace(/^\/+/, "");
    const resolvedBase = path.resolve(baseDir);
    const absolutePath = path.resolve(baseDir, relativePath);

    if (!absolutePath.startsWith(resolvedBase + path.sep) && absolutePath !== resolvedBase) {
        sendResponse(res, 403, "Forbidden");
        return;
    }

    if (!fs.existsSync(absolutePath)) {
        sendResponse(res, 404, "Not found");
        return;
    }

    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory()) {
        sendResponse(res, 403, "Directory listing is disabled");
        return;
    }

    const contentTypes = {
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".pkg": "application/octet-stream"
    };
    const ext = path.extname(absolutePath).toLowerCase();

    res.writeHead(200, {
        "Content-Type": contentTypes[ext] || "application/octet-stream",
        "Content-Length": stat.size
    });

    fs.createReadStream(absolutePath).pipe(res);
}

function startHttpServer(settings, options = {}) {
    validateSettings(settings);
    if (!settings.httpServer?.enabled) return Promise.resolve(null);

    const log = createLogger(options.onLog);
    const address = settings.httpServer.address;
    const port = settings.httpServer.port;
    const pkgPath = settings.paths.pkgScan;
    const coversPath = settings.paths.covers;

    const server = http.createServer((req, res) => {
        if (!req.url) return sendResponse(res, 400, "Bad request");
        if (req.url === "/" || req.url === "") return sendResponse(res, 200, "Available paths: /pkg and /covers");
        if (req.url === "/pkg" || req.url === "/pkg/" || req.url === "/covers" || req.url === "/covers/") {
            return sendResponse(res, 403, "Directory listing is disabled");
        }
        if (req.url.startsWith("/pkg/")) return serveStaticFile(req, res, "/pkg/", pkgPath);
        if (req.url.startsWith("/covers/")) return serveStaticFile(req, res, "/covers/", coversPath);
        return sendResponse(res, 404, "Not found");
    });

    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, address, () => {
            server.removeListener("error", reject);
            log(`HTTP server running at http://${address}:${port}`);
            resolve(server);
        });
    });
}

function stopHttpServer(server, onLog) {
    const log = createLogger(onLog);
    if (!server) return Promise.resolve();

    return new Promise((resolve, reject) => {
        server.close(error => {
            if (error) return reject(error);
            log("HTTP server stopped");
            resolve();
        });
    });
}

module.exports = { runProcessing, startHttpServer, stopHttpServer, validateSettings };
