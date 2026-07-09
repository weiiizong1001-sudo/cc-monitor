# -*- coding: utf-8 -*-
"""
cc-monitor - 按需连接器（Windows 端）

开机自启，在 http://localhost:7080 提供落地页。
浏览器里填「后端主机名 + 跳板机密码」→
先密码登录跳板机 → 经跳板机建立 SSH 通道到后端 →
再使用 Windows 本地私钥登录后端 →
最后把本地 http://localhost:18080/ 转发到后端 cc-monitor(3100)。

当前认证方式：
  第一跳：Windows connector --密码--> 跳板机
  第二跳：Windows connector --本地私钥--> 后端

密码只过内存，不落盘、不打日志。
私钥路径写在 connector_config.json 里。

依赖：
  pip install paramiko

启动：
  python connector.py

打包：
  pyinstaller --onefile --name cc-monitor连接器 connector.py
"""

import json
import os
import select
import socket
import socketserver
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import paramiko
except ImportError:
    paramiko = None


# ----------------------------- 配置 -----------------------------

HERE = os.path.dirname(os.path.abspath(__file__))

# PyInstaller --noconsole 打包时 sys.stdout / sys.stderr 为 None，
# 代码里的 print() 会抛 'NoneType' object has no attribute 'write'，导致 exe 启动即闪退。
# 这种情况下把输出重定向到同目录 connector_debug.log，既防崩又便于排查。
if getattr(sys, "stdout", None) is None or getattr(sys, "stderr", None) is None:
    try:
        _log_file = open(os.path.join(HERE, "connector_debug.log"), "a", encoding="utf-8")
        if getattr(sys, "stdout", None) is None:
            sys.stdout = _log_file
        if getattr(sys, "stderr", None) is None:
            sys.stderr = _log_file
    except Exception:
        pass
CONFIG_PATH = os.path.join(HERE, "connector_config.json")
LOG_PATH = os.path.join(HERE, "connector_debug.log")
HOSTS_PATH = os.path.join(HERE, "connector_hosts.json")
HOSTS_MAX = 10


def log_dbg(msg):
    """写调试日志。注意：绝不写密码。"""
    import time as _t

    line = _t.strftime("%Y-%m-%d %H:%M:%S ") + msg
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


DEFAULT_CONFIG = {
    "jumphost": "YOUR_JUMPHOST_IP",
    "jumphost_port": 22,
    "jumphost_user": "your-jumphost-username",

    "backend_user": "your-backend-username",
    "backend_port": 22,

    # Windows 本地用于登录后端的私钥路径。
    # 注意：这里是私钥，不是 .pub 公钥。
    # 推荐写法：C:/Users/你的用户名/.ssh/id_ed25519
    "backend_key_path": "",

    # 如果私钥有 passphrase，就填这里；没有就留空。
    # 注意：这个字段会落盘。如果不想落盘，建议给私钥设置为空 passphrase，
    # 或者后续改成网页输入 passphrase。
    "backend_key_passphrase": "",

    "landing_port": 7080,
    "forward_port": 18080,
    "monitor_host": "127.0.0.1",
    "monitor_port": 3100,
    "auto_open_browser": True
}


def load_config():
    if not os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_CONFIG, f, ensure_ascii=False, indent=2)
        print("[连接器] 已生成配置模板：" + CONFIG_PATH)
        print("[连接器] 请先编辑其中的 jumphost / jumphost_user / backend_key_path，再重启本程序。")

    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    for k, v in DEFAULT_CONFIG.items():
        cfg.setdefault(k, v)

    return cfg


def load_hosts():
    """读过往后端主机名历史（最新在前，最多 HOSTS_MAX 条）。"""
    try:
        with open(HOSTS_PATH, encoding="utf-8") as f:
            d = json.load(f)
        return [h for h in d.get("hosts", []) if h][:HOSTS_MAX]
    except Exception:
        return []


