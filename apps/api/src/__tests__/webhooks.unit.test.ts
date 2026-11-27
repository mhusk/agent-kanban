import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Event, Subscription } from '@agent-kanban/shared';
import { computeHmacSignature, matchesSubscription } from '../services/webhookDispatcher.js';

const BASE_EVENT: Event = {
  id: 'evt-1',
  type: 'card.commented',
  cardId: 'card-1',
  visibleToUserIds: ['user-alex'],
  actor: {
    actorType: 'human',
    actorId: 'user-alex',
    agentName: null,
    platform: null,
  },
  note: null,
  payload: {
    status: 'todo',
    tags: ['groceries', 'urgent'],
    assignedUserIds: ['user-alex'],
    mentions: ['user-sam'],
  },
  createdAt: '2026-06-01T12:00:00.000Z',
  deliveries: {},
};

const BASE_SUB: Pick<Subscription, 'active' | 'ownerUserId' | 'filters'> = {
  active: true,
  ownerUserId: 'user-alex',
  filters: {
    eventTypes: ['card.commented', 'card.created'],
  },
};

describe('Webhook filter matcher & HMAC signing', () => {
  it('matches active visible subscriptions and filters cleanly on tags, statuses, assignees, mentions', () => {
    expect(matchesSubscription(BASE_EVENT, BASE_SUB)).toBe(true);

    expect(matchesSubscription(BASE_EVENT, { ...BASE_SUB, active: false })).toBe(false);
    expect(matchesSubscription(BASE_EVENT, { ...BASE_SUB, ownerUserId: 'user-sam' })).toBe(false);
    expect(
      matchesSubscription(
        { ...BASE_EVENT, actor: { ...BASE_EVENT.actor, actorType: 'agent' } },
        BASE_SUB,
      ),
    ).toBe(false);

    expect(
      matchesSubscription(BASE_EVENT, {
        ...BASE_SUB,
        filters: { eventTypes: ['card.completed'] },
      }),
    ).toBe(false);

    expect(
      matchesSubscription(BASE_EVENT, {
        ...BASE_SUB,
        filters: { eventTypes: ['card.commented'], tags: ['urgent'] },
      }),
    ).toBe(true);
    expect(
      matchesSubscription(BASE_EVENT, {
        ...BASE_SUB,
        filters: { eventTypes: ['card.commented'], tags: ['finance'] },
      }),
    ).toBe(false);

    const mixedCaseEvent: Event = {
      ...BASE_EVENT,
      payload: { ...BASE_EVENT.payload, tags: ['Groceries', 'Urgent'] },
    };
    expect(
      matchesSubscription(mixedCaseEvent, {
        ...BASE_SUB,
        filters: { eventTypes: ['card.commented'], tags: ['groceries'] },
      }),
    ).toBe(true);
    expect(
      matchesSubscription(BASE_EVENT, {
        ...BASE_SUB,
        filters: { eventTypes: ['card.commented'], tags: ['URGENT'] },
      }),
    ).toBe(true);
    expect(
      matchesSubscription(mixedCaseEvent, {
        ...BASE_SUB,
        filters: { eventTypes: ['card.commented'], tags: ['finance'] },
      }),
    ).toBe(false);

    expect(
      matchesSubscription(BASE_EVENT, {
        ...BASE_SUB,
        filters: { eventTypes: ['card.commented'], statuses: ['todo', 'blocked'] },
      }),
    ).toBe(true);
    expect(
      matchesSubscription(BASE_EVENT, {
        ...BASE_SUB,
        filters: { eventTypes: ['card.commented'], statuses: ['done'] },
      }),
    ).toBe(false);

    expect(
      matchesSubscription(BASE_EVENT, {
        ...BASE_SUB,
        filters: { eventTypes: ['card.commented'], assignedUserIds: ['user-alex'] },
      }),
    ).toBe(true);
    expect(
      matchesSubscription(BASE_EVENT, {
        ...BASE_SUB,
        filters: { eventTypes: ['card.commented'], assignedUserIds: ['user-sam'] },
      }),
    ).toBe(false);

    expect(
      matchesSubscription(BASE_EVENT, {
        ...BASE_SUB,
        filters: { eventTypes: ['card.commented'], mentionedUserIds: ['user-sam'] },
      }),
    ).toBe(true);
    expect(
      matchesSubscription(BASE_EVENT, {
        ...BASE_SUB,
        filters: { eventTypes: ['card.commented'], mentionedUserIds: ['user-alex'] },
      }),
    ).toBe(false);
  });

  it('computes t=<ts>,v1=<hex> HMAC-SHA256 signatures deterministically', () => {
    const secret = 'test-hmac-secret-value';
    const ts = '1780315200';
    const body = '{"id":"evt-1"}';
    const sig = computeHmacSignature(secret, ts, body);
    const expected = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    expect(sig).toBe(`t=${ts},v1=${expected}`);
  });
});
