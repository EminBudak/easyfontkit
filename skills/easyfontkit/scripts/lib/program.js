"use strict";

// The browser's program: where it is, as a shell would find it, and what
// is certain about one that cannot be started. Before it is started, its
// path is looked at with the checks whose answer is certain: nothing there,
// a folder, a link that leads to nothing or round a loop, a path through a
// file or a folder this user may not enter, a file this user may not run,
// as on a disk mounted noexec, and an empty file. What a browser that
// passes them does is told by the system's own words when it could not be
// started at all, or by what it printed and how it ended when it ended
// before it answered: never guessed from what the file holds, nor from
// which program the words of a script that starts it name.

const fs = require("fs");
const path = require("path");
const { getSystemErrorMap } = require("util");

const WINDOWS = process.platform === "win32";

const MAC = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];
const LINUX = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
const WINDOWS_PLACES = [
  ["PROGRAMFILES", "Google\\Chrome\\Application\\chrome.exe"],
  ["PROGRAMFILES(X86)", "Google\\Chrome\\Application\\chrome.exe"],
  ["LOCALAPPDATA", "Google\\Chrome\\Application\\chrome.exe"],
  ["PROGRAMFILES(X86)", "Microsoft\\Edge\\Application\\msedge.exe"],
  ["PROGRAMFILES", "Microsoft\\Edge\\Application\\msedge.exe"],
];

// The first words of the message that says no browser was found, as the
// kit wrote it before, and that message whole, for a search that found
// nothing at all. A message for a browser that was found and did not start
// starts with its name and "did not start", as before. Both are written out
// whole, as what reads the kit's messages looks for them in its code.
const NONE = "No Chrome, Chromium, Edge or Brave found";
const NOTHING = "No Chrome, Chromium, Edge or Brave found. Install one, or point CHROME_PATH at its binary.";
// How to get a browser that runs: for one CHROME_PATH names, and for one
// found on this machine.
const FIX = {
  named: "Point CHROME_PATH at the program of a Chrome, Chromium, Edge or Brave that runs, or unset it and install one.",
  found: "Install Chrome, Chromium, Edge or Brave, or point CHROME_PATH at the program of one that runs.",
};
// What lets Chrome's sandbox start, said when the browser said it could not
// start one, in words that hold whichever way it could not: in a container
// whose seccomp keeps a user who is not root from making namespaces, in a
// build whose setuid helper is not set up, or in one that has no helper and
// that the system keeps from making user namespaces, as AppArmor does on
// Ubuntu 23.10 and later for a browser it has no rule for.
const SANDBOX = "Its sandbox could not start here: a container has to allow it, as Docker does with --security-opt seccomp=unconfined, and a build copied or unpacked by hand can lack the setup that Google Chrome's own package gives it.";

// A name with no folder in it, which is looked up on PATH.
const bare = (value) => !(value.includes("/") || (WINDOWS && value.includes("\\")));

// A path made whole from the folder easyfontkit was started in, so the
// browser is found also when it is started in another folder. path.resolve
// works out a .. by its letters, while the system goes up from wherever a
// link on the way leads, so a path with a .. in it keeps it. Windows goes by
// the letters too.
function whole(name) {
  if (WINDOWS || !name.split("/").includes("..")) return path.resolve(name);
  return path.isAbsolute(name) ? name : `${process.cwd()}/${name}`;
}

// The system's words for an error, as "too many symbolic links
// encountered", else its code.
const worded = (err) => (getSystemErrorMap().get(err.errno) || [])[1] || err.code || String(err.message || err);

