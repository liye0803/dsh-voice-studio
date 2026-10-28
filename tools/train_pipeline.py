r"""Voice Studio 训练流水线：切片 → 打标 → 预处理 → s1/s2 微调 → 权重入库。

用法（由插件宿主调用，也可以手动跑）：
  python train_pipeline.py --name yinlang2 --audio D:\x\a.wav --root D:\AI_Tools\dania-voice\gpt-sovits \
      --py ...venv\Scripts\python.exe --asrpy ...asr-venv\Scripts\python.exe --workdir ...\dataset\yinlang2 \
      [--steps all|prep|train] [--epochs1 8] [--epochs2 8]
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np


def say(msg):
    print(f"::step::{msg}", flush=True)


def run(cmd, cwd=None, env=None):
    print("$ " + " ".join(str(c) for c in cmd), flush=True)
    base = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1", TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD="1", TORCHAUDIO_SOUNDFILE_SHIM="1", PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True")
    if env:
        base.update(env)
    r = subprocess.run(cmd, cwd=cwd, env=base)
    if r.returncode != 0:
        raise SystemExit(f"命令失败（{r.returncode}）：{cmd[0]}")


def slice_audio(src: Path, out: Path, win=6.0):
    out.mkdir(parents=True, exist_ok=True)
    with wave.open(str(src), "rb") as w:
        sr, ch = w.getframerate(), w.getnchannels()
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        audio = audio.reshape(-1, ch).mean(axis=1)
    step = int(sr * win)
    idx, total = 0, 0.0
    for start in range(0, len(audio) - int(sr), step):
        seg = audio[start:start + step]
        if len(seg) < sr:
            continue
        if float(np.sqrt((seg ** 2).mean())) < 0.008:
            continue
        idx += 1
        with wave.open(str(out / f"{idx:04d}.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes((np.clip(seg, -1, 1) * 32767).astype(np.int16).tobytes())
        total += len(seg) / sr
    return idx, total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--root", required=True, help="gpt-sovits 目录")
    ap.add_argument("--py", required=True, help="主 venv 的 python")
    ap.add_argument("--asrpy", required=True, help="asr venv 的 python")
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--ref-text", default="")
    ap.add_argument("--steps", default="all")
    ap.add_argument("--name-template", default="{name}-e{epoch}")
    ap.add_argument("--version", default="v2ProPlus", choices=["v2ProPlus", "v2"])
    ap.add_argument("--epochs1", type=int, default=8)
    ap.add_argument("--epochs2", type=int, default=8)
    args = ap.parse_args()

    root = Path(args.root)
    PM = root / "GPT_SoVITS" / "pretrained_models"
    is_v2 = args.version == "v2"
    work = Path(args.workdir)
    sliced = work / "sliced"
    opt = work / "prep"
    name = args.name
    ref_text = args.ref_text or "你好，我是语音助手。"

    work.mkdir(parents=True, exist_ok=True)

    if args.steps in ("all", "prep"):
        say("切片")
        n, total = slice_audio(Path(args.audio), sliced)
        if n == 0:
            raise SystemExit("切片失败：没有可用音频")
        say(f"切片完成：{n} 段 / {total:.1f} 秒")
        if total < 20:
            raise SystemExit("素材太短（<20 秒），至少 1 分钟才训得动")

        say("打标")
        label_py = Path(__file__).with_name("label.py")
        run([args.asrpy, str(label_py), str(sliced), str(work / "list.txt"), str(Path(args.asrpy).parents[2] / "models" / "faster-whisper-medium"), name], cwd=str(root))

        say("预处理（文本 / hubert / 语义）")
        env = os.environ.copy()
        env.update({
            "inp_text": str(work / "list.txt"),
            "inp_wav_dir": str(sliced),
            "exp_name": name,
            "i_part": "0",
            "all_parts": "1",
            "opt_dir": str(opt),
            "bert_pretrained_dir": str(root / "GPT_SoVITS" / "pretrained_models" / "chinese-roberta-wwm-ext-large"),
            "cnhubert_base_dir": str(root / "GPT_SoVITS" / "pretrained_models" / "chinese-hubert-base"),
            "version": args.version,
            "is_half": "True",
            "pretrained_s2G": str(PM / ("gsv-v2final-pretrained/s2G2333k.pth" if is_v2 else "v2Pro/s2Gv2ProPlus.pth")),
            "s2config_path": str(root / "GPT_SoVITS" / "configs" / ("s2.json" if is_v2 else "s2v2ProPlus.json")),
            "sv_path": str(root / "GPT_SoVITS" / "pretrained_models" / "sv" / "pretrained_eres2netv2w24s4ep4.ckpt"),
        })
        scripts = ["1-get-text.py", "2-get-hubert-wav32k.py"] + ([] if is_v2 else ["2-get-sv.py"]) + ["3-get-semantic.py"]
        for script in scripts:
            run([args.py, str(root / "GPT_SoVITS" / "prepare_datasets" / script)], cwd=str(root), env=env)
        # 训练脚本期望的固定文件名
        txt = opt / "2-name2text-0.txt"
        if txt.exists():
            shutil.copyfile(txt, opt / "2-name2text.txt")
        say("预处理完成")

    if args.steps in ("all", "train"):
        semantic = opt / "6-name2semantic-0.tsv"
        phoneme = opt / "2-name2text.txt"
        if not semantic.exists() or not phoneme.exists():
            raise SystemExit("缺少预处理产物，先跑 --steps prep")

        say("训练 s1（GPT）")
        base_s1 = json.loads(json.dumps({}))  # placeholder, 从 yaml 模板读取
        s1_cfg = {
            "train": {
                "seed": 1234, "epochs": args.epochs1, "batch_size": 2, "save_every_n_epoch": 1,
                "precision": "16-mixed", "gradient_clip": 1.0,
                "if_save_latest": True, "if_save_every_weights": True,
                "half_weights_save_dir": str(root / "GPT_weights"),
                "exp_name": name,
            },
            "optimizer": {"lr": 0.01, "lr_init": 0.00001, "lr_end": 0.0001, "warmup_steps": 2000, "decay_steps": 40000},
            "data": {"max_eval_sample": 8, "max_sec": 54, "num_workers": 2, "pad_val": 1024},
            "model": {"vocab_size": 1025, "phoneme_vocab_size": 732, "embedding_dim": 512, "hidden_dim": 512,
                      "head": 16, "linear_units": 2048, "n_layer": 24, "dropout": 0, "EOS": 1024, "random_bert": 0},
            "inference": {"top_k": 15},
            "pretrained_s1": str(PM / ("gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt" if is_v2 else "s1v3.ckpt")),
            "train_semantic_path": str(semantic),
            "train_phoneme_path": str(phoneme),
            "output_dir": str(work / "logs_s1"),
        }
        cfg_file = work / f"s1_{name}.yaml"
        import yaml
        cfg_file.write_text(yaml.safe_dump(s1_cfg, allow_unicode=True, sort_keys=False), encoding="utf-8")
        env1 = dict(os.environ, MASTER_ADDR="127.0.0.1", MASTER_PORT="29560", _CUDA_VISIBLE_DEVICES="0", GLOO_SOCKET_IFNAME="WLAN")
        run([args.py, str(root / "GPT_SoVITS" / "s1_train.py"), "--config", str(cfg_file)], cwd=str(root), env=env1)

        say("训练 s2（SoVITS）")
        s2_tpl = json.loads((root / "GPT_SoVITS" / "configs" / ("s2.json" if is_v2 else "s2v2ProPlus.json")).read_text(encoding="utf-8"))
        s2_tpl["train"].update({
            "epochs": args.epochs2, "batch_size": 1, "gpu_numbers": "0", "segment_size": 10240, "grad_ckpt": True,
            "save_every_epoch": 1, "if_save_latest": True, "if_save_every_weights": True,
            "half_weights_save_dir": str(root / "SoVITS_weights"), "if_cache_data_in_gpu": False,
            "pretrained_s2G": str(PM / ("gsv-v2final-pretrained/s2G2333k.pth" if is_v2 else "v2Pro/s2Gv2ProPlus.pth")),
            "pretrained_s2D": str(root / "GPT_SoVITS" / "pretrained_models" / "v2Pro" / "s2Dv2ProPlus.pth"),
        })
        s2_tpl["model"]["version"] = args.version
        s2_tpl["data"]["exp_dir"] = str(opt)
        s2_tpl["s2_ckpt_dir"] = str(work / "logs_s2")
        s2_tpl["save_weight_dir"] = str(root / "SoVITS_weights")
        s2_tpl["name"] = name
        s2_tpl["version"] = args.version
        (opt / f"logs_s2_{args.version}").mkdir(parents=True, exist_ok=True)
        cfg2 = work / f"s2_{name}.json"
        cfg2.write_text(json.dumps(s2_tpl, indent=2, ensure_ascii=False), encoding="utf-8")
        run([args.py, str(root / "GPT_SoVITS" / "s2_train.py"), "--config", str(cfg2)], cwd=str(root))

        say("权重入库")
        try:
            import re
            gpts = sorted((root / "GPT_weights").glob(f"{name}*.ckpt"))
            sovs = sorted((root / "SoVITS_weights").glob(f"{name}*.pth"))
            for f in gpts:
                m = re.search(r"-e(\d+)", f.name)
                if not m:
                    continue
                stem = args.name_template.format(name=name, epoch=m.group(1))
                nf = f.with_name(stem + f.suffix)
                if nf != f:
                    f.rename(nf)
                if sovs:
                    s0 = sovs.pop(0)
                    ns = s0.with_name(stem + s0.suffix)
                    if ns != s0:
                        s0.rename(ns)
        except Exception as e:
            print("重命名失败（忽略）：", e)
        print("训练完成，权重在 GPT_weights / SoVITS_weights", flush=True)

    say("完成")


if __name__ == "__main__":
    main()
