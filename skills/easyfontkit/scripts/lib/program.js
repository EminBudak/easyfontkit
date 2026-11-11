"use strict";

// The browser's program: where it is, as a shell would find it, and, when
// it cannot be started, what is wrong with it, in words a person can act
// on. The system says little: ENOENT for a script whose interpreter or a
// program whose loader is not there, EACCES for a folder or a file on a
// noexec mount, and a file it cannot run as a program it hands to /bin/sh,
// which reads it as a script and fails with words of its own. A script that
// runs the browser, as Chrome's own launcher on Linux does, says what it
// could not start. So the path is looked at before the browser is started,
// and the file again, more closely, with what was said, when it did not
// start.

const fs = require("fs");
const path = require("path");
const { getSystemErrorMap } = require("util");

const WINDOWS = process.platform === "win32";
const OS = { linux: "Linux", darwin: "macOS", win32: "Windows" }[process.platform] || process.platform;

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

// The processors of ELF programs, by their number in the file's header,
// and this machine's, by Node's name for it.
const MACHINES = { 3: "32-bit x86", 8: "MIPS", 20: "32-bit PowerPC", 21: "64-bit PowerPC", 22: "IBM Z (s390x)", 40: "32-bit ARM", 62: "x86-64", 183: "ARM64 (aarch64)", 243: "RISC-V", 258: "LoongArch" };
const ARCH = { ia32: 3, mips: 8, mipsel: 8, ppc: 20, ppc64: 21, s390x: 22, arm: 40, x64: 62, arm64: 183, riscv64: 243, loong64: 258 };

function readAt(fd, offset, length) {
  const buffer = Buffer.alloc(Math.max(0, Math.min(length, 1 << 16)));
  return buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, offset));
}

// An ELF program's processor and the loader it names, from its header and
// its program headers.
function elfOf(fd, head) {
  const bits = head[4] === 2 ? 64 : 32;
  const little = head[5] !== 2;
  const u16 = (b, at) => (little ? b.readUInt16LE(at) : b.readUInt16BE(at));
  const u32 = (b, at) => (little ? b.readUInt32LE(at) : b.readUInt32BE(at));
  const word = (b, at) => (bits === 64 ? Number(little ? b.readBigUInt64LE(at) : b.readBigUInt64BE(at)) : u32(b, at));
  const machine = u16(head, 18);
  let loader = "";
  try {
    const table = word(head, bits === 64 ? 0x20 : 0x1c);
    const size = u16(head, bits === 64 ? 0x36 : 0x2a);
    const count = Math.min(u16(head, bits === 64 ? 0x38 : 0x2c), 128);
    const headers = readAt(fd, table, size * count);
    for (let i = 0; i < count; i++) {
      // PT_INTERP: the loader that starts the program.
      if (u32(headers, i * size) !== 3) continue;
      const offset = word(headers, i * size + (bits === 64 ? 8 : 4));
      const length = word(headers, i * size + (bits === 64 ? 32 : 16));
      loader = readAt(fd, offset, Math.min(length, 4096)).toString("latin1").replace(/\0[\s\S]*$/, "");
      break;
    }
  } catch {
    // A header cut short: no loader known.
  }
  return { machine, loader };
}

// Whether bytes are text: UTF-8 with no control character but a tab, a
// line break, a form feed or an escape. A letter cut in two at the end of
// the bytes read is no sign of anything.
function textual(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
  } catch {
    return false;
  }
  return !/[\0-\x08\x0e-\x1a\x1c-\x1f\x7f]/.test(text);
}

