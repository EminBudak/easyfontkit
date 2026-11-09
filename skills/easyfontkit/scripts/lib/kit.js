"use strict";

// A font kit from a website: the page is opened in a headless browser on a
// 1600x900 desktop screen, walked from top to bottom, and read once. What
// comes out, in one folder:
//
//   FONTS.md    the fonts of headings, body text, buttons and code, each
//               family's license and maker, and the closest free fonts, for
//               people and coding agents
//   fonts.css   a @font-face rule for every saved file and, per role, the
//               site's font and its closest free font as CSS variables
//   fonts.json  everything above, for tools
//   files/      every font file the page loaded, as the browser received it
//
// Nothing is written while the page is read. The kit is then made in a
// part folder inside its folder, and moved in for an earlier kit there one
// file at a time: the earlier kit's files go aside, fonts.json first, and
// the new ones come in, fonts.json last. A run that fails or is stopped
// leaves the folder as it was.

const crypto = require("crypto");
const fs = require("fs");
const { STATUS_CODES } = require("http");
const path = require("path");
const { launch, killBrowsers, openPage } = require("./chrome");
const { scanPage } = require("./scan");
const { buildFamilies, parseStack } = require("./families");
const { SOURCE_NAMES } = require("./license");
const { styleWords, words } = require("./match");
const { setTimeLimit, sleep } = require("./time");
const version = require("./version");

const SCREEN = { width: 1600, height: 900 };
const ROLE_NAMES = { heading: "Headings", body: "Body text", button: "Buttons", code: "Code" };
const ROLE_WORDS = { heading: "headings", body: "body text", button: "buttons", code: "code" };
const GENERIC = { sans: "sans-serif", serif: "serif", mono: "monospace" };
const STATUS = { open: "Open", commercial: "Commercial", unknown: "Unknown", system: "System font" };

// "acme.com", "www.acme.com/pricing" and "https://acme.com" all mean a web
// address; anything that is not http(s) is refused.
function normalizeUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("Give a website address, for example: easyfontkit acme.com");
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error(`Not a web address: ${text}`);
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname) throw new Error(`Not a web address: ${text}`);
  return url.href;
}

// The font files an earlier kit lists, by name only: a fonts.json someone
// edited cannot point a run outside the kit's files folder.
function kitFiles(kit) {
  return []
    .concat(kit.families || [])
    .flatMap((family) => [].concat((family && family.files) || []).map((file) => file && file.file))
    .filter((file) => typeof file === "string" && file)
    .map((file) => path.basename(file))
    .filter((name) => name && name !== "." && name !== "..");
}

function entry(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}
const exists = (file) => Boolean(entry(file));
// What a kit writes: a file, never a folder. A link counts, as the link.
const isFile = (file) => {
  const stat = entry(file);
  return Boolean(stat && (stat.isFile() || stat.isSymbolicLink()));
};
const namesIn = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const remove = (file) => {
  try {
    fs.rmSync(file, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Left for the next run.
  }
};

// A run's part folder in the kit's folder, .easyfontkit-part-<pid>-<random>;
// the list of moves a run writes in it before it moves its kit in; and the
// lock that runs saving into the same folder take turns with.
const PART = /^\.easyfontkit-part-(\d+)-[0-9a-f]{8}$/;
const MOVES = "moves.json";
const LOCK = ".easyfontkit-lock";
// The lock and the marker a takeover makes both start with the lock's name.
const isControl = (name) => PART.test(name) || name.startsWith(LOCK);

function readKit(file) {
  try {
    const kit = JSON.parse(fs.readFileSync(file, "utf8"));
    return kit && kit.version === 1 && String(kit.generator || "").startsWith("easyfontkit") ? kit : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Another user's process.
    return err.code === "EPERM";
  }
}
// The run that made a part folder or a lock has ended: its process is gone,
// or it went by this process's pid, so it was an earlier process with the
// same pid, as this process asks only about ones it did not make.
const ended = (pid) => pid === process.pid || !alive(pid);

// The part folders in dir with a list of moves: a run moved its kit in and
// had not finished. Under the lock no run is in the middle of its moves, so
// every one of these was left by a run killed outright.
function swaps(dir) {
  return namesIn(dir)
    .map((name) => [name, PART.exec(name)])
    .filter(([name, m]) => m && exists(path.join(dir, name, MOVES)))
    .map(([name]) => ({ part: path.join(dir, name) }));
}

// The kit's folder as a run finds it: null when it is missing or empty, or
// the earlier kit there, with the names of its font files that are in
// files/ as files. A folder that holds anything else is refused, so a run
// never mixes into or replaces someone's files, and so is a kit that has
// something other than a file where the new kit puts one. The lock and the
// part folders of runs do not count. A folder a killed run left half
// replaced counts as a kit (cut): saveKit puts it back together first.
// Nothing is changed.
function earlierKit(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => !isControl(name));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (!names.length) return null;
  // First whether the folder holds a kit at all, so a folder that holds
  // none is refused for that, whatever else is in it. A run saving here
  // moves fonts.json into place before it removes its list of moves, so one
  // that finished between the first read and the look for leftover lists
  // has a fonts.json now; it is read once more before the folder is
  // refused.
  let old = readKit(path.join(dir, "fonts.json"));
  const cut = !old && swaps(dir).length > 0;
  if (!old && !cut) old = readKit(path.join(dir, "fonts.json"));
  if (!old && !cut) throw new Error(`${dir} is not empty and holds no earlier font kit. Pick another folder with --out.`);
  // Then what stands where the new kit puts its files, in a kit and in a
  // folder a killed run left half replaced alike. One lstat per name, so a
  // run saving here cannot be refused for a name that moved between two
  // separate reads. files must be a real folder, not a link: a link would
  // send the kit's reads and moves outside the folder.
  for (const name of ["FONTS.md", "fonts.css", "files"]) {
    const stat = entry(path.join(dir, name));
    if (!stat) continue;
    const ok = name === "files" ? stat.isDirectory() : stat.isFile() || stat.isSymbolicLink();
    const what = name !== "files" ? "not a file" : stat.isSymbolicLink() ? "a link, not a folder" : "not a folder";
    if (!ok) throw new Error(`No kit can be saved in ${dir}: ${path.join(dir, name)} is ${what}. Move it away, or pick another folder with --out.`);
  }
  if (cut) return { files: [], cut: true };
  return { files: [...new Set(kitFiles(old))].filter((name) => isFile(path.join(dir, "files", name))) };
}

