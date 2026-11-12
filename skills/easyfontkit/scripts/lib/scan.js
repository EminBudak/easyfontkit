"use strict";

// What a page draws its text with. The page is opened with the network
// recorded, so every font file it loads is kept as the browser received it,
// with no second download. Chrome then says which face it really drew
// headings, body text, buttons and code with: the font it picked from the
// CSS font stack, not the stack itself. The @font-face rules are read too,
// to tie a CSS family to its files when a file hides its own names.

const crypto = require("crypto");
const { navigate, currentAddress, triedSoFar, handedOut } = require("./chrome");
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

// The most a run keeps of the bodies of a page's font files, as much as the
// browser keeps of all it loads for a page (Network.enable below): well
// above any site's fonts, which come to a few megabytes, tens for Chinese,
// Japanese or Korean. A page could serve font files of tens of megabytes
// each, which the run would hold until it ends, on a server for every
// user's job too.
const FONT_BYTES = 200 * 1024 * 1024;

// Every request's addresses, redirects included, and each font file's body
// as soon as it has arrived: read later, a long page's pictures can push it
// out of the browser's buffer. Bodies are kept up to `most` bytes in all: a
// file whose body would take them past it, with those still coming, is not
// fetched, or is let go of as it comes, and is marked left.
function record(cdp, most = FONT_BYTES) {
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
  // The bytes of the bodies kept, and of those fetched and not come yet, as
  // what came over the network for each: about as much as its body, or less
  // when it came packed. A file that takes them past `most` is not fetched.
  let kept = 0;
  let coming = 0;
  cdp.on("Network.loadingFinished", ({ requestId, encodedDataLength = 0 }) => {
    const font = fonts.get(requestId);
    if (!font) return;
    font.finished = true;
    if (kept + coming + encodedDataLength > most) {
      font.left = true;
      return;
    }
    coming += encodedDataLength;
    font.body = cdp
      .send("Network.getResponseBody", { requestId })
      .then(({ body, base64Encoded }) => {
        const bytes = Buffer.byteLength(body, base64Encoded ? "base64" : "utf8");
        if (kept + bytes > most) {
          font.left = true;
          return null;
        }
        kept += bytes;
        return Buffer.from(body, base64Encoded ? "base64" : "utf8");
      })
      .catch(() => null)
      .finally(() => (coming -= encodedDataLength));
  });
  // The address of every font file the browser asked for, redirects
  // included, also of one whose answer has not come: one that is not among
  // the files read did not load while the page was read.
  const asked = new Set();
  cdp.on("Network.requestWillBeSent", ({ type, request }) => {
    if (type === "Font" && request && !String(request.url).startsWith("data:")) asked.add(request.url);
  });
  // The font files the browser refused to load, by the address the page
  // asked for, with why: one from another site whose server does not let
  // this page use it (CORS), or one the page's own Content-Security-Policy
  // keeps out. The browser refuses them again on every visit, so another
  // run does not get them either.
  const refused = new Map();
  cdp.on("Network.loadingFailed", ({ requestId, type, corsErrorStatus, blockedReason }) => {
    const [url] = addresses.get(requestId) || [];
    if (type !== "Font" || !url) return;
    const why = corsErrorStatus && corsErrorStatus.corsError ? `CORS error: ${corsErrorStatus.corsError}` : blockedReason ? `blocked: ${blockedReason}` : "";
    if (why) refused.set(requestId, { url, why, reason: `the browser refused it (${why})` });
  });
  // The status of each request's last answer as the network got it, also
  // of one the browser then refused: a server's error page often comes
  // without the header CORS asks for, and then the error is what kept the
  // file out, an answer another run may not get. Chrome can say this after
  // it has said the request failed.
  const statuses = new Map();
  cdp.on("Network.responseReceivedExtraInfo", ({ requestId, statusCode }) => {
    if (statusCode) statuses.set(requestId, statusCode);
  });
  cdp.on("CSS.fontsUpdated", ({ font }) => font && faces.push(font));
  cdp.on("CSS.styleSheetAdded", ({ header }) => header && header.origin === "regular" && sheets.set(header.styleSheetId, header));
  // The tab's own page as the server answered it: the last response its
  // main frame got, after any redirects, so a script that moves the page on
  // counts too. The frames inside a page get documents of their own, and a
  // blob: address a page made for itself is no answer of a server's and has
  // no host to name the kit by.
  const page = { frame: "", status: 0, url: "", shown: "", first: "", requested: "", failed: null };
  cdp.on("Network.responseReceived", ({ frameId, type, response }) => {
    if (type === "Document" && response && page.frame && frameId === page.frame && /^https?:/i.test(response.url)) Object.assign(page, { status: response.status, url: response.url });
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
  // The last web address the tab showed goes with it: a response alone says
  // less, as one that was a download, which the browser refuses, leaves the
  // tab where it was.
  cdp.on("Page.frameNavigated", ({ frame }) => {
    if (!frame || !page.frame || frame.id !== page.frame) return;
    page.failed = frame.unreachableUrl ? { url: frame.unreachableUrl, error: errors.get(frame.loaderId) || "" } : null;
    if (/^https?:/i.test(frame.url)) page.shown = frame.url;
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
  // The addresses that are not web addresses, as mailto:, that the page or
  // a frame of it tried to open, as the browser tells them: a move a script,
  // a refresh, a form or a link asked for (asked), which the guard each
  // document gets cancels, one the browser began to go to (started), as the
  // first address of a frame or one a frame's page redirected to, and a
  // window the page asked for (window), which the browser does not open
  // without a click. A frame of another site tells of its own, and of its
  // frames' redirects, on a session of its own (openPage).
  const tried = [];
  const keep = (how) => ({ url }) => {
    if (handedOut(url) && tried.length < 50) tried.push({ url: String(url).slice(0, 300), how });
  };
  const listen = (session) => {
    session.on("Page.frameScheduledNavigation", keep("asked"));
    session.on("Page.frameRequestedNavigation", keep("asked"));
    session.on("Page.frameStartedNavigating", keep("started"));
    session.on("Page.windowOpen", keep("window"));
    session.on("Network.requestWillBeSent", ({ type, request, redirectResponse }) => {
      if (type === "Document" && redirectResponse && request) keep("started")(request);
    });
  };
  listen(cdp);
  if (cdp.onFrame) cdp.onFrame(listen);
  return { fonts, asked, refused, statuses, faces, sheets, page, due, tried };
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

// The text Chrome counts the glyphs of for a node: that of its own text
// nodes and of its children's, as it is laid out, with each run of white
// space one space, or the label of an input button, its value, which no
// text node holds. Read for a node drawn in part with a font of the
// visitor's own, as one a web font has no glyphs for: { text, length },
// the text cut to 20000 characters and how long it was. The page hands
// back the text alone, however many children the node has. A page that
// holds the call up, as its own scripts can, is not asked again in this
// run: its text is not read, and the note on it is worded as before.
const TEXT_KEPT = 20_000;
const TEXT_WAIT = 5_000;
const textHeld = new WeakSet();
const OWN_TEXT = `function (kept) {
  let text = "";
  const own = (node) => { for (const child of node.childNodes) if (child.nodeType === 3) text += child.data; };
  if (this.localName === "input") text = String(this.value || "");
  else {
    own(this);
    for (const child of this.children) own(child);
  }
  text = text.replace(/\\s+/g, " ").trim();
  return [text.slice(0, kept), text.length];
}`;
async function textOf(cdp, nodeId) {
  const none = { text: "", length: 0 };
  if (textHeld.has(cdp)) return none;
  const held = (err) => {
    if (err && err.timedOut) textHeld.add(cdp);
    return {};
  };
  const { object } = await cdp.send("DOM.resolveNode", { nodeId }, TEXT_WAIT).catch(held);
  if (!object || !object.objectId) return none;
  const { result = {} } = await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: OWN_TEXT, arguments: [{ value: TEXT_KEPT }], returnByValue: true }, TEXT_WAIT).catch(held);
  await cdp.send("Runtime.releaseObject", { objectId: object.objectId }, TEXT_WAIT).catch(held);
  const [text, length] = Array.isArray(result.value) ? result.value : [];
  return typeof text === "string" && Number.isFinite(length) ? { text: text.slice(0, TEXT_KEPT), length: Math.max(length, text.length) } : none;
}

// The faces Chrome drew a role's text with, most glyphs first, with the
// weights, styles and CSS stacks that text asked for. A font of the
// visitor's own also keeps, for each node it drew, the text Chrome counted
// there and how many of its glyphs the visitor's own fonts drew (nodes).
// The nodes are read while the run has 15 s left: `cut` says that its time
// ran out before every node there was to read had been read.
async function readRole(cdp, rootId, selector) {
  const { nodeIds = [] } = await cdp.send("DOM.querySelectorAll", { nodeId: rootId, selector }).catch(() => ({}));
  const faces = new Map();
  let withText = 0;
  let cut = false;
  for (const nodeId of nodeIds.slice(0, NODES_TRIED)) {
    if (withText >= NODES_WITH_TEXT) break;
    if (timeLeft() < 15_000) {
      cut = true;
      break;
    }
    const { fonts = [] } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId }).catch(() => ({}));
    const drawn = fonts.filter((font) => font.glyphCount > 0);
    if (!drawn.length) continue;
    withText++;
    const { computedStyle = [] } = await cdp.send("CSS.getComputedStyleForNode", { nodeId }).catch(() => ({}));
    const css = (name) => ((computedStyle.find((property) => property.name === name) || {}).value || "").trim();
    const stack = css("font-family");
    const weight = css("font-weight") || "400";
    const italic = /italic|oblique/.test(css("font-style"));
    const system = drawn.filter((font) => !font.isCustomFont).reduce((sum, font) => sum + font.glyphCount, 0);
    const read = system ? await textOf(cdp, nodeId) : null;
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
        ...(font.isCustomFont ? {} : { nodes: [] }),
      };
      face.glyphs += font.glyphCount;
      if (face.nodes) face.nodes.push({ ...read, system });
      if (italic) face.italicGlyphs += font.glyphCount;
      face.weights[weight] = (face.weights[weight] || 0) + font.glyphCount;
      face.stacks[stack] = (face.stacks[stack] || 0) + font.glyphCount;
      faces.set(key, face);
    }
  }
  return { faces: [...faces.values()].sort((a, b) => b.glyphs - a.glyphs), cut };
}

