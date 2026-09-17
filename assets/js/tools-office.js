/* ===== 办公工具 ===== */
(function () {
  'use strict';
  var LB = window.LB, U = LB.util;

  var MAX_MB = 30;                                  // 单张体积上限
  var EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

  /* ---------------- 小工具 ---------------- */
  function fmtSize(n) {
    if (n == null || isNaN(n)) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function baseName(name) {
    var n = String(name || 'image'), d = n.lastIndexOf('.');
    return d > 0 ? n.slice(0, d) : n;
  }
  function autoMime(t) {
    t = String(t || '').toLowerCase();
    if (t.indexOf('png') >= 0) return 'image/png';
    if (t.indexOf('webp') >= 0) return 'image/webp';
    return 'image/jpeg';
  }
  var _webp = null;
  function supportWebP() {
    if (_webp !== null) return _webp;
    try {
      var c = document.createElement('canvas');
      c.width = c.height = 1;
      _webp = c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
    } catch (e) { _webp = false; }
    return _webp;
  }
  function stampName(prefix, ext) {
    var d = new Date(), p = U.pad;
    return prefix + '_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '_' + p(d.getHours()) + p(d.getMinutes()) + '.' + ext;
  }

  /* ---------------- 解码 / 绘制 / 编码 ---------------- */
  function loadImage(file) {
    if (window.createImageBitmap) {
      try {
        // 优先按 EXIF 方向解码，避免手机竖拍照片被转成横的
        return createImageBitmap(file, { imageOrientation: 'from-image' })
          .catch(function () { return createImageBitmap(file); });
      } catch (e) { /* 落到 <img> 分支 */ }
    }
    return new Promise(function (res, rej) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () { res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('图片解码失败，文件可能已损坏')); };
      img.src = url;
    });
  }
  function encode(cv, mime, q) {
    return new Promise(function (res, rej) {
      try {
        cv.toBlob(function (b) {
          b ? res(b) : rej(new Error('无法输出 ' + mime + '，当前浏览器不支持该格式'));
        }, mime, q);
      } catch (e) { rej(new Error('编码失败：' + e.message)); }
    });
  }
  /** 按设置算出目标尺寸 */
  function calcSize(w, h, o) {
    var s = 1;
    if (o.size === 'pct') s = Math.max(1, Math.min(100, o.pct)) / 100;
    else if (o.size === 'custom') {
      if (o.maxW && w > o.maxW) s = Math.min(s, o.maxW / w);
      if (o.maxH && h > o.maxH) s = Math.min(s, o.maxH / h);
    } else if (o.size !== 'orig') {
      var m = Math.max(w, h);
      if (m > o.size) s = o.size / m;
    }
    if (o.noUp && s > 1) s = 1;
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), scale: s };
  }
  /** 二分逼近目标体积（有损格式才有意义） */
  function encodeToTarget(cv, mime, target, tol) {
    var lo = 0.05, hi = 0.95, best = null, tries = 0;
    function step() {
      if (tries >= 8) return Promise.resolve(best);
      var q = (lo + hi) / 2;
      tries++;
      return encode(cv, mime, q).then(function (b) {
        if (!best || Math.abs(b.size - target) < Math.abs(best.blob.size - target)) best = { blob: b, q: q };
        if (b.size <= target * (1 + tol) && b.size >= target * (1 - tol)) return best;
        if (b.size > target) hi = q; else lo = q;
        return step();
      });
    }
    return step();
  }

  var P = {};   // 处理管线（对外只暴露 processOne）

  P.processOne = function (item, o) {
    var src = item.file, srcW = 0, srcH = 0, bmp = null;
    return loadImage(src).then(function (b) {
      bmp = b;
      srcW = b.width; srcH = b.height;
      var sz = calcSize(srcW, srcH, o);
      var mime = o.fmt === 'auto' ? autoMime(src.type) : o.fmt;
      var cv = document.createElement('canvas');
      cv.width = sz.w; cv.height = sz.h;
      var ctx = cv.getContext('2d');
      if (mime === 'image/jpeg') {           // JPEG 无 alpha，透明区必须填底色，否则会变黑
        ctx.fillStyle = o.bg || '#ffffff';
        ctx.fillRect(0, 0, sz.w, sz.h);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, sz.w, sz.h);
      if (bmp.close) { try { bmp.close(); } catch (e) { } }

      var chain;
      if (o.mode === 'target' && (mime === 'image/jpeg' || mime === 'image/webp')) {
        chain = encodeToTarget(cv, mime, o.targetBytes, o.tol).then(function (r) {
          var note = '';
          if (!r) throw new Error('编码失败');
          if (r.blob.size > o.targetBytes * (1 + o.tol)) note = '已达最低质量仍超目标，可再调小尺寸';
          return { blob: r.blob, note: note, quality: r.q };
        });
      } else {
        var note2 = (o.mode === 'target' && mime === 'image/png')
          ? 'PNG 为无损格式，按体积压缩无效，已按最高质量输出' : '';
        chain = encode(cv, mime, o.quality).then(function (b) {
          return { blob: b, note: note2, quality: o.quality };
        });
      }
      return chain.then(function (r) {
        r.srcW = srcW; r.srcH = srcH; r.w = sz.w; r.h = sz.h;
        r.srcSize = src.size; r.mime = mime; r.scaled = sz.scale !== 1;
        return r;
      });
    });
  };

  /* ================= 工具注册 ================= */
  LB.register({
    id: 'imgcomp', cat: 'office', icon: '🖼️', name: '图片压缩 / 格式转换',
    desc: '批量压缩、尺寸规格、JPEG/PNG/WebP 互转，全程本地不上传',
    kw: '图片 压缩 批量 转换 格式 jpg jpeg png webp 质量 尺寸 缩放 缩小 体积 图片压缩 压缩图片 图片转换 批量压缩 瘦身 网页图片',

    tpl: function () {
      var webpTip = supportWebP() ? '' : '（当前浏览器不支持 WebP 输出）';
      return '' +
        /* ---- 1 添加 ---- */
        '<div class="t-section"><div class="sec-t">1 · 添加图片</div>' +
        '<div class="drop-zone" id="icDrop">' +
        '<div class="drop-ico">🖼️</div>' +
        '<div class="drop-t">拖拽图片到此处</div>' +
        '<div class="drop-s">支持 JPG / PNG / WebP / GIF / BMP · 单张 ≤ ' + MAX_MB + ' MB · 可一次拖入多张</div>' +
        '<button class="btn btn-pri" id="icPick">选择图片</button>' +
        '<div class="drop-s mt8">也可以直接按 <b>Ctrl + V</b> 粘贴剪贴板里的截图</div>' +
        '</div>' +
        '<input type="file" id="icFile" accept="image/*" multiple hidden>' +
        '</div>' +

        /* ---- 2 设置 ---- */
        '<div class="t-section"><div class="sec-t">2 · 压缩设置</div>' +
        '<div class="tabs" id="icMode">' +
        '<button class="tab on" data-m="quality">按质量压缩</button>' +
        '<button class="tab" data-m="target">按目标体积</button>' +
        '</div>' +

        '<div id="icQt">' +
        '<div class="field"><label class="field-l">压缩质量 <b class="qval" id="icQv">80%</b></label>' +
        '<input type="range" class="range" id="icQuality" min="10" max="100" step="1" value="80">' +
        '<div class="hint">数值越低体积越小、画质损失越明显。80% 通常肉眼无差别，60% 适合发微信/贴文档</div></div>' +
        '</div>' +

        '<div id="icTg" hidden>' +
        '<div class="row tight">' +
        '<div class="field"><label class="field-l">目标体积（KB）</label>' +
        '<input type="number" id="icTarget" value="200" min="5" step="10"></div>' +
        '<div class="field"><label class="field-l">允许误差</label>' +
        '<select id="icTol"><option value="0.1">±10%</option><option value="0.2">±20%</option>' +
        '<option value="0.35">±35%</option></select></div>' +
        '</div>' +
        '<div class="hint">自动二分试算质量（最多 8 次）逼近目标体积，仅对 JPEG / WebP 有效；PNG 无效</div>' +
        '</div>' +

        '<div class="row tight">' +
        '<div class="field"><label class="field-l">尺寸规格</label>' +
        '<select id="icSize">' +
        '<option value="orig">保持原始尺寸</option>' +
        '<option value="3840">长边 ≤ 3840 px（4K）</option>' +
        '<option value="1920" selected>长边 ≤ 1920 px（1080P · 推荐）</option>' +
        '<option value="1280">长边 ≤ 1280 px（720P）</option>' +
        '<option value="1080">长边 ≤ 1080 px（文档插图）</option>' +
        '<option value="800">长边 ≤ 800 px（微信 / 邮件）</option>' +
        '<option value="pct">按百分比缩放</option>' +
        '<option value="custom">自定义最大宽 × 高</option>' +
        '</select></div>' +
        '<div class="field" id="icPctW" hidden><label class="field-l">缩放比例（%）</label>' +
        '<input type="number" id="icPct" value="50" min="1" max="100"></div>' +
        '<div class="field" id="icWW" hidden><label class="field-l">最大宽（px）</label>' +
        '<input type="number" id="icW" min="1" placeholder="留空不限"></div>' +
        '<div class="field" id="icHW" hidden><label class="field-l">最大高（px）</label>' +
        '<input type="number" id="icH" min="1" placeholder="留空不限"></div>' +
        '</div>' +

        '<div class="row tight">' +
        '<div class="field"><label class="field-l">输出格式</label>' +
        '<select id="icFmt">' +
        '<option value="auto">保持原格式</option>' +
        '<option value="image/jpeg">JPEG（有损，体积最小）</option>' +
        '<option value="image/webp">WebP（有损，同画质更小）' + webpTip + '</option>' +
        '<option value="image/png">PNG（无损，体积大）</option>' +
        '</select></div>' +
        '<div class="field" id="icBgW" hidden><label class="field-l">透明区填充色</label>' +
        '<input type="color" id="icBg" value="#ffffff"></div>' +
        '</div>' +

        '<div class="chk-grid mt8">' +
        '<label class="chk"><input type="checkbox" id="icNoUp" checked>不放大小图</label>' +
        '<label class="chk"><input type="checkbox" id="icSuffix" checked>文件名加 _min 后缀</label>' +
        '</div>' +
        '<div class="hint">图片已本地重绘，EXIF（拍摄设备、时间、GPS）不会保留 —— 发到网上更安全。' +
        'GIF 动图只会取第一帧。</div>' +
        '</div>' +

        /* ---- 3 列表与结果 ---- */
        '<div class="t-section" id="icPanel" hidden><div class="sec-t">3 · 处理与下载</div>' +
        '<div class="btn-group" style="margin-top:0">' +
        '<button class="btn btn-pri" id="icRun">开始压缩</button>' +
        '<button class="btn" id="icZip" disabled>打包下载 ZIP</button>' +
        '<button class="btn" id="icClear">清空列表</button>' +
        '</div>' +
        '<div class="prog" id="icProgW" hidden><div class="prog-bar" id="icProg"></div></div>' +
        '<div class="small mt8" id="icStatus"></div>' +
        '<div class="stat-grid mt12" id="icStatW" hidden>' +
        '<div class="stat"><span>原始大小</span><b id="icS1">-</b></div>' +
        '<div class="stat"><span>处理后大小</span><b id="icS2" class="hl">-</b></div>' +
        '<div class="stat"><span>节省空间</span><b id="icS3" class="ok">-</b></div>' +
        '<div class="stat"><span>压缩率</span><b id="icS4" class="ok">-</b></div>' +
        '</div>' +
        '<div class="img-list mt12" id="icList"></div>' +
        '</div>';
    },

    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var items = [], seq = 0, running = false, cancel = false;

      /* ---------- 设置读取 ---------- */
      function readOpt() {
        var mode = ($('#icMode .tab.on') || {}).dataset ? $('#icMode .tab.on').dataset.m : 'quality';
        var size = $('#icSize').value;
        return {
          mode: mode,
          quality: (Number($('#icQuality').value) || 80) / 100,
          targetBytes: Math.max(5, Number($('#icTarget').value) || 200) * 1024,
          tol: Number($('#icTol').value) || 0.1,
          size: size === 'pct' || size === 'orig' || size === 'custom' ? size : Number(size),
          pct: Number($('#icPct').value) || 50,
          maxW: size === 'custom' ? (Number($('#icW').value) || null) : null,
          maxH: size === 'custom' ? (Number($('#icH').value) || null) : null,
          fmt: $('#icFmt').value,
          bg: $('#icBg').value || '#ffffff',
          noUp: $('#icNoUp').checked
        };
      }

      /* ---------- 添加文件 ---------- */
      function addFiles(list) {
        var ok = 0, skip = [], gif = 0;
        for (var i = 0; i < list.length; i++) {
          var f = list[i];
          if (!f || !/^image\//i.test(f.type || '')) { skip.push((f && f.name) || '未知文件'); continue; }
          if (f.size > MAX_MB * 1048576) { skip.push(f.name + '（超过 ' + MAX_MB + 'MB）'); continue; }
          if (/gif/i.test(f.type)) gif++;
          items.push({ uid: ++seq, file: f, url: URL.createObjectURL(f), res: null, err: null });
          ok++;
        }
        if (!ok) {
          U.toast(skip.length ? '没有可用的图片（' + skip[0] + '）' : '没有识别到图片文件', 'err');
          return;
        }
        $('#icPanel').hidden = false;
        render();
        var msg = '已添加 ' + ok + ' 张';
        if (skip.length) msg += '，跳过 ' + skip.length + ' 个（' + skip[0] + '）';
        U.toast(msg, 'ok');
        if (gif) $('#icStatus').textContent = '提示：GIF 动图只会输出第一帧';
        // 主打的「拖入即压缩」：添加后立刻按当前设置处理一遍，改设置再点「开始压缩」重跑
        setTimeout(function () { if (!running) run(); }, 60);
      }

      /* ---------- 渲染 ---------- */
      function rowHtml(it) {
        var r = it.res, line;
        if (it.err) {
          line = '<span class="bad">✕ ' + U.esc(it.err) + '</span>';
        } else if (r) {
          var pct = r.srcSize ? (1 - r.blob.size / r.srcSize) : 0;
          var dim = r.srcW + '×' + r.srcH + ' → ' + r.w + '×' + r.h;
          line = dim + ' · <span class="' + (pct >= 0 ? 'save' : 'bad') + '">' +
            (pct >= 0 ? '↓' : '↑') + Math.abs(pct * 100).toFixed(1) + '%</span>' +
            ' · q' + Math.round(r.quality * 100) +
            (r.note ? ' · ' + U.esc(r.note) : '');
        } else {
          line = '待处理 · ' + ((it.file.type || '').replace('image/', '').toUpperCase() || 'IMG');
        }
        return '<div class="img-row" data-uid="' + it.uid + '">' +
          '<img class="img-thumb" src="' + it.url + '" alt="">' +
          '<div class="img-meta"><div class="img-name" title="' + U.esc(it.file.name) + '">' +
          U.esc(it.file.name) + '</div><div class="img-sub">' + line + '</div></div>' +
          '<div class="img-size">' + fmtSize(it.file.size) + '</div>' +
          '<div class="img-size out">' + (r ? fmtSize(r.blob.size) : '—') + '</div>' +
          '<div class="img-ops">' +
          (r ? '<button class="btn btn-sm" data-dl="' + it.uid + '">下载</button>' : '') +
          (running ? '' : '<button class="btn btn-sm" data-rm="' + it.uid + '" title="移除">✕</button>') +
          '</div></div>';
      }
      function bindRows() {
        U.$$('#icList [data-rm]', root).forEach(function (b) {
          b.onclick = function () {
            var uid = Number(b.dataset.rm), i;
            for (i = 0; i < items.length; i++) if (items[i].uid === uid) break;
            if (i >= items.length) return;
            URL.revokeObjectURL(items[i].url);
            items.splice(i, 1);
            render();
          };
        });
        U.$$('#icList [data-dl]', root).forEach(function (b) {
          b.onclick = function () {
            var it = byUid(Number(b.dataset.dl));
            if (it && it.res) U.saveBlob(outName(it), it.res.blob);
          };
        });
      }
      /** 只替换单行 —— 批量处理时不重绘整张列表，避免缩图闪烁 */
      function updateRow(it) {
        var el = root.querySelector('#icList .img-row[data-uid="' + it.uid + '"]');
        if (!el) { render(); return; }
        el.outerHTML = rowHtml(it);
        bindRows();
        renderStat();
      }
      function render() {
        $('#icList').innerHTML = items.map(rowHtml).join('');
        bindRows();
        $('#icRun').disabled = !items.length;          // 处理中保持可点（点了就是「停止」）
        $('#icZip').disabled = running || !items.some(function (x) { return x.res; });
        $('#icClear').disabled = running || !items.length;
        if (!items.length) { $('#icPanel').hidden = true; $('#icStatW').hidden = true; }
      }
      function byUid(uid) {
        for (var i = 0; i < items.length; i++) if (items[i].uid === uid) return items[i];
        return null;
      }
      function outName(it) {
        return baseName(it.file.name) + ($('#icSuffix').checked ? '_min' : '') + '.' + (EXT[it.res.mime] || 'jpg');
      }

      /* ---------- 统计 ---------- */
      function renderStat() {
        var done = items.filter(function (x) { return x.res; });
        if (!done.length) { $('#icStatW').hidden = true; return; }
        var s0 = 0, s1 = 0;
        done.forEach(function (x) { s0 += x.res.srcSize; s1 += x.res.blob.size; });
        var save = s0 - s1, rate = s0 ? save / s0 : 0;
        $('#icS1').textContent = fmtSize(s0);
        $('#icS2').textContent = fmtSize(s1);
        $('#icS3').textContent = fmtSize(Math.abs(save));
        $('#icS3').className = save >= 0 ? 'ok' : 'err';
        $('#icS4').textContent = (save >= 0 ? '↓ ' : '↑ ') + Math.abs(rate * 100).toFixed(1) + '%';
        $('#icS4').className = save >= 0 ? 'ok' : 'err';
        $('#icStatW').hidden = false;
      }

      /* ---------- 执行 ---------- */
      function setProg(p) {
        $('#icProgW').hidden = false;
        $('#icProg').style.width = Math.round(p * 100) + '%';
      }
      function run() {
        if (!items.length) return;
        var o = readOpt();
        if (o.fmt === 'image/webp' && !supportWebP()) { U.toast('当前浏览器不支持 WebP 输出', 'err'); return; }
        if (o.mode === 'target' && o.fmt === 'image/png') U.toast('PNG 无损，目标体积模式对它无效', 'err');

        running = true; cancel = false;
        var btn = $('#icRun');
        btn.textContent = '停止处理';
        render(); setProg(0);
        var total = items.length, i = 0, failed = 0;

        function next() {
          if (cancel || i >= total) return finish();
          var it = items[i];
          it.err = null; it.res = null;
          $('#icStatus').textContent = '处理中… ' + (i + 1) + ' / ' + total + '（' + it.file.name + '）';
          return P.processOne(it, o).then(function (r) {
            it.res = r;
          }).catch(function (e) {
            it.err = (e && e.message) || '处理失败'; failed++;
          }).then(function () {
            i++;
            setProg(i / total);
            updateRow(it);
            // 让出主线程，批量处理时界面不假死
            return new Promise(function (r) { setTimeout(r, 0); }).then(next);
          });
        }
        function finish() {
          running = false;
          btn.textContent = '开始压缩';
          var okN = items.filter(function (x) { return x.res; }).length;
          var sel = $('#icFmt').selectedOptions && $('#icFmt').selectedOptions[0];
          var fmtTxt = sel ? sel.textContent.replace(/（.*/, '') : '原格式';
          $('#icStatus').textContent = cancel
            ? '已停止：成功 ' + okN + ' 张' + (failed ? '，失败 ' + failed + ' 张' : '')
            : '完成：成功 ' + okN + ' 张' + (failed ? '，失败 ' + failed + ' 张' : '') +
            '，输出 ' + fmtTxt;
          render(); renderStat();
          if (!cancel) U.toast(okN ? '压缩完成，共 ' + okN + ' 张' : '没有成功处理的图片', okN ? 'ok' : 'err');
        }
        next();
      }

      /* ---------- 打包下载 ---------- */
      function zipAll() {
        var done = items.filter(function (x) { return x.res; });
        if (!done.length) { U.toast('还没有处理结果', 'err'); return; }
        var used = {}, entries = [];
        var n = done.length;
        function step(i) {
          if (i >= n) return Promise.resolve();
          var it = done[i], name = outName(it);
          if (used[name]) {
            var k = used[name]++;
            var d = name.lastIndexOf('.');
            name = name.slice(0, d) + '(' + k + ')' + name.slice(d);
          } else used[name] = 1;
          return it.res.blob.arrayBuffer().then(function (buf) {
            entries.push({ name: name, data: new Uint8Array(buf) });
            $('#icStatus').textContent = '打包中… ' + (i + 1) + ' / ' + n;
            return step(i + 1);
          });
        }
        step(0).then(function () {
          var blob = U.zipStore(entries);
          U.saveBlob(stampName('images', 'zip'), blob);
          $('#icStatus').textContent = '已打包 ' + entries.length + ' 张，合计 ' + fmtSize(blob.size);
        }).catch(function (e) { U.toast('打包失败：' + e.message, 'err'); });
      }

      /* ---------- 交互绑定 ---------- */
      var drop = $('#icDrop'), fi = $('#icFile');
      $('#icPick').onclick = function (e) { e.stopPropagation(); fi.click(); };
      drop.onclick = function () { fi.click(); };
      fi.onchange = function () { addFiles(Array.prototype.slice.call(fi.files)); fi.value = ''; };

      ['dragenter', 'dragover'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); });
      });
      ['dragleave', 'dragend'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
      });
      drop.addEventListener('drop', function (e) {
        e.preventDefault(); e.stopPropagation();
        drop.classList.remove('over');
        var dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length) addFiles(Array.prototype.slice.call(dt.files));
      });
      // 面板内任意位置拖放也能接住
      root.addEventListener('dragover', function (e) { e.preventDefault(); });
      root.addEventListener('drop', function (e) {
        if (e.target === drop || drop.contains(e.target)) return;
        e.preventDefault();
        var dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length) addFiles(Array.prototype.slice.call(dt.files));
      });
      // Ctrl+V 粘贴截图
      function onPaste(e) {
        var its = (e.clipboardData || {}).items || [], list = [];
        for (var i = 0; i < its.length; i++) {
          if (its[i].kind === 'file') { var f = its[i].getAsFile(); if (f) list.push(f); }
        }
        if (list.length) { e.preventDefault(); addFiles(list); }
      }
      document.addEventListener('paste', onPaste);

      U.$$('#icMode .tab', root).forEach(function (t) {
        t.onclick = function () {
          U.$$('#icMode .tab', root).forEach(function (x) { x.classList.remove('on'); });
          t.classList.add('on');
          var m = t.dataset.m;
          $('#icQt').hidden = m !== 'quality';
          $('#icTg').hidden = m !== 'target';
        };
      });
      $('#icQuality').oninput = function () { $('#icQv').textContent = this.value + '%'; };
      $('#icSize').onchange = function () {
        var v = this.value;
        $('#icPctW').hidden = v !== 'pct';
        $('#icWW').hidden = v !== 'custom';
        $('#icHW').hidden = v !== 'custom';
      };
      $('#icFmt').onchange = function () { $('#icBgW').hidden = this.value !== 'image/jpeg'; };

      $('#icRun').onclick = function () {
        if (running) { cancel = true; $('#icStatus').textContent = '正在停止…'; return; }
        run();
      };
      $('#icZip').onclick = zipAll;
      $('#icClear').onclick = function () {
        if (running) return;
        items.forEach(function (x) { URL.revokeObjectURL(x.url); });
        items = [];
        $('#icStatW').hidden = true; $('#icProgW').hidden = true;
        $('#icStatus').textContent = '';
        $('#icList').innerHTML = '';
        render();
      };

      /* ---------- 清理（关闭面板时） ---------- */
      root._cleanup = function () {
        cancel = true;
        document.removeEventListener('paste', onPaste);
        items.forEach(function (x) { URL.revokeObjectURL(x.url); });
      };

      render();
    }
  });

  /* ---------- 预留：后续办公类工具在此登记 ---------- */
})();
