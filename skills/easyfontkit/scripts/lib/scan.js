"use strict";

// What a page draws its text with. The page is opened with the network
// recorded, so every font file it loads is kept as the browser received it,
// with no second download. Chrome then says which face it really drew
// headings, body text, buttons and code with: the font it picked from the
// CSS font stack, not the stack itself. The @font-face rules are read too,
// to tie a CSS family to its files when a file hides its own names.

const crypto = require("crypto");
const { navigate, currentAddress } = require("./chrome");
const { describeFont } = require("./sfnt");
const { timeLeft, sleep } = require("./time");

// The second selector of a role is tried only when the first finds no text:
// a page built from divs has no p, and a heading can be a styled div.
// Chrome counts the text of an element and of its children's children, so
// the inner elements of headings and buttons are asked too: a button's
// label often sits three levels down.
const BUTTONS = "button, [role=button], input[type=submit], input[type=button], a[class*=button i], a[class*=btn i]";
const ROLES = [
  ["heading", ["h1, h2, h3, h1 *, h2 *, h3 *", "h4, [role=heading], [class*=headline i], [class*=heading i], [class*=title i]"]],
  ["body", ["p, li, dd, blockquote, td", "span, div, a"]],
  ["button", [`${BUTTONS}, ${BUTTONS.split(", ").filter((selector) => !selector.startsWith("input")).map((selector) => `${selector} *`).join(", ")}`]],
  ["code", ["pre, code, kbd, samp"]],
];
const NODES_WITH_TEXT = 24;
const NODES_TRIED = 80;

// A bot check served instead of the page (a CAPTCHA, "Just a moment…").
const CHALLENGE_TITLE = /human verification|just a moment|attention required|access denied|verify you are human|are you a robot|security check|checking your browser|pardon our interruption|ddos-guard|one more step|request blocked|captcha/i;

// Every request's addresses, redirects included, and each font file's body
// as soon as it has arrived: read later, a long page's pictures can push it
// out of the browser's buffer.
function record(cdp) {
  const addresses = new Map();
  const fonts = new Map();
  const faces = [];
  const sheets = new Map();
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
    if (request && !String(request.url).startsWith("data:")) addresses.set(requestId, [...(addresses.get(requestId) || []), request.url]);
  });
  cdp.on("Network.responseReceived", ({ requestId, type, response }) => {
    if (type !== "Font" || !response || String(response.url).startsWith("data:")) return;
    fonts.set(requestId, { urls: [...new Set([...(addresses.get(requestId) || []), response.url])], status: response.status, body: null });
  });
  cdp.on("Network.loadingFinished", ({ requestId }) => {
    const font = fonts.get(requestId);
    if (!font) return;
    font.body = cdp
      .send("Network.getResponseBody", { requestId })
      .then(({ body, base64Encoded }) => Buffer.from(body, base64Encoded ? "base64" : "utf8"))
      .catch(() => null);
  });
  cdp.on("CSS.fontsUpdated", ({ font }) => font && faces.push(font));
  cdp.on("CSS.styleSheetAdded", ({ header }) => header && header.origin === "regular" && sheets.set(header.styleSheetId, header));
  // The tab's own page as the server answered it: the last response its
  // main frame got, after any redirects, so a script that moves the page on
  // counts too. The frames inside a page get documents of their own.
  const page = { frame: "", status: 0, url: "", first: "", requested: "", failed: null };
  cdp.on("Network.responseReceived", ({ frameId, type, response }) => {
    if (type === "Document" && response && page.frame && frameId === page.frame) Object.assign(page, { status: response.status, url: response.url });
  });
  // The address the tab's own page was first asked from, as Chrome writes
  // it, and the one it was last asked from, each redirect's included, so a
  // redirect to an address that cannot be opened or does not answer is
  // named. Chrome writes some characters otherwise than Node does, like a |
  // in a path, so whether the page moved on is told against first.
  cdp.on("Network.requestWillBeSent", ({ frameId, type, request }) => {
    if (type !== "Document" || !request || !page.frame || frameId !== page.frame) return;
    page.first = page.first || request.url;
    page.requested = request.url;
  });
  // A page that moves itself on, by a script or a meta refresh, to an
  // address that cannot be opened at all, like a host that does not resolve
  // or a closed port, gets no response: the tab shows the browser's own
  // error page for that address instead (failed), until a page that loads
  // takes its place. The reason is the first one its load gave: the browser
  // tries the address again a second later and then drops that try as
  // canceled, which says nothing.
  const errors = new Map();
  cdp.on("Network.loadingFailed", ({ requestId, type, errorText, canceled }) => {
    if (type === "Document" && !canceled && errorText && !errors.has(requestId)) errors.set(requestId, errorText);
  });
  cdp.on("Page.frameNavigated", ({ frame }) => {
    if (frame && page.frame && frame.id === page.frame) page.failed = frame.unreachableUrl ? { url: frame.unreachableUrl, error: errors.get(frame.loaderId) || "" } : null;
  });
  // The style sheets the tab's own page has asked for and not got yet: the
  // browser draws nothing of a page until those in its head have come.
  const due = new Map();
  cdp.on("Network.requestWillBeSent", ({ requestId, frameId, type, request }) => {
    if (type === "Stylesheet" && request && page.frame && frameId === page.frame) due.set(requestId, request.url);
  });
  const arrived = ({ requestId }) => due.delete(requestId);
  cdp.on("Network.loadingFinished", arrived);
  cdp.on("Network.loadingFailed", arrived);
  return { fonts, faces, sheets, page, due };
}

