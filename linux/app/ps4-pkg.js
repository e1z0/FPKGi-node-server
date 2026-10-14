const fs = require("fs");
const path = require("path");

const PS4_MAGIC = 0x7f434e54;
const HEADER_MIN_SIZE = 0xa0;
const ENTRY_SIZE = 0x20;
const MAX_ENTRY_COUNT = 10000;
const MAX_METADATA_SIZE = 64 * 1024 * 1024;
const MAX_ICON_SIZE = 32 * 1024 * 1024;
const ENTRY_NAMES_ID = 0x0200;
const PARAM_SFO_ID = 0x1000;
const ICON0_ID = 0x1200;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class Ps4PkgError extends Error {
    constructor(message, code = "INVALID_PS4_PKG") {
        super(message);
        this.name = "Ps4PkgError";
        this.code = code;
    }
}

function checkedRange(offset, size, fileSize, label) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) ||
        offset < 0 || size < 0 || offset > fileSize || size > fileSize - offset) {
        throw new Ps4PkgError(`${label} is outside the package`);
    }
}

function readExactly(fd, offset, size, label) {
    const buffer = Buffer.alloc(size);
    const bytesRead = fs.readSync(fd, buffer, 0, size, offset);
    if (bytesRead !== size) {
        throw new Ps4PkgError(`${label} is truncated`);
    }
    return buffer;
}

function decodeCString(buffer) {
    const end = buffer.indexOf(0);
    return buffer.subarray(0, end === -1 ? buffer.length : end).toString("utf8").trim();
}

function parseSfo(buffer) {
    if (buffer.length < 20 || !buffer.subarray(0, 4).equals(Buffer.from([0, 0x50, 0x53, 0x46]))) {
        throw new Ps4PkgError("param.sfo has invalid magic", "INVALID_SFO");
    }

    const keyTableOffset = buffer.readUInt32LE(8);
    const dataTableOffset = buffer.readUInt32LE(12);
    const entryCount = buffer.readUInt32LE(16);
    const entryTableEnd = 20 + entryCount * 16;

    if (entryCount > 4096 || entryTableEnd > buffer.length ||
        keyTableOffset < entryTableEnd || dataTableOffset < keyTableOffset ||
        dataTableOffset > buffer.length) {
        throw new Ps4PkgError("param.sfo table is invalid", "INVALID_SFO");
    }

    const values = {};
    for (let index = 0; index < entryCount; index++) {
        const entryOffset = 20 + index * 16;
        const keyOffset = buffer.readUInt16LE(entryOffset);
        const formatLe = buffer.readUInt16LE(entryOffset + 2);
        const valueSize = buffer.readUInt32LE(entryOffset + 4);
        const valueOffset = buffer.readUInt32LE(entryOffset + 12);
        const absoluteKeyOffset = keyTableOffset + keyOffset;
        const absoluteValueOffset = dataTableOffset + valueOffset;

        if (absoluteKeyOffset >= dataTableOffset ||
            absoluteValueOffset > buffer.length || valueSize > buffer.length - absoluteValueOffset) {
            continue;
        }

        let keyEnd = buffer.indexOf(0, absoluteKeyOffset);
        if (keyEnd === -1 || keyEnd > dataTableOffset) keyEnd = dataTableOffset;
        const key = buffer.subarray(absoluteKeyOffset, keyEnd).toString("utf8");
        if (!key) continue;

        if (formatLe === 0x0204 || formatLe === 0x0402) {
            values[key] = decodeCString(buffer.subarray(absoluteValueOffset, absoluteValueOffset + valueSize));
        } else if (formatLe === 0x0404 && valueSize >= 4) {
            values[key] = buffer.readUInt32LE(absoluteValueOffset);
        }
    }
    return values;
}

