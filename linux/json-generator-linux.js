const fs = require("fs");
const path = require("path");
const readline = require("readline");
const http = require("http");

const configPath = path.join(__dirname, "json-generator-config.json");

let BASE_DIR = null;
let COVERS_DIR = null;
let JSON_OUTPUT_DIR = null;
let SERVER_ADDRESS = null;

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
            gameInfo[key] = buffer
                .slice(absoluteDataOffset, absoluteDataOffset + valueSize)
                .toString("utf8")
                .replace(/\0/g, "");
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

        if (foundOffset === null) {
            return null;
        }

        const sfoBuffer = readBytes(fd, foundOffset, 2048);
        return parseSFO(sfoBuffer);
    } catch (_) {
        return null;
    } finally {
        if (typeof fd === "number") {
            fs.closeSync(fd);
        }
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
        return {
            contentId: null,
            titleId: null
        };
    } finally {
        if (typeof fd === "number") {
            fs.closeSync(fd);
        }
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

function findCoverImage(titleId, contentId, category) {
    const extensions = [".png", ".jpg", ".jpeg"];
    const isDlcOrTheme = category === "DLC" || category === "themes";
    const primaryKey = isDlcOrTheme ? (contentId || titleId) : titleId;
    const secondaryKey = titleId;
    const allFolders = [category, "games", "apps", "updates", "DLC", "demos", "homebrew", "emulators", "themes", "PS1", "PS2", "PSP"];

    for (const ext of extensions) {
        const ownPath = path.join(COVERS_DIR, category, `${primaryKey}${ext}`);
        if (primaryKey && fs.existsSync(ownPath)) {
            return `http://${SERVER_ADDRESS}/covers/${category}/${primaryKey}${ext}`;
        }
    }

    if (isDlcOrTheme && secondaryKey && secondaryKey !== primaryKey) {
        for (const folder of allFolders.filter(f => f !== category)) {
            for (const ext of extensions) {
                const fallbackPath = path.join(COVERS_DIR, folder, `${secondaryKey}${ext}`);
                if (fs.existsSync(fallbackPath)) {
                    return `http://${SERVER_ADDRESS}/covers/${folder}/${secondaryKey}${ext}`;
                }
            }
        }
    }

    if (primaryKey) {
        for (const folder of allFolders.filter(f => f !== category)) {
            for (const ext of extensions) {
                const fallbackPath = path.join(COVERS_DIR, folder, `${primaryKey}${ext}`);
                if (fs.existsSync(fallbackPath)) {
                    return `http://${SERVER_ADDRESS}/covers/${folder}/${primaryKey}${ext}`;
                }
            }
        }
    }

    return `http://${SERVER_ADDRESS}/covers/default.png`;
}

function generateJSON(category, games) {
    const jsonFilePath = path.join(JSON_OUTPUT_DIR, `${category}.json`);
    const jsonData = { DATA: {} };

    for (const game of games) {
        const pkgUrl = `http://${SERVER_ADDRESS}/pkg/${category}/${path.basename(game.pkgPath)}`;
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
    }

    fs.writeFileSync(jsonFilePath, JSON.stringify(jsonData, null, 4));
    console.log(`    Generated: ${jsonFilePath}`);
}

function runJsonGeneration(pkgsByCategory) {
    console.log("-".repeat(55));
    console.log("STEP 1: Generating JSON Files\n");

    let totalProcessed = 0;

    for (const [category, pkgFiles] of Object.entries(pkgsByCategory)) {
        console.log(`  Category: ${category}`);
        const games = [];

        pkgFiles.forEach(pkgPath => {
            console.log(`     Processing ${path.basename(pkgPath)}`);

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
                cover_url: findCoverImage(titleId, contentId, category)
            });
            totalProcessed++;
        });

        if (games.length > 0) {
            generateJSON(category, games);
            console.log(`     ${games.length} PKG(s) -> ${category}.json\n`);
        } else {
            console.log(`     No valid PKGs in ${category}\n`);
        }
    }

    console.log(`JSON done. ${totalProcessed} PKG(s) processed\n`);
}

