'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { finalizeIosSign } = require('../gravity-sign-ios.cjs');

test('finalizeIosSign matches captured iOS param key order', () => {
  const params = {
    app_version: '14.2',
    country: 'JP',
    device: 'ios',
    idfa: 'test-idfa',
    keyword: '中国',
    languageV2: 'ja',
    model: 'iPad8,6',
    operator_name: '',
    product: 'gravity',
    referrer: 'default',
    sim_country: '',
    sys_lang: 'ja-JP',
    system_version: '18.7',
    token: 'tok',
    user_country: 'JP',
    uwd: 'test-uwd',
    zone: '9',
  };
  const signed = finalizeIosSign(params, 1791343629);
  assert.equal(signed.ts, '1791343629');
  assert.ok(signed.sign);
  assert.equal(signed.uwd, 'test-uwd');
  assert.equal(signed.keyword, '中国');
  assert.ok(!Object.prototype.hasOwnProperty.call(signed, 'api_security'));
});
