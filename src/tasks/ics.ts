import { createHash } from 'node:crypto';
import { LMS_ORIGIN } from '../constants.js';
import type { Task, TaskType } from './schema.js';
import { clean } from './text.js';
import { deadlineMs } from './time.js';

const TYPE_LABELS: Record<TaskType, string> = { vod: '동영상 강의', assign: '과제', quiz: '퀴즈' };
// 캘린더에는 마감 1시간 전부터 마감까지의 일정으로 넣는다 (마감 시각에 끝나는 블록이 앱마다 가장 눈에 띈다)
const EVENT_MS = 60 * 60_000;
const MAX_LINE_OCTETS = 75;
// toIsoDeadline 결과(오프셋 포함 ISO)만 받는다. Date.parse 는 오프셋 없는 문자열을 실행 환경 시간대로 읽어 시각이 틀어진다
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/;

// RFC 5545 3.3.11 TEXT 이스케이프. LMS 텍스트는 신뢰하지 않으므로 먼저 제어·서식 문자를 걷어낸다 (줄바꿈 주입 방지)
export const escapeText = (text: string) => clean(text).replace(/[\\;,]/g, (c) => `\\${c}`);

// RFC 5545 3.1: 한 줄 75옥텟 이하로 접는다. 한글(3바이트)이 잘리지 않게 코드 포인트 단위로 자르고, 이어지는 줄은 공백 하나로 시작
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (octets + size > MAX_LINE_OCTETS) {
      parts.push(current);
      current = ' ';
      octets = 1;
    }
    current += ch;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n');
}

// UTC 'Z' 형식 (VTIMEZONE 없이 모든 캘린더 앱이 같은 순간으로 읽는다)
const utc = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

// 다시 내보내도 같은 UID 여야 다시 가져올 때 일정이 중복되지 않는다
export function uidOf(t: Task): string {
  const id =
    t.cmid ??
    createHash('sha256')
      .update(t.url || `${t.course}\n${t.title}`)
      .digest('hex')
      .slice(0, 16);
  return `${t.type}-${id}@dotbugi-mcp`;
}

// LMS 출처 주소만 설명에 넣는다 (캘린더 앱이 링크로 보여 주므로 다른 주소를 흘리지 않게)
function lmsUrl(url: string): string | null {
  try {
    return new URL(url).origin === LMS_ORIGIN ? url : null;
  } catch {
    return null;
  }
}

// 마감을 해석할 수 없는(정보 없음·LMS 원문) 항목은 일정으로 만들 수 없어 건너뛰고 개수만 센다
export function buildIcs(tasks: Task[], now: number): { ics: string; count: number; skipped: number } {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//dotbugi-mcp//KO', 'CALSCALE:GREGORIAN'];
  let count = 0;
  for (const t of tasks) {
    const end = ISO_WITH_OFFSET.test(t.deadline ?? '') ? deadlineMs(t.deadline) : NaN;
    if (Number.isNaN(end)) continue;
    count++;
    const url = lmsUrl(t.url);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uidOf(t)}`,
      `DTSTAMP:${utc(now)}`,
      // Apple·Outlook 은 SEQUENCE·LAST-MODIFIED 가 더 크면 같은 UID 일정을 새 내용으로 바꾼다
      `LAST-MODIFIED:${utc(now)}`,
      `SEQUENCE:${Math.floor(now / 1000)}`,
      `DTSTART:${utc(end - EVENT_MS)}`,
      `DTEND:${utc(end)}`,
      `SUMMARY:${escapeText(`[${t.course}] ${t.title} (${TYPE_LABELS[t.type]})`)}`,
      ...(url ? [`DESCRIPTION:${escapeText(`LMS: ${url}`)}`] : []),
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return { ics: `${lines.map(foldLine).join('\r\n')}\r\n`, count, skipped: tasks.length - count };
}
