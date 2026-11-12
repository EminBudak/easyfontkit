"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { fontFaceRules, decodeDataUrl } = require("../skills/easyfontkit/scripts/lib/scan");

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

test("data URLs decode to their bytes", () => {
  assert.equal(decodeDataUrl("data:font/woff2;base64,d09GMg==").toString("latin1"), "wOF2");
  assert.equal(decodeDataUrl("data:text/plain,a%20b").toString("latin1"), "a b");
  assert.equal(decodeDataUrl("not a data url"), null);
});

// A page's tab as record() listens to it: what the browser tells is given
// to it by tell(), and each font file's body is fetched from `bodies`, by
// its request's id, in the order the fetches were asked, as the browser
// answers on its pipe. fetched lists the ids asked for.
function tab(bodies) {
  const listeners = new Map();
  const fetched = [];
  return {
    fetched,
    on: (method, listener) => listeners.set(method, [...(listeners.get(method) || []), listener]),
    tell: (method, params) => (listeners.get(method) || []).forEach((listener) => listener(params)),
    send: async (method, { requestId }) => {
      fetched.push(requestId);
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
  const read = await readFiles(recorded.fonts, [], []);
  assert.deepEqual(
    read.files.map((file) => file.urls),
    [[url(1)]],
  );
  assert.deepEqual(read.skipped, [
    { url: url(2), reason: "not a font file" },
    { url: url(3), reason: "not a font file" },
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
  const read = await readFiles(recorded.fonts, [], []);
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