async function evaluate(cdp, expression, timeoutMs = 10_000) {
  const { result = {} } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs).catch(() => ({}));
  return result.value;
}

const fontsReady = (cdp) => evaluate(cdp, "Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 5000))]).then(() => true)");

async function metrics(cdp) {
  const m = await cdp.send("Page.getLayoutMetrics");
  const viewport = m.cssLayoutViewport || m.layoutViewport || {};
  const visual = m.cssVisualViewport || m.visualViewport || {};
  const content = m.cssContentSize || m.contentSize || {};
  return {
    width: Math.max(1, Math.floor(viewport.clientWidth || 0)),
    viewportHeight: Math.max(1, Math.floor(viewport.clientHeight || 0)),
    scrollY: Math.max(0, Math.floor(visual.pageY || 0)),
    height: Math.max(1, Math.ceil(content.height || 0)),
  };
}

// A step of the scroll is taken once the page has drawn: one that a page
// has not taken in this long, it does not take, as with a page that waits
// for a style sheet that never comes, or one whose scripts hold it.
const WHEEL_WAIT = 10_000;
const wheel = (cdp, x, y, deltaY) => cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY }, WHEEL_WAIT);

// Down a screen at a time, so sections that render only when scrolled to
// (and the fonts they use, often the code font) load. If the page does not
// move, the pointer may sit on an inner scroller: retry once from the left
// edge.
async function walk(cdp) {
  let m = await metrics(cdp);
  const step = Math.max(200, Math.floor(m.viewportHeight * 0.8));
  const midY = Math.floor(m.viewportHeight / 2);
  for (let i = 0; i < 40 && timeLeft() > 30_000; i++) {
    if (m.scrollY + m.viewportHeight >= m.height - 2) break;
    const before = m.scrollY;
    await wheel(cdp, Math.floor(m.width / 2), midY, step);
    await sleep(250);
    m = await metrics(cdp);
    if (m.scrollY === before) {
      await wheel(cdp, 8, midY, step);
      await sleep(250);
      m = await metrics(cdp);
      if (m.scrollY === before) break;
    }
  }
  await sleep(600);
  await wheel(cdp, 8, midY, -(m.height + m.viewportHeight));
  await sleep(400);
}

