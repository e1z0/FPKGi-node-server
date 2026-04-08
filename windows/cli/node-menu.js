const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { runProcessing, startHttpServer, stopHttpServer, validateSettings } = require("./app/processor");
const { startJsonLibraryServer, stopJsonLibraryServer } = require("./app/json-library-server");

let httpServerInstance = null;
let jsonLibraryServerInstance = null;

function log(message = "") {
    process.stdout.write(`${message}\n`);
}

function error(message) {
    process.stderr.write(`${message}\n`);
}

function getOrbisPath() {
    return path.join(__dirname, "orbis-pub-cmd.exe");
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
    return path.join(process.cwd(), "node-settings.json");
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

async function runScan(settings) {
    validateSettings(settings);
    await runProcessing(settings, {
        orbisCmdPath: getOrbisPath(),
        onLog: log
    });
}

async function main() {
    const prompt = createPrompt();
    let settings = loadOrCreateSettings();
    saveSettings(settings);
    await startServers(settings);

    try {
        while (true) {
            log("");
            log("FPKGi Node Server CLI");
            log("----------------");
            log(`Config: ${getConfigPath()}`);
            log("Running servers:");
            getRunningServersSummary(settings).forEach(line => log(`- ${line}`));
            log("1. Run scan");
            log("2. Edit settings");
            log("3. Start servers");
            log("4. Run scan and keep servers running");
            log("5. Stop running servers");
            log("6. Show current settings");
            log("7. Exit");

            const choice = (await prompt.question("Choose an option: ")).trim();

            try {
                if (choice === "1") {
                    await runScan(settings);
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
                    await runScan(settings);
                    log("Scan complete. Servers are still running.");
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
