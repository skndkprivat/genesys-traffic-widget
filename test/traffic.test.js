import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConversations, readJsonLoose, clampToPeriod, listOf } from '../js/traffic.js';

const conv = (over = {}) => ({
  conversationId: 'c1', conversationStart: '2026-10-01T10:00:00Z', originatingDirection: 'inbound',
  participants: [
    { purpose: 'customer', participantName: '+4512345678', sessions: [{ dnis: 'tel:+4570000001', segments: [{ queueId: 'q1', segmentStart: '2026-10-01T10:00:05Z' }] }] },
    { purpose: 'ivr', sessions: [{ flow: { flowName: 'Main', flowType: 'INBOUNDCALL' }, segments: [{ segmentStart: '2026-10-01T10:00:01Z' }] }] },
    { purpose: 'acd', participantName: 'Support', sessions: [{ segments: [{ queueId: 'q1' }] }] },
    { purpose: 'agent', participantName: 'Jane Agent', sessions: [{ segments: [{ queueId: 'q1' }] }] },
  ], ...over,
});

test('queue name is the acd participant name, never the customer number or the agent', () => {
  const [c] = parseConversations({ conversations: [conv()] });
  assert.equal(c.queue, 'Support');
  assert.equal(c.blue, true);
});

test('queue name from the queue list wins when available', () => {
  const [c] = parseConversations({ conversations: [conv()] }, new Map([['q1', 'Sales DK']]));
  assert.equal(c.queue, 'Sales DK');
});

test('falls back to a short queue id when no name is known', () => {
  const c0 = conv(); c0.participants = c0.participants.filter(p => p.purpose !== 'acd');
  const [c] = parseConversations({ conversations: [c0] });
  assert.equal(c.queue, 'q1');
});

test('no queue at all stays empty (lost in the IVR)', () => {
  const c0 = conv(); c0.participants = [c0.participants[0], c0.participants[1]]; c0.participants[0].sessions[0].segments = [];
  const [c] = parseConversations({ conversations: [c0] });
  assert.equal(c.queue, ''); assert.equal(c.blue, false);
});

test('flow types are kept in call order', () => {
  const [c] = parseConversations({ conversations: [conv()] });
  assert.deepEqual(c.flows, ['Main']); assert.deepEqual(c.ftypes, ['INBOUNDCALL']);
});

test('readJsonLoose handles BOM and pages back to back', () => {
  assert.equal(readJsonLoose('﻿{"a":1}\n{"b":2}').length, 2);
  assert.throws(() => readJsonLoose('{"a": ['));
});

test('listOf finds the list in different shapes', () => {
  assert.equal(listOf({ entities: [{ x: 1 }] }).length, 1);
  assert.equal(listOf([{ x: 1 }]).length, 1);
  assert.equal(listOf({ foo: 1 }).length, 0);
});

test('clampToPeriod moves early outliers to the edge of the period', () => {
  const day = 86400000, t = Date.parse('2026-10-05T00:00:00Z');
  const convs = [{ start: t - 40 * day }, ...Array.from({ length: 50 }, (_, i) => ({ start: t + i * 3600000 }))];
  const { clamped } = clampToPeriod(convs);
  assert.equal(clamped, 1);
  assert.ok(convs[0].start >= t - day);
});

import { isAnswered } from '../js/traffic.js';
const seg = (segmentType, extra = {}) => ({ sessions: [{ segments: [{ segmentType, ...extra }], ...extra.session }] });

test('answered: agent with an interact segment', () => {
  assert.equal(isAnswered([{ purpose: 'agent', ...seg('alert') }, { purpose: 'agent', ...seg('interact') }], true), true);
});
test('not answered: agent only alerted, never connected', () => {
  assert.equal(isAnswered([{ purpose: 'customer', ...seg('interact') }, { purpose: 'agent', ...seg('alert') }], true), false);
});
test('the external CALLER (direction inbound) does not make a call answered', () => {
  assert.equal(isAnswered([{ purpose: 'external', sessions: [{ direction: 'inbound', segments: [{ segmentType: 'interact' }] }] }, { purpose: 'ivr', ...seg('ivr') }], false), false);
});
test('answered: transferred out to an external number that connected', () => {
  assert.equal(isAnswered([{ purpose: 'external', sessions: [{ direction: 'inbound', segments: [{ segmentType: 'interact' }] }] },
    { purpose: 'external', sessions: [{ direction: 'outbound', segments: [{ segmentType: 'interact' }] }] }], false), true);
});
test('IVR transfer without a queue is answered, but not when it went to voicemail', () => {
  const ivr = { purpose: 'ivr', sessions: [{ segments: [{ disconnectType: 'transfer' }] }] };
  assert.equal(isAnswered([ivr], false), true);
  assert.equal(isAnswered([ivr, { purpose: 'voicemail', ...seg('interact') }], false), false);
  assert.equal(isAnswered([ivr], true), false);   // went to a queue and nobody took it
});
test('exports without segment types: an agent/user participant counts as answered', () => {
  assert.equal(isAnswered([{ purpose: 'agent', sessions: [{ segments: [{}] }] }], true), true);
});

test('e-mail: the address written to is the "DID", shown in full; outbound legs are ignored', () => {
  const [c] = parseConversations({ conversations: [{
    conversationId: 'e1', conversationStart: '2026-10-01T10:00:00Z', originatingDirection: 'inbound',
    participants: [
      { purpose: 'customer', sessions: [{ mediaType: 'email', direction: 'inbound', addressFrom: 'kunde@example.com', addressTo: 'support@firma.dk', segments: [] }] },
      { purpose: 'agent', sessions: [{ mediaType: 'email', direction: 'outbound', addressTo: 'kunde@example.com', segments: [] }] },
    ] }] });
  assert.equal(c.didFull, 'support@firma.dk'); assert.equal(c.did, 'support@firma.dk'); assert.equal(c.media, 'email');
});
test('phone numbers are still masked and a dnis wins over an address', () => {
  const [c] = parseConversations({ conversations: [conv()] });
  assert.match(c.did, /^••••• /); assert.equal(c.media, '');
});
