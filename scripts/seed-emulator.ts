import { pathToFileURL } from 'node:url';
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import {
  CardSchema,
  UserSchema,
  buildSearchTokens,
  type Card,
  type User,
} from '@agent-kanban/shared';

export const SEED_USERS: readonly User[] = [
  UserSchema.parse({
    id: 'user-alex',
    workosUserId: null,
    email: 'alex@example.test',
    displayName: 'Alex Rivera',
    handle: 'alex',
    role: 'admin',
    createdAt: '2026-01-01T12:00:00.000Z',
  }),
  UserSchema.parse({
    id: 'user-sam',
    workosUserId: null,
    email: 'sam@example.test',
    displayName: 'Sam Rivera',
    handle: 'sam',
    role: 'member',
    createdAt: '2026-01-01T12:05:00.000Z',
  }),
];

function offsetIsoDays(base: Date, days: number): string {
  const target = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  return target.toISOString();
}

export function buildSeedCards(now: Date = new Date()): Card[] {
  const nowIso = now.toISOString();
  const yesterdayIso = offsetIsoDays(now, -1);
  const twoDaysAgoIso = offsetIsoDays(now, -2);
  const tomorrowIso = offsetIsoDays(now, 1);
  const inThreeDaysIso = offsetIsoDays(now, 3);
  const inSevenDaysIso = offsetIsoDays(now, 7);

  const rawCards: Card[] = [
    {
      id: 'card-seed-1',
      title: 'Schedule annual HVAC tune-up',
      description: 'Confirm spring maintenance window and check air filter dimensions beforehand.',
      status: 'todo',
      tags: ['home', 'maintenance'],
      assignedUserIds: ['user-alex'],
      awareUserIds: ['user-sam'],
      visibleToUserIds: ['user-alex', 'user-sam'],
      priorityScore: 90,
      priorityReason: 'Seasonal booking slots fill quickly and due soon',
      due: tomorrowIso,
      dueFirm: true,
      dueHasTime: false,
      recurrence: null,
      links: [],
      checklists: [
        {
          id: 'chk-seed-1',
          title: 'Prep Steps',
          items: [
            { id: 'chk-item-1', text: 'Measure return vent filter', checked: true },
            { id: 'chk-item-2', text: 'Call service desk for morning slot', checked: false },
          ],
        },
      ],
      archived: false,
      enteredStatusAt: twoDaysAgoIso,
      lastTouchedAt: yesterdayIso,
      createdBy: 'user-alex',
      createdAt: twoDaysAgoIso,
      updatedAt: yesterdayIso,
      searchTokens: ['schedule', 'annual', 'hvac', 'tune', 'up', 'filter', 'maintenance'],
      trelloUrl: null,
      trelloShortLink: null,
      dueSoonNotifiedAt: null,
      overdueNotifiedAt: null,
    },
    {
      id: 'card-seed-2',
      title: 'Weekly grocery restock',
      description: 'Standard pantry and produce run for the week.',
      status: 'todo',
      tags: ['groceries', 'errands'],
      assignedUserIds: ['user-sam'],
      awareUserIds: ['user-alex'],
      visibleToUserIds: ['user-sam', 'user-alex'],
      priorityScore: 75,
      priorityReason: 'Recurring weekly household staple',
      due: inThreeDaysIso,
      dueFirm: false,
      dueHasTime: false,
      recurrence: {
        type: 'cron',
        expression: '0 7 * * 6',
      },
      links: [],
      checklists: [
        {
          id: 'chk-seed-2',
          title: 'Shopping List',
          items: [
            { id: 'chk-item-3', text: 'Oats and milk', checked: false },
            { id: 'chk-item-4', text: 'Fresh vegetables', checked: false },
            { id: 'chk-item-5', text: 'Coffee beans', checked: false },
          ],
        },
      ],
      archived: false,
      enteredStatusAt: twoDaysAgoIso,
      lastTouchedAt: yesterdayIso,
      createdBy: 'user-sam',
      createdAt: twoDaysAgoIso,
      updatedAt: yesterdayIso,
      searchTokens: ['weekly', 'grocery', 'restock', 'pantry', 'produce', 'oats', 'coffee'],
      trelloUrl: null,
      trelloShortLink: null,
      dueSoonNotifiedAt: null,
      overdueNotifiedAt: null,
    },
    {
      id: 'card-seed-3',
      title: 'Organize garage tool shelf',
      description: 'Sort spare fasteners and label storage bins.',
      status: 'todo',
      tags: ['home'],
      assignedUserIds: ['user-alex'],
      awareUserIds: [],
      visibleToUserIds: ['user-alex'],
      priorityScore: null,
      priorityReason: null,
      due: null,
      dueFirm: false,
      dueHasTime: false,
      recurrence: null,
      links: [],
      checklists: [],
      archived: false,
      enteredStatusAt: yesterdayIso,
      lastTouchedAt: yesterdayIso,
      createdBy: 'user-alex',
      createdAt: yesterdayIso,
      updatedAt: yesterdayIso,
      searchTokens: ['organize', 'garage', 'tool', 'shelf', 'fasteners', 'bins'],
      trelloUrl: null,
      trelloShortLink: null,
      dueSoonNotifiedAt: null,
      overdueNotifiedAt: null,
    },
    {
      id: 'card-seed-4',
      title: 'Compare auto insurance renewal quotes',
      description: 'Review coverage limits and deductible options before policy renewal.',
      status: 'doing',
      tags: ['finance'],
      assignedUserIds: ['user-alex', 'user-sam'],
      awareUserIds: [],
      visibleToUserIds: ['user-alex', 'user-sam'],
      priorityScore: 85,
      priorityReason: 'Renewal deadline approaching next week',
      due: inSevenDaysIso,
      dueFirm: true,
      dueHasTime: false,
      recurrence: null,
      links: [
        {
          id: 'lnk-seed-1',
          url: 'https://example.com/insurance-checklist',
          label: 'Coverage comparison checklist',
          createdAt: yesterdayIso,
        },
      ],
      checklists: [],
      archived: false,
      enteredStatusAt: yesterdayIso,
      lastTouchedAt: nowIso,
      createdBy: 'user-alex',
      createdAt: twoDaysAgoIso,
      updatedAt: nowIso,
      searchTokens: ['compare', 'auto', 'insurance', 'renewal', 'quotes', 'coverage'],
      trelloUrl: null,
      trelloShortLink: null,
      dueSoonNotifiedAt: null,
      overdueNotifiedAt: null,
    },
    {
      id: 'card-seed-5',
      title: 'Replace porch light fixture',
      description: 'Waiting on replacement mounting bracket to arrive by mail.',
      status: 'blocked',
      tags: ['home', 'maintenance'],
      assignedUserIds: ['user-sam'],
      awareUserIds: ['user-alex'],
      visibleToUserIds: ['user-sam', 'user-alex'],
      priorityScore: 60,
      priorityReason: 'Blocked pending delivery of mounting hardware',
      due: null,
      dueFirm: false,
      dueHasTime: false,
      recurrence: null,
      links: [],
      checklists: [],
      archived: false,
      enteredStatusAt: yesterdayIso,
      lastTouchedAt: yesterdayIso,
      createdBy: 'user-sam',
      createdAt: twoDaysAgoIso,
      updatedAt: yesterdayIso,
      searchTokens: ['replace', 'porch', 'light', 'fixture', 'mounting', 'bracket'],
      trelloUrl: null,
      trelloShortLink: null,
      dueSoonNotifiedAt: null,
      overdueNotifiedAt: null,
    },
    {
      id: 'card-seed-6',
      title: 'Return library books',
      description: 'Drop off borrowed books at the main branch return box.',
      status: 'done',
      tags: ['errands'],
      assignedUserIds: ['user-alex'],
      awareUserIds: ['user-sam'],
      visibleToUserIds: ['user-alex', 'user-sam'],
      priorityScore: 50,
      priorityReason: 'Completed before due date',
      due: yesterdayIso,
      dueFirm: false,
      dueHasTime: false,
      recurrence: null,
      links: [],
      checklists: [],
      archived: false,
      enteredStatusAt: nowIso,
      lastTouchedAt: nowIso,
      createdBy: 'user-alex',
      createdAt: twoDaysAgoIso,
      updatedAt: nowIso,
      searchTokens: ['return', 'library', 'books', 'branch'],
      trelloUrl: null,
      trelloShortLink: null,
      dueSoonNotifiedAt: null,
      overdueNotifiedAt: null,
    },
  ];

  return rawCards.map((card) =>
    CardSchema.parse({
      ...card,
      searchTokens: buildSearchTokens({
        title: card.title,
        description: card.description,
        checklists: card.checklists,
      }),
    }),
  );
}

