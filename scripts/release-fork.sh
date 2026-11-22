#!/usr/bin/env bash
# One-shot fork release — docs/release-fork.zh-CN.md as an idempotent script.
# Every step detects whether it is already done, so an interrupted run
# (e.g. waiting for `npm login`) can simply be re-run.
#
# Usage: scripts/release-fork.sh [--skip-build] [--refresh-fonts]
#
# NOTE: this is the ONE sanctioned place to run `next build` (AGENTS.md
# forbids it during dev; publishing without a build ships dev .next residue).

set -euo pipefail

cd "$(dirname "$0")/.."
repo="$(pwd)"

SKIP_BUILD=0
REFRESH_FONTS=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --refresh-fonts) REFRESH_FONTS=1 ;;
    *) echo "unknown option: $arg" >&2; exit 64 ;;
  esac
done

PKG="@mcy2015/pi-web"
SERVICE="com.agegr.pi-web"
PLIST="$HOME/Library/LaunchAgents/${SERVICE}.plist"
FONT_CSS_URL="https://fonts.loli.net/css2?family=Noto+Sans+Mono:wght@100..900&display=swap"
GOOGLEAPIS_URL="https://fonts.googleapis.com/css2?family=Noto+Sans+Mono:wght@100..900&display=swap"
FONT_CACHE_DIR="$HOME/.cache/pi-web-release-fonts"
CHROME_UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.0.0 Safari/537.36"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

version() { node -p "require('$repo/package.json').version"; }

# ---------------------------------------------------------------- step 0: guards
step "[0/8] pre-flight"
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "personal/main" ] || die "not on personal/main (currently: $branch). Releases happen on personal/main only."
[ -z "$(git status --porcelain)" ] || die "working tree is not clean — commit or stash first (npm version requires it)."
note "branch=$branch  version=$(version)"

# ------------------------------------------------- step 1: bump + tag (idempotent)
# The registry's latest is the source of truth for "was the previous release
# published":  latest == version  → previous release shipped, bump a new one;
#               latest  < version  → bumped but not yet published, keep it.
# (A HEAD-tag check would re-bump whenever any commit lands after a Release.)
step "[1/8] version bump"
registry_latest="$(npm view "$PKG" version 2>/dev/null || true)"
[ -n "$registry_latest" ] || die "cannot read $PKG's latest version from the npm registry — network/npm state unclear, refusing to bump."
relation="$(node -p "require('semver').compare('$registry_latest','$(version)')")"
case "$relation" in
  -1) note "v$(version) already bumped (registry latest: $registry_latest) — skipping." ;;
  0)  npm run release ;;
  *)  die "registry latest ($registry_latest) is newer than local v$(version) — refusing to bump." ;;
esac

# --------------------------------------------------------- step 2: push (idempotent)
step "[2/8] push commit + tags"
git push --follow-tags origin personal/main

# ------------------------------------------------------- step 3: npm auth (manual)
step "[3/8] npm login check"
if npm whoami >/dev/null 2>&1; then
  note "logged in as $(npm whoami)"
else
  die "npm session expired (E401). Run \`npm login\` in a terminal, then re-run this script — earlier steps will be skipped."
fi

# ------------------------------------------------------------------ step 4: build
step "[4/8] production build"
if [ "$SKIP_BUILD" = 1 ]; then
  note "skipped (--skip-build); make sure .next holds a build of v$(version)."
