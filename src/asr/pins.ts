// asr install 이 받는 모든 파일의 출처·해시. 여기 적힌 sha256 과 일치하지 않으면 설치·실행하지 않는다

export type AsrPlatform = 'linux-x64' | 'macos-arm64';
export type AsrModel = '0.6b' | '1.7b';

// asr-binaries.yml 첫 실행 전이라 아직 값이 없다는 표시. 이 값이면 install 이 거부한다
export const UNPINNED = 'UNPINNED';

// .github/workflows/asr-binaries.yml 이 antirez/qwen-asr@924694251d9e0f18e5d86bbd06aa3ab5f870002d 를 빌드해 올린 Release.
// 채우는 법: 워크플로를 태그 asr-v1 로 실행 → Release 의 SHA256SUMS 값을 아래 sha256 에 붙여 넣는다
const QWEN_ASR_RELEASE = 'https://github.com/hs-shell/dotbugi-mcp/releases/download/asr-v1';
export const QWEN_ASR_BINARY: Record<AsrPlatform, { url: string; sha256: string }> = {
  'linux-x64': { url: `${QWEN_ASR_RELEASE}/qwen_asr-linux-x64`, sha256: UNPINNED },
  'macos-arm64': { url: `${QWEN_ASR_RELEASE}/qwen_asr-macos-arm64`, sha256: UNPINNED },
};

// 정적 ffmpeg: PyPI imageio-ffmpeg 0.6.0 휠(sha256 = PyPI 공시값) 안의 바이너리. 휠과 꺼낸 바이너리를 각각 검증한다
export const FFMPEG: Record<AsrPlatform, { url: string; sha256: string; entry: string; entrySha256: string }> = {
  'linux-x64': {
    url: 'https://files.pythonhosted.org/packages/a0/2d/43c8522a2038e9d0e7dbdf3a61195ecc31ca576fb1527a528c877e87d973/imageio_ffmpeg-0.6.0-py3-none-manylinux2014_x86_64.whl',
    sha256: 'c7e46fcec401dd990405049d2e2f475e2b397779df2519b544b8aab515195282',
    entry: 'imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2',
    entrySha256: 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99',
  },
  'macos-arm64': {
    url: 'https://files.pythonhosted.org/packages/40/5c/f3d8a657d362cc93b81aab8feda487317da5b5d31c0e1fdfd5e986e55d17/imageio_ffmpeg-0.6.0-py3-none-macosx_11_0_arm64.whl',
    sha256: 'b1ae3173414b5fc5f538a726c4e48ea97edc0d2cdc11f103afee655c463fa742',
    entry: 'imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1',
    entrySha256: '6d175a4743ca50256e89a8cdd731100f9cee33bd79aeea46894d209410dc6617',
  },
};

const COMMON_MODEL_FILES = {
  'chat_template.json': '75a8cfca24f00de72d796fbfed6858fc9614ef3dabd8696684cc3bc03a9c58ff',
  'generation_config.json': '1da527824d81e07118facff437e03f2e24a23311e3bdeb2368973fe77e5f275c',
  'merges.txt': '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5',
  'preprocessor_config.json': '45e120a4eda2c20c5d7f2ea9354e63536bf35e27aa573fb7cdf78017b378770d',
  'tokenizer_config.json': '4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c',
  'vocab.json': 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910',
};

// Hugging Face 리비전(커밋) 고정. 파일 sha256 은 그 리비전에서 받은 내용 (LFS 파일은 HF 가 공시한 oid 와 같다)
export const MODELS: Record<AsrModel, { repo: string; revision: string; files: Record<string, string> }> = {
  '0.6b': {
    repo: 'Qwen/Qwen3-ASR-0.6B',
    revision: '5eb144179a02acc5e5ba31e748d22b0cf3e303b0',
    files: {
      ...COMMON_MODEL_FILES,
      'config.json': '76d3ae4601ce939830b2517f4a6cadb86cc51316c3900af6b020b051c21a478c',
      'model.safetensors': '79d6cbd4c98c7bbffe9db2edac07f56cd6637d0d5944b27f6c2b8353840323ea',
    },
  },
  '1.7b': {
    repo: 'Qwen/Qwen3-ASR-1.7B',
    revision: '7278e1e70fe206f11671096ffdd38061171dd6e5',
    files: {
      ...COMMON_MODEL_FILES,
      'config.json': '2e74a751548b8ad7d7526d29365ad8144c345d8b412b1152d25dc6698452712f',
      'model.safetensors.index.json': 'f994739fe38e5210b9e3e8ce6c6307315e2ceac3cb630e7b7414d69dce520f60',
      'model-00001-of-00002.safetensors': 'a4cd1f1a04d90b757dc7f7dd26254e69a013b19e80efe590a83c6a3bde8608d6',
      'model-00002-of-00002.safetensors': '6e0b9d9e09e2e0238e7ef3cc8a484ab387e91b90f1900bedf88bc92d7929ccfc',
    },
  },
};

export const modelFileUrl = (model: AsrModel, file: string) =>
  `https://huggingface.co/${MODELS[model].repo}/resolve/${MODELS[model].revision}/${file}`;

// GPU venv 의 Python. 패키지는 해시가 고정된 gpu-requirements.txt 로만 설치한다
export const GPU_PYTHON_VERSION = '3.12';
export const PYPI_INDEX = 'https://pypi.org/simple';

// 내려받기는 https 로 이 호스트들만. 앞 셋이 출발지, 나머지는 이들이 넘겨주는 CDN
const DOWNLOAD_HOSTS = new Set([
  'github.com',
  'huggingface.co',
  'files.pythonhosted.org',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
]);
const DOWNLOAD_HOST_SUFFIXES = ['.hf.co'];

export function isAllowedDownloadUrl(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return DOWNLOAD_HOSTS.has(url.hostname) || DOWNLOAD_HOST_SUFFIXES.some((s) => url.hostname.endsWith(s));
}
