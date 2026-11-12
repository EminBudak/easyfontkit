"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { fontFaceRules, decodeDataUrl, dataKey } = require("../skills/easyfontkit/scripts/lib/scan");

test("@font-face rules: family, weight, style, range and absolute addresses", () => {
  const css = `
    /* @font-face { font-family: Commented; src: url(no.woff2) } */
    @font-face {
      font-family: "Acme Sans";
      src: url("../fonts/acme.woff2?v=2") format("woff2"), url(/fonts/acme.woff) format("woff");
      font-weight: 100 900;
      font-style: normal;
      unicode-range: U+0000-00FF, U+0131;
    }
    @media (min-width: 1px) { @font-face { font-family: 'Acme Mono'; src: url('mono.ttf'); } }
    @font-face { font-family: Inline; src: url(data:font/woff2;base64,d09GMgABAAAA) format("woff2"); font-style: italic }
    @font-face { font-family: NoSource; font-weight: 400 }`;
  const rules = fontFaceRules(css, "https://cdn.acme.com/css/site.css");
  assert.deepEqual(
    rules.map((rule) => rule.family),
    ["Acme Sans", "Acme Mono", "Inline"],
  );
  assert.deepEqual(rules[0].urls, ["https://cdn.acme.com/fonts/acme.woff2?v=2", "https://cdn.acme.com/fonts/acme.woff"]);
  assert.equal(rules[0].weight, "100 900");
  assert.equal(rules[0].unicodeRange, "U+0000-00FF, U+0131");
  assert.deepEqual(rules[1].urls, ["https://cdn.acme.com/css/mono.ttf"]);
  assert.equal(rules[2].style, "italic", "the semicolon inside the data URL does not end the declaration");
  assert.equal(rules[2].urls[0], "data:font/woff2;base64,d09GMgABAAAA");
});

test("a quoted address of megabytes in a src, as a font given as a data: address and as the CSS object model writes every address, is read, where the pattern ran the regular expression engine out of stack from about 8 MB", () => {
  for (const mb of [8, 16]) {
    const font = `data:font/woff2;base64,${"QUJD".repeat((mb << 20) / 4)}`;
    for (const quote of ['"', "'"]) {
      // A quote in an address is written after a backslash.
      const rules = fontFaceRules(`@font-face { font-family: Big; src: url(${quote}${font}${quote}) format("woff2"), url(${quote}/fonts/a\\${quote}b.woff${quote}) }`, "https://acme.example/");
      assert.equal(rules.length, 1);
      assert.equal(rules[0].urls.length, 2);
      assert.equal(rules[0].urls[0].length, font.length);
      assert.equal(rules[0].urls[1], `https://acme.example/fonts/a/${quote === '"' ? "%22" : "'"}b.woff`);
    }
  }
});

test("a style sheet of many comments or @font-face blocks that never close, or a src of many url( openings that never close, is read in a moment, where the run took seconds for 320 KB of them and would take hours for the 64 MB it reads of style sheets, during which a stop signal waited", () => {
  const rule = "@font-face { font-family: Acme; src: url(/acme.woff2) } /* a comment */ ";
  // The last two inside one block, whose src they make.
  for (const [opening, start, end] of [
    ["/* a", "", ""],
    ["@font-face{", "", ""],
    ["url(", "@font-face { font-family: Slow; src: ", " }"],
    ['url("x', "@font-face { font-family: Slow; src: ", " }"],
  ]) {
    const text = rule + start + opening.repeat(Math.ceil(320_000 / opening.length)) + end;
    const started = Date.now();
    const rules = fontFaceRules(text, "https://acme.example/");
    const took = Date.now() - started;
    assert.deepEqual(
      rules.map((one) => [one.family, one.urls]),
      [["Acme", ["https://acme.example/acme.woff2"]]],
    );
    assert.ok(took < 1_000, `${opening}: ${took} ms`);
  }
});

