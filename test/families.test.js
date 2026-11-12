"use strict";

// From a page scan to families, without a browser: scans are built here the
// way scan.js reports them.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildFamilies } = require("../skills/easyfontkit/scripts/lib/families");
const { describeFont } = require("../skills/easyfontkit/scripts/lib/sfnt");
const { setTimeLimit } = require("../skills/easyfontkit/scripts/lib/time");
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

test("text a fallback drew in characters that a file of the web font's for them, which had not come while the page was read, covers by its unicode-range, as a family split into latin and latin-ext or into Cyrillic, is said to have waited for that file, not to lack glyphs; characters no rule of the family covers still lack them, and an input button whose label was not read does not change that", () => {
  // Inter's latin file, as the family's file for U+0000-00FF, which was
  // read, and the family's other files, for latin-ext and for Cyrillic,
  // which the browser asked for and had not got.
  const latin = file("https://www.acme.com/fonts/latin.ttf", { 1: "Acme Latin", 13: "This Font Software is licensed under the SIL Open Font License, Version 1.1." });
  const ext = "https://www.acme.com/fonts/latin-ext.ttf";
  const cyrillic = "https://www.acme.com/fonts/cyrillic.ttf";
  const stack = '"Acme Latin", sans-serif';
  const rules = [
    { ...rule("Acme Latin", latin.urls[0]), unicodeRange: "U+0000-00FF" },
    { ...rule("Acme Latin", ext), unicodeRange: "U+0100-024F" },
    { ...rule("Acme Latin", cyrillic), unicodeRange: "U+0400-04FF" },
  ];
  const read = (roles, { asked = [latin.urls[0], ext, cyrillic], skipped = [] } = {}) => buildFamilies({ pageUrl: PAGE, roles, files: [latin], rules, faces: [], loaded: [{ family: "Acme Latin" }], asked, skipped });
  const polish = { heading: [face("Liberation Sans", 9, stack, { custom: false, nodes: [["Zażółć gęślą jaźń", 9]] }), face("Acme Latin", 8, stack)] };
  const waited = (urls, end = ": try again later") => `Some of the headings were drawn with Liberation Sans, a fallback, because Acme Latin's ${urls.length === 1 ? "file" : "files"} ${urls.join(" and ")} did not load while the page was read. That text is counted as Acme Latin, the font the site asks for. The kit has no file of it for those characters${end}.`;
  assert.deepEqual(read(polish).notes, [waited([ext])]);
  assert.deepEqual(read({ heading: [face("Liberation Sans", 10, stack, { custom: false, nodes: [["Hello Привет мир", 10]] }), face("Acme Latin", 5, stack)] }).notes, [waited([cyrillic])]);
  // One whose server answered with an error has a note of its own, and a
  // later run gets the same answer.
  assert.deepEqual(read(polish, { skipped: [{ url: ext, reason: "the server answered 503" }] }).notes, [waited([ext], "")]);
  // One that came and was not a usable font file, which another run gets
  // too.
  assert.deepEqual(read(polish, { skipped: [{ url: ext, reason: "not a font file" }] }).notes, [
    `Some of the headings were drawn with Liberation Sans, a fallback, because Acme Latin's file ${ext} was not a usable font file. That text is counted as Acme Latin, the font the site asks for. The kit has no file of it for those characters.`,
  ]);
  // A rule whose file the browser never asked for takes nothing, as the
  // browser asks for a file once the text needs it.
  const lacking = "Some of the headings were drawn with Liberation Sans, a fallback, as Acme Latin has no glyphs for those characters. That text is counted as Acme Latin, the font the site asks for.";
  assert.deepEqual(read(polish, { asked: [latin.urls[0]] }).notes, [lacking]);
  // Japanese, which no rule of the family covers, as on a page whose
  // latin-ext file had not come either.
  const japanese = (nodes) => read({ button: [face("Noto Sans CJK JP", 12, '"Acme Latin", "Noto Sans CJK JP", sans-serif', { custom: false, nodes })] }).notes;
  const buttons = ["Some of the buttons were drawn with Noto Sans CJK JP, a fallback, as Acme Latin has no glyphs for those characters. That text is counted as Acme Latin, the font the site asks for."];
  assert.deepEqual(japanese([["送信する", 4], ["次へ", 2]]), buttons);
  // An input button whose label the kit could not read, as one whose label
  // is the browser's own, among buttons whose labels it read.
  assert.deepEqual(japanese([["送信する", 4], ["次へ", 2], ["", 6]]), buttons);
  // With no label read at all, nothing tells, and the note is as before.
  assert.deepEqual(japanese([["", 6]]), ["Some of the buttons were drawn with Noto Sans CJK JP, a fallback, because Acme Latin loaded too late for them. That text is counted as Acme Latin, the font the site asks for."]);
});

