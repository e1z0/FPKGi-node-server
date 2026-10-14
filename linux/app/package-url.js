const path = require("path");

function encodePathSegments(relativePath) {
    return relativePath
        .split(/[\\/]+/)
        .filter(Boolean)
        .map(segment => encodeURIComponent(segment))
        .join("/");
}

function buildPackageUrl(serverAddress, baseDir, pkgPath) {
    const relativePath = path.relative(baseDir, pkgPath);
    const segments = relativePath.split(path.sep);

    if (!relativePath || path.isAbsolute(relativePath) || segments.includes("..")) {
        throw new Error(`PKG path is outside the configured scan directory: ${pkgPath}`);
    }

    return `http://${serverAddress}/pkg/${encodePathSegments(relativePath)}`;
}

module.exports = { buildPackageUrl, encodePathSegments };
