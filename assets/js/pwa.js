/* IT工具箱 · PWA 注册 + 安装引导（横幅 + 事件等待 + 诊断指引） */
(function () {
  'use strict';

  // 0. 局域网 http 访问（http://192.168.x.x:3008）时浏览器不认为是「安全上下文」：
  //    Service Worker 注册必然失败、beforeinstallprompt 也不会触发。
  //    这种情况直接静默退出——否则会弹一个点了永远没反应的「安装」横幅，误导同事。
  var secure = false;
  try { secure = window.isSecureContext === true; } catch (e) { }
  if (!secure) return;

  // 1. Service Worker 立即注册（脚本在 body 末尾，DOM 已就绪；越早注册，安装事件来得越早）
  var swState = 'pending'; // pending | ok | fail
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    navigator.serviceWorker.register('./sw.js')
      .then(function () { swState = 'ok'; })
      .catch(function () { swState = 'fail'; });
  } else {
    swState = 'fail';
  }

  // 2. 已作为 App 启动 → 不再弹引导
  var standalone = false;
  try { standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone; } catch (e) { }
  if (standalone) return;

  // 3. 按屏幕宽度判断（不依赖 UA，国产浏览器全兼容）
  if (window.innerWidth >= 900) return;

  // 4. 本次会话中被 ✕ 关过 → 不再骚扰
  try { if (sessionStorage.getItem('pwaDismissed') === '1') return; } catch (e) { }

  var ua = navigator.userAgent || '';
  var uaL = ua.toLowerCase();
  var isIos = /iP(hone|ad|od)/.test(ua);
  // 微信/QQ/微博/抖音等 App 内置 WebView：根本不支持安装到桌面，必须换系统浏览器
  var isWebview = /micromessenger|weibo|alipayclient|taobao|snssdk|aweme|baiduboxapp|bili|hongkong|dq\.app/i.test(ua) || (/qq\/[\d.]+/i.test(ua) && !/mqqbrowser/i.test(ua));
  var deferred = null; // 浏览器原生安装事件

  /* ---------- 横幅 ---------- */
  function mount(html) {
    var old = document.getElementById('installBanner');
    if (old) old.remove();
    var b = document.createElement('div');
    b.id = 'installBanner';
    b.className = 'install-banner';
    b.innerHTML = html;
    document.body.appendChild(b);
    b.querySelector('.install-close').onclick = function () {
      b.classList.add('hide');
      setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 300);
      try { sessionStorage.setItem('pwaDismissed', '1'); } catch (e) { }
    };
    var btn = b.querySelector('.install-btn');
    if (btn) btn.onclick = function (e) {
      e.preventDefault();
      if (deferred) {
        deferred.prompt();
        deferred.userChoice.finally(function () { deferred = null; });
      } else {
        waitOrGuide(btn);
      }
    };
    setTimeout(function () { b.classList.add('show'); }, 600);
  }

  function ico() { return '<div class="install-ico">🧰</div>'; }
  function close() { return '<button class="install-close" aria-label="关闭" title="关闭">×</button>'; }
  function banner(sub) {
    mount(
      ico() +
      '<div class="install-msg"><b>安装 IT工具箱 应用</b>' +
      '<span>' + sub + '</span></div>' +
      '<button class="install-btn" data-act="install">安装</button>' +
      close()
    );
  }

  /* ---------- 点安装但事件未到：等 3 秒，不来再弹诊断指引 ---------- */
  function waitOrGuide(btn) {
    if (btn._waiting) return;
    btn._waiting = true;
    var txt = btn.textContent;
    btn.textContent = '准备中…';
    setTimeout(function () {
      btn._waiting = false;
      btn.textContent = txt;
      if (deferred) {
        deferred.prompt(); // 事件到了 → 直接弹原生安装
        deferred.userChoice.finally(function () { deferred = null; });
      } else {
        showGuide();
      }
    }, 3000);
  }

  /* ---------- 国产浏览器识别 → 专属"发送到桌面"路径 ---------- */
  function browserGuide() {
    if (/qqbrowser/.test(uaL)) return ['QQ浏览器', '点底部 ☰ 菜单 →「添加书签」→ 保存时勾选「发送到桌面」'];
    if (/ucbrowser/.test(uaL)) return ['UC浏览器', '点底部 ☰ 菜单 →「收藏网址」→ 勾选「手机桌面」→ 保存'];
    if (/quark/.test(uaL)) return ['夸克浏览器', '点 ☰ 菜单 →「收藏」→ 到书签页长按该条 →「发送至桌面」'];
    if (/vivo/.test(uaL)) return ['vivo浏览器', '点底部 ☰ 菜单 →「加入书签」→ 勾选「发送至桌面」'];
    if (/heytap/.test(uaL)) return ['OPPO浏览器', '点 ☰ 菜单 →「添加书签」→ 勾选「发送至桌面」'];
    if (/mibrowser|miuibrowser|xiaomi/.test(uaL)) return ['小米浏览器', '点 ☰ 菜单 →「添加到桌面」或「收藏」→ 发送到桌面'];
    if (/huawei|harmony|honor/.test(uaL)) return ['华为/荣耀浏览器', '点 ⋮ 或 ☰ 菜单 →「添加到主屏幕」或「收藏到桌面」'];
    if (/baidu|bidubrowser/.test(uaL)) return ['百度浏览器', '点 ☰ 菜单 →「收藏」→ 勾选「保存到桌面」'];
    if (/sogou/.test(uaL)) return ['搜狗浏览器', '点 ☰ 菜单 →「收藏」→ 勾选「桌面快捷方式」'];
    if (/360|qihoo/.test(uaL)) return ['360浏览器', '点 ☰ 菜单 →「收藏/添加快捷方式」→ 发送到桌面'];
    return ['当前浏览器', '在菜单里找「添加到主屏幕 / 添加快捷方式 / 收藏到桌面」类似选项'];
  }

  /* ---------- 诊断指引弹窗 ---------- */
  function diagText() {
    var sw = swState === 'ok' ? '✅ 已激活' : (swState === 'fail' ? '❌ 失败' : '⏳ 激活中');
    var ev = deferred ? '<b style="color:var(--ok)">✅ 已就绪</b>' : '<b style="color:var(--warn)">未触发</b>';
    var name = browserGuide()[0];
    var uas = ua.replace(/\s+/g, ' ').slice(0, 72);
    return '浏览器识别：<b>' + name + '</b><br>安装事件：' + ev + ' · Service Worker：' + sw + '<br><span style="opacity:.75">UA：' + uas + '…</span>';
  }
  function showGuide() {
    var old = document.getElementById('guideMask');
    if (old) old.remove();
    var g = browserGuide();
    var mask = document.createElement('div');
    mask.id = 'guideMask';
    mask.className = 'guide-mask';
    mask.innerHTML =
      '<div class="guide-card">' +
      '<div class="guide-tt">📲 添加到桌面</div>' +
      '<div class="guide-row"><span class="guide-badge">Chrome</span><span>点右上角 <b>⋮</b> → <b>「添加到主屏幕」</b>或「安装应用」→ 弹窗里确认。本站已通过 Chrome 全部安装性检查，此路径必然存在。</span></div>' +
      '<div class="guide-row"><span class="guide-badge">' + g[0] + '</span><span>' + g[1] + '</span></div>' +
      '<div class="guide-row"><span class="guide-badge gray">事件</span><span>底部「安装」按钮走的是系统事件，<b>新网站首次访问 Chrome 会故意延迟触发</b>（站点熟悉度机制）。多访问一两次、停留滑动几十秒后就会放行——之后点「安装」即可一键装。</span></div>' +
      '<div class="guide-diag">' + diagText() + '</div>' +
      '<button class="btn guide-ok">知道了</button>' +
      '</div>';
    document.body.appendChild(mask);
    mask.onclick = function (e) { if (e.target === mask) mask.remove(); };
    mask.querySelector('.guide-ok').onclick = function () { mask.remove(); };
    // 弹窗开着期间事件来了 → 实时更新提示
    if (!guideWatch) {
      guideWatch = window.setInterval(function () {
        var gm = document.getElementById('guideMask');
        if (!gm) { window.clearInterval(guideWatch); guideWatch = null; return; }
        if (deferred) {
          gm.querySelector('.guide-diag').innerHTML =
            '安装事件：<b style="color:var(--ok)">✅ 已就绪</b> · 关闭此弹窗，<b>再点一次「安装」即可</b>';
          window.clearInterval(guideWatch); guideWatch = null;
        }
      }, 500);
    }
  }
  var guideWatch = null;

  /* ---------- iOS：引导分享菜单 ---------- */
  if (isIos) {
    mount(
      ico() +
      '<div class="install-msg"><b>安装 IT工具箱 应用</b>' +
      '<span>点底部分享 <b style="color:var(--pri)">↑</b> → 「添加到主屏幕」</span></div>' +
      close()
    );
    return;
  }

  /* ---------- Android / 其他移动端 ---------- */
  if (isWebview) {
    // 微信/QQ 等内置浏览器：装不了，直接引导换浏览器
    mount(
      ico() +
      '<div class="install-msg"><b>当前在微信/QQ内置浏览器中</b>' +
      '<span>内置浏览器无法安装到桌面。点右上角 <b>⋯</b> →「在浏览器打开」或复制链接，用 <b>Chrome / 系统浏览器</b>打开后再安装</span></div>' +
      close()
    );
    return;
  }
  banner('获得更好的离线体验和性能');

  // Chrome / Edge 等触发原生安装事件 → 升级横幅
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    banner('添加到桌面，像 App 一样全屏打开，断网可用');
  });
})();
