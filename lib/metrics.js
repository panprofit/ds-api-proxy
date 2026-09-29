'use strict';
// In-process counters for a few operational signals, surfaced in the detailed
// /health report (loopback only). Deliberately dependency-free and
// non-persistent: this is a local proxy with no metrics backend, so the goal is
// just an at-a-glance view of what the server has been doing since boot.
//
// Counters are process-lifetime totals (never reset on request) except where a
// field is documented as a gauge (e.g. rotations in flight).

/**
 * @typedef {object} Metrics
 * @property {number} requests Total completion requests that reached dispatch.
 * @property {number} completions Total successful completions returned.
 * @property {number} toolCalls Total responses delivered as a tool call.
 * @property {number} rotations Total account rotations after a failure.
 * @property {number} upstreamTransient Total transient DS upstream outages seen.
 * @property {number} emptyResponses Total empty-response recoveries attempted.
 */

function createMetrics() {
    /** @type {Metrics} */
    const counters = {
        requests: 0,
        completions: 0,
        toolCalls: 0,
        rotations: 0,
        upstreamTransient: 0,
        emptyResponses: 0,
    };

    /** @param {keyof Metrics} name */
    function inc(name, by = 1) {
        if (typeof counters[name] === 'number') counters[name] += by;
    }

    /** @returns {Metrics} a copy, so callers cannot mutate the live counters */
    function snapshot() { return { ...counters }; }

    return { inc, snapshot };
}

// Default process-wide instance. Like ./accounts and ./sessions this is a
// singleton so request-path code can metrics.inc('x') without threading a
// handle through every dependency.
const instance = createMetrics();

module.exports = { createMetrics, instance };
