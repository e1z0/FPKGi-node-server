const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, Notification, nativeImage, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const { startHttpServer, stopHttpServer, validateSettings } = require("../app/processor");
const { startJsonLibraryServer, stopJsonLibraryServer } = require("../app/json-library-server");

let mainWindow = null;
let tray = null;
let httpServerInstance = null;
let jsonLibraryServerInstance = null;
let isScanning = false;
let logBuffer = [];
let scanWorker = null;
let isQuitting = false;

function getUserConfigPath() {
    return path.join(app.getPath("userData"), "settings.json");
}

function getBundledOrbisPath() {
    if (app.isPackaged) return path.join(process.resourcesPath, "bin", "orbis-pub-cmd.exe");
    return path.join(app.getAppPath(), "orbis-pub-cmd.exe");
}

function getAppIconPath() {
    if (app.isPackaged) {
        const packagedIcon = path.join(process.resourcesPath, "icon.ico");
        return fs.existsSync(packagedIcon) ? packagedIcon : null;
    }
    const devIcon = path.join(app.getAppPath(), "electron", "assets", "icon.ico");
    return fs.existsSync(devIcon) ? devIcon : null;
}

function getTrayIconImage() {
    const iconPath = getAppIconPath();
    if (!iconPath) return nativeImage.createEmpty();
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) return nativeImage.createEmpty();
    return process.platform === "win32" ? image.resize({ width: 16, height: 16 }) : image;
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
        },
        appBehavior: {
            runInBackground: false,
            runOnStartup: false,
            startInBackgroundOnStartup: false
        }
    };
}

function loadSettings() {
    const configPath = getUserConfigPath();
    const defaults = defaultSettings();
    if (!fs.existsSync(configPath)) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(defaults, null, 4));
        return defaults;
    }

    try {
        const loaded = JSON.parse(fs.readFileSync(configPath, "utf8"));
        return {
            ...defaults,
            ...loaded,
            httpServer: { ...defaults.httpServer, ...(loaded.httpServer || {}) },
            jsonLibraryServer: { ...defaults.jsonLibraryServer, ...(loaded.jsonLibraryServer || {}) },
            paths: { ...defaults.paths, ...(loaded.paths || {}) },
            output: { ...defaults.output, ...(loaded.output || {}) },
            appBehavior: { ...defaults.appBehavior, ...(loaded.appBehavior || {}) }
        };
    } catch (_) {
        return defaults;
    }
}

function saveSettings(settings) {
    const configPath = getUserConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(settings, null, 4));
}

function addLog(message) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    logBuffer.push(line);
    if (logBuffer.length > 500) logBuffer = logBuffer.slice(-500);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("log:append", line);
    }
}

function getJsonLibraryUrl(settings = loadSettings()) {
    return `http://${settings.jsonLibraryServer.address}:${settings.jsonLibraryServer.port}/`;
}

function getStatusPayload() {
    const settings = loadSettings();
    const orbisPath = getBundledOrbisPath();
    return {
        scanning: isScanning,
        httpServerRunning: Boolean(httpServerInstance),
        httpServerUrl: settings.httpServer?.enabled ? `http://${settings.httpServer.address}:${settings.httpServer.port}` : "",
        jsonLibraryRunning: Boolean(jsonLibraryServerInstance),
        jsonLibraryUrl: settings.jsonLibraryServer?.enabled ? getJsonLibraryUrl(settings) : "",
        orbisExists: fs.existsSync(orbisPath),
        orbisPath,
        settings,
        logs: logBuffer
    };
}

function emitStatusUpdate() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("status:update", getStatusPayload());
    }
}

function applyStartupSetting(settings) {
    app.setLoginItemSettings({
        openAtLogin: Boolean(settings.appBehavior?.runOnStartup)
    });
}

function serverConfigChanged(prevConfig = {}, nextConfig = {}) {
    return JSON.stringify(prevConfig) !== JSON.stringify(nextConfig);
}

async function syncHttpServer(settings) {
    if (httpServerInstance) {
        await stopHttpServer(httpServerInstance, addLog);
        httpServerInstance = null;
    }
    if (settings.httpServer?.enabled) {
        httpServerInstance = await startHttpServer(settings, { onLog: addLog });
    }
}

async function syncJsonLibraryServer(settings) {
    if (jsonLibraryServerInstance) {
        await stopJsonLibraryServer(jsonLibraryServerInstance, addLog);
        jsonLibraryServerInstance = null;
    }
    if (settings.jsonLibraryServer?.enabled) {
        jsonLibraryServerInstance = await startJsonLibraryServer(settings, { onLog: addLog });
    }
}

function showWindow() {
    if (!mainWindow) return;
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
}

function hideToTray() {
    if (!mainWindow) return;
    mainWindow.hide();
    addLog("App minimized to tray");
}

function createTray() {
    if (tray) return;
    tray = new Tray(getTrayIconImage());
    tray.setToolTip("FPKGi Node Server");
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: "Open", click: showWindow },
        {
            label: "Quit",
            click: () => {
                isQuitting = true;
                app.quit();
            }
        }
    ]));
    tray.on("click", showWindow);
}

