"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { freeMatches, lookup, cleanName, FONTS } = require("../skills/easyfontkit/scripts/lib/match");

const families = (matches) => matches.map((match) => match.family);

test("names: Fontsource's spelling when it lists the family, else without the words files add", () => {
  assert.equal(cleanName("Inter Medium"), "Inter");
  assert.equal(cleanName("Inter Semi Bold"), "Inter");
  assert.equal(cleanName("InterVariable"), "Inter");
  assert.equal(cleanName("SourceCodePro"), "Source Code Pro");
  assert.equal(cleanName("Archivo Black"), "Archivo Black", "a family of its own keeps its name");
  assert.equal(cleanName("Söhne VF"), "Söhne");
  assert.equal(cleanName("Lyon Text Web"), "Lyon Text");
  assert.equal(lookup("Söhne"), null);
  assert.equal(lookup("roboto").license, "OFL-1.1");
});

test("a name of a long run of capitals, as a page can give its font stack, is cleaned in a moment, where it took seconds for tens of thousands of them, and names keep their words", () => {
  const { words } = require("../skills/easyfontkit/scripts/lib/match");
  assert.deepEqual(words("HTMLParser"), ["HTML", "Parser"]);
  assert.deepEqual(words("GTAmericaMonoLC"), ["GT", "America", "Mono", "LC"]);
  assert.deepEqual(words("ABcDEf"), ["A", "Bc", "D", "Ef"]);
  assert.deepEqual(words("IBMPlexSans-Bold"), ["IBM", "Plex", "Sans", "Bold"]);
  for (const name of ["A".repeat(80_000), `${"A".repeat(80_000)}b`]) {
    const started = Date.now();
    cleanName(name);
    const took = Date.now() - started;
    assert.ok(took < 1_000, `${name.length} characters: ${took} ms`);
  }
});

test("well-known paid fonts get their hand-picked free matches, by any of their names", () => {
  assert.deepEqual(families(freeMatches({ names: ["Helvetica Neue"] })), ["Inter", "Arimo"]);
  assert.deepEqual(families(freeMatches({ names: ["SFMono-Regular"], category: "mono" })), ["JetBrains Mono", "IBM Plex Mono"]);
  assert.deepEqual(families(freeMatches({ names: ["acme-var", "Gotham SSm"] })), ["Montserrat"]);
  assert.match(freeMatches({ names: ["Arial"] })[0].basis, /metric-compatible/);
});

test("a heavy, narrow or wide cut gets no free font that keeps its family's widths, nor do the fonts after it in a stack, while other cuts keep their family's match", () => {
  const stack = (names, category = "sans") => freeMatches({ names, category, stack: true });
  // Arial Black keeps neither Arial's widths nor its line breaks, so Arimo
  // is not its match, also when Arial follows it as its fallback, and so
  // for Arial Narrow.
  for (const names of [["Arial Black", "sans-serif"], ["Arial Black", "Arial", "sans-serif"], ["Arial Black", "Arial Bold", "Arial"], ["Arial Narrow", "Arial", "sans-serif"]]) {
    assert.deepEqual(families(stack(names)), ["Inter"], names.join(", "));
    assert.match(stack(names)[0].basis, /could not be measured/);
  }
  assert.deepEqual(families(stack(["Times New Roman Condensed", "Times New Roman", "serif"], "serif")), ["Source Serif 4"]);
  // Helvetica's entry keeps Inter, a common substitute, and drops Arimo,
  // which keeps only Helvetica's own widths.
  for (const names of [["Helvetica Neue Black"], ["Helvetica Neue Black", "Helvetica Neue", "sans-serif"], ["Arial Black", "Helvetica", "sans-serif"], ["Helvetica Neue Condensed", "Helvetica Neue", "sans-serif"]]) {
    assert.deepEqual(families(stack(names)), ["Inter"], names.join(", "));
    assert.equal(stack(names)[0].basis, "a common substitute", names.join(", "));
  }
  // A file of it is measured instead.
  assert.match(freeMatches({ names: ["Arial Black"], metrics: { xHeight: 0.52, capHeight: 0.72, lowercaseWidth: 0.62 } })[0].basis, /^close in proportions/);
  assert.deepEqual(families(stack(["Arial Bold", "sans-serif"])), ["Arimo"]);
  assert.deepEqual(families(stack(["Times-Roman", "serif"], "serif")), ["Tinos"]);
  assert.deepEqual(families(stack(["Times New Roman Bold", "serif"], "serif")), ["Tinos"]);
  assert.deepEqual(families(stack(["Gotham Book", "sans-serif"])), ["Montserrat"]);
  assert.deepEqual(families(stack(["Segoe UI Semibold", "sans-serif"])), ["Noto Sans", "Open Sans"]);
  assert.deepEqual(families(stack(["Helvetica Light", "sans-serif"])), ["Inter", "Arimo"]);
  assert.deepEqual(families(stack(["SFMono-Regular", "monospace"], "mono")), ["JetBrains Mono", "IBM Plex Mono"]);
  assert.deepEqual(families(stack(["Courier New Bold", "monospace"], "mono")), ["Cousine"]);
  // A match that is only a common substitute holds for a heavy cut too.
  assert.deepEqual(families(stack(["Avenir Black", "sans-serif"])), ["Nunito Sans"]);
  // A free family a stack names after a cut is still the match itself.
  assert.deepEqual(families(stack(["Arial Narrow", "Roboto Condensed", "Arial"])), ["Roboto Condensed"]);
});

