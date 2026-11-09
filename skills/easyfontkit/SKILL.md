---
name: easyfontkit
description: Find the fonts a website really draws its headings, body text, buttons and code with, save every font file the page loads, say how each one is licensed, and name the closest free font for each one that is not free. Use it whenever the user wants to match a site's typography, asks what font a site uses or whether it is free, or asks for a page, video, slide deck or image in a product's style and you know its website.
---

# easyfontkit

A CSS font stack says what a site asks for, not what the visitor sees, and a font's name says nothing about whether it is free. easyfontkit opens the site in a headless browser, asks Chrome which font it really drew each kind of text with, keeps the font files the page loaded, and reads each file's own license fields.

## Get the kit

```bash
node <skill>/scripts/easyfontkit.js <url> --out fonts/<name>
```

`<skill>` is this skill's folder. The script needs Node 22 or newer and Chrome, Chromium, Edge or Brave on the machine; it installs nothing and needs no API key. A run takes 15 to 60 seconds. Any page of a site works, and fonts can differ between a home page and its docs, so read the page whose look you need.

The folder has to be new, empty or hold an earlier kit. A new run into it replaces the earlier kit once the new one is whole. A run that fails or is stopped leaves the folder as it was: a kit an earlier run left there is still whole, and nothing is added.

## Use it

1. Read `fonts/<name>/FONTS.md` first. Its table gives each role's font, the weights the site uses, the license and the closest free font.
2. Each family's section says who made it, where it was served from and what its file says about its license. Open means it may be used under that license anywhere. Commercial means its maker sells it, and the site's license covers the site, not other work. Unknown means neither the file nor its source says. A system font is the visitor's own and comes with no file.
3. In CSS, import `fonts.css` from the kit folder and use `var(--font-heading)`, `var(--font-body)`, `var(--font-button)` and `var(--font-code)` for the site's own fonts, or the `-free` variables for the closest free ones. The font files are in `files/`.
4. Before a commercial or unknown font goes into work the user will publish, tell them which one it is and who sells it, and ask whether they hold a license. Until they answer, build with the `-free` variable. Open fonts need no question.
5. For images and video, name the families in prompts and titles, and hand the files in `files/` to tools that take a font file.
6. `fonts.json` holds the same facts for scripts.

## When it goes wrong

- A free match chosen by proportions has a similar x-height, cap height and width, which keeps line lengths and spacing close. It can still look different. Tell the user it is the nearest free font, not the same design.
- If a role shows a system font where you expected the brand's own, the site may load its fonts late. Try `--timeout 240`, and tell the user what you got.
- If the site answers with a bot check, the run stops and says so. Ask the user for the font names.
- If the page answers with an error status, the run stops, writes nothing and names the status and the address it ended on. After a 404, check the address with the user or read the site's home page. After a 401 or a 403, the page may need a login, or the site may turn away headless browsers. After a 500, a 503 or a 429, the site may be down or busy: try again later.
- If the address cannot be opened at all, redirects in a loop or its server does not answer, the run stops, writes nothing and says "Could not open <url>: <reason>". If a redirect, a script or a meta refresh sends the browser on to an address that cannot be opened, or a redirect sends it to a server that does not answer, it names that address instead. If the page moves itself on to about:blank, an empty page, the run stops and writes nothing too. Check the page in a normal browser.
- If the page stays blank because a style sheet it waits for never comes, the run stops, writes nothing and names that style sheet. Try again later, or check the page in a normal browser.
