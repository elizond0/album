/* ============================================
   admin.js —— NAS 路线的管理后台（纯静态版）
   发布有两条路，走的是同一个 content.json：
     ① 「保存并发布」→ 浏览器直接调 GitHub Contents API 提交，push 后 Pages 自动重建
     ② 「仅下载」   → 生成 content.json 让你手动放/推，作为降级通道
   两条路共用一个 pushContent()，将来若要换成 NAS 代理，只改这个函数体，页面不用动。
   ============================================ */
(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  // 版本时间戳：写到 content.json 的 builtAt，页面页脚和后台顶部都读它。
  // 带时分，才看得出「今天是不是又发过一版」；纯日期同一天两次发布看起来一模一样。
  const localStamp = () => {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  let db = null;
  let dirty = false;

  /* ---------- 提示 ---------- */
  let toastTimer = null;
  function toast(msg, bad) {
    const t = $("#toast");
    t.textContent = msg;
    t.style.borderColor = bad ? "#a13a2e" : "";
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2800);
  }

  /* ---------- 动态码显示状态 ----------
     服务端对外不广播「开没开动态码」（那也属于内部信息），所以这里由本机记：
     输错时服务端在 401 里带 totp:true，就把输入框亮出来并记住，下次直接显示。
     没开过的人永远看不到这个框，不打扰。

     这几个函数必须定义在使用之前：v8 之前把它们写在文件后半段，
     函数声明虽然会提升，但同名的 const TOTP_HINT 在暂时性死区里，
     整个 IIFE 在初始化阶段就抛错，于是下面的启动分支一行都没执行——
     表现就是「刷新后后台空白、验证码框也不出来」。 */
  const TOTP_HINT = "album-admin-totp";

  function totpKnownOn() {
    try { return localStorage.getItem(TOTP_HINT) === "1"; } catch (e) { return false; }
  }
  function markTotpOn(on) {
    try { on ? localStorage.setItem(TOTP_HINT, "1") : localStorage.removeItem(TOTP_HINT); } catch (e) {}
  }

  /* ---------- 口令：只在「保存并发布」时用一次 ----------
     2026-11-17 改：去掉了本机 SHA-256 登录锁（哈希写在公开仓库里、无盐，
     只挡得住随手点链接的人，却要每次登录多填一次，还会和 NAS 的 push-secret
     混淆成两套口令）。现在编辑不设卡，只在真正写回仓库时向 NAS 验一次身份。
     浏览器里不留任何副本：不写 localStorage，也不写 sessionStorage。 */
  const KEY_STORE = "album-admin-key"; // 旧版遗留键名，仅用于清理

  /* ---------- 进门口令 ----------
     口令本身只有 6 位数字，熵很低：把它或它的哈希写进 JS 等于公开。
     所以「对不对」这件事只有 NAS 知道——进后台时把口令 POST 到
     /api/auth，服务端用 PBKDF2 存着的哈希比对，过了才回一个一次性令牌。
     令牌放 sessionStorage：关标签页即失效，刷新还在，不写 localStorage。 */
  const TOKEN_STORE = "album-admin-token";

  function getAuthToken() {
    try { return sessionStorage.getItem(TOKEN_STORE) || ""; } catch (e) { return ""; }
  }
  function setAuthToken(t) {
    try { t ? sessionStorage.setItem(TOKEN_STORE, t) : sessionStorage.removeItem(TOKEN_STORE); } catch (e) {}
  }

  function unlockError(msg) {
    const el = $("#unlock-error");
    if (!el) return;
    el.textContent = msg;
    el.hidden = !msg;
  }

  async function tryUnlock(key, code) {
    const base = await nasBase();
    if (!base) throw new Error("NO_NAS");
    let r;
    try {
      r = await ghFetch(`${base}/api/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(code ? { key, code } : { key }),
      }, 15000);
    } catch (e) {
      throw new Error(e.name === "AbortError" ? "TIMEOUT" : "NO_NAS");
    }
    if (r.status === 401) {
      const j = await r.json().catch(() => ({}));
      const err = new Error("BAD_KEY");
      err.needTotp = !!j.totp;      // 口令对、动态码缺/错
      throw err;
    }
    if (r.status === 429) throw new Error("TOO_FAST");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.error || "HTTP " + r.status);
    return j.token || "ok";
  }

  async function gateIn() {
    const view = $("#unlock-view");
    const inp = $("#unlock-input");
    const note = $("#unlock-note");
    const row = $("#totp-row");
    const tin = $("#totp-input");

    // 之前撞见过动态码就默认展开。这一步放在最前面、任何 await 之前：
    // 放到探 NAS 之后的话，那几秒里用户已经对着「缺一个框」的界面在打字了。
    if (row && totpKnownOn()) {
      row.hidden = false;
      if (tin) setTimeout(() => tin.focus(), 30);
    }

    view.hidden = false;
    inp.focus();

    // 出错时才需要临时把框亮出来
    const showTotp = (on) => {
      if (!row) return;
      row.hidden = !on;
      if (on && tin) setTimeout(() => tin.focus(), 30);
    };

    // NAS 是否在线，先探一下，省得人输了口令才发现连不上
    const base = await nasBase();
    let alive = false;
    if (base) alive = await nasAlive(base);
    if (note) {
      note.textContent = alive
        ? "已连上家里的 NAS 写入口。"
        : "连不上 NAS 写入口（NAS 离线或隧道刚换域名）。口令校验要靠它，稍后再试。";
      note.classList.toggle("is-bad", !alive);
    }

    const submit = async () => {
      const k = (inp.value || "").trim();
      const code = (tin && tin.value || "").trim();
      if (!k) return unlockError("请先输入口令。");
      if (row && !row.hidden && !code) return unlockError("请输入验证器上的 6 位动态码。");
      unlockError("");
      const btn = $("#unlock-ok");
      btn.disabled = true;
      btn.textContent = "校验中…";
      try {
        const tok = await tryUnlock(k, code);
        setAuthToken(tok);
        if (!(row && row.hidden) || code) markTotpOn(true);   // 走过动态码这条路就记住
        view.hidden = true;
        inp.value = "";
        if (tin) tin.value = "";
        await enter();
      } catch (e) {
        let m;
        if (e.needTotp) {
          markTotpOn(true);
          showTotp(true);
          m = code
            ? "动态码不对。注意它每 30 秒换一次，用最新的那个。"
            : "这道后台还要求动态码，请在下面输入验证器上的 6 位数字。";
        } else {
          m = {
            BAD_KEY: "口令不对，再试一次。",
            NO_NAS: "连不上 NAS，没法校验口令。等 NAS 恢复再进。",
            TIMEOUT: "NAS 没有响应，稍后再试。",
            TOO_FAST: "试太多次了，歇一分钟再来。",
          }[e.message] || ("校验失败：" + e.message);
        }
        unlockError(m);
      } finally {
        btn.disabled = false;
        btn.textContent = "进入";
      }
    };

    $("#unlock-ok").addEventListener("click", submit);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    if (tin) tin.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  }

  // 发布口令不缓存；进门拿的令牌在 nasPush() 里单独处理

  async function enter() {
    $("#panel-view").hidden = false;
    $("#logout-btn").hidden = false;
    const ok = await Site.load();
    if (!ok.ready) { toast("内容加载失败：" + Site.error, true); return; }
    db = JSON.parse(JSON.stringify(Site.db));
    renderBasic(); renderTexts();
    ["timeline", "quotes", "wishes", "events"].forEach(renderList);
    renderPhotos();
    renderStamp();
  }

  /* ---------- 版本时间戳 ----------
     值来自 content.json 的 builtAt，格式化函数用 Site.stampText（site.js 里那份），
     页脚 [data-stamp] 用的是同一个函数——所以后台和页面不可能显示成两个时间。 */
  function renderStamp(at) {
    const el = $("#admin-stamp");
    if (!el) return;
    const v = at || (db && db.builtAt) || (Site.db && Site.db.builtAt) || "";
    const t = window.Site && Site.stampText ? Site.stampText(v) : String(v);
    el.textContent = t ? "内容版本 " + t : "内容版本 —";
    el.title = t ? "当前已发布的内容版本（前台页脚同此时间）" : "还没有版本信息";
  }

  /* ---------- 退出 ---------- */
  $("#logout-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    setAuthToken("");
    // 门禁票也要清：否则刷新时 gate.js 会拿着旧票直接放行，看起来像没退出去
    try { localStorage.removeItem("album_gate_v1"); } catch (err) {}
    location.reload();
  });

  // 清理旧版本留下的本机哈希与明文口令
  try {
    localStorage.removeItem("album-admin-hash");
    sessionStorage.removeItem(KEY_STORE);
  } catch (e) { /* 隐私模式下忽略 */ }

  // 启动：有令牌先进（令牌也可能已过期，发布时会再撞 401），没有就弹进门口令。
  // 2026-11-23：若刚在相册门禁里用动态码验过身（gate.js 留下的票 kind=totp），
  // 这张票服务端也认（_ok_admin 里认），直接进——同一次验证不该让人输两遍。
  // 访客口令换来的票 kind=guest，不享受这条，仍然要口令。
  if (getAuthToken()) enter();
  else if (window.__ALBUM_K && window.__ALBUM_KIND === "totp") {
    setAuthToken(window.__ALBUM_K);
    enter();
  } else gateIn();

  /* ---------- 标签页 ---------- */
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t === b));
    document.querySelectorAll(".panel").forEach((p) => {
      p.hidden = p.id !== "panel-" + b.dataset.tab;
    });
    if (b.dataset.tab === "log" && !logLoaded) loadLog();
  });

  function markDirty() { dirty = true; $("#dirty-tip").hidden = false; }

  /* ---------- 基本信息 / 首页设置 ---------- */
  const SEC_NAMES = { timeline: "时间轴", photos: "照片墙", quotes: "随手记", wishes: "心愿单", videos: "影像" };

  function renderBasic() {
    const m = db.meta || {};
    $("#f-anniversary").value = m.anniversary || "";
    $("#f-couple-a").value = (m.couple && m.couple.a) || "";
    $("#f-couple-b").value = (m.couple && m.couple.b) || "";
    $("#f-hero").value = m.hero || "";
    renderHomeCfg();
  }

  function renderHomeCfg() {
    const h = (db.meta && db.meta.home) || {};
    $("#f-h-tl").value = h.timelineCount || 5;
    // 2026-11-23：合并成一个字段。以前拆成「首屏行数 / 滚到底最多行数」，
    // 后台填 2、页面上却滚出 6 行，看着就是「设置没生效」。现在一个数说了算。
    $("#f-h-pr").value = h.photoRows || 2;
    $("#f-h-qr").value = h.quoteRows || 1;
    $("#f-h-wc").value = h.wishCount || 8;
    $("#f-h-videos").value = h.showVideos || "auto";
    renderHomeOrder();
    renderPageCfg();
  }

  function renderPageCfg() {
    const p = (db.meta && db.meta.pages) || {};
    if ($("#f-p-cols")) $("#f-p-cols").value = p.photosCols || 3;
    if ($("#f-p-rows")) $("#f-p-rows").value = p.photosRows || 20;
    if ($("#f-q-cols")) $("#f-q-cols").value = p.quotesCols || 2;
    if ($("#f-w-limit")) $("#f-w-limit").value = p.wishLimit == null ? 0 : p.wishLimit;
  }

  function renderHomeOrder() {
    const ALL = ["timeline", "photos", "quotes", "wishes", "videos"];
    const h = (db.meta && db.meta.home) || {};
    const order = (Array.isArray(h.order) && h.order.length ? h.order : ALL).filter((k) => ALL.includes(k));
    const box = $("#home-order");
    box.innerHTML = order
      .map(
        (k, i) => `
      <div class="home-order__row">
        <span class="home-order__name">${esc(SEC_NAMES[k] || k)}</span>
        <span class="home-order__acts">
          <button type="button" data-ho="up" data-k="${k}" ${i === 0 ? "disabled" : ""} title="上移">↑</button>
          <button type="button" data-ho="down" data-k="${k}" ${i === order.length - 1 ? "disabled" : ""} title="下移">↓</button>
        </span>
      </div>`
      )
      .join("");
    box.dataset.order = order.join(",");
    // 让显隐下拉也反映当前顺序
  }

  $("#home-order").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ho]");
    if (!b) return;
    const order = $("#home-order").dataset.order.split(",");
    const i = order.indexOf(b.dataset.k);
    const j = b.dataset.ho === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    $("#home-order").dataset.order = order.join(",");
    // 立即重绘顺序（不动数据，保存时再写）
    const labels = order.map((k) => SEC_NAMES[k] || k);
    renderHomeOrderFromOrder(order);
    void labels;
    markDirty();
  });

  function renderHomeOrderFromOrder(order) {
    const box = $("#home-order");
    box.innerHTML = order
      .map(
        (k, i) => `
      <div class="home-order__row">
        <span class="home-order__name">${esc(SEC_NAMES[k] || k)}</span>
        <span class="home-order__acts">
          <button type="button" data-ho="up" data-k="${k}" ${i === 0 ? "disabled" : ""} title="上移">↑</button>
          <button type="button" data-ho="down" data-k="${k}" ${i === order.length - 1 ? "disabled" : ""} title="下移">↓</button>
        </span>
      </div>`
      )
      .join("");
    box.dataset.order = order.join(",");
  }

  $("#save-basic").addEventListener("click", () => {
    db.meta = db.meta || {};
    db.meta.anniversary = $("#f-anniversary").value;
    db.meta.couple = { a: $("#f-couple-a").value.trim(), b: $("#f-couple-b").value.trim() };
    db.meta.hero = $("#f-hero").value.trim();
    const firstRows = Math.max(1, +$("#f-h-pr").value || 3);
    db.meta.home = {
      timelineCount: Math.max(1, +$("#f-h-tl").value || 5),
      photoRows: firstRows,
      photoRowsMax: firstRows,
      quoteRows: Math.max(1, +$("#f-h-qr").value || 1),
      wishCount: Math.max(2, +$("#f-h-wc").value || 8),
      showVideos: $("#f-h-videos").value,
      order: ($("#home-order").dataset.order || "timeline,photos,quotes,wishes,videos").split(","),
    };
    markDirty();
    toast("已写入待保存内容，点右上角「保存」导出");
  });

  /* ---------- 发布口令弹窗 ---------- */
  // 只在点「保存并发布」时打开一次；口令用完即弃，不落任何存储。
  let gateResolve = null;
  let gateRetry = false;

  function askKey(msg) {
    const sec = $("#publish-gate");
    const err = $("#gate-error");
    const inp = $("#gate-input");
    const crow = $("#gate-totp-row");
    const cin = $("#gate-totp-input");
    sec.hidden = false;
    inp.value = "";
    if (cin) cin.value = "";
    if (crow) crow.hidden = !totpKnownOn();
    (crow && !crow.hidden && cin ? cin : inp).focus();
    if (msg) { err.textContent = msg; err.hidden = false; } else { err.hidden = true; }
    // 返回 {key, code}；取消返回 null
    return new Promise((res) => { gateResolve = res; });
  }

  function closeGate(val) {
    $("#publish-gate").hidden = true;
    const r = gateResolve;
    gateResolve = null;
    if (r) r(val);
  }

  $("#gate-ok").addEventListener("click", () => {
    const k = $("#gate-input").value.trim();
    const crow = $("#gate-totp-row");
    const c = (crow && !crow.hidden && $("#gate-totp-input")) ? $("#gate-totp-input").value.trim() : "";
    const err = $("#gate-error");
    if (k.length < 6) {
      err.textContent = "口令至少 6 位。";
      err.hidden = false;
      return;
    }
    closeGate({ key: k, code: c });
  });
  $("#gate-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#gate-ok").click();
    if (e.key === "Escape") closeGate(null);
  });
  const gin = $("#gate-totp-input");
  if (gin) gin.addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#gate-ok").click();
    if (e.key === "Escape") closeGate(null);
  });
  $("#gate-cancel").addEventListener("click", () => closeGate(null));

  /* ---------- 站点文本 ---------- */
  function renderTexts() {
    const t = (db.meta && db.meta.texts) || {};
    $("#text-list").innerHTML = Object.keys(t)
      .map(
        (k) => `<label class="field"><span class="text-key">${esc(k)}</span>
          <input data-tk="${esc(k)}" value="${esc(t[k])}" /></label>`
      )
      .join("");
  }
  $("#save-texts").addEventListener("click", () => {
    const t = {};
    document.querySelectorAll("[data-tk]").forEach((i) => (t[i.dataset.tk] = i.value));
    db.meta.texts = t;
    markDirty();
    toast("文本已写入待保存");
  });

  /* ---------- 通用列表（时间轴 / 随手记 / 心愿 / 事件） ---------- */
  const LIST_CFG = {
    timeline: { fields: [["date", "日期", "text"], ["title", "标题", "text"], ["text", "内容", "textarea"]] },
    quotes: { fields: [["text", "内容", "textarea"], ["tag", "署名", "text"]] },
    wishes: { fields: [["text", "愿望", "text"], ["emoji", "表情", "text"], ["done", "已解锁", "check"]] },
    events: { fields: [["date", "日期", "text"], ["title", "名称", "text"], ["note", "备注", "text"]] },
  };

  function renderList(key) {
    const cfg = LIST_CFG[key];
    const box = $("#list-" + key);
    const arr = db[key] || [];
    box.innerHTML = arr
      .map(
        (it, i) => `
      <div class="row" data-i="${i}">
        ${cfg.fields
          .map(([f, label, type]) => {
            if (type === "check")
              return `<label class="row-check"><input type="checkbox" data-f="${f}" ${it[f] ? "checked" : ""} />${label}</label>`;
            const v = esc(it[f] ?? "");
            return type === "textarea"
              ? `<label class="row-f"><span>${label}</span><textarea data-f="${f}" rows="2">${v}</textarea></label>`
              : `<label class="row-f"><span>${label}</span><input data-f="${f}" value="${v}" /></label>`;
          })
          .join("")}
        <button type="button" class="row-del" data-del="${i}" title="删除">✕</button>
      </div>`
      )
      .join("") || '<p class="modal__hint">还没有内容。</p>';
  }

  document.querySelectorAll("[data-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.add;
      (db[key] = db[key] || []).push({});
      renderList(key);
      markDirty();
    });
  });

  document.querySelectorAll("[data-list]").forEach((box) => {
    const key = box.dataset.list;
    box.addEventListener("click", (e) => {
      const d = e.target.closest("[data-del]");
      if (!d) return;
      db[key].splice(+d.dataset.del, 1);
      renderList(key);
      markDirty();
    });
    box.addEventListener("input", () => markDirty());
  });

  document.querySelectorAll("[data-save-list]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.saveList;
      const cfg = LIST_CFG[key];
      const rows = [...document.querySelectorAll("#list-" + key + " .row")];
      db[key] = rows.map((r) => {
        const o = {};
        cfg.fields.forEach(([f, , type]) => {
          const n = r.querySelector(`[data-f="${f}"]`);
          if (!n) return;
          o[f] = type === "check" ? n.checked : n.value.trim();
        });
        return o;
      });
      markDirty();
      toast("已写入待保存");
    });
  });

  /* ---------- 照片库（改描述 / 地点 / 隐藏） ---------- */
  let photoView = "list";
  $("#photo-view")?.addEventListener("change", (e) => {
    photoView = e.target.value;
    renderPhotos();
  });

  function placeKey(p) {
    const pl = p.place || {};
    const parts = [pl.province, pl.city, pl.district, pl.spot].filter(Boolean);
    return parts.length ? parts.join("·") : "未标注地点";
  }

  function photoRow(p, i) {
    const pl = p.place || {};
    return `
      <div class="photo-row" data-i="${i}">
        <img loading="lazy" src="${esc(Site.imgSrc(p.src))}" alt="" />
        <div class="photo-row__grid">
          <label>描述<input data-p="title" value="${esc(p.title)}" /></label>
          <label>补充描述<textarea data-p="desc" rows="1">${esc(p.desc || "")}</textarea></label>
          <label>日期<input data-p="date" value="${esc(p.date)}" placeholder="2026-08-22" /></label>
          <label>省/市<span class="pair"><input data-p="province" value="${esc(pl.province || "")}" placeholder="省" /><input data-p="city" value="${esc(pl.city || "")}" placeholder="市" /></span></label>
          <label>区/地点<span class="pair"><input data-p="district" value="${esc(pl.district || "")}" placeholder="区县" /><input data-p="spot" value="${esc(pl.spot || "")}" placeholder="具体地点" /></span></label>
          <label class="row-check"><input type="checkbox" data-p="hidden" ${p.hidden ? "checked" : ""} />隐藏（不上照片墙）</label>
          <label class="row-check"><input type="checkbox" data-p="featured" ${p.featured ? "checked" : ""} />精选</label>
        </div>
      </div>`;
  }

  function renderPhotos() {
    const box = $("#photo-list");
    if (!box || !db) return;
    const kw = ($("#photo-search")?.value || "").trim().toLowerCase();
    const list = db.photos.filter(
      (p) => !kw || (p.file + " " + (p.title || "") + " " + placeKey(p)).toLowerCase().includes(kw)
    );
    if (photoView === "group") {
      const g = new Map();
      list.forEach((p) => {
        const k = placeKey(p);
        if (!g.has(k)) g.set(k, []);
        g.get(k).push(p);
      });
      box.classList.add("is-group");
      box.innerHTML = [...g.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(
          ([k, arr]) => `
        <div class="pg-group">
          <div class="pg-head"><span class="pg-title">${esc(k)}</span>
            <span class="pg-count">${arr.length} 张</span></div>
          <div class="pg-grid">
            ${arr
              .map(
                (p) =>
                  `<figure class="pg-thumb ${p.hidden ? "is-hidden" : ""} ${p.featured ? "is-featured" : ""}"
                     data-file="${esc(p.file)}" title="${esc(p.title || p.file)}">
                     <img loading="lazy" src="${esc(Site.imgSrc(p.src))}" alt="" /></figure>`
              )
              .join("")}
          </div>
        </div>`
        )
        .join("");
    } else {
      box.classList.remove("is-group");
      const shown = list.slice(0, 60);
      box.innerHTML =
        shown.map((p, i) => photoRow(p, db.photos.indexOf(p))).join("") ||
        '<p class="modal__hint">没有匹配的照片。</p>';
      if (list.length > 60)
        box.innerHTML += `<p class="modal__hint">仅显示前 60 张（共 ${list.length} 张），用搜索框精确查找。</p>`;
    }
    $("#photo-stat").textContent = `共 ${db.photos.length} 张 · 当前匹配 ${list.length} 张`;
    // 这里不要 markDirty()：本函数只负责「按筛选条件重绘」，进后台首次渲染也会走到，
    // 标脏会让「有未发布的改动」一进页面就亮着。真正的编辑在下面 #photo-list 的 input 里标。
  }

  $("#photo-search")?.addEventListener("input", renderPhotos);
  $("#photo-list")?.addEventListener("input", (e) => {
    const row = e.target.closest(".photo-row");
    if (!row) return;
    const p = db.photos[+row.dataset.i];
    const f = e.target.dataset.p;
    if (!p || !f) return;
    if (f === "hidden") p.hidden = e.target.checked;
    else if (f === "featured") p.featured = e.target.checked;
    else if (["province", "city", "district", "spot"].includes(f)) {
      p.place = p.place || {};
      p.place[f] = e.target.value.trim();
    } else p[f] = e.target.value;
    markDirty();
  });

  /* ---------- 保存：生成 content.json 供下载 ---------- */
  // 首页设置散在「基本信息」面板里，但用户常常改完行数就直接点右上角导出，
  // 不会去点「保存基本信息」。所以导出时统一冲一遍 DOM → db，避免白改。
  function syncFormToDb() {
    db.meta = db.meta || {};
    const num = (sel, def, min, max) => {
      const el = $(sel);
      const v = el ? Math.round(+el.value) : NaN;
      return Math.min(max, Math.max(min, Number.isFinite(v) && v > 0 ? v : def));
    };
    if ($("#f-anniversary")) db.meta.anniversary = $("#f-anniversary").value;
    if ($("#f-couple-a"))
      db.meta.couple = { a: $("#f-couple-a").value.trim(), b: $("#f-couple-b").value.trim() };
    if ($("#f-hero")) db.meta.hero = $("#f-hero").value.trim();
    if ($("#f-h-tl")) {
      const first = num("#f-h-pr", 2, 1, 6);
      db.meta.home = {
        timelineCount: num("#f-h-tl", 5, 1, 20),
        photoRows: first,
        photoRowsMax: first,
        quoteRows: num("#f-h-qr", 1, 1, 6),
        wishCount: num("#f-h-wc", 8, 2, 30),
        showVideos: $("#f-h-videos") ? $("#f-h-videos").value : "auto",
        order: ($("#home-order").dataset.order || "timeline,photos,quotes,wishes,videos")
          .split(",")
          .filter(Boolean),
      };
    }
    if ($("#f-p-cols")) {
      const pick = (sel, def, min, max) => {
        const el = $(sel);
        const v = el ? Math.round(+el.value) : NaN;
        return Math.min(max, Math.max(min, Number.isFinite(v) ? v : def));
      };
      db.meta.pages = {
        photosCols: pick("#f-p-cols", 3, 1, 4),
        photosRows: pick("#f-p-rows", 20, 2, 60),
        quotesCols: pick("#f-q-cols", 2, 1, 3),
        wishLimit: pick("#f-w-limit", 0, 0, 30),
      };
    }

    const tk = document.querySelectorAll("[data-tk]");
    if (tk.length) {
      const t = { ...((db.meta && db.meta.texts) || {}) };
      tk.forEach((i) => (t[i.dataset.tk] = i.value));
      db.meta.texts = t;
    }
  }

  function buildContent() {
    syncFormToDb();
    const out = JSON.parse(JSON.stringify(db));
    // 内存里的 src / thumb 已被 Site.attachBase() 拼成绝对 URL，导出必须还原成相对路径，
    // 否则隧道地址会被重新写死进 content.json，下次换地址又得重建。
    // thumb 还原成 s（两者在数据里同源）。以前这里直接 delete p.thumb，导致每次保存都
    // 整体删掉 562 个 thumb 字段——文件结构变了、commit diff 全是噪音，看不出真正改了
    // 什么。既然要把 commit 当更新日志用，diff 就必须只包含真改动。
    (out.photos || []).forEach((p) => {
      if (p.file) p.src = p.file;
      p.thumb = p.s || "";
    });
    (out.videos || []).forEach((v) => { if (v.file) v.src = v.file; });
    out.base = "";
    out.version = 1;
    out.builtAt = localStamp();   // 版本时间戳：页脚与后台都读它
    return out;
  }

  /* ============================================
     发布：直连 GitHub Contents API
     --------------------------------------------
     只改这里就能换传输层（例如换成 NAS 代理 /api/save），上层按钮和页面不用动。
     安全前提：token 只进 sessionStorage（关标签页即失效），绝不写 localStorage。
     ============================================ */
  const GH = {
    repo: "elizond0/album",
    branch: "main",
    dir: "data",          // 目录名，给 trees 接口用
    file: "content.json", // 文件名
    path: "data/content.json",
    store: "album-gh-token",
  };
  const getToken = () => sessionStorage.getItem(GH.store) || "";
  const setToken = (t) => (t ? sessionStorage.setItem(GH.store, t) : sessionStorage.removeItem(GH.store));

  // 硬超时：国内到 api.github.com 偶发卡住，卡死比报错更难排查
  async function ghFetch(url, opt, ms = 60000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      return await fetch(url, { ...opt, signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // 取远端当前 blob sha。优先 trees 接口（只回目录清单、几百字节，实测 0.6s）；
  // contents 接口会把整个 316 KB base64 下回来（实测 9s），只作兜底。
  async function remoteSha(headers) {
    try {
      const r = await ghFetch(
        `https://api.github.com/repos/${GH.repo}/git/trees/${GH.branch}:${GH.dir}`,
        { headers, cache: "no-store" },
        20000
      );
      if (r.ok) {
        const j = await r.json();
        const hit = (j.tree || []).find((x) => x.path === GH.file);
        if (hit && hit.sha) return hit.sha;
      }
    } catch (e) {
      /* 落到 contents 兜底 */
    }
    const r = await ghFetch(
      `https://api.github.com/repos/${GH.repo}/contents/${GH.path}?ref=${GH.branch}&t=${Date.now()}`,
      { headers, cache: "no-store" }
    );
    if (r.status === 401) throw new Error("BAD_TOKEN");
    if (r.status === 403) throw new Error("NO_SCOPE");
    if (r.status === 404) throw new Error("NOT_FOUND");
    if (!r.ok) throw new Error(`读取远端失败：HTTP ${r.status}`);
    return (await r.json()).sha;
  }

  // 316 KB 的 UTF-8 文本转 base64：分块喂给 fromCharCode，避免 apply 参数过多爆栈
  function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  const GH_ERR = {
    NO_TOKEN: "还没填 GitHub Token，点下方「GitHub Token 设置」填一个",
    BAD_TOKEN: "Token 无效或已过期，去 GitHub 重新生成一个",
    NO_SCOPE: "Token 没有写权限：Repository permissions 里 Contents 要勾 Read and write",
    CONFLICT: "远端文件刚被改过（sha 对不上），刷新页面后重试",
    NOT_FOUND: "仓库里找不到 data/content.json，检查 repo 名和分支",
    TOO_BIG: "文件太大，GitHub 拒绝了这次提交",
    NET: "连不上 GitHub（网络被拦或超时），可以改用「仅下载」",
    TIMEOUT: "等了两分钟没回音，网络太慢或被拦了，改用「仅下载」更快",
    BAD_KEY: "口令不对：要跟 NAS 上 push-secret 设的是同一个",
    CANCELLED: "已取消发布（没输口令，什么都没提交）",
    NO_KEY: "没输口令",
    NO_NAS: "连不上 NAS 的写入口（NAS 离线 / 隧道刚换域名还没同步）",
    TOO_FAST: "一分钟内提交太多次了，歇一会儿再点",
    NO_NAS_NO_TOKEN: "NAS 不在线，又没配 GitHub Token。等 NAS 恢复，或展开下面填个 token 直连",
  };

  // ---------- 传输层 A：NAS 代理（默认走这条，token 不进浏览器） ----------
  async function nasBase() {
    if (window.Site && Site.base) return String(Site.base).replace(/\/+$/, "");
    try {
      const r = await fetch(`base.json?t=${Date.now()}`, { cache: "no-store" });
      return String((await r.json()).base || "").replace(/\/+$/, "");
    } catch (e) {
      return "";
    }
  }

  async function nasAlive(base) {
    try {
      const r = await ghFetch(`${base}/api/health`, { cache: "no-store" }, 5000);
      if (!r.ok) return false;
      const j = await r.json();
      return !!j.ok;               // 服务端对外只回 {ok:true}，不再暴露端口和口令状态
    } catch (e) {
      return false;
    }
  }

  async function nasPush(json) {
    const base = await nasBase();
    if (!base) throw new Error("NO_NAS");

    // 进门时拿到的令牌先顶上（省得每次发布都重输口令）；令牌过期了 NAS 会回 401，
    // 这时才现问口令，且只重试一次——口令只有 6 位，不能让它被反复试。
    let tok = getAuthToken();
    let key = "", code = "";
    if (!tok) {
      const got = await askKey(gateRetry ? "口令不对，再输一次。" : "");
      if (!got) throw new Error("CANCELLED");
      key = got.key; code = got.code;
    }

    let r;
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = { "Content-Type": "application/json" };
      if (key) {
        headers["X-Admin-Key"] = key;
        if (code) headers["X-Admin-Code"] = code;   // 开了动态码时这条通道也得带
      } else headers["X-Admin-Auth"] = tok;
      try {
        r = await ghFetch(`${base}/api/save`, { method: "POST", headers, body: json }, 120000);
      } catch (e) {
        throw new Error(e.name === "AbortError" ? "TIMEOUT" : "NO_NAS");
      }
      if (r.status !== 401) break;
      if (attempt === 1) throw new Error("BAD_KEY");
      // 令牌失效：清掉，改问口令（必要时连动态码一起问）
      if (tok) { setAuthToken(""); tok = ""; }
      const again = await askKey(totpKnownOn()
        ? "令牌过期了，重新输一次口令和动态码。"
        : "令牌过期了，重新输一次口令。");
      if (!again) throw new Error("CANCELLED");
      key = again.key; code = again.code;
    }

    let j = {};
    try { j = await r.json(); } catch (e) {}
    if (r.status === 401) throw new Error("BAD_KEY");
    if (r.status === 429) throw new Error("TOO_FAST");
    if (r.status === 409) throw new Error("CONFLICT");
    if (!r.ok || !j.ok) throw new Error(j.error || `NAS 返回 HTTP ${r.status}`);
    return { commit: j.commit, via: "nas" };
  }

  // ---------- 传输层 B：直连 GitHub（NAS 不在线时的备用，需要 token） ----------
  async function directPush(json) {
    const token = getToken();
    if (!token) throw new Error("NO_TOKEN");

    const api = `https://api.github.com/repos/${GH.repo}/contents/${GH.path}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    let sha = null;
    try {
      sha = await remoteSha(headers);
    } catch (e) {
      if (/^(BAD_TOKEN|NO_SCOPE|NOT_FOUND)/.test(e.message || "")) throw e;
      throw new Error("NET");
    }

    const body = {
      message: `admin: 更新 content.json（${new Date().toLocaleString("zh-CN", { hour12: false })}）`,
      content: toBase64(json),
      branch: GH.branch,
    };
    if (sha) body.sha = sha;

    let r;
    try {
      r = await ghFetch(api, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, 120000);
    } catch (e) {
      throw new Error(e.name === "AbortError" ? "TIMEOUT" : "NET");
    }

    if (r.status === 401) throw new Error("BAD_TOKEN");
    if (r.status === 403) throw new Error("NO_SCOPE");
    if (r.status === 409) throw new Error("CONFLICT");
    if (r.status === 422) throw new Error("TOO_BIG");
    if (!r.ok) {
      let msg = "";
      try { msg = (await r.json()).message || ""; } catch (e) {}
      throw new Error(`提交失败 HTTP ${r.status}${msg ? "：" + msg : ""}`);
    }
    const j = await r.json();
    return { commit: (j.commit || {}).sha || "", via: "direct" };
  }

  // ---------- 统一出口：换传输层只改这里，页面和编辑逻辑不用动 ----------
  // 顺序：NAS 代理优先（口令换写权限，token 不出浏览器）→ 不在线时退直连 → 都不行就报错。
  async function pushContent(json) {
    const base = await nasBase();
    if (base && (await nasAlive(base))) {
      return await nasPush(json);
    }
    if (getToken()) {
      const r = await directPush(json);
      return { ...r, note: "NAS 连不上，已改用直连 GitHub" };
    }
    throw new Error("NO_NAS_NO_TOKEN");
  }

  /* ---------- Token 面板 ---------- */
  function syncTokenState() {
    const has = !!getToken();
    const el = $("#token-state");
    if (!el) return;
    el.textContent = has ? "已设置 · 本次会话有效" : "未设置";
    el.classList.toggle("is-on", has);
  }

  $("#token-save")?.addEventListener("click", () => {
    const t = ($("#token-input").value || "").trim();
    if (!t) return toast("token 不能为空", true);
    if (!/^(github_pat_|gh[pousr]_)/.test(t)) return toast("这不像 GitHub token（应以 github_pat_ 或 ghp_ 开头）", true);
    setToken(t);
    $("#token-input").value = "";
    syncTokenState();
    toast("已保存到本次会话，关掉这个标签页就失效");
  });

  $("#token-clear")?.addEventListener("click", () => {
    setToken("");
    syncTokenState();
    toast("已清除本次会话的 token");
  });

  /* ---------- 改动日志 ----------
     为什么不靠 GitHub 的 commit diff：content.json 一整份 350 KB，任何一次保存
     都会整文件重写，diff 里看不出「你改的是照片墙行数还是别的地方」。
     所以由 NAS 在提交成功那一刻，把新旧两版结构化对比一遍，写成人话，落到
     changes.jsonl。后台只负责读。 */
  let logLoaded = false;

  async function loadLog() {
    const box = $("#log-list");
    const stat = $("#log-stat");
    if (!box) return;
    box.innerHTML = '<li class="changelog__empty">加载中…</li>';
    const base = await nasBase();
    if (!base) {
      if (stat) stat.textContent = "连不上 NAS，看不到日志";
      box.innerHTML = "";
      return;
    }
    const headers = {};
    const tok = getAuthToken();
    if (tok) headers["X-Admin-Auth"] = tok;
    let r;
    try {
      r = await ghFetch(`${base}/api/log?limit=30`, { headers, cache: "no-store" }, 15000);
    } catch (e) {
      if (stat) stat.textContent = "读取失败：NAS 没有响应";
      box.innerHTML = "";
      return;
    }
    if (r.status === 401) {
      if (stat) stat.textContent = "登录状态已过期，刷新页面重新进后台";
      box.innerHTML = "";
      return;
    }
    if (!r.ok) {
      if (stat) stat.textContent = "读取失败：HTTP " + r.status;
      box.innerHTML = "";
      return;
    }
    const j = await r.json().catch(() => ({}));
    const items = (j && j.items) || [];
    logLoaded = true;
    if (stat) stat.textContent = items.length
      ? `最近 ${items.length} 次发布 · 日志留在 NAS 上，最多 200 条`
      : "还没有发布记录";
    if (!items.length) {
      box.innerHTML = '<li class="changelog__empty">还没有记录。改点东西、点一次「保存并发布」就会留一条。</li>';
      return;
    }
    box.innerHTML = items
      .map((it) => {
        const lines = (it.changes || []).map((c) => `<li>${esc(c)}</li>`).join("");
        const n = it.photos != null ? `<span>${esc(String(it.photos))} 张照片</span>` : "";
        const c = it.commit ? `<code>${esc(String(it.commit).slice(0, 7))}</code>` : "";
        return `<li class="changelog__item">
          <p class="changelog__head"><b>${esc(it.t || "")}</b>${c}${n}</p>
          <ul class="changelog__diffs">${lines || "<li>（没有明细）</li>"}</ul>
        </li>`;
      })
      .join("");
  }

  $("#log-refresh")?.addEventListener("click", () => { logLoaded = false; loadLog(); });

  /* ---------- 保存并发布 ---------- */
  $("#save-all").addEventListener("click", async () => {
    const btn = $("#save-all");
    const built = buildContent();
    const json = JSON.stringify(built, null, 1);

    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = "提交中…";
    // 走 NAS 时，pushContent 会在这里面弹口令框；取消则抛 CANCELLED
    gateRetry = false;
    try {
      const r = await pushContent(json);
      dirty = false;
      $("#dirty-tip").hidden = true;
      renderStamp(built.builtAt);     // 页脚版本立刻跟到最新，不用刷新
      logLoaded = false;              // 下次点开「改动日志」强制重拉
      const c = String((r && r.commit) || "").slice(0, 7);
      const via = r && r.via === "direct" ? "（直连）" : "";
      // 版本号挪到页面最底部了，发布后不一定看得见，所以在提示里带一份
      const vt = window.Site && Site.stampText ? Site.stampText(built.builtAt) : "";
      toast(`${r && r.note ? r.note + "，" : ""}已提交${via}${c ? " " + c : ""}` +
            (vt ? `，内容版本 ${vt}` : "") + "，Pages 约 20~60 秒构建");
    } catch (e) {
      if (e.message === "CANCELLED") {
        toast("已取消，没有提交任何东西");
      } else {
        const msg = GH_ERR[e.message] || e.message || "提交失败";
        toast(msg, true);
      }
      if (e.message === "NO_NAS_NO_TOKEN" || e.message === "NO_NAS") {
        const box = $("#token-box");
        if (box) box.open = true;
      }
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  /* ---------- 仅下载（降级通道，原行为） ---------- */
  $("#save-download").addEventListener("click", () => {
    const json = JSON.stringify(buildContent(), null, 1);
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "content.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    dirty = false;
    $("#dirty-tip").hidden = true;
    toast("已导出 content.json，手动推上去同样生效；没生效就按 Ctrl/Cmd+Shift+R 强刷");
  });

  window.addEventListener("beforeunload", (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  /* ---------- 启动 ---------- */
  // 入口在文件上半段的 gateIn()/enter() 二选一里已经决定了，这里只同步 token 折叠区。
  // 别再在这里无条件 enter()——那会让进门口令卡片和编辑区同时显示。
  syncTokenState();
})();
