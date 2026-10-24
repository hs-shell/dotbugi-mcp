// 실제 과제 화면(Report #1 관계대수)을 줄인 것. 제출자 학번·이름과 LMS 내부 번호(제출물·과제 id 등)는 가짜 값으로 바꿨다.
// 본문 안 hwpEditorBoardContent 는 HTML 주석 속 JSON 이고, 화면과 다른 기한(3월23일)을 담고 있다 — 본문에 섞이면 안 된다
export const SUBMISSION_FILE =
  'https://learn.hansung.ac.kr/pluginfile.php?file=%2F900001%2Fassignsubmission_file%2Fsubmission_files%2F100001%2F%EA%B4%80%EA%B3%84%EB%8C%80%EC%88%98_B%EB%B0%98_2099999_%ED%99%8D%EA%B8%B8%EB%8F%99.docx&amp;forcedownload=1';

export const REPORT_PAGE = `<html><body><div id="region-main">
<span class="notifications" id="user-notifications"></span><div role="main"><span id="maincontent"></span><h2>Report #1</h2><div id="intro" class="box generalbox boxaligncenter"><div class="no-overflow"><p><!--[if !mso]>

<![endif]
--></p><p><span lang="EN-US">Report#1 </span>관계대수 </p><p><span lang="EN-US">1. </span>문제 <span lang="EN-US">:</span>교재 <span lang="EN-US">79~81</span>쪽 연습문제 <span lang="EN-US">11</span>번 문제를 푸시오<span lang="EN-US">.</span></p><p><span lang="EN-US">2. </span>제출기한 <span lang="EN-US">: 3</span>월<span lang="EN-US">28</span>일<span lang="EN-US">(</span>목<span lang="EN-US">) 23:55</span>까지<span lang="EN-US">(</span>기한 엄수<span lang="EN-US">)</span></p><p><span lang="EN-US">3. </span>제출방법 <span lang="EN-US">:</span></p><p><span lang="EN-US">    </span><span lang="EN-US">- </span>첨부파일로  <span lang="EN-US">e-class </span>과제란에 업로드 <span lang="EN-US">(.hwp </span>혹은 <span lang="EN-US">.docx)   </span></p><p><span lang="EN-US">    </span><span lang="EN-US">- </span>파일명은 관계대수<span lang="EN-US">_</span>분반<span lang="EN-US">_</span>학번<span lang="EN-US">_</span>이름<span lang="EN-US">.</span>확장자  </p><p><span lang="EN-US"></span><span lang="EN-US">&nbsp; &nbsp; (</span>예 <span lang="EN-US">: </span>관계대수<span lang="EN-US">_B</span>반<span lang="EN-US">_2099998_</span>김예시<span lang="EN-US">.hwp)</span></p><p><span lang="EN-US">   </span><span lang="EN-US">- </span>연산자 기호를 표시하기 어려우면 손으로 작성하여 사진을 찍어 파일에 캡쳐해서 제출해도 무방함<span lang="EN-US">.</span></p><div id="hwpEditorBoardContent" data-hjsonver="1.0" data-jsonlen="7526"><!--[data-hwpjson]{
"documentPr": {
"di": "",
"dp": { "dn": "test.hwp", "an": "Hancom Office Hangul" }
},
"ro": {
"01DA775565C5374000000013": {
"ru": [ { "ch": [ { "t": "2. 제출기한 : 3월23일(목) 23:55까지(기한 엄수)" } ] } ]
}
}
}--></div><br><p></p></div></div><div class="submissionstatustable"><h3>제출 상황</h3><div class="box boxaligncenter submissionsummarytable"><table class="generaltable table table-bordered">
<tbody><tr class="">
<td class="cell c0" style="">제출 여부</td>
<td class="submissionstatussubmitted cell c1 lastcol" style="">제출 완료</td>
</tr>
<tr class="">
<td class="cell c0" style="">채점 상황</td>
<td class="submissionnotgraded cell c1 lastcol" style="">채점되지 않음</td>
</tr>
<tr class="">
<td class="cell c0" style="">종료 일시</td>
<td class="cell c1 lastcol" style="">2024-03-28 23:55</td>
</tr>
<tr class="">
<td class="cell c0" style="">첨부파일</td>
<td class="cell c1 lastcol" style=""><div class="box boxaligncenter plugincontentsummary summary_assignsubmission_file_100001"><div><img class="icon" alt="관계대수_B반_2099999_홍길동.docx" title="관계대수_B반_2099999_홍길동.docx" src="https://learn.hansung.ac.kr/theme/image.php?theme=coursemosv2&amp;component=core&amp;rev=1&amp;image=f%2Fdocument"> <a target="_blank" href="${SUBMISSION_FILE}">관계대수_B반_2099999_홍길동.docx</a> </div></div></td>
</tr>
</tbody>
</table>
</div><div class="box generalbox submissionaction submissionaction-best"><div class="singlebutton"><form method="get" action="https://learn.hansung.ac.kr/mod/assign/view.php"><div><input type="submit" value="제출한 과제 편집" class="btn btn-default form-submit"><input type="hidden" name="id" value="5"><input type="hidden" name="action" value="editsubmission"></div></form></div></div></div></div>
</div></body></html>`;