def save_hosts(hosts):
    hosts = [h for h in hosts if h][:HOSTS_MAX]
    try:
        tmp = HOSTS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"hosts": hosts}, f, ensure_ascii=False)
        os.replace(tmp, HOSTS_PATH)
    except Exception:
        pass


def push_host(host):
    """把后端主机名提到历史最前（去重），保留最新 HOSTS_MAX 条。"""
    host = (host or "").strip()
    if not host:
        return
    hosts = load_hosts()
    if host in hosts:
        hosts.remove(host)
    hosts.insert(0, host)
    save_hosts(hosts)


def normalize_key_path(path):
    """
    处理私钥路径：
    - 支持 ~
    - 支持环境变量，例如 %USERPROFILE%/.ssh/id_ed25519
    - 支持 Windows 路径
    """
    path = (path or "").strip()
    if not path:
        return ""

    path = os.path.expandvars(path)
    path = os.path.expanduser(path)
    path = os.path.abspath(path)
    return path


# ----------------------- 本地端口转发（paramiko）-----------------------
# 监听本地端口，每个连接开一条 direct-tcpip 通道到后端 cc-monitor，
# 双向搬运字节。SSE 长连接透传无碍。


class ForwardHandler(socketserver.BaseRequestHandler):
    # 由 ForwardServer 动态注入
    chain_host = None
    chain_port = None
    ssh_transport = None

    def handle(self):
        try:
            chan = self.ssh_transport.open_channel(
                "direct-tcpip",
                (self.chain_host, self.chain_port),
                self.request.getpeername(),
                timeout=20,
            )
        except Exception as e:
            log_dbg("本地转发 open_channel 失败：%s: %s" % (type(e).__name__, e))
            return

        if chan is None:
            log_dbg("本地转发 open_channel 返回 None")
            return

        try:
            while True:
                r, _, _ = select.select([self.request, chan], [], [])
                if self.request in r:
                    data = self.request.recv(4096)
                    if not data:
                        break
                    chan.send(data)

                if chan in r:
                    data = chan.recv(4096)
                    if not data:
                        break
                    self.request.sendall(data)
        except Exception:
            pass
        finally:
            try:
                chan.close()
            except Exception:
                pass
            try:
                self.request.close()
            except Exception:
                pass


class ForwardServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def make_forward_server(listen_port, dest_host, dest_port, transport):
    ForwardHandler.chain_host = dest_host
    ForwardHandler.chain_port = dest_port
    ForwardHandler.ssh_transport = transport
    return ForwardServer(("127.0.0.1", listen_port), ForwardHandler)


# ----------------------------- 隧道管理 -----------------------------


