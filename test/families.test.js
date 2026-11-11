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

// A face as readRole() reports it. A font of the visitor's own can carry
// the nodes it drew, each with the text Chrome counted there and how many
// glyphs the visitor's own fonts drew in it.
function face(familyName, glyphs, stack, { custom = true, postScriptName = "", weight = "400", nodes } = {}) {
  return { familyName, postScriptName, custom, glyphs, italicGlyphs: 0, weights: { [weight]: glyphs }, stacks: { [stack]: glyphs }, ...(nodes ? { nodes: nodes.map(([text, system]) => ({ text, length: text.length, system })) } : {}) };
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

test("text a web font has no glyphs for, as Japanese or an emoji in a Latin font, is said to be drawn with a fallback for that, and text it has glyphs for that a fallback drew is said to have come too late", () => {
  // Inter's latin file, which has no Japanese and no emoji, as Lato has
  // none: the glyph counts are those Chrome gave for these texts.
  const inter = file("https://www.acme.com/fonts/inter.ttf", { 1: "Acme Latin", 13: "This Font Software is licensed under the SIL Open Font License, Version 1.1." });
  const stack = '"Acme Latin", "Noto Sans CJK JP", sans-serif';
  const read = (roles) =>
    buildFamilies({ pageUrl: PAGE, roles, files: [inter], rules: [rule("Acme Latin", inter.urls[0])], faces: [], loaded: [{ family: "Acme Latin" }] });
  const lacking = (roles, fonts = "Noto Sans CJK JP, a fallback") => `Some of the ${roles} drawn with ${fonts}, as Acme Latin has no glyphs for those characters. That text is counted as Acme Latin, the font the site asks for.`;
  const late = (roles, fonts, them) => `Some of the ${roles} drawn with ${fonts}, because Acme Latin loaded too late for ${them}. That text is counted as Acme Latin, the font the site asks for.`;
  // Japanese text alone, and Japanese with Latin words the web font drew.
  const japanese = read({
    heading: [face("Noto Sans CJK JP", 16, stack, { custom: false, nodes: [["日本語の見出しです", 9], ["二つ目の見出し", 7]] })],
    body: [face("Noto Sans CJK JP", 10, stack, { custom: false, nodes: [["Body text と日本語の本文です。Latin words come first here.", 10]] }), face("Acme Latin", 36, stack)],
  });
  assert.equal(japanese.roles.heading.family, "Acme Latin");
  assert.deepEqual(japanese.notes, [lacking("headings and body text were")]);
  // An emoji in a heading, which the emoji font draws.
  const emoji = read({ heading: [face("Acme Latin", 6, '"Acme Latin", sans-serif'), face("Noto Color Emoji", 2, '"Acme Latin", sans-serif', { custom: false, nodes: [["🌱 Grow 🌿", 2]] })] });
  assert.deepEqual(emoji.notes, [lacking("headings were", "Noto Color Emoji, a fallback")]);
  // The same Latin words drawn by the fallback too, as when the web font
  // came too late: they were late, though the fallback that drew them also
  // drew the Japanese.
  const mixed = read({ heading: [face("Noto Sans CJK JP", 13, stack, { custom: false, nodes: [["Lato で書かれた見出し", 13]] })] });
  assert.deepEqual(mixed.notes, [late("headings were", "Noto Sans CJK JP, a fallback", "them")]);
  // Latin text alone, and text that was not read, as before.
  assert.deepEqual(read({ body: [face("Liberation Sans", 14, stack, { custom: false, nodes: [["A late heading", 14]] })] }).notes, [late("body text was", "Liberation Sans, a fallback", "it")]);
  assert.deepEqual(read({ body: [face("Liberation Sans", 14, stack, { custom: false })] }).notes, [late("body text was", "Liberation Sans, a fallback", "it")]);
  // A late fallback and one for characters the web font lacks in one role.
  const both = read({
    heading: [
      face("Liberation Sans", 40, stack, { custom: false, nodes: [["A late heading 日本", 16]] }),
      face("Noto Sans CJK JP", 30, stack, { custom: false, nodes: [["A late heading 日本", 16], ["日本語の見出しです", 9]] }),
    ],
  });
  assert.deepEqual(both.notes, [late("headings were", "Liberation Sans and Noto Sans CJK JP, fallbacks", "them")]);
  const apart = read({
    heading: [
      face("Liberation Sans", 40, stack, { custom: false, nodes: [["A late heading", 14]] }),
      face("Noto Color Emoji", 30, stack, { custom: false, nodes: [["Grow 🌱", 1]] }),
    ],
  });
  assert.deepEqual(apart.notes, [late("headings were", "Liberation Sans, a fallback", "them"), lacking("headings were", "Noto Color Emoji, a fallback")]);
  // A file's unicode-range keeps the characters outside it from it, as the
  // browser does.
  const ranged = buildFamilies({
    pageUrl: PAGE,
    roles: { heading: [face("Liberation Sans", 2, '"Acme Latin", sans-serif', { custom: false, nodes: [["Grow é", 2]] }), face("Acme Latin", 5, '"Acme Latin", sans-serif')] },
    files: [inter],
    rules: [{ ...rule("Acme Latin", inter.urls[0]), unicodeRange: "U+0000-007F" }],
    faces: [],
    loaded: [{ family: "Acme Latin" }],
  });
  assert.deepEqual(ranged.notes, ["Some of the headings were drawn with Liberation Sans, a fallback, as Acme Latin has no glyphs for those characters. That text is counted as Acme Latin, the font the site asks for."]);
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

test("text whose stack asks for a font of the visitor's own before a web font whose file did not load is that font's, with no note, though other text made the browser ask for the web font's file", () => {
  const slow = "https://www.acme.com/fonts/slowpoke.woff2";
  const read = (stack) =>
    buildFamilies({
      pageUrl: PAGE,
      roles: { heading: [face("Liberation Sans", 120, stack, { custom: false, weight: "800" })] },
      files: [],
      // A family for characters the text does not use, whose file the
      // browser does not ask for.
      rules: [rule("Slowpoke", slow), { ...rule("Slowpoke Cyrillic", "https://www.acme.com/fonts/slowpoke-cyrillic.woff2"), unicodeRange: "U+0400-04FF" }],
      faces: [],
      loaded: [],
      // Asked for by other text, whose stack names Slowpoke first.
      asked: [slow],
    });
  // Arial is no web font of the page's: the text was drawn with it, here as
  // Liberation Sans, and Slowpoke's file has nothing to do with it.
  const { roles, families, notes } = read('Arial, "Slowpoke", serif');
  assert.equal(roles.heading.family, "Arial");
  assert.deepEqual(roles.heading.weights, [800]);
  assert.equal(families.length, 1);
  const [arial] = families;
  assert.deepEqual([arial.name, arial.system, arial.license.status, arial.drawnWith], ["Arial", true, "system", "Liberation Sans"]);
  assert.equal("notLoaded" in arial, false);
  assert.equal(arial.free[0].family, "Arimo");
  assert.deepEqual(notes, []);
  // A family of the page's whose file the browser did not ask for is gone
  // past, as the browser goes past it, to the web font whose file did not
  // load.
  const past = read('"Slowpoke Cyrillic", "Slowpoke", serif');
  assert.equal(past.roles.heading.family, "Slowpoke");
  assert.deepEqual(past.families.map((f) => [f.name, f.system, f.notLoaded]), [["Slowpoke", false, [slow]]]);
  assert.equal(past.notes.length, 1);
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
