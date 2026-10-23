import { getKeychain } from './keychain/index.js';

export type LoginMethod = 'extension' | 'browser';

export interface StoredSession {
  session: string;
  savedAt: string;
  method: LoginMethod;
}

export async function saveSession(session: string, method: LoginMethod): Promise<void> {
  const stored: StoredSession = { session, savedAt: new Date().toISOString(), method };
  await getKeychain().set(JSON.stringify(stored));
}

// 저장된 세션이 없으면 null
export async function readSession(): Promise<StoredSession | null> {
  const raw = await getKeychain().get();
  return raw ? (JSON.parse(raw) as StoredSession) : null;
}

// 다른 기능(도구)이 쓰는 진입점 — 없으면 사용자가 할 일을 알려준다
export async function getSession(): Promise<StoredSession> {
  const stored = await readSession();
  if (!stored) throw new Error('저장된 LMS 세션이 없습니다. 터미널에서 dotbugi-mcp login 을 실행하세요.');
  return stored;
}

export async function deleteSession(): Promise<boolean> {
  return getKeychain().delete();
}
