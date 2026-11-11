"use strict";

// A browser that cannot be started, in each way it can come about: the run
// stops before any work with the path CHROME_PATH or the search for one
// gave, what is certain about it (what is wrong with the path, the system's
// own reason, or the line the browser printed that says why, quoted, and how
// it ended) and how to point to one that runs, exits with 1, makes no out
// folder and leaves nothing in its temp folder.

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
// work with that message, or one that matches it, exits with 1, and leaves
// no out folder and nothing in its temp folder. A run goes through the
// command `wrap` when there is one, and node is given `node` before the
// script.
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
      const said = run.stderr.replace(/^easyfontkit: /, "").replace(/\n$/, "");
      assert.equal(run.stderr, `easyfontkit: ${said}\n`, what);
      if (typeof message === "string") assert.equal(said, message, what);
      else assert.match(said, message, what);
      if (json) assert.deepEqual(JSON.parse(run.stdout), { ok: false, error: said }, what);
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

// A string as it reads in a pattern.
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The words for a browser that ended before it answered: `lead`, which says
// who it was and ends with "ended before it answered: ", then the line it
// printed, which the pattern `line` matches, and how it ended, which the
// pattern `end` matches, then `more` and the advice.
const quit = (lead, line, end, { fix = POINT, more = "" } = {}) => new RegExp(`^${esc(lead)}it printed "${line}" and ${end}\\.${more ? ` ${esc(more)}` : ""} ${esc(fix)}$`);
// The start of those words for the browser CHROME_PATH names.
const named = (file, name = "chrome") => `${name} did not start: CHROME_PATH is ${file}, which ended before it answered: `;

test("a CHROME_PATH that names no browser the system could start, as a path where nothing is, a folder or a link to one, a link to nothing or round a loop, a path through a file, a name not on PATH, a file without the permission to run it or an empty file, stops the run before any work with that path, what is wrong with it and how to point to one that runs; a script whose interpreter is missing gets the system's own reason with its first line", () => {
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
      [{ PATH, CHROME_PATH: script }, `chrome did not start: CHROME_PATH is ${script}, which could not be started: an interpreter or a loader it needs is not there, and its first line is "#!/nonexistent/interpreter". ${POINT}`],
      // A path from the folder the run was started in.
      [{ PATH, CHROME_PATH: path.join("empty", "chrome") }, `chrome did not start: CHROME_PATH is ${path.join("empty", "chrome")}, an empty file, not a program. ${POINT}`],
      // A name looked up on PATH, as a shell would.
      [{ PATH: `${at("empty")}${path.delimiter}${PATH}`, CHROME_PATH: "chrome" }, `chrome did not start: CHROME_PATH is chrome, found on your PATH at ${empty}, an empty file, not a program. ${POINT}`],
    );
  }
  refused(root, cases);
});

test("a file the system will not run as a program, as a web page saved in the browser's place or a program for macOS, Windows or another processor, which glibc hands to /bin/sh, is named with what came of it, never guessed from what the file holds", { skip: process.platform !== "linux" && "glibc hands such files to /bin/sh on Linux" }, () => {
  const root = path.join(dir, "foreign");
  const { PATH } = process.env;
  const windows = Buffer.concat([Buffer.from("4d5a90000300000004000000ffff0000b8000000000000004000", "hex"), Buffer.alloc(4096)]);
  windows.writeUInt32LE(0x80, 0x3c);
  windows.write("PE\0\0", 0x80, "latin1");
  const files = [
    [put(root, "text", "<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head>\n<body><h1>Not Found</h1></body></html>\n"), ""],
    [put(root, "mac", Buffer.concat([Buffer.from("cffaedfe07000001030000000200000000", "hex"), Buffer.alloc(4096)])), "That file is a program for macOS."],
    [put(root, "windows", windows), "That file is a program for Windows."],
  ];
  if (["x64", "arm64"].includes(process.arch)) {
    // A copy of a program of this system's, for the other processor.
    const elf = Buffer.from(fs.readFileSync(["/usr/bin/true", "/bin/true"].find((file) => fs.existsSync(file))));
    elf.writeUInt16LE(process.arch === "arm64" ? 0x3e : 0xb7, 0x12);
    files.push([put(root, "elf", elf), process.arch === "arm64" ? "That file is a program for x86-64, and the Node.js that runs easyfontkit is one for 64-bit ARM." : "That file is a program for 64-bit ARM, and the Node.js that runs easyfontkit is one for x86-64."]);
  }
  // What the system said of it, or what /bin/sh, given it, printed first,
  // which names the file, and its exit status; or a program of the
  // system's own that took the file, as binfmt_misc gives some, printed.
  // Then what a program for another kind of machine is for, which its first
  // bytes say.
  refused(
    root,
    files.map(([file, fact]) => [{ PATH, CHROME_PATH: file }, new RegExp(`^chrome did not start: CHROME_PATH is ${esc(file)}, which (could not be started: it is not a program this system can run|ended before it answered: it (printed ".+" and exited with \\d+|printed nothing and exited with \\d+|was stopped by SIG[A-Z0-9]+))\\.${fact ? ` ${esc(fact)}` : ""} ${esc(POINT)}$`)]),
  );
});

