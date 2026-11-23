#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
album-push.py —— 相册后台的写入口（NAS 侧哑管道）

职责只有六件事，不含任何业务规则（归类和文案都在前端 admin.js 里）：
  ⓪ 发令牌        POST /api/auth  校验口令，发一个短效令牌（进后台用）
  ① 验口令        PBKDF2-HMAC-SHA256（pbkdf2$轮数$盐$dk），常数时间比较
  ② 验请求        体积 ≤2MB、JSON 可解析、顶层 key 白名单
  ③ 验文件        照片文件名在 /srv/pub/img 下真的存在（防死链）
  ④ 存档         旧版 content.json 存 /var/lib/tailscale/history/
  ⑤ 提交          PUT 到 GitHub，用 NAS 本地的 .gh_token

口令为什么用 PBKDF2：口令只有 6 位数字，10^6 个候选空间。老格式是
sha256(盐+口令)——单卡一秒能算几千万次，拿到 push-secret 就等于拿到口令。
PBKDF2 20 万轮把单次校验拖到 ~50ms，爆破成本抬到万倍级，仍不影响正常使用。
push-secret 里同时兼容老格式（盐:sha256），下次 --set-key 自动升级成新格式。

为什么要有这一层（而不是浏览器直接连 GitHub）：
  - token 不进浏览器。浏览器泄漏最多丢一个口令，丢不了仓库写权限
  - 攻击面收窄到「只能改 data/content.json」一个文件，改不了 index.html
  - 服务端能挡掉「照片数骤降」「文件名不存在」这类前端 bug

用法：
  python3 album-push.py --set-key '<口令>'     # 生成/重置口令（写 push-secret）
  python3 album-push.py --check                # 看一眼口令/token 有没有
  python3 album-push.py                        # 前台运行，监听 8787
接口：
  GET  /api/health   存活 + 有没有设过口令
  POST /api/auth     {key} → {ok, token, ttl}   进后台的令牌（默认 12 小时）
  POST /api/login    {code} → {ok, token, ttl}  相册门禁：动态码或访客口令换看图的票
  GET  /api/gate?k=  → 204/401                  给 Caddy forward_auth 用的校验口
  POST /api/save     需 X-Admin-Auth 或 X-Admin-Key
  POST /api/pull|run 运维，需 X-Admin-Key
环境变量：
  ALBUM_PUSH_PORT   默认 8787
  ALBUM_PUSH_ROOT   静态根目录，默认 /srv/pub
  ALBUM_HOME        状态目录，默认 /var/lib/tailscale
  ALBUM_REPO        默认 elizond0/album
  ALBUM_ALLOW_ORIGIN  默认 https://elizond0.github.io
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get("ALBUM_PUSH_PORT", "8787"))
ROOT = Path(os.environ.get("ALBUM_PUSH_ROOT", "/srv/pub"))
HOME = Path(os.environ.get("ALBUM_HOME", "/var/lib/tailscale"))
REPO = os.environ.get("ALBUM_REPO", "elizond0/album")
ORIGIN = os.environ.get("ALBUM_ALLOW_ORIGIN", "https://elizond0.github.io")
FILE_PATH = "data/content.json"
BRANCH = "main"

SECRET_F = HOME / "push-secret"
TOKEN_F = HOME / ".gh_token"
HIST_DIR = HOME / "history"
LOG_F = HOME / "album-push.log"
CHANGE_F = HOME / "changes.jsonl"   # 改动日志：每次提交成功写一条（人话摘要）
CHANGE_MAX = 200                    # 只留最近 200 条

MAX_BODY = 2 * 1024 * 1024
TOP_KEYS = {"version", "builtAt", "base", "meta", "events", "timeline", "quotes", "wishes", "photos", "videos"}
RATE_WINDOW = 60
RATE_MAX = 5            # 单 IP 每分钟 5 次（正常改文案根本用不到）
RATE_GLOBAL_MAX = 15    # 全局每分钟 15 次
DROP_RATIO = 0.95       # 照片数掉到上次的 95% 以下就拒

# 口令哈希：pbkdf2$<轮数>$<盐 hex>$<dk hex>
PBKDF2_ITER = 200_000
TOKEN_TTL = 12 * 3600   # 进后台的令牌有效期，够一个下午改文案
TOKEN_MAX = 200         # 内存里最多留多少个令牌，超了先丢最老的

# ── 相册门禁（看图的票）──────────────────────────────────────────
# 和进后台的令牌分开存：后台票 12 小时、只有 200 个坑；看图的票要能挂 30 天，
# 而且每张照片都会带一次，量级完全不同，混在一起会把后台票挤掉。
GUEST_F = HOME / "guest-key"      # 访客口令哈希（给家人看，不带动态码）
GATE_F = HOME / "gate-tokens.json"  # 看图的票，落盘，容器重启不掉线
GATE_TTL_TOTP = 12 * 3600         # 动态码登录：12 小时
GATE_TTL_GUEST = 30 * 86400       # 访客口令登录：30 天
GATE_MAX = 500                    # 票的容量上限，超了先丢最老的