// The kit's folder before the page is read, without writing anything:
// refused when it holds someone else's files, or when this user cannot
// make it or write in it. Gives what earlierKit gives.
function checkFolder(dir) {
  const target = path.resolve(dir);
  const shownAt = (at) => (at === target ? dir : path.isAbsolute(dir) ? at : path.relative(process.cwd(), at) || ".");
  const thenAt = (at) => (at === target ? "" : `, so ${dir} cannot be made there`);
  let at = target;
  let stat;
  for (;;) {
    try {
      stat = fs.statSync(at);
      break;
    } catch (err) {
      // A path this run cannot use at all: a link loop, a name too long.
      if (err.code === "ELOOP" || err.code === "ENAMETOOLONG") throw new Error(`${dir} is not a folder this run can use. Pick another folder with --out.`);
      // A link whose target is missing, at --out or on the way to it: statSync
      // finds nothing there, as for a folder not made yet, but mkdir cannot
      // make it, and would fail only once the page has been read.
      if (err.code === "ENOENT" && entry(at) && entry(at).isSymbolicLink()) {
        throw new Error(`${shownAt(at)} is a link to a folder that is not there${thenAt(at)}. Pick another folder with --out.`);
      }
      // ENOTDIR: a file on the way. EACCES/EPERM: a folder on the way this
      // user may not enter. Both are found one level up, where the message
      // is plain, instead of as a raw system error later.
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(err.code) || path.dirname(at) === at) throw err;
      at = path.dirname(at);
    }
  }
  if (!stat.isDirectory()) throw new Error(`${shownAt(at)} is not a folder${thenAt(at)}. Pick another folder with --out.`);
  try {
    fs.accessSync(at, fs.constants.W_OK | fs.constants.X_OK | (at === target ? fs.constants.R_OK : 0));
  } catch {
    throw new Error(`This user may not write in ${shownAt(at)}${thenAt(at)}. Pick another folder with --out.`);
  }
  return earlierKit(dir);
}

// The kit's folder made ready for a kit written straight into it, as 0.1.1
// exported it for code that writes a kit itself: a folder the kit cannot be
// saved in is refused, as makeFontKit refuses it, a missing one is made, and
// an earlier kit's own files are removed, with its files folder when
// nothing else is in it, while the user's files stay. makeFontKit does not
// call it, since a run that then failed would lose the earlier kit. A
// folder a run killed outright left half replaced holds no whole kit to
// clear, and is refused as 0.1.1 refused it, so the earlier kit's files that
// run moved aside can still be put back.
function prepareDir(dir) {
  const earlier = checkFolder(dir);
  if (earlier && earlier.cut) {
    throw new Error(`A run killed while it put its kit in ${dir} left the earlier kit there half moved. The next easyfontkit run that saves a kit there puts it back together first; or pick another folder with --out.`);
  }
  fs.mkdirSync(dir, { recursive: true });
  if (!earlier) return;
  for (const name of [...earlier.files.map((file) => path.join("files", file)), "fonts.json", "FONTS.md", "fonts.css"]) fs.rmSync(path.join(dir, name), { force: true });
  try {
    fs.rmdirSync(path.join(dir, "files"));
  } catch {
    // Missing, or holding files of the user's.
  }
}

// The names in the kit's files folder that the earlier kit does not list:
// the user's own, which a new font file never takes. Compared without case,
// as macOS and Windows disks compare them.
function ownFiles(dir, earlier) {
  const kit = new Set((earlier ? earlier.files : []).map((name) => name.toLowerCase()));
  try {
    return fs.readdirSync(path.join(dir, "files")).filter((name) => !kit.has(name.toLowerCase()));
  } catch {
    return [];
  }
}

// Windows can refuse a rename for a moment while a virus scanner reads a
// file that was just written, so there it is tried again for up to two
// seconds, waiting in place like the rest of the move.
function rename(from, to) {
  for (let waited = 0; ; waited += 50) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(err.code) || waited >= 2_000) throw err;
      pause(50);
    }
  }
}