// A file this user may run, as a shell would take one: a file, not a
// folder, with the permission to run it. On Windows that permission is not
// looked at, and any file passes.
function runnable(file) {
  try {
    if (!WINDOWS) fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Whether anything is at a path, a link that leads nowhere too.
function there(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

// On PATH, the first program by a name that this user may run, as a shell
// finds it, and the first thing by that name that is none, such as a
// folder or a file without the permission to run it, which a shell passes
// over: { file, other }, each "" when there is none. A folder of PATH given
// from the current folder is taken from the folder easyfontkit was started
// in, and an empty entry, which some shells read as the current folder, is
// passed over.
function lookOnPath(name) {
  let other = "";
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const at = whole(dir);
    const file = `${at}${at.endsWith(path.sep) ? "" : path.sep}${name}`;
    if (runnable(file)) return { file, other };
    if (!other && there(file)) other = file;
  }
  return { file: "", other };
}

// Where a link leads, as a whole path.
function target(link) {
  try {
    return path.resolve(path.dirname(link), fs.readlinkSync(link));
  } catch {
    return link;
  }
}

function real(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

// What keeps the system from looking at a path, on the way to it: a file
// where a folder should be, { file }, or a folder this user may not enter,
// { folder }. null when neither does.
function inTheWay(file) {
  const chain = [];
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    chain.unshift(dir);
    if (path.dirname(dir) === dir) break;
  }
  for (const dir of chain) {
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      return null;
    }
    if (!stat.isDirectory()) return { file: dir };
    if (WINDOWS) continue;
    try {
      fs.accessSync(dir, fs.constants.X_OK);
    } catch {
      return { folder: dir };
    }
  }
  return null;
}

// The point a file system that runs no program is mounted at, when `file`
// is on one (mounted noexec, as /tmp and /dev/shm are on some servers).
// Read from /proc/self/mountinfo, so on Linux only; "" elsewhere, and when
// the file system runs programs.
function noexecMount(file) {
  if (process.platform !== "linux") return "";
  let info;
  try {
    info = fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return "";
  }
  const at = real(file);
  let found = null;
  for (const line of info.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 7) continue;
    // A space, a tab, a line break or a backslash in a mount point is
    // written as \040, \011, \012 and \134.
    const point = fields[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    const inside = at === point || at.startsWith(point.endsWith("/") ? point : `${point}/`);
    // The deepest mount point holds the file; of two at one point, the one
    // mounted last, which comes last.
    if (inside && (!found || point.length >= found.point.length)) found = { point, noexec: fields[5].split(",").includes("noexec") };
  }
  return found && found.noexec ? found.point : "";
}

// What is wrong with a path that names nothing the system could start, as
// words that follow it after a comma, with none set: the browser was not
// found there.
function unreachable(file, err) {
  const none = (what) => ({ what, none: true });
  const way = ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(err.code) ? inTheWay(file) : null;
  if (way && way.file) return none(`and there is no file there, as ${way.file} is a file, not a folder`);
  if (way && way.folder) return none(`in ${way.folder}, a folder this user may not enter`);
  if (err.code === "ENOENT" || err.code === "ENOTDIR") return none("and there is no file there");
  if (err.code === "ELOOP") return none("a path that goes round a loop of links");
  if (err.code === "ENAMETOOLONG") return none("a path longer than the system takes");
  return none(`a path the system cannot look at (${worded(err)})`);
}

// What keeps a path from being a program this user may run, looked at as
// the system would, through links and with this user's permissions: {
// what, none }, `what` being words that follow the path after a comma, as
// "a folder, not a program", and `none` set when nothing is there to start.
// An empty `what` when nothing does: the file may still not start, which
// only starting it shows.
function look(file, depth = 0) {
  let link;
  try {
    link = fs.lstatSync(file);
  } catch (err) {
    return unreachable(file, err);
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (err.code === "ELOOP") return { what: "a link in a loop of links, which leads to no file", none: true };
    const to = target(file);
    if (err.code === "ENOENT" && !there(to)) return { what: `a link to ${to}, where there is no file`, none: true };
    const why = depth < 8 && to !== file ? look(to, depth + 1) : { what: "", none: true };
    return { what: `a link to ${to}, ${why.what || "which leads to no file"}`, none: why.none };
  }
  if (stat.isDirectory()) return { what: link.isSymbolicLink() ? `a link to the folder ${real(file)}, not to a program` : "a folder, not a program", none: false };
  if (!stat.isFile()) return { what: `${stat.isFIFO() ? "a named pipe" : stat.isSocket() ? "a socket" : "a device"}, not a program`, none: false };
  if (!WINDOWS) {
    try {
      fs.accessSync(file, fs.constants.X_OK);
    } catch {
      if (!(stat.mode & 0o111)) return { what: "a file without the permission to run it, which chmod +x gives", none: false };
      const mount = noexecMount(file);
      if (mount) return { what: `a file on ${mount}, which is mounted noexec, so no program on it may run`, none: false };
      // The bit that counts for this user: the owner's, the group's or
      // everyone else's. Where it is set, something else refuses it, as an
      // ACL or the system's security rules.
      const bit = process.getuid && stat.uid === process.getuid() ? 0o100 : process.getgroups && (process.getgroups().includes(stat.gid) || stat.gid === process.getgid()) ? 0o010 : 0o001;
      return { what: stat.mode & bit ? "a file this user may not run" : "a file this user may not run, as only other users have the permission to run it", none: false };
    }
  }
  // The system would take an empty file for a script with nothing in it,
  // which ends at once and well.
  if (stat.size === 0) return { what: "an empty file, not a program", none: false };
  return { what: "", none: false };
}

// Where this run's browser is: { file, name, value, where, what, none }, or
// null when there is none at all. `value` is what CHROME_PATH holds when it
// is set, which names the browser by its path or, as a shell would take it,
// by a name on PATH. Else the browser is looked for where macOS and Windows
// install it, and on Linux on PATH by each of its names: the first this
// user may run, or the first thing by such a name, to say what is wrong
// with it. `where` says where it was found then. `what` says what keeps it
// from being a program this user may run, "" when nothing does, and `none`
// that nothing is there to start.
function chromePlace() {
  const value = process.env.CHROME_PATH;
  if (value) {
    if (bare(value)) {
      const found = lookOnPath(value);
      const exe = WINDOWS && !found.file ? lookOnPath(`${value}.exe`) : { file: "", other: "" };
      const file = found.file || exe.file || found.other || exe.other;
      if (!file) return { file: "", name: value, value, what: "and no program by that name is on your PATH", none: true };
      return { file, name: path.basename(file), value, ...look(file) };
    }
    const file = whole(value);
    return { file, name: path.basename(file), value, ...look(file) };
  }
  const installed = (file) => ({ file, name: path.basename(file), where: "installed on this machine", ...look(file) });
  if (process.platform === "darwin") {
    const file = MAC.find((place) => fs.existsSync(place));
    return file ? installed(file) : null;
  }
  if (WINDOWS) {
    for (const [root, rest] of WINDOWS_PLACES) {
      const file = process.env[root] ? path.join(process.env[root], rest) : "";
      if (file && fs.existsSync(file)) return installed(file);
    }
    return null;
  }
  let other = null;
  for (const name of LINUX) {
    const seen = lookOnPath(name);
    if (seen.file) return { file: seen.file, name, where: "on your PATH", ...look(seen.file) };
    if (!other && seen.other) other = { file: seen.other, name, where: "on your PATH", ...look(seen.other), none: true };
  }
  return other;
}

// The browser to start: its path, or "" when there is none this user may
// run.
function findChrome() {
  const place = chromePlace();
  return place && !place.what ? place.file : "";
}

// The message for a browser that cannot be started, `what` being what is
// wrong with it: the path CHROME_PATH or the search gave, what is wrong
// with it, and how to get one that runs. It starts as the kit's messages
// did before: none was found, or the one found did not start.
function cannotStart(place, what = place.what) {
  const lead = place.none ? NONE : `${place.name} did not start`;
  if (place.value !== undefined) {
    const at = bare(place.value) && place.file ? `, found on your PATH at ${place.file}` : "";
    return `${lead}: CHROME_PATH is ${place.value}${at}, ${what}. ${FIX.named}`;
  }
  // A file that was found is there, unless it went since.
  const is = what.startsWith("and ") ? `gone: ${what.slice(4)}` : what;
  return `${lead}: ${place.file}, the ${place.name} ${place.where}, is ${is}. ${FIX.found}`;
}

// The message for a browser that was there to start and did not start:
// `what` says what happened to it, in words that follow "which" or its
// path, as "ended before it answered: ...", and `more` comes before the
// words that say how to get one that runs, or `fix`, what to do in their
// place.
function didNotStart(place, what, more = "", fix = "") {
  const at = place.value !== undefined ? `CHROME_PATH is ${place.value}${bare(place.value) && place.file ? `, found on your PATH at ${place.file}` : ""}, which ${what}` : `${place.file}, the ${place.name} ${place.where}, ${what}`;
  return `${place.name} did not start: ${at}.${more ? ` ${more}` : ""} ${fix || (place.value !== undefined ? FIX.named : FIX.found)}`;
}

// The errors that say the system is short of something to start a program
// with, not that the browser is wrong, and what to do.
const SHORT = {
  EMFILE: "this process has as many files open as it may (too many open files). Raise that limit, as ulimit -n does, and run it again",
  ENFILE: "the system has as many files open as it may (file table overflow). Run it again once fewer are open",
  EAGAIN: "the system starts no more processes for this user now (resource temporarily unavailable). Run it again once fewer are running",
  ENOMEM: "the system has no memory left to start it. Run it again once more is free",
};

// A line a program printed, in quotes, as it printed it, with its control
// characters written out, as \r or \x1b. A line longer than 200 characters
// keeps its first 120 and its last 80, as its end often says why.
function quoted(line) {
  const chars = Array.from(String(line)).map((c) => {
    if (c === "\t") return "\\t";
    if (c === "\r") return "\\r";
    if (!/[\p{Cc}\p{Cf}]/u.test(c)) return c;
    const n = c.codePointAt(0);
    return n < 0x100 ? `\\x${n.toString(16).padStart(2, "0")}` : `\\u${n.toString(16).padStart(4, "0")}`;
  });
  return `"${(chars.length > 200 ? [...chars.slice(0, 120), "...", ...chars.slice(-80)] : chars).join("")}"`;
}

// The head of a line of Chrome's own log: which process wrote it, when,
// how grave it is and where in Chrome's code, in brackets. One whose
// gravity is FATAL ended the browser.
const LOG = /^\[[^\]]*?:(FATAL|ERROR|WARNING|INFO|VERBOSE\d*):[^\]]*\]\s*/;
// A line of Chrome's log from its D-Bus code that is not the one that ended
// it, as "Failed to connect to the bus": the browser is started with a
// session bus where nothing listens (see launch), and says so as it starts.
const BUS = /^\[[^\]]*?:(ERROR|WARNING|INFO|VERBOSE\d*):dbus\//;
// What libwayland says as Chrome starts when the Wayland display the run
// gives it, a socket in its profile that is never made (see launch), has a
// path too long for a socket, as in a long temp folder: it finds no display
// either way.
const NO_DISPLAY = /^error: socket path ".*\/no-display" plus null terminator exceeds \d+ bytes$/;