_hits = {}              # ip -> [ts, ...]
_g_hits = deque()       # 全局时间戳队列
_tokens = {}            # token -> 过期时间戳
_gates = {}             # 看图的票 -> 过期时间戳（启动时从 GATE_F 读回）
_auth_fail = deque()    # 全局鉴权失败时间戳，用于「口令被爆破」刹车
AUTH_FAIL_MAX = 12      # 一分钟内全局失败 12 次就短暂停止受理校验


def now_cn(fmt="%Y-%m-%d %H:%M:%S"):
    """容器时区是 UTC，而用户和 GitHub 页面看到的都是北京时间。
    统一按 UTC+8 生成给人看的时间，别让日志和版本时间戳差 8 小时。"""
    return time.strftime(fmt, time.gmtime(time.time() + 8 * 3600))


def log(msg):
    line = f"{now_cn()} {msg}"
    print(line, flush=True)
    try:
        with open(LOG_F, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        if LOG_F.stat().st_size > 400_000:          # 别无限长
            lines = LOG_F.read_text(encoding="utf-8").splitlines()[-2000:]
            LOG_F.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        pass


def load_secret():
    """返回 push-secret 里的原始字符串；文件不存在/为空返回 ""。"""
    try:
        return SECRET_F.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def make_secret(key: str, iter_: int = PBKDF2_ITER):
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", key.encode("utf-8"), salt, iter_, dklen=32)
    HOME.mkdir(parents=True, exist_ok=True)
    SECRET_F.write_text(f"pbkdf2${iter_}${salt.hex()}${dk.hex()}\n", encoding="utf-8")
    os.chmod(SECRET_F, 0o600)
    return SECRET_F


def check_key(key: str) -> bool:
    """常数时间比对。兼容老的 `盐:sha256` 格式，升级靠下次 --set-key。"""
    raw = load_secret()
    if not raw or not key:
        return False
    if raw.startswith("pbkdf2$"):
        try:
            _, iter_s, salt_hex, dk_hex = raw.split("$", 3)
            dk = hashlib.pbkdf2_hmac(
                "sha256", key.encode("utf-8"), bytes.fromhex(salt_hex), int(iter_s), dklen=32
            )
            return hmac.compare_digest(dk.hex(), dk_hex)
        except (ValueError, TypeError):
            return False
    try:
        salt, want = raw.split(":", 1)
    except ValueError:
        return False
    got = hashlib.sha256((salt + key).encode("utf-8")).hexdigest()
    return hmac.compare_digest(got, want)


def _write_hash(path: Path, key: str, iter_: int = PBKDF2_ITER):
    """把口令写成 pbkdf2$轮数$盐$dk，0600。访客口令与后台口令同一套格式。"""
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", key.encode("utf-8"), salt, iter_, dklen=32)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"pbkdf2${iter_}${salt.hex()}${dk.hex()}\n", encoding="utf-8")
    os.chmod(path, 0o600)
    return path


def _check_hash(path: Path, key: str) -> bool:
    try:
        raw = path.read_text(encoding="utf-8").strip()
    except OSError:
        return False
    if not raw or not key:
        return False
    try:
        _, iter_s, salt_hex, dk_hex = raw.split("$", 3)
        dk = hashlib.pbkdf2_hmac(
            "sha256", key.encode("utf-8"), bytes.fromhex(salt_hex), int(iter_s), dklen=32
        )
        return hmac.compare_digest(dk.hex(), dk_hex)
    except (ValueError, TypeError):
        return False


def check_guest(key: str) -> bool:
    """访客口令：只给看，不给改。没设就返回 False（门禁只认动态码）。"""
    return _check_hash(GUEST_F, key)


def guest_enabled() -> bool:
    return GUEST_F.exists()


# ---------- 看图令牌（Caddy forward_auth 用）----------

def _load_gates() -> dict:
    """值统一成 {"exp": 时间戳, "kind": "totp"|"guest"}。
    旧版写的是裸时间戳，读进来按 guest 处理——保守：旧票不自动获得后台权限。"""
    try:
        d = json.loads(GATE_F.read_text(encoding="utf-8"))
        now = time.time()
        out = {}
        for k, v in d.items():
            if isinstance(v, dict):
                exp = float(v.get("exp") or 0)
                kind = str(v.get("kind") or "guest")
            else:
                exp = float(v)
                kind = "guest"
            if exp > now:
                out[k] = {"exp": exp, "kind": "totp" if kind == "totp" else "guest"}
        return out
    except Exception:
        return {}


def _save_gates():
    try:
        HOME.mkdir(parents=True, exist_ok=True)
        GATE_F.write_text(json.dumps(_gates), encoding="utf-8")
        os.chmod(GATE_F, 0o600)
    except OSError:
        pass


def issue_gate(ttl: float, kind: str = "guest") -> str:
    now = time.time()
    for t in [t for t, g in _gates.items() if float((g or {}).get("exp") or 0) < now]:
        _gates.pop(t, None)
    while len(_gates) >= GATE_MAX:
        _gates.pop(next(iter(_gates)), None)
    tok = secrets.token_urlsafe(32)
    _gates[tok] = {"exp": now + ttl, "kind": "totp" if kind == "totp" else "guest"}
    _save_gates()
    return tok


def check_gate(tok: str) -> bool:
    if not tok:
        return False
    g = _gates.get(tok)
    if not g:
        return False
    if float((g or {}).get("exp") or 0) < time.time():
        _gates.pop(tok, None)
        _save_gates()
        return False
    return True


def gate_kind(tok: str) -> str:
    """投票的来历：totp（手机动态码/恢复码）还是 guest（访客口令）。"""
    g = _gates.get(tok)
    return str((g or {}).get("kind") or "") if g else ""


# ---------- 动态码 TOTP（RFC 6238）----------
# 实现已抽到公共模块 totp_auth.py（拓展工具/验证码，运行副本与本脚本同目录）。
# 本文件只保留调用面：名字不变，其他代码一行不用改。
# ⚠ 部署时 totp_auth.py 必须和本脚本放在一起，缺了它服务起不来。
import totp_auth as _t
TOTP_STEP, TOTP_DIGITS, TOTP_SKEW = _t.STEP, _t.DIGITS, _t.SKEW
TOTP_F, RECOVERY_F = _t.secret_file(), _t.recovery_file()
totp_secret = _t.secret
totp_enabled = _t.enabled
totp_at = _t.totp_at
check_totp = _t.check_totp
check_recovery = _t.check_recovery
make_totp = _t.make_totp
recovery_file = _t.recovery_file
_recovery_left = _t.recovery_left


def _print_qr(text: str) -> bool:
    """在终端打二维码。有 qrcode 库就用，没就退回只给手动密钥。"""
    try:
        import qrcode
    except ImportError:
        print("（终端没装 qrcode 库，跳过二维码，用下面的手动密钥即可）")
        return False
    q = qrcode.QRCode(border=1)
    q.add_data(text)
    q.make(fit=True)
    q.print_ascii(invert=True)
    return True


def note_fail():
    """记一次口令失败；调用方据此判断要不要刹车。"""
    now = time.time()
    while _auth_fail and now - _auth_fail[0] > RATE_WINDOW:
        _auth_fail.popleft()
    _auth_fail.append(now)
    return len(_auth_fail)


def auth_braked() -> bool:
    now = time.time()
    while _auth_fail and now - _auth_fail[0] > RATE_WINDOW:
        _auth_fail.popleft()
    return len(_auth_fail) >= AUTH_FAIL_MAX


def issue_token() -> str:
    now = time.time()
    for t, exp in list(_tokens.items()):          # 顺手清过期
        if exp < now:
            _tokens.pop(t, None)
    while len(_tokens) >= TOKEN_MAX:              # 超量先踢最老的
        _tokens.pop(next(iter(_tokens)), None)
    tok = secrets.token_urlsafe(32)
    _tokens[tok] = now + TOKEN_TTL
    return tok


def check_token(tok: str) -> bool:
    if not tok:
        return False
    exp = _tokens.get(tok)
    if not exp:
        return False
    if exp < time.time():
        _tokens.pop(tok, None)
        return False
    return True


def gh(path, method="GET", body=None, timeout=90):
    token = TOKEN_F.read_text(encoding="utf-8").strip()
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "album-push",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode() or "{}")


