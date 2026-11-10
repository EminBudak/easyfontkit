"use strict";

// A stand-in for a browser's end of the DevTools pipe, for tests of how a
// run waits on the browser: a server on a local port that takes what a run
// says on the pipe, each message JSON ended by a NUL byte, and answers each
// call as the test says. A test reaches it from this process with
// pipeTo(), or through the stand-in browser in browser.js, which carries
// its own pipe there. Only tests use this; it is not shipped.
//
// calls: a method's result, "hold" to never answer it, a number of
// milliseconds to answer it with {} that much later, a promise of the result
// to answer it once that settles, as a browser held still for a while does,
// or "close" to drop the pipe it came on, as a browser that quits does. A
// function of how many times the method was called before, and of the
// call's params, gives one of these. A method not named gets {}, but for
// Target.createTarget and Target.attachToTarget, which give a tab and a
// session for it. Browser.close is answered and calls onClose. Each call is
// kept in received, with who it was said to: the browser itself, or a tab.

const net = require("node:net");

const OPEN_TAB = { "Target.createTarget": { targetId: "1" }, "Target.attachToTarget": { sessionId: "S1" } };

function devtools({ calls = {}, onClose = () => {} } = {}) {
  const called = {};
  const received = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const answer = (message) => socket.writable && socket.write(`${JSON.stringify(message)}\0`);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (let end = buffer.indexOf(0); end !== -1; end = buffer.indexOf(0)) {
        const { id, method, params = {}, sessionId } = JSON.parse(buffer.subarray(0, end).toString());
        buffer = buffer.subarray(end + 1);
        received.push({ to: sessionId ? "tab" : "browser", method });
        const times = called[method] || 0;
        called[method] = times + 1;
        const given = method in calls ? calls[method] : OPEN_TAB[method] || {};
        const how = typeof given === "function" ? given(times, params) : given;
        const reply = (result) => answer({ id, result, ...(sessionId ? { sessionId } : {}) });
        if (how === "hold") continue;
        if (how === "close") return void socket.destroy();
        if (typeof how === "number") {
          setTimeout(() => reply({}), how).unref();
          continue;
        }
        if (how && typeof how.then === "function") {
          how.then(reply);
          continue;
        }
        reply(how);
        if (method === "Browser.close") onClose();
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        received,
        close() {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      }),
    ),
  );
}

// A socket to the stand-in, as the two ends of a browser's pipe, once it is
// open.
function pipeTo({ port }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => resolve(socket));
    socket.on("error", reject);
  });
}

module.exports = { devtools, pipeTo };
