import type { ElicitResult } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmDestructive, type Asker } from '../tools/confirm.js';

const withElicit = (result: ElicitResult) => {
  const elicit = vi.fn(async () => result);
  return { asker: { caps: { elicitation: { form: {} } }, elicit } satisfies Asker, elicit };
};
const noElicit: Asker = {
  caps: {},
  elicit: async () => {
    throw new Error('호출되면 안 됨');
  },
};
const req = (targets = ['/a', '/b'], token?: string) => ({ action: 'test', message: '지웁니다', targets, token });
const tokenOf = (text: string) => /confirmToken: "([0-9a-f]+)"/.exec(text)![1];
const issue = async () => tokenOf(((await confirmDestructive(noElicit, req())) as { text: string }).text);

afterEach(() => vi.useRealTimers());

describe('confirmDestructive — elicitation', () => {
  it('목록을 보여주고 accept + confirm=true 일 때만 승인한다', async () => {
    const { asker, elicit } = withElicit({ action: 'accept', content: { confirm: true } });
    expect(await confirmDestructive(asker, req())).toEqual({ ok: true });
    const [params] = elicit.mock.calls[0] as unknown as [{ message: string }];
    expect(params.message).toContain('- /a\n- /b');
    // 경고는 긴 목록 끝에 묻히지 않게 목록 앞에 둔다
    expect(params.message.indexOf('되돌릴 수 없습니다')).toBeGreaterThan(-1);
    expect(params.message.indexOf('되돌릴 수 없습니다')).toBeLessThan(params.message.indexOf('- /a'));
  });

  it.each<ElicitResult>([
    { action: 'decline' },
    { action: 'cancel' },
    { action: 'accept', content: { confirm: false } },
    { action: 'accept' },
  ])('%o 는 취소이고 토큰도 주지 않는다', async (result) => {
    const out = await confirmDestructive(withElicit(result).asker, req());
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain('confirmToken');
  });
});

describe('confirmDestructive — 조작 안내·기본값·취소 이유', () => {
  type Params = { message: string; requestedSchema: { properties: { confirm: { default: boolean } } } };
  const paramsOf = (elicit: ReturnType<typeof withElicit>['elicit']) =>
    (elicit.mock.calls[0] as unknown as [Params])[0];

  it('삭제는 체크가 꺼진 채로 띄우고 스페이스로 체크하라고 안내한다', async () => {
    const { asker, elicit } = withElicit({ action: 'cancel' });
    await confirmDestructive(asker, req());
    expect(paramsOf(elicit).requestedSchema.properties.confirm.default).toBe(false);
    expect(paramsOf(elicit).message).toContain('스페이스로 체크한 뒤 엔터: 승인');
  });

  it('삭제가 아닌 확인은 체크가 켜진 채로 띄워 엔터만으로 승인된다', async () => {
    const { asker, elicit } = withElicit({ action: 'accept', content: { confirm: true } });
    expect(await confirmDestructive(asker, { ...req(), kind: 'relocate' })).toEqual({ ok: true });
    expect(paramsOf(elicit).requestedSchema.properties.confirm.default).toBe(true);
    expect(paramsOf(elicit).message).toContain('엔터: 승인');
  });

  it.each<ElicitResult>([{ action: 'accept' }, { action: 'accept', content: {} }])(
    '기본값이 켜진 확인은 %o 처럼 confirm 필드가 없어도 기본값대로 승인한다',
    async (result) => {
      expect(await confirmDestructive(withElicit(result).asker, { ...req(), kind: 'relocate' })).toEqual({ ok: true });
    }
  );

  it('기본값이 켜진 확인도 명시적 confirm=false 는 취소한다', async () => {
    const out = await confirmDestructive(withElicit({ action: 'accept', content: { confirm: false } }).asker, {
      ...req(),
      kind: 'relocate',
    });
    expect(out).toEqual({ ok: false, text: expect.stringContaining('체크를 해제하고 제출했습니다') });
  });

  it.each<[ElicitResult, string]>([
    [{ action: 'decline' }, '거절을 눌렀습니다'],
    [{ action: 'cancel' }, '확인 창이 닫혔습니다'],
    [{ action: 'accept', content: { confirm: false } }, '스페이스로 체크한 뒤 엔터'],
    [{ action: 'accept' }, '체크하지 않고 제출했습니다'],
  ])('%o 는 취소 이유를 구분해 알린다', async (result, reason) => {
    const out = await confirmDestructive(withElicit(result).asker, req());
    expect(out).toEqual({ ok: false, text: expect.stringContaining(reason) });
  });
});

describe('confirmDestructive — 확인 창이 없는 클라이언트', () => {
  it('첫 호출은 목록과 토큰만 돌려주고, 같은 대상에 한 번만 쓸 수 있다', async () => {
    const first = await confirmDestructive(noElicit, req());
    expect(first.ok).toBe(false);
    const text = (first as { text: string }).text;
    expect(text).toContain('- /a\n- /b');
    const token = tokenOf(text);
    expect(await confirmDestructive(noElicit, req(['/b', '/a'], token))).toEqual({ ok: true });
    expect((await confirmDestructive(noElicit, req(['/a', '/b'], token))).ok).toBe(false);
  });

  it('틀린 토큰·다른 대상·다른 동작의 토큰은 거절하고, 거절된 토큰은 버린다', async () => {
    expect((await confirmDestructive(noElicit, req(['/a'], 'f'.repeat(64)))).ok).toBe(false);
    const token = await issue();
    expect((await confirmDestructive(noElicit, req(['/a', '/b', '/c'], token))).ok).toBe(false);
    expect((await confirmDestructive(noElicit, req(['/a', '/b'], token))).ok).toBe(false);
    const other = await issue();
    expect((await confirmDestructive(noElicit, { ...req(['/a', '/b'], other), action: 'other' })).ok).toBe(false);
  });

  it('만료된 토큰은 거절한다', async () => {
    vi.useFakeTimers();
    const token = await issue();
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect((await confirmDestructive(noElicit, req(['/a', '/b'], token))).ok).toBe(false);
  });
});

describe('confirmDestructive — 확인 창 요청 실패', () => {
  const failing = (err: Error): Asker => ({
    caps: { elicitation: { form: {} } },
    elicit: async () => {
      throw err;
    },
  });

  it('확인 창 요청이 실패하면(취소·시간 초과 등) 토큰 없이 그대로 던진다', async () => {
    await expect(confirmDestructive(failing(new Error('cancelled')), req())).rejects.toThrow('cancelled');
  });
});
