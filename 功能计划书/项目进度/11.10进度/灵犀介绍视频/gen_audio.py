# 重新生成配音：改了 script.json 的 say 文字后运行 python3 gen_audio.py，再运行 python3 build.py
# 默认用微软神经配音（edge-tts，需联网，把旁白文字发到微软语音服务；安装：python3 -m pip install --user edge-tts）
# 不能联网时：python3 gen_audio.py --mac  改用 macOS 自带的婷婷（机械一些）
import asyncio, json, pathlib, subprocess, sys

here = pathlib.Path(__file__).parent
VOICE = "zh-CN-YunyangNeural"   # 云扬（播音男声）；晓晓 zh-CN-XiaoxiaoNeural / 晓伊 zh-CN-XiaoyiNeural / 云希 zh-CN-YunxiNeural
RATE = "-4%"                     # 语速：负数更慢
MAC = "--mac" in sys.argv
script = json.loads((here / "script.json").read_text(encoding="utf8"))
audio = here / "audio"
audio.mkdir(exist_ok=True)
ext = "m4a" if MAC else "mp3"
for old in audio.glob("*.*"):
    old.unlink()

async def edge():
    import edge_tts
    for s in script:
        await edge_tts.Communicate(s["say"], VOICE, rate=RATE).save(str(audio / f"{s['id']}.mp3"))

if MAC:
    for s in script:
        aiff = audio / f"{s['id']}.aiff"
        subprocess.run(["say", "-v", "Tingting", "-r", "180", "-o", str(aiff), s["say"]], check=True)
        subprocess.run(["afconvert", "-f", "m4af", "-d", "aac@44100", str(aiff), str(audio / f"{s['id']}.m4a")], check=True)
        aiff.unlink()
else:
    asyncio.run(edge())

dur = {}
for s in script:
    info = subprocess.run(["afinfo", str(audio / f"{s['id']}.{ext}")], capture_output=True, text=True).stdout
    dur[s["id"]] = round(float([l for l in info.splitlines() if "estimated duration" in l][0].split(":")[1].split()[0]), 2)
(here / "durations.json").write_text(json.dumps({"ext": ext, "voice": "Tingting" if MAC else VOICE, "dur": dur}), encoding="utf8")
print(dur, "合计", round(sum(dur.values()), 1), "秒", "(" + ext + ")")
