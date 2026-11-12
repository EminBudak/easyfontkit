"use strict";

// The browser: a Chrome, Chromium, Edge or Brave already on this machine,
// started headless with a throwaway profile and driven over the DevTools
// protocol on a pipe, its file descriptors 3 and 4. It opens no port, so no
// other program on the machine can read or drive it. No browser is
// downloaded, and the one started downloads none of its components.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { timeLeft, sleep } = require("./time");
const { NOTHING, SHORT, chromePlace, findChrome, cannotStart, couldNotStart, endedEarly, runnable, worded, ownSandbox, lowLimits } = require("./program");

// The browsers this process has started and not closed yet, each with its
// profile, from the moment it is spawned.
const open = new Set();

// The programs Chrome on Linux hands an address it does not open itself to,
// such as mailto:, news: and snews:, without asking, when it finds no
// desktop portal to hand it to over the session bus: xdg-settings, which it
// asks first whether it is itself the program for such addresses, then
// xdg-email for mailto: and xdg-open for the rest, and the browsers
// xdg-open goes on to. It finds each by its name on PATH. On macOS and
// Windows it asks the system instead.
const HANDLERS = ["xdg-open", "xdg-email", "xdg-settings", "x-www-browser", "www-browser", "sensible-browser"];
const STAND_INS = process.platform !== "darwin" && process.platform !== "win32";

// A path as a D-Bus address writes it: each byte but a letter, a digit and
// -_/.\* as %xx.
const busPath = (file) => Array.from(Buffer.from(file, "utf8"), (byte) => (/[-0-9A-Za-z_/.\\*]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `%${byte.toString(16).padStart(2, "0")}`)).join("");

// A folder in the profile of stand-ins for those programs, which goes first
// on the browser's PATH, so that the system finds them before the real
// ones: each a link to the system's own true, which starts nothing and
// exits with 0. The system runs the file a link leads to, so a temp folder
// mounted noexec runs them too. Where there is no true this user may run,
// each is a link to itself, which the system cannot follow: the search for
// that name ends there, and nothing starts. Gives the folder. A link the
// temp folder's disk does not take, as a FAT or exFAT disk does not, is
// marked (noLinks).
function standIns(profile, made) {
  const dir = path.resolve(profile, "stand-ins");
  made[""].push("stand-ins");
  made["stand-ins"] = HANDLERS;
  fs.mkdirSync(dir);
  const nothing = ["/usr/bin/true", "/bin/true"].find(runnable);
  for (const name of HANDLERS) {
    const at = path.join(dir, name);
    try {
      fs.symlinkSync(nothing || at, at);
    } catch (err) {
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(err.code)) err.noLinks = true;
      throw err;
    }
  }
  return dir;
}

// Whether an address is one the browser does not open as a page but hands
// to a program of the machine, as mailto:, news: or a scheme of an app: any
// with a scheme of its own that is no web address and none of the
// browser's own.
const handedOut = (url) => /^[a-z][a-z0-9+.-]*:/i.test(String(url || "")) && !/^(https?|about|data|blob|javascript|file|filesystem|chrome|chrome-error|chrome-extension|devtools|view-source):/i.test(String(url));

// The world each document of the tab gets before its own scripts run, and
// the guard it runs there: a move to an address that is not a web address,
// by a script, a refresh, a form or a link, that a document the browser
// loaded makes of itself, the page or a frame of it, or that the page makes
// of a frame of its own site that shows such a document, is cancelled before
// the browser acts on it, on every system, and the address is kept for the
// kit's notes. A frame of another site, which runs apart from the page, gets
// it as it is attached to (guardFrames). The page's own scripts cannot reach
// this world. The guard never sees a frame's first address, a frame the page
// makes, or a frame of another site, that the page sends to such an address
// by its script, a frame at about:blank, or made with no address, that the
// page puts a script in, as its first document never gets the guard, the
// move of a frame with no origin of its own, as one at a data: address or a
// sandboxed one, that moves itself, as the browser fires no navigate event
// in such a document, or a redirect: those reach the browser, and no
// DevTools call cancels them. On Linux the browser's stand-ins take those
// (see launch).
const GUARD_WORLD = "easyfontkit-guard";
const GUARD = `(() => {
  if (typeof navigation === "undefined") return;
  const tried = (globalThis.easyfontkitTried = []);
  const web = /^(https?|data|blob|about|javascript):$/i;
  navigation.addEventListener("navigate", (event) => {
    let scheme = "";
    try {
      scheme = new URL(event.destination.url).protocol;
    } catch {}
    if (web.test(scheme) || !event.cancelable) return;
    event.preventDefault();
    if (tried.length < 20) tried.push(String(event.destination.url).slice(0, 300));
  });
})();`;

