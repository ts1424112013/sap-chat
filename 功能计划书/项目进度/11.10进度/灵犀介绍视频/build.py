# 生成 index.html：把标志、旁白脚本、配音时长填进 template.html
import json, re, pathlib
here = pathlib.Path(__file__).parent
logo = (here / '../../../../webapp/images/lingxi-mark.svg').resolve().read_text(encoding='utf8')
logo = re.sub(r'<title>.*?</title>', '', logo)
big = logo.replace('<svg ', '<svg class="logo" ', 1)
sm = logo.replace('lingxi-mark-', 'lx-sm-').replace('<svg ', '<svg ', 1)
tpl = (here / 'template.html').read_text(encoding='utf8')
script = json.loads((here / 'script.json').read_text(encoding='utf8'))
meta = json.loads((here / 'durations.json').read_text(encoding='utf8'))
if 'dur' not in meta:   # 旧格式：只有时长
    meta = {'ext': 'm4a', 'dur': meta}
dur = meta['dur']
# 小标志在每个窗口里重复出现：渐变 id 每处要唯一
n = [0]
def small(_):
    n[0] += 1
    return sm.replace('lx-sm-', f'lx{n[0]}-')
html = tpl.replace('{{LOGO}}', big, 1)
html = html.replace('{{LOGO}}', big.replace('lingxi-mark-', 'lingxi-end-'), 1)
html = re.sub(r'\{\{LOGO_SM\}\}', small, html)
html = html.replace('{{SCRIPT}}', json.dumps([{'id': s['id'], 'cap': s['cap']} for s in script], ensure_ascii=False))
html = html.replace('{{DUR}}', json.dumps(dur))
html = html.replace('{{EXT}}', meta['ext'])
(here / 'index.html').write_text(html, encoding='utf8')
print('index.html', len(html), '字符；小标志', n[0], '处')
