import { randomUUID } from 'node:crypto';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { LMS_DATA_NOTICE, READ_MATERIAL_TEXT_MAX_CHARS as TEXT_MAX_CHARS } from '../constants.js';
import { replaceFile } from '../player/state.js';
import { kindOf, readText } from '../tools/read-material.js';
import { storageRoot } from '../storage.js';
import { safeFileName } from './download.js';
import type { GetAssignmentOutput } from './schema.js';

// 이 줄로 시작하는 파일만 우리가 쓴 지시사항 md 로 보고 갱신한다 (같은 이름의 첨부 등은 덮지 않음)
const MARK = '<!-- dotbugi-mcp: 과제 지시사항 -->';

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
export async function buildInstructions(r: Omit<GetAssignmentOutput, 'instructionsPath'>): Promise<string> {
  const lines = [
    MARK,
    LMS_DATA_NOTICE,
    '',
    `# ${r.title}`,
    '',
    `- 마감: ${r.deadline ?? '-'}`,
    `- 제출 페이지 (제출은 직접): ${r.submitUrl}`,
    ...r.status.map((s) => `- ${s.label}: ${s.value}`),
    '',
    '## 본문 지시사항 (LMS 과제 화면)',
    '',
    r.body || '(본문 없음)',
  ];
  for (const a of r.attachments)
    lines.push('', `## 첨부: ${a.name}`, '', `경로: ${a.path}`, '', await attachmentText(a.path));
  if (r.warnings.length) lines.push('', '## 안내', '', ...r.warnings.map((w) => `- ${w}`));
  return `${lines.join('\n')}\n`;
}

// dir/과제-<제목>.md 에 쓴다. 내용이 같으면 그대로, 우리가 쓴 파일이 아니면(링크·다른 파일) 건드리지 않고 경고를 돌려준다
export async function saveInstructions(
  dir: string,
  title: string,
  md: string
): Promise<{ path: string | null; warning?: string }> {
  const path = join(dir, instructionsName(title));
  const st = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (st) {
    const current = st.isFile() ? await readFile(path, 'utf8') : '';
    if (!current.startsWith(MARK))
      return { path: null, warning: `같은 이름의 다른 파일이 있어 지시사항 md 를 쓰지 않았습니다: ${path}` };
    if (current === md) return { path };
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
  return { path };
}
