# 사용법: python -I gpu_transcribe.py <model_dir> <language>
# stdin 의 16kHz mono s16le PCM 을 받아쓴 글을 stdout 에 쓴다 (dotbugi-mcp asr install --gpu 의 venv 에서 실행)
import sys

import numpy as np
import torch
from qwen_asr import Qwen3ASRModel
from qwen_asr.inference.utils import split_audio_into_chunks

SAMPLE_RATE = 16000


def main() -> None:
    model_dir, language = sys.argv[1], sys.argv[2]
    pcm = sys.stdin.buffer.read()
    wav = np.frombuffer(pcm[: len(pcm) // 2 * 2], dtype='<i2').astype(np.float32) / 32768.0
    if wav.size == 0:
        sys.exit('stdin 에 오디오가 없습니다.')
    model = Qwen3ASRModel.from_pretrained(
        model_dir, dtype=torch.bfloat16, device_map='cuda:0', max_inference_batch_size=8, max_new_tokens=4096
    )
    # 긴 오디오를 통째로 넣으면 내용이 빠진다 (POC CER 22~36%) — 무음 경계 기준 30초 청크로 나눠 넣는다
    chunks = split_audio_into_chunks(wav, SAMPLE_RATE, 30)
    results = model.transcribe(audio=[(c, SAMPLE_RATE) for c, _ in chunks], language=[language] * len(chunks))
    sys.stdout.write(' '.join(r.text for r in results) + '\n')


main()