// The faces Chrome drew a role's text with, most glyphs first, with the
// weights, styles and CSS stacks that text asked for.
async function readRole(cdp, rootId, selector) {
  const { nodeIds = [] } = await cdp.send("DOM.querySelectorAll", { nodeId: rootId, selector }).catch(() => ({}));
  const faces = new Map();
  let withText = 0;
  for (const nodeId of nodeIds.slice(0, NODES_TRIED)) {
    if (withText >= NODES_WITH_TEXT || timeLeft() < 15_000) break;
    const { fonts = [] } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId }).catch(() => ({}));
    const drawn = fonts.filter((font) => font.glyphCount > 0);
    if (!drawn.length) continue;
    withText++;
    const { computedStyle = [] } = await cdp.send("CSS.getComputedStyleForNode", { nodeId }).catch(() => ({}));
    const css = (name) => ((computedStyle.find((property) => property.name === name) || {}).value || "").trim();
    const stack = css("font-family");
    const weight = css("font-weight") || "400";
    const italic = /italic|oblique/.test(css("font-style"));
    for (const font of drawn) {
      const key = `${font.isCustomFont ? "web" : "system"}\u0000${font.familyName}\u0000${font.postScriptName || ""}`;
      const face = faces.get(key) || {
        familyName: font.familyName || "",
        postScriptName: font.postScriptName || "",
        custom: Boolean(font.isCustomFont),
        glyphs: 0,
        italicGlyphs: 0,
        weights: {},
        stacks: {},
      };
      face.glyphs += font.glyphCount;
      if (italic) face.italicGlyphs += font.glyphCount;
      face.weights[weight] = (face.weights[weight] || 0) + font.glyphCount;
      face.stacks[stack] = (face.stacks[stack] || 0) + font.glyphCount;
      faces.set(key, face);
    }
  }
  return [...faces.values()].sort((a, b) => b.glyphs - a.glyphs);
}

async function readRoles(cdp) {
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const roles = {};
  for (const [role, selectors] of ROLES) {
    for (const selector of selectors) {
      const faces = await readRole(cdp, root.nodeId, selector);
      if (faces.length) {
        roles[role] = faces;
        break;
      }
    }
  }
  return roles;
}

// A declaration list split on the semicolons outside quotes and brackets: a
// data URL in src has its own.
function declarations(body) {
  const out = {};
  let depth = 0;
  let quote = "";
  let start = 0;
  const take = (end) => {
    const text = body.slice(start, end);
    const colon = text.indexOf(":");
    if (colon > 0) out[text.slice(0, colon).trim().toLowerCase()] = text.slice(colon + 1).trim();
    start = end + 1;
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) take(i);
  }
  take(body.length);
  return out;
}

