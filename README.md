# dotbugi-mcp

한성대 LMS(learn.hansung.ac.kr)의 강의 영상(VOD)·과제·퀴즈·강의자료를 Claude Code / Claude Desktop 대화에서 다루게 해 주는 연결 기능(MCP 서버)입니다. 마감 임박 할 일 조회, 과제 본문·첨부 받기, 강의자료 동기화, 주차별 요약, VOD 연속 재생, 강의 받아쓰기를 Claude 에게 말로 요청하면 됩니다. LMS 에 제출하거나 글을 쓰지는 않습니다.

## 요구사항

- **Node.js 22.22.1 이상**
- 로그인용 [dotbugi 확장](https://github.com/hs-shell/dotbugi) **5.1.0 이상**

| 기능                             | Windows  | macOS             | Linux  | WSL |
| -------------------------------- | -------- | ----------------- | ------ | --- |
| 조회·과제·강의자료·요약·VOD 재생 | O        | O                 | O      | O   |
| 받아쓰기(로컬 음성 인식)         | WSL 에서 | O (Apple Silicon) | x64 만 | O   |

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

| 요청 예시                                               | 쓰는 도구                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| "이번 주 마감 과제 알려줘", "안 들은 강의 뭐 있어?"     | `list_tasks`                                               |
| "할 일을 캘린더 파일로 만들어줘"                        | `export_ics`                                               |
| "운영체제 과목은 추적 꺼줘"                             | `list_courses` / `set_course_tracking`                     |
| "자료구조 과제 내용이랑 첨부파일 받아줘"                | `get_assignment`                                           |
| "운영체제 강의자료 받아줘"                              | `sync_materials`                                           |
| "LMS 에서 지워진 자료 정리해줘"                         | `delete_materials` (승인 화면)                             |
| "자료는 문서/돋부기에 저장해줘" / "자료 어디 저장돼?"   | `set_storage_dir` (승인 화면) / `get_storage_dir`          |
| "자료구조 5주차 정리해줘"                               | `summarize_week` 프롬프트                                  |
| "안 들은 강의 차례로 틀어줘" / "재생 멈춰"              | `play_vods` / `stop_vods`, `vod_status`                    |
| "받아쓰기 준비해줘"                                     | `asr_install`, `asr_status`                                |
| "이 강의 받아써줘" / "어디까지 됐어?" / "받아쓰기 멈춰" | `transcribe_vod` / `transcribe_status` / `stop_transcribe` |
| "LMS 로그아웃해줘"                                      | `logout`                                                   |

Claude Code 에서는 프롬프트를 `/mcp__dotbugi__summarize_week 자료구조 5` 처럼 직접 부를 수도 있습니다.

**삭제·저장 위치 변경은 사용자가 직접 승인합니다.** `delete_materials`·`asr_remove`·`set_storage_dir`(위치만 바꿔도 — 공유 폴더로 바뀌면 앞으로 받는 자료가 새기 때문)는 대상 목록을 Claude 앱의 확인 창에 띄우고, 사용자가 체크하고 승인해야만 실행합니다 (Claude 가 대신 승인할 수 없습니다). 확인 창을 지원하지 않는 앱에서는 Claude 가 목록을 보여 주고 동의를 물은 뒤에만 실행합니다.

## 도구 목록

인자·출력·상한·파일 위치는 [docs/tools.md](docs/tools.md) 에 있습니다.

| 분류     | 이름                                                                                                                                                                           | 하는 일                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 로그인   | [`login`](docs/tools.md#login) / [`logout`](docs/tools.md#logout)                                                                                                              | LMS 로그인(확장 연결 또는 임시 브라우저) / 로그아웃                 |
| 할 일    | [`list_tasks`](docs/tools.md#list_tasks)                                                                                                                                       | VOD·과제·퀴즈를 마감 임박 순으로 조회                               |
|          | [`export_ics`](docs/tools.md#export_ics)                                                                                                                                       | 할 일 마감을 캘린더 파일(.ics)로 저장                               |
|          | [`list_courses`](docs/tools.md#list_courses--set_course_tracking) / [`set_course_tracking`](docs/tools.md#list_courses--set_course_tracking)                                   | 내 강좌·추적 여부 조회 / 강좌 추적 켜기·끄기                        |
|          | [`get_assignment`](docs/tools.md#get_assignment)                                                                                                                               | 과제 본문·마감·제출 상황, 첨부파일 받기                             |
| 재생     | [`vod_status`](docs/tools.md#vod_status)                                                                                                                                       | 남은 VOD 와 연속 재생 진행 상황                                     |
|          | [`play_vods`](docs/tools.md#play_vods--stop_vods) / [`stop_vods`](docs/tools.md#play_vods--stop_vods)                                                                          | 미출석 VOD 를 공식 플레이어로 차례로 재생 / 중지                    |
|          | [`setup_statusline`](docs/tools.md#setup_statusline)                                                                                                                           | Claude Code 상태 표시줄 켜기·끄기 (승인 후)                         |
| 자료     | [`sync_materials`](docs/tools.md#sync_materials)                                                                                                                               | 강의자료를 과목·주차 폴더로 동기화                                  |
|          | [`get_storage_dir`](docs/tools.md#get_storage_dir--set_storage_dir) / [`set_storage_dir`](docs/tools.md#get_storage_dir--set_storage_dir)                                      | 저장 위치·학기 폴더 확인 / 승인 후 저장 위치 변경(기존 자료도 이동) |
|          | [`delete_materials`](docs/tools.md#delete_materials)                                                                                                                           | LMS 에서 사라진 자료를 승인 후 로컬에서 삭제                        |
|          | [`summarize_week`](docs/tools.md#summarize_week) (프롬프트)                                                                                                                    | 주차 강의자료를 `요약.md` 로 정리                                   |
| 받아쓰기 | [`transcribe_vod`](docs/tools.md#transcribe_vod--transcribe_status--stop_transcribe) / [`transcribe_status`](docs/tools.md#transcribe_vod--transcribe_status--stop_transcribe) | VOD 하나를 로컬 음성 인식으로 받아쓰기 / 진행 상황                  |
|          | [`stop_transcribe`](docs/tools.md#transcribe_vod--transcribe_status--stop_transcribe)                                                                                          | 받아쓰기 중지                                                       |
|          | [`asr_install`](docs/tools.md#asr_install--asr_status) / [`asr_status`](docs/tools.md#asr_install--asr_status) / [`asr_remove`](docs/tools.md#asr_remove)                      | 음성 인식 런타임 설치 / 상태·검증 / 승인 후 삭제                    |

모든 기능을 대화로 쓸 수 있습니다. 같은 일을 터미널 명령으로도 할 수 있습니다 → [docs/tools.md](docs/tools.md#터미널에서도-할-수-있는-것)

## 개인정보·보안

- LMS 세션은 **OS 키체인에만** 저장합니다 (파일 저장 없음). 같은 사용자 권한의 프로세스는 키체인을 읽을 수 있으니 필요 없을 때는 "LMS 로그아웃해줘" 라고 하세요.
- 세션 쿠키는 `https://learn.hansung.ac.kr` 로만 보냅니다. 그 밖의 외부 접속은 받아쓰기용 영상 서버(`*.edge.naverncp.com`, 쿠키 없음)와 음성 인식 런타임 설치 때의 github.com·huggingface.co·PyPI 뿐이며, 텔레메트리는 없습니다.
- 도구 출력·로그에는 세션 값·연결 코드·영상 주소를 넣지 않습니다.
- LMS 에 제출·작성·수정하지 않습니다. 과제 제출은 직접 하세요.
- 출석은 LMS **공식 플레이어**를 평소 브라우저 창에서 재생해서만 인정받습니다 (헤드리스·음소거·배속 강제 없음).
- 받은 파일은 저장 위치(기본 `~/Downloads/dotbugi-mcp/`, `set_storage_dir` 로 변경)의 학기 폴더 `<YYYY-N학기>/<과목>/<N주차>/`, 재생·받아쓰기 상태와 음성 인식 런타임은 `~/.cache/dotbugi-mcp/`, 강좌·저장 위치 설정은 `~/.config/dotbugi-mcp/` 에 둡니다.

## 문제 해결

- **"저장된 LMS 세션이 없습니다" / "세션이 만료되었습니다"**: "dotbugi 로그인해줘" 라고 다시 요청하세요.
- **연결 창이 안 뜸**: dotbugi 확장이 5.1.0 이상인지, 열린 LMS 탭에 로그인돼 있는지 확인하세요.
- **Claude Desktop 에서 서버가 안 뜸**: 대개 `npx` 경로 문제입니다. 위 [설치·등록](#설치등록)의 macOS·Windows·WSL 안내를 보세요.
- **받아쓰기가 "런타임이 설치되어 있지 않습니다"**: "받아쓰기 준비해줘" 라고 해 음성 인식 런타임을 한 번 설치하세요 (약 2GB, [상세](docs/tools.md#asr_install--asr_status)).
- **원하는 과목이 안 보임**: "내 강좌 추적 설정 보여줘" 로 확인하고 켜 달라고 하세요 (기본: 비교과 꺼짐).

## 라이선스·기여

[Apache-2.0](LICENSE). 개발·기여 방법은 [CONTRIBUTING.md](CONTRIBUTING.md) 를 보세요.
