'use strict';
// Test preload for the index.js process-level tests. Two injection modes:
//  * boot-crash - replace lib/server.createServer before index.js loads, so
//    main() throws. Safe because index.js calls it as a property of the
//    exports object, not through a destructured load-time binding.
//  * uncaught  - throw from a timer, i.e. after index.js has installed its
//    process-level uncaughtException handler and started serving.
const MODE = process.env.DS_TEST_MODE;
if (MODE === 'boot-crash') {
    const server = require(process.env.DS_TEST_SERVER_PATH);
    server.createServer = () => { throw new Error('injected boot failure'); };
} else if (MODE === 'uncaught') {
    setTimeout(() => { throw new Error('injected uncaught'); }, 100);
}
// sweep-throw: make the periodic idle-session sweep throw, so index.js's
// try/catch around it (the setInterval callback in main()) is exercised while
// the server keeps serving. sweepIdleSessions is destructured from
// ./lib/sessions when index.js loads, so replacing it here is what index.js
// will capture - hence this must run before requiring index.js.
if (MODE === 'sweep-throw') {
    const sessions = require(process.env.DS_TEST_SESSIONS_PATH);
    sessions.sweepIdleSessions = () => { throw new Error('injected sweep failure'); };
}
