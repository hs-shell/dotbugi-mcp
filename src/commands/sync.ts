import { createInterface } from 'node:readline/promises';
import { log } from '../log.js';
import { resolveRemoved, syncMaterials, withSyncLock, type RemovedFile } from '../materials/sync.js';
import { getSession } from '../session.js';

const LABELS = { added: '추가', updated: '갱신', unchanged: '변경 없음' } as const;

// LMS 에서 사라진 파일을 하나씩 묻는다. 기본은 유지(N). ask 가 없으면(TTY 아님) 묻지도 기록하지도 않고 그대로 둔다
export async function confirmRemovals(removed: RemovedFile[], ask?: (question: string) => Promise<string>) {
  if (removed.length === 0) return;
  if (!ask)
    return log(
      `LMS 에서 사라진 파일 ${removed.length}개는 그대로 둡니다 (터미널에서 실행하면 하나씩 삭제 여부를 묻습니다).`
    );
  for (const item of removed) {
    log(`\nLMS 에서 삭제된 파일: ${item.path}`);
    if (item.locallyModified) log('⚠ 받은 뒤 수정된 파일입니다. 삭제하면 수정한 내용도 사라집니다.');
    const answer = (await ask('삭제할까요? [y/N] ')).trim().toLowerCase();
    const remove = answer === 'y' || answer === 'yes';
    const deleted = await resolveRemoved(item, remove);
    if (!remove) log('남겨 둡니다 (다시 묻지 않습니다).');
    else log(deleted ? '삭제했습니다.' : '확인한 뒤 파일이 바뀌었거나 옮겨져 지우지 않았습니다.');
  }
}

export async function sync(): Promise<void> {
  const { session } = await getSession();
  // 삭제 확인까지 잠금 안에서 — 그사이 MCP 도구가 같은 기록을 바꾸지 않게
  await withSyncLock(async () => {
    const result = await syncMaterials(session);
    for (const w of result.warnings) log(w);
    for (const f of result.files) if (f.status !== 'unchanged') log(`[${LABELS[f.status]}] ${f.path}`);
    const count = (s: keyof typeof LABELS) => result.files.filter((f) => f.status === s).length;
    log(
      `저장 폴더: ${result.root} — 추가 ${count('added')} · 갱신 ${count('updated')} · 변경 없음 ${count('unchanged')}`
    );
    if (!process.stdin.isTTY) return confirmRemovals(result.removed);
    // 질문은 stderr 로 — stdout 은 다른 명령과 같이 비워 둔다
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      await confirmRemovals(result.removed, (q) => rl.question(q));
    } finally {
      rl.close();
    }
  });
}
