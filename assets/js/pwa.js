/* IT工具箱 · PWA 注册 + 安装引导 */
(function () {
  'use strict';

  // 1. Service Worker 注册（HTTPS / localhost 下有效，file:// 静默失败）
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* 离线/旧浏览器时静默 */ });
    });
  }

  // 2. 已作为 App 启动 → 不再弹引导
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) return;

  // 3. 仅移动端处理
  var ua = navigator.userAgent || '';
  var isIos = /iP(hone|ad|od)/.test(ua);
  var isMobile = /Android|iP(hone|ad|od)|Mobile/.test(ua);
  if (!isMobile) return;

  var dismissed = false;

  function dismiss(el) {
    el.classList.add('hide');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 280);
    dismissed = true;
  }

  function show(html, onClick) {
    if (dismissed) return;
    if (document.getElementById('installBanner')) return;
    var b = document.createElement('div');
    b.id = 'installBanner';
    b.className = 'install-banner';
    b.innerHTML = html + '<button class="install-close" aria-label="关闭" title="关闭">×</button>';
    document.body.appendChild(b);
    b.querySelector('.install-close').onclick = function () { dismiss(b); };
    var btn = b.querySelector('[data-act]');
    if (btn && onClick) btn.onclick = function (e) { e.preventDefault(); onClick(); };
    setTimeout(function () { b.classList.add('show'); }, 200);
  }

  if (isIos) {
    // iOS 无自动 install 事件 → 立即显示操作说明
    show(
      '<div class="install-msg"><b>📱 安装 IT工具箱</b>' +
      '<span>iPhone：点底部分享 <b style="color:var(--pri)">↑</b> → 再选「添加到主屏幕」即可</span></div>'
    );
  } else {
    // Android：所有浏览器都有「添加到主屏幕/安装应用」菜单项 → 立即显示通用说明（不依赖任何事件）
    show(
      '<div class="install-msg"><b>📲 想装到桌面？</b>' +
      '<span>点浏览器右上角菜单 →「添加到主屏幕」或「安装应用」</span></div>'
    );
    // Chrome / Edge 等满足条件时触发原生 beforeinstallprompt → 升级为「一键安装」按钮
    var deferred = null;
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferred = e;
      var old = document.getElementById('installBanner');
      if (old) old.remove();
      show(
        '<div class="install-msg"><b>📲 一键安装 IT工具箱</b>' +
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