// What a file holds, from its first bytes: { script: { interpreter, rest,
// cr } } from its #! line, { elf: { machine, loader } }, { windows } for a
// Windows program, { macos } for a macOS one, { text } for text with no #!
// line, { binary } for anything else, { unreadable } for a file this user
// may not read, and {} when it is empty or cannot be read otherwise.
function kindOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch (err) {
    return err.code === "EACCES" || err.code === "EPERM" ? { unreadable: true } : {};
  }
  try {
    const head = readAt(fd, 0, 4096);
    if (!head.length) return {};
    if (head[0] === 0x23 && head[1] === 0x21) {
      // The system takes the interpreter up to a space, a tab or the end of
      // the line, and the rest of the line as one word it is given, with a
      // carriage return as part of either.
      const end = head.indexOf(0x0a);
      const line = head.subarray(2, end < 0 ? head.length : end).toString("latin1");
      const [, name, rest] = /^[ \t]*([^ \t]*)[ \t]*(.*)$/s.exec(line);
      const word = rest.replace(/[ \t]+$/, "");
      return { script: { interpreter: name.replace(/\r$/, ""), rest: word.replace(/\r$/, ""), cr: name.endsWith("\r") || word.endsWith("\r") } };
    }
    if (head.length >= 52 && head.readUInt32BE(0) === 0x7f454c46) return { elf: elfOf(fd, head) };
    if (head[0] === 0x4d && head[1] === 0x5a) return { windows: true };
    const magic = head.length >= 8 ? head.readUInt32BE(0) : 0;
    // Mach-O, 32 and 64 bits in either byte order, and a universal file of
    // a few of them, which a Java class file, of the same magic, is not.
    if ([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic) || ((magic === 0xcafebabe || magic === 0xcafebabf) && head.readUInt32BE(4) < 20)) return { macos: true };
    return textual(head) ? { text: true } : { binary: true };
  } catch {
    return {};
  } finally {
    fs.closeSync(fd);
  }
}

// What a file made for another system is, or "" for one of this one's.
function foreign(kind) {
  if (kind.elf) {
    if (WINDOWS || process.platform === "darwin") return `a program for Linux or another Unix, not for ${OS}`;
    const mine = ARCH[process.arch];
    if (mine !== undefined && kind.elf.machine !== mine) return `a program for ${MACHINES[kind.elf.machine] || "another processor"}, which this ${MACHINES[mine]} machine cannot run`;
    return "";
  }
  if (kind.windows && !WINDOWS) return `a Windows program, which does not run on ${OS}`;
  if (kind.macos && process.platform !== "darwin") return `a macOS program, which does not run on ${OS}`;
  return "";
}

// A script whose interpreter cannot be started: what its first line names
// and what is wrong with that.
function interpreterTrouble(script) {
  if (script.cr) return "a script with Windows line breaks, so its first line names a program whose name ends in a carriage return, which is not there";
  const name = script.interpreter;
  if (!name) return "a script whose first line, #!, names no program";
  let stat = null;
  try {
    stat = fs.statSync(name);
  } catch {
    // Not there, or not to be looked at.
  }
  if (!stat) return `a script whose first line names ${name}, which is not on this machine`;
  if (stat.isDirectory()) return `a script whose first line names ${name}, a folder, not a program`;
  if (!runnable(name)) return `a script whose first line names ${name}, a file this user may not run`;
  return "";
}

// Whether /bin/sh read a file as a script and failed on it, which the
// system has it do with a file it cannot run as a program: what the shell
// says starts with the file's path, then the line it failed on, as dash
// says, "line" and the line, as bash says, or the path again, as bash says
// of a file that is no script. It is asked only of a file the system would
// not run, as a script's own shell says the same of its lines.
function readByShell(file, stderr) {
  if (!stderr.startsWith(`${file}: `)) return false;
  const rest = stderr.slice(file.length + 2);
  return /^(line )?\d+: /.test(rest) || rest.startsWith(`${file}: `);
}

// What the system told a shell of a program it could not start, by the
// words dash, bash and BusyBox say after its name.
const SHELL_SAYS = {
  "not found": "ENOENT",
  "command not found": "ENOENT",
  "No such file or directory": "ENOENT",
  "cannot execute: required file not found": "ENOENT",
  "cannot execute: No such file or directory": "ENOENT",
  "Permission denied": "EACCES",
  "cannot execute: Permission denied": "EACCES",
  "Is a directory": "EACCES",
  "cannot execute: Is a directory": "EACCES",
  "Exec format error": "ENOEXEC",
  "cannot execute binary file": "ENOEXEC",
  "cannot execute binary file: Exec format error": "ENOEXEC",
};
// A script's shell on a program one of its lines could not start, after the
// script's path: the line, as dash says it, or "line" and the line, as bash
// says it, then exec when it was that, the program and what was wrong.
const COULD_NOT = new RegExp(`^(?:line )?\\d+: (?:exec: )?(.+?): (${Object.keys(SHELL_SAYS).join("|")})$`);
// env's words for a program it was told to start and could not, as GNU's,
// BusyBox's and the BSDs' env say them, in their quotes or none.
const ENV_COULD_NOT = /^(?:\S*\/)?env: (?:can't execute )?['"\u2018]?(.+?)['"\u2019]?: (No such file or directory|Permission denied)$/;

