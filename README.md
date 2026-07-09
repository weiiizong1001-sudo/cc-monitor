# cc-monitor

一个轻量级的 **Claude Code 会话监控 Web 工具**：在浏览器里实时查看所有 Claude Code 会话的历史列表与终端输出流，支持会话分组、重命名、JSONL 路径查看。

- 后端：Fastify v5 + WebSocket
- 前端：React 19 + Vite 8 + Tailwind v4
- 信号来源：4 个 Claude Code Hook（SessionStart / SessionEnd / PermissionRequest / Notification）+ JSONL 文件 tail

## 特性

- 📋 **会话列表**：已激活 / 未激活分段，按最近活动排序
- 📡 **实时输出**：流式查看 cc 终端输出（assistant 文本、工具调用、思考块等分块显示）
- 🗂 **分组管理**：给会话打分组标签，列表按分组分段，分组持久化（重启不丢）
- ✏ **重命名**：网页端重命名会话（写入 Claude 原生 `custom-title` 格式，cc 客户端也识别）
- 📁 **JSONL 路径**：详情页查看会话原始 JSONL 文件路径，方便在终端归档 / 删除
- 🔐 **访问控制**：回环 / 内网（RFC1918）免 token 访问；公网来源需 Bearer token
- 🖥 **Windows 连接器**：经跳板机两跳 SSH 隧道，免手敲 `ssh -L` 即可在 Windows 访问内网部署的 cc-monitor

## 架构

```
cc-monitor/
├── core/        共享类型与协议定义（ServerMessage / ClientMessage / schemas）
├── server/      Fastify 服务端：hook 接收、JSONL tail、WS 推送、状态持久化
├── web/         React 前端（Vite 构建，由 Fastify 静态托管）
├── connector/   Windows 端连接器（paramiko 两跳 SSH 隧道 + 落地页）
├── esbuild.config.js   服务端打包
└── package.json
```

### 信号流

```
Claude Code ──hook POST──▶ Fastify (auth token) ──▶ AgentRuntime ──WS──▶ 浏览器
       │                                                       ▲
       └──JSONL 写入──▶ fileWatcher (tail) ──解析/transcriptParser──┘
```

- Hook 事件（会话起止、权限请求、通知）经 HTTP POST 到达，需 Bearer token。
- 工具调用 / 轮次完成 / token 用量等细节由 `fileWatcher` tail JSONL 文件解析得出。

## 快速开始

### 1. 安装与构建

```bash
npm install
npm run build        # check-types + 打包 server + 构建 web
```

### 2. 启动

```bash
node dist/cli.js --port 3100 --host 0.0.0.0 --hook-host 127.0.0.1
```

- `--port`：Web / WS 监听端口（默认 3100）
- `--host`：监听地址
- `--hook-host`：Claude Code CLI 回连 hook 的地址（本机访问用 `127.0.0.1`；若要让局域网内其他机器的 cc 也上报，填本机内网 IP）
- `--scan-dir`：可选，启动时扫描该目录下的 Claude 会话并收养

首次启动会自动把 4 个 hook 写入 `~/.claude/`，并把端口 / PID / 鉴权 token 写到 `~/.cc-monitor/server.json`。之后新开的 Claude Code 会话即自动上报。

### 3. 访问

浏览器打开 `http://localhost:3100`（本机）或 `http://<内网IP>:3100`（同网段）。

## 配置目录 `~/.cc-monitor/`

| 文件 | 说明 |
|---|---|
| `server.json` | 运行实例信息：端口、PID、鉴权 token（自动生成，权限 600） |
| `standalone-state.json` | 会话元数据持久化（分组、标题等，重启不丢） |
| `config.json` | 启动配置缓存 |
| `cc-monitor.log` | 运行日志 |
| `hooks/` | 安装的 hook 脚本 |

## 网页端管理

- **分组**：详情页点「🗂 分组」输入组名，列表即按分组分段；清空组名即移出分组。
- **重命名**：详情页点「✏ 重命名」，回车提交。重命名以 Claude 原生 `custom-title` 格式追加到会话 JSONL，Claude Code 客户端也会显示新名字。
- **JSONL 路径**：详情页点「📁 路径」查看会话原始文件路径，可在终端 `rm` / 归档。

## Windows 连接器

适用于 cc-monitor 部署在内网、需经跳板机访问的场景。连接器在本机起落地页，填后端主机名 + 跳板机密码，自动建两跳 SSH 隧道并跳转 cc-monitor。

```
Windows connector
   │ 第一跳：密码登录跳板机
   ▼
跳板机 <jumphost-ip>
   │ direct-tcpip 通道
   ▼
后端 SSH:22  ← 第二跳：Windows 本地私钥认证
   │
   ▼
后端 cc-monitor 127.0.0.1:3100
```

隧道落地在后端回环 `127.0.0.1:3100`，cc-monitor 判定为本地来源 → WS 免 token。

详见 [`connector/README.md`](connector/README.md)。配置模板见 [`connector/connector_config.example.json`](connector/connector_config.example.json)——复制为 `connector_config.json` 并填入你的跳板机地址、账号、私钥路径后使用。

## 访问控制

- `isLocalOrPrivate(ip)` 判定来源：回环 / RFC1918 内网 → WebSocket 免 token。
- 公网来源需在请求头带 `Authorization: Bearer <token>`，token 见 `~/.cc-monitor/server.json`。
- hook POST 始终需要 Bearer token。

## 安全提示

- 鉴权 token 由 `crypto.randomUUID()` 运行时生成，`server.json` 权限 600，不入仓库。
- 跳板机密码只在连接器内存中传递，不落盘、不打日志。
- 后端私钥由各人自置于本机，配置只记路径不记内容。
- **请勿**将 `connector_config.json`（含真实跳板机 / 账号）、`~/.cc-monitor/` 下任何文件提交到版本库——`.gitignore` 已默认排除。

## 技术栈

| 层 | 技术 |
|---|---|
| 服务端 | Fastify 5、@fastify/websocket、@fastify/static、@fastify/cors |
| 前端 | React 19、Vite 8、Tailwind CSS 4 |
| 构建 | esbuild（server）、Vite（web）、TypeScript 5.9 |
| 连接器 | Python 3 + paramiko |

## 许可证

MIT
