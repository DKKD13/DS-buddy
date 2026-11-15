#!/usr/bin/env bash
# 把 r31 的 mira-projects 插件装进你 Mac 上原来的目录，然后起一个试用的 DSH。
#
#   cd ~/Downloads && unzip -o dsh-mira-projects-r31.zip && bash dsh-mira-projects-r31/install-mac.sh
#
# 装到哪：~/Documents/daimon-multica/dsh-plugin/mira-projects（换地方：DST=/别的/路径 bash install-mac.sh）
# 做什么：先把旧的 lib/ test/ qa/ dev/ 打成一个 backup-*.tgz 放在原目录里，再用 r31 覆盖；
#        qa/run-* 里的历史验收产物不动；不碰 node_modules；最后调用 dev/start-mac.sh 启动。
set -euo pipefail
SRC="$(cd "$(dirname "$0")/../plugin" && pwd)"   # 仓库里插件在 plugin/
DST="${DST:-$HOME/Documents/daimon-multica/dsh-plugin/mira-projects}"
mkdir -p "$DST"
if [ -d "$DST/lib" ]; then
  B="$DST/backup-before-r31-$(date +%Y%m%d-%H%M%S).tgz"
  (cd "$DST" && tar -czf "$B" --exclude='qa/run-*' --exclude='qa/node_modules' --exclude='qa/try' lib test qa dev README.md package.json cordis.patch.yml 2>/dev/null) || true
  echo "旧代码已备份：$B"
fi
rm -rf "$DST/lib" "$DST/test" "$DST/dev"
cp -R "$SRC/lib" "$SRC/test" "$SRC/dev" "$DST/"
mkdir -p "$DST/qa"
find "$SRC/qa" -maxdepth 1 -type f -exec cp {} "$DST/qa/" \;
cp "$SRC/README.md" "$SRC/package.json" "$SRC/cordis.patch.yml" "$DST/"
chmod +x "$DST/dev/start-mac.sh" "$DST/qa/run-all.sh" 2>/dev/null || true
if command -v node >/dev/null; then (cd "$DST" && node --check lib/index.js && echo "语法检查通过（lib/index.js）"); fi
echo "r31 已装到 $DST"
echo "现在启动试用的 DSH（profile mira-qa，端口 18180）……"
exec bash "$DST/dev/start-mac.sh"
