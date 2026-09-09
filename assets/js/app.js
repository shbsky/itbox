/* ===== IT工具箱 · 主框架 ===== */
(function () {
  'use strict';
  var LB = window.LB, U = LB.util;
  var tools = LB.tools, cats = LB.cats;
  var favs = U.store.get('favs', []);
  var recent = U.store.get('recent', []);
  var state = { cat: 'all', kw: '', cur: null };

  /* ---------- 主题 ---------- */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    document.getElementById('themeIco').textContent = t === 'dark' ? '☀️' : '🌙';
    document.getElementById('themeTxt').textContent = t === 'dark' ? '浅色模式' : '深色模式';
    U.store.set('theme', t);
  }
  applyTheme(U.store.get('theme', 'light'));
  document.getElementById('themeBtn').onclick = function () {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  };

  /* ---------- 侧边栏 ---------- */
  function renderNav() {
    var nav = document.getElementById('nav');
    var items = [{ id: 'all', name: '全部工具', icon: '🧰' },
    { id: 'fav', name: '我的收藏', icon: '⭐' },
    { id: 'recent', name: '最近使用', icon: '🕘' }];
    var html = '<div class="nav-group"><div class="nav-group-t">视图</div>' +
      items.map(function (i) {
        return '<button class="nav-item' + (state.cat === i.id ? ' active' : '') + '" data-cat="' + i.id + '">' +
          '<span class="ic">' + i.icon + '</span><span>' + i.name + '</span>' +
          (i.id === 'fav' ? '<span class="cnt">' + favs.length + '</span>' : '') + '</button>';
      }).join('') + '</div>';
    html += '<div class="nav-group"><div class="nav-group-t">分类</div>' +
      cats.map(function (c) {
        var n = tools.filter(function (t) { return t.cat === c.id; }).length;
        return '<button class="nav-item' + (state.cat === c.id ? ' active' : '') + '" data-cat="' + c.id + '">' +
          '<span class="ic">' + c.icon + '</span><span>' + c.name + '</span><span class="cnt">' + n + '</span></button>';
      }).join('') + '</div>';
    nav.innerHTML = html;
    U.$$('#nav .nav-item').forEach(function (b) {
      b.onclick = function () {
        state.cat = b.dataset.cat;
        renderNav(); renderGrid();
        document.getElementById('sidebar').classList.remove('open');
      };
    });
  }

  /* ---------- 网格 ---------- */
  function match(t) {
    if (state.kw) {
      var k = state.kw.toLowerCase();
      var hay = (t.name + ' ' + t.desc + ' ' + (t.kw || '') + ' ' + t.id + ' ' + catName(t.cat)).toLowerCase();
      return hay.indexOf(k) >= 0;
    }
    if (state.cat === 'all') return true;
    if (state.cat === 'fav') return favs.indexOf(t.id) >= 0;
    if (state.cat === 'recent') return recent.indexOf(t.id) >= 0;
    return t.cat === state.cat;
  }
  function catName(id) {
    var c = cats.filter(function (x) { return x.id === id; })[0];
    return c ? c.name : '';
  }
  function card(t) {
    return '<div class="tcard" data-id="' + t.id + '">' +
      '<button class="tcard-fav' + (favs.indexOf(t.id) >= 0 ? ' on' : '') + '" data-fav="' + t.id + '">' +
      (favs.indexOf(t.id) >= 0 ? '★' : '☆') + '</button>' +
      '<span class="tcard-ico">' + t.icon + '</span>' +
      '<div class="tcard-name">' + U.esc(t.name) + '</div>' +
      '<div class="tcard-desc">' + U.esc(t.desc) + '</div></div>';
  }
  function renderGrid() {
    var grid = document.getElementById('grid');
    var list = tools.filter(match);
    var html = '';
    if (state.kw || state.cat === 'all') {
      cats.forEach(function (c) {
        var sub = list.filter(function (t) { return t.cat === c.id; });
        if (!sub.length) return;
        html += '<div class="cat-head">' + c.icon + ' ' + c.name + '（' + sub.length + '）</div>' + sub.map(card).join('');
      });
    } else if (state.cat === 'recent') {
      html = recent.map(function (id) { return tools.filter(function (t) { return t.id === id; })[0]; })
        .filter(Boolean).map(card).join('') || '<div class="empty"><div class="empty-ico">🕘</div><p>还没有使用记录</p></div>';
    } else if (state.cat === 'fav') {
      html = favs.map(function (id) { return tools.filter(function (t) { return t.id === id; })[0]; })
        .filter(Boolean).map(card).join('') || '<div class="empty"><div class="empty-ico">⭐</div><p>还没有收藏，点卡片右上角的小星星试试</p></div>';
    } else {
      html = list.map(card).join('');
    }
    grid.innerHTML = html;
    document.getElementById('empty').hidden = list.length > 0 || state.cat === 'fav' || state.cat === 'recent';

    var c2 = cats.filter(function (x) { return x.id === state.cat; })[0];
    var titles = {
      all: ['全部工具', '共 ' + tools.length + ' 个工具，运维日常一站式解决'],
      fav: ['我的收藏', '把高频工具标星，下次一点就到'],
      recent: ['最近使用', '按你最近打开的顺序排列']
    };
    var ti = titles[state.cat] || [c2 ? c2.name : '工具', c2 ? c2.desc : ''];
    document.getElementById('pageTitle').textContent = ti[0];
    document.getElementById('pageDesc').textContent = ti[1];

    U.$$('#grid .tcard').forEach(function (el) {
      el.onclick = function (e) {
        if (e.target.dataset && e.target.dataset.fav) return;
        openTool(el.dataset.id);
      };
    });
    U.$$('#grid .tcard-fav').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        toggleFav(b.dataset.fav);
        renderGrid(); renderNav();
        if (state.cur && state.cur.id === b.dataset.fav) syncFavBtn();
      };
    });
  }
  function toggleFav(id) {
    var i = favs.indexOf(id);
    if (i >= 0) { favs.splice(i, 1); U.toast('已取消收藏'); }
    else { favs.push(id); U.toast('已收藏，可在「我的收藏」查看', 'ok'); }
    U.store.set('favs', favs);
    document.getElementById('statFav').textContent = favs.length;
  }

  /* ---------- 面板 ---------- */
  var panel = document.getElementById('panel');
  var mask = document.getElementById('panelMask');
  var bodyEl = document.getElementById('panelBody');

  function openTool(id) {
    var t = tools.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    state.cur = t;
    document.getElementById('panelIcon').textContent = t.icon;
    document.getElementById('panelName').textContent = t.name;
    document.getElementById('panelDesc').textContent = t.desc;
    bodyEl.innerHTML = typeof t.tpl === 'function' ? t.tpl() : (t.tpl || '');
    panel.hidden = false; mask.hidden = false;
    document.body.style.overflow = 'hidden';
    try {
      if (t.init) t.init(bodyEl);
    } catch (e) {
      bodyEl.innerHTML = '<div class="alert err">工具初始化出错：' + U.esc(e.message) + '</div>';
    }
    syncFavBtn();
    // 记录最近使用
    var i = recent.indexOf(id);
    if (i >= 0) recent.splice(i, 1);
    recent.unshift(id);
    recent = recent.slice(0, 12);
    U.store.set('recent', recent);
    location.hash = id;
    bodyEl.scrollTop = 0;
  }
  function closeTool() {
    if (bodyEl._cleanup) { try { bodyEl._cleanup(); } catch (e) { } }
    panel.hidden = true; mask.hidden = true;
    document.body.style.overflow = '';
    state.cur = null;
    // file:// 下部分浏览器禁止 replaceState/修改 search，失败时退回到清空 hash
    try { history.replaceState(null, '', location.pathname + location.search); }
    catch (e) { try { location.hash = ''; } catch (e2) { /* 忽略 */ } }
  }
  function syncFavBtn() {
    var b = document.getElementById('panelFav');
    if (!state.cur) return;
    var on = favs.indexOf(state.cur.id) >= 0;
    b.textContent = on ? '★' : '☆';
    b.classList.toggle('on', on);
  }
  document.getElementById('panelClose').onclick = closeTool;
  mask.onclick = closeTool;
  document.getElementById('panelFav').onclick = function () {
    if (!state.cur) return;
    toggleFav(state.cur.id); syncFavBtn(); renderNav(); renderGrid();
  };

  /* ---------- 搜索 ---------- */
  var si = document.getElementById('search');
  si.oninput = function () {
    state.kw = this.value.trim();
    document.getElementById('searchClear').classList.toggle('show', !!this.value);
    renderGrid();
  };
  document.getElementById('searchClear').onclick = function () {
    si.value = ''; state.kw = ''; this.classList.remove('show'); renderGrid(); si.focus();
  };

  /* ---------- 复制委托 ---------- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-copy],[data-copytext],[data-copyraw]') : null;
    if (!el) return;
    if (el.hasAttribute('data-copyraw')) { U.copy(el.getAttribute('data-copyraw')); return; }
    var sel = el.getAttribute('data-copy') || el.getAttribute('data-copytext');
    var target = document.querySelector(sel);
    if (!target) return;
    U.copy(el.hasAttribute('data-copytext') ? target.innerText : (target.textContent || target.innerText));
  });

  /* ---------- 快捷键 ---------- */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if (!panel.hidden) closeTool(); return; }
    if (e.key === '/' && document.activeElement !== si && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      e.preventDefault(); si.focus();
    }
  });

  /* ---------- 移动端菜单 ---------- */
  document.getElementById('menuBtn').onclick = function () {
    document.getElementById('sidebar').classList.toggle('open');
  };

  /* ---------- 启动 ---------- */
  document.getElementById('statTotal').textContent = tools.length;
  document.getElementById('statFav').textContent = favs.length;
  renderNav(); renderGrid();
  if (location.hash) {
    var id = location.hash.slice(1);
    if (tools.some(function (t) { return t.id === id; })) openTool(id);
  }
})();
