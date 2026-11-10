#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const { makeFontKit, stopRuns } = require("./lib/kit");
const version = require("./lib/version");

const USAGE = `Usage: easyfontkit <url> [options]

Reads a website the way a browser draws it and saves its fonts in one
folder: which font its headings, body text, buttons and code are drawn
with, every font file the page loads, how each one is licensed, and the
closest free font for each one that is not free. FONTS.md is for people
and coding agents, fonts.css for pages, fonts.json for tools.

A page that answers with an error status, like a 404, or that ends on an
address that cannot be opened or on about:blank gets no kit. The folder
has to be new, empty or hold an earlier kit, which a new run replaces once
the new kit is whole. A run that fails or is stopped leaves the folder as
it was.

Options:
  --out <dir>      where to save (default: ./easyfontkit-<host>)
  --no-files       read the font files but do not save them
  --json           print fonts.json instead of a summary
  --timeout <s>    give up after this many seconds (default: 120)
  -h, --help       show this help
  -v, --version    show the version

Needs Node 22 or newer and Chrome, Chromium, Edge or Brave. Set CHROME_PATH
to pick the browser, by its path or a name on your PATH.`;

function parse(argv) {
  const options = { files: true, json: false, timeout: 120 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "-v" || arg === "--version") options.version = true;
    else if (arg === "--no-files") options.files = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "--out" || arg === "--timeout") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error(`${arg} needs a value`);
      if (arg === "--out") options.out = value;
      else options.timeout = Number(value);
    } else if (arg.startsWith("--out=")) options.out = arg.slice(6);
    else if (arg.startsWith("--timeout=")) options.timeout = Number(arg.slice(10));
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else rest.push(arg);
  }
  if (!(options.timeout >= 30 && options.timeout <= 600)) throw new Error("--timeout takes 30 to 600 seconds");
  if (!options.help && !options.version && rest.length !== 1) throw new Error("Give one website address, for example: easyfontkit acme.com");
  return { ...options, url: rest[0] };
}

const ROLE_LABELS = { heading: "Headings", body: "Body", button: "Buttons", code: "Code" };
const STATUS = { open: "open", commercial: "commercial", unknown: "license unknown", system: "system font" };

function summary({ dir, kit }) {
  const byKey = new Map(kit.families.map((family) => [family.key, family]));
  const host = new URL(kit.url).hostname.replace(/^www\./, "");
  const lines = [`Saved the fonts of ${host} to ${dir}`, ""];
  for (const [role, info] of Object.entries(kit.roles)) {
    const family = byKey.get(info.key);
    const free = family.license.status === "open" && !family.system ? "" : family.free[0] ? `, free match: ${family.free[0].family}` : "";
    lines.push(`  ${ROLE_LABELS[role].padEnd(9)} ${info.family} ${info.weights.join(", ")} (${STATUS[family.license.status]}${free})`);
  }
  if (!Object.keys(kit.roles).length) lines.push("  No text found in headings, body text, buttons or code");
  const saved = kit.families.flatMap((family) => family.files).filter((file) => file.file);
  const all = kit.families.flatMap((family) => family.files);
  lines.push(`  Files     ${saved.length ? `${saved.length} font file${saved.length === 1 ? "" : "s"} in ${dir}/files` : all.length ? `${all.length} read, none saved` : "none loaded"}`);
  for (const note of kit.notes) lines.push(`  Note      ${note}`);
  lines.push("", `Read ${dir}/FONTS.md for the licenses and the free matches.`);
  return lines.join("\n");
}

// Ctrl-C, Ctrl-\ (Ctrl-Break on Windows), a kill or a closed terminal while
// the page is read: the browser is killed and the process ends by the same
// signal, before the run has written anything, so the kit's folder is left
// as it was. Once the kit is in place, the run has ended well, and a stop
// that comes then ends the process with 0, as it would have ended. The
// listeners stay until the process ends, so a second copy of the signal, as
// npm and makersmcp's supervisor pass one on, changes nothing. An error that
// ends the process kills the browser too.
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", ...(process.platform === "win32" ? ["SIGBREAK"] : ["SIGQUIT"])];
let stopping = false;

// Written at once: a pipe can be asynchronous, and the process ends right
// after. One that nobody reads any more, as when the program that started
// the run has gone, or a terminal that has closed, fails the write, and the
// stop goes on all the same.
function say(fd, text) {
  try {
    fs.writeSync(fd, text);
  } catch {
    // Nobody is reading.
  }
}

function stopOnSignals() {
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      const stopped = stopRuns();
      if (!stopped.length) return void process.stdout.write("", () => process.exit(0));
      for (const run of stopped) say(2, `easyfontkit: stopped by ${signal}, so no kit was made.${run.earlier ? ` The earlier kit in ${run.dir} is as it was.` : ""}\n`);
      for (const name of SIGNALS) process.removeAllListeners(name);
      const code = 128 + os.constants.signals[signal];
      try {
        process.kill(process.pid, signal);
      } catch {
        // Windows cannot raise every signal.
        process.exit(code);
      }
      // Only reached where that signal does not end a process.
      setTimeout(() => process.exit(code), 100);
    });
  }
  process.on("exit", () => stopRuns());
}

async function main() {
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`easyfontkit: ${err.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (options.help) return void process.stdout.write(`${USAGE}\n`);
  if (options.version) return void process.stdout.write(`${version}\n`);
  // A progress line nobody reads any more, as when the reader stops after
  // the first line, does not stop the run: what came of it is in its exit
  // status and on stdout.
  process.stderr.on("error", () => {});
  stopOnSignals();
  try {
    const result = await makeFontKit(options.url, {
      dir: options.out,
      files: options.files,
      timeLimit: options.timeout * 1000,
      log: options.json ? () => {} : (line) => process.stderr.write(`${line}...\n`),
    });
    // Ended here once the kit is printed: left to end by itself, Node puts
    // the signals back to their default action as it winds down, and a stop
    // that came in those few milliseconds would end a run whose kit is
    // already in place by that signal instead of with 0.
    process.stdout.write(options.json ? JSON.stringify(result.kit, null, 2) + "\n" : summary(result) + "\n", () => process.exit(0));
  } catch (err) {
    // A stopped run has said so, and ends by its signal.
    if (stopping) return;
    if (options.json) process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + "\n");
    process.stderr.write(`easyfontkit: ${err.message}\n`);
    process.exit(1);
  }
}

main();
