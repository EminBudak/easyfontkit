"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { describeFont, glyphsOf } = require("../skills/easyfontkit/scripts/lib/sfnt");
const { fixture, interAs } = require("./helpers");

test("reads WOFF2 and WOFF alike: names, license link, embedding and the measurements", () => {
  const woff2 = describeFont(fixture("inter-latin-400.woff2"));
  const woff = describeFont(fixture("inter-latin-400.woff"));
  assert.equal(woff2.format, "woff2");
  assert.equal(woff.format, "woff");
  for (const font of [woff2, woff]) {
    assert.equal(font.family, "Inter");
    assert.equal(font.licenseUrl, "https://openfontlicense.org");
    assert.equal(font.embedding, "installable");
    assert.equal(font.monospace, false);
    assert.equal(font.weight, 400);
    assert.equal(font.xHeight, 0.546);
    assert.equal(font.capHeight, 0.728);
    assert.equal(font.lowercaseWidth, 0.536);
    assert.equal(font.vendorId, "RSMS");
  }
});

test("reads a TrueType file, its license text and a restricted embedding", () => {
  const font = describeFont(
    interAs({
      names: { 0: "Copyright 2026 Acme Type. All rights reserved.", 1: "Acme Sans", 2: "Regular", 6: "AcmeSans-Regular", 8: "Acme Type", 13: "Webfont sold by Acme Type, for use of the licensee only.", 14: "https://acme.example/license" },
      fsType: 0x0004,
    }),
  );
  assert.equal(font.format, "ttf");
  assert.equal(font.family, "Acme Sans");
  assert.equal(font.postscriptName, "AcmeSans-Regular");
  assert.equal(font.manufacturer, "Acme Type");
  assert.equal(font.license, "Webfont sold by Acme Type, for use of the licensee only.");
  assert.equal(font.embedding, "preview and print");
  assert.equal(font.lowercaseWidth, 0.536, "the measurements survive the rebuild");
});

test("a name a font hides on purpose is no name", () => {
  const font = describeFont(interAs({ names: { 1: ".\u007f", 2: "\u007f", 6: "\u007f", 8: "Acme Type" } }));
  assert.equal(font.family, "");
  assert.equal(font.postscriptName, "");
  assert.equal(font.hiddenNames, true);
  assert.equal(font.manufacturer, "Acme Type");
});

test("refuses what is not a font", () => {
  assert.throws(() => describeFont(Buffer.from("<html>not found</html>")), /not a font file/);
  assert.throws(() => describeFont(Buffer.alloc(4)), /too short/);
});

test("a font file cut short is said to be cut short or broken, in plain words and not in Node's own about offsets", () => {
  for (const font of [interAs(), fixture("inter-latin-400.woff"), fixture("inter-latin-400.woff2")]) {
    assert.throws(() => describeFont(font.subarray(0, 100)), { message: "cut short or broken: its tables run past its 100 bytes" });
  }
});

test("a font file's cmap says which characters it has glyphs for", () => {
  for (const font of [fixture("inter-latin-400.woff2"), fixture("inter-latin-400.woff"), interAs()]) {
    const has = glyphsOf(font);
    assert.deepEqual([..."Ag é"].map((c) => has(c.codePointAt(0))), [true, true, true, true]);
    assert.deepEqual([..."日本🌱"].map((c) => has(c.codePointAt(0))), [false, false, false]);
  }
  assert.equal(glyphsOf(Buffer.from("<html>not found</html>")), null);
});
