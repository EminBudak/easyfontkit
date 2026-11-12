# easyfontkit

Find the fonts a website really uses, save the font files, see how each one is licensed, and get the closest free font for the ones that are not free.

```bash
npx easyfontkit@latest linear.app
```

```
Saved the fonts of linear.app to easyfontkit-linear.app

  Headings  Inter 510, 590 (open)
  Body      Inter 400 (open)
  Buttons   Inter 510, 400, 590 (open)
  Code      Berkeley Mono 400 (commercial, free match: IBM Plex Mono)
  Files     3 font files in easyfontkit-linear.app/files

Read easyfontkit-linear.app/FONTS.md for the licenses and the free matches.
```

Ask a coding agent to build something in a site's style and it reads the CSS: `font-family: sohne-var, "SF Pro Display", sans-serif`. That is a wish list, not an answer. Which of those did the browser use? Who made it? Can you use it too? easyfontkit opens the site in a headless browser, asks Chrome which font it actually drew the headings, the body text, the buttons and the code with, keeps the font files the page loaded, and reads what each file says about its own license. Your agent gets one Markdown file with the answers.

## Requirements

- Node.js 22 or newer.
- Google Chrome or Chromium, which opens the site and says which fonts it drew the text with. It has been tested with Google Chrome only: 155 on Ubuntu 26.04, 157 on Ubuntu 22.04 and the ones GitHub's ubuntu-22.04, ubuntu-24.04 and ubuntu-latest runners come with, and not with Chromium. Chrome runs in its sandbox unless easyfontkit runs as root: Chrome does not start as root with its sandbox, so the run starts it without one. On Linux, Google Chrome's own package sets the sandbox up, and a container has to let it start, as Docker does with `--security-opt seccomp=unconfined`. easyfontkit looks for it on your PATH on Linux and where macOS and Windows install it, and for Edge and Brave as well, which no test has run with; on Windows it finds Chrome and Edge only. Set `CHROME_PATH` to use another build, as a path or a name on your PATH. The browser takes its pipe to easyfontkit on its file descriptors 3 and 4, so a program that `CHROME_PATH` names and that starts the browser has to hand those on. One that does not stops the run, quoting Chrome's "Remote debugging pipe file descriptors are not open." Before any work, a run looks at the path `CHROME_PATH` or the search gave, and one where nothing is, a folder, a link that leads nowhere or round a loop, a file this user may not run, as on a disk mounted noexec, or an empty file stops it with that path and what is wrong with it. A browser the system cannot start, or one that ends before it answers, stops the run before anything is made too, with the system's own reason, or with a line the browser printed, the line of Chrome's own log that ended it where there is one, in quotes, and how it ended, and says how to point to one that runs. When what it printed says its sandbox could not start, the message adds what lets a sandbox start, and where the system keeps even the sandbox's setuid helper from making namespaces, as a container with Docker's default seccomp does, that another browser does not help. When the system could not start the browser for want of open files, processes or memory, or what the browser printed says that it or the system ran short of them, as Chrome's "Too many open files" or "pthread_create: Resource temporarily unavailable", the message says that and what to do in place of how to get another browser. As Chrome can also run short of open files and print only what failed for want of them, the message says so as well when this process may have fewer than 1024 files open, which the browser takes on, or when this user runs within 100 of the most processes and threads they may. A program for another kind of machine, which Linux hands to /bin/sh, whose words the message then quotes, is named as one, as "That file is a program for 64-bit ARM".
- Linux, where it is tested: on Ubuntu 22.04, on Ubuntu 24.04 and on GitHub's ubuntu-latest runner, on every push and before every release. This release has also run on Ubuntu 26.04 with Node.js 22.22 and on Ubuntu 22.04 with Node.js 22.23. It is written for macOS and Windows as well, but it has not been run on either.
- Room on the disk for the kit and the one before it, as the earlier kit stays until the new one is in place, and in the temp folder for Chrome's profile.
- On Linux, a temp folder whose path has no `:` in it, on a disk that takes symbolic links: the stand-ins the browser starts with (see below) are links in its profile there, and a `:` would part their folder from the rest of the browser's PATH. A relative `TMPDIR` is judged by its full path, from the folder the run is started in. A run in another temp folder stops before the browser starts and says so; set `TMPDIR` to one that fits.
- Network access to the site, which the browser opens with its fonts as any browser would. The free fonts the matches come from are listed in a file that ships with easyfontkit. Installing it needs the network, and `npx easyfontkit@latest` asks npm for the newest version each time it runs. No ffmpeg, no account, no API key and no npm dependencies.

