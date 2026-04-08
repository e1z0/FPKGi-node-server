const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fpkgiApi", {
    getStatus: () => ipcRenderer.invoke("app:get-status"),
    saveSettings: settings => ipcRenderer.invoke("settings:save", settings),
    browseDirectory: () => ipcRenderer.invoke("settings:browse-directory"),
    runScan: () => ipcRenderer.invoke("scan:run"),
    stopScan: () => ipcRenderer.invoke("scan:stop"),
    openJsonLibrary: () => ipcRenderer.invoke("json-library:open"),
    onLog: callback => ipcRenderer.on("log:append", (_event, line) => callback(line)),
    onStatus: callback => ipcRenderer.on("status:update", (_event, status) => callback(status))
});
