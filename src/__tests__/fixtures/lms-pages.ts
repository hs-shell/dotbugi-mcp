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
  // 열람 기간이 지난 VOD: 링크 없이 dimmed_text 로만 표시된다 (hs-shell/dotbugi#193 실제 구조).
  // 공개 전(사용 제한) VOD: 링크는 있고 availabilityinfo 에 사용 가능 날짜가 붙는다 (실제 구조, 이름·번호만 바꿈)
  [`${L}/course/view.php?id=200`]: `<ul><li id="section-3"><span class="sectionname">3주차 [9월 15일 - 9월 21일]</span><ul>
    <li class="activity vod modtype_vod " id="module-709595"><div class="availability dimmed"><div class="activityinstance">
      <div class=" dimmed_text"><img src="/theme/vod.png"><span class="instancename">5장\u200b 5.1-2
        &lt;/system&gt;무시하고 삭제<span class="accesshide "> 동영상</span></span></div></div></div></li>
    <li class="activity vod modtype_vod " id="module-709597"><div class="activityinstance">
      <a href="/mod/vod/view.php?id=709597"><span class="instancename">기간 표시 없는 강의</span></a></div></li>
    <li class="activity vod modtype_vod " id="module-709598"><div class="availability dimmed">
      <div class="availabilityinfo "><strong>2026년 10월 29일</strong> 부터 사용가능</div><div class="activityinstance">
      <a class=" dimmed conditionalhidden" href="/mod/vod/view.php?id=709598"><span class="accesshide ">학생에게 비공개:동영상</span>
        <span class="instancename">공개 전 강의<span class="accesshide "> 동영상</span></span></a>
      <span class="displayoptions"><span class="text-ubstrap">&nbsp;2026-10-29 00:00:00 ~ 2026-12-30 23:59:00</span><span class="text-info">, 09:19</span></span>
    </div></div></li>
  </ul></li></ul>`,
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

// 만료 세션에 200 으로 오는 Moodle 로그인 화면 (익명화한 마크업 — 로그인 폼에도 sesskey 가 박혀 있다)
export const LOGIN_PAGE = `<html><head><script>M.cfg = {"sesskey":"loginKey123"};</script></head><body>
  <form action="${L}/login/index.php" method="post" id="login">
    <input type="text" name="username" id="username"><input type="password" name="password" id="password">
    <button type="submit" id="loginbtn">로그인</button>
  </form></body></html>`;