// The addresses the guard cancelled in the tab's page as it stands now and
// in its frames, read from their worlds: { url, how: "cancelled" } each,
// those of the frames of other sites read through their own sessions
// (cdp.frames). A page the tab has moved on from took its own with it. A
// frame that cannot be asked, as one between two documents, is passed over.
// It takes a few seconds at most, and stops at a call a session does not
// answer, as a page whose own script keeps its thread busy answers none.
async function triedSoFar(cdp) {
  const found = [];
  const until = Date.now() + Math.min(3_000, Math.max(1_000, timeLeft()));
  const left = () => Math.max(1, until - Date.now());
  let asked = 0;
  for (const session of [cdp, ...(cdp.frames || [])]) {
    if (Date.now() >= until) break;
    try {
      const { frameTree } = await session.send("Page.getFrameTree", {}, left());
      const frames = [];
      for (let next = [frameTree]; next.length && frames.length < 20; ) {
        const node = next.shift();
        frames.push(node.frame.id);
        next.push(...(node.childFrames || []));
      }
      for (const frameId of frames) {
        if (Date.now() >= until || asked++ >= 40) break;
        try {
          const { executionContextId } = await session.send("Page.createIsolatedWorld", { frameId, worldName: GUARD_WORLD }, left());
          const { result = {} } = await session.send("Runtime.evaluate", { expression: "(globalThis.easyfontkitTried || []).slice(0, 20)", contextId: executionContextId, returnByValue: true }, left());
          for (const url of Array.isArray(result.value) ? result.value : []) if (typeof url === "string") found.push({ url: url.slice(0, 300), how: "cancelled" });
        } catch (err) {
          if (err.timedOut || err.closed) break;
          // A frame between two documents, gone, or one of another site's
          // that this session does not hold, asked through its own.
        }
      }
    } catch {
      // A session that does not answer, or has closed.
    }
  }
  return found;
}

// The frames of other sites a session's page or frame has, each of which
// runs apart from it, in a process of its own that the page's guard does not
// reach. The browser holds each before it runs anything
// (waitForDebuggerOnStart) and lets it go once it has the guard, which its
// own moves then meet as the page's do; its own frames of other sites are
// held in the same way. The watchers are told of each with its session, on
// which the browser tells what the frame does, its frames' requests too, as
// a redirect of one of them, which only that session tells of; the bodies
// of what it loads are not kept. Anything else held so, as a worker, is let
// go of at once. A frame whose calls fail is let go of too, as it would wait
// for good otherwise, and runs without the guard, as before.
function guardFrames(pipe, session, frames, watchers) {
  session.on("Target.attachedToTarget", ({ sessionId, targetInfo = {}, waitingForDebugger }) => {
    let frame;
    try {
      frame = pipe.session(sessionId);
    } catch {
      return;
    }
    const go = () => (waitingForDebugger ? frame.send("Runtime.runIfWaitingForDebugger", {}, 5_000).catch(() => {}) : Promise.resolve());
    if (targetInfo.type !== "iframe") return void go().then(() => frame.close());
    frames.add(frame);
    for (const watch of watchers) watch(frame);
    guardFrames(pipe, frame, frames, watchers);
    Promise.allSettled([
      frame.send("Page.enable", {}, 5_000),
      frame.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, 5_000),
      frame.send("Page.addScriptToEvaluateOnNewDocument", { source: GUARD, worldName: GUARD_WORLD }, 5_000),
      frame.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, 5_000),
    ]).then(go);
  });
  session.on("Target.detachedFromTarget", ({ sessionId }) => {
    for (const frame of frames) {
      if (frame.id !== sessionId) continue;
      frames.delete(frame);
      frame.close();
    }
  });
}

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
function removeProfile({ profile, singleton, made }, maxRetries, retryDelay) {
  for (const [folder, names] of [
    [profile, made],
    [singleton, {}],
  ]) {
    if (!folder) continue;
    try {
      fs.rmSync(folder, { recursive: true, force: true, maxRetries, retryDelay });
    } catch {
      removeTree(folder, names);
    }
  }
}

