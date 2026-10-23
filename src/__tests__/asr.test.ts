import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { download } from '../asr/download.js';
import { installAsr, missingCpuFlags, parseInstallOptions } from '../asr/install.js';
import { isAllowedDownloadUrl, MODELS, QWEN_ASR_BINARY, UNPINNED } from '../asr/pins.js';
import { asrConfigSchema, asrPaths, GPU_SCRIPT, modelFilePath, resolveAsrRuntime } from '../asr/runtime.js';
import { extractZipEntry } from '../asr/zip.js';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const pin = (sha256: string, maxBytes = 1000) => ({ sha256, maxBytes });

let root: string;
beforeEach(async () => void (root = await mkdtemp(join(tmpdir(), 'asr-'))));
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe('설치 옵션', () => {
  it('CPU 는 0.6b 고정', () => {
    expect(parseInstallOptions({})).toEqual({ runtime: 'cpu', model: '0.6b' });
    expect(parseInstallOptions({ gpu: true, model: '1.7b' })).toEqual({ runtime: 'gpu', model: '1.7b' });
    expect(parseInstallOptions({ gpu: true })).toEqual({ runtime: 'gpu', model: '0.6b' });
  });

  it('--gpu 없는 --model, 모르는 모델은 거부', () => {
    expect(() => parseInstallOptions({ model: '0.6b' })).toThrow('--gpu');
    expect(() => parseInstallOptions({ gpu: true, model: '7b' })).toThrow('0.6b 또는 1.7b');
  });

  it('설정 스키마는 CPU+1.7b·모르는 키를 거부', () => {
    expect(asrConfigSchema.safeParse({ runtime: 'cpu', model: '1.7b' }).success).toBe(false);
    expect(asrConfigSchema.safeParse({ runtime: 'gpu', model: '1.7b', x: 1 }).success).toBe(false);
    expect(asrConfigSchema.safeParse({ runtime: 'gpu', model: '1.7b' }).success).toBe(true);
  });
});

describe('download', () => {
  const url = 'https://huggingface.co/x/resolve/r/f';
  const body = 'hello asr';

  it('sha256 이 다르면 버리고 실패 (dest·.part 남기지 않음)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body))
    );
    await expect(download(url, join(root, 'f'), pin(sha('other')), 'f')).rejects.toThrow('sha256');
    expect(await readdir(root)).toEqual([]);
  });

  it('맞으면 dest 에 쓰고, 다음에는 받지 않는다', async () => {
    const fetchMock = vi.fn(async () => new Response(body));
    vi.stubGlobal('fetch', fetchMock);
    await download(url, join(root, 'f'), pin(sha(body)), 'f');
    await download(url, join(root, 'f'), pin(sha(body)), 'f');
    expect(await readFile(join(root, 'f'), 'utf8')).toBe(body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('.part 를 Range 로 이어 받는다', async () => {
    await writeFile(join(root, 'f.part'), body.slice(0, 4));
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(body.slice(4), { status: 206, headers: { 'content-range': `bytes 4-8/${body.length}` } })
    );
    vi.stubGlobal('fetch', fetchMock);
    await download(url, join(root, 'f'), pin(sha(body)), 'f');
    expect(await readFile(join(root, 'f'), 'utf8')).toBe(body);
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ range: 'bytes=4-' });
  });

  it('크기 상한을 넘으면 받다가 끊고 버린다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body))
    );
    await expect(download(url, join(root, 'f'), pin(sha(body), 4), 'f')).rejects.toThrow('크기');
    expect(await readdir(root)).toEqual([]);
  });

  it('응답이 멈추면 시간 제한으로 끊는다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchMock = vi.fn(
      (_u: URL, init: RequestInit) =>
        new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    );
    vi.stubGlobal('fetch', fetchMock);
    const pending = expect(download(url, join(root, 'f'), pin(sha(body)), 'f')).rejects.toThrow('멈춰');
    while (!fetchMock.mock.calls.length) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    vi.useRealTimers();
  });

  it('고정값이 없거나, 허용 밖 호스트·http·리다이렉트는 거부', async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/f' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(download(url, join(root, 'f'), pin(UNPINNED), 'f')).rejects.toThrow('고정되지 않아');
    await expect(download('https://evil.example/f', join(root, 'f'), pin(sha(body)), 'f')).rejects.toThrow(
      '허용되지 않은'
    );
    await expect(download(url, join(root, 'f'), pin(sha(body)), 'f')).rejects.toThrow('허용되지 않은');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(isAllowedDownloadUrl(new URL('http://huggingface.co/x'))).toBe(false);
    expect(isAllowedDownloadUrl(new URL('https://huggingface.co.evil.example/x'))).toBe(false);
    expect(isAllowedDownloadUrl(new URL('https://us.aws.cdn.hf.co/x'))).toBe(true);
  });
});

const supported =
  (process.platform === 'linux' && process.arch === 'x64') ||
  (process.platform === 'darwin' && process.arch === 'arm64');

