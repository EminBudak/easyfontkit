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

test("the note on text a late web font left to a fallback agrees with the roles and the fallbacks it names", () => {
  const clean = file("https://use.typekit.net/af/abc/000/27/l", { 1: "Acme Clean", 8: "Acme Type" });
  const note = (roles) =>
    buildFamilies({
      pageUrl: PAGE,
      roles: Object.fromEntries(roles.map((role) => [role, [face("Liberation Sans", 100, '"Acme Clean", acme-clean, sans-serif', { custom: false })]])),
      files: [clean],
      rules: [rule("acme-clean", clean.urls[0])],
      faces: [],
      loaded: [{ family: "acme-clean" }],
    }).notes;
  const late = (roles, verb, them) => [`Some of the ${roles} ${verb} drawn with Liberation Sans, a fallback, because Acme Clean loaded too late for ${them}. That text is counted as Acme Clean, the font the site asks for.`];
  assert.deepEqual(note(["heading"]), late("headings", "were", "them"));
  assert.deepEqual(note(["button"]), late("buttons", "were", "them"));
  assert.deepEqual(note(["body"]), late("body text", "was", "it"));
  assert.deepEqual(note(["code"]), late("code", "was", "it"));
  assert.deepEqual(note(["body", "code"]), late("body text and code", "were", "them"));
  assert.deepEqual(note(["heading", "body", "button"]), late("headings, body text and buttons", "were", "them"));
  // Text drawn with two fallbacks names them both as fallbacks.
  const stack = '"Acme Clean", acme-clean, sans-serif';
  const two = buildFamilies({
    pageUrl: PAGE,
    roles: { heading: [face("Liberation Sans", 100, stack, { custom: false }), face("DejaVu Sans", 60, stack, { custom: false })] },
    files: [clean],
    rules: [rule("acme-clean", clean.urls[0])],
    faces: [],
    loaded: [{ family: "acme-clean" }],
  }).notes;
  assert.deepEqual(two, ["Some of the headings were drawn with Liberation Sans and DejaVu Sans, fallbacks, because Acme Clean loaded too late for them. That text is counted as Acme Clean, the font the site asks for."]);
});

test("a web font whose file the browser asked for and did not get while the page was read is named as the CSS names it, with the file's address, an unknown license and a note, and is not taken for a font of the visitor's own", () => {
  const slow = "https://www.acme.com/fonts/slowpoke.woff2";
  const read = (asked, skipped = []) =>
    buildFamilies({
      pageUrl: PAGE,
      roles: { heading: [face("Liberation Serif", 120, "Slowpoke, Georgia, serif", { custom: false, weight: "800" })] },
      files: [],
      // A file for characters the text does not use, which the browser does
      // not ask for.
      rules: [rule("Slowpoke", `${slow}#v1`), { ...rule("Slowpoke", "https://www.acme.com/fonts/slowpoke-cyrillic.woff2"), unicodeRange: "U+0400-04FF" }],
      faces: [],
      loaded: [],
      asked,
      skipped,
    });
  const { roles, families, notes } = read([slow]);
  assert.equal(roles.heading.family, "Slowpoke");
  assert.deepEqual(roles.heading.weights, [800]);
  assert.equal(families.length, 1);
  const [slowpoke] = families;
  assert.equal(slowpoke.system, false);
  assert.equal(slowpoke.missing, false);
  assert.deepEqual(slowpoke.notLoaded, [slow], "the file the browser asked for alone");
  assert.deepEqual(slowpoke.files, []);
  assert.deepEqual([slowpoke.license.status, slowpoke.license.basis], ["unknown", "its file did not load while the page was read, so nothing in it could be read"]);
  assert.deepEqual([slowpoke.source, slowpoke.host], ["self-hosted", "www.acme.com"]);
  assert.equal(slowpoke.category, "serif");
  assert.deepEqual(notes, [`Some of the headings were drawn with Liberation Serif, a fallback, because Slowpoke's file ${slow} did not load while the page was read. That text is counted as Slowpoke, the font the site asks for. The kit has no file of it, so its license is unknown: try again later.`]);
  // A file whose server answered, with an error or with no font, has a note
  // of its own that says why, and trying again later is not offered for it.
  assert.deepEqual(read([slow], [{ url: slow, reason: "the server answered 404" }]).notes, [
    `Some of the headings were drawn with Liberation Serif, a fallback, because Slowpoke's file ${slow} did not load while the page was read. That text is counted as Slowpoke, the font the site asks for. The kit has no file of it, so its license is unknown.`,
  ]);
  // Matched by its stack, as when it was taken for a font of the visitor's
  // own: Georgia's match.
  const before = read([]);
  assert.deepEqual(slowpoke.free.map((f) => f.family), before.families[0].free.map((f) => f.family));
  // A family whose files the browser never asked for is the visitor's own
  // font, as before.
  assert.equal(before.families[0].system, true);
  assert.equal(before.families[0].name, "Slowpoke");
  assert.equal("notLoaded" in before.families[0], false);
  assert.deepEqual(before.notes, []);
});