// The faces of each role, and the roles the run's time ran out before any
// text of was read (cut): the time a slow browser or a font that never
// comes took, which a role with no text does not tell from one never read.
async function readRoles(cdp) {
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const roles = {};
  const cut = [];
  for (const [role, selectors] of ROLES) {
    for (const selector of selectors) {
      const read = await readRole(cdp, root.nodeId, selector);
      if (read.faces.length) {
        roles[role] = read.faces;
        break;
      }
      if (read.cut) {
        cut.push(role);
        break;
      }
    }
  }
  return { roles, cut };
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

// The src addresses of a @font-face declaration, absolute. A quoted address
// is matched with no choice inside the repeat, so one of megabytes, as a
// font given as a data: address can be, does not run the regular expression
// engine out of stack.
const SRC_URL = /url\(\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^)\s]*))\s*\)/gi;
function srcUrls(src, base) {
  return [...String(src || "").matchAll(SRC_URL)]
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
// two addresses or as a data URL. A file the browser refused is skipped
// with why, as one its server answered with an error or with no bytes at
// all is, and with that error when its server answered it with one. One
// read all the same from that address, as by a preload the page made
// without crossorigin, which the browser does not hold to CORS, is in the
// kit and not skipped, and the refusal goes with it (refusedRead): the
// browser does not draw the page's text with it. The addresses of the
// files whose bodies were not kept, as the page's font files came to more
// than a run keeps (record), are given apart (unread). A body is let go of
// once it is read, so one that is not a usable font file is not held.
async function readFiles(fonts, rules, faces, refused = new Map(), statuses = new Map()) {
  const files = new Map();
  const skipped = [];
  const refusedRead = [];
  const unread = [];
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
    font.body = null;
    if (font.left) unread.push(font.urls[0] || "");
    else if (body && body.length) add(body, font.urls);
    else if (font.status >= 400) skipped.push({ url: font.urls[0] || "", reason: `the server answered ${font.status}` });
    // A whole answer with no bytes in it, as another run gets too.
    else if (font.finished && body) skipped.push({ url: font.urls[0] || "", reason: "the server sent an empty file" });
  }
  const read = (url) => [...files.values()].some((file) => file.urls.includes(url));
  for (const [requestId, refusal] of refused) {
    if (read(refusal.url)) {
      if (!refusedRead.some((known) => known.url === refusal.url)) refusedRead.push({ url: refusal.url, why: refusal.why });
      continue;
    }
    if (skipped.some((skip) => skip.url === refusal.url)) continue;
    const status = statuses.get(requestId) || 0;
    skipped.push(status >= 400 ? { url: refusal.url, reason: `the server answered ${status}` } : { url: refusal.url, reason: refusal.reason });
  }
  const inline = [...rules.flatMap((rule) => rule.urls), ...faces.map((face) => String(face.src || ""))].filter((url) => url.startsWith("data:"));
  for (const url of new Set(inline)) {
    const body = decodeDataUrl(url);
    if (body && body.length) add(body, [url]);
  }
  return { files: [...files.values()], skipped, refusedRead, unread };
}