// A folder removed with one file descriptor at a time: rmSync holds one for
// each level of it, which a process short of them, as one that could not
// start the browser for want of them, may not have, and a start that failed
// for want of them can hold the last one for a moment. A folder that cannot
// be listed at all loses by name what easyfontkit made there (`made`, the
// names it made in each folder, by the folder's path in the profile). What
// still cannot be removed is left for the system's temp clean-up.
function removeTree(folder, made = {}, at = "") {
  let names;
  try {
    names = fs.readdirSync(path.join(folder, at));
  } catch (err) {
    if (err.code === "ENOENT") return;
    names = made[at] || [];
  }
  for (const name of names) {
    const entry = path.join(at, name);
    let stat;
    try {
      stat = fs.lstatSync(path.join(folder, entry));
    } catch {
      continue;
    }
    try {
      if (stat.isDirectory()) removeTree(folder, made, entry);
      else fs.unlinkSync(path.join(folder, entry));
    } catch {
      // Left for the system's temp clean-up.
    }
  }
  try {
    fs.rmdirSync(path.join(folder, at));
  } catch {
    // Not empty, or gone.
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
// with the run's, so more of it can help, unless a limit of this process's
// leaves the browser few files or processes, which is said then.
function tooSlow(name, what, wait) {
  return new Error(`${name} did not ${what} in ${Math.round(wait / 1000)} s, so no kit was made. ${lowLimits() || "The machine may be busy; try again, or give it more time with --timeout."}`);
}

// A browser that stopped answering once it had started: a call that got no
// answer in its time (timedOut), or a pipe to it that failed or closed
// (closed), as when it has quit. A call cut short by the end of the run's
// time says that. A limit of this process's that leaves the browser few
// files or processes, as one that ran short of them can quit while it
// opens the page, is said in place of the busy machine. Any other error is
// given back as it is.
function stoppedAnswering(name, err) {
  if (!err || !(err.timedOut || err.closed)) return err;
  if (err.timedOut && err.outOfTime) return new Error(`${name} did not answer before the run's time ran out, so no kit was made. The machine may be busy; try again, or give it more time with --timeout.`);
  return new Error(`${name} stopped answering, so no kit was made. ${lowLimits() || "The machine may be busy; try again."}`);
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

// Chrome writes the first bytes of a file a page starts to download before
// it refuses the download (below), in a hidden file in the user's Downloads
// folder, and removes it a moment later: a run stopped in that moment would
// leave it there. On Linux and the other systems that name that folder as
// xdg-user-dirs does, in user-dirs.dirs in the config folder
// (XDG_CONFIG_HOME, ~/.config by default), the browser is given a config
// folder in its profile, whose user-dirs.dirs names a Downloads folder in
// the profile, which goes with it. That folder links to every other entry
// of the user's own config folder, so the browser reads the user's font,
// proxy and other settings as before. The links are removed with the
// profile, and what they lead to stays. Gives what to add to the browser's
// environment, and keeps the names it makes in `made`, by the folder's path
// in the profile.
function downloadsIn(profile, made) {
  if (process.platform === "darwin" || process.platform === "win32") return {};
  const config = path.resolve(profile, "config");
  const downloads = path.resolve(profile, "Downloads");
  made[""].push("config", "Downloads");
  made.config = ["user-dirs.dirs"];
  fs.mkdirSync(config);
  fs.mkdirSync(downloads);
  const given = process.env.XDG_CONFIG_HOME;
  const own = path.resolve(given && path.isAbsolute(given) ? given : path.join(process.env.HOME || os.homedir(), ".config"));
  let names = [];
  try {
    names = fs.readdirSync(own);
  } catch {
    // None, or not to be read: there is nothing to keep.
  }
  for (const name of names) {
    if (name === "user-dirs.dirs") continue;
    made.config.push(name);
    try {
      fs.symlinkSync(path.join(own, name), path.join(config, name));
    } catch {
      // Left out.
    }
  }
  // The path in quotes, with a backslash before a quote, a backslash, a $
  // or a backquote, as the file is read.
  fs.writeFileSync(path.join(config, "user-dirs.dirs"), `XDG_DOWNLOAD_DIR="${downloads.replace(/["\\$`]/g, (c) => `\\${c}`)}"\n`);
  return { XDG_CONFIG_HOME: config };
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
// ends. The DevTools protocol goes over a pipe, file descriptors 3 and 4,
// and not over a port: any program on the machine that found a port could
// read the page the browser shows and drive it, as another user's job can on
// a server that runs several at a time.
//
// A browser that cannot be started stops the run before anything is made,
// with the path CHROME_PATH or the search for one gave: a path the browser
// is not at, or one that names no program this user may run, as a folder or
// a file on a noexec mount, is told before it is started, with what is
// wrong with it; one the system could not start at all, with the system's
// own reason; and one that ended before it answered, with what it printed
// and how it ended. The system can also be short of what it takes to start
// one, as file descriptors.
async function launch({ width, height }) {
  const place = chromePlace();
  if (!place) throw new Error(NOTHING);
  if (place.what) throw new Error(cannotStart(place));
  const { file: binary, name } = place;
  const variable = process.platform === "win32" ? "TEMP" : "TMPDIR";
  // The temp folder by its whole path: a relative TMPDIR names a folder in
  // the one easyfontkit was started in, and the stand-ins' folder in it goes
  // on the browser's PATH by its whole path (see below). One in a folder
  // that was removed before the run started, as from another shell, names
  // none.
  let temp;
  try {
    temp = path.resolve(os.tmpdir());
  } catch {
    throw new Error(`${name} did not start: easyfontkit could not make the browser's profile in ${os.tmpdir()}, as the folder the run was started in is gone. Set ${variable} to the full path of a folder this user may write in, with room to spare.`);
  }
  // The folders of PATH are parted by its delimiter, so the folder of
  // stand-ins in a temp folder whose path has one in it could not come first
  // on the browser's PATH, and the browser would find the real programs.
  // Such a run starts nothing. The stand-ins' folder is looked at again as
  // it goes on PATH, so no other way to it can bring one in.
  const parted = (what, folder) => new Error(`${name} did not start: ${what}, ${folder}, has a ${path.delimiter} in it, which parts the folders of PATH, so the stand-ins that keep a site from starting a program of this machine could not come first on the browser's PATH. Set TMPDIR to a folder whose path has none.`);
  if (STAND_INS && temp.includes(path.delimiter)) throw parted("the temp folder's path", temp);
  // A profile that cannot be made, as in a temp folder that is not there, may
  // not be written in or is full, or for want of file descriptors, stops the
  // run before the browser is started, and so do stand-ins the temp folder's
  // disk takes no links for.
  const unmade = (err) => {
    if (SHORT[err.code]) return new Error(`${name} did not start: easyfontkit could not make the browser's profile in ${temp}, as ${SHORT[err.code]}.`);
    if (err.noLinks) return new Error(`${name} did not start: the stand-ins that keep a site from starting a program of this machine are links, and the disk of the temp folder ${temp} takes none (${worded(err)}). Set ${variable} to a folder on a disk that takes links.`);
    return new Error(`${name} did not start: easyfontkit could not make the browser's profile in ${temp} (${worded(err)}). Set ${variable} to a folder this user may write in, with room to spare.`);
  };
  let fresh;
  try {
    fresh = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-chrome-"));
  } catch (err) {
    throw unmade(err);
  }
  const { profile, env = process.env, ...where } = tempOf(fresh);
  const started = { child: null, profile, singleton: "", crashHandler: null, made: { "": [] } };
  // A site can send the browser to mailto:, news: or snews:, which Chrome on
  // Linux hands on without asking: over the session bus to the desktop's
  // portal, which opens it with the user's own mail program, and with no
  // portal to ask, to a program of the machine it finds through PATH, as the
  // user who runs the kit, or on a server that runs the kit for others,
  // xdg-open as its user, with what the site wrote in the address. So the
  // browser gets a session bus where nothing listens, a socket in its
  // profile that is never made (unset, the bus is looked for in
  // XDG_RUNTIME_DIR, where the desktop's is), no display, as it draws on
  // none and a program it starts could open a window there: no DISPLAY, and
  // a Wayland display that is a socket in its profile that is never made
  // (unset, a Wayland program looks for the desktop's in XDG_RUNTIME_DIR
  // too), and the stand-ins first on its PATH, the rest of PATH as it was.
  // On macOS and Windows the browser asks the system, and the guard each
  // page gets (openPage) is what holds there.
  let config;
  let standing = "";
  try {
    config = downloadsIn(profile, started.made);
    if (STAND_INS) {
      standing = standIns(profile, started.made);
      config.PATH = [standing, process.env.PATH || "/usr/bin:/bin"].join(path.delimiter);
      config.DBUS_SESSION_BUS_ADDRESS = `unix:path=${busPath(path.resolve(profile, "no-bus"))}`;
    }
  } catch (err) {
    removeProfile(started, 10, 100);
    throw unmade(err);
  }
  if (standing.includes(path.delimiter)) {
    removeProfile(started, 10, 100);
    throw parted("the path of the stand-ins' folder", standing);
  }
  const browserEnv = { ...env, ...config, BREAKPAD_DUMP_LOCATION: path.resolve(profile, "Crash Reports") };
  if (STAND_INS) {
    delete browserEnv.DISPLAY;
    delete browserEnv.WAYLAND_SOCKET;
    browserEnv.WAYLAND_DISPLAY = path.resolve(profile, "no-display");
  }
  let child;
  try {
    child = spawn(
      binary,
      [
        "--headless=new",
        "--remote-debugging-pipe",
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
      { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"], ...where, env: browserEnv },
    );
  } catch (error) {
    // Node gives some errors at once, as for a path that changed since it
    // was looked at and now goes round a loop of links.
    removeProfile(started, 10, 100);
    throw new Error(couldNotStart(place, error));
  }
  started.child = child;
  open.add(started);
  let exited = false;
  let failure = null;
  let code = null;
  let signal = null;
  const ended = new Promise((resolve) => {
    child.on("exit", (status, stoppedBy) => {
      code = status;
      signal = stoppedBy;
      resolve();
    });
    child.on("error", (error) => {
      failure = failure || error;
      resolve();
    });
  }).then(() => (exited = true));
  // What the browser prints, the first 8 KB of its output and of its error
  // output: a browser that ends before it answers often says why there, as
  // the system's loader names a library it did not find, a script's shell
  // or env a program it could not start, and Chrome why its sandbox could
  // not start. The rest is read and let go, so the browser never waits to
  // write it.
  const printed = (stream) => {
    const kept = [];
    let bytes = 0;
    if (stream) {
      stream.on("data", (chunk) => {
        if (bytes < 8_192) kept.push(chunk.subarray(0, 8_192 - bytes));
        bytes += chunk.length;
      });
      stream.on("error", () => {});
    }
    return () => Buffer.concat(kept).toString("utf8");
  };
  const stdout = printed(child.stdout);
  const stderr = printed(child.stderr);
  // With no file descriptor left, Node makes no pipes, and says why a
  // moment later.
  if (!child.stdio || !child.stdio[3] || !child.stdio[4]) {
    await ended;
    open.delete(started);
    removeProfile(started, 10, 100);
    throw new Error(failure ? couldNotStart(place, failure) : `${name} did not start: easyfontkit could not make the pipes it drives the browser through.`);
  }
  const pipe = connect(child.stdio[3], child.stdio[4]);
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
    if (!exited && !pipe.lost) {
      // One that does not take the request in three seconds is not
      // answering: it is killed below, at once.
      const asked = await pipe.send("Browser.close", {}, 3_000).then(
        () => true,
        (err) => !err.timedOut,
      );
      for (let i = 0; i < 50 && asked && !exited; i++) await sleep(100);
    }
    if (!exited) child.kill("SIGKILL");
    for (let i = 0; i < 20 && !exited; i++) await sleep(100);
    pipe.close();
    endAll(processes, profile);
    if (child.stdout) child.stdout.destroy();
    if (child.stderr) child.stderr.destroy();
    open.delete(started);
    started.singleton = started.singleton || singletonOf(profile);
    removeProfile(started, 10, 100);
  };
  // A page cannot make the browser save a file: a download it starts, by a
  // link, a script or a frame that goes to an attachment, is refused, and the
  // page stays where it is. The first bytes Chrome writes before it refuses
  // it go into a folder in its profile on Linux (downloadsIn), and go with
  // the profile. The refusal is the first thing said on the pipe, to the
  // whole browser, and it holds until the browser has ended: Chrome forgets
  // it only when the connection that said it closes, and the pipe closes with
  // the browser. The browser has started once it answers, and it has the time
  // a browser has to start for that: one that does not answer in it ends the
  // run, as a slow one could go on to open the page with nothing said. The
  // time is told by the clock, as on a busy machine a wait takes longer than
  // it asks. A browser that answers that it does not take it is not used, as
  // a page could save files through it.
  const wait = beforeReading();
  const how = await Promise.race([
    pipe.send("Browser.setDownloadBehavior", { behavior: "deny" }, wait).then(
      () => "started",
      (err) => (err.timedOut ? "slow" : err.closed ? "quit" : { refused: err.message }),
    ),
    ended.then(() => "quit"),
  ]);
  if (how !== "started") {
    // How it ended, and all it printed as it ended, a second at most: a
    // pipe can close a moment before the browser ends, and helpers it
    // started can hold its output open.
    let byItself = exited;
    if (how === "quit") {
      let timer;
      const closing = [child.stdout, child.stderr].filter((stream) => stream && !stream.closed).map((stream) => new Promise((resolve) => stream.once("close", resolve)));
      await Promise.race([Promise.all([ended, ...closing]), new Promise((resolve) => (timer = setTimeout(resolve, 1_000)))]);
      clearTimeout(timer);
      byItself = exited;
    }
    await close();
    // One that quit did not start; one still starting is slow.
    if (how === "quit") throw new Error(failure ? couldNotStart(place, failure) : endedEarly(place, { stderr: stderr(), stdout: stdout(), code, signal, closed: !byItself }));
    if (how === "slow") throw tooSlow(name, "start", wait);
    throw new Error(`${name} cannot be told to refuse the downloads a page starts (${how.refused}), so no kit was made: a site could save files on this machine through it. Point CHROME_PATH at another browser.`);
  }
  started.singleton = singletonOf(profile);
  // Known from the start: by the time the browser is stopped, its helpers
  // can have ended.
  const processes = processesOf(child);
  started.crashHandler = crashHandlerOf(processes);
  // sandboxed: a browser that runs in a sandbox of its own, as one
  // installed as a snap or a Flatpak does, also when a launcher by another
  // name started it, which may not take the stand-ins or the bus it was
  // started with.
  return { name, pipe, close, sandboxed: ownSandbox(binary, processes.map(({ pid }) => pid)) };
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

// The browser answers what is asked of the browser itself in a few
// milliseconds, also on a busy machine. One that takes longer than this was
// held still, as a machine under heavy load can hold it.
const HELD_STILL = 2_000;

// What says the pipe to the browser has closed, as when the browser has
// quit.
const closedPipe = () => Object.assign(new Error("The browser connection closed."), { closed: true });

// The connection to a browser over the pipe it was started with: the
// browser reads what it is asked from one end (input) and writes its
// answers and events to the other (output), each message JSON ended by a
// NUL byte. The pipe carries what is said to the browser itself and, each
// in a session of its own, what is said to its tabs. Gives the browser's
// own session, whose session() gives a tab's. What says that the browser
// has stopped answering (timedOut), or that the pipe has closed (closed),
// holds for all of them once either has happened: every call waiting then
// fails with it, and every call after it fails at once.
function connect(input, output) {
  const pending = new Map();
  const listeners = new Map();
  let nextId = 0;
  let lost = null;
  const lose = (err) => {
    lost = lost || err;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(lost);
    }
    pending.clear();
  };
  const write = (id, method, params, sessionId) => {
    if (!input.writable) return void lose(closedPipe());
    input.write(`${JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })}\0`);
  };
  const receive = (text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg) return;
    if (msg.method) {
      const own = listeners.get(msg.sessionId || "");
      for (const listener of (own && own.get(msg.method)) || []) listener(msg.params || {});
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    clearTimeout(waiter.timer);
    if (msg.error) waiter.reject(new Error(msg.error.message || "DevTools protocol error"));
    else waiter.resolve(msg.result || {});
  };
  // A message can come in several pieces, and a piece can hold several.
  let pieces = [];
  output.on("data", (chunk) => {
    let start = 0;
    for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
      pieces.push(chunk.subarray(start, end));
      start = end + 1;
      const text = Buffer.concat(pieces).toString("utf8");
      pieces = [];
      receive(text);
    }
    if (start < chunk.length) pieces.push(chunk.subarray(start));
  });
  output.on("close", () => lose(closedPipe()));
  output.on("error", () => lose(closedPipe()));
  input.on("error", () => lose(closedPipe()));
  // A call that gets no answer in the time given says so (timedOut).
  const call = (method, params, wait) =>
    new Promise((resolve, reject) => {
      if (lost) return void reject(lost);
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`${method} timed out`), { timedOut: true }));
      }, wait);
      pending.set(id, { resolve, reject, timer, sessionId: "" });
      write(id, method, params, "");
    });
  // Whether the browser itself still answers, asked on the pipe when a call
  // to a tab got no answer in its time, and how long its answer took: the
  // milliseconds, or null when it gave none. The browser answers
  // Browser.getVersion by itself, whatever the page or its server does, in
  // a few milliseconds also on a busy machine: any answer will do, an error
  // too. It has ten seconds for that, or what is left of the run's time when
  // that is less, a second at least, as a busy machine can hold it still for
  // a while. None in that time, or a pipe that closes, says it has stopped
  // answering. Calls that run out together share one question, and each is
  // told how long it took.
  let asking = null;
  const answers = () => {
    if (!asking) {
      const asked = Date.now();
      asking = call("Browser.getVersion", {}, Math.max(1_000, Math.min(10_000, timeLeft())))
        .then(
          () => Date.now() - asked,
          (err) => (err.timedOut || err.closed ? null : Date.now() - asked),
        )
        .finally(() => (asking = null));
    }
    return asking;
  };
  const session = (sessionId) => {
    const own = new Map();
    listeners.set(sessionId, own);
    let ended = false;
    let crashed = null;
    let onCrash;
    const crashing = new Promise((resolve) => (onCrash = resolve));
    return {
      id: sessionId,
      // A call that gets no answer in its time says so (timedOut), and
      // whether the end of the run's time cut that short (outOfTime). One on
      // a pipe that has closed fails at once (closed), where it would wait
      // out its time for an answer that cannot come, and so does one once
      // the browser has stopped answering. A call to the browser itself,
      // and a call of the browser's own (Browser.*), that gets no answer
      // says that by itself; for one to a tab, the browser is asked first,
      // so a page or a server that does not answer is not taken for the
      // browser, and the call's own answer is still taken while the browser
      // is asked. When the browser answers within two seconds, the call
      // fails, as one the page or its server did not answer. When it takes
      // longer, it was held still itself, and the call can have run out for
      // that alone: the browser still has the call and answers it once it
      // goes on, so the call gets its wait again, cut to what is left of the
      // run's time, and the run goes on with its answer. It is not sent
      // again: the browser would do it twice, and Chrome answers a page
      // opened a second time that way with net::ERR_ABORTED. Still
      // unanswered after its second wait, the call fails in the same way, or
      // as the browser's when the browser does not answer either.
      send(method, params = {}, timeoutMs = 30_000) {
        if (lost) return Promise.reject(lost);
        if (crashed) return Promise.reject(crashed);
        if (ended) return Promise.reject(closedPipe());
        return new Promise((resolve, reject) => {
          const id = ++nextId;
          const waiter = { resolve, reject, timer: null, sessionId };
          let waitedAgain = false;
          const wait = () => {
            const given = Math.max(1_000, Math.min(timeoutMs, timeLeft()));
            waiter.timer = setTimeout(async () => {
              if (!pending.has(id)) return;
              const err = Object.assign(new Error(`${method} timed out`), { timedOut: true, outOfTime: given < timeoutMs });
              const took = !sessionId || method.startsWith("Browser.") ? null : await answers();
              // Answered meanwhile, or failed with the rest.
              if (!pending.has(id)) return;
              if (took === null) return void lose(err);
              if (took > HELD_STILL && !waitedAgain) {
                waitedAgain = true;
                return void wait();
              }
              pending.delete(id);
              reject(err);
            }, given);
          };
          pending.set(id, waiter);
          wait();
          write(id, method, params, sessionId);
        });
      },
      on(method, listener) {
        own.set(method, [...(own.get(method) || []), listener]);
      },
      // A tab whose page crashed, as the system ends a page's process when
      // the machine, or a job held to a memory limit, runs out of memory:
      // its calls still waiting fail with err at once (crashed), and so does
      // every call after it, as none of them can be answered, where each
      // would wait out its time. crashing settles with err then.
      crash(err) {
        if (crashed || !sessionId) return;
        crashed = err;
        for (const [id, waiter] of pending) {
          if (waiter.sessionId !== sessionId) continue;
          pending.delete(id);
          clearTimeout(waiter.timer);
          waiter.reject(err);
        }
        onCrash(err);
      },
      get crashed() {
        return crashed;
      },
      crashing,
      // A tab's session is let go of, and its calls still waiting fail
      // (closed); the browser's own closes the pipe.
      close() {
        if (ended) return;
        ended = true;
        listeners.delete(sessionId);
        if (!sessionId) {
          lose(closedPipe());
          input.destroy();
          output.destroy();
          return;
        }
        for (const [id, waiter] of pending) {
          if (waiter.sessionId !== sessionId) continue;
          pending.delete(id);
          clearTimeout(waiter.timer);
          waiter.reject(closedPipe());
        }
        if (!lost) write(++nextId, "Target.detachFromTarget", { sessionId }, "");
      },
      // The browser stopped answering (timedOut), or the pipe closed
      // (closed), when either has happened; null until then.
      get lost() {
        return lost;
      },
    };
  };
  const browser = session("");
  // The session a tab was given when it was attached to.
  browser.session = (sessionId) => {
    if (!sessionId) throw new Error("The browser gave its tab no session.");
    return session(sessionId);
  };
  return browser;
}

