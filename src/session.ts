import { SESSION_CACHE_TTL_MS, SESSION_PATTERN } from './constants.js';
import { getKeychain } from './keychain/index.js';
import { setSessionExpiredHandler } from './lms.js';

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

// getSession 이 읽은 세션을 SESSION_CACHE_TTL_MS 동안 기억한다 (WSL 은 키체인 읽기마다 PowerShell 을 띄워 몇 초 걸린다).
// 저장·삭제·세션 만료(SessionExpiredError) 때 비운다. 없음(null)·오류는 기억하지 않아 다른 프로세스(CLI)의 login 을 바로 읽는다.
// TTL 을 두는 이유: 다른 프로세스의 CLI logout(확장 방식은 서버 세션을 끊지 않는다)을 실행 중인 서버가 무기한 모르면 안 된다
let cached: { stored: StoredSession; at: number } | undefined;
// 읽는 도중 저장·삭제가 끼면 옛 값을 캐시에 넣지 않도록 세대를 센다
let generation = 0;

export function clearSessionCache(): void {
  cached = undefined;
  generation++;
}
setSessionExpiredHandler(clearSessionCache);

export async function saveSession(session: string, method: LoginMethod): Promise<void> {
  const stored: StoredSession = { session, savedAt: new Date().toISOString(), method };
  // 쓰기가 끝난 뒤(실패해도) 비운다 — 쓰는 도중 시작된 읽기가 옛 값을 캐시에 넣지 못한다
  try {
    await getKeychain().set(JSON.stringify(stored));
  } finally {
    clearSessionCache();
  }
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
  if (cached && Date.now() - cached.at < SESSION_CACHE_TTL_MS) return cached.stored;
  const gen = generation;
  const stored = await readSession();
  if (!stored) throw new Error('저장된 LMS 세션이 없습니다. login 도구를 호출하세요.');
  if (gen === generation) cached = { stored, at: Date.now() };
  return stored;
}

export async function deleteSession(): Promise<boolean> {
  try {
    return await getKeychain().delete();
  } finally {
    clearSessionCache();
  }
}