test("data URLs decode to their bytes", () => {
  assert.equal(decodeDataUrl("data:font/woff2;base64,d09GMg==").toString("latin1"), "wOF2");
  assert.equal(decodeDataUrl("data:text/plain,a%20b").toString("latin1"), "a b");
  assert.equal(decodeDataUrl("not a data url"), null);
});

// A page's tab as record() listens to it: what the browser tells is given
// to it by tell(), and each font file's body is fetched from `bodies`, by
// its request's id, in the order the fetches were asked, as the browser
// answers on its pipe; an Error there is the browser's answer that it has
// no such body. fetched lists the ids asked for.
function tab(bodies) {
  const listeners = new Map();
  const fetched = [];
  return {
    fetched,
    on: (method, listener) => listeners.set(method, [...(listeners.get(method) || []), listener]),
    tell: (method, params) => (listeners.get(method) || []).forEach((listener) => listener(params)),
    send: async (method, { requestId }) => {
      fetched.push(requestId);
      if (bodies[requestId] instanceof Error) throw bodies[requestId];
      return { body: bodies[requestId].toString("base64"), base64Encoded: true };
    },
  };
}

test("the bodies of a page's font files are kept up to what a run keeps of one page, 200 MB: a file that what came over the network for it, with the bodies kept and those still coming, takes past that is not fetched, one whose body takes them past it is let go of as it comes, and their addresses are given apart, while a body that is no font file is let go of once read", async () => {
  const { record, readFiles } = require("../skills/easyfontkit/scripts/lib/scan");
  const { FONT_BYTES } = require("../skills/easyfontkit/scripts/lib/limits");
  const { unreadNotes } = require("../skills/easyfontkit/scripts/lib/kit");
  const { fixture } = require("./helpers");
  const inter = fixture("inter-latin-400.woff2");
  // File 1 is Inter and files 2 to 6 are 400 bytes that are no font file,
  // with a run that keeps Inter and 1000 bytes more. Each comes over the
  // network as large as it is, but file 5, which comes packed to 100 bytes.
  // Files 1 to 5 are told of at once: 1, 2 and 3 come in what the run
  // keeps, 4 is not fetched, as with those still coming it would take more,
  // and 5 is fetched and let go of as it comes. File 6, told of once they
  // have come, is not fetched either.
  const junk = (n) => Buffer.alloc(400, n);
  const bodies = { 1: inter, 2: junk(2), 3: junk(3), 4: junk(4), 5: junk(5), 6: junk(6) };
  const sent = { 1: inter.length, 2: 400, 3: 400, 4: 400, 5: 100, 6: 400 };
  const cdp = tab(bodies);
  const recorded = record(cdp, inter.length + 1000);
  const url = (id) => `https://acme.example/fonts/${id}.woff2`;
  const finished = (id) => {
    cdp.tell("Network.requestWillBeSent", { requestId: id, type: "Font", request: { url: url(id) } });
    cdp.tell("Network.responseReceived", { requestId: id, type: "Font", response: { url: url(id), status: 200 } });
    cdp.tell("Network.loadingFinished", { requestId: id, encodedDataLength: sent[id] });
  };
  ["1", "2", "3", "4", "5"].forEach(finished);
  await new Promise((resolve) => setImmediate(resolve));
  finished("6");
  assert.deepEqual(cdp.fetched, ["1", "2", "3", "5"], "files 4 and 6 are not fetched");
  const read = await readFiles(recorded.fonts, recorded.inline);
  assert.deepEqual(
    read.files.map((file) => file.urls),
    [[url(1)]],
  );
  assert.deepEqual(read.skipped, [
    { url: url(2), label: url(2), reason: "not a font file" },
    { url: url(3), label: url(3), reason: "not a font file" },
  ]);
  assert.deepEqual(
    read.unread.map(({ url, why }) => [url, why]),
    [
      [url(4), "budget"],
      [url(5), "budget"],
      [url(6), "budget"],
    ],
  );
  assert.ok([...recorded.fonts.values()].every((font) => font.body === null), "no body is held once read");
  assert.equal(FONT_BYTES, 200 * 1024 * 1024);
  assert.deepEqual(unreadNotes(read.unread), [`3 font files, the first of them ${url(4)}, were not read, as the page's font files came to more than the 200 MB easyfontkit reads of one page.`]);
  assert.deepEqual(unreadNotes(read.unread.slice(0, 1)), [`The font file ${url(4)} was not read, as the page's font files came to more than the 200 MB easyfontkit reads of one page.`]);
});