## What you get

```
easyfontkit-linear.app/
  FONTS.md      the fonts per role, each family's maker and license, and free matches
  fonts.css     a @font-face rule per saved file, and the fonts as CSS variables
  fonts.json    the same, for scripts
  files/        every font file the page loaded, as the browser received it
```

FONTS.md starts with a table:

| Role | Font | Weights | License | Closest free font |
| --- | --- | --- | --- | --- |
| Headings | Inter | 510, 590 | Open | itself |
| Body text | Inter | 400 | Open | itself |
| Buttons | Inter | 510, 400, 590 | Open | itself |
| Code | Berkeley Mono | 400 | Commercial | IBM Plex Mono |

Then a section per family: where it was served from, who made it, its copyright line, what the file says about its license and the license link, the saved files with their weights, and for a font that is not free, the three closest free fonts and why each one was picked.

fonts.css gives every role two variables. `--font-code` is the site's own font, backed by the saved file. `--font-code-free` is the closest free font, loaded from Google Fonts or Fontsource, or the site's own font when that is open. Use whichever fits what you are making. With `--no-files` no file is saved, so fonts.css has no @font-face rule and says so, and it loads an open font of the site's from Google Fonts or Fontsource as well, where they have it.

The folder has to be new, empty or hold an earlier kit. easyfontkit refuses any other, and one it may not write in, before it opens the page. Run it again into the same folder and the new kit takes the place of the earlier one once all of it is written. A run replacing a kit writes the new one beside the old for a moment, so it needs room on the disk for both; if it runs out, it says so and leaves the earlier kit as it was. Two runs that save into one folder at the same moment take turns. Other files you keep there, in files/ too, are never removed or replaced. A run that fails, or is stopped with Ctrl-C, Ctrl-\ (Ctrl-Break on Windows), SIGTERM or SIGHUP, leaves the folder as it was: the earlier kit stays whole, nothing is added, and a folder that was not there is not made. The stop has to reach easyfontkit itself: Ctrl-C in its terminal does, and so does a signal sent to its process group, but a signal sent to the `npx` process alone can stop only npx and leave the run going. A run killed outright (kill -9, or a forced end on Windows) can leave a hidden .easyfontkit-part folder or .easyfontkit-lock file there, which the next run that ends well in the folder removes. If it was killed while it moved the new kit in, the folder is left half replaced, with the rest of the earlier kit in that hidden folder, and the next run that saves a kit there puts the earlier kit back together before anything else. A run killed outright cannot remove its headless browser's throwaway profile either: the browser quits by itself once the run has gone, as the pipe it is driven through closes, but the profile, a folder whose name starts with easyfontkit-chrome-, stays in the temp folder for you or the system's temp clean-up to remove.

## How the license is read

A font file carries its own fine print: a copyright line, a license description, a license link, the maker's name, and bits that say whether it may be embedded. easyfontkit reads them in this order:

1. The file names an open license (SIL Open Font License, Apache, Ubuntu Font Licence, MIT, CC0): open.
2. The file sells or restricts itself ("Webfont sold by Klim Type Foundry, for use of the licensee only."), or points to its maker's license page: commercial.
3. The file came from Google Fonts, Fontsource or Bunny Fonts: open. From Adobe Fonts, Monotype or Typography.com: commercial.
4. The file only allows preview and print embedding: commercial.
5. Fontsource lists the family under an open license: open. This catches sites that self-host Inter with its license fields stripped.
6. Anything else: unknown.

