"use strict";

// The kit end to end in a real headless browser (skipped when none is
// installed), against a page served from this process, plus the address and
// folder rules and the CLI's own answers, which need no browser.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");
const { makeFontKit, normalizeUrl, prepareDir } = require("../skills/easyfontkit/scripts/lib/kit");
const { findChrome } = require("../skills/easyfontkit/scripts/lib/chrome");
const { fixture, interAs } = require("./helpers");

const CLI = path.resolve(__dirname, "../skills/easyfontkit/scripts/easyfontkit.js");
const noBrowser = !findChrome() && "no Chrome, Chromium, Edge or Brave installed";

function serve(routes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const route = routes[req.url.split("?")[0]];
      if (!route) return void res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      res.writeHead(200, { "content-type": route.type }).end(route.body);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

// The CLI's answer, and how long the process went on after it had printed
// its result.
function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let printedAt = 0;
    child.stdout.on("data", (chunk) => {
      printedAt = Date.now();
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr, lingered: Date.now() - printedAt }));
  });
}

// A heading font that sells itself, an open body font declared under
// another CSS name, a second heading font whose file hides its names, and
// code in the visitor's own monospace font.
const ACME = interAs({
  names: {
    0: "Copyright 2026 Acme Type. All rights reserved.",
    1: "Acme Display",
    2: "Regular",
    4: "Acme Display",
    6: "AcmeDisplay-Regular",
    8: "Acme Type",
    13: "Webfont sold by Acme Type, for use of the licensee only.",
    14: "https://acme.example/license",
  },
  fsType: 0x0004,
});
const SECRET = interAs({ names: { 1: ".\u007f", 2: "\u007f", 6: "\u007f", 8: "Secret Foundry", 14: "https://secret.example/eula" } });
const PAGE = {
  "/": {
    type: "text/html",
    body: `<!doctype html><html><head><title>Acme</title>
      <link rel="stylesheet" href="/css/site.css">
      <style>
        h1 { font-family: "Acme Display", sans-serif; font-weight: 700; }
        h2 { font-family: "Secret Grotesk", sans-serif; font-weight: 400; }
        p, button { font-family: "Body Sans", "Helvetica Neue", Arial, sans-serif; }
        pre, code { font-family: ui-monospace, "SF Mono", monospace; }
      </style></head>
      <body>
        <h1>Tools for teams that ship faster than ever before</h1>
        <h2>Plan and launch</h2>
        <p>Acme keeps the plan, the code and the launch in one place, so a team of five can work like a team of fifty.</p>
        <p>Every part of the work stays where the team can see it, from the first sketch to the release notes.</p>
        <button>Start free</button>
        <pre><code>npx acme init --team five</code></pre>
      </body></html>`,
  },
  "/css/site.css": {
    type: "text/css",
    body: `@font-face { font-family: "Acme Display"; src: url("../fonts/acme-display.ttf") format("truetype"); font-weight: 700; }
      @font-face { font-family: "Body Sans"; src: url("../fonts/inter.woff2") format("woff2"); font-weight: 400; unicode-range: U+0000-00FF; }
      @font-face { font-family: "Secret Grotesk"; src: url("/fonts/secret.ttf") format("truetype"); font-weight: 400; }`,
  },
  "/fonts/acme-display.ttf": { type: "font/ttf", body: ACME },
  "/fonts/inter.woff2": { type: "font/woff2", body: fixture("inter-latin-400.woff2") },
  "/fonts/secret.ttf": { type: "font/ttf", body: SECRET },
};

test("addresses: bare domains get https, anything else is refused", () => {
  assert.equal(normalizeUrl("acme.com"), "https://acme.com/");
  assert.equal(normalizeUrl("http://acme.com/docs"), "http://acme.com/docs");
  assert.throws(() => normalizeUrl("ftp://acme.com"), /Not a web address/);
  assert.throws(() => normalizeUrl(""), /Give a website address/);
});

test("never writes into a folder that holds someone else's files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-dir-"));
  try {
    fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
    assert.throws(() => prepareDir(dir), /not empty/);
    assert.equal(fs.readFileSync(path.join(dir, "notes.txt"), "utf8"), "mine");
    // An earlier kit is replaced, by file name only.
    fs.rmSync(path.join(dir, "notes.txt"));
    fs.mkdirSync(path.join(dir, "files"));
    fs.writeFileSync(path.join(dir, "files", "acme-400.woff2"), "old");
    fs.writeFileSync(path.join(dir, "FONTS.md"), "old");
    const old = { version: 1, generator: "easyfontkit 0.1.0", families: [{ files: [{ file: "../../escape.woff2" }, { file: "files/acme-400.woff2" }] }] };
    fs.writeFileSync(path.join(dir, "fonts.json"), JSON.stringify(old));
    prepareDir(dir);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the skill folder carries its own version, the same as the package's", () => {
  assert.equal(require("../skills/easyfontkit/scripts/lib/version"), require("../package.json").version);
});

test("the CLI explains itself and refuses a missing address", () => {
  const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: easyfontkit <url>/);
  const version = spawnSync(process.execPath, [CLI, "-v"], { encoding: "utf8" });
  assert.equal(version.stdout.trim(), require("../package.json").version);
  const none = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /Give one website address/);
  const slow = spawnSync(process.execPath, [CLI, "acme.com", "--timeout", "5"], { encoding: "utf8" });
  assert.equal(slow.status, 2);
  assert.match(slow.stderr, /--timeout takes 30 to 600 seconds/);
});

