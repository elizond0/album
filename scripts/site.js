/* ============================================
   site.js —— NAS 路线的内容层与交互层
   数据源：data/content.json（由 scripts/build_content.py 生成）
           其中每个媒体项都带 NAS 直链 src，页面只做渲染。
   对外：window.Site
   ============================================ */
(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  // thumbDead：缩略图在 NAS 上还不存在时的全局开关，见 guardImg
  const Site = { esc, db: null, ready: false, error: "", base: "", mediaError: "", thumbDead: false };
  window.Site = Site;

  /* ---------- 图标层：内联 SVG 顶替 emoji ----------
     起因（2026-11-27）：所有者设备的 emoji 自检 14 项缺 13 项——连 U+1F355 披萨、
     U+1F3AE 手柄这种 2010 年的老 emoji 都画成方框，只有 U+2668（1993 年的符号）
     正常。说明那台机器根本没有彩色 emoji 字体，换任何 emoji 字符都没用，只能换成
     不依赖字体的矢量图。
     约束：数据层不动——content.json 里照旧存 emoji 字符，后台「表情」框照旧编辑；
     渲染时按字符查表换成 SVG，表里没有的字符原样输出（有字体的设备照样能看），
     所以以后加新愿望不会因为忘了配图而白屏。 */
  const ICONS = {
    mountain:
      '<path d="M2.5 19.5h19L13.8 5.5 10.6 11.2 8.2 7.6 2.5 19.5Z"/><path d="M9.4 12.9l1.2-1.7 1.2 1.4"/>',
    "heart-hand":
      '<path d="M12 14.8S6.8 11.5 6.8 8.1A2.9 2.9 0 0 1 12 6.4a2.9 2.9 0 0 1 5.2 1.7c0 3.4-5.2 6.7-5.2 6.7Z"/><path d="M5.9 19.6c.7-2.7 2.7-4.3 6.1-4.3s5.4 1.6 6.1 4.3"/>',
    train:
      '<rect x="3.2" y="10.8" width="9.6" height="5.8" rx="2.2"/><path d="M12.8 16.6V7.2h5.2a1.6 1.6 0 0 1 1.6 1.6v7.8"/><rect x="14.6" y="9.2" width="2.8" height="2.6" rx=".5"/><rect x="6" y="8" width="2.6" height="2.8" rx=".5"/><path d="M7.3 6.4c.9-.7.3-1.7 1.1-2.4"/><circle cx="6.4" cy="18.4" r="1.5"/><circle cx="11.6" cy="18.4" r="1.5"/><circle cx="16.4" cy="18.4" r="1.5"/><path d="M3.2 17.4h14.4"/>',
    onsen:
      '<path d="M8.2 9.8c0-1.6 1.1-2 1.1-3.6M12 9.8c0-1.8 1.1-2.2 1.1-4M15.8 9.8c0-1.6 1.1-2 1.1-3.6"/><path d="M4.8 12.6h14.4v3.2a4.2 4.2 0 0 1-4.2 4.2H9a4.2 4.2 0 0 1-4.2-4.2v-3.2Z"/>',
    castle:
      '<path d="M3.4 20V10l2-1.9 2 1.9v10"/><path d="M16.6 20V10l2-1.9 2 1.9v10"/><path d="M9 20V7.8L12 5l3 2.8V20"/><path d="M3.4 12h4.2M16.6 12h4.2M9 10.4h6"/><path d="M10.8 20v-3.6a1.2 1.2 0 0 1 2.4 0V20"/><path d="M2.6 20h18.8"/>',
    masks:
      '<path d="M14.8 4.6c2.2 0 3.9 1.6 3.9 3.8 0 3.1-1.6 5.7-3.9 5.7s-3.9-2.6-3.9-5.7c0-2.2 1.7-3.8 3.9-3.8Z"/><circle cx="13.4" cy="7.9" r=".65"/><circle cx="16.2" cy="7.9" r=".65"/><path d="M13.9 11.4c.6-.5 1.2-.5 1.8 0"/><path d="M8.2 8.4c2.2 0 3.9 1.6 3.9 3.8 0 3.1-1.6 5.7-3.9 5.7s-3.9-2.6-3.9-5.7c0-2.2 1.7-3.8 3.9-3.8Z"/><circle cx="6.8" cy="11.7" r=".65"/><circle cx="9.6" cy="11.7" r=".65"/><path d="M7.2 15.6c.7.8 1.6.8 2.3 0"/>',
    bag:
      '<path d="M5.6 8.6h12.8l-1 11.2H6.6L5.6 8.6Z"/><path d="M8.9 8.6V7.1a3.1 3.1 0 0 1 6.2 0v1.5"/>',
    // 🛶 画成帆船：24×24 下独木舟那套「细长船身 + 一根桨」缩到 27px 就像碗里插勺子，
    // 试过两版都不认。三角帆是「船」最稳的符号，对「RAFT 木筏求生」这条愿望同样成立。
    boat:
      '<path d="M12 3.4v11.2"/><path d="M12 3.4 20 13.2h-8Z"/><path d="M3.2 14.4h17.6c-.8 3.2-4 5.4-8.8 5.4s-8-2.2-8.8-5.4Z"/>',
    gamepad:
      '<path d="M8.4 8.4h7.2a5.4 5.4 0 0 1 5.3 6.7l-.5 2a2.5 2.5 0 0 1-4.4 1L14.4 16H9.6l-1.6 2.1a2.5 2.5 0 0 1-4.4-1l-.5-2a5.4 5.4 0 0 1 5.3-6.7Z"/><path d="M7.4 11.6v2.6M6.1 12.9h2.6"/><circle cx="16" cy="12.2" r=".8"/><circle cx="17.6" cy="14" r=".8"/>',
    sunflower:
      '<circle cx="12" cy="12" r="3.1"/><circle cx="12" cy="5.2" r="1.55" fill="currentColor" stroke="none"/><circle cx="12" cy="18.8" r="1.55" fill="currentColor" stroke="none"/><circle cx="5.2" cy="12" r="1.55" fill="currentColor" stroke="none"/><circle cx="18.8" cy="12" r="1.55" fill="currentColor" stroke="none"/><circle cx="7.2" cy="7.2" r="1.55" fill="currentColor" stroke="none"/><circle cx="16.8" cy="16.8" r="1.55" fill="currentColor" stroke="none"/><circle cx="16.8" cy="7.2" r="1.55" fill="currentColor" stroke="none"/><circle cx="7.2" cy="16.8" r="1.55" fill="currentColor" stroke="none"/>',
    pizza:
      '<path d="M12 3.6 20 19.5c-2.6 1.1-5.3 1.7-8 1.7s-5.4-.6-8-1.7L12 3.6Z"/><path d="M4 19.5c2.6 1.1 5.3 1.7 8 1.7s5.4-.6 8-1.7"/><circle cx="12" cy="9.6" r=".85"/><circle cx="9.9" cy="14.4" r=".85"/><circle cx="14.3" cy="15.4" r=".85"/>',
    tree:
      '<path d="M12 3.6a4.3 4.3 0 0 1 4.2 3.3 3.7 3.7 0 0 1 .5 7.2H7.3a3.7 3.7 0 0 1 .5-7.2A4.3 4.3 0 0 1 12 3.6Z"/><path d="M12 14.1v6.3"/><path d="M9.3 20.4h5.4"/>',
    heartbeat:
      '<path d="M12 19.2S5 14.6 5 9.9A3.7 3.7 0 0 1 12 7.6a3.7 3.7 0 0 1 7 2.3c0 4.7-7 9.3-7 9.3Z"/><path d="M8.6 11.7h1.4l.9-1.9 1.2 3.3.9-1.4h1.4"/>',
    teddy:
      '<circle cx="7.6" cy="7.6" r="2.5"/><circle cx="16.4" cy="7.6" r="2.5"/><circle cx="12" cy="13.6" r="6.1"/><circle cx="9.8" cy="12.4" r=".75"/><circle cx="14.2" cy="12.4" r=".75"/><ellipse cx="12" cy="15.1" rx="1.4" ry="1.05"/><path d="M12 16.2v.9M10.9 17.4c.7.5 1.5.5 2.2 0"/>',
    star: '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8L12 3.6Z"/>',
  };

  // emoji 字符 → 图标名。带 U+FE0F（变体选择符）与不带都注册一遍：
  // content.json 里 ⛰️ / 🛍️ / ♨️ 是「字符 + FE0F」两码位，只注册裸字符会漏。
  const EMOJI_ICON = {};
  [
    ["⛰", "mountain"],
    ["🫰", "heart-hand"],
    ["🚂", "train"],
    ["♨", "onsen"],
    ["🏰", "castle"],
    ["🎭", "masks"],
    ["🛍", "bag"],
    ["🛶", "boat"],
    ["🎮", "gamepad"],
    ["🌻", "sunflower"],
    ["🍕", "pizza"],
    ["🌳", "tree"],
    ["💓", "heartbeat"],
    ["🧸", "teddy"],
  ].forEach(function (pair) {
    EMOJI_ICON[pair[0]] = pair[1];
    EMOJI_ICON[pair[0] + "\uFE0F"] = pair[1];
  });

  /* 设备能不能真画出彩色 emoji：canvas 画一个已知 emoji，看有没有「非灰」像素。
     只判断「有没有画上东西」不够——没有 emoji 字体时浏览器画的是空心方框，
     那也有像素、也不透明，恰恰是要判成「不支持」的情形。
     检测本身抛错就按「支持」处理：宁可维持原生行为，也别把正常设备全降级成图标。 */
  const hasColorEmoji = (function () {
    try {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 16;
      const cx = cv.getContext("2d", { willReadFrequently: true });
      if (!cx) return true;
      cx.textBaseline = "top";
      cx.font = "16px sans-serif";
      cx.fillText("🍕", 0, 0);
      const px = cx.getImageData(0, 0, 16, 16).data;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] < 8) continue;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        if (Math.abs(r - g) > 16 || Math.abs(g - b) > 16) return true;
      }
      return false;
    } catch (e) {
      return true;
    }
  })();
  Site.hasColorEmoji = hasColorEmoji;

  Site.icon = function (name, cls) {
    const d = ICONS[name];
    if (!d) return "";
    return (
      '<svg class="' + (cls || "ico") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"' +
      ' aria-hidden="true" focusable="false">' + d + "</svg>"
    );
  };

  /* 心愿卡图标：命中的走 SVG；字段为空给一颗星。
     没收录的字符分两种设备：能画彩色 emoji 的原样输出（保住原生样子），
     画不出来的（无 emoji 字体，画出来是豆腐块）同样给一颗星——
     这样「新加一条愿望、忘了补图标」最差也只是星星，不会卡片前顶个方框。 */
  Site.wishIcon = function (ch) {
    const raw = String(ch ?? "").trim();
    if (!raw) return Site.icon("star", "wish__ico");
    const name = EMOJI_ICON[raw] || EMOJI_ICON[raw.replace(/\uFE0F/g, "")];
    if (name) return Site.icon(name, "wish__ico");
    return hasColorEmoji ? esc(raw) : Site.icon("star", "wish__ico");
  };

  /* 引语是整句文字，emoji 夹在句中，只能在转义后按字符替换成行内 SVG。
     转义不改变 emoji 码位，所以「先 esc 再替换」是安全的。
     按长度倒序替换，保证「🛍️（带 FE0F）」先于「🛍」命中，不会剩一个孤立 FE0F。
     表里没有的 emoji：有彩色字体的设备原样留着；没有的会渲染成方框，
     句中一个豆腐块比少一个表情更扎眼，直接去掉（句子本身仍读得通）。
     只清理 U+1F000–1FAFF 这片彩色 emoji 区——♨ ★ 这类老符号在无 emoji 字体的
     设备上仍由普通字体兜着，不能一起删。 */
  Site.richText = function (s) {
    let out = esc(s);
    Object.keys(EMOJI_ICON)
      .sort(function (a, b) { return b.length - a.length; })
      .forEach(function (ch) {
        if (out.indexOf(ch) === -1) return;
        const svg = Site.icon(EMOJI_ICON[ch], "quote__ico");
        if (svg) out = out.split(ch).join(svg);
      });
    if (!hasColorEmoji) out = out.replace(/[\u{1F000}-\u{1FAFF}]\uFE0F?/gu, "");
    return out;
  };

  /* ---------- 内容加载 ---------- */
  // content.json 里存的是相对路径（img/xxx.jpg）。真实的 NAS 地址在 base.json，
  // 由 NAS 开机时自动改写。这样隧道地址一换，只改 base.json 就行，
  // 不用重新构建、不用重新推 Git。

  // GitHub Pages 在国内容易抽风：偶尔一次 404/超时，页面就变成「全是默认文案、
  // 一张照片都没有」，而用户看到的只是「网站好像坏了」。这里失败自动重试两次，
  // 三次都拿不到才算真的失败，再由 showLoadError() 明说。
  //
  // bust=true 才加时间戳。为什么不一律加：Pages 给这些文件的 max-age 是 600，
  // 每次换 query 等于每次都强制回源，实测回源 2~30 秒，而命中缓存是几十毫秒。
  // content.json 体量不小且改动少，交给缓存；base.json 只有 110 字节，
  // 但隧道地址一变就必须尽快生效，所以它 bust。
  // timeoutMs 是硬超时：content.json 316 KB 实测国内 6.2/17.3/22.0/27.8/32.9 秒，
  // 而 fetch 默认没有超时（浏览器肯等 300 秒）。不加这个，网络半死时用户看到的是
  // 一直白屏——既不报错也不降级，比慢更难受。
  async function getJSON(url, name, tries, bust, timeoutMs) {
    const limit = timeoutMs || 20000;
    let last;
    for (let i = 0; i < (tries || 3); i++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), limit);
      try {
        const u = bust ? url + "?_=" + Date.now() : url;
        const r = await fetch(u, { cache: bust ? "no-store" : "default", signal: ac.signal });
        if (!r.ok) throw new Error(name + " HTTP " + r.status);
        return await r.json();
      } catch (e) {
        last =
          e && e.name === "AbortError"
            ? new Error(name + " 超时（" + Math.round(limit / 1000) + " 秒没响应）")
            : e;
        if (i < (tries || 3) - 1) await new Promise((ok) => setTimeout(ok, 400 * (i + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw last;
  }

  /* ---------- 文案本机缓存（首屏不跳字） ----------
     现象：导航左上角先显示 HTML 里写死的「我们的故事」，content.json 到了才换成「Album」。
     慢网下 content.json 要等好几秒，这段时间用户看到的是一句不对的文案——不是字体、不是动画，
     是数据没到。修法：上次拿到的 meta.texts 存 localStorage，下次开页先用它把文案填上，
     content.json 到了再以线上为准覆盖。缓存只是加速，失效（首访/清缓存）时行为和以前一样。 */
  const TEXT_CACHE = "album-texts-v1";
  function cachedTexts() {
    try {
      const o = JSON.parse(localStorage.getItem(TEXT_CACHE) || "null");
      return o && typeof o === "object" && o.texts && typeof o.texts === "object" ? o : null;
    } catch (e) {
      return null;
    }
  }
  function saveTexts() {
    try {
      const t = Site.db && Site.db.meta && Site.db.meta.texts;
      if (!t) return;
      localStorage.setItem(TEXT_CACHE, JSON.stringify({ v: 1, at: Date.now(), texts: t }));
    } catch (e) {} // 隐私模式/配额满：不缓存也能用，别让这行挡住后面
  }

  Site.load = async function () {
    // base.json 和 content.json 并行拿。以前是串行 await：content.json 的 316 KB 下完了
    // 才开始请求 base.json，而 base.json 失败还要重试 2×8 秒——慢网下 applyTexts 被吊到 20 秒后。
    const baseP = getJSON("base.json", "base.json", 2, true, 8000)
      .then((bj) => {
        Site.base = String((bj && bj.base) || "").replace(/\/+$/, "");
        if (!Site.base) throw new Error("base.json 里没有 base 字段");
        Site.mediaError = "";
      })
      .catch((e) => {
        Site.mediaError = String((e && e.message) || e);
        console.warn("[Site] NAS 地址读取失败：", Site.mediaError);
        Site.base = "";
      });

    try {
      Site.db = await getJSON("data/content.json", "content.json", 3, false, 45000);
      Site.ready = true;
    } catch (e) {
      Site.error = String((e && e.message) || e);
      console.warn("[Site] 内容加载失败：", Site.error);
      return Site;
    }
    // 文案一到位就先刷一遍，别等 base.json（图片地址失败不该拖住文字）
    Site.applyTexts();
    saveTexts();
    await baseP;
    Site.attachBase();
    return Site;
  };

  // 内容彻底没拉到时的横幅。别让人对着默认文案猜「是不是我记错网址了」。
  Site.showLoadError = function () {
    if (document.getElementById("load-error")) return;
    const bar = document.createElement("div");
    bar.id = "load-error";
    bar.className = "load-error";
    bar.innerHTML =
      '<span>内容没加载出来（' + esc(Site.error || "网络不通") + "）</span>" +
      '<button type="button" class="load-error__btn">重新加载</button>';
    bar.querySelector("button").addEventListener("click", () => location.reload());
    document.body.insertBefore(bar, document.body.firstChild);
  };

  // 把相对路径拼成可用的完整地址；base 缺失时留空，让上层决定怎么提示
  Site.media = function (rel) {
    const f = String(rel || "");
    if (!f) return "";
    if (/^https?:\/\//i.test(f)) return f;
    if (!Site.base) return "";
    // 相册门禁：每张图/每段视频都要带票，Caddy 拿 ?k= 去 album-push 核验。
    // 票来自 scripts/gate.js（用户输过验证码才有），没票就照旧请求——让它 401，
    // 而不是悄悄退回不带票的地址，否则「为什么图裂了」会变成很难查的问题。
    const k = window.__ALBUM_K || "";
    return Site.base + "/" + f.replace(/^\/+/, "") + (k ? "?k=" + encodeURIComponent(k) : "");
  };

  // NAS 没开机 / 隧道断了 / 单张图 404 时统一落到这张手账风占位图
  Site.PLACEHOLDER = "assets/img/placeholder-offline.svg";
  // 视频默认封面：本地 SVG，避免 preload 把整段 mp4 拉下来
  Site.VIDEO_POSTER = "assets/img/video-poster.svg";
  Site.imgSrc = function (src) {
    return src || Site.PLACEHOLDER;
  };
  // 给任意 <img> 挂兜底：真加载失败才换占位图。不加 once——灯箱会复用同一个 <img>，
  // 只挂一次的监听在切换第二张图后就失效了。
  // data-fallback 是「退路」：缩略图 404 时先试原图，原图也挂了才上占位图。
  // 这样即使缩略图还没生成/被清掉了，页面也只是慢一点，不会整片占位。
  Site.guardImg = function (img) {
    if (!img || img.dataset.guarded) return;
    img.dataset.guarded = "1";
    img.addEventListener("error", () => {
      if (img.src && img.src.indexOf(Site.PLACEHOLDER) !== -1) return; // 占位图本身也挂了就别循环
      const fb = img.dataset.fallback;
      if (fb && !img.dataset.fellback) {
        img.dataset.fellback = "1";
        // 缩略图 404 → 说明 NAS 上还没跑 mkthumb.py。记一笔，后面就别再试了，
        // 否则照片墙几百张会挨个 404 一遍。
        if (img.src && img.src.indexOf("/t/") !== -1) Site.thumbDead = true;
        img.src = fb;
        return;
      }
      img.src = Site.PLACEHOLDER;
      img.classList.add("is-offline");
    });
  };

  // 缩略图路径规则固定：img/xxx.jpg → img/t/xxx.jpg。
  // content.json 里没写 s 也照样能推出来——这样 NAS 上跑完 mkthumb.py 刷新即生效，
  // 不必先回头重建一次 content.json。推到不存在的缩略图也只是多一次 404，
  // data-fallback 会退回原图。
  function thumbOf(file) {
    const f = String(file || "");
    if (!f || /^https?:\/\//i.test(f)) return "";
    if (/\/t\//.test(f)) return "";                 // 本身已经是缩略图
    const i = f.lastIndexOf("/");
    return i < 0 ? "t/" + f : f.slice(0, i + 1) + "t/" + f.slice(i + 1);
  }

  Site.attachBase = function () {
    const db = Site.db;
    if (!db) return;
    (db.photos || []).forEach((p) => {
      p.src = Site.media(p.file || p.src);
      // 网格用缩略图（NAS 上由 mkthumb.py 生成，原图 2 MB → 缩略图 60 KB 量级）。
      p.thumb = Site.media(p.s || thumbOf(p.file));
    });
    (db.videos || []).forEach((v) => (v.src = Site.media(v.file || v.src)));
    db.base = Site.base;
  };

  /* ---------- 图片并发闸门 ----------
     NAS 走隧道出去，单张实测 90~450 KB/s 之间跳。一次进视口十几张时如果全放开，
     带宽被摊薄，观感是「整片都在转圈、一张都不出来」。这里限制同时最多 6 张在途。
     （2026-11-17 从 4 提到 6：一页 60 张，4 张并发排队太久；6 张实测更顺，再多互相拖慢。） */
  const IMG_LIMIT = 6;
  let imgActive = 0;
  const imgQueue = [];

  function imgPump() {
    while (imgActive < IMG_LIMIT && imgQueue.length) {
      const job = imgQueue.shift();
      imgActive++;
      job();
    }
  }

  Site.loadImg = function (img, url) {
    if (!img || !url) return;
    imgQueue.push(function () {
      let done = false;
      let timer = 0;
      const finish = function () {
        if (done) return;           // load / error / 超时 三者只认第一个
        done = true;
        clearTimeout(timer);        // ← 成功也要清，否则 45 秒后还会再来一遍 finish
        imgActive = Math.max(0, imgActive - 1);
        imgPump();
      };
      img.addEventListener("load", finish, { once: true });
      img.addEventListener("error", finish, { once: true });
      // 请求被浏览器丢弃（组件已卸载、网络挂起）时不会有 load/error，靠超时解锁队列。
      // 45 秒是上限不是常态；一页 60 张、并发 6，只要有一批卡住就会连锁拖慢整页，
      // 所以这里成功路径必须清计时器，不能让「已加载完的图」继续占着名额到期才释放。
      timer = setTimeout(finish, 45000);
      img.src = url;
    });
    imgPump();
  };

  /* ---------- 文案：meta.texts 优先 ---------- */
  Site.text = (key, fb) => {
    const t = Site.db && Site.db.meta && Site.db.meta.texts;
    const v = t && t[key];
    return v == null || v === "" ? (fb || "") : v;
  };
  Site.applyTexts = function (scope) {
    (scope || document).querySelectorAll("[data-text]").forEach((n) => {
      const v = Site.text(n.dataset.text, n.textContent);
      if (v) n.textContent = v;
    });
    // 标题：首页用站点全名，子页保留自己的「页名 · 站名」，别被统统改成一个名字
    const t = Site.db && Site.db.meta && Site.db.meta.texts;
    const full = (t && t.siteTitle) || "";
    const h1 = document.querySelector("main h1");
    const isHome = !document.querySelector(".subpage");
    if (full && isHome) document.title = full;
    else if (full) {
      const pageName = (h1 && h1.textContent.trim()) || document.title.split(" · ")[0];
      const short = (t && t.siteShort) || full.split(" · ")[0] || full;
      // 页名已经在标题里就别拼第二遍
      document.title = pageName.indexOf(short) === 0 ? pageName : pageName + " · " + short;
    }
  };

  /* ---------- 照片 ---------- */
  Site.visiblePhotos = function () {
    const list = (Site.db && Site.db.photos) || [];
    return list
      .filter((p) => !p.hidden)
      .slice()
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  };

  Site.placeLabel = function (p) {
    const pl = (p && p.place) || {};
    const parts = [pl.province, pl.city === pl.province ? "" : pl.city, pl.district, pl.spot];
    return parts.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join("·") || p.title || "我们的日常";
  };

  /* ---------- 拍立得卡片（懒加载 + 入场） ---------- */
  let wallIO = null;
  Site.photoCard = function (p, i, all) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "wall__item reveal";
    node.setAttribute("aria-label", "查看照片：" + (p.title || p.file));
    const ar = p.ar || 0.75;
    // 网格位置放缩略图；灯箱另外用 p.src 原图（见 lightbox.fill）
    // 兼容两种字段名：新版构建脚本写 thumb，早期 NAS 清单透传的是 s
    const thumb = Site.thumbDead ? "" : (p.thumb || p.s || "");
    const gridSrc = Site.imgSrc(thumb || p.src);
    const fallback = thumb && p.src ? Site.imgSrc(p.src) : "";
    node.innerHTML =
      '<div class="polaroid">' +
      '<span class="tape" aria-hidden="true"></span>' +
      `<img class="polaroid__img" alt="${esc(p.title)}" data-src="${esc(gridSrc)}"` +
      (fallback ? ` data-fallback="${esc(fallback)}"` : "") +
      ` style="aspect-ratio:${ar}" />` +
      '<p class="polaroid__caption">' + esc(p.desc || p.title || "我们的日常") +
      (p.date
        ? '<span class="polaroid__date">' + esc(String(p.date).replace(/-/g, ".")) + " · " + esc(Site.placeLabel(p)) + "</span>"
        : "") +
      "</p></div>";
    node.addEventListener("click", () => Site.lightbox(all || Site.visiblePhotos(), i));

    const img = node.querySelector("img");
    if (!wallIO) {
      wallIO = new IntersectionObserver(
        (entries) =>
          entries.forEach((en) => {
            if (!en.isIntersecting) return;
            const im = en.target.querySelector("img[data-src]");
            if (im) {
              Site.guardImg(im);
              Site.loadImg(im, im.dataset.src);
              im.removeAttribute("data-src");
            }
            wallIO.unobserve(en.target);
          }),
        // 2400px 而不是 400px：照片墙改成翻页后，一页 60 张、整页高六七千像素。
        // 400px 意味着必须真的滚到那一张附近才开始下载，用户在页中间停下时，
        // 屏外半屏全是空白纸片——看起来就是「有部分照片显示不出来」。
        // 放大到 2400px 后，翻页当下就会把整页都排进队列；真正的并发仍然由
        // loadImg 的 IMG_LIMIT 队列卡着，不会把带宽摊薄。
        { rootMargin: "2400px 0px" }
      );
    }
    wallIO.observe(node);
    Site.reveal(node, (i % 8) * 45);
    return node;
  };

  /* ---------- 整页直接开下（分页专用） ----------
     为什么不能只靠 IntersectionObserver：照片墙是 CSS columns 布局，
     浏览器给多列元素算相交矩形时，列末那几张经常被判成「不在视口内」，
     于是整列尾部永远不触发懒加载——实测一页 60 张里固定缺 28 张，
     而且缺的都是每列最后 9 个（idx 9-18/31-39/51-59），看着就是「有些照片不显示」。

     分页场景本身没有「省流量」的必要：用户点页码就是为了看这一页，
     一页最多 240 张，队列本来就有并发闸门。所以渲染完就整页排进队列，
     把探测的责任交回给确定性的排队逻辑。首页那种「滚到才补下一批」仍然走 IO。 */
  Site.loadWallNow = function (root) {
    if (!root) return;
    root.querySelectorAll("img[data-src]").forEach(function (im) {
      Site.guardImg(im);
      Site.loadImg(im, im.dataset.src);
      im.removeAttribute("data-src");
    });
  };

  /* ---------- 首页照片：首屏 N 排 + 滚到就补下一批 ----------
     只铺 3 排不是省 DOM，是为了压住并发：隧道带宽有限，一次铺 24 张会让每张都变慢。
     more 是 grid 后面的占位块，进入视口就把下一批挪进来，直到 maxRows 行封顶。 */
  Site.renderPhotosPaged = function (grid, more, all, opt) {
    if (!grid) return;
    opt = opt || {};
    const perRow = Math.max(1, opt.perRow || 4);
    const firstRows = Math.max(1, opt.firstRows || 3);
    const maxRows = Math.max(firstRows, opt.maxRows || firstRows);
    const step = Math.max(1, opt.stepRows || 3) * perRow;
    const cap = Math.min(all.length, maxRows * perRow);
    let shown = Math.min(cap, firstRows * perRow);

    // 灯箱的翻页范围 = 已经铺出来的这些，不是全部 562 张。
    // 首页按设置只显示 2 行（8 张），点第 8 张往后翻出第 9 张、而墙上根本没有它，
    // 用户会以为「照片墙漏图了」。取 seen 这个活数组：more 补进来的会自然接上。
    const seen = [];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < shown; i++) {
      seen.push(all[i]);
      frag.appendChild(Site.photoCard(all[i], seen.length - 1, seen));
    }
    grid.appendChild(frag);

    if (!more) return;
    const btn = more.querySelector("[data-more]");
    const tip = more.querySelector("[data-left]");

    function sync() {
      const left = Math.min(cap, all.length) - shown;
      if (tip) tip.textContent = left > 0 ? "还有 " + left + " 张" : "";
      more.hidden = left <= 0;
      if (btn) btn.hidden = left <= 0;
    }

    function grow() {
      if (shown >= cap) return false;
      const end = Math.min(cap, shown + step);
      const f = document.createDocumentFragment();
      for (let i = shown; i < end; i++) {
        seen.push(all[i]);
        f.appendChild(Site.photoCard(all[i], seen.length - 1, seen));
      }
      grid.appendChild(f);
      shown = end;
      sync();
      return shown < cap;
    }

    // 观察器只在「进入/离开视口」时回调；补完一批后 more 只是往下挪了位置，
    // 状态没变就不会再触发，所以补完要自己再看一次它还在不在视口附近。
    function checkNear() {
      if (more.hidden) return;
      const near = more.getBoundingClientRect().top < window.innerHeight + 300;
      if (!near) return;
      if (grow()) requestAnimationFrame(checkNear);
    }

    sync();
    // 一铺好就主动补一次，别把补页交给「观察器什么时候回调」这种不确定的事。
    // 桌面/平板首屏常把整段照片区包进去：more 块一创建就在视口附近，观察器却未必
    // 交得出那一次 isIntersecting 回调 → 实测 768 档永远停在 2 排（8 张），
    // 卡片总高 605px 在 1024px 视口内，用户看到的就是「照片墙只有两排」。
    // 判据只认同一个坐标系：grid 底边是否还在首屏内。别混用「more 的位置」——
    // 它下面还有「查看全部」链接，判出来的边界比网格实际底边高一截。
    // 量之前还要让版面落定：prime 跑在 site:ready 里，此时上面的板块可能还是
    // opacity:0 的渐入初态，后面板块会跟着上浮（实测同一时刻 2893、稳定后 3083，差 190px）。
    // 所以分几帧判、最多补 3 批（自然被 cap 封住），别一把梭也别无限循环。
    // 判定不能只用「此刻 grid 底边在不在首屏」：首页大概率深链进来后立刻有轮播
    // takeover 把滚动弹走（实测 location.hash 变 #p2~#p4、scrollY 瞬间非 0），
    // 那一刻量出来的「已越过首屏」是假的，于是永远停在 2 排。
    // 所以看的是「首屏排数够不够」：photoRowsMax 行以内全铺满，超过就不硬拉。
    if (window.scrollY < 40) {
      const need = Math.min(cap, maxRows * perRow);
      if (shown < need) { grow(); sync(); }
    }
    if (btn) btn.addEventListener("click", function () { grow(); checkNear(); });
    if (!("IntersectionObserver" in window)) {
      more.hidden = true;
      return;
    }
    const io = new IntersectionObserver(
      (ens) => ens.forEach((en) => { if (en.isIntersecting) checkNear(); }),
      { rootMargin: "300px 0px" }
    );
    io.observe(more);
  };

  /* ---------- 入场动画（单向，不来回触发） ---------- */
  let revealIO = null;
  Site.reveal = function (node, delay) {
    node.classList.add("reveal");
    if (delay) node.style.setProperty("--reveal-delay", delay + "ms");
    if (!revealIO) {
      revealIO = new IntersectionObserver(
        (entries) =>
          entries.forEach((en) => {
            if (en.isIntersecting) { en.target.classList.add("in"); revealIO.unobserve(en.target); }
          }),
        { threshold: 0.1 }
      );
    }
    revealIO.observe(node);
  };
  /* 接管 HTML 里静态写死的 .reveal，否则它们永远停在 opacity:0 */
  Site.revealAll = function () {
    document.querySelectorAll(".reveal:not(.in)").forEach((n) => {
      if (!revealIO) {
        revealIO = new IntersectionObserver(
          (entries) =>
            entries.forEach((en) => {
              if (en.isIntersecting) { en.target.classList.add("in"); revealIO.unobserve(en.target); }
            }),
          { threshold: 0.1 }
        );
      }
      revealIO.observe(n);
    });
  };

  /* ---------- 灯箱 ---------- */
  const SVG = {
    close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    prev: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    next: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  };

  Site.lightbox = function (items, index) {
    let lb = $("#lightbox");
    if (!lb) {
      lb = document.createElement("div");
      lb.id = "lightbox";
      lb.className = "lightbox";
      lb.hidden = true;
      lb.setAttribute("role", "dialog");
      lb.setAttribute("aria-modal", "true");
      lb.innerHTML =
        '<button class="lightbox__btn lightbox__close" data-a="close" aria-label="关闭">' + SVG.close + "</button>" +
        '<button class="lightbox__btn lightbox__prev" data-a="prev" aria-label="上一张">' + SVG.prev + "</button>" +
        '<img class="lightbox__img" alt="" />' +
        '<button class="lightbox__btn lightbox__next" data-a="next" aria-label="下一张">' + SVG.next + "</button>" +
        '<p class="lightbox__caption"></p>';
      document.body.appendChild(lb);
      // SVG 会成为 e.target，必须用 closest 取按钮，否则 dataset 读空、按钮全失效
      lb.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-a]");
        const a = btn && btn.dataset.a;
        if (a === "close") Site.lightbox.close();
        else if (a === "prev") Site.lightbox.step(-1);
        else if (a === "next") Site.lightbox.step(1);
        else if (e.target === lb) Site.lightbox.close();
      });
      document.addEventListener("keydown", (e) => {
        if (lb.hidden) return;
        if (e.key === "Escape") Site.lightbox.close();
        if (e.key === "ArrowLeft") Site.lightbox.step(-1);
        if (e.key === "ArrowRight") Site.lightbox.step(1);
      });
      // 触屏左右滑
      let tx = 0, ty = 0, on = false;
      lb.addEventListener("touchstart", (e) => { on = true; tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
      lb.addEventListener("touchend", (e) => {
        if (!on) return;
        on = false;
        const t = e.changedTouches[0], dx = t.clientX - tx, dy = t.clientY - ty;
        if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) Site.lightbox.step(dx < 0 ? 1 : -1);
        else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.6) Site.lightbox.close();
      }, { passive: true });
    }
    Site.lightbox.items = items || [];
    // 下标夹到有效区间：外面传进来的 i 可能是筛选前的旧下标，夹一下免得开成空白
    const n0 = Site.lightbox.items.length;
    Site.lightbox.idx = Math.min(Math.max(0, index || 0), Math.max(0, n0 - 1));
    Site.lightbox.fill();
    lb.hidden = false;
    requestAnimationFrame(() => lb.classList.add("open"));
    document.body.style.overflow = "hidden";
  };

  Site.lightbox.fill = function () {
    const lb = $("#lightbox");
    const p = Site.lightbox.items[Site.lightbox.idx];
    if (!lb || !p) return;
    const lbImg = lb.querySelector(".lightbox__img");
    Site.guardImg(lbImg);
    const want = Site.imgSrc(p.src);
    const thumb = Site.thumbDead ? "" : (p.thumb || p.s || "");
    lbImg.alt = p.title || "";

    // 原图 2 MB 上下、隧道上要两三秒，直接换来是一片白。
    // 先把网格里的缩略图顶上去（它基本已经缓存过），原图在后台 quiet 地加载，好了再换。
    if (thumb && want && thumb !== want) {
      lbImg.setAttribute("data-want", want);
      lbImg.src = thumb;
      // 灯箱是「看细节」的地方，用户不是在刷墙。原图没到之前先标一下放大状态，
      // 到了再撤掉——不然点开只看到一张糊的缩略图，还以为原图就这清晰度。
      lb.classList.add("is-loading-hd");
      const pre = new Image();
      pre.onload = function () {
        if (lbImg.getAttribute("data-want") === want) {
          lbImg.src = want;
          lb.classList.remove("is-loading-hd");
        }
      };
      // 原图挂了（隧道抖动 / 文件缺失）：留着缩略图，别把这张也变成占位图
      pre.onerror = function () { lb.classList.remove("is-loading-hd"); };
      pre.src = want;
    } else {
      lbImg.removeAttribute("data-want");
      lb.classList.remove("is-loading-hd");
      lbImg.src = want;
    }

    const place = Site.placeLabel(p);
    lb.querySelector(".lightbox__caption").textContent =
      (p.title && p.title !== place ? p.title + " · " : "") + place +
      (p.date ? " · " + String(p.date).replace(/-/g, ".") : "");

    Site.lightbox.syncNav();
  };

  /* 第一张不给「上一张」、最后一张不给「下一张」。
     2026-11-23 之前是取模循环：点最后一张往后会直接跳回第一张，
     看上去像「到底了却又从头开始」，用户认为不合理，改成到边即停。 */
  Site.lightbox.syncNav = function () {
    const lb = $("#lightbox");
    if (!lb) return;
    const n = (Site.lightbox.items || []).length;
    const i = Site.lightbox.idx || 0;
    const prev = lb.querySelector('.lightbox__btn[data-a="prev"]');
    const next = lb.querySelector('.lightbox__btn[data-a="next"]');
    const single = n <= 1;
    if (prev) prev.disabled = single || i <= 0;
    if (next) next.disabled = single || i >= n - 1;
    // 只有一张时两侧都停用，别再留两个按不动的圆圈抢视线
    lb.classList.toggle("is-single", single);
  };

  Site.lightbox.close = function () {
    const lb = $("#lightbox");
    if (!lb) return;
    lb.classList.remove("open");
    document.body.style.overflow = "";
    setTimeout(() => { lb.hidden = true; }, 280);
  };

  /* 左右滑动：先退场再换图再进场；_busy 防连点错乱 */
  Site.lightbox.step = function (d) {
    const lb = $("#lightbox");
    const items = Site.lightbox.items || [];
    const n = items.length;
    if (!n || !lb || Site.lightbox._busy) return;
    const dir = d > 0 ? 1 : -1;
    const next = Site.lightbox.idx + d;
    // 到边界就停住，不绕回另一头
    if (next < 0 || next >= n) { Site.lightbox.syncNav(); return; }
    Site.lightbox.idx = next;
    const img = lb.querySelector(".lightbox__img");
    const cap = lb.querySelector(".lightbox__caption");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { Site.lightbox.fill(); return; }
    Site.lightbox._busy = true;
    img.style.setProperty("--slide-dir", dir);
    img.classList.add("is-out");
    cap.classList.add("is-out");
    setTimeout(() => {
      Site.lightbox.fill();
      img.classList.remove("is-out");
      img.classList.add("is-in");
      cap.classList.remove("is-out");
      cap.classList.add("is-in");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          img.classList.remove("is-in");
          cap.classList.remove("is-in");
          Site.lightbox._busy = false;
        })
      );
    }, 170);
  };

  /* ---------- 时间轴 ---------- */
  Site.renderTimeline = function (container, items) {
    if (!container) return;
    container.innerHTML = "";
    (items || []).forEach((t, i) => {
      const li = document.createElement("li");
      li.className = "timeline__item";
      li.innerHTML =
        '<span class="timeline__dot" aria-hidden="true"></span>' +
        '<p class="timeline__date">' + esc(t.date) + "</p>" +
        '<h3 class="timeline__title">' + esc(t.title) + "</h3>" +
        '<p class="timeline__text">' + esc(t.text) + "</p>";
      container.appendChild(li);
      Site.reveal(li, (i % 4) * 70);
    });
  };

  /* ---------- 随手记 ---------- */
  Site.renderQuotes = function (container, items) {
    if (!container) return;
    container.innerHTML = "";
    (items || []).forEach((q, i) => {
      const card = document.createElement("blockquote");
      card.className = "quote";
      card.style.setProperty("--tilt", ((i * 47) % 7) - 3 + "deg");
      card.innerHTML =
        '<p class="quote__text">「' + Site.richText(q.text) + "」</p>" +
        (q.tag ? '<cite class="quote__tag">—— ' + esc(q.tag) + "</cite>" : "");
      container.appendChild(card);
      Site.reveal(card, (i % 3) * 90);
    });
  };

  /* ---------- 心愿单（TodoList 风格，待解锁 / 已解锁两块） ---------- */
  // 两块始终都渲染，哪怕其中一块是空的——空着就把框架留在那儿并写一句提示，
  // 不能因为「暂时没有已解锁」就让右栏整个消失，那样两栏布局会塌成单栏。
  Site.renderWishes = function (container, items, opt) {
    if (!container) return;
    container.innerHTML = "";
    const all = items || [];
    const limit = (opt && opt.limit) || 0; // 每组最多显示几条，0 = 全部

    const mkGroup = (title, list, cls, emptyText) => {
      const box = document.createElement("div");
      box.className = "wishbox " + cls;
      const arr = limit ? list.slice(0, limit) : list;

      const h = document.createElement("h3");
      h.className = "wishbox__head";
      // 徽章显示「实际显示的条数」，总数更多时补一个分母，免得看到 12 以为是 12 条都铺上了
      const badge = arr.length < list.length ? arr.length + "/" + list.length : String(arr.length);
      h.innerHTML = esc(title) + "<small>" + badge + "</small>";
      box.appendChild(h);

      if (!arr.length) {
        const ph = document.createElement("p");
        ph.className = "wishbox__empty";
        ph.textContent = emptyText;
        box.appendChild(ph);
        return box;
      }

      arr.forEach((w, i) => {
        const card = document.createElement("div");
        card.className = "wish reveal" + (w.done ? " wish--done" : "");
        card.innerHTML =
          '<span class="wish__check" aria-hidden="true">' + (w.done ? "✓" : "") + "</span>" +
          '<span class="wish__emoji" aria-hidden="true">' + Site.wishIcon(w.emoji) + "</span>" +
          '<span class="wish__text' + (w.done ? " is-done" : "") + '">' + esc(w.text) + "</span>" +
          '<span class="wish__mark">' + (w.done ? "已解锁" : "待解锁") + "</span>";
        box.appendChild(card);
        Site.reveal(card, (i % 4) * 60);
      });
      return box;
    };

    container.appendChild(
      mkGroup("待解锁", all.filter((w) => !w.done), "wishbox--todo", "还没有写下的愿望，去后台加一条吧。")
    );
    container.appendChild(
      mkGroup("已解锁", all.filter((w) => w.done), "wishbox--done", "还没解锁的愿望，等着我们一起完成。")
    );
  };

  /* ---------- 影像 ---------- */
  /* ---------- 影像 ---------- */
  // 手机竖拍视频占大多数（1080×1920），横盒子 + object-fit:cover 会把画面裁掉大半，
  // 因此按真实比例决定卡片是竖版还是横版。NAS 清单没给尺寸时用元数据兜底。
  Site.renderVideos = function (container, items) {
    if (!container) return;
    container.innerHTML = "";
    const fmt = (s) => {
      s = Math.round(+s || 0);
      return s >= 60 ? Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") : s + "s";
    };
    (items || []).forEach((v, i) => {
      const portrait = +(v.h || 0) > +(v.w || 0);
      const card = document.createElement("article");
      card.className = "video-card" + (portrait ? " video-card--portrait" : "");
      card.style.setProperty("--reveal-delay", (i % 3) * 100 + "ms");
      const vid = document.createElement("video");
      vid.controls = true;
      // 关键：preload=metadata 在没有 poster 时，Chromium 会发 Range: bytes=0- 的开放式
      // 请求，把整个 mp4 拖下来（实测首页 3 个视频 = 67MB）。改成 none，点播放才加载。
      vid.preload = "none";
      vid.setAttribute("playsinline", "");
      // poster 默认是本地 SVG（走 Pages，不依赖 NAS、零请求）。
      // NAS 抽好首帧封面后，用 Image 预检通过才替换；404 就安静地保持 SVG。
      // 不能用 video 的 error 事件判断 —— poster 加载失败不会触发它。
      vid.poster = Site.VIDEO_POSTER;
      if (v.poster) {
        const url = Site.media(v.poster);
        if (url) {
          const probe = new Image();
          probe.onload = () => { vid.poster = url; };
          probe.src = url;
        }
      }
      // NAS 不可用时留空 src，由 CSS 的占位背景兜着，别让浏览器去请求一个必然失败的地址
      if (v.src) vid.src = v.src;
      else card.classList.add("is-offline");
      // 拿到时长后补一行小字，没有标题时它就是唯一的说明
      vid.addEventListener(
        "loadedmetadata",
        () => {
          if (vid.duration && isFinite(vid.duration)) meta.textContent = fmt(vid.duration);
        },
        { once: true }
      );

      /* ---------- 失败可见 + 可重试 ----------
         2026-11-17 用户反馈「影像部分有视频无法读取」。
         走 Cloudflare 隧道传 mp4，偶发 502/超时会触发 video 的 error 事件，
         原来的实现什么都不做——用户只看到一块黑框，不知道是网卡了还是文件坏了。
         现在：error 时给卡片挂 is-error（CSS 出一句说明），并放一个「重试」按钮。
         重试就是换一个带时间戳的地址重新加载，绕开中间层可能缓存的失败响应。 */
      const frame = document.createElement("div");
      frame.className = "video-card__frame";
      const showError = (msg) => {
        card.classList.add("is-error");
        card.classList.remove("is-offline");
        let btn = card.querySelector(".video-card__retry");
        if (!btn) {
          btn = document.createElement("button");
          btn.type = "button";
          btn.className = "video-card__retry";
          btn.textContent = "重试";
          frame.appendChild(btn);
        }
        btn.hidden = false;
        btn.onclick = () => {
          card.classList.remove("is-error");
          btn.hidden = true;
          const base = String(v.src || "").split("?")[0];
          if (!base) return;
          const k = window.__ALBUM_K || "";
          vid.src = base + "?r=" + Date.now() + (k ? "&k=" + encodeURIComponent(k) : "");
          try { vid.load(); } catch (e) {}
        };
        if (msg) card.dataset.err = msg;
      };
      vid.addEventListener("error", () => {
        // 只报真错：用户还没点播放时 preload=none 也可能给一个空 error，忽略
        if (!vid.currentSrc && !vid.src) return;
        showError("media-error");
      });
      // 挂太久没有任何数据 → 判超时（隧道带宽低时常见，别让人干等）
      let stallT = null;
      vid.addEventListener("loadstart", () => {
        clearTimeout(stallT);
        stallT = setTimeout(() => {
          if (vid.readyState < 1) showError("timeout");
        }, 45000);
      });
      vid.addEventListener("loadeddata", () => clearTimeout(stallT));

      frame.appendChild(vid);
      const body = document.createElement("div");
      body.className = "video-card__body";
      const h3 = document.createElement("h3");
      h3.className = "video-card__title";
      const d = String(v.date || "");
      h3.textContent = d ? d.replace(/-/g, ".") : "片段";
      const meta = document.createElement("span");
      meta.className = "video-card__meta";
      body.appendChild(h3);
      body.appendChild(meta);
      card.appendChild(frame);
      card.appendChild(body);
      container.appendChild(card);
      // NAS 清单没给宽高 → 等元数据到了再定卡片是竖版还是横版
      if (!portrait) {
        vid.addEventListener(
          "loadedmetadata",
          () => {
            if (vid.videoHeight > vid.videoWidth) {
              card.classList.add("video-card--portrait");
              vid.style.objectFit = "contain";
            }
          },
          { once: true }
        );
      }
      Site.reveal(card, (i % 3) * 100);
    });
  };

  /* ---------- 子页面配置（后台可调，缺省有默认值） ---------- */
  // 首页只铺 N 排，子页面是「全部内容」，但列数和每组条数也该能调——
  // 手机上看 3 列拍立得就太挤，愿望太多也会翻很久。
  Site.pageCfg = function () {
    const p = (Site.db && Site.db.meta && Site.db.meta.pages) || {};
    const cfg = {
      photosCols: Math.min(4, Math.max(1, +p.photosCols || 3)),   // 照片墙页列数
      quotesCols: Math.min(3, Math.max(1, +p.quotesCols || 2)),   // 随手记页列数
      wishLimit: Math.max(0, +p.wishLimit || 0),                  // 心愿单每组条数，0 = 全部
      // 分页：一页几行、每行几列。默认 20 行 × 3 列 = 60 张/页，
      // 562 张就是 10 页——翻十次能看完，滑到底要滑八万像素。
      photosRows: Math.min(60, Math.max(2, +p.photosRows || 20)),
      photosPerPage: 0, // 由下方按行×列算，别在数据里存冗余
    };
    cfg.photosPerPage = Math.min(240, cfg.photosRows * Math.max(1, Math.min(4, cfg.photosCols)));
    return cfg;
  };

  /* ---------- 首页配置（后台可调，缺省有默认值） ---------- */
  Site.homeCfg = function () {
    const h = (Site.db && Site.db.meta && Site.db.meta.home) || {};
    const ALL = ["timeline", "photos", "quotes", "wishes", "videos"];
    const rows = Math.max(1, +h.photoRows || 2);
    return {
      timelineCount: Math.max(1, +h.timelineCount || 5),
      photoRows: rows,                                              // 首屏铺几排
      // 2026-11-23：默认与 photoRows 相等。以前默认 rows+3，后台只填一个数时
      // 页面会自己多长三排，看起来像「设置没生效」。要更多行就改同一个数。
      photoRowsMax: Math.max(rows, +h.photoRowsMax || rows),         // 滚到底最多铺到几排
      quoteRows: Math.max(1, +h.quoteRows || 1),
      wishCount: Math.max(2, +h.wishCount || 8),
      showVideos: h.showVideos || "auto", // auto | show | hide
      order: (Array.isArray(h.order) && h.order.length ? h.order : ALL).filter((k) => ALL.includes(k)),
    };
  };

  /* ---------- 板块「幻灯片式」渐入（单向触发，不闪烁） ---------- */
  Site.initSlides = function (scope) {
    const root = scope || document;
    const secs = root.querySelectorAll("main > [data-sec], .home-slide");
    if (!secs.length) return;
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((en) => {
          if (en.isIntersecting && en.intersectionRatio > 0.12) {
            en.target.classList.add("in");
            io.unobserve(en.target);
          }
        }),
      { threshold: [0.12], rootMargin: "0px 0px -6% 0px" }
    );
    secs.forEach((s) => {
      s.classList.add("home-slide");
      if (s.getBoundingClientRect().top < window.innerHeight * 0.6) s.classList.add("in");
      else io.observe(s);
    });
    // 兜底：观察器不回调的环境里，6 秒后强制显示
    setTimeout(() => secs.forEach((s) => s.classList.add("in")), 6000);
  };

  /* ---------- 字体就绪：可观测，且带硬超时 ----------
     霞鹜文楷切成 194 个子集，浏览器按 unicode-range 只下用到的那几个，
     正常情况下二十来个请求、一两百毫秒就完事。但在 CDN 冷启动、隧道限速、
     或者某些无头浏览器里，document.fonts.status 会长时间停在 loading，
     任何 await document.fonts.ready 的脚本（截图、性能采集）就会永远挂着——
     看起来像「页面卡死」，其实内容早渲染完了。
     这里给一个 3 秒上限的版本，并往 <html> 上打 fonts-ready，
     自动化要等字体就绪就等这个，别直接等 document.fonts.ready。 */
  Site.watchFonts = function () {
    const started = Date.now();
    const done = function (how) {
      document.documentElement.classList.add("fonts-ready");
      document.documentElement.dataset.fonts = how;
      Site.fontsMs = Date.now() - started;
      return Site.fontsMs;
    };
    if (!document.fonts || !document.fonts.ready) return done("无 FontFace API，用系统字体");
    let settled = false;
    const settle = function (how) {
      if (settled) return;
      settled = true;
      done(how);
    };
    document.fonts.ready.then(function () { settle("loaded"); });
    setTimeout(function () { settle("timeout"); }, 3000);
    return null;
  };
  /* ---------- 相恋天数 ---------- */
  Site.renderDays = function () {
    const ann = (Site.db && Site.db.meta && Site.db.meta.anniversary) || "";
    const start = ann ? new Date(ann + "T00:00:00") : null;
    const days = start && !isNaN(start) ? Math.max(0, Math.floor((Date.now() - start) / 86400000)) : 0;
    const set = (id, v) => { const n = $("#" + id); if (n) n.textContent = v; };
    set("days-count", days.toLocaleString("zh-CN"));
    set("since-date", ann.replace(/-/g, "."));
    set("since-year", ann.slice(0, 4));
  };

  /* ---------- 版本时间戳 ----------
     页脚那个小字「2026.11.23 16:31」的来源。以前是 HTML 里写死的，改一次内容
     也不会动，久了就成了假信息。现在统一读 content.json 的 builtAt，后台顶部
     用的是同一个函数，两边永远一致。
     兼容三种旧值：纯日期 2026-11-23 / 日期+时分 2026-11-23 16:31 / ISO 带 T。 */
  Site.stampText = function (v) {
    const s = String(v || "").trim();
    if (!s) return "";
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/);
    if (!m) return s;
    const p = (n) => String(n).padStart(2, "0");
    return `${m[1]}.${p(m[2])}.${p(m[3])}` + (m[4] ? ` ${p(m[4])}:${m[5]}` : "");
  };

  Site.renderStamp = function () {
    const t = Site.stampText(Site.db && Site.db.builtAt);
    if (!t) return;
    document.querySelectorAll("[data-stamp]").forEach((el) => { el.textContent = t; });
  };

  /* ---------- 结语：内容就绪事件 ---------- */
  Site.boot = async function () {
    Site.watchFonts();          // 和内容加载并行，不等
    // 先用上次的文案把首屏填上（防「我们的故事 → Album」跳字），再去拿线上内容
    const c = cachedTexts();
    if (c) { Site.db = { meta: { texts: c.texts } }; Site.applyTexts(); }
    await Site.load();
    Site.applyTexts();
    Site.renderDays();
    Site.renderStamp();
    Site.revealAll();
    if (!Site.db) Site.showLoadError();
    document.dispatchEvent(new CustomEvent("site:ready", { detail: Site.db }));
  };
})();
