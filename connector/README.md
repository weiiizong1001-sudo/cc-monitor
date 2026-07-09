# cc-monitor 连接器（Windows 端）

参考同类进程监控项目的 connector 思路，给 cc-monitor 做一个 Windows 端"登录"入口：双击/运行后本地起落地页，填**后端主机名 + 跳板机密码**，自动经跳板机建两跳 SSH 隧道，浏览器跳转 cc-monitor 界面。免去手敲 `ssh -L`。

## 认证两跳

```
Windows connector
   │ 第一跳：密码登录
   ▼
跳板机 <jumphost-ip>
   │ direct-tcpip 通道
   ▼
后端 SSH:22  ← 第二跳：Windows 本地私钥认证
   │
   ▼
后端 cc-monitor 127.0.0.1:3100
```

- 第一跳（跳板机）：**密码**登录，密码只在内存，不落盘不打日志。
- 第二跳（后端）：**Windows 本地私钥**登录，私钥路径写在配置里，不分发。
- 隧道落地在后端 `127.0.0.1:3100`，cc-monitor server 看到来源是回环 → WS 免 token（`isLocalOrPrivate` 判定），所以隧道方式无需鉴权 token。

## 依赖

Windows 上装一次 Python + paramiko：
```
pip install paramiko
```

## 配置

编辑同目录 `connector_config.json`：

| 字段 | 说明 |
|---|---|
| `jumphost` / `jumphost_port` / `jumphost_user` | 跳板机地址、端口、账号 |
| `backend_user` / `backend_port` | 后端 SSH 账号、端口 |
| `backend_key_path` | **必填**：Windows 本地私钥路径，如 `C:/Users/你/.ssh/id_ed25519`（私钥，不是 .pub） |
| `backend_key_passphrase` | 私钥有密码才填（会落盘；不想落盘就给私钥设空 passphrase） |
| `landing_port` | 落地页端口（默认 7080） |
| `forward_port` | 浏览器最终访问端口（默认 18080，转发到后端 3100） |
| `monitor_host` / `monitor_port` | 后端 cc-monitor 地址端口（`127.0.0.1:3100`，不动） |

> 私钥对应的**公钥**需已授权在后端 `~/.ssh/authorized_keys`。

## 启动

```
python connector.py
```

- 自动打开落地页 `http://localhost:7080`。
- 填后端主机名（如 `<backend-ip>`）+ 跳板机密码 → 点「连接并打开 cc-monitor」。
- 自动建隧道 → 跳转 `http://localhost:18080`（即 cc-monitor）。
- 主机名缓存最多 10 个，下次点击即填入。
- 切换后端：回落地页填新主机名，旧隧道自动关再开新的。
- `Ctrl+C` 退出，隧道随之关闭。

## 端口对照

| 端口 | 用途 |
|---|---|
| 7080 | 落地页（本机） |
| 18080 | cc-monitor 界面（本机，经隧道到后端 3100） |
| 3100 | 后端 cc-monitor server（仅后端回环） |

## 打包成 exe（可选，交付同事）

```
pip install pyinstaller
pyinstaller --onefile --name cc-monitor连接器 connector.py
```
产物在 `dist/`，连同 `connector_config.json` 一起分发。同事零安装（exe 自包含 Python+paramiko）。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 双击无反应 | 看同目录 `connector_debug.log` |
| 「跳板机认证失败」 | 跳板机密码错，或 `jumphost_user` 不对 |
| 「后端密钥认证失败」 | `backend_key_path` 路径错 / 私钥不对应后端授权公钥 / 私钥有 passphrase 但配置没填 |
| 「无法经跳板机连接到后端」 | 跳板机登录成功但到后端通道被拒；检查后端主机名、后端 SSH 是否开 |
| 跳转后 18080 打不开 | cc-monitor 没在后端跑，或 `monitor_port` 不是 3100 |
| `forward_port` 被占用 | 改 config 的 `forward_port` 重启 |

## 安全

- 跳板机密码只过内存，不落盘不打日志。
- 私钥由各人自置于本机，配置只记路径不记内容。
- `backend_key_passphrase` 会落盘——不想落盘就给私钥设空 passphrase。
- 落地页 / 转发端口都绑 127.0.0.1，本机外不可访问。
- paramiko 用 `AutoAddPolicy` 自动接受跳板机/后端指纹（内网可接受）。
