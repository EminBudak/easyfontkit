"use strict";

// From a page scan to families, without a browser: scans are built here the
// way scan.js reports them.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { buildFamilies } = require("../skills/easyfontkit/scripts/lib/families");
const { describeFont } = require("../skills/easyfontkit/scripts/lib/sfnt");
const { interAs } = require("./helpers");

const PAGE = "https://www.acme.com/";

function file(url, names, fsType) {
  const buffer = interAs({ names, fsType });
  return { sha: crypto.createHash("sha1").update(buffer).update(url).digest("hex"), urls: [url], buffer, font: describeFont(buffer) };
}

function face(familyName, glyphs, stack, { custom = true, postScriptName = "", weight = "400" } = {}) {
  return { familyName, postScriptName, custom, glyphs, italicGlyphs: 0, weights: { [weight]: glyphs }, stacks: { [stack]: glyphs } };
}

const rule = (family, url) => ({ family, weight: "400", style: "normal", unicodeRange: "", urls: [url] });

test("files shipped under a stand-in name are told apart by the CSS that loads them", () => {
  const standIn = { 1: "TN Web Use Only", 6: "TN_Web_Use_Only", 8: "Acme Type" };
  const franklin = file("https://cdn.acme.com/fonts/franklin-700.woff2", standIn, 0x0004);
  const imperial = file("https://cdn.acme.com/fonts/imperial-400.woff2", standIn, 0x0004);
  const { roles, families } = buildFamilies({
    pageUrl: PAGE,
    roles: {
      heading: [face("TN Web Use Only", 120, "acme-franklin, helvetica, sans-serif", { postScriptName: "TN_Web_Use_Only", weight: "700" })],
      body: [face("TN Web Use Only", 400, "acme-imperial, georgia, serif", { postScriptName: "TN_Web_Use_Only" })],
    },
    files: [franklin, imperial],
    rules: [rule("acme-franklin", franklin.urls[0]), rule("acme-imperial", imperial.urls[0])],
    faces: [],
    loaded: [{ family: "acme-franklin" }, { family: "acme-imperial" }],
  });
  assert.equal(roles.heading.family, "acme-franklin");
  assert.equal(roles.body.family, "acme-imperial");
  assert.deepEqual(families.map((f) => f.files.length), [1, 1]);
  assert.equal(families[0].license.status, "commercial");
});

test("text a late web font left to a fallback counts as the web font, with a note", () => {
  const clean = file("https://use.typekit.net/af/abc/000/27/l", { 1: "Acme Clean", 8: "Acme Type" });
  const { roles, families, notes } = buildFamilies({
    pageUrl: PAGE,
    roles: {
      body: [face("Liberation Sans", 900, '"Acme Clean", acme-clean, "Trebuchet MS", sans-serif', { custom: false }), face("Acme Clean", 300, '"Acme Clean", acme-clean, sans-serif')],
      code: [face("DejaVu Sans Mono", 80, 'ui-monospace, "SF Mono", monospace', { custom: false })],
    },
    files: [clean],
    rules: [rule("acme-clean", clean.urls[0])],
    faces: [],
    loaded: [{ family: "acme-clean" }],
  });
  assert.equal(roles.body.family, "Acme Clean");
  assert.deepEqual(roles.body.also, [], "one family, not a system copy of it");
  assert.equal(families.find((f) => f.name === "Acme Clean").license.status, "commercial", "Adobe Fonts serves it");
  assert.deepEqual(notes, ["Some of the body text was drawn with Liberation Sans, a fallback, because Acme Clean loaded too late for it. That text is counted as Acme Clean, the font the site asks for."]);
  // A stack of system fonts only is the visitor's own font.
  assert.equal(roles.code.family, "System monospace font");
  assert.equal(families.find((f) => f.system).drawnWith, "DejaVu Sans Mono");
});

test("a font on the visitor's computer keeps the name the CSS asks for it by", () => {
  const { roles, families } = buildFamilies({
    pageUrl: PAGE,
    roles: {
      heading: [face("Liberation Sans", 120, '"Arial Black", sans-serif', { custom: false, weight: "900" })],
      body: [face("Liberation Serif", 400, '"Times New Roman", Times, serif', { custom: false })],
    },
    files: [],
    rules: [],
    faces: [],
    loaded: [],
  });
  assert.equal(roles.heading.family, "Arial Black");
  assert.equal(roles.body.family, "Times New Roman");
  const times = families.find((f) => f.name === "Times New Roman");
  assert.equal(times.category, "serif");
  assert.deepEqual(times.free.map((f) => f.family), ["Tinos"]);
  // Arial Black is its own name, not Arial: it does not borrow Arial's
  // metric-compatible match, which keeps Arial's line breaks and not its
  // own. With no entry of its own it gets the plain default.
  const black = families.find((f) => f.name === "Arial Black");
  assert.deepEqual(black.free.map((f) => f.family), ["Inter"]);
  assert.match(black.free[0].basis, /could not be measured/);
});