class Tunnel:
    """
    一条 SSH 隧道：

    Windows connector
        |
        | 第一跳：密码登录
        v
    跳板机
        |
        | direct-tcpip TCP 通道
        v
    后端 SSH:22
        |
        | 第二跳：Windows 本地私钥认证
        v
    后端 cc-monitor:3100

    本地浏览器访问：
      http://localhost:18080/
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.jump = None
        self.backend = None
        self.fwd_server = None
        self.fwd_thread = None
        self.backend_host = ""
        self.local_port = 0
        self.started_at = ""

    def start(self, cfg, backend_host, password):
        backend_host = (backend_host or "").strip()
        if not backend_host:
            raise ValueError("后端主机名不能为空")
        if not password:
            raise ValueError("跳板机密码不能为空")

        backend_user = cfg.get("backend_user") or cfg["jumphost_user"]
        backend_key_path = normalize_key_path(cfg.get("backend_key_path") or "")
        backend_key_passphrase = cfg.get("backend_key_passphrase") or None

        if not backend_key_path:
            raise ValueError("未配置 backend_key_path：请在 connector_config.json 中填写 Windows 本地私钥路径")

        if not os.path.exists(backend_key_path):
            raise ValueError("backend_key_path 指向的私钥文件不存在：%s" % backend_key_path)

        with self.lock:
            self.stop_locked()

            log_dbg(
                "开始连接：跳板机=%s@%s:%s  后端=%s@%s:%s  后端key=%s"
                % (
                    cfg["jumphost_user"],
                    cfg["jumphost"],
                    cfg.get("jumphost_port", 22),
                    backend_user,
                    backend_host,
                    cfg.get("backend_port", 22),
                    backend_key_path,
                )
            )

            # 1) 密码登录跳板机
            jump = paramiko.SSHClient()
            jump.set_missing_host_key_policy(paramiko.AutoAddPolicy())

            try:
                jump.connect(
                    cfg["jumphost"],
                    port=cfg.get("jumphost_port", 22),
                    username=cfg["jumphost_user"],
                    password=password,
                    timeout=20,
                    auth_timeout=20,
                    banner_timeout=20,
                    look_for_keys=False,
                    allow_agent=False,
                )
            except paramiko.AuthenticationException as e:
                jump.close()
                msg = "跳板机认证失败：%s（账号 %s@%s）" % (
                    e,
                    cfg["jumphost_user"],
                    cfg["jumphost"],
                )
                log_dbg(msg)
                raise RuntimeError(msg)
            except Exception as e:
                jump.close()
                msg = "连接跳板机失败：%s: %s" % (type(e).__name__, e)
                log_dbg(msg)
                raise RuntimeError(msg)

            jt = jump.get_transport()
            if jt is None or not jt.is_active():
                jump.close()
                msg = "跳板机 Transport 未激活"
                log_dbg(msg)
                raise RuntimeError(msg)

            jt.set_keepalive(30)
            log_dbg("跳板机登录成功")

            # 2) 经跳板机开一条 direct-tcpip 通道到 后端:22
            try:
                chan = jt.open_channel(
                    "direct-tcpip",
                    (backend_host, cfg.get("backend_port", 22)),
                    ("127.0.0.1", 0),
                    timeout=20,
                )
            except Exception as e:
                jump.close()
                msg = "经跳板机开通道到后端 %s:%s 失败：%s: %s" % (
                    backend_host,
                    cfg.get("backend_port", 22),
                    type(e).__name__,
                    e,
                )
                log_dbg(msg)
                raise RuntimeError(msg)

            if chan is None:
                jump.close()
                msg = "无法经跳板机连接到后端 " + backend_host
                log_dbg(msg)
                raise RuntimeError(msg)

            log_dbg("到后端的 TCP 通道已建立")

            # 3) 在该通道上使用 Windows 本地私钥 SSH 登录后端
            back = paramiko.SSHClient()
            back.set_missing_host_key_policy(paramiko.AutoAddPolicy())

            try:
                back.connect(
                    backend_host,
                    port=cfg.get("backend_port", 22),
                    username=backend_user,
                    key_filename=backend_key_path,
                    passphrase=backend_key_passphrase,
                    sock=chan,
                    timeout=20,
                    auth_timeout=20,
                    banner_timeout=20,
                    look_for_keys=False,
                    allow_agent=False,
                )
            except paramiko.AuthenticationException as e:
                back.close()
                jump.close()
                msg = "后端密钥认证失败：%s（账号 %s@%s，key=%s）" % (
                    e,
                    backend_user,
                    backend_host,
                    backend_key_path,
                )
                log_dbg(msg)
                raise RuntimeError(msg)
            except paramiko.PasswordRequiredException as e:
                back.close()
                jump.close()
                msg = "后端私钥需要 passphrase，但配置中未提供或不正确：%s" % e
                log_dbg(msg)
                raise RuntimeError(msg)
            except paramiko.SSHException as e:
                back.close()
                jump.close()
                msg = "连接后端失败：SSHException: %s（账号 %s@%s，key=%s）" % (
                    e,
                    backend_user,
                    backend_host,
                    backend_key_path,
                )
                log_dbg(msg)
                raise RuntimeError(msg)
            except Exception as e:
                back.close()
                jump.close()
                msg = "连接后端失败：%s: %s" % (type(e).__name__, e)
                log_dbg(msg)
                raise RuntimeError(msg)

            bt = back.get_transport()
            if bt is None or not bt.is_active():
                back.close()
                jump.close()
                msg = "后端 Transport 未激活"
                log_dbg(msg)
                raise RuntimeError(msg)

            bt.set_keepalive(30)
            log_dbg(
                "后端登录成功，建立本地转发 %d -> %s:%s"
                % (cfg["forward_port"], cfg["monitor_host"], cfg["monitor_port"])
            )

            # 4) 本地转发 forward_port → 后端 monitor_host:monitor_port
            try:
                fwd = make_forward_server(
                    cfg["forward_port"],
                    cfg["monitor_host"],
                    cfg["monitor_port"],
                    bt,
                )
            except OSError as e:
                back.close()
                jump.close()
                msg = "本地端口 %s 监听失败：%s。可能端口已被占用。" % (
                    cfg["forward_port"],
                    e,
                )
                log_dbg(msg)
                raise RuntimeError(msg)

            fwd_thread = threading.Thread(target=fwd.serve_forever, daemon=True)

            self.jump = jump
            self.backend = back
            self.fwd_server = fwd
            self.fwd_thread = fwd_thread
            self.backend_host = backend_host
            self.local_port = cfg["forward_port"]

            import time as _t
            self.started_at = _t.strftime("%Y-%m-%d %H:%M:%S")

            fwd_thread.start()
            log_dbg("隧道就绪，监控界面：http://localhost:%d/" % cfg["forward_port"])

    def stop(self):
        with self.lock:
            self.stop_locked()

    def stop_locked(self):
        if self.fwd_server is not None:
            try:
                self.fwd_server.shutdown()
            except Exception:
                pass
            try:
                self.fwd_server.server_close()
            except Exception:
                pass
            self.fwd_server = None

        if self.backend is not None:
            try:
                self.backend.close()
            except Exception:
                pass
            self.backend = None

        if self.jump is not None:
            try:
                self.jump.close()
            except Exception:
                pass
            self.jump = None

        self.backend_host = ""
        self.local_port = 0

    def is_alive(self):
        return bool(
            self.backend
            and self.backend.get_transport()
            and self.backend.get_transport().is_active()
        )


TUNNEL = Tunnel()
CFG = load_config()


# ----------------------------- 落地页 HTTP -----------------------------

HTML = """<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>cc-monitor - 连接器</title>
<style>
  *{{box-sizing:border-box}}
  body{{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
       background:#0f1419;color:#e6e6e6;margin:0;min-height:100vh;
       display:flex;align-items:center;justify-content:center;padding:24px}}
  .card{{background:#1a2029;border:1px solid #2a3340;border-radius:14px;
         padding:34px 36px;width:100%;max-width:460px;
         box-shadow:0 8px 32px rgba(0,0,0,.4)}}
  h1{{margin:0 0 6px;font-size:22px;font-weight:600}}
  .sub{{color:#8a96a3;font-size:13px;margin-bottom:24px;line-height:1.6}}
  label{{display:block;font-size:14px;color:#aeb8c4;margin:0 0 6px}}
  input{{width:100%;padding:11px 13px;font-size:15px;background:#0f1419;
         color:#e6e6e6;border:1px solid #2a3340;border-radius:8px;outline:none}}
  input:focus{{border-color:#3b82f6}}
  .row{{margin-bottom:18px}}
  button{{width:100%;padding:12px;font-size:15px;font-weight:600;border:none;
         border-radius:8px;cursor:pointer;color:#fff;background:#3b82f6;margin-top:4px}}
  button:hover{{background:#2f6fe0}}
  button.ghost{{background:#2a3340;color:#aeb8c4;margin-top:10px}}
  button.ghost:hover{{background:#333c4a}}
  .status{{margin-top:22px;padding:12px 14px;border-radius:8px;font-size:13px;
           background:#0f1419;border:1px solid #2a3340;color:#8a96a3;line-height:1.6}}
  .status.ok{{border-color:#1f6f43;color:#7fd9a3}}
  .status.err{{border-color:#8a2f2f;color:#f0a0a0}}
  .hosts{{margin-top:18px}}
  .hosts-title{{font-size:12px;color:#5f6b78;margin-bottom:8px}}
  .host-item{{display:block;font-family:Consolas,monospace;font-size:13px;color:#7fd9a3;
             padding:8px 12px;border:1px solid #2a3340;border-radius:8px;margin-bottom:7px;
             cursor:pointer;background:#0f1419;text-decoration:none;transition:.12s}}
  .host-item:hover{{background:#16202c;border-color:#3b82f6;color:#9ee7b8}}
  .open-link{{display:block;text-align:center;text-decoration:none;margin-top:10px;
              padding:12px;font-size:15px;font-weight:600;border-radius:8px;
              color:#fff;background:#1f6f43}}
  .open-link:hover{{background:#247a4e}}
  .hint{{margin-top:18px;font-size:12px;color:#5f6b78;line-height:1.6}}
  .mono{{font-family:Consolas,monospace;color:#7fd9a3}}
</style></head><body>
<div class="card">
  <h1>cc-monitor 连接器</h1>
  <div class="sub">
    填写后端主机名与跳板机密码，自动经跳板机打开隧道并跳转 cc-monitor。<br>
    跳板机 <span class="mono">{jumphost}</span> · 用户 <span class="mono">{juser}</span><br>
    后端用户 <span class="mono">{buser}</span> · 后端认证 <span class="mono">private key</span>
  </div>
  <form method="post" action="/connect">
    <div class="row">
      <label for="host">后端主机名 / IP</label>
      <input id="host" name="host" placeholder="例如 10.0.0.1"
             value="{host_val}" autofocus required>
    </div>
    <div class="row">
      <label for="pass">跳板机登录密码</label>
      <input id="pass" name="pass" type="password" placeholder="跳板机密码" required>
    </div>
    <button type="submit">连接并打开 cc-monitor</button>
  </form>
  {hosts_html}
  {status_html}
  {open_html}
  {disconnect_html}
  <div class="hint">
    提示：cc-monitor 界面地址为 <span class="mono">http://localhost:{fport}/</span>。<br>
    切换后端只需回到本页填新主机名即可，会自动关闭旧隧道。<br>
    后端私钥路径来自配置文件：<span class="mono">{key_path}</span>
  </div>
</div>
</body></html>"""


def html_escape(s):
    import html
    return html.escape(str(s), quote=True)


def render_page(error="", host_val=""):
    connected = TUNNEL.is_alive()

    if error:
        status_html = '<div class="status err">连接失败：' + html_escape(error) + "</div>"
    elif connected:
        status_html = (
            '<div class="status ok">已连接后端 <span class="mono">'
            + html_escape(TUNNEL.backend_host)
            + "</span>，自 "
            + html_escape(TUNNEL.started_at)
            + " 起。</div>"
        )
    elif TUNNEL.backend_host:
        status_html = (
            '<div class="status err">隧道已断开（后端 '
            + html_escape(TUNNEL.backend_host)
            + "）。请重新连接。</div>"
        )
    else:
        status_html = ""

    disconnect_html = (
        '<form method="post" action="/disconnect"><button type="submit" class="ghost">'
        "断开当前连接</button></form>"
        if (connected or TUNNEL.backend_host)
        else ""
    )

    open_html = (
        '<a class="open-link" href="http://localhost:%d/" target="_blank">重新打开 cc-monitor</a>'
        % CFG["forward_port"]
        if connected
        else ""
    )

    key_path = normalize_key_path(CFG.get("backend_key_path") or "")

    hosts = load_hosts()
    if hosts:
        from urllib.parse import quote
        items = "".join(
            '<a class="host-item" href="/?host=%s">%s</a>' % (quote(h, safe=''), html_escape(h))
            for h in hosts
        )
        hosts_html = ('<div class="hosts"><div class="hosts-title">最近后端主机（点击填入）</div>'
                      + items + '</div>')
    else:
        hosts_html = ""

    return HTML.format(
        jumphost=html_escape(CFG["jumphost"]),
        juser=html_escape(CFG["jumphost_user"]),
        buser=html_escape(CFG.get("backend_user") or CFG["jumphost_user"]),
        host_val=html_escape(host_val),
        hosts_html=hosts_html,
        status_html=status_html,
        open_html=open_html,
        disconnect_html=disconnect_html,
        fport=CFG["forward_port"],
        key_path=html_escape(key_path or "未配置"),
    )


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, body, code=200, ctype="text/html; charset=utf-8"):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(self.path)
        if parsed.path == "/":
            qs = parse_qs(parsed.query)
            host_val = (qs.get("host", [""])[0] or "").strip()
            self._send(render_page(host_val=host_val))
            return

        self._send(render_page("未知请求"), code=404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length).decode("utf-8", "replace") if length else ""

        from urllib.parse import parse_qs

        form = parse_qs(raw)
        host = (form.get("host", [""])[0] or "").strip()
        password = form.get("pass", [""])[0] or ""

        if self.path == "/connect":
            try:
                TUNNEL.start(CFG, host, password)
            except Exception as e:
                self._send(render_page(str(e), host))
                return

            push_host(host)   # 连接成功才记入历史（最新在前，去重，最多 10 条）

            target = "http://localhost:%d/" % CFG["forward_port"]
            self.send_response(302)
            self.send_header("Location", target)
            self.end_headers()
            return

        if self.path == "/disconnect":
            TUNNEL.stop()
            self.send_response(302)
            self.send_header("Location", "/")
            self.end_headers()
            return

        self._send(render_page("未知请求", host), code=404)


def main():
    if paramiko is None:
        print("=" * 56)
        print("缺少依赖 paramiko。请在 Windows 上执行：")
        print("    pip install paramiko")
        print("=" * 56)
        try:
            input("按回车退出...")
        except Exception:
            pass
        return

    key_path = normalize_key_path(CFG.get("backend_key_path") or "")

    if not key_path:
        print("[连接器] 警告：connector_config.json 中未配置 backend_key_path。")
        print("[连接器] 请填写 Windows 本地私钥路径，例如：")
        print("    C:/Users/你的用户名/.ssh/id_ed25519")
        print()

    elif not os.path.exists(key_path):
        print("[连接器] 警告：backend_key_path 指向的文件不存在：")
        print("    " + key_path)
        print()

    port = CFG["landing_port"]
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)

    url = "http://localhost:%d/" % port
    print("[连接器] 落地页已就绪：" + url)
    print("[连接器] 跳板机：%s@%s:%s" % (
        CFG["jumphost_user"],
        CFG["jumphost"],
        CFG.get("jumphost_port", 22),
    ))
    print("[连接器] 后端用户：%s" % (CFG.get("backend_user") or CFG["jumphost_user"]))
    print("[连接器] 后端私钥：" + (key_path or "未配置"))
    print("[连接器] cc-monitor 界面将跳转到：http://localhost:%d/" % CFG["forward_port"])
    print("[连接器] Ctrl+C 退出。")

    if CFG.get("auto_open_browser", True):
        try:
            webbrowser.open(url)
        except Exception:
            pass

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[连接器] 正在退出，关闭隧道...")
    finally:
        TUNNEL.stop()
        srv.server_close()


if __name__ == "__main__":
    main()