else
  # next/font must reach fonts.googleapis.com. On this network that host may be
  # SNI-reset while fonts.gstatic.com (the file host) stays reachable; in that
  # case build against NEXT_FONT_GOOGLE_MOCKED_RESPONSES with local woff2 files
  # (mirrored CSS from fonts.loli.net, files downloaded from fonts.gstatic.com).
  if node -e "fetch('$GOOGLEAPIS_URL',{signal:AbortSignal.timeout(8000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    note "fonts.googleapis.com reachable — building normally."
    npm run build
  else
    note "fonts.googleapis.com unreachable — using the offline font mock."
    if [ "$REFRESH_FONTS" = 1 ] && [ -d "$FONT_CACHE_DIR" ]; then
      rm -rf "$FONT_CACHE_DIR"
    fi
    if [ ! -f "$FONT_CACHE_DIR/mock.js" ]; then
      note "building font mock in $FONT_CACHE_DIR (mirror CSS + local woff2)…"
      mkdir -p "$FONT_CACHE_DIR"
      curl -s --max-time 20 -A "$CHROME_UA" "$FONT_CSS_URL" -o "$FONT_CACHE_DIR/mirrored.css" || die "cannot fetch mirrored CSS from fonts.loli.net — check network or open a proxy/TUN."
      node - "$FONT_CACHE_DIR/mirrored.css" "$FONT_CACHE_DIR" <<'NODE'
        // Rewrite the mirrored CSS to absolute local woff2 paths and emit mock.js.
        // gstatic.loli.net mirrors fonts.gstatic.com 1:1; prefer the direct host,
        // fall back to the mirror, so a half-blocked network still works.
        const [cssPath, outDir] = process.argv.slice(2);
        const fs = require("fs");
        const { execFileSync } = require("child_process");
        const crypto = require("crypto");
        let css = fs.readFileSync(cssPath, "utf8");
        const urls = [...new Set(css.match(/https:\/\/[^)]*\.woff2/g) || [])];
        if (urls.length === 0) throw new Error("no woff2 URLs found in mirrored CSS");
        const googleUrl = "https://fonts.googleapis.com/css2?family=Noto+Sans+Mono:wght@100..900&display=swap";
        for (const u of urls) {
          const name = "font-" + crypto.createHash("sha1").update(u).digest("hex").slice(0, 16) + ".woff2";
          const path = outDir + "/" + name;
          const candidates = [
            u.replace("https://gstatic.loli.net", "https://fonts.gstatic.com"),
            u, // the mirror itself
          ];
          let ok = false;
          for (const src of candidates) {
            try {
              execFileSync("curl", ["-s", "--max-time", "30", "-A", "Mozilla/5.0", "-o", path, "-w", "%{http_code}", src], { stdio: ["ignore", "pipe", "ignore"] });
              if (fs.existsSync(path) && fs.statSync(path).size > 1000) { ok = true; break; }
            } catch {}
          }
          if (!ok) throw new Error("cannot download " + u);
          css = css.split(u).join(path);
        }
        fs.writeFileSync(outDir + "/mock.js", "module.exports = " + JSON.stringify({ [googleUrl]: css }) + ";\n");
        console.log("    font mock ready: " + urls.length + " woff2 localized");
NODE
    else
      note "reusing cached font mock ($FONT_CACHE_DIR/mock.js)."
    fi
    NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$FONT_CACHE_DIR/mock.js" npm run build
  fi
fi

# ---------------------------------------------------------------- step 5: publish
step "[5/8] npm publish"
published="$(npm view "$PKG" version 2>/dev/null || true)"
if [ "$published" = "$(version)" ]; then
  note "$PKG@$(version) already on the registry — skipping."
else
  npm publish --access public
fi

# ------------------------------------------------------- step 6: restore dev tree
step "[6/8] remove production .next"
rm -rf .next
note ".next removed (production build and Turbopack dev are mutually exclusive)."

# --------------------------------------------------- step 7: upgrade local service
step "[7/8] upgrade the local launchd service"
npm i -g "${PKG}@latest"
if [ -f "$PLIST" ]; then
  launchctl kickstart -k "gui/$(id -u)/$SERVICE"
  note "service $SERVICE restarted."
else
  note "no $PLIST — skipping the kickstart (not this machine's layout?)."
fi

# ----------------------------------------------------------------- step 8: verify
step "[8/8] verify"
npm_latest="$(npm view "$PKG" version 2>/dev/null || true)"
note "registry: $PKG latest = ${npm_latest:-unknown}"

current=""
for i in 1 2 3 4 5 6; do
  current="$(curl -s --max-time 5 http://127.0.0.1:30141/api/app-update | node -p "try{JSON.parse(require('fs').readFileSync(0,'utf8')).currentVersion}catch{return ''}" 2>/dev/null || true)"
  [ -n "$current" ] && break
  note "service not answering yet, retrying ($i/6)…"
  sleep 5
done

if [ "$current" = "$(version)" ]; then
  note "local service answers $(version) ✔"
else
  note "WARNING: local service answered '${current:-nothing}' (expected $(version))."
  note "Check: launchctl print gui/$(id -u)/$SERVICE and curl http://127.0.0.1:30141/api/app-update"
fi

printf '\n\033[32mRelease v%s complete.\033[0m\n' "$(version)"
