'use strict';

/**
 * @typedef {object} Metrics
 * @property {number} requests Total completion requests that reached dispatch.
 * @property {number} completions Total successful completions returned.
 * @property {number} toolCalls Total responses delivered as a tool call.
 * @property {number} rotations Total account rotations after a failure.
 * @property {number} upstreamTransient Total transient DS upstream outages seen.
 * @property {number} toolCallReprompts Tool-call turns re-prompted in the same session after a generation_err.
 * @property {number} emptyResponses Total empty-response recoveries attempted.
 * @property {number} malformedToolCalls Terminal malformed tool-call markup failures.
 * @property {number} unknownTool Terminal unknown-tool-name failures.
 * @property {number} toolChoiceUnmet Terminal responses that ignored an explicit tool_choice.
 * @property {number} toolResultEcho Fabricated native tool-result envelopes (<tool_result>...</tool_result>) dropped from model output.
 */

function createMetrics() {
    /** @type {Metrics} */
    const counters = {
        requests: 0,
        completions: 0,
        toolCalls: 0,
        rotations: 0,
        upstreamTransient: 0,
        toolCallReprompts: 0,
        emptyResponses: 0,
        malformedToolCalls: 0,
        unknownTool: 0,
        toolChoiceUnmet: 0,
        toolResultEcho: 0,
    };

    /** @param {keyof Metrics} name */
    function inc(name, by = 1) {
        if (typeof counters[name] === 'number') counters[name] += by;
    }

    /** @returns {Metrics} a copy, so callers cannot mutate the live counters */
    function snapshot() { return { ...counters }; }

    return { inc, snapshot };
}

const instance = createMetrics();

module.exports = {
    createMetrics,
    instance,
    inc: instance.inc,
    snapshot: instance.snapshot,
};
