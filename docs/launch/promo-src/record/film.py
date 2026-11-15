"""One continuous take of a real Mira task, with timestamps for every beat. Acts only inside the film project it creates."""
import re, time, json, shutil, os, http.cookiejar, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
H = Path.home() / 'promo-study'; OUT = H / 'take'; OUT.mkdir(exist_ok=True)
TOKEN = re.findall(r'token=([A-Za-z0-9_-]+)', open(os.path.expanduser('~/.local/state/mira-projects/logs/v4-claude-web.log')).read())[-1]
BASE = 'http://127.0.0.1:18196/'; NAME = 'Mira 1.0 发布会'
api = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())); api.open(BASE + '?token=' + TOKEN, timeout=30).read()
def act(name, body):
    req = urllib.request.Request(BASE + 'api/mira-projects/action', data=json.dumps({'op': name, **body}).encode(), headers={'content-type': 'application/json'})
    return json.loads(api.open(req, timeout=120).read())
def threads(pid):
    st = json.loads(api.open(BASE + 'api/mira-projects/state', timeout=60).read()); p = next((x for x in st['projects'] if x['id'] == pid), {}) or {}
    return p.get('threads') or []
TASK = ('下周四下午 2 点，在上海西岸艺术中心发布 Mira 1.0。帮我准备两样东西：'
        '一页网页版邀请函 invitation.html（单文件、内联样式，写清时间、地点、三项议程和报名按钮，产品名就是 Mira 1.0，不要留任何占位符）；'
        '一份媒体问答 qa.md，8 个记者最可能问的问题和回答。邀请函的主色，开工前先问我：暖色还是冷色。')
pid = (H / 'film_pid').read_text().strip() if (H / 'film_pid').exists() else act('createProject', {'name': NAME, 'instructions': '宣传片拍摄用：Mira 1.0 发布会物料。'})['projectId']; (H / 'film_pid').write_text(pid)
for _ in range(24):
    time.sleep(5)
    st = json.loads(api.open(BASE + 'api/mira-projects/state', timeout=60).read())
    if (next((x for x in st['projects'] if x['id'] == pid), {}) or {}).get('icon'): break
marks = {}; T0 = None
def mark(k):
    marks[k] = round(time.time() - T0, 2); print(k, marks[k], flush=True); (OUT / 'marks.json').write_text(json.dumps(marks, ensure_ascii=False))
def guide(pg, label):
    pg.get_by_role('button', name='新标签页').first.click(timeout=6000); time.sleep(1.2)
    pg.get_by_text(label, exact=True).last.click(timeout=6000); time.sleep(1.5)
def glide(pg, pts, pause=0.7):
    for x, y in pts: pg.mouse.move(x, y, steps=30); time.sleep(pause)
with sync_playwright() as p:
    ctx = p.chromium.launch().new_context(viewport={'width': 1440, 'height': 900}, locale='zh-CN', timezone_id='Asia/Shanghai', record_video_dir=str(OUT / 'raw'), record_video_size={'width': 1440, 'height': 900})
    ctx.add_init_script("try{localStorage.setItem('dsh.locale','zh-CN')}catch(e){}")
    pg = ctx.new_page(); T0 = time.time()
    try:
        pg.goto(BASE + '?token=' + TOKEN, wait_until='load'); time.sleep(4)
        for _ in range(3):
            try: pg.get_by_role('button', name=re.compile('^(Continue|继续)$')).first.click(timeout=3000); time.sleep(1); break
            except Exception: time.sleep(1)
        pg.locator('[data-mira-entry]').first.click(timeout=8000); time.sleep(4); mark('ready')
        guide(pg, '待你决定'); mark('inbox'); glide(pg, [(1100, 140), (1100, 220), (1100, 300), (1100, 380)], 1.0); time.sleep(1)
        pg.get_by_text(NAME, exact=True).first.click(timeout=8000); time.sleep(3); mark('project')
        box = pg.locator('[contenteditable="true"]').first; box.click(timeout=8000); time.sleep(0.8); mark('typing')
        pg.keyboard.type(TASK, delay=35); time.sleep(0.8); pg.keyboard.press('Enter'); mark('sent')
        for k in range(60):
            time.sleep(3)
            if threads(pid): break
            if k == 30: print('no task from the composer; posting through the API', flush=True); act('post', {'projectId': pid, 'text': TASK})
        mark('tasks'); time.sleep(4)
        ts = threads(pid); first = next((t for t in ts if '邀请' in (t.get('title') or '')), ts[0])
        pg.get_by_text(first['title'], exact=True).first.click(timeout=8000); time.sleep(3); mark('task')
        guide(pg, '任务详情'); mark('board')
        asked = False
        for i in range(120):
            time.sleep(3); st = {t['id']: t['state'] for t in threads(pid)}
            if i % 5 == 0: glide(pg, [(1100, 300 + (i % 3) * 120)], 0.2)
            if not asked and st.get(first['id']) == 'blocked':
                mark('decision'); time.sleep(2)
                opt = pg.locator('.mp4-opt').first; opt.scroll_into_view_if_needed(timeout=5000); opt.hover(); time.sleep(1.2); opt.click(timeout=5000); mark('answered'); asked = True
            if st.get(first['id']) in ('review_ready', 'failed'): break
        mark('delivered'); time.sleep(2)
        guide(pg, '交付'); time.sleep(1.5)
        pg.locator('.mp4-dfile-main', has_text='invitation').first.click(timeout=8000); time.sleep(2); mark('preview')
        glide(pg, [(1100, 420), (1100, 560)], 0.8); pg.mouse.wheel(0, 260); time.sleep(3); pg.mouse.wheel(0, -260); time.sleep(1.5)
        btn = pg.get_by_role('button', name=re.compile('验收通过')).first; btn.hover(); time.sleep(1); btn.click(timeout=6000); mark('accepted'); time.sleep(4)
    except Exception as e: print('fail', str(e)[:200], flush=True); mark('fail')
    video = pg.video; ctx.close(); shutil.move(video.path(), OUT / 'take.webm')
print('DONE', json.dumps(marks, ensure_ascii=False), flush=True)