// The line of what a program printed to quote when it ended before it
// answered: the first line of Chrome's log that ended it, else the first
// line with anything in it that is not a line of Chrome's log that only
// tells or warns, as Chrome 157 starts by saying which channel it is, else
// the first line with anything in it, or "". A line of Chrome's D-Bus code
// that did not end it, or libwayland's on a display path too long, is
// never the one. The head of a line of Chrome's log is left out, and the
// rest of the line is as it was printed.
function causeLine(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() && !BUS.test(line) && !NO_DISPLAY.test(line));
  const grave = (line) => (LOG.exec(line) || [])[1];
  const line = lines.find((one) => grave(one) === "FATAL") || lines.find((one) => !/^(INFO|WARNING|VERBOSE\d*)$/.test(grave(one) || "")) || lines[0] || "";
  return line.replace(LOG, "").trim() || line.trim();
}

// What a browser printed says of why its sandbox could not start, in
// Chrome's own words for each way it cannot: "setup" for a build that lacks
// what its sandbox needs, a setuid helper that is set up or user namespaces
// the system lets it make, which another build can have; "namespaces" for a
// system that keeps even its setuid helper from making namespaces, as a
// container with Docker's default seccomp does, where every browser fails
// the same way; "" when it does not say.
function sandboxSaid(text) {
  const said = String(text || "");
  if (/No usable sandbox|SUID sandbox helper binary was found, but is not configured correctly/.test(said)) return "setup";
  if (/setuid sandbox: failed to move to new namespaces|^Failed to move to new namespace/m.test(said)) return "namespaces";
  return "";
}

