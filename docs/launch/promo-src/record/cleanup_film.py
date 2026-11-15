"""Before a new take: put earlier 「<PRODUCT_CN> 1.0 发布会」 film projects in the trash; if one still waits on a question card, abandon the card first."""
import http.cookiejar, urllib.request, json, re, os, time
from playwright.sync_api import sync_playwright
T=re.findall(r"token=([A-Za-z0-9_-]+)", open(os.path.expanduser("~/.local/state/mira-projects/logs/v4-claude-web.log")).read())[-1]; B="http://127.0.0.1:18196/"; NAME=os.environ.get("PRODUCT_CN", "Tacit")+" 1.0 发布会"
op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())); op.open(B+"?token="+T, timeout=30).read()
def ids(): return [x["id"] for x in json.loads(op.open(B+"api/mira-projects/state", timeout=60).read())["projects"] if x["name"]==NAME]
def trash(pid):
    req=urllib.request.Request(B+"api/mira-projects/action", data=json.dumps({"op":"deleteProject","projectId":pid}).encode(), headers={"content-type":"application/json"})
    try: return json.loads(op.open(req, timeout=60).read()).get("ok")
    except urllib.error.HTTPError as e: return e.read().decode()[:120]
for pid in ids():
    r=trash(pid)
    if r is True: print("trashed", pid); continue
    print("busy", pid, r)
    with sync_playwright() as p:
        pg=p.chromium.launch().new_page(viewport={"width":1440,"height":900}, locale="zh-CN")
        pg.goto(B+"?token="+T, wait_until="load"); time.sleep(4)
        try: pg.get_by_role("button", name=re.compile("^(Continue|继续)$")).first.click(timeout=3000)
        except Exception: pass
        pg.locator("[data-mira-entry]").first.click(timeout=8000); time.sleep(4)
        pg.get_by_text(NAME, exact=True).first.click(timeout=8000); time.sleep(4)
        try: pg.get_by_role("button", name="放弃整组问题").first.click(timeout=5000); print("abandoned the card")
        except Exception as e: print("no card", str(e)[:60])
    for _ in range(30):
        time.sleep(4); r=trash(pid)
        if r is True: print("trashed", pid); break
    else: print("still busy", pid, r)