def remote_sha():
    """trees 接口只回目录清单（几百字节，0.6s）；contents 要下整个 316KB（9s）。"""
    try:
        s, j = gh(f"/git/trees/{BRANCH}:data", timeout=20)
        if s == 200:
            for x in j.get("tree", []):
                if x.get("path") == "content.json":
                    return x.get("sha")
    except Exception as e:
        log(f"trees 失败，回退 contents: {type(e).__name__}")
    s, j = gh(f"/contents/{FILE_PATH}?ref={BRANCH}")
    return j.get("sha")


def archive(old_bytes: bytes):
    try:
        HIST_DIR.mkdir(parents=True, exist_ok=True)
        name = time.strftime("content-%Y%m%d-%H%M%S.json")
        (HIST_DIR / name).write_bytes(old_bytes)
        files = sorted(HIST_DIR.glob("content-*.json"))
        for f in files[:-30]:                       # 只留最近 30 份
            f.unlink()
        return name
    except OSError as e:
        log(f"存档失败（不阻断）: {e}")
        return ""


# ── 改动日志 ────────────────────────────────────────────────────────
# 为什么不让前端自己记：前端只知道「我改了什么」，不知道「到底有没有提交成功」。
# 而且换设备、清缓存就断了。放在 NAS 上，以「提交成功」为准，是唯一可信的口径。
# 为什么不用 GitHub commit diff：content.json 一整份 350 KB，保存一次整文件重写，
# diff 里全是噪音。这里在服务端把新旧两版结构化对比一遍，只写人话。
_HOME_FIELDS = [
    ("photoRows", "首页照片墙行数"),
    ("photoRowsMax", "首页照片墙最多行数"),
    ("timelineCount", "时间轴条数"),
    ("quoteRows", "随手记行数"),
    ("wishCount", "心愿条数"),
    ("showVideos", "影像板块"),
]
_PAGE_FIELDS = [
    ("photosCols", "照片墙列数"),
    ("photosRows", "照片墙每页行数"),
    ("quotesCols", "随手记列数"),
    ("wishLimit", "心愿单条数"),
]
_PHOTO_FIELDS = [("title", "描述"), ("desc", "补充"), ("date", "日期"),
                 ("place", "地点"), ("hidden", "隐藏"), ("featured", "精选")]