// Chrome's own words, as the system gives them for errno, for what the
// system or the browser was short of as it started, and what to do then, in
// place of how to get a browser that runs, as another would be short of the
// same. Chrome writes the errno's number after its words, in brackets.
const SHORT_SAID = [
  [/Too many open files in system|: [^:\n]+ \(23\)$/m, "The system had as many files open as it may (file table overflow): run it again once fewer are open."],
  [/Too many open files|: [^:\n]+ \(24\)$/m, "The browser had as many files open as it may (too many open files): raise that limit, as ulimit -n does, and run it again."],
  [/\b(pthread_create|fork|clone)\b.*(Resource temporarily unavailable|: [^:\n]+ \(11\)$)/m, "The system started no more processes or threads for this user (resource temporarily unavailable): run it again once fewer are running."],
  [/Cannot allocate memory|: [^:\n]+ \(12\)$|\bOut of memory\b/m, "The system had no memory left for the browser: run it again once more is free."],
];

// A limit of this process's, on Linux, that leaves the browser it starts
// few files or processes, which the browser can be short of without saying
// so in words SHORT_SAID knows: the most files it may have open, as the
// browser takes on this process's, when that is under 1024, and the most
// processes and threads this user may run, when fewer than 100 more are
// left. "" when neither is low, or they cannot be read.
function lowLimits() {
  if (process.platform !== "linux") return "";
  let limits;
  try {
    limits = fs.readFileSync("/proc/self/limits", "utf8");
  } catch {
    return "";
  }
  const hard = (name) => {
    const found = new RegExp(`^${name}\\s+\\S+\\s+(\\d+)\\s`, "m").exec(limits);
    return found ? Number(found[1]) : Infinity;
  };
  const said = [];
  const files = hard("Max open files");
  if (files < 1024) said.push(`This process may have no more than ${files} files open, which can be too few for the browser: raise that limit, as ulimit -n does, and run it again.`);
  const most = hard("Max processes");
  if (most < Infinity && process.getuid && process.getuid() !== 0) {
    const running = threadsOfUser();
    if (most - running < 100) said.push(`This user runs ${running} processes and threads and may run no more than ${most}, which can be too few for the browser: run it again once fewer are running.`);
  }
  return said.join(" ");
}