// Two runs that save into one folder at the same moment take turns: the
// first makes the lock file, with its pid in it, and the second waits for
// it to go, at most LOCK_WAIT. A lock whose run has ended, or one older
// than any save takes, was left by a run killed outright, and is taken
// over. Gives the function that lets go of the lock.
const LOCK_WAIT = 10_000;
const LOCK_STALE = 120_000;
function lockOf(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return null;
  }
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // Not readable: told by its age alone.
  }
  const pid = /^\d+$/.test(text) ? Number(text) : 0;
  const age = Date.now() - stat.mtimeMs;
  // A lock with no pid yet has just been made, unless it is a few seconds old.
  return { text, mtimeMs: stat.mtimeMs, stale: age > LOCK_STALE || (pid ? ended(pid) : age > 5_000) };
}
// A stale lock is taken over by one waiter at a time: whoever makes the
// marker file removes the lock, but only while it is still the same stale
// lock. The others find the marker taken and wait, so two waiters never both
// unlink and then both go on.
function takeOver(file, holder) {
  const marker = `${file}.stale`;
  let fd;
  try {
    fd = fs.openSync(marker, "wx");
  } catch {
    // Another waiter holds the marker, or a run killed mid-takeover left it;
    // clear one old enough to be leaked and let a later pass retry.
    try {
      if (Date.now() - fs.lstatSync(marker).mtimeMs > LOCK_WAIT) fs.unlinkSync(marker);
    } catch {
      // Gone, or not ours to judge.
    }
    return;
  }
  try {
    const now = lockOf(file);
    if (now && now.text === holder.text && now.mtimeMs === holder.mtimeMs) fs.unlinkSync(file);
  } catch {
    // Gone already, or taken by someone else since.
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(marker);
    } catch {
      // Left for the next waiter; a stale marker is judged by its age too.
    }
  }
}
// Two runs that save into one folder at the same moment take turns: the
// first makes the lock file, with its pid in it, and the second waits for it
// to go, at most LOCK_WAIT. The wait yields to the event loop, so a stop
// signal that arrives during it ends the run before anything is written,
// as it would at any other point. The folder itself can go during the
// wait, as the run that made it removes it when its own save fails: then
// remake() makes it again for this run. Gives the function that lets go of
// the lock, which removes it only while it is still this run's.
async function lock(dir, remake) {
  const file = path.join(dir, LOCK);
  const mine = String(process.pid);
  const unlock = () => {
    try {
      if (fs.readFileSync(file, "utf8") === mine) fs.unlinkSync(file);
    } catch {
      // Gone already, or no longer ours.
    }
  };
  const take = () => {
    try {
      return fs.openSync(file, "wx");
    } catch (err) {
      if (err.code === "EEXIST") return undefined;
      if (err.code !== "ENOENT") throw err;
    }
    remake();
    try {
      return fs.openSync(file, "wx");
    } catch (err) {
      // Taken, or gone again: tried again after the pause.
      if (err.code === "EEXIST" || err.code === "ENOENT") return undefined;
      throw err;
    }
  };
  for (let waited = 0; ; waited += 50) {
    const fd = take();
    if (fd !== undefined) {
      try {
        fs.writeSync(fd, mine);
      } catch (err) {
        fs.closeSync(fd);
        // This run made it a moment ago and could not write its pid in it,
        // as on a full disk, so it is removed as it is.
        try {
          fs.unlinkSync(file);
        } catch {
          // Gone already.
        }
        throw err;
      }
      fs.closeSync(fd);
      return unlock;
    }
    if (waited >= LOCK_WAIT) throw new Error(`Another run is saving a font kit in ${dir}, so no kit was made. Try again once it is done.`);
    if (stopping) throw new Error("stopped while waiting for another run to finish saving");
    const holder = lockOf(file);
    if (holder && holder.stale) takeOver(file, holder);
    await sleep(50);
  }
}

