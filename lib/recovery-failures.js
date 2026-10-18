'use strict';
// Terminal failure handlers for the recovery loop: the outcomes that either
// rotate to another account or end the request (auth-expired, muted, transient
// upstream outage, context-too-long, and the generic recoverable give-up).
// Extracted from recovery.js so the phase driver keeps only control flow; each
// handler returns a transition from recovery-transitions.

const { isAuthExpiredError } = require('./recovery-classify');
const accounts = require('./accounts');
const sessions = require('./sessions');
const metrics = require('./metrics');
const { currentConfig, retryDelayMs, sleep, backoffDelay } = require('./recovery-util');
const { RETRY, ROTATE, terminal, terminalError, rotateAccountAfterFailure } = require('./recovery-transitions');

// An auth-expired / captcha / Web-API-change failure means this account's
// credentials are unusable. Retrying the same account cannot help, so cool it
// down and rotate to the next one. Returns ROTATE when another account is
// ready, otherwise a terminal 401 (or 429 when nothing is available). The
// error is re-thrown untouched if it is not an auth failure.
async function handleAuthExpired(e, deps, ctl) {
    // Anything that is not a credential failure is re-thrown untouched. In
    // particular an upstream HTTP 429 (typeForStatus -> 'rate_limit_error')
    // does NOT rotate: a DS 429 is not guaranteed to be account-scoped, so the
    // request fails with Retry-After instead of silently retrying elsewhere.
    // The account is already cooled down by upstream-session's
    // markAccountFailure() before the throw, so the next request rotates away.
    if (!isAuthExpiredError(e)) throw e;
    const { agentId, agentTag, session, clientGone, rotationDeadlineHit, log } = deps;
    const usedAccount = accounts.getAccounts().find(a => a.id === session.accountId);
    accounts.markAccountBroken(usedAccount, 'auth expired / captcha / DS Web API change');
    const { failure, rotated } = await rotateAccountAfterFailure({
        session, accountAttempt: ctl.accountAttempt, agentTag, reason: 'auth expired (captcha/Web API)',
        log, clientGone, rotationDeadlineHit,
    });
    if (rotated) return ROTATE;
    const allCooling = !accounts.hasAvailableAccount();
    log(`${agentTag} auth expired on all ${ctl.accountAttempt + 1} account attempt(s). Giving up.`);
    return terminalError({
        status: 401,
        type: 'auth_expired',
        message: e.message || 'DS auth expired',
        allCooling,
        agentId,
        failure,
        extra: { account_attempts: ctl.accountAttempt + 1 },
    });
}

// Park a muted account until its reported mute_until and rotate. Returns a
// transition: ROTATE when another account is ready, otherwise a terminal 429.
// The mute payload is account-level and time-bound, so neither retrying the
// same account nor cooling it down for the usual short window can clear it.
async function handleMutedAccount(state, deps, ctl) {
    const { agentId, agentTag, session, clientGone, rotationDeadlineHit, log } = deps;
    const untilMs = state.muted.muteUntil != null
        ? state.muted.muteUntil * 1000 - Date.now()
        : currentConfig().accountCooldownMs;
    const parkMs = Math.max(1000, untilMs);
    const usedAccount = accounts.getAccounts().find(a => a.id === session.accountId);
    accounts.markAccountBroken(usedAccount, `muted (${state.muted.message})`, parkMs);
    sessions.resetRemoteSession(session);
    const { failure, rotated } = await rotateAccountAfterFailure({
        session, accountAttempt: ctl.accountAttempt, agentTag,
        reason: 'account muted',
        log, clientGone, rotationDeadlineHit,
    });
    if (rotated) return ROTATE;
    const allCooling = !accounts.hasAvailableAccount();
    log(`${agentTag} account muted after ${ctl.accountAttempt + 1} account attempt(s). Giving up.`);
    return terminalError({
        status: 429,
        type: 'rate_limit_error',
        message: allCooling
            ? 'All auth accounts are muted or cooling down. Retry later.'
            : (state.muted.message || 'DS account is muted'),
        allCooling,
        agentId,
        failure,
        extra: { mute_until: state.muted.muteUntil, account_attempts: ctl.accountAttempt + 1 },
    });
}

// A context-too-long error is deterministic and account-independent: rotating
// (or waiting out a cooldown) cannot help, and re-sending the same prompt
// reproduces it. Surface it immediately as a 400 instead of burning the
// account attempts / rotation budget.
async function terminalContextTooLong(state, deps, ctl, failureClass) {
    const { agentId, agentTag, session, log } = deps;
    log(`${agentTag} context_length_exceeded; not rotating accounts.`);
    return terminalError({
        status: failureClass.status,
        type: failureClass.type,
        message: state.modelError?.content || 'DS context length exceeded',
        agentId,
        failure: { failedSessionId: session.id, failedMessageCount: session.messageCount, accountId: session.accountId },
        extra: { retry_attempts: state.retryAttempt, account_attempts: ctl.accountAttempt + 1 },
    });
}

