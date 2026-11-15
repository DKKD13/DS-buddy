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
        pg.get_by_text(NAME, exact=True).first.click(timeout=8000); time.sleep(3); mark('questions')
        glide(pg, [(560, 520), (560, 560), (560, 600)], 1.0); time.sleep(1.5)
        box = pg.locator('[contenteditable="true"]').first; box.click(timeout=8000); time.sleep(0.6); mark('typing')
        pg.keyboard.type('暖色。日期没错，就是 11 月 19 日周四下午 2 点。', delay=60); time.sleep(0.8); pg.keyboard.press('Enter'); mark('replied')
        before = {t['id'] for t in threads(pid)}; new = None
        for _ in range(80):
            time.sleep(3); new = next((t for t in threads(pid) if t['id'] not in before), None)
            if new: break
        mark('opened'); time.sleep(4)
        pg.get_by_text(new['title'], exact=True).first.click(timeout=8000); time.sleep(3); mark('task')
        guide(pg, '任务详情'); mark('board')
        for i in range(120):
            time.sleep(3); st = {t['id']: t['state'] for t in threads(pid)}
            if i % 4 == 0: glide(pg, [(1100, 260 + (i % 3) * 140)], 0.2)
            if st.get(new['id']) in ('review_ready', 'failed', 'blocked'): break
        mark('delivered'); time.sleep(3)
        guide(pg, '交付'); time.sleep(1.5)
        pg.locator('.mp4-dfile-main', has_text='invitation').first.click(timeout=8000); time.sleep(2.5); mark('preview')
        glide(pg, [(1100, 420), (1100, 560)], 0.8); pg.mouse.wheel(0, 300); time.sleep(3); pg.mouse.wheel(0, -300); time.sleep(1.5)
        btn = pg.get_by_role('button', name=re.compile('验收通过')).first; btn.hover(); time.sleep(1.2); btn.click(timeout=6000); mark('accepted'); time.sleep(4)
    except Exception as e: print('fail', str(e)[:200], flush=True); mark('fail')
    video = pg.video; ctx.close(); shutil.move(video.path(), OUT / 'take.webm')
print('DONE', json.dumps(marks, ensure_ascii=False), flush=True)
