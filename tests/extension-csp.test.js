const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const extensionRoot = path.join(__dirname, "..", "src", "extension");
const manifest = JSON.parse(
  fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8")
);
const popupHtml = fs.readFileSync(
  path.join(extensionRoot, "popup.html"),
  "utf8"
);

test("popup assets comply with the extension CSP", () => {
  const policy = manifest.content_security_policy.extension_pages;

  assert.doesNotMatch(policy, /'unsafe-inline'/);
  assert.match(popupHtml, /<link rel="stylesheet" href="popup\.css">/);
  assert.doesNotMatch(popupHtml, /<style(?:\s|>)/i);
  assert.doesNotMatch(popupHtml, /\sstyle\s*=/i);
  assert.equal(fs.existsSync(path.join(extensionRoot, "popup.css")), true);
});