test("the addresses that are not web addresses a page tries are kept each once, with each way it went, up to 50 addresses, so the notes count the rest of 26 frames at 26 such addresses as 23, and of 60 as at least 47, where 50 tellings of them were kept, which held 25 addresses as a frame tells of its address twice, and the notes counted 22 more for both", () => {
  const { record } = require("../skills/easyfontkit/scripts/lib/scan");
  const { triedNotes } = require("../skills/easyfontkit/scripts/lib/kit");
  // n frames, each at an address of its own, which the browser tells of as
  // asked and as started, and of which the first is asked again.
  const frames = (n) => {
    const cdp = tab({});
    const recorded = record(cdp);
    for (let i = 0; i < n; i++) {
      const url = `mailto:a${i}@example.invalid`;
      cdp.tell("Page.frameRequestedNavigation", { url });
      cdp.tell("Page.frameStartedNavigating", { url });
      cdp.tell("Page.frameRequestedNavigation", { url });
    }
    return recorded;
  };
  const counted = (n) => {
    const recorded = frames(n);
    return triedNotes(recorded.tried, { more: recorded.triedMore }).slice(3);
  };
  assert.deepEqual(counted(26), ["It tried 23 more addresses that are not web addresses as well."]);
  assert.deepEqual(counted(50), ["It tried 47 more addresses that are not web addresses as well."]);
  assert.deepEqual(counted(60), ["It tried at least 47 more addresses that are not web addresses as well."]);
  const sixty = frames(60);
  assert.equal(new Set(sixty.tried.map(({ url }) => url)).size, 50);
  assert.equal(sixty.tried.length, 100, "each of 50 addresses with each way it went once");
});

test("a font file whose body the browser no longer holds when it is asked for, as the browser lets go of the oldest it keeps once font files that come at the same moment pass its buffer, is given apart with that and noted apart from those past what a run keeps, where it was left out with no word", async () => {
  const { record, readFiles } = require("../skills/easyfontkit/scripts/lib/scan");
  const { unreadNotes } = require("../skills/easyfontkit/scripts/lib/kit");
  const { fixture } = require("./helpers");
  const inter = fixture("inter-latin-400.woff2");
  // Files 1 and 2 come at once with Inter, file 3, and with file 5, which
  // the server answered with 404, and the browser has let go of their
  // bodies by the time they are asked for, as Chrome answers then. File 4,
  // told of once they have come, would take the run past what it keeps.
  const evicted = new Error("Request content was evicted from inspector cache");
  const cdp = tab({ 1: evicted, 2: evicted, 3: inter, 4: Buffer.alloc(1200, 4), 5: evicted });
  const recorded = record(cdp, inter.length + 1000);
  const url = (id) => `https://acme.example/fonts/${id}.ttf`;
  const finished = (id, size, status = 200) => {
    cdp.tell("Network.requestWillBeSent", { requestId: id, type: "Font", request: { url: url(id) } });
    cdp.tell("Network.responseReceived", { requestId: id, type: "Font", response: { url: url(id), status } });
    cdp.tell("Network.loadingFinished", { requestId: id, encodedDataLength: size });
  };
  finished("1", 400);
  finished("2", 400);
  finished("3", inter.length);
  finished("5", 100, 404);
  await new Promise((resolve) => setImmediate(resolve));
  finished("4", 1200);
  assert.deepEqual(cdp.fetched, ["1", "2", "3", "5"]);
  const read = await readFiles(recorded.fonts, recorded.inline);
  assert.deepEqual(
    read.files.map((file) => file.urls),
    [[url(3)]],
  );
  assert.deepEqual(read.skipped, [{ url: url(5), label: url(5), reason: "the server answered 404" }]);
  assert.deepEqual(
    read.unread.map(({ url: address, why }) => [address, why]),
    [
      [url(1), "dropped"],
      [url(2), "dropped"],
      [url(4), "budget"],
    ],
  );
  assert.deepEqual(unreadNotes(read.unread), [
    `The font file ${url(4)} was not read, as the page's font files came to more than the 200 MB easyfontkit reads of one page.`,
    `2 font files, the first of them ${url(1)}, were not read, as the browser no longer held them when easyfontkit asked for them, which can happen when a page's font files come at the same moment.`,
  ]);
  assert.deepEqual(unreadNotes(read.unread.slice(0, 1)), [`The font file ${url(1)} was not read, as the browser no longer held it when easyfontkit asked for it, which can happen when a page's font files come at the same moment.`]);
});

