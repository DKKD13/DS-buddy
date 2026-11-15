"""README screenshots from the film project only, cropped so no other project or private text shows."""
import re, time, os, json, http.cookiejar, urllib.request
from playwright.sync_api import sync_playwright
T = re.findall(r'token=([A-Za-z0-9_-]+)', open(os.path.expanduser('~/.local/state/mira-projects/logs/v4-claude-web.log')).read())[-1]
B = 'http://127.0.0.1:18196/'; PID = open(os.path.expanduser('~/promo-study/film_pid')).read().strip()
L = os.path.expanduser('~/.local/state/mira-projects/checkouts/claude-v4-dsh/docs/launch')
api = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())); api.open(B + '?token=' + T, timeout=30).read()
th = next(x for x in json.loads(api.open(B + 'api/mira-projects/state', timeout=60).read())['projects'] if x['id'] == PID)['threads']
inv = next(t for t in th if '邀请' in t['title'])
def guide(pg, label):
    pg.get_by_role('button', name='新标签页').first.click(timeout=6000); time.sleep(1.2); pg.get_by_text(label, exact=True).last.click(timeout=6000); time.sleep(2)
with sync_playwright() as p:
    pg = p.chromium.launch().new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=2, locale='zh-CN')
    pg.goto(B + '?token=' + T, wait_until='load'); time.sleep(4)
    try: pg.get_by_role('button', name=re.compile('^(Continue|继续)$')).first.click(timeout=3000)
    except Exception: pass
    pg.locator('[data-mira-entry]').first.click(timeout=8000); time.sleep(4)
    pg.get_by_text('Mira 1.0 发布会', exact=True).first.click(timeout=8000); time.sleep(4)
    pg.mouse.move(5, 5); pg.screenshot(path=f'{L}/clarify.png', clip={'x': 290, 'y': 0, 'width': 520, 'height': 900})
    pg.get_by_text(inv['title'], exact=True).first.click(timeout=8000); time.sleep(4)
    guide(pg, '任务详情'); pg.mouse.move(5, 5); time.sleep(1)
    box = pg.locator('.mp4-tabpane').last.bounding_box() or {'x': 820}
    x0 = max(700, int(box['x']) - 8); pg.screenshot(path=f'{L}/task-board.png', clip={'x': x0, 'y': 0, 'width': 1440 - x0, 'height': 900})
    guide(pg, '交付'); pg.locator('.mp4-dfile-main', has_text='invitation').first.click(timeout=8000); time.sleep(3); pg.mouse.move(5, 5)
    pg.screenshot(path=f'{L}/delivery.png', clip={'x': x0, 'y': 0, 'width': 1440 - x0, 'height': 900})
print('ok')
