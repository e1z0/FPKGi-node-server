const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { renderHomePage, renderLibraryPage } = require("../app/json-library-server");

test("hides internal metadata files from the category list", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "json-library-test-"));
    try {
        for (const file of ["games.json", "title-metadata.json", "title-metadata-overrides.json"]) {
            fs.writeFileSync(path.join(directory, file), "{}\n");
        }
        const html = renderHomePage("192.0.2.10:3000", directory);
        assert.match(html, /\/games/);
        assert.doesNotMatch(html, /title-metadata/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("library cards render optional descriptions as text", () => {
    const html = renderLibraryPage("games");
    assert.match(html, /game\.description/);
    assert.match(html, /description\.textContent = game\.description/);
});
