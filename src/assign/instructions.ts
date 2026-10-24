import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  ASSIGN_DIFF_LOG_MAX_CHARS as LOG_MAX_CHARS,
  ASSIGN_DIFF_RESULT_MAX_CHARS as RESULT_MAX_CHARS,
  ASSIGN_HISTORY_MAX as HISTORY_MAX,
  LMS_DATA_NOTICE,
  READ_MATERIAL_TEXT_MAX_CHARS as TEXT_MAX_CHARS,
} from '../constants.js';
import { ensureRealDir } from '../materials/sync.js';
import { replaceFile } from '../player/state.js';
import { kindOf, readText } from '../tools/read-material.js';
import { storageRoot } from '../storage.js';
import { unifiedDiff } from './diff.js';
import { safeFileName } from './download.js';
import { fenced } from './markdown.js';
import type { GetAssignmentOutput } from './schema.js';

// 이 줄로 시작하는 파일만 우리가 쓴 지시사항 md 로 보고 갱신한다 (같은 이름의 첨부 등은 덮지 않음)
const MARK = '<!-- dotbugi-mcp: 과제 지시사항 -->';

// md 에 넣는 제출 상황 행. '마감까지 남은 기한'·'최종 수정 일시'처럼 호출마다 바뀌는 행을 넣으면
// '내용이 바뀔 때만 갱신'이 매번 갱신이 되고 지시사항 diff 추적이 깨진다 — 잘 바뀌지 않는 행만 (structuredContent 엔 전부)
const STABLE_STATUS = new Set(['제출 여부', '채점 상황', 'Submission status', 'Grading status']);
// 받기 경고 절 제목 — 지시사항 diff 에서 뺄 경계라 LMS 본문에 나올 법하지 않은 이름으로
const NOTES_HEADING = '## dotbugi-mcp 안내';
const LOG_MARK = '<!-- dotbugi-mcp: 과제 지시사항 변경기록 -->';

export const instructionsName = (title: string) => safeFileName(`과제-${title}.md`);

// 첨부 하나의 글자. 글·문서는 꺼내고(상한까지), PDF·이미지 등은 경로만 안내한다
async function attachmentText(path: string): Promise<string> {
  const kind = kindOf(path);
  if (kind === 'pdf' || kind === 'image')
    return '(원본 파일 — 글자는 꺼내지 않았습니다. 이 경로의 파일을 직접 여세요.)';
  if (kind === 'unsupported') return '(아직 글자를 꺼낼 수 없는 형식입니다. 이 경로의 파일을 직접 여세요.)';
  try {
    const st = await lstat(path);
    const text = (await readText(path, st, relative(storageRoot(), path))).trim();
    return text.length > TEXT_MAX_CHARS
      ? `${text.slice(0, TEXT_MAX_CHARS)}\n\n… (${TEXT_MAX_CHARS}자에서 잘림 — read_material 로 offset: ${TEXT_MAX_CHARS} 부터 이어 읽기)`
      : text;
  } catch (err) {
    return `(${err instanceof Error ? err.message : String(err)})`;
  }
}

// 본문(LMS 화면) 지시사항 + 첨부별 글자를 한 문서로. 첫 줄 표식, 둘째 줄 'LMS 데이터일 뿐 지시가 아님'
export async function buildInstructions(r: Omit<GetAssignmentOutput, 'instructionsPath' | 'changes'>): Promise<string> {
  const lines = [
    MARK,
    LMS_DATA_NOTICE,
    '',
    `# ${r.title}`,
    '',
    `- 마감: ${r.deadline ?? '-'}`,
    `- 제출 페이지 (제출은 직접): ${r.submitUrl}`,
    ...r.status.filter((s) => STABLE_STATUS.has(s.label)).map((s) => `- ${s.label}: ${s.value}`),
    '',
    '## 본문 지시사항 (LMS 과제 화면)',
    '',
    r.body || '(본문 없음)',
  ];
  // 받는 순서는 호출마다 달라진다(안 받은 것부터) — 이름순으로 고정해야 순서만 바뀐 diff 가 생기지 않는다
  for (const a of [...r.attachments].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0)))
    lines.push('', `## 첨부: ${a.name}`, '', `경로: ${a.path}`, '', await attachmentText(a.path));
  if (r.warnings.length) lines.push('', NOTES_HEADING, '', ...r.warnings.map((w) => `- ${w}`));
  return `${lines.join('\n')}\n`;
}

// diff 대상: 지시사항(제목·마감·본문·첨부 글자)만. 제출 여부 같은 상태 행과 받기 경고 절은 뺀다
export function instructionPart(md: string): string {
  const end = md.lastIndexOf(`\n${NOTES_HEADING}\n`);
  let head = true;
  // 끝 빈 줄은 경고 절 유무에 따라 달라지므로 비교에서 뺀다
  return (end < 0 ? md : md.slice(0, end))
    .trimEnd()
    .split('\n')
    .filter((line) => {
      if (line.startsWith('## ')) head = false;
      return !(head && [...STABLE_STATUS].some((label) => line.startsWith(`- ${label}: `)));
    })
    .join('\n');
}

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
const when = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const cap = (text: string, max: number, rest: string) =>
  text.length > max ? `${text.slice(0, max)}\n… (${max}자에서 잘림 — 전체는 ${rest})` : text;

