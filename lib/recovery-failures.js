'use strict';

const { isAuthExpiredError } = require('./recovery-classify');
const accounts = require('./accounts');
const sessions = require('./sessions');
const metrics = require('./metrics');
const { currentConfig, retryDelayMs, sleep, backoffDelay } = require('./recovery-util');
const { RETRY, ROTATE, terminal, terminalError, rotateAccountAfterFailure, retrySameAccount } = require('./recovery-transitions');

async function handleAuthExpired(e, deps, ctl) {

    if (!isAuthExpiredError(e)) throw e;
    const { agentId, agentTag, session, clientGone, rotationDeadlineHit, log } = deps;
    const usedAccount = accounts.getAccounts().find(a => a.id === session.accountId);
    accounts.markAccountAuthExpired(usedAccount);
    const { failure, rotated } = await rotateAccountAfterFailure({
        session, accountAttempt: ctl.accountAttempt, agentTag, reason: 'auth expired (captcha/Web API)',
        log, clientGone, rotationDeadlineHit,
    });
    if (rotated) return ROTATE;

    const hasNonExpired = accounts.getAccounts().some(a => a.config.token && a.config.cookie && !a.authExpired);
    const allCooling = hasNonExpired && !accounts.hasAvailableAccount();
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

async function handleMutedAccount(state, deps, ctl) {
    const { agentId, agentTag, session, clientGone, rotationDeadlineHit, log } = deps;
    const untilMs = state.muted.muteUntil != null
        ? state.muted.muteUntil * 1000 - Date.now()
        : currentConfig().accountCooldownMs;
    const parkMs = Math.max(1000, untilMs);
    const usedAccount = accounts.getAccounts().find(a => a.id === session.accountId);
    accounts.markAccountBroken(usedAccount, `muted (${state.muted.message})`, parkMs);

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

async function terminalContextTooLong(state, deps, ctl, failureClass) {
    const { agentId, agentTag, session, log } = deps;
    log(`${agentTag} context_length_exceeded; not rotating accounts.`);
    return terminalError({
        status: failureClass.status,
        type: failureClass.type,
        message: state.modelError?.content || 'DS context length exceeded',
        agentId,
        failure: { failedSessionId: session.id, failedMessageCount: session.messageCount, accountId: session.accountId },
        extra: { account_attempts: ctl.accountAttempt + 1 },
    });
}

async function handleTransientOutage(state, deps, ctl, failureClass) {
    const { agentId, agentTag, session, clientGone, deadlineHit, log } = deps;
    metrics.inc('upstreamTransient');
    if (clientGone()) return terminal({ ok: false, clientGone: true });

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

        await sleep(backoffDelay(state.upstreamRetryAttempt, retryDelayMs()));
        return RETRY;
    }

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

async function terminalOrRotateRecoverable(state, deps, ctl, failureClass, timedOut) {
    const { agentId, agentTag, session, clientGone, deadlineHit, rotationDeadlineHit, log } = deps;

    if (clientGone()) return terminal({ ok: false, clientGone: true });

    if (state.modelError?.type === 'rate_limit' || state.modelError?.finish_reason === 'rate_limit_reached') {
        const usedAccount = accounts.getAccounts().find(a => a.id === session.accountId);
        accounts.markAccountFailure(usedAccount, 429, 'rate-limit-empty-response');
    }

    if (await retrySameAccount({ state, session, agentTag, reason: failureClass.type, log, clientGone, deadlineHit })) {
        return RETRY;
    }

    const { failure, rotated } = await rotateAccountAfterFailure({
        session, accountAttempt: ctl.accountAttempt, agentTag, reason: failureClass.type,
        log, clientGone, rotationDeadlineHit,
    });
    if (rotated) return ROTATE;
    const errorType = failureClass.type;
    const errorMessage = state.modelError?.content
        || (timedOut
            ? 'DS request deadline reached while recovering an empty response'
            : 'DS returned empty content');
    log(`${agentTag} ${errorType} after ${ctl.accountAttempt + 1} account attempt(s). Giving up.`);
    const allCooling = !accounts.hasAvailableAccount();
    return terminalError({
        status: failureClass.status,
        type: errorType,
        message: errorMessage,
        allCooling,
        agentId,
        failure,
        extra: {
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
