import { describe, expect, it } from 'vitest';
import {
  describeRecurrence,
  describeSmartLeadDays,
  formStateToRecurrence,
  recurrenceToFormState,
  recurrencesEqual,
} from '../lib/recurrenceUi.js';

describe('recurrenceUi helpers', () => {
  it('round-trips daily, weekly, monthly, interval, and custom cron schedules', () => {
    expect(recurrenceToFormState(null).mode).toBe('none');
    expect(describeRecurrence(null)).toBe('Does not repeat');

    const daily = formStateToRecurrence({
      ...recurrenceToFormState(null),
      mode: 'daily',
      time: '08:30',
    });
    expect(daily).toEqual({ type: 'cron', expression: '30 8 * * *' });
    expect(recurrenceToFormState(daily)).toMatchObject({ mode: 'daily', time: '08:30' });
    expect(describeRecurrence(daily)).toBe('Every day at 8:30 AM');

    const weekly = recurrenceToFormState({
      type: 'cron',
      expression: '0 7 * * 7,3,1',
      timezone: 'America/New_York',
    });
    expect(weekly).toMatchObject({
      mode: 'weekly',
      time: '07:00',
      weekdays: [0, 1, 3],
      timezone: 'America/New_York',
    });
    expect(describeRecurrence({ type: 'cron', expression: '0 7 * * 6' })).toBe(
      'Every Saturday at 7:00 AM',
    );
    expect(describeRecurrence({ type: 'cron', expression: '15 17 * * 1,3,5' })).toBe(
      'Every Mon, Wed, Fri at 5:15 PM',
    );

    const monthly = formStateToRecurrence({
      ...recurrenceToFormState(null),
      mode: 'monthly',
      dayOfMonth: 21,
      time: '12:00',
    });
    expect(monthly).toEqual({ type: 'cron', expression: '0 12 21 * *' });
    expect(describeRecurrence(monthly)).toBe('Monthly on the 21st at 12:00 PM');

    const interval = {
      type: 'interval_after_completion' as const,
      every: 1,
      unit: 'weeks' as const,
    };
    expect(recurrenceToFormState(interval)).toMatchObject({
      mode: 'interval_after_completion',
      intervalEvery: 1,
      intervalUnit: 'weeks',
    });
    expect(describeRecurrence(interval)).toBe('Every 1 week after completion');

    const exotic = { type: 'cron' as const, expression: '0 8 1 */3 *' };
    expect(recurrenceToFormState(exotic)).toMatchObject({
      mode: 'cron',
      cronExpression: '0 8 1 */3 *',
    });
    expect(describeRecurrence(exotic)).toBe('Custom schedule (0 8 1 */3 *)');
  });

  it('round-trips auto-hide and explicit lead days, and describes the smart default', () => {
    const base = recurrenceToFormState(null);
    expect(base.autoDefer).toBe(true);
    expect(base.leadDaysInput).toBe('');

    const weekly = formStateToRecurrence({
      ...base,
      mode: 'weekly',
      time: '09:00',
      weekdays: [1],
    });
    expect(weekly).toEqual({ type: 'cron', expression: '0 9 * * 1' });
    expect(describeSmartLeadDays(weekly)).toBe('Smart default: reappear 1 day before due');
    expect(describeSmartLeadDays({ type: 'cron', expression: '30 8 * * *' })).toBe(
      'Smart default: reappear on the due date',
    );
    expect(
      describeSmartLeadDays({ type: 'interval_after_completion', every: 30, unit: 'days' }),
    ).toBe('Smart default: reappear 3 days before due');

    const hidden = formStateToRecurrence({
      ...base,
      mode: 'weekly',
      time: '09:00',
      weekdays: [1],
      autoDefer: false,
      leadDaysInput: '2',
    });
    expect(hidden).toEqual({
      type: 'cron',
      expression: '0 9 * * 1',
      autoDefer: false,
      leadDays: 2,
    });
    expect(recurrenceToFormState(hidden)).toMatchObject({
      mode: 'weekly',
      autoDefer: false,
      leadDaysInput: '2',
    });
    expect(
      recurrencesEqual(
        { type: 'cron', expression: '0 9 * * 1' },
        { type: 'cron', expression: '0 9 * * 1', autoDefer: true },
      ),
    ).toBe(true);
    expect(recurrencesEqual(weekly, hidden)).toBe(false);
  });
});