// The processes and threads this user runs, as the system counts them
// against the most it may run, read from /proc.
function threadsOfUser() {
  let count = 0;
  let names = [];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (fs.statSync(`/proc/${name}`).uid !== process.getuid()) continue;
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      count += Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[17]) || 1;
    } catch {
      // Gone already.
    }
  }
  return count;
}

// What a program file is for, when its first bytes say it is one for
// another kind of machine than the Node.js that runs easyfontkit, which
// Linux hands to /bin/sh as a script with no #! line: an ELF program for
// another processor, or a program for macOS or Windows. Said as a sentence,
// "" when the bytes do not say so, or elsewhere than on Linux.
const ELF_MACHINES = { 2: "SPARC", 3: "32-bit x86", 8: "MIPS", 20: "32-bit PowerPC", 21: "64-bit PowerPC", 22: "IBM Z", 40: "32-bit ARM", 43: "64-bit SPARC", 62: "x86-64", 183: "64-bit ARM", 243: "RISC-V", 258: "LoongArch" };
const NODE_MACHINES = { ia32: 3, mips: 8, mipsel: 8, ppc: 20, ppc64: 21, s390x: 22, arm: 40, x64: 62, arm64: 183, riscv64: 243, loong64: 258 };
function madeFor(file) {
  if (process.platform !== "linux") return "";
  let bytes = Buffer.alloc(0);
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(64);
    bytes = head.subarray(0, fs.readSync(fd, head, 0, 64, 0));
    if (bytes.length >= 64 && bytes.toString("latin1", 0, 2) === "MZ") {
      const at = bytes.readUInt32LE(0x3c);
      const pe = Buffer.alloc(4);
      if (at < 4096 && fs.readSync(fd, pe, 0, 4, at) === 4 && pe.toString("latin1") === "PE\0\0") return "That file is a program for Windows.";
    }
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (bytes.length >= 20 && bytes.readUInt32BE(0) === 0x7f454c46) {
    const machine = bytes[5] === 2 ? bytes.readUInt16BE(18) : bytes.readUInt16LE(18);
    const own = NODE_MACHINES[process.arch];
    if (!ELF_MACHINES[machine] || !ELF_MACHINES[own] || machine === own) return "";
    return `That file is a program for ${ELF_MACHINES[machine]}, and the Node.js that runs easyfontkit is one for ${ELF_MACHINES[own]}.`;
  }
  if (bytes.length >= 4 && ["feedface", "feedfacf", "cefaedfe", "cffaedfe"].includes(bytes.toString("hex", 0, 4))) return "That file is a program for macOS.";
  return "";
}

// The first line of a file that starts with #!, as the system reads it to
// find the program that runs the file, or null.
function bangLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const bytes = Buffer.alloc(256);
    const got = bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0));
    if (got.indexOf("#!") !== 0) return null;
    const end = got.indexOf(10);
    return got.subarray(0, end < 0 ? got.length : end).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The message for a browser the system did not start, as it gave `err`