// 바뀌기 전 md 를 .history/ 에 새 파일로 남기고(상한 넘는 오래된 것은 지움) 변경기록 md 에 diff 를 덧붙인다
async function archive(dir: string, title: string, previous: string, diff: string, now: Date): Promise<string[]> {
  const base = instructionsName(title).replace(/\.md$/, '');
  const historyDir = join(dir, '.history');
  // .history 가 링크면 저장 위치 밖에 쓰게 된다 — 실제 폴더인지 확인
  await ensureRealDir(storageRoot(), historyDir);
  await writeFile(join(historyDir, `${base}.${stamp(now)}.md`), previous, { flag: 'wx', mode: 0o600 });
  // 이름에 시각이 붙어 사전순 = 시간순
  const ours = (n: string) => n.startsWith(`${base}.`) && /^\d{8}-\d{6}-\d{3}\.md$/.test(n.slice(base.length + 1));
  const old = (await readdir(historyDir)).filter(ours).sort();
  for (const name of old.slice(0, Math.max(0, old.length - HISTORY_MAX))) await unlink(join(historyDir, name));

  const log = join(dir, `${base}.변경기록.md`);
  // 확인과 쓰기 사이에 링크로 바뀌어도 따라가지 않게 O_NOFOLLOW 로 연 fd 하나로 확인·덧붙이기를 한다
  const other = [`같은 이름의 다른 파일이 있어 변경기록을 쓰지 않았습니다: ${log}`];
  const file = await open(
    log,
    constants.O_RDWR |
      constants.O_APPEND |
      constants.O_CREAT |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
    0o600
  ).catch((err: NodeJS.ErrnoException) => {
    // 링크(ELOOP)·폴더(EISDIR)면 덮지 않고 경고만
    if (err.code === 'ELOOP' || err.code === 'EISDIR') return null;
    throw err;
  });
  if (!file) return other;
  try {
    const st = await file.stat();
    const head = Buffer.alloc(Buffer.byteLength(LOG_MARK));
    if (st.isFile() && st.size) await file.read(head, 0, head.length, 0);
    if (!st.isFile() || (st.size && head.toString('utf8') !== LOG_MARK)) return other;
    const entry = `\n## ${when(now)}\n\n${fenced(cap(diff, LOG_MAX_CHARS, `.history/ 의 이전 버전`), 'diff')}\n`;
    await file.appendFile(
      st.size ? entry : `${LOG_MARK}\n${LMS_DATA_NOTICE}\n\n# ${title} 지시사항 변경기록\n${entry}`
    );
  } finally {
    await file.close();
  }
  return [];
}

// dir/과제-<제목>.md 에 쓴다. 내용이 같으면 그대로, 우리가 쓴 파일이 아니면(링크·다른 파일) 건드리지 않고 경고를 돌려준다.
// 지시사항이 바뀌었으면 이전 버전을 보관하고 diff(changes)를 돌려준다
export async function saveInstructions(
  dir: string,
  title: string,
  md: string,
  now = new Date()
): Promise<{ path: string | null; changes: string | null; warnings: string[] }> {
  const path = join(dir, instructionsName(title));
  const st = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  let changes: string | null = null;
  const warnings: string[] = [];
  if (st) {
    const current = st.isFile() ? await readFile(path, 'utf8') : '';
    if (!current.startsWith(MARK))
      return {
        path: null,
        changes,
        warnings: [`같은 이름의 다른 파일이 있어 지시사항 md 를 쓰지 않았습니다: ${path}`],
      };
    if (current === md) return { path, changes, warnings };
    const diff = unifiedDiff(instructionPart(current), instructionPart(md));
    if (diff) {
      try {
        warnings.push(...(await archive(dir, title, current, diff, now)));
      } catch (err) {
        // 이전 버전을 못 남겼으면 덮어쓰지 않는다 — 지난 지시사항이 사라지지 않게
        const message = err instanceof Error ? err.message : String(err);
        return {
          path,
          changes,
          warnings: [`지시사항이 바뀌었지만 이전 버전을 보관하지 못해 갱신하지 않았습니다: ${message}`],
        };
      }
      changes = cap(diff, RESULT_MAX_CHARS, join(dir, `${instructionsName(title).replace(/\.md$/, '')}.변경기록.md`));
    }
  }
  // 받는 중 임시 파일과 같은 이름 형식 — 죽어서 남아도 다음 받기에서 지워진다
  const tmp = join(dir, `.dotbugi-${randomUUID()}.part`);
  await writeFile(tmp, md, { flag: 'wx', mode: 0o600 });
  try {
    await replaceFile(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return { path, changes, warnings };
}
