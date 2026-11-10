"use strict";

// The browser's answers that need no browser: a stand-in for the DevTools
// connection says what the real one would.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");
const { launch, killBrowsers, connect, openPage, navigate } = require("../skills/easyfontkit/scripts/lib/chrome");
const { makeFontKit } = require("../skills/easyfontkit/scripts/lib/kit");
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
// The message of a wait given a run with three seconds left, which on a
// busy machine can be two by the time the wait begins.
const inThreeSeconds = (what) => (err) => [3, 2].some((seconds) => err.message === busy("chrome", what, seconds)) || assert.fail(err.message);
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
    const browser = await stand(options);
    const begun = Date.now();
    setTimeLimit(3_000);
    await assert.rejects(openPage(browser, SCREEN), inThreeSeconds("open a page"), JSON.stringify(options));
    assert.ok(Date.now() - begun < 15_000, `${JSON.stringify(options)}: ${Date.now() - begun} ms`);
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

// Stands in for Chrome: writes the port of the stand-in DevTools endpoint
// where Chrome writes its own, unless NO_PORT is set, and stays until it is
// killed, as a browser that is slow to answer does.
const STAND_IN = `#!/bin/sh
for arg in "$@"; do case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}";; esac; done
echo $$ > "$STANDIN_PID"
[ -z "$NO_PORT" ] && printf '%s\\n/devtools/browser/x\\n' "$DEVTOOLS_PORT" > "$profile/DevToolsActivePort"
exec sleep 60
`;

// A test's own temp folder and stand-in browser, with the environment put
// back and anything left of the browser killed once the test has ended.
function standIn(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-busy-"));
  const temp = path.join(parent, "temp");
  fs.mkdirSync(temp);
  const names = ["CHROME_PATH", "TMPDIR", "STANDIN_PID", "DEVTOOLS_PORT", "NO_PORT"];
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
  Object.assign(process.env, { CHROME_PATH: path.join(parent, "chrome"), TMPDIR: temp, STANDIN_PID: pidFile });
  // A browser asked to quit quits.
  const serve = async (options) => {
    const endpoint = await devtools({ ...options, onClose: () => process.kill(pid(), "SIGKILL") });
    endpoints.push(endpoint);
    process.env.DEVTOOLS_PORT = String(endpoint.port);
    return endpoint;
  };
  return { parent, temp, pid, serve };
}

