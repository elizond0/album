/* gate.js —— 相册门禁（页面级）
 *
 * 放在每个页面 <head> 里、且必须早于 scripts/site.js。
 * 职责只有两件：
 *   1. 有票 → window.__ALBUM_K 交给 site.js，让它给每个图片/视频地址拼 ?k=
 *   2. 没票 → 把整页藏起来，只显示一个输码的卡片；验过再整页重载
 *
 * 为什么不是「验过之后局部显示」：内容脚本一旦开跑就会去拉 content.json 和
 * 几十张图，全得 401。整页重载最省事，也最不容易漏掉某个加载入口。
 *
 * 真正的权限判定在 NAS 上（Caddy forward_auth → album-push）
 * 这里只负责把票拿来存好，前端拿票是没用的：票不对，图就是 401。
 */
(function () {
  var KEY = "album_gate_v1";
  var store = null;
  try {
    store = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch (e) {}

  // 票还在有效期内：直接放行，不发任何请求
  if (store && store.t && +store.e > Date.now()) {
    window.__ALBUM_K = String(store.t);
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
      ".gate-reset{position:fixed;left:8px;bottom:6px;z-index:100000;width:16px;height:16px;border:0;",
      "border-radius:50%;background:transparent;color:#a9a29a;font-size:12px;line-height:16px;",
      "text-align:center;cursor:pointer;opacity:.3;transition:opacity .2s}",
      ".gate-reset:hover{opacity:.95;color:#7a5c3a}"
    ].join("");
    return s;
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
      "<p>输入验证器上的 6 位动态码，或家人用的访客口令。</p>" +
      '<input class="gate-input" type="text" name="code" inputmode="text" ' +
      'autocomplete="one-time-code" autocapitalize="off" autocorrect="off" spellcheck="false" ' +
      'placeholder="6 位数字 / 访客口令" />' +
      '<button class="gate-btn" type="submit">进入</button>' +
      '<div class="gate-msg"></div>' +
      '<div class="gate-foot">验证一次可看 12 小时（访客口令 30 天）。<br />' +
      "票只存在这台设备上，公共电脑用完记得点左下角的小点退出。</div>" +
      "</form>";
    document.body.appendChild(box);

    // 左下角的「重新验证」小点：图片整片裂掉时点一下，清票重来
    var reset = document.createElement("button");
    reset.className = "gate-reset";
    reset.type = "button";
    reset.title = "重新验证";
    reset.textContent = "×";
    reset.addEventListener("click", function () {
      try {
        localStorage.removeItem(KEY);
      } catch (e) {}
      location.reload();
    });
    document.body.appendChild(reset);

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
        msg.textContent = "还没拿到相册地址，稍等一下再试";
        loadBase();
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
                JSON.stringify({ t: o.j.token, e: Date.now() + (+o.j.ttl || 43200) * 1000 })
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

  function loadBase() {
    fetch("base.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        BASE = String((j && j.base) || "").replace(/\/+$/, "");
      })
      .catch(function () {
        BASE = "";
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
  loadBase();
})();
