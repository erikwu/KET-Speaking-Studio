import argparse
import contextlib
import glob
import json
import os
import sys
import traceback


def send(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    os.makedirs(args.output, exist_ok=True)

    try:
        with contextlib.redirect_stdout(sys.stderr):
            from mlx_audio.tts.generate import generate_audio
            from mlx_audio.tts.utils import load_model

            model = load_model(model_path=args.model)
        send({"type": "ready"})
    except Exception as error:
        send({"type": "fatal", "error": f"加载 MLX 模型失败：{error}"})
        traceback.print_exc(file=sys.stderr)
        return 1

    for raw in sys.stdin:
        try:
            request = json.loads(raw)
            request_id = request["id"]
            prefix = os.path.join(args.output, request_id)
            for stale in glob.glob(prefix + "_*.wav"):
                os.unlink(stale)
            with contextlib.redirect_stdout(sys.stderr):
                generate_audio(
                    text=request["text"],
                    model=model,
                    instruct=request.get("instruct") or None,
                    lang_code=request.get("language", "English"),
                    output_path=args.output,
                    file_prefix=request_id,
                    audio_format="wav",
                    verbose=False,
                    speed=0.95,
                )
            outputs = sorted(glob.glob(prefix + "_*.wav"))
            if not outputs:
                raise RuntimeError("模型没有生成音频文件。")
            send({"id": request_id, "ok": True, "fileName": os.path.basename(outputs[0])})
        except Exception as error:
            send({"id": request.get("id", "") if "request" in locals() else "", "ok": False, "error": str(error)})
            traceback.print_exc(file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())

