# FPKGi Node Server

## Improved Fork Highlights

This fork focuses on a production-ready, PS4-only Linux and Docker workflow.
The ready-to-run image is published as
`nulldevil/fpkgi-node-server:latest` and includes:

- native PS4 FPKG metadata parsing and `icon0.png` extraction on Linux
- automatic extraction for new packages and repair of missing, zero-byte, or
  invalid covers
- persistent incremental scans that inspect only new or changed PKGs
- catalog and cache writes only when their contents actually change
- correct download URLs for PKGs stored in nested collection folders
- configurable runtime UID/GID through `PUID` and `PGID`
- built-in container health checks and scheduled rescans
- persistent Compose volumes for packages, covers, generated JSON, and cache

See the [Docker](#docker), [incremental scans](#incremental-scans), and
[Linux PS4 icon extraction](#linux-ps4-icon-extraction) sections for setup and
implementation details.

FPKGi Node Server is a set of tools for generating FPKGi-compatible JSON files, serving PKG and cover files over HTTP, and hosting a separate JSON library web UI.

This repository contains the source code for:

- a Windows GUI app
- a Windows CLI version
- a Linux CLI version

## Features

- scan category folders containing PS4 `.pkg` files
- extract plaintext PS4 `icon0.png` cover art on Linux
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

### Linux PS4 Icon Extraction

The Linux version reads the PS4 CNT entry table directly and extracts the
plaintext `icon0.png` entry (`0x1200`) while generating the FPKGi JSON files.
New PKGs are handled during the same scheduled scan as catalog generation.
Existing non-empty PNG/JPEG covers with valid signatures are preserved;
zero-byte or invalid covers are extracted again automatically.

This path is intentionally PS4-only. Encrypted icon entries, such as those in
some official retail packages, are reported and skipped. FPKG icon entries are
normally plaintext and do not require `orbis-pub-cmd.exe`, Python, or GUI
dependencies.

The PS4 package parser was informed by the MIT-licensed
[PKG Viewer](https://github.com/Loopayeh/pkg-viewer) implementation and the
PS4 format validation documented by
[PkgToolBox](https://github.com/seregonwar/PkgToolBox).

## Docker

Build the image from the repository root:

```bash
docker build -t fpkgi-node-server:latest .
```

The published image is also available from Docker Hub:

```bash
docker pull nulldevil/fpkgi-node-server:latest
```

The PKG directory must contain category subfolders such as `games`, `updates`,
or `homebrew`. Set `FPKGI_PUBLIC_ADDRESS` to the LAN address and published HTTP
port that your PS4 can reach:

```bash
docker run -d \
  --name fpkgi-node-server \
  --restart unless-stopped \
  -p 8080:8080 \
  -p 3000:3000 \
  -e FPKGI_PUBLIC_ADDRESS=192.168.1.10:8080 \
  -e FPKGI_SCAN_INTERVAL_SECONDS=300 \
  -v /path/to/pkgs:/data/pkgs:ro \
  -v /path/to/covers:/data/covers \
  -v /path/to/json:/data/json \
  fpkgi-node-server:latest
```

Open `http://192.168.1.10:3000/` to see the generated FPKGi category URLs.
The initial scan runs when the container starts. Set
`FPKGI_SCAN_INTERVAL_SECONDS` to a positive number to rescan periodically, or
leave it at `0` to scan only at startup.

### Incremental scans

Scan state is persisted as `/data/json/.fpkgi-cache-v1`, so the `json` volume
must remain writable and persistent. Each package is keyed by its relative
path, size, and nanosecond modification/change timestamps. Unchanged packages
reuse cached PS4 metadata and icon offsets; only new or changed packages are
inspected. Removed packages are dropped from the catalog. The fingerprint
survives container replacement and bind-mount remapping.

The scanner still validates each expected cover signature, allowing missing,
zero-byte, or invalid covers to be repaired without parsing the package again.
Generated category JSON and the cache manifest are written only when their
contents change. Full-file hashes are deliberately avoided because hashing
large PKGs on every scan would consume the disk and CPU resources the cache is
intended to save.

The Node process runs as UID/GID `1000:1000` by default. Set the `PUID` and
`PGID` environment variables to use different IDs. The container adjusts the
internal `node` account at startup and drops root privileges before launching
the server. Keep both ports on your trusted LAN; the application has no
authentication and should not be exposed to the public internet.

### Docker Compose

An example with all persistent volumes is provided in
`docker-compose.example.yml`. Create the bind-mount directories, set the LAN
address reachable by the PS4, and start it with:

```bash
mkdir -p data/pkgs data/covers data/json
export FPKGI_PUBLIC_ADDRESS=192.168.1.10:8080
docker compose -f docker-compose.example.yml up -d
```

Set `PUID` and `PGID` to the owner of the host bind-mount directories. Do not
use Compose's `user:` setting because the startup script needs to adjust the
internal `node` account before dropping privileges. The host directories can
also be overridden with `FPKGI_PKG_DIR`, `FPKGI_COVERS_DIR`, and
`FPKGI_JSON_DIR`.

The container health check requests the JSON library service every 30 seconds.
Its status is available with:

```bash
docker inspect --format '{{.State.Health.Status}}' fpkgi-node-server
```

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
