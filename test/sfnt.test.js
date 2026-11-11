"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { describeFont, glyphsOf } = require("../skills/easyfontkit/scripts/lib/sfnt");
const zlib = require("node:zlib");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { fixture, interAs, packedZeros, woff2With, woffWith } = require("./helpers");

// What `script` prints as JSON, run in a Node.js process of its own with the
// heap given, in megabytes, and killed after `seconds`: a test of what a
// file costs, which on code that has no bound would take minutes or all the
// memory there is, ends in that time and fails.
function measured(script, { heap = 256, seconds = 60 } = {}) {
  const setup = `const { describeFont, glyphsOf } = require(${JSON.stringify(path.resolve(__dirname, "../skills/easyfontkit/scripts/lib/sfnt"))});\nconst { interAs } = require(${JSON.stringify(path.join(__dirname, "helpers"))});\n`;
  const run = spawnSync(process.execPath, [`--max-old-space-size=${heap}`, "-e", setup + script], { encoding: "utf8", timeout: seconds * 1000 });
  assert.equal(run.status, 0, `${run.error || ""} ${run.signal || ""} ${run.stderr}`);
  return JSON.parse(run.stdout);
}

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

test("a font file cut short is said to be cut short or broken, in plain words and not in Node's own about offsets, also a TrueType file cut after its directory, which the browser refuses too", () => {
  for (const font of [interAs(), fixture("inter-latin-400.woff"), fixture("inter-latin-400.woff2")]) {
    assert.throws(() => describeFont(font.subarray(0, 100)), { message: "cut short or broken: its tables run past its 100 bytes" });
  }
  const ttf = interAs();
  for (const share of [0.95, 0.5]) {
    const cut = ttf.subarray(0, Math.floor(ttf.length * share));
    assert.throws(() => describeFont(cut), { message: `cut short or broken: its tables run past its ${cut.length} bytes` }, `cut at ${share}`);
  }
});

test("a font file whose packed tables are garbled, as by a bad server or a mangled upload, is said to be cut short or broken, not in zlib's or brotli's own words", () => {
  // The first bytes of each packed table of the WOFF, and some of the
  // brotli stream of the WOFF2, written over.
  const woff = Buffer.from(fixture("inter-latin-400.woff"));
  for (let i = 0; i < woff.readUInt16BE(12); i++) {
    const entry = 44 + i * 20;
    if (woff.readUInt32BE(entry + 8) < woff.readUInt32BE(entry + 12)) woff.fill(0xff, woff.readUInt32BE(entry + 4), woff.readUInt32BE(entry + 4) + 8);
  }
  const woff2 = Buffer.from(fixture("inter-latin-400.woff2"));
  woff2.fill(0x55, woff2.length - 2000, woff2.length - 1940);
  for (const font of [woff, woff2]) assert.throws(() => describeFont(font), { message: "cut short or broken: its tables cannot be unpacked" });
});

test("a font file whose tables would unpack to more than any web font, or to more than its own directory says, is not unpacked past that, and the process's memory stays low", async () => {
  // Files of a few hundred bytes to a few hundred kilobytes: two whose
  // directory says their table is 256 MB, and two that say 200 KB and
  // hold 128 MB.
  const over = [woff2With(256 * 1024 * 1024, await packedZeros(1, true)), woffWith(256 * 1024 * 1024, await packedZeros(1, false))];
  const more = [woff2With(200 * 1024, await packedZeros(128, true)), woffWith(200 * 1024, await packedZeros(128, false))];
  assert.ok(more.every((font) => font.length < 200 * 1024), "each holds far more than it is long");
  const before = process.resourceUsage().maxRSS;
  for (const font of over) assert.throws(() => describeFont(font), { message: "its tables would unpack to 256 MB, more than the 64 MB easyfontkit reads of one font file" });
  for (const font of more) assert.throws(() => describeFont(font), { message: "broken: its tables unpack to more than its directory says" });
  // In kilobytes: what 128 MB unpacked would have added.
  const grew = process.resourceUsage().maxRSS - before;
  assert.ok(grew < 64 * 1024, `the process grew by ${grew} KB at its peak`);
});

test("a font file is unpacked once: what says which characters it has glyphs for comes from the reading of its names and measurements", () => {
  const counted = { brotliDecompressSync: 0, inflateSync: 0 };
  const own = { brotliDecompressSync: zlib.brotliDecompressSync, inflateSync: zlib.inflateSync };
  for (const name of Object.keys(counted)) {
    zlib[name] = (...args) => {
      counted[name]++;
      return own[name](...args);
    };
  }
  try {
    for (const name of ["inter-latin-400.woff2", "inter-latin-400.woff"]) {
      const font = Buffer.from(fixture(name));
      describeFont(font);
      const unpacked = counted.brotliDecompressSync + counted.inflateSync;
      assert.ok(unpacked > 0, name);
      assert.equal(glyphsOf(font)("A".codePointAt(0)), true, name);
      assert.equal(counted.brotliDecompressSync + counted.inflateSync, unpacked, `${name}: not unpacked again`);
    }
  } finally {
    Object.assign(zlib, own);
  }
});

