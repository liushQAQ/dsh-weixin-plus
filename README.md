# dsh-weixin-plus

> DeepSeek Harness (DSH) 微信通道全功能增强插件 —— 通用版：跨机器零改配置，装完即用。

把手机微信变成 DSH 的一个入口：微信发消息 → DSH 会话，DSH 回复/发图/发文件 → 微信；并在 DSH 设置中心提供完整的「微信通道」管理面板。

---

## 核心特性

1. **双向消息与媒体桥接**：文本、图片、文件双向传输；入站媒体自动归档。
2. **Web 设置与管理面板**：嵌入 DSH 设置中心「微信通道」标签页 —— 实时探测连通性与 Token 有效期（过期即时预警）、一键重新扫码登录（动态渲染二维码）、一键断开连接并安全清理本地凭证。
3. **免 403 的双通道通讯**：
   - 首选 Cordis `connection.rpc` 通道（`/dsh-weixin-plus`），天然免疫 Electron / 浏览器模式下的安全拦截与鉴权错误；
   - 失败自动回退到独立 HTTP 路由口 `/dsh-weixin-plus-http/<action>`（与 RPC 口分属不同前缀，互不抢占）。
4. **单实例选举锁（`ilink-owner.lock`）**：多宿主（GUI + 后台无头服务）同时运行时只允许一个消费消息，避免游标竞争与丢消息。
5. **大文件智能转接（filepush17）**：超过微信体积限制的本地文件安全暂存后投递。
6. **大图无损智能分流（filepush18 / v1.0.5）**：出站图片 ≤2MB 走图片气泡直显，>2MB 自动无损升维走微信原图文件通道，规避微信 CDN 500 且 100% 保留原始像素；加载时自愈热补丁增强底层 SDK，跨机器零配置。
7. **微信端文字选项提问**：需要用户选择时以 A/B/C 文字选项下发（微信端看不到交互卡片），并把回复解析回选项。

---

## 环境要求

- **DSH ≥ 0.1.0**（需含 Cordis 加载器，且宿主提供 `connection` / `webServer` 服务）
- **Node.js ≥ 20**
- 运行依赖由 npm 自动安装：`weixin-agent-sdk@^0.3.0`、`qrcode@^1.5.4`（peer：`@deepseek-ai/cordis >= 4.0.0`）

---

## 安装（推荐：作为 profile bundle）

1）在 profile 目录安装（`~/.dsh/profiles/<你的 profile>`）：

```bash
npm i github:liushQAQ/dsh-weixin-plus
# 或使用 Release 附件：npm i ./dsh-weixin-plus-<version>.tgz
```

2）把包名加入 profile 的 bundle 列表（`package.json`）：

```json
{
  "dependencies": { "dsh-weixin-plus": "github:liushQAQ/dsh-weixin-plus" },
  "dsh": { "profile": { "bundles": ["...", "dsh-weixin-plus"] } }
}
```

插件自带 `cordis.patch.yml`（`package.json` 的 `dsh.bundle.patch`），加载器据此挂载入口 `weixin-plus`。

3）重启 DSH（或触发加载器热重载），设置中心会出现「微信通道」。

> 进阶/开发：也可以把仓库目录 `link:` 进 profile，再用内容哈希文件名（`p1.js → p2.js → …`）做免重启热挂载 —— 宿主按 **URL** 缓存 ESM 模块，原地改内容不会生效，必须换文件名。

## 可选配置

| 键 | 说明 |
|---|---|
| `cwd` | agent 工作目录（缺省取已有工作区） |
| `provider` / `model` | 覆盖默认 provider 路由与模型 |
| `inboxDir` | 入站媒体归档目录（缺省 `<DSH_HOME>/weixin-inbox`） |

工作目录、模型、凭证位置全部走 DSH 运行时（`~/.dsh`）与上述配置，**不含任何机器专有路径**。

## 服务接口（宿主内）

| 通道 | 路径 | 说明 |
|---|---|---|
| RPC | `/dsh-weixin-plus` | 客户端首选；`connection.rpc.call` |
| HTTP 回退 | `/dsh-weixin-plus-http/<action>` | POST/GET，action 如 `status`、`qrcode`、`login`、`logout`、`cancel-scan` |

---

## 变更记录

### v1.0.7 / filepush22（2026-10-20）

- **修复**：设置面板报「获取微信通道状态失败: HTTP 405」（同时 GET 返回 404）。两个根因都在插件侧：
  1. `connection.rpc.handle()` 内部会拿「读该服务的 ctx」去 `owner.effect(() => owner.webServer.register(route))`（官方 `@deepseek-ai/dsh-client-connection` 的 register 实现）。该 ctx 经 shadow 反解后落在父 ctx 上，其 `inject` 里没有 `webServer` ⇒ 抛 `cannot get property "webServer" without inject`，RPC 通道注册失败。
  2. RPC 通道与 HTTP 备用口注册了同一个 `{kind:'prefix', path:'/dsh-weixin-plus'}` ⇒ `webserver: duplicate prefix route`，实例一换路由即丢。
- **修法**：①HTTP 备用口改到独立路径 `/dsh-weixin-plus-http`；②RPC 通道改在 `apply` 体内直接注册，并用 `ctx.extend({ webServer: ctx.get('webServer') })` 把 `webServer` 绑成自有属性后再读 `.connection`（与官方 `dsh-mnemon` 同款写法）；③只注册带斜杠通道，重复注册幂等放过。
- **验证**：`POST/GET /dsh-weixin-plus/status` 由 405/404 → 401（路由已注册、匿名需认证）；`POST /dsh-weixin-plus-http/status` → 200 且返回真实状态（账号、`connected`、`isPollingOwner`）。

### v1.0.6

- 适配最新 DSH 内核，放宽 `peerDependencies`。

### v1.0.5 / filepush18

- 大图无损智能分流防 500（>2MB 走原图文件通道）。

---

## 架构

- `index.js`：宿主端逻辑 —— iLink 轮询、会话挂载、单实例选举、Cordis RPC 与 WebServer 路由。
- `client.js`：客户端 React 前端，挂载在 `settings.section`（id: `weixin`）。
- `cordis.patch.yml`：bundle 装配声明（入口 `weixin-plus`）。
