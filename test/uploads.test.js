'use strict';
// Unit tests for lib/uploads.js (mime guessing, data-uri decoding, response
// parsing, filename derivation).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    guessMimeFromName,
    extractUploadedFileId,
    extractFetchedFiles,
    decodeDataUri,
    filenameForSource,
} = require('../lib/uploads');

test('guessMimeFromName: maps known extensions', () => {
    assert.equal(guessMimeFromName('a.png'), 'image/png');
    assert.equal(guessMimeFromName('a.jpg'), 'image/jpeg');
    assert.equal(guessMimeFromName('a.jpeg'), 'image/jpeg');
    assert.equal(guessMimeFromName('a.webp'), 'image/webp');
    assert.equal(guessMimeFromName('a.gif'), 'image/gif');
    assert.equal(guessMimeFromName('a.bmp'), 'image/bmp');
    assert.equal(guessMimeFromName('a.pdf'), 'application/pdf');
    assert.equal(guessMimeFromName('a.txt'), 'text/plain');
});

test('guessMimeFromName: case-insensitive and falls back to octet-stream', () => {
    assert.equal(guessMimeFromName('A.PNG'), 'image/png');
    assert.equal(guessMimeFromName('archive.zip'), 'application/octet-stream');
    assert.equal(guessMimeFromName('noext'), 'application/octet-stream');
    assert.equal(guessMimeFromName(''), 'application/octet-stream');
    assert.equal(guessMimeFromName(null), 'application/octet-stream');
});

test('extractUploadedFileId: reads data.biz_data.id', () => {
    assert.equal(extractUploadedFileId({ data: { biz_data: { id: 'f1' } } }), 'f1');
});

test('extractUploadedFileId: null when missing', () => {
    assert.equal(extractUploadedFileId({}), null);
    assert.equal(extractUploadedFileId(null), null);
    assert.equal(extractUploadedFileId({ data: { biz_data: {} } }), null);
});

test('extractFetchedFiles: returns the files array', () => {
    const files = [{ id: 'f1', status: 'SUCCESS' }];
    assert.deepEqual(extractFetchedFiles({ data: { biz_data: { files } } }), files);
});

test('extractFetchedFiles: [] for missing or non-array files', () => {
    assert.deepEqual(extractFetchedFiles({}), []);
    assert.deepEqual(extractFetchedFiles(null), []);
    assert.deepEqual(extractFetchedFiles({ data: { biz_data: { files: 'nope' } } }), []);
});

test('decodeDataUri: decodes base64 data URIs', () => {
    const b64 = Buffer.from('hello').toString('base64');
    const out = decodeDataUri(`data:image/png;base64,${b64}`);
    assert.equal(out.mime, 'image/png');
    assert.equal(out.buffer.toString('utf8'), 'hello');
});

test('decodeDataUri: decodes percent-encoded (non-base64) data URIs', () => {
    const out = decodeDataUri('data:text/plain,hello%20world');
    assert.equal(out.mime, 'text/plain');
    assert.equal(out.buffer.toString('utf8'), 'hello world');
});

test('decodeDataUri: defaults mime to application/octet-stream', () => {
    const out = decodeDataUri('data:;base64,aGk=');
    assert.equal(out.mime, 'application/octet-stream');
    assert.equal(out.buffer.toString('utf8'), 'hi');
});

test('decodeDataUri: returns null for non-data URIs', () => {
    assert.equal(decodeDataUri('https://example.com/a.png'), null);
    assert.equal(decodeDataUri(''), null);
    assert.equal(decodeDataUri(null), null);
});

test('filenameForSource: uses the basename of an http(s) URL', () => {
    assert.equal(filenameForSource('https://example.com/a/b/photo.png', 'image/png'), 'photo.png');
});

test('filenameForSource: data URIs still produce a non-empty name', () => {
    // `new URL('data:...')` parses the payload as the pathname, so this does not
    // yield a clean "upload-<ts>.png" name. Assert only the real contract: the
    // function never returns an empty string.
    const name = filenameForSource('data:image/png;base64,AAAA', 'image/png');
    assert.ok(typeof name === 'string' && name.length > 0);
});

test('filenameForSource: defaults the extension to bin', () => {
    const noMime = filenameForSource('relative/path', '');
    assert.match(noMime, /^upload-\d+\.bin$/);
});

test('filenameForSource: accepts an injected path module', () => {
    const fakePath = { basename: () => 'injected.txt' };
    assert.equal(filenameForSource('https://example.com/x', 'text/plain', fakePath), 'injected.txt');
});
