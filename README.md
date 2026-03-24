# zed2api

将 Zed 编辑器的 LLM API 代理为 OpenAI / Anthropic 兼容接口的本地服务器，内嵌 Web 管理界面。

## 功能

- OpenAI 兼容接口：`POST /v1/chat/completions`
- Anthropic 原生接口：`POST /v1/messages`
- 模型列表：`GET /v1/models`
- 多账号管理 + 自动故障转移
- SSE 流式输出
- 多模型供应商：Anthropic / OpenAI / Google / xAI
- 扩展思考（thinking）支持
- 内嵌 Web UI 管理界面
- HTTPS 代理支持（环境变量 / Windows 系统代理自动检测）
- GitHub OAuth 登录（浏览器引导）

## 支持的模型

| 供应商 | 模型 |
|---------|------|
| Anthropic | claude-sonnet-4-6, claude-sonnet-4-5, claude-haiku-4-5 |
| OpenAI | gpt-5.4, gpt-5.3-codex, gpt-5.2, gpt-5.2-codex, gpt-5-mini, gpt-5-nano |
| Google | gemini-3.1-pro-preview, gemini-3-pro-preview, gemini-3-flash |
| xAI | grok-4, grok-4-fast-reasoning, grok-4-fast-non-reasoning, grok-code-fast-1 |

## 运行（Node.js）

**环境要求：** Node.js >= 18

```bash
npm install
node index.js serve [端口]   # 默认 3000
```

打开 http://127.0.0.1:3000 进入 Web 管理界面。

### 添加账号

**方式一：命令行登录（有浏览器的环境）**

```bash
node index.js login [账号名]   # 自动打开浏览器完成 OAuth 授权
```

**方式二：Web UI 登录（本地部署）**

打开 http://127.0.0.1:3000，点击「登录」，浏览器自动跳转 Zed OAuth 授权页面，完成后账号自动写入 `accounts.json`。

**方式三：手动（无 GUI 的 Linux 服务器）**

OAuth 回调必须打到服务器本机 localhost，远程浏览器无法完成授权。推荐在本地有浏览器的机器上完成登录，再将 `accounts.json` 复制到服务器：

```bash
# 本地机器
node index.js login
# 将生成的 accounts.json 上传到服务器
scp accounts.json user@server:/path/to/zed2api/
```

也可手动创建 `accounts.json`，参考 `accounts.example.json`。

## Claude Code 集成

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3000
export ANTHROPIC_AUTH_TOKEN=zed2api
claude
```

## Docker 部署

```bash
docker run -d \
  --name zed2api \
  -p 3000:3000 \
  -v /root/zed2api:/app/data \
  supray/zed2api:latest
```

访问 http://服务器IP:3000 进入 Web 管理界面。

> **无 GUI 服务器添加账号**：OAuth 回调必须打到本机 localhost，请在本地有浏览器的机器上运行 `node index.js login`，再将生成的 `accounts.json` 上传到服务器挂载目录。

## 代理设置

支持 HTTP / HTTPS / SOCKS5 代理，含账号密码认证。通过环境变量配置，Windows 下还会自动读取系统代理。

```bash
# 无认证
export HTTPS_PROXY=http://127.0.0.1:7890
# 带账号密码
export HTTPS_PROXY=http://user:password@127.0.0.1:7890
# SOCKS5
export HTTPS_PROXY=socks5://user:password@127.0.0.1:1080

node index.js serve
```

Docker 中使用代理：

```bash
docker run -d \
  --name zed2api \
  -p 3000:3000 \
  -v /root/zed2api:/app/data \
  -e HTTPS_PROXY=http://user:password@192.168.1.1:7890 \
  supray/zed2api:latest
```

## 项目结构

```
index.js              - 入口，CLI 命令解析
src/
  server.js           - Express HTTP 服务器，路由
  stream.js           - SSE 流式代理，账号故障转移
  zed.js              - JWT Token 管理，Zed API 调用
  providers.js        - 多供应商请求构建 & 响应转换
  accounts.js         - 账号管理，JSON 持久化
  auth.js             - RSA 密钥对生成，GitHub OAuth 登录
  proxy.js            - HTTPS 代理检测
  models.json         - 模型列表
webui/
  dist/index.html     - 编译后的单文件 Web UI
  src/                - Vite + TypeScript 源码
```

## 接口说明

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /v1/chat/completions | OpenAI 聊天补全（支持 stream） |
| POST | /v1/messages | Anthropic Messages（支持 stream） |
| GET | /v1/models | 模型列表 |
| GET | /zed/accounts | 账号列表 |
| POST | /zed/accounts/switch | 切换当前账号 |
| DELETE | /zed/accounts/:name | 删除账号 |
| POST | /zed/login | 发起 OAuth 登录 |
| GET | /zed/login/status | 查询登录状态 |
| GET | /zed/billing | 用量 & 计费信息 |
