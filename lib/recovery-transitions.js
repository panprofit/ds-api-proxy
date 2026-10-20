'use strict';
// Shared recovery control-flow primitives: the transition singletons returned
// by phases, the terminal-result builder, and the account-rotation helper.
// Kept in their own module because both the phase list (recovery.js) and the
// failure handlers (recovery-failures.js) need them; duplicating them would
// let the two copies drift on the terminal-result shape.

const accounts = require('./accounts');
const sessions = require('./sessions');
const metrics = require('./metrics');
const { currentConfig, backoffDelay, retryDelayMs, sleep } = require('./recovery-util');

// Frozen singletons so a phase can `return RETRY` without allocating; the
// driver only ever reads `.kind`. `terminal()` wraps a caller-facing result.
const RETRY = Object.freeze({ kind: 'retry' });
const ROTATE = Object.freeze({ kind: 'rotate' });
const SUCCESS = Object.freeze({ kind: 'success' });
function terminal(result) { return { kind: 'terminal', result }; }

// Build a terminal error result. `allCooling` short-circuits to the shared
// 429 rate-limit shape used by every recovery give-up path, so callers only
// declare the non-cooling status/type/message. `failure` (from
// rotateAccountAfterFailure/resetRemoteSession) contributes the session
// snapshot fields when present.
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

// Abandon the session's current account and try to rotate to a healthy one.
//
// Always resets the remote session (releasing the sticky account) so the next
// loop iteration re-selects via least-recently-used. The failure snapshot is
// returned so the caller can build a terminal error body if no account is
// available.
//
// Returns { failure, rotated }:
//   rotated=true  -> an account is ready; the caller should return ROTATE
//   rotated=false -> nothing available (or the client is gone); the caller
//                    should return a terminal error using `failure`.
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

// Retry a recoverable, account-independent failure on the same account when
// there is nowhere to rotate to. The remote session is reset first so the retry
// starts from the full prompt in a fresh session. This does not touch the
// rotation budget or the rotation metric.
//
// Returns true when the caller should return RETRY.
async function retrySameAccount({ state, session, agentTag, reason, log, clientGone, deadlineHit }) {
    const { maxSameAccountRetries } = currentConfig();
    if (!(maxSameAccountRetries > 0) || (state.sameAccountRetries || 0) >= maxSameAccountRetries) return false;
    if (clientGone() || deadlineHit()) return false;
    // Only a genuinely single-account deployment: with another configured
    // account, rotation is still the preferred (and budgeted) path.
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
