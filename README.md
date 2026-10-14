# dsh-weixin-plus

> DeepSeek Harness (DSH) 微信通道全功能增强插件。

集成了手机微信与 DSH 之间的实时双向消息桥接、单实例选举守护锁、大文件本地智能投递与 Web 端原生设置管理面板。

---

## 核心特性

1. **双向消息与媒体桥接**：手机微信发消息直通 DSH 会话，支持文本与双向多媒体传输。
2. **Web 设置与管理面板**：
   - 嵌入 DSH 设置中心「微信通道」标签页。
   - 实时探测微信服务端连通性与 Token 有效期（过期即时预警）。
   - 内置一键重新扫码登录，动态渲染 Base64 二维码与直链。
   - 支持一键断开连接并安全清理本地凭证。
3. **免 403 健壮通讯**：
   - 首创基于 Cordis `connection.rpc` 通道双向通信，天然免疫 Electron 与常规浏览器模式下的安全拦截与 403 鉴权错误。
   - 优雅兼容 HTTP RESTful 路由回退。
4. **单实例选举锁 (ilink-owner.lock)**：
   - 防止多宿主（如 GUI 与后台无头服务）同时消费消息导致的游标竞争与丢消息问题。
5. **大文件智能转接 (filepush17)**：
   - 智能识别超过微信体积限制的本地文件并安全暂存。
6. **大图无损智能分流防 500 (filepush18 / v1.0.5)**：
   - 智能识别出站图片大小：≤2MB 走图片气泡直显，>2MB 自动无损升维走微信 25MB 原图文件通道，彻底杜绝微信官方 CDN 500 报错并 100% 保留原始像素。
   - 内置自愈热补丁，加载时自动增强底层 SDK，跨机器安装零配置生效。

---

## 安装与配置

在 DSH `cordis.patch.yml` 中启用：

```yaml
- id: weixin-plus
  plugin: ./node_modules/dsh-weixin-plus/index.js
```

并在 `package.json` 中引入依赖：

```json
"dependencies": {
  "dsh-weixin-plus": "github:liushQAQ/dsh-weixin-plus"
}
```

---

## 架构

- `index.js`: 宿主端逻辑，包括 iLink 轮询、会话挂载、单实例选举、Cordis RPC 与 WebServer 路由。
- `client.js`: 客户端 React 前端，挂载在 `settings.section`（id: `weixin`）。
- `cordis.patch.yml`: 插件装配声明。
