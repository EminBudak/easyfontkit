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
  const { record, readFiles, FONT_BYTES } = require("../skills/easyfontkit/scripts/lib/scan");
  const { unreadNote } = require("../skills/easyfontkit/scripts/lib/kit");
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
  assert.deepEqual(read.unread, [url(4), url(5), url(6)]);
  assert.ok([...recorded.fonts.values()].every((font) => font.body === null), "no body is held once read");
  assert.equal(FONT_BYTES, 200 * 1024 * 1024);
  assert.equal(unreadNote(read.unread), `3 font files, the first of them ${url(4)}, were not read, as the page's font files came to more than the 200 MB easyfontkit reads of one page.`);
  assert.equal(unreadNote([url(4)]), `The font file ${url(4)} was not read, as the page's font files came to more than the 200 MB easyfontkit reads of one page.`);
});
