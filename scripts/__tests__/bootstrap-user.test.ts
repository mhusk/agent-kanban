import { describe, expect, it } from 'vitest';
import { parseBootstrapArgs } from '../bootstrap-user.js';

describe('bootstrap-user CLI argument parser', () => {
  it('parses CLI flags and normalizes email and @handle', () => {
    const parsed = parseBootstrapArgs(
      [
        '--email',
        'Alex@Example.Test',
        '--display-name',
        'Alex Rivera',
        '--handle',
        '@Alex',
        '--role',
        'admin',
        '--project',
        'demo-agent-kanban',
        '--upsert',
      ],
      {},
    );

    expect(parsed).toEqual({
      email: 'alex@example.test',
      displayName: 'Alex Rivera',
      handle: 'alex',
      role: 'admin',
      id: undefined,
      projectId: 'demo-agent-kanban',
      upsert: true,
      help: false,
    });
  });

  it('falls back to environment variables and defaults role to member', () => {
    const parsed = parseBootstrapArgs([], {
      BOOTSTRAP_USER_EMAIL: 'sam@example.test',
      BOOTSTRAP_USER_DISPLAY_NAME: 'Sam Rivera',
      BOOTSTRAP_USER_HANDLE: 'sam',
      FIREBASE_PROJECT_ID: 'demo-agent-kanban',
    });

    expect(parsed).toEqual({
      email: 'sam@example.test',
      displayName: 'Sam Rivera',
      handle: 'sam',
      role: 'member',
      id: undefined,
      projectId: 'demo-agent-kanban',
      upsert: false,
      help: false,
    });
  });

  it('supports --help without requiring user fields', () => {
    const parsed = parseBootstrapArgs(['--help'], {});
    expect(parsed.help).toBe(true);
  });

  it('throws on unknown flags or invalid email', () => {
    expect(() => parseBootstrapArgs(['--unknown', 'value'], {})).toThrow(/Unknown argument/);
    expect(() =>
      parseBootstrapArgs(
        ['--email', 'not-an-email', '--display-name', 'Alex', '--handle', 'alex'],
        {},
      ),
    ).toThrow();
  });
});