function inspectPs4Pkg(pkgPath) {
    const stat = fs.statSync(pkgPath);
    if (!stat.isFile() || stat.size < HEADER_MIN_SIZE) {
        throw new Ps4PkgError("PS4 PKG header is truncated");
    }

    const fd = fs.openSync(pkgPath, "r");
    try {
        const header = readExactly(fd, 0, HEADER_MIN_SIZE, "PS4 PKG header");
        if (header.readUInt32BE(0) !== PS4_MAGIC) {
            throw new Ps4PkgError("not a PS4 CNT package", "NOT_PS4_PKG");
        }

        const entryCount = header.readUInt32BE(0x10);
        const duplicateEntryCount = header.readUInt16BE(0x16);
        const tableOffset = header.readUInt32BE(0x18);
        if (entryCount < 1 || entryCount > MAX_ENTRY_COUNT) {
            throw new Ps4PkgError(`invalid PS4 entry count: ${entryCount}`);
        }
        if (duplicateEntryCount !== 0 && duplicateEntryCount !== entryCount) {
            throw new Ps4PkgError("PS4 entry-count fields disagree");
        }
        if (tableOffset < HEADER_MIN_SIZE) {
            throw new Ps4PkgError("invalid PS4 entry-table offset");
        }

        const tableSize = entryCount * ENTRY_SIZE;
        checkedRange(tableOffset, tableSize, stat.size, "PS4 entry table");
        const table = readExactly(fd, tableOffset, tableSize, "PS4 entry table");
        const entries = new Map();

        for (let index = 0; index < entryCount; index++) {
            const offset = index * ENTRY_SIZE;
            const id = table.readUInt32BE(offset);
            const entry = {
                id,
                nameOffset: table.readUInt32BE(offset + 4),
                flags1: table.readUInt32BE(offset + 8),
                flags2: table.readUInt32BE(offset + 12),
                offset: table.readUInt32BE(offset + 16),
                size: table.readUInt32BE(offset + 20)
            };
            entry.encrypted = (entry.flags1 >>> 31) === 1;
            checkedRange(entry.offset, entry.size, stat.size, `PS4 entry 0x${id.toString(16)}`);
            if (entries.has(id)) {
                throw new Ps4PkgError(`duplicate PS4 entry 0x${id.toString(16)}`);
            }
            entries.set(id, entry);
        }

        const contentId = decodeCString(header.subarray(0x40, 0x64)) || null;
        let sfo = {};
        let metadataError = null;
        const sfoEntry = entries.get(PARAM_SFO_ID);
        if (sfoEntry && !sfoEntry.encrypted && sfoEntry.size > 0) {
            try {
                if (sfoEntry.size > MAX_METADATA_SIZE) {
                    throw new Ps4PkgError("param.sfo is unreasonably large", "INVALID_SFO");
                }
                sfo = parseSfo(readExactly(fd, sfoEntry.offset, sfoEntry.size, "param.sfo"));
            } catch (error) {
                metadataError = error.message;
            }
        }

        const effectiveContentId = sfo.CONTENT_ID || contentId;
        const titleMatch = effectiveContentId && effectiveContentId.match(/-(CUSA\d{5})/i);
        return {
            path: pkgPath,
            size: stat.size,
            pkgType: header.readUInt32BE(4),
            isFakePackage: (header.readUInt32BE(4) & 0x80000000) === 0,
            contentId: effectiveContentId,
            titleId: sfo.TITLE_ID || (titleMatch ? titleMatch[1].toUpperCase() : null),
            sfo,
            metadataError,
            entries,
            namesEntry: entries.get(ENTRY_NAMES_ID) || null,
            iconEntry: entries.get(ICON0_ID) || null
        };
    } finally {
        fs.closeSync(fd);
    }
}

function extractPs4Icon(pkg, destination, options = {}) {
    const icon = pkg.iconEntry;
    if (!icon || icon.size === 0) return { status: "missing" };
    if (icon.encrypted) return { status: "encrypted" };
    if (icon.size > MAX_ICON_SIZE) return { status: "invalid", reason: "icon0.png is unreasonably large" };
    if (!options.overwrite && fs.existsSync(destination)) return { status: "existing" };

    const fd = fs.openSync(pkg.path, "r");
    let temporaryPath;
    try {
        const data = readExactly(fd, icon.offset, icon.size, "icon0.png");
        if (data.length < PNG_SIGNATURE.length || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
            return { status: "invalid", reason: "icon0 entry is not a PNG" };
        }

        fs.mkdirSync(path.dirname(destination), { recursive: true });
        temporaryPath = `${destination}.tmp-${process.pid}`;
        fs.writeFileSync(temporaryPath, data, { mode: 0o644 });
        fs.renameSync(temporaryPath, destination);
        temporaryPath = null;
        return { status: "extracted", path: destination, size: data.length };
    } finally {
        fs.closeSync(fd);
        if (temporaryPath) {
            try { fs.unlinkSync(temporaryPath); } catch (_) {}
        }
    }
}

module.exports = {
    Ps4PkgError,
    inspectPs4Pkg,
    extractPs4Icon,
    parseSfo,
    constants: { PS4_MAGIC, PARAM_SFO_ID, ICON0_ID }
};
