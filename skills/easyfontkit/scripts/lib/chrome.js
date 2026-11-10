"use strict";

// The browser: a Chrome, Chromium, Edge or Brave already on this machine,
// started headless with a throwaway profile and driven over the DevTools
// protocol with the WebSocket built into Node 22. No browser is
// downloaded, and the one started downloads none of its components.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { timeLeft, sleep } = require("./time");

const MAC = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];
const LINUX = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
const WINDOWS = [
  ["PROGRAMFILES", "Google\\Chrome\\Application\\chrome.exe"],
  ["PROGRAMFILES(X86)", "Google\\Chrome\\Application\\chrome.exe"],
  ["LOCALAPPDATA", "Google\\Chrome\\Application\\chrome.exe"],
  ["PROGRAMFILES(X86)", "Microsoft\\Edge\\Application\\msedge.exe"],
  ["PROGRAMFILES", "Microsoft\\Edge\\Application\\msedge.exe"],
];

function onPath(name) {
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // Not in this directory.
    }
  }
  return "";
}

function findChrome() {
  if (process.env.CHROME_PATH) return fs.existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : "";
  if (process.platform === "darwin") return MAC.find((file) => fs.existsSync(file)) || "";
  if (process.platform === "win32") {
    for (const [root, rest] of WINDOWS) {
      const file = process.env[root] ? path.join(process.env[root], rest) : "";
      if (file && fs.existsSync(file)) return file;
    }
    return "";
  }
  for (const name of LINUX) {
    const file = onPath(name);
    if (file) return file;
  }
  return "";
}

// The browsers this process has started and not closed yet, each with its
// profile, from the moment it is spawned.
const open = new Set();

// Chrome keeps the socket that hands a second start of a profile over to
// the first one in a folder of its own in the temp folder, linked from the
// profile as SingletonSocket. Chrome removes that folder when it quits; one
// that is killed cannot, so it is removed with the profile.
function singletonOf(profile) {
  try {
    const socket = path.resolve(profile, fs.readlinkSync(path.join(profile, "SingletonSocket")));
    const folder = path.dirname(socket);
    if (path.basename(socket) === "SingletonSocket" && fs.realpathSync(path.dirname(folder)) === fs.realpathSync(os.tmpdir())) return folder;
  } catch {
    // Not made yet, or not on this system.
  }
  return "";
}

// A browser's profile and its socket folder, once the browser has ended,
// each removal tried again a few times with the given delay.
function removeProfile({ profile, singleton }, maxRetries, retryDelay) {
  for (const folder of [profile, singleton]) {
    if (!folder) continue;
    try {
      fs.rmSync(folder, { recursive: true, force: true, maxRetries, retryDelay });
    } catch {
      // Left for the system's temp clean-up.
    }
  }
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// When a process started, on Linux, from /proc/<pid>/stat, so that a pid
// that has come round again on another process is not taken for it: null
// once it has ended (a zombie has ended too).
function startOf(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" || fields[0] === "X" ? null : fields[19];
  } catch {
    return null;
  }
}

// The processes that run on Linux, but this one: the parent of each, and,
// given a tag, those whose command line holds it.
function processTable(tag = "") {
  const parentOf = new Map();
  const named = [];
  let names = [];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return { parentOf, named };
  }
  for (const name of names) {
    const pid = Number(name);
    if (!/^\d+$/.test(name) || pid === process.pid) continue;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const [state, ppid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (state === "Z" || state === "X") continue;
      parentOf.set(pid, Number(ppid));
      if (tag && fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(tag)) named.push(pid);
    } catch {
      // Gone already.
    }
  }
  return { parentOf, named };
}

// A browser's processes on Linux: the browser and those that descend from
// it, each with its start. Other systems give none.
function processesOf(child) {
  if (process.platform !== "linux" || !child.pid) return [];
  const { parentOf } = processTable();
  const found = new Set([child.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of parentOf) {
      if (!found.has(pid) && found.has(ppid)) {
        found.add(pid);
        grew = true;
      }
    }
  }
  return [...found].map((pid) => ({ pid, start: startOf(pid) })).filter(({ start }) => start !== null);
}

