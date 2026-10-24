# Changelog

## [0.4.0](https://github.com/hs-shell/dotbugi-mcp/compare/v0.3.0...v0.4.0) (2026-10-24)


### Features

* get_assignment 가 본문(DOM)·첨부 글자를 합친 과제 지시사항 md 저장 ([#114](https://github.com/hs-shell/dotbugi-mcp/issues/114)) ([83210b3](https://github.com/hs-shell/dotbugi-mcp/commit/83210b3aa51806f78af713c433a6969440a0cd2a))
* Google Drive 내 드라이브 감지와 다른 드라이브로 저장 위치 옮기기 ([#121](https://github.com/hs-shell/dotbugi-mcp/issues/121)) ([5d8ed37](https://github.com/hs-shell/dotbugi-mcp/commit/5d8ed37410beb42090e6e2646dc401f204689086))
* notes — 주차별 강의 노트 대상 확인·변경 감지·저장 ([#126](https://github.com/hs-shell/dotbugi-mcp/issues/126)) ([3a12908](https://github.com/hs-shell/dotbugi-mcp/commit/3a1290870c8ae4a38d141d2b2000a664938d078f))
* read_material 이 hwp·hwpx·docx·pptx·xlsx 글자를 읽기 ([#106](https://github.com/hs-shell/dotbugi-mcp/issues/106)) ([b09f10d](https://github.com/hs-shell/dotbugi-mcp/commit/b09f10d0b634855bc403a71e536a40cc9d0e8f65))
* summary — 노트 기반 핵심 요약 (대상 확인·변경 감지·노트 먼저 묻기) ([#128](https://github.com/hs-shell/dotbugi-mcp/issues/128)) ([6098ac0](https://github.com/hs-shell/dotbugi-mcp/commit/6098ac093f8e0b94d536ae733ce9da264b86632a))
* transcribe_vod 대상을 과목·전체로 지정하고 실행 전 확인 ([#117](https://github.com/hs-shell/dotbugi-mcp/issues/117)) ([8446335](https://github.com/hs-shell/dotbugi-mcp/commit/84463355f4c0fb8d3716e201fff3c78d86e34855))
* transcribe_vod 에 cmid 여러 개를 넘겨 대기열로 차례로 받아쓰기 ([#105](https://github.com/hs-shell/dotbugi-mcp/issues/105)) ([ffd2ca2](https://github.com/hs-shell/dotbugi-mcp/commit/ffd2ca20372b23cf45b9dd662e232f8be4020add))
* 과제 지시사항 변경을 diff 로 추적 ([#119](https://github.com/hs-shell/dotbugi-mcp/issues/119)) ([69f1ec2](https://github.com/hs-shell/dotbugi-mcp/commit/69f1ec2fdac080bbaf7d67b6d9324a7b10fa5f7d))
* 받아쓰기 진행률을 Claude Code 상태 표시줄에 표시 ([#111](https://github.com/hs-shell/dotbugi-mcp/issues/111)) ([228ea32](https://github.com/hs-shell/dotbugi-mcp/commit/228ea320f26938ac593b57586937bafd1e503d6d))
* 슬래시 명령 체계 개편 — status·pull·courses·assignment·transcribe·login·help ([#118](https://github.com/hs-shell/dotbugi-mcp/issues/118)) ([cb7bd4a](https://github.com/hs-shell/dotbugi-mcp/commit/cb7bd4adf062097075539f9b50c60ca2fa657900))
* 추적 과목을 체크박스 선택 창으로 켜기·끄기 ([#113](https://github.com/hs-shell/dotbugi-mcp/issues/113)) ([904a69d](https://github.com/hs-shell/dotbugi-mcp/commit/904a69d4f3d1e806bb029f1df9c1b719ef5ae433))


### Bug Fixes

* STT 대상 목록에서 dimmed·기간 표시 없는 동영상 강의가 빠지는 문제 ([#127](https://github.com/hs-shell/dotbugi-mcp/issues/127)) ([d2c4378](https://github.com/hs-shell/dotbugi-mcp/commit/d2c4378bb9085fbe1e1e8e1d1f3975e3e5f08449))
* 번호만 있는 주차 이름을 N주차 폴더로 정한다 ([#103](https://github.com/hs-shell/dotbugi-mcp/issues/103)) ([f7df42b](https://github.com/hs-shell/dotbugi-mcp/commit/f7df42bb08a03b677b67d233ecb5dbf33f8dc895))
* 슬래시 명령 선택 인자를 비우면 안내 문구가 깨지던 문제 ([#104](https://github.com/hs-shell/dotbugi-mcp/issues/104)) ([b7cfb8b](https://github.com/hs-shell/dotbugi-mcp/commit/b7cfb8b0f8198065a374346bbe3ee701b5f9be25))

## [0.3.0](https://github.com/hs-shell/dotbugi-mcp/compare/v0.2.0...v0.3.0) (2026-10-24)


### ⚠ BREAKING CHANGES

* play_vods·stop_vods·vod_status·setup_statusline 도구와 dotbugi-mcp play·statusline 명령이 사라진다. Claude Code 상태 표시줄에 dotbugi-mcp statusline 을 설정했다면 직접 지워야 한다.

### Features

* VOD 자동 재생 기능 삭제 ([#95](https://github.com/hs-shell/dotbugi-mcp/issues/95)) ([26a71d4](https://github.com/hs-shell/dotbugi-mcp/commit/26a71d459a8908018e3a3ee5a2930080d7b473f5)), closes [#94](https://github.com/hs-shell/dotbugi-mcp/issues/94)
* 슬래시 명령 바로가기 + VOD 재생 창을 viewer.php 로 ([#92](https://github.com/hs-shell/dotbugi-mcp/issues/92)) ([6d9c6f9](https://github.com/hs-shell/dotbugi-mcp/commit/6d9c6f9e450eb268e3790109d8e48306a1327ca6))

## [0.2.0](https://github.com/hs-shell/dotbugi-mcp/compare/v0.1.0...v0.2.0) (2026-10-24)


### Features

* asr install/status/remove — 로컬 Qwen3-ASR 런타임 관리 ([#21](https://github.com/hs-shell/dotbugi-mcp/issues/21)) ([049e221](https://github.com/hs-shell/dotbugi-mcp/commit/049e2213efb75af4425bc66ac2393bcc72f99a61))
* asr_install·asr_status MCP 도구 ([#51](https://github.com/hs-shell/dotbugi-mcp/issues/51)) ([db08e5e](https://github.com/hs-shell/dotbugi-mcp/commit/db08e5e82f2b8344f1341dc620616bbaed49093f))
* Claude Code 상태 표시줄과 vod_status 도구로 VOD 진행 상황 시각화 ([#12](https://github.com/hs-shell/dotbugi-mcp/issues/12)) ([911e17f](https://github.com/hs-shell/dotbugi-mcp/commit/911e17f98e53e1eda5cf3702facf6107ecb52279))
* courses — MCP 강좌 추적 켜기/끄기 ([#25](https://github.com/hs-shell/dotbugi-mcp/issues/25)) ([f6a81ad](https://github.com/hs-shell/dotbugi-mcp/commit/f6a81ad0ec6a431f4efbaa559a2fc118ceffdcb7))
* delete_materials·asr_remove — 사용자 승인 후 삭제 ([#53](https://github.com/hs-shell/dotbugi-mcp/issues/53)) ([f19029f](https://github.com/hs-shell/dotbugi-mcp/commit/f19029fae0fbcb7e8781a0f26bba32c9d61285ec))
* export_ics — 할 일을 캘린더 파일로 ([#77](https://github.com/hs-shell/dotbugi-mcp/issues/77)) ([b420664](https://github.com/hs-shell/dotbugi-mcp/commit/b420664777005ea250e67ef7b2ecaa5057478f88))
* get_assignment — 과제 본문·첨부파일 다운로드와 제출 페이지 안내 ([#11](https://github.com/hs-shell/dotbugi-mcp/issues/11)) ([0cdf2e4](https://github.com/hs-shell/dotbugi-mcp/commit/0cdf2e4b8bb27a64f0f026aab5282e53fef3a5fd))
* list_courses·set_course_tracking MCP 도구 ([#48](https://github.com/hs-shell/dotbugi-mcp/issues/48)) ([0111736](https://github.com/hs-shell/dotbugi-mcp/commit/011173601d526c6eec86dd6a9d1f33f956b5621a))
* list_tasks — 과제·퀴즈·VOD 상태와 마감 조회 ([#9](https://github.com/hs-shell/dotbugi-mcp/issues/9)) ([a9b9699](https://github.com/hs-shell/dotbugi-mcp/commit/a9b9699e5ed02e8b2f6698c67ceeb8071d69011b))
* list_tasks 에 cmid·includePast ([#67](https://github.com/hs-shell/dotbugi-mcp/issues/67)) ([3bad32c](https://github.com/hs-shell/dotbugi-mcp/commit/3bad32cf44c82063a88c0894a057e0be84a1c804))
* login MCP 도구 — 확장 연결로 터미널 없이 로그인 ([#35](https://github.com/hs-shell/dotbugi-mcp/issues/35)) ([b199bfd](https://github.com/hs-shell/dotbugi-mcp/commit/b199bfdab4d0fcec5f3835d455d3bb44d635a1d3))
* login method=browser·logout MCP 도구 ([#49](https://github.com/hs-shell/dotbugi-mcp/issues/49)) ([e2e212b](https://github.com/hs-shell/dotbugi-mcp/commit/e2e212bddef244191bfc56bbe6ca159f47243b81))
* login/logout — LMS 세션 확보와 OS 키체인 저장 ([#8](https://github.com/hs-shell/dotbugi-mcp/issues/8)) ([6717d18](https://github.com/hs-shell/dotbugi-mcp/commit/6717d1811ed22a4de586940ce8a18e19cc0dd365))
* play_vods·stop_vods — VOD 연속 재생을 대화에서 시작·중지 ([#39](https://github.com/hs-shell/dotbugi-mcp/issues/39)) ([40d38f7](https://github.com/hs-shell/dotbugi-mcp/commit/40d38f772f1d8691271e83e8b4aa15cc67bb0c80))
* read_material — 받은 자료를 Claude Desktop 에서도 읽기 ([#78](https://github.com/hs-shell/dotbugi-mcp/issues/78)) ([e791145](https://github.com/hs-shell/dotbugi-mcp/commit/e7911452b334a2ab66ee2ba09543c94557a83a08))
* setup_statusline — 상태 표시줄을 대화로 설정 ([#70](https://github.com/hs-shell/dotbugi-mcp/issues/70)) ([05a10eb](https://github.com/hs-shell/dotbugi-mcp/commit/05a10ebfa24252bcf60f2ace5b22fab858dde9c2))
* stop_transcribe — 백그라운드 받아쓰기 중지 ([#50](https://github.com/hs-shell/dotbugi-mcp/issues/50)) ([f0e47d4](https://github.com/hs-shell/dotbugi-mcp/commit/f0e47d4ea63c5302a20453045481f4b82ee587f4))
* summarize_week — 주차별 강의자료 요약.md 정리 프롬프트 ([#15](https://github.com/hs-shell/dotbugi-mcp/issues/15)) ([77d67d9](https://github.com/hs-shell/dotbugi-mcp/commit/77d67d95bcd756c7e0cb2f311dbd6ea23ac5e76e))
* sync_materials — 과목·주차별 강의자료 동기화 ([#16](https://github.com/hs-shell/dotbugi-mcp/issues/16)) ([64155cf](https://github.com/hs-shell/dotbugi-mcp/commit/64155cf1566db8fc79148b1505c6bfe940ad48d7))
* transcribe_vod — VOD 오디오 받아쓰기 파이프라인 ([#20](https://github.com/hs-shell/dotbugi-mcp/issues/20)) ([8ae9f4d](https://github.com/hs-shell/dotbugi-mcp/commit/8ae9f4d76db0fc33f1f50a367bceb9c6e53ff9ea))
* VOD 스케줄러 — 마감 임박 순 앱 모드 창 재생과 다음 강의 자동 진행 ([#10](https://github.com/hs-shell/dotbugi-mcp/issues/10)) ([3686270](https://github.com/hs-shell/dotbugi-mcp/commit/3686270ff00762534c99e6e7b3670cae0f34574e))
* 도구 출력에 LMS 데이터 표시 ([#82](https://github.com/hs-shell/dotbugi-mcp/issues/82)) ([1a61e47](https://github.com/hs-shell/dotbugi-mcp/commit/1a61e47c075bafdf16b086f0228e62205003c126))
* 받아쓰기 언어 — 자동 감지 기본, language 로 고정 ([#79](https://github.com/hs-shell/dotbugi-mcp/issues/79)) ([af1249d](https://github.com/hs-shell/dotbugi-mcp/commit/af1249d120051684622e004a9f8b99d00d585238)), closes [#59](https://github.com/hs-shell/dotbugi-mcp/issues/59)
* 서버 instructions 에 별칭 안내, 도구 설명의 CLI 명령을 도구 이름으로 ([#56](https://github.com/hs-shell/dotbugi-mcp/issues/56)) ([2e892e0](https://github.com/hs-shell/dotbugi-mcp/commit/2e892e094901de93af27f4f83843fbfeb52bc79d))
* 열람 기간이 지난(dimmed) VOD 도 받아쓰기 ([#66](https://github.com/hs-shell/dotbugi-mcp/issues/66)) ([f4d4f4e](https://github.com/hs-shell/dotbugi-mcp/commit/f4d4f4e68d6f3f06b7ea20729be9545876b4fb6e))
* 오래 걸리는 도구 진행 알림·한 번 호출 작업량 상한 ([#80](https://github.com/hs-shell/dotbugi-mcp/issues/80)) ([fa6d54d](https://github.com/hs-shell/dotbugi-mcp/commit/fa6d54d620a12482119fecafea82dadbf7b9bcc5))
* 학기별 저장 폴더·저장 위치 변경(set_storage_dir) ([#71](https://github.com/hs-shell/dotbugi-mcp/issues/71)) ([6313c55](https://github.com/hs-shell/dotbugi-mcp/commit/6313c553994880320ad646f13592bda6bd78ea52)), closes [#58](https://github.com/hs-shell/dotbugi-mcp/issues/58)


### Bug Fixes

* qwen_asr linux-x64 바이너리 sha256 고정 ([#24](https://github.com/hs-shell/dotbugi-mcp/issues/24)) ([5ab951e](https://github.com/hs-shell/dotbugi-mcp/commit/5ab951e52f2e4af183181c09841a0f2e637ddb4f)), closes [#22](https://github.com/hs-shell/dotbugi-mcp/issues/22)
* security-audit 후속 — 콜백 조기 종료 방지·승인 문서·assign 폴더 링크 검사 ([#91](https://github.com/hs-shell/dotbugi-mcp/issues/91)) ([a42c944](https://github.com/hs-shell/dotbugi-mcp/commit/a42c944f382a65db51bcef78a78138a01c39c57b)), closes [#90](https://github.com/hs-shell/dotbugi-mcp/issues/90)
* set_storage_dir 는 dotbugi 자료만 옮기고 경로 서식 문자 거부 ([#88](https://github.com/hs-shell/dotbugi-mcp/issues/88)) ([d1c10a6](https://github.com/hs-shell/dotbugi-mcp/commit/d1c10a69a21baebbcc6cb67485dddbd66dab2e3f))
* WSL 드라이브 마운트 위치·사용자 설치 브라우저 해석 ([#31](https://github.com/hs-shell/dotbugi-mcp/issues/31)) ([6b30042](https://github.com/hs-shell/dotbugi-mcp/commit/6b30042b91c632d92c71950e577baaf71bf62fa0))
* WSL 키체인 시간 제한·세션 캐시, 200 로그인 화면도 세션 만료로 ([#69](https://github.com/hs-shell/dotbugi-mcp/issues/69)) ([d07828c](https://github.com/hs-shell/dotbugi-mcp/commit/d07828c3defe30558a83a4a9dbc9752fdfc47203))
* 죽은 play 잠금을 원자적으로 넘겨받기 ([#33](https://github.com/hs-shell/dotbugi-mcp/issues/33)) ([2c86556](https://github.com/hs-shell/dotbugi-mcp/commit/2c86556d6adc098a436b4c5f06d04092a62269b8)), closes [#28](https://github.com/hs-shell/dotbugi-mcp/issues/28)
* 첨부를 임시 파일로 받아 덜 받은 파일이 남지 않게 ([#32](https://github.com/hs-shell/dotbugi-mcp/issues/32)) ([045bcae](https://github.com/hs-shell/dotbugi-mcp/commit/045bcae6aebc6db4aecad18771bc6666bfe2e1e5))
* 회귀 점검 후속 — 받아쓰기 전 폴더 이전·잠금 기다림·로그인 판정 일치 등 ([#89](https://github.com/hs-shell/dotbugi-mcp/issues/89)) ([d1ea60b](https://github.com/hs-shell/dotbugi-mcp/commit/d1ea60b566d0919515d2bdb1670b87e8fab73eff))