// Opens the page and reads it: the faces of each role, every font file it
// loaded, the ones it could not use and why (skipped), the browser's
// refusals of files it read all the same (refusedRead), the addresses of
// those it did not read, as the page's had come to more than a run keeps
// (unread), the addresses of every one the browser asked for (asked), its
// @font-face rules, the web fonts Chrome reports as loaded, the families
// document.fonts holds, the status and address the server answered the
// page with (answer), the address the page was first asked from as Chrome
// wrote it (first), the address a redirect or the page led on to that could
// not be opened or did not answer (failed), about:blank or the like when
// the page moved itself on to that (left), for a page that did not draw, so
// it could not be scrolled, the style sheet it waited for, if one had not
// come (stalled), the addresses that are not web addresses the page tried
// to open (tried), and the roles the run's time ran out before any text of
// was read (cut).
// pageUrl is the address of the page the roles were read from, or the last
// web address the tab showed when it has moved on to about:blank or to a
// blob: address, so it is always a web address.
async function scanPage(cdp, url, log = () => {}) {
  const recorded = record(cdp);
  await cdp.send("Network.enable", { maxTotalBufferSize: 200_000_000, maxResourceBufferSize: 50_000_000 });
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { frameTree } = await cdp.send("Page.getFrameTree");
  recorded.page.frame = frameTree.frame.id;
  const nothing = (pageUrl, found) => ({ pageUrl, first: recorded.page.first, answer: { status: recorded.page.status, url: recorded.page.url }, failed: null, left: "", stalled: null, title: "", challenge: "", roles: {}, cut: [], files: [], skipped: [], refusedRead: [], unread: [], rules: [], faces: [], loaded: [], asked: [], tried: [], ...found });
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
  const { roles, cut } = await readRoles(cdp);
  // With what the guard cancelled in the page the roles were read from.
  const tried = [...recorded.tried, ...(await triedSoFar(cdp))];
  // A script or a meta refresh can have moved the tab on since the load
  // event navigate() waited for: the page read is the one it shows now. One
  // that has moved on to about:blank shows nothing, and the roles were read
  // from that: left says where it went, and pageUrl is the last web address
  // the tab showed, also after a redirect, and also when it went at its load
  // event, as Chrome then keeps no web address in the tab's history. A blob:
  // address is read, and has no host of its own, so it is named by the page
  // that made it, in the same way.
  const now = await currentAddress(cdp);
  if (/^https?:/i.test(now)) pageUrl = now;
  else if (recorded.page.shown) pageUrl = recorded.page.shown;
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
  const { files, skipped, refusedRead, unread } = await readFiles(recorded.fonts, rules, faces, recorded.refused, recorded.statuses);
  const { failed } = recorded.page;
  // The browser's own error page is titled with the host it could not
  // reach, which is not the site's bot check.
  const challenge = !failed && !files.length && CHALLENGE_TITLE.test(title) ? title : "";
  const answer = { status: recorded.page.status, url: recorded.page.url };
  return { pageUrl, first: recorded.page.first, answer, failed, left, stalled: null, title, challenge, roles, cut, files, skipped, refusedRead, unread, rules, faces, loaded: loaded.map((face) => ({ ...face, family: unquote(face.family) })), asked: [...recorded.asked], tried };
}

module.exports = { scanPage, fontFaceRules, decodeDataUrl, record, readFiles, FONT_BYTES };
