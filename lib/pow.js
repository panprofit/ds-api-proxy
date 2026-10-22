'use strict';

function buildPowHeader(challenge, answer, targetPath = '/api/v0/chat/completion') {
    return Buffer.from(JSON.stringify({
        algorithm: challenge.algorithm, challenge: challenge.challenge,
        salt: challenge.salt, answer: answer,
        signature: challenge.signature, target_path: targetPath
    })).toString('base64');
}

module.exports = { buildPowHeader };