// Made with mkdir, not mkdtemp: under a default ACL, mkdtemp's mode 0700
// would shut out the others that ACL lets into the folder, like a hosted
// worker that removes what a killed run left.
function makePart(dir) {
  for (;;) {
    const part = path.join(dir, `.easyfontkit-part-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    try {
      fs.mkdirSync(part);
      return part;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
}

// What a move takes, to know it again where it went: a rename keeps a
// file's size and time, and a folder's names.
function idOf(file) {
  const stat = fs.lstatSync(file);
  return stat.isDirectory() ? { names: fs.readdirSync(file).sort() } : { size: stat.size, mtimeMs: stat.mtimeMs };
}
function isSame(file, id) {
  const stat = entry(file);
  if (!stat || !id) return false;
  if (id.names) return stat.isDirectory() && JSON.stringify(namesIn(file).sort()) === JSON.stringify(id.names);
  return !stat.isDirectory() && stat.size === id.size && stat.mtimeMs === id.mtimeMs;
}

// Moves back, last first, each move whose file is still where it went,
// unless something has taken its old place: all of moves, or only the
// first done when the others were not made. Gives what could not go back,
// or "".
function undo(dir, moves, done = moves.length) {
  let left = "";
  for (const [from, to, id] of moves.slice(0, done).reverse()) {
    if (!isSame(path.join(dir, to), id)) continue;
    try {
      if (exists(path.join(dir, from))) throw new Error(`${path.normalize(from)} is taken`);
      rename(path.join(dir, to), path.join(dir, from));
    } catch (err) {
      left = left || err.message;
    }
  }
  return left;
}

// A list of moves is followed only when every move is one putInPlace itself
// writes: a file name with no slash of its own, going between the kit's
// folder and this part folder and nowhere else. A planted or edited list,
// one that points outside the folder or at another name, is treated as
// unreadable, so putBack keeps the part and refuses rather than moving or
// removing anything the list names. Nor is any folder the moves pass
// through a link: the part, its earlier, earlier/files and files, and the
// kit's own files. A link there would carry the moves outside the folder.
const partMove = (own) => {
  const safe = (name) => name && !name.includes("/") && !name.includes("\\") && name !== "." && name !== "..";
  return ([from, to]) => {
    if (typeof from !== "string" || typeof to !== "string") return false;
    for (const name of ["fonts.json", "FONTS.md", "fonts.css"]) {
      if (from === name && to === `${own}/earlier/${name}`) return true;
      if (from === `${own}/${name}` && to === name) return true;
    }
    if (from === `${own}/files` && to === "files") return true;
    const asideTo = `${own}/earlier/files/`;
    if (from.startsWith("files/") && to.startsWith(asideTo)) {
      const f = from.slice("files/".length);
      return safe(f) && to === `${asideTo}${f}`;
    }
    const newFrom = `${own}/files/`;
    if (from.startsWith(newFrom) && to.startsWith("files/")) {
      const f = from.slice(newFrom.length);
      return safe(f) && to === `files/${f}`;
    }
    return false;
  };
};
// Nor is a list followed unless it and its part folder are this user's
// own, as a run of this user's leaves them: someone else who may write in
// the kit's folder, but not in its files folder, could put there a list
// that names only moves a run makes, and have the run move the user's files
// into that part folder and remove them with it. Windows gives no owner to
// compare.
const mine = (stat) => !process.getuid || stat.uid === process.getuid();
function readMoves(part) {
  const through = [part, path.join(part, "earlier"), path.join(part, "earlier", "files"), path.join(part, "files"), path.join(path.dirname(part), "files")];
  for (const folder of through) {
    const stat = entry(folder);
    if (folder === part ? !stat || !stat.isDirectory() || !mine(stat) : stat && !stat.isDirectory()) return null;
  }
  const list = entry(path.join(part, MOVES));
  if (!list || !list.isFile() || !mine(list)) return null;
  try {
    const moves = JSON.parse(fs.readFileSync(path.join(part, MOVES), "utf8"));
    if (!Array.isArray(moves) || !moves.every((move) => Array.isArray(move))) return null;
    return moves.every(partMove(path.basename(part))) ? moves : null;
  } catch {
    return null;
  }
}

// The new kit, made in the part folder, put in place of the earlier kit.
// The earlier kit's own files go aside into the part folder, fonts.json
// first, and the new ones come in, fonts.json last, so a fonts.json in the
// folder always goes with the files next to it. The moves are written down
// in the part folder before the first one, and that list is removed after
// the last, so a run killed in between can be undone by the next one. Each
// move is a rename within the folder that never takes the place of
// anything, and one that fails puts back every file moved before it.
function putInPlace(dir, part, earlier) {
  const own = path.basename(part);
  const moves = [];
  const plan = (from, to) => moves.push([from, to, idOf(path.join(dir, from))]);
  if (earlier) {
    for (const name of ["fonts.json", "FONTS.md", "fonts.css"]) {
      if (isFile(path.join(dir, name))) plan(name, `${own}/earlier/${name}`);
    }
    for (const name of earlier.files) plan(`files/${name}`, `${own}/earlier/files/${name}`);
  }
  for (const name of ["FONTS.md", "fonts.css"]) plan(`${own}/${name}`, name);
  const withFiles = exists(path.join(part, "files"));
  if (withFiles && !exists(path.join(dir, "files"))) plan(`${own}/files`, "files");
  else if (withFiles) for (const name of fs.readdirSync(path.join(part, "files"))) plan(`${own}/files/${name}`, `files/${name}`);
  plan(`${own}/fonts.json`, "fonts.json");
  fs.mkdirSync(path.join(part, "earlier", "files"), { recursive: true });
  fs.writeFileSync(path.join(part, `${MOVES}.tmp`), JSON.stringify(moves));
  rename(path.join(part, `${MOVES}.tmp`), path.join(part, MOVES));
  let done = 0;
  try {
    for (const [from, to] of moves) {
      if (exists(path.join(dir, to))) throw new Error(`${path.normalize(to)} is in the way`);
      rename(path.join(dir, from), path.join(dir, to));
      done++;
    }
  } catch (err) {
    const left = undo(dir, moves, done);
    if (!left) throw new Error(`The new kit could not be put in place in ${dir} (${err.message}), ${earlier ? "so the earlier kit there is as it was." : "so nothing was saved there."}`);
    const error = new Error(`The new kit could not be put in place in ${dir} (${err.message}), and some of the earlier kit's files could not be moved back (${left}): they are in ${path.join(part, "earlier")}. The next run that saves a kit there tries again to put them back.`);
    // The part folder holds them, with its list of moves, and stays.
    error.keepPart = true;
    throw error;
  }
  remove(path.join(part, MOVES));
  // As before, without font files: a files folder that held only the
  // earlier kit's goes too.
  if (!withFiles) {
    try {
      fs.rmdirSync(path.join(dir, "files"));
    } catch {
      // Missing, or holding files of the user's.
    }
  }
}

// What runs killed outright in the middle of their moves had moved, put
// back, so the earlier kit is whole again; then their part folders go,
// with the new kits they had made.
function putBack(dir) {
  // Under the lock no run is in the middle of its moves, so every leftover
  // list is from a run killed outright, whatever pid its part folder names;
  // a pid that has come round again on another process is not mistaken for
  // the killed run.
  for (const { part } of swaps(dir)) {
    const moves = readMoves(part);
    const left = moves ? undo(dir, moves) : "its list of moves cannot be followed";
    if (left) {
      throw new Error(`A run killed while it put its kit in ${dir} left the earlier kit there half moved, and it could not be put back together (${left}), so no kit was made. The earlier kit's files that could not go back are in ${path.join(part, "earlier")}; move them back by hand, or pick another folder with --out.`);
    }
    remove(part);
  }
}

// The first folder mkdir -p would make for target: the highest one on its
// path that is not there yet, or "" when target is there.
function firstMissing(target) {
  let missing = "";
  for (let at = target; !entry(at); at = path.dirname(at)) {
    missing = at;
    if (path.dirname(at) === at) break;
  }
  return missing;
}

// The folders made for a kit that was not saved, from the kit's folder up
// to the first one made, as long as they are empty. One a mkdir that failed
// partway did not get to is passed over.
function removeMade(dir, made) {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    try {
      fs.rmdirSync(at);
    } catch (err) {
      if (err.code !== "ENOENT") return;
    }
    if (at === path.resolve(made) || path.dirname(at) === at) return;
  }
}

