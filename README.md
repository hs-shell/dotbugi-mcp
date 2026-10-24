# dotbugi-mcp

한성대 LMS(learn.hansung.ac.kr, Moodle 3.2 + 코스모스)의 VOD·과제·퀴즈를 Claude Code / Claude Desktop에서 다루기 위한 MCP 서버.

## 설치

실행에 **Node.js 22.22.1 이상**이 필요합니다.

```bash
npx -y @dotbugi/mcp          # 설치 없이 바로 실행
npm i -g @dotbugi/mcp        # 또는 전역 설치 → dotbugi-mcp 명령
```

아래 터미널 예시의 `dotbugi-mcp` 는 전역 설치 기준입니다. 설치하지 않았다면 `npx -y @dotbugi/mcp` 로 바꿔 실행하세요. MCP 클라이언트 등록은 [Claude Code](#claude-code에-등록) · [Claude Desktop](#claude-desktop에-등록) 참고.

## 로그인 / 로그아웃

LMS 세션은 MCP [`login`](#login) 도구나 터미널에서 확보합니다. 어느 쪽이든 세션 값·연결 코드는 대화 기록에 남지 않습니다.

```bash
dotbugi-mcp login            # 기본: dotbugi 확장으로 연결
dotbugi-mcp login --browser  # 대체: 임시 브라우저 창에서 직접 로그인
dotbugi-mcp logout
```

- **기본(`login`)**: 기본 브라우저로 LMS가 열리고, 로그인된 상태에서 dotbugi 확장의 연결 창에서 승인하면 세션이 `127.0.0.1`로 전달됩니다. dotbugi 확장 5.1.0 이상이 필요합니다. 연결은 일회용 코드 + dotbugi 확장 출처만 허용하며 5분 안에 한 번만 받습니다.
- **대체(`login --browser`)**: 설치된 Chrome → Edge → Brave → Whale 중 하나를 **새 임시 프로필**로 엽니다. 주소가 `https://learn.hansung.ac.kr` 인지 확인하고 로그인하면, LMS 세션 쿠키만 꺼낸 뒤 창을 닫고 임시 프로필을 삭제합니다. 평소 브라우저 정보에는 접근하지 않습니다. 브라우저 제어는 TCP 디버깅 포트 대신 파이프(`--remote-debugging-pipe`)로 연결하므로 로그인 대기 중 다른 프로세스가 창에 붙을 수 없고, 중간에 Ctrl+C 로 중단해도 창을 닫고 임시 프로필을 지웁니다. **WSL에서는 지원하지 않습니다** (디버깅 파이프가 Windows 브라우저로 전달되지 않음) — 확장 방식을 쓰거나 Windows 터미널에서 실행하세요.
- 받은 세션은 LMS `/my/` 접속으로 확인한 뒤에만 저장합니다.
- **`logout`**: 키체인에서 세션을 지웁니다. `--browser` 로 얻은 세션은 LMS 서버에서도 로그아웃합니다. 확장 방식 세션은 평소 브라우저와 공유되므로 서버 로그아웃은 하지 않습니다(브라우저까지 로그아웃되기 때문).

### 보안 참고

- 웹서비스 토큰(폐기 불가, 12주 유효) 대신 **세션 쿠키(`MoodleSession`)** 를 씁니다. 세션은 활동이 없으면 만료되고 로그아웃으로 서버에서 끊을 수 있습니다.
- 세션은 **OS 키체인에만** 저장합니다 (Windows 자격 증명 관리자 / macOS 키체인 / Linux Secret Service, 없으면 커널 키링 — 재부팅 시 사라짐). 키체인을 쓸 수 없으면 로그인을 거부하며, 파일로 대신 저장하지 않습니다.
- **WSL**에서는 Windows 자격 증명 관리자(`session.dotbugi-mcp` 일반 자격 증명)를 PowerShell로 사용합니다.
- 키체인은 **같은 사용자 권한으로 실행되는 프로세스라면 읽을 수 있습니다.** Bash 실행 권한이 있는 AI 에이전트도 마찬가지입니다. 필요 없을 때는 `logout` 하세요.
- 세션 쿠키는 `https://learn.hansung.ac.kr` 로만 보내고, 세션 값·연결 코드는 화면이나 로그에 출력하지 않습니다.
- 확장 연결용 일회용 코드는 브라우저를 여는 명령(`xdg-open`·`rundll32` 등)의 실행 인자에 잠시 나타나 같은 기기의 다른 프로세스가 볼 수 있습니다. 이 코드로는 세션을 **넣을** 수만 있고 읽을 수는 없으며, 한 번 받으면(또는 5분 뒤) 무효가 됩니다.

## 추적할 강좌 (`courses`)

`list_tasks`·`vod_status`·`play`·`sync_materials`·`transcribe_vod` 가 다룰 강좌를 고릅니다. dotbugi 확장의 강좌 토글과는 **별개**입니다 (공유하지 않음).

```bash
dotbugi-mcp courses                 # 터미널: ↑↓(k/j) 이동 · Space 켜기/끄기 · Enter 저장 · q/Esc/Ctrl+C 취소
dotbugi-mcp courses --list          # 켜짐/꺼짐 · courseId · 과목명 (탭 구분)
dotbugi-mcp courses --on 비교과      # 과목명 일부(대소문자 무시) 또는 courseId
dotbugi-mcp courses --off 12345
```

- 강좌 목록은 LMS 메인의 내 강좌에서 가져오므로 로그인이 필요합니다. 터미널(TTY)이 아니면 옵션 없이 실행해도 `--list` 처럼 출력합니다.
- `--on`/`--off` 에 여러 강좌가 맞으면 저장하지 않고 후보를 보여 줍니다.
- 기본값: 정규 강좌 켜짐, 비교과(커뮤니티) 꺼짐. 직접 정하지 않은 강좌(새 학기 강좌 포함)는 기본값을 따릅니다.
- 꺼진 강좌는 LMS 요청도 하지 않습니다. 설정이 바뀌면 `list_tasks` 캐시도 새로 가져옵니다.
- 저장: `~/.config/dotbugi-mcp/courses.json` (디렉터리 0700·파일 0600, 원자적 교체). `{ "version": 1, "courses": { "<courseId>": true | false } }` 만 담고, 읽을 때 검증해 형식이 틀리면 기본값으로 봅니다.

## 도구

### `login`

터미널 없이 dotbugi 확장 연결로 로그인합니다. 인자는 없습니다. 기본 브라우저로 LMS 를 열고 **승인을 기다리지 않고 바로** 확인 코드(`XXX-XXX`)와 안내를 돌려줍니다. 승인 대기(5분)·`/my/` 확인·키체인 저장은 MCP 서버 안에서 이어집니다.

- 연결 방식·보안 조건은 터미널 `login` 기본 방식과 같습니다 (일회용 코드, 확장 출처만, 5분 안에 한 번). 출력은 상태·확인 코드·안내뿐이고 세션 값·연결 코드는 넣지 않습니다.
- 진행 중에 다시 부르면 새 연결을 열지 않고 같은 확인 코드로 "진행 중"을 알립니다. 승인 뒤 다시 부르면 "이미 로그인되어 있습니다"로 결과를 확인할 수 있습니다.
- 저장된 세션이 유효하면 브라우저를 열지 않습니다. `--browser` 대체 방식은 터미널 전용입니다.

### `list_tasks` (읽기 전용)

추적 중인 강좌([`courses`](#추적할-강좌-courses), 기본: 비교과 제외)의 강의 영상(VOD)·과제·퀴즈를 **마감 임박 순**으로 돌려줍니다. 지금 출석 인정 기간인 VOD와 마감 전(또는 마감 정보 없는) 과제·퀴즈만 대상입니다 (dotbugi 확장 대시보드와 같은 기준).

| 인자             | 기본값  | 설명                                         |
| ---------------- | ------- | -------------------------------------------- |
| `type`           | 전부    | `vod` / `assign` / `quiz` 중 하나만          |
| `incompleteOnly` | `true`  | 미출석·미제출·미응시만                       |
| `withinDays`     | -       | 마감이 N일 이내인 것만 (마감 정보 없음 제외) |
| `course`         | -       | 과목명 일부 (대소문자 무시)                  |
| `refresh`        | `false` | 1시간 캐시를 무시하고 다시 가져오기          |

- 결과는 구조화 데이터(`structuredContent`: 종류·과목·제목·상태·마감(한국 시간 ISO)·남은 시간·URL)와 한 줄 요약 텍스트로 옵니다.
- LMS 요청은 프로세스 전체에서 동시에 3개까지만, 요청마다 20초 제한으로 보내고, 결과는 메모리에 1시간 캐시합니다.
- 일부 과목·항목을 가져오지 못하면 `warnings`(텍스트 맨 앞에도)에 실패 건수를 알리고, 그 결과는 캐시하지 않습니다.
- 세션이 없거나 만료되면 `login` 도구(또는 `dotbugi-mcp login`)로 다시 로그인하라는 오류를 돌려줍니다.

### `vod_status` (읽기 전용)

`list_tasks(type: vod)` 와 같은 기준의 **남은(미출석) VOD** 를 마감 임박 순으로 돌려주고, `play` 로 재생 중이면 상태 파일의 지금 강의 진도·남은 시간(`player`)을 함께 붙입니다. 인자는 `refresh` 하나입니다.

- `player`: 상태 파일(아래 `play` 참고) 내용 + `stale`(재생 중인데 갱신이 3분 넘게 끊김). 파일이 없거나 형식이 틀리면 `null`
- 텍스트는 상태 표시줄과 같은 한 줄(재생 중일 때) + `list_tasks` 와 같은 표입니다.
- 세션이 없거나 만료됐거나 LMS 를 못 읽어도 오류로 끝내지 않고, `player` 와 함께 `tasks: []`·`fetchedAt: null`·`warnings`(login 안내)를 돌려줍니다.

### `get_assignment` (LMS 읽기 전용, 로컬에 첨부파일 저장)

과제 하나의 본문·마감·제출 상황을 돌려주고, 첨부파일을 서버가 직접 받아 **로컬 경로만** 알려줍니다. **제출은 하지 않습니다** — 결과물은 사용자가 `submitUrl`(`https://learn.hansung.ac.kr/mod/assign/view.php?id=<cmid>`)에서 직접 제출합니다.

| 인자   | 설명                                                                                   |
| ------ | -------------------------------------------------------------------------------------- |
| `cmid` | 과제 id (양의 정수). 과제 주소 `mod/assign/view.php?id=<cmid>` (`list_tasks` 의 `url`) |

- 결과(`structuredContent`): 제목·마감(한국 시간 ISO, 해석 못 하면 LMS 원문)·제출 상황 표(LMS 표기 그대로)·본문(마크다운)·첨부파일 경로·저장 폴더·제출 링크·경고.
- 본문은 **신뢰할 수 없는 데이터**로 표시합니다. 스크립트와 흔한 방식으로 숨긴 글(숨김 클래스·`display:none`·글자 크기 0 등, 최선 노력)은 버리고, 제어·서식 문자(제로폭·방향 전환 등)는 공백으로 바꿉니다. 링크 글자가 주소처럼 보이는데 실제 주소와 다르면 실제 주소를 함께 보여 줍니다. `<pre>` 는 코드 블록으로 줄바꿈을 살립니다.
- 첨부파일 저장 위치: `~/Downloads/dotbugi-mcp/assign-<cmid>/` (과제 전용 폴더).
  - 본문 영역의 `https://learn.hansung.ac.kr/pluginfile.php/…` 링크만 받습니다. 다른 주소에는 세션을 보내지 않으며, 리다이렉트는 따라가지 않습니다.
  - 파일명에서 경로 문자(`/`, `\`, `..` 등)·제어 문자·Windows 금지 문자와 예약 이름을 걸러내고, 실제 경로가 저장 폴더 안인지 다시 확인합니다.
  - 파일당 20MB, 과제당 20개까지 받습니다 (크기는 받는 도중에도 세어 넘으면 멈추고 지웁니다). 첨부 요청은 120초까지 기다립니다.
  - 쿼리(`?forcedownload=1` 등)만 다른 같은 파일 링크는 한 번만 받습니다.
  - 같은 이름의 파일이 이미 있으면 **덮어쓰지 않고** `이름 (2).pdf` 처럼 번호를 붙여 저장하고 경고로 알립니다 (다시 호출하면 번호가 붙은 사본이 늘어납니다).
- 일부 첨부파일을 못 받아도 나머지 결과는 돌려주고 `warnings` 로 알립니다.

### `sync_materials` (LMS 읽기 전용, 로컬에 강의자료 저장)

추적 중인 강좌([`courses`](#추적할-강좌-courses)) 화면의 **파일(`mod/resource`)·폴더(`mod/folder`) 자료**를 과목·주차별 폴더에 받고 로컬 경로를 돌려줍니다. 터미널에서는 `dotbugi-mcp sync` 로 같은 동기화를 합니다.

| 인자     | 설명                                                      |
| -------- | --------------------------------------------------------- |
| `course` | 과목명 일부 (대소문자 무시). 생략하면 추적 중인 강좌 전부 |

- 저장 위치: `~/Downloads/dotbugi-mcp/<과목>/<N주차>/` — 섹션 이름에서 `N주차`(또는 `Week N`)를 읽고, 주차가 없는 섹션은 섹션명을 씁니다. 과목·주차 이름도 파일명과 같은 규칙으로 정리하고 저장 폴더 안인지 다시 확인합니다 저장 폴더 아래에 링크(symlink) 폴더가 끼어 있으면 그 과목·주차는 건너뜁니다. 정리한 이름이 같은 다른 과목(분반 등)은 `<과목> (<과목 번호>)` 폴더를 씁니다.
- 결과(`structuredContent`): `files`(과목·주차·로컬 경로·`added`/`updated`/`unchanged`), `removed`(LMS 에서 사라진 파일), `warnings`. 세션이 붙은 주소는 내보내지 않습니다.
- **증분**: 과목 폴더의 `.dotbugi-manifest.json`(0600, 원자적 교체)에 파일별 cmid·리비전이 든 pluginfile 주소·sha256·상대 경로·받은 시각을 기록합니다.
  - 새 파일과 **리비전(주소)이 바뀐 파일만** 다시 받습니다. 받은 내용의 해시가 기존과 같으면 파일을 쓰지 않습니다.
  - 로컬 파일 해시가 기록과 다르면(사용자가 수정) 덮어쓰지 않고 `이름 (2).pdf` 로 새 버전을 저장하고 경고합니다. 로컬에서 지운 파일은 다시 받습니다.
  - 기록 파일은 읽을 때마다 형식을 검증하고(링크·4MB 초과·형식 오류면 그 과목을 건너뜀), 기록된 경로도 쓰거나 지우기 전에 과목 폴더 안인지 다시 확인합니다.
- **LMS 에서 사라진 파일은 자동으로 지우지 않습니다.** MCP 도구는 `removed` 로 알리기만 합니다. `dotbugi-mcp sync` 는 파일마다 `삭제할까요? [y/N]` 를 묻고(기본 유지, 받은 뒤 수정한 파일은 추가 경고), 남기기로 한 파일은 기록해 다시 묻지 않습니다. 터미널(TTY)이 아니면 묻지 않고 그대로 둡니다. 목록을 못 읽은 자료는 사라진 것으로 보지 않습니다.
- 파일 자료는 `mod/resource/view.php?id=<cmid>&redirect=1` 의 리다이렉트 주소가 **LMS 출처의 `/pluginfile.php/`** 일 때만 받습니다 (리다이렉트를 자동으로 따라가지 않고 직접 확인). 폴더 자료는 폴더 화면의 pluginfile 링크만 받습니다. 하위 폴더는 펼쳐서 같은 주차 폴더에 받습니다.
- 파일은 `이름.part` 로 받은 뒤 다 받으면 제자리로 옮기고, 받을 때마다 기록 파일을 갱신합니다 (중간에 멈춰도 덜 받은 파일이 자료 이름으로 남지 않음). 받은 그대로인 파일을 새 버전으로 바꾸기 직전에 해시를 다시 재므로, 받는 동안 고친 파일도 덮어쓰지 않습니다.
- 파일당 200MB, 요청당 10분, 한 번 실행에 새로 받는 양은 300개·2GB 까지 (넘으면 경고하고 다음 실행에서 이어 받음). 크기는 받는 도중에도 세어 넘으면 멈추고 지웁니다. LMS 요청은 다른 도구와 함께 동시에 3개까지만 보냅니다.
- `sync_materials` 와 `dotbugi-mcp sync` 는 한 번에 하나만 실행됩니다 (`~/Downloads/dotbugi-mcp/.dotbugi-sync.lock`).
- CLI 삭제는 보고한 그 파일(같은 경로·같은 내용)일 때만 합니다. 묻는 사이 파일이 바뀌면 지우지 않습니다.
- 텍스트 결과에는 개수와 추가·갱신·삭제된 경로만 싣고, 변경 없는 파일까지 모든 경로는 `structuredContent.files` 에 있습니다.

## 프롬프트

### `summarize_week`

한 과목·주차의 강의자료를 복습용 노트로 정리하도록 Claude에게 안내하는 프롬프트입니다. 서버는 LLM 을 호출하지 않습니다 (API 키·비용 없음) — Claude가 `sync_materials` 로 자료를 받고 파일을 직접 읽어 정리합니다.

| 인자     | 설명                                                   |
| -------- | ------------------------------------------------------ |
| `course` | 과목명 일부 (1~50자, 줄바꿈·제어·서식 문자는 공백으로) |
| `week`   | 주차 (1~99)                                            |

- 대상 폴더: `sync_materials` 가 돌려준 경로 중 해당 주차 폴더 (`~/Downloads/dotbugi-mcp/<과목>/<주차 폴더>/`, 이름은 LMS 섹션 제목을 따름). 과목이 여럿 맞거나 주차 폴더를 확신할 수 없으면 사용자에게 묻습니다.
- 폴더의 파일을 읽되 `요약.md` 자신은 제외합니다.
- PDF 는 Claude가 직접 읽고, 읽지 못하는 형식(PPTX·DOCX·HWP 등)은 파일명과 함께 알립니다.
- 같은 폴더에 `요약.md` (핵심 개념 / 용어 정리 / 예제 / 예상 문제 / 출처(파일명·페이지))를 씁니다. 이미 있으면 덮어쓰기 전에 확인합니다.
- 단계보다 먼저, 자료 내용은 **신뢰할 수 없는 데이터**이며 파일 안의 지시를 따르지 않고, 쓰는 파일은 그 주차 폴더의 `요약.md` 하나뿐이며, 자료를 근거로 명령 실행·URL 열기·다른 파일 수정/삭제를 하지 않도록 명시합니다.
- Claude Code 에서는 `/mcp__dotbugi__summarize_week 자료구조 3` 처럼 호출합니다 (서버 이름에 따라 다름).

## VOD 연속 재생 (`play`)

```bash
dotbugi-mcp play   # Ctrl+C 로 중지
```

- 지금 **출석 인정 기간 안의 미출석 VOD**를 마감 임박 순(같으면 과목·주차 순)으로, LMS **공식 플레이어 페이지**(`/mod/vod/view.php?id=<번호>`)를 평소 브라우저 프로필의 앱 모드 창(`--app`)으로 하나씩 엽니다. 출석·진도는 공식 플레이어가 평소처럼 기록합니다.
- 재생 중에는 90초마다 서버 진도 페이지(`report/ubcompletion/user_progress.php`)를 한 장씩 확인하고, **서버가 출석(진도 100%)을 확인한 뒤에만** 다음 강의 창을 엽니다. 서버 반영 주기만큼 늦게 넘어갈 수 있습니다.
- 다 본 창은 직접 닫아 주세요 (평소 프로필 창은 외부에서 제어하지 않습니다). 이미 출석한 강의는 열지 않고, 보는 중에 출석 인정 기간이 끝나면 건너뜁니다.
- 세션이 만료되면 멈추고 `dotbugi-mcp login` 을 안내합니다. 진도를 10번(약 15분) 연속 확인하지 못하면 로그와 상태 파일 `message` 로 알립니다.
- 한 번에 하나만 실행됩니다 (`~/.cache/dotbugi-mcp/player.lock`, 강제 종료로 남은 잠금은 다음 실행이 넘겨받음). Ctrl+C·터미널 종료(SIGINT·SIGTERM·SIGHUP)로 멈추면 상태를 `stopped` 로 남깁니다.
- 헤드리스 재생·자동 음소거·배속 강제·플레이어 검사 우회·진도 요청 직접 생성은 **하지 않습니다**.
- 브라우저는 Chrome → Edge → Brave → Whale 순으로 찾습니다. WSL에서는 `C:\Program Files` 의 Windows 브라우저를 실행합니다.

진행 상황은 `~/.cache/dotbugi-mcp/player-state.json` 에 기록됩니다 (디렉터리 0700·파일 0600, 원자적 교체). 세션·URL 등은 넣지 않고 표시용 데이터만 담습니다.

```json
{
  "version": 1,
  "status": "playing",
  "updatedAt": "2026-10-24T03:00:00.000Z",
  "total": 3,
  "index": 1,
  "current": {
    "course": "자료구조",
    "title": "트리 순회",
    "week": 8,
    "deadline": "2026-10-27T23:59:59+09:00",
    "progress": 25,
    "remainingSeconds": 900
  },
  "next": { "course": "운영체제", "title": "스케줄링", "week": 8, "deadline": "2026-10-28T23:59:59+09:00" },
  "message": null
}
```

- `status`: `playing` / `done`(모두 마침) / `stopped`(Ctrl+C) / `error`(`message` 에 이유)
- `index`: 지금 강의 순번(1부터, 없으면 0). `progress`·`remainingSeconds`(출석 인정까지 남은 학습 시간)는 서버 진도를 못 읽으면 `null`
- 재생 중에는 약 90초마다 `updatedAt` 이 갱신됩니다. 강제 종료되면 `status` 가 `playing` 으로 남으므로, 읽는 쪽은 `updatedAt` 이 3분(`PLAYER_STATE_STALE_MS`, 확인 간격의 2배)보다 오래되면 멈춘 것으로 봐야 합니다.

## Claude Code 상태 표시줄

`play` 로 재생하는 동안 Claude Code 아래쪽에 진행 상황을 한 줄로 띄웁니다.

```text
🎬 VOD 3/7 · 초급일본어 5과  ▓▓▓▓▓▓░░░░ 62%  12분 남음 · 다음: 6과 (D-1)
```

`~/.claude/settings.json` 에 추가합니다 (`refreshInterval` 은 Claude Code가 한가할 때도 N초마다 다시 그리게 합니다).

```json
{
  "statusLine": {
    "type": "command",
    "command": "dotbugi-mcp statusline",
    "refreshInterval": 30
  }
}
```

- 상태 파일(`~/.cache/dotbugi-mcp/player-state.json`)만 읽습니다. 네트워크·키체인·Claude Code가 넘기는 세션 JSON(stdin)은 쓰지 않습니다.
- 재생 중이 아니면(파일 없음·`done`·`stopped`) 아무것도 출력하지 않습니다. `error` 는 짧은 오류 한 줄로 보여줍니다.
- 갱신이 3분 넘게 끊기면 `⚠ N분째 갱신 없음`(갱신 시각이 미래면 `⚠ 갱신 시각 이상`)을 붙이고, 1시간 넘게 지난 상태(강제 종료·지난 오류)는 숨깁니다. 지난 마감은 `D-day` 대신 `마감` 으로 보여줍니다.
- 과목·제목 등 LMS 텍스트는 제어·서식 문자(터미널 이스케이프 포함)를 지우고 30자로 자릅니다. 상태 파일의 글은 쓸 때·읽을 때 200자로 자릅니다. 링크(symlink)·16KB 초과·형식이 틀린 상태 파일은 읽지 않습니다.
- 이미 다른 상태 표시줄을 쓰고 있다면 그 스크립트에서 이 명령의 출력을 이어 붙이면 됩니다.

## 로컬 음성 인식 런타임 (`asr`)

VOD 받아쓰기(`transcribe_vod`, #19)가 쓰는 Qwen3-ASR 런타임을 설치·확인·제거합니다. Docker·sudo 없이 `~/.cache/dotbugi-mcp/asr/` 한 폴더(0700)에만 설치하고, 시스템 패키지·PATH 는 건드리지 않습니다.

```bash
dotbugi-mcp asr install                    # CPU: ffmpeg + qwen_asr + Qwen3-ASR-0.6B (약 2GB)
dotbugi-mcp asr install --gpu --model 1.7b # NVIDIA GPU: ffmpeg + Python venv(uv) + 선택 모델 (venv 약 6GB)
dotbugi-mcp asr status                     # 설치 구성·용량·sha256 검증 결과
dotbugi-mcp asr remove                     # 폴더 삭제 (터미널이 아니면 --yes 필요)
```

- 실행 방식은 자동으로 고르지 않습니다. CPU 는 0.6B 고정, `--model 0.6b|1.7b` 는 `--gpu` 와 함께일 때만 고를 수 있고 `config.json` 에 저장됩니다. 다시 `install` 하면 바뀝니다.
- 지원: Linux x64·WSL — x86-64-v3 CPU(AVX2·FMA 등, Intel Haswell·AMD Excavator 이후) + **glibc 2.35 이상**(Ubuntu 22.04·Debian 12 이후). macOS Apple Silicon 은 바이너리 검증 전이라 아직 CPU 설치가 거부됩니다. `--gpu` 는 Linux x64 + NVIDIA GPU + [uv](https://docs.astral.sh/uv/) 필요. Windows 는 WSL 에서 실행하세요.
- 받는 파일은 모두 코드에 고정된 sha256·크기와 일치해야 쓰입니다(`src/asr/pins.ts`). 60초 동안 데이터가 오지 않으면 끊습니다. `.part` 로 받아 검증한 뒤에만 이름을 바꾸므로 중단돼도 다시 실행하면 이어 받습니다.
  - `qwen_asr`: 공개 저장소 [hs-shell/dotbugi-asr-binaries](https://github.com/hs-shell/dotbugi-asr-binaries) Release(`asr-v*`)의 미리 빌드한 바이너리 — antirez/qwen-asr 커밋 고정, OpenBLAS 정적 링크
  - ffmpeg: PyPI `imageio-ffmpeg` 0.6.0 휠 안의 정적 바이너리
  - 모델: Hugging Face `Qwen/Qwen3-ASR-0.6B`·`1.7B` 고정 리비전
  - GPU venv: `src/asr/gpu-requirements.txt` (해시 고정, 휠만) — `uv pip install --require-hashes --only-binary :all:`
- uv 캐시와 uv 가 받는 Python 도 같은 폴더(`uv-cache/`, `python/`)에 두므로 `asr remove` 로 모두 지워집니다.
- 내려받기는 https 로 github.com·huggingface.co·files.pythonhosted.org 와 그 CDN 만 허용합니다. 텔레메트리는 없습니다.

### qwen_asr 바이너리 고정 (관리자)

`linux-x64` 는 Release `asr-v1` 로 고정돼 있습니다. 새 빌드를 올릴 때는:

1. [hs-shell/dotbugi-asr-binaries](https://github.com/hs-shell/dotbugi-asr-binaries) 의 **Build qwen_asr** 워크플로를 새 태그(`asr-v2` …)로 실행
2. Release 의 `SHA256SUMS` 값과 파일 크기를 `src/asr/pins.ts` 의 `QWEN_ASR_BINARY` 에 넣고 PR (값이 `UNPINNED` 인 플랫폼은 CPU 설치가 거부됩니다)

## Claude Code에 등록

```bash
claude mcp add -s user dotbugi -- npx -y @dotbugi/mcp
```

`-s user` 는 모든 프로젝트에서 쓰도록 등록합니다. 등록 확인은 `claude mcp list`.

## Claude Desktop에 등록

`claude_desktop_config.json` 의 `mcpServers` 에 추가한 뒤 Claude Desktop을 다시 시작합니다.

macOS · Windows:

```json
{
  "mcpServers": {
    "dotbugi": {
      "command": "npx",
      "args": ["-y", "@dotbugi/mcp"]
    }
  }
}
```

- **macOS**: Claude Desktop은 셸 PATH를 읽지 않아 nvm·Homebrew 로 설치한 `npx` 를 못 찾을 수 있습니다. 그러면 `which npx` 로 확인한 절대 경로(예: `/opt/homebrew/bin/npx`)를 `command` 에 넣으세요.
- **Windows**: `npx` 를 못 찾으면 `"command": "npx.cmd"` 로 바꾸세요.

**WSL**(Node를 WSL 안에 설치한 경우): Windows 쪽 Claude Desktop에서 WSL 셸로 실행합니다. 로그인 셸(`-lc`)로 띄워야 nvm 등의 PATH가 잡힙니다.

```json
{
  "mcpServers": {
    "dotbugi": {
      "command": "wsl.exe",
      "args": ["-e", "bash", "-lc", "npx -y @dotbugi/mcp"]
    }
  }
}
```

## 개발

소스에서 빌드:

```bash
npm install
npm run build
npm run inspect   # MCP Inspector로 동작 확인
node dist/index.js login   # 빌드 결과를 직접 실행 (npm link 로 dotbugi-mcp 명령 연결 가능)
```

```bash
npm run lint     # ESLint
npm run test     # Vitest
npm run format   # Prettier
```

커밋 메시지와 PR 제목은 Conventional Commits 형식을 따릅니다(husky + commitlint로 검사). 릴리즈는 release-please 가 관리합니다: main 머지는 Release PR만 갱신하고, Release PR을 머지하면 GitHub Release 생성 후 npm 에 스테이징 배포(소유자 2FA 승인 후 공개)됩니다.

## 개발 참고

- **CI가 실패한 PR은 머지하지 않는다.**
