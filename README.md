# FPKGi Node Server

FPKGi Node Server is a set of tools for generating FPKGi-compatible JSON files, serving PKG and cover files over HTTP, and hosting a separate JSON library web UI.

This repository contains the source code for:

- a Windows GUI app
- a Windows CLI version
- a Linux CLI version

## Features

- scan category folders containing PS4 `.pkg` files
- generate FPKGi JSON files
- serve PKG files and cover images over HTTP
- host a separate JSON library server on its own port
- support a background image for the JSON library
- extract cover icons automatically on Windows with `orbis-pub-cmd.exe` from [PS4 Fake PKG Tools by CyB1K](https://github.com/CyB1K/PS4-Fake-PKG-Tools-3.87)

## Release Downloads

Check ther [Releases](https://github.com/CyberMask367/FPKGi-node-server/releases) section for files:

- `fpkgi-node-server-windows-gui_installer.exe`
- `fpkgi-node-server-windows-gui_portable.zip`
- `fpkgi-node-server-windows-cli.zip`
- `fpkgi-node-server-linux.zip`

## Which Version To Use

Use the Windows GUI if you want:

- a desktop app
- settings page
- dashboard
- tray support
- live logs
- buttons for scan and stop scan

Use the Windows CLI if you want:

- a simple menu in the terminal
- Windows icon extraction support
- no GUI

Use the Linux version if you want:

- terminal-based operation
- JSON generation on Linux
- HTTP and JSON library servers without Windows-only extraction tools

## Windows GUI Release

You can use either the installer or the portable version.

### Windows GUI Installer

File:

- `fpkgi-node-server-windows-gui_installer.exe`

Installation:

1. Run the installer.
2. Follow the setup wizard.
3. Launch `FPKGi Node Server` from the Start menu or installed folder.

<img width="1587" height="1067" alt="image" src="https://github.com/user-attachments/assets/cf4651d6-39f6-4ad5-ab3c-14d8dc11b4d5" />


Notes:

- Node.js is not required for the packaged GUI release.
- `orbis-pub-cmd.exe`, `orbis-pub-prx.dll`, and `ext` are bundled inside the app resources.

### Windows GUI Portable

File:

- `fpkgi-node-server-windows-gui_portable.zip`

Installation and usage:

1. Extract the zip to a folder.
2. Keep all extracted files together.
3. Run `FPKGi Node Server.exe`.

Important:

- Do not move only the `.exe` out of the extracted folder.
- The portable build depends on the bundled `resources` folder next to the executable.
- Node.js is not required for the packaged GUI release.

### First-Time Setup In The GUI

Open the `Settings` page and set:

- PKG scan path
- covers path
- JSON output path
- HTTP server enabled or disabled
- HTTP server IP and port
- JSON library server enabled or disabled
- JSON library server IP and port
- optional tray and startup behavior

Then save the settings.

### Running A Scan In The GUI

From the dashboard:

1. Click `Run Scan`.
2. The app scans PKGs, extracts icons on Windows, and generates JSON files.
3. Use `Stop Scan` if you want to cancel the current scan.

The dashboard also shows:

- current job status
- whether the HTTP server is running
- whether the JSON library server is running
- whether the Orbis tool is available
- live logs

## Windows CLI Release

File:

- `fpkgi-node-server-windows-cli.zip`

What is included:

- `node-menu.js`
- `node-settings.json`
- `fpkgi-node-server-windows-cli.bat`
- `orbis-pub-cmd.exe`
- `orbis-pub-prx.dll`
- `ext`
- `app`
- empty `pkg`, `covers`, and `json` folders

Requirements:

- Windows
- [Node.js](https://nodejs.org/)

Installation and usage:

1. Extract the zip to a folder.
2. Make sure Node.js is installed.
3. Run `fpkgi-node-server-windows-cli.bat`, or open a terminal in the extracted folder and run:

```bash
node node-menu.js
```

### Windows CLI Menu

The menu includes:

- `1. Run scan`
- `2. Edit settings`
- `3. Start servers`
- `4. Run scan and keep servers running`
- `5. Stop running servers`
- `6. Show current settings`
- `7. Exit`

Enabled servers start automatically when the script launches, and the currently running servers are shown at the top of the menu.

### Windows CLI Config

The Windows CLI uses:

- `node-settings.json`

Main settings:

- `paths.pkgScan`
- `paths.covers`
- `output.path`
- `httpServer.enabled`
- `httpServer.address`
- `httpServer.port`
- `jsonLibraryServer.enabled`
- `jsonLibraryServer.address`
- `jsonLibraryServer.port`
- `serverAddress`

## Linux Release

File:

- `fpkgi-node-server-linux.zip`

What is included:

- `node-menu-linux.js`
- `node-settings-linux.json`
- `json-generator-linux.js`
- `app`
- empty `pkg`, `covers`, and `json` folders

Requirements:

- Linux
- [Node.js](https://nodejs.org/)

Installation and usage:

1. Extract the zip to a folder.
2. Make sure Node.js is installed.
3. Open a terminal in the extracted folder.
4. Run:

```bash
node node-menu-linux.js
```

Note:

- The archive includes `fpkgi-node-server-linux.sh`, but the safest way to launch the Linux version is running `node node-menu-linux.js` directly.

### Linux Menu

The Linux menu includes:

- `1. Generate JSON`
- `2. Edit settings`
- `3. Start servers`
- `4. Generate JSON and keep servers running`
- `5. Stop running servers`
- `6. Show current settings`
- `7. Exit`

Enabled servers start automatically when the script launches, and the currently running servers are shown at the top of the menu.

### Linux Limitation

The Linux version does not extract icons because `orbis-pub-cmd.exe` is Windows-only.

You should provide cover images in the covers folder if you want custom artwork in generated output.

## Covers And Background Image

Cover images are read from the covers directory you set in the app or CLI config.

The JSON library server also checks the root of the covers folder for a background image named:

- `background.png`
- `background.bmp`
- `background.jpg`
- `background.jpeg`

If one of those exists, it is served automatically through the JSON library server.

The generated JSON library config uses:

```json
"background_uri": "http://server-address/background"
```

## HTTP Server

When enabled, the built-in HTTP server serves only:

- `/pkg/...`
- `/covers/...`

It does not expose the whole project folder.

## JSON Library Server

The JSON library server is separate from the PKG/covers HTTP server and has its own:

- enable toggle
- IP address
- port

It uses the JSON output path automatically and can be opened in a browser from the GUI.

## Source Usage

If you want to run from source instead of using the releases:

- run the Electron project from [windows/gui](https://github.com/CyberMask367/FPKGi-node-server/tree/main/windows/gui)
- run the Windows Node CLI from [windows/cli](https://github.com/CyberMask367/FPKGi-node-server/tree/main/windows/cli)
- run the Linux Node tools from [linux](https://github.com/CyberMask367/FPKGi-node-server/tree/main/linux)

After cloning the repo, install dependencies locally only where they are needed.

### Windows GUI From Source

In [windows/gui](https://github.com/CyberMask367/FPKGi-node-server/tree/main/windows/gui):

```bash
npm install
npm start
```

To build:

```bash
npm run build
```

If you clean the folder later or clone the repo on another machine, run `npm install` again in `windows/gui` to restore `node_modules`.

The GUI source project expects these files in the same folder:

- `orbis-pub-cmd.exe`
- `orbis-pub-prx.dll`
- `ext`

### Windows CLI From Source

In [windows/cli](https://github.com/CyberMask367/FPKGi-node-server/tree/main/windows/cli):

```bash
node node-menu.js
```

The Windows CLI runs directly with Node.js and does not need the Electron GUI `node_modules` folder.

### Linux From Source

In [linux](https://github.com/CyberMask367/FPKGi-node-server/tree/main/linux):

```bash
node node-menu-linux.js
```

The Linux scripts also run directly with Node.js and do not use the Windows GUI dependencies.

## Safety Note

This project is designed for local or private network use.

It should not be exposed directly to the public internet because it does not include authentication or security hardening for public hosting.

Use at your own risk if hosting publicly.