test("a font file larger than a run reads of one, 64 MB, by its size as it comes unpacked, is not fetched and is given apart with why, as are those past what a run keeps of one page", async () => {
  const { record, readFiles } = require("../skills/easyfontkit/scripts/lib/scan");
  const { FILE_BYTES } = require("../skills/easyfontkit/scripts/lib/limits");
  const { unreadNotes } = require("../skills/easyfontkit/scripts/lib/kit");
  const { fixture } = require("./helpers");
  const inter = fixture("inter-latin-400.woff2");
  assert.equal(FILE_BYTES, 64 * 1024 * 1024);
  // A run that reads 1000 bytes more than Inter of one file and keeps 1500
  // more than Inter in all. Files 1 and 2 come over the network packed to
  // 900 bytes, 1000 bytes more than a run reads of one as they come
  // unpacked, and are not fetched; file 3 is Inter, and file 4, Inter again
  // with bytes of its own after it, would take the run past what it keeps.
  const one = inter.length + 1000;
  const cdp = tab({ 1: Buffer.alloc(one + 1000), 2: Buffer.alloc(one + 1000), 3: inter, 4: Buffer.concat([inter, Buffer.alloc(900, 4)]) });
  const recorded = record(cdp, inter.length + 1500, one);
  const url = (id) => `https://acme.example/${id}.ttf`;
  for (const [id, size] of [["1", one + 1000], ["2", one + 1000], ["3", inter.length], ["4", inter.length + 900]]) {
    cdp.tell("Network.requestWillBeSent", { requestId: id, type: "Font", request: { url: url(id) } });
    cdp.tell("Network.responseReceived", { requestId: id, type: "Font", response: { url: url(id), status: 200 } });
    cdp.tell("Network.dataReceived", { requestId: id, dataLength: size, encodedDataLength: 900 });
    cdp.tell("Network.loadingFinished", { requestId: id, encodedDataLength: 900 });
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(cdp.fetched, ["3"], "files 1 and 2 are larger than a run reads of one, and file 4 takes it past what it keeps");
  const read = await readFiles(recorded.fonts, recorded.inline);
  assert.deepEqual(
    read.files.map((file) => file.urls),
    [[url(3)]],
  );
  assert.deepEqual(
    read.unread.map(({ url: address, label, why }) => [address, label, why]),
    [
      [url(1), url(1), "big"],
      [url(2), url(2), "big"],
      [url(4), url(4), "budget"],
    ],
  );
  assert.deepEqual(unreadNotes(read.unread), [
    `The font file ${url(4)} was not read, as the page's font files came to more than the 200 MB easyfontkit reads of one page.`,
    `2 font files, the first of them ${url(1)}, were not read, as each is larger than the 64 MB easyfontkit reads of one font file.`,
  ]);
  assert.deepEqual(unreadNotes(read.unread.slice(0, 1)), [`The font file ${url(1)} was not read, as it is larger than the 64 MB easyfontkit reads of one font file.`]);
});

test("a font the page gives as a data: address is read from the browser's request for it, once, within what a run keeps of one page and of one file, and known by a key: one past either is not read and is named by its media type and size, as is one that is no font file, and one the browser never asked for is not read", async () => {
  const { record, readFiles } = require("../skills/easyfontkit/scripts/lib/scan");
  const { unreadNotes } = require("../skills/easyfontkit/scripts/lib/kit");
  const { fixture } = require("./helpers");
  const inter = fixture("inter-latin-400.woff2");
  const woff = fixture("inter-latin-400.woff");
  const data = (type, buffer) => `data:${type};base64,${buffer.toString("base64")}`;
  // A run that keeps Inter's WOFF2 and 4000 bytes more, and reads 1000
  // bytes more than its WOFF of one file. Inter's WOFF2 as a data: address,
  // asked for twice and told of as a face; a font of 3000 bytes that is no
  // font file; its WOFF, which takes the run past what it keeps; a file 1000
  // bytes larger than a run reads of one; and a font in the page's CSS the
  // browser never asks for.
  const one = woff.length + 1000;
  const good = data("font/woff2", inter);
  const junk = data("application/vnd.ms-fontobject", Buffer.alloc(3000, 1));
  const over = data("font/woff", woff);
  const big = data("font/ttf", Buffer.alloc(one + 1000, 2));
  const never = data("image/svg+xml", Buffer.alloc(100, 3));
  const cdp = tab({});
  const recorded = record(cdp, inter.length + 4000, one);
  [good, good, junk, over, big].forEach((address, i) => cdp.tell("Network.requestWillBeSent", { requestId: `d${i}`, type: "Font", request: { url: address } }));
  cdp.tell("CSS.fontsUpdated", { font: { fontFamily: "Inl", src: good } });
  assert.deepEqual(cdp.fetched, [], "nothing is fetched");
  assert.equal(recorded.faces[0].src, dataKey(good), "the face is known by the key");
  assert.ok(!JSON.stringify(recorded.faces).includes("base64"), "no data: address is kept");
  const read = await readFiles(recorded.fonts, recorded.inline);
  assert.deepEqual(
    read.files.map((file) => file.urls),
    [[dataKey(good)]],
  );
  assert.ok(!read.files.some((file) => file.urls.includes(dataKey(never))));
  assert.deepEqual(read.skipped, [{ url: dataKey(junk), label: "a font the page gave as a data: address (application/vnd.ms-fontobject, 3 KB)", reason: "not a font file" }]);
  assert.deepEqual(
    read.unread.map(({ url, label, why }) => [url, label, why]),
    [
      [dataKey(over), "a font the page gave as a data: address (font/woff, 30 KB)", "budget"],
      [dataKey(big), "a font the page gave as a data: address (font/ttf, 32 KB)", "big"],
    ],
  );
  assert.ok([...recorded.inline.values()].every((font) => font.body === null), "no body is held once read");
  assert.deepEqual(unreadNotes(read.unread), [
    "A font the page gave as a data: address (font/woff, 30 KB) was not read, as the page's font files came to more than the 200 MB easyfontkit reads of one page.",
    "A font the page gave as a data: address (font/ttf, 32 KB) was not read, as it is larger than the 64 MB easyfontkit reads of one font file.",
  ]);
});

test("the @font-face rules the page's CSS object model gives stand a data: address in by its print and stop at the most characters given, so a page cannot make the run take its fonts' addresses whole", () => {
  const { cssomRules, dataPrint } = require("../skills/easyfontkit/scripts/lib/scan");
  const big = `data:font/woff2;base64,${"QUJD".repeat(1 << 18)}`;
  const rule = (family, src) => Object.assign(Object.create(CSSFontFaceRule.prototype), { style: { getPropertyValue: (name) => ({ "font-family": family, src, "font-weight": "400", "font-style": "normal", "unicode-range": "" })[name] || "" } });
  class CSSFontFaceRule {}
  class CSSImportRule {}
  const sheet = { href: "https://acme.example/site.css", cssRules: [rule("Inl", `url("${big}") format("woff2"), url("https://acme.example/inl.woff2") format("woff2")`), rule("Plain", 'url("https://acme.example/plain.woff2")'), rule("Late", 'url("https://acme.example/late.woff2")')] };
  const run = (most) => new Function("CSSFontFaceRule", "CSSImportRule", "document", "location", `return (${cssomRules})(${most}, ${dataPrint});`)(CSSFontFaceRule, CSSImportRule, { styleSheets: [sheet] }, { href: "https://acme.example/" });
  const all = run(1e6);
  // Its length, and its first and last 64 characters.
  assert.equal(dataPrint(big), `data:easyfontkit,${big.length},data:font/woff2;base64,${"QUJD".repeat(10)}Q,${"QUJD".repeat(16)}`);
  assert.equal(dataPrint('data:font/ttf,a"b\\c)d e'), "data:easyfontkit,23,data:font/ttf,a_b_c_d_e,data:font/ttf,a_b_c_d_e");
  assert.deepEqual(
    all.map((one) => [one.family, one.src]),
    [
      ["Inl", `url("${dataPrint(big)}") format("woff2"), url("https://acme.example/inl.woff2") format("woff2")`],
      ["Plain", 'url("https://acme.example/plain.woff2")'],
      ["Late", 'url("https://acme.example/late.woff2")'],
    ],
  );
  // Given what the first two come to, the third is left out.
  const size = (one) => Object.values(one).reduce((sum, value) => sum + String(value).length, 0);
  assert.deepEqual(
    run(size(all[0]) + size(all[1])).map((one) => one.family),
    ["Inl", "Plain"],
  );
});

// A tab whose page has style sheets: what the browser tells is given to it
// by tell(), the text of a sheet is given from `texts` by its id, and a
// script run in the world of easyfontkit's own the tab gives, 7, is run on
// `page`, the stand-in for the page's own document with the classes of its
// rules, as the page would run it; in another world it gives nothing, as a
// page's own scripts can make it. asked lists the calls.
function sheetsTab(page, texts = {}) {
  const listeners = new Map();
  const asked = [];
  class CSSFontFaceRule {}
  class CSSImportRule {}
  return {
    asked,
    CSSFontFaceRule,
    on: (method, listener) => listeners.set(method, [...(listeners.get(method) || []), listener]),
    tell: (method, params) => (listeners.get(method) || []).forEach((listener) => listener(params)),
    send: async (method, params = {}) => {
      asked.push([method, params.styleSheetId || ""]);
      if (method === "CSS.getStyleSheetText") return { text: texts[params.styleSheetId] || "" };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Runtime.evaluate" && params.contextId !== 7) return { result: { value: [] } };
      if (method === "Runtime.evaluate") return { result: { value: new Function("CSSFontFaceRule", "CSSImportRule", "document", "location", `return ${params.expression};`)(CSSFontFaceRule, CSSImportRule, page(CSSFontFaceRule), { href: "https://acme.example/" }) } };
      return {};
    },
  };
}

test("a font the page gives as a data: address in a style sheet whose text is past what a run reads of style sheets is tied to the browser's request for it by the print the CSS object model gives of it, so a family whose font the browser could not use is no longer taken for one of the visitor's own", async () => {
  const { record, readRules, dataKey } = require("../skills/easyfontkit/scripts/lib/scan");
  const { CSS_BYTES } = require("../skills/easyfontkit/scripts/lib/limits");
  // A font of 3 MB that is no font file, as the browser asked for it, and
  // another the browser never asked for.
  const junk = `data:font/ttf;base64,${Buffer.alloc(3 << 20, 1).toString("base64")}`;
  const never = `data:font/ttf;base64,${Buffer.alloc(3 << 20, 2).toString("base64")}`;
  const rule = (CSSFontFaceRule, family, font) => Object.assign(Object.create(CSSFontFaceRule.prototype), { style: { getPropertyValue: (name) => ({ "font-family": family, src: `url(${font}) format("truetype")` })[name] || "" } });
  // A small sheet's text gives a font as a data: address too, and is read.
  const small = "data:font/woff2;base64,d09GMgABAAAA";
  const cdp = sheetsTab((CSSFontFaceRule) => ({ styleSheets: [{ href: null, cssRules: [rule(CSSFontFaceRule, '"Junk"', junk), rule(CSSFontFaceRule, '"Never"', never)] }] }), { small: `@font-face { font-family: Small; src: url(${small}) format("woff2") } @font-face { font-family: Plain; src: url(/plain.woff2) }` });
  const recorded = record(cdp);
  cdp.tell("Network.requestWillBeSent", { requestId: "d1", type: "Font", request: { url: junk } });
  // The big sheet is longer than a run reads of style sheets, so its text
  // is not read and its rules come from the CSS object model alone.
  cdp.tell("CSS.styleSheetAdded", { header: { styleSheetId: "big", origin: "regular", length: CSS_BYTES + 1, sourceURL: "https://acme.example/" } });
  cdp.tell("CSS.styleSheetAdded", { header: { styleSheetId: "small", origin: "regular", length: 120, sourceURL: "https://acme.example/site.css" } });
  const rules = await readRules(cdp, recorded.sheets, "https://acme.example/", recorded.inline);
  assert.deepEqual(
    cdp.asked.filter(([method]) => method === "CSS.getStyleSheetText").map(([, id]) => id),
    ["small"],
  );
  assert.deepEqual(
    rules.map((one) => one.family),
    ["Small", "Plain", "Junk", "Never"],
  );
  assert.deepEqual(rules[0].urls, [dataKey(small)]);
  assert.deepEqual(rules[1].urls, ["https://acme.example/plain.woff2"]);
  assert.deepEqual(rules[2], { family: "Junk", weight: "400", style: "normal", unicodeRange: "", urls: [dataKey(junk)] });
  assert.ok(!rules[3].urls[0].includes("base64") && rules[3].urls[0] !== dataKey(never), "a font the browser never asked for is tied to nothing");
});

test("the text of a page's style sheets is read up to what a run reads of them, 64 MB, as their lengths tell, and the text of a sheet a script built is never read, as the page can give it new text of any length once the browser has told its length: their rules come from the CSS object model", async () => {
  const { record, readRules } = require("../skills/easyfontkit/scripts/lib/scan");
  const { CSS_BYTES } = require("../skills/easyfontkit/scripts/lib/limits");
  assert.equal(CSS_BYTES, 64 * 1024 * 1024);
  const face = (family) => `@font-face { font-family: ${family}; src: url(/${family.toLowerCase()}.woff2) format("woff2") }`;
  // Four sheets as the browser tells of them: one of 40 MB, one of 30 MB,
  // which would take the text read past 64 MB, one a script built, told of
  // with 19 characters, and one of 10 MB. The text of each is a rule.
  const MB = 1024 * 1024;
  const texts = { first: face("First"), past: face("Past"), built: face("Built"), last: face("Last") };
  const cdp = sheetsTab((CSSFontFaceRule) => ({
    styleSheets: [],
    // The sheet the script built, as the CSS object model has it.
    adoptedStyleSheets: [{ href: null, cssRules: [Object.assign(Object.create(CSSFontFaceRule.prototype), { style: { getPropertyValue: (name) => ({ "font-family": "Built", src: 'url("https://acme.example/built.woff2") format("woff2")' })[name] || "" } })] }],
  }), texts);
  const recorded = record(cdp);
  const added = (styleSheetId, length, isConstructed = false) => cdp.tell("CSS.styleSheetAdded", { header: { styleSheetId, origin: "regular", length, isConstructed, sourceURL: "https://acme.example/site.css" } });
  added("first", 40 * MB);
  added("past", 30 * MB);
  added("built", 19, true);
  added("last", 10 * MB);
  const rules = await readRules(cdp, recorded.sheets, "https://acme.example/");
  assert.deepEqual(
    cdp.asked.filter(([method]) => method === "CSS.getStyleSheetText").map(([, id]) => id),
    ["first", "last"],
  );
  assert.deepEqual(
    rules.map((rule) => [rule.family, rule.urls]),
    [
      ["First", ["https://acme.example/first.woff2"]],
      ["Last", ["https://acme.example/last.woff2"]],
      ["Built", ["https://acme.example/built.woff2"]],
    ],
  );
});
