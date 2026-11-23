/* page-videos.js —— 影像子页
   上传入口只在管理后台；前台纯展示。
   内容来自 NAS 清单里的 video 项（content.json 的 videos）。

   2026-11-23 补：videos.html 的 <script> 在 <div id="page-videos"> 之前，
   content.json 命中浏览器缓存时 site:ready 会早于 DOM 解析完成，
   这时 getElementById 拿到 null，整页空白且不报错（实测 cards=0）。
   所以改成「拿不到容器就等 DOMContentLoaded 再画一次」。 */
(function () {
  "use strict";

  function draw(list) {
    var box = document.getElementById("page-videos");
    if (!box) return false;
    if (!list.length) {
      box.innerHTML =
        '<p class="section__desc" style="color:#b8b1a2">还没有短片。管理后台「媒体文件」里可以上传。</p>';
      return true;
    }
    Site.renderVideos(box, list);
    return true;
  }

  document.addEventListener("site:ready", function (e) {
    var db = e.detail || {};
    var list = db.videos || [];
    if (draw(list)) return;
    document.addEventListener(
      "DOMContentLoaded",
      function () {
        draw(list);
      },
      { once: true }
    );
  });
})();