// DS itself is briefly unavailable (finish_reason=generation_err, "Server
// temporarily unavailable."). The account is healthy, so rotating cannot
// help: every account talks to the same upstream and the next one fails
// identically. Retry the SAME account up to maxUpstreamRetries, then surface
// the error to the client without touching the account. Returns RETRY while a
// retry budget remains (same-session first, then one fresh-session attempt),
// otherwise a terminal transition.
async function handleTransientOutage(state, deps, ctl, failureClass) {
    const { agentId, agentTag, session, clientGone, deadlineHit, log } = deps;
    metrics.inc('upstreamTransient');
    if (clientGone()) return terminal({ ok: false, clientGone: true });
    // Retries are per account: reset the counter if the sticky account changed
    // since the last outage.
    if (state.upstreamRetryAccountId !== session.accountId) {
        state.upstreamRetryAccountId = session.accountId;
        state.upstreamRetryAttempt = 0;
        state.upstreamFreshRetryDone = false;
    }
    const usedAccount = accounts.getAccounts().find(a => a.id === session.accountId);
    const { maxUpstreamRetries } = currentConfig();
    if (state.upstreamRetryAttempt < maxUpstreamRetries && !deadlineHit()) {
        state.upstreamRetryAttempt++;
        log(`${agentTag} DS upstream temporarily unavailable (${state.modelError?.content || 'generation_err'}); not penalising account ${usedAccount?.id || 'n/a'}, retrying the last turn in the SAME session (${state.upstreamRetryAttempt}/${maxUpstreamRetries})...`);
        // Do NOT reset the remote session: a DS-side outage is transient and
        // the session is still valid. Retrying the last turn in place avoids
        // re-sending the full context and the extra create/delete round-trips.
        // readDSResponse() leaves parentMessageId untouched on a model error,
        // so the retry branches from the previous valid message.
        await sleep(backoffDelay(state.upstreamRetryAttempt, retryDelayMs()));
        return RETRY;
    }
    // Same-session retries are exhausted. If DS still reports the outage, try
    // once more in a FRESH remote session (full context) in case the old
    // session itself was marked bad, then give up.
    if (!state.upstreamFreshRetryDone && !deadlineHit()) {
        state.upstreamFreshRetryDone = true;
        log(`${agentTag} DS upstream temporarily unavailable after ${state.upstreamRetryAttempt} same-session retr${state.upstreamRetryAttempt === 1 ? 'y' : 'ies'}; recreating the remote session and retrying once with the full context...`);
        sessions.resetRemoteSession(session);
        await sleep(backoffDelay(state.upstreamRetryAttempt || 1, retryDelayMs()));
        return RETRY;
    }
    log(`${agentTag} DS upstream temporarily unavailable after ${state.upstreamRetryAttempt} retr${state.upstreamRetryAttempt === 1 ? 'y' : 'ies'} on account ${usedAccount?.id || 'n/a'}; giving up.`);
    return terminalError({
        status: failureClass.status,
        type: failureClass.type,
        message: state.modelError?.content || 'DS upstream temporarily unavailable',
        agentId,
        failure: { failedSessionId: session.id, failedMessageCount: session.messageCount, accountId: session.accountId },
        extra: { upstream_retries: state.upstreamRetryAttempt },
    });
}

// The last line of defence: the account was penalised (short or rate-limit
// cooldown) and the request is about to rotate, or give up if nothing is
// available. Returns ROTATE when another account is ready, otherwise a
// terminal error whose status reflects whether any account is still usable.
async function terminalOrRotateRecoverable(state, deps, ctl, failureClass, timedOut, malformedCooldownMs) {
    const { agentId, agentTag, session, clientGone, rotationDeadlineHit, log } = deps;
    const usedAccount = accounts.getAccounts().find(a => a.id === session.accountId);
    if (state.modelError?.type === 'rate_limit' || state.modelError?.finish_reason === 'rate_limit_reached') {
        accounts.markAccountFailure(usedAccount, 429, 'rate-limit-empty-response');
    } else {
        // An empty/malformed stream is usually a transient model or protocol
        // glitch, NOT a dead account. Use the short recoverable-failure cooldown
        // instead of the long accountCooldownMs, otherwise a single upstream
        // protocol change parks every account for minutes.
        accounts.markAccountBroken(usedAccount, `empty response (${failureClass.type})`, malformedCooldownMs);
    }
    // `waitForAvailableAccount` returns the *current* availability, so a single
    // call covers both the immediate and the wait-then-check cases.
    const { failure, rotated } = await rotateAccountAfterFailure({
        session, accountAttempt: ctl.accountAttempt, agentTag, reason: failureClass.type,
        log, clientGone, rotationDeadlineHit,
    });
    if (rotated) return ROTATE;
    const errorType = failureClass.type;
    const errorMessage = state.modelError?.content
        || (timedOut
            ? 'DS request deadline reached while recovering an empty response'
            : `DS returned empty content after ${state.retryAttempt} retr${state.retryAttempt === 1 ? 'y' : 'ies'}`);
    log(`${agentTag} ${errorType} after ${state.retryAttempt} retr${state.retryAttempt === 1 ? 'y' : 'ies'} and ${ctl.accountAttempt + 1} account attempt(s). Giving up.`);
    const allCooling = !accounts.hasAvailableAccount();
    return terminalError({
        status: failureClass.status,
        type: errorType,
        message: errorMessage,
        allCooling,
        agentId,
        failure,
        extra: {
            retry_attempts: state.retryAttempt,
            account_attempts: ctl.accountAttempt + 1,
            upstream_prompt_chars: state.fullPrompt.length,
        },
    });
}

module.exports = {
    handleAuthExpired,
    handleMutedAccount,
    terminalContextTooLong,
    handleTransientOutage,
    terminalOrRotateRecoverable,
};
