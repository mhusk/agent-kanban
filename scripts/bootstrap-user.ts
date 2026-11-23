import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import {
  CreateUserInputSchema,
  UserSchema,
  type CreateUserInput,
  type User,
} from '@agent-kanban/shared';

export interface BootstrapUserArgs {
  email: string;
  displayName: string;
  handle: string;
  role: 'admin' | 'member';
  id?: string;
  projectId?: string;
  upsert: boolean;
  help: boolean;
}

const USAGE_TEXT = `Usage:
  pnpm exec tsx scripts/bootstrap-user.ts \\
    --email <email> \\
    --display-name <name> \\
    --handle <handle> \\
    [--role admin|member] \\
    [--id <userId>] \\
    [--project <firebaseProjectId>] \\
    [--upsert]

Environment variable fallbacks:
  BOOTSTRAP_USER_EMAIL, BOOTSTRAP_USER_DISPLAY_NAME, BOOTSTRAP_USER_HANDLE,
  BOOTSTRAP_USER_ROLE, BOOTSTRAP_USER_ID, FIREBASE_PROJECT_ID / GCLOUD_PROJECT

Example (emulator):
  FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pnpm exec tsx scripts/bootstrap-user.ts \\
    --email alex@example.test --display-name "Alex Rivera" --handle alex --role admin
`;

function readFlagValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for flag ${flag}`);
  }
  return value;
}

export function parseBootstrapArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): BootstrapUserArgs {
  let email = env.BOOTSTRAP_USER_EMAIL?.trim() ?? '';
  let displayName = env.BOOTSTRAP_USER_DISPLAY_NAME?.trim() ?? '';
  let handle = env.BOOTSTRAP_USER_HANDLE?.trim() ?? '';
  let roleRaw = env.BOOTSTRAP_USER_ROLE?.trim() ?? 'member';
  let id = env.BOOTSTRAP_USER_ID?.trim() || undefined;
  let projectId = env.FIREBASE_PROJECT_ID?.trim() || env.GCLOUD_PROJECT?.trim() || undefined;
  let upsert = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--email':
        email = readFlagValue(argv, i, arg);
        i += 1;
        break;
      case '--display-name':
      case '--name':
        displayName = readFlagValue(argv, i, arg);
        i += 1;
        break;
      case '--handle':
        handle = readFlagValue(argv, i, arg);
        i += 1;
        break;
      case '--role':
        roleRaw = readFlagValue(argv, i, arg);
        i += 1;
        break;
      case '--id':
        id = readFlagValue(argv, i, arg);
        i += 1;
        break;
      case '--project':
        projectId = readFlagValue(argv, i, arg);
        i += 1;
        break;
      case '--upsert':
        upsert = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (help) {
    return {
      email,
      displayName,
      handle,
      role: 'member',
      id,
      projectId,
      upsert,
      help: true,
    };
  }

  const parsed: CreateUserInput = CreateUserInputSchema.parse({
    email,
    displayName,
    handle,
    role: roleRaw,
  });

  return {
    email: parsed.email,
    displayName: parsed.displayName,
    handle: parsed.handle,
    role: parsed.role,
    id,
    projectId,
    upsert,
    help: false,
  };
}

export interface BootstrapUserResult {
  action: 'created' | 'updated' | 'unchanged';
  user: User;
}

export async function bootstrapUser(
  db: Firestore,
  args: Omit<BootstrapUserArgs, 'projectId' | 'help'>,
): Promise<BootstrapUserResult> {
  const usersRef = db.collection('users');
  const existingByEmail = await usersRef.where('email', '==', args.email).limit(1).get();
  const existingDoc = existingByEmail.docs[0];

  if (existingDoc) {
    const existingUser = UserSchema.parse({
      ...existingDoc.data(),
      id: existingDoc.id,
    });

    if (!args.upsert) {
      return { action: 'unchanged', user: existingUser };
    }

    if (existingUser.handle !== args.handle) {
      const handleConflict = await usersRef.where('handle', '==', args.handle).limit(1).get();
      if (!handleConflict.empty && handleConflict.docs[0]?.id !== existingUser.id) {
        throw new Error(`Handle "@${args.handle}" is already in use by another user`);
      }
    }

    const updatedUser = UserSchema.parse({
      ...existingUser,
      displayName: args.displayName,
      handle: args.handle,
      role: args.role,
    });

    await existingDoc.ref.set(updatedUser);
    return { action: 'updated', user: updatedUser };
  }

  const existingByHandle = await usersRef.where('handle', '==', args.handle).limit(1).get();
  if (!existingByHandle.empty) {
    throw new Error(`Handle "@${args.handle}" is already in use by another user`);
  }

  const userId = args.id ?? `user-${crypto.randomUUID()}`;
  const newUser = UserSchema.parse({
    id: userId,
    workosUserId: null,
    email: args.email,
    displayName: args.displayName,
    handle: args.handle,
    role: args.role,
    createdAt: new Date().toISOString(),
  });

  await usersRef.doc(userId).set(newUser);
  return { action: 'created', user: newUser };
}

function initTargetFirestore(projectId?: string): Firestore {
  const isEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST?.trim());
  const resolvedProjectId = projectId ?? (isEmulator ? 'demo-agent-kanban' : undefined);

  if (!isEmulator && !resolvedProjectId) {
    throw new Error(
      'Missing Firebase project ID. Provide --project <id> or set FIREBASE_PROJECT_ID (or set FIRESTORE_EMULATOR_HOST for local emulator).',
    );
  }

  const app =
    getApps().length > 0
      ? getApp()
      : initializeApp(resolvedProjectId ? { projectId: resolvedProjectId } : undefined);
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

async function main(): Promise<void> {
  const args = parseBootstrapArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE_TEXT);
    return;
  }

  const db = initTargetFirestore(args.projectId);
  const result = await bootstrapUser(db, args);
  console.log(
    `Bootstrap user ${result.action}: id=${result.user.id} email=${result.user.email} handle=@${result.user.handle} role=${result.user.role}`,
  );
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error('Bootstrap user failed:', error instanceof Error ? error.message : error);
    console.error('');
    console.error(USAGE_TEXT);
    process.exitCode = 1;
  });
}
