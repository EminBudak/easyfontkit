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

The folder has to be new, empty or hold an earlier kit; easyfontkit refuses any other. Run it again into the same folder and the new kit takes the place of the earlier one once all of it is written. Other files you keep there, in files/ too, are never removed or replaced. A run that fails, or is stopped with Ctrl-C, SIGTERM or SIGHUP, leaves the folder as it was: the earlier kit stays whole, nothing is added, and a folder that was not there is not made. Only a run killed outright in the moment it writes the kit (kill -9, or a forced end on Windows) can leave a hidden .easyfontkit-part folder behind, and the next run that ends well in that folder removes it.

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

Well-known paid fonts have hand-picked matches: Arimo for Arial and Helvetica, Tinos for Times New Roman, Carlito for Calibri, Montserrat for Gotham, EB Garamond for Garamond, JetBrains Mono for SF Mono, and a few more. Fonts like Arimo and Tinos are metric-compatible, so text breaks on the same lines.

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

It needs Node 22 or newer and Chrome, Chromium, Edge or Brave. Set `CHROME_PATH` to pick the browser. There are no npm dependencies and nothing is downloaded besides the page itself: easyfontkit drives the browser you already have over the Chrome DevTools Protocol, with a throwaway profile, and reads the font files with Node's own zlib.

## How it works

1. Opens the page in a headless browser on a 1600x900 desktop screen, with the network recorded, so each font file is kept as it arrives.
2. Waits for the fonts, then scrolls to the bottom and back, so sections that render late load their fonts too.
3. For up to 24 headings, paragraphs, buttons and code blocks, asks Chrome which fonts it drew the text with and how many glyphs each one drew. The font with the most glyphs is the role's font.
4. Ties each of those fonts to its file by the names inside the file, by the @font-face rule that loads it, or by Chrome's own record of the web fonts it loaded. Some sites hide the names in their files; then the CSS name stands in.
5. Reads every file's name, OS/2, post, head, cmap and hmtx tables (WOFF2, WOFF, TrueType and OpenType), decides the license, and measures the font for the free match.
6. Writes the kit into a hidden folder inside the kit's folder and, once all of it is written, moves it in place of the earlier kit in one go.

The index of free fonts in `skills/easyfontkit/scripts/data/fonts.json` comes from the [Fontsource](https://fontsource.org) API and the Google Fonts catalog, with the measurements taken from Fontsource's files. `npm run build-index` rebuilds it.

## Limits

- Text drawn into a canvas, an image or an SVG path has no font to find.
- A role is read from the page's own headings, paragraphs, buttons and code. A site that builds its headings from plain divs gets them from elements named "title" or "heading" instead, and may get them wrong.
- A site that answers with a bot check gets no kit: easyfontkit stops and says so.
- The free match is chosen on proportions, not on how the letters are drawn. A visual comparison is on the list for a later version.

## License

MIT
