"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { licenseOf, sourceOf, redact, redactUrl } = require("../skills/easyfontkit/scripts/lib/license");
const { describeFont } = require("../skills/easyfontkit/scripts/lib/sfnt");
const { lookup } = require("../skills/easyfontkit/scripts/lib/match");
const { fixture, interAs } = require("./helpers");

test("a file that names an open license is open, whoever serves it", () => {
  const inter = describeFont(fixture("inter-latin-400.woff2"));
  const verdict = licenseOf(inter, { source: "self-hosted" });
  assert.equal(verdict.status, "open");
  assert.equal(verdict.name, "SIL Open Font License");
  assert.equal(verdict.url, "https://openfontlicense.org");
  assert.equal(licenseOf({ license: "Licensed under the Apache License, Version 2.0" }).name, "Apache License");
});

test("a file that sells or restricts itself is commercial, and its own words are the reason", () => {
  const acme = describeFont(
    interAs({ names: { 1: "Acme Sans", 8: "Acme Type", 13: "Webfont sold by Acme Type, for use of the licensee only.", 14: "https://acme.example/license" }, fsType: 0x0004 }),
  );
  const verdict = licenseOf(acme, { source: "self-hosted" });
  assert.equal(verdict.status, "commercial");
  assert.equal(verdict.maker, "Acme Type");
  assert.match(verdict.basis, /Webfont sold by Acme Type/);
  assert.equal(verdict.url, "https://acme.example/license");
  // A foundry's license link alone says the same.
  assert.equal(licenseOf({ licenseUrl: "https://www.daltonmaag.com/eula" }).status, "commercial");
});

test("with nothing in the file, the service it came from decides, then the embedding bits, then Fontsource", () => {
  assert.equal(licenseOf({}, { source: "google", listed: lookup("Roboto") }).status, "open");
  assert.equal(licenseOf({}, { source: "google", listed: lookup("Roboto") }).name, "SIL Open Font License 1.1");
  assert.equal(licenseOf({}, { source: "adobe" }).status, "commercial");
  assert.equal(licenseOf({ embedding: "restricted" }, { source: "self-hosted" }).status, "commercial");
  const stripped = licenseOf({ embedding: "installable" }, { source: "self-hosted", listed: lookup("Inter Medium") });
  assert.equal(stripped.status, "open");
  assert.match(stripped.basis, /Fontsource lists Inter/);
  assert.equal(licenseOf({ copyright: "Copyright 2020 Acme. All rights reserved." }, { source: "self-hosted" }).status, "commercial");
  assert.equal(licenseOf({ embedding: "installable" }, { source: "self-hosted" }).status, "unknown");
});

test("a licensee's own license number is left out, from the text and the link", () => {
  const text = "LT-07 Enterprise Business License. License classification: Commercial. License ID: ABCD-1234-EFGH-5678. Property of Acme Type.";
  assert.equal(redact(text), "LT-07 Enterprise Business License. License classification: Commercial. Property of Acme Type.");
  assert.equal(redactUrl("https://acme.example/licenses/ABCD-1234-EFGH-5678/validate"), "https://acme.example/licenses/");
  assert.equal(redactUrl("https://acme.example/eula?customer=42"), "https://acme.example/eula");
  assert.equal(redact("Copyright 2022-2025 Acme Type"), "Copyright 2022-2025 Acme Type");
  const verdict = licenseOf({ license: text, licenseUrl: "https://acme.example/licenses/ABCD-1234-EFGH-5678/validate" });
  assert.equal(verdict.status, "commercial");
  assert.doesNotMatch(JSON.stringify(verdict), /ABCD-1234/);
});

test("where a file comes from, by its address", () => {
  const page = "https://www.acme.com/pricing";
  assert.equal(sourceOf("https://fonts.gstatic.com/s/inter/v13/abc.woff2", page), "google");
  assert.equal(sourceOf("https://use.typekit.net/af/abc/000/27/l?fvd=n4", page), "adobe");
  assert.equal(sourceOf("https://fonts.bunny.net/inter/files/inter-latin-400-normal.woff2", page), "bunny");
  assert.equal(sourceOf("https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-400-normal.woff2", page), "fontsource");
  assert.equal(sourceOf("https://static.acme.com/fonts/a.woff2", page), "self-hosted");
  assert.equal(sourceOf("https://b.acmecdn.com/fonts/a.woff2", page), "self-hosted");
  assert.equal(sourceOf("https://a0.othercdn.net/fonts/a.woff2", page), "third-party");
  assert.equal(sourceOf("data:font/woff2;base64,AAAA", page), "inline");
});
