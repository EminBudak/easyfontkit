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
    const socket = fs.readlinkSync(path.join(profile, "SingletonSocket"));
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

// Chrome on Linux takes its temp folder from TMPDIR. There it is given the
// profile, so anything else Chrome leaves in its temp folder when it is
// closed soon after it starts goes with the profile too. Chrome makes its
// socket in that folder as well, and a socket's path may not pass 107
// bytes: the socket's own folder takes up to 32 more, and /SingletonSocket
// 16. With a longer profile path, Chrome keeps the temp folder it would
// have had.
const ownTemp = (profile) => process.platform !== "darwin" && process.platform !== "win32" && Buffer.byteLength(profile) + 1 + 32 + 16 <= 107;

// --use-mock-keychain and --password-store=basic keep Chrome on macOS from
// asking for the login keychain, which it does for a fresh profile. The
// profile is a temp folder; the user's own home and browser are untouched.
// Chrome's component updater is sent to a closed port, so it downloads
// nothing during a run: a download it had begun when a run ends early, as
// on an error page, leaves an empty folder in the temp folder on every
// system, which removing the profile does not reach.
async function launch({ width, height }) {
  const binary = findChrome();
  if (!binary) {
    throw new Error("No Chrome, Chromium, Edge or Brave found. Install one, or point CHROME_PATH at its binary.");
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-chrome-"));
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
    { stdio: "ignore", env: ownTemp(profile) ? { ...process.env, TMPDIR: profile } : process.env },
  );
  let exited = false;
  child.on("exit", () => (exited = true));
  child.on("error", () => (exited = true));
  const started = { child, profile, singleton: "" };
  open.add(started);
  let base = "";
  // Chrome is asked to quit first: killed outright, its helper processes go
  // on writing to the profile for a while and the folder cannot be removed.
  // A profile that still cannot be removed is left in the temp folder; the
  // kit is not lost over it.
  const close = async () => {
    if (base && !exited) {
      try {
        const { webSocketDebuggerUrl } = await (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2_000) })).json();
        const browser = await connect(webSocketDebuggerUrl);
        await browser.send("Browser.close", {}, 3_000).catch(() => {});
      } catch {
        // Not answering: it is killed below.
      }
      for (let i = 0; i < 50 && !exited; i++) await sleep(100);
    }
    if (!exited) child.kill("SIGKILL");
    for (let i = 0; i < 20 && !exited; i++) await sleep(100);
    open.delete(started);
    started.singleton = started.singleton || singletonOf(profile);
    removeProfile(started, 10, 100);
  };
  // Chrome writes the port it picked to DevToolsActivePort in the profile.
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let waited = 0; waited < 20_000 && !exited; waited += 100) {
    try {
      const port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
      if (/^\d+$/.test(port)) {
        base = `http://127.0.0.1:${port}`;
        started.singleton = singletonOf(profile);
        return { base, close };
      }
    } catch {
      // Not written yet.
    }
    await sleep(100);
  }
  await close();
  throw new Error(`${path.basename(binary)} did not start. Try again, or point CHROME_PATH at another browser.`);
}

// Every browser still open, killed at once, and its profile and socket
// folder removed, for a process that is being stopped and has no time to
// ask them to quit. Their helper processes end by themselves soon after,
// but on their way out they can write to the profile and make it again, so
// it is removed once more a moment later. What is still left goes with the
// system's temp clean-up.
function killBrowsers() {
  const browsers = [...open];
  open.clear();
  if (!browsers.length) return;
  for (const browser of browsers) {
    browser.singleton = browser.singleton || singletonOf(browser.profile);
    try {
      browser.child.kill("SIGKILL");
    } catch {
      // Gone already.
    }
  }
  for (const wait of [0, 100]) {
    if (wait) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    for (const browser of browsers) removeProfile(browser, 3, 50);
  }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 0;
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
    ws.onerror = () => reject(new Error("The browser connection failed."));
    ws.onclose = () => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("The browser connection closed."));
      }
      pending.clear();
    };
    ws.onopen = () =>
      resolve({
        send(method, params = {}, timeoutMs = 30_000) {
          const id = ++nextId;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(Object.assign(new Error(`${method} timed out`), { timedOut: true }));
            }, Math.max(1_000, Math.min(timeoutMs, timeLeft())));
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(method, listener) {
          listeners.set(method, [...(listeners.get(method) || []), listener]);
        },
        close() {
          ws.close();
        },
      });
  });
}

// A new tab, set to a desktop screen of the given size. Headless Chrome says
// "HeadlessChrome" in its user agent, and some sites answer that with a
// stripped page; the tab says "Chrome", as the same browser with a window
// would.
async function openPage(base, { width, height }) {
  const res = await fetch(`${base}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(10_000) });
  const target = await res.json();
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const { userAgent = "" } = await cdp.send("Browser.getVersion").catch(() => ({}));
  if (userAgent.includes("HeadlessChrome")) {
    await cdp.send("Emulation.setUserAgentOverride", { userAgent: userAgent.replace("HeadlessChrome", "Chrome") });
  }
  return cdp;
}

// Opens the address and waits for its load event, at most 30 s: a page that
// never finishes loading (a stuck tracking script) is read as it stands.
// The wait's timer is cleared once the page has loaded, or it would keep
// the process alive for the rest of the 30 s after the kit is done. The
// server gets the run's time to answer, less a minute for reading the
// page: 30 s at least, and never more than the run has left. Returns the
// address the tab ended on, after any redirects, or the one asked when the
// tab has moved on to one that is not a web address, like about:blank.
async function navigate(cdp, url) {
  const loaded = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
  const answer = Math.max(1_000, Math.min(Math.max(30_000, timeLeft() - 60_000), timeLeft()));
  let errorText;
  try {
    ({ errorText } = await cdp.send("Page.navigate", { url }, answer));
  } catch (err) {
    if (!err.timedOut) throw err;
    throw new Error(`Could not open ${url}: no answer in ${Math.round(answer / 1000)} s. The site may be down or slow; try again later, or give it more time with --timeout.`);
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

module.exports = { findChrome, launch, killBrowsers, connect, openPage, navigate, currentAddress };