test("a browser slow to start gets the run's time less a minute, and is told to refuse downloads before a run goes on in it; one that does not start, or does not answer as it starts, in that time is named in a plain message, ended, and its profile removed", { skip: process.platform === "win32" && "the stand-in browser is a shell script" }, async (t) => {
  const { temp, pid, serve } = standIn(t);
  // /json/version answered after three seconds, where 0.1.2 gave up after
  // two and went on without the download refusal.
  setTimeLimit(60_000);
  const slow = await serve({ routes: { "/json/version": (times) => (times ? 0 : 3_000) } });
  const browser = await launch(SCREEN);
  assert.equal(browser.name, "chrome");
  assert.deepEqual(slow.received, [{ socket: "browser", method: "Browser.setDownloadBehavior" }]);
  await browser.close();
  assert.ok(ended(pid()), "the browser asked to quit");
  assert.deepEqual(fs.readdirSync(temp), []);
  // A browser that writes no port, one whose endpoint, connection or
  // download refusal gets no answer, with three seconds left.
  for (const [what, options] of [
    ["no port", null],
    ["/json/version", { routes: { "/json/version": "hold" } }],
    ["the connection", { routes: { browser: "hold" } }],
    ["the download refusal", { calls: { "Browser.setDownloadBehavior": "hold" } }],
  ]) {
    if (options) {
      delete process.env.NO_PORT;
      await serve(options);
    } else process.env.NO_PORT = "1";
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
  await assert.rejects(launch(SCREEN), { message: "chrome did not start. Try again, or point CHROME_PATH at another browser." });
  assert.deepEqual(fs.readdirSync(path.join(parent, "temp")), []);
});

test("a browser that stops answering once it has started, or quits, ends the run with a plain message, and the earlier kit stays", { skip: process.platform === "win32" && "the stand-in browser is a shell script" }, async (t) => {
  const { parent, temp, pid, serve } = standIn(t);
  const dir = path.join(parent, "kit");
  fs.mkdirSync(dir);
  const kit = { "fonts.json": JSON.stringify({ version: 1, generator: "easyfontkit 0.1.2", url: "https://acme.example/", families: [] }), "FONTS.md": "# Fonts of acme.example\n", "fonts.css": ":root {}\n" };
  for (const [name, text] of Object.entries(kit)) fs.writeFileSync(path.join(dir, name), text);
  const stopped = "chrome stopped answering, so no kit was made. The machine may be busy; try again.";
  // The calls to the tab after the three that open it.
  for (const [what, options, timeLimit, calls, message] of [
    // A call that gets no answer until the run's time is out, and the
    // browser itself, asked then.
    ["a call", { calls: { "Network.enable": "hold" } }, 4_000, ["Network.enable", "Browser.getVersion"], "chrome did not answer before the run's time ran out, so no kit was made. The machine may be busy; try again, or give it more time with --timeout."],
    // A browser that drops its connection to the tab, before the page is
    // asked for or as it is, or its endpoint's request for the tab, as one
    // that has quit.
    ["the connection", { calls: { "Network.enable": "close" } }, 60_000, ["Network.enable"], stopped],
    ["the first navigation", { calls: { "Page.getFrameTree": { frameTree: { frame: { id: "1" } } }, "Page.navigate": "close" } }, 60_000, ["Network.enable", "DOM.enable", "CSS.enable", "Page.getFrameTree", "Page.navigate"], stopped],
    ["the endpoint", { routes: { "/json/new": "refuse" } }, 60_000, [], stopped],
  ]) {
    const endpoint = await serve(options);
    await assert.rejects(makeFontKit("https://acme.example/", { dir, timeLimit }), { message }, what);
    assert.deepEqual(endpoint.received.filter(({ socket }) => socket === "tab").map(({ method }) => method).slice(3), calls, `${what}: the calls to the tab`);
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

test("a call that gets no answer is put down to the browser only when the browser itself, asked at once on the same connection, does not answer either in ten seconds, or in what is left of the run's time when that is less, and every call then fails at once; a browser that takes more than two seconds to answer was held still, and the call it was sent gets its wait again and is not sent twice", async (t) => {
  const endpoints = [];
  t.after(() => {
    for (const endpoint of endpoints) endpoint.close();
    setTimeLimit(120_000);
  });
  setTimeLimit(60_000);
  const open = async (calls, where = "/devtools/page/1") => {
    const endpoint = await devtools({ calls });
    endpoints.push(endpoint);
    const cdp = await connect(`ws://127.0.0.1:${endpoint.port}${where}`, 5_000);
    t.after(() => cdp.close());
    return { cdp, sent: () => endpoint.received.map(({ method }) => method) };
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
  // A call of the browser's own that gets no answer says that by itself.
  const own = await open({ "Browser.setDownloadBehavior": "hold" }, "/devtools/browser/x");
  const refused = await own.cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }, 1_000).catch((err) => err);
  assert.equal(refused.timedOut, true);
  assert.equal(own.cdp.lost, refused);
  assert.deepEqual(own.sent(), ["Browser.setDownloadBehavior"]);
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

// A page whose text is all drawn with Arial, as the browser tells it.
const ARIAL = { fonts: [{ familyName: "Arial", postScriptName: "ArialMT", isCustomFont: false, glyphCount: 12 }] };
const PAGE = {
  "Page.getFrameTree": { frameTree: { frame: { id: "1" } } },
  "DOM.getDocument": { root: { nodeId: 1 } },
  "DOM.querySelectorAll": { nodeIds: [2] },
  "CSS.getPlatformFontsForNode": ARIAL,
  "CSS.getComputedStyleForNode": { computedStyle: [{ name: "font-family", value: "Arial, sans-serif" }] },
};

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
    ["the first navigation", { "Page.navigate": "hold", "Browser.getVersion": silent }, 5_000, ["Page.navigate", "Browser.getVersion"], [stopped, ranOut]],
    // The scroll back to the top, which has ten seconds.
    ["the scroll", { "Input.dispatchMouseEvent": "hold", "Browser.getVersion": silent }, 25_000, ["Input.dispatchMouseEvent", "Browser.getVersion"], [stopped]],
    // The fonts of the body text, once the headings' were read, which have
    // what is left of the run.
    ["the reading", { "CSS.getPlatformFontsForNode": (times) => (times ? "hold" : ARIAL), "Browser.getVersion": silent }, 25_000, ["CSS.getPlatformFontsForNode", "Browser.getVersion"], [ranOut]],
    // A browser that quits there.
    ["a quit as the page is read", { "CSS.getPlatformFontsForNode": (times) => (times ? "close" : ARIAL) }, 25_000, ["CSS.getPlatformFontsForNode"], [stopped]],
    // A server and a page that do not answer, in a browser that does.
    ["the server", { "Page.navigate": "hold" }, 5_000, ["Page.navigate", "Browser.getVersion"], [/^Could not open https:\/\/acme\.example\/: no answer in \d+ s\. The site may be down or slow; try again later, or give it more time with --timeout\.$/]],
    ["the page", { "Input.dispatchMouseEvent": "hold" }, 25_000, ["Input.dispatchMouseEvent", "Browser.getVersion"], ["https://acme.example/ stopped answering the browser while it was read, so no kit was made. Try again later, or check the page in a normal browser."]],
  ]) {
    const endpoint = await serve({ calls: { ...PAGE, ...calls } });
    await assert.rejects(makeFontKit("https://acme.example/", { dir, timeLimit }), (err) => said.some((text) => (typeof text === "string" ? err.message === text : text.test(err.message))) || assert.fail(`${what}: ${err.message}`));
    assert.deepEqual(endpoint.received.filter(({ socket }) => socket === "tab").map(({ method }) => method).slice(-last.length), last, `${what}: the last calls to the tab`);
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
    const sent = endpoint.received.filter(({ socket }) => socket === "tab").map(({ method: sentMethod }) => sentMethod);
    const held = sent.indexOf(method);
    assert.deepEqual(sent.slice(held, held + 2), [method, "Browser.getVersion"], `${method}: the browser is asked`);
    assert.notEqual(sent[held + 2], method, `${method}: not sent twice`);
    assert.ok(await waitFor(pid()), `${method}: the browser is ended`);
  }
  assert.deepEqual(fs.readdirSync(temp), [], "no profile is left");
});
