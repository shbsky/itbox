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
  /* 原生安装事件是「一次性的」：prompt() 调过之后这个事件对象就废了，
   * 再调一次会抛 InvalidStateError。所以必须自己记账，不能只看 deferred 有没有值。 */
  var used = false;    // 这个事件是否已被消费
  var busy = false;    // 正在等用户在系统弹窗里做选择
  function canPrompt() { return !!deferred && !used && !busy; }

  /* ---------- 横幅 ---------- */
  function mount(html) {
    var old = document.getElementById('installBanner');
    if (old) old.remove();
    var b = document.createElement('div');
    b.id = 'installBanner';
    b.className = 'install-banner';
    b.innerHTML = html;
    document.body.appendChild(b);
    b.querySelector('.install-close').onclick = hideBanner;
    var btn = b.querySelector('.install-btn');
    if (btn) btn.onclick = function (e) { e.preventDefault(); doInstall(btn); };
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

  function hideBanner() {
    var b = document.getElementById('installBanner');
    try { sessionStorage.setItem('pwaDismissed', '1'); } catch (e) { }
    if (!b) return;
    b.classList.add('hide');
    setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 300);
  }

  /* ---------- 调原生安装 ---------- *
   * 这里每一句都是踩过的坑：
   * ① prompt() 会抛错（事件已消费 / 浏览器拒绝），必须 try 起来，否则「点了毫无反应」；
   * ② 调过就立刻标 used，连点两下时第二下必定抛错——这才是最常见的那种「点不出来」；
   * ③ userChoice 可能**永远不 settle**（Chrome 偶发），那样 deferred 会永远挂着，
   *    弹窗就一直显示「✅ 已就绪」骗人，用户怎么点都没用、也永远恢复不了 —— 加 8 秒兜底；
   * ④ 任何失败都不许停在原地：立刻给出「浏览器菜单」这条必然走得通的路径。
   */
  function doInstall(btn) {
    if (busy) return;
    if (!canPrompt()) {
      if (btn) waitOrGuide(btn); else showGuide('wait');
      return;
    }
    var ev = deferred;
    used = true;
    busy = true;
    var finish = function (res) {
      if (!busy) return;
      busy = false; deferred = null; used = false;
      if (res && res.outcome === 'accepted') { hideBanner(); return; }   // 装成功
      /* 走到这里有两种情况，而且从 resolve 的结果**分不出来**：
       *   · 用户自己取消了系统弹窗
       *   · Chrome 判定不该弹窗，直接 resolve 成 dismissed 且什么都没显示
       * 两种都退到菜单路径，用户至少能看到一条路走。 */
      showGuide('native');
    };
    try {
      ev.prompt();
      if (ev.userChoice && ev.userChoice.then) ev.userChoice.then(finish, finish);
      else finish(null);
    } catch (err) {
      busy = false; deferred = null; used = false;
      showGuide('error');
      return;
    }
    setTimeout(function () { if (busy) finish(null); }, 8000);
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
      if (canPrompt()) doInstall(btn);
      else showGuide('wait');
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
    var ev = canPrompt() ? '<b style="color:var(--ok)">✅ 可用</b>'
      : (deferred ? '<b style="color:var(--warn)">⚠ 已失效</b>' : '未触发');
    var name = browserGuide()[0];
    var uas = ua.replace(/\s+/g, ' ').slice(0, 72);
    return '浏览器识别：<b>' + name + '</b><br>安装事件：' + ev + ' · Service Worker：' + sw +
      '<br><span style="opacity:.75">UA：' + uas + '…</span>';
  }
  /**
   * @param mode 'wait'（事件还没来） | 'native'（调过原生但没装成） | 'error'（事件已失效）
   */
  function showGuide(mode) {
    var old = document.getElementById('guideMask');
    if (old) old.remove();
    var g = browserGuide();
    var tip;
    if (canPrompt()) {
      tip = '系统安装现在可用：点下面的绿色按钮即可，<b>不用关弹窗再点一次</b>。';
    } else if (mode === 'native') {
      tip = '刚才那次没装成（你取消了，或 Chrome 判定不再弹窗）。<b>用上面的菜单路径一定能装</b>。';
    } else if (mode === 'error') {
      tip = '系统安装事件已失效，已自动改用菜单路径（这条一定能装）。';
    } else {
      tip = '没等到系统安装事件。<b>用上面的菜单路径，不必等它</b>。';
    }
    var mask = document.createElement('div');
    mask.id = 'guideMask';
    mask.className = 'guide-mask';
    mask.innerHTML =
      '<div class="guide-card">' +
      '<div class="guide-tt">📲 添加到桌面</div>' +
      '<div class="guide-row"><span class="guide-badge">Chrome</span><span>点右上角 <b>⋮</b> → ' +
      '<b>「安装应用」</b>（旧版本叫「添加到主屏幕」）→ 确认。也可以点<b>地址栏右侧的安装图标</b>，一键装。</span></div>' +
      '<div class="guide-row"><span class="guide-badge">' + g[0] + '</span><span>' + g[1] + '</span></div>' +
      '<div class="guide-row"><span class="guide-badge gray">说明</span><span>' + tip + '</span></div>' +
      '<div class="guide-diag">' + diagText() + '</div>' +
      (canPrompt() ? '<button class="btn guide-sys">用系统安装（推荐）</button>' : '') +
      '<button class="btn guide-ok' + (canPrompt() ? ' ghost' : '') + '">知道了</button>' +
      '</div>';
    document.body.appendChild(mask);
    mask.onclick = function (e) { if (e.target === mask) mask.remove(); };
    mask.querySelector('.guide-ok').onclick = function () { mask.remove(); };
    var sys = mask.querySelector('.guide-sys');
    if (sys) sys.onclick = function () { mask.remove(); doInstall(null); };

    /* 弹窗开着期间事件才到 → 现场把「用系统安装」按钮补上并把「知道了」降级，
     * 而不是丢一句「关掉再点一次」让用户自己去猜时机。 */
    if (!guideWatch) {
      guideWatch = window.setInterval(function () {
        var gm = document.getElementById('guideMask');
        if (!gm) { window.clearInterval(guideWatch); guideWatch = null; return; }
        var dg = gm.querySelector('.guide-diag');
        var dgNow = diagText();
        if (dg && dg.innerHTML !== dgNow) dg.innerHTML = dgNow;
        if (canPrompt() && !gm.querySelector('.guide-sys')) {
          var b = document.createElement('button');
          b.className = 'btn guide-sys';
          b.textContent = '用系统安装（推荐）';
          b.onclick = function () { gm.remove(); doInstall(null); };
          gm.querySelector('.guide-card').insertBefore(b, gm.querySelector('.guide-ok'));
          var okb = gm.querySelector('.guide-ok');
          if (okb) okb.classList.add('ghost');
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
    used = false;
    busy = false;
    var b = document.getElementById('installBanner');
    if (b) {
      /* 横幅已经挂着了：只换文案，不重建。
       * 重建会重跑 600ms 入场动画（横幅此刻是位移+透明状态），
       * 用户正好在这一刻点「安装」就会落在还没就位的元素上 —— 也是「点了没反应」。 */
      var m = b.querySelector('.install-msg');
      if (m) m.innerHTML = '<b>安装 IT工具箱 应用</b>' +
        '<span>添加到桌面，像 App 一样全屏打开，断网可用</span>';
      return;
    }
    var dis = false;
    try { dis = sessionStorage.getItem('pwaDismissed') === '1'; } catch (err) { }
    if (dis) return;               // 用户关过横幅 → 本次会话不再骚扰
    banner('添加到桌面，像 App 一样全屏打开，断网可用');
  });

  // 装好了 → 收掉横幅
  window.addEventListener('appinstalled', function () { hideBanner(); });
})();
