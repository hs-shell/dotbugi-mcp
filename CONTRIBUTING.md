# 기여 안내

## 개발 환경

Node.js 22.22.1 이상이 필요합니다.

```bash
npm install          # 의존성 + husky 훅 설치
npm run build        # 타입 체크 + dist/ 빌드
npm run inspect      # MCP Inspector 로 도구 동작 확인
node dist/index.js login   # 빌드 결과를 직접 실행 (npm link 로 dotbugi-mcp 명령 연결 가능)
```

| 스크립트                | 하는 일             |
| ----------------------- | ------------------- |
| `npm run lint`          | ESLint              |
| `npm test`              | Vitest (한 번 실행) |
| `npm run test:watch`    | Vitest 감시 모드    |
| `npm run test:coverage` | Vitest + 커버리지   |
| `npm run format`        | Prettier 로 쓰기    |
| `npm run build`         | 타입 체크 + 빌드    |
| `npm run inspect`       | MCP Inspector       |

stdout 은 MCP 프로토콜 전용입니다. 로그는 반드시 stderr 로 씁니다 (`src/log.ts`).

## 브랜치·커밋·PR

- **이슈 먼저**: 모든 변경은 이슈를 먼저 등록하고, PR 본문에 `Closes #번호` 로 참조합니다 (PR 검사가 강제, Dependabot 제외).
- 브랜치: `<type>/<짧은-설명>` (예: `fix/12-vod-parse`).
- 커밋 메시지와 PR 제목은 **Conventional Commits** (`feat`/`fix`/`docs`/`refactor`/`perf`/`test`/`chore`/`ci`/`style`/`build`/`revert`). husky + commitlint 가 커밋을, PR 제목 검사가 PR 제목을 확인합니다. 한국어 제목도 됩니다.
- **스쿼시 머지만** 씁니다. main 에 남는 커밋 제목 = PR 제목이고, release-please 가 이를 읽어 버전을 정합니다.
- PR 검사: Prettier·ESLint·타입 체크와 빌드·테스트·의존성 취약점(high 이상 차단). **CI 가 실패한 PR 은 머지하지 않습니다.**
- **테스트 필수**: `src/`·`plugin/hooks/` 를 바꾼 PR 은 테스트(`*.test.ts`)도 함께 바꿔야 합니다 (`테스트 필수` 검사). 버그 수정은 실패하는 재현 테스트부터 씁니다. 테스트가 필요 없는 변경(문구·타입만 등)은 PR 에 이유를 적으면 메인테이너가 `no-test` 라벨을 붙입니다.
- 커버리지: PR 검사가 커버리지를 재서 전체 수치와 이 PR 에서 바뀐 파일의 수치를 PR 댓글로 남깁니다.
- main 보호: 필수 검사 `verify`·`issue-link`·`CodeRabbit`·`test-required` 통과 + 승인 1개가 있어야 머지됩니다.
- 리뷰: [CodeRabbit](https://coderabbit.ai) 이 PR 을 열 때 자동으로 한국어 리뷰를 남깁니다 (`.coderabbit.yaml`). 다시 받으려면 `@coderabbitai review` 를 댓글로 답니다. 리뷰어는 `.github/CODEOWNERS` 로 자동 지정됩니다.
- 자동화: PR 제목 접두어로 타입 라벨이 붙고 (`fix:` → `bug`, 나머지는 같은 이름), 새 이슈는 기존 이슈와 비교해 중복으로 보이면 댓글과 `possible-duplicate` 라벨이 달립니다.

## Claude Code 로 기여하기

`.claude/` 에 이 저장소용 설정과 스킬이 있습니다. 저장소를 Claude Code 로 열면 [ponytail](https://github.com/DietrichGebert/ponytail) 플러그인(필요한 만큼만 짜는 모드) 설치를 묻습니다.

| 스킬            | 하는 일                                                                   |
| --------------- | ------------------------------------------------------------------------- |
| `/create-issue` | 이슈 템플릿을 그대로 채워 이슈 생성 (중복 검색 먼저)                      |
| `/implement`    | 이슈 → 브랜치 → 테스트 먼저 → 구현 → 검사                                 |
| `/write-test`   | 이 저장소 패턴(fixture·InMemoryTransport 등)으로 테스트                   |
| `/create-pr`    | 검사 통과 확인 후 PR 템플릿을 채워 PR 생성                                |
| `/rebase`       | 최신 main 위로 리베이스하고 충돌을 해결한 뒤 `--force-with-lease` 로 push |

## qwen_asr 바이너리 고정 (관리자)

`linux-x64`·`macos-arm64` 는 [hs-shell/dotbugi-asr-binaries](https://github.com/hs-shell/dotbugi-asr-binaries) Release `asr-v2` 로 고정돼 있습니다. 새 빌드를 올릴 때는:

1. dotbugi-asr-binaries 의 **Build qwen_asr** 워크플로를 새 태그(`asr-v3` …)로 실행
2. Release 의 `SHA256SUMS` 값과 파일 크기를 `src/asr/pins.ts` 의 `QWEN_ASR_BINARY` 에 넣고 PR (값이 `UNPINNED` 인 플랫폼은 CPU 설치가 거부됩니다)

## 릴리즈

[release-please](https://github.com/googleapis/release-please) 가 관리합니다 (`release-please-config.json`, `.release-please-manifest.json`).

- main 에 머지해도 바로 배포되지 않고, 버전·CHANGELOG 를 담은 **Release PR** 만 갱신됩니다.
- Release PR 을 머지하면 태그·GitHub Release 를 만들고, `publish` 잡이 빌드·테스트 후 `npm stage publish` 로 **스테이징 배포**합니다 (npm Trusted Publishing, 토큰 없음). 소유자가 npm 에서 2FA 로 승인해야 공개됩니다.
- 첫 버전은 Trusted Publisher 를 설정할 패키지가 아직 없으므로 소유자가 로컬에서 직접 `npm publish` 합니다. 그 뒤 npm 패키지 설정에서 이 저장소의 `release-please.yml` 을 Trusted Publisher 로 등록합니다.
- Release PR 은 저장소 시크릿 `APP_ID`·`APP_PRIVATE_KEY`(이 저장소에 설치된 GitHub App)가 있으면 그 App 토큰으로 만들어 PR 검사가 돕니다. 시크릿이 없으면 `GITHUB_TOKEN` 으로 만들어 PR 검사가 돌지 않습니다.
