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

fonts.css gives every role two variables. `--font-code` is the site's own font, backed by the saved file. `--font-code-free` is the closest free font, loaded from Google Fonts or Fontsource. Use whichever fits what you are making.

The folder has to be new, empty or hold an earlier kit. easyfontkit refuses any other, and one it may not write in, before it opens the page. Run it again into the same folder and the new kit takes the place of the earlier one once all of it is written. A run replacing a kit writes the new one beside the old for a moment, so it needs room on the disk for both; if it runs out, it says so and leaves the earlier kit as it was. Two runs that save into one folder at the same moment take turns. Other files you keep there, in files/ too, are never removed or replaced. A run that fails, or is stopped with Ctrl-C, Ctrl-\ (Ctrl-Break on Windows), SIGTERM or SIGHUP, leaves the folder as it was: the earlier kit stays whole, nothing is added, and a folder that was not there is not made. The stop has to reach easyfontkit itself: Ctrl-C in its terminal does, and so does a signal sent to its process group, but a signal sent to the `npx` process alone can stop only npx and leave the run going. A run killed outright (kill -9, or a forced end on Windows) can leave a hidden .easyfontkit-part folder or .easyfontkit-lock file there, which the next run that ends well in the folder removes. If it was killed while it moved the new kit in, the folder is left half replaced, with the rest of the earlier kit in that hidden folder, and the next run that saves a kit there puts the earlier kit back together before anything else. A run killed outright cannot end its headless browser either: the browser goes on running, and its throwaway profile, a folder whose name starts with easyfontkit-chrome-, stays in the temp folder. A kill sent to the whole process group ends the browser too, but leaves the profile, for you or the system's temp clean-up to remove.

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

It needs Node 22 or newer and Chrome, Chromium, Edge or Brave. Set `CHROME_PATH` to pick the browser. There are no npm dependencies and no browser to download: easyfontkit drives the browser you already have over the Chrome DevTools Protocol, with a throwaway profile, and reads the font files with Node's own zlib. The browser's component updater is pointed at a closed port, so the browser does not download its own components during a run, and on Linux its crash reports go into its throwaway profile, not into your own browser's folder. The browser also refuses every download a page starts, like a link or a redirect to a file, so a site cannot save a file on your machine.

## How it works

1. Opens the page in a headless browser on a 1600x900 desktop screen, with the network recorded, so each font file is kept as it arrives.
2. Waits for the fonts, then scrolls to the bottom and back, so sections that render late load their fonts too.
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
- On a busy machine the browser can be slow to open its page. It gets the time the run has left less a minute for that: 30 s at least, or all of it when less is left. A browser that takes longer ends the run with no kit and a message that says so, like "google-chrome did not open a page in 60 s, so no kit was made." Try again, or give the run more time with `--timeout`.
- The free match is chosen on proportions, not on how the letters are drawn. A visual comparison is on the list for a later version.

## License

MIT
