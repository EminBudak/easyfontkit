"use strict";

// The browser's answers that need no browser: a stand-in for the browser's
// end of the DevTools pipe says what the real one would.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn, spawnSync } = require("node:child_process");
const { launch, killBrowsers, connect, openPage, navigate, HANDLERS } = require("../skills/easyfontkit/scripts/lib/chrome");
const { makeFontKit } = require("../skills/easyfontkit/scripts/lib/kit");
const { setTimeLimit, timeLeft } = require("../skills/easyfontkit/scripts/lib/time");
const { devtools, pipeTo } = require("./devtools");

// The stand-in browser that carries its pipe to the stand-in DevTools end.
const BROWSER = path.join(__dirname, "browser.js");

test("on Linux, Chrome's temp folder is its profile where the socket it makes there fits, and its profile given as \".\", with Chrome started in it, where its own temp folder is too long for the socket, and a CHROME_PATH given from the folder the run was started in is still found; its crash reports go into its profile", { skip: ["darwin", "win32"].includes(process.platform) && "Chrome takes its temp folder from TMPDIR on Linux only" }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-temp-"));
  const saved = { TMPDIR: process.env.TMPDIR, CHROME_PATH: process.env.CHROME_PATH };
  // A browser that writes down the temp folder it was given, its profile,
  // the folder it was started in and where its crash reports go, then
  // quits.
  const seen = path.join(parent, "seen");
  process.env.CHROME_PATH = path.join(parent, "chrome");
  fs.writeFileSync(
    process.env.CHROME_PATH,
    `#!/bin/sh
for arg in "$@"; do case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}";; esac; done
printf '%s\\n%s\\n%s\\n%s\\n' "$TMPDIR" "$profile" "$(pwd -P)" "$BREAKPAD_DUMP_LOCATION" > ${JSON.stringify(seen)}
`,
    { mode: 0o755 },
  );
  // Temp folders given from inside the folder that holds them: one with a
  // short path, one too long for the socket in the profile but not in a
  // folder of Chrome's own there, and one too long for both.
  const cwd = process.cwd();
  fs.mkdirSync(path.join(parent, "t"));
  fs.mkdirSync(path.join(parent, "y".repeat(40)));
  fs.mkdirSync(path.join(parent, "x".repeat(70)));
  try {
    process.chdir(parent);
    for (const [tmp, temp, relative] of [
      ["t", "profile"],
      ["y".repeat(40), "own"],
      ["x".repeat(70), "."],
      // Given from the folder the run was started in, not from the
      // profile Chrome is started in.
      ["x".repeat(70), ".", "./chrome"],
    ]) {
      process.env.TMPDIR = tmp;
      process.env.CHROME_PATH = relative || path.join(parent, "chrome");
      fs.rmSync(seen, { force: true });
      await assert.rejects(launch({ width: 800, height: 600 }), /did not start/);
      const [given, profile, started, dumps] = fs.readFileSync(seen, "utf8").split("\n");
      assert.equal(path.relative(parent, path.dirname(profile)), tmp);
      assert.equal(given, { profile, own: tmp, ".": "." }[temp]);
      assert.equal(started, temp === "." ? path.join(fs.realpathSync(path.dirname(profile)), path.basename(profile)) : fs.realpathSync(parent));
      assert.equal(dumps, path.resolve(parent, profile, "Crash Reports"), "the crash reports, in the throwaway profile");
      assert.equal(fs.existsSync(path.resolve(parent, profile)), false, "the profile is removed");
    }
  } finally {
    process.chdir(cwd);
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("on Linux, the browser's download folder is in its profile: its config folder there names that folder in user-dirs.dirs and links to every other entry of the user's own, which stays as it was when the profile goes", { skip: ["darwin", "win32"].includes(process.platform) && "Chrome reads its download folder from user-dirs.dirs on Linux and the like only" }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-config-"));
  const saved = Object.fromEntries(["CHROME_PATH", "HOME", "XDG_CONFIG_HOME"].map((name) => [name, process.env[name]]));
  // A browser that writes down its config folder, what user-dirs.dirs
  // there says, and where each entry of that folder leads, then quits.
  const seen = path.join(parent, "seen");
  process.env.CHROME_PATH = path.join(parent, "chrome");
  fs.writeFileSync(
    process.env.CHROME_PATH,
    `#!/bin/sh
{ printf '%s\\n' "$XDG_CONFIG_HOME"; cat "$XDG_CONFIG_HOME/user-dirs.dirs"; for entry in "$XDG_CONFIG_HOME"/*; do printf '%s %s\\n' "\${entry##*/}" "$(readlink "$entry")"; done; } > ${JSON.stringify(seen)}
`,
    { mode: 0o755 },
  );
  // The user's own config folder, as ~/.config and as XDG_CONFIG_HOME.
  const config = (folder) => {
    fs.mkdirSync(path.join(folder, "fontconfig"), { recursive: true });
    fs.writeFileSync(path.join(folder, "fontconfig", "fonts.conf"), "<fontconfig/>\n");
    fs.writeFileSync(path.join(folder, "mimeapps.list"), "[Default Applications]\n");
    fs.writeFileSync(path.join(folder, "user-dirs.dirs"), 'XDG_DOWNLOAD_DIR="$HOME/Downloads"\n');
    return fs.readdirSync(folder).sort();
  };
  const home = path.join(parent, "home");
  const own = config(path.join(home, ".config"));
  const elsewhere = path.join(parent, "elsewhere");
  config(elsewhere);
  process.env.HOME = home;
  try {
    for (const [given, folder] of [
      [undefined, path.join(home, ".config")],
      [elsewhere, elsewhere],
    ]) {
      if (given === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = given;
      fs.rmSync(seen, { force: true });
      await assert.rejects(launch({ width: 800, height: 600 }), /did not start/);
      const [at, dirs, ...links] = fs.readFileSync(seen, "utf8").trim().split("\n").map((line) => line.trimEnd());
      const profile = path.dirname(at);
      assert.equal(path.basename(at), "config");
      assert.ok(path.basename(profile).startsWith("easyfontkit-chrome-"), profile);
      assert.equal(dirs, `XDG_DOWNLOAD_DIR="${path.join(profile, "Downloads")}"`);
      assert.deepEqual(links.sort(), [`fontconfig ${path.join(folder, "fontconfig")}`, `mimeapps.list ${path.join(folder, "mimeapps.list")}`, "user-dirs.dirs"]);
      assert.equal(fs.existsSync(profile), false, "the profile is removed");
      assert.deepEqual(fs.readdirSync(folder).sort(), own, "the user's own config folder is as it was");
      assert.equal(fs.readFileSync(path.join(folder, "fontconfig", "fonts.conf"), "utf8"), "<fontconfig/>\n");
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("on Linux, the browser's PATH starts with a folder in its profile of stand-ins for xdg-open, xdg-email, xdg-settings and the browsers xdg-open goes on to, each of which starts nothing and exits with 0, also from a temp folder mounted noexec, and the rest of PATH is as it was", { skip: ["darwin", "win32"].includes(process.platform) && "Chrome hands such addresses to the system on macOS and Windows" }, async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-handlers-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  // A browser that writes down its PATH, where each stand-in leads, and what
  // came of starting each by its name as Chrome does, through PATH, then
  // quits. A program of that name later on PATH writes down that it was
  // started, in place of a real one.
  const seen = path.join(parent, "seen");
  const later = path.join(parent, "later");
  fs.mkdirSync(later);
  for (const name of HANDLERS) fs.writeFileSync(path.join(later, name), `#!/bin/sh\necho "started $0" >> ${JSON.stringify(seen)}\n`, { mode: 0o755 });
  const chrome = path.join(parent, "chrome");
  fs.writeFileSync(
    chrome,
    `#!/bin/sh
{ printf '%s\\n' "$PATH"; for name in ${HANDLERS.join(" ")}; do printf '%s %s ' "$name" "$(readlink "\${PATH%%:*}/$name")"; out=$("$name" mailto:hello@example.com 2>&1); printf '%s [%s]\\n' "$?" "$out"; done; } >> ${JSON.stringify(seen)}
`,
    { mode: 0o755 },
  );
  const ownPath = `${later}${path.delimiter}${process.env.PATH}`;
  const check = async (env, wrap) => {
    fs.rmSync(seen, { force: true });
    // In a process of its own, so a run in a mount namespace can be given a
    // temp folder mounted noexec.
    const script = `const { launch } = require(${JSON.stringify(path.resolve(__dirname, "../skills/easyfontkit/scripts/lib/chrome"))}); launch({ width: 800, height: 600 }).then(() => process.exit(2), (err) => { console.error(err.message); process.exit(/did not start/.test(err.message) ? 0 : 1); });`;
    const command = [...wrap, process.execPath, "-e", script];
    const result = await new Promise((resolve) => {
      const child = spawn(command[0], command.slice(1), { env: { ...process.env, ...env, CHROME_PATH: chrome, PATH: ownPath }, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => resolve({ status, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    const [first, ...lines] = fs.readFileSync(seen, "utf8").trim().split("\n");
    const [folder, ...rest] = first.split(path.delimiter);
    assert.equal(path.basename(folder), "stand-ins");
    assert.ok(path.basename(path.dirname(folder)).startsWith("easyfontkit-chrome-"), folder);
    assert.equal(rest.join(path.delimiter), ownPath, "the rest of PATH is as it was");
    const truth = ["/usr/bin/true", "/bin/true"].find((file) => fs.existsSync(file));
    assert.deepEqual(lines, HANDLERS.map((name) => `${name} ${truth} 0 []`), "each starts nothing and exits with 0");
    return folder;
  };
  const folder = await check({}, []);
  assert.equal(fs.existsSync(folder), false, "the stand-ins go with the profile");
  // A temp folder on a tmpfs mounted noexec, in a mount namespace of the
  // test's own, where this user is root.
  const mount = path.join(parent, "noexec");
  fs.mkdirSync(mount);
  const wrap = ["unshare", "-rm", "sh", "-c", 'mount -t tmpfs -o noexec,size=4m tmpfs "$1" && shift && exec "$@"', "sh", mount];
  const probe = spawnSync(wrap[0], [...wrap.slice(1), "true"], { encoding: "utf8" });
  if (probe.status !== 0) return t.skip(`no mount namespace for this user here: ${(probe.stderr || String(probe.error)).trim()}`);
  await check({ TMPDIR: mount }, wrap);
});

test("on Linux, the browser starts with a session bus where nothing listens, a socket in its profile that is never made, and with no display, no DISPLAY and a Wayland display that is a socket in its profile that is never made, whatever bus and display this process has, so it cannot hand an address to the desktop's portal and a program it starts finds no display", { skip: ["darwin", "win32"].includes(process.platform) && "Chrome asks the system on macOS and Windows" }, async (t) => {
  // A temp folder whose path has a space and a comma in it, which a D-Bus
  // address writes as %20 and %2c.
  const parent = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-bus-")), "te mp,1");
  fs.mkdirSync(parent);
  t.after(() => fs.rmSync(path.dirname(parent), { recursive: true, force: true }));
  // A bus of this process's that a connection would reach, as a desktop's
  // session bus is, and a display: a Wayland one that listens in a runtime
  // folder of the test's own, where a Wayland program looks for one with
  // WAYLAND_DISPLAY unset, and the names of an X one and a Wayland socket.
  const desktop = path.join(path.dirname(parent), "desktop-bus");
  const listening = require("node:net").createServer().listen(desktop);
  await new Promise((resolve) => listening.once("listening", resolve));
  t.after(() => listening.close());
  const runtime = path.join(path.dirname(parent), "run");
  fs.mkdirSync(runtime, { mode: 0o700 });
  const wayland = require("node:net").createServer().listen(path.join(runtime, "wayland-0"));
  await new Promise((resolve) => wayland.once("listening", resolve));
  t.after(() => wayland.close());
  // Where Python can load libwayland-client, the browser asks it for a
  // display, as a program it started would.
  const probe = "import ctypes, ctypes.util; w = ctypes.CDLL(ctypes.util.find_library('wayland-client') or 'libwayland-client.so.0'); w.wl_display_connect.restype = ctypes.c_void_p; w.wl_display_connect.argtypes = [ctypes.c_char_p]; print('display' if w.wl_display_connect(None) else 'none')";
  const client = spawnSync("python3", ["-I", "-c", probe], { encoding: "utf8", env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: "wayland-0" }, timeout: 10_000 });
  const canAsk = client.status === 0 && client.stdout.trim() === "display";
  // A browser that writes down the bus it was given, whether anything is at
  // the path that address names, its displays, whether anything is at its
  // Wayland one, and what a Wayland program it starts finds with no Wayland
  // socket handed to it, then quits.
  const seen = path.join(path.dirname(parent), "seen");
  const chrome = path.join(path.dirname(parent), "chrome");
  fs.writeFileSync(
    chrome,
    `#!/bin/bash
bus=$(printf '%b' "$(printf '%s' "\${DBUS_SESSION_BUS_ADDRESS#unix:path=}" | sed 's/%/\\\\x/g')")
{ printf '%s\\n' "$DBUS_SESSION_BUS_ADDRESS"; [ -e "$bus" ] && echo there || echo nothing; printf '%s|%s|%s\\n' "\${DISPLAY-unset}" "\${WAYLAND_DISPLAY-unset}" "\${WAYLAND_SOCKET-unset}"; [ -e "\${WAYLAND_DISPLAY-}" ] && echo there || echo nothing; ${canAsk ? `env -u WAYLAND_SOCKET python3 -I -c ${JSON.stringify(probe)}` : "echo none"}; } > ${JSON.stringify(seen)}
exit 3
`,
    { mode: 0o755 },
  );
  const names = ["CHROME_PATH", "TMPDIR", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XDG_RUNTIME_DIR"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  Object.assign(process.env, { CHROME_PATH: chrome, TMPDIR: parent, DBUS_SESSION_BUS_ADDRESS: `unix:path=${desktop}`, DISPLAY: ":99", WAYLAND_DISPLAY: "wayland-0", WAYLAND_SOCKET: "99", XDG_RUNTIME_DIR: runtime });
  setTimeLimit(30_000);
  await assert.rejects(launch({ width: 800, height: 600 }), /ended before it answered: it printed nothing and exited with 3\./);
  const [address, there, displays, waylandThere, found] = fs.readFileSync(seen, "utf8").trim().split("\n");
  const profile = /^unix:path=(.+)\/no-bus$/.exec(address);
  assert.ok(profile, address);
  assert.doesNotMatch(address, /[ ,]/, "a space and a comma are written as %xx");
  assert.equal(path.dirname(decodeURIComponent(profile[1])), parent);
  assert.match(path.basename(decodeURIComponent(profile[1])), /^easyfontkit-chrome-/);
  assert.equal(there, "nothing", "the bus the browser was given leads nowhere");
  assert.equal(displays, `unset|${path.join(decodeURIComponent(profile[1]), "no-display")}|unset`, "no X display, a Wayland display in the profile, and no Wayland socket");
  assert.equal(waylandThere, "nothing", "the Wayland display the browser was given leads nowhere");
  if (canAsk) assert.equal(found, "none", "a Wayland program the browser starts finds no display");
  else t.diagnostic("no Python with libwayland-client to ask for a Wayland display");
  assert.deepEqual(fs.readdirSync(parent), [], "the profile went");
});

test("on Linux, a temp folder whose path has a : in it, which parts the folders of PATH, stops the run before the browser starts, with nothing made there and no out folder, as the stand-ins could not come first on the browser's PATH: also a relative TMPDIR, by the whole path it names from a folder whose path has one, and a stand-ins' folder that has one however it came to; a relative TMPDIR in a folder removed before the run started is said to name none", { skip: ["darwin", "win32"].includes(process.platform) && "the stand-ins are for Linux" }, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-colon-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  // A browser that writes down that it was started.
  const started = path.join(parent, "started");
  const chrome = path.join(parent, "chrome");
  fs.writeFileSync(chrome, `#!/bin/sh\necho started >> ${JSON.stringify(started)}\n`, { mode: 0o755 });
  const parts = (what, folder) => `easyfontkit: chrome did not start: ${what}, ${folder}, has a : in it, which parts the folders of PATH, so the stand-ins that keep a site from starting a program of this machine could not come first on the browser's PATH. Set TMPDIR to a folder whose path has none.\n`;
  // Runs the kit from `cwd` with TMPDIR `given`, the temp folder `temp`
  // being where that leads, and node given `node` before the script: it
  // stops with 1 and starts no browser, and nothing is left in the temp
  // folder and no out folder is made. Gives what it printed.
  const refused = (cwd, given, temp, node = []) => {
    fs.mkdirSync(temp, { recursive: true });
    const out = path.join(parent, "out");
    const run = spawnSync(process.execPath, [...node, path.resolve(__dirname, "../skills/easyfontkit/scripts/easyfontkit.js"), "http://127.0.0.1:9/", "--out", out], { cwd, encoding: "utf8", env: { ...process.env, CHROME_PATH: chrome, TMPDIR: given }, timeout: 60_000 });
    assert.equal(run.status, 1, run.stderr);
    assert.equal(fs.existsSync(started), false, "the browser was not started");
    assert.deepEqual(fs.readdirSync(temp), [], "nothing was left in the temp folder");
    assert.equal(fs.existsSync(out), false, "no out folder");
    return run.stderr;
  };
  const temp = path.join(parent, "job:1");
  assert.equal(refused(parent, temp, temp), parts("the temp folder's path", temp));
  // A relative TMPDIR is the folder of that name in the one the run was
  // started in, whose path has the :, and so has the stand-ins' folder in
  // it: it is named by that whole path.
  const work = path.join(parent, "work:2");
  assert.equal(refused(work, "tmp", path.join(work, "tmp")), parts("the temp folder's path", path.join(work, "tmp")));
  // A profile whose own name has one, which no run makes today: the
  // stand-ins' folder in it is refused as it goes on PATH, named by its
  // path, and the profile goes.
  const plain = path.join(parent, "plain");
  const preload = path.join(parent, "colon-profile.js");
  fs.writeFileSync(preload, 'const fs = require("node:fs");\nconst made = fs.mkdtempSync;\nfs.mkdtempSync = (prefix, ...rest) => {\n  const dir = made(prefix, ...rest);\n  if (!String(prefix).includes("easyfontkit-chrome-")) return dir;\n  fs.renameSync(dir, `${dir}:x`);\n  return `${dir}:x`;\n};\n');
  const said = refused(plain, plain, plain, ["-r", preload]);
  const folder = /the path of the stand-ins' folder, (.+), has a : in it/.exec(said);
  assert.ok(folder, said);
  assert.match(folder[1], new RegExp(`^${plain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/easyfontkit-chrome-\\w+:x/stand-ins$`));
  assert.equal(said, parts("the path of the stand-ins' folder", folder[1]));
  // A relative TMPDIR in a folder that was removed before the run started,
  // as by another shell, names no folder: the run says so, where it ended
  // with Node's own words.
  const gone = path.join(parent, "gone");
  fs.mkdirSync(gone);
  const out = path.join(parent, "out");
  const run = spawnSync("/bin/sh", ["-c", 'cd "$1" && rmdir "$1" && shift && exec "$@"', "sh", gone, process.execPath, path.resolve(__dirname, "../skills/easyfontkit/scripts/easyfontkit.js"), "http://127.0.0.1:9/", "--out", out], { encoding: "utf8", env: { ...process.env, CHROME_PATH: chrome, TMPDIR: "tmp" }, timeout: 60_000 });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr, "easyfontkit: chrome did not start: easyfontkit could not make the browser's profile in tmp, as the folder the run was started in is gone. Set TMPDIR to the full path of a folder this user may write in, with room to spare.\n");
  assert.equal(fs.existsSync(started), false, "the browser was not started");
  assert.equal(fs.existsSync(out), false, "no out folder");
});

test("on Linux, a temp folder on a disk that takes no links, as a FAT or exFAT disk, stops the run before the browser starts and says the stand-ins need one that does, with nothing left there", { skip: ["darwin", "win32"].includes(process.platform) && "the stand-ins are for Linux" }, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-nolinks-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const temp = path.join(parent, "tmp");
  fs.mkdirSync(temp);
  // Loaded before the kit: the disk refuses every link, as such a disk does,
  // with the system's EPERM.
  const preload = path.join(parent, "nolinks.js");
  fs.writeFileSync(preload, 'const fs = require("node:fs");\nfs.symlinkSync = (target, at) => {\n  throw Object.assign(new Error(`EPERM: operation not permitted, symlink \'${target}\' -> \'${at}\'`), { code: "EPERM", errno: -1, syscall: "symlink" });\n};\n');
  const started = path.join(parent, "started");
  const chrome = path.join(parent, "chrome");
  fs.writeFileSync(chrome, `#!/bin/sh\necho started >> ${JSON.stringify(started)}\n`, { mode: 0o755 });
  const out = path.join(parent, "out");
  const run = spawnSync(process.execPath, ["-r", preload, path.resolve(__dirname, "../skills/easyfontkit/scripts/easyfontkit.js"), "http://127.0.0.1:9/", "--out", out], { encoding: "utf8", env: { ...process.env, CHROME_PATH: chrome, TMPDIR: temp }, timeout: 60_000 });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr, `easyfontkit: chrome did not start: the stand-ins that keep a site from starting a program of this machine are links, and the disk of the temp folder ${temp} takes none (operation not permitted). Set TMPDIR to a folder on a disk that takes links.\n`);
  assert.equal(fs.existsSync(started), false, "the browser was not started");
  assert.deepEqual(fs.readdirSync(temp), [], "nothing was left in the temp folder");
  assert.equal(fs.existsSync(out), false, "no out folder");
});

test("Chrome's component updater is sent to a closed port, so it downloads nothing during a run", { skip: process.platform === "win32" && "the stand-in browser is a shell script" }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-args-"));
  const saved = process.env.CHROME_PATH;
  // A browser that writes down what it was started with, then quits.
  const seen = path.join(parent, "seen");
  process.env.CHROME_PATH = path.join(parent, "chrome");
  fs.writeFileSync(process.env.CHROME_PATH, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(seen)}\n`, { mode: 0o755 });
  try {
    await assert.rejects(launch({ width: 800, height: 600 }), /did not start/);
    assert.ok(fs.readFileSync(seen, "utf8").split("\n").includes("--component-updater=url-source=http://127.0.0.1:9/"));
  } finally {
    if (saved === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = saved;
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("the browser is driven over a pipe on its file descriptors 3 and 4, and is started with no DevTools port", { skip: process.platform === "win32" && "the stand-in browser is a shell script" }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-pipe-"));
  const saved = process.env.CHROME_PATH;
  // A browser that writes down what it was started with and which of its
  // file descriptors 3 and 4 are open, then quits.
  const seen = path.join(parent, "seen");
  process.env.CHROME_PATH = path.join(parent, "chrome");
  fs.writeFileSync(
    process.env.CHROME_PATH,
    `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(seen)}
for fd in 3 4; do if { : >&$fd; } 2>/dev/null; then echo "open $fd" >> ${JSON.stringify(seen)}; fi; done
`,
    { mode: 0o755 },
  );
  try {
    await assert.rejects(launch({ width: 800, height: 600 }), /did not start/);
    const lines = fs.readFileSync(seen, "utf8").split("\n");
    assert.ok(lines.includes("--remote-debugging-pipe"), lines.join(" "));
    assert.deepEqual(lines.filter((line) => line.startsWith("--remote-debugging-port") || line.startsWith("--remote-debugging-address")), []);
    assert.ok(lines.includes("open 3") && lines.includes("open 4"), lines.join(" "));
  } finally {
    if (saved === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = saved;
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a page whose server does not answer gets the run's time less a minute, and a message with its address", async () => {
  for (const [limit, seconds] of [
    [120_000, 60],
    [300_000, 240],
    // Never less than 30 s, and never more than the run has left.
    [75_000, 30],
    [30_000, 30],
  ]) {
    setTimeLimit(limit);
    let given = 0;
    const cdp = {
      on() {},
      send(method, params, timeoutMs) {
        given = timeoutMs;
        return Promise.reject(Object.assign(new Error(`${method} timed out`), { timedOut: true }));
      },
    };
    await assert.rejects(navigate(cdp, "https://acme.example/"), {
      message: `Could not open https://acme.example/: no answer in ${seconds} s. The site may be down or slow; try again later, or give it more time with --timeout.`,
      noAnswer: seconds,
    });
    assert.ok(Math.abs(given - seconds * 1000) < 1_000, `${given} ms for a ${limit} ms run`);
  }
  setTimeLimit(120_000);
});

const busy = (name, what, seconds) => `${name} did not ${what} in ${seconds} s, so no kit was made. The machine may be busy; try again, or give it more time with --timeout.`;
// The message of a wait given a run with three seconds left, which on a
// busy machine can be two by the time the wait begins.
const inThreeSeconds = (what) => (err) => [3, 2].some((seconds) => err.message === busy("chrome", what, seconds)) || assert.fail(err.message);
const SCREEN = { width: 800, height: 600 };

test("a browser gets the run's time less a minute to open its page, as the page's server gets to answer, and one that does not is named in a plain message", async () => {
  // A browser that never answers, told without waiting for it.
  const given = [];
  const pipe = {
    send(method, params, timeoutMs) {
      given.push(timeoutMs);
      return Promise.reject(Object.assign(new Error(`${method} timed out`), { timedOut: true }));
    },
  };
  try {
    for (const [limit, seconds] of [
      [120_000, 60],
      [300_000, 240],
      [75_000, 30],
      [30_000, 30],
    ]) {
      setTimeLimit(limit);
      await assert.rejects(openPage({ pipe, name: "chrome" }, SCREEN), { message: busy("chrome", "open a page", seconds) });
      assert.ok(Math.abs(given.at(-1) - seconds * 1000) < 1_000, `${given.at(-1)} ms for a ${limit} ms run`);
    }
  } finally {
    setTimeLimit(120_000);
  }
});

// The stand-in browser's end of a pipe, and the run's end of it.
async function standInPipe(t, calls) {
  const endpoint = await devtools({ calls });
  const socket = await pipeTo(endpoint);
  const pipe = connect(socket, socket);
  t.after(() => {
    pipe.close();
    endpoint.close();
  });
  return { endpoint, pipe, sent: () => endpoint.received.map(({ to, method }) => `${to} ${method}`) };
}

test("a browser slow to open its page gets it opened, and one that does not open it, or does not answer on it, in the time it has is named in a plain message", async (t) => {
  t.after(() => setTimeLimit(120_000));
  // More than the ten seconds a tab had in 0.1.2.
  setTimeLimit(60_000);
  const late = await standInPipe(t, { "Target.createTarget": () => new Promise((resolve) => setTimeout(() => resolve({ targetId: "1" }), 10_500)) });
  const started = Date.now();
  const cdp = await openPage({ pipe: late.pipe, name: "chrome" }, SCREEN);
  assert.ok(Date.now() - started >= 10_000, `opened after ${Date.now() - started} ms`);
  assert.deepEqual(late.sent(), ["browser Target.createTarget", "browser Target.attachToTarget", "tab Page.enable", "tab Inspector.enable", "tab Page.addScriptToEvaluateOnNewDocument", "tab Target.setAutoAttach", "tab Emulation.setDeviceMetricsOverride", "browser Browser.getVersion"]);
  cdp.close();
  // The tab that is not made, the session that is not given for it, and
  // its first call that gets no answer, with three seconds left.
  for (const calls of [{ "Target.createTarget": "hold" }, { "Target.attachToTarget": "hold" }, { "Page.enable": "hold" }]) {
    const { pipe } = await standInPipe(t, calls);
    const begun = Date.now();
    setTimeLimit(3_000);
    await assert.rejects(openPage({ pipe, name: "chrome" }, SCREEN), inThreeSeconds("open a page"), JSON.stringify(calls));
    assert.ok(Date.now() - begun < 15_000, `${JSON.stringify(calls)}: ${Date.now() - begun} ms`);
  }
});


// A process that has ended, or that is a zombie waiting for its parent.
const ended = (pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return /^[ZX]/.test(stat.slice(stat.lastIndexOf(")") + 2));
  } catch {
    return true;
  }
};
const waitFor = async (pid) => {
  for (let waited = 0; waited < 2_000 && !ended(pid); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  return ended(pid);
};

// Stands in for Chrome with a helper that writes into the profile until it
// is killed, as Chrome's network service does on its way out. The browser
// answers on its pipe at once; its helper does not hold the pipe, as
// Chrome's do not.
const WITH_HELPER = `#!/bin/sh
for arg in "$@"; do
  case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}" ;; esac
done
"$NODE_BIN" -e 'const fs = require("fs"); setInterval(() => { try { fs.mkdirSync(process.argv[1] + "/Default", { recursive: true }); fs.writeFileSync(process.argv[1] + "/Default/state", "x"); } catch {} }, 20)' "$profile" 3>&- 4>&- &
echo $! > "$HELPER_PID"
exec "$NODE_BIN" "$BROWSER_JS" answer
`;

test("a browser that is closed or stopped takes its helpers with it, and its profile stays gone", { skip: process.platform !== "linux" && "a browser's processes are told on Linux only" }, async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-helpers-"));
  const temp = path.join(parent, "temp");
  fs.mkdirSync(temp);
  const names = ["CHROME_PATH", "TMPDIR", "HELPER_PID", "NODE_BIN", "BROWSER_JS"];
  const env = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const started = [];
  t.after(() => {
    for (const pid of started) if (!ended(pid)) process.kill(pid, "SIGKILL");
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const chrome = path.join(parent, "chrome");
  fs.writeFileSync(chrome, WITH_HELPER, { mode: 0o755 });
  Object.assign(process.env, { CHROME_PATH: chrome, TMPDIR: temp, HELPER_PID: path.join(parent, "helper.pid"), NODE_BIN: process.execPath, BROWSER_JS: BROWSER });
  for (const end of ["closed", "stopped"]) {
    const browser = await launch({ width: 800, height: 600 });
    const helper = Number(fs.readFileSync(process.env.HELPER_PID, "utf8"));
    started.push(helper);
    if (end === "closed") await browser.close();
    else killBrowsers();
    assert.ok(await waitFor(helper), `the helper of a browser ${end}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(fs.readdirSync(temp), [], `a browser ${end}`);
  }
});

// Stands in for Chrome and the crash handler it starts apart from itself:
// the handler is no child of the browser's, and a helper names it as
// Chrome's helpers do, in a command line rewritten with its arguments apart
// by spaces. A handler already running can be named instead of a new one.
// The browser answers on its pipe at once, and neither of the others holds
// the pipe, as Chrome's helpers and handler do not.
const WITH_CRASH_HANDLER = `#!/bin/sh
for arg in "$@"; do
  case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}" ;; esac
done
if [ -z "$HANDLER_GIVEN" ]; then
  ( "$HANDLER_BIN" -e 'setTimeout(() => {}, 30000)' 3>&- 4>&- & echo $! > "$HANDLER_PID" )
else
  echo "$HANDLER_GIVEN" > "$HANDLER_PID"
fi
"$NODE_BIN" -e 'process.title = process.argv.join(" "); require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 30000)' -- "$profile/helper.pid" "--crashpad-handler-pid=$(cat "$HANDLER_PID")" "--user-data-dir=$profile" 3>&- 4>&- &
while [ ! -s "$profile/helper.pid" ]; do sleep 0.01; done
exec "$NODE_BIN" "$BROWSER_JS" answer
`;

test("a browser's crash handler goes with it, also once its helpers have ended, and no other process it names does", { skip: process.platform !== "linux" && "a browser's processes are told on Linux only" }, async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-handler-"));
  const temp = path.join(parent, "temp");
  fs.mkdirSync(temp);
  const names = ["CHROME_PATH", "TMPDIR", "NODE_BIN", "BROWSER_JS", "HANDLER_BIN", "HANDLER_PID", "HANDLER_GIVEN"];
  const env = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const started = [];
  t.after(() => {
    for (const pid of started) if (!ended(pid)) process.kill(pid, "SIGKILL");
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const chrome = path.join(parent, "chrome");
  fs.writeFileSync(chrome, WITH_CRASH_HANDLER, { mode: 0o755 });
  const handlerBin = path.join(parent, "chrome_crashpad_handler");
  fs.symlinkSync(process.execPath, handlerBin);
  fs.symlinkSync(process.execPath, path.join(parent, "something_else"));
  Object.assign(process.env, { CHROME_PATH: chrome, TMPDIR: temp, NODE_BIN: process.execPath, BROWSER_JS: BROWSER, HANDLER_PID: path.join(parent, "handler.pid") });
  const helperOf = () => {
    const profile = fs.readdirSync(temp).find((name) => name.startsWith("easyfontkit-chrome-"));
    return Number(fs.readFileSync(path.join(temp, profile, "helper.pid"), "utf8"));
  };
  // A browser asked to quit, one stopped, and one stopped once its helpers
  // have ended, as a crash or Ctrl-\ can end them: its handler is the one it
  // started.
  for (const end of ["closed", "stopped", "stopped after its helpers"]) {
    process.env.HANDLER_BIN = handlerBin;
    delete process.env.HANDLER_GIVEN;
    const browser = await launch({ width: 800, height: 600 });
    const handler = Number(fs.readFileSync(process.env.HANDLER_PID, "utf8"));
    const helper = helperOf();
    started.push(handler, helper);
    assert.equal(ended(handler), false);
    if (end === "closed") await browser.close();
    else {
      if (end !== "stopped") {
        process.kill(helper, "SIGKILL");
        assert.ok(await waitFor(helper));
      }
      killBrowsers();
    }
    assert.ok(await waitFor(handler), `the crash handler of a browser ${end}`);
  }
  // A process that is no crash handler, or one that ran before the browser,
  // as the user's own browser's handler does, is not the browser's to end.
  const before = spawn(handlerBin, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  started.push(before.pid);
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const [bin, given] of [
    [path.join(parent, "something_else"), ""],
    [handlerBin, String(before.pid)],
  ]) {
    process.env.HANDLER_BIN = bin;
    if (given) process.env.HANDLER_GIVEN = given;
    await launch({ width: 800, height: 600 });
    const named = Number(fs.readFileSync(process.env.HANDLER_PID, "utf8"));
    started.push(named, helperOf());
    killBrowsers();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(ended(named), false, given ? "a handler that ran before the browser" : "a process that is no crash handler");
  }
});

// Stands in for Chrome: carries its pipe to the stand-in DevTools end at
// DEVTOOLS_PORT, unless SILENT is set, when it never answers on it and stays
// until it is killed, as a browser that is slow to answer does.
const STAND_IN = `#!/bin/sh
echo $$ > "$STANDIN_PID"
[ -z "$SILENT" ] && exec "$NODE_BIN" "$BROWSER_JS"
exec sleep 60
`;

// A test's own temp folder and stand-in browser, with the environment put
// back and anything left of the browser killed once the test has ended.
function standIn(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-busy-"));
  const temp = path.join(parent, "temp");
  fs.mkdirSync(temp);
  const names = ["CHROME_PATH", "TMPDIR", "STANDIN_PID", "DEVTOOLS_PORT", "SILENT", "NODE_BIN", "BROWSER_JS"];
  const env = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const endpoints = [];
  const pidFile = path.join(parent, "browser.pid");
  const pid = () => Number(fs.readFileSync(pidFile, "utf8"));
  t.after(() => {
    for (const endpoint of endpoints) endpoint.close();
    try {
      process.kill(pid(), "SIGKILL");
    } catch {
      // Ended already, or never started.
    }
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    setTimeLimit(120_000);
    fs.rmSync(parent, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(parent, "chrome"), STAND_IN, { mode: 0o755 });
  Object.assign(process.env, { CHROME_PATH: path.join(parent, "chrome"), TMPDIR: temp, STANDIN_PID: pidFile, NODE_BIN: process.execPath, BROWSER_JS: BROWSER });
  // A browser asked to quit quits.
  const serve = async (options) => {
    const endpoint = await devtools({ ...options, onClose: () => process.kill(pid(), "SIGKILL") });
    endpoints.push(endpoint);
    process.env.DEVTOOLS_PORT = String(endpoint.port);
    return endpoint;
  };
  return { parent, temp, pid, serve };
}

// What a run said to the stand-in, to the browser or to a tab, before it let
// go of its tab and closed the browser.
const asked = (endpoint) =>
  endpoint.received.map(({ to, method }) => `${to} ${method}`).filter((call) => call !== "browser Target.detachFromTarget" && call !== "browser Browser.close");

test("a browser slow to start gets the run's time less a minute, and is told to refuse downloads before a run goes on in it; one that does not start, or does not answer as it starts, in that time is named in a plain message, ended, and its profile removed", { skip: process.platform === "win32" && "the stand-in browser is a shell script" }, async (t) => {
  const { temp, pid, serve } = standIn(t);
  // The download refusal, the first thing said on the pipe, answered after
  // three seconds, where 0.1.2 gave up after two and went on without it.
  setTimeLimit(60_000);
  const slow = await serve({ calls: { "Browser.setDownloadBehavior": (times) => (times ? {} : 3_000) } });
  const browser = await launch(SCREEN);
  assert.equal(browser.name, "chrome");
  assert.deepEqual(slow.received, [{ to: "browser", method: "Browser.setDownloadBehavior" }]);
  await browser.close();
  assert.ok(ended(pid()), "the browser asked to quit");
  assert.deepEqual(slow.received.map(({ method }) => method), ["Browser.setDownloadBehavior", "Browser.close"]);
  assert.deepEqual(fs.readdirSync(temp), []);
  // A browser that never answers on its pipe, and one that does not answer
  // the download refusal, with three seconds left.
  for (const [what, options] of [
    ["no answer", null],
    ["the download refusal", { calls: { "Browser.setDownloadBehavior": "hold" } }],
  ]) {
    if (options) {
      delete process.env.SILENT;
      await serve(options);
    } else process.env.SILENT = "1";
    const begun = Date.now();
    setTimeLimit(3_000);
    await assert.rejects(launch(SCREEN), inThreeSeconds("start"), what);
    assert.ok(Date.now() - begun < 20_000, `${what}: ${Date.now() - begun} ms`);
    assert.ok(await waitFor(pid()), `${what}: the browser is ended`);
    assert.deepEqual(fs.readdirSync(temp), [], `${what}: no profile is left`);
  }
});

test("a browser that quits as it starts is told apart from one that is slow, as in 0.1.2", { skip: process.platform === "win32" && "the stand-in browser is a shell script" }, async (t) => {
  const { parent } = standIn(t);
  fs.writeFileSync(process.env.CHROME_PATH, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  setTimeLimit(3_000);
  await assert.rejects(launch(SCREEN), { message: `chrome did not start: CHROME_PATH is ${process.env.CHROME_PATH}, which ended before it answered: it printed nothing and exited with 1. Point CHROME_PATH at the program of a Chrome, Chromium, Edge or Brave that runs, or unset it and install one.` });
  assert.deepEqual(fs.readdirSync(path.join(parent, "temp")), []);
});

test("a browser that answers that it cannot be told to refuse downloads is not used, as a site could save files through it, and is ended with its profile removed", { skip: process.platform === "win32" && "the stand-in browser is a shell script" }, async (t) => {
  const { temp, pid, serve } = standIn(t);
  setTimeLimit(60_000);
  const endpoint = await serve({ calls: { "Browser.setDownloadBehavior": new Error("Browser.setDownloadBehavior is not supported") } });
  await assert.rejects(launch(SCREEN), {
    message: "chrome cannot be told to refuse the downloads a page starts (Browser.setDownloadBehavior is not supported), so no kit was made: a site could save files on this machine through it. Point CHROME_PATH at another browser.",
  });
  assert.deepEqual(endpoint.received.map(({ method }) => method), ["Browser.setDownloadBehavior", "Browser.close"]);
  assert.ok(await waitFor(pid()), "the browser is ended");
  assert.deepEqual(fs.readdirSync(temp), []);
});

test("a browser that stops answering once it has started, or quits, ends the run with a plain message, and the earlier kit stays", { skip: process.platform === "win32" && "the stand-in browser is a shell script" }, async (t) => {
  const { parent, temp, pid, serve } = standIn(t);
  const dir = path.join(parent, "kit");
  fs.mkdirSync(dir);
  const kit = { "fonts.json": JSON.stringify({ version: 1, generator: "easyfontkit 0.1.2", url: "https://acme.example/", families: [] }), "FONTS.md": "# Fonts of acme.example\n", "fonts.css": ":root {}\n" };
  for (const [name, text] of Object.entries(kit)) fs.writeFileSync(path.join(dir, name), text);
  const stopped = "chrome stopped answering, so no kit was made. The machine may be busy; try again.";
  // The calls that start the browser and open its tab, and those after
  // them.
  const opening = ["browser Browser.setDownloadBehavior", "browser Target.createTarget", "browser Target.attachToTarget", "tab Page.enable", "tab Inspector.enable", "tab Page.addScriptToEvaluateOnNewDocument", "tab Target.setAutoAttach", "tab Emulation.setDeviceMetricsOverride", "browser Browser.getVersion"];
  for (const [what, options, timeLimit, calls, message] of [
    // A call that gets no answer until the run's time is out, and the
    // browser itself, asked then.
    ["a call", { calls: { "Network.enable": "hold" } }, 4_000, [...opening, "tab Network.enable", "browser Browser.getVersion"], "chrome did not answer before the run's time ran out, so no kit was made. The machine may be busy; try again, or give it more time with --timeout."],
    // A browser that drops its pipe before the page is asked for or as it
    // is, or as it is asked for a tab, as one that has quit.
    ["the pipe", { calls: { "Network.enable": "close" } }, 60_000, [...opening, "tab Network.enable"], stopped],
    ["the first navigation", { calls: { "Page.getFrameTree": { frameTree: { frame: { id: "1" } } }, "Page.navigate": "close" } }, 60_000, [...opening, "tab Network.enable", "tab DOM.enable", "tab CSS.enable", "tab Page.getFrameTree", "tab Page.navigate"], stopped],
    ["the tab", { calls: { "Target.createTarget": "close" } }, 60_000, opening.slice(0, 2), stopped],
  ]) {
    const endpoint = await serve(options);
    await assert.rejects(makeFontKit("https://acme.example/", { dir, timeLimit }), { message }, what);
    assert.deepEqual(asked(endpoint), calls, `${what}: the calls`);
    assert.ok(await waitFor(pid()), `${what}: the browser is ended`);
    assert.deepEqual(fs.readdirSync(temp), [], `${what}: no profile is left`);
    assert.deepEqual(Object.fromEntries(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")])), kit, `${what}: the earlier kit is as it was`);
  }
});

// A browser held still, as a busy machine can hold it, until it is asked
// whether it still answers and three seconds have gone by. It then answers
// that question, and a moment later each call it was sent while it was
// held, as Chrome does once it goes on: by then the call has been given its
// wait again. Answered together with the question, the call's answer would
// be taken while the browser is asked, and that second wait never tried.
function heldStill() {
  let goOn;
  const wentOn = new Promise((resolve) => (goOn = resolve));
  return {
    // A call sent while it is held, answered with this once it goes on.
    until: (result) => wentOn.then(() => result),
    // The question, answered three seconds after it is asked, and the calls
    // held a fifth of a second after that.
    asked: () =>
      new Promise((resolve) =>
        setTimeout(() => {
          resolve({});
          setTimeout(goOn, 200);
        }, 3_000),
      ),
  };
}

test("a call to a tab that gets no answer is put down to the browser only when the browser itself, asked at once on the pipe, does not answer either in ten seconds, or in what is left of the run's time when that is less, and every call then fails at once; a browser that takes more than two seconds to answer was held still, and the call it was sent gets its wait again and is not sent twice", async (t) => {
  t.after(() => setTimeLimit(120_000));
  setTimeLimit(60_000);
  // A tab's session on a pipe to a stand-in browser.
  const open = async (calls) => {
    const { pipe, endpoint } = await standInPipe(t, calls);
    return { pipe, cdp: pipe.session("S1"), sent: () => endpoint.received.map(({ method }) => method) };
  };
  // A server or a page that does not answer, in a browser that does: the
  // call says so, and the next one goes through.
  const answering = await open({ "Page.navigate": "hold" });
  await assert.rejects(answering.cdp.send("Page.navigate", { url: "https://acme.example/" }, 1_000), { message: "Page.navigate timed out", timedOut: true });
  assert.equal(answering.cdp.lost, null);
  assert.deepEqual(await answering.cdp.send("Page.enable"), {});
  assert.deepEqual(answering.sent(), ["Page.navigate", "Browser.getVersion", "Page.enable"]);
  // A browser held still for longer than the calls waited. Two calls that
  // ran out together share one question, and each gets its wait again and,
  // in it, the answer the browser gives it once it goes on, sent only once.
  // A call still unanswered after its second wait fails as before when the
  // browser answers again, and with what says the browser stopped when it
  // does not. An answer that comes while the browser is asked is taken.
  const busy = heldStill();
  const navigated = { frameId: "1", loaderId: "2" };
  const evaluated = { result: { type: "number", value: 1 } };
  const held = await open({ "Page.navigate": () => busy.until(navigated), "Runtime.evaluate": () => busy.until(evaluated), "Browser.getVersion": busy.asked });
  const twice = await open({ "Page.navigate": "hold", "Browser.getVersion": 3_000 });
  const stops = await open({ "Page.navigate": "hold", "Browser.getVersion": (times) => (times ? "hold" : 3_000) });
  const slow = await open({ "Page.navigate": 2_500, "Browser.getVersion": 3_000 });
  const url = { url: "https://acme.example/" };
  const [evaluation, navigation, failed, gone, meanwhile] = await Promise.all([
    held.cdp.send("Runtime.evaluate", {}, 2_000),
    held.cdp.send("Page.navigate", url, 2_000),
    twice.cdp.send("Page.navigate", url, 1_000).catch((err) => err),
    stops.cdp.send("Page.navigate", url, 1_000).catch((err) => err),
    slow.cdp.send("Page.navigate", url, 1_000),
  ]);
  assert.deepEqual(evaluation, evaluated);
  assert.deepEqual(navigation, navigated);
  assert.equal(held.cdp.lost, null);
  assert.deepEqual(held.sent(), ["Runtime.evaluate", "Page.navigate", "Browser.getVersion"]);
  assert.deepEqual(meanwhile, {});
  assert.deepEqual(slow.sent(), ["Page.navigate", "Browser.getVersion"]);
  assert.equal(failed.message, "Page.navigate timed out");
  assert.equal(failed.timedOut, true);
  assert.equal(twice.cdp.lost, null);
  assert.deepEqual(await twice.cdp.send("Page.enable"), {});
  assert.deepEqual(twice.sent(), ["Page.navigate", "Browser.getVersion", "Browser.getVersion", "Page.enable"]);
  assert.equal(gone.timedOut, true);
  assert.equal(stops.cdp.lost, gone);
  assert.deepEqual(stops.sent(), ["Page.navigate", "Browser.getVersion", "Browser.getVersion"]);
  // A browser that does not answer either: the call, and one that waits
  // with it, fail with what says so once the browser has had its ten
  // seconds, and a call after them fails at once and is not sent.
  const silent = await open({ "Page.navigate": "hold", "Runtime.evaluate": "hold", "Browser.getVersion": "hold" });
  const waiting = silent.cdp.send("Runtime.evaluate", {}, 30_000).catch((err) => err);
  const begun = Date.now();
  const lost = await silent.cdp.send("Page.navigate", { url: "https://acme.example/" }, 1_000).catch((err) => err);
  assert.equal(lost.message, "Page.navigate timed out");
  assert.equal(lost.timedOut, true);
  assert.equal(silent.cdp.lost, lost);
  assert.equal(await waiting, lost);
  assert.ok(Date.now() - begun < 20_000, `the call that waited with it failed after ${Date.now() - begun} ms`);
  const after = Date.now();
  assert.equal(await silent.cdp.send("Page.enable").catch((err) => err), lost);
  assert.ok(Date.now() - after < 1_000, `a call after them failed after ${Date.now() - after} ms`);
  assert.deepEqual(silent.sent(), ["Runtime.evaluate", "Page.navigate", "Browser.getVersion"]);
  // A call to the browser itself, one of the browser's own or not, that
  // gets no answer says that by itself, as does one of the browser's own
  // said to a tab.
  for (const [method, to] of [
    ["Browser.setDownloadBehavior", "browser"],
    ["Target.createTarget", "browser"],
    ["Browser.getVersion", "tab"],
  ]) {
    const own = await open({ [method]: "hold" });
    const unanswered = await (to === "tab" ? own.cdp : own.pipe).send(method, {}, 1_000).catch((err) => err);
    assert.equal(unanswered.timedOut, true, method);
    assert.equal(own.pipe.lost, unanswered, method);
    assert.equal(own.cdp.lost, unanswered, method);
    assert.deepEqual(own.sent(), [method]);
  }
  // With three seconds of the run left, the browser has what is left to
  // answer, not ten seconds more.
  const late = await open({ "Page.navigate": "hold", "Browser.getVersion": "hold" });
  setTimeLimit(3_000);
  const cut = Date.now();
  const unanswered = await late.cdp.send("Page.navigate", { url: "https://acme.example/" }, 1_000).catch((err) => err);
  assert.equal(late.cdp.lost, unanswered);
  assert.ok(Date.now() - cut < 8_000, `told after ${Date.now() - cut} ms`);
  assert.deepEqual(late.sent(), ["Page.navigate", "Browser.getVersion"]);
});

test("a tab let go of fails the calls still waiting on it at once and is detached from, while the browser goes on answering; a long answer comes whole; a pipe that closes fails every call", async (t) => {
  const { pipe, endpoint } = await standInPipe(t, { "Page.navigate": "hold", "Network.getResponseBody": { body: "x".repeat(300_000), base64Encoded: false } });
  const cdp = pipe.session("S1");
  const { body } = await cdp.send("Network.getResponseBody", { requestId: "1" });
  assert.equal(body.length, 300_000);
  const waiting = cdp.send("Page.navigate", { url: "https://acme.example/" }, 30_000).catch((err) => err);
  const begun = Date.now();
  cdp.close();
  const dropped = await waiting;
  assert.equal(dropped.closed, true);
  assert.ok(Date.now() - begun < 1_000, `failed after ${Date.now() - begun} ms`);
  assert.equal(pipe.lost, null);
  assert.deepEqual(await pipe.send("Browser.getVersion"), {});
  assert.equal((await cdp.send("Page.enable").catch((err) => err)).closed, true);
  assert.deepEqual(
    endpoint.received.map(({ to, method }) => `${to} ${method}`),
    ["tab Network.getResponseBody", "tab Page.navigate", "browser Target.detachFromTarget", "browser Browser.getVersion"],
  );
  // The browser's end of the pipe closes, as when it quits.
  const other = pipe.session("S2");
  const held = other.send("Page.navigate", { url: "https://acme.example/" }, 30_000).catch((err) => err);
  endpoint.close();
  const gone = await held;
  assert.equal(gone.closed, true);
  assert.equal(pipe.lost, gone);
  assert.equal(await pipe.send("Browser.getVersion").catch((err) => err), gone);
});

// A page whose text is all drawn with Arial, as the browser tells it.
const ARIAL = { fonts: [{ familyName: "Arial", postScriptName: "ArialMT", isCustomFont: false, glyphCount: 12 }] };
const PAGE = {
  "Page.getFrameTree": { frameTree: { frame: { id: "1" } } },
  "DOM.getDocument": { root: { nodeId: 1 } },
  "DOM.querySelectorAll": { nodeIds: [2] },
  "CSS.getPlatformFontsForNode": ARIAL,
  "CSS.getComputedStyleForNode": { computedStyle: [{ name: "font-family", value: "Arial, sans-serif" }] },
};

test("a page whose own scripts hold up the read of a node's text, which tells a fallback for characters a web font lacks from a late font, is asked for it once, with a short wait, and the kit is made", { skip: process.platform === "win32" && "the stand-in browser is a shell script" }, async (t) => {
  const { parent, pid, serve } = standIn(t);
  // Every node is drawn with a font of the visitor's own, and the page
  // never answers the call that reads a node's text.
  const endpoint = await serve({ calls: { ...PAGE, "DOM.resolveNode": { object: { objectId: "text" } }, "Runtime.callFunctionOn": "hold" } });
  const started = Date.now();
  const { kit } = await makeFontKit("https://acme.example/", { dir: path.join(parent, "kit"), timeLimit: 60_000 });
  assert.deepEqual(Object.keys(kit.roles), ["heading", "body", "button", "code"]);
  assert.equal(asked(endpoint).filter((call) => call === "tab Runtime.callFunctionOn").length, 1, "asked once");
  assert.ok(Date.now() - started < 30_000, `the run took ${Date.now() - started} ms`);
  assert.ok(await waitFor(pid()), "the browser is ended");
});

// The run's time spent before the roles are read, as by a font that never
// comes or a browser slow to start: a call answered only once the run has
// less than the 15 s a role is read in.
const whenTimeIsShort = (value) =>
  new Promise((resolve) => {
    const check = () => (timeLeft() < 14_000 ? resolve(value) : setTimeout(check, 100).unref());
    check();
  });

test("a run whose time runs out before any of the page's text could be read makes no kit and says so, and the earlier kit stays, where it saved a kit that said the page had no text; one whose time runs out after some roles were read saves them with a note that names the others", { skip: process.platform === "win32" && "the stand-in browser is a shell script" }, async (t) => {
  const { parent, temp, pid, serve } = standIn(t);
  const dir = path.join(parent, "kit");
  fs.mkdirSync(dir);
  const kit = { "fonts.json": JSON.stringify({ version: 1, generator: "easyfontkit 0.1.3", url: "https://acme.example/", families: [] }), "FONTS.md": "# Fonts of acme.example\n", "fonts.css": ":root {}\n" };
  for (const [name, text] of Object.entries(kit)) fs.writeFileSync(path.join(dir, name), text);
  await serve({ calls: { ...PAGE, "DOM.querySelectorAll": () => whenTimeIsShort({ nodeIds: [2] }) } });
  await assert.rejects(makeFontKit("https://acme.example/", { dir, timeLimit: 30_000 }), { message: "The run's time ran out before the text of https://acme.example/ could be read, so no kit was made. The machine or the site may be slow; try again, or give it more time with --timeout." });
  assert.deepEqual(Object.fromEntries(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")])), kit, "the earlier kit is as it was");
  assert.ok(await waitFor(pid()), "the browser is ended");
  assert.deepEqual(fs.readdirSync(temp), [], "no profile is left");
  // The headings read at once, and the rest once the time is short.
  await serve({ calls: { ...PAGE, "DOM.querySelectorAll": (times) => (times ? whenTimeIsShort({ nodeIds: [2] }) : { nodeIds: [2] }) } });
  const { kit: made } = await makeFontKit("https://acme.example/", { dir: path.join(parent, "some"), timeLimit: 30_000 });
  assert.deepEqual(Object.keys(made.roles), ["heading"]);
  assert.deepEqual(made.notes, ["The run's time ran out before the body text, buttons and code could be read: give it more time with --timeout."]);
  assert.ok(await waitFor(pid()), "the browser is ended");
});

test("a browser that stops answering, or quits, as its page is opened, scrolled or read ends the run naming it, where the site or the page was named or a kit made of what had been read, and the earlier kit stays; a server or a page that does not answer in a browser that does is named as before", { skip: process.platform === "win32" && "the stand-in browser is a shell script" }, async (t) => {
  const { parent, temp, pid, serve } = standIn(t);
  const dir = path.join(parent, "kit");
  fs.mkdirSync(dir);
  const kit = { "fonts.json": JSON.stringify({ version: 1, generator: "easyfontkit 0.1.2", url: "https://acme.example/", families: [] }), "FONTS.md": "# Fonts of acme.example\n", "fonts.css": ":root {}\n" };
  for (const [name, text] of Object.entries(kit)) fs.writeFileSync(path.join(dir, name), text);
  // In a browser that answers, it gives a kit.
  await serve({ calls: PAGE });
  const { kit: made } = await makeFontKit("https://acme.example/", { dir: path.join(parent, "answered"), timeLimit: 30_000 });
  assert.deepEqual(Object.keys(made.roles), ["heading", "body", "button", "code"]);
  assert.ok(await waitFor(pid()), "the browser that answered is ended");
  // A browser that answers what its tab asks as it opens, and nothing after.
  const silent = (times) => (times ? "hold" : {});
  const stopped = "chrome stopped answering, so no kit was made. The machine may be busy; try again.";
  const ranOut = "chrome did not answer before the run's time ran out, so no kit was made. The machine may be busy; try again, or give it more time with --timeout.";
  for (const [what, calls, timeLimit, last, said] of [
    // The first navigation, which has all of a short run: told as a stop, or
    // as the end of the run's time when that came a millisecond before.
    ["the first navigation", { "Page.navigate": "hold", "Browser.getVersion": silent }, 5_000, ["tab Page.navigate", "browser Browser.getVersion"], [stopped, ranOut]],
    // The scroll back to the top, which has ten seconds.
    ["the scroll", { "Input.dispatchMouseEvent": "hold", "Browser.getVersion": silent }, 25_000, ["tab Input.dispatchMouseEvent", "browser Browser.getVersion"], [stopped]],
    // The fonts of the body text, once the headings' were read, which have
    // what is left of the run.
    ["the reading", { "CSS.getPlatformFontsForNode": (times) => (times ? "hold" : ARIAL), "Browser.getVersion": silent }, 25_000, ["tab CSS.getPlatformFontsForNode", "browser Browser.getVersion"], [ranOut]],
    // A browser that quits there.
    ["a quit as the page is read", { "CSS.getPlatformFontsForNode": (times) => (times ? "close" : ARIAL) }, 25_000, ["tab CSS.getPlatformFontsForNode"], [stopped]],
    // A server and a page that do not answer, in a browser that does.
    ["the server", { "Page.navigate": "hold" }, 5_000, ["tab Page.navigate", "browser Browser.getVersion"], [/^Could not open https:\/\/acme\.example\/: no answer in \d+ s\. The site may be down or slow; try again later, or give it more time with --timeout\.$/]],
    ["the page", { "Input.dispatchMouseEvent": "hold" }, 25_000, ["tab Input.dispatchMouseEvent", "browser Browser.getVersion"], ["https://acme.example/ stopped answering the browser while it was read, so no kit was made. Try again later, or check the page in a normal browser."]],
  ]) {
    const endpoint = await serve({ calls: { ...PAGE, ...calls } });
    await assert.rejects(makeFontKit("https://acme.example/", { dir, timeLimit }), (err) => said.some((text) => (typeof text === "string" ? err.message === text : text.test(err.message))) || assert.fail(`${what}: ${err.message}`));
    assert.deepEqual(asked(endpoint).slice(-last.length), last, `${what}: the last calls`);
    assert.ok(await waitFor(pid()), `${what}: the browser is ended`);
    assert.deepEqual(fs.readdirSync(temp), [], `${what}: no profile is left`);
    assert.deepEqual(Object.fromEntries(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")])), kit, `${what}: the earlier kit is as it was`);
  }
});

test("a browser held still for longer than a call waits, as a busy machine can hold it, that answers more than two seconds after it is asked and within ten, gives the call its answer in the wait the call then gets again, and the run saves its whole kit wherever it was held: at the wait for the page's fonts, as 0.1.2 did, and at the navigation, the scroll, a layout read or the reading of a role, where 0.1.2 named the site or the page, or saved a kit without that role; the call is not sent twice", { skip: process.platform === "win32" && "the stand-in browser is a shell script" }, async (t) => {
  // One run for each call, all at once, each in a browser of its own, held
  // still from the first time the call is sent: the call gets no answer in
  // its wait, and the browser, asked then, answers three seconds later, and
  // the call a moment after that. Every run has ended before the first is
  // checked, so a check that fails leaves none going on to save its kit
  // after the test's temp folder is removed. What is left of their browsers
  // is ended before that folder, with their pids, is removed.
  const runs = [];
  t.after(() => {
    for (const { endpoint, pid } of runs) {
      endpoint.close();
      try {
        if (!ended(pid())) process.kill(pid(), "SIGKILL");
      } catch {
        // Never started.
      }
    }
  });
  const { parent, temp } = standIn(t);
  // A page whose headings are all h1, h2 or h3, so a heading not read
  // there is not read at all.
  const page = { ...PAGE, "DOM.querySelectorAll": (times, { selector }) => ({ nodeIds: selector.startsWith("h4") ? [] : [2] }) };
  for (const method of ["Runtime.evaluate", "Page.navigate", "Input.dispatchMouseEvent", "Page.getLayoutMetrics", "CSS.getPlatformFontsForNode"]) {
    const pidFile = path.join(parent, `${method}.pid`);
    const pid = () => Number(fs.readFileSync(pidFile, "utf8"));
    const busy = heldStill();
    const answer = page[method] || {};
    const endpoint = await devtools({ calls: { ...page, [method]: (times) => (times ? answer : busy.until(answer)), "Browser.getVersion": (times) => (times ? busy.asked() : {}) }, onClose: () => process.kill(pid(), "SIGKILL") });
    // The browser is started at once, with these.
    Object.assign(process.env, { DEVTOOLS_PORT: String(endpoint.port), STANDIN_PID: pidFile });
    const made = makeFontKit("https://acme.example/", { dir: path.join(parent, method), timeLimit: 60_000 }).catch((err) => err);
    runs.push({ method, pid, endpoint, made });
  }
  // Each run gives its kit or its error, so this does not throw.
  await Promise.all(runs.map(({ made }) => made));
  for (const { method, pid, endpoint, made } of runs) {
    const { kit, message } = await made;
    assert.ok(kit, `${method}: ${message}`);
    assert.deepEqual(Object.keys(kit.roles), ["heading", "body", "button", "code"], method);
    const sent = asked(endpoint);
    const held = sent.indexOf(`tab ${method}`);
    assert.deepEqual(sent.slice(held, held + 2), [`tab ${method}`, "browser Browser.getVersion"], `${method}: the browser is asked`);
    assert.notEqual(sent[held + 2], `tab ${method}`, `${method}: not sent twice`);
    assert.ok(await waitFor(pid()), `${method}: the browser is ended`);
  }
  assert.deepEqual(fs.readdirSync(temp), [], "no profile is left");
});
