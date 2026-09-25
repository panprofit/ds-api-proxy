'use strict';
// Proof-of-work WASM loader and solver. The wasm module cache and the
// solvePOW() ABI glue are isolated from the HTTP layer. upstream.js re-exports
// loadModule/solvePOW for existing callers.

const moduleCache = new Map();

// --- PoW -------------------------------------------------------------------

async function loadModule(wasmUrl, { timeoutMs = 15000 } = {}) {
    if (!wasmUrl) throw new Error('POW: missing wasmUrl');
    if (!moduleCache.has(wasmUrl)) {
        const p = (async () => {
            const resp = await fetch(wasmUrl, { signal: AbortSignal.timeout(timeoutMs) });
            if (!resp.ok) throw new Error(`POW: could not fetch WASM (HTTP ${resp.status})`);
            const bytes = await resp.arrayBuffer();
            return WebAssembly.compile(bytes);
        })();
        moduleCache.set(wasmUrl, p);
        p.catch(() => moduleCache.delete(wasmUrl));
    }
    return moduleCache.get(wasmUrl);
}

async function solvePOW(challenge, wasmUrl, opts = {}) {
    const module = await loadModule(wasmUrl, opts);
    const instance = await WebAssembly.instantiate(module, { wbg: {} });
    const e = instance.exports;
    const encoder = new TextEncoder();
    const prefix = challenge.salt + '_' + challenge.expire_at + '_';
    const cBytes = encoder.encode(challenge.challenge);
    const pBytes = encoder.encode(prefix);
    const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0;
    const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0;
    new Uint8Array(e.memory.buffer, cP, cBytes.length).set(cBytes);
    new Uint8Array(e.memory.buffer, pP, pBytes.length).set(pBytes);
    const sp = e.__wbindgen_add_to_stack_pointer(-16);
    e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, challenge.difficulty);
    const dv = new DataView(e.memory.buffer);
    const code = dv.getInt32(sp, true);
    const ans = dv.getFloat64(sp + 8, true);
    e.__wbindgen_add_to_stack_pointer(16);
    if (code === 0 || !Number.isFinite(ans) || ans <= 0) throw new Error('POW failed');
    return Math.floor(ans);
}

module.exports = {
    loadModule,
    solvePOW,
};
