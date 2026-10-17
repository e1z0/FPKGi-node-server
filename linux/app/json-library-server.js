const fs = require("fs");
const path = require("path");
const http = require("http");
const zlib = require("zlib");

const INTERNAL_JSON_FILES = new Set([
    "title-metadata.json",
    "title-metadata-overrides.json"
]);

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
    res.writeHead(status, { "Content-Type": contentType });
    res.end(body);
}

function getBackgroundFilePath(coversDir) {
    const extensions = [".png", ".bmp", ".jpg", ".jpeg"];
    for (const ext of extensions) {
        const filePath = path.join(coversDir, `background${ext}`);
        if (fs.existsSync(filePath)) {
            return filePath;
        }
    }
    return null;
}

function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (let i = 0; i < buffer.length; i++) {
        crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const typeBuffer = Buffer.from(type, "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);

    const crcInput = Buffer.concat([typeBuffer, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcInput), 0);

    return Buffer.concat([length, typeBuffer, data, crc]);
}

function createBackgroundPng(width = 1280, height = 720) {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const raw = Buffer.alloc((width * 4 + 1) * height);

    for (let y = 0; y < height; y++) {
        const rowOffset = y * (width * 4 + 1);
        raw[rowOffset] = 0;

        for (let x = 0; x < width; x++) {
            const t = x / Math.max(width - 1, 1);
            const v = y / Math.max(height - 1, 1);
            const offset = rowOffset + 1 + x * 4;

            const r = Math.round(18 + 125 * t + 20 * v);
            const g = Math.round(6 + 10 * t + 4 * v);
            const b = Math.round(10 + 22 * t + 18 * v);

            raw[offset] = Math.min(r, 255);
            raw[offset + 1] = Math.min(g, 255);
            raw[offset + 2] = Math.min(b, 255);
            raw[offset + 3] = 255;
        }
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const idat = zlib.deflateSync(raw, { level: 9 });
    const iend = Buffer.alloc(0);

    return Buffer.concat([
        signature,
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", idat),
        pngChunk("IEND", iend)
    ]);
}

function sendBackgroundImage(res, coversDir) {
    const backgroundFile = getBackgroundFilePath(coversDir);
    if (backgroundFile) {
        const stat = fs.statSync(backgroundFile);
        const ext = path.extname(backgroundFile).toLowerCase();
        const contentTypes = {
            ".png": "image/png",
            ".bmp": "image/bmp",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg"
        };

        res.writeHead(200, {
            "Content-Type": contentTypes[ext] || "application/octet-stream",
            "Content-Length": stat.size,
            "Cache-Control": "no-cache"
        });

        fs.createReadStream(backgroundFile).pipe(res);
        return;
    }

    const image = createBackgroundPng();
    res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": image.length,
        "Cache-Control": "no-cache"
    });
    res.end(image);
}

function sendJsonFile(res, filePath) {
    if (!fs.existsSync(filePath)) {
        send(res, 404, JSON.stringify({ error: "File Not found" }), "application/json; charset=utf-8");
        return;
    }

    const stat = fs.statSync(filePath);
    res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": stat.size
    });

    fs.createReadStream(filePath).pipe(res);
}

