'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { finalizeIosSign, apiSecurityForTs, TS_MOD, buildIosBaseParams } = require('../gravity-sign-ios.cjs');

// Synthetic credentials only; private App captures are verified separately by the CLI.
const fixture = {
  app_version: '14.2', country: 'JP', device: 'ios', idfa: 'fixture-idfa',
  keyword: '中文 雑談', languageV2: 'ja', model: 'iPad8,6', operator_name: '',
  product: 'gravity', referrer: 'default', sim_country: '', sys_lang: 'ja-JP',
  system_version: '18.7', token: 'fixture%2Btoken%3D', user_country: 'JP',
  uwd: 'fixture-uwd', zone: '9',
};

// Independent reference value from the decoded constants and captured Swift algorithm.
const expectedFixtureSign = '5814c804970e8f406a018994f7e76355';

test('iOS timestamp modulus equals the decoded ARM64 immediate, not Android modulus', () => {
  assert.equal(TS_MOD, 0x0197a04b);
  assert.equal(TS_MOD, 26714187);
  assert.equal(1791344121 % TS_MOD, 1493592);
});
test('iOS api_security handles timestamp rollover', () => {
  assert.equal(apiSecurityForTs(TS_MOD), apiSecurityForTs(0));
  assert.equal(apiSecurityForTs(TS_MOD + 1), apiSecurityForTs(1));
  assert.notEqual(apiSecurityForTs(TS_MOD - 1), apiSecurityForTs(TS_MOD));
});
test('iOS sign matches fixed reference hash with Unicode, empty values and stored percent escapes', () => {
  const signed = finalizeIosSign(fixture, 1791344121);
  assert.equal(signed.sign, expectedFixtureSign);
  assert.equal(signed.ts, '1791344121');
  assert.equal(signed.token, fixture.token);
  assert.equal(signed.keyword, fixture.keyword);
  assert.equal(signed.uwd, fixture.uwd);
  assert.equal(signed.operator_name, '');
  assert.ok(!Object.hasOwn(signed, 'api_security'));
});
test('iOS sign is independent of input key insertion order and does not mutate parameters', () => {
  const reversed = Object.fromEntries(Object.entries(fixture).reverse());
  assert.deepEqual(finalizeIosSign(reversed, 1791344121), finalizeIosSign(fixture, 1791344121));
  assert.ok(!Object.hasOwn(fixture, 'sign'));
  assert.ok(!Object.hasOwn(fixture, 'ts'));
});
test('stale signing fields are replaced and timestamp type does not change the signature', () => {
  assert.equal(finalizeIosSign({...fixture, sign:'old', ts:'old', api_security:'old'}, '1791344121').sign, expectedFixtureSign);
  assert.notEqual(finalizeIosSign(fixture, 1791344122).sign, expectedFixtureSign);
});
test('invalid timestamps fail without returning signed requests', () => {
  for (const ts of [-1, NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => finalizeIosSign(fixture, ts), /invalid_ios_timestamp/);
  }
});
test('captured device values, including empty strings, are kept when building iOS base parameters', () => {
  const device = {...fixture};
  const params = buildIosBaseParams({token:fixture.token, device});
  assert.equal(params.idfa, device.idfa);
  assert.equal(params.uwd, device.uwd);
  assert.equal(params.model, device.model);
  assert.equal(params.operator_name, device.operator_name);
  assert.equal(params.sim_country, device.sim_country);
  assert.ok(!Object.hasOwn(params, 'keyword'));
  assert.ok(!Object.hasOwn(params, 'app_version_code'));
});
