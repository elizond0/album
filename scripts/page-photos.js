/* page-photos.js —— 照片墙子页：渲染 + 地点筛选 + 分页
   本对话的决定：前台不再提供上传按钮，所有内容调整都在管理后台。
   因此这里只做展示与筛选。

   ============================================================
   为什么从「无限滚动」改成「分页」（2026-11-17）
   ============================================================
   以前是一次铺 48 张、滚到底自动补。问题有两个，都是实测出来的：
     1. 瀑布流用 CSS columns，卡片按「列优先」排。无限追加时新一批照片
        会插进各列末尾，顺序看起来是乱的；想找某一张只能一直滚。
     2. 用户明确要「一页 20 行、能翻页」。
   现在改成：每页 rows × cols 张（默认 20 行 × 3 列 = 60 张），
   底部页码栏翻页，翻页时滚回照片墙顶部而不是页面顶部。

   ============================================================
   还有一个坑：CSS columns 是按列填的
   ============================================================
   .wall{columns:3} 会把第 1、2、3 张竖着排在左列，第 4 张才进中列。
   人眼读图是从左到右，这样读序号全是跳的。所以这里先把「视觉顺序」
   算成 indexMap：rows 行 × cols 列，一页正好整除，按行优先取下标。
   手机 1 列、平板 2 列时也按当前实际列数重算，序号始终对得上。 */
