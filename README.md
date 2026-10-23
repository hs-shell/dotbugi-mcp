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
