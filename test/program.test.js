"use strict";

// A browser that cannot be started, in each way it can come about: the run
// stops before any work with the path CHROME_PATH or the search for one
// gave, what is wrong with it and how to point to one that runs, exits
// with 1, makes no out folder and leaves nothing in its temp folder.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const CLI = path.resolve(__dirname, "../skills/easyfontkit/scripts/easyfontkit.js");
const POINT = "Point CHROME_PATH at the program of a Chrome, Chromium, Edge or Brave that runs, or unset it and install one.";
const INSTALL = "Install Chrome, Chromium, Edge or Brave, or point CHROME_PATH at the program of one that runs.";
const NONE = "No Chrome, Chromium, Edge or Brave found";
// An address no run opens: each of these stops before the page is read.
const URL = "http://127.0.0.1:9/";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-program-"));
test.after(() => {
  // Folders a test locked are opened again, so they can go.
  for (const locked of [path.join(dir, "denied", "locked")]) {
    try {
      fs.chmodSync(locked, 0o755);
    } catch {
      // Not made.
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// A file named `name` in a folder of its own under `root`.
function put(root, folder, bytes, mode = 0o755, name = "chrome") {
  const file = path.join(root, folder, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  fs.chmodSync(file, mode);
  return file;
}

// Runs the kit for each [env, message] of `cases` from `root`, once with
// the summary and once with --json, and holds that each stops before any
// work with that message, exits with 1, and leaves no out folder and
// nothing in its temp folder. A run goes through the command `wrap` when
// there is one, and node is given `node` before the script.
function refused(root, cases, { wrap = [], node = [] } = {}) {
  const { CHROME_PATH, PATH, TMPDIR, ...rest } = process.env;
  let n = 0;
  for (const [env, message] of cases) {
    for (const json of [false, true]) {
      const folder = path.join(root, "runs", String(n));
      const tmp = path.join(root, "tmp", String(n++));
      fs.mkdirSync(folder, { recursive: true });
      fs.mkdirSync(tmp, { recursive: true });
      const command = [...wrap, process.execPath, ...node, CLI, URL, "--out", path.join(folder, "out"), ...(json ? ["--json"] : [])];
      const run = spawnSync(command[0], command.slice(1), { cwd: root, encoding: "utf8", env: { ...rest, TMPDIR: tmp, ...env }, timeout: 60_000 });
      const what = `${JSON.stringify(env)}${json ? " --json" : ""}`;
      assert.equal(run.status, 1, `${what}: ${run.stderr}`);
      assert.equal(run.stderr, `easyfontkit: ${message}\n`, what);
      if (json) assert.deepEqual(JSON.parse(run.stdout), { ok: false, error: message }, what);
      assert.deepEqual(fs.readdirSync(folder), [], what);
      assert.deepEqual(fs.readdirSync(tmp), [], what);
    }
  }
}

// Whether binfmt_misc gives files that start with `magic` (in hex) to a
// program of its own, as qemu or wine, which would run them.
function handled(magic) {
  try {
    const root = "/proc/sys/fs/binfmt_misc";
    return fs.readdirSync(root).some((name) => {
      if (name === "register" || name === "status") return false;
      const entry = fs.readFileSync(path.join(root, name), "utf8");
      return /^enabled$/m.test(entry) && entry.includes(`\nmagic ${magic}`);
    });
  } catch {
    return false;
  }
}

// A copy of a small program of this system's, at `file`, that the system's
// loader cannot start: the loader its ELF headers name (PT_INTERP), or the
// first library they say it needs (DT_NEEDED), has another name. That
// name, or null when no such program is a 64-bit little-endian ELF that
// names one.
function unloadable(file, what) {
  const source = ["/usr/bin/true", "/bin/true"].find((name) => fs.existsSync(name));
  if (!source) return null;
  const bytes = fs.readFileSync(source);
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46 || bytes[4] !== 2 || bytes[5] !== 1) return null;
  const headers = Array.from({ length: bytes.readUInt16LE(0x38) }, (_, i) => {
    const at = Number(bytes.readBigUInt64LE(0x20)) + i * bytes.readUInt16LE(0x36);
    return { type: bytes.readUInt32LE(at), offset: Number(bytes.readBigUInt64LE(at + 8)), vaddr: Number(bytes.readBigUInt64LE(at + 16)), size: Number(bytes.readBigUInt64LE(at + 32)) };
  });
  let from = -1;
  let at = -1;
  if (what === "loader") {
    const interp = headers.find((h) => h.type === 3);
    if (interp) [from, at] = [interp.offset, bytes.indexOf(0, interp.offset) - 1];
  } else {
    const dynamic = headers.find((h) => h.type === 2);
    const entries = [];
    for (let e = dynamic ? dynamic.offset : 0; dynamic && e + 16 <= dynamic.offset + dynamic.size && bytes.readBigInt64LE(e) !== 0n; e += 16) entries.push({ tag: Number(bytes.readBigInt64LE(e)), value: Number(bytes.readBigUInt64LE(e + 8)) });
    const strtab = (entries.find((e) => e.tag === 5) || {}).value;
    const needed = entries.find((e) => e.tag === 1);
    const load = headers.find((h) => h.type === 1 && h.vaddr <= strtab && strtab < h.vaddr + h.size);
    if (needed && load) from = at = load.offset + strtab - load.vaddr + needed.value;
  }
  if (at < from || from < 0) return null;
  bytes[at] = bytes[at] === 0x58 ? 0x59 : 0x58;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  fs.chmodSync(file, 0o755);
  return bytes.toString("latin1", from, bytes.indexOf(0, from));
}

test("a CHROME_PATH that names no browser the system could start, as a path where nothing is, a folder or a link to one, a link to nothing or round a loop, a path through a file, a name not on PATH, a file without the permission to run it, an empty or a text file, a script whose interpreter is missing or a program for another system, stops the run before any work with that path, what is wrong with it and how to point to one that runs", () => {
  const root = path.join(dir, "named");
  const at = (...names) => path.join(root, ...names);
  const { PATH } = process.env;
  fs.mkdirSync(root, { recursive: true });
  const cases = [
    [{ PATH, CHROME_PATH: at("nothing", "chrome") }, `${NONE}: CHROME_PATH is ${at("nothing", "chrome")}, and there is no file there. ${POINT}`],
    [{ PATH, CHROME_PATH: "chrome-not-there" }, `${NONE}: CHROME_PATH is chrome-not-there, and no program by that name is on your PATH. ${POINT}`],
  ];
  if (process.platform !== "win32") {
    fs.mkdirSync(at("folder", "chrome"), { recursive: true });
    fs.mkdirSync(at("links"), { recursive: true });
    fs.symlinkSync(at("folder", "chrome"), at("links", "to-folder"));
    fs.symlinkSync(at("gone", "chrome"), at("links", "to-none"));
    fs.symlinkSync(at("links", "b"), at("links", "a"));
    fs.symlinkSync(at("links", "a"), at("links", "b"));
    const plain = put(root, "plain", "#!/bin/sh\nexec google-chrome \"$@\"\n", 0o644);
    const empty = put(root, "empty", "");
    const script = put(root, "script", "#!/nonexistent/interpreter\n");
    cases.push(
      // A folder, like an app's whole folder where its program is in it.
      [{ PATH, CHROME_PATH: at("folder", "chrome") }, `chrome did not start: CHROME_PATH is ${at("folder", "chrome")}, a folder, not a program. ${POINT}`],
      [{ PATH, CHROME_PATH: at("links", "to-folder") }, `to-folder did not start: CHROME_PATH is ${at("links", "to-folder")}, a link to the folder ${fs.realpathSync(at("folder", "chrome"))}, not to a program. ${POINT}`],
      [{ PATH, CHROME_PATH: at("links", "to-none") }, `${NONE}: CHROME_PATH is ${at("links", "to-none")}, a link to ${at("gone", "chrome")}, where there is no file. ${POINT}`],
      [{ PATH, CHROME_PATH: at("links", "a") }, `${NONE}: CHROME_PATH is ${at("links", "a")}, a link in a loop of links, which leads to no file. ${POINT}`],
      [{ PATH, CHROME_PATH: path.join(plain, "chrome") }, `${NONE}: CHROME_PATH is ${path.join(plain, "chrome")}, and there is no file there, as ${plain} is a file, not a folder. ${POINT}`],
      [{ PATH, CHROME_PATH: plain }, `chrome did not start: CHROME_PATH is ${plain}, a file without the permission to run it, which chmod +x gives. ${POINT}`],
      // The system would take it for a script with nothing in it, which
      // ends at once and well.
      [{ PATH, CHROME_PATH: empty }, `chrome did not start: CHROME_PATH is ${empty}, an empty file, not a program. ${POINT}`],
      [{ PATH, CHROME_PATH: script }, `chrome did not start: CHROME_PATH is ${script}, a script whose first line names /nonexistent/interpreter, which is not on this machine. ${POINT}`],
      // A path from the folder the run was started in.
      [{ PATH, CHROME_PATH: path.join("empty", "chrome") }, `chrome did not start: CHROME_PATH is ${path.join("empty", "chrome")}, an empty file, not a program. ${POINT}`],
      // A name looked up on PATH, as a shell would.
      [{ PATH: `${at("empty")}${path.delimiter}${PATH}`, CHROME_PATH: "chrome" }, `chrome did not start: CHROME_PATH is chrome, found on your PATH at ${empty}, an empty file, not a program. ${POINT}`],
    );
  }
  if (process.platform === "linux") {
    // glibc hands a file it cannot run as a program to /bin/sh, which reads
    // it as a script: a text file with no #! line, as a web page saved in
    // place of the program, and a program made for macOS, for Windows or
    // for another processor.
    const text = put(root, "text", "<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head>\n<body><h1>Not Found</h1></body></html>\n");
    const mac = put(root, "mac", Buffer.concat([Buffer.from("cffaedfe07000001030000000200000000", "hex"), Buffer.alloc(4096)]));
    cases.push(
      [{ PATH, CHROME_PATH: text }, `chrome did not start: CHROME_PATH is ${text}, a text file with no #! line, not a program. ${POINT}`],
      [{ PATH, CHROME_PATH: mac }, `chrome did not start: CHROME_PATH is ${mac}, a macOS program, which does not run on Linux. ${POINT}`],
    );
    // Unless the system has a program of its own that runs them.
    if (!handled("4d5a")) {
      const windows = put(root, "windows", Buffer.concat([Buffer.from("4d5a90000300000004000000ffff0000b8000000000000004000", "hex"), Buffer.alloc(4096)]));
      cases.push([{ PATH, CHROME_PATH: windows }, `chrome did not start: CHROME_PATH is ${windows}, a Windows program, which does not run on Linux. ${POINT}`]);
    }
    if (!handled("7f454c46") && ["x64", "arm64"].includes(process.arch)) {
      const elf = Buffer.concat([Buffer.from("7f454c4602010100000000000000000002000000", "hex"), Buffer.alloc(4096)]);
      elf.writeUInt16LE(process.arch === "arm64" ? 0x3e : 0xb7, 0x12);
      const foreign = put(root, "foreign", elf);
      const other = process.arch === "arm64" ? "x86-64, which this ARM64 (aarch64)" : "ARM64 (aarch64), which this x86-64";
      cases.push([{ PATH, CHROME_PATH: foreign }, `chrome did not start: CHROME_PATH is ${foreign}, a program for ${other} machine cannot run. ${POINT}`]);
    }
  }
  refused(root, cases);
});

test("a browser found on PATH that the system could not start is named as the one on PATH, and a folder or a file that may not be run by a browser's name is passed over, as a shell passes over them, and named when no browser follows", { skip: process.platform !== "linux" && "the browser is looked for on PATH on Linux only" }, () => {
  const root = path.join(dir, "found");
  const at = (...names) => path.join(root, ...names);
  const text = put(root, "text", "not a program\n", 0o755, "google-chrome");
  fs.mkdirSync(at("folder", "google-chrome"), { recursive: true });
  put(root, "plain", "#!/bin/sh\n", 0o644, "chromium");
  fs.mkdirSync(at("empty"), { recursive: true });
  refused(root, [
    [{ PATH: `${at("text")}:${at("empty")}` }, `google-chrome did not start: ${text}, the google-chrome on your PATH, is a text file with no #! line, not a program. ${INSTALL}`],
    // The folder is passed over for the text file after it.
    [{ PATH: `${at("folder")}:${at("text")}` }, `google-chrome did not start: ${text}, the google-chrome on your PATH, is a text file with no #! line, not a program. ${INSTALL}`],
    [{ PATH: `${at("folder")}:${at("plain")}` }, `${NONE}: ${at("folder", "google-chrome")}, the google-chrome on your PATH, is a folder, not a program. ${INSTALL}`],
    [{ PATH: `${at("plain")}:${at("empty")}` }, `${NONE}: ${at("plain", "chromium")}, the chromium on your PATH, is a file without the permission to run it, which chmod +x gives. ${INSTALL}`],
    // With nothing at all, the words are those of every earlier release.
    [{ PATH: at("empty") }, `${NONE}. Install one, or point CHROME_PATH at its binary.`],
  ]);
});

test("a browser this user may not run, by its mode or a folder on its path, is named before any work", { skip: process.platform === "win32" ? "Windows keeps no such mode" : process.getuid() === 0 ? "root may run any file with an x bit, and enter any folder" : false }, () => {
  const root = path.join(dir, "denied");
  // x for the group and the others, none for its owner, who runs it.
  const others = put(root, "others", "#!/bin/sh\nexec google-chrome \"$@\"\n", 0o055);
  const locked = put(root, "locked", "#!/bin/sh\nexec google-chrome \"$@\"\n");
  fs.chmodSync(path.join(root, "locked"), 0);
  try {
    refused(root, [
      [{ PATH: process.env.PATH, CHROME_PATH: others }, `chrome did not start: CHROME_PATH is ${others}, a file this user may not run, as only other users have the permission to run it. ${POINT}`],
      [{ PATH: process.env.PATH, CHROME_PATH: locked }, `${NONE}: CHROME_PATH is ${locked}, in ${path.join(root, "locked")}, a folder this user may not enter. ${POINT}`],
    ]);
  } finally {
    fs.chmodSync(path.join(root, "locked"), 0o755);
  }
});

test("a browser on a file system mounted noexec is named as one, before any work", { skip: process.platform !== "linux" && "noexec mounts are told from /proc on Linux only" }, (t) => {
  const root = path.join(dir, "noexec");
  const mount = path.join(root, "mount");
  fs.mkdirSync(mount, { recursive: true });
  // A tmpfs mounted noexec in a mount namespace of the test's own, where
  // this user is root and runs the kit, as nothing on it may be run.
  const script = 'mount -t tmpfs -o noexec,size=1m tmpfs "$1" && printf "#!/bin/sh\\nexec google-chrome \\"\\$@\\"\\n" > "$1/chrome" && chmod 755 "$1/chrome" && shift && exec "$@"';
  const wrap = ["unshare", "-rm", "sh", "-c", script, "sh", mount];
  const probe = spawnSync(wrap[0], [...wrap.slice(1), "true"], { encoding: "utf8" });
  if (probe.status !== 0) return t.skip(`no mount namespace for this user here: ${(probe.stderr || String(probe.error)).trim()}`);
  const file = path.join(mount, "chrome");
  refused(root, [[{ PATH: process.env.PATH, CHROME_PATH: file }, `chrome did not start: CHROME_PATH is ${file}, a file on ${mount}, which is mounted noexec, so no program on it may run. ${POINT}`]], { wrap });
});

test("a browser the system's loader cannot start, as its loader or a library it needs is missing, is named with what is missing, before any work", { skip: process.platform !== "linux" && "the stand-ins are Linux programs" }, (t) => {
  const root = path.join(dir, "unloaded");
  const at = (...names) => path.join(root, ...names);
  const loader = unloadable(at("noloader", "chrome"), "loader");
  const glibc = Boolean(process.report.getReport().header.glibcVersionRuntime);
  const library = glibc && unloadable(at("nolib", "chrome"), "library");
  if (!loader && !library) return t.skip("no 64-bit little-endian program of this system's to make them from");
  const { PATH } = process.env;
  const cases = [];
  if (loader) cases.push([{ PATH, CHROME_PATH: at("noloader", "chrome") }, `chrome did not start: CHROME_PATH is ${at("noloader", "chrome")}, a program that needs the loader ${loader}, which is not on this machine. ${POINT}`]);
  // glibc's loader names a library that is not there and exits with 127.
  if (library) {
    cases.push(
      [{ PATH, CHROME_PATH: at("nolib", "chrome") }, `chrome did not start: CHROME_PATH is ${at("nolib", "chrome")}, a program that needs the shared library ${library}, which is not on this machine. ${POINT}`],
      [{ PATH: `${at("nolib")}:${PATH}`, CHROME_PATH: "chrome" }, `chrome did not start: CHROME_PATH is chrome, found on your PATH at ${at("nolib", "chrome")}, a program that needs the shared library ${library}, which is not on this machine. ${POINT}`],
    );
    // Found on PATH, by a browser's name.
    fs.mkdirSync(at("onpath"), { recursive: true });
    fs.copyFileSync(at("nolib", "chrome"), at("onpath", "chromium"));
    fs.chmodSync(at("onpath", "chromium"), 0o755);
    cases.push([{ PATH: at("onpath") }, `chromium did not start: ${at("onpath", "chromium")}, the chromium on your PATH, is a program that needs the shared library ${library}, which is not on this machine. ${INSTALL}`]);
  }
  refused(root, cases);
});

test("a run with no file descriptor left to start the browser stops before any work and says what to do", { skip: process.platform === "win32" && "it takes sh to lower the limit" }, () => {
  const root = path.join(dir, "no-descriptors");
  const browser = put(root, "bin", "#!/bin/sh\nexec google-chrome \"$@\"\n");
  // Loaded before the kit: makes node's own signal pipe, then holds every
  // file descriptor it may but three: one for the kit's stderr, one for the
  // files it reads one at a time, and one more, where starting the browser
  // takes six for its pipes.
  const hold = path.join(root, "hold.js");
  fs.writeFileSync(hold, 'process.on("SIGWINCH", () => {});\nconst fs = require("node:fs");\nconst held = [];\ntry {\n  for (;;) held.push(fs.openSync(__filename, "r"));\n} catch {}\nfor (let i = 0; i < 3; i++) fs.closeSync(held.pop());\n');
  const message = `chrome did not start: easyfontkit could not start ${browser}, as this process has as many files open as it may (too many open files). Raise that limit, as ulimit -n does, and run it again.`;
  refused(root, [[{ PATH: process.env.PATH, CHROME_PATH: browser }, message]], { wrap: ["sh", "-c", 'ulimit -n 256 && exec "$@"', "sh"], node: ["-r", hold] });
});
