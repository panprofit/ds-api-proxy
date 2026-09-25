'use strict';
// Shared size limits for tool-call parsing. Kept in one place so the JSON
// repair helpers (./json-repair) and the DSML markup parser (./parser-dsml)
// enforce the same caps; ./parser re-exports them for existing callers.

const MAX_TOOL_MARKUP_CHARS = 256 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 128 * 1024;
const MAX_TOOL_JSON_CANDIDATES = 32;
const MAX_DSML_PARAMETERS = 128;
const MAX_DSML_STRUCTURAL_TAGS = MAX_DSML_PARAMETERS * 2 + 16;
const MAX_DSML_TAG_CHARS = 2048;

module.exports = {
    MAX_TOOL_MARKUP_CHARS,
    MAX_TOOL_ARGUMENT_CHARS,
    MAX_TOOL_JSON_CANDIDATES,
    MAX_DSML_PARAMETERS,
    MAX_DSML_STRUCTURAL_TAGS,
    MAX_DSML_TAG_CHARS,
};