export interface SeedResult {
  usersSeeded: number;
  cardsSeeded: number;
}

export async function seedEmulator(db: Firestore, now: Date = new Date()): Promise<SeedResult> {
  for (const seedUser of SEED_USERS) {
    const userRef = db.collection('users').doc(seedUser.id);
    const existing = await userRef.get();
    if (existing.exists) {
      const existingData = existing.data() ?? {};
      const merged = UserSchema.parse({
        ...seedUser,
        workosUserId:
          typeof existingData.workosUserId === 'string' && existingData.workosUserId.length > 0
            ? existingData.workosUserId
            : null,
        createdAt:
          typeof existingData.createdAt === 'string' && existingData.createdAt.length > 0
            ? existingData.createdAt
            : seedUser.createdAt,
      });
      await userRef.set(merged);
    } else {
      await userRef.set(seedUser);
    }
  }

  const cards = buildSeedCards(now);
  for (const card of cards) {
    await db.collection('cards').doc(card.id).set(card);
  }

  return {
    usersSeeded: SEED_USERS.length,
    cardsSeeded: cards.length,
  };
}

function getEmulatorFirestore(): Firestore {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST?.trim() || '127.0.0.1:8080';
  process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;

  const projectId = process.env.GCLOUD_PROJECT?.trim() || 'demo-agent-kanban';
  const app = getApps().length > 0 ? getApp() : initializeApp({ projectId });
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

async function clearFirestoreEmulator(emulatorHost: string, projectId: string): Promise<void> {
  const url = `http://${emulatorHost}/emulator/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Failed to clear Firestore emulator at ${url}: HTTP ${res.status}`);
  }
}

async function main(): Promise<void> {
  const shouldReset = process.argv.includes('--reset');
  const db = getEmulatorFirestore();
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const projectId = process.env.GCLOUD_PROJECT?.trim() || 'demo-agent-kanban';

  if (shouldReset) {
    await clearFirestoreEmulator(emulatorHost, projectId);
  }

  const result = await seedEmulator(db);
  console.log(
    `Seeded Firestore emulator (${emulatorHost}${shouldReset ? ', reset' : ''}): ${result.usersSeeded} users, ${result.cardsSeeded} cards.`,
  );
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error('Failed to seed emulator:', error);
    process.exitCode = 1;
  });
}