// The program a script's #! line has env start, as in "#!/usr/bin/env
// chrome", where the system gives env the rest of the line as one word, or
// "#!/usr/bin/env -S chrome --flag", where env splits it and passes over
// its own options and any NAME=value. "" for any other #! line.
function envTarget(script) {
  if (path.basename(script.interpreter) !== "env" || !script.rest) return "";
  if (!script.rest.startsWith("-S")) return script.rest.startsWith("-") ? "" : script.rest;
  return script.rest.slice(2).split(/[ \t]+/).find((word) => word && !word.startsWith("-") && !word.includes("=")) || "";
}

// What is wrong with a program a script ran and could not start, `named` as
// the script names it, by a path or by a name on PATH, with `said` the
// shell's or env's words for it: words that follow its name after a comma.
function startedByScript(named, said) {
  let file;
  let at = "";
  if (bare(named)) {
    const found = lookOnPath(named);
    if (!found.file && !found.other) return "which is not on your PATH";
    file = found.file || found.other;
    at = `found on your PATH at ${file}, `;
  } else {
    file = path.resolve(named);
  }
  const seen = look(file);
  if (seen.what) return `${at}${seen.what.replace(/^and there is no file there/, "which is not there")}`;
  // A file this user may run, which the system did not start: one whose
  // loader or interpreter is missing, or one for another system.
  const code = SHELL_SAYS[said] || "EACCES";
  const kind = kindOf(file);
  if (code === "ENOENT" && kind.script) {
    const trouble = interpreterTrouble(kind.script);
    if (trouble) return `${at}${trouble}`;
  }
  if (code === "ENOENT" && kind.elf && kind.elf.loader && !there(kind.elf.loader)) return `${at}a program that needs the loader ${kind.elf.loader}, which is not on this machine`;
  if (code === "ENOEXEC") return `${at}${foreign(kind) || (kind.text ? "a text file with no #! line, not a program" : "not a program this system can run")}`;
  return `${at}which it could not start (${said})`;
}

// What a script that ran says of a program it could not start, as it ended
// with `code`: env, of the one its first line has env start, or the
// script's shell, of one a line of it runs, as Chrome's own launcher on
// Linux runs the browser with exec. They end with 126 or 127 then, and with
// 2 when the shell could not read a file the system gave it. "" for anything
// else, as a script whose browser started and quit.
function scriptStopped(file, script, stderr, code) {
  if (![2, 126, 127].includes(code)) return "";
  const lines = stderr.split("\n");
  const env = envTarget(script);
  if (env && code !== 2) {
    for (const line of lines) {
      const m = ENV_COULD_NOT.exec(line);
      if (!m || m[1] !== env) continue;
      if (script.cr) return "a script with Windows line breaks, so its first line has env start a program whose name ends in a carriage return, which is not there";
      return `a script whose first line has env start ${env}, ${startedByScript(env, m[2])}`;
    }
  }
  for (const line of lines) {
    if (code === 2 || !line.startsWith(`${file}: `)) continue;
    // A builtin's words, as bash's "cd: <folder>: No such file or
    // directory", name no program.
    const m = COULD_NOT.exec(line.slice(file.length + 2));
    if (m && !m[1].includes(": ")) return `a script that starts ${m[1]}, ${startedByScript(m[1], m[2])}`;
  }
  // A file the system would not run as a program, which the script started
  // and the system gave /bin/sh, as a web page saved in the browser's place:
  // the shell's words start with that file's path.
  for (const line of lines) {
    const m = /^(.+?): (?:(?:line )?\d+: |\1: )/.exec(line);
    if (!m || m[1] === file || !path.isAbsolute(m[1])) continue;
    const kind = kindOf(m[1]);
    if (kind.text || kind.binary || foreign(kind)) return `a script that starts ${m[1]}, ${foreign(kind) || (kind.text ? "a text file with no #! line, not a program" : "not a program this system can run")}`;
  }
  return "";
}

