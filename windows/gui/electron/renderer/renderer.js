const state = { settings: null, logs: [], toastTimer: null };

const elements = {
    navLinks: Array.from(document.querySelectorAll(".nav-link")),
    panels: Array.from(document.querySelectorAll(".view")),
    runScanButton: document.getElementById("runScanButton"),
    stopScanButton: document.getElementById("stopScanButton"),
    saveSettingsButton: document.getElementById("saveSettingsButton"),
    httpServerStatus: document.getElementById("httpServerStatus"),
    httpServerUrl: document.getElementById("httpServerUrl"),
    jsonLibraryStatus: document.getElementById("jsonLibraryStatus"),
    jsonLibraryUrl: document.getElementById("jsonLibraryUrl"),
    openJsonLibraryButton: document.getElementById("openJsonLibraryButton"),
    orbisStatus: document.getElementById("orbisStatus"),
    orbisPath: document.getElementById("orbisPath"),
    scanStatus: document.getElementById("scanStatus"),
    logOutput: document.getElementById("logOutput"),
    toast: document.getElementById("toast"),
    httpEnabled: document.getElementById("httpEnabled"),
    jsonLibraryEnabled: document.getElementById("jsonLibraryEnabled"),
    runInBackground: document.getElementById("runInBackground"),
    runOnStartup: document.getElementById("runOnStartup"),
    startInBackgroundOnStartup: document.getElementById("startInBackgroundOnStartup"),
    httpAddress: document.getElementById("httpAddress"),
    httpPort: document.getElementById("httpPort"),
    jsonLibraryAddress: document.getElementById("jsonLibraryAddress"),
    jsonLibraryPort: document.getElementById("jsonLibraryPort"),
    serverAddress: document.getElementById("serverAddress"),
    pkgScanPath: document.getElementById("pkgScanPath"),
    coversPath: document.getElementById("coversPath"),
    jsonOutputPath: document.getElementById("jsonOutputPath"),
    browseButtons: Array.from(document.querySelectorAll("[data-browse-target]"))
};

function setActiveView(view) {
    elements.navLinks.forEach(link => link.classList.toggle("is-active", link.dataset.view === view));
    elements.panels.forEach(panel => panel.classList.toggle("is-active", panel.dataset.viewPanel === view));
}

function showToast(message, type = "success") {
    elements.toast.textContent = message;
    elements.toast.dataset.type = type;
    elements.toast.classList.add("is-visible");

    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
        elements.toast.classList.remove("is-visible");
    }, 2400);
}

