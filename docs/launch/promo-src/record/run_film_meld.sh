#!/usr/bin/env bash
# One command: record the product film (PRODUCT_CN, default Tacit) in one take, cut three versions with Remotion, refresh docs/launch. Acts only in its own film project.
set -euo pipefail
S=$HOME/.local/state/mira-projects; REPO=$S/checkouts/claude-v4-dsh; L=$REPO/docs/launch; P=$HOME/promo-remotion/meld-promo; cd ~/promo-study
export PATH=$S/toolchains/node-v24.15.0-linux-x64/bin:$PATH
# The product name, from the environment: PRODUCT_CN=… PRODUCT_EN=… SLOGAN=… bash run_film_meld.sh
export PRODUCT_CN="${PRODUCT_CN:-Tacit}" PRODUCT_EN="${PRODUCT_EN:-Tacit}" SLOGAN="${SLOGAN:-交代一句，心领神会}"
python3 - "$P/src/brand.ts" <<PY
import json, os, sys
open(sys.argv[1], "w").write("// Written by run_film_meld.sh.\nexport const BRAND = " + json.dumps({"cn": os.environ["PRODUCT_CN"], "en": os.environ["PRODUCT_EN"], "slogan": os.environ["SLOGAN"]}, ensure_ascii=False) + " as const;\n")
PY
python3 cleanup_film.py
rm -f film_pid_meld2; rm -rf take_meld_all
python3 film_meld_all.py > film_meld_all.log 2>&1 || true
python3 -c "import json,sys; m=json.load(open('take_meld_all/marks.json')); sys.exit(0 if 'accepted' in m and 'fail' not in m else 2)" || { echo "take incomplete:"; tail -3 film_meld_all.log; exit 2; }
ffmpeg -loglevel error -y -i take_meld_all/take.webm -c:v libx264 -pix_fmt yuv420p -crf 18 -r 30 $P/public/take1.mp4
cp $P/public/take1.mp4 $P/public/take2.mp4
python3 - "$P" <<'PY'
import json, sys
m=json.load(open("take_meld_all/marks.json"))
m1={"inbox": m["inbox"], "typing": m["typing"]}
m2={"questions": m["questions"], "typing": m["answer"], "opened": m["opened"], "board": m["board"], "preview": m["preview"], "accepted": m["accepted"]}
open(sys.argv[1]+"/src/marks.ts","w").write("// Timestamps from the one-take recording (film_meld_all.py).\nexport const M1 = "+json.dumps(m1)+" as const;\nexport const M2 = "+json.dumps(m2)+" as const;\n")
PY
cd $P
npx remotion render MiraPromo out/meld-internal.mp4 --concurrency=8 > render.log 2>&1
npx remotion render MiraPromoPublic out/meld-public.mp4 --concurrency=8 >> render.log 2>&1
npx remotion render MiraPromoVertical out/meld-vertical.mp4 --concurrency=8 >> render.log 2>&1
rm -f $L/mira-promo.mp4 $L/mira-promo-vertical.mp4
cp out/meld-public.mp4 $L/meld-promo.mp4; cp out/meld-vertical.mp4 $L/meld-promo-vertical.mp4
ffmpeg -loglevel error -y -ss 31 -i out/meld-public.mp4 -frames:v 1 -vf scale=1600:-2 $L/poster.png
ffmpeg -loglevel error -y -ss 2.9 -t 14.4 -i out/meld-public.mp4 -vf "fps=8,scale=800:-2:flags=lanczos,palettegen=stats_mode=diff" /tmp/meld-pal.png
ffmpeg -loglevel error -y -ss 2.9 -t 14.4 -i out/meld-public.mp4 -i /tmp/meld-pal.png -lavfi "fps=8,scale=800:-2:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4" $L/demo.gif
cd ~/promo-study && python3 readme_shots_meld.py && python3 - "$L" <<'PY'
import json, os, subprocess, sys
from PIL import Image
L=sys.argv[1]
if os.path.exists("take_meld_all/card.png"): Image.open("take_meld_all/card.png").save(f"{L}/decision.png")
else:
    m=json.load(open("take_meld_all/marks.json")); subprocess.run(["ffmpeg","-loglevel","error","-y","-ss",f"{m['answer']+6:.2f}","-i","take_meld_all/take.webm","-frames:v","1","/tmp/ans.png"],check=True)
    im=Image.open("/tmp/ans.png"); w,h=im.size; im.crop((int(w*290/1440),0,int(w*850/1440),h)).save(f"{L}/decision.png")
PY
sed -i 's#docs/launch/mira-promo.mp4#docs/launch/meld-promo.mp4#g' $REPO/README.md
cp $P/src/Promo.tsx $P/src/Root.tsx $P/src/marks.ts $P/src/brand.ts $L/promo-src/remotion/src/; cp film_meld_all.py readme_shots_meld.py $L/promo-src/record/
ls -la $L | awk '{print $5, $9}'
echo FILM-DONE
