'use strict';
// Corpus of real-world-shaped tool-call markup for the parser regression net.
//
// Each entry: { name, input, call } where `call` is:
//   - { name, args }  -> parseToolCall(input) must return that call
//   - null            -> parseToolCall(input) must return null (either genuinely
//                        unparsable, or a truncation the recovery loop -- not
//                        the parser -- is responsible for repairing)
//
// Add the motivating input here whenever a repair rule in lib/json-repair.js or
// lib/parser-dsml.js is added, so it cannot silently regress.

module.exports = [
    // --- strict / well-formed ---------------------------------------------
    {
        name: 'strict JSON tool_call',
        input: '{"tool_call":{"name":"read","arguments":{"path":"/x"}}}',
        call: { name: 'read', args: { path: '/x' } },
    },
    {
        name: 'function_call nested shape',
        input: '{"function_call":{"function":{"name":"read","arguments":"{\\"path\\":\\"/y\\"}"}}}',
        call: { name: 'read', args: { path: '/y' } },
    },
    {
        name: 'tool_calls array (single)',
        input: '{"tool_calls":[{"function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}',
        call: { name: 'bash', args: { command: 'ls' } },
    },
    {
        name: 'fenced json',
        input: '```json\n{"tool_call":{"name":"read","arguments":{"path":"/f"}}}\n```',
        call: { name: 'read', args: { path: '/f' } },
    },
    {
        name: 'XML <tool_call> wrapper',
        input: '<tool_call>{"name":"read","arguments":{"path":"/z"}}</tool_call>',
        call: { name: 'read', args: { path: '/z' } },
    },
    {
        name: 'lone fenced bash (whole message)',
        input: '```bash\nls -la\n```',
        call: { name: 'bash', args: { command: 'ls -la' } },
    },
    {
        name: 'DSML <tool_calls><invoke>',
        input: '<tool_calls><invoke name="read"><parameter name="path">/d</parameter></invoke></tool_calls>',
        call: { name: 'read', args: { path: '/d' } },
    },

    // --- JSON repairs ------------------------------------------------------
    {
        name: 'trailing comma in arguments',
        input: '{"tool_call":{"name":"read","arguments":{"path":"/t",}}}',
        call: { name: 'read', args: { path: '/t' } },
    },
    {
        name: 'raw newline inside a string value',
        input: '{"tool_call":{"name":"write","arguments":{"content":"line1\nline2"}}}',
        call: { name: 'write', args: { content: 'line1\nline2' } },
    },
    {
        name: 'unescaped double quotes inside a value',
        input: '{"tool_call":{"name":"bash","arguments":{"command":"echo "hi""}}}',
        call: { name: 'bash', args: { command: 'echo "hi"' } },
    },
    {
        name: 'XML-like keys and glued literals',
        input: '{"tool_call":{ id="call_1""name":"read","arguments":{"path":"/x"}}}',
        call: { name: 'read', args: { path: '/x' } },
    },
    {
        name: 'stray closing quote before trailing braces',
        input: '{"tool_call":{"name":"read","arguments":{"limit":35"}}}',
        call: { name: 'read', args: { limit: 35 } },
    },
    {
        name: 'nested JSON body escaped one level too few',
        input: '{"tool_call":{"name":"bash","arguments":{"command":"node -e \'\nconsole.log("hi");\n\'"}}}',
        call: { name: 'bash', argsAny: true },
    },
    {
        name: 'concatenated calls missing the comma (first wins)',
        input: '{"tool_call":{"name":"read","arguments":{"path":"/a"}}}{"tool_call":{"name":"read","arguments":{"path":"/b"}}}',
        call: { name: 'read', args: { path: '/a' } },
    },
    {
        name: 'duplicate JSON then truncated DSML copy (JSON wins)',
        input: '{"tool_call":{"name":"read","arguments":{"path":"/x"}}} <tool_call>{"name":"read","argu',
        call: { name: 'read', args: { path: '/x' } },
    },
    {
        name: 'tool_call key with no arguments object',
        input: '{"tool_call":{"name":"read"}}',
        call: { name: 'read', args: {} },
    },

    // --- rejects / truncations handed to the recovery loop -----------------
    {
        name: 'plain prose mentioning a tool',
        input: 'I will read the file for you now.',
        call: null,
    },
    {
        name: 'prose with an illustrative fenced bash snippet',
        input: 'Here is how: ```bash\nls\n``` use it wisely.',
        call: null,
    },
    {
        name: 'truncated mid arguments (recovery repairs)',
        input: '{"tool_call":{"name":"read","arguments":{"path":"/m"}}',
        call: null,
    },
    {
        name: 'truncated mid string (recovery repairs)',
        input: '{"tool_call":{"name":"read","arguments":{"path":"/m',
        call: null,
    },
    {
        name: 'empty tool name is rejected',
        input: '{"tool_call":{"name":"","arguments":{}}}',
        call: null,
    },
    {
        name: 'array arguments is rejected',
        input: '{"tool_call":{"name":"read","arguments":[1,2]}}',
        call: null,
    },
];
