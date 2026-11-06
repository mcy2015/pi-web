# Fork 发布流程（@mcy2015/pi-web，本地手动发布）

> fork 的 npm 包是 `@mcy2015/pi-web`，发布走**本地手动**（上游 agegr/pi-web 走 CI Trusted Publishing，fork 未配置）。
> 前提：工作区干净、在 `personal/main` 分支、`package.json` 版本已就位（合并上游后通常已对齐上游版本号）。

## 发布步骤

```bash
cd "/Volumes/Data Vault/PiSpace/pi-web"

# 1) 版本号 bump：0.14.2 → 0.14.3，自动提交 "Release v0.14.3" + 打 tag v0.14.3
npm run release

# 2) 推送提交和 tag
#    注意：push v* tag 会触发上游合并来的 .github/workflows/publish.yml（Release workflow）。
#    它用 OIDC Trusted Publishing，绑定的是上游仓库；fork 没在 npmjs.com 配过
#    Trusted Publisher → workflow 的 npm 步骤会红叉。无害，以本地 publish 为准。
#    嫌 Actions 红叉吵：仓库网页 Settings → Actions 里 disable "Release" workflow（文件保留）。
git push --follow-tags origin personal/main

# 3) 登录 npm（本机 2026-11-03 时 session 已过期，E401）
npm login

# 4) 生产构建（发布必需，别跳过！）
npm run build
#    package.json 无 prepack/prepublishOnly 脚本，npm publish 打包时 "files" 含 .next ——
#    不先 build 发出去的就是 dev 残留（.next/dev 缓存），装上跑不起来。
#    此步是 AGENTS.md「dev 期间禁跑 next build」红线的唯一例外场景。

# 5) 发布（scoped 包必须 --access public，package.json 无 publishConfig）
npm publish --access public

# 6) 清掉生产 .next，恢复 dev 环境（下次 npm run dev 自动重建）
rm -rf .next

# 7) 本机常驻服务升级 + 重启
#    30141 端口 launchd 服务名沿用了历史名 com.agegr.pi-web，跑的就是全局安装的 fork 包。
npm i -g @mcy2015/pi-web@latest
launchctl kickstart -k gui/$(id -u)/com.agegr.pi-web
```

## 验证

```bash
# 常驻服务版本应答 0.14.3（/api/app-update 的 currentVersion）
curl -s http://127.0.0.1:30141/api/app-update | jq

# 页面冒烟（可选）：首页 200
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:30141/

# npm registry 侧确认
npm view @mcy2015/pi-web version dist-tags
```

## 排错速查

| 症状 | 原因 / 处理 |
|---|---|
| `npm run release` 报工作区不干净 | 先 `git status` 处理未提交改动（npm version 要求干净树） |
| `npm publish` 401 | `npm login` 重新登录 |
| 装完新包服务起不来 / 白页 | 发布时没跑 `npm run build`，包里 .next 是 dev 残留 → 重新走 4-5-7 步 |
| Actions 里 Release workflow 红叉 | fork 没配 Trusted Publishing，预期行为，本地 publish 为准（或 disable 该 workflow） |
| dev 起不来 / 行为诡异 | 发布后忘了删 `.next`（生产构建与 Turbopack dev 互斥）→ `rm -rf .next` 再 `npm run dev` |

## 相关背景（2026-11-03 实录）

- fork 真正开发分支 = `personal/main`；本地 `main` 只是上游旧点镜像，别在它上面发版。
- 上游 v0.14.2 合并（fc631fa）后 package.json version = 0.14.2，npm 上 fork latest = 0.13.2，
  所以下一次 release 自然是 **0.14.3**。
- launchd plist：`~/Library/LaunchAgents/com.agegr.pi-web.plist`（服务名是历史遗留，包已 rebrand）。
