// 익명화한 최소 LMS 페이지 (@dotbugi/lms-parser 테스트 구조 기반). 기준 시각 NOW 에 맞춘 날짜를 쓴다
export const NOW = new Date('2026-10-24T12:00:00+09:00');
const L = 'https://learn.hansung.ac.kr';

const course = (id: string, title: string, extraClass = '') => `
  <li class="${extraClass}"><a class="course_link" href="${L}/course/view.php?id=${id}">
    <div class="course-title"><h3>${title}</h3><p>교수</p></div></a></li>`;

// 온라인 출석부(user_progress_a.php) 머리글 — 파서가 컬럼 위치를 머리글로 찾는다
const attendanceTable = (rows = '') => `<table class="user_progress_table"><thead><tr>
  <th>주차</th><th>강의 자료</th><th>출석인정 요구시간</th><th>총 학습시간</th><th>출석</th><th>주차 출석</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
const EMPTY_TABLE = '<table class="generaltable"><tbody></tbody></table>';

export const PAGES: Record<string, string> = {
  [`${L}/`]: `<ul class="my-course-lists">
    ${course('100', '[A반] 자료구조')}${course('200', '운영체제')}${course('300', '비교과 활동', 'course_label_ec')}
  </ul>`,
  [`${L}/course/view.php?id=100`]: `<ul><li id="section-8"><span class="sectionname">8주차</span><ul>
    <li class="modtype_vod"><div class="activityinstance">
      <a href="${L}/mod/vod/view.php?id=1"><span class="instancename">트리
        순회<span class="accesshide"> 동영상</span></span></a>
      <span class="text-ubstrap">2026-10-20 00:00:00 ~ 2026-10-27 23:59:59</span><span class="text-info">, 20:00</span>
    </div></li>
    <li class="modtype_vod"><div class="activityinstance">
      <a href="${L}/mod/vod/view.php?id=2"><span class="instancename">다음 주 강의</span></a>
      <span class="text-ubstrap">2026-10-28 00:00:00 ~ 2026-11-03 23:59:59</span>
    </div></li>
  </ul></li></ul>`,
  [`${L}/report/ubcompletion/user_progress.php?id=100`]: `<table class="user_progress"><tbody>
    <tr><td class="sectiontitle">8</td><td><img src="/theme/vod.png">트리
        순회</td><td>20:00</td><td>05:00</td></tr>
    <tr><td class="sectiontitle">8</td><td><img src="/theme/vod.png">다음 주 강의</td><td>20:00</td><td>00:00</td></tr>
  </tbody></table>`,
  [`${L}/report/ubcompletion/user_progress_a.php?id=100`]: attendanceTable(`
    <tr><td rowspan="2">8</td><td>트리
        순회</td><td>20:00</td><td>05:00</td><td>X</td><td rowspan="2">X</td></tr>
    <tr><td>다음 주 강의</td><td>20:00</td><td>00:00</td><td>X</td></tr>`),
  [`${L}/mod/assign/index.php?id=100`]: `<table class="generaltable"><tbody>
    <tr><td class="cell c0">8주차</td><td class="cell c1"><a href="/mod/assign/view.php?id=5">과제1</a></td>
      <td class="cell c2">2026-10-25 18:00</td><td class="cell c3">미제출</td></tr>
    <tr><td class="cell c0"></td><td class="cell c1"><a href="/mod/assign/view.php?id=6">과제2</a></td>
      <td class="cell c2">2026-10-30 23:59</td><td class="cell c3">제출 완료</td></tr>
    <tr><td class="cell c0"></td><td class="cell c1"><a href="/mod/assign/view.php?id=7">지난 과제</a></td>
      <td class="cell c2">2026-10-01 23:59</td><td class="cell c3">미제출</td></tr>
  </tbody></table>`,
  [`${L}/mod/quiz/index.php?id=100`]: `<table class="generaltable"><tbody>
    <tr><td class="cell c0">8주차</td><td class="cell c1"><a href="view.php?id=9">퀴즈1</a></td>
      <td class="cell c2">2026-10-26 09:00</td></tr>
  </tbody></table>`,
  [`${L}/mod/quiz/view.php?id=9`]: `<table class="quizattemptsummary"><tbody></tbody></table>`,
  [`${L}/course/view.php?id=200`]: '<ul></ul>',
  [`${L}/report/ubcompletion/user_progress_a.php?id=200`]: attendanceTable(),
  [`${L}/report/ubcompletion/user_progress.php?id=200`]: '<table class="user_progress"><tbody></tbody></table>',
  [`${L}/mod/quiz/index.php?id=200`]: EMPTY_TABLE,
  [`${L}/mod/assign/index.php?id=200`]: `<table class="generaltable"><tbody>
    <tr><td class="cell c0">1주차</td><td class="cell c1"><a href="/mod/assign/view.php?id=8">기한 없는 과제</a></td>
      <td class="cell c2">-</td><td class="cell c3">미제출</td></tr>
  </tbody></table>`,
};

// fetch 대역: 등록된 페이지는 200, 나머지는 404
export function fakeLmsFetch(input: RequestInfo | URL): Promise<Response> {
  const html = PAGES[String(input)];
  return Promise.resolve(
    html ? new Response(`<html><body>${html}</body></html>`) : new Response('not found', { status: 404 })
  );
}

export const LOGIN_REDIRECT = () => new Response(null, { status: 303, headers: { location: `${L}/login/index.php` } });
