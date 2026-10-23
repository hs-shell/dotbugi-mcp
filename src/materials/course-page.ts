import type { FetchHtml } from '@dotbugi/lms-parser';
import { DOMParser } from 'linkedom';
import { isLmsFileUrl } from '../assign/page.js';
import { FOLDER_VIEW_PATH, LMS_ORIGIN, RESOURCE_VIEW_PATH } from '../constants.js';
import { limit } from '../lms-html.js';
import { lmsFetch } from '../lms.js';
import { clean } from '../tasks/text.js';

export interface CourseModule {
  cmid: number;
  type: 'resource' | 'folder';
  // 저장할 하위 폴더 이름 (정리 전, LMS 텍스트)
  week: string;
}

// "3주차 [9월 15일 - 9월 21일]" / "Week 3" → "3주차". 주차가 없는 섹션은 섹션명, 그것도 없으면 섹션 번호
export function weekName(sectionNumber: number, sectionName: string): string {
  const name = clean(sectionName);
  const m = /(\d+)\s*주차|week\s*(\d+)/i.exec(name);
  if (m) return `${Number(m[1] ?? m[2])}주차`;
  return name || `section-${sectionNumber}`;
}

// Moodle 3.2 강좌 화면: 섹션 li#section-N > .sectionname, 모듈 li#module-<cmid>.modtype_resource|folder
export function parseCoursePage(doc: Document): CourseModule[] {
  const sections = Array.from(doc.querySelectorAll('li[id^="section-"]'));
  // 섹션이 하나도 없으면 다른 화면을 받은 것이다 — 빈 목록으로 보면 받은 파일이 전부 '삭제됨'으로 보고된다
  if (sections.length === 0)
    throw new Error('강좌 화면에서 주차(섹션)를 찾지 못했습니다. LMS 화면 구조가 바뀌었을 수 있습니다.');
  return sections.flatMap((section) => {
    const week = weekName(
      Number(/^section-(\d+)$/.exec(section.id)?.[1] ?? 0),
      section.querySelector('.sectionname')?.textContent ?? ''
    );
    return Array.from(section.querySelectorAll('li.modtype_resource, li.modtype_folder')).flatMap(
      (li): CourseModule[] => {
        const cmid = /^module-(\d{1,10})$/.exec(li.id)?.[1];
        // 링크가 없으면 아직 열리지 않은(제한된) 자료다
        if (!cmid || !li.querySelector('a[href]')) return [];
        return [{ cmid: Number(cmid), type: li.classList.contains('modtype_folder') ? 'folder' : 'resource', week }];
      }
    );
  });
}

// 파일·폴더 모듈 본문 파일만 받는다 (설명란 첨부 등 다른 영역의 pluginfile 은 제외)
const MATERIAL_PATH = /^\/pluginfile\.php\/\d+\/mod_(resource|folder)\/content\//;
export const isMaterialUrl = (url: URL) => isLmsFileUrl(url) && MATERIAL_PATH.test(url.pathname);

// 화면 본문의 강의자료 pluginfile 링크 (쿼리는 버리고 경로만, 중복 없이)
export function fileLinks(doc: Document): URL[] {
  const main = doc.querySelector('[role="main"]') ?? doc.body;
  const urls = new Map<string, URL>();
  for (const a of main.querySelectorAll('a[href]')) {
    const url = URL.parse(a.getAttribute('href') ?? '', LMS_ORIGIN);
    if (url && isMaterialUrl(url)) urls.set(url.origin + url.pathname, new URL(url.origin + url.pathname));
  }
  return [...urls.values()];
}

// 파일 모듈 → 실제 파일 주소. lmsFetch 는 리다이렉트를 따라가지 않으므로 Location 을 직접 확인해 LMS pluginfile 일 때만 쓴다
export async function resourceFileUrl(cmid: number, session: string): Promise<URL> {
  return limit(async () => {
    const res = await lmsFetch(`${RESOURCE_VIEW_PATH}?id=${cmid}&redirect=1`, session);
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const url = URL.parse(res.headers.get('location') ?? '', LMS_ORIGIN);
      if (!url || !isMaterialUrl(url)) throw new Error('LMS 가 파일이 아닌 곳으로 이동시켰습니다.');
      return new URL(url.origin + url.pathname);
    }
    if (!res.ok) throw new Error(`LMS 응답 오류 HTTP ${res.status}`);
    // 표시 방식(삽입·팝업)에 따라 리다이렉트 대신 파일 링크가 든 화면이 온다
    const [url] = fileLinks(new DOMParser().parseFromString(await res.text(), 'text/html') as unknown as Document);
    if (!url) throw new Error('자료 화면에서 파일 링크를 찾지 못했습니다.');
    return url;
  });
}

export async function folderFileUrls(cmid: number, fetchHtml: FetchHtml): Promise<URL[]> {
  return fileLinks(await fetchHtml(`${FOLDER_VIEW_PATH}?id=${cmid}`));
}

// manifest 키: 같은 모듈 안 파일 경로 (/pluginfile.php/<ctx>/<component>/<area>/<리비전>/<경로…>). 리비전은 빼야 바뀐 파일을 같은 항목으로 본다
export function fileKey(cmid: number, url: URL): string {
  const parts = url.pathname.split('/');
  return `${cmid}:${parts.slice(6).join('/') || url.pathname}`;
}