def _same(a, b):
    if isinstance(a, (dict, list)) or isinstance(b, (dict, list)):
        return json.dumps(a, ensure_ascii=False, sort_keys=True) == json.dumps(b, ensure_ascii=False, sort_keys=True)
    return a == b


def summarize(old, new):
    """把新旧两版 content.json 的差异讲成人话，返回字符串列表。"""
    out = []
    om, nm = old.get("meta") or {}, new.get("meta") or {}

    for k, label in (("anniversary", "纪念日"), ("hero", "首屏照片")):
        if not _same(om.get(k), nm.get(k)):
            out.append(f"{label}：{om.get(k) or '—'} → {nm.get(k) or '—'}")
    oc, nc = om.get("couple") or {}, nm.get("couple") or {}
    if not _same(oc, nc):
        out.append(f"昵称：{oc.get('a', '')}/{oc.get('b', '')} → {nc.get('a', '')}/{nc.get('b', '')}")

    oh, nh = om.get("home") or {}, nm.get("home") or {}
    for k, label in _HOME_FIELDS:
        if not _same(oh.get(k), nh.get(k)):
            out.append(f"{label}：{oh.get(k, '—')} → {nh.get(k, '—')}")
    if not _same(oh.get("order"), nh.get("order")):
        out.append("首页板块顺序有调整")

    op, npp = om.get("pages") or {}, nm.get("pages") or {}
    for k, label in _PAGE_FIELDS:
        if not _same(op.get(k), npp.get(k)):
            out.append(f"{label}：{op.get(k, '—')} → {npp.get(k, '—')}")

    ot, nt = om.get("texts") or {}, nm.get("texts") or {}
    changed = [k for k in set(ot) | set(nt) if not _same(ot.get(k), nt.get(k))]
    if changed:
        head = "、".join(sorted(changed)[:3]) + ("…" if len(changed) > 3 else "")
        out.append(f"文案：改了 {len(changed)} 处（{head}）")

    def pmap(doc):
        m = {}
        for p in doc.get("photos") or []:
            m[str(p.get("file") or p.get("src") or "")] = p
        return m

    opm, npm = pmap(old), pmap(new)
    added = [f for f in npm if f not in opm]
    removed = [f for f in opm if f not in npm]
    mod = 0
    fields = set()
    for f in npm:
        if f not in opm:
            continue
        for k, label in _PHOTO_FIELDS:
            if not _same(opm[f].get(k), npm[f].get(k)):
                mod += 1
                fields.add(label)
                break
    bits = []
    if added:
        bits.append(f"新增 {len(added)} 张")
    if removed:
        bits.append(f"删除 {len(removed)} 张")
    if mod:
        bits.append(f"修改 {mod} 张（{'/'.join(sorted(fields))}）")
    if bits:
        out.append("照片：" + "、".join(bits))

    for key, label in (("events", "事件"), ("timeline", "时间轴"), ("quotes", "随手记"), ("wishes", "愿望"), ("videos", "影像")):
        oa, na = old.get(key) or [], new.get(key) or []
        if _same(oa, na):
            continue
        if len(oa) != len(na):
            out.append(f"{label}：{len(oa)} → {len(na)} 条")
        elif not _same(oa, na):
            n = sum(1 for a, b in zip(oa, na) if not _same(a, b))
            out.append(f"{label}：改了 {n} 条")

    if not out:
        out.append("内容没有实质变化（只刷新了版本时间）")
    if len(out) > 12:
        out = out[:12] + [f"…另有 {len(out) - 12} 项"]
    return out


