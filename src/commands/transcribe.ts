import { spawn } from 'node:child_process';
import { asrLanguageSchema, DEFAULT_ASR_LANGUAGE, resolveAsrRuntime } from '../asr/runtime.js';
import { LMS_NUMERIC_ID, SIGNAL_EXIT_CODES, VOD_VIEWER_PATH } from '../constants.js';
import { createFetchHtml, limit } from '../lms-html.js';
import { isLoginPage, lmsFetch, SessionExpiredError } from '../lms.js';
import { log } from '../log.js';
import { acquireLock, adoptLock } from '../player/lock.js';
import { redact } from '../redact.js';
import { getSession } from '../session.js';
import { storageRoot } from '../storage.js';
import { findVod, type VodMeta } from '../transcribe/find-vod.js';
import { transcribeVod, type Phase } from '../transcribe/pipeline.js';
import {
  TRANSCRIBE_BUSY,
  TRANSCRIBE_HEARTBEAT_MS,
  TRANSCRIBE_LOCK_FILE,
  TRANSCRIBE_TMP_DIR,
  writeTranscribeState,
  type TranscribeState,
} from '../transcribe/state.js';

type StopSignal = keyof typeof SIGNAL_EXIT_CODES;
const STOP_SIGNALS = Object.keys(SIGNAL_EXIT_CODES) as StopSignal[];
const PHASE_LABELS: Record<Phase, string> = {
  prepare: '준비',
  download: '영상 받는 중',
  extract: '소리 추출',
  transcribe: '받아쓰는 중',
};

const viewerHtml = (session: string, cmid: number) =>
  limit(async () => {
    const res = await lmsFetch(`${VOD_VIEWER_PATH}?id=${cmid}`, session);
    // 리다이렉트도 실패 — 세션을 들고 다른 곳으로 따라가지 않는다
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`LMS 응답 오류 HTTP ${res.status}`);
    }
    const html = await res.text();
    if (isLoginPage(html)) throw new SessionExpiredError();
    return html;
  });

// 포그라운드 CLI 와 MCP 가 띄운 백그라운드 작업(worker: 출력 없음, 잠금은 도구가 넘겨준다)이 같이 쓴다. 진행은 상태 파일에 남긴다
export async function transcribe(arg: string, worker = false, languageArg?: string): Promise<void> {
  if (!LMS_NUMERIC_ID.test(arg)) throw new Error('강의 번호(cmid)는 숫자여야 합니다.');
  const cmid = Number(arg);
  // CLI 인자는 그대로 ASR argv 에 들어가므로 목록에 있는 이름만 받는다
  const parsed = asrLanguageSchema.safeParse(languageArg ?? DEFAULT_ASR_LANGUAGE);
  if (!parsed.success)
    throw new Error(
      `--language 는 auto 또는 다음 중 하나여야 합니다: ${asrLanguageSchema.options.slice(1).join(', ')}`
    );
  const language = parsed.data;
  const release = worker
    ? await adoptLock(TRANSCRIBE_LOCK_FILE)
    : await acquireLock(TRANSCRIBE_LOCK_FILE, TRANSCRIBE_BUSY);
  const controller = new AbortController();
  const stop = (signal: StopSignal) => {
    process.exitCode = SIGNAL_EXIT_CODES[signal];
    controller.abort();
  };
  for (const s of STOP_SIGNALS) process.once(s, stop);

  let meta: VodMeta | null = null;
  let current: Pick<TranscribeState, 'status' | 'phase' | 'progress' | 'path' | 'message'> = {
    status: 'running',
    phase: 'prepare',
    progress: null,
    path: null,
    message: null,
  };
  // 상태 쓰기는 같은 임시 파일을 쓰므로 차례로
  let writes = Promise.resolve();
  const save = (patch: Partial<typeof current>) => {
    current = { ...current, ...patch };
    const state = {
      version: 1 as const,
      ...current,
      cmid,
      course: meta?.course ?? null,
      title: meta?.title ?? null,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      language,
    };
    writes = writes.then(() => writeTranscribeState(state)).catch(() => {});
  };
  let logged = '';
  const report = (phase: Phase, progress: number | null) => {
    save({ phase, progress });
    const key = `${phase}:${progress === null ? '' : Math.floor(progress / 10)}`;
    if (worker || key === logged) return;
    logged = key;
    log(`[${PHASE_LABELS[phase]}]${progress === null ? '' : ` ${progress}%`}`);
  };

  // 잠금을 잡자마자 running 을 남긴다 — 이후 어디서 실패해도 error 로 바뀐다
  save({});
  // stop_transcribe 가 갱신이 끊긴 상태(죽은 작업·pid 재사용)와 구별할 수 있게 진행이 없어도 주기적으로 다시 쓴다
  const heartbeat = setInterval(() => save({}), TRANSCRIBE_HEARTBEAT_MS);
  let session = '';
  try {
    ({ session } = await getSession());
    const result = await transcribeVod(cmid, {
      findVod: async (id) => (meta = await findVod(createFetchHtml(session), id)),
      viewerHtml: (id) => viewerHtml(session, id),
      runtime: () => resolveAsrRuntime(undefined, language),
      fetch,
      spawn,
      root: storageRoot(),
      tmpDir: TRANSCRIBE_TMP_DIR,
      now: () => new Date(),
      report,
      signal: controller.signal,
    });
    const message = result.status === 'done' ? '녹취를 저장했습니다.' : '이미 녹취가 있어 건너뛰었습니다.';
    save({
      status: result.status,
      phase: null,
      progress: result.status === 'done' ? 100 : null,
      path: result.path,
      message,
    });
    if (!worker) log(`${message} ${result.path}`);
  } catch (err) {
    // Ctrl+C·종료 신호면 시그널 종료 코드를 그대로 둔다
    if (controller.signal.aborted) return save({ status: 'stopped', message: '중지했습니다.' });
    const message = redact(err instanceof Error ? err.message : String(err), [session]);
    save({ status: 'error', message });
    throw new Error(message);
  } finally {
    clearInterval(heartbeat);
    for (const s of STOP_SIGNALS) process.off(s, stop);
    await writes;
    await release();
  }
}