// Once the new kit is in place: the part folder, which holds the earlier
// kit by then, and the part folders of runs killed outright while they
// wrote their kit, before they moved anything. Nothing here fails the run:
// what cannot be removed is left for the next run.
function tidy(dir, part) {
  remove(part);
  for (const name of namesIn(dir)) {
    const m = PART.exec(name);
    if (m && ended(Number(m[1])) && !exists(path.join(dir, name, MOVES))) remove(path.join(dir, name));
  }
}

// The kit, written by write() into a part folder of its own inside dir and
// put in place of the earlier kit there, or nothing at all: on any error
// the part folder goes, and so do the folders made for it. Runs saving into
// one folder take turns, and the first to save after a run killed in the
// middle of its moves puts the earlier kit back together. All of it runs
// without a pause, so a stop signal is handled before it starts or after it
// is done, never halfway. The folder is read again here, as it can have
// changed while the page was read.
async function saveKit(dir, write) {
  let made;
  let unlock = null;
  let part = "";
  let earlier = null;
  try {
    // Resolved once, so a .. in --out cannot make mkdirSync report a folder
    // off the path removeMade walks and leave the run's own folder behind
    // while removing one that was already there. A mkdir that fails partway,
    // as on a full disk, reports nothing, so the first folder it would make
    // is found before.
    const target = path.resolve(dir);
    // Made again, and then this run's, when it goes while this run waits
    // for the lock, also when this run had made it before: two runs that
    // make the same new path at the same moment can each count part of it
    // as their own, and the one that fails removes that part. made is the
    // highest folder this run has made, which is the shortest path.
    const highest = (folder) => {
      if (folder && (!made || folder.length < made.length)) made = folder;
    };
    const makeFolder = () => {
      const missing = firstMissing(target);
      try {
        highest(fs.mkdirSync(target, { recursive: true }));
      } catch (err) {
        highest(missing);
        throw err;
      }
    };
    makeFolder();
    // The wait yields to the event loop; the rest runs without a pause, so a
    // stop signal is handled before the save starts or after it is done,
    // never halfway. The folder is read here, under the lock, as the one
    // read before the page may be out of date now.
    unlock = await lock(dir, makeFolder);
    putBack(dir);
    earlier = earlierKit(dir);
    part = makePart(dir);
    write(part, ownFiles(dir, earlier));
    putInPlace(dir, part, earlier);
    tidy(dir, part);
  } catch (err) {
    if (part && !err.keepPart) remove(part);
    if (unlock) unlock();
    if (made) removeMade(dir, made);
    // The new kit is written beside the earlier one before it takes its
    // place, so a replacing run needs room for both. A disk or quota that
    // runs out is said plainly, and the earlier kit is untouched. One that
    // runs out before the folder was read here, at the lock, finds the
    // earlier kit by reading it now.
    if (err.code === "ENOSPC" || err.code === "EDQUOT") {
      let had = earlier;
      try {
        had = had || earlierKit(dir);
      } catch {
        // Not a kit: nothing to say about it.
      }
      const kept = had && !had.cut;
      throw new Error(`There is no room on the disk to write the new kit${kept ? " beside the earlier one" : ""} in ${dir}, so no kit was made.${kept ? " The earlier kit there is as it was." : ""}`);
    }
    throw err;
  }
  unlock();
}

const slug = (text) =>
  String(text || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "font";

const weightText = ({ min, max }) => (min === max ? String(min) : `${min} ${max}`);

// files/<family>-<weight or "variable">[-<style>][-italic].<format>, the
// style when it is more than a weight ("grid" in Geist Pixel Grid), and
// numbered when two files would still share a name (the latin and
// latin-ext parts of one weight) or a name a file of the user's has in the
// kit's files folder (own).
function saveFiles(families, dir, own = []) {
  const taken = new Set(own.map((name) => name.toLowerCase()));
  fs.mkdirSync(path.join(dir, "files"));
  for (const family of families) {
    for (const file of family.files) {
      // A variable file's style is only its default instance.
      const style = file.variable ? [] : styleWords(file.style).filter((word) => !words(family.name).some((part) => part.toLowerCase() === word.toLowerCase()));
      const stem = `${slug(family.name)}-${file.variable ? "variable" : file.weight.min}${style.length ? `-${slug(style.join(" "))}` : ""}${file.italic ? "-italic" : ""}`;
      let name = `${stem}.${file.format}`;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem}-${n}.${file.format}`;
      taken.add(name.toLowerCase());
      fs.writeFileSync(path.join(dir, "files", name), file.buffer);
      file.file = `files/${name}`;
    }
  }
}

const quote = (name) => `"${String(name).replace(/["\\]/g, "\\$&")}"`;
// Generic families and system keywords stay bare: quoted, they would name a
// font called "sans-serif".
const cssName = (name) => (/^(-apple-system|BlinkMacSystemFont|system-ui|ui-[a-z-]+|serif|sans-serif|monospace|cursive|fantasy|emoji|math)$/i.test(name) ? name : quote(name));

