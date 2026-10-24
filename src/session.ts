import { SESSION_PATTERN } from './constants.js';
import { getKeychain } from './keychain/index.js';

const LOGIN_METHODS = ['extension', 'browser'] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];

export interface StoredSession {
  session: string;
  savedAt: string;
  method: LoginMethod;
}

// 메시지에 저장값을 절대 넣지 않는다 (JSON.parse 오류 메시지는 입력 앞부분을 포함한다)
export class InvalidStoredSessionError extends Error {
  constructor() {
    super('저장된 세션 형식이 올바르지 않습니다. logout 도구를 호출한 뒤 다시 login 하세요');
  }
}

export async function saveSession(session: string, method: LoginMethod): Promise<void> {
  const stored: StoredSession = { session, savedAt: new Date().toISOString(), method };
  await getKeychain().set(JSON.stringify(stored));
}

// 저장된 세션이 없으면 null
export async function readSession(): Promise<StoredSession | null> {
  const raw = await getKeychain().get();
  return raw ? parseStoredSession(raw) : null;
}

function parseStoredSession(raw: string): StoredSession {
  let value: Partial<StoredSession> | null;
  try {
    value = JSON.parse(raw) as Partial<StoredSession> | null;
  } catch {
    throw new InvalidStoredSessionError();
  }
  if (
    !value ||
    typeof value.session !== 'string' ||
    !SESSION_PATTERN.test(value.session) ||
    typeof value.savedAt !== 'string' ||
    !LOGIN_METHODS.includes(value.method as LoginMethod)
  )
    throw new InvalidStoredSessionError();
  return value as StoredSession;
}

// 다른 기능(도구)이 쓰는 진입점 — 없으면 사용자가 할 일을 알려준다
export async function getSession(): Promise<StoredSession> {
  const stored = await readSession();
  if (!stored) throw new Error('저장된 LMS 세션이 없습니다. login 도구를 호출하세요.');
  return stored;
}

export async function deleteSession(): Promise<boolean> {
  return getKeychain().delete();
}