function appendLog(line) {
    state.logs.push(line);
    if (state.logs.length > 500) state.logs = state.logs.slice(-500);
    elements.logOutput.textContent = state.logs.join("\n");
    elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function renderSettings(settings) {
    state.settings = settings;
    elements.httpEnabled.checked = Boolean(settings.httpServer?.enabled);
    elements.jsonLibraryEnabled.checked = Boolean(settings.jsonLibraryServer?.enabled);
    elements.runInBackground.checked = Boolean(settings.appBehavior?.runInBackground);
    elements.runOnStartup.checked = Boolean(settings.appBehavior?.runOnStartup);
    elements.startInBackgroundOnStartup.checked = Boolean(settings.appBehavior?.startInBackgroundOnStartup);
    elements.httpAddress.value = settings.httpServer?.address || "";
    elements.httpPort.value = settings.httpServer?.port || "";
    elements.jsonLibraryAddress.value = settings.jsonLibraryServer?.address || "";
    elements.jsonLibraryPort.value = settings.jsonLibraryServer?.port || "";
    elements.serverAddress.value = settings.serverAddress || "";
    elements.pkgScanPath.value = settings.paths?.pkgScan || "";
    elements.coversPath.value = settings.paths?.covers || "";
    elements.jsonOutputPath.value = settings.output?.path || "";
}

function renderStatus(payload) {
    renderSettings(payload.settings);
    state.logs = payload.logs || [];
    elements.logOutput.textContent = state.logs.join("\n");
    elements.logOutput.scrollTop = elements.logOutput.scrollHeight;

    elements.httpServerStatus.textContent = payload.httpServerRunning ? "Running" : "Stopped";
    elements.httpServerStatus.className = payload.httpServerRunning ? "status-good" : "status-bad";
    elements.httpServerUrl.textContent = payload.httpServerRunning ? payload.httpServerUrl : "HTTP server is turned off.";

    elements.jsonLibraryStatus.textContent = payload.jsonLibraryRunning ? "Running" : "Stopped";
    elements.jsonLibraryStatus.className = payload.jsonLibraryRunning ? "status-good" : "status-bad";
    elements.jsonLibraryUrl.textContent = payload.jsonLibraryRunning ? payload.jsonLibraryUrl : "JSON library server is turned off.";
    elements.openJsonLibraryButton.disabled = !payload.jsonLibraryRunning;

    elements.orbisStatus.textContent = payload.orbisExists ? "Detected" : "Missing";
    elements.orbisStatus.className = payload.orbisExists ? "status-good" : "status-bad";
    elements.orbisPath.textContent = payload.orbisPath;

    elements.scanStatus.textContent = payload.scanning ? "Scanning" : "Idle";
    elements.runScanButton.disabled = payload.scanning;
    elements.stopScanButton.disabled = !payload.scanning;
}

function collectSettingsFromForm() {
    return {
        serverAddress: elements.serverAddress.value.trim(),
        httpServer: {
            enabled: elements.httpEnabled.checked,
            address: elements.httpAddress.value.trim(),
            port: Number(elements.httpPort.value)
        },
        jsonLibraryServer: {
            enabled: elements.jsonLibraryEnabled.checked,
            address: elements.jsonLibraryAddress.value.trim(),
            port: Number(elements.jsonLibraryPort.value)
        },
        paths: {
            pkgScan: elements.pkgScanPath.value.trim(),
            covers: elements.coversPath.value.trim()
        },
        output: {
            path: elements.jsonOutputPath.value.trim()
        },
        appBehavior: {
            runInBackground: elements.runInBackground.checked,
            runOnStartup: elements.runOnStartup.checked,
            startInBackgroundOnStartup: elements.startInBackgroundOnStartup.checked
        }
    };
}

async function bootstrap() {
    renderStatus(await window.fpkgiApi.getStatus());
}

elements.navLinks.forEach(link => link.addEventListener("click", () => setActiveView(link.dataset.view)));

elements.browseButtons.forEach(button => {
    button.addEventListener("click", async () => {
        const selected = await window.fpkgiApi.browseDirectory();
        if (!selected) return;
        const input = document.getElementById(button.dataset.browseTarget);
        if (input) input.value = selected;
    });
});

elements.saveSettingsButton.addEventListener("click", async () => {
    try {
        renderStatus(await window.fpkgiApi.saveSettings(collectSettingsFromForm()));
        appendLog("Settings saved");
        showToast("Settings saved");
    } catch (error) {
        appendLog(`Settings save failed: ${error.message}`);
        showToast("Failed to save settings", "error");
    }
});

elements.runScanButton.addEventListener("click", async () => {
    appendLog("Launching scan from dashboard");
    elements.scanStatus.textContent = "Scanning";
    elements.runScanButton.disabled = true;
    elements.stopScanButton.disabled = false;
    const result = await window.fpkgiApi.runScan();
    renderStatus(result.status);
    if (!result.ok) {
        if (result.error === "Scan stopped.") {
            showToast("Scan stopped");
        } else {
            appendLog(`Scan error: ${result.error}`);
            showToast("Scan failed", "error");
        }
        return;
    }
    showToast("Scan completed");
});

elements.stopScanButton.addEventListener("click", async () => {
    try {
        const status = await window.fpkgiApi.stopScan();
        renderStatus(status);
        showToast("Stopping scan...");
    } catch (error) {
        appendLog(`Stop scan failed: ${error.message}`);
        showToast("Failed to stop scan", "error");
    }
});

elements.openJsonLibraryButton.addEventListener("click", async () => {
    try {
        await window.fpkgiApi.openJsonLibrary();
    } catch (error) {
        appendLog(`Open JSON library failed: ${error.message}`);
        showToast("Failed to open JSON library", "error");
    }
});

window.fpkgiApi.onLog(appendLog);
window.fpkgiApi.onStatus(renderStatus);
bootstrap();