// The crash handler a browser's processes name, on Linux, which Chrome starts
// apart from them, in a session of its own: it is no child of theirs, and a
// stop sent to the run's process group does not reach it. Ctrl-\ reaches the
// browser's helpers, each of them asks it for a crash report, and it takes
// hold of each one to write it. A helper killed while it is held stays until
// the handler lets go of it, which it can fail to do for good. So it goes
// with them: the one named, only when it is a crash handler by the name /proc
// gives it (the first 15 characters of its program's name, chrome_crashpad
// or msedge_crashpad) and it started with them or after them. Chrome rewrites
// a helper's command line with spaces between its arguments. null when none
// is named.
function crashHandlerOf(processes) {
  if (process.platform !== "linux" || !processes.length) return null;
  const oldest = Math.min(...processes.map(({ start }) => Number(start)));
  for (const { pid } of processes) {
    let line = "";
    try {
      line = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    const named = /(?:^|[\0 ])--crashpad-handler-pid=(\d+)(?=[\0 ]|$)/.exec(line);
    if (!named) continue;
    // 0 where Chrome runs without one.
    const handler = Number(named[1]);
    if (handler <= 1 || handler === process.pid) return null;
    try {
      if (!/crashpad/.test(fs.readFileSync(`/proc/${handler}/comm`, "utf8"))) return null;
    } catch {
      return null;
    }
    const start = startOf(handler);
    return start === null || Number(start) < oldest ? null : { pid: handler, start };
  }
  return null;
}

// A browser's processes and its crash handler, known from its launch or
// named by them now.
function withCrashHandler(browser, processes) {
  const handler = browser.crashHandler || crashHandlerOf(processes);
  return handler && !processes.some(({ pid }) => pid === handler.pid) ? [...processes, handler] : processes;
}

// Each of them that still runs, killed.
function killAll(processes) {
  for (const { pid, start } of processes) {
    if (startOf(pid) !== start) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
}
const allGone = (processes) => processes.every(({ pid, start }) => startOf(pid) !== start);

// Each of a browser's processes that still runs, killed, and then each
// process whose command line names its profile, as Chrome's helpers and its
// crash handler do: they are found that way also once the browser has ended
// and they belong to no one, and one of them can start another a moment
// before it is killed, which would write into the profile after it was
// removed. Looked for again until a look finds none and all have ended, a
// second at most. Chrome's network service writes into the profile as it
// ends, so the profile can be removed for good only once they are all gone.
// Gives back every process it killed.
function endAll(processes, profile) {
  const ended = [...processes];
  killAll(ended);
  if (process.platform !== "linux") return ended;
  const tag = path.basename(profile);
  for (let waited = 0; waited < 1_000; waited += 20) {
    const late = processTable(tag)
      .named.map((pid) => ({ pid, start: startOf(pid) }))
      .filter(({ pid, start }) => start !== null && !ended.some((known) => known.pid === pid && known.start === start));
    if (!late.length && allGone(ended)) break;
    killAll(late);
    ended.push(...late);
    pause(20);
  }
  return ended;
}

// How long a wait before the page is read gets: the time the run has left,
// less a minute for reading the page, 30 s at least, and never more than
// the run has left. The browser gets that to start, and again to open its
// page, as the page's server gets it to answer: on a machine under heavy
// load the browser alone can take half a minute and more.
const beforeReading = () => Math.max(1_000, Math.min(Math.max(30_000, timeLeft() - 60_000), timeLeft()));

// A browser that did not start, or did not open its page, in the time it
// had: which browser, that no kit was made, and what to do. That time grows
// with the run's, so more of it can help.
function tooSlow(name, what, wait) {
  return new Error(`${name} did not ${what} in ${Math.round(wait / 1000)} s, so no kit was made. The machine may be busy; try again, or give it more time with --timeout.`);
}

// A browser that stopped answering once it had started: a call that got no
// answer in its time (timedOut), or a connection to it that failed or
// closed (closed), as when it has quit. A call cut short by the end of the
// run's time says that. Any other error is given back as it is.
function stoppedAnswering(name, err) {
  if (!err || !(err.timedOut || err.closed)) return err;
  if (err.timedOut && err.outOfTime) return new Error(`${name} did not answer before the run's time ran out, so no kit was made. The machine may be busy; try again, or give it more time with --timeout.`);
  return new Error(`${name} stopped answering, so no kit was made. The machine may be busy; try again.`);
}

// A wait for the browser's own HTTP endpoint that runs out says so
// (timedOut), and one it refuses, as when it has quit, too (closed).
async function askBrowser(url, init) {
  try {
    return await (await fetch(url, init)).json();
  } catch (err) {
    if (err.name === "TimeoutError") throw Object.assign(new Error("The browser did not answer."), { timedOut: true });
    if (err.name === "TypeError") throw Object.assign(new Error("The browser connection failed."), { closed: true });
    throw err;
  }
}

// The connection to the browser as a whole, for what is said to all of it,
// made by the time given.
async function browserConnection(base, until) {
  const left = () => Math.max(1_000, until - Date.now());
  const { webSocketDebuggerUrl } = await askBrowser(`${base}/json/version`, { signal: AbortSignal.timeout(left()) });
  return connect(webSocketDebuggerUrl, left());
}

// A page cannot make the browser save a file: a download it starts, by a
// link, a script or a frame that goes to an attachment, is refused before
// anything is written, in the user's Downloads folder or anywhere else, and
// the page stays where it is. Said to the whole browser over a connection
// of its own, which stays open until the browser has ended: Chrome forgets
// it as soon as the connection that said it closes, and the connection to
// the tab closes first. It is said within the time the browser has to
// start: a browser that does not answer in that time ends the run
// (timedOut), as a slow one could go on to open the page with nothing said.
// A run goes on in a browser that does not take it, or that refuses the
// connection, as one that has quit: opening its page then fails.
// Gives that connection, or null when there is none.
async function denyDownloads(base, until) {
  let browser;
  try {
    browser = await browserConnection(base, until);
  } catch (err) {
    if (err.timedOut) throw err;
    return null;
  }
  try {
    await browser.send("Browser.setDownloadBehavior", { behavior: "deny" }, Math.max(1_000, until - Date.now()));
  } catch (err) {
    if (err.timedOut) {
      browser.close();
      throw err;
    }
    // A browser that does not take it.
  }
  return browser;
}

// Chrome on Linux takes its temp folder from TMPDIR, and makes there the
// socket that hands a second start of a profile over to the first one. A
// socket's path may not pass 107 bytes: the socket's own folder takes up to
// 32 more, and /SingletonSocket 16, and Chrome does not start when it does
// not fit. Chrome is given its profile as its temp folder when that leaves
// room for the socket, so anything else it leaves there when it is closed
// soon after it starts goes with the profile too. Else it keeps the temp
// folder it would have had, and when that leaves no room either, it is
// started in its profile and given that as ".", which leaves room however
// long the path is.
const fits = (folder) => Buffer.byteLength(folder) + 1 + 32 + 16 <= 107;
function tempOf(profile) {
  if (process.platform === "darwin" || process.platform === "win32") return { profile };
  if (fits(profile)) return { profile, env: { ...process.env, TMPDIR: profile } };
  if (fits(os.tmpdir())) return { profile };
  const whole = path.resolve(profile);
  return { profile: whole, cwd: whole, env: { ...process.env, TMPDIR: "." } };
}

// --use-mock-keychain and --password-store=basic keep Chrome on macOS from
// asking for the login keychain, which it does for a fresh profile. The
// profile is a temp folder; the user's own home and browser are untouched.
// Chrome's component updater is sent to a closed port, so it downloads
// nothing during a run: a download it had begun when a run ends early, as
// on an error page, leaves an empty folder in the temp folder on every
// system, which removing the profile does not reach. Chrome on Linux has its
// crash handler keep its reports in the user's own browser's folder
// (~/.config/google-chrome/Crash Reports), where nothing removes them, and
// Ctrl-\ asks for one from each of the browser's processes:
// BREAKPAD_DUMP_LOCATION puts them in the profile, which goes when the run
// ends.
async function launch({ width, height }) {
  const binary = findChrome();
  if (!binary) {
    throw new Error("No Chrome, Chromium, Edge or Brave found. Install one, or point CHROME_PATH at its binary.");
  }
  const name = path.basename(binary);
  const { profile, env = process.env, ...where } = tempOf(fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-chrome-")));
  const child = spawn(
    binary,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "--hide-scrollbars",
      "--mute-audio",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--component-updater=url-source=http://127.0.0.1:9/",
      "--use-mock-keychain",
      "--password-store=basic",
      // Chrome refuses to start as root without it (a container, a CI box).
      ...(process.getuid && process.getuid() === 0 ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdio: "ignore", ...where, env: { ...env, BREAKPAD_DUMP_LOCATION: path.resolve(profile, "Crash Reports") } },
  );
  let exited = false;
  child.on("exit", () => (exited = true));
  child.on("error", () => (exited = true));
  const started = { child, profile, singleton: "", crashHandler: null };
  open.add(started);
  let base = "";
  let denying = null;
  // Chrome is asked to quit first: killed outright, its helper processes go
  // on writing to the profile for a while. Those still there once it has
  // quit are killed, with its crash handler, and the profile is removed once
  // they are gone. A profile that still cannot be removed is left in the
  // temp folder; the kit is not lost over it.
  const close = async () => {
    // The browser's processes as they are now, with its crash handler; its
    // helpers, which name the profile, are found also once it has ended, as
    // one that could not start has.
    const processes = withCrashHandler(started, processesOf(child));
    if (base && !exited) {
      let asked = false;
      try {
        const browser = await browserConnection(base, Date.now() + 2_000);
        asked = true;
        await browser.send("Browser.close", {}, 3_000).catch(() => {});
      } catch {
        // Not answering: it is killed below, at once.
      }
      for (let i = 0; i < 50 && asked && !exited; i++) await sleep(100);
    }
    if (!exited) child.kill("SIGKILL");
    for (let i = 0; i < 20 && !exited; i++) await sleep(100);
    if (denying) denying.close();
    endAll(processes, profile);
    open.delete(started);
    started.singleton = started.singleton || singletonOf(profile);
    removeProfile(started, 10, 100);
  };
  // Chrome writes the port it picked to DevToolsActivePort in the profile.
  // The time a browser has to start covers that, and the connection that
  // tells it to refuse downloads. It is told by the clock: on a busy
  // machine each pause between two looks takes longer than it asks.
  const wait = beforeReading();
  const until = Date.now() + wait;
  const portFile = path.join(profile, "DevToolsActivePort");
  while (!exited && Date.now() < until) {
    let port = "";
    try {
      port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
    } catch {
      // Not written yet.
    }
    if (/^\d+$/.test(port)) {
      base = `http://127.0.0.1:${port}`;
      started.singleton = singletonOf(profile);
      // Known from the start: by the time the browser is stopped, its
      // helpers can have ended.
      started.crashHandler = crashHandlerOf(processesOf(child));
      try {
        denying = await denyDownloads(base, until);
      } catch (err) {
        await close();
        throw err.timedOut ? tooSlow(name, "start", wait) : err;
      }
      return { base, name, close };
    }
    await sleep(100);
  }
  // One that quit did not start; one still starting is slow.
  const quit = exited;
  await close();
  if (quit) throw new Error(`${name} did not start. Try again, or point CHROME_PATH at another browser.`);
  throw tooSlow(name, "start", wait);
}

// Every browser still open, killed at once with its helpers and its crash
// handler, and its profile and socket folder removed, for a process that is
// being stopped and has no time to ask them to quit. It never throws.
function killBrowsers() {
  const browsers = [...open];
  open.clear();
  if (!browsers.length) return;
  for (const browser of browsers) {
    browser.singleton = browser.singleton || singletonOf(browser.profile);
    browser.processes = withCrashHandler(browser, processesOf(browser.child));
    try {
      browser.child.kill("SIGKILL");
    } catch {
      // Gone already.
    }
    killAll(browser.processes);
  }
  // Until they are gone, with any they started, a second at most each.
  for (const browser of browsers) browser.processes = endAll(browser.processes, browser.profile);
  // Once its processes are gone, nothing writes into a profile again. Where
  // they cannot be told, as on macOS and Windows, helpers can still write
  // into it for a moment as they end: it is removed until it stays gone,
  // half a second at most. What is still left goes with the system's temp
  // clean-up.
  for (let round = 0; round < 5; round++) {
    for (const browser of browsers) removeProfile(browser, 2, 20);
    if (browsers.every(({ processes }) => processes.length && allGone(processes))) break;
    pause(100);
    if (!browsers.some(({ profile }) => fs.existsSync(profile))) break;
  }
}

// A connection to the browser or to one of its tabs, open within the time
// given: one that does not open in it says so (timedOut), as does one that
// fails or closes (closed).
function connect(wsUrl, ms = beforeReading()) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const opening = setTimeout(() => {
      reject(Object.assign(new Error("The browser connection timed out."), { timedOut: true }));
      ws.close();
    }, ms);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 0;
    // What says that the browser has stopped answering, or that the
    // connection has closed, once either has happened: every call waiting
    // then fails with it, and every call after it fails at once.
    let lost = null;
    const lose = (err) => {
      lost = lost || err;
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(lost);
      }
      pending.clear();
    };
    // A call that gets no answer in the time given says so (timedOut).
    const call = (method, params, wait) =>
      new Promise((res, rej) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(Object.assign(new Error(`${method} timed out`), { timedOut: true }));
        }, wait);
        pending.set(id, { resolve: res, reject: rej, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    // Whether the browser itself still answers, asked on the same connection
    // when a call got no answer in its time. The browser answers
    // Browser.getVersion by itself, whatever the page or its server does, in
    // a few milliseconds also on a busy machine: any answer will do, an
    // error too. None in two seconds, or a connection that closes, says it
    // has stopped answering. Calls that run out together share one question.
    let asking = null;
    const answers = () =>
      (asking =
        asking ||
        call("Browser.getVersion", {}, Math.max(1_000, Math.min(2_000, timeLeft())))
          .then(
            () => true,
            (err) => !(err.timedOut || err.closed),
          )
          .finally(() => (asking = null)));
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (msg && msg.method) {
        for (const listener of listeners.get(msg.method) || []) listener(msg.params || {});
        return;
      }
      const waiter = msg && pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(msg.error.message || "DevTools protocol error"));
      else waiter.resolve(msg.result || {});
    };
    ws.onerror = () => {
      clearTimeout(opening);
      reject(Object.assign(new Error("The browser connection failed."), { closed: true }));
    };
    ws.onclose = () => {
      clearTimeout(opening);
      lose(Object.assign(new Error("The browser connection closed."), { closed: true }));
    };
    ws.onopen = () => {
      clearTimeout(opening);
      resolve({
        // A call that gets no answer in its time says so (timedOut), and
        // whether the end of the run's time cut that short (outOfTime). One
        // on a connection that has closed fails at once (closed), where it
        // would wait out its time for an answer that cannot come, and so
        // does one once the browser has stopped answering. A call of the
        // browser's own (Browser.*) that gets no answer says that by
        // itself; for any other, the browser is asked first, so a page or
        // a server that does not answer is not taken for the browser.
        send(method, params = {}, timeoutMs = 30_000) {
          if (lost) return Promise.reject(lost);
          if (ws.readyState !== WebSocket.OPEN) return Promise.reject(Object.assign(new Error("The browser connection closed."), { closed: true }));
          const wait = Math.max(1_000, Math.min(timeoutMs, timeLeft()));
          return call(method, params, wait).catch(async (err) => {
            if (!err.timedOut || err === lost) throw err;
            err.outOfTime = wait < timeoutMs;
            if (!lost && (method.startsWith("Browser.") || !(await answers()))) lose(err);
            throw lost || err;
          });
        },
        on(method, listener) {
          listeners.set(method, [...(listeners.get(method) || []), listener]);
        },
        close() {
          ws.close();
        },
        // The browser stopped answering (timedOut), or the connection closed
        // (closed), when either has happened; null until then.
        get lost() {
          return lost;
        },
      });
    };
  });
}

