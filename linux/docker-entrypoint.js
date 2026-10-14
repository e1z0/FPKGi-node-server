const fs = require("fs");
const { runJsonOnly } = require("./node-menu-linux");
const { startHttpServer, stopHttpServer } = require("./app/processor");
const { startJsonLibraryServer, stopJsonLibraryServer } = require("./app/json-library-server");

function integerEnv(name, fallback) {
    const value = Number.parseInt(process.env[name] || String(fallback), 10);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error(`${name} must be an integer between 1 and 65535`);
    }
    return value;
}

function nonNegativeIntegerEnv(name, fallback) {
    const value = Number.parseInt(process.env[name] || String(fallback), 10);
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer`);
    }
    return value;
}

const httpPort = integerEnv("FPKGI_HTTP_PORT", 8080);
const jsonPort = integerEnv("FPKGI_JSON_PORT", 3000);
const scanIntervalSeconds = nonNegativeIntegerEnv("FPKGI_SCAN_INTERVAL_SECONDS", 0);
const pkgPath = process.env.FPKGI_PKG_PATH || "/data/pkgs";
const coversPath = process.env.FPKGI_COVERS_PATH || "/data/covers";
const jsonPath = process.env.FPKGI_JSON_PATH || "/data/json";

const settings = {
    serverAddress: process.env.FPKGI_PUBLIC_ADDRESS || `localhost:${httpPort}`,
    httpServer: {
        enabled: true,
        address: process.env.FPKGI_HTTP_BIND || "0.0.0.0",
        port: httpPort
    },
    jsonLibraryServer: {
        enabled: true,
        address: process.env.FPKGI_JSON_BIND || "0.0.0.0",
        port: jsonPort
    },
    paths: {
        pkgScan: pkgPath,
        covers: coversPath
    },
    output: {
        path: jsonPath
    }
};

let httpServer;
let jsonServer;
let scanTimer;
let scanRunning = false;
let stopping = false;

function log(message) {
    process.stdout.write(`${message}\n`);
}

async function scan() {
    if (scanRunning) {
        log("Skipping scheduled scan because the previous scan is still running.");
        return;
    }

    scanRunning = true;
    try {
        await runJsonOnly(settings);
    } catch (error) {
        process.stderr.write(`Scan failed: ${error.message}\n`);
    } finally {
        scanRunning = false;
    }
}

async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    log(`Received ${signal}; stopping servers.`);
    if (scanTimer) clearInterval(scanTimer);

    try {
        await stopJsonLibraryServer(jsonServer, log);
        await stopHttpServer(httpServer, log);
        process.exit(0);
    } catch (error) {
        process.stderr.write(`Shutdown failed: ${error.message}\n`);
        process.exit(1);
    }
}

async function main() {
    for (const directory of [pkgPath, coversPath, jsonPath]) {
        fs.mkdirSync(directory, { recursive: true });
    }

    log(`Advertising package URLs as http://${settings.serverAddress}/`);
    await scan();
    httpServer = await startHttpServer(settings, { onLog: log });
    jsonServer = await startJsonLibraryServer(settings, { onLog: log });

    if (scanIntervalSeconds > 0) {
        scanTimer = setInterval(scan, scanIntervalSeconds * 1000);
        log(`Scheduled a package rescan every ${scanIntervalSeconds} seconds.`);
    }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
});