describe.skipIf(!supported)('installAsr', () => {
  it('qwen_asr 고정값이 비어 있으면 아무것도 받지 않고 거부', async () => {
    const platform = process.platform === 'darwin' ? 'macos-arm64' : 'linux-x64';
    const pin = QWEN_ASR_BINARY[platform];
    const saved = pin.sha256;
    pin.sha256 = UNPINNED;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(installAsr({ runtime: 'cpu', model: '0.6b' }, join(root, 'asr'))).rejects.toThrow('고정되지 않아');
    } finally {
      pin.sha256 = saved;
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
});

describe('CPU 기능 확인', () => {
  it('x86-64-v3 플래그가 빠지면 알려 준다', () => {
    const v3 = 'flags\t\t: fpu sse2 avx avx2 fma bmi1 bmi2 abm movbe f16c\n';
    expect(missingCpuFlags(v3)).toEqual([]);
    expect(missingCpuFlags('flags\t\t: fpu sse2 avx avx2 fma\n')).toEqual(['bmi1', 'bmi2', 'abm', 'movbe', 'f16c']);
    expect(missingCpuFlags('')).toHaveLength(7);
  });
});

describe('경로', () => {
  it('모델 파일 이름이 폴더 밖을 가리키면 거부', () => {
    expect(() => modelFilePath(root, '0.6b', '../config.json')).toThrow();
    expect(() => modelFilePath(root, '0.6b', '..')).toThrow();
    for (const model of Object.keys(MODELS) as (keyof typeof MODELS)[])
      for (const f of Object.keys(MODELS[model].files)) expect(() => modelFilePath(root, model, f)).not.toThrow();
  });
});

describe('resolveAsrRuntime', () => {
  const install = async (config: object, files: string[]) => {
    await mkdir(join(root, 'bin'), { recursive: true });
    await writeFile(asrPaths(root).config, JSON.stringify(config));
    for (const f of files) {
      await mkdir(join(f, '..'), { recursive: true });
      await writeFile(f, '');
    }
  };
  const modelFiles = (m: '0.6b' | '1.7b') => Object.keys(MODELS[m].files).map((f) => modelFilePath(root, m, f));

  it('설치 전·설정 오류·파일 누락이면 asr install 안내', async () => {
    await expect(resolveAsrRuntime(root)).rejects.toThrow('dotbugi-mcp asr install');
    await install({ runtime: 'cpu', model: '1.7b' }, []);
    await expect(resolveAsrRuntime(root)).rejects.toThrow('형식이 올바르지 않습니다');
    await writeFile(asrPaths(root).config, '{');
    await expect(resolveAsrRuntime(root)).rejects.toThrow('형식이 올바르지 않습니다');
    await install({ runtime: 'cpu', model: '0.6b' }, [asrPaths(root).ffmpeg]);
    await expect(resolveAsrRuntime(root)).rejects.toThrow('파일이 없습니다');
  });

  it('CPU: qwen_asr 를 stdin 30초 청크로', async () => {
    const p = asrPaths(root);
    await install({ runtime: 'cpu', model: '0.6b' }, [p.ffmpeg, p.qwenAsr, ...modelFiles('0.6b')]);
    const rt = await resolveAsrRuntime(root);
    expect(rt).toMatchObject({ ffmpeg: p.ffmpeg, kind: 'cpu', command: p.qwenAsr, model: '0.6b' });
    expect(rt.args).toEqual(expect.arrayContaining(['--stdin', '-S', '30', '--silent', '-t']));
    expect(rt.args.slice(0, 2)).toEqual(['-d', join(p.models, '0.6b')]);
    expect(rt.env).toEqual({ OPENBLAS_NUM_THREADS: '1' });
  });

  it('GPU: venv python -I + 동봉 스크립트, 오프라인', async () => {
    const p = asrPaths(root);
    await install({ runtime: 'gpu', model: '1.7b' }, [p.ffmpeg, p.venvPython, ...modelFiles('1.7b')]);
    expect(await resolveAsrRuntime(root)).toEqual({
      ffmpeg: p.ffmpeg,
      kind: 'gpu',
      command: p.venvPython,
      args: ['-I', GPU_SCRIPT, join(p.models, '1.7b'), 'Korean'],
      model: '1.7b',
      env: { HF_HUB_OFFLINE: '1' },
    });
  });
});

describe('extractZipEntry', () => {
  // 최소 zip 작성기 (deflate 항목 하나)
  const makeZip = (name: string, data: Buffer) => {
    const comp = deflateRawSync(data);
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    const cdOffset = 30 + n.length + comp.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cdOffset, 16);
    return Buffer.concat([local, n, comp, central, n, eocd]);
  };

  it('이름이 같은 항목을 꺼내고, 없으면 실패', () => {
    const zip = makeZip('pkg/bin/ffmpeg', Buffer.from('binary'.repeat(100)));
    expect(extractZipEntry(zip, 'pkg/bin/ffmpeg').toString()).toBe('binary'.repeat(100));
    expect(() => extractZipEntry(zip, 'other')).toThrow('없습니다');
  });
});
