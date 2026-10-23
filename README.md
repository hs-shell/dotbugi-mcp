# dotbugi-mcp

한성대 LMS(learn.hansung.ac.kr, Moodle 3.2 + 코스모스)의 VOD·과제·퀴즈를 Claude Code / Claude Desktop에서 다루기 위한 MCP 서버.

> 현재는 서버 뼈대만 있습니다. `login`·조회 도구 등은 이후 이슈에서 추가됩니다.

## 설치 / 빌드

Node.js 22.22.1 이상이 필요합니다 (개발 도구 요구사항).

```bash
npm install
npm run build
npm run inspect   # MCP Inspector로 동작 확인
```

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