(function () {
  "use strict";

  let all = [];      // 全部可见照片（按日期从新到旧）
  let list = [];     // 当前筛选后的照片
  let cfg = { photosCols: 3, photosRows: 20, photosPerPage: 60 };
  let page = 1;
  let lastPlace = null;   // 上一次生效的地点筛选，用来判断「要不要把页码打回 1」

  function placeKey(p) {
    const pl = p.place || {};
    const parts = [pl.province, pl.city, pl.district, pl.spot].filter(Boolean);
    return parts.length ? parts.join("·") : "未标注地点";
  }

  function placeOptions() {
    const sel = document.getElementById("place-filter");
    if (!sel) return;
    const map = new Map();
    all.forEach((p) => {
      const k = placeKey(p);
      map.set(k, (map.get(k) || 0) + 1);
    });
    const keys = [...map.keys()].sort((a, b) => {
      if (a === "未标注地点") return 1;
      if (b === "未标注地点") return -1;
      return map.get(b) - map.get(a);
    });
    sel.innerHTML =
      '<option value="">全部地点（' + all.length + "）</option>" +
      keys.map((k) => `<option value="${Site.esc(k)}">${Site.esc(k)}（${map.get(k)}）</option>`).join("");
  }

  /* ---------- 列数：以后台设置为上限，窄屏再降 ----------
     必须读实际生效的列数，不能直接用后台值：后台写 3，手机上是 1 列，
     按 3 列算出来的行优先顺序在 1 列布局下就是错的。 */
  function effectiveCols() {
    const w = window.innerWidth;
    let c = cfg.photosCols;
    if (w <= 560) c = 1;
    else if (w <= 960) c = Math.min(c, 2);
    else if (w <= 1100) c = Math.min(c, 3);
    return Math.max(1, Math.min(4, c));
  }

  function perPage() {
    return Math.max(1, cfg.photosPerPage);
  }

  function totalPages() {
    return Math.max(1, Math.ceil(list.length / perPage()));
  }

  /* ---------- 一页内的「视觉顺序」 ----------
     columns 是列优先填充，所以想让第 n 张显示在第 r 行第 c 列，
     就要把索引排成 [c0r0, c1r0, ..., c0r1, c1r1, ...] 的转置形式。 */
  function indexMap(startIdx, count, cols) {
    const rows = Math.ceil(count / cols);
    const order = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // 列优先落位：第 c 列的第 r 个
        const i = c * rows + r;
        if (i < count) order.push(startIdx + i);
      }
    }
    return order;
  }

  function render() {
    const wall = document.getElementById("wall");
    if (!wall) return;
    const cols = effectiveCols();
    const size = perPage();
    const pages = totalPages();
    page = Math.min(Math.max(1, page), pages);

    const start = (page - 1) * size;
    const count = Math.min(size, list.length - start);

    wall.dataset.cols = String(cfg.photosCols);
    wall.innerHTML = "";

    const frag = document.createDocumentFragment();
    // 灯箱范围 = 本页。分页的意义就是「这一页就这些」，
    // 翻到最后一张还能滑进下一页，页码栏就白摆了（2026-11-23 改）。
    const pageList = list.slice(start, start + count);
    indexMap(start, count, cols).forEach((idx, vi) => {
      frag.appendChild(Site.photoCard(list[idx], idx - start, pageList));
    });
    wall.appendChild(frag);

    // 整页直接开下。别指望 IntersectionObserver —— CSS columns 下浏览器算不出
    // 列尾那几张的真实位置，实测每列最后 9 张永远不加载（一页缺 28 张）。
    if (Site.loadWallNow) Site.loadWallNow(wall);

    renderPager(pages, start, count);
    renderCount(start, count);
  }

  function renderCount(start, count) {
    const el = document.getElementById("wall-count");
    if (!el) return;
    const sel = document.getElementById("place-filter");
    const want = sel ? sel.value : "";
    const scope = want ? `${want} · ` : "";
    if (!list.length) {
      el.textContent = want ? `${want} · 这里还没有照片。` : "这里还没有照片。";
      return;
    }
    el.textContent = `${scope}第 ${page} / ${totalPages()} 页 · 本页 ${count} 张（第 ${start + 1}–${start + count} 张，共 ${list.length} 张）`;
  }

  /* ---------- 页码栏 ----------
     562 张、每页 60 张 = 10 页。页码全铺太长（手机上尤其），
     所以用「首页 … 当前±2 … 末页」的省略式，加前后翻。 */
  function pageWindow(cur, total) {
    const set = new Set([1, total, cur, cur - 1, cur + 1, cur - 2, cur + 2]);
    const arr = [...set].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
    const out = [];
    arr.forEach((n, i) => {
      if (i && n - arr[i - 1] > 1) out.push("…");
      out.push(n);
    });
    return out;
  }

  function renderPager(pages, start, count) {
    const box = document.getElementById("wall-pager");
    if (!box) return;
    if (pages <= 1) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;

    const btn = (label, p, opt) => {
      opt = opt || {};
      const dis = opt.disabled ? " disabled" : "";
      const cur = opt.current ? ' aria-current="page"' : "";
      const cls = "pager__btn" + (opt.current ? " is-current" : "");
      return `<button type="button" class="${cls}" data-page="${p}"${dis}${cur}>${label}</button>`;
    };

    let html = "";
    html += btn("‹ 上一页", page - 1, { disabled: page === 1 });
    pageWindow(page, pages).forEach((n) => {
      html += n === "…" ? '<span class="pager__gap">…</span>' : btn(String(n), n, { current: n === page });
    });
    html += btn("下一页 ›", page + 1, { disabled: page === pages });
    box.innerHTML = html;

    // 第二排：跳到第几页 + 本页区间
    const jump = document.createElement("div");
    jump.className = "pager__meta";
    jump.innerHTML =
      `<span>共 ${list.length} 张 · 每页 ${perPage()} 张</span>` +
      `<label>跳到第 <input type="number" min="1" max="${pages}" value="${page}" id="pager-jump" /> 页</label>`;
    box.appendChild(jump);

    box.querySelectorAll("[data-page]").forEach((b) => {
      b.addEventListener("click", () => go(Number(b.dataset.page)));
    });
    const inp = box.querySelector("#pager-jump");
    if (inp) {
      inp.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const n = Math.min(pages, Math.max(1, parseInt(inp.value, 10) || 1));
        go(n);
      });
    }
  }

  function go(n) {
    page = n;
    render();
    // 滚到照片墙顶部，而不是页面顶部——顶上的站点导航和标题没必要重看一遍
    const head = document.querySelector(".wall-toolbar") || document.getElementById("wall");
    if (head) {
      const y = head.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
    }
    // 地址栏留个 #p3，刷新或分享都还在这一页；用 replaceState 不污染后退历史
    try {
      history.replaceState(null, "", page > 1 ? "#p" + page : location.pathname + location.search);
    } catch (e) { /* file:// 下会抛错，忽略 */ }
  }

  function startList() {
    const sel = document.getElementById("place-filter");
    const want = sel ? sel.value : "";
    const changed = want !== lastPlace;
    list = want ? all.filter((p) => placeKey(p) === want) : all;
    // 筛选变了才归 1：否则「#p2 深链 / 就地重渲染」会被无条件打回第一页。
    // （2026-11-17 实测：location.hash 明明是 #p2，页面停在第 1 页，就是这里干的。）
    lastPlace = want;
    if (changed) page = 1;
    render();
  }

  // 深链 #p2 的页码只读一次，记住要跳到第几页。
  // 为什么不在 site:ready 里读 location.hash 就完事：实测线上带 #p2 进来，
  // site:ready 触发时 hash 确实是 "#p2"、正则也匹配，但最终仍停在第 1 页——
  // 因为站点在 site:ready 之后还有一次版面落定（reveal 渐入、图片回填撑高），
  // 触发 resize 链把页面重渲染了一遍。重渲染走的是 render()，page 变量被前一轮
  // 的 startList 归过 1，深链就丢了。改成「记住目标页，等版面静下来再补一次」。
  let wantPage = 0;

  function syncDeepLink() {
    if (!wantPage) return;
    if (wantPage > totalPages()) return;
    if (page === wantPage) return;
    page = wantPage;
    render();
  }

  document.addEventListener("site:ready", function () {
    all = Site.visiblePhotos();
    cfg = Site.pageCfg();
    placeOptions();

    // 深链 #p3 直接翻到那一页
    const m = /^#p(\d+)$/.exec(location.hash || "");
    if (m) wantPage = Math.max(1, parseInt(m[1], 10) || 1);
    if (wantPage) page = wantPage;

    startList();

    // 首屏排版落定后（图片回填会改变列高）再校一次，兜住重渲染把页码打回 1 的情况
    requestAnimationFrame(function () {
      requestAnimationFrame(syncDeepLink);
    });
    setTimeout(syncDeepLink, 1200);

    const sel = document.getElementById("place-filter");
    if (sel) sel.addEventListener("change", function () {
      wantPage = 0;          // 用户手选了地点，深链作废，别再把它拉回去
      startList();
    });

    // 列数变了（转屏 / 拖窗口）要重算行优先顺序，否则序号会错位
    let lastCols = effectiveCols();
    let t = 0;
    window.addEventListener("resize", function () {
      clearTimeout(t);
      t = setTimeout(function () {
        const c = effectiveCols();
        if (c === lastCols) return;
        lastCols = c;
        render();
      }, 200);
    });

    // 键盘翻页：← → （不抢输入框的键）
    document.addEventListener("keydown", function (e) {
      const tag = (e.target && e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      if (e.key === "ArrowLeft" && page > 1) go(page - 1);
      if (e.key === "ArrowRight" && page < totalPages()) go(page + 1);
    });
  });
})();