test("every hand-picked free font that keeps a family's widths is marked so, and an entry with others says why they were picked", () => {
  const { fonts } = require("../skills/easyfontkit/scripts/data/lookalikes.json");
  for (const entry of fonts) {
    const metric = entry.metric || [];
    for (const id of metric) assert.ok(entry.free.includes(id), `${entry.names[0]}: ${id}`);
    if (/metric-compatible|keeps .*widths/.test(entry.basis)) assert.ok(metric.length, `${entry.names[0]} keeps widths`);
    if (metric.length && entry.free.some((id) => !metric.includes(id))) assert.ok(entry.basisWithoutMetric, `${entry.names[0]} says why`);
  }
});

test("a font stack that names a free family is matched with that family", () => {
  assert.deepEqual(families(freeMatches({ names: ["-apple-system", "Segoe UI", "Roboto"], stack: true })), ["Inter"], "the system font comes first");
  assert.deepEqual(families(freeMatches({ names: ["Inter", "system-ui"], stack: true })), ["Inter"]);
  assert.doesNotMatch(freeMatches({ names: ["Inter"] })[0].basis, /stack names it/, "a font's own name is looked up only in a stack");
});

test("any other font is matched on its proportions, among text fonts of its kind", () => {
  const sans = freeMatches({ names: ["Acme Grotesk"], category: "sans", metrics: { xHeight: 0.523, capHeight: 0.718, lowercaseWidth: 0.507 } });
  assert.equal(sans.length, 3);
  for (const match of sans) {
    const font = FONTS.find((f) => f.id === match.id);
    assert.equal(font.category, "sans");
    assert.equal(font.script, "", `${match.family} is made for Latin first`);
    assert.equal(font.display, 0);
    assert.match(match.basis, /^close in proportions: x-height /);
    assert.ok(Math.abs(font.xHeight - 0.523) < 0.03, `${match.family} has a near x-height`);
  }
  const mono = freeMatches({ names: ["Acme Mono"], category: "mono", metrics: { xHeight: 0.518, capHeight: 0.68, lowercaseWidth: 0.6 } });
  for (const match of mono) assert.equal(FONTS.find((f) => f.id === match.id).monospace, 1);
  const serif = freeMatches({ names: ["Acme Text"], category: "serif", metrics: { xHeight: 0.47, capHeight: 0.664, lowercaseWidth: 0.491 } });
  for (const match of serif) assert.doesNotMatch(match.family, /Slab/, `${match.family} is not a slab serif`);
  for (const match of serif) assert.equal(FONTS.find((f) => f.id === match.id).slab, 0, `${match.family} is not filed as a slab serif`);
});

test("a font that cannot be measured gets a plain free font of its kind, and says so", () => {
  const [only] = freeMatches({ names: ["Acme Mono"], category: "mono" });
  assert.equal(only.family, "JetBrains Mono");
  assert.match(only.basis, /could not be measured/);
});
