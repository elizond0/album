/* gate.js —— 相册门禁（页面级）
 *
 * 放在每个页面 <head> 里、且必须早于 scripts/site.js。
 * 职责三件：
 *   1. 有票 → window.__ALBUM_K 交给 site.js，让它给每个图片/视频地址拼 ?k=
 *   2. 没票 → 把整页藏起来，只显示一个输码的卡片；验过再整页重载
 *   3. 有票时右下角挂一个「退出」按钮 → 清掉本机验证痕迹再硬重载
 *
 * 为什么不是「验过之后局部显示」：内容脚本一旦开跑就会去拉 content.json 和
 * 几十张图，全得 401。整页重载最省事，也最不容易漏掉某个加载入口。
 *
 * 真正的权限判定在 NAS 上（Caddy forward_auth → album-push）
 * 这里只负责把票拿来存好，前端拿票是没用的：票不对，图就是 401。
 */
(function () {
  var KEY = "album_gate_v1";

  /* ---------- 退出：清掉本机所有验证痕迹 ----------
     只清本相册自己的键，同域下别的工具（值得买、PDF 工具站）不受牵连。
     为什么不止清 album_gate_v1：后台令牌在 sessionStorage，旧版还留过
     album-admin-hash / album-admin-key，只清门禁票会出现「页脚看着退了、
     后台还是登录态」的鬼影，测验证码时最容易误判。 */
  var DROP_LOCAL = ["album_gate_v1", "album-admin-hash", "album-admin-key"];
  var DROP_SESSION = ["album-admin-token", "album-admin-key"];

  function purge() {
    DROP_LOCAL.forEach(function (k) {
      try { localStorage.removeItem(k); } catch (e) {}
    });
    DROP_SESSION.forEach(function (k) {
      try { sessionStorage.removeItem(k); } catch (e) {}
    });
    // 兜底：以后新加的 album-* 键也不会漏。album-admin-totp 只是「后台已开
    // 动态码」的 UI 记忆，不是票，留着省得每次进后台重新勾一遍。
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (/^album[-_]/i.test(k) && k !== "album-admin-totp") localStorage.removeItem(k);
      });
    } catch (e) {}
    try {
      Object.keys(sessionStorage).forEach(function (k) {
        if (/^album[-_]/i.test(k)) sessionStorage.removeItem(k);
      });
    } catch (e) {}
  }

  function logout() {
    purge();
    // 带时间戳走 replace：① 绕过 index 的 HTTP 缓存，② 后退不会回到
    // 已经解锁过的页面快照。之后由下面那段把 out 参数从地址栏抹掉。
    var u = location.pathname + "?out=" + Date.now();
    if (location.hash) u += location.hash;
    location.replace(u);
  }
  window.__ALBUM_LOGOUT = logout;

  // 退出留下的 ?out=xxx 只是缓存戳，别让它赖在地址栏里
  try {
    var us = new URLSearchParams(location.search);
    if (us.has("out")) {
      us.delete("out");
      var qs = us.toString();
      history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    }
  } catch (e) {}

  var store = null;
  try {
    store = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch (e) {}

  // 票还在有效期内：直接放行，不发任何请求
  // k 记录这张票的来历：totp（手机动态码/恢复码）、admin（管理员口令）或 guest（访客口令）。
  // admin.html 靠它决定「是否免掉后台口令」——totp 与 admin 都免，guest 不免。
  if (store && store.t && +store.e > Date.now()) {
    window.__ALBUM_K = String(store.t);
    window.__ALBUM_KIND = String(store.k || "guest");
    mountExit();
    return;
  }
  if (store) {
    try {
      localStorage.removeItem(KEY);
    } catch (e) {}
  }

  var docEl = document.documentElement;
  docEl.className += " gate-locked";

  var BASE = "";        // 从 base.json 取，异步
  /* 上一次拿到的 API 地址存 sessionStorage：退出后整页重载，base.json 要重拉，
     慢的时候要等好几秒才输得了码。有缓存就先顶上，loadBase 回来再覆盖。
     键名故意不带 - / _，purge() 只清 album-*，所以退出不会把它一起清掉；
     隧道域名变了由 loadBase 覆盖修正，最坏情况多试一次。 */
  var BASE_CACHE = "albumBase";
  try {
    BASE = String(sessionStorage.getItem(BASE_CACHE) || "").replace(/\/+$/, "");
  } catch (e) {}

  var mounted = false;

  function css() {
    var s = document.createElement("style");
    // 配色照 styles/tokens.css 抄：石色纸面 + 古铜赭石，别让这道门看起来像另一个网站
    s.textContent = [
      "html.gate-locked body > *:not(.gate-overlay){display:none!important}",
      "html.gate-locked{background:#f2efe9}",
      ".gate-overlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;",
      "justify-content:center;padding:24px;",
      "background:radial-gradient(120% 90% at 50% 0%,#faf8f3 0%,#f0ece4 55%,#e5e0d6 100%);",
      "font-family:'LXGW WenKai','Kaiti SC','STKaiti','KaiTi','Songti SC','Noto Serif SC',serif;",
      "color:#2c2a26;-webkit-font-smoothing:antialiased}",
      ".gate-card{width:100%;max-width:380px;background:rgba(251,250,247,.94);",
      "border:1px solid rgba(44,42,38,.13);border-radius:18px;padding:34px 30px 26px;",
      "box-shadow:0 24px 64px rgba(46,42,36,.18)}",
      ".gate-card h1{margin:0 0 8px;font-size:21px;font-weight:600;letter-spacing:.03em}",
      ".gate-card p{margin:0 0 20px;font-size:13.5px;line-height:1.85;color:#6e6a61}",
      ".gate-input{width:100%;box-sizing:border-box;padding:13px 15px;font-size:17px;letter-spacing:.16em;",
      "font-family:inherit;background:#fff;border:1px solid rgba(44,42,38,.18);border-radius:11px;",
      "color:#2c2a26;outline:none;transition:border-color .2s,box-shadow .2s}",
      ".gate-input::placeholder{letter-spacing:.02em;color:#a9a29a}",
      ".gate-input:focus{border-color:#7a5c3a;box-shadow:0 0 0 3px rgba(122,92,58,.12)}",
      ".gate-btn{margin-top:16px;width:100%;padding:13px;font-size:15.5px;font-weight:600;letter-spacing:.1em;",
      "font-family:inherit;background:linear-gradient(180deg,#8a6842,#6d4f30);color:#fbf7ef;border:0;",
      "border-radius:11px;cursor:pointer;transition:filter .2s}",
      ".gate-btn:hover{filter:brightness(1.08)}",
      ".gate-btn:disabled{filter:grayscale(.55);cursor:default}",
      ".gate-msg{min-height:20px;margin-top:12px;font-size:12.5px;line-height:1.6;color:#a8432e}",
      ".gate-msg.ok{color:#4d7a5b}",
      ".gate-foot{margin-top:18px;padding-top:14px;border-top:1px solid rgba(44,42,38,.08);",
      "font-size:11.5px;line-height:1.8;color:#9a948a}",
      /* 右下角常驻的「退出」：平时半透明不抢戏，摸上去变实。
         尺寸按手指点得中算（高 34px 上下），不是那种 16px 藏起来的小点。 */
      ".gate-out{position:fixed;right:14px;bottom:14px;z-index:100000;display:inline-flex;",
      "align-items:center;gap:5px;padding:9px 15px;font-family:inherit;font-size:13px;",
      "line-height:1;letter-spacing:.08em;color:#5b574f;background:rgba(251,250,247,.95);",
      "border:1px solid rgba(44,42,38,.2);border-radius:999px;cursor:pointer;opacity:.72;",
      "-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);",
      "transition:opacity .2s,color .2s,border-color .2s,box-shadow .2s}",
      ".gate-out:hover,.gate-out:focus-visible{opacity:1;color:#7a5c3a;",
      "border-color:rgba(122,92,58,.5);box-shadow:0 6px 18px rgba(46,42,36,.15);outline:none}",
      ".gate-out:active{transform:translateY(1px)}",
      "@media (max-width:520px){.gate-out{right:10px;bottom:10px;padding:8px 13px;",
      "font-size:12.5px;opacity:.82}}",
      "@media print{.gate-out{display:none}}"
    ].join("");
    return s;
  }

  /* ---------- 右下角「退出」按钮 ----------
     只挂一次。后台页自己导航栏里已有「退出管理」，这里就不重复放一个。 */
  function mountExit() {
    function add() {
      if (!document.body) return;
      if (document.querySelector(".gate-out")) return;
      if (document.getElementById("logout-btn")) return;
      document.head.appendChild(css());
      var b = document.createElement("button");
      b.className = "gate-out";
      b.type = "button";
      b.title = "清空本机的验证票，回到输码页（改完验证码用它自测）";
      b.textContent = "退出";
      b.addEventListener("click", logout);
      document.body.appendChild(b);
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", add);
    } else {
      add();
    }
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    document.head.appendChild(css());

    var box = document.createElement("div");
    box.className = "gate-overlay";
    box.innerHTML =
      '<form class="gate-card" autocomplete="off">' +
      "<h1>这是私人相册</h1>" +
      "<p>输入验证器上的 6 位动态码，或管理员口令。</p>" +
      '<input class="gate-input" type="text" name="code" inputmode="text" ' +
      'autocomplete="one-time-code" autocapitalize="off" autocorrect="off" spellcheck="false" ' +
      'placeholder="6 位数字 / 管理员口令" />' +
      '<button class="gate-btn" type="submit">进入</button>' +
      '<div class="gate-msg"></div>' +
      '<div class="gate-foot">验证一次可看 12 小时。<br />' +
      "票只存在这台设备上。想换码重验，点右下角「退出」。</div>" +
      "</form>";
    document.body.appendChild(box);

    var form = box.querySelector("form");
    var input = box.querySelector(".gate-input");
    var btn = box.querySelector(".gate-btn");
    var msg = box.querySelector(".gate-msg");
    setTimeout(function () {
      try {
        input.focus();
      } catch (e) {}
    }, 60);

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var code = (input.value || "").trim();
      if (!code) {
        msg.textContent = "先填验证码";
        return;
      }
      if (!BASE) {
        // 刚退出/刚打开时 base.json 还在路上。别让人再点一次——
        // 挂着「正在连接」，拿到地址自动续上这次提交。
        msg.className = "gate-msg";
        msg.textContent = "正在连接相册…";
        btn.disabled = true;
        loadBase(function () {
          btn.disabled = false;
          if (BASE) form.dispatchEvent(new Event("submit", { cancelable: true }));
          else msg.textContent = "连不上相册，刷新页面再试";
        });
        return;
      }
      btn.disabled = true;
      msg.className = "gate-msg";
      msg.textContent = "核对中…";
      fetch(BASE + "/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code })
      })
        .then(function (r) {
          return r.json().then(function (j) {
            return { s: r.status, j: j };
          });
        })
        .then(function (o) {
          if (o.s === 200 && o.j && o.j.token) {
            try {
              localStorage.setItem(
                KEY,
                JSON.stringify({
                  t: o.j.token,
                  e: Date.now() + (+o.j.ttl || 43200) * 1000,
                  k: o.j.kind || "guest"
                })
              );
            } catch (e) {}
            msg.className = "gate-msg ok";
            msg.textContent = "验证通过，正在打开…";
            location.reload();
            return;
          }
          btn.disabled = false;
          msg.textContent =
            o.s === 429
              ? "试错太多次了，等一分钟再来"
              : (o.j && o.j.error) || "验证码不对，再看一眼手机";
          input.select();
        })
        .catch(function () {
          btn.disabled = false;
          msg.textContent = "连不上相册所在的 NAS，检查一下网络";
        });
    });
  }

  function loadBase(cb) {
    fetch("base.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        var v = String((j && j.base) || "").replace(/\/+$/, "");
        if (v) {
          BASE = v;
          try { sessionStorage.setItem(BASE_CACHE, v); } catch (e) {}
        }
      })
      .catch(function () {
        // 拉不到就沿用缓存里的地址；两条路都空才真的没法用
      })
      .then(function () {
        if (cb) cb();
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
  loadBase();
})();
