#!/usr/bin/env python3
import os
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: transcribe_local.py <audio_path> [model] [compute_type] [beam_size]", file=sys.stderr)
        return 2

    audio_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("AI_TERMINAL_WHISPER_MODEL", "tiny.en")
    compute_type = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("AI_TERMINAL_WHISPER_COMPUTE_TYPE", "int8")
    beam_size = int(sys.argv[4]) if len(sys.argv) > 4 else int(os.environ.get("AI_TERMINAL_WHISPER_BEAM_SIZE", "1"))

    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device="cpu", compute_type=compute_type)
    segments, _info = model.transcribe(
        audio_path,
        language="en",
        beam_size=beam_size,
        vad_filter=True,
    )
    text = " ".join(seg.text.strip() for seg in segments).strip()
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise
