'use strict';

const MODE = process.env.DS_TEST_MODE;
if (MODE === 'boot-crash') {
    const server = require(process.env.DS_TEST_SERVER_PATH);
    server.createServer = () => { throw new Error('injected boot failure'); };
} else if (MODE === 'uncaught-early') {
    setImmediate(() => { throw new Error('injected uncaught before boot'); });
} else if (MODE === 'uncaught') {
    setTimeout(() => { throw new Error('injected uncaught'); }, 100);
}

if (MODE === 'sweep-throw') {
    const sessions = require(process.env.DS_TEST_SESSIONS_PATH);
    sessions.sweepIdleSessions = () => { throw new Error('injected sweep failure'); };
}