// A new tab, set to a desktop screen of the given size, in the browser
// launch() gave, opened in the time a browser has for that. Headless Chrome
// says "HeadlessChrome" in its user agent, and some sites answer that with
// a stripped page; the tab says "Chrome", as the same browser with a window
// would.
async function openPage({ base, name }, { width, height }) {
  const wait = beforeReading();
  const until = Date.now() + wait;
  const left = () => Math.max(1_000, until - Date.now());
  let cdp;
  try {
    const target = await askBrowser(`${base}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(wait) });
    cdp = await connect(target.webSocketDebuggerUrl, left());
    await cdp.send("Page.enable", {}, left());
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, left());
    const { userAgent = "" } = await cdp.send("Browser.getVersion", {}, left()).catch((err) => {
      if (err.timedOut) throw err;
      return {};
    });
    if (userAgent.includes("HeadlessChrome")) {
      await cdp.send("Emulation.setUserAgentOverride", { userAgent: userAgent.replace("HeadlessChrome", "Chrome") }, left());
    }
    return cdp;
  } catch (err) {
    if (cdp) cdp.close();
    throw err.timedOut ? tooSlow(name, "open a page", wait) : err;
  }
}

// Opens the address and waits for its load event, at most 30 s: a page that
// never finishes loading (a stuck tracking script) is read as it stands.
// The wait's timer is cleared once the page has loaded, or it would keep
// the process alive for the rest of the 30 s after the kit is done. The
// server gets the run's time to answer, less a minute for reading the
// page: 30 s at least, and never more than the run has left. Returns the
// address the tab ended on, after any redirects, or the one asked when the
// tab has moved on to one that is not a web address, like about:blank. An
// error says how many seconds a server that did not answer had (noAnswer),
// as the one that did not can be one a redirect led to.
async function navigate(cdp, url) {
  const loaded = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
  const answer = beforeReading();
  let errorText;
  try {
    ({ errorText } = await cdp.send("Page.navigate", { url }, answer));
  } catch (err) {
    if (!err.timedOut) throw err;
    const seconds = Math.round(answer / 1000);
    throw Object.assign(new Error(`Could not open ${url}: no answer in ${seconds} s. The site may be down or slow; try again later, or give it more time with --timeout.`), { noAnswer: seconds });
  }
  if (errorText) throw Object.assign(new Error(`Could not open ${url}: ${errorText}`), { errorText });
  let timer;
  const late = new Promise((resolve) => (timer = setTimeout(resolve, Math.max(1_000, Math.min(30_000, timeLeft() - 60_000)))));
  await Promise.race([loaded, late]);
  clearTimeout(timer);
  const now = await currentAddress(cdp);
  return /^https?:/i.test(now) ? now : url;
}

// The address the tab shows now, from its history: with the #fragment, and
// after any redirect, script or meta refresh that moved it on. Empty when
// the browser does not say.
async function currentAddress(cdp) {
  try {
    const { currentIndex, entries } = await cdp.send("Page.getNavigationHistory");
    return (entries[currentIndex] || {}).url || "";
  } catch {
    return "";
  }
}

module.exports = { findChrome, launch, killBrowsers, connect, openPage, stoppedAnswering, navigate, currentAddress };