function renderHomePage(serverAddress, jsonDir) {
    const jsonFiles = fs.readdirSync(jsonDir)
        .filter(file => file.endsWith(".json") && !INTERNAL_JSON_FILES.has(file))
        .map(file => {
            const category = path.basename(file, ".json");
            return {
                name: category,
                url: `/${category}`
            };
        });

    return `
        <!DOCTYPE html>
<html>
    <head>
        <title>FPKGi Json Server</title>
        <style>
            body { 
                background-color: #121212;
                color: #e0e0e0;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                max-width: 800px;
                margin: 0 auto;
                padding: 20px;
                line-height: 1.6;
            }
            h1, h2 {
                color: #ffffff;
            }
            ul {
                list-style-type: none;
                padding: 0;
            }
            li { 
                margin: 10px 0;
                padding: 10px;
                background: #1e1e1e;
                border-radius: 4px;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
            }
            a {
                color: #FF4444;
                text-decoration: none;
            }
            a:hover { 
                text-decoration: underline;
            }
            textarea {
                width: 100%;
                height: 150px;
                background-color: #1e1e1e;
                color: #e0e0e0;
                border: 1px solid #333;
                border-radius: 4px;
                padding: 10px;
                font-family: monospace;
                resize: vertical;
            }
            hr {
                height: 2px;
                color:rgb(128, 128, 128);
                background: rgb(128, 128, 128);
                font-size: 0;
                border: 0;
            }
            .dark-textarea {
                background-color: #1e1e1e;
                color: #cfcfcf;
                border: 1px solid #333;
                padding: 10px;
                width: 100%;
                min-height: 190px;
                border-radius: 4px;
                font-size: 14px;
                resize: vertical;
                box-shadow: 0 2px 4px rgba(0,0,0,0.5);
            }
            .copy-btn {
                margin-top: 0px;
                padding: 8px 16px;
                background-color: #333;
                color: #fff;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                transition: background-color 0.3s ease;
                float:right;
            }
            .copy-btn:hover {
                background-color: #555;
            }
        </style>
    </head>
    <body>
        <h1>Available Categories</h1>
        <hr />
        <p>Click on the links below to view the JSON data and URL for your discovered packages. Either manually copy these URLs into your config, or use the generated config below. Click the Eye icon to see a parsed library view.</p>
        <ul>
            ${jsonFiles.map(file => `
                <li>
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" title="JSON File">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <text x="12" y="17" text-anchor="middle" font-size="4" fill="currentColor">{ }</text>
                    </svg>&nbsp;
                <a href="${file.name}">/${file.name}</a> 
                <a style="float:right;" href="/library/?cat=${file.name}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="#e0e0e0" viewBox="0 0 24 24">
                        <path d="M12 4.5C7.305 4.5 3.032 7.28 1 12c2.032 4.72 6.305 7.5 11 7.5s8.968-2.78 11-7.5c-2.032-4.72-6.305-7.5-11-7.5zm0 13.5c-3.03 0-5.5-2.47-5.5-5.5S8.97 7 12 7s5.5 2.47 5.5 5.5-2.47 5.5-5.5 5.5zm0-9a3.5 3.5 0 100 7 3.5 3.5 0 000-7z"/>
                    </svg>
                </a></li>
            `).join("")}
        </ul>

        <h2>Generated Config</h2>
        <p>Use the following configuration in your FPKGi config</p>
        <textarea id="json" readonly class="dark-textarea">
"background_uri": "http://${serverAddress}/background",

"CONTENT_URLS": {
    ${(() => {
        const FIXED_CATEGORIES = ["PS1", "PS2", "PSP", "games", "apps", "updates", "DLC", "demos", "homebrew", "emulators", "themes"];
        const availableNames = new Set(jsonFiles.map(f => f.name));
        return FIXED_CATEGORIES.map(cat =>
            availableNames.has(cat)
                ? `"${cat}": "http://${serverAddress}/${cat}"`
                : `"${cat}": null`
        ).join(",\n    ");
    })()}
}</textarea>
<a href="/background" target="_blank" class="copy-btn" style="float:left;">View Background</a>
<button class="copy-btn" id="copyBtn">Copy</button>
        
        <script>
            document.getElementById('copyBtn').addEventListener('click', function() {
            const textarea = document.getElementById('json');
            textarea.select();
            textarea.setSelectionRange(0, 99999);
            
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(textarea.value).then(() => {
                alert('Config copied to clipboard.');
                }).catch(err => {
                alert('Failed to copy config: ' + err);
                });
            } else {
                document.execCommand('copy');
                alert('Config copied to clipboard.');
            }
            });
        </script>
    </body>
</html>`;
}

