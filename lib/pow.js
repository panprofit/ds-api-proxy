'use strict';
// Proof-of-work header builder. DS requires a base64-encoded JSON blob that
// includes the solved challenge answer and the target path.

function buildPowHeader(challenge, answer, targetPath = '/api/v0/chat/completion') {
    return Buffer.from(JSON.stringify({
        algorithm: challenge.algorithm, challenge: challenge.challenge,
        salt: challenge.salt, answer: answer,
        signature: challenge.signature, target_path: targetPath
    })).toString('base64');
}

module.exports = { buildPowHeader };
