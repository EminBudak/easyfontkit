"use strict";

// A stand-in for a browser started with --remote-debugging-pipe, for tests:
// what it is asked comes on file descriptor 3 and its answers go out on 4,
// each message JSON ended by a NUL byte. It carries them to the stand-in at
// the port DEVTOOLS_PORT names (devtools.js), which answers as the test
// says, and ends once either side has closed. Started with "answer", it
// answers every call itself with {} and quits when it is asked to, as a
// browser that answers at once does. Only tests use this; it is not shipped.

const net = require("node:net");

const asked = new net.Socket({ fd: 3, readable: true, writable: false });
const answers = new net.Socket({ fd: 4, readable: false, writable: true });
const quit = () => process.exit(0);
asked.on("end", quit);
asked.on("error", quit);
answers.on("error", quit);

if (process.argv[2] === "answer") {
  let buffer = Buffer.alloc(0);
  asked.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let end = buffer.indexOf(0); end !== -1; end = buffer.indexOf(0)) {
      const { id, method } = JSON.parse(buffer.subarray(0, end).toString());
      buffer = buffer.subarray(end + 1);
      answers.write(`${JSON.stringify({ id, result: {} })}\0`);
      if (method === "Browser.close") answers.end(quit);
    }
  });
} else {
  const standIn = net.connect(Number(process.env.DEVTOOLS_PORT), "127.0.0.1");
  standIn.on("close", quit);
  standIn.on("error", quit);
  asked.pipe(standIn);
  standIn.pipe(answers);
}
