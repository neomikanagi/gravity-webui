'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const {createTranslateService, TranslateError, looksEnglish, skipTranslate} = require('../gravity-translate.cjs');
const {makeHandler} = require('../serve.cjs');

test('looksEnglish skips latin-only lines but not Chinese or Japanese', () => {
  assert.equal(looksEnglish('Hello!'), true);
  assert.equal(looksEnglish('ok'), true);
  assert.equal(looksEnglish('こんにちは！'), false);
  assert.equal(looksEnglish('今天天气不错'), false);
  assert.equal(looksEnglish('Giftありがとう'), false);
  assert.equal(looksEnglish(''), false);
  assert.equal(looksEnglish('12345'), false);
});

test('skipTranslate ignores numbers, emoji, punctuation and already-English chat', () => {
  assert.equal(skipTranslate('12345'), true);
  assert.equal(skipTranslate('666'), true);
  assert.equal(skipTranslate('😂😂😂'), true);
  assert.equal(skipTranslate('✨666✨'), true);
  assert.equal(skipTranslate('+1'), true);
  assert.equal(skipTranslate('♡♡'), true);
  assert.equal(skipTranslate('Hello'), true);
  assert.equal(skipTranslate('こんにちは！'), false);
  assert.equal(skipTranslate('Giftありがとう'), false);
  assert.equal(skipTranslate('今天天气不错'), false);
});

function fakeFetch(calls, {text = 'Hello', status = 200} = {}) {
  return async (url, options) => {
    calls.push({url, auth: options.headers.Authorization, text: String(options.body.get('text'))});
    return {ok: status >= 200 && status < 300, status, json: async () => ({translations: [{text}]})};
  };
}
const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('translate validates input, picks the free endpoint for :fx keys and caches', async () => {
  const calls = [], service = createTranslateService({fetchImpl: fakeFetch(calls), key: 'test-key:fx'});
  await assert.rejects(service.translate({text: '', request_id: uuid}), /1～500/);
  await assert.rejects(service.translate({text: 'x'.repeat(501), request_id: uuid}), /1～500/);
  await assert.rejects(service.translate({text: 'hi', target_lang: 'FR', request_id: uuid}), /1～500/);
  await assert.rejects(service.translate({text: 'hi', request_id: 'bad'}), /提交编号/);
  await assert.rejects(service.translate({text: 'hi', request_id: uuid, evil: 1}), /参数/);
  const first = await service.translate({text: 'こんにちは', request_id: uuid});
  assert.equal(first.text, 'Hello'); assert.equal(first.cached, false);
  assert.ok(calls[0].url.startsWith('https://api-free.deepl.com/'));
  assert.equal(calls[0].auth, 'DeepL-Auth-Key test-key:fx');
  const second = await service.translate({text: 'こんにちは', request_id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'});
  assert.equal(second.cached, true); assert.equal(calls.length, 1);
  const pro = [];
  const proService = createTranslateService({fetchImpl: fakeFetch(pro), key: 'pro-key'});
  await proService.translate({text: 'おはよう', request_id: uuid});
  assert.ok(pro[0].url.startsWith('https://api.deepl.com/'));
});

test('already-English text is skipped without a network call and budgets are enforced', async () => {
  const calls = [], service = createTranslateService({fetchImpl: fakeFetch(calls), key: 'k:fx', dayBudget: 5});
  const skipped = await service.translate({text: 'hello', request_id: uuid});
  assert.equal(skipped.skipped, true); assert.equal(calls.length, 0);
  const emoji = await service.translate({text: '😂😂', request_id: 'cccccccc-dddd-eeee-ffff-111111111111'});
  assert.equal(emoji.skipped, true);
  await service.translate({text: 'こんにちは', request_id: uuid});
  await assert.rejects(service.translate({text: 'ありがとう', request_id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'}), e => e.status === 429);
});

test('missing key and failed upstreams fail closed without leaking the key', async () => {
  const noKey = createTranslateService({key: ''});
  await assert.rejects(noKey.translate({text: 'こんにちは', request_id: uuid}), e => e.status === 503);
  const leaky = createTranslateService({fetchImpl: async () => { throw Error('down'); }, key: 'SECRET-ABC-123'});
  await assert.rejects(leaky.translate({text: 'こんにちは', request_id: uuid}), e => e instanceof TranslateError && !e.message.includes('SECRET-ABC-123'));
  const failing = createTranslateService({fetchImpl: async () => { throw Error('down'); }, key: 'k:fx'});
  await assert.rejects(failing.translate({text: 'こんにちは', request_id: uuid}), /暂不可用/);
  const quota = createTranslateService({fetchImpl: async () => ({ok: false, status: 456, json: async () => ({})}), key: 'k:fx'});
  await assert.rejects(quota.translate({text: 'こんにちは', request_id: uuid}), /免费额度/);
});

test('translate route accepts the page action and rejects foreign origins', async t => {
  const calls = [], service = createTranslateService({fetchImpl: fakeFetch(calls), key: 'k:fx'});
  const server = http.createServer(makeHandler({translate: service}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const body = {text: 'おはよう', request_id: uuid};
  const ok = await fetch(base + '/api/translate', {method: 'POST',
    headers: {Origin: base, 'Content-Type': 'application/json', 'X-Gravity-Action': 'translate-control'},
    body: JSON.stringify(body)});
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).data.text, 'Hello');
  const evil = await fetch(base + '/api/translate', {method: 'POST',
    headers: {Origin: base, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json', 'X-Gravity-Action': 'translate-control'},
    body: JSON.stringify(body)});
  assert.equal(evil.status, 403);
  const bad = await fetch(base + '/api/translate', {method: 'POST',
    headers: {Origin: base, 'Content-Type': 'application/json', 'X-Gravity-Action': 'wrong'},
    body: JSON.stringify(body)});
  assert.equal(bad.status, 403);
});
