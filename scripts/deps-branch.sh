#!/usr/bin/env bash
# 依赖压缩包放在单独的 deps 分支（只有 deps/ 目录，没有代码），main 不存压缩包。
#
#   scripts/deps-branch.sh check            看哪个 package-lock.json 比 deps 分支里的压缩包新
#   scripts/deps-branch.sh update [--push]  把有变化的 node_modules 重新打包，提交到 deps 分支（--push 顺便推送）
#   scripts/deps-branch.sh fetch            从远端取压缩包和说明到本地 deps/（main 里没有这个目录，已忽略）
#
# update 打包的是本机现在的 node_modules：先在对应目录 npm ci，再运行。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BRANCH=deps
# 名字|目录|压缩包
PARTS=(
  "root|.|deps/node_modules-root.zip"
  "test-server|test-server|deps/node_modules-test-server.zip"
  "agent-bundle|agent-bundle|deps/node_modules-agent-bundle.zip"
  "local-mcp|local-mcp|deps/node_modules-local-mcp.zip"
)

lock_of() { [ "$1" = "." ] && echo package-lock.json || echo "$1/package-lock.json"; }
mods_of() { [ "$1" = "." ] && echo node_modules || echo "$1/node_modules"; }

# deps 分支里记的锁文件哈希（优先本地分支，没有就用远端）
branch_ref() {
  if git rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null; then echo "$BRANCH"
  elif git rev-parse -q --verify "refs/remotes/origin/$BRANCH" >/dev/null; then echo "origin/$BRANCH"
  else echo ""; fi
}
recorded() {  # $1 = 名字
  local ref; ref=$(branch_ref)
  [ -n "$ref" ] || return 0
  git show "$ref:deps/LOCKS.txt" 2>/dev/null | awk -v n="$1" '$1==n {print $2}'
}

changed_parts() {
  for p in "${PARTS[@]}"; do
    IFS='|' read -r name dir zip <<<"$p"
    local now; now=$(git hash-object "$(lock_of "$dir")")
    [ "$now" = "$(recorded "$name")" ] || echo "$p"
  done
}

cmd=${1:-check}
case "$cmd" in
  check)
    git fetch -q origin "$BRANCH" 2>/dev/null || true
    out=$(changed_parts)
    if [ -z "$out" ]; then echo "依赖没有变化，deps 分支是最新的"; exit 0; fi
    echo "这些依赖变了，deps 分支需要更新（scripts/deps-branch.sh update --push）："
    echo "$out" | cut -d'|' -f1 | sed 's/^/  - /'
    exit 1
    ;;

  update)
    out=$(changed_parts)
    if [ -z "$out" ]; then echo "依赖没有变化，不用更新"; exit 0; fi
    while IFS='|' read -r name dir zip; do
      mods=$(mods_of "$dir")
      [ -d "$mods" ] || { echo "缺少 $mods：先在 $dir 里 npm ci" >&2; exit 2; }
      echo "打包 $mods → $zip"
      rm -f "$zip"
      zip -qr -X -9 "$zip" "$mods" -x "*.DS_Store"
    done <<<"$out"

    # 用临时索引直接拼 deps 分支的新提交，不动当前分支和工作区
    tmpidx=$(mktemp)
    trap 'rm -f "$tmpidx"' EXIT
    ref=$(branch_ref); parent=()
    if [ -n "$ref" ]; then GIT_INDEX_FILE=$tmpidx git read-tree "$ref"; parent=(-p "$(git rev-parse "$ref")")
    else GIT_INDEX_FILE=$tmpidx git read-tree --empty; fi
    add() { GIT_INDEX_FILE=$tmpidx git update-index --add --cacheinfo "100644,$1,$2"; }
    while IFS='|' read -r name dir zip; do add "$(git hash-object -w "$zip")" "$zip"; done <<<"$out"
    locks=$(for p in "${PARTS[@]}"; do IFS='|' read -r n d z <<<"$p"; echo "$n $(git hash-object "$(lock_of "$d")")"; done)
    add "$(printf '%s\n' "$locks" | git hash-object -w --stdin)" deps/LOCKS.txt
    tree=$(GIT_INDEX_FILE=$tmpidx git write-tree)
    names=$(echo "$out" | cut -d'|' -f1 | paste -sd'/' -)
    commit=$(git commit-tree "$tree" "${parent[@]}" -m "chore(deps): 更新依赖压缩包（$names），对应 main $(git rev-parse --short HEAD)")
    git update-ref "refs/heads/$BRANCH" "$commit"
    echo "deps 分支已更新：$(git log --oneline -1 "$BRANCH")"
    if [ "${2:-}" = "--push" ]; then git push origin "$BRANCH"; fi
    ;;

  fetch)
    git fetch -q origin "$BRANCH"
    git restore --source="origin/$BRANCH" --worktree -- deps
    echo "压缩包已取到 deps/，按 deps/README.md 在项目根目录解压"
    ;;

  *) echo "用法：$0 check | update [--push] | fetch" >&2; exit 2 ;;
esac