// What is wrong with a browser at `file` that did not start, from the
// error the system gave as it was started (`error`), or from how it ended
// before it answered (`stderr`, what it printed, and `code`, its exit
// status) and what the file is, as words that follow its path after a
// comma. "" when nothing tells, as for a browser that started and quit.
function explain(file, { error = null, stderr = "", code = null } = {}) {
  const kind = kindOf(file);
  if (error) {
    if (kind.script && ["ENOENT", "EACCES", "EPERM", "ENOEXEC"].includes(error.code)) {
      const trouble = interpreterTrouble(kind.script);
      if (trouble) return trouble;
    }
    if (error.code === "ENOENT") {
      if (kind.elf && kind.elf.loader && !there(kind.elf.loader)) return `a program that needs the loader ${kind.elf.loader}, which is not on this machine`;
      return "a program that cannot start, as its interpreter or loader is missing";
    }
    if (error.code === "ENOEXEC" || error.code === "EFTYPE") return foreign(kind) || (kind.text ? "a text file with no #! line, not a program" : "not a program this system can run");
    if (error.code === "EACCES" || error.code === "EPERM") return "a file this user may not run";
    return `a program that cannot be started (${worded(error)})`;
  }
  // The loader's words for a library it did not find, or one too old. It
  // names the program by the name it was started with: a script's
  // interpreter, or a program a script starts, by its own, unless the
  // script gives it the script's name, as Chrome's launcher on Linux does.
  const by = (named, what) => {
    if (!kind.script || named === file) return what;
    return `${named === kind.script.interpreter ? "a script whose first line names" : "a script that starts"} ${named}, ${what}`;
  };
  const library = /^(.+?): error while loading shared libraries: ([^:\n]+): cannot open shared object file/m.exec(stderr);
  if (library) return by(library[1], `a program that needs the shared library ${library[2].trim()}, which is not on this machine`);
  const old = /^(.+?): ([^:\s]+): version `([^']+)' not found \(required by /m.exec(stderr);
  if (old) return by(old[1], `a program made for a newer system: it needs ${old[3]} of ${path.basename(old[2])}, which this machine's is too old to have`);
  // A script the system started, which says what it could not start, or
  // nothing that tells.
  if (kind.script) return scriptStopped(file, kind.script, stderr, code);
  // A file this user may run and not read. The system starts a program so,
  // but a script's interpreter has to read it, and says it may not, as
  // dash's "cannot open <file>: Permission denied" does.
  if (kind.unreadable) {
    const denied = stderr.split("\n").some((line) => line.includes(file) && line.includes("Permission denied"));
    return denied ? "a script without the permission to read it, which its interpreter needs and chmod +r gives" : "";
  }
  // A file the system would not run as a program and gave /bin/sh.
  if (!(kind.text || kind.binary || foreign(kind)) || !readByShell(file, stderr)) return "";
  if (kind.text) return "a text file with no #! line, not a program";
  return foreign(kind) || "not a program this system can run";
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

// The errors that say the system is short of something to start a program
// with, not that the browser is wrong, and what to do.
const SHORT = {
  EMFILE: "this process has as many files open as it may (too many open files). Raise that limit, as ulimit -n does, and run it again",
  ENFILE: "the system has as many files open as it may (file table overflow). Run it again once fewer are open",
  EAGAIN: "the system starts no more processes for this user now (resource temporarily unavailable). Run it again once fewer are running",
  ENOMEM: "the system has no memory left to start it. Run it again once more is free",
};

// The message for a browser the system did not start with `error`, or
// that ended before it answered, having printed `stderr`, with `code`:
// what is wrong with it, or what the system is short of. "" when nothing
// tells.
function notStarted(place, { error = null, stderr = "", code = null } = {}) {
  if (error && SHORT[error.code]) return `${place.name} did not start: easyfontkit could not start ${place.file}, as ${SHORT[error.code]}.`;
  // A path the system could not follow, or a file it would not run, looked
  // at again: it can have changed since it was looked at first.
  if (error && ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG", "EACCES", "EPERM"].includes(error.code)) {
    const seen = look(place.file);
    if (seen.what) return cannotStart({ ...place, ...seen });
  }
  const what = explain(place.file, { error, stderr, code });
  return what ? cannotStart(place, what) : "";
}

module.exports = { NOTHING, chromePlace, findChrome, cannotStart, notStarted };
