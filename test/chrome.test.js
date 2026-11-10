"use strict";

// The browser's answers that need no browser: a stand-in for the DevTools
// connection says what the real one would.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");
const { launch, killBrowsers, openPage, navigate } = require("../skills/easyfontkit/scripts/lib/chrome");
const { setTimeLimit } = require("../skills/easyfontkit/scripts/lib/time");
const { devtools } = require("./devtools");

test("on Linux, Chrome's temp folder is its profile where the socket it makes there fits, and its profile given as \".\", with Chrome started in it, where its own temp folder is too long for the socket; its crash reports go into its profile", { skip: ["darwin", "win32"].includes(process.platform) && "Chrome takes its temp folder from TMPDIR on Linux only" }, async () => {
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
    for (const [tmp, temp] of [
      ["t", "profile"],
      ["y".repeat(40), "own"],
      ["x".repeat(70), "."],
    ]) {
      process.env.TMPDIR = tmp;
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
const SCREEN = { width: 800, height: 600 };

test("a browser gets the run's time less a minute to open its page, as the page's server gets to answer, and one that does not is named in a plain message", async () => {
  // A browser that never answers, told without waiting for it.
  const saved = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  try {
    for (const [limit, seconds] of [
      [120_000, 60],
      [300_000, 240],
      [75_000, 30],
      [30_000, 30],
    ]) {
      setTimeLimit(limit);
      await assert.rejects(openPage({ base: "http://127.0.0.1:9", name: "chrome" }, SCREEN), { message: busy("chrome", "open a page", seconds) });
    }
  } finally {
    globalThis.fetch = saved;
    setTimeLimit(120_000);
  }
});

test("a browser slow to open its page gets it opened, and one that does not open it, or does not answer on it, in the time it has is named in a plain message", async (t) => {
  const endpoints = [];
  t.after(() => {
    for (const endpoint of endpoints) endpoint.close();
    setTimeLimit(120_000);
  });
  const stand = async (options) => {
    const endpoint = await devtools(options);
    endpoints.push(endpoint);
    return { base: `http://127.0.0.1:${endpoint.port}`, name: "chrome", endpoint };
  };
  // More than the ten seconds a tab had in 0.1.2.
  setTimeLimit(60_000);
  const late = await stand({ routes: { "/json/new": 10_500 } });
  const started = Date.now();
  const cdp = await openPage(late, SCREEN);
  assert.ok(Date.now() - started >= 10_000, `opened after ${Date.now() - started} ms`);
  assert.deepEqual(
    late.endpoint.received.map(({ method }) => method),
    ["Page.enable", "Emulation.setDeviceMetricsOverride", "Browser.getVersion"],
  );
  cdp.close();
  // The tab that is not made, its connection that does not open, and its
  // first call that gets no answer, with three seconds left.
  for (const options of [{ routes: { "/json/new": "hold" } }, { routes: { tab: "hold" } }, { calls: { "Page.enable": "hold" } }]) {
    setTimeLimit(3_000);
    const browser = await stand(options);
    const begun = Date.now();
    await assert.rejects(openPage(browser, SCREEN), { message: busy("chrome", "open a page", 3) }, JSON.stringify(options));
    assert.ok(Date.now() - begun < 6_000, `${JSON.stringify(options)}: ${Date.now() - begun} ms`);
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
// is killed, as Chrome's network service does on its way out.
const WITH_HELPER = `#!/bin/sh
for arg in "$@"; do
  case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}" ;; esac
done
"$NODE_BIN" -e 'const fs = require("fs"); setInterval(() => { try { fs.mkdirSync(process.argv[1] + "/Default", { recursive: true }); fs.writeFileSync(process.argv[1] + "/Default/state", "x"); } catch {} }, 20)' "$profile" &
echo $! > "$HELPER_PID"
printf '1\\n/devtools/browser/x\\n' > "$profile/DevToolsActivePort"
exec sleep 30
`;

test("a browser that is closed or stopped takes its helpers with it, and its profile stays gone", { skip: process.platform !== "linux" && "a browser's processes are told on Linux only" }, async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-helpers-"));
  const temp = path.join(parent, "temp");
  fs.mkdirSync(temp);
  const names = ["CHROME_PATH", "TMPDIR", "HELPER_PID", "NODE_BIN"];
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
  Object.assign(process.env, { CHROME_PATH: chrome, TMPDIR: temp, HELPER_PID: path.join(parent, "helper.pid"), NODE_BIN: process.execPath });
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
const WITH_CRASH_HANDLER = `#!/bin/sh
for arg in "$@"; do
  case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}" ;; esac
done
if [ -z "$HANDLER_GIVEN" ]; then
  ( "$HANDLER_BIN" -e 'setTimeout(() => {}, 30000)' & echo $! > "$HANDLER_PID" )
else
  echo "$HANDLER_GIVEN" > "$HANDLER_PID"
fi
"$NODE_BIN" -e 'process.title = process.argv.join(" "); require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 30000)' -- "$profile/helper.pid" "--crashpad-handler-pid=$(cat "$HANDLER_PID")" "--user-data-dir=$profile" &
while [ ! -s "$profile/helper.pid" ]; do sleep 0.01; done
printf '1\\n/devtools/browser/x\\n' > "$profile/DevToolsActivePort"
exec sleep 30
`;

test("a browser's crash handler goes with it, also once its helpers have ended, and no other process it names does", { skip: process.platform !== "linux" && "a browser's processes are told on Linux only" }, async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-handler-"));
  const temp = path.join(parent, "temp");
  fs.mkdirSync(temp);
  const names = ["CHROME_PATH", "TMPDIR", "NODE_BIN", "HANDLER_BIN", "HANDLER_PID", "HANDLER_GIVEN"];
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
  Object.assign(process.env, { CHROME_PATH: chrome, TMPDIR: temp, NODE_BIN: process.execPath, HANDLER_PID: path.join(parent, "handler.pid") });
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