function collectPkgFiles() {
    const ignoredNames = ["node_modules", ".git", "covers", "_temp"];
    const pkgList = [];
    const pkgsByCategory = {};

    fs.readdirSync(BASE_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !ignoredNames.includes(entry.name) && !entry.name.startsWith("."))
        .forEach(categoryEntry => {
            const categoryPath = path.join(BASE_DIR, categoryEntry.name);
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

function startHttpServer(config) {
    const address = config.httpServer.address;
    const port = config.httpServer.port;
    const pkgPath = config.paths.pkgScan;
    const coversPath = config.paths.covers;

    console.log("Starting built-in HTTP server");
    console.log(`   Address: http://${address}:${port}`);
    console.log("   Structure:");
    console.log(`     /pkg/      -> ${pkgPath}`);
    console.log(`     /covers/   -> ${coversPath}\n`);

    const server = http.createServer((req, res) => {
        if (!req.url) {
            sendResponse(res, 400, "Bad request");
            return;
        }

        if (req.url === "/" || req.url === "") {
            sendResponse(res, 200, "Available paths: /pkg and /covers");
            return;
        }

        if (req.url === "/pkg" || req.url === "/pkg/" || req.url === "/covers" || req.url === "/covers/") {
            sendResponse(res, 403, "Directory listing is disabled");
            return;
        }

        if (req.url.startsWith("/pkg/")) {
            serveStaticFile(req, res, "/pkg/", pkgPath);
            return;
        }

        if (req.url.startsWith("/covers/")) {
            serveStaticFile(req, res, "/covers/", coversPath);
            return;
        }

        sendResponse(res, 404, "Not found");
    });

    server.on("error", err => {
        console.error(`Failed to start HTTP server: ${err.message}`);
        process.exit(1);
    });

    server.listen(port, address);
    return server;
}

async function loadOrCreateConfig() {
    if (fs.existsSync(configPath)) {
        console.log("Loading existing config...\n");
        return JSON.parse(fs.readFileSync(configPath, "utf8"));
    }

    console.log("No config found. Let's set it up.\n");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = q => new Promise(resolve => rl.question(q, resolve));

    const useHttpRaw = await question("Enable built-in HTTP server to serve files? (y/n): ");
    const useHttpServer = useHttpRaw.trim().toLowerCase() === "y";
    const pkgPath = (await question("Path to PKG files folder (e.g., /mnt/data/pkg): ")).trim();
    const coversPath = (await question("Path to Covers folder (e.g., /mnt/data/covers): ")).trim();

    let httpServerConfig = { enabled: false };
    let serverAddress = "";

    if (useHttpServer) {
        const httpAddress = await question("HTTP server bind address (e.g., 0.0.0.0): ");
        const httpPort = await question("HTTP server port (e.g., 8080): ");

        serverAddress = `${httpAddress.trim()}:${httpPort.trim()}`;
        httpServerConfig = {
            enabled: true,
            address: httpAddress.trim(),
            port: parseInt(httpPort.trim(), 10)
        };

        console.log(`\nServer URLs will use: http://${serverAddress}`);
        console.log(`   PKGs path:    ${pkgPath}`);
        console.log(`   Covers path:  ${coversPath}\n`);
    } else {
        serverAddress = (await question("Server address for generated URLs (e.g., 192.168.1.100:8080 or myhome.server): ")).trim();
    }

    const outputPath = await question("Path where JSON files should be saved (e.g., ./json): ");
    rl.close();

    const config = {
        serverAddress,
        httpServer: httpServerConfig,
        paths: {
            pkgScan: pkgPath,
            covers: coversPath
        },
        output: {
            path: outputPath.trim()
        }
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    console.log("\nConfig saved to json-generator-config.json\n");
    return config;
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

(async () => {
    console.log("JSON Generator for Linux - JSON Builder Only\n");

    const config = await loadOrCreateConfig();

    SERVER_ADDRESS = (config.httpServer && config.httpServer.enabled)
        ? `${config.httpServer.address}:${config.httpServer.port}`
        : config.serverAddress;

    BASE_DIR = config.paths.pkgScan;
    COVERS_DIR = config.paths.covers;
    JSON_OUTPUT_DIR = config.output.path;

    if (!fs.existsSync(BASE_DIR)) {
        console.error(`PKG scan directory not found: ${BASE_DIR}`);
        process.exit(1);
    }

    fs.mkdirSync(COVERS_DIR, { recursive: true });
    fs.mkdirSync(JSON_OUTPUT_DIR, { recursive: true });

    console.log(`PKG folder:   ${BASE_DIR}`);
    console.log(`Covers:       ${COVERS_DIR}`);
    console.log(`JSON Output:  ${JSON_OUTPUT_DIR}`);
    console.log(`Server URL:   http://${SERVER_ADDRESS}\n`);

    let httpProc = null;
    if (config.httpServer && config.httpServer.enabled) {
        httpProc = startHttpServer(config);
    }

    const { pkgList, pkgsByCategory } = collectPkgFiles();

    if (pkgList.length === 0) {
        console.log("No PKG files found in any category subfolder.");
        if (httpProc) console.log("\nHTTP server is still running. Press Ctrl+C to stop.");
        return;
    }

    console.log(`Found ${pkgList.length} PKG(s) across ${Object.keys(pkgsByCategory).length} category/categories\n`);

    runJsonGeneration(pkgsByCategory);

    console.log("-".repeat(55));
    console.log("All done!");
    if (httpProc) console.log("\nHTTP server is still running. Press Ctrl+C to stop.");
})();
