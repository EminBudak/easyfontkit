"use strict";

// The browser's answers that need no browser: a stand-in for the DevTools
// connection says what the real one would.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { launch, navigate } = require("../skills/easyfontkit/scripts/lib/chrome");
const { setTimeLimit } = require("../skills/easyfontkit/scripts/lib/time");

test("on Linux, Chrome's temp folder is its profile when the socket it makes there fits, so what it leaves there goes with the profile", { skip: ["darwin", "win32"].includes(process.platform) && "Chrome takes its temp folder from TMPDIR on Linux only" }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "easyfontkit-temp-"));
  const saved = { TMPDIR: process.env.TMPDIR, CHROME_PATH: process.env.CHROME_PATH };
  // A browser that writes down the temp folder it was given and its
  // profile, then quits.
  const seen = path.join(parent, "seen");
  process.env.CHROME_PATH = path.join(parent, "chrome");
  fs.writeFileSync(
    process.env.CHROME_PATH,
    `#!/bin/sh
for arg in "$@"; do case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}";; esac; done
printf '%s\\n%s\\n' "$TMPDIR" "$profile" > ${JSON.stringify(seen)}
`,
    { mode: 0o755 },
  );
  // A temp folder with a short path, given from inside the folder that
  // holds it, and one too long for the socket.
  const cwd = process.cwd();
  fs.mkdirSync(path.join(parent, "t"));
  fs.mkdirSync(path.join(parent, "x".repeat(60)));
  try {
    process.chdir(parent);
    for (const [tmp, fits] of [
      ["t", true],
      [path.join(parent, "x".repeat(60)), false],
    ]) {
      process.env.TMPDIR = tmp;
      await assert.rejects(launch({ width: 800, height: 600 }), /did not start/);
      const [given, profile] = fs.readFileSync(seen, "utf8").split("\n");
      assert.equal(path.dirname(profile), tmp);
      assert.equal(given, fits ? profile : tmp);
      assert.equal(fs.existsSync(profile), false, "the profile is removed");
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
    });
    assert.ok(Math.abs(given - seconds * 1000) < 1_000, `${given} ms for a ${limit} ms run`);
  }
  setTimeLimit(120_000);
});