// The weights a free family is loaded in: each weight the site uses, moved
// to the nearest one the family has.
function freeWeights(free, used) {
  const have = free.weights.length ? free.weights : [400];
  const pick = (w) => have.reduce((best, h) => (Math.abs(h - w) < Math.abs(best - w) ? h : best), have[0]);
  return [...new Set((used.length ? used : [400]).map(pick))].sort((a, b) => a - b);
}

function freeImports(picks) {
  const google = picks.filter(({ free }) => free.from === "Google Fonts");
  const lines = [];
  if (google.length) {
    const families = google.map(({ free, weights }) => `family=${free.family.replace(/ /g, "+")}:wght@${weights.join(";")}`);
    lines.push(`@import url("https://fonts.googleapis.com/css2?${families.join("&")}&display=swap");`);
  }
  for (const { free, weights } of picks.filter(({ free }) => free.from !== "Google Fonts")) {
    for (const w of weights) lines.push(`@import url("https://cdn.jsdelivr.net/npm/@fontsource/${free.id}/${w}.css");`);
  }
  return lines;
}

// The free family each role falls back to: the role's own family when it is
// open, else its first free match.
function freePick(family) {
  if (!family) return null;
  if (family.license.status === "open" && !family.system) return { name: family.name, own: true };
  const free = family.free[0];
  return free ? { name: free.family, free } : null;
}

// The page's address goes into a CSS comment, and the page sets it: a path,
// a redirect or a #fragment with */ in it would end the comment and put
// rules of the page's choosing, like an @import, at the top of fonts.css.
// Each * is written as %2A, which is the same address, so none can.
const inComment = (text) => String(text).replace(/\*/g, "%2A");

function writeCss(kit, families, dir) {
  const byKey = new Map(families.map((family) => [family.key, family]));
  const host = new URL(kit.url).hostname.replace(/^www\./, "");
  const picks = new Map();
  for (const role of Object.values(kit.roles)) {
    const pick = freePick(byKey.get(role.key));
    if (!pick || !pick.free) continue;
    const used = picks.get(pick.free.id) || { free: pick.free, used: new Set() };
    role.weights.forEach((w) => used.used.add(w));
    picks.set(pick.free.id, used);
  }
  const imports = freeImports([...picks.values()].map(({ free, used }) => ({ free, weights: freeWeights(free, [...used]) })));
  const lines = [
    `/* Fonts of ${inComment(host)}, read from ${inComment(kit.url)} on ${kit.capturedAt.slice(0, 10)} by easyfontkit ${version}.`,
    "   Each font file the page loaded has a @font-face rule below, under its",
    "   family's name. --font-heading, --font-body, --font-button and --font-code",
    "   are the site's own fonts; the -free ones are the closest free fonts.",
    "   FONTS.md says how each one is licensed. */",
    "",
    ...imports,
  ];
  if (imports.length) lines.push("");
  for (const family of families) {
    for (const file of family.files.filter((f) => f.file)) {
      lines.push(
        "@font-face {",
        `  font-family: ${quote(family.name)};`,
        `  src: url("${file.file}") format("${file.format === "ttf" ? "truetype" : file.format === "otf" ? "opentype" : file.format}");`,
        `  font-weight: ${weightText(file.weight)};`,
        `  font-style: ${file.italic ? "italic" : "normal"};`,
        ...(file.unicodeRange ? [`  unicode-range: ${file.unicodeRange};`] : []),
        "  font-display: swap;",
        "}",
        "",
      );
    }
  }
  lines.push(":root {");
  for (const [role, info] of Object.entries(kit.roles)) {
    const family = byKey.get(info.key);
    const stack = parseStack(info.stack);
    const generic = GENERIC[family ? family.category : "sans"];
    const own = family && !family.system ? [quote(family.name), ...stack.filter((name) => !family.cssNames.some((css) => css.toLowerCase() === name.toLowerCase())).map(cssName)] : stack.map(cssName);
    if (!own.includes(generic)) own.push(generic);
    lines.push(`  --font-${role}: ${[...new Set(own)].join(", ")};`);
    const pick = freePick(family);
    if (pick) lines.push(`  --font-${role}-free: ${quote(pick.name)}, ${generic};`);
  }
  lines.push("}", "");
  fs.writeFileSync(path.join(dir, "fonts.css"), lines.join("\n"));
}

