'use strict';

const accounts = require('./accounts');
const sessions = require('./sessions');
const metrics = require('./metrics');
const { currentConfig, backoffDelay, retryDelayMs, sleep } = require('./recovery-util');

const RETRY = Object.freeze({ kind: 'retry' });
const ROTATE = Object.freeze({ kind: 'rotate' });
const SUCCESS = Object.freeze({ kind: 'success' });
function terminal(result) { return { kind: 'terminal', result }; }

function terminalError({ status, type, message, allCooling = false, agentId, failure, extra }) {
    const body = {
        message: allCooling && !message ? 'All auth accounts are cooling down after repeated recoverable failures. Retry later.' : message,
        type: allCooling ? 'rate_limit_error' : type,
        agent: agentId,
        ...(failure ? {
            failed_session_id: failure.failedSessionId,
            message_count: failure.failedMessageCount,
            account: failure.accountId,
        } : {}),
        ...(extra || {}),
    };
    return terminal({ ok: false, error: { status: allCooling ? 429 : status, body } });
}

async function rotateAccountAfterFailure({ session, accountAttempt, agentTag, reason, log, clientGone, rotationDeadlineHit }) {
    const failure = sessions.resetRemoteSession(session, { releaseAccount: true });
    if (clientGone() || !(await accounts.waitForAvailableAccount(rotationDeadlineHit, { clientGone }))) {
        return { failure, rotated: false };
    }
    metrics.inc('rotations');
    log(`${agentTag} ${reason} on ${failure.accountId}; rotating to next account (attempt ${accountAttempt + 2})...`);
    await sleep(backoffDelay(accountAttempt + 1, retryDelayMs()));
    return { failure, rotated: true };
}

async function retrySameAccount({ state, session, agentTag, reason, log, clientGone, deadlineHit }) {
    const { maxSameAccountRetries } = currentConfig();
    if (!(maxSameAccountRetries > 0) || (state.sameAccountRetries || 0) >= maxSameAccountRetries) return false;
    if (clientGone() || deadlineHit()) return false;

    const list = accounts.getAccounts();
    if (list.length !== 1) return false;
    const account = list[0];
    if (!account?.config?.token || !account?.config?.cookie) return false;
    if (account.cooldownUntil > Date.now()) return false;
    if (session.accountId && session.accountId !== account.id) return false;
    state.sameAccountRetries = (state.sameAccountRetries || 0) + 1;
    sessions.resetRemoteSession(session);
    log(`${agentTag} ${reason}; no other account available, retrying on the same account in a fresh session (${state.sameAccountRetries}/${maxSameAccountRetries})...`);
    await sleep(backoffDelay(state.sameAccountRetries, retryDelayMs()));
    return true;
}

module.exports = {
    RETRY, ROTATE, SUCCESS,
    terminal, terminalError, rotateAccountAfterFailure, retrySameAccount,
};
