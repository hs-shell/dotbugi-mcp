import { normalizeLmsDate } from '@dotbugi/lms-parser';
import { LMS_FILE_PATH_PREFIX, LMS_ORIGIN } from '../constants.js';
import { clean } from '../tasks/text.js';
import { toIsoDeadline } from '../tasks/time.js';
import { htmlToMarkdown } from './markdown.js';

// 제출 상황 표의 마감 행 머리글 (ko / en)
const DUE_DATE_LABELS = ['종료 일시', 'Due date'];

export interface AssignPage {
  title: string;
  status: { label: string; value: string }[];
  deadline: string | null;
  body: string;
  attachmentUrls: URL[];
  // 교수자(채점) 화면 — 이 과목에서 교수자 권한이라 내 제출 상황 대신 채점 요약이 나온다
  gradingView: boolean;
  // 과제가 속한 과목 번호 (못 찾으면 null)
  courseId: string | null;
}

// Moodle 이 body 에 다는 course-<id> 클래스, 없으면 이동 경로(breadcrumb)의 강좌 링크
function courseIdOf(doc: Document): string | null {
  const fromBody = /(?:^|\s)course-(\d{1,10})(?:\s|$)/.exec(doc.body?.className ?? '')?.[1];
  if (fromBody) return fromBody;
  const link = doc.querySelector('.breadcrumb a[href*="/course/view.php?id="]')?.getAttribute('href') ?? '';
  return /[?&]id=(\d{1,10})(?:&|$)/.exec(link)?.[1] ?? null;
}

// 세션 쿠키를 붙여 받을 수 있는 건 LMS 출처의 pluginfile 뿐이다 (다른 주소는 본문 링크로만 남는다)
export function isLmsFileUrl(url: URL): boolean {
  return url.origin === LMS_ORIGIN && !url.username && !url.password && url.pathname.startsWith(LMS_FILE_PATH_PREFIX);
}

function attachmentUrls(intro: Element): URL[] {
  const urls = new Map<string, URL>();
  for (const a of intro.querySelectorAll('a[href]')) {
    const url = URL.parse(a.getAttribute('href') ?? '', LMS_ORIGIN);
    // 같은 파일에 ?forcedownload=1 등만 다른 링크가 여럿 걸려도 한 번만 받는다
    if (url && isLmsFileUrl(url) && !urls.has(url.origin + url.pathname)) urls.set(url.origin + url.pathname, url);
  }
  return [...urls.values()];
}

// Moodle 3.2 과제 화면: 본문·첨부는 #intro, 제출 상황은 .submissionstatustable 의 "머리글 | 값" 행
export function parseAssignPage(doc: Document): AssignPage {
  const main = doc.querySelector('[role="main"]') ?? doc.body;
  const title = clean(main.querySelector('h2')?.textContent ?? '');
  if (!title)
    throw new Error('과제 화면을 읽지 못했습니다. cmid 가 과제(mod/assign/view.php?id=…)의 id 인지 확인하세요.');
  const status = Array.from(main.querySelectorAll('.submissionstatustable tr')).flatMap((row) => {
    const cells = row.querySelectorAll('th, td');
    if (cells.length < 2) return [];
    return [{ label: clean(cells[0].textContent ?? ''), value: clean(cells[cells.length - 1].textContent ?? '') }];
  });
  // 채점 요약 표에도 같은 머리글의 마감 행이 있다 (내 제출 상황이 아니라 status 에는 넣지 않는다)
  const grading = Array.from(main.querySelectorAll('.gradingsummarytable tr')).map((row) => {
    const cells = row.querySelectorAll('th, td');
    return { label: clean(cells[0]?.textContent ?? ''), value: clean(cells[cells.length - 1]?.textContent ?? '') };
  });
  const due = [...status, ...grading].find((s) => DUE_DATE_LABELS.includes(s.label))?.value ?? null;
  const intro = main.querySelector('#intro');
  return {
    title,
    status,
    deadline: toIsoDeadline(normalizeLmsDate(due)),
    body: intro ? htmlToMarkdown(intro) : '',
    attachmentUrls: intro ? attachmentUrls(intro) : [],
    gradingView: !status.length && grading.length > 0,
    courseId: courseIdOf(doc),
  };
}