test("a font file whose cmap unpacks to more than the file itself is read, but its cmap is not kept for the glyph check, so many such files, as a page could serve, leave the process's memory as it was", async () => {
  // A cmap with one subtable, of format 4, which maps no character, then
  // 24 MB of zeros, in a WOFF2 file of a few kilobytes.
  const cmap = Buffer.alloc(36);
  cmap.writeUInt16BE(1, 2);
  cmap.writeUInt16BE(3, 4);
  cmap.writeUInt16BE(1, 6);
  cmap.writeUInt32BE(12, 8);
  for (const [at, value] of [[12, 4], [14, 24], [18, 2], [20, 2], [26, 0xffff], [30, 0xffff], [32, 1]]) cmap.writeUInt16BE(value, at);
  const font = woff2With(cmap.length + 24 * 1024 * 1024, await packedZeros(24, true, cmap), 0);
  assert.ok(font.length < 64 * 1024, `${font.length} bytes`);
  require("node:v8").setFlagsFromString("--expose-gc");
  const collect = require("node:vm").runInNewContext("gc");
  // What every buffer no longer held leaves, once V8 has swept them, which
  // it does a moment after it collects them.
  const held = async () => {
    for (let i = 0; i < 3; i++) {
      collect();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return process.memoryUsage().arrayBuffers;
  };
  const before = await held();
  // Kept, as the kit keeps the files a page loaded until the run ends.
  const kept = [];
  for (let i = 0; i < 8; i++) {
    const copy = Buffer.from(font);
    assert.equal(describeFont(copy).format, "woff2");
    assert.equal(glyphsOf(copy), null, "nothing to look up");
    kept.push(copy);
  }
  const grew = (await held()) - before;
  assert.ok(grew < 16 * 1024 * 1024, `${kept.length} files hold ${Math.round(grew / 1024 / 1024)} MB`);
});

test("a font file's cmap says which characters it has glyphs for", () => {
  for (const font of [fixture("inter-latin-400.woff2"), fixture("inter-latin-400.woff"), interAs()]) {
    const has = glyphsOf(font);
    assert.deepEqual([..."Ag é"].map((c) => has(c.codePointAt(0))), [true, true, true, true]);
    assert.deepEqual([..."日本🌱"].map((c) => has(c.codePointAt(0))), [false, false, false]);
  }
  assert.equal(glyphsOf(Buffer.from("<html>not found</html>")), null);
});

test("a font file's name table costs a run a moment and little memory however many records it has, as a page can serve one of 65535 records that each point at the same 64 KB in a file of a few kilobytes: only the names easyfontkit reads are decoded, a few times each at most, each kept to its first 2000 characters, and of the names Chrome can name a face by, 200 at most", () => {
  const result = measured(`
// 65535 records, each with a name ID of its own or all with ID 1 (the
// family), whose strings start where the records do, 64 KB long or 100
// bytes long at offsets of their own.
function names(count, { id, length, step = 0 }) {
  const table = Buffer.alloc(6 + count * 12);
  table.writeUInt16BE(count, 2);
  table.writeUInt16BE(6, 4);
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    table.writeUInt16BE(3, at);
    table.writeUInt16BE(1, at + 2);
    table.writeUInt16BE(0x409, at + 4);
    table.writeUInt16BE(id === undefined ? i : id, at + 6);
    table.writeUInt16BE(length, at + 8);
    table.writeUInt16BE((i * step) % 60000, at + 10);
  }
  return table;
}
const fonts = [interAs({ name: names(65535, { length: 65534 }) }), interAs({ name: names(65535, { id: 1, length: 100, step: 7 }) })];
const out = [];
for (const font of fonts) {
  global.gc && global.gc();
  const before = process.memoryUsage().heapUsed;
  const started = Date.now();
  const read = describeFont(font);
  out.push({ ms: Date.now() - started, heap: process.memoryUsage().heapUsed - before, names: read.names.length, license: read.license.length, copyright: read.copyright.length, kept: read });
}
console.log(JSON.stringify(out.map(({ kept, ...rest }) => rest)));
`);
  for (const [i, { ms, heap, names, license, copyright }] of result.entries()) {
    assert.ok(ms < 5_000, `font ${i}: ${ms} ms`);
    assert.ok(heap < 32 * 1024 * 1024, `font ${i}: the heap grew by ${Math.round(heap / 1024 / 1024)} MB`);
    assert.ok(names <= 200, `font ${i}: ${names} names kept`);
    assert.ok(license <= 2000 && copyright <= 2000, `font ${i}: a license of ${license} and a copyright of ${copyright} characters`);
  }
  assert.ok(result[0].license > 1000, "a long name keeps its first 2000 characters");
});