// for it: what it is short of, or what is wrong with the path when it
// changed since it was looked at, or the system's own reason. The system
// gives ENOENT for a file that is there when an interpreter or a loader it
// needs is not, so a script's first line, which names its interpreter, is
// shown.
function couldNotStart(place, err) {
  if (SHORT[err.code]) return `${place.name} did not start: easyfontkit could not start ${place.file}, as ${SHORT[err.code]}.`;
  const seen = look(place.file);
  if (seen.what) return cannotStart({ ...place, ...seen });
  const line = bangLine(place.file);
  const first = line === null ? "" : `, and its first line is ${quoted(line)}`;
  if (err.code === "ENOENT") return didNotStart(place, `could not be started: an interpreter or a loader it needs is not there${first}`);
  if (["ENOEXEC", "EFTYPE", "EBADARCH"].includes(err.code)) return didNotStart(place, "could not be started: it is not a program this system can run");
  return didNotStart(place, `could not be started: ${worded(err)}${first}`);
}

// The message for a browser that ended before it answered on its pipe,
// having printed `stderr` and `stdout`, with the exit status `code` or the
// signal that stopped it: the line of what it printed that causeLine picks,
// quoted, and how it ended. One that printed only lines of Chrome's D-Bus
// code is said to have ended, with no line. What it printed, any line of it,
// can also say that its sandbox could not start, and then what lets a
// sandbox start comes too, or that the system or the browser was short of
// open files, processes or memory, and then what to do comes in place of
// how to get a browser that runs, which another browser would not help
// with either. A limit of this process's that leaves the browser few files
// or processes is said too, and so is what a program for another kind of
// machine is for. `closed` says that it closed its pipe and was still
// running, so the run stopped it.
function endedEarly(place, { stderr = "", stdout = "", code = null, signal = null, closed = false } = {}) {
  const line = causeLine(stderr) || causeLine(stdout);
  const said = `${stderr}\n${stdout}`;
  const sandbox = sandboxSaid(said);
  const [, short = ""] = SHORT_SAID.find(([words]) => words.test(said)) || [];
  const more = [madeFor(place.file), sandbox ? SANDBOX : "", short ? "" : lowLimits()].filter(Boolean).join(" ");
  const fix = short || (sandbox === "namespaces" ? "Another browser does not help here." : "");
  if (closed) return didNotStart(place, `closed its pipe before it answered${line ? `, having printed ${quoted(line)}` : ""}`, more, fix);
  const exited = code !== null && code !== undefined;
  const end = exited ? `exited with ${code}` : `was stopped by ${signal}`;
  const how = line ? `it printed ${quoted(line)} and ${end}` : exited && !/\S/.test(stderr + stdout) ? `it printed nothing and ${end}` : `it ${end}`;
  return didNotStart(place, `ended before it answered: ${how}`, more, fix);
}

// Whether the browser at `file` runs in a sandbox of its own, with a PATH
// of its own, as one installed as a snap or a Flatpak does. By its path:
// snap's own program, where the links in /snap/bin lead, or one under
// /snap/, or one in a Flatpak's folders, as the links in its exports/bin and
// the app folder they lead to are. Or, once it runs, by its processes
// (`pids`), on Linux: one that runs a program under /snap/, or one whose
// root is not this process's and holds the .flatpak-info file every
// Flatpak's sandbox has, as when a launcher such as Ubuntu's
// chromium-browser starts the chromium snap. `proc` is where /proc is.
function ownSandbox(file, pids = [], proc = "/proc") {
  if ([file, real(file)].some((at) => at === "/usr/bin/snap" || at.startsWith("/snap/") || /\/flatpak\/(exports|app)\//.test(at))) return true;
  const rootOf = (pid) => {
    try {
      const { dev, ino } = fs.statSync(`${proc}/${pid}/root`);
      return `${dev}:${ino}`;
    } catch {
      return "";
    }
  };
  const own = rootOf("self");
  return pids.some((pid) => {
    try {
      if (fs.readlinkSync(`${proc}/${pid}/exe`).startsWith("/snap/")) return true;
    } catch {
      // Gone, or not this user's to read.
    }
    const root = rootOf(pid);
    return Boolean(root) && root !== own && fs.existsSync(`${proc}/${pid}/root/.flatpak-info`);
  });
}

module.exports = { NOTHING, SHORT, chromePlace, findChrome, cannotStart, couldNotStart, endedEarly, runnable, worded, quoted, ownSandbox, lowLimits };
