#!/usr/bin/env python3
"""
analyze_frames.py — vision-tool 帧缓冲区分析入口
接收图片帧目录，直接复用 vision_proxy 的并行多模型策略，跳过文件路径检查。
"""
import sys, os, io, concurrent.futures
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vision_proxy import (
    load_config, start_background_capability_refresh, _print_available_keys,
    _build_strategies, _has_key, _load_backend_memory,
    _filter_strategies_by_memory, _call_with_timeout,
    _record_backend_success, _record_backend_failure
)


def analyze_frames(frame_dir, prompt=""):
    supported = (".jpg", ".jpeg", ".png", ".webp")
    frame_files = sorted([
        os.path.join(frame_dir, f) for f in os.listdir(frame_dir)
        if f.lower().endswith(supported)
    ])
    if not frame_files:
        return "ERROR: No frame images found"

    frames = []
    for fp in frame_files:
        img = Image.open(fp)
        if img.mode != "RGB":
            img = img.convert("RGB")
        img.thumbnail((1024, 1024), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        frames.append((buf.getvalue(), "image/jpeg"))

    CFG = load_config()
    start_background_capability_refresh(reason="analyze_frames")
    _print_available_keys()

    prompt = prompt or (
        "Describe this video naturally — what's happening, what you see changing "
        "frame to frame. Cover the layout, any visible text or UI elements, "
        "colors, and scene transitions. Be thorough but conversational."
    )

    strategies = _build_strategies("vid", frames, prompt=prompt)
    strategies = [(n, f) for n, f in strategies if _has_key(n)]
    backend_memory = _load_backend_memory()
    strategies, _ = _filter_strategies_by_memory(strategies, backend_memory)

    if not strategies:
        raise RuntimeError("No vision backends available")

    first_success = None
    for name, fn in strategies[:2]:
        try:
            text = _call_with_timeout(fn, 30)
            if text and text.strip():
                _record_backend_success(backend_memory, name)
                first_success = text
                break
        except Exception as e:
            _record_backend_failure(backend_memory, name, e, str(e))

    if not first_success:
        remaining = strategies[2:]
        if remaining:
            pool = concurrent.futures.ThreadPoolExecutor(max_workers=len(remaining))
            futs = {pool.submit(lambda f=fn, n=name: (n, _call_with_timeout(f, 12))): name
                    for name, fn in remaining}
            try:
                for fut in concurrent.futures.as_completed(futs, timeout=25):
                    name = futs[fut]
                    try:
                        text = fut.result()[1]
                        if text and text.strip():
                            _record_backend_success(backend_memory, name)
                            first_success = text
                            break
                    except Exception as e:
                        _record_backend_failure(backend_memory, name, e, str(e))
            except concurrent.futures.TimeoutError:
                pass
            finally:
                pool.shutdown(wait=False, cancel_futures=True)

    if not first_success:
        raise RuntimeError("All vision backends failed")

    return first_success


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python analyze_frames.py <frame_dir> [prompt]", file=sys.stderr)
        sys.exit(1)
    frame_dir = sys.argv[1]
    prompt = sys.argv[2] if len(sys.argv) > 2 else ""
    try:
        result = analyze_frames(frame_dir, prompt)
        basename = os.path.basename(os.path.normpath(frame_dir))
        print(f"[{basename}]\n{result}")
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