function renderLibraryPage(category) {
    const title = category ? category.replace(/^./, c => c.toUpperCase()) : category;

    return "<!DOCTYPE html>" +
    "<html lang=\"en\">" +
    "<head>" +
    "  <meta charset=\"UTF-8\">" +
    "  <title>" + title + " Library</title>" +
    "  <style>" +
    "    body { background-color: #121212; color: #e0e0e0; font-family: \"Segoe UI\", Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; }" +
    "    h1 { text-align: center; color: #ffffff; margin-bottom: 30px; }" +
    "    #library { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 20px; }" +
    "    .card { background-color: #1e1e1e; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.5); transition: transform 0.2s ease; text-align: center; }" +
    "    .card:hover { transform: scale(1.05); }" +
    "    .card img { width: 100%; height: auto; display: block; }" +
    "    .info { padding: 10px; }" +
    "    .info h3 { margin: 0; font-size: 1em; color: #FF4444; }" +
    "    .info p { margin: 5px 0; font-size: 0.85em; color: #aaa; }" +
    "    .info .description { color: #ccc; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }" +
    "    .info a { color: #FF4444; text-decoration: none; font-size: 0.8em; }" +
    "    .info a:hover { text-decoration: underline; }" +
    "  </style>" +
    "</head>" +
    "<body>" +
    "  <h1>" + title + " Library</h1>" +
    "  <div id=\"library\"></div>" +
    "   <a href=\"/\" style=\"display:inline-block; padding:10px 20px; text-align:center; margin-top:20px; background-color:#1e1e1e; color:#e0e0e0; border:1px solid #333; border-radius:4px; text-decoration:none; font-family:\"Segoe UI\", Tahoma, Geneva, Verdana, sans-serif; transition: background-color 0.2s ease;\">Back</a>" + 
    "  <script>" +
    "    function createGameCard(pkgUrl, game) {" +
    "      var card = document.createElement(\"div\");" +
    "      card.className = \"card\";" +
    "      var img = document.createElement(\"img\");" +
    "      img.src = game.cover_url;" +
    "      img.alt = game.name + \" cover\";" +
    "      card.appendChild(img);" +
    "      var info = document.createElement(\"div\");" +
    "      info.className = \"info\";" +
    "      var title = document.createElement(\"h3\");" +
    "      title.textContent = game.name;" +
    "      info.appendChild(title);" +
    "      var details = document.createElement(\"p\");" +
    "      details.innerHTML = \"<strong>\" + game.region + \" - \" + game.title_id + \"</strong><br>v\" + game.version;" +
    "      info.appendChild(details);" +
    "      if (game.description) {" +
    "        var description = document.createElement(\"p\");" +
    "        description.className = \"description\";" +
    "        description.textContent = game.description;" +
    "        description.title = game.description;" +
    "        info.appendChild(description);" +
    "      }" +
    "      var link = document.createElement(\"a\");" +
    "      link.href = pkgUrl;" +
    "      link.textContent = \"Download\";" +
    "      link.target = \"_blank\";" +
    "      info.appendChild(link);" +
    "      card.appendChild(info);" +
    "      return card;" +
    "    }" +
    "    function loadGameLibrary() {" +
    "      fetch(\"/" + category + "\")" +
    "        .then(function(response) {" +
    "          if (!response.ok) {" +
    "            throw new Error(\"Network response was not ok\");" +
    "          }" +
    "          return response.json();" +
    "        })" +
    "        .then(function(data) {" +
    "          var library = document.getElementById(\"library\");" +
    "          var games = data.DATA;" +
    "          for (var pkgUrl in games) {" +
    "            if (games.hasOwnProperty(pkgUrl)) {" +
    "              var card = createGameCard(pkgUrl, games[pkgUrl]);" +
    "              library.appendChild(card);" +
    "            }" +
    "          }" +
    "        })" +
    "        .catch(function(error) {" +
    "          console.error(\"Error fetching game library:\", error);" +
    "          document.getElementById(\"library\").innerHTML = \"<p>Error loading game library.</p>\";" +
    "        });" +
    "    }" +
    "    document.addEventListener(\"DOMContentLoaded\", loadGameLibrary);" +
    "  </script>" +
    "</body>" +
    "</html>";
}

function startJsonLibraryServer(settings, options = {}) {
    if (!settings.jsonLibraryServer?.enabled) return Promise.resolve(null);

    const jsonDir = path.resolve(settings.output.path);
    const coversDir = path.resolve(settings.paths.covers);
    if (!fs.existsSync(jsonDir)) {
        throw new Error(`JSON directory not found: ${jsonDir}`);
    }

    const host = settings.jsonLibraryServer.address;
    const port = settings.jsonLibraryServer.port;
    const log = options.onLog || (() => {});

    const server = http.createServer((req, res) => {
        if (!req.url) {
            send(res, 400, "Bad request");
            return;
        }

        const requestUrl = new URL(req.url, `http://${host}:${port}`);
        const pathname = decodeURIComponent(requestUrl.pathname);

        if (pathname === "/") {
            const publicAddress = req.headers.host || `${host}:${port}`;
            send(res, 200, renderHomePage(publicAddress, jsonDir), "text/html; charset=utf-8");
            return;
        }

        if (pathname === "/background") {
            sendBackgroundImage(res, coversDir);
            return;
        }

        if (pathname === "/library" || pathname === "/library/") {
            const cat = requestUrl.searchParams.get("cat");
            const jsonPath = path.join(jsonDir, `${cat}.json`);

            if (!cat || !fs.existsSync(jsonPath)) {
                send(res, 404, "Category not found");
                return;
            }

            send(res, 200, renderLibraryPage(cat), "text/html; charset=utf-8");
            return;
        }

        const category = pathname.replace(/^\/+/, "");
        if (!category.includes("/") && category) {
            sendJsonFile(res, path.join(jsonDir, `${category}.json`));
            return;
        }

        send(res, 404, "Not found");
    });

    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host === "0.0.0.0" ? "0.0.0.0" : host, () => {
            server.removeListener("error", reject);
            log(`JSON library server running at http://${host}:${port}/`);
            log(`Serving JSON files from: ${jsonDir}`);
            resolve(server);
        });
    });
}

function stopJsonLibraryServer(server, onLog) {
    const log = onLog || (() => {});
    if (!server) return Promise.resolve();

    return new Promise((resolve, reject) => {
        server.close(error => {
            if (error) {
                reject(error);
                return;
            }
            log("JSON library server stopped");
            resolve();
        });
    });
}

module.exports = {
    renderHomePage,
    renderLibraryPage,
    startJsonLibraryServer,
    stopJsonLibraryServer
};