test("a browser found on PATH that the system could not start is named as the one on PATH, and a folder or a file that may not be run by a browser's name is passed over, as a shell passes over them, and named when no browser follows", { skip: process.platform !== "linux" && "the browser is looked for on PATH on Linux only" }, () => {
  const root = path.join(dir, "found");
  const at = (...names) => path.join(root, ...names);
  const text = put(root, "text", "#!/bin/sh\necho 'not a browser' >&2\nexit 3\n", 0o755, "google-chrome");
  fs.mkdirSync(at("folder", "google-chrome"), { recursive: true });
  put(root, "plain", "#!/bin/sh\n", 0o644, "chromium");
  fs.mkdirSync(at("empty"), { recursive: true });
  const found = `google-chrome did not start: ${text}, the google-chrome on your PATH, ended before it answered: it printed "not a browser" and exited with 3. ${INSTALL}`;
  refused(root, [
    [{ PATH: `${at("text")}:${at("empty")}` }, found],
    // The folder is passed over for the script after it.
    [{ PATH: `${at("folder")}:${at("text")}` }, found],
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

test("a browser the system's loader cannot start, as its loader is missing, gets the system's own reason, and one whose library is missing gets the loader's line that names it, before any work", { skip: process.platform !== "linux" && "the stand-ins are Linux programs" }, (t) => {
  const root = path.join(dir, "unloaded");
  const at = (...names) => path.join(root, ...names);
  const loader = unloadable(at("noloader", "chrome"), "loader");
  const glibc = Boolean(process.report.getReport().header.glibcVersionRuntime);
  const library = glibc && unloadable(at("nolib", "chrome"), "library");
  if (!loader && !library) return t.skip("no 64-bit little-endian program of this system's to make them from");
  const { PATH } = process.env;
  const cases = [];
  if (loader) cases.push([{ PATH, CHROME_PATH: at("noloader", "chrome") }, `chrome did not start: CHROME_PATH is ${at("noloader", "chrome")}, which could not be started: an interpreter or a loader it needs is not there. ${POINT}`]);
  // glibc's loader names a library that is not there and exits with 127.
  if (library) {
    const said = (file) => `${esc(file)}: error while loading shared libraries: ${esc(library)}: cannot open shared object file: No such file or directory`;
    cases.push(
      [{ PATH, CHROME_PATH: at("nolib", "chrome") }, quit(named(at("nolib", "chrome")), said(at("nolib", "chrome")), "exited with 127")],
      [{ PATH: `${at("nolib")}:${PATH}`, CHROME_PATH: "chrome" }, quit(`chrome did not start: CHROME_PATH is chrome, found on your PATH at ${at("nolib", "chrome")}, which ended before it answered: `, said(at("nolib", "chrome")), "exited with 127")],
    );
    // Found on PATH, by a browser's name.
    fs.mkdirSync(at("onpath"), { recursive: true });
    fs.copyFileSync(at("nolib", "chrome"), at("onpath", "chromium"));
    fs.chmodSync(at("onpath", "chromium"), 0o755);
    cases.push([{ PATH: at("onpath") }, quit(`chromium did not start: ${at("onpath", "chromium")}, the chromium on your PATH, ended before it answered: `, said(at("onpath", "chromium")), "exited with 127", { fix: INSTALL })]);
  }
  refused(root, cases);
});

test("a script in the browser's place that could not start what it runs, as a launcher whose browser is missing, a wrapper that runs a saved web page, one whose #!/usr/bin/env line or env line names a program not on PATH, one with Windows line breaks, a launcher that asks for the chromium snap, or one that crashed, stopped or closed its pipe, is named with the first line it printed, quoted, and how it ended, never with a program guessed from its words", { skip: process.platform !== "linux" && "the stand-ins are Linux scripts and programs" }, (t) => {
  // A folder with a short path, whatever TMPDIR is: a shell writes the paths
  // of the script and of what it ran in one line, and the message keeps the
  // first 120 and the last 80 characters of a line longer than 200, which
  // the patterns below would not find whole. Under /tmp where this user may
  // make one, else in the temp folder.
  const short = ["/tmp", os.tmpdir()].reduce((made, base) => {
    if (made) return made;
    try {
      return fs.mkdtempSync(path.join(base, "efk-"));
    } catch {
      return "";
    }
  }, "");
  t.after(() => fs.rmSync(short, { recursive: true, force: true }));
  const root = path.join(short, "scripts");
  const at = (...names) => path.join(root, ...names);
  const { PATH } = process.env;
  const shells = ["/bin/sh", "/bin/bash"].filter((shell) => fs.existsSync(shell));
  const cases = [];
  const by = (file) => [{ PATH, CHROME_PATH: file }];
  // The line names the script or the program it ran, and ends with the
  // system's reason; how the line begins is the shell's own.
  const ran = (file, line, end) => [...by(file), quit(named(file), line, end)];
  const plain = put(root, "plain", "x", 0o644);
  for (const shell of shells) {
    const name = path.basename(shell);
    // exec, as Chrome's own launcher runs the browser, and a line that runs
    // it without exec.
    const gone = put(root, `${name}-gone`, `#!${shell}\nexec ${at("nothing", "chrome")} "$@"\n`);
    cases.push(ran(gone, `${esc(gone)}: .*${esc(at("nothing", "chrome"))}: (not found|No such file or directory)`, "exited with 127"));
    const noexec = put(root, `${name}-gone-noexec`, `#!${shell}\n${at("nothing", "chrome")} "$@"\n`);
    cases.push(ran(noexec, `${esc(noexec)}: .*${esc(at("nothing", "chrome"))}: (not found|No such file or directory)`, "exited with 127"));
    const denied = put(root, `${name}-plain`, `#!${shell}\nexec ${plain} "$@"\n`);
    cases.push(ran(denied, `${esc(denied)}: .*${esc(plain)}: Permission denied`, "exited with 126"));
    const bare = put(root, `${name}-name`, `#!${shell}\nexec chrome-not-there-xyz "$@"\n`);
    cases.push(ran(bare, `${esc(bare)}: .*chrome-not-there-xyz: (not found|No such file or directory)`, "exited with 127"));
  }
  // A launcher that runs a web page saved in the browser's place, which the
  // system gives /bin/sh, whose words name the page.
  const page = put(root, "page", "<!DOCTYPE html>\n<html><body>Not Found</body></html>\n");
  const runsPage = put(root, "sh-page", `#!/bin/sh\nexec ${page} "$@"\n`);
  cases.push(ran(runsPage, `${esc(page)}: .+`, "exited with \\d+"));
  // A launcher that runs a script whose interpreter is missing, under bash,
  // which names both, and under dash.
  const inner = put(root, "inner", "#!/nonexistent/interp\n");
  if (shells.includes("/bin/bash")) {
    const bash = put(root, "bash-badinterp", `#!/bin/bash\nexec ${inner} "$@"\n`);
    cases.push(ran(bash, `${esc(bash)}: .*bad interpreter: No such file or directory`, "exited with 126"));
  }
  const dash = put(root, "sh-badinterp", `#!/bin/sh\nexec ${inner} "$@"\n`);
  cases.push(ran(dash, `${esc(dash)}: .*${esc(inner)}: .+`, "exited with 12[67]"));
  if (fs.existsSync("/usr/bin/env")) {
    // env, as in the common #!/usr/bin/env form, with the name as one word
    // and split by -S, on a line of a wrapper, and on a first line with a
    // Windows line break, whose carriage return env names, written out.
    const word = put(root, "env", "#!/usr/bin/env no-such-browser-xyz\n");
    cases.push(ran(word, "(/usr/bin/)?env: .*no-such-browser-xyz.*: No such file or directory", "exited with 127"));
    const split = put(root, "env-split", "#!/usr/bin/env -S no-such-browser-xyz --flag\n");
    cases.push(ran(split, "(/usr/bin/)?env: .*no-such-browser-xyz.*: No such file or directory", "exited with 127"));
    const line = put(root, "env-line", `#!/bin/sh\nexec env CHROME_WRAPPER=1 ${at("nothing", "chrome")} "$@"\n`);
    cases.push(ran(line, `(/usr/bin/)?env: .*${esc(at("nothing", "chrome"))}.*: No such file or directory`, "exited with 127"));
    if (fs.existsSync("/bin/bash")) {
      const crlf = put(root, "crlf-env", "#!/usr/bin/env bash\r\necho hi\r\n");
      cases.push(ran(crlf, "(/usr/bin/)?env: .*bash\\\\r.*: No such file or directory", "exited with 127"));
    }
  }
  // Ubuntu's chromium-browser where the chromium snap is not installed: its
  // first line with words in it says so.
  const snap = put(root, "snap", `#!/bin/sh\necho "" >&2\necho "Command '$0' requires the chromium snap to be installed." >&2\necho "Please install it with:" >&2\necho "" >&2\necho "snap install chromium" >&2\nexit 1\n`, 0o755, "chromium-browser");
  cases.push([...by(snap), quit(named(snap, "chromium-browser"), esc(`Command '${snap}' requires the chromium snap to be installed.`), "exited with 1")]);
  // Chrome's own launcher on Linux, as a broken install leaves it, with no
  // browser beside it: it runs that browser with exec -a, and bash says
  // which line could not start it.
  const launcher = "/opt/google/chrome/google-chrome";
  if (fs.existsSync(launcher) && fs.readFileSync(launcher, "latin1").startsWith("#!")) {
    fs.mkdirSync(at("google"), { recursive: true });
    fs.copyFileSync(launcher, at("google", "google-chrome"));
    fs.chmodSync(at("google", "google-chrome"), 0o755);
    const beside = path.join(fs.realpathSync(at("google")), "chrome");
    cases.push([...by(at("google", "google-chrome")), quit(named(at("google", "google-chrome"), "google-chrome"), `${esc(at("google", "google-chrome"))}: line \\d+: ${esc(beside)}: No such file or directory`, "exited with 127")]);
  }
  // Found on PATH by a browser's name.
  const onPath = put(root, "onpath", `#!/bin/sh\nexec ${at("nothing", "chrome")} "$@"\n`, 0o755, "chromium");
  cases.push([{ PATH: at("onpath") }, quit(`chromium did not start: ${onPath}, the chromium on your PATH, ended before it answered: `, `${esc(onPath)}: .*${esc(at("nothing", "chrome"))}: (not found|No such file or directory)`, "exited with 127", { fix: INSTALL })]);
  // A script that crashed, one stopped by a signal with nothing printed,
  // one that ended well having started nothing, one that prints only on its
  // output, and a shell that would not take the browser's options.
  if (shells.includes("/bin/bash")) cases.push(ran(put(root, "crash", "#!/bin/bash\nsh -c 'kill -SEGV $$'\nexit 139\n"), `${esc(at("crash", "chrome"))}: line 2: +\\d+ Segmentation fault.*`, "exited with 139"));
  cases.push([...by(put(root, "killed", "#!/bin/sh\nkill -TERM $$\n")), `chrome did not start: CHROME_PATH is ${at("killed", "chrome")}, which ended before it answered: it was stopped by SIGTERM. ${POINT}`]);
  cases.push([...by(put(root, "silent", "#!/bin/sh\nexit 0\n")), `chrome did not start: CHROME_PATH is ${at("silent", "chrome")}, which ended before it answered: it printed nothing and exited with 0. ${POINT}`]);
  cases.push([...by(put(root, "stdout", '#!/bin/sh\necho "only on its output"\nexit 3\n')), `chrome did not start: CHROME_PATH is ${at("stdout", "chrome")}, which ended before it answered: it printed "only on its output" and exited with 3. ${POINT}`]);
  // One that says first what Chrome tells or warns of as it starts, then
  // what is wrong: its words are those quoted.
  cases.push([...by(put(root, "warns", "#!/bin/sh\necho '[1111/052926.234058:WARNING:chrome/app/chrome_main_linux.cc:84] Read channel stable from /opt/google/chrome/CHROME_VERSION_EXTRA' >&2\necho 'the real trouble' >&2\nexit 4\n")), `chrome did not start: CHROME_PATH is ${at("warns", "chrome")}, which ended before it answered: it printed "the real trouble" and exited with 4. ${POINT}`]);
  // One that says first what Chrome's D-Bus code says as it starts with the
  // session bus the run gives it, where nothing listens, then what is
  // wrong: its words are those quoted. One that says nothing else has
  // ended, with no line quoted, as those lines are not why.
  const bus = [
    "[3425813:3426008:1111/084920.176503:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Failed to connect to socket /tmp/easyfontkit-chrome-x/no-bus: No such file or directory",
    "[3425813:3425813:1111/084920.444840:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type: ",
    // As older builds write them, with the file's name alone.
    "[1111/000000.000000:ERROR:bus.cc(399)] Failed to connect to the bus: Could not parse server address: Unknown address type",
    "[1111/000000.000000:ERROR:object_proxy.cc(623)] Failed to call method: org.freedesktop.DBus.NameHasOwner",
    // What libwayland says of the display the run gives the browser when
    // its path is too long for a socket, as in a long temp folder.
    'error: socket path "/home/user/a-long-temp-folder-for-jobs-of-the-hosted-service-of-many-users/easyfontkit-chrome-x/no-display" plus null terminator exceeds 108 bytes',
  ];
  const busLines = bus.map((line) => `echo '${line}' >&2\n`).join("");
  cases.push([...by(put(root, "bus", `#!/bin/sh\n${busLines}echo 'the real trouble' >&2\nexit 4\n`)), `chrome did not start: CHROME_PATH is ${at("bus", "chrome")}, which ended before it answered: it printed "the real trouble" and exited with 4. ${POINT}`]);
  cases.push([...by(put(root, "busonly", `#!/bin/sh\n${busLines}exit 5\n`)), `chrome did not start: CHROME_PATH is ${at("busonly", "chrome")}, which ended before it answered: it exited with 5. ${POINT}`]);
  // One that closes the pipe it is driven through and goes on, which the
  // run then stops.
  cases.push([...by(put(root, "closer", '#!/bin/sh\necho "closing the pipe" >&2\nexec 3<&- 4>&-\nexec sleep 30\n')), `chrome did not start: CHROME_PATH is ${at("closer", "chrome")}, which closed its pipe before it answered, having printed "closing the pipe". ${POINT}`]);
  cases.push([...by("/bin/sh"), quit(named("/bin/sh", "sh"), ".+", "exited with \\d+")]);
  refused(root, cases);
});

test("a script this user may run but not read, which its interpreter has to read, is named with what its interpreter said, before any work", { skip: process.platform === "win32" ? "Windows keeps no such mode" : process.getuid() === 0 ? "root may read any file" : false }, () => {
  const root = path.join(dir, "unreadable");
  const file = put(root, "xonly", '#!/bin/sh\nexec google-chrome "$@"\n', 0o111);
  try {
    refused(root, [[{ PATH: process.env.PATH, CHROME_PATH: file }, quit(named(file), `.*${esc(file)}: Permission denied`, "exited with \\d+")]]);
  } finally {
    fs.chmodSync(file, 0o755);
  }
});

test("a browser that quits at once as its sandbox cannot start, as in a container that keeps it from making namespaces, with a setuid helper that is not set up, or with none on a system that keeps it from making user namespaces, is named with Chrome's own line, and what lets a sandbox start", { skip: process.platform === "win32" && "the stand-ins are shell scripts" }, () => {
  const root = path.join(dir, "sandbox");
  const more = "Its sandbox could not start here: a container has to allow it, as Docker does with --security-opt seccomp=unconfined, and a build copied or unpacked by hand can lack the setup that Google Chrome's own package gives it.";
  // What Chrome 157 says as a user who is not root in a container with
  // Docker's default seccomp, then with a helper that lost its setuid bit,
  // and without a setuid helper where user namespaces are kept from it.
  const said = {
    namespaces: [
      "[1111/052926.234058:WARNING:chrome/app/chrome_main_linux.cc:84] Read channel stable from /opt/google/chrome/CHROME_VERSION_EXTRA",
      "Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted",
      "[436:436:1111/052926.256964:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:242] Zygote process exited prematurely with exit code 82 (setuid sandbox: failed to move to new namespaces)",
      "[1111/052926.266425:ERROR:third_party/crashpad/crashpad/util/file/file_io_posix.cc:145] open /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq: No such file or directory (2)",
    ],
    helper: ["[1:1:1111/000000.000000:FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166] The SUID sandbox helper binary was found, but is not configured correctly. Rather than run without sandboxing I'm aborting now. You need to make sure that /opt/chrome/chrome-sandbox is owned by root and has mode 4755."],
    none: ["[1:1:1111/000000.000000:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:128] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md. Otherwise see https://chromium.googlesource.com/chromium/src/+/main/docs/linux/suid_sandbox_development.md for more information on developing with the (older) SUID sandbox. If you want to live dangerously and need an immediate workaround, you can try using --no-sandbox."],
  };
  const standIn = (folder, lines, name = "chrome") => put(root, folder, `#!/bin/sh\n${lines.map((line) => `echo '${line.replace(/'/g, "'\\''")}' >&2`).join("\n")}\nexit 1\n`, 0o755, name);
  const namespaces = standIn("namespaces", said.namespaces);
  const helper = standIn("helper", said.helper);
  const none = standIn("none", said.none);
  // One that could not make namespaces and has no setuid helper to fall
  // back on, as a build unpacked by hand on a system that keeps it from
  // making user namespaces: another build, with the helper, can start.
  const both = standIn("both", [said.namespaces[1], ...said.none]);
  const found = standIn("found", said.namespaces, "google-chrome");
  // The line that ended it, its FATAL line, without the head of Chrome's
  // log line, cut to its first 120 characters and its last 80 when it is
  // longer than 200.
  const cut = (line) => (line.length > 200 ? `${line.slice(0, 120)}...${line.slice(-80)}` : line);
  const line = (lines) => cut(lines.find((one) => one.includes(":FATAL:")).replace(/^\[[^\]]*\] /, ""));
  const { PATH } = process.env;
  // Where the system keeps even the setuid helper from making namespaces,
  // another browser fails the same way, and the message says so in place of
  // pointing to one; a build that lacks its sandbox's setup is pointed past.
  const notAnother = "Another browser does not help here.";
  refused(root, [
    [{ PATH, CHROME_PATH: namespaces }, `chrome did not start: CHROME_PATH is ${namespaces}, which ended before it answered: it printed "${line(said.namespaces)}" and exited with 1. ${more} ${notAnother}`],
    [{ PATH, CHROME_PATH: helper }, `chrome did not start: CHROME_PATH is ${helper}, which ended before it answered: it printed "${line(said.helper)}" and exited with 1. ${more} ${POINT}`],
    [{ PATH, CHROME_PATH: none }, `chrome did not start: CHROME_PATH is ${none}, which ended before it answered: it printed "${line(said.none)}" and exited with 1. ${more} ${POINT}`],
    [{ PATH, CHROME_PATH: both }, `chrome did not start: CHROME_PATH is ${both}, which ended before it answered: it printed "${line(said.none)}" and exited with 1. ${more} ${POINT}`],
    [{ PATH: `${path.dirname(found)}${path.delimiter}${PATH}` }, `google-chrome did not start: ${found}, the google-chrome on your PATH, ended before it answered: it printed "${line(said.namespaces)}" and exited with 1. ${more} ${notAnother}`],
  ]);
});

test("a run with no file descriptor left to start the browser, or to read its out folder, stops before any work, says what to do and leaves nothing in its temp folder, also with one descriptor left, which the browser's profile is removed with", { skip: process.platform === "win32" && "it takes sh to lower the limit" }, () => {
  const root = path.join(dir, "no-descriptors");
  const browser = put(root, "bin", "#!/bin/sh\nexec google-chrome \"$@\"\n");
  const short = "this process has as many files open as it may (too many open files). Raise that limit, as ulimit -n does, and run it again.";
  // Loaded before the kit: makes node's own signal pipe, then holds every
  // file descriptor it may but three: one for the kit's stderr, one for the
  // files it reads one at a time, and one more, where starting the browser
  // takes six for its pipes.
  const hold = path.join(root, "hold.js");
  fs.writeFileSync(hold, 'process.on("SIGWINCH", () => {});\nconst fs = require("node:fs");\nconst held = [];\ntry {\n  for (;;) held.push(fs.openSync(__filename, "r"));\n} catch {}\nfor (let i = 0; i < 3; i++) fs.closeSync(held.pop());\n');
  refused(root, [[{ PATH: process.env.PATH, CHROME_PATH: browser }, `chrome did not start: easyfontkit could not start ${browser}, as ${short}`]], { wrap: ["sh", "-c", 'ulimit -n 256 && exec "$@"', "sh"], node: ["-r", hold] });
  // The kit run in a process that holds every file descriptor it may but
  // the ones given, once the kit is loaded: with none, the out folder
  // cannot be read; with one, the browser cannot be started, and its
  // profile, which needs one descriptor for each of its folders to be
  // removed in one call, is removed one folder at a time.
  const run = path.join(root, "run.js");
  fs.writeFileSync(
    run,
    `const { makeFontKit } = require(${JSON.stringify(path.resolve(__dirname, "../skills/easyfontkit/scripts/lib/kit"))});
process.on("SIGWINCH", () => {});
const fs = require("node:fs");
const held = [];
try {
  for (;;) held.push(fs.openSync(__filename, "r"));
} catch {}
for (let i = 0; i < Number(process.argv[3]); i++) fs.closeSync(held.pop());
makeFontKit(${JSON.stringify(URL)}, { dir: process.argv[2], timeLimit: 30000 }).then(
  () => process.exit(0),
  (err) => {
    fs.writeSync(2, err.message);
    process.exit(1);
  },
);
`,
  );
  const { CHROME_PATH, TMPDIR, ...rest } = process.env;
  for (const [free, message] of [
    [0, (out) => `easyfontkit could not read ${out}, as ${short}`],
    [1, () => `chrome did not start: easyfontkit could not start ${browser}, as ${short}`],
  ]) {
    const tmp = path.join(root, "tmp-run", String(free));
    const out = path.join(root, "runs-in", String(free), "out");
    fs.mkdirSync(tmp, { recursive: true });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const result = spawnSync("sh", ["-c", 'ulimit -n 256 && exec "$@"', "sh", process.execPath, run, out, String(free)], { encoding: "utf8", env: { ...rest, CHROME_PATH: browser, TMPDIR: tmp }, timeout: 60_000 });
    assert.equal(result.status, 1, `${free}: ${result.stderr}`);
    assert.equal(result.stderr, message(out), `${free} left`);
    assert.deepEqual(fs.readdirSync(path.dirname(out)), [], `${free} left: no out folder`);
    assert.deepEqual(fs.readdirSync(tmp), [], `${free} left: nothing in the temp folder`);
  }
});

test("a temp folder the browser's profile cannot be made in, as one that is not there or a file, stops the run before any work with the system's own reason and what to do", { skip: process.platform === "win32" && "the stand-in browser is a shell script" }, () => {
  const root = path.join(dir, "no-profile");
  const browser = put(root, "bin", "#!/bin/sh\nexec google-chrome \"$@\"\n");
  const file = put(root, "file", "not a folder\n", 0o644, "temp");
  const { CHROME_PATH, TMPDIR, ...rest } = process.env;
  for (const [tmp, reason] of [
    [path.join(root, "not-there"), "no such file or directory"],
    [file, "not a directory"],
  ]) {
    const out = path.join(root, "runs", path.basename(tmp), "out");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const run = spawnSync(process.execPath, [CLI, URL, "--out", out], { encoding: "utf8", env: { ...rest, CHROME_PATH: browser, TMPDIR: tmp }, timeout: 60_000 });
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stderr, `easyfontkit: chrome did not start: easyfontkit could not make the browser's profile in ${tmp} (${reason}). Set TMPDIR to a folder this user may write in, with room to spare.\n`);
    assert.deepEqual(fs.readdirSync(path.dirname(out)), [], "no out folder");
  }
});

test("a browser that ended before it answered, as the system or the browser was short of open files, processes or memory, which Chrome's own words say as errno gives them, is told what to do about that in place of how to get another browser, which would be short of the same", { skip: process.platform === "win32" && "the stand-ins are shell scripts" }, () => {
  const root = path.join(dir, "short");
  // What Chrome 155 printed with ulimit -n 32 and ulimit -u a few above
  // this user's threads, and the same for the system's file table and for
  // memory, each ended as Chrome ended.
  const cases = [
    ["files", "[1:1:1111/000000.000000:FATAL:base/files/scoped_file.cc:43] Check failed: . : Too many open files (24)", "ABRT", "The browser had as many files open as it may (too many open files): raise that limit, as ulimit -n does, and run it again."],
    ["table", "[1:1:1111/000000.000000:FATAL:base/files/scoped_file.cc:43] Check failed: . : Too many open files in system (23)", "ABRT", "The system had as many files open as it may (file table overflow): run it again once fewer are open."],
    ["threads", "[1:9:1111/000000.000000:ERROR:base/threading/platform_thread_posix.cc:147] pthread_create: Resource temporarily unavailable (11)", "TRAP", "The system started no more processes or threads for this user (resource temporarily unavailable): run it again once fewer are running."],
    ["memory", "[1:1:1111/000000.000000:FATAL:base/memory/page_size_posix.cc:24] mmap: Cannot allocate memory (12)", "ABRT", "The system had no memory left for the browser: run it again once more is free."],
    // Its words in another language, with errno's number after them.
    ["number", "[1:1:1111/000000.000000:FATAL:base/files/scoped_file.cc:43] Check failed: . : Zu viele offene Dateien (24)", "ABRT", "The browser had as many files open as it may (too many open files): raise that limit, as ulimit -n does, and run it again."],
  ];
  const { PATH } = process.env;
  refused(
    root,
    cases.map(([folder, said, signal, what]) => {
      // The line that says it can come after the one that ended it.
      const file = put(root, folder, `#!/bin/sh\necho '[1:1:1111/000000.000000:ERROR:chrome/browser/ui/startup.cc:1] first' >&2\necho '${said}' >&2\nkill -${signal} $$\n`);
      return [{ PATH, CHROME_PATH: file }, `chrome did not start: CHROME_PATH is ${file}, which ended before it answered: it printed "${said.includes(":FATAL:") ? said.replace(/^\[[^\]]*\] /, "") : "first"}" and was stopped by SIG${signal}. ${what}`];
    }),
  );
});

test("a browser that ended before it answered, saying something else, is told the limit on open files this process and the browser have when it is low, as Chrome can run short of them and say only what failed for it", { skip: process.platform !== "linux" && "the limits are read from /proc on Linux" }, () => {
  const root = path.join(dir, "low-limit");
  const said = "[1:1:1111/000000.000000:ERROR:components/ukm/ukm_database.cc:1] Failed to open UKM database: 0 unable to open database file";
  const file = put(root, "ukm", `#!/bin/sh\necho '${said}' >&2\nkill -TRAP $$\n`);
  const message = (limit) => `chrome did not start: CHROME_PATH is ${file}, which ended before it answered: it printed "Failed to open UKM database: 0 unable to open database file" and was stopped by SIGTRAP.${limit ? ` This process may have no more than ${limit} files open, which can be too few for the browser: raise that limit, as ulimit -n does, and run it again.` : ""} ${POINT}`;
  refused(root, [[{ PATH: process.env.PATH, CHROME_PATH: file }, message(64)]], { wrap: ["sh", "-c", 'ulimit -n 64 && exec "$@"', "sh"] });
  // With the limit this machine gives, nothing is said of it.
  const hard = /^Max open files\s+\S+\s+(\d+)/m.exec(fs.readFileSync("/proc/self/limits", "utf8"));
  if (hard && Number(hard[1]) >= 1024) refused(path.join(root, "high"), [[{ PATH: process.env.PATH, CHROME_PATH: file }, message(0)]]);
});

test("the limit on processes is the soft one, which the system holds this user to as a process or a thread starts and which nothing raises, so a soft limit alone within 100 of what this user runs is said too, and that limit is named; of open files it is the hard one, to which Node raises this process's own as it starts", { skip: (process.platform !== "linux" && "the limits are read from /proc on Linux") || (process.getuid() === 0 && "the system holds root to no limit on processes") }, () => {
  const { lowLimits } = require("../skills/easyfontkit/scripts/lib/program");
  // A /proc of the test's own: the limits as /proc/self/limits gives them,
  // and two processes of this user with 60 and 40 threads.
  const proc = path.join(dir, "limits-proc");
  const limits = (processes, files) => {
    fs.rmSync(proc, { recursive: true, force: true });
    fs.mkdirSync(path.join(proc, "self"), { recursive: true });
    const row = (name, [soft, hard], units) => `${name.padEnd(26)}${String(soft).padEnd(21)}${String(hard).padEnd(21)}${units}`;
    fs.writeFileSync(path.join(proc, "self", "limits"), `${["Limit                     Soft Limit           Hard Limit           Units     ", row("Max processes", processes, "processes"), row("Max open files", files, "files")].join(" \n")} \n`);
    for (const [pid, threads] of [
      [1001, 60],
      [1002, 40],
    ]) {
      fs.mkdirSync(path.join(proc, String(pid)));
      fs.writeFileSync(path.join(proc, String(pid), "stat"), `${pid} (sh) S${" 0".repeat(16)} ${threads}${" 0".repeat(30)}\n`);
    }
    return lowLimits(proc);
  };
  const processes = (most) => `This user runs 100 processes and threads and may run no more than ${most}, which can be too few for the browser: run it again once fewer are running.`;
  assert.equal(limits([150, 204127], [524288, 524288]), processes(150), "a soft limit alone, as ulimit -Su or a soft nproc line of limits.conf sets");
  assert.equal(limits([150, 150], [524288, 524288]), processes(150), "both, as ulimit -u sets");
  assert.equal(limits([5000, 5000], [524288, 524288]), "", "far from what runs");
  assert.equal(limits(["unlimited", "unlimited"], [524288, 524288]), "", "none");
  assert.equal(limits([5000, 5000], [64, 4096]), "", "a soft limit on files alone, which Node raises");
  assert.equal(limits([5000, 5000], [64, 64]), "This process may have no more than 64 files open, which can be too few for the browser: raise that limit, as ulimit -n does, and run it again.");
});

test("a browser that runs from a snap or a Flatpak is told by its processes once it runs, also when a launcher by another name, as Ubuntu's chromium-browser, started it: one whose program is under /snap/, or whose root is not this process's and holds the .flatpak-info every Flatpak's sandbox has", () => {
  const { ownSandbox } = require("../skills/easyfontkit/scripts/lib/program");
  // A /proc of the test's own: each process with the program it runs and
  // its root.
  const proc = path.join(dir, "proc");
  const sandbox = path.join(dir, "flatpak-root");
  const container = path.join(dir, "container-root");
  fs.mkdirSync(sandbox, { recursive: true });
  fs.mkdirSync(container, { recursive: true });
  fs.writeFileSync(path.join(sandbox, ".flatpak-info"), "[Application]\nname=org.chromium.Chromium\n");
  const process_ = (pid, exe, root) => {
    fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
    if (exe) fs.symlinkSync(exe, path.join(proc, String(pid), "exe"));
    fs.symlinkSync(root, path.join(proc, String(pid), "root"));
  };
  process_("self", "", "/");
  process_(101, "/snap/chromium/3051/usr/lib/chromium-browser/chrome", "/");
  process_(102, "/app/chromium/chrome", sandbox);
  process_(103, "/opt/google/chrome/chrome", "/");
  process_(104, "/opt/google/chrome/chrome", container);
  process_(105, "", sandbox);
  const launcher = "/usr/bin/chromium-browser";
  assert.equal(ownSandbox(launcher, [], proc), false);
  assert.equal(ownSandbox(launcher, [103], proc), false, "a browser of the machine's own");
  assert.equal(ownSandbox(launcher, [104], proc), false, "a root of its own with no .flatpak-info");
  assert.equal(ownSandbox(launcher, [103, 101], proc), true, "the chromium snap");
  assert.equal(ownSandbox(launcher, [102], proc), true, "a Flatpak");
  assert.equal(ownSandbox(launcher, [105], proc), true, "a Flatpak's process whose program cannot be read");
  assert.equal(ownSandbox(launcher, [999], proc), false, "a process that has gone");
  // easyfontkit itself in a Flatpak: a browser with the same root is not
  // one in a sandbox of its own.
  fs.rmSync(path.join(proc, "self", "root"));
  fs.symlinkSync(sandbox, path.join(proc, "self", "root"));
  assert.equal(ownSandbox(launcher, [105], proc), false);
  // By its path, as before.
  assert.equal(ownSandbox("/snap/bin/chromium"), true);
  assert.equal(ownSandbox(path.join(dir, "share", "flatpak", "exports", "bin", "org.chromium.Chromium")), true);
});

test("a browser that stopped answering once it had started, as one short of open files can stop while it opens the page, is told the limit on open files when it is low, in place of the busy machine", { skip: process.platform !== "linux" && "the limits are read from /proc on Linux" }, () => {
  const script = `const { stoppedAnswering } = require(${JSON.stringify(path.resolve(__dirname, "../skills/easyfontkit/scripts/lib/chrome"))}); process.stdout.write(stoppedAnswering("google-chrome", Object.assign(new Error("closed"), { closed: true })).message);`;
  const low = spawnSync("sh", ["-c", 'ulimit -n 160 && exec "$@"', "sh", process.execPath, "-e", script], { encoding: "utf8", timeout: 30_000 });
  assert.equal(low.stdout, "google-chrome stopped answering, so no kit was made. This process may have no more than 160 files open, which can be too few for the browser: raise that limit, as ulimit -n does, and run it again.", low.stderr);
  const hard = /^Max open files\s+\S+\s+(\d+)/m.exec(fs.readFileSync("/proc/self/limits", "utf8"));
  if (hard && Number(hard[1]) >= 1024) {
    const high = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000 });
    assert.equal(high.stdout, "google-chrome stopped answering, so no kit was made. The machine may be busy; try again.", high.stderr);
  }
});