def append_change(entry):
    try:
        with open(CHANGE_F, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        lines = CHANGE_F.read_text(encoding="utf-8").splitlines()
        if len(lines) > CHANGE_MAX:
            CHANGE_F.write_text("\n".join(lines[-CHANGE_MAX:]) + "\n", encoding="utf-8")
    except OSError as e:
        log(f"写改动日志失败（不阻断）: {e}")


def read_changes(limit=30):
    """按时间倒序返回。不依赖文件里行的先后：补录、时钟回拨、多进程写都可能乱序，
    直接按 t 排序最省心（t 是 YYYY-MM-DD HH:MM:SS，字典序即时间序）。"""
    try:
        lines = CHANGE_F.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    items = []
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        try:
            items.append(json.loads(ln))
        except Exception:
            continue
    items.sort(key=lambda x: str(x.get("t") or ""), reverse=True)
    return items[:limit]


def check_photos(doc):
    """照片数不能骤降 + 文件名必须真的在 /srv/pub/img 下。返回错误信息或 None。"""
    photos = doc.get("photos")
    if not isinstance(photos, list) or not photos:
        return "photos 为空，拒绝提交（防止误把内容清空）"

    img = ROOT / "img"
    missing = []
    for p in photos:
        f = str(p.get("file") or "").replace("img/", "", 1)
        if not f:
            missing.append("(空文件名)")
            continue
        # 视频条目混在 photos 里时 file 形如 video/xxx.mp4，不能拿 img/ 去找。
        # 2026-11-16 实测：photos 562 条里没有 .mp4，但前端一旦允许把视频并入
        # photos，这条路径就会把所有视频判成「照片不存在」并 422。
        target = (ROOT / f) if f.startswith("video/") else (img / f)
        if not target.exists():
            missing.append(f)
        if len(missing) > 5:
            break
    if missing:
        return "这些照片文件在 NAS 上不存在：" + ", ".join(missing[:5])

    # 与上一次提交的数量比
    try:
        s, j = gh(f"/contents/{FILE_PATH}?ref={BRANCH}")
        old = json.loads(base64.b64decode(j["content"]))
        before = len(old.get("photos") or [])
        now = len(photos)
        if before and now < before * DROP_RATIO:
            return f"照片数从 {before} 掉到 {now}，超过 5% 阈值，拒绝提交"
    except Exception as e:
        log(f"数量比对跳过: {type(e).__name__}")
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "album-push/1.0"

    def _cors(self):
        # CORS 头一律由 Caddy 发（Caddyfile 里那几行）。
        # 这里再发一次会变成 "*, https://elizond0.github.io" 两个值，
        # 浏览器直接判 CORS 失败——实测就是这么挂的，改完 header 只剩一个值才通。
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def client_ip(self):
        # 隧道后面全是 127.0.0.1，必须读 cloudflared 注入的真实 IP
        return self.headers.get("CF-Connecting-IP") or self.client_address[0]

    def limited(self):
        now = time.time()

        # 全局闸门先判：出口 IP 可能是代理池（云沙箱、手机流量都会轮换），
        # 只按 IP 限速等于没限——实测 7 次连打，日志里出现了 6 个不同 IP 全放行。
        while _g_hits and now - _g_hits[0] > RATE_WINDOW:
            _g_hits.popleft()
        if len(_g_hits) >= RATE_GLOBAL_MAX:
            return True

        ip = self.client_ip()
        arr = [t for t in _hits.get(ip, []) if now - t < RATE_WINDOW]
        if len(arr) >= RATE_MAX:
            _hits[ip] = arr
            return True

        arr.append(now)
        _hits[ip] = arr
        _g_hits.append(now)
        return False

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    # ── 运维接口：自更新 / 代跑脚本 ───────────────────────────────────────
    #
    # 为什么需要这两个：这个容器只有「网页终端」一条交互通道，AI 想改一行脚本得
    # 逐段粘贴 base64，一次十分钟；而部署必读里写的「跑完看 /srv/pub/wb_setup.log」
    # 实际根本没这条通道（脚本只启动不落日志）。所以把两件事做成 HTTP 接口：
    #   /api/pull  用容器自己的 wget 从 GitHub raw 拉最新脚本，只覆盖内容有变化的文件
    #   /api/run   代跑一条**白名单内的**脚本
    # 安全边界：都要口令、都进全局限速；run 只认固定脚本名，不接受任意命令。
    SAFE_SCRIPTS = {
        "nas-setup": ["sh", "nas-setup.sh"],
        "pull": ["sh", "_pull.sh"],
        "index": ["python3", "mkindex.py", str(ROOT)],
        "thumb": ["python3", "mkthumb.py", str(ROOT)],
    }

    def _op(self, kind):
        if self.limited():
            return self._json(429, {"ok": False, "error": "太频繁了，等一下再试"})
        key = self.headers.get("X-Admin-Key", "")
        if not check_key(key):
            log(f"运维接口口令拒绝 ip={self.client_ip()} op={kind}")
            time.sleep(0.4)
            return self._json(401, {"ok": False, "error": "口令不对"})

        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        except Exception:
            return self._json(400, {"ok": False, "error": "body 不是 JSON"})

        if kind == "pull":
            files = body.get("files") or ["nas-setup.sh", "pub_vid.sh", "boot.sh", "album-push.py"]
            r = subprocess.run(["/bin/sh", str(HOME / "_pull.sh")] + files,
                              capture_output=True, text=True, timeout=300, cwd=str(HOME))
            log(f"pull rc={r.returncode}")
            return self._json(200, {"ok": r.returncode == 0, "rc": r.returncode,
                                    "out": (r.stdout + r.stderr)[-4000:]})

        name = body.get("script", "")
        cmd = self.SAFE_SCRIPTS.get(name)
        if not cmd:
            return self._json(400, {"ok": False, "error": f"不在白名单：{name}",
                                    "allowed": sorted(self.SAFE_SCRIPTS)})
        # 不复用 nas-setup 的终端环境；输出直接落 wb_setup.log，浏览器可读
        logf = ROOT / "wb_setup.log"
        with open(logf, "w", encoding="utf-8") as f:
            p = subprocess.Popen(cmd, stdout=f, stderr=subprocess.STDOUT,
                                 cwd=str(HOME), stdin=subprocess.DEVNULL,
                                 start_new_session=True)
        log(f"run {name} pid={p.pid}")
        return self._json(200, {"ok": True, "pid": p.pid, "script": name,
                                "log": "https://<当前隧道>/wb_setup.log"})

    # ── 进后台的口令校验 ──────────────────────────────────────────────
    # 为什么单独一个接口：进后台和「提交」是两件事。进门校验一次，之后页面拿着
    # 令牌改文案；点「保存并发布」时再问一次口令——两道门都落在 NAS 上，
    # 因为 6 位数字的任何哈希放在前端 JS 里都是公开的，等于没设。
    # ── 相册门禁：换一张「看图的票」──────────────────────────────
    # 为什么单独一个口：进后台那套（口令 + 动态码）是给自己用的，家人不该拿到
    # 仓库写权限。这里只发看图的票，票进不了 /api/save，泄了也改不了任何东西。
    def _login(self):
        if auth_braked():
            log(f"门禁失败过多，暂停受理 ip={self.client_ip()}")
            return self._json(429, {"ok": False, "error": "试错太多次了，等一分钟再来"})
        if self.limited():
            return self._json(429, {"ok": False, "error": "太频繁了，等一下再试"})

        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > 4096:
            return self._json(413, {"ok": False, "error": "体积异常"})
        try:
            body = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return self._json(400, {"ok": False, "error": "body 不是 JSON"})

        code = str((body or {}).get("code") or "").strip()
        if not code:
            return self._json(400, {"ok": False, "error": "没填验证码"})

        ok_totp = totp_enabled() and (check_totp(code) or check_recovery(code))
        ok_guest = (not ok_totp) and check_guest(code)

        if not (ok_totp or ok_guest):
            hit = note_fail()
            log(f"门禁拒绝 ip={self.client_ip()} 窗口内失败={hit}")
            time.sleep(0.4)
            return self._json(401, {"ok": False, "error": "验证码或口令不对"})

        ttl = GATE_TTL_TOTP if ok_totp else GATE_TTL_GUEST
        kind = "totp" if ok_totp else "guest"
        tok = issue_gate(ttl, kind)
        log(f"门禁通过 ip={self.client_ip()} kind={kind} ttl={int(ttl)}s")
        return self._json(200, {"ok": True, "token": tok, "ttl": int(ttl), "kind": kind})

    def _auth(self):
        if auth_braked():
            log(f"口令失败过多，暂停受理 ip={self.client_ip()}")
            return self._json(429, {"ok": False, "error": "试错太多次了，等一分钟再来"})
        if self.limited():
            return self._json(429, {"ok": False, "error": "太频繁了，等一下再试"})

        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > 4096:
            return self._json(413, {"ok": False, "error": "体积异常"})
        try:
            body = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return self._json(400, {"ok": False, "error": "body 不是 JSON"})

        key = str((body or {}).get("key") or "")
        if not check_key(key):
            hit = note_fail()
            log(f"进门口令拒绝 ip={self.client_ip()} 窗口内失败={hit}")
            time.sleep(0.4)                       # 拖慢爆破
            return self._json(401, {"ok": False, "error": "口令不对"})

        # 动态码：开了就必须过。口令对了但码不对，不记 note_fail——
        # 否则一个人输错手机验证码会把全站锁一分钟。
        if totp_enabled():
            code = str((body or {}).get("code") or "")
            if not check_totp(code) and not check_recovery(code):
                log(f"动态码拒绝 ip={self.client_ip()}")
                time.sleep(0.4)
                return self._json(401, {"ok": False, "error": "动态码不对", "totp": True})

        tok = issue_token()
        log(f"进门口令通过 ip={self.client_ip()} ttl={TOKEN_TTL}s")
        return self._json(200, {"ok": True, "token": tok, "ttl": TOKEN_TTL})

    def _ok_admin(self) -> bool:
        """令牌优先（进门时校验过），退回一次性口令（老页面 / 运维脚本）。
        开了动态码时，走 X-Admin-Key 的老通道还得多带 X-Admin-Code，否则只靠
        静态口令就能绕过动态码。"""
        tok = self.headers.get("X-Admin-Auth", "")
        if check_token(tok):
            return True
        # 2026-11-23：用动态码换来的看图票，等同后台票——同一个人、同一次验证，
        # 没必要让他在同一个浏览器里再输一遍。访客口令换的票 kind=guest，不给。
        if check_gate(tok) and gate_kind(tok) == "totp":
            return True
        if not check_key(self.headers.get("X-Admin-Key", "")):
            return False
        if totp_enabled():
            code = self.headers.get("X-Admin-Code", "")
            return check_totp(code) or check_recovery(code)
        return True

    def do_GET(self):
        # 对外只回一个存活信号。端口号、有没有设口令、存储格式这些都属于
        # 内部信息，公开出去只会帮攻击者缩小范围。要看详情在本机跑 --check。
        p = self.path.split("?")[0]

        # Caddy 的 forward_auth 对每个照片/视频请求都来问一次，这里绝不能限速，
        # 否则一屏 30 张图就把自己锁死。只做一次字典查表 + 常数时间比对。
        if p == "/api/gate":
            q = urllib.parse.parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            ok = check_gate((q.get("k") or [""])[0])
            if ok and self.command == "HEAD":
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self._cors()
                self.end_headers()
                return
            self._json(204 if ok else 401, {"ok": True} if ok else {"ok": False})
            return

        if p == "/api/log":
            # 改动日志里有「删了哪些照片、改了哪些设置」，只给后台登录的人看。
            # 和 /api/save 用同一套身份判断（令牌或口令+动态码）。
            if not self._ok_admin():
                return self._json(401, {"ok": False, "error": "需要后台登录"})
            q = urllib.parse.parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            try:
                lim = int((q.get("limit") or ["30"])[0])
            except ValueError:
                lim = 30
            lim = max(1, min(200, lim))
            return self._json(200, {"ok": True, "items": read_changes(lim)})

        if p == "/api/health":
            self._json(200, {"ok": True})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    do_HEAD = do_GET

    def do_POST(self):
        p = self.path.split("?")[0]
        if p == "/api/login":
            return self._login()
        if p == "/api/auth":
            return self._auth()
        if p == "/api/pull":
            return self._op("pull")
        if p == "/api/run":
            return self._op("run")
        if p != "/api/save":
            return self._json(404, {"ok": False, "error": "not found"})

        if self.limited():
            return self._json(429, {"ok": False, "error": "太频繁了，等一下再试"})

        if not self._ok_admin():
            note_fail()
            log(f"提交口令/令牌拒绝 ip={self.client_ip()}")
            time.sleep(0.4)                       # 拖慢爆破
            return self._json(401, {"ok": False, "error": "口令不对"})

        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            return self._json(413, {"ok": False, "error": f"体积异常（{n} 字节）"})
        raw = self.rfile.read(n)

        try:
            doc = json.loads(raw.decode("utf-8"))
        except Exception as e:
            return self._json(400, {"ok": False, "error": f"不是合法 JSON: {e}"})

        if not isinstance(doc, dict):
            return self._json(400, {"ok": False, "error": "顶层必须是对象"})
        extra = set(doc) - TOP_KEYS
        if extra:
            return self._json(400, {"ok": False, "error": f"出现未知字段：{sorted(extra)}"})

        err = check_photos(doc)
        if err:
            log(f"校验拒绝：{err}")
            return self._json(422, {"ok": False, "error": err})

        try:
            sha = remote_sha()
        except Exception as e:
            log(f"读远端 sha 失败: {e}")
            return self._json(502, {"ok": False, "error": "读不到 GitHub 上的当前版本"})

        # 存档旧版（尽力而为，失败不阻断）；顺手留下旧 doc，提交成功后用来算改动摘要
        saved = ""
        old_doc = None
        try:
            s, j = gh(f"/contents/{FILE_PATH}?ref={BRANCH}")
            raw_old = base64.b64decode(j["content"])
            saved = archive(raw_old)
            old_doc = json.loads(raw_old.decode("utf-8"))
        except Exception as e:
            log(f"取旧版失败: {type(e).__name__}")

        msg = now_cn("admin: 更新 content.json（%Y-%m-%d %H:%M）")
        body = {
            "message": msg,
            "content": base64.b64encode(raw).decode(),
            "branch": BRANCH,
        }
        if sha:
            body["sha"] = sha
        try:
            s, r = gh(f"/contents/{FILE_PATH}", "PUT", body, timeout=120)
            commit = (r.get("commit") or {}).get("sha", "")
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = json.loads(e.read().decode()).get("message", "")
            except Exception:
                pass
            code = 409 if e.code == 409 else 502
            log(f"提交失败 HTTP {e.code} {detail}")
            if e.code == 409:
                return self._json(409, {"ok": False, "error": "远端刚被改过，刷新页面重试"})
            return self._json(code, {"ok": False, "error": f"GitHub 返回 {e.code}：{detail}"})
        except Exception as e:
            log(f"提交异常: {type(e).__name__}: {e}")
            return self._json(502, {"ok": False, "error": "连不上 GitHub"})

        log(f"提交成功 commit={commit[:7]} photos={len(doc.get('photos') or [])} archive={saved}")
        # 改动日志以「提交成功」为准。old_doc 取不到（比如首次部署）时只记数量变化。
        diffs = summarize(old_doc, doc) if isinstance(old_doc, dict) else ["首次提交（没有可比对的旧版本）"]
        entry = {
            "t": now_cn(),
            "commit": commit,
            "photos": len(doc.get("photos") or []),
            "videos": len(doc.get("videos") or []),
            "builtAt": doc.get("builtAt", ""),
            "by": "token" if self.headers.get("X-Admin-Auth") else "key",
            "ip": self.client_ip(),
            "size": len(raw),
            "changes": diffs,
        }
        append_change(entry)
        return self._json(200, {"ok": True, "commit": commit, "archive": saved, "changes": diffs})

    def log_message(self, fmt, *args):        # 别把默认访问日志刷进 journal
        pass


def main():
    _gates.update(_load_gates())          # 容器重启后，已经登录过的设备不用重输
    if len(sys.argv) >= 3 and sys.argv[1] == "--set-guest":
        _write_hash(GUEST_F, sys.argv[2])
        print(f"访客口令已写入 {GUEST_F}（pbkdf2，0600）。只能看图，改不了内容。")
        return 0
    if len(sys.argv) >= 2 and sys.argv[1] == "--no-guest":
        try:
            GUEST_F.unlink()
        except OSError:
            pass
        print("访客口令已关闭，门禁只认动态码")
        return 0
    if len(sys.argv) >= 3 and sys.argv[1] == "--set-key":
        make_secret(sys.argv[2])
        print(f"口令已写入 {SECRET_F}（pbkdf2，0600）")
        return 0
    if len(sys.argv) >= 2 and sys.argv[1] == "--check":
        raw = load_secret()
        fmt = "pbkdf2" if raw.startswith("pbkdf2$") else ("旧 sha256 格式（建议 --set-key 升级）" if raw else "未设置")
        print("secret:", fmt, "| token:", "有" if TOKEN_F.exists() else "缺")
        print("totp:  ", "开" if totp_enabled() else "关", "| 恢复码:", _recovery_left(), "个")
        n_t = sum(1 for g in _gates.values() if (g or {}).get("kind") == "totp")
        print("门禁:  ", "访客口令有" if guest_enabled() else "访客口令无",
              "| 有效票:", len(_gates), "张（动态码", n_t, "/ 访客", len(_gates) - n_t, "）")
        return 0
    if len(sys.argv) >= 2 and sys.argv[1] == "--set-totp":
        secret, codes, uri = make_totp()
        print("动态码已开启。用手机验证器 App 扫下面这个二维码（或手动输入密钥）：\n")
        _print_qr(uri)
        print(f"\n手动输入：{secret}")
        print("\n恢复码（手机丢了时用，每个只能用一次，抄到纸上，别存手机里）：")
        for c in codes:
            print("  " + c)
        print(f"\n校验一次当前码：python3 album-push.py --check")
        return 0
    if len(sys.argv) >= 2 and sys.argv[1] == "--off-totp":
        for f in (TOTP_F, RECOVERY_F):
            try:
                f.unlink()
            except OSError:
                pass
        print("动态码已关闭（口令仍在，PBKDF2 照旧）")
        return 0
    if len(sys.argv) >= 2 and sys.argv[1] == "--show-totp":
        s = totp_secret()
        if not s:
            print("动态码未开启。开启：python3 album-push.py --set-totp")
            return 0
        print("当前码:", totp_at(s), f"（{TOTP_STEP - int(time.time()) % TOTP_STEP} 秒后失效）")
        return 0

    if not load_secret():
        print("⚠ 还没设口令，先跑：python3 album-push.py --set-key '<口令>'", file=sys.stderr)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log(f"listening 127.0.0.1:{PORT} root={ROOT} origin={ORIGIN}")
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