const short = (text, n) => {
  const one = String(text || "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1).trim()}…` : one;
};
const list = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

const sentence = (text) => {
  const one = String(text || "").trim();
  return one ? `${one.charAt(0).toUpperCase()}${one.slice(1)}${/[.!?]["”']?$/.test(one) ? "" : "."}` : "";
};

function licenseLine(family) {
  const l = family.license;
  if (family.system) return "None needed from the site: it sends no file and asks for a font already on the visitor's computer.";
  const head = { open: `Open${l.name ? `, ${l.name}` : ""}.`, commercial: "Commercial.", unknown: "Unknown." }[l.status];
  // The file's own words say it best; the reasoning is given when they are
  // missing or when the call came from somewhere else.
  const fromText = /^the font file (says|names)/.test(l.basis);
  const parts = [head];
  if (!fromText || !l.text) parts.push(sentence(l.basis));
  if (l.text) parts.push(`The file says "${short(l.text, 200)}"${/[.!?]$/.test(short(l.text, 200)) ? "" : "."}`);
  if (l.url) parts.push(`License page: ${l.url}`);
  return parts.join(" ");
}

function writeMarkdown(kit, families, dir) {
  const byKey = new Map(families.map((family) => [family.key, family]));
  const host = new URL(kit.url).hostname.replace(/^www\./, "");
  const lines = [`# Fonts of ${host}`, "", `Read from ${kit.url} on ${kit.capturedAt.slice(0, 10)} by easyfontkit ${version}.`, ""];
  const roles = Object.entries(kit.roles);
  if (roles.length) {
    lines.push("| Role | Font | Weights | License | Closest free font |", "| --- | --- | --- | --- | --- |");
    for (const [role, info] of roles) {
      const family = byKey.get(info.key);
      const pick = freePick(family);
      const free = !pick ? "" : pick.own ? "itself" : pick.name;
      const also = info.also.length ? `, also ${list(info.also)}` : "";
      lines.push(`| ${ROLE_NAMES[role]} | ${info.family}${info.italic ? " (italic)" : ""}${also} | ${info.weights.join(", ")} | ${STATUS[family.license.status]} | ${free} |`);
    }
  } else {
    lines.push("No text was found in headings, body text, buttons or code.");
  }
  const section = (family) => {
    lines.push("", `## ${family.name}`, "");
    if (family.roles.length) lines.push(`- Used for: ${list(family.roles.map((role) => ROLE_WORDS[role]))}`);
    else lines.push("- Loaded by the page, but not drawn in its headings, body text, buttons or code");
    if (family.system) {
      lines.push(`- CSS: \`${family.stack}\``);
      if (family.drawnWith) lines.push(`- Drawn here with ${family.drawnWith}; each visitor gets their own system's font`);
    } else {
      if (family.cssNames.length && !family.cssNames.every((name) => name === family.name)) lines.push(`- CSS name: ${family.cssNames.join(", ")}`);
      const service = SOURCE_NAMES[family.source];
      lines.push(`- Served from: ${service && family.host ? `${service} (${family.host})` : family.host || service || "unknown"}`);
      if (family.license.maker) lines.push(`- Maker: ${family.license.maker}`);
      if (family.license.designer && family.license.designer !== family.license.maker) lines.push(`- Designer: ${family.license.designer}`);
      if (family.license.copyright) lines.push(`- Copyright: ${short(family.license.copyright, 160)}`);
    }
    lines.push(`- License: ${licenseLine(family)}`);
    if (family.files.length) {
      const saved = family.files.map((file) => `${file.file || file.url} (${file.variable ? `variable, weights ${file.weight.min} to ${file.weight.max}` : `weight ${file.weight.min}`}${file.italic ? ", italic" : ""}, ${Math.round(file.bytes / 1024)} KB)`);
      lines.push(`- Files: ${saved.join("; ")}`);
    } else if (family.missing) {
      lines.push("- Files: Chrome drew with it, but its file was not caught");
    }
    if (family.listed && family.license.status === "open") lines.push(`- Also on ${family.listed.from}: ${family.listed.from === "Google Fonts" ? `https://fonts.google.com/specimen/${family.listed.family.replace(/ /g, "+")}` : `https://fontsource.org/fonts/${family.listed.id}`}`);
    if (family.free.length) {
      lines.push("- Closest free fonts:");
      for (const free of family.free) lines.push(`  - ${free.family} (${free.from}, ${free.license}): ${free.basis}`);
    }
  };
  const drawn = families.filter((family) => family.roles.length);
  const others = families.filter((family) => !family.roles.length);
  drawn.forEach(section);
  if (others.length) {
    lines.push("", "## Other fonts the page loads", "", "These files were loaded too, but none of the text read above was drawn with them: icon fonts, or text further from the usual places.");
    others.forEach(section);
  }
  lines.push(
    "",
    "## How to use",
    "",
    "fonts.css declares every saved file under its family's name and sets a variable per role. Keep it next to the files folder:",
    "",
    "```css",
    '@import "fonts.css";',
    "h1, h2, h3 { font-family: var(--font-heading); }",
    "body { font-family: var(--font-body); }",
    "```",
    "",
    "`--font-heading` and the others are the site's own fonts. `--font-heading-free` and the other -free variables are the closest free fonts, loaded from Google Fonts or Fontsource. A commercial font is licensed by its maker, and the site's license does not carry over to other uses.",
  );
  if (kit.notes.length) lines.push("", "## Notes", "", ...kit.notes.map((note) => `- ${note}`));
  fs.writeFileSync(path.join(dir, "FONTS.md"), lines.join("\n") + "\n");
}

function publicFamily(family) {
  return {
    ...family,
    files: family.files.map((file) => ({
      file: file.file || "",
      url: file.url,
      format: file.format,
      weight: file.weight,
      style: file.style,
      italic: file.italic,
      variable: file.variable,
      unicodeRange: file.unicodeRange,
      bytes: file.bytes,
    })),
  };
}

// A request never carries the address's #fragment, so a change in that
// alone is not a move to another page.
const bare = (address) => address.replace(/#.*$/s, "");

// Who a message is about: the address asked, as it was given, and when the
// page moved on from it, by a redirect, a script or a meta refresh, the
// address it went to. That is told against the address of the first
// request Chrome sent for the page (first), not the one asked: Chrome
// writes some characters of an address otherwise than Node does, like a |
// in its path. When Chrome sent none, the page did not move.
function where(asked, to, first) {
  return to && first && bare(to) !== bare(first) ? `${asked} led to ${to}, which` : asked;
}

const httpStatus = (status) => `HTTP ${status}${STATUS_CODES[status] ? ` ${STATUS_CODES[status]}` : ""}`;

// A bot check served instead of the page, with the error status it often
// comes with.
function botCheck(asked, { pageUrl, first, challenge, answer }) {
  return `${where(asked, pageUrl, first)} answered with a bot check ("${challenge}")${answer.status >= 400 ? `, ${httpStatus(answer.status)},` : ""} instead of its page, so no kit was made. Open the site in a normal browser and try again later.`;
}

// A page that answers with an error status, after any redirects, is not the
// page that was asked for, and its fonts are often only the browser's
// defaults. What to try next depends on the status.
function errorPage(asked, { answer: { status, url }, first }) {
  const next =
    status >= 500 || status === 408 || status === 429
      ? "The site may be down or busy; try again later."
      : status === 401 || status === 403
        ? "The page may need a login, or the site may turn away headless browsers; check the page in a normal browser."
        : "Give the address of a page that loads without an error, like the site's home page.";
  return `${where(asked, url, first)} answered with an error, ${httpStatus(status)}, so no kit was made. ${next}`;
}

// A page that moved itself on to an address that could not be opened at
// all ends on the browser's own error page, whose fonts are the browser's.
// A redirect can also lead to a server that takes the connection and never
// answers. In a redirect loop every address answers, and Chrome gives up at
// whichever one it has reached, so the one to name is the one asked.
function notOpened(asked, { failed: { url, error, noAnswer }, first }) {
  if (noAnswer) return `${where(asked, url, first)} did not answer in ${noAnswer} s, so no kit was made. The site may be down or slow; try again later, or give it more time with --timeout.`;
  if (error === "net::ERR_TOO_MANY_REDIRECTS") return `Could not open ${asked}: ${error}`;
  return `${where(asked, url, first)} could not be opened${error ? ` (${error})` : ""}, so no kit was made. Check the page in a normal browser.`;
}

// A page that moved itself on to about:blank shows nothing, and the font
// files it had loaded before it went are not the fonts of a page.
function wentBlank(asked, { pageUrl, first, left }) {
  return `${where(asked, pageUrl, first)} moved itself on to ${left}, an empty page, so no kit was made. Check the page in a normal browser.`;
}

// A page that did not draw, so that it could not be scrolled: mostly one
// that waits for a style sheet that does not come, which holds back the
// fonts it asks for too. Read as it stands, it would give the browser's
// default fonts.
function stalledPage(asked, { pageUrl, first, stalled: { sheet } }) {
  const what = sheet ? `stayed blank: it waits for its style sheet ${sheet}, which did not come` : "stopped answering the browser while it was read";
  return `${where(asked, pageUrl, first)} ${what}, so no kit was made. Try again later, or check the page in a normal browser.`;
}

// The runs going on in this process, for a stop signal, and whether one has
// come: a run waiting for another to let go of a folder's lock gives up at
// once when it has, so the folder is left as it was.
const runs = new Set();
let stopping = false;

async function makeFontKit(rawUrl, { dir, files = true, timeLimit = 120_000, log = () => {} } = {}) {
  setTimeLimit(timeLimit);
  const url = normalizeUrl(rawUrl);
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  const target = dir || `easyfontkit-${host}`;
  // Refused before the page is read: a folder of someone else's, or one
  // this user cannot write in.
  const earlier = checkFolder(target);
  const run = { dir: target, earlier: Boolean(earlier && !earlier.cut) };
  runs.add(run);
  try {
    let scan;
    const chrome = await launch(SCREEN);
    let cdp;
    try {
      cdp = await openPage(chrome.base, SCREEN);
      scan = await scanPage(cdp, url, log);
    } finally {
      if (cdp) cdp.close();
      await chrome.close();
    }
    // Nothing waits from here to the end.
    if (scan.challenge) throw new Error(botCheck(url, scan));
    if (scan.answer.status >= 400) throw new Error(errorPage(url, scan));
    if (scan.failed) throw new Error(notOpened(url, scan));
    if (scan.left) throw new Error(wentBlank(url, scan));
    if (scan.stalled) throw new Error(stalledPage(url, scan));
    if (!Object.keys(scan.roles).length && !scan.files.length) {
      throw new Error(`${scan.pageUrl} showed no text and loaded no fonts, so nothing was read. The site may turn away headless browsers; check the page in a normal browser.`);
    }
    log("Reading the font files");
    const built = buildFamilies(scan);
    let kit;
    await saveKit(target, (part, own) => {
      if (files) saveFiles(built.families, part, own);
      const notes = [...built.notes];
      for (const skipped of scan.skipped) notes.push(`${skipped.url} was not a usable font file: ${skipped.reason}.`);
      if (!files) notes.push("Run with --no-files: the font files were read but not saved.");
      kit = {
        version: 1,
        url: scan.pageUrl,
        capturedAt: new Date().toISOString(),
        generator: `easyfontkit ${version}`,
        roles: built.roles,
        families: built.families.map(publicFamily),
        notes,
      };
      fs.writeFileSync(path.join(part, "fonts.json"), JSON.stringify(kit, null, 2) + "\n");
      writeMarkdown(kit, kit.families, part);
      writeCss(kit, kit.families, part);
    });
    return { dir: target, kit };
  } finally {
    runs.delete(run);
  }
}

// For a process that is being stopped: the runs going on, none of which
// has written anything yet, and their browsers, which are killed at once.
function stopRuns() {
  stopping = true;
  const stopped = [...runs];
  runs.clear();
  killBrowsers();
  return stopped;
}

module.exports = { makeFontKit, normalizeUrl, prepareDir, earlierKit, saveKit, stopRuns, slug };
