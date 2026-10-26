---
description: 사용자가 "테스트 써줘", "테스트 추가", "재현 테스트", "failing test", "커버리지 올려줘" 등을 요청하거나, 코드 변경에 맞는 vitest 테스트를 작성해야 할 때 사용
---

이 저장소의 패턴대로 **vitest** 테스트를 쓴다. 소스(`src/`·`plugin/hooks/`)를 바꾼 PR 은 테스트도 바꿔야 `테스트 필수` 검사를 통과한다.

## 1단계: 무엇을 확인할지 한 문장으로

"어떤 입력에서 / 무엇을 기대하는데 / (버그면) 지금은 무엇이 나오는지". 버그 이슈면 `gh issue view <번호> --repo hs-shell/dotbugi-mcp` 로 증상을 읽는다.

## 2단계: 위치

- `src/**` → `src/__tests__/<대상>.test.ts`. **같은 대상의 기존 파일이 있으면 거기에 케이스를 추가**한다.
- `plugin/skills` 생성 결과 등 src 밖 → `test/*.test.ts`.
- `plugin/hooks/*` → 순수 함수(`format.ts`)는 `test/*.test.ts` 에서 vitest 로 테스트한다 (`test/plugin-band.test.ts`). `plugin/tests/` 는 `claude-code/testing` 용이라 CI 에서 돌지 않아 `테스트 필수` 검사가 인정하지 않는다.

## 3단계: 이 저장소 패턴

- import: `import { describe, expect, it, vi } from 'vitest'`, 대상은 `'../<경로>.js'` (확장자 `.js`).
- 설명은 한국어로, 동작이 드러나게: `it('빈 비밀값은 무시한다', …)`.
- **순수 함수**: 버그·경계 입력으로 직접 부르고 결과를 단언한다 (`src/__tests__/redact.test.ts`).
- **LMS HTML**: `src/__tests__/fixtures/lms-pages.ts` 의 `fakeLmsFetch`·페이지 스니펫을 쓰고 `vi.stubGlobal('fetch', …)` 로 막는다. 실제 LMS 에 요청하지 않는다.
- **MCP 도구**: `InMemoryTransport.createLinkedPair()` + `createServer()` 로 `tools/call` 을 보내 결과 텍스트를 단언한다 (`src/__tests__/course-tools.test.ts`).
- **파일·홈 디렉토리**: `tmpdir()` 아래 임시 폴더를 쓰고 `afterEach` 에서 지운다. `~/.config` 등 실제 홈에 쓰지 않도록 `vi.mock('node:os', …)` 로 `homedir` 를 바꾼다.
- **세션·키체인**: `vi.mock('../session.js', …)` 로 가짜 세션을 준다. 진짜 쿠키 값처럼 보이는 문자열을 쓰지 않는다.
- **문서 파일(hwp/pptx/docx)**: `src/__tests__/fixtures/docs.ts` 의 `zip`·`hwp`·`pptx` 빌더로 만든다.
- 시간: `vi.useFakeTimers()` / `vi.setSystemTime()`. 플랫폼 분기: `vi.spyOn(process, 'platform', 'get')` 등으로 바꾼다 — CI 는 Windows·macOS·Linux 에서 모두 돈다.
- 비밀값이 결과·로그에 새지 않는지가 관련된 변경이면 그 단언도 넣는다 (`expect(text).not.toContain(SESSION)`).

## 4단계: 실행

```
npx vitest run src/__tests__/<파일>.test.ts   # 이 파일만
npm run test:coverage                          # 전체 + 커버리지
```

- 버그 재현 테스트는 **고치기 전에 실패하는지** 먼저 본다. 통과하면 재현이 안 된 것이니 조건을 다시 좁힌다.
- 바꾼 소스 파일의 커버리지 표에서 새 분기(`Uncovered Line #s`)가 남았는지 보고, 의미 있는 분기면 케이스를 더한다. 숫자를 올리려고 의미 없는 단언을 넣지 않는다.

## 주의

- 한 케이스는 한 동작만. 관련 없는 케이스를 같이 넣지 않는다.
- 구현 세부(내부 함수 호출 횟수 등)보다 바깥에서 보이는 결과를 단언한다.
