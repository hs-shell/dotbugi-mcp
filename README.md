# dotbugi-mcp

한성대 LMS(learn.hansung.ac.kr, Moodle 3.2 + 코스모스)의 VOD·과제·퀴즈를 Claude Code / Claude Desktop에서 다루기 위한 MCP 서버.

## 설치 / 빌드

Node.js 22.22.1 이상이 필요합니다 (개발 도구 요구사항).

```bash
npm install
npm run build
npm run inspect   # MCP Inspector로 동작 확인
```

## 로그인 / 로그아웃

LMS 세션은 **터미널에서** 확보합니다 (MCP 도구가 아니므로 자격 증명이 대화 기록에 남지 않습니다).

```bash
node dist/index.js login            # 기본: dotbugi 확장으로 연결
node dist/index.js login --browser  # 대체: 임시 브라우저 창에서 직접 로그인
node dist/index.js logout
```

(`npm link` 등으로 설치하면 `dotbugi-mcp login` 으로 실행할 수 있습니다.)

- **기본(`login`)**: 기본 브라우저로 LMS가 열리고, 로그인된 상태에서 dotbugi 확장의 연결 창에서 승인하면 세션이 `127.0.0.1`로 전달됩니다. 확장 쪽 기능은 [hs-shell/dotbugi#167](https://github.com/hs-shell/dotbugi/issues/167)에서 제공됩니다. 연결은 일회용 코드 + dotbugi 확장 출처만 허용하며 5분 안에 한 번만 받습니다.
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

## 도구

### `list_tasks` (읽기 전용)

수강 과목(비교과 제외)의 강의 영상(VOD)·과제·퀴즈를 **마감 임박 순**으로 돌려줍니다. 지금 출석 인정 기간인 VOD와 마감 전(또는 마감 정보 없는) 과제·퀴즈만 대상입니다 (dotbugi 확장 대시보드와 같은 기준).

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
- 세션이 없거나 만료되면 `dotbugi-mcp login` 을 다시 실행하라는 오류를 돌려줍니다.

### `vod_status` (읽기 전용)

`list_tasks(type: vod)` 와 같은 기준의 **남은(미출석) VOD** 를 마감 임박 순으로 돌려주고, `play` 로 재생 중이면 상태 파일의 지금 강의 진도·남은 시간(`player`)을 함께 붙입니다. 인자는 `refresh` 하나입니다.

- `player`: 상태 파일(아래 `play` 참고) 내용 + `stale`(재생 중인데 갱신이 3분 넘게 끊김). 파일이 없거나 형식이 틀리면 `null`
- 텍스트는 상태 표시줄과 같은 한 줄(재생 중일 때) + `list_tasks` 와 같은 표입니다.

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

## VOD 연속 재생 (`play`)

```bash
node dist/index.js play   # Ctrl+C 로 중지
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
    "command": "node /절대/경로/dotbugi-mcp/dist/index.js statusline",
    "refreshInterval": 30
  }
}
```

- 상태 파일(`~/.cache/dotbugi-mcp/player-state.json`)만 읽습니다. 네트워크·키체인·Claude Code가 넘기는 세션 JSON(stdin)은 쓰지 않습니다.
- 재생 중이 아니면(파일 없음·`done`·`stopped`) 아무것도 출력하지 않습니다. `error` 는 짧은 오류 한 줄로 보여줍니다.
- 갱신이 3분 넘게 끊기면 `⚠ N분째 갱신 없음` 을 붙이고, 1시간 넘게 지난 상태(강제 종료 등)는 숨깁니다.
- 과목·제목 등 LMS 텍스트는 제어·서식 문자(터미널 이스케이프 포함)를 지우고 30자로 자릅니다. 링크(symlink)·16KB 초과·형식이 틀린 상태 파일은 읽지 않습니다.
- 이미 다른 상태 표시줄을 쓰고 있다면 그 스크립트에서 이 명령의 출력을 이어 붙이면 됩니다.

## Claude Code에 등록

```bash
claude mcp add dotbugi -- node /절대/경로/dotbugi-mcp/dist/index.js
```

`-s user`를 붙이면 모든 프로젝트에서 사용할 수 있습니다. 등록 확인은 `claude mcp list`.

## Claude Desktop에 등록

`claude_desktop_config.json`에 추가한 뒤 Claude Desktop을 다시 시작합니다.

```json
{
  "mcpServers": {
    "dotbugi": {
      "command": "node",
      "args": ["/절대/경로/dotbugi-mcp/dist/index.js"]
    }
  }
}
```

## 개발

```bash
npm run lint     # ESLint
npm run test     # Vitest
npm run format   # Prettier
```

커밋 메시지와 PR 제목은 Conventional Commits 형식을 따릅니다(husky + commitlint로 검사).

## 개발 참고

- 비공개 저장소라 브랜치 보호(필수 검사)를 쓸 수 없어 CI 결과는 참고용이다. **CI가 실패한 PR은 머지하지 않는다.**