Every file is saved either way, and FONTS.md says which is which. If a foundry wrote the site's own license number into the file, that number is left out of what the kit prints.

## How the free match is picked

Well-known paid fonts have hand-picked matches: Arimo for Arial and Helvetica, Tinos for Times New Roman, Carlito for Calibri, Montserrat for Gotham, EB Garamond for Garamond, JetBrains Mono for SF Mono, and a few more. Fonts like Arimo and Tinos are metric-compatible, so text breaks on the same lines. That holds for the family's own weights only: a heavy, narrow or wide cut is a design of its own. Arial Black and Arial Narrow do not get Arimo, also when Arial or Helvetica follows them in the CSS, and Helvetica Neue Black gets Inter alone.

Any other font is measured: its x-height, cap height and the average width of its lowercase, as shares of the em. easyfontkit compares those with every free sans, serif and monospaced font on Fontsource, measured the same way, and picks the three nearest. Fonts made for another script first, small caps cuts, condensed cuts and display faces are left out, a slab serif only stands in for another slab serif, and among near matches the more popular Google Fonts families come first. The result keeps sizes and line lengths close. It does not promise the same character, so look at it before you commit.

## Use it with your agent

easyfontkit ships as an [Agent Skill](https://agentskills.io). Install it once and your agent runs it by itself when you ask for something in a site's typography:

```bash
npx skills add EminBudak/easyfontkit
```

That covers Claude Code, Codex, Cursor and the other agents the [`skills`](https://github.com/vercel-labs/skills) CLI supports. In Claude Code you can add it as a plugin instead:

```
/plugin marketplace add EminBudak/easyfontkit
/plugin install easyfontkit@easyfontkit
```

In GitHub Copilot CLI, add the repo as a plugin marketplace and install from it:

```bash
copilot plugin marketplace add EminBudak/easyfontkit
copilot plugin install easyfontkit@easyfontkit
```

Then ask as usual:

> Build a pricing page that uses the same fonts as stripe.com

The skill tells the agent to name any commercial font before it goes into published work, and to build with the free match until you say you hold a license.

## Use it from the command line

```
npx easyfontkit <url> [options]

  --out <dir>      where to save (default: ./easyfontkit-<host>)
  --no-files       read the font files but do not save them
  --json           print fonts.json instead of a summary
  --timeout <s>    give up after this many seconds (default: 120)
```

Installed globally (`npm install -g easyfontkit`), the command is `easyfontkit`. npx keeps the copy an earlier run fetched, so `npx easyfontkit@latest` is how you get a newer version.

There are no npm dependencies and no browser to download: easyfontkit drives the browser you already have over the Chrome DevTools Protocol, with a throwaway profile, and reads the font files with Node's own zlib. The protocol goes through a pipe between easyfontkit and the browser, not a network port, so no other program on your machine can read or drive the browser while it runs. The browser's component updater is pointed at a closed port, so the browser does not download its own components during a run, and on Linux its crash reports go into its throwaway profile, not into your own browser's folder. The browser also refuses every download a page starts, like a link or a redirect to a file, and a browser that cannot be told to refuse them is not used. Chrome writes the first bytes of such a file before it refuses it: on Linux into a folder of its throwaway profile, never into your Downloads folder, and they go with the profile. On macOS and Windows, which no test has run on, easyfontkit does not move that folder, so they can be in your Downloads folder for a moment.

Chrome hands an address that is not a web address, such as `mailto:` or `news:`, to a program of the machine without asking, so a site could start your mail program with what it wrote in the address, or `xdg-open` as the user of a server that runs easyfontkit for others. On every system, a guard in the page cancels a move to such an address before the browser acts on it: a move the page makes of itself, by its script, a refresh, a form or a link, a move a frame that shows a page makes of itself, also a frame of another site, which runs apart from the page and which the browser holds as it starts until it has the guard, and a move the page makes of a frame of its own site that shows a page. The browser also opens no window a page asks for without a click. The guard never sees a frame's first address, a frame the page makes, or a frame of another site, that the page sends to such an address by its script, a frame at `about:blank`, or made with no address, that the page puts a script in, a frame with no origin of its own, as one at a `data:` address or a sandboxed one, that moves itself, or a redirect to one: those still reach the browser. On Linux, Chrome hands those over the session bus to the desktop's portal, which opens them with your own mail program, or to `xdg-email` or `xdg-open` when it finds no portal there. So the browser starts with no display and a session bus where nothing listens, whatever easyfontkit was started with: `DISPLAY` is unset, and `WAYLAND_DISPLAY` and `DBUS_SESSION_BUS_ADDRESS` name sockets in its throwaway profile that are never made, as either left unset would lead a program to the desktop's own in `XDG_RUNTIME_DIR`. It also starts with stand-ins first on its PATH for `xdg-open`, `xdg-email` and `xdg-settings`, which it hands such addresses to or asks about them, and for `x-www-browser`, `www-browser` and `sensible-browser`, which `xdg-open` goes on to: links in its throwaway profile to `true`, which starts nothing. What reaches the browser then starts nothing either, also from a temp folder mounted noexec. A browser installed as a snap or a Flatpak runs in a sandbox of its own, where it may find other programs by those names or ask the desktop to open the address, so there only the cancelling holds. easyfontkit tells such a browser by its path, and once it runs by where its processes run from, as when Ubuntu's `chromium-browser` starts the chromium snap; no test has run with one. On macOS and Windows the browser asks the system instead, so there what the guard never sees can still reach the system's own program, the mail program for `mailto:`. No test has run on either. FONTS.md names the first three such addresses easyfontkit saw a page try and counts the rest, and says of one that reached the browser there, or a browser in a sandbox of its own, that the system may have opened it. An address you give that redirects to one gets no kit, and where such an address can reach the system's own program, the message says the system may have opened it.

## How it works

1. Opens the page in a headless browser on a 1600x900 desktop screen, with the network recorded, so each font file is kept as it arrives, and each font the page gives as a `data:` address as the browser asks for it. A font the page's CSS names that the browser never asks for, as a fallback after one it took, is not read.
2. Waits for the page to load and for its fonts, then scrolls to the bottom and back, so sections that render late load their fonts too, and waits for the fonts again. The load is waited for up to 30 s, and the page's fonts up to 5 s more before the scroll and again after it, so a font that is slow to come holds the run until it comes, and one that never comes holds it about 40 s.
3. For up to 24 headings, paragraphs, buttons and code blocks, asks Chrome which fonts it drew the text with and how many glyphs each one drew. The font with the most glyphs is the role's font.
4. Ties each of those fonts to its file by the names inside the file, by the @font-face rule that loads it, or by Chrome's own record of the web fonts it loaded. Some sites hide the names in their files; then the CSS name stands in.
5. Reads every file's name, OS/2, post, head, cmap and hmtx tables (WOFF2, WOFF, TrueType and OpenType), decides the license, and measures the font for the free match.
6. Writes the kit into a hidden folder inside the kit's folder. Once all of it is written, it moves the earlier kit's files aside and the new ones in, one at a time, with fonts.json last, so a fonts.json in the folder always goes with the files next to it.

The index of free fonts in `skills/easyfontkit/scripts/data/fonts.json` comes from the [Fontsource](https://fontsource.org) API and the Google Fonts catalog, with the measurements taken from Fontsource's files. `npm run build-index` rebuilds it.

## Limits

- Text drawn into a canvas, an image or an SVG path has no font to find.
- A role is read from the page's own headings, paragraphs, buttons and code. A site that builds its headings from plain divs gets them from elements named "title" or "heading" instead, and may get them wrong.
- A site that answers with a bot check gets no kit: easyfontkit stops and says so.
- A page that answers with an error status, like a 404 or a 500, gets no kit either, also after a redirect: an error page is not the page you asked for, and its fonts are often only the browser's defaults. easyfontkit names the status and the address it ended on. A site that serves some of its real pages with an error status, like an app whose deep links answer 404, gets no kit for those; read its home page instead.
- A page that moves itself on, by a script or a meta refresh, is read where it ends up, and the kit names that address. One that goes on to a blob: address it made itself, which has no host, is read there and named by the page that made it. A redirect, a script or a meta refresh that leads to an address that cannot be opened, like a host that does not resolve, would end on the browser's own error page: easyfontkit makes no kit and names that address, as it does for a redirect to a server that never answers. Addresses that redirect to each other in a loop get no kit, and the message names the address you asked for. A page that moves itself on to about:blank, an empty page, gets no kit either.
- A page that stays blank because a style sheet it waits for never comes gets no kit: read as it stands, it would give the browser's default fonts. easyfontkit names that style sheet.
- A font file the browser asked for and did not get while the page was read, as from a font server that is slow or down, is not in the kit. When the headings, the body text, the buttons or the code ask for its family before any font of the visitor's own, FONTS.md names that family as the page's CSS does, with the file's address, and says its license is unknown. A run later may get the file, unless the browser refused it, as it refuses a font from another site whose server does not let this one use it (CORS), or one the page's own Content-Security-Policy keeps out. FONTS.md then says that the browser refused it. A refused file the page also asked for in another way, as with a preload without crossorigin, is in the kit, and FONTS.md says the browser refused it to the page's @font-face rule, so its text is drawn with a fallback on every visit. A file whose server sends no bytes, one cut short or broken, or one whose tables would unpack to more than 64 MB, or to more than the file itself says, is not in the kit either, and FONTS.md says so. Each file is unpacked once, to no more than that.
- easyfontkit keeps up to 200 MB of a page's font files, those the page loads and those it gives as `data:` addresses, and reads none larger than 64 MB. Of a page that serves more, the files past that are not read: FONTS.md says how many there were and names the first, and a family whose file was not read shows with an unknown license that says why. Font files a page sends at the same moment, past about 120 MB in all, can be left out as well, as the browser lets go of the first of them before easyfontkit has read them: FONTS.md counts those apart and names the first in the same way. Of the text of a page's style sheets, a run reads up to 64 MB; the @font-face rules of a sheet past that, or of a sheet a script built, are still read from the browser when the sheet is of the page's own site. The browser holds what the page loads, as any browser does, so a page that serves very large files still takes memory there. A page that runs out of memory, as one that loads very large files can on a machine or in a job held to a memory limit, or one whose own scripts use more than the browser gives a page, crashes, and easyfontkit stops with no kit and says so.
- Text in characters a web font has no glyphs for, as Japanese or an emoji in a Latin font, is drawn by the browser with another font. FONTS.md says so in a note and counts that text as the web font the CSS asks for. Text in characters that a file of the font's for them covers, as the Cyrillic file of a family split by unicode-range as Google Fonts serves it, that had not come while the page was read, gets a note that names that file instead, and the kit has no file of the font for those characters.
- On a busy machine the browser can be slow. Its start and the opening of its page each get the time the run has left less a minute: 30 s at least, or all of it when less is left. A browser that takes longer, or that stops answering, ends the run with no kit and a message that says so, like "google-chrome did not start in 60 s, so no kit was made." A run whose time runs out before any of the page's text could be read makes no kit either and says so, and one whose time runs out after some of it notes the roles it could not read. Try again, or give the run more time with `--timeout`.
- The free match is chosen on proportions, not on how the letters are drawn. A visual comparison is on the list for a later version.

## License

MIT
