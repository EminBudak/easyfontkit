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
