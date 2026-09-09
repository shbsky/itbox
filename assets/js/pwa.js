/* IT工具箱 · PWA 注册 + 安装引导 */
(function () {
  'use strict';

  // 只在 http(s) 下注册 Service Worker；file:// 下静默失败不影响页面
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* 离线/旧浏览器时静默 */ });
    });
  }

  // 已作为 App 启动 → 不再弹引导
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) return;

  var ua = navigator.userAgent || '';
  var isIos = /iP(hone|ad|od)/.test(ua);
  var isMobile = /Android|iP(hone|ad|od)|Mobile/.test(ua);
  if (!isMobile) return;

  function dismiss(el) {
    el.classList.add('hide');
    setTimeout(function () { el.remove(); }, 280);
  }

  function show(html, onClick) {
    if (document.getElementById('installBanner')) return;
    var b = document.createElement('div');
    b.id = 'installBanner';
    b.className = 'install-banner';
    b.innerHTML = html + '<button class="install-close" aria-label="关闭" title="关闭">×</button>';
    document.body.appendChild(b);
    b.querySelector('.install-close').onclick = function () { dismiss(b); };
    var btn = b.querySelector('[data-act]');
    if (btn && onClick) btn.onclick = function (e) { e.preventDefault(); onClick(); };
    setTimeout(function () { b.classList.add('show'); }, 600);
  }

  if (isIos) {
    show(
      '<div class="install-msg"><b>📱 安装 IT工具箱</b>' +
      '<span>iPhone：点底部分享按钮 <b style="color:var(--pri)">↑</b> → <b>添加到主屏幕</b>，即可像 App 一样全屏使用</span></div>' +
      '<button class="install-btn" data-act="x">知道了</button>',
      null
    );
  } else {
    var deferred = null;
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferred = e;
      show(
        '<div class="install-msg"><b>📲 安装 IT工具箱</b>' +
        '<span>添加到桌面后，像 App 一样全屏打开，断网也能用</span></div>' +
        '<button class="install-btn" data-act="install">安装</button>',
        function () {
          if (!deferred) return;
          deferred.prompt();
          deferred.userChoice.finally(function () { deferred = null; });
        }
      );
    });
  }
})();