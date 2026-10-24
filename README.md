# dotbugi-mcp

한성대 LMS(learn.hansung.ac.kr)의 동영상 강의·과제·퀴즈·강의자료를 Claude Code / Claude Desktop 대화에서 다루게 해 주는 연결 기능(MCP 서버)입니다. 할 일 현황, 강의자료·과제 지시사항 최신화, 과제 함께 수행, 동영상 강의 STT 변환, 주차별 노트·핵심 요약, Google Drive 저장을 Claude 에게 말로(또는 슬래시 명령으로) 요청하면 됩니다. LMS 에 제출하거나 글을 쓰지는 않습니다.

## 사용 흐름

1. [설치·등록](#설치등록) 후 `/dotbugi:login` — dotbugi 확장으로 LMS 세션 연결
2. `/dotbugi:courses` — 다룰 과목을 체크박스로 선택
3. `/dotbugi:status` — 남은 할 일 확인 (`past` 를 붙이면 마감 지난 항목까지)
4. `/dotbugi:pull` — 강의자료와 미완료 과제 지시사항을 받고, 바뀐 것만 확인
5. 공부·과제
   - `/dotbugi:work` — 과제를 골라 지시사항을 읽고 함께 수행 (제출은 직접)
   - `/dotbugi:transcribe` — 동영상 강의를 STT 변환 (대상 목록을 확인한 뒤 시작, 진행률은 상태 표시줄)
   - `/dotbugi:notes` → `/dotbugi:summary` — 주차별 노트를 만들고, 노트로 핵심 요약
6. `/dotbugi:drive` — 받은 자료를 Google Drive 내 드라이브에 저장 (선택)

명령 전체는 `/dotbugi:help` 또는 아래 [슬래시 명령](#슬래시-명령) 표를 보세요.

## 요구사항

- **Node.js 22.22.1 이상**
- 로그인용 [dotbugi 확장](https://github.com/hs-shell/dotbugi) **5.1.0 이상**

| 기능                    | Windows  | macOS             | Linux  | WSL |
| ----------------------- | -------- | ----------------- | ------ | --- |
| 조회·과제·강의자료·요약 | O        | O                 | O      | O   |
| STT(로컬 음성 인식)     | WSL 에서 | O (Apple Silicon) | x64 만 | O   |

## 설치·등록

**Claude Code**

```bash
claude mcp add -s user dotbugi -- npx -y @dotbugi/mcp
```

`-s user` 는 모든 프로젝트에서 쓰도록 등록합니다. 확인은 `claude mcp list`.

**Claude Desktop** — `claude_desktop_config.json` 의 `mcpServers` 에 추가하고 Claude Desktop 을 다시 시작합니다.

```json
{
  "mcpServers": {
    "dotbugi": { "command": "npx", "args": ["-y", "@dotbugi/mcp"] }
  }
}
```

- **macOS**: Claude Desktop 은 셸 PATH 를 읽지 않아 nvm·Homebrew 로 설치한 `npx` 를 못 찾을 수 있습니다. `which npx` 로 확인한 절대 경로(예: `/opt/homebrew/bin/npx`)를 `command` 에 넣으세요.
- **Windows**: `npx` 를 못 찾으면 `"command": "cmd"`, `"args": ["/c", "npx", "-y", "@dotbugi/mcp"]` 로 바꾸세요.
- **WSL**(Node 를 WSL 안에 설치): 아래처럼 WSL 셸로 실행합니다. 비대화형 셸은 `~/.bashrc` 의 nvm 설정을 읽지 않아 직접 불러옵니다 (`-i` 는 쓰지 마세요 — `.bashrc` 출력이 MCP 통신에 섞입니다). nvm 이 아니면 `npx -y @dotbugi/mcp` 만 남기세요.

```json
{
  "mcpServers": {
    "dotbugi": {
      "command": "wsl.exe",
      "args": ["-e", "bash", "-c", "source ~/.nvm/nvm.sh && exec npx -y @dotbugi/mcp"]
    }
  }
}
```

## 시작하기

1. Claude 에게 **"dotbugi 로그인해줘"** 라고 합니다.
2. 기본 브라우저로 LMS 가 열리고, Claude 가 확인 코드(`XXX-XXX`)를 알려 줍니다.
3. LMS 에 로그인된 상태에서 dotbugi 확장의 연결 창에 같은 코드가 보이면 5분 안에 승인합니다.

세션은 OS 키체인에 저장되고, 만료되면 Claude 가 다시 로그인을 안내합니다.

## 이렇게 물어보세요

| 요청 예시                                             | 쓰는 도구                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| "이번 주 마감 과제 알려줘", "안 들은 강의 뭐 있어?"   | `list_tasks`                                               |
| "할 일을 캘린더 파일로 만들어줘"                      | `export_ics`                                               |
| "운영체제 과목은 추적 꺼줘"                           | `list_courses` / `set_course_tracking`                     |
| "자료구조 과제 내용이랑 첨부파일 받아줘"              | `get_assignment`                                           |
| "운영체제 강의자료 받아줘"                            | `sync_materials`                                           |
| "3주차 강의자료 읽고 요약해줘"                        | `read_material`                                            |
| "LMS 에서 지워진 자료 정리해줘"                       | `delete_materials` (승인 화면)                             |
| "자료는 문서/돋부기에 저장해줘" / "자료 어디 저장돼?" | `set_storage_dir` (승인 화면) / `get_storage_dir`          |
| "자료를 구글 드라이브에 저장해줘"                     | `find_google_drive` → `set_storage_dir` (승인 화면)        |
| "자료구조 5주차 노트 만들어줘"                        | `list_notes` → `save_notes` (`notes` 프롬프트)             |
| "자료구조 1-7주차 핵심만 요약해줘"                    | `list_summary` → `save_summary` (`summary` 프롬프트)       |
| "STT 준비해줘"                                        | `asr_install`, `asr_status`                                |
| "이 강의 STT 해줘" / "어디까지 됐어?" / "STT 멈춰"    | `transcribe_vod` / `transcribe_status` / `stop_transcribe` |
| "LMS 로그아웃해줘"                                    | `logout`                                                   |

Claude Code 에서는 `/dotbugi:notes 자료구조 5주차 시험 대비로`, `/dotbugi:summary 자료구조 1-7주차 개념 위주` 처럼 범위와 작성 지시를 함께 넘길 수 있습니다.

### 슬래시 명령

자주 쓰는 작업은 Claude Code 에서 슬래시 명령으로 바로 부를 수 있습니다 (서버 이름이 `dotbugi` 일 때). `/status` 처럼 뒷부분만 쳐도 자동 완성됩니다. `[ ]` 안 인자는 생략할 수 있고, 생략하면 추적 과목 전체가 대상입니다:

| 명령                                                              | 설명                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `/dotbugi:status [과목\|courseId] [past]`                         | 할 일 현황 (과목을 주면 그 과목 상세, past 면 마감 지난 항목 포함) |
| `/dotbugi:pull [과목\|courseId]`                                  | 강의자료·과제 최신화 (바뀐 자료·과제만 요약)                       |
| `/dotbugi:courses`                                                | 추적 과목 선택 (체크박스 선택 창)                                  |
| `/dotbugi:work [cmid\|과제명]`                                    | 과제 함께 수행 (생략하면 미완료 과제 목록에서 선택)                |
| `/dotbugi:notes [과목\|courseId\|교수] [N주차] [지시]`            | 주차별 강의 노트 생성 (범위 뒤에 작성 지시를 붙일 수 있음)         |
| `/dotbugi:summary [과목\|courseId\|교수] [N주차\|N-M주차] [지시]` | 핵심 요약 (노트 기반, 범위 뒤에 요약 지시를 붙일 수 있음)          |
| `/dotbugi:transcribe [cmid…\|과목\|all]`                          | 동영상 강의 STT 변환 (all 이 아니면 대상 확인 후 실행)             |
| `/dotbugi:drive`                                                  | Google Drive 연동 (저장 위치를 내 드라이브로)                      |
| `/dotbugi:login`                                                  | LMS 로그인                                                         |
| `/dotbugi:help`                                                   | 명령 안내                                                          |

**삭제·저장 위치 변경은 승인을 거칩니다.** `delete_materials`·`asr_remove`·`set_storage_dir`(위치만 바꿔도 — 공유 폴더로 바뀌면 앞으로 받는 자료가 새기 때문)는 확인 창(MCP form elicitation)을 지원하는 앱이면 대상 목록을 확인 창에 띄우고, 사용자가 체크하고 승인해야만 실행합니다 (Claude 가 대신 승인할 수 없습니다). 확인 창을 지원하지 않는 앱에서는 목록과 일회용 확인 토큰을 Claude 에게 돌려주고, Claude 가 사용자에게 묻고 토큰을 넣어 다시 불러야 실행합니다. 이 방식에서는 토큰이 모델을 거치므로 서버가 사용자 동의를 직접 확인하지 못합니다 — 남는 관문은 앱 자체의 도구 실행 허용 확인이니, 이런 앱에서는 이 도구들을 자동 허용하지 마세요.

## 도구 목록

인자·출력·상한·파일 위치는 [docs/tools.md](docs/tools.md) 에 있습니다.

| 분류   | 이름                                                                                                                                                                            | 하는 일                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 로그인 | [`login`](docs/tools.md#login) / [`logout`](docs/tools.md#logout)                                                                                                               | LMS 로그인(확장 연결 또는 임시 브라우저) / 로그아웃                         |
| 할 일  | [`list_tasks`](docs/tools.md#list_tasks)                                                                                                                                        | 동영상 강의·과제·퀴즈를 마감 임박 순으로 조회                               |
|        | [`export_ics`](docs/tools.md#export_ics)                                                                                                                                        | 할 일 마감을 캘린더 파일(.ics)로 저장                                       |
|        | [`list_courses`](docs/tools.md#list_courses--set_course_tracking) / [`set_course_tracking`](docs/tools.md#list_courses--set_course_tracking)                                    | 내 강좌·추적 여부 조회 / 추적 과목 선택(체크박스)·켜기·끄기                 |
|        | [`get_assignment`](docs/tools.md#get_assignment)                                                                                                                                | 과제 본문·마감·제출 상황, 첨부파일 받기                                     |
| 자료   | [`sync_materials`](docs/tools.md#sync_materials)                                                                                                                                | 강의자료를 과목·주차 폴더로 동기화                                          |
|        | [`get_storage_dir`](docs/tools.md#get_storage_dir--set_storage_dir--find_google_drive) / [`set_storage_dir`](docs/tools.md#get_storage_dir--set_storage_dir--find_google_drive) | 저장 위치·학기 폴더 확인 / 승인 후 저장 위치 변경(기존 자료도 이동)         |
|        | [`find_google_drive`](docs/tools.md#get_storage_dir--set_storage_dir--find_google_drive)                                                                                        | Google Drive 내 드라이브 찾기 → 저장 위치 후보 (옮기기는 `set_storage_dir`) |
|        | [`read_material`](docs/tools.md#read_material)                                                                                                                                  | 받은 자료·첨부·STT 결과 읽기, 폴더 살펴보기                                 |
|        | [`delete_materials`](docs/tools.md#delete_materials)                                                                                                                            | LMS 에서 사라진 자료를 승인 후 로컬에서 삭제                                |
|        | [`list_notes`](docs/tools.md#list_notes--save_notes-notes) / [`save_notes`](docs/tools.md#list_notes--save_notes-notes) (`notes` 프롬프트)                                      | 주차별 강의 노트 대상 확인(변경 감지) / 노트 저장                           |
|        | [`list_summary`](docs/tools.md#list_summary--save_summary-summary) / [`save_summary`](docs/tools.md#list_summary--save_summary-summary) (`summary` 프롬프트)                    | 노트 기반 핵심 요약 대상 확인(변경 감지) / 요약 저장                        |
| STT    | [`transcribe_vod`](docs/tools.md#transcribe_vod--transcribe_status--stop_transcribe) / [`transcribe_status`](docs/tools.md#transcribe_vod--transcribe_status--stop_transcribe)  | 동영상 강의를 로컬 음성 인식으로 STT 변환(여러 개는 대기열) / 진행 상황     |
|        | [`stop_transcribe`](docs/tools.md#transcribe_vod--transcribe_status--stop_transcribe)                                                                                           | STT 변환 중지                                                               |
|        | [`setup_statusline`](docs/tools.md#setup_statusline)                                                                                                                            | Claude Code 상태 표시줄에 STT 진행 표시 (승인 후, 기존 표시줄과 합침)       |
|        | [`asr_install`](docs/tools.md#asr_install--asr_status) / [`asr_status`](docs/tools.md#asr_install--asr_status) / [`asr_remove`](docs/tools.md#asr_remove)                       | 음성 인식 런타임 설치 / 상태·검증 / 승인 후 삭제                            |

모든 기능을 대화로 쓸 수 있습니다. 같은 일을 터미널 명령으로도 할 수 있습니다 → [docs/tools.md](docs/tools.md#터미널에서도-할-수-있는-것)

## 개인정보·보안

- LMS 세션은 **OS 키체인에만** 저장합니다 (파일 저장 없음). 같은 사용자 권한의 프로세스는 키체인을 읽을 수 있으니 필요 없을 때는 "LMS 로그아웃해줘" 라고 하세요.
- 세션 쿠키는 `https://learn.hansung.ac.kr` 로만 보냅니다. 그 밖의 외부 접속은 STT 용 영상 서버(`*.edge.naverncp.com`, 쿠키 없음)와 음성 인식 런타임 설치 때의 github.com·huggingface.co·PyPI 뿐이며, 텔레메트리는 없습니다.
- 도구 출력·로그에는 세션 값·연결 코드·영상 주소를 넣지 않습니다.
- LMS 에 제출·작성·수정하지 않습니다. 과제 제출은 직접 하세요.
- 받은 파일은 저장 위치(기본 `~/Downloads/dotbugi-mcp/`, WSL 은 Windows 다운로드 폴더, `set_storage_dir` 로 변경)의 학기 폴더 `<YYYY-N학기>/<과목>/<N주차>/`, STT 상태와 음성 인식 런타임은 `~/.cache/dotbugi-mcp/`, 강좌·저장 위치 설정은 `~/.config/dotbugi-mcp/` 에 둡니다.

## 문제 해결

- **"저장된 LMS 세션이 없습니다" / "세션이 만료되었습니다"**: "dotbugi 로그인해줘" 라고 다시 요청하세요.
- **연결 창이 안 뜸**: dotbugi 확장이 5.1.0 이상인지, 열린 LMS 탭에 로그인돼 있는지 확인하세요.
- **Claude Desktop 에서 서버가 안 뜸**: 대개 `npx` 경로 문제입니다. 위 [설치·등록](#설치등록)의 macOS·Windows·WSL 안내를 보세요.
- **STT 변환이 "런타임이 설치되어 있지 않습니다"**: "STT 준비해줘" 라고 해 음성 인식 런타임을 한 번 설치하세요 (약 2GB, [상세](docs/tools.md#asr_install--asr_status)).
- **원하는 과목이 안 보임**: `/dotbugi:courses` 로 체크박스 창을 열어 켜세요 (기본: 비교과 꺼짐).
- **STT 대상에 강의가 빠짐**: 아직 공개 전("…부터 사용가능")이거나 열람 기간이 지난 강의는 영상을 받지 못해 대상에서 빼고 따로 알립니다. 이미 STT 결과가 있는 강의도 건너뜁니다.
- **WSL 에서 Google Drive 를 못 찾음**: Drive 가상 드라이브(G: 등)는 WSL 에 자동으로 붙지 않습니다. `/dotbugi:drive` 가 알려 주는 마운트 명령(관리자 권한)을 한 번 실행한 뒤 다시 부르세요.
- **상태 표시줄에 STT 진행이 안 보임**: "상태 표시줄 켜줘" 라고 하면 `setup_statusline` 이 승인 후 설정합니다 (Claude Code 전용).

## 라이선스·기여

[Apache-2.0](LICENSE). 개발·기여 방법은 [CONTRIBUTING.md](CONTRIBUTING.md) 를 보세요.
