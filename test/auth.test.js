import test from 'node:test';
import assert from 'node:assert/strict';
import { regionFrom, readContext } from '../js/genesys-auth.js';

test('region from the Genesys host origin', () => {
  assert.equal(regionFrom('https://apps.mypurecloud.de'), 'mypurecloud.de');
  assert.equal(regionFrom('https://apps.euw2.pure.cloud'), 'euw2.pure.cloud');
  assert.equal(regionFrom('mypurecloud.ie'), 'mypurecloud.ie');
});

test('unknown hosts give no region', () => {
  assert.equal(regionFrom('https://evil.example.com'), '');
  assert.equal(regionFrom('https://apps.mypurecloud.de.evil.com'), '');
  assert.equal(regionFrom(''), '');
});

test('context from the integration URL', () => {
  const c = readContext('?clientId=12345678-1234-1234-1234-123456789ABC&gcHostOrigin=https%3A%2F%2Fapps.mypurecloud.de&gcLangTag=da-dk');
  assert.equal(c.ok, true);
  assert.equal(c.region, 'mypurecloud.de');
  assert.equal(c.clientId, '12345678-1234-1234-1234-123456789abc');
  assert.equal(c.lang, 'da-dk');
});

test('pcEnvironment wins over gcHostOrigin, missing client id is reported', () => {
  const c = readContext('?pcEnvironment=mypurecloud.ie&gcHostOrigin=https%3A%2F%2Fapps.mypurecloud.de');
  assert.equal(c.region, 'mypurecloud.ie');
  assert.equal(c.ok, false);
  assert.deepEqual(c.problems, ['clientId']);
});