// A new tab, set to a desktop screen of the given size, in the browser
// launch() gave, with a session of its own on the browser's pipe, opened in
// the time a browser has for that, and with the guard in each document it
// shows. Headless Chrome says "HeadlessChrome" in its user agent, and some
// sites answer that with a stripped page; the tab says "Chrome", as the
// same browser with a window would.
async function openPage({ pipe, name }, { width, height }) {
  const wait = beforeReading();
  const until = Date.now() + wait;
  const left = () => Math.max(1_000, until - Date.now());
  let cdp;
  try {
    const { targetId } = await pipe.send("Target.createTarget", { url: "about:blank" }, wait);
    const { sessionId } = await pipe.send("Target.attachToTarget", { targetId, flatten: true }, left());
    cdp = pipe.session(sessionId);
    await cdp.send("Page.enable", {}, left());
    // A page that crashes ends the run at once (crash), as no call to it
    // gets an answer. A browser that does not take the call goes on
    // without, as before.
    cdp.on("Inspector.targetCrashed", () => cdp.crash(Object.assign(new Error("The browser's page crashed."), { crashed: true })));
    await cdp.send("Inspector.enable", {}, left()).catch((err) => {
      if (err.timedOut || err.closed) throw err;
    });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: GUARD, worldName: GUARD_WORLD }, left());
    // The frames of other sites, each with the guard: cdp.frames holds their
    // sessions, and cdp.onFrame(watch) tells watch of each, those attached
    // already and those to come. A browser that does not take the call goes
    // on without, as before.
    const frames = new Set();
    const watchers = [];
    cdp.frames = frames;
    cdp.onFrame = (watch) => {
      watchers.push(watch);
      for (const frame of frames) watch(frame);
    };
    guardFrames(pipe, cdp, frames, watchers);
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, left()).catch((err) => {
      if (err.timedOut || err.closed) throw err;
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, left());
    const { userAgent = "" } = await pipe.send("Browser.getVersion", {}, left()).catch((err) => {
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
  await Promise.race([loaded, late, cdp.crashing || late]);
  clearTimeout(timer);
  if (cdp.crashed) throw cdp.crashed;
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

module.exports = { findChrome, launch, killBrowsers, connect, openPage, stoppedAnswering, navigate, currentAddress, triedSoFar, handedOut, GUARD_WORLD, STAND_INS, HANDLERS };
