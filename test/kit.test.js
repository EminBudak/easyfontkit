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
const { makeFontKit, normalizeUrl, earlierKit, saveKit } = require("../skills/easyfontkit/scripts/lib/kit");
const { findChrome } = require("../skills/easyfontkit/scripts/lib/chrome");
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
    // The lock and the part folders of runs do not count.
    const empty = path.join(dir, "empty");
    fs.mkdirSync(path.join(empty, ".easyfontkit-part-1-0000000a"), { recursive: true });
    fs.writeFileSync(path.join(empty, ".easyfontkit-lock"), "1");
    assert.equal(earlierKit(empty), null);
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
    const before = snapshot(parent);
    const refused = {
      [path.join(locked, "kit")]: `This user may not write in ${locked}, so ${path.join(locked, "kit")} cannot be made there. Pick another folder with --out.`,
      [locked]: `This user may not write in ${locked}. Pick another folder with --out.`,
      [path.join(noenter, "kit")]: `This user may not write in ${noenter}, so ${path.join(noenter, "kit")} cannot be made there. Pick another folder with --out.`,
      [file]: `${file} is not a folder. Pick another folder with --out.`,
      [path.join(file, "kit")]: `${file} is not a folder, so ${path.join(file, "kit")} cannot be made there. Pick another folder with --out.`,
      [kit]: `No kit can be saved in ${kit}: ${path.join(kit, "FONTS.md")} is not a file. Move it away, or pick another folder with --out.`,
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

test("a stop signal kills the browser, leaves the folder as it was, says so and ends the run by that signal, also when a second one comes", { skip: noSignals }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-signal-"));
  const groups = [];
  try {
    // A browser that starts and never answers, so a run waits for it, with
    // a helper process that makes its profile again once it is removed, as
    // Chrome's helpers can on their way out, and a socket folder in the temp
    // folder that the profile links to, as Chrome's own.
    const chrome = path.join(parent, "chrome");
    fs.writeFileSync(
      chrome,
      `#!/bin/sh
for arg in "$@"; do case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}";; esac; done
socket=$(mktemp -d "$TMPDIR/com.example.Chrome.XXXXXX") && : > "$socket/SingletonSocket" && ln -s "$socket/SingletonSocket" "$profile/SingletonSocket"
(i=0; while [ -d "$profile" ] && [ $i -lt 3000 ]; do sleep 0.01; i=$((i + 1)); done; mkdir -p "$profile/Default") &
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
    const stop = async (dir, preload) => {
      const tmp = fs.mkdtempSync(path.join(parent, "tmp-"));
      fs.rmSync(path.join(parent, "chrome.pid"), { force: true });
      // In a process group of its own, with its browser, so whatever is
      // left of it can be stopped at the end.
      const child = spawn(process.execPath, [...(preload ? ["--require", preload] : []), CLI, "acme.example", "--out", dir], {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, CHROME_PATH: chrome, TMPDIR: tmp },
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
      child.kill("SIGTERM");
      const { signal } = await ended;
      for (let i = 0; i < 100 && !gone(pid); i++) await sleep(20);
      return { signal, stderr, browserLeft: !gone(pid), profiles: fs.readdirSync(tmp) };
    };
    const dir = path.join(parent, "kit");
    earlierKitIn(dir);
    const before = snapshot(dir);
    for (const preload of [null, twice]) {
      const stopped = await stop(dir, preload);
      assert.deepEqual(stopped, { signal: "SIGTERM", stderr: `easyfontkit: stopped by SIGTERM, so no kit was made. The earlier kit in ${dir} is as it was.\n`, browserLeft: false, profiles: [] });
      assert.deepEqual(snapshot(dir), before);
    }
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
    assert.deepEqual(fs.readdirSync(dir).sort(), ["FONTS.md", "fonts.css", "fonts.json"]);

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

test("a run stopped while it reads the page leaves the earlier kit as it was, closes its browser and ends by the signal", { skip: noBrowser || noSignals }, async () => {
  const { server, origin } = await serve({
    "/": { body: `<!doctype html><html><head><title>Stalls</title><link rel="stylesheet" href="/held.css"></head><body><h1>Stalls</h1><p>A style sheet that never comes.</p></body></html>` },
    "/held.css": { hold: true },
  });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-stop-"));
  const dir = path.join(parent, "kit");
  // The browser's profile goes in the temp folder: a longer path than that
  // can be too long for the socket Chrome makes there.
  const profiles = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("easyfontkit-chrome-"));
  const others = new Set(profiles());
  let child;
  try {
    earlierKitIn(dir);
    const before = snapshot(dir);
    // In a process group of its own, as makersmcp runs a kit. The stop goes
    // to the whole group, as Ctrl-C and makersmcp's cancel send it, and a
    // second copy to the kit, as npm and makersmcp's supervisor pass it on.
    child = spawn(process.execPath, [CLI, origin, "--out", dir], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    const opened = new Promise((resolve) => child.stderr.on("data", (chunk) => /Opening/.test((stderr += chunk)) && resolve()));
    await Promise.race([opened, ended]);
    assert.match(stderr, /Opening/);
    const mine = profiles().filter((name) => !others.has(name));
    assert.equal(mine.length, 1);
    await sleep(1500);
    // Chrome's socket folder, which it removes only when it quits. On Linux
    // the profile links to it from the start.
    let socket = "";
    try {
      socket = path.dirname(fs.readlinkSync(path.join(os.tmpdir(), mine[0], "SingletonSocket")));
    } catch (err) {
      if (process.platform === "linux") throw err;
    }
    process.kill(-child.pid, "SIGTERM");
    await sleep(20);
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      // Ended already.
    }
    const { signal } = await ended;
    assert.equal(signal, "SIGTERM");
    assert.ok(stderr.endsWith(`\neasyfontkit: stopped by SIGTERM, so no kit was made. The earlier kit in ${dir} is as it was.\n`), stderr);
    assert.deepEqual(snapshot(dir), before);
    const browsers = () => spawnSync("ps", ["-A", "-o", "args="], { encoding: "utf8" }).stdout.split("\n").filter((line) => line.includes(mine[0]));
    for (let i = 0; i < 150 && browsers().length; i++) await sleep(20);
    assert.deepEqual(browsers(), []);
    assert.equal(fs.existsSync(path.join(os.tmpdir(), mine[0])), false, "no browser profile left");
    if (socket) assert.equal(fs.existsSync(socket), false, "no socket folder left");
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

test("a bot check served instead of the page fails with a reason and leaves nothing behind", { skip: noBrowser }, async () => {
  const html = "<!doctype html><html><head><title>Just a moment...</title></head><body><p>Checking your browser.</p></body></html>";
  // Also with the error status a bot check often comes with: it is still
  // told as a bot check.
  const { server, origin } = await serve({ "/": { body: html }, "/403": { status: 403, body: html } });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-out-"));
  const dir = path.join(parent, "kit");
  try {
    for (const url of [origin, `${origin}/403`]) {
      await assert.rejects(makeFontKit(url, { dir, timeLimit: 60_000 }), /answered with a bot check \("Just a moment\.\.\."\)/);
      assert.equal(fs.existsSync(dir), false, "no folder left behind");
    }
  } finally {
    server.close();
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
      // A #fragment is not sent to the server, so it is not a redirect.
      "/missing#top": missing,
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