function sendDesktopNotification(title, body) {
    if (!Notification.isSupported()) return;
    const iconPath = getAppIconPath();
    new Notification({ title, body, icon: iconPath || undefined }).show();
}

function createWindow() {
    const settings = loadSettings();
    const showOnLaunch = !settings.appBehavior?.startInBackgroundOnStartup;

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 1080,
        minHeight: 760,
        backgroundColor: "#150609",
        show: showOnLaunch,
        icon: getAppIconPath() || undefined,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

    if (!showOnLaunch) {
        mainWindow.once("ready-to-show", () => {
            mainWindow.hide();
            addLog("App started in tray mode");
        });
    }

    mainWindow.on("close", event => {
        const settingsNow = loadSettings();
        if (!isQuitting && settingsNow.appBehavior?.runInBackground) {
            event.preventDefault();
            hideToTray();
        }
    });
}

app.whenReady().then(async () => {
    createTray();
    createWindow();
    try {
        const settings = loadSettings();
        applyStartupSetting(settings);
        if (settings.httpServer?.enabled) await syncHttpServer(settings);
        if (settings.jsonLibraryServer?.enabled) await syncJsonLibraryServer(settings);
        emitStatusUpdate();
    } catch (error) {
        addLog(`Failed to start server: ${error.message}`);
    }
});

app.on("window-all-closed", async () => {
    const settings = loadSettings();
    if (settings.appBehavior?.runInBackground && !isQuitting) return;

    if (httpServerInstance) {
        try { await stopHttpServer(httpServerInstance, addLog); } catch (_) {}
    }
    if (jsonLibraryServerInstance) {
        try { await stopJsonLibraryServer(jsonLibraryServerInstance, addLog); } catch (_) {}
    }

    if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
    isQuitting = true;
});

ipcMain.handle("app:get-status", async () => getStatusPayload());

ipcMain.handle("settings:save", async (_event, nextSettings) => {
    const previousSettings = loadSettings();
    validateSettings(nextSettings);
    saveSettings(nextSettings);
    applyStartupSetting(nextSettings);

    if (serverConfigChanged(previousSettings.httpServer, nextSettings.httpServer) ||
        previousSettings.serverAddress !== nextSettings.serverAddress ||
        previousSettings.paths?.pkgScan !== nextSettings.paths?.pkgScan ||
        previousSettings.paths?.covers !== nextSettings.paths?.covers) {
        await syncHttpServer(nextSettings);
    }

    if (serverConfigChanged(previousSettings.jsonLibraryServer, nextSettings.jsonLibraryServer) ||
        previousSettings.output?.path !== nextSettings.output?.path) {
        await syncJsonLibraryServer(nextSettings);
    }

    emitStatusUpdate();
    return getStatusPayload();
});

ipcMain.handle("settings:browse-directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

ipcMain.handle("json-library:open", async () => {
    const settings = loadSettings();
    if (!settings.jsonLibraryServer?.enabled || !jsonLibraryServerInstance) {
        throw new Error("JSON library server is not running.");
    }
    await shell.openExternal(getJsonLibraryUrl(settings));
    return true;
});

ipcMain.handle("scan:run", async () => {
    if (isScanning) throw new Error("A scan is already running.");

    const settings = loadSettings();
    const orbisPath = getBundledOrbisPath();

    isScanning = true;
    emitStatusUpdate();
    try {
        addLog("Starting scan");
        const summary = await new Promise((resolve, reject) => {
            let settled = false;
            scanWorker = new Worker(path.join(__dirname, "scan-worker.js"), {
                workerData: {
                    settings,
                    orbisCmdPath: orbisPath
                }
            });

            scanWorker.on("message", message => {
                if (message.type === "log") {
                    addLog(message.line);
                    return;
                }
                if (message.type === "done") {
                    settled = true;
                    resolve(message.summary);
                }
            });

            scanWorker.on("error", error => {
                if (!settled) reject(error);
            });

            scanWorker.on("exit", code => {
                if (!settled && code !== 0) {
                    reject(new Error(code === 1 ? "Scan stopped." : `Scan worker stopped with exit code ${code}`));
                }
            });
        });

        isScanning = false;
        scanWorker = null;
        emitStatusUpdate();
        addLog("Scan finished");
        sendDesktopNotification("FPKGi Node Server", "Scan completed successfully.");
        return { ok: true, summary, status: getStatusPayload() };
    } catch (error) {
        isScanning = false;
        scanWorker = null;
        emitStatusUpdate();
        addLog(`Scan failed: ${error.message}`);
        if (error.message === "Scan stopped.") {
            sendDesktopNotification("FPKGi Node Server", "Scan stopped.");
        }
        return { ok: false, error: error.message, status: getStatusPayload() };
    }
});

ipcMain.handle("scan:stop", async () => {
    if (!scanWorker || !isScanning) {
        return getStatusPayload();
    }

    addLog("Stopping scan...");
    const workerToStop = scanWorker;
    scanWorker = null;
    await workerToStop.terminate();
    isScanning = false;
    emitStatusUpdate();
    sendDesktopNotification("FPKGi Node Server", "Scan stopped.");
    return getStatusPayload();
});
