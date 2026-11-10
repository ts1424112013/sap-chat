# 重新生成配音：改了 script.json 的 say 文字后运行 python3 gen_audio.py，再运行 python3 build.py
# 用 macOS 自带的 say（婷婷，普通话女声）+ afconvert，不需要装任何东西
import json, pathlib, subprocess

here = pathlib.Path(__file__).parent
VOICE, RATE = "Tingting", "190"   # 语速：数字越大越快
script = json.loads((here / "script.json").read_text(encoding="utf8"))
(here / "audio").mkdir(exist_ok=True)
dur = {}
for s in script:
    aiff, m4a = here / "audio" / f"{s['id']}.aiff", here / "audio" / f"{s['id']}.m4a"
    subprocess.run(["say", "-v", VOICE, "-r", RATE, "-o", str(aiff), s["say"]], check=True)
    subprocess.run(["afconvert", "-f", "m4af", "-d", "aac@44100", str(aiff), str(m4a)], check=True)
    info = subprocess.run(["afinfo", str(m4a)], capture_output=True, text=True).stdout
    dur[s["id"]] = round(float([l for l in info.splitlines() if "estimated duration" in l][0].split(":")[1].split()[0]), 2)
    aiff.unlink()
(here / "durations.json").write_text(json.dumps(dur), encoding="utf8")
print(dur, "合计", round(sum(dur.values()), 1), "秒")
