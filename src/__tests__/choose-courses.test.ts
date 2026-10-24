import { describe, expect, it, vi } from 'vitest';
import type { Asker } from '../tools/confirm.js';
import { chooseCourses } from '../tools/courses.js';

const courses = [
  { courseId: '100', title: '자료구조', kind: '정규' as const, tracked: true, explicit: false },
  { courseId: '300', title: '비교과 활동', kind: '비교과' as const, tracked: false, explicit: false },
];
const withElicit = (result: Awaited<ReturnType<Asker['elicit']>>) => {
  const elicit = vi.fn(async () => result);
  return { asker: { caps: { elicitation: { form: {} } }, elicit } satisfies Asker, elicit };
};

describe('chooseCourses', () => {
  it('강좌별 체크박스를 현재 추적 상태를 기본값으로 띄운다', async () => {
    const { asker, elicit } = withElicit({ action: 'accept', content: { '100': true, '300': false } });
    await chooseCourses(asker, courses);
    const [params] = elicit.mock.calls[0] as unknown as [{ requestedSchema: { properties: object } }];
    expect(params.requestedSchema.properties).toEqual({
      '100': { type: 'boolean', title: '자료구조 · 정규', default: true },
      '300': { type: 'boolean', title: '비교과 활동 · 비교과', default: false },
    });
  });

  it('바뀐 강좌만 돌려주고 모르는 courseId·boolean 아닌 값은 무시한다', async () => {
    const { asker } = withElicit({ action: 'accept', content: { '100': true, '300': true, '999': true } });
    expect(await chooseCourses(asker, courses)).toEqual({ ok: true, changed: [courses[1]] });
    const { asker: odd } = withElicit({ action: 'accept', content: { '100': 'false' } });
    expect(await chooseCourses(odd, courses)).toEqual({ ok: true, changed: [] });
  });

  it('숫자가 아닌 courseId 는 폼 필드 키로 쓰지 않는다', async () => {
    const odd = { ...courses[0], courseId: '__proto__' };
    const { asker, elicit } = withElicit({ action: 'accept', content: { __proto__: false } });
    expect(await chooseCourses(asker, [odd, courses[1]])).toEqual({ ok: true, changed: [] });
    const [params] = elicit.mock.calls[0] as unknown as [{ requestedSchema: { properties: object } }];
    expect(Object.keys(params.requestedSchema.properties)).toEqual(['300']);
  });

  it('취소·거절이면 바꾸지 않는다', async () => {
    for (const action of ['cancel', 'decline'] as const) {
      const { asker } = withElicit({ action });
      expect(await chooseCourses(asker, courses)).toMatchObject({ ok: false });
    }
  });

  it('선택 창을 지원하지 않으면 null (폴백)', async () => {
    const elicit = vi.fn();
    expect(await chooseCourses({ caps: {}, elicit }, courses)).toBeNull();
    expect(elicit).not.toHaveBeenCalled();
  });
});