test("a font on the visitor's computer keeps the name the CSS asks for it by", () => {
  const { roles, families } = buildFamilies({
    pageUrl: PAGE,
    roles: {
      heading: [face("Liberation Sans", 120, '"Arial Black", Arial, sans-serif', { custom: false, weight: "900" })],
      body: [face("Liberation Serif", 400, '"Times New Roman", Times, serif', { custom: false })],
      button: [face("Liberation Sans", 60, '"Arial Bold", Arial, sans-serif', { custom: false, weight: "700" })],
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
  // own, also when Arial follows it in the stack. With no other match it
  // gets the plain default. Arial Bold is Arial, and keeps it.
  const black = families.find((f) => f.name === "Arial Black");
  assert.deepEqual(black.free.map((f) => f.family), ["Inter"]);
  assert.match(black.free[0].basis, /could not be measured/);
  assert.equal(roles.button.family, "Arial Bold");
  const bold = families.find((f) => f.name === "Arial Bold");
  assert.deepEqual(bold.free.map((f) => f.family), ["Arimo"]);
  assert.match(bold.free[0].basis, /^metric-compatible with Arial/);
});

test("a font on the visitor's computer that the CSS names as one word, like a PostScript name, is named and grouped as its family", () => {
  // Bootstrap's code stack, and a heading cut named next to its family.
  const { roles, families } = buildFamilies({
    pageUrl: PAGE,
    roles: {
      heading: [face("Liberation Sans", 120, '"HelveticaNeue-Bold", "Helvetica Neue", Helvetica, Arial, sans-serif', { custom: false, weight: "700" })],
      body: [face("Liberation Sans", 400, '"Helvetica Neue", Helvetica, Arial, sans-serif', { custom: false })],
      code: [face("DejaVu Sans Mono", 80, 'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace', { custom: false })],
    },
    files: [],
    rules: [],
    faces: [],
    loaded: [],
  });
  assert.equal(roles.heading.family, "Helvetica Neue");
  assert.equal(roles.heading.key, roles.body.key, "the heading cut is one family with the body's");
  assert.equal(roles.code.family, "SF Mono");
  assert.deepEqual(families.map((f) => f.name), ["Helvetica Neue", "SF Mono"]);
  assert.deepEqual(families[1].free.map((f) => f.family), ["JetBrains Mono", "IBM Plex Mono"]);
});

test("a heavy cut the CSS names as one word, like Arial-Black, is a family of its own, and the free match of each family does not hang on the order of the roles", () => {
  const read = (heading, body) =>
    buildFamilies({
      pageUrl: PAGE,
      roles: {
        heading: [face("Liberation Sans", 120, heading, { custom: false, weight: "700" })],
        body: [face("Liberation Sans", 400, body, { custom: false })],
      },
      files: [],
      rules: [],
      faces: [],
      loaded: [],
    });
  const match = ({ families }, name) => families.find((f) => f.name === name).free.map((f) => f.family);
  for (const [heading, body, names] of [
    ["Arial-Black, sans-serif", "Arial, sans-serif", ["Arial Black", "Arial"]],
    ["Arial, sans-serif", "Arial-Black, sans-serif", ["Arial", "Arial Black"]],
    ["Arial-BlackItalic, sans-serif", "Arial, sans-serif", ["Arial Black", "Arial"]],
  ]) {
    const kit = read(heading, body);
    assert.deepEqual([kit.roles.heading.family, kit.roles.body.family], names, `${heading} over ${body}`);
    assert.deepEqual(match(kit, "Arial"), ["Arimo"], `plain Arial keeps its metric match: ${heading} over ${body}`);
    assert.deepEqual(match(kit, "Arial Black"), ["Inter"], `Arial Black does not take Arial's: ${heading} over ${body}`);
  }
  // A heavy cut in one role's stack does not reach the names of another
  // role's stack: Helvetica in the body's stack follows no cut there.
  const kit = read('"Acme Display", "Arial Black", sans-serif', '"Acme Display", Helvetica, sans-serif');
  assert.equal(kit.roles.heading.key, kit.roles.body.key);
  assert.deepEqual(match(kit, "Acme Display"), ["Inter", "Arimo"]);
  // A cut that is no heavy weight still goes with its family.
  assert.equal(read('"HelveticaNeue-Bold", Helvetica, sans-serif', '"Helvetica Neue", sans-serif').roles.heading.family, "Helvetica Neue");
  assert.equal(read("HelveticaNeue-Black, sans-serif", '"Helvetica Neue", sans-serif').roles.heading.family, "Helvetica Neue Black");
});