const unquote = (text) => String(text || "").trim().replace(/^(['"])(.*)\1$/s, "$2").trim();

// A request never carries the address's #fragment.
const bare = (address) => String(address).replace(/#.*$/s, "");

function resolve(url, base) {
  try {
    return new URL(url, base || undefined).href;
  } catch {
    return "";
  }
}

// The src addresses of a @font-face declaration, absolute.
function srcUrls(src, base) {
  return [...String(src || "").matchAll(/url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/gi)]
    .map((m) => (m[1] ?? m[2] ?? m[3] ?? "").trim())
    .filter(Boolean)
    .map((url) => (url.startsWith("data:") ? url : resolve(url, base)))
    .filter(Boolean);
}

// The @font-face rules in a style sheet's text.
function fontFaceRules(text, base) {
  const rules = [];
  const clean = String(text || "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, body] of clean.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const d = declarations(body);
    const family = unquote(d["font-family"]);
    const urls = srcUrls(d.src, base);
    if (family && urls.length) rules.push({ family, weight: d["font-weight"] || "400", style: d["font-style"] || "normal", unicodeRange: d["unicode-range"] || "", urls });
  }
  return rules;
}

// The same rules as the page's own CSS object model has them: style sheets
// a script builds rule by rule (CSS-in-JS) have no text to read, and other
// sites' sheets have a text but no readable rules, so both are read.
const CSSOM_RULES = `(() => {
  const out = [];
  const visit = (rules, base, depth) => {
    if (depth > 8) return;
    for (const rule of rules) {
      if (rule instanceof CSSFontFaceRule) {
        const get = (name) => rule.style.getPropertyValue(name);
        out.push({ family: get("font-family"), src: get("src"), weight: get("font-weight"), style: get("font-style"), unicodeRange: get("unicode-range"), base });
      } else if (rule instanceof CSSImportRule) {
        try { if (rule.styleSheet) visit(rule.styleSheet.cssRules, rule.styleSheet.href || base, depth + 1); } catch {}
      } else if (rule.cssRules) {
        visit(rule.cssRules, base, depth + 1);
      }
    }
  };
  for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
    try { visit(sheet.cssRules, sheet.href || location.href, 0); } catch {}
  }
  return out;
})()`;

async function readRules(cdp, sheets, pageUrl) {
  const rules = [];
  for (const [styleSheetId, header] of sheets) {
    if (timeLeft() < 15_000) break;
    const { text = "" } = await cdp.send("CSS.getStyleSheetText", { styleSheetId }).catch(() => ({}));
    if (/@font-face/i.test(text)) rules.push(...fontFaceRules(text, header.sourceURL || pageUrl));
  }
  for (const rule of (await evaluate(cdp, CSSOM_RULES)) || []) {
    const family = unquote(rule.family);
    const urls = srcUrls(rule.src, rule.base);
    if (family && urls.length) rules.push({ family, weight: rule.weight || "400", style: rule.style || "normal", unicodeRange: rule.unicodeRange || "", urls });
  }
  const seen = new Set();
  return rules.filter((rule) => {
    const key = `${rule.family}\u0000${rule.weight}\u0000${rule.style}\u0000${rule.urls.join(" ")}`;
    return !seen.has(key) && seen.add(key);
  });
}

function decodeDataUrl(url) {
  const m = /^data:([^,]*?),(.*)$/s.exec(url);
  if (!m) return null;
  try {
    return /;base64$/i.test(m[1]) ? Buffer.from(m[2], "base64") : Buffer.from(decodeURIComponent(m[2]), "latin1");
  } catch {
    return null;
  }
}

// The font files, each once: the same file can be asked for twice, under
// two addresses or as a data URL.
async function readFiles(fonts, rules, faces) {
  const files = new Map();
  const skipped = [];
  const add = (buffer, urls) => {
    const sha = crypto.createHash("sha1").update(buffer).digest("hex");
    const known = files.get(sha);
    if (known) return void known.urls.push(...urls.filter((url) => !known.urls.includes(url)));
    try {
      files.set(sha, { sha, urls: [...urls], buffer, font: describeFont(buffer) });
    } catch (err) {
      skipped.push({ url: urls[0] || "", reason: err.message });
    }
  };
  for (const font of fonts.values()) {
    const body = font.body ? await font.body : null;
    if (body && body.length) add(body, font.urls);
    else if (font.status >= 400) skipped.push({ url: font.urls[0] || "", reason: `the server answered ${font.status}` });
  }
  const inline = [...rules.flatMap((rule) => rule.urls), ...faces.map((face) => String(face.src || ""))].filter((url) => url.startsWith("data:"));
  for (const url of new Set(inline)) {
    const body = decodeDataUrl(url);
    if (body && body.length) add(body, [url]);
  }
  return { files: [...files.values()], skipped };
}

// Opens the page and reads it: the faces of each role, every font file it
// loaded, its @font-face rules, the web fonts Chrome reports as loaded, the
// families document.fonts holds, the status and address the server
// answered the page with (answer), the address the page was first asked
// from as Chrome wrote it (first), the address a redirect or the page led
// on to that could not be opened or did not answer (failed), about:blank or
// the like when the page moved itself on to that (left), and for a page that
// did not draw, so it could not be scrolled, the style sheet it waited for,
// if one had not come (stalled). pageUrl is the address of the page the
// roles were read from, or the last page the server sent the tab when it has
// moved on to about:blank.
async function scanPage(cdp, url, log = () => {}) {
  const recorded = record(cdp);
  await cdp.send("Network.enable", { maxTotalBufferSize: 200_000_000, maxResourceBufferSize: 50_000_000 });
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { frameTree } = await cdp.send("Page.getFrameTree");
  recorded.page.frame = frameTree.frame.id;
  const nothing = (pageUrl, found) => ({ pageUrl, first: recorded.page.first, answer: { status: recorded.page.status, url: recorded.page.url }, failed: null, left: "", stalled: null, title: "", challenge: "", roles: {}, files: [], skipped: [], rules: [], faces: [], loaded: [], ...found });
  log(`Opening ${url}`);
  let pageUrl;
  try {
    pageUrl = await navigate(cdp, url);
  } catch (err) {
    const { status, requested, first } = recorded.page;
    // An error status with no page of its own makes Chrome show its own
    // error page and give a net:: code, which says less than the status.
    if (status >= 400) return nothing(url);
    // A redirect that led to an address that could not be opened, or whose
    // server did not answer: that address failed, not the one asked, which
    // answered.
    if ((err.errorText || err.noAnswer) && requested && first && bare(requested) !== bare(first)) {
      return nothing(url, { failed: { url: requested, error: err.errorText || "", noAnswer: err.noAnswer || 0 } });
    }
    throw err;
  }
  await fontsReady(cdp);
  log("Reading the page");
  try {
    await walk(cdp);
  } catch (err) {
    if (!err.timedOut) throw err;
    // Read as it stands, the page would give the browser's default fonts,
    // as the ones it asks for come with the style sheet it waits for.
    return nothing(pageUrl, { stalled: { sheet: [...recorded.due.values()][0] || "" } });
  }
  await fontsReady(cdp);
  await sleep(500);
  const title = String((await evaluate(cdp, "document.title")) || "").trim();
  const roles = await readRoles(cdp);
  // A script or a meta refresh can have moved the tab on since the load
  // event navigate() waited for: the page read is the one it shows now. One
  // that has moved on to about:blank shows nothing, and the roles were read
  // from that: left says where it went, and pageUrl is the last page the
  // server sent the tab, also after a redirect, and also when it went at its
  // load event, as Chrome then keeps no web address in the tab's history.
  const now = await currentAddress(cdp);
  if (/^https?:/i.test(now)) pageUrl = now;
  else if (recorded.page.url) pageUrl = recorded.page.url;
  const left = /^about:/i.test(now) ? now : "";
  const loaded = (await evaluate(cdp, "[...document.fonts].filter((f) => f.status === 'loaded').map((f) => ({ family: f.family, weight: f.weight, style: f.style }))")) || [];
  const rules = await readRules(cdp, recorded.sheets, pageUrl);
  const faces = recorded.faces.map((face) => ({
    family: unquote(face.fontFamily),
    weight: face.fontWeight || "",
    style: face.fontStyle || "",
    src: String(face.src || ""),
    unicodeRange: face.unicodeRange && face.unicodeRange !== "U+0-10FFFF" ? face.unicodeRange : "",
    platformFamily: face.platformFontFamily || "",
  }));
  const { files, skipped } = await readFiles(recorded.fonts, rules, faces);
  const { failed } = recorded.page;
  // The browser's own error page is titled with the host it could not
  // reach, which is not the site's bot check.
  const challenge = !failed && !files.length && CHALLENGE_TITLE.test(title) ? title : "";
  const answer = { status: recorded.page.status, url: recorded.page.url };
  return { pageUrl, first: recorded.page.first, answer, failed, left, stalled: null, title, challenge, roles, files, skipped, rules, faces, loaded: loaded.map((face) => ({ ...face, family: unquote(face.family) })) };
}

module.exports = { scanPage, fontFaceRules, decodeDataUrl };
