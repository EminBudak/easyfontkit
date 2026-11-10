"use strict";

// The kit end to end in a real headless browser (skipped when none is
// installed), against a page served from this process, plus the address and
// folder rules and the CLI's own answers, which need no browser.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");
const { Worker } = require("node:worker_threads");
const { makeFontKit, normalizeUrl, prepareDir, earlierKit, saveKit } = require("../skills/easyfontkit/scripts/lib/kit");
const { findChrome, launch, openPage } = require("../skills/easyfontkit/scripts/lib/chrome");
const { setTimeLimit } = require("../skills/easyfontkit/scripts/lib/time");
const { fixture, interAs } = require("./helpers");

const CLI = path.resolve(__dirname, "../skills/easyfontkit/scripts/easyfontkit.js");
const noBrowser = !findChrome() && "no Chrome, Chromium, Edge or Brave installed";
const noSignals = process.platform === "win32" && "no POSIX signals or shell scripts on Windows";

// A route answers with its status (200 unless it says), its headers and its
// body; one that holds never answers.
function serve(routes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const route = routes[req.url.split("?")[0]];
      if (!route) return void res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      if (route.hold) return;
      res.writeHead(route.status || 200, { "content-type": route.type || "text/html", ...route.headers }).end(route.body || "");
    });
    const close = () => {
      server.closeAllConnections();
      server.close();
    };
    server.listen(0, "127.0.0.1", () => resolve({ server: { close }, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

// The CLI's answer, and how long the process went on after it had printed
// its result.
function run(args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
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

// Every entry of a folder, hidden ones too, with its kind, mode, contents
// and time: two snapshots that match mean the folder is exactly as it was.
// Without folderTimes, the times of folders are left out.
function snapshot(dir, { folderTimes = true } = {}) {
  if (!fs.existsSync(dir)) return null;
  const lines = [];
  const walk = (at, rel) => {
    for (const name of fs.readdirSync(at).sort()) {
      const full = path.join(at, name);
      const stat = fs.lstatSync(full);
      const where = rel ? `${rel}/${name}` : name;
      const mode = (stat.mode & 0o7777).toString(8);
      if (stat.isDirectory()) {
        lines.push(`${where}/ ${mode}${folderTimes ? ` ${stat.mtimeMs}` : ""}`);
        walk(full, where);
      } else {
        lines.push(`${where} ${mode} ${crypto.createHash("sha1").update(fs.readFileSync(full)).digest("hex")} ${stat.mtimeMs}`);
      }
    }
  };
  walk(dir, "");
  return lines;
}

// A kit as an earlier run left it, with a file of the user's in its files
// folder.
function earlierKitIn(dir) {
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  const kit = { version: 1, generator: "easyfontkit 0.1.1", url: "https://acme.example/", families: [{ files: [{ file: "files/acme-400.woff2" }] }] };
  fs.writeFileSync(path.join(dir, "fonts.json"), JSON.stringify(kit));
  fs.writeFileSync(path.join(dir, "FONTS.md"), "# Fonts of acme.example\n");
  fs.writeFileSync(path.join(dir, "fonts.css"), ":root {}\n");
  fs.writeFileSync(path.join(dir, "files", "acme-400.woff2"), fixture("inter-latin-400.woff2"));
  fs.writeFileSync(path.join(dir, "files", "notes.txt"), "mine");
}

// A new kit, written into its part folder as makeFontKit writes it.
function newKitIn(part, names = []) {
  fs.writeFileSync(path.join(part, "fonts.json"), JSON.stringify({ version: 1, generator: "easyfontkit test", families: [{ files: names.map((name) => ({ file: `files/${name}` })) }] }));
  fs.writeFileSync(path.join(part, "FONTS.md"), "new\n");
  fs.writeFileSync(path.join(part, "fonts.css"), "new\n");
  fs.mkdirSync(path.join(part, "files"));
  for (const name of names) fs.writeFileSync(path.join(part, "files", name), "new");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

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

test("never writes into a folder that holds someone else's files, and reads an earlier kit without changing it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-dir-"));
  try {
    assert.equal(earlierKit(path.join(dir, "missing")), null);
    assert.equal(earlierKit(dir), null);
    fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
    assert.throws(() => earlierKit(dir), /not empty and holds no earlier font kit/);
    await assert.rejects(saveKit(dir, () => assert.fail("nothing is written")), /not empty and holds no earlier font kit/);
    assert.deepEqual(fs.readdirSync(dir), ["notes.txt"]);
    // An earlier kit's font files, by name only and only as files: a folder
    // under a name it lists is not the kit's.
    fs.rmSync(path.join(dir, "notes.txt"));
    fs.mkdirSync(path.join(dir, "files", "keep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "files", "keep", "mine.txt"), "mine");
    fs.writeFileSync(path.join(dir, "files", "acme-400.woff2"), "old");
    fs.writeFileSync(path.join(dir, "FONTS.md"), "old");
    const old = { version: 1, generator: "easyfontkit 0.1.0", families: [{ files: [{ file: "../../escape.woff2" }, { file: "files/acme-400.woff2" }, { file: "files/keep" }, { file: "files/gone.woff2" }] }] };
    fs.writeFileSync(path.join(dir, "fonts.json"), JSON.stringify(old));
    const before = snapshot(dir);
    assert.deepEqual(earlierKit(dir), { files: ["acme-400.woff2"] });
    assert.deepEqual(snapshot(dir), before);
    // Something other than a file where the new kit puts one, or other than
    // a folder where it puts its files, is refused before the page is read.
    for (const [name, make] of [["fonts.css", (at) => fs.mkdirSync(at)], ["files", (at) => fs.writeFileSync(at, "mine")]]) {
      const kept = path.join(dir, `${name}.kept`);
      if (fs.existsSync(path.join(dir, name))) fs.renameSync(path.join(dir, name), kept);
      make(path.join(dir, name));
      assert.throws(() => earlierKit(dir), { message: `No kit can be saved in ${dir}: ${path.join(dir, name)} is not a ${name === "files" ? "folder" : "file"}. Move it away, or pick another folder with --out.` });
      fs.rmSync(path.join(dir, name), { recursive: true });
      if (fs.existsSync(kept)) fs.renameSync(kept, path.join(dir, name));
    }
    // The lock, the marker of a waiter taking a stale lock over and the
    // part folders of runs do not count.
    const empty = path.join(dir, "empty");
    fs.mkdirSync(path.join(empty, ".easyfontkit-part-1-0000000a"), { recursive: true });
    fs.writeFileSync(path.join(empty, ".easyfontkit-lock"), "1");
    fs.writeFileSync(path.join(empty, ".easyfontkit-lock.stale"), "");
    assert.equal(earlierKit(empty), null);
    // A folder that holds no kit is refused for that, also when something
    // stands in it under the name of a kit file: moving that away would not
    // make it a kit.
    const site = path.join(dir, "site");
    fs.mkdirSync(path.join(site, "FONTS.md"), { recursive: true });
    fs.writeFileSync(path.join(site, "index.html"), "mine");
    const none = { message: `${site} is not empty and holds no earlier font kit. Pick another folder with --out.` };
    assert.throws(() => earlierKit(site), none);
    fs.rmdirSync(path.join(site, "FONTS.md"));
    fs.writeFileSync(path.join(site, "files"), "mine");
    assert.throws(() => earlierKit(site), none);
    if (process.platform !== "win32") {
      fs.rmSync(path.join(site, "files"));
      fs.symlinkSync(empty, path.join(site, "files"));
      assert.throws(() => earlierKit(site), none);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a run that fails leaves the earlier kit exactly as it was, and a first run that fails makes no folder", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-keep-"));
  const env = { ...process.env, CHROME_PATH: path.join(parent, "no-chrome") };
  try {
    const dir = path.join(parent, "kit");
    earlierKitIn(dir);
    const before = snapshot(dir);
    const failed = spawnSync(process.execPath, [CLI, "acme.example", "--out", dir], { encoding: "utf8", env });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /No Chrome, Chromium, Edge or Brave found/);
    assert.deepEqual(snapshot(dir), before);
    const deep = path.join(parent, "new", "deep", "kit");
    assert.equal(spawnSync(process.execPath, [CLI, "acme.example", "--out", deep], { env }).status, 1);
    assert.deepEqual(fs.readdirSync(parent).sort(), ["kit"]);
    // A save that fails removes the folders made for it, too.
    await assert.rejects(saveKit(deep, () => assert.fail("no kit")), /no kit/);
    assert.deepEqual(fs.readdirSync(parent).sort(), ["kit"]);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a folder the kit cannot be saved in is refused before the browser starts", { skip: (process.platform === "win32" && "no modes on Windows") || (process.getuid && process.getuid() === 0 && "root may write anywhere") }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-check-"));
  // No browser: a check that came after it would say so instead.
  const env = { ...process.env, CHROME_PATH: path.join(parent, "no-chrome") };
  const cli = (out) => spawnSync(process.execPath, [CLI, "acme.example", "--out", out], { encoding: "utf8", env });
  try {
    const locked = path.join(parent, "locked");
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o555);
    // A folder this user may not enter, found on the way up to --out.
    const noenter = path.join(parent, "noenter");
    fs.mkdirSync(noenter);
    fs.chmodSync(noenter, 0o600);
    const file = path.join(parent, "notes.txt");
    fs.writeFileSync(file, "mine");
    const kit = path.join(parent, "kit");
    earlierKitIn(kit);
    fs.rmSync(path.join(kit, "FONTS.md"));
    fs.mkdirSync(path.join(kit, "FONTS.md"));
    // The same folder where a kit file goes, in a folder that holds no kit.
    const site = path.join(parent, "site");
    fs.mkdirSync(path.join(site, "FONTS.md"), { recursive: true });
    fs.writeFileSync(path.join(site, "index.html"), "mine");
    const before = snapshot(parent);
    const refused = {
      [path.join(locked, "kit")]: `This user may not write in ${locked}, so ${path.join(locked, "kit")} cannot be made there. Pick another folder with --out.`,
      [locked]: `This user may not write in ${locked}. Pick another folder with --out.`,
      [path.join(noenter, "kit")]: `This user may not write in ${noenter}, so ${path.join(noenter, "kit")} cannot be made there. Pick another folder with --out.`,
      [file]: `${file} is not a folder. Pick another folder with --out.`,
      [path.join(file, "kit")]: `${file} is not a folder, so ${path.join(file, "kit")} cannot be made there. Pick another folder with --out.`,
      [kit]: `No kit can be saved in ${kit}: ${path.join(kit, "FONTS.md")} is not a file. Move it away, or pick another folder with --out.`,
      [site]: `${site} is not empty and holds no earlier font kit. Pick another folder with --out.`,
    };
    for (const [out, message] of Object.entries(refused)) {
      const run = cli(out);
      assert.equal(run.status, 1, out);
      assert.equal(run.stderr, `easyfontkit: ${message}\n`);
    }
    assert.deepEqual(snapshot(parent), before);
  } finally {
    fs.chmodSync(path.join(parent, "locked"), 0o755);
    fs.chmodSync(path.join(parent, "noenter"), 0o755);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("an --out that is a broken link or a link loop is refused before the page is read", { skip: process.platform === "win32" && "no symlinks of this kind on Windows" }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-link-"));
  const env = { ...process.env, CHROME_PATH: path.join(parent, "no-chrome") };
  const cli = (out) => spawnSync(process.execPath, [CLI, "acme.example", "--out", out], { encoding: "utf8", env });
  try {
    // A link to a folder that is not there.
    const broken = path.join(parent, "broken");
    fs.symlinkSync(path.join(parent, "nowhere", "kit"), broken);
    const run1 = cli(broken);
    assert.equal(run1.status, 1);
    assert.equal(run1.stderr, `easyfontkit: ${broken} is a link to a folder that is not there. Pick another folder with --out.\n`);
    // And on the way to --out.
    const below = cli(path.join(broken, "kit"));
    assert.equal(below.status, 1);
    assert.equal(below.stderr, `easyfontkit: ${broken} is a link to a folder that is not there, so ${path.join(broken, "kit")} cannot be made there. Pick another folder with --out.\n`);
    // A loop of links on the way to --out.
    fs.symlinkSync(path.join(parent, "b"), path.join(parent, "a"));
    fs.symlinkSync(path.join(parent, "a"), path.join(parent, "b"));
    const run2 = cli(path.join(parent, "a", "kit"));
    assert.equal(run2.status, 1);
    assert.equal(run2.stderr, `easyfontkit: ${path.join(parent, "a", "kit")} is not a folder this run can use. Pick another folder with --out.\n`);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a first run that fails removes only the folders it made, even with a .. in the path", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-made-"));
  try {
    // A folder that was already there, named on the far side of the ..
    fs.mkdirSync(path.join(parent, "keep"));
    // --out as the user might give it, with a .. that resolves back through
    // a folder this run makes.
    const out = `${path.join(parent, "gone")}${path.sep}..${path.sep}keep${path.sep}kit`;
    await assert.rejects(saveKit(out, () => assert.fail("no kit")), /no kit/);
    assert.equal(fs.existsSync(path.join(parent, "keep")), true, "a folder that was already there is left");
    assert.deepEqual(fs.readdirSync(path.join(parent, "keep")), [], "and left empty, as it was");
    assert.equal(fs.existsSync(path.join(parent, "gone")), false, "the folder the run made is removed");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a disk with no room for the new kit is reported plainly, and the earlier kit is left as it was", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-full-"));
  try {
    const full = () => {
      const err = new Error("ENOSPC: no space left on device, write");
      err.code = "ENOSPC";
      throw err;
    };
    const dir = path.join(parent, "kit");
    earlierKitIn(dir);
    const before = snapshot(dir);
    await assert.rejects(saveKit(dir, () => full()), {
      message: `There is no room on the disk to write the new kit beside the earlier one in ${dir}, so no kit was made. The earlier kit there is as it was.`,
    });
    assert.deepEqual(snapshot(dir), before);
    // A first run with no earlier kit says it plainly too, and makes no folder.
    const fresh = path.join(parent, "fresh", "kit");
    await assert.rejects(saveKit(fresh, () => full()), {
      message: `There is no room on the disk to write the new kit in ${fresh}, so no kit was made.`,
    });
    assert.equal(fs.existsSync(path.join(parent, "fresh")), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("the message for a kit that could not be put in place says nothing was saved when the folder had no kit", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-first-"));
  try {
    const dir = path.join(parent, "kit");
    // A first run: something comes where a new file goes while the page is
    // read, so the kit cannot be put in place. There was no earlier kit.
    await assert.rejects(
      saveKit(dir, (part, own) => {
        assert.deepEqual(own, []);
        newKitIn(part, ["inter-400.woff2"]);
        fs.writeFileSync(path.join(dir, "FONTS.md"), "in the way");
      }),
      { message: `The new kit could not be put in place in ${dir} (FONTS.md is in the way), so nothing was saved there.` },
    );
    assert.equal(fs.existsSync(path.join(dir, "fonts.json")), false, "no kit was saved");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("the new kit goes in only whole: a step that fails puts the earlier kit back", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-swap-"));
  try {
    const dir = path.join(parent, "kit");
    earlierKitIn(dir);
    // A file moved aside and back keeps its time; the folder it was in
    // shows the moves in its own.
    const before = snapshot(dir, { folderTimes: false });
    let inTheWay;
    await assert.rejects(
      () =>
        saveKit(dir, (part, own) => {
          assert.deepEqual(own, ["notes.txt"]);
          newKitIn(part, ["inter-400.woff2", "inter-700.woff2"]);
          // Someone's folder came where a new file goes while the page was read.
          fs.mkdirSync(path.join(dir, "files", "inter-700.woff2"));
          inTheWay = snapshot(dir, { folderTimes: false }).filter((line) => !line.startsWith(".easyfontkit-"));
        }),
      (err) => err.message === `The new kit could not be put in place in ${dir} (${path.join("files", "inter-700.woff2")} is in the way), so the earlier kit there is as it was.`,
    );
    assert.deepEqual(snapshot(dir, { folderTimes: false }), inTheWay);
    fs.rmdirSync(path.join(dir, "files", "inter-700.woff2"));
    assert.deepEqual(snapshot(dir, { folderTimes: false }), before);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// Two runs saving into one folder, each in a thread of its own that goes by
// another pid, as two processes would. Once both have written their kit, or
// one of them waits for the other's lock, their lstat and rename calls take
// turns as schedule says: 0 for the first run, 1 for the second. A run that
// waits for the lock, or is done, lets the other go on.
const SAVER = `
const { workerData, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const { kitjs, dir, tag, id, shared, schedule, names } = workerData;
// shared: [0] calls made, [1 + id] run id is done, [3] runs that wrote
// their kit, [4 + id] run id waits for the lock.
const other = 1 - id;
const free = () => Atomics.load(shared, 1 + other) || Atomics.load(shared, 4 + other);
const turn = (call) => {
  for (;;) {
    const at = Atomics.load(shared, 0);
    if (at >= schedule.length || schedule[at] === id || free()) break;
    Atomics.wait(shared, 0, at, 5);
  }
  try {
    return call();
  } finally {
    Atomics.add(shared, 0, 1);
    Atomics.notify(shared, 0);
  }
};
if (id === 1) Object.defineProperty(process, "pid", { value: 1 });
const { lstatSync, renameSync, openSync } = fs;
fs.openSync = (file, ...rest) => {
  if (!String(file).endsWith(".easyfontkit-lock")) return openSync(file, ...rest);
  try {
    const fd = openSync(file, ...rest);
    Atomics.store(shared, 4 + id, 0);
    return fd;
  } catch (err) {
    if (err.code === "EEXIST") Atomics.store(shared, 4 + id, 1);
    Atomics.notify(shared, 0);
    throw err;
  }
};
const { saveKit } = require(kitjs);
(async () => {
  let result = "ok";
  try {
    await saveKit(dir, (part) => {
      fs.writeFileSync(path.join(part, "fonts.json"), JSON.stringify({ version: 1, generator: "easyfontkit " + tag, families: [{ files: names.map((name) => ({ file: "files/" + name })) }] }));
      fs.writeFileSync(path.join(part, "FONTS.md"), tag);
      fs.writeFileSync(path.join(part, "fonts.css"), tag);
      fs.mkdirSync(path.join(part, "files"));
      for (const name of names) fs.writeFileSync(path.join(part, "files", name), tag);
      Atomics.add(shared, 3, 1);
      while (Atomics.load(shared, 3) < 2 && !free()) Atomics.wait(shared, 3, Atomics.load(shared, 3), 5);
      fs.lstatSync = (...args) => turn(() => lstatSync(...args));
      fs.renameSync = (...args) => turn(() => renameSync(...args));
    });
  } catch (err) {
    result = err.message;
  }
  fs.lstatSync = lstatSync;
  fs.renameSync = renameSync;
  Atomics.store(shared, 1 + id, 1);
  Atomics.notify(shared, 0);
  parentPort.postMessage(result);
})();
`;

test("two runs that save into one folder at the same moment take turns: both end well, and the folder holds the second one's kit whole", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-turns-"));
  const names = ["inter-400.woff2", "inter-700.woff2", "acme-400.woff2"];
  // Every few offsets of the two in lockstep, and some at random.
  const schedules = [];
  for (let offset = 0; offset <= 40; offset += 4) schedules.push(Array.from({ length: 300 }, (_, i) => (i < offset ? 0 : (i - offset) % 2)));
  for (let seed = 1; seed <= 6; seed++) {
    let x = seed * 2654435761;
    schedules.push(Array.from({ length: 300 }, () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) >> 16) & 1));
  }
  const save = (dir, tag, id, shared, schedule) =>
    new Promise((resolve) => {
      const worker = new Worker(SAVER, { eval: true, workerData: { kitjs: require.resolve("../skills/easyfontkit/scripts/lib/kit"), dir, tag, id, shared, schedule, names } });
      worker.on("message", resolve);
      worker.on("error", (err) => resolve(`crashed: ${err.message}`));
    });
  try {
    for (const [n, order] of schedules.entries()) {
      const dir = path.join(parent, `kit${n}`);
      earlierKitIn(dir);
      const shared = new Int32Array(new SharedArrayBuffer(32));
      const schedule = new Int32Array(new SharedArrayBuffer(4 * order.length));
      schedule.set(order);
      assert.deepEqual(await Promise.all([save(dir, "A", 0, shared, schedule), save(dir, "B", 1, shared, schedule)]), ["ok", "ok"], `schedule ${n}`);
      // The one that went second holds the folder; the earlier kit and the
      // first one's kit are gone with their part folders.
      const last = fs.readFileSync(path.join(dir, "FONTS.md"), "utf8");
      assert.deepEqual(fs.readdirSync(dir).sort(), ["FONTS.md", "files", "fonts.css", "fonts.json"], `schedule ${n}`);
      assert.deepEqual(fs.readdirSync(path.join(dir, "files")).sort(), [...names, "notes.txt"].sort(), `schedule ${n}`);
      for (const name of ["fonts.css", ...names.map((name) => `files/${name}`)]) assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), last, `schedule ${n}: ${name}`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "fonts.json"), "utf8")).generator, `easyfontkit ${last}`);
      assert.equal(fs.readFileSync(path.join(dir, "files", "notes.txt"), "utf8"), "mine");
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a run still saving into the folder is waited for, and a lock a killed run left is taken over", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-lock-"));
  try {
    const dir = path.join(parent, "kit");
    earlierKitIn(dir);
    const lockFile = path.join(dir, ".easyfontkit-lock");
    // Another process holds the lock for 400 ms.
    const holder = spawn(process.execPath, ["-e", `const fs = require("fs"); fs.writeFileSync(${JSON.stringify(lockFile)}, String(process.pid), { flag: "wx" }); console.log("locked"); setTimeout(() => fs.rmSync(${JSON.stringify(lockFile)}), 400);`], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve) => holder.stdout.once("data", resolve));
    const started = Date.now();
    await saveKit(dir, (part) => newKitIn(part, ["inter-400.woff2"]));
    assert.ok(Date.now() - started >= 250, `saved after ${Date.now() - started} ms, while the other run held the lock`);
    assert.equal(fs.readFileSync(path.join(dir, "FONTS.md"), "utf8"), "new\n");
    // A lock whose process has ended.
    const ended = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
    fs.writeFileSync(lockFile, ended);
    await saveKit(dir, (part) => newKitIn(part, ["inter-700.woff2"]));
    assert.deepEqual(fs.readdirSync(dir).sort(), ["FONTS.md", "files", "fonts.css", "fonts.json"]);
    assert.deepEqual(fs.readdirSync(path.join(dir, "files")).sort(), ["inter-700.woff2", "notes.txt"]);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a run that waits for another run's lock makes the folder again when that run fails and removes it, and the folder is then its own", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-gone-"));
  // The other run, still going.
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
  const mkdirSync = fs.mkdirSync;
  try {
    for (const [fails, madeBy] of [
      [false, "the other run"],
      [true, "the other run"],
      [false, "this run"],
      [true, "this run"],
    ]) {
      // The other run made the new folder and holds its lock while this run
      // waits for it. Or this run made it, and the other run, whose mkdir of
      // the same path came at the same moment, takes the lock at once and
      // counts the folder as its own.
      const dir = path.join(parent, "new", "kit");
      const lockIn = () => fs.writeFileSync(path.join(dir, ".easyfontkit-lock"), String(other.pid));
      if (madeBy === "the other run") {
        fs.mkdirSync(dir, { recursive: true });
        lockIn();
      } else {
        fs.mkdirSync = (target, ...rest) => {
          const made = mkdirSync(target, ...rest);
          if (path.resolve(String(target)) === dir) {
            fs.mkdirSync = mkdirSync;
            lockIn();
          }
          return made;
        };
      }
      const saving = saveKit(dir, (part) => {
        if (fails) throw new Error("no kit");
        newKitIn(part, ["inter-400.woff2"]);
      });
      fs.mkdirSync = mkdirSync;
      await sleep(200);
      // Its save fails: it lets go of the lock and removes the folders it made.
      fs.rmSync(path.join(dir, ".easyfontkit-lock"));
      fs.rmdirSync(dir);
      fs.rmdirSync(path.join(parent, "new"));
      if (!fails) {
        await saving;
        assert.deepEqual(fs.readdirSync(dir).sort(), ["FONTS.md", "files", "fonts.css", "fonts.json"], madeBy);
        assert.deepEqual(fs.readdirSync(path.join(dir, "files")), ["inter-400.woff2"]);
        fs.rmSync(path.join(parent, "new"), { recursive: true });
      } else {
        // This run made them again, so its own failure removes them.
        await assert.rejects(saving, /no kit/, madeBy);
        assert.deepEqual(fs.readdirSync(parent), [], madeBy);
      }
    }
  } finally {
    fs.mkdirSync = mkdirSync;
    other.kill();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a run stopped while it waits for another run's lock leaves the folder as it was and ends by the signal", { skip: noBrowser || noSignals }, async () => {
  const { server, origin } = await serve({ "/": { body: `<!doctype html><html><head><title>Fast</title></head><body><h1>Fast</h1><p>Loads at once.</p></body></html>` } });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-wait-"));
  const dir = path.join(parent, "kit");
  let child;
  let holder;
  try {
    earlierKitIn(dir);
    // Another process holds the folder's lock while the run waits for it.
    const lockFile = path.join(dir, ".easyfontkit-lock");
    holder = spawn(process.execPath, ["-e", `const fs = require("fs"); fs.writeFileSync(${JSON.stringify(lockFile)}, String(process.pid), { flag: "wx" }); console.log("held"); setTimeout(() => {}, 30_000);`], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve) => holder.stdout.once("data", resolve));
    const before = snapshot(dir);
    // In a process group of its own, as makersmcp runs a kit. The run reads
    // the page, then waits for the lock; the stop reaches it during the wait.
    child = spawn(process.execPath, [CLI, origin, "--out", dir], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    const waiting = new Promise((resolve) => child.stderr.on("data", (chunk) => /Reading the font files/.test((stderr += chunk)) && resolve()));
    await Promise.race([waiting, ended]);
    assert.match(stderr, /Reading the font files/, stderr);
    await sleep(200);
    process.kill(-child.pid, "SIGTERM");
    const { signal } = await ended;
    assert.equal(signal, "SIGTERM");
    assert.ok(stderr.endsWith(`\neasyfontkit: stopped by SIGTERM, so no kit was made. The earlier kit in ${dir} is as it was.\n`), stderr);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Nothing of its group is left.
    }
    if (holder) holder.kill("SIGKILL");
    server.close();
    fs.rmSync(parent, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a run killed outright while it moves its kit in leaves the earlier kit for the next run to put back", { skip: noSignals }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-killed-"));
  try {
    // Killed with SIGKILL right after its KILL_AT-th rename.
    const killer = path.join(parent, "killer.js");
    fs.writeFileSync(killer, `const fs = require("fs"); const rename = fs.renameSync; let n = 0; fs.renameSync = (...args) => { rename(...args); if (++n === Number(process.env.KILL_AT)) process.kill(process.pid, "SIGKILL"); };`);
    const saver = path.join(parent, "saver.js");
    fs.writeFileSync(
      saver,
      `const fs = require("fs"); const path = require("path");
       require(${JSON.stringify(require.resolve("../skills/easyfontkit/scripts/lib/kit"))}).saveKit(process.argv[2], (part) => {
         fs.writeFileSync(path.join(part, "fonts.json"), JSON.stringify({ version: 1, generator: "easyfontkit killed", families: [{ files: [{ file: "files/inter-400.woff2" }, { file: "files/acme-400.woff2" }] }] }));
         fs.writeFileSync(path.join(part, "FONTS.md"), "killed"); fs.writeFileSync(path.join(part, "fonts.css"), "killed");
         fs.mkdirSync(path.join(part, "files")); for (const name of ["inter-400.woff2", "acme-400.woff2"]) fs.writeFileSync(path.join(part, "files", name), "killed");
       }).catch((err) => { process.stderr.write(String((err && err.message) || err)); process.exit(1); });`,
    );
    for (const first of [false, true]) {
      let k = 1;
      for (; ; k++) {
        const dir = path.join(parent, `${first ? "first" : "again"}-${k}`);
        if (!first) earlierKitIn(dir);
        const before = snapshot(dir, { folderTimes: false });
        const killed = spawnSync(process.execPath, ["--require", killer, saver, dir], { env: { ...process.env, KILL_AT: String(k) } });
        if (killed.signal !== "SIGKILL") {
          assert.equal(killed.status, 0, String(killed.stderr));
          break;
        }
        // The next run puts back what the killed one had moved before its
        // own kit is written: here that fails, so the folder is the earlier
        // kit exactly, or empty when there was none.
        await assert.rejects(saveKit(dir, () => assert.fail("no kit")), /no kit/, `killed after rename ${k}`);
        assert.deepEqual(snapshot(dir, { folderTimes: false }), before || [], `killed after rename ${k}`);
        // And one that ends well leaves its own kit whole.
        await saveKit(dir, (part) => newKitIn(part, ["inter-400.woff2"]));
        assert.deepEqual(fs.readdirSync(dir).sort(), ["FONTS.md", "files", "fonts.css", "fonts.json"], `killed after rename ${k}`);
        assert.deepEqual(fs.readdirSync(path.join(dir, "files")).sort(), first ? ["inter-400.woff2"] : ["inter-400.woff2", "notes.txt"]);
      }
      // The list of moves, every move, and the run that was not killed.
      assert.ok(k >= (first ? 6 : 11), `only ${k - 1} renames`);
    }
    // A file put by hand where the killed run's FONTS.md went is never moved
    // away: the earlier kit's FONTS.md stays aside, and the run says where.
    const dir = path.join(parent, "edited");
    const shown = () => (fs.existsSync(path.join(dir, "FONTS.md")) ? fs.readFileSync(path.join(dir, "FONTS.md"), "utf8") : "");
    for (let k = 1; shown() !== "killed"; k++) {
      fs.rmSync(dir, { recursive: true, force: true });
      earlierKitIn(dir);
      assert.equal(spawnSync(process.execPath, ["--require", killer, saver, dir], { env: { ...process.env, KILL_AT: String(k) } }).signal, "SIGKILL");
    }
    fs.writeFileSync(path.join(dir, "FONTS.md"), "edited");
    const part = fs.readdirSync(dir).find((name) => name.startsWith(".easyfontkit-part-"));
    await assert.rejects(saveKit(dir, () => assert.fail("no kit")), {
      message: `A run killed while it put its kit in ${dir} left the earlier kit there half moved, and it could not be put back together (FONTS.md is taken), so no kit was made. The earlier kit's files that could not go back are in ${path.join(dir, part, "earlier")}; move them back by hand, or pick another folder with --out.`,
    });
    assert.equal(fs.readFileSync(path.join(dir, "FONTS.md"), "utf8"), "edited");
    assert.equal(fs.readFileSync(path.join(dir, part, "earlier", "FONTS.md"), "utf8"), "# Fonts of acme.example\n");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a planted list of moves, or a files that is a link, cannot send a run outside its folder", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-plant-"));
  try {
    const outside = path.join(parent, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "mine");
    // A list of moves that points outside the folder, or at any name other
    // than the ones a run writes, is not the kit's own: it is refused, and
    // nothing it names is moved or removed.
    const dir = path.join(parent, "kit");
    const own = ".easyfontkit-part-999999999-deadbeef";
    fs.mkdirSync(path.join(dir, own, "payload"), { recursive: true });
    fs.writeFileSync(path.join(dir, own, "payload", "x.txt"), "planted");
    fs.writeFileSync(path.join(dir, own, "moves.json"), JSON.stringify([["../escaped", `${own}/payload`, { names: ["x.txt"] }]]));
    await assert.rejects(saveKit(dir, () => assert.fail("no kit")), /could not be put back together/);
    assert.equal(fs.existsSync(path.join(parent, "escaped")), false, "nothing was moved out of the folder");
    assert.deepEqual(fs.readdirSync(outside).sort(), ["keep.txt"]);
    // A files that is a link is refused before the folder is read, so the
    // kit never follows it to delete or write the files it points at.
    const linked = path.join(parent, "linked");
    fs.mkdirSync(linked);
    fs.writeFileSync(path.join(linked, "fonts.json"), JSON.stringify({ version: 1, generator: "easyfontkit 0.1.1", families: [{ files: [{ file: "files/keep.txt" }] }] }));
    fs.writeFileSync(path.join(linked, "FONTS.md"), "old");
    fs.writeFileSync(path.join(linked, "fonts.css"), "old");
    fs.symlinkSync(outside, path.join(linked, "files"));
    const message = `No kit can be saved in ${linked}: ${path.join(linked, "files")} is a link, not a folder. Move it away, or pick another folder with --out.`;
    assert.throws(() => earlierKit(linked), { message });
    await assert.rejects(saveKit(linked, () => assert.fail("no kit")), { message });
    assert.deepEqual(fs.readdirSync(outside).sort(), ["keep.txt"]);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a leftover list of moves is followed only when it and its part folder are this user's own", { skip: !process.getuid && "no owners to compare on Windows" }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-owner-"));
  const lstatSync = fs.lstatSync;
  try {
    // A list that names only a move a run makes, put there by someone else
    // who may write in the kit's folder: it would move the user's files
    // folder into its part folder, which is then removed.
    const own = ".easyfontkit-part-999999999-deadbeef";
    for (const planted of [own, `${own}/moves.json`]) {
      const dir = path.join(parent, planted.endsWith(".json") ? "list" : "part");
      earlierKitIn(dir);
      fs.mkdirSync(path.join(dir, own));
      fs.writeFileSync(path.join(dir, own, "moves.json"), JSON.stringify([[`${own}/files`, "files", { names: fs.readdirSync(path.join(dir, "files")).sort() }]]));
      const before = snapshot(dir);
      fs.lstatSync = (file, ...rest) => {
        const stat = lstatSync(file, ...rest);
        return String(file) === path.join(dir, planted) ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: stat.uid + 1 }) : stat;
      };
      try {
        await assert.rejects(saveKit(dir, () => assert.fail("no kit")), /could not be put back together \(its list of moves cannot be followed\)/, planted);
      } finally {
        fs.lstatSync = lstatSync;
      }
      assert.deepEqual(snapshot(dir), before, planted);
    }
  } finally {
    fs.lstatSync = lstatSync;
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a leftover list of moves is never followed through a link, in its part folder or at the kit's files", { skip: process.platform === "win32" && "no symlinks of this kind on Windows" }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-links-"));
  const own = ".easyfontkit-part-999999999-deadbeef";
  const id = (file) => {
    const stat = fs.lstatSync(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  };
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  // Each list passes as one a run writes, and would move a file in or out
  // of the folder outside if its link were followed.
  const setups = {
    "the part": (dir, outside) => {
      put(path.join(outside, "earlier", "fonts.json"), "outside");
      fs.symlinkSync(outside, path.join(dir, own));
      return [["fonts.json", `${own}/earlier/fonts.json`, id(path.join(outside, "earlier", "fonts.json"))]];
    },
    "the part's earlier": (dir, outside) => {
      put(path.join(outside, "fonts.json"), "outside");
      fs.mkdirSync(path.join(dir, own), { recursive: true });
      fs.symlinkSync(outside, path.join(dir, own, "earlier"));
      return [["fonts.json", `${own}/earlier/fonts.json`, id(path.join(outside, "fonts.json"))]];
    },
    "the part's earlier/files": (dir, outside) => {
      put(path.join(outside, "mine.woff2"), "outside");
      fs.mkdirSync(path.join(dir, own, "earlier"), { recursive: true });
      fs.symlinkSync(outside, path.join(dir, own, "earlier", "files"));
      return [["files/mine.woff2", `${own}/earlier/files/mine.woff2`, id(path.join(outside, "mine.woff2"))]];
    },
    "the part's files": (dir, outside) => {
      put(path.join(dir, "files", "planted.sh"), "planted");
      fs.mkdirSync(path.join(dir, own), { recursive: true });
      fs.symlinkSync(outside, path.join(dir, own, "files"));
      return [[`${own}/files/planted.sh`, "files/planted.sh", id(path.join(dir, "files", "planted.sh"))]];
    },
    "the kit's files": (dir, outside) => {
      put(path.join(dir, own, "earlier", "files", "planted.sh"), "planted");
      fs.symlinkSync(outside, path.join(dir, "files"));
      return [["files/planted.sh", `${own}/earlier/files/planted.sh`, id(path.join(dir, own, "earlier", "files", "planted.sh"))]];
    },
  };
  try {
    for (const [n, [name, plant]] of Object.entries(setups).entries()) {
      const dir = path.join(parent, `kit${n}`);
      const outside = path.join(parent, `outside${n}`);
      fs.mkdirSync(dir);
      put(path.join(outside, "keep.txt"), "mine");
      const moves = plant(dir, outside);
      if (!fs.existsSync(path.join(dir, "files"))) fs.mkdirSync(path.join(dir, "files"));
      fs.writeFileSync(path.join(dir, own, "moves.json"), JSON.stringify(moves));
      const before = snapshot(outside);
      if (name === "the kit's files") {
        // Refused before the page is read, also next to a list of moves.
        assert.throws(() => earlierKit(dir), /files is a link, not a folder/);
      }
      await assert.rejects(saveKit(dir, () => assert.fail("no kit")), /could not be put back together \(its list of moves cannot be followed\)/, name);
      assert.deepEqual(snapshot(outside), before, name);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a lock: a run lets go only of its own, a stale one is taken over by one waiter at a time, and a marker a killed waiter left is cleared", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-own-"));
  try {
    const dir = path.join(parent, "kit");
    earlierKitIn(dir);
    const lockFile = path.join(dir, ".easyfontkit-lock");
    const marker = `${lockFile}.stale`;
    // Taken over by another run while this one saved: that run's lock stays.
    await saveKit(dir, (part) => {
      newKitIn(part, ["inter-400.woff2"]);
      fs.writeFileSync(lockFile, "999999999");
    });
    assert.equal(fs.readFileSync(lockFile, "utf8"), "999999999");
    // A stale lock, a killed run's, while another waiter holds the marker:
    // this one waits for it.
    const ended = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
    fs.writeFileSync(lockFile, ended);
    fs.writeFileSync(marker, "");
    const saving = saveKit(dir, (part) => newKitIn(part, ["inter-700.woff2"]));
    await sleep(400);
    assert.equal(fs.readFileSync(lockFile, "utf8"), ended, "the stale lock is left to the waiter with the marker");
    fs.rmSync(marker);
    await saving;
    assert.equal(fs.existsSync(lockFile), false);
    assert.deepEqual(fs.readdirSync(path.join(dir, "files")).sort(), ["inter-700.woff2", "notes.txt"]);
    // A marker older than any wait was left by a waiter killed outright.
    fs.writeFileSync(lockFile, ended);
    fs.writeFileSync(marker, "");
    const old = (Date.now() - 60_000) / 1000;
    fs.utimesSync(marker, old, old);
    const started = Date.now();
    await saveKit(dir, (part) => newKitIn(part, ["inter-900.woff2"]));
    assert.ok(Date.now() - started < 3_000, `saved after ${Date.now() - started} ms`);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["FONTS.md", "files", "fonts.css", "fonts.json"]);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a run being stopped gives up the wait for another run's lock at once and leaves the folder as it was", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-stopping-"));
  try {
    const dir = path.join(parent, "kit");
    earlierKitIn(dir);
    // Held by this living process.
    fs.writeFileSync(path.join(dir, ".easyfontkit-lock"), String(process.pid));
    const before = snapshot(dir);
    const script = `const { saveKit, stopRuns } = require(${JSON.stringify(require.resolve("../skills/easyfontkit/scripts/lib/kit"))});
      stopRuns();
      const started = Date.now();
      saveKit(${JSON.stringify(dir)}, () => { throw new Error("written"); }).then(
        () => console.log(JSON.stringify({ message: "saved" })),
        (err) => console.log(JSON.stringify({ message: err.message, ms: Date.now() - started })),
      );`;
    const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000 });
    const { message, ms } = JSON.parse(child.stdout);
    assert.equal(message, "stopped while waiting for another run to finish saving");
    assert.ok(ms < 2_000, `gave up after ${ms} ms`);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a lock and a part folder that name this process's own pid were left by an earlier process with that pid, as in a fresh container, and go at once", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-ownpid-"));
  try {
    const dir = path.join(parent, "kit");
    earlierKitIn(dir);
    const left = `.easyfontkit-part-${process.pid}-0000000a`;
    for (const lock of [true, false]) {
      if (lock) fs.writeFileSync(path.join(dir, ".easyfontkit-lock"), String(process.pid));
      fs.mkdirSync(path.join(dir, left));
      fs.writeFileSync(path.join(dir, left, "fonts.json"), "{}");
      const started = Date.now();
      await saveKit(dir, (part) => newKitIn(part, ["inter-400.woff2"]));
      assert.ok(Date.now() - started < 3_000, `saved after ${Date.now() - started} ms`);
      assert.deepEqual(fs.readdirSync(dir).sort(), ["FONTS.md", "files", "fonts.css", "fonts.json"]);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a lock is waited for while another user's run holds it or its run has only just made it, and taken over once it is older than any save", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-held-"));
  const kill = process.kill;
  const going = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  try {
    const dir = path.join(parent, "kit");
    earlierKitIn(dir);
    const lockFile = path.join(dir, ".easyfontkit-lock");
    // Held for 400 ms, then let go: the run waits for it.
    const held = async (text) => {
      fs.writeFileSync(lockFile, text);
      const started = Date.now();
      const saving = saveKit(dir, (part) => newKitIn(part, ["inter-400.woff2"]));
      await sleep(400);
      assert.equal(fs.readFileSync(lockFile, "utf8"), text, `the lock holding "${text}" is waited for`);
      fs.rmSync(lockFile);
      await saving;
      assert.ok(Date.now() - started >= 400);
    };
    // Another user's process, which this user may not signal.
    const other = 4_000_001;
    process.kill = function (pid, signal) {
      if (pid === other && signal === 0) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      return kill.apply(process, arguments);
    };
    await held(String(other));
    process.kill = kill;
    // Made a moment ago, before its run wrote its pid in it.
    await held("");
    // Taken over at once: one with no pid left for more than a few seconds,
    // and one whose process lives on but is older than any save takes, as a
    // pid that came round again on another process.
    for (const [text, ago] of [["", 10_000], [String(going.pid), 180_000]]) {
      fs.writeFileSync(lockFile, text);
      const then = (Date.now() - ago) / 1000;
      fs.utimesSync(lockFile, then, then);
      const started = Date.now();
      await saveKit(dir, (part) => newKitIn(part, ["inter-700.woff2"]));
      assert.ok(Date.now() - started < 3_000, `saved after ${Date.now() - started} ms past a lock holding "${text}"`);
      assert.equal(fs.existsSync(lockFile), false);
    }
  } finally {
    process.kill = kill;
    going.kill();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("an --out with a name too long for the system is refused before the page is read, with a plain message", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-long-"));
  try {
    const out = path.join(parent, "x".repeat(300), "kit");
    const run = spawnSync(process.execPath, [CLI, "acme.example", "--out", out], { encoding: "utf8", env: { ...process.env, CHROME_PATH: path.join(parent, "no-chrome") } });
    assert.equal(run.status, 1);
    assert.equal(run.stderr, `easyfontkit: ${out} is not a folder this run can use. Pick another folder with --out.\n`);
    assert.deepEqual(fs.readdirSync(parent), []);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("an earlier kit whose fonts.json another run is moving in as it is read is not refused", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-reread-"));
  const readFileSync = fs.readFileSync;
  try {
    const dir = path.join(parent, "kit");
    earlierKitIn(dir);
    // The first read finds no fonts.json, as between a run's last move and
    // the removal of its list of moves; the second finds it in place.
    let misses = 1;
    fs.readFileSync = (file, ...rest) => {
      if (String(file) === path.join(dir, "fonts.json") && misses-- > 0) throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      return readFileSync(file, ...rest);
    };
    assert.deepEqual(earlierKit(dir), { files: ["acme-400.woff2"] });
    assert.equal(misses, -1, "fonts.json was read twice");
  } finally {
    fs.readFileSync = readFileSync;
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a disk that runs out at the lock or while the folders are made leaves nothing behind and says so", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-nospace-"));
  const { writeSync, mkdirSync } = fs;
  const full = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  try {
    // The lock is made, but its pid cannot be written.
    fs.writeSync = () => {
      fs.writeSync = writeSync;
      throw full();
    };
    const fresh = path.join(parent, "fresh", "kit");
    await assert.rejects(saveKit(fresh, () => assert.fail("no kit")), { message: `There is no room on the disk to write the new kit in ${fresh}, so no kit was made.` });
    assert.equal(fs.existsSync(path.join(parent, "fresh")), false);
    const dir = path.join(parent, "kit");
    earlierKitIn(dir);
    const before = snapshot(dir);
    fs.writeSync = () => {
      fs.writeSync = writeSync;
      throw full();
    };
    await assert.rejects(saveKit(dir, () => assert.fail("no kit")), {
      message: `There is no room on the disk to write the new kit beside the earlier one in ${dir}, so no kit was made. The earlier kit there is as it was.`,
    });
    assert.deepEqual(snapshot(dir), before);
    // mkdir makes the first folder of a new path, then runs out.
    const deep = path.join(parent, "deep", "er", "kit");
    fs.mkdirSync = (...args) => {
      fs.mkdirSync = mkdirSync;
      mkdirSync(path.join(parent, "deep"));
      throw full();
    };
    await assert.rejects(saveKit(deep, () => assert.fail("no kit")), { message: `There is no room on the disk to write the new kit in ${deep}, so no kit was made.` });
    assert.deepEqual(fs.readdirSync(parent).sort(), ["kit"]);
  } finally {
    Object.assign(fs, { writeSync, mkdirSync });
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("prepareDir does what it did in 0.1.1: it makes a missing folder and clears an earlier kit's own files, while the user's stay, and refuses what makeFontKit refuses", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-prepare-"));
  try {
    // An earlier kit, with a file of the user's in its files folder.
    const dir = path.join(parent, "kit");
    earlierKitIn(dir);
    prepareDir(dir);
    assert.deepEqual(fs.readdirSync(dir), ["files"]);
    assert.deepEqual(fs.readdirSync(path.join(dir, "files")), ["notes.txt"]);
    // Without one, the files folder goes too, and code that writes its kit
    // as it did with 0.1.1 can make it again.
    fs.rmSync(dir, { recursive: true });
    earlierKitIn(dir);
    fs.rmSync(path.join(dir, "files", "notes.txt"));
    prepareDir(dir);
    assert.deepEqual(fs.readdirSync(dir), []);
    fs.mkdirSync(path.join(dir, "files"));
    const fresh = path.join(parent, "new", "kit");
    prepareDir(fresh);
    assert.deepEqual(fs.readdirSync(fresh), []);
    // A folder of someone else's is refused, and left as it was.
    fs.writeFileSync(path.join(fresh, "notes.txt"), "mine");
    assert.throws(() => prepareDir(fresh), /not empty and holds no earlier font kit/);
    assert.deepEqual(fs.readdirSync(fresh), ["notes.txt"]);
    // So is a folder a run killed outright left half replaced: its earlier
    // fonts.json is aside, in that run's part folder.
    const cut = path.join(parent, "cut");
    earlierKitIn(cut);
    const own = ".easyfontkit-part-12345-0000000c";
    fs.mkdirSync(path.join(cut, own, "earlier"), { recursive: true });
    fs.renameSync(path.join(cut, "fonts.json"), path.join(cut, own, "earlier", "fonts.json"));
    fs.writeFileSync(path.join(cut, own, "moves.json"), "[]");
    const before = snapshot(cut);
    assert.throws(() => prepareDir(cut), { message: `A run killed while it put its kit in ${cut} left the earlier kit there half moved. The next easyfontkit run that saves a kit there puts it back together first; or pick another folder with --out.` });
    assert.deepEqual(snapshot(cut), before);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a leftover list of moves is put back even when its run's pid is in use again", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-reuse-"));
  // A living process whose pid the killed run's part folder names.
  const going = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  try {
    const dir = path.join(parent, "kit");
    earlierKitIn(dir);
    const before = snapshot(dir, { folderTimes: false });
    // A kit half moved in, then killed right after its first move: the
    // earlier fonts.json went aside. The part names a pid that now belongs
    // to another, living process.
    const own = `.easyfontkit-part-${going.pid}-deadbeef`;
    fs.mkdirSync(path.join(dir, own, "earlier"), { recursive: true });
    fs.renameSync(path.join(dir, "fonts.json"), path.join(dir, own, "earlier", "fonts.json"));
    const st = fs.lstatSync(path.join(dir, own, "earlier", "fonts.json"));
    fs.writeFileSync(path.join(dir, own, "moves.json"), JSON.stringify([["fonts.json", `${own}/earlier/fonts.json`, { size: st.size, mtimeMs: st.mtimeMs }]]));
    assert.equal(gone(going.pid), false, "the pid is in use");
    // The next run puts the earlier kit back first, whatever the pid says;
    // here its own write fails, so the folder is the earlier kit exactly.
    await assert.rejects(saveKit(dir, () => assert.fail("no kit")), /no kit/);
    assert.deepEqual(snapshot(dir, { folderTimes: false }), before, "the earlier kit is whole again");
  } finally {
    going.kill();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a run that ends well leaves its kit, the user's files, and the part folders of runs still going", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-tidy-"));
  const going = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  try {
    const dir = path.join(parent, "kit");
    earlierKitIn(dir);
    // The part folders of a run killed outright and of one still going.
    const ended = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
    const dead = `.easyfontkit-part-${ended}-0000000a`;
    const live = `.easyfontkit-part-${going.pid}-0000000b`;
    fs.mkdirSync(path.join(dir, dead));
    fs.writeFileSync(path.join(dir, dead, "fonts.json"), "{}");
    fs.mkdirSync(path.join(dir, live));
    // A file of the user's under the name a new font file would take.
    fs.writeFileSync(path.join(dir, "files", "Inter-400.woff2"), "mine");
    await saveKit(dir, (part, own) => {
      assert.deepEqual(own.sort(), ["Inter-400.woff2", "notes.txt"]);
      newKitIn(part, ["inter-400-2.woff2"]);
    });
    assert.deepEqual(fs.readdirSync(dir).sort(), [live, "FONTS.md", "files", "fonts.css", "fonts.json"].sort());
    assert.deepEqual(fs.readdirSync(path.join(dir, "files")).sort(), ["Inter-400.woff2", "inter-400-2.woff2", "notes.txt"]);
    assert.equal(fs.readFileSync(path.join(dir, "FONTS.md"), "utf8"), "new\n");
    assert.equal(fs.readFileSync(path.join(dir, "files", "Inter-400.woff2"), "utf8"), "mine");
  } finally {
    going.kill();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("the part folder is made with mkdir, so the access a default ACL gives others reaches it", { skip: process.platform === "win32" && "no modes on Windows" }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-mode-"));
  const umask = process.umask(0o027);
  try {
    let mode = 0;
    await saveKit(path.join(parent, "kit"), (part) => {
      mode = fs.statSync(part).mode & 0o777;
      newKitIn(part);
    });
    assert.equal(mode.toString(8), "750", "mkdtemp would give 700");
  } finally {
    process.umask(umask);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a stop by SIGINT, SIGQUIT, SIGTERM or SIGHUP kills the browser, leaves the folder as it was, says so and ends the run by that signal, also when a second one comes", { skip: noSignals }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-signal-"));
  const groups = [];
  try {
    // A browser that starts and never answers, so a run waits for it, with
    // a socket folder in the temp folder that the profile links to, as
    // Chrome's own, and with REMAKE set, a helper process that makes its
    // profile again once it is removed, as Chrome's helpers can on their way
    // out.
    const chrome = path.join(parent, "chrome");
    fs.writeFileSync(
      chrome,
      `#!/bin/sh
for arg in "$@"; do case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}";; esac; done
socket=$(mktemp -d "$TMPDIR/com.example.Chrome.XXXXXX") && : > "$socket/SingletonSocket" && ln -s "$socket/SingletonSocket" "$profile/SingletonSocket"
[ -n "$REMAKE" ] && (i=0; while [ -d "$profile" ] && [ $i -lt 3000 ]; do sleep 0.01; i=$((i + 1)); done; mkdir -p "$profile/Default") &
echo $$ > "$(dirname "$0")/chrome.pid"
exec sleep 60
`,
      { mode: 0o755 },
    );
    // The copy of the signal npm and makersmcp's supervisor pass on, made to
    // come while the first one is handled: as the browser's profile is
    // removed.
    const twice = path.join(parent, "twice.js");
    fs.writeFileSync(
      twice,
      `const fs = require("fs");
       const rmSync = fs.rmSync;
       fs.rmSync = (target, ...rest) => {
         if (String(target).includes("easyfontkit-chrome-")) {
           fs.rmSync = rmSync;
           process.kill(process.pid, "SIGTERM");
           const until = Date.now() + 300;
           while (Date.now() < until);
         }
         return rmSync(target, ...rest);
       };`,
    );
    const stop = async (dir, preload, signal = "SIGTERM", remake = true, deaf = false) => {
      const tmp = fs.mkdtempSync(path.join(parent, "tmp-"));
      fs.rmSync(path.join(parent, "chrome.pid"), { force: true });
      // In a process group of its own, with its browser, so whatever is
      // left of it can be stopped at the end. SIGQUIT ends a process with a
      // core dump where the system writes them, into the folder it runs in:
      // the test's own.
      const child = spawn(process.execPath, [...(preload ? ["--require", preload] : []), CLI, "acme.example", "--out", dir], {
        cwd: parent,
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, CHROME_PATH: chrome, TMPDIR: tmp, REMAKE: remake ? "1" : "" },
      });
      groups.push(child.pid);
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      let exited = false;
      const ended = new Promise((resolve) =>
        child.on("exit", (code, signal) => {
          exited = true;
          resolve({ code, signal });
        }),
      );
      while (!exited && !fs.existsSync(path.join(parent, "chrome.pid"))) await sleep(20);
      assert.equal(exited, false, stderr);
      const pid = Number(fs.readFileSync(path.join(parent, "chrome.pid"), "utf8"));
      // Nobody reads what it says any more, as when the program that
      // started it has gone.
      if (deaf) {
        child.stderr.destroy();
        await sleep(50);
      }
      child.kill(signal);
      const ended2 = await ended;
      for (let i = 0; i < 100 && !gone(pid); i++) await sleep(20);
      return { signal: ended2.signal, stderr, browserLeft: !gone(pid), profiles: fs.readdirSync(tmp) };
    };
    const dir = path.join(parent, "kit");
    earlierKitIn(dir);
    const before = snapshot(dir);
    // Ctrl-C, Ctrl-\, a kill and a closed terminal, sent to the kit alone.
    // How soon a helper makes the profile again is a matter of time, not of
    // the signal, so that is tried with SIGTERM only.
    for (const [signal, preload] of [["SIGTERM", null], ["SIGTERM", twice], ["SIGINT", null], ["SIGQUIT", null], ["SIGHUP", null]]) {
      const stopped = await stop(dir, preload, signal, signal === "SIGTERM");
      assert.deepEqual(stopped, { signal, stderr: `easyfontkit: stopped by ${signal}, so no kit was made. The earlier kit in ${dir} is as it was.\n`, browserLeft: false, profiles: [] });
      assert.deepEqual(snapshot(dir), before);
    }
    const deaf = await stop(dir, null, "SIGTERM", false, true);
    assert.deepEqual(deaf, { signal: "SIGTERM", stderr: "", browserLeft: false, profiles: [] }, "a stop whose message nobody reads");
    assert.deepEqual(snapshot(dir), before);
    const first = await stop(path.join(parent, "new", "kit"));
    assert.equal(first.stderr, "easyfontkit: stopped by SIGTERM, so no kit was made.\n");
    assert.equal(fs.existsSync(path.join(parent, "new")), false);
  } finally {
    for (const group of groups) {
      try {
        process.kill(-group, "SIGKILL");
      } catch {
        // Nothing of it is left.
      }
    }
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a stop that comes once the new kit is in place ends the run with 0, and the new kit stays", { skip: noSignals }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-late-"));
  try {
    // A run whose page is read at once: its kit is saved as makeFontKit
    // saves one.
    const quick = path.join(parent, "quick.js");
    fs.writeFileSync(
      quick,
      `const fs = require("fs");
       const path = require("path");
       const kit = require(${JSON.stringify(require.resolve("../skills/easyfontkit/scripts/lib/kit"))});
       kit.makeFontKit = async (url, { dir }) => {
         const made = { version: 1, url: "https://acme.example/", capturedAt: new Date().toISOString(), generator: "easyfontkit test", roles: {}, families: [], notes: [] };
         await kit.saveKit(dir, (part) => {
           fs.writeFileSync(path.join(part, "fonts.json"), JSON.stringify(made));
           fs.writeFileSync(path.join(part, "FONTS.md"), "new");
           fs.writeFileSync(path.join(part, "fonts.css"), "new");
         });
         return { dir, kit: made };
       };`,
    );
    const dir = path.join(parent, "kit");
    // The stop comes every millisecond from the moment the kit is printed
    // until the process has ended, so one comes while it winds down.
    for (let i = 1; i <= 10; i++) {
      fs.rmSync(dir, { recursive: true, force: true });
      earlierKitIn(dir);
      const ended = await new Promise((resolve) => {
        const child = spawn(process.execPath, ["--require", quick, CLI, "acme.example", "--out", dir], { stdio: ["ignore", "pipe", "ignore"] });
        let stdout = "";
        let timer;
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (!timer && stdout.includes("Saved")) timer = setInterval(() => child.kill("SIGTERM"), 1);
        });
        child.on("exit", (code, signal) => {
          clearInterval(timer);
          resolve({ code, signal, printed: stdout.includes("Saved") });
        });
      });
      assert.deepEqual(ended, { code: 0, signal: null, printed: true }, `run ${i}`);
      assert.equal(fs.readFileSync(path.join(dir, "FONTS.md"), "utf8"), "new");
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("an error nothing catches ends the run with the browser killed and its profile removed, and the folder as it was", { skip: noSignals }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-uncaught-"));
  let child;
  try {
    // A browser that starts and never answers, with a socket folder in the
    // temp folder that its profile links to, as Chrome's own.
    const chrome = path.join(parent, "chrome");
    fs.writeFileSync(
      chrome,
      `#!/bin/sh
for arg in "$@"; do case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}";; esac; done
socket=$(mktemp -d "$TMPDIR/com.example.Chrome.XXXXXX") && : > "$socket/SingletonSocket" && ln -s "$socket/SingletonSocket" "$profile/SingletonSocket"
echo $$ > "$(dirname "$0")/chrome.pid"
exec sleep 60
`,
      { mode: 0o755 },
    );
    // An error thrown once the browser is up, from a timer, where no code of
    // the run can catch it.
    const pidFile = path.join(parent, "chrome.pid");
    const boom = path.join(parent, "boom.js");
    fs.writeFileSync(boom, `const fs = require("fs"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(pidFile)})) { clearInterval(timer); throw new Error("boom"); } }, 20);`);
    const tmp = fs.mkdtempSync(path.join(parent, "tmp-"));
    const dir = path.join(parent, "kit");
    earlierKitIn(dir);
    const before = snapshot(dir);
    // In a process group of its own, with its browser, so whatever is left
    // of it can be stopped at the end.
    child = spawn(process.execPath, ["--require", boom, CLI, "acme.example", "--out", dir], { detached: true, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, CHROME_PATH: chrome, TMPDIR: tmp } });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(code, 1, stderr);
    assert.match(stderr, /Error: boom/);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 100 && !gone(pid); i++) await sleep(20);
    assert.equal(gone(pid), true, "the browser is killed");
    assert.deepEqual(fs.readdirSync(tmp), [], "no profile or socket folder is left");
    assert.deepEqual(snapshot(dir), before);
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Nothing of its group is left.
    }
    fs.rmSync(parent, { recursive: true, force: true });
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
    assert.match(css, /^\/\* Fonts of 127\.0\.0\.1, read from [^\n]+\n {3}Each font file the page loaded has a @font-face rule below, under its\n/);
    assert.match(css, /@font-face \{\n {2}font-family: "Inter";\n {2}src: url\("files\/inter-400\.woff2"\) format\("woff2"\);\n {2}font-weight: 400;\n {2}font-style: normal;\n {2}unicode-range: U\+0000-00FF;/);
    // Inter is the closest free font of the heading's, in its weight alone:
    // the body's, the site's own, comes from its saved file.
    assert.match(css, /family=Inter:wght@700&/);
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
    assert.deepEqual(fs.readdirSync(dir).sort(), ["FONTS.md", "fonts.css", "fonts.json"]);
    // fonts.css then says it has no @font-face rule, and loads the site's
    // own open font from Google Fonts, so its -free variable still names a
    // font that loads, as every other -free variable does.
    const bare = fs.readFileSync(path.join(dir, "fonts.css"), "utf8");
    assert.match(bare, /^\/\* Fonts of 127\.0\.0\.1, read from [^\n]+\n {3}The font files were read but not saved, so no @font-face rule follows\.\n/);
    assert.doesNotMatch(bare, /@font-face \{/);
    assert.match(bare, /@import url\("https:\/\/fonts\.googleapis\.com\/css2\?family=Inter:wght@400;700&[^"]*display=swap"\);/);
    assert.match(bare, /--font-body-free: "Inter", sans-serif;/);
    assert.match(fs.readFileSync(path.join(dir, "FONTS.md"), "utf8"), /\nfonts\.css sets a variable per role\. The font files were not saved, so it declares none of them:\n/);

    // Files of the user's own in the files folder stay theirs, also one
    // under the name a new font file would take, written in other case, as
    // a macOS or Windows disk holds the two as one.
    fs.mkdirSync(path.join(dir, "files"));
    fs.writeFileSync(path.join(dir, "files", "Inter-400.woff2"), "mine");
    fs.writeFileSync(path.join(dir, "files", "notes.txt"), "mine");
    const again = await makeFontKit(origin, { dir, timeLimit: 90_000 });
    assert.equal(again.kit.families.find((f) => f.name === "Inter").files[0].file, "files/inter-400-2.woff2");
    assert.ok(fs.readFileSync(path.join(dir, "files", "inter-400-2.woff2")).equals(fixture("inter-latin-400.woff2")));
    assert.equal(fs.readFileSync(path.join(dir, "files", "Inter-400.woff2"), "utf8"), "mine");
    assert.equal(fs.readFileSync(path.join(dir, "files", "notes.txt"), "utf8"), "mine");
    assert.deepEqual(fs.readdirSync(dir).sort(), ["FONTS.md", "files", "fonts.css", "fonts.json"]);
  } finally {
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a run whose progress lines nobody reads any more still makes its kit", { skip: noBrowser }, async () => {
  const { server, origin } = await serve(PAGE);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-deaf-"));
  const dir = path.join(parent, "kit");
  try {
    const child = spawn(process.execPath, [CLI, origin, "--out", dir], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const ended = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
    // Gone once the run has said it opens the page, as a reader that stops
    // after the first line.
    await new Promise((resolve) => child.stderr.once("data", resolve));
    child.stderr.destroy();
    assert.deepEqual(await ended, { code: 0, signal: null });
    assert.match(stdout, /^Saved the fonts of 127\.0\.0\.1 to /);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["FONTS.md", "files", "fonts.css", "fonts.json"]);
  } finally {
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// fonts.css as a style sheet reads it: its comments, and the rules outside
// them.
function cssParts(css) {
  const comments = css.match(/\/\*[\s\S]*?\*\//g) || [];
  return { comments, rules: css.replace(/\/\*[\s\S]*?\*\//g, "") };
}

test("the page's address goes into fonts.css only inside its comment, also when the page puts */ in it", { skip: noBrowser }, async () => {
  const font = `<style>@font-face { font-family: "Body Sans"; src: url("/inter.woff2") format("woff2"); } h1, p { font-family: "Body Sans", sans-serif; }</style>`;
  const page = (title, body = "") => `<!doctype html><html><head><title>${title}</title>${font}</head><body><h1>${title}</h1><p>A page whose address carries a style sheet of its own.</p>${body}</body></html>`;
  const routes = {
    "/inter.woff2": { type: "font/woff2", body: fixture("inter-latin-400.woff2") },
    "/evil.css": { type: "text/css", body: "body { background: red; }" },
  };
  const { server, origin } = await serve(routes);
  const evil = `*/@import'${origin}/evil.css';/*`;
  // A #fragment the page sets on itself once it has loaded, and a redirect
  // to a path with the same in it.
  routes["/hash"] = { body: page("Hash", `<script>addEventListener("load", () => setTimeout(() => (location.hash = ${JSON.stringify(evil)}), 300))</script>`) };
  routes["/moved"] = { status: 302, headers: { location: `/x/${evil}` } };
  routes[`/x/${evil}`] = { body: page("Moved") };
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-css-"));
  try {
    for (const [route, ended] of [
      ["/hash", `/hash#${evil}`],
      ["/moved", `/x/${evil}`],
    ]) {
      const dir = path.join(parent, route.slice(1));
      const { kit } = await makeFontKit(`${origin}${route}`, { dir, timeLimit: 60_000 });
      assert.equal(kit.url, `${origin}${ended}`, "fonts.json keeps the address as it is");
      const css = fs.readFileSync(path.join(dir, "fonts.css"), "utf8");
      const { comments, rules } = cssParts(css);
      assert.equal(comments.length, 1, css);
      assert.ok(comments[0].includes(`read from ${origin}${ended.replace(/\*/g, "%2A")} on `), comments[0]);
      assert.ok(css.startsWith(comments[0]), "the comment is the one at the top");
      assert.doesNotMatch(rules, /@import|evil/, css);
    }
  } finally {
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a unicode-range in the page's own CSS goes into fonts.css only when it is one", { skip: noBrowser }, async () => {
  const routes = {
    "/inter.woff2": { type: "font/woff2", body: fixture("inter-latin-400.woff2") },
    // A font of its own: the same bytes at two addresses are one file in the
    // kit, named by the address whose answer the browser took first, which
    // on a busy machine can be either.
    "/evil.ttf": { type: "font/ttf", body: interAs({ names: { 1: "Other Sans", 2: "Regular", 4: "Other Sans", 6: "OtherSans-Regular" } }) },
  };
  const { server, origin } = await serve(routes);
  // A range that ends in an open quote, then a line with a src of its own:
  // copied as written, it would end the range in fonts.css and give the
  // family a file from elsewhere.
  routes["/"] = {
    body: `<!doctype html><html><head><title>Range</title><link rel="preload" href="/inter.woff2" as="font" type="font/woff2" crossorigin>
      <style>@font-face { font-family: "Body Sans"; src: url("/inter.woff2") format("woff2"); unicode-range: U+0-FF "\n; src: url(${origin}/evil.ttf) }
      h1, p { font-family: "Body Sans", sans-serif; }</style></head>
      <body><h1>Range</h1><p>A family whose range carries a file from elsewhere.</p></body></html>`,
  };
  const range = /^U\+[0-9A-F?]+(-[0-9A-F]+)?(, ?U\+[0-9A-F?]+(-[0-9A-F]+)?)*$/i;
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-range-"));
  const dir = path.join(parent, "kit");
  try {
    const { kit } = await makeFontKit(origin, { dir, timeLimit: 60_000 });
    const files = kit.families.flatMap((family) => family.files);
    assert.ok(files.some((file) => file.url === `${origin}/inter.woff2`), "the file the rule names is saved");
    for (const file of files) assert.ok(!file.unicodeRange || range.test(file.unicodeRange), `${file.url}: ${file.unicodeRange}`);
    const css = fs.readFileSync(path.join(dir, "fonts.css"), "utf8");
    assert.doesNotMatch(css, /evil/, css);
    for (const line of css.split("\n").filter((text) => text.includes("unicode-range"))) assert.match(line.replace(/^ {2}unicode-range: (.*);$/, "$1"), range, line);
  } finally {
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a kit made without its font files says in fonts.css that it has no @font-face rule, loads the site's own open fonts from Google Fonts or Fontsource where they are, and names the -free variables of those it cannot load, and speaks of @import lines only when it has some", { skip: noBrowser }, async () => {
  // Inter, which Google Fonts has, and an open font of the site's own that
  // neither Google Fonts nor Fontsource has; on /only that font alone.
  const open = interAs({ names: { 1: "Acme Open", 2: "Regular", 4: "Acme Open", 6: "AcmeOpen-Regular", 13: "This Font Software is licensed under the SIL Open Font License, Version 1.1." } });
  const { server, origin } = await serve({
    "/": {
      body: `<!doctype html><html><head><title>Open</title><style>
        @font-face { font-family: "Body Sans"; src: url("/inter.woff2") format("woff2"); }
        @font-face { font-family: "Acme Open"; src: url("/open.ttf") format("truetype"); }
        h1 { font-family: "Body Sans", sans-serif; } p, button { font-family: "Acme Open", sans-serif; }
      </style></head><body><h1>Open fonts only</h1><p>Body text in an open font that no library has.</p><button>Go</button></body></html>`,
    },
    "/only": {
      body: `<!doctype html><html><head><title>Only</title><style>
        @font-face { font-family: "Acme Open"; src: url("/open.ttf") format("truetype"); }
        h1, p, button { font-family: "Acme Open", sans-serif; }
      </style></head><body><h1>One open font</h1><p>Body text in an open font that no library has.</p><button>Go</button></body></html>`,
    },
    "/inter.woff2": { type: "font/woff2", body: fixture("inter-latin-400.woff2") },
    "/open.ttf": { type: "font/ttf", body: open },
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-nofiles-"));
  const dir = path.join(parent, "kit");
  try {
    const { kit } = await makeFontKit(origin, { dir, files: false, timeLimit: 60_000 });
    assert.deepEqual([kit.roles.heading.family, kit.roles.body.family, kit.roles.button.family], ["Inter", "Acme Open", "Acme Open"]);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["FONTS.md", "fonts.css", "fonts.json"]);
    const css = fs.readFileSync(path.join(dir, "fonts.css"), "utf8");
    const { comments, rules } = cssParts(css);
    assert.deepEqual(
      comments.map((comment) => comment.replace(/\n {3}/g, " ")),
      [
        `/* Fonts of 127.0.0.1, read from ${origin}/ on ${kit.capturedAt.slice(0, 10)} by easyfontkit ${require("../package.json").version}. The font files were read but not saved, so no @font-face rule follows. --font-heading, --font-body, --font-button and --font-code are the site's own fonts; the -free ones are the closest free fonts, which the @import lines load from Google Fonts or Fontsource. --font-body-free and --font-button-free name an open font of the site's that is on neither, so nothing here loads it. FONTS.md says how each one is licensed. */`,
      ],
    );
    for (const line of comments[0].split("\n")) assert.ok(line.length <= 76 || line.startsWith("/* Fonts of"), line);
    assert.doesNotMatch(rules, /@font-face/);
    assert.deepEqual(rules.match(/@import url\("[^"]*"\);/g), ['@import url("https://fonts.googleapis.com/css2?family=Inter:wght@700&display=swap");']);
    assert.match(rules, /--font-heading-free: "Inter", sans-serif;/);
    assert.match(rules, /--font-body-free: "Acme Open", sans-serif;/);
    const md = fs.readFileSync(path.join(dir, "FONTS.md"), "utf8");
    assert.match(md, /\nfonts\.css sets a variable per role\. The font files were not saved, so it declares none of them:\n/);
    assert.match(md, /the closest free fonts, loaded from Google Fonts or Fontsource\. `--font-body-free` and `--font-button-free` name an open font of the site's that is on neither, so fonts\.css does not load it\. A commercial font/);

    // With that font alone, nothing is loaded from Google Fonts or
    // Fontsource, and neither fonts.css nor FONTS.md says otherwise.
    const only = await makeFontKit(`${origin}/only`, { dir, files: false, timeLimit: 60_000 });
    assert.deepEqual([only.kit.roles.heading.family, only.kit.roles.body.family, only.kit.roles.button.family], ["Acme Open", "Acme Open", "Acme Open"]);
    const alone = cssParts(fs.readFileSync(path.join(dir, "fonts.css"), "utf8"));
    assert.deepEqual(
      alone.comments.map((comment) => comment.replace(/\n {3}/g, " ")),
      [
        `/* Fonts of 127.0.0.1, read from ${origin}/only on ${only.kit.capturedAt.slice(0, 10)} by easyfontkit ${require("../package.json").version}. The font files were read but not saved, so no @font-face rule follows. --font-heading, --font-body, --font-button and --font-code are the site's own fonts; the -free ones are the closest free fonts. --font-heading-free, --font-body-free and --font-button-free name an open font of the site's that is on neither Google Fonts nor Fontsource, so nothing here loads it. FONTS.md says how each one is licensed. */`,
      ],
    );
    for (const line of alone.comments[0].split("\n")) assert.ok(line.length <= 76 || line.startsWith("/* Fonts of"), line);
    assert.doesNotMatch(alone.rules, /@import|@font-face/);
    assert.match(alone.rules, /--font-heading-free: "Acme Open", sans-serif;/);
    const aloneMd = fs.readFileSync(path.join(dir, "FONTS.md"), "utf8");
    assert.ok(aloneMd.includes("the closest free fonts. `--font-heading-free`, `--font-body-free` and `--font-button-free` name an open font of the site's that is on neither Google Fonts nor Fontsource, so fonts.css does not load it. A commercial font"), aloneMd);
    assert.doesNotMatch(aloneMd, /loaded from Google Fonts or Fontsource/);
  } finally {
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a web font whose file the browser asked for and did not get while the page was read, one that never comes or one that is not there, is named with that file's address and an unknown license, where it was taken for a font of the visitor's own", { skip: noBrowser }, async () => {
  const { server, origin } = await serve({
    "/": {
      body: `<!doctype html><html><head><title>Late</title><style>
        @font-face { font-family: "Slowpoke"; src: url("/slowpoke.ttf") format("truetype"); }
        @font-face { font-family: "Broken Sans"; src: url("/broken.woff2") format("woff2"); }
        h1 { font-family: "Slowpoke", serif; } p, button { font-family: "Broken Sans", sans-serif; }
      </style></head><body><h1>A heading whose font never comes</h1><p>Body text whose font is not there.</p><button>Go</button></body></html>`,
    },
    "/slowpoke.ttf": { hold: true },
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-unloaded-"));
  const dir = path.join(parent, "kit");
  try {
    // A run's time short enough that the wait for a page that does not
    // finish loading is cut to a few seconds.
    const { kit } = await makeFontKit(origin, { dir, timeLimit: 65_000 });
    assert.deepEqual([kit.roles.heading.family, kit.roles.body.family, kit.roles.button.family], ["Slowpoke", "Broken Sans", "Broken Sans"]);
    const family = Object.fromEntries(kit.families.map((f) => [f.name, f]));
    for (const [name, file] of [
      ["Slowpoke", "slowpoke.ttf"],
      ["Broken Sans", "broken.woff2"],
    ]) {
      assert.equal(family[name].system, false, name);
      assert.deepEqual(family[name].notLoaded, [`${origin}/${file}`], name);
      assert.deepEqual(family[name].files, [], name);
      assert.equal(family[name].license.status, "unknown", name);
      assert.equal(family[name].source, "self-hosted", name);
    }
    const md = fs.readFileSync(path.join(dir, "FONTS.md"), "utf8");
    assert.match(md, /\| Headings \| Slowpoke \| 700 \| Unknown \| [A-Z][^|]+ \|/);
    assert.ok(md.includes(`\n- Files: none read, as ${origin}/slowpoke.ttf did not load while the page was read\n`), md);
    assert.ok(md.includes("\n- License: Unknown. Its file did not load while the page was read, so nothing in it could be read.\n"), md);
    assert.doesNotMatch(md, /System font|sends no file/);
    // One that never answered may come on another run; one the server
    // answered with an error has a note of its own that says why.
    assert.match(md, new RegExp(`\\n- Some of the headings were drawn with .+?, (a fallback|fallbacks), because Slowpoke's file ${origin}/slowpoke\\.ttf did not load while the page was read\\. That text is counted as Slowpoke, the font the site asks for\\. The kit has no file of it, so its license is unknown: try again later\\.\\n`));
    assert.match(md, new RegExp(`\\n- Some of the body text and buttons were drawn with .+?, (a fallback|fallbacks), because Broken Sans's file ${origin}/broken\\.woff2 did not load while the page was read\\. That text is counted as Broken Sans, the font the site asks for\\. The kit has no file of it, so its license is unknown\\.\\n`));
    assert.match(md, new RegExp(`\\n- ${origin}/broken\\.woff2 was not a usable font file: [^\\n]+\\.\\n`));
    // Its free match comes from Google Fonts, as for any font of unknown
    // license.
    assert.match(fs.readFileSync(path.join(dir, "fonts.css"), "utf8"), /--font-heading-free: "[^"]+", serif;/);
  } finally {
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a web font the browser refuses, one from another site whose server sends no CORS header or one the page's own Content-Security-Policy keeps out, is named with its file's address, and a note says the browser refused it, with no advice to try again later", { skip: noBrowser }, async () => {
  // Another site: a server on another port is another origin. It sends the
  // same font once without a CORS header and once with one.
  const farFont = interAs({ names: { 1: "Far Font", 2: "Regular", 4: "Far Font", 6: "FarFont-Regular" } });
  const far = await serve({
    "/far.ttf": { type: "font/ttf", body: farFont },
    "/far-allowed.ttf": { type: "font/ttf", headers: { "access-control-allow-origin": "*" }, body: farFont },
  });
  const page = (src, head = "") => `<!doctype html><html><head><title>Refused</title>${head}<style>
      @font-face { font-family: "Far Font"; src: url("${far.origin}/${src}") format("truetype"); }
      @font-face { font-family: "Kept Out"; src: url("/kept.ttf") format("truetype"); }
      h1 { font-family: "Far Font", serif; } p { font-family: "Kept Out", sans-serif; }
    </style></head><body><h1>A heading in a font from another site</h1><p>Body text in a font the page keeps out.</p></body></html>`;
  const { server, origin } = await serve({
    "/": { body: page("far.ttf", `<meta http-equiv="Content-Security-Policy" content="font-src ${far.origin}">`) },
    "/allowed": { body: page("far-allowed.ttf") },
    "/kept.ttf": { type: "font/ttf", body: interAs({ names: { 1: "Kept Out", 2: "Regular", 4: "Kept Out", 6: "KeptOut-Regular" } }) },
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-refused-"));
  const dir = path.join(parent, "kit");
  try {
    const { kit } = await makeFontKit(origin, { dir, timeLimit: 60_000 });
    assert.deepEqual([kit.roles.heading.family, kit.roles.body.family], ["Far Font", "Kept Out"]);
    const family = Object.fromEntries(kit.families.map((f) => [f.name, f]));
    for (const [name, url] of [
      ["Far Font", `${far.origin}/far.ttf`],
      ["Kept Out", `${origin}/kept.ttf`],
    ]) {
      assert.equal(family[name].system, false, name);
      assert.deepEqual(family[name].notLoaded, [url], name);
      assert.deepEqual(family[name].files, [], name);
      assert.equal(family[name].license.status, "unknown", name);
    }
    // Another run gets the same answer, so trying again later is not
    // offered, and a note of its own says why the file did not load.
    const md = fs.readFileSync(path.join(dir, "FONTS.md"), "utf8");
    assert.match(md, new RegExp(`\\n- Some of the headings were drawn with .+?, (a fallback|fallbacks), because Far Font's file ${far.origin}/far\\.ttf did not load while the page was read\\. That text is counted as Far Font, the font the site asks for\\. The kit has no file of it, so its license is unknown\\.\\n`));
    assert.match(md, new RegExp(`\\n- Some of the body text was drawn with .+?, (a fallback|fallbacks), because Kept Out's file ${origin}/kept\\.ttf did not load while the page was read\\. That text is counted as Kept Out, the font the site asks for\\. The kit has no file of it, so its license is unknown\\.\\n`));
    assert.ok(md.includes(`\n- ${far.origin}/far.ttf was not a usable font file: the browser refused it (CORS error: MissingAllowOriginHeader).\n`), md);
    assert.ok(md.includes(`\n- ${origin}/kept.ttf was not a usable font file: the browser refused it (blocked: csp).\n`), md);
    assert.doesNotMatch(md, /try again later/);
    assert.equal(kit.notes.length, 4);

    // With a CORS header and no such policy, the same fonts load and are in
    // the kit, with no note.
    const allowed = await makeFontKit(`${origin}/allowed`, { dir, timeLimit: 60_000 });
    assert.deepEqual([allowed.kit.roles.heading.family, allowed.kit.roles.body.family], ["Far Font", "Kept Out"]);
    for (const name of ["Far Font", "Kept Out"]) {
      const loaded = allowed.kit.families.find((f) => f.name === name);
      assert.equal(loaded.files.length, 1, name);
      assert.equal("notLoaded" in loaded, false, name);
    }
    assert.deepEqual(allowed.kit.notes, []);
  } finally {
    server.close();
    far.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a web font from another site whose server answers with an error and sends no CORS header, as error pages often come, gets a note with that error, not one that says the browser refused it", { skip: noBrowser }, async () => {
  // Another site that is down for a while, as its error pages come without
  // the header CORS asks for, and one that sends that header with its error.
  const far = await serve({
    "/busy.ttf": { status: 503, body: "<h1>Service Unavailable</h1>" },
    "/gone.ttf": { status: 404, headers: { "access-control-allow-origin": "*" }, body: "<h1>Not Found</h1>" },
  });
  const { server, origin } = await serve({
    "/": {
      body: `<!doctype html><html><head><title>Busy</title><style>
        @font-face { font-family: "Busy Font"; src: url("${far.origin}/busy.ttf") format("truetype"); }
        @font-face { font-family: "Gone Font"; src: url("${far.origin}/gone.ttf") format("truetype"); }
        h1 { font-family: "Busy Font", serif; } p { font-family: "Gone Font", sans-serif; }
      </style></head><body><h1>A heading in a font whose server is down</h1><p>Body text in a font that is not there.</p></body></html>`,
    },
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-busy-"));
  const dir = path.join(parent, "kit");
  try {
    const { kit } = await makeFontKit(origin, { dir, timeLimit: 60_000 });
    assert.deepEqual([kit.roles.heading.family, kit.roles.body.family], ["Busy Font", "Gone Font"]);
    const family = Object.fromEntries(kit.families.map((f) => [f.name, f]));
    for (const [name, file] of [
      ["Busy Font", "busy.ttf"],
      ["Gone Font", "gone.ttf"],
    ]) {
      assert.deepEqual(family[name].notLoaded, [`${far.origin}/${file}`], name);
      assert.equal(family[name].license.status, "unknown", name);
    }
    // Both as a file whose server answered with an error: the note says
    // which, and that is what kept the file out, with or without the header.
    const md = fs.readFileSync(path.join(dir, "FONTS.md"), "utf8");
    assert.ok(md.includes(`\n- ${far.origin}/busy.ttf was not a usable font file: the server answered 503.\n`), md);
    assert.ok(md.includes(`\n- ${far.origin}/gone.ttf was not a usable font file: the server answered 404.\n`), md);
    assert.doesNotMatch(md, /refused/);
    assert.equal(kit.notes.length, 4);
  } finally {
    server.close();
    far.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a font file from another site with no CORS header that the page also preloads without crossorigin is in the kit from that preload, with no note that it was not usable", { skip: noBrowser }, async () => {
  // The preload is not held to CORS, so the browser gets the file, while
  // the @font-face rule's own request for that address is refused.
  const farFont = interAs({ names: { 1: "Far Font", 2: "Regular", 4: "Far Font", 6: "FarFont-Regular" } });
  const far = await serve({ "/far.ttf": { type: "font/ttf", body: farFont } });
  const { server, origin } = await serve({
    "/": {
      body: `<!doctype html><html><head><title>Preloaded</title>
        <link rel="preload" href="${far.origin}/far.ttf" as="font" type="font/ttf">
        <style>
        @font-face { font-family: "Far Font"; src: url("${far.origin}/far.ttf") format("truetype"); }
        h1 { font-family: "Far Font", serif; }
      </style></head><body><h1>A heading in a font from another site</h1><p>Body text.</p></body></html>`,
    },
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-preloaded-"));
  const dir = path.join(parent, "kit");
  try {
    const { kit } = await makeFontKit(origin, { dir, timeLimit: 60_000 });
    assert.equal(kit.roles.heading.family, "Far Font");
    const family = kit.families.find((f) => f.name === "Far Font");
    assert.deepEqual(family.files.map((file) => file.url), [`${far.origin}/far.ttf`]);
    assert.equal("notLoaded" in family, false);
    assert.ok(fs.existsSync(path.join(dir, family.files[0].file)));
    assert.deepEqual(kit.notes.filter((note) => /usable|refused/.test(note)), []);
  } finally {
    server.close();
    far.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a run stopped while it reads the page, by a stop or by Ctrl-\\ sent to its process group, leaves the earlier kit as it was, ends its browser with its crash handler, leaves no crash report and ends by the signal", { skip: noBrowser || noSignals }, async () => {
  const { server, origin } = await serve({
    "/": { body: `<!doctype html><html><head><title>Stalls</title><link rel="stylesheet" href="/held.css"></head><body><h1>Stalls</h1><p>A style sheet that never comes.</p></body></html>` },
    "/held.css": { hold: true },
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-stop-"));
  let child;
  try {
    // Ctrl-\ reaches the browser's processes too, and Chrome takes it as a
    // crash: each one asks its crash handler, which Chrome starts apart from
    // them, for a report. Told on Linux only.
    for (const signal of ["SIGTERM", ...(process.platform === "linux" ? ["SIGQUIT"] : [])]) {
      const dir = path.join(parent, `kit-${signal}`);
      // A home and a temp folder of the run's own, so whatever Chrome leaves
      // in them is seen. A longer path than the test's own temp folder can be
      // too long for the socket Chrome makes in it.
      const home = path.join(parent, `home-${signal}`);
      const tmp = path.join(parent, `tmp-${signal}`);
      fs.mkdirSync(home);
      fs.mkdirSync(tmp);
      earlierKitIn(dir);
      const before = snapshot(dir);
      // In a process group of its own, as makersmcp runs a kit and a terminal
      // runs a command. The stop goes to the whole group, as Ctrl-C, Ctrl-\
      // and makersmcp's cancel send it, and a second copy to the kit, as npm
      // and makersmcp's supervisor pass it on.
      child = spawn(process.execPath, [CLI, origin, "--out", dir], { detached: true, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, HOME: home, TMPDIR: tmp } });
      let stderr = "";
      const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
      const opened = new Promise((resolve) => child.stderr.on("data", (chunk) => /Opening/.test((stderr += chunk)) && resolve()));
      await Promise.race([opened, ended]);
      assert.match(stderr, /Opening/);
      const mine = fs.readdirSync(tmp).filter((name) => name.startsWith("easyfontkit-chrome-"));
      assert.equal(mine.length, 1);
      await sleep(1500);
      // Chrome's socket folder, which it removes only when it quits. On Linux
      // the profile links to it from the start, from inside the profile when
      // the temp folder's path is long.
      let socket = "";
      try {
        const profile = path.join(tmp, mine[0]);
        socket = path.dirname(path.resolve(profile, fs.readlinkSync(path.join(profile, "SingletonSocket"))));
      } catch (err) {
        if (process.platform === "linux") throw err;
      }
      process.kill(-child.pid, signal);
      await sleep(20);
      try {
        process.kill(child.pid, signal);
      } catch {
        // Ended already.
      }
      const end = await ended;
      assert.equal(end.signal, signal);
      assert.ok(stderr.endsWith(`\neasyfontkit: stopped by ${signal}, so no kit was made. The earlier kit in ${dir} is as it was.\n`), stderr);
      assert.deepEqual(snapshot(dir), before, signal);
      // Nothing that names the profile, as the browser's processes do, or the
      // home, as a crash handler that keeps its reports there does.
      const left = () => spawnSync("ps", ["-A", "-o", "args="], { encoding: "utf8" }).stdout.split("\n").filter((line) => line.includes(mine[0]) || line.includes(home));
      for (let i = 0; i < 150 && left().length; i++) await sleep(20);
      assert.deepEqual(left(), [], signal);
      assert.deepEqual(fs.readdirSync(tmp), [], `no browser profile left after ${signal}`);
      if (socket) assert.equal(fs.existsSync(socket), false, "no socket folder left");
      if (process.platform === "linux") {
        const reports = spawnSync("find", [home, "-name", "Crash Reports", "-o", "-name", "*.dmp"], { encoding: "utf8" }).stdout.trim();
        assert.equal(reports, "", `no crash reports in the home after ${signal}`);
      }
    }
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Nothing of its group is left.
    }
    server.close();
    fs.rmSync(parent, { recursive: true, force: true, maxRetries: 5 });
  }
});

// The processes still running, zombies aside, whose command line holds the
// given text, from /proc on Linux.
function naming(text) {
  const found = [];
  for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      if (/^[ZX]/.test(stat.slice(stat.lastIndexOf(")") + 2))) continue;
      if (fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(text)) found.push(Number(pid));
    } catch {
      // Gone, or not this user's.
    }
  }
  return found;
}

test("a run killed outright leaves no browser running: the browser and its crash handler quit once the pipe it is driven through closes, and only its profile stays in the temp folder", { skip: noBrowser || noSignals || (process.platform !== "linux" && "a browser's processes are told from /proc on Linux only") }, async () => {
  const { server, origin } = await serve({
    "/": { body: `<!doctype html><html><head><title>Stalls</title><link rel="stylesheet" href="/held.css"></head><body><h1>Stalls</h1><p>A style sheet that never comes.</p></body></html>` },
    "/held.css": { hold: true },
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-killed-"));
  // A temp folder and a home of the run's own: Chrome makes its socket
  // folder in that temp folder, and its crash handler names the profile.
  const tmp = path.join(parent, "tmp");
  const home = path.join(parent, "home");
  fs.mkdirSync(tmp);
  fs.mkdirSync(home);
  let child;
  try {
    child = spawn(process.execPath, [CLI, origin, "--out", path.join(parent, "kit")], { detached: true, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, HOME: home, TMPDIR: tmp } });
    let stderr = "";
    const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    const opened = new Promise((resolve) => child.stderr.on("data", (chunk) => /Opening/.test((stderr += chunk)) && resolve()));
    await Promise.race([opened, ended]);
    assert.match(stderr, /Opening/);
    const [profile, ...others] = fs.readdirSync(tmp).filter((name) => name.startsWith("easyfontkit-chrome-"));
    assert.ok(profile && !others.length, "one profile");
    assert.ok(naming(profile).length, "the browser runs");
    // The kit alone, as kill -9 ends it: none of its handlers runs.
    process.kill(child.pid, "SIGKILL");
    assert.deepEqual(await ended, { code: null, signal: "SIGKILL" });
    for (let waited = 0; waited < 5_000 && naming(profile).length; waited += 50) await sleep(50);
    assert.deepEqual(naming(profile), [], "no process names the profile");
    assert.deepEqual(fs.readdirSync(tmp), [profile], "the profile alone stays in the temp folder");
    assert.equal(fs.existsSync(path.join(parent, "kit")), false);
  } finally {
    // Whatever of the run is left: its group, and anything that names its
    // folders, as a crash handler in a session of its own does.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Nothing of its group is left.
    }
    for (const pid of naming(parent)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone already.
      }
    }
    server.close();
    fs.rmSync(parent, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a page that waits for a style sheet that never comes draws nothing and is refused, naming the style sheet, and the earlier kit stays", { skip: noBrowser }, async () => {
  const { server, origin } = await serve({
    "/": { body: `<!doctype html><html><head><title>Stalls</title><link rel="stylesheet" href="/held.css"></head><body><h1>Stalls</h1><p>A style sheet that never comes.</p></body></html>` },
    "/held.css": { hold: true },
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-stalls-"));
  const dir = path.join(parent, "kit");
  try {
    earlierKitIn(dir);
    const before = snapshot(dir);
    const started = Date.now();
    await assert.rejects(makeFontKit(origin, { dir, timeLimit: 60_000 }), {
      message: `${origin}/ stayed blank: it waits for its style sheet ${origin}/held.css, which did not come, so no kit was made. Try again later, or check the page in a normal browser.`,
    });
    assert.ok(Date.now() - started < 40_000, `refused after ${Date.now() - started} ms`);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a bot check served instead of the page fails with a reason and leaves nothing behind", { skip: noBrowser }, async () => {
  const html = "<!doctype html><html><head><title>Just a moment...</title></head><body><p>Checking your browser.</p></body></html>";
  // Also with the error status a bot check often comes with: it is still
  // told as a bot check, with its status, and after a redirect with the
  // address it led to.
  const { server, origin } = await serve({ "/": { body: html }, "/403": { status: 403, body: html }, "/to-403": { status: 302, headers: { location: "/403" } } });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-out-"));
  const dir = path.join(parent, "kit");
  const rest = "instead of its page, so no kit was made. Open the site in a normal browser and try again later.";
  try {
    for (const [url, message] of [
      [origin, `${origin}/ answered with a bot check ("Just a moment...") ${rest}`],
      [`${origin}/403`, `${origin}/403 answered with a bot check ("Just a moment..."), HTTP 403 Forbidden, ${rest}`],
      [`${origin}/to-403`, `${origin}/to-403 led to ${origin}/403, which answered with a bot check ("Just a moment..."), HTTP 403 Forbidden, ${rest}`],
    ]) {
      await assert.rejects(makeFontKit(url, { dir, timeLimit: 60_000 }), { message });
      assert.equal(fs.existsSync(dir), false, "no folder left behind");
    }
  } finally {
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a page that moves itself on is read where it ends, and one that ends on an address that cannot be opened or on about:blank is refused, naming the address, and the earlier kit stays", { skip: noBrowser }, async () => {
  // A port nothing listens on: one a server had, once it has closed.
  const closed = await new Promise((resolve) => {
    const probe = http.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const dead = `http://127.0.0.1:${closed}/`;
  const page = (head, body) => `<!doctype html><html><head><title>Moves on</title>${head}</head><body><h1>Moves on</h1><p>This page sends the browser elsewhere.</p>${body}</body></html>`;
  const { server, origin } = await serve({
    "/meta": { body: page(`<meta http-equiv="refresh" content="0;url=${dead}">`, "") },
    "/script": { body: page("", `<script>setTimeout(() => (location.href = ${JSON.stringify(dead)}), 50)</script>`) },
    // A redirect, and one that leads to it.
    "/302": { status: 302, headers: { location: dead } },
    "/301": { status: 301, headers: { location: "/302" } },
    "/on": { body: page("", `<script>setTimeout(() => (location.href = "/next"), 50)</script>`) },
    // A redirect to an address whose server takes the connection and never
    // answers.
    "/to-hang": { status: 302, headers: { location: "/hang" } },
    "/hang": { hold: true },
    // On to about:blank at the load event, also after a redirect, and a
    // moment after a font has come.
    "/blank": { body: page("", `<script>addEventListener("load", () => (location.href = "about:blank"))</script>`) },
    "/to-blank": { status: 302, headers: { location: "/blank" } },
    "/blank-font": {
      body: page(
        `<style>@font-face { font-family: "Body Sans"; src: url("/inter.woff2") format("woff2"); } p { font-family: "Body Sans", sans-serif; }</style>`,
        `<script>document.fonts.ready.then(() => setTimeout(() => (location.href = "about:blank"), 300))</script>`,
      ),
    },
    "/inter.woff2": { type: "font/woff2", body: fixture("inter-latin-400.woff2") },
    // Code only here, so a kit with code was read from this page.
    "/next": { body: `<!doctype html><html><head><title>Next</title></head><body><h1>Next</h1><p>The page the other one leads to.</p><pre><code>npx acme init</code></pre></body></html>` },
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-moved-"));
  const dir = path.join(parent, "kit");
  try {
    earlierKitIn(dir);
    const before = snapshot(dir);
    for (const route of ["/meta", "/script", "/302", "/301"]) {
      await assert.rejects(makeFontKit(`${origin}${route}`, { dir, timeLimit: 60_000 }), {
        message: `${origin}${route} led to ${dead}, which could not be opened (net::ERR_CONNECTION_REFUSED), so no kit was made. Check the page in a normal browser.`,
      });
      assert.deepEqual(snapshot(dir), before, route);
    }
    // The address asked, when it is the one that cannot be opened, also one
    // that Chrome writes otherwise than it was given.
    for (const asked of [dead, `${dead}a|b`]) {
      await assert.rejects(makeFontKit(asked, { dir, timeLimit: 60_000 }), { message: `Could not open ${asked}: net::ERR_CONNECTION_REFUSED` });
      assert.deepEqual(snapshot(dir), before, asked);
    }
    // A short run, so the server it waits for has ten seconds at most.
    await assert.rejects(makeFontKit(`${origin}/to-hang`, { dir, timeLimit: 10_000 }), {
      message: new RegExp(`^${origin}/to-hang led to ${origin}/hang, which did not answer in \\d+ s, so no kit was made\\. The site may be down or slow; try again later, or give it more time with --timeout\\.$`),
    });
    assert.deepEqual(snapshot(dir), before, "/to-hang");
    const { kit } = await makeFontKit(`${origin}/on`, { dir: path.join(parent, "on"), timeLimit: 60_000 });
    assert.equal(kit.url, `${origin}/next`);
    assert.ok(kit.roles.code, "the code of the page it moved to was read");
    assert.match(fs.readFileSync(path.join(parent, "on", "FONTS.md"), "utf8"), new RegExp(`^Read from ${origin}/next on `, "m"));
    // A page that moves itself on to about:blank shows nothing, also when it
    // loaded a font first, and the message names the address asked, and the
    // one a redirect led to.
    for (const [route, which] of [
      ["/blank", ""],
      ["/blank-font", ""],
      ["/to-blank", `led to ${origin}/blank, which `],
    ]) {
      await assert.rejects(makeFontKit(`${origin}${route}`, { dir, timeLimit: 60_000 }), {
        message: `${origin}${route} ${which}moved itself on to about:blank, an empty page, so no kit was made. Check the page in a normal browser.`,
      });
      assert.deepEqual(snapshot(dir), before, route);
    }
  } finally {
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("two addresses that redirect to each other are told as the address asked, as each of them answers, also when a script or a meta refresh leads to them, and the earlier kit stays", { skip: noBrowser }, async () => {
  const page = (head, body) => `<!doctype html><html><head><title>Moves on</title>${head}</head><body><h1>Moves on</h1><p>This page sends the browser elsewhere.</p>${body}</body></html>`;
  const { server, origin } = await serve({
    "/a": { status: 302, headers: { location: "/b" } },
    "/b": { status: 302, headers: { location: "/a" } },
    // A redirect into the loop, and a page that loads and then goes there.
    "/in": { status: 302, headers: { location: "/a" } },
    "/script": { body: page("", `<script>setTimeout(() => (location.href = "/a"), 50)</script>`) },
    "/meta": { body: page(`<meta http-equiv="refresh" content="0;url=/a">`, "") },
    "/at-load": { body: page("", `<script>addEventListener("load", () => (location.href = "/a"))</script>`) },
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-loop-"));
  const dir = path.join(parent, "kit");
  try {
    earlierKitIn(dir);
    const before = snapshot(dir);
    for (const route of ["/a", "/b", "/in", "/script", "/meta", "/at-load"]) {
      await assert.rejects(makeFontKit(`${origin}${route}`, { dir, timeLimit: 60_000 }), { message: `Could not open ${origin}${route}: net::ERR_TOO_MANY_REDIRECTS` });
      assert.deepEqual(snapshot(dir), before, route);
    }
  } finally {
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a page that moves itself on to a blob: address it made is read there and named by its last web address", { skip: noBrowser }, async () => {
  // Code only inside the blob, so a kit with code was read from it.
  const blob = `URL.createObjectURL(new Blob(["<!doctype html><title>Inside</title><h1>Inside</h1><p>Text the script made.</p><pre><code>npx acme init</code></pre>"], { type: "text/html" }))`;
  const page = (script) => `<!doctype html><html><head><title>Makes a blob</title></head><body><h1>Makes a blob</h1><p>This page goes on to a page it made.</p><script>${script}</script></body></html>`;
  const { server, origin } = await serve({
    "/timed": { body: page(`setTimeout(() => (location.href = ${blob}), 300)`) },
    "/at-load": { body: page(`addEventListener("load", () => (location.href = ${blob}))`) },
    "/moved": { status: 302, headers: { location: "/timed" } },
    "/not-found": { status: 404, body: page(`setTimeout(() => (location.href = ${blob}), 300)`) },
    // A file the browser refuses to save does not move the tab, so it is
    // not the page named when the page goes on.
    "/file.bin": { type: "application/octet-stream", headers: { "content-disposition": 'attachment; filename="from-the-site.txt"' }, body: "written by the site\n" },
    "/file-then-blob": { body: page(`setTimeout(() => (location.href = "/file.bin"), 100); setTimeout(() => (location.href = ${blob}), 800)`) },
    "/file-then-blank": { body: page(`setTimeout(() => (location.href = "/file.bin"), 100); setTimeout(() => (location.href = "about:blank"), 800)`) },
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-blob-"));
  // A home of its own, as these pages ask for a file.
  const env = { ...process.env, HOME: parent };
  try {
    for (const [route, named] of [
      ["/timed", "/timed"],
      ["/at-load", "/at-load"],
      ["/moved", "/timed"],
      ["/file-then-blob", "/file-then-blob"],
    ]) {
      const dir = path.join(parent, route.slice(1));
      const cli = await run([`${origin}${route}`, "--out", dir], env);
      assert.equal(cli.status, 0, cli.stderr);
      assert.match(cli.stdout, /^Saved the fonts of 127\.0\.0\.1 to /, route);
      const kit = JSON.parse(fs.readFileSync(path.join(dir, "fonts.json"), "utf8"));
      assert.equal(kit.url, `${origin}${named}`, route);
      assert.ok(kit.roles.code, "the code of the page it made was read");
      const fontsMd = fs.readFileSync(path.join(dir, "FONTS.md"), "utf8");
      assert.ok(fontsMd.startsWith(`# Fonts of 127.0.0.1\n\nRead from ${origin}${named} on `), fontsMd.slice(0, 200));
      assert.ok(fs.readFileSync(path.join(dir, "fonts.css"), "utf8").startsWith(`/* Fonts of 127.0.0.1, read from ${origin}${named} on `));
    }
    // The server's answer stands: a blob's own 200 is not the page's.
    await assert.rejects(makeFontKit(`${origin}/not-found`, { dir: path.join(parent, "not-found"), timeLimit: 60_000 }), {
      message: `${origin}/not-found answered with an error, HTTP 404 Not Found, so no kit was made. Give the address of a page that loads without an error, like the site's home page.`,
    });
    const blank = await run([`${origin}/file-then-blank`, "--out", path.join(parent, "file-then-blank")], env);
    assert.equal(blank.status, 1, blank.stdout);
    assert.ok(blank.stderr.includes(`easyfontkit: ${origin}/file-then-blank moved itself on to about:blank, an empty page, so no kit was made. Check the page in a normal browser.\n`), blank.stderr);
  } finally {
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("fonts whose names are too long for a file name still get a kit, with short file names that stay apart", { skip: noBrowser }, async () => {
  const family = "Verylongfamilyname ".repeat(17).trim();
  const cssFamily = "Verylongcssname".repeat(20);
  assert.ok(family.length > 300 && cssFamily.length >= 300);
  const font = (names) => ({ type: "font/ttf", body: interAs({ names }) });
  const face = (name, file) => `@font-face { font-family: "${name}"; src: url("${file}") format("truetype"); }`;
  const { server, origin } = await serve({
    "/": {
      body: `<!doctype html><html><head><title>Long names</title><style>
        ${face("One", "/family.ttf")}
        ${face("Two", "/same-start.ttf")}
        ${face("Three", "/style.ttf")}
        ${face(cssFamily, "/hidden.ttf")}
        h1 { font-family: "One", sans-serif; }
        h2 { font-family: "Two", sans-serif; }
        p { font-family: "Three", sans-serif; }
        pre, code { font-family: "${cssFamily}", monospace; }
      </style></head><body><h1>Tools for teams</h1><h2>Plan and launch</h2><p>Every part of the work stays where the team can see it.</p><pre><code>npx acme init</code></pre></body></html>`,
    },
    // A family's name from its file, and one the same but for its end, which
    // lies past the cut, so both are cut to the same file name.
    "/family.ttf": font({ 1: family, 2: "Regular" }),
    "/same-start.ttf": font({ 1: `${family} Two`, 2: "Regular" }),
    // A style's name from its file.
    "/style.ttf": font({ 1: "Short Family", 2: "Stylish ".repeat(40).trim() }),
    // A file that hides its names is named from the CSS.
    "/hidden.ttf": font({ 1: ".\u007f", 2: "\u007f", 6: "\u007f" }),
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-long-"));
  const dir = path.join(parent, "kit");
  try {
    const { kit } = await makeFontKit(`${origin}/`, { dir, timeLimit: 60_000 });
    const names = fs.readdirSync(path.join(dir, "files"));
    assert.equal(names.length, 4, names.join("\n"));
    for (const name of names) assert.ok(Buffer.byteLength(name) <= 150, name);
    // Only a number keeps the two families cut to one name apart.
    const cut = `${"verylongfamilyname-".repeat(4)}very-400`;
    assert.deepEqual(names.filter((name) => name.endsWith("-2.ttf")), [`${cut}-2.ttf`], names.join("\n"));
    assert.ok(names.includes(`${cut}.ttf`), names.join("\n"));
    // The kit lists each file under the name it was saved with.
    const listed = kit.families.flatMap((one) => one.files.map((file) => path.basename(file.file)));
    assert.deepEqual(listed.sort(), names.sort());
    // The names in the kit itself stay whole, one written as a single word
    // with its words set apart.
    const whole = kit.families.map((one) => one.name);
    for (const name of [family, `${family} Two`]) assert.ok(whole.includes(name), whole.join("\n"));
    assert.ok(whole.some((name) => name.replace(/ /g, "") === cssFamily), whole.join("\n"));
    assert.deepEqual(fs.readdirSync(dir).sort(), ["FONTS.md", "files", "fonts.css", "fonts.json"]);
  } finally {
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// A page that sends the browser to a file served as an attachment, as a
// download link does. Chrome on Linux saves a download in the Downloads
// folder of the home it runs with, where nothing removes it.
const noDownloads = noBrowser || (process.platform !== "linux" && "Chrome reads where it saves a download from HOME on Linux only");
const savedIn = (home) =>
  fs
    .readdirSync(home, { recursive: true })
    .map(String)
    .filter((name) => /from-the-site|\.crdownload$/.test(name));
function attachment(onAsked) {
  return {
    type: "application/octet-stream",
    headers: { "content-disposition": 'attachment; filename="from-the-site.txt"' },
    get body() {
      onAsked();
      return "written by the site\n";
    },
  };
}
const startsDownload = (script) => `<!doctype html><html><head><title>Download</title></head><body><h1>Download</h1><p>A page that gets a file.</p><a id="file" href="/file.bin">The file</a><script>${script}</script></body></html>`;

test("a page cannot make the browser save a file and is read where it stays, and an address that is a file gets no kit and saves nothing", { skip: noDownloads }, async () => {
  let asked = 0;
  const { server, origin } = await serve({
    "/script": { body: startsDownload(`setTimeout(() => (location.href = "/file.bin"), 300)`) },
    "/click": { body: startsDownload(`setTimeout(() => document.getElementById("file").click(), 300)`) },
    "/file.bin": attachment(() => asked++),
    "/to-file": { status: 302, headers: { location: "/file.bin" } },
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-download-"));
  const home = path.join(parent, "home");
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home };
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_DOWNLOAD_DIR;
  try {
    for (const route of ["/script", "/click"]) {
      const was = asked;
      const dir = path.join(parent, route.slice(1));
      const cli = await run([`${origin}${route}`, "--out", dir], env);
      assert.equal(cli.status, 0, cli.stderr);
      assert.ok(asked > was, `${route} sent the browser to the file`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "fonts.json"), "utf8")).url, `${origin}${route}`, "the page stayed where it was");
      assert.deepEqual(savedIn(home), [], route);
    }
    for (const [route, message] of [
      ["/file.bin", `Could not open ${origin}/file.bin: net::ERR_ABORTED`],
      ["/to-file", `${origin}/to-file led to ${origin}/file.bin, which could not be opened (net::ERR_ABORTED), so no kit was made. Check the page in a normal browser.`],
    ]) {
      const was = asked;
      const dir = path.join(parent, `asked${route.replace(/\W/g, "-")}`);
      const cli = await run([`${origin}${route}`, "--out", dir], env);
      assert.equal(cli.status, 1, cli.stdout);
      assert.ok(cli.stderr.includes(`easyfontkit: ${message}\n`), cli.stderr);
      assert.ok(asked > was, `${route} sent the browser to the file`);
      assert.equal(fs.existsSync(dir), false, "nothing written");
      assert.deepEqual(savedIn(home), [], route);
    }
  } finally {
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("the browser stays told to save nothing until it is closed, also once the session of its tab has been let go of", { skip: noDownloads }, async () => {
  let asked = 0;
  const { server, origin } = await serve({
    "/": { body: startsDownload(`setTimeout(() => (location.href = "/file.bin"), 400)`) },
    "/file.bin": attachment(() => asked++),
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-download-"));
  const saved = Object.fromEntries(["HOME", "XDG_CONFIG_HOME", "XDG_DOWNLOAD_DIR"].map((name) => [name, process.env[name]]));
  process.env.HOME = parent;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DOWNLOAD_DIR;
  const screen = { width: 800, height: 600 };
  let chrome;
  try {
    setTimeLimit(60_000);
    chrome = await launch(screen);
    const cdp = await openPage(chrome, screen);
    await cdp.send("Page.navigate", { url: `${origin}/` });
    cdp.close();
    for (let waited = 0; waited < 10_000 && !asked; waited += 50) await sleep(50);
    assert.ok(asked, "the page sent the browser to the file");
    await sleep(1_000);
    assert.deepEqual(savedIn(parent), []);
  } finally {
    if (chrome) await chrome.close();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// The ports that the processes whose command line names the given text
// listen on, from /proc on Linux. A kernel with IPv6 turned off has no
// /proc/net/tcp6: the IPv4 table is read all the same.
function listening(named, tables = ["/proc/net/tcp", "/proc/net/tcp6"]) {
  const sockets = new Set();
  for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      if (!fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(named)) continue;
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        const socket = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (socket) sockets.add(socket[1]);
      }
    } catch {
      // Gone, or not this user's.
    }
  }
  const ports = [];
  for (const table of tables) {
    let text;
    try {
      text = fs.readFileSync(table, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      // The state 0A is LISTEN; the tenth field is the socket's inode.
      if (fields[3] === "0A" && sockets.has(fields[9])) ports.push(parseInt(fields[1].split(":")[1], 16));
    }
  }
  return ports;
}

test("the browser listens on no port, so no other program on the machine can read or drive it, and is driven over its pipe", { skip: noBrowser || (process.platform !== "linux" && "a process's sockets are read from /proc on Linux only") }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-port-"));
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = parent;
  const screen = { width: 800, height: 600 };
  let chrome;
  try {
    // The ports are found: a listener of the test's own, named on its
    // command line, in the IPv4 table, also where the IPv6 one is missing.
    const tag = `easyfontkit-listener-${process.pid}`;
    const listener = spawn(process.execPath, ["-e", 'const s = require("net").createServer().listen(0, "127.0.0.1", () => console.log(s.address().port));', tag], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const port = Number(
        await new Promise((resolve, reject) => {
          listener.stdout.once("data", resolve);
          listener.once("exit", () => reject(new Error("the listener did not start")));
        }),
      );
      assert.deepEqual(listening(tag, ["/proc/net/tcp", "/proc/net/no-such-table"]), [port]);
    } finally {
      listener.kill("SIGKILL");
    }
    setTimeLimit(60_000);
    chrome = await launch(screen);
    const profile = fs.readdirSync(parent).find((name) => name.startsWith("easyfontkit-chrome-"));
    const cdp = await openPage(chrome, screen);
    const { result } = await cdp.send("Runtime.evaluate", { expression: "1 + 1", returnByValue: true });
    assert.equal(result.value, 2, "the tab answers over the pipe");
    assert.deepEqual(listening(profile), [], "ports the browser listens on");
    assert.equal(fs.existsSync(path.join(parent, profile, "DevToolsActivePort")), false);
    cdp.close();
  } finally {
    if (chrome) await chrome.close();
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    setTimeLimit(120_000);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a page that answers with an error is refused, naming the status and the address the run ended on, and the earlier kit stays", { skip: noBrowser }, async () => {
  // Error pages as servers send them, drawn in the browser's default font.
  const error = (title) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>The page you asked for is not here.</p></body></html>`;
  const { server, origin } = await serve({
    // A frame that answers with an error is not the page.
    "/": { body: `<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1><p>A page that loads.</p><iframe src="/missing"></iframe></body></html>` },
    "/missing": { status: 404, body: error("Not Found") },
    "/moved": { status: 302, headers: { location: "/gone/page.html" } },
    "/empty": { status: 404 },
    "/broken": { status: 500, body: error("Internal Server Error") },
    "/private": { status: 403, body: error("Forbidden") },
    "/old-home": { status: 301, headers: { location: "/" } },
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-error-"));
  const dir = path.join(parent, "kit");
  const elsewhere = "Give the address of a page that loads without an error, like the site's home page.";
  try {
    earlierKitIn(dir);
    const before = snapshot(dir);
    const cli = await run([`${origin}/missing`, "--out", dir, "--json"]);
    const missing = `${origin}/missing answered with an error, HTTP 404 Not Found, so no kit was made. ${elsewhere}`;
    assert.equal(cli.status, 1);
    assert.deepEqual(JSON.parse(cli.stdout), { ok: false, error: missing });
    assert.equal(cli.stderr, `easyfontkit: ${missing}\n`);
    assert.deepEqual(snapshot(dir), before);
    const refused = {
      // A #fragment is not sent to the server, so it is not a redirect; nor
      // is a | that Chrome writes as %7C.
      "/missing#top": `${origin}/missing#top answered with an error, HTTP 404 Not Found, so no kit was made. ${elsewhere}`,
      "/old|page": `${origin}/old|page answered with an error, HTTP 404 Not Found, so no kit was made. ${elsewhere}`,
      "/moved": `${origin}/moved led to ${origin}/gone/page.html, which answered with an error, HTTP 404 Not Found, so no kit was made. ${elsewhere}`,
      // No page of its own: Chrome shows its error page, and the status says more.
      "/empty": `${origin}/empty answered with an error, HTTP 404 Not Found, so no kit was made. ${elsewhere}`,
      "/broken": `${origin}/broken answered with an error, HTTP 500 Internal Server Error, so no kit was made. The site may be down or busy; try again later.`,
      "/private": `${origin}/private answered with an error, HTTP 403 Forbidden, so no kit was made. The page may need a login, or the site may turn away headless browsers; check the page in a normal browser.`,
    };
    for (const [route, message] of Object.entries(refused)) {
      await assert.rejects(makeFontKit(`${origin}${route}`, { dir, timeLimit: 60_000 }), { message });
      assert.deepEqual(snapshot(dir), before, route);
    }
    // A redirect that ends on a page that loads makes a kit, as before.
    const { kit } = await makeFontKit(`${origin}/old-home`, { dir, timeLimit: 60_000 });
    assert.equal(kit.url, `${origin}/`);
  } finally {
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a run refused for an error page leaves nothing in the temp folder, also one too long for the socket Chrome makes there", { skip: noBrowser }, async () => {
  const { server, origin } = await serve({ "/missing": { status: 404, body: "<!doctype html><html><head><title>Not Found</title></head><body><h1>Not Found</h1></body></html>" } });
  // Over 32 bytes, so the profile's path leaves no room for the socket
  // Chrome makes in it, and over 70, so a folder of Chrome's own there
  // leaves none either.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "e"));
  const folder = (letter, bytes) => {
    const at = path.join(base, letter.repeat(Math.max(1, bytes - Buffer.byteLength(base) - 1)));
    fs.mkdirSync(at);
    return at;
  };
  try {
    for (const tmp of [folder("s", 40), folder("l", 100)]) {
      for (let i = 1; i <= 2; i++) {
        const child = spawn(process.execPath, [CLI, `${origin}/missing`, "--out", path.join(tmp, "kit")], { env: { ...process.env, TMPDIR: tmp }, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        const status = await new Promise((resolve) => child.on("close", resolve));
        assert.equal(status, 1, stderr);
        assert.match(stderr, /answered with an error, HTTP 404 Not Found/);
        assert.deepEqual(fs.readdirSync(tmp), [], `run ${i} in ${tmp}`);
      }
    }
  } finally {
    server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