test("text a fallback drew because the browser refused the web font's file to the page's @font-face rule, a file the kit read from another request, is said to be so, and not to have come too late", () => {
  const far = file("http://cdn.example/far.ttf", { 1: "Far Sans" });
  const { roles, families, notes } = buildFamilies({
    pageUrl: PAGE,
    roles: { heading: [face("Liberation Serif", 20, '"Far Font", serif', { custom: false, weight: "800", nodes: [["A heading", 20]] })] },
    files: [far],
    rules: [rule("Far Font", far.urls[0])],
    faces: [],
    loaded: [],
    refusedRead: [{ url: far.urls[0], why: "CORS error: MissingAllowOriginHeader" }],
  });
  assert.equal(roles.heading.family, "Far Sans");
  assert.equal(families[0].files.length, 1, "the file is in the kit");
  assert.deepEqual(notes, [
    "Some of the headings were drawn with Liberation Serif, a fallback, because the browser refused Far Sans's file http://cdn.example/far.ttf to the page's @font-face rule (CORS error: MissingAllowOriginHeader), as it does on every visit. That text is counted as Far Sans, the font the site asks for. The kit has that file from another request the page made for it, such as a preload without crossorigin.",
  ]);
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

test("a web font whose file easyfontkit did not read, as the page's font files came to more than a run keeps or the file to more than it reads of one, is named as the CSS names it, with an unknown license that says why and a note that does not say the file did not load or offer another try, also when Chrome drew with it, a font given as a data: address by its label, and a file of a split family for those characters", () => {
  const { UNREAD } = require("../skills/easyfontkit/scripts/lib/limits");
  const big = "https://www.acme.com/big/10.ttf";
  const unread = (url, why, label = url) => ({ url, label, why, reason: UNREAD[why][0] });
  // The browser loaded the file, and drew the text with a fallback, as for a
  // file that is no usable font.
  const fallback = buildFamilies({
    pageUrl: PAGE,
    roles: { body: [face("Liberation Serif", 300, "B10, serif", { custom: false })] },
    files: [],
    rules: [rule("B10", big)],
    faces: [],
    loaded: [],
    asked: [big],
    unread: [unread(big, "budget")],
  });
  assert.equal(fallback.roles.body.family, "B10");
  const [b10] = fallback.families;
  assert.deepEqual([b10.system, b10.missing, "notLoaded" in b10, b10.notRead], [false, false, false, [big]]);
  assert.deepEqual([b10.license.status, b10.license.basis], ["unknown", "its file was not read, as the page's font files came to more than the 200 MB easyfontkit reads of one page"]);
  assert.deepEqual(fallback.notes, [`Some of the body text was drawn with Liberation Serif, a fallback, in place of B10, whose file ${big} was not read, as the page's font files came to more than the 200 MB easyfontkit reads of one page. That text is counted as B10, the font the site asks for. The kit has no file of it, so its license is unknown.`]);
  // Chrome drew with it, a file larger than a run reads of one.
  const drawn = buildFamilies({
    pageUrl: PAGE,
    roles: { heading: [face("B10", 120, "B10, serif")] },
    files: [],
    rules: [rule("B10", big)],
    faces: [{ family: "B10", src: big, platformFamily: "B10" }],
    loaded: [{ family: "B10" }],
    asked: [big],
    unread: [unread(big, "big")],
  });
  assert.deepEqual(drawn.families.map((f) => [f.name, f.missing, f.notRead, f.license.basis]), [["B10", false, [big], "its file was not read, as it is larger than the 64 MB easyfontkit reads of one font file"]]);
  assert.deepEqual(drawn.notes, []);
  // A font given as a data: address, known by its key, which Chrome drew
  // with under another name, as the CSS object model gives no address.
  const key = "data:sha1,0123456789abcdef0123456789abcdef01234567";
  const label = "a font the page gave as a data: address (font/woff2, 3 MB)";
  const inline = buildFamilies({
    pageUrl: PAGE,
    roles: { heading: [face("Inl Display", 100, "Inl, sans-serif")] },
    files: [],
    rules: [rule("Inl", "data:sha1,ffffffffffffffffffffffffffffffffffffffff")],
    faces: [{ family: "Inl", src: key, platformFamily: "Inl Display" }],
    loaded: [],
    asked: [],
    unread: [unread(key, "budget", label)],
  });
  assert.deepEqual(inline.families.map((f) => [f.name, f.notRead, f.source]), [["Inl", [label], "inline"]]);
  // A file of a split family, for the characters the fallback drew.
  const latin = file("https://www.acme.com/fonts/latin.ttf", { 1: "Acme Latin", 13: "This Font Software is licensed under the SIL Open Font License, Version 1.1." });
  const ext = "https://www.acme.com/fonts/latin-ext.ttf";
  const stack = '"Acme Latin", sans-serif';
  const split = buildFamilies({
    pageUrl: PAGE,
    roles: { heading: [face("Liberation Sans", 9, stack, { custom: false, nodes: [["Zażółć gęślą jaźń", 9]] }), face("Acme Latin", 8, stack)] },
    files: [latin],
    rules: [
      { ...rule("Acme Latin", latin.urls[0]), unicodeRange: "U+0000-00FF" },
      { ...rule("Acme Latin", ext), unicodeRange: "U+0100-024F" },
    ],
    faces: [],
    loaded: [{ family: "Acme Latin" }],
    asked: [latin.urls[0], ext],
    unread: [unread(ext, "budget")],
  });
  assert.deepEqual(split.notes, [`Some of the headings were drawn with Liberation Sans, a fallback, in place of Acme Latin, whose file ${ext} was not read, as the page's font files came to more than the 200 MB easyfontkit reads of one page. That text is counted as Acme Latin, the font the site asks for. The kit has no file of it for those characters.`]);
  // One file that did not load and one that was not read.
  const slow = "https://www.acme.com/fonts/b10-italic.ttf";
  const both = buildFamilies({
    pageUrl: PAGE,
    roles: { body: [face("Liberation Serif", 300, "B10, serif", { custom: false })] },
    files: [],
    rules: [rule("B10", big), rule("B10", slow)],
    faces: [],
    loaded: [],
    asked: [big, slow],
    unread: [unread(big, "budget")],
  });
  assert.deepEqual([both.families[0].notLoaded, both.families[0].notRead, both.families[0].license.basis], [[slow], [big], "its file did not load while the page was read, so nothing in it could be read"]);
  assert.deepEqual(both.notes, [`Some of the body text was drawn with Liberation Serif, a fallback, because B10's file ${slow} did not load while the page was read, and its file ${big} was not read, as the page's font files came to more than the 200 MB easyfontkit reads of one page. That text is counted as B10, the font the site asks for. The kit has no file of it, so its license is unknown: try again later.`]);
});

test("a web font given as a data: address that the browser asked for and could not use is named as the CSS names it, not taken for a font of the visitor's own, and the notes name its file by its label", () => {
  const key = "data:sha1,0123456789abcdef0123456789abcdef01234567";
  const label = "a font the page gave as a data: address (font/ttf, 3 MB)";
  const { roles, families, notes } = buildFamilies({
    pageUrl: PAGE,
    roles: { body: [face("Liberation Serif", 300, "I10, serif", { custom: false })] },
    files: [],
    rules: [rule("I10", key)],
    faces: [],
    loaded: [],
    asked: [key],
    labels: new Map([[key, label]]),
    skipped: [{ url: key, label, reason: "not a font file" }],
  });
  assert.equal(roles.body.family, "I10");
  assert.deepEqual(families.map((f) => [f.name, f.system, "notLoaded" in f, f.notUsable, f.source]), [["I10", false, false, [label], "inline"]]);
  assert.deepEqual(notes, [`Some of the body text was drawn with Liberation Serif, a fallback, because I10's file, ${label}, was not a usable font file. That text is counted as I10, the font the site asks for. The kit has no file of it, so its license is unknown.`]);
});

test("a web font whose file came and was not a usable font file, as a page a server sent with 200 in a font's place, an empty file or one cut short, is said to have a file that was not a usable font file, in its note, its license and fonts.json, where they said the file did not load while the page was read; one the server answered with an error, or the browser refused, did not load", () => {
  const junk = "https://www.acme.com/fonts/junk.woff2";
  const slow = "https://www.acme.com/fonts/slow.woff2";
  const read = (skipped, urls = [junk]) =>
    buildFamilies({
      pageUrl: PAGE,
      roles: { heading: [face("Liberation Serif", 120, '"Net Junk", serif', { custom: false, weight: "700" })] },
      files: [],
      rules: urls.map((url) => rule("Net Junk", url)),
      faces: [],
      loaded: [],
      asked: urls,
      skipped,
    });
  const unusable = (end) => `Some of the headings were drawn with Liberation Serif, a fallback, because Net Junk's file ${junk} was not a usable font file. That text is counted as Net Junk, the font the site asks for. The kit has no file of it${end}.`;
  for (const reason of ["not a font file", "the server sent an empty file", "cut short or broken: its tables run past its 100 bytes"]) {
    const { roles, families, notes } = read([{ url: junk, label: junk, reason }]);
    assert.equal(roles.heading.family, "Net Junk", reason);
    assert.deepEqual(
      families.map((f) => [f.system, "notLoaded" in f, f.notUsable, f.license.status, f.license.basis]),
      [[false, false, [junk], "unknown", "its file was not a usable font file, so nothing in it could be read"]],
      reason,
    );
    assert.deepEqual(notes, [unusable(", so its license is unknown")], reason);
  }
  // A file the server answered with an error, or the browser refused, did
  // not load, as before.
  for (const reason of ["the server answered 404", "the browser refused it (CORS error: MissingAllowOriginHeader)"]) {
    const { families, notes } = read([{ url: junk, label: junk, reason }]);
    assert.deepEqual(
      families.map((f) => [f.notLoaded, "notUsable" in f, f.license.basis]),
      [[[junk], false, "its file did not load while the page was read, so nothing in it could be read"]],
      reason,
    );
    assert.deepEqual(notes, [`Some of the headings were drawn with Liberation Serif, a fallback, because Net Junk's file ${junk} did not load while the page was read. That text is counted as Net Junk, the font the site asks for. The kit has no file of it, so its license is unknown.`], reason);
  }
  // One file that did not load and one that was not usable.
  const both = read([{ url: junk, label: junk, reason: "not a font file" }], [slow, junk]);
  assert.deepEqual(
    both.families.map((f) => [f.notLoaded, f.notUsable, f.license.basis]),
    [[[slow], [junk], "its file did not load while the page was read, so nothing in it could be read"]],
  );
  assert.deepEqual(both.notes, [`Some of the headings were drawn with Liberation Serif, a fallback, because Net Junk's file ${slow} did not load while the page was read, and its file ${junk} was not a usable font file. That text is counted as Net Junk, the font the site asks for. The kit has no file of it, so its license is unknown: try again later.`]);
});

test("a long stack of families costs a moment, also when it names the same families over and over or in other cases, where each name looked through every @font-face rule of the page and every font file read: 3000 names the rules declare and whose files the browser never asked for, among 100000 rules, took 11 s", () => {
  const names = Array.from({ length: 3000 }, (_, i) => `F${i}`);
  const declared = (families, count) => Array.from({ length: count }, (_, i) => ({ ...rule(families[i % families.length], `https://www.acme.com/f${i}.woff2`), unicodeRange: "U+E000" }));
  // Body text drawn with a font of the visitor's own, and headings with a
  // web font no file read is named after.
  const read = (stack, rules, files = []) =>
    buildFamilies({
      pageUrl: PAGE,
      roles: { body: [face("DejaVu Serif", 100, `${stack.join(", ")}, serif`, { custom: false })], heading: [face("Mystery", 100, `${stack.join(", ")}, serif`)] },
      files,
      rules,
      faces: [],
      loaded: [],
      asked: [],
    });
  // One family in 16384 spellings.
  const spellings = Array.from({ length: 1 << 14 }, (_, i) => [..."abcdefghijklmn"].map((letter, at) => (i & (1 << at) ? letter.toUpperCase() : letter)).join(""));
  // 2000 font files read, each under a family of its own the stack does not
  // name.
  const buffer = interAs();
  const font = describeFont(buffer);
  const files = Array.from({ length: 2000 }, (_, i) => ({ sha: `s${i}`, urls: [`https://www.acme.com/w${i}.woff2`], buffer, font }));
  for (const [what, stack, rules, read2000] of [
    ["3000 names", names, declared(names, 100_000)],
    ["10 names over and over", Array.from({ length: 100_000 }, (_, i) => names[i % 10]), declared(names.slice(0, 10), 60_000)],
    ["one name in 16384 spellings", spellings, declared(["abcdefghijklmn"], 60_000)],
    ["50000 names and 2000 files", Array.from({ length: 50_000 }, (_, i) => `N${i}`), files.map((file, i) => rule(`W${i}`, file.urls[0])), files],
  ]) {
    const started = Date.now();
    const { roles, families } = read(stack, rules, read2000);
    const took = Date.now() - started;
    // The body text was drawn with a font of the visitor's own, as the
    // browser went past every family it never asked for a file of, and the
    // headings with a web font whose file was not caught.
    assert.deepEqual(
      [roles.body.family, roles.heading.family, families.filter((family) => family.system).length, families.filter((family) => family.missing).length],
      [stack[0], "Mystery", 1, 1],
      what,
    );
    assert.ok(took < 3_000, `${what}: ${took} ms`);
  }
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

test("the check of which characters a web font has glyphs for holds the run's time: four files whose cmap has 350000 groups and text in 20000 characters take a moment, and once the run's time has run out the note is the one on a late font, with no check", () => {
  // In a process of its own, killed after 60 s, as code that looks at
  // every group for every character takes minutes.
  const script = `
const crypto = require("node:crypto");
const { buildFamilies } = require(${JSON.stringify(path.resolve(__dirname, "../skills/easyfontkit/scripts/lib/families"))});
const { describeFont } = require(${JSON.stringify(path.resolve(__dirname, "../skills/easyfontkit/scripts/lib/sfnt"))});
const { interAs, cmap12 } = require(${JSON.stringify(path.join(__dirname, "helpers"))});
const font = interAs({ names: { 1: "Bomb" }, cmap: cmap12(350000) });
const files = [1, 2, 3, 4].map((n) => {
  const url = "https://www.acme.com/fonts/bomb-" + n + ".ttf";
  return { sha: crypto.createHash("sha1").update(font).update(url).digest("hex"), urls: [url], buffer: font, font: describeFont(font) };
});
let text = "";
for (let i = 0; i < 20000; i++) text += String.fromCodePoint(0x4e01 + 2 * i);
const stack = '"Bomb", sans-serif';
const face = { familyName: "Noto Sans CJK JP", postScriptName: "", custom: false, glyphs: 20000, italicGlyphs: 0, weights: { 400: 20000 }, stacks: { [stack]: 20000 }, nodes: [{ text, length: text.length, system: 20000 }] };
const started = Date.now();
const { notes } = buildFamilies({ pageUrl: "https://www.acme.com/", roles: { body: [face] }, files, rules: files.map((file) => ({ family: "Bomb", weight: "400", style: "normal", unicodeRange: "", urls: file.urls })), faces: [], loaded: [{ family: "Bomb" }] });
console.log(JSON.stringify({ ms: Date.now() - started, notes }));
`;
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, `${run.error || ""} ${run.signal || ""} ${run.stderr}`);
  const { ms, notes } = JSON.parse(run.stdout);
  assert.deepEqual(notes, ["Some of the body text was drawn with Noto Sans CJK JP, a fallback, as Bomb has no glyphs for those characters. That text is counted as Bomb, the font the site asks for."]);
  assert.ok(ms < 10_000, `${ms} ms`);
  // A run whose time has run out by then: the files are not looked at, and
  // the note says what it said before the check.
  const inter = file("https://www.acme.com/fonts/inter.ttf", { 1: "Acme Latin" });
  const stack = '"Acme Latin", "Noto Sans CJK JP", sans-serif';
  setTimeLimit(-1);
  try {
    const { notes: late } = buildFamilies({ pageUrl: PAGE, roles: { heading: [face("Noto Sans CJK JP", 9, stack, { custom: false, nodes: [["日本語の見出しです", 9]] })] }, files: [inter], rules: [rule("Acme Latin", inter.urls[0])], faces: [], loaded: [{ family: "Acme Latin" }] });
    assert.deepEqual(late, ["Some of the headings were drawn with Noto Sans CJK JP, a fallback, because Acme Latin loaded too late for them. That text is counted as Acme Latin, the font the site asks for."]);
  } finally {
    setTimeLimit(120_000);
  }
});