test("a page's fonts: each role's face, every file saved as served, each license, the free matches", { skip: noBrowser }, async () => {
  const { server, origin } = await serve(PAGE);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-out-"));
  const dir = path.join(parent, "kit");
  try {
    const { kit } = await makeFontKit(origin, { dir, timeLimit: 90_000 });
    assert.equal(kit.roles.heading.family, "Acme Display");
    assert.deepEqual(kit.roles.heading.weights, [700]);
    assert.deepEqual(kit.roles.heading.also, ["Secret Grotesk"]);
    assert.equal(kit.roles.body.family, "Inter");
    assert.equal(kit.roles.button.family, "Inter");
    assert.equal(kit.roles.code.family, "System monospace font");
    const family = Object.fromEntries(kit.families.map((f) => [f.name, f]));

    // Commercial by its own words, saved all the same, matched on its
    // proportions.
    const acme = family["Acme Display"];
    assert.equal(acme.license.status, "commercial");
    assert.equal(acme.license.maker, "Acme Type");
    assert.match(acme.license.basis, /Webfont sold by Acme Type/);
    assert.equal(acme.license.url, "https://acme.example/license");
    assert.equal(acme.files[0].file, "files/acme-display-400.ttf");
    assert.ok(fs.readFileSync(path.join(dir, acme.files[0].file)).equals(ACME), "saved byte for byte");
    assert.equal(acme.free.length, 3);
    assert.match(acme.free[0].basis, /^close in proportions/);

    // Open by its own words; known by the file's name, not the CSS one.
    const inter = family.Inter;
    assert.equal(inter.license.status, "open");
    assert.deepEqual(inter.cssNames, ["Body Sans"]);
    assert.equal(inter.files[0].file, "files/inter-400.woff2");
    assert.equal(inter.files[0].unicodeRange, "U+0000-00FF");
    assert.ok(fs.readFileSync(path.join(dir, "files/inter-400.woff2")).equals(fixture("inter-latin-400.woff2")));
    assert.deepEqual(inter.free, []);

    // A file that hides its names is named by the CSS that loads it.
    const secret = family["Secret Grotesk"];
    assert.equal(secret.license.status, "commercial");
    assert.equal(secret.license.maker, "Secret Foundry");
    assert.equal(secret.files[0].file, "files/secret-grotesk-400.ttf");

    // The visitor's own font: no file, the stack, a hand-picked match.
    const mono = family["System monospace font"];
    assert.equal(mono.system, true);
    assert.equal(mono.license.status, "system");
    assert.ok(mono.drawnWith, "says what this machine drew it with");
    assert.deepEqual(mono.free.map((f) => f.family), ["JetBrains Mono", "IBM Plex Mono"]);

    const md = fs.readFileSync(path.join(dir, "FONTS.md"), "utf8");
    assert.match(md, /^# Fonts of 127\.0\.0\.1/);
    assert.match(md, /\| Headings \| Acme Display, also Secret Grotesk \| 700 \| Commercial \| [A-Z][^|]+ \|/);
    assert.match(md, /\| Body text \| Inter \| 400 \| Open \| itself \|/);
    assert.match(md, /\| Code \| System monospace font \| 400 \| System font \| JetBrains Mono \|/);
    assert.match(md, /The file says "Webfont sold by Acme Type, for use of the licensee only\."/);
    const css = fs.readFileSync(path.join(dir, "fonts.css"), "utf8");
    assert.match(css, /@font-face \{\n {2}font-family: "Inter";\n {2}src: url\("files\/inter-400\.woff2"\) format\("woff2"\);\n {2}font-weight: 400;\n {2}font-style: normal;\n {2}unicode-range: U\+0000-00FF;/);
    assert.match(css, /src: url\("files\/acme-display-400\.ttf"\) format\("truetype"\);/);
    assert.match(css, /--font-body: "Inter", "Helvetica Neue", "Arial", sans-serif;/);
    assert.match(css, /--font-body-free: "Inter", sans-serif;/);
    assert.match(css, /--font-heading-free: "[^"]+", sans-serif;/);
    assert.match(css, /--font-code: ui-monospace, "SF Mono", monospace;/);
    assert.match(css, /--font-code-free: "JetBrains Mono", monospace;/);
    assert.match(css, /@import url\("https:\/\/fonts\.googleapis\.com\/css2\?family=[^"]*JetBrains\+Mono:wght@400[^"]*&display=swap"\);/);

    // The CLI, into the same folder: the earlier kit is replaced, and with
    // --no-files nothing is saved.
    const cli = await run([origin, "--out", dir, "--json", "--no-files"]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.ok(cli.lingered < 10_000, `the process ended ${cli.lingered} ms after printing the kit`);
    const json = JSON.parse(cli.stdout);
    assert.equal(json.roles.body.family, "Inter");
    assert.equal(json.families.find((f) => f.name === "Inter").files[0].file, "");
    assert.equal(fs.existsSync(path.join(dir, "files")), false);
  } finally {
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a bot check served instead of the page fails with a reason and leaves nothing behind", { skip: noBrowser }, async () => {
  const html = "<!doctype html><html><head><title>Just a moment...</title></head><body><p>Checking your browser.</p></body></html>";
  const { server, origin } = await serve({ "/": { type: "text/html", body: html } });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-out-"));
  const dir = path.join(parent, "kit");
  try {
    await assert.rejects(makeFontKit(origin, { dir, timeLimit: 60_000 }), /answered with a bot check \("Just a moment\.\.\."\)/);
    assert.equal(fs.existsSync(dir), false, "no folder left behind");
  } finally {
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
