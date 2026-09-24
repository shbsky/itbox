/* ===== PDF 工具箱 =====
 * 全部在浏览器本地完成，文件不上传。
 * 依赖（首次用到时才加载，见 util.js 的 U.loadPdfLib / U.loadPdfJs）：
 *   assets/lib/pdf-lib.min.js   @cantoo/pdf-lib 2.11.1 —— 改文档 + AES/RC4 加解密
 *   assets/lib/pdf.min.js       pdf.js 3.11.174 —— 渲染页面为图片 / 缩略图
 */
(function () {
  'use strict';
  var LB = window.LB, U = LB.util;

  var MAX_MB = 100;                                   // 单文件上限
  var FONT = '"Microsoft YaHei","微软雅黑","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Source Han Sans SC",sans-serif';
  var DPR = 2;                                        // 水印/页码位图放大倍数（贴回 PDF 时按 1/DPR 折算）

  /* ================= 通用小工具 ================= */
  function fmtSize(n) {
    if (n == null || isNaN(n)) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function baseName(name) {
    var n = String(name || 'file'), d = n.lastIndexOf('.');
    return d > 0 ? n.slice(0, d) : n;
  }
  function stamp(prefix, ext) {
    var d = new Date(), p = U.pad;
    return prefix + '_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '_' + p(d.getHours()) + p(d.getMinutes()) + '.' + ext;
  }
  function readBuf(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(new Uint8Array(fr.result)); };
      fr.onerror = function () { rej(new Error('读取文件失败')); };
      fr.readAsArrayBuffer(file);
    });
  }
  function toBlob(u8, mime) { return new Blob([u8], { type: mime || 'application/pdf' }); }
  function cvBlob(cv, mime, q) {
    return new Promise(function (res, rej) {
      try {
        cv.toBlob(function (b) { b ? res(b) : rej(new Error('图片编码失败')); }, mime || 'image/jpeg', q);
      } catch (e) { rej(e); }
    });
  }
  function isPdf(file) {
    return file && (/\.pdf$/i.test(file.name || '') || file.type === 'application/pdf');
  }
  /** "1-3,5,7-" → { list:[1,2,3,5,7,8], bad:[] }（1 起算，去重升序） */
  function parseRanges(str, max) {
    var set = {}, bad = [];
    String(str || '').split(/[,，、\s]+/).forEach(function (seg) {
      if (!seg) return;
      var m = seg.match(/^(\d+)\s*(?:[-~—至]\s*(\d*))?$/);
      if (!m) { bad.push(seg); return; }
      var a = parseInt(m[1], 10);
      var b = (m[2] === undefined) ? a : (m[2] === '' ? max : parseInt(m[2], 10));
      if (!a || !b || a < 1 || b < 1) { bad.push(seg); return; }
      if (a > b) { var t = a; a = b; b = t; }
      if (a > max) { bad.push(seg); return; }
      if (b > max) b = max;
      for (var i = a; i <= b; i++) set[i] = 1;
    });
    var list = Object.keys(set).map(Number).sort(function (x, y) { return x - y; });
    return { list: list, bad: bad };
  }
  /** 把 canvas 上的文字做成透明 PNG；返回 {img, w, h}（w/h 为「点」尺寸） */
  function textToImage(text, opt) {
    var size = opt.size || 24;
    var cv = document.createElement('canvas');
    var ctx = cv.getContext('2d');
    var font = (opt.bold ? '600 ' : '') + size + 'px ' + FONT;
    ctx.font = font;
    var w = Math.max(1, Math.ceil(ctx.measureText(text).width));
    var h = Math.max(1, Math.ceil(size * 1.45));
    cv.width = Math.ceil(w * DPR);
    cv.height = Math.ceil(h * DPR);
    ctx = cv.getContext('2d');
    ctx.scale(DPR, DPR);
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = opt.color || '#888888';
    ctx.fillText(text, w / 2, h / 2);
    return { cv: cv, w: w, h: h };
  }
  /** 绕中心旋转后，求图片左下角坐标 */
  function rotXY(cx, cy, w, h, deg) {
    var r = deg * Math.PI / 180;
    var dx = (w / 2) * Math.cos(r) - (h / 2) * Math.sin(r);
    var dy = (w / 2) * Math.sin(r) + (h / 2) * Math.cos(r);
    return { x: cx - dx, y: cy - dy };
  }
  function isEncryptedBytes(u8) {
    var head = '', n = Math.min(u8.length, 8192);
    for (var i = 0; i < n; i++) head += String.fromCharCode(u8[i]);
    return head.indexOf('/Encrypt') >= 0;
  }

  /* ================= 共享状态 ================= */
  var S = { name: '', bytes: null, doc: null, pages: 0, size: 0, dirty: false };
  function clearDoc() {
    S.name = ''; S.bytes = null; S.doc = null;
    S.pages = 0; S.size = 0; S.dirty = false;
  }
  /** 载入 PDF 到 S（自动识别「需要密码」并给出人话提示） */
  function loadInto(file, password) {
    if (!isPdf(file)) return Promise.reject(new Error('请选择 PDF 文件'));
    if (file.size > MAX_MB * 1048576) return Promise.reject(new Error('文件超过 ' + MAX_MB + ' MB，浏览器处理不了这么大的 PDF'));
    var nm = file.name || 'document.pdf';
    return readBuf(file).then(function (u8) {
      return U.loadPdfLib().then(function (PDFLib) {
        var opt = password ? { password: password } : undefined;
        return PDFLib.PDFDocument.load(u8, opt).then(function (doc) {
          S.name = nm; S.bytes = u8; S.doc = doc;
          S.pages = doc.getPageCount(); S.size = u8.length; S.dirty = false;
          return doc;
        });
      });
    }).catch(function (e) {
      var m = String(e && e.message || e);
      if (/encrypted|password/i.test(m)) {
        throw new Error('这个 PDF 有打开密码，请先用「解锁 PDF」去掉密码，或填入正确密码');
      }
      if (/Failed to parse|No PDF header|Invalid PDF/i.test(m)) throw new Error('文件不是有效的 PDF，或已损坏');
      throw new Error('打开失败：' + m);
    });
  }
  /** 保存 S.doc 并回写状态 */
  function persist(opt) {
    return S.doc.save(opt).then(function (u8) {
      S.bytes = u8; S.size = u8.length; S.dirty = true;
      return u8;
    });
  }
  /** 用新的 PDFDocument 替换当前文档（用于重建类操作） */
  function replaceDoc(doc, u8) {
    S.doc = doc;
    S.bytes = u8;
    S.size = u8.length;
    S.pages = doc.getPageCount();
    S.dirty = true;
    if (S.name && !/_已|_unlock|_merged/i.test(S.name)) S.name = baseName(S.name) + '.pdf';
  }

  /* ================= 功能清单 ================= */
  var FEATS = [
    { id: 'merge', icon: '🔗', name: '合并 PDF', desc: '多个 PDF 按顺序合成一个', multi: true },
    { id: 'split', icon: '✂️', name: '拆分 PDF', desc: '按范围提取或逐页拆开' },
    { id: 'rotate', icon: '🔄', name: '旋转 PDF', desc: '顺/逆时针 90°、180° 翻转' },
    { id: 'delete', icon: '🗑️', name: '删除页面', desc: '点选要删掉的页面', pj: true },
    { id: 'reorder', icon: '🔀', name: '重新排列', desc: '拖拽调整页面顺序', pj: true },
    { id: 'compress', icon: '📉', name: '压缩 PDF', desc: '大幅减小体积', pj: true },
    { id: 'watermark', icon: '💧', name: '加水印', desc: '支持中文，平铺或居中' },
    { id: 'pagenum', icon: '🔢', name: 'PDF 页码', desc: '给每页加页码' },
    { id: 'encrypt', icon: '🔒', name: '加密 PDF', desc: '设打开密码与权限' },
    { id: 'unlock', icon: '🔓', name: '解锁 PDF', desc: '解除打印/复制限制' },
    { id: 'extract', icon: '🖼️', name: '提取图片', desc: '取出 PDF 里的图片' },
    { id: 'toimage', icon: '📷', name: '转图片', desc: 'PDF 转 JPG / PNG / WebP', pj: true },
    { id: 'toxlsx', icon: '📊', name: 'PDF 转 Excel', desc: '提取表格 → .xlsx，可预览调列', pj: true },
    { id: 'todocx', icon: '📝', name: 'PDF 转 Word', desc: '文字 → .docx，保留标题与表格', pj: true }
  ];

  /* ================= 视图 ================= */
  var appEl = null, feat = null, mgFiles = [] /* 合并专用列表 */;

  function render() {
    if (!appEl) return;
    if (!feat) { appEl.innerHTML = homeHtml(); bindHome(); }
    else { appEl.innerHTML = workHtml(); bindWork(); }
  }

  function homeHtml() {
    var best;
    if (S.doc) {
      best = '<div class="t-section"><div class="sec-t">当前文档</div>' +
        '<div class="pdf-doc">' +
        '<span class="pdf-doc-tag">PDF</span>' +
        '<span class="pdf-doc-nm" title="' + U.esc(S.name) + '">' + U.esc(S.name) + '</span>' +
        '<span class="pdf-doc-mt">' + S.pages + ' 页 · ' + fmtSize(S.size) + (S.dirty ? ' · 已修改' : '') + '</span>' +
        '<span class="pdf-doc-ops"><button class="btn btn-sm" data-doc="save">下载</button>' +
        '<button class="btn btn-sm" data-doc="clear">清除</button></span>' +
        '</div></div>';
    } else { best = ''; }
    return '' +
      '<div class="t-section"><div class="sec-t">选择功能</div>' +
      '<div class="pdf-tip">全部在本机浏览器完成，文件不会上传到任何服务器。带「需渲染」的功能首次使用要加载约 1.4 MB 渲染库，之后走缓存。</div>' +
      '<div class="pdf-grid">' + FEATS.map(function (f) {
        return '<button class="pdf-card" data-feat="' + f.id + '">' +
          '<span class="pdf-ico">' + f.icon + '</span>' +
          '<b>' + f.name + '</b>' +
          '<i>' + f.desc + '</i>' +
          (f.pj ? '<span class="pdf-tag">需渲染</span>' : '') +
          '</button>';
      }).join('') + '</div></div>' + best;
  }

  function docSection() {
    if (S.doc) {
      return '<div class="pdf-doc">' +
        '<span class="pdf-doc-tag">PDF</span>' +
        '<span class="pdf-doc-nm" title="' + U.esc(S.name) + '">' + U.esc(S.name) + '</span>' +
        '<span class="pdf-doc-mt">' + S.pages + ' 页 · ' + fmtSize(S.size) + (S.dirty ? ' · 已修改' : '') + '</span>' +
        '<span class="pdf-doc-ops"><button class="btn btn-sm" data-doc="save">下载</button>' +
        '<button class="btn btn-sm" data-doc="change">更换</button></span></div>';
    }
    return '<div class="drop-zone" id="pdfDrop">' +
      '<div class="drop-ico">📕</div>' +
      '<div class="drop-t">拖 PDF 到这里，或点下面按钮</div>' +
      '<div class="drop-s">单个文件 ≤ ' + MAX_MB + ' MB · 全程本地不上传</div>' +
      '<button class="btn btn-pri" id="pdfPick">选择 PDF 文件</button>' +
      '<input type="file" id="pdfFile" accept="application/pdf,.pdf" hidden></div>';
  }

  function workHtml() {
    var f = feat;
    return '<div class="pdf-head">' +
      '<button class="btn btn-sm" id="pdfBack">← 全部功能</button>' +
      '<b class="pdf-head-t">' + f.icon + ' ' + f.name + '</b>' +
      '<span class="pdf-head-d">' + f.desc + '</span>' +
      '</div>' +
      (f.multi ? '' : '<div class="t-section"><div class="sec-t">源文件</div>' + docSection() + '</div>') +
      '<div class="t-section"><div class="sec-t">' + (f.multi ? '待合并文件' : '操作') + '</div>' +
      '<div id="pdfPane">' + (PANE[f.id] ? PANE[f.id].html() : '') + '</div>' +
      '<div class="pdf-status" id="pdfStatus"></div></div>';
  }

  /* ================= 事件绑定 ================= */
  function bindHome() {
    U.$$('.pdf-card', appEl).forEach(function (b) {
      b.onclick = function () {
        feat = FEATS.filter(function (x) { return x.id === b.dataset.feat; })[0] || null;
        render();
      };
    });
    bindDocOps(appEl);
  }

  function bindWork() {
    var back = U.$('#pdfBack', appEl);
    if (back) back.onclick = function () { feat = null; status(''); render(); };
    bindDocOps(appEl);
    bindPicker(appEl);
    if (PANE[feat.id] && PANE[feat.id].bind) PANE[feat.id].bind(appEl);
  }

  function bindDocOps(scope) {
    U.$$('[data-doc]', scope).forEach(function (b) {
      b.onclick = function () {
        var k = b.dataset.doc;
        if (k === 'save') {
          if (!S.doc) return;
          withBusy(b, '生成中…', function () {
            return persist().then(function (u8) {
              U.saveBlob(baseName(S.name) + (S.dirty ? '_已处理' : '') + '.pdf', toBlob(u8));
            });
          });
        } else if (k === 'clear') {
          clearDoc(); render();
        } else if (k === 'change') {
          clearDoc(); render();
        }
      };
    });
  }

  function bindPicker(scope) {
    var drop = U.$('#pdfDrop', scope), input = U.$('#pdfFile', scope), btn = U.$('#pdfPick', scope);
    if (!drop || !input) return;
    function take(file) {
      if (!file) return;
      status('正在打开 ' + file.name + ' …');
      loadInto(file, '').then(function () {
        status(''); U.toast('已打开 ' + S.name + '（' + S.pages + ' 页）', 'ok');
        render();
      }).catch(function (e) { status(''); U.toast(e.message, 'err'); });
    }
    btn.onclick = function () { input.click(); };
    input.onchange = function () { take(input.files[0]); input.value = ''; };
    drop.onclick = function (e) { if (e.target !== btn && e.target !== input) input.click(); };
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      take(f);
    });
  }

  /* ================= 辅助：忙碌态 / 状态行 ================= */
  function status(msg) {
    var e = U.$('#pdfStatus', appEl || document);
    if (e) e.textContent = msg || '';
  }
  function withBusy(btn, label, fn) {
    var old = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = label || '处理中…'; }
    return Promise.resolve().then(fn).catch(function (e) {
      var m = String(e && e.message || e);
      status('出错：' + m);
      U.toast(m, 'err');
    }).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = old; }
    });
  }
  function needDoc() {
    if (!S.doc) { U.toast('请先选择 PDF 文件', 'err'); return false; }
    return true;
  }
  /** 渲染 PDF 页为 canvas（pdf.js） */
  function renderPage(pjDoc, num, scale) {
    return pjDoc.getPage(num).then(function (page) {
      var vp = page.getViewport({ scale: scale });
      var cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.floor(vp.width));
      cv.height = Math.max(1, Math.floor(vp.height));
      var ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
        return { cv: cv, w: vp.width / scale, h: vp.height / scale };
      });
    });
  }

  /* ================= 各功能面板 ================= */
  var PANE = {};

  /* ---------- 合并 ---------- */
  PANE.merge = {
    html: function () {
      return '<div class="pdf-files" id="mgList"></div>' +
        '<div class="pdf-row">' +
        '<button class="btn" id="mgPick">＋ 添加 PDF</button>' +
        '<button class="btn btn-pri" id="mgGo" disabled>开始合并</button>' +
        '<input type="file" id="mgFile" accept="application/pdf,.pdf" multiple hidden>' +
        '</div>' +
        '<div class="pdf-hint">列表顺序就是合并顺序，可用 ↑ ↓ 调整。全部页面会依次拼接。</div>';
    },
    bind: function (root) {
      var list = U.$('#mgList', root), input = U.$('#mgFile', root);
      U.$('#mgPick', root).onclick = function () { input.click(); };
      input.onchange = function () {
        var fs = Array.prototype.slice.call(input.files || []);
        input.value = '';
        if (!fs.length) return;
        status('正在读取 ' + fs.length + ' 个文件…');
        U.loadPdfLib().then(function (PDFLib) {
          return fs.reduce(function (chain, f) {
            return chain.then(function () {
              if (!isPdf(f)) { mgFiles.push({ name: f.name, size: f.size, pages: 0, bytes: null, bad: '不是 PDF' }); return; }
              return readBuf(f).then(function (u8) {
                return PDFLib.PDFDocument.load(u8, { ignoreEncryption: true }).then(function (d) {
                  mgFiles.push({ name: f.name, size: u8.length, pages: d.getPageCount(), bytes: u8 });
                }).catch(function () {
                  mgFiles.push({ name: f.name, size: f.size, pages: 0, bytes: null, bad: '打不开（可能加密）' });
                });
              });
            });
          }, Promise.resolve());
        }).then(function () { status(''); draw(); })
          .catch(function (e) { status(''); U.toast(e.message, 'err'); });
      };
      function draw() {
        var okN = mgFiles.filter(function (x) { return x.bytes; }).length;
        list.innerHTML = mgFiles.length ? mgFiles.map(function (f, i) {
          return '<div class="pdf-file" data-i="' + i + '">' +
            '<span class="pdf-file-i">' + (i + 1) + '</span>' +
            '<span class="pdf-file-n" title="' + U.esc(f.name) + '">' + U.esc(f.name) + '</span>' +
            '<span class="pdf-file-m">' + (f.bad ? '<em class="bad">' + f.bad + '</em>' : f.pages + ' 页 · ' + fmtSize(f.size)) + '</span>' +
            '<span class="pdf-file-o">' +
            '<button class="btn btn-sm" data-mv="-1" ' + (i === 0 ? 'disabled' : '') + '>↑</button>' +
            '<button class="btn btn-sm" data-mv="1" ' + (i === mgFiles.length - 1 ? 'disabled' : '') + '>↓</button>' +
            '<button class="btn btn-sm" data-rm="1">✕</button></span></div>';
        }).join('') : '<div class="pdf-empty">还没有添加文件</div>';
        U.$('#mgGo', root).disabled = okN < 2;
        U.$$('.pdf-file', root).forEach(function (row) {
          var i = Number(row.dataset.i);
          var mv = U.$('[data-mv="-1"]', row), mvd = U.$('[data-mv="1"]', row), rm = U.$('[data-rm]', row);
          if (mv) mv.onclick = function () { var t = mgFiles[i - 1]; mgFiles[i - 1] = mgFiles[i]; mgFiles[i] = t; draw(); };
          if (mvd) mvd.onclick = function () { var t = mgFiles[i + 1]; mgFiles[i + 1] = mgFiles[i]; mgFiles[i] = t; draw(); };
          rm.onclick = function () { mgFiles.splice(i, 1); draw(); };
        });
      }
      U.$('#mgGo', root).onclick = function () {
        var btn = this;
        withBusy(btn, '合并中…', function () {
          var use = mgFiles.filter(function (x) { return x.bytes; });
          return U.loadPdfLib().then(function (PDFLib) {
            return PDFLib.PDFDocument.create().then(function (out) {
              return use.reduce(function (chain, f, i) {
                return chain.then(function () {
                  status('正在合并 ' + (i + 1) + '/' + use.length + '：' + f.name);
                  return PDFLib.PDFDocument.load(f.bytes, { ignoreEncryption: true }).then(function (src) {
                    return out.copyPages(src, src.getPageIndices()).then(function (pgs) {
                      pgs.forEach(function (p) { out.addPage(p); });
                    });
                  });
                });
              }, Promise.resolve()).then(function () {
                status('正在输出…');
                return out.save();
              });
            });
          }).then(function (u8) {
            status('合并完成，共 ' + use.reduce(function (a, b) { return a + b.pages; }, 0) + ' 页 · ' + fmtSize(u8.length));
            U.saveBlob(stamp('merged', 'pdf'), toBlob(u8));
          });
        });
      };
      draw();
    }
  };

  /* ---------- 拆分 ---------- */
  PANE.split = {
    html: function () {
      return '<div class="pdf-row"><label class="pdf-lb">拆分方式</label>' +
        '<select id="spMode">' +
        '<option value="one">提取选定页面 → 一个 PDF</option>' +
        '<option value="each">每页一个 PDF → 打包 ZIP</option>' +
        '<option value="chunk">每 N 页一个 PDF → 打包 ZIP</option>' +
        '</select></div>' +
        '<div class="pdf-row"><label class="pdf-lb">页码范围</label>' +
        '<input type="text" id="spRanges" placeholder="留空 = 全部，如 1-3,5,8-10"></div>' +
        '<div class="pdf-row" id="spChunkRow" hidden><label class="pdf-lb">每份页数</label>' +
        '<input type="number" id="spChunk" value="1" min="1" style="max-width:110px"></div>' +
        '<div class="pdf-row"><button class="btn btn-pri" id="spGo">开始拆分</button>' +
        '<span class="pdf-hint-inline" id="spInfo"></span></div>';
    },
    bind: function (root) {
      var mode = U.$('#spMode', root), chRow = U.$('#spChunkRow', root);
      mode.onchange = function () { chRow.hidden = mode.value !== 'chunk'; };
      U.$('#spGo', root).onclick = function () {
        if (!needDoc()) return;
        var btn = this, total = S.pages;
        var rg = parseRanges(U.$('#spRanges', root).value, total);
        if (rg.bad.length) { U.toast('页码写错了：' + rg.bad.join(' '), 'err'); return; }
        var idx = (rg.list.length ? rg.list : Array.apply(null, { length: total }).map(function (_, i) { return i + 1; }))
          .map(function (n) { return n - 1; });
        var m = mode.value;
        withBusy(btn, '拆分中…', function () {
          return U.loadPdfLib().then(function (PDFLib) {
            if (m === 'one') {
              return PDFLib.PDFDocument.create().then(function (out) {
                return out.copyPages(S.doc, idx).then(function (pgs) {
                  pgs.forEach(function (p) { out.addPage(p); });
                  return out.save();
                });
              }).then(function (u8) {
                U.saveBlob(stamp('split_' + idx.length + 'p', 'pdf'), toBlob(u8));
                status('已导出 ' + idx.length + ' 页 · ' + fmtSize(u8.length));
              });
            }
            var chunk = m === 'each' ? 1 : Math.max(1, parseInt(U.$('#spChunk', root).value, 10) || 1);
            var groups = [];
            for (var i = 0; i < idx.length; i += chunk) groups.push(idx.slice(i, i + chunk));
            var files = [];
            return groups.reduce(function (chain, g, gi) {
              return chain.then(function () {
                status('正在拆分 ' + (gi + 1) + '/' + groups.length + ' …');
                return PDFLib.PDFDocument.create().then(function (out) {
                  return out.copyPages(S.doc, g).then(function (pgs) {
                    pgs.forEach(function (p) { out.addPage(p); });
                    return out.save().then(function (u8) {
                      var tag = chunk === 1
                        ? 'p' + U.pad(g[0] + 1, String(total).length)
                        : 'p' + U.pad(g[0] + 1, String(total).length) + '-' + U.pad(g[g.length - 1] + 1, String(total).length);
                      files.push({ name: baseName(S.name) + '_' + tag + '.pdf', data: u8 });
                    });
                  });
                });
              });
            }, Promise.resolve()).then(function () {
              U.saveBlob(baseName(S.name) + '_拆分' + files.length + '份.zip', U.zipStore(files));
              status('已拆成 ' + files.length + ' 个文件');
            });
          });
        });
      };
    }
  };

  /* ---------- 旋转 ---------- */
  PANE.rotate = {
    html: function () {
      return '<div class="pdf-row"><label class="pdf-lb">旋转</label>' +
        '<select id="rtAngle">' +
        '<option value="90">顺时针 90°</option>' +
        '<option value="-90">逆时针 90°</option>' +
        '<option value="180">180° 翻转</option>' +
        '</select></div>' +
        '<div class="pdf-row"><label class="pdf-lb">应用页面</label>' +
        '<input type="text" id="rtPages" placeholder="留空 = 全部页面，如 1,3-5"></div>' +
        '<div class="pdf-row"><button class="btn btn-pri" id="rtGo">应用旋转</button>' +
        '<span class="pdf-hint-inline">可重复点，效果会累加</span></div>';
    },
    bind: function (root) {
      U.$('#rtGo', root).onclick = function () {
        if (!needDoc()) return;
        var btn = this, d = parseInt(U.$('#rtAngle', root).value, 10);
        var rg = parseRanges(U.$('#rtPages', root).value, S.pages);
        if (rg.bad.length) { U.toast('页码写错了：' + rg.bad.join(' '), 'err'); return; }
        var list = rg.list.length ? rg.list : null;
        withBusy(btn, '处理中…', function () {
          return U.loadPdfLib().then(function (PDFLib) {
            var pages = S.doc.getPages();
            var n = 0;
            pages.forEach(function (p, i) {
              if (list && list.indexOf(i + 1) < 0) return;
              var cur = p.getRotation().angle || 0;
              p.setRotation(PDFLib.degrees(((cur + d) % 360 + 360) % 360));
              n++;
            });
            return persist().then(function () {
              status('已旋转 ' + n + ' 页（' + d + '°）');
              render();
            });
          });
        });
      };
    }
  };

  /* ---------- 删除页面 ---------- */
  PANE.delete = {
    html: function () {
      return '<div class="pdf-hint">点缩略图选中要删除的页面（可多选）。下方也可直接输入页码。</div>' +
        '<div class="pdf-pages" id="dlGrid"><div class="pdf-loading">正在生成缩略图…</div></div>' +
        '<div class="pdf-row">' +
        '<input type="text" id="dlPages" placeholder="如 2,5-7">' +
        '<button class="btn btn-pri" id="dlGo" disabled>删除选中页</button>' +
        '<span class="pdf-hint-inline" id="dlCnt"></span></div>';
    },
    bind: function (root) {
      var grid = U.$('#dlGrid', root), picked = {}, goBtn = U.$('#dlGo', root);
      function sync() {
        var n = Object.keys(picked).length;
        goBtn.disabled = n === 0 || n >= S.pages;
        U.$('#dlCnt', root).textContent = n ? '已选 ' + n + ' 页' : '';
      }
      function drawThumbs() {
        /* 没打开文档时必须先退出：原来直接 S.bytes.slice() 会抛 TypeError，
         * app.js 的 try/catch 会把整个面板换成「工具初始化出错」，
         * 用户连「源文件」的选文件入口都看不见。 */
        if (!S.doc) {
          grid.innerHTML = '<div class="pdf-empty">还没有打开 PDF —— 先在上面「源文件」选一个文件</div>';
          return;
        }
        grid.innerHTML = '<div class="pdf-loading">正在生成缩略图…</div>';
        U.pdfOpen(S.bytes.slice()).then(function (d) {
          var used = d;
          var i = 0;
          (function next() {
            if (i >= d.numPages) { used.destroy(); return; }
            renderPage(d, i + 1, 0.22).then(function (r) {
              if (i === 0) grid.innerHTML = '';
              var el = document.createElement('div');
              el.className = 'pdf-pg' + (picked[i + 1] ? ' on' : '');
              el.dataset.n = i + 1;
              el.appendChild(r.cv);
              var lb = document.createElement('span');
              lb.className = 'pdf-pg-n';
              lb.textContent = i + 1;
              el.appendChild(lb);
              el.onclick = function () {
                if (picked[i + 1]) delete picked[i + 1]; else picked[i + 1] = 1;
                el.classList.toggle('on');
                sync();
              };
              grid.appendChild(el);
              i++;
              next();
            }).catch(function (e) {
              grid.innerHTML = '<div class="pdf-empty">缩略图渲染失败：' + U.esc(e.message) + '</div>';
            });
          })();
        }).catch(function (e) {
          grid.innerHTML = '<div class="pdf-empty">加载失败：' + U.esc(e.message) + '</div>';
        });
      }
      U.$('#dlPages', root).oninput = function () {
        var rg = parseRanges(this.value, S.pages);
        picked = {};
        rg.list.forEach(function (n) { picked[n] = 1; });
        U.$$('.pdf-pg', grid).forEach(function (el) {
          el.classList.toggle('on', !!picked[Number(el.dataset.n)]);
        });
        sync();
      };
      goBtn.onclick = function () {
        if (!needDoc()) return;
        var btn = this;
        var list = Object.keys(picked).map(Number).sort(function (a, b) { return b - a; });
        withBusy(btn, '删除中…', function () {
          list.forEach(function (n) { S.doc.removePage(n - 1); });
          return persist().then(function () {
            status('已删除 ' + list.length + ' 页，剩余 ' + S.pages + ' 页');
            picked = {};
            render();
          });
        });
      };
      sync();
      drawThumbs();
    }
  };

  /* ---------- 重新排列 ---------- */
  PANE.reorder = {
    html: function () {
      return '<div class="pdf-hint">按住缩略图拖动即可调整顺序，也可在下方直接写出新顺序。</div>' +
        '<div class="pdf-pages" id="roGrid"><div class="pdf-loading">正在生成缩略图…</div></div>' +
        '<div class="pdf-row">' +
        '<input type="text" id="roOrder" placeholder="新顺序，如 3,1,2,4">' +
        '<button class="btn btn-pri" id="roGo" disabled>应用顺序</button></div>';
    },
    bind: function (root) {
      var grid = U.$('#roGrid', root), goBtn = U.$('#roGo', root), order = null, dragEl = null;
      function curOrder() {
        return U.$$('.pdf-pg', grid).map(function (el) { return Number(el.dataset.n); });
      }
      function upd() { goBtn.disabled = !order; }
      function drawThumbs() {
        /* 同上：没文档时直接 S.bytes.slice() 会抛，面板会被整块替换成报错页。 */
        if (!S.doc) {
          grid.innerHTML = '<div class="pdf-empty">还没有打开 PDF —— 先在上面「源文件」选一个文件</div>';
          return;
        }
        grid.innerHTML = '<div class="pdf-loading">正在生成缩略图…</div>';
        U.pdfOpen(S.bytes.slice()).then(function (d) {
          var i = 0;
          (function next() {
            if (i >= d.numPages) { d.destroy(); return; }
            renderPage(d, i + 1, 0.22).then(function (r) {
              if (i === 0) grid.innerHTML = '';
              var el = document.createElement('div');
              el.className = 'pdf-pg';
              el.dataset.n = i + 1;
              el.draggable = true;
              el.appendChild(r.cv);
              var lb = document.createElement('span');
              lb.className = 'pdf-pg-n';
              lb.textContent = i + 1;
              el.appendChild(lb);
              grid.appendChild(el);
              i++;
              next();
            }).catch(function (e) {
              grid.innerHTML = '<div class="pdf-empty">缩略图渲染失败：' + U.esc(e.message) + '</div>';
            });
          })();
        }).catch(function (e) {
          grid.innerHTML = '<div class="pdf-empty">加载失败：' + U.esc(e.message) + '</div>';
        });
      }
      grid.addEventListener('dragstart', function (e) {
        var el = e.target.closest ? e.target.closest('.pdf-pg') : null;
        if (!el) return;
        dragEl = el;
        el.classList.add('drag');
        try { e.dataTransfer.setData('text/plain', el.dataset.n); e.dataTransfer.effectAllowed = 'move'; } catch (x) { }
      });
      grid.addEventListener('dragover', function (e) {
        e.preventDefault();
        if (!dragEl) return;
        var el = e.target.closest ? e.target.closest('.pdf-pg') : null;
        if (!el || el === dragEl) return;
        var r = el.getBoundingClientRect();
        var after = (e.clientX - r.left) > r.width / 2;
        grid.insertBefore(dragEl, after ? el.nextSibling : el);
      });
      grid.addEventListener('dragend', function () {
        if (!dragEl) return;
        dragEl.classList.remove('drag');
        dragEl = null;
        order = curOrder();
        U.$('#roOrder', root).value = order.join(',');
        upd();
      });
      U.$('#roOrder', root).oninput = function () {
        var rg = parseRanges(this.value, S.pages);
        if (rg.bad.length || rg.list.length !== S.pages) { order = null; upd(); return; }
        order = rg.list; upd();
      };
      goBtn.onclick = function () {
        if (!needDoc() || !order) return;
        var btn = this, ord = order.slice();
        withBusy(btn, '重排中…', function () {
          // 必须用 copyPages 重建：pdf-lib 在「页面被全部移除后再 insertPage」时
          // pageTree 的 Count 会算错并抛 corrupt page tree（实测确认），改用重建方案
          return U.loadPdfLib().then(function (PDFLib) {
            return PDFLib.PDFDocument.create().then(function (out) {
              var src = S.doc;
              return out.copyPages(src, ord.map(function (n) { return n - 1; })).then(function (pgs) {
                pgs.forEach(function (p) { out.addPage(p); });
                S.doc = out;
                return persist();
              });
            });
          }).then(function () {
            status('已按新顺序重排 ' + ord.length + ' 页');
            order = null;
            render();
          });
        });
      };
      drawThumbs();
    }
  };

  /* ---------- 压缩 ---------- */
  PANE.compress = {
    html: function () {
      return '<div class="pdf-warn">压缩的原理是把每页重新渲染成图片再嵌入 —— 体积能降很多（扫描件常降 60~90%），' +
        '但文字会变成图像，<b>无法再选中或搜索</b>。纯文字型 PDF 压完可能反而变大。</div>' +
        '<div class="pdf-row"><label class="pdf-lb">清晰度</label>' +
        '<select id="cpDpi">' +
        '<option value="72">最小体积 · 72 DPI</option>' +
        '<option value="96">较小 · 96 DPI</option>' +
        '<option value="120" selected>均衡 · 120 DPI</option>' +
        '<option value="150">清晰 · 150 DPI</option>' +
        '<option value="200">高清 · 200 DPI</option>' +
        '</select></div>' +
        '<div class="pdf-row"><label class="pdf-lb">画质</label>' +
        '<input type="range" id="cpQ" min="30" max="92" value="70" style="flex:1">' +
        '<span class="pdf-val" id="cpQv">70</span></div>' +
        '<div class="pdf-row"><button class="btn btn-pri" id="cpGo">开始压缩</button>' +
        '<span class="pdf-hint-inline" id="cpInfo"></span></div>';
    },
    bind: function (root) {
      var q = U.$('#cpQ', root);
      q.oninput = function () { U.$('#cpQv', root).textContent = q.value; };
      U.$('#cpGo', root).onclick = function () {
        if (!needDoc()) return;
        var btn = this, dpi = parseInt(U.$('#cpDpi', root).value, 10), qual = parseInt(q.value, 10) / 100;
        var before = S.bytes.length;
        withBusy(btn, '压缩中…', function () {
          return U.pdfOpen(S.bytes.slice()).then(function (pdf) {
            return U.loadPdfLib().then(function (PDFLib) {
              return PDFLib.PDFDocument.create().then(function (out) {
                var i = 0;
                (function step() {
                  if (i >= pdf.numPages) return Promise.resolve();
                  var n = i + 1;
                  return pdf.getPage(n).then(function (page) {
                    var vp0 = page.getViewport({ scale: 1 });
                    // 超大页面保护：像素数超过 3000 万时自动降倍率
                    var scale = dpi / 72;
                    while (vp0.width * scale * vp0.height * scale > 3e7 && scale > 0.35) scale *= 0.75;
                    var vp = page.getViewport({ scale: scale });
                    var cv = document.createElement('canvas');
                    cv.width = Math.max(1, Math.floor(vp.width));
                    cv.height = Math.max(1, Math.floor(vp.height));
                    var ctx = cv.getContext('2d');
                    ctx.fillStyle = '#fff';
                    ctx.fillRect(0, 0, cv.width, cv.height);
                    return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
                      return cvBlob(cv, 'image/jpeg', qual);
                    }).then(function (b) {
                      return b.arrayBuffer();
                    }).then(function (ab) {
                      return out.embedJpg(new Uint8Array(ab)).then(function (img) {
                        var pg = out.addPage([vp0.width, vp0.height]);
                        pg.drawImage(img, { x: 0, y: 0, width: vp0.width, height: vp0.height });
                      });
                    }).then(function () {
                      i++;
                      status('正在压缩 ' + i + '/' + pdf.numPages + ' 页…');
                      return new Promise(function (r) { setTimeout(r, 0); }).then(step);
                    });
                  });
                })();
                return out.save();
              });
            }).then(function (u8) {
              pdf.destroy();
              return u8;
            });
          });
        }).then(function (u8) {
          if (!u8) return;
          var rate = Math.round((1 - u8.length / before) * 100);
          var txt = rate > 0
            ? '完成：' + fmtSize(before) + ' → ' + fmtSize(u8.length) + '，减小 ' + rate + '%'
            : '完成，但体积反而增加了 ' + Math.abs(rate) + '%（这多半是文字型 PDF，建议别压）';
          status(txt);
          U.saveBlob(baseName(S.name) + '_压缩.pdf', toBlob(u8));
        });
      };
    }
  };

  /* ---------- 加水印 ---------- */
  PANE.watermark = {
    html: function () {
      return '<div class="pdf-row"><label class="pdf-lb">水印文字</label>' +
        '<input type="text" id="wmText" value="内部资料 禁止外传" maxlength="40" style="flex:1"></div>' +
        '<div class="pdf-row"><label class="pdf-lb">排版</label>' +
        '<select id="wmLayout">' +
        '<option value="tile">斜向平铺满页</option>' +
        '<option value="center">居中大字</option>' +
        '</select></div>' +
        '<div class="pdf-row"><label class="pdf-lb">字号</label>' +
        '<input type="range" id="wmSize" min="8" max="90" value="24" style="flex:1">' +
        '<span class="pdf-val" id="wmSizev">24</span></div>' +
        '<div class="pdf-row"><label class="pdf-lb">透明度</label>' +
        '<input type="range" id="wmOp" min="5" max="90" value="20" style="flex:1">' +
        '<span class="pdf-val" id="wmOpv">20%</span></div>' +
        '<div class="pdf-row"><label class="pdf-lb">角度</label>' +
        '<input type="range" id="wmRot" min="0" max="90" value="35" style="flex:1">' +
        '<span class="pdf-val" id="wmRotv">35°</span></div>' +
        '<div class="pdf-row"><label class="pdf-lb">颜色</label>' +
        '<input type="color" id="wmColor" value="#c0392b">' +
        '<label class="pdf-lb" style="margin-left:14px">页面</label>' +
        '<input type="text" id="wmPages" placeholder="留空 = 全部"></div>' +
        '<div class="pdf-row"><button class="btn btn-pri" id="wmGo">添加水印</button>' +
        '<span class="pdf-hint-inline">中文无需额外字体，直接用系统字体绘制</span></div>';
    },
    bind: function (root) {
      [['wmSize', 'wmSizev', ''], ['wmOp', 'wmOpv', '%'], ['wmRot', 'wmRotv', '°']].forEach(function (t) {
        var el = U.$('#' + t[0], root);
        el.oninput = function () { U.$('#' + t[1], root).textContent = el.value + t[2]; };
      });
      U.$('#wmGo', root).onclick = function () {
        if (!needDoc()) return;
        var btn = this;
        var text = U.$('#wmText', root).value.trim();
        if (!text) { U.toast('请输入水印文字', 'err'); return; }
        var layout = U.$('#wmLayout', root).value;
        var size = parseInt(U.$('#wmSize', root).value, 10);
        var op = parseInt(U.$('#wmOp', root).value, 10) / 100;
        var rot = parseInt(U.$('#wmRot', root).value, 10);
        var color = U.$('#wmColor', root).value;
        var rg = parseRanges(U.$('#wmPages', root).value, S.pages);
        if (rg.bad.length) { U.toast('页码写错了：' + rg.bad.join(' '), 'err'); return; }
        var only = rg.list.length ? rg.list : null;

        withBusy(btn, '添加中…', function () {
          return U.loadPdfLib().then(function (PDFLib) {
            var timg = textToImage(text, { size: size, color: color, bold: true });
            var iw = timg.w / DPR, ih = timg.h / DPR;
            return cvBlob(timg.cv, 'image/png').then(function (b) { return b.arrayBuffer(); })
              .then(function (ab) {
                return S.doc.embedPng(new Uint8Array(ab));
              }).then(function (img) {
                var pages = S.doc.getPages();
                var n = 0;
                pages.forEach(function (page, i) {
                  if (only && only.indexOf(i + 1) < 0) return;
                  var pw = page.getWidth(), ph = page.getHeight();
                  if (layout === 'center') {
                    var k = Math.min(2.2, pw / (iw * 1.25), ph / (ih * 1.25));
                    var w = iw * k, h = ih * k;
                    var p = rotXY(pw / 2, ph / 2, w, h, rot);
                    page.drawImage(img, { x: p.x, y: p.y, width: w, height: h, rotate: PDFLib.degrees(rot), opacity: op });
                  } else {
                    var diag = Math.sqrt(pw * pw + ph * ph) / 2 + Math.max(iw, ih);
                    var sx = iw * 1.7, sy = ih * 4.6;
                    for (var y = -diag; y <= diag; y += sy) {
                      for (var x = -diag; x <= diag; x += sx) {
                        page.drawImage(img, {
                          x: pw / 2 + x, y: ph / 2 + y,
                          width: iw, height: ih,
                          rotate: PDFLib.degrees(rot), opacity: op
                        });
                      }
                    }
                  }
                  n++;
                });
                return persist().then(function () {
                  status('已给 ' + n + ' 页加上水印');
                  render();
                });
              });
          });
        });
      };
    }
  };

  /* ---------- 页码 ---------- */
  PANE.pagenum = {
    html: function () {
      return '<div class="pdf-row"><label class="pdf-lb">位置</label>' +
        '<select id="pnPos">' +
        '<option value="bc">底部居中</option><option value="br">右下角</option>' +
        '<option value="bl">左下角</option><option value="tc">顶部居中</option>' +
        '<option value="tr">右上角</option><option value="tl">左上角</option>' +
        '</select></div>' +
        '<div class="pdf-row"><label class="pdf-lb">格式</label>' +
        '<select id="pnFmt">' +
        '<option value="n">1</option>' +
        '<option value="p-n">第 1 页</option>' +
        '<option value="n-t">1 / 12</option>' +
        '<option value="p-n-t">第 1 页 / 共 12 页</option>' +
        '</select></div>' +
        '<div class="pdf-row"><label class="pdf-lb">起始编号</label>' +
        '<input type="number" id="pnStart" value="1" min="1" style="max-width:110px">' +
        '<label class="pdf-lb" style="margin-left:14px">字号</label>' +
        '<input type="number" id="pnSize" value="10" min="6" max="30" style="max-width:90px">' +
        '<label class="pdf-lb" style="margin-left:14px">颜色</label>' +
        '<input type="color" id="pnColor" value="#444444"></div>' +
        '<div class="pdf-row"><button class="btn btn-pri" id="pnGo">添加页码</button>' +
        '<span class="pdf-hint-inline">纯数字用矢量字体（最清晰），含中文时自动转位图</span></div>';
    },
    bind: function (root) {
      U.$('#pnGo', root).onclick = function () {
        if (!needDoc()) return;
        var btn = this;
        var pos = U.$('#pnPos', root).value, fmt = U.$('#pnFmt', root).value;
        var start = Math.max(1, parseInt(U.$('#pnStart', root).value, 10) || 1);
        var size = Math.max(6, Math.min(30, parseInt(U.$('#pnSize', root).value, 10) || 10));
        var color = U.$('#pnColor', root).value;
        var total = S.pages;
        var needCjk = /p-/.test(fmt);                      // "第 x 页" 需要中文
        var M = 22, totalPages = total;

        function label(i) {
          var n = start + i;
          if (fmt === 'n') return String(n);
          if (fmt === 'p-n') return '第 ' + n + ' 页';
          if (fmt === 'n-t') return n + ' / ' + totalPages;
          return '第 ' + n + ' 页 / 共 ' + totalPages + ' 页';
        }
        withBusy(btn, '添加中…', function () {
          return U.loadPdfLib().then(function (PDFLib) {
            var chain = Promise.resolve();
            if (needCjk) return persistAndDraw(PDFLib);
            // 纯数字：矢量字体，最清晰
            return S.doc.embedFont(PDFLib.StandardFonts.Helvetica).then(function (font) {
              return drawAll(PDFLib, font, null);
            });
            function persistAndDraw(PDFLib) {
              return drawAll(PDFLib, null, true);
            }
            function drawAll(PDFLib, font, useBitmap) {
              var pages = S.doc.getPages();
              var jobs = pages.map(function (page, i) {
                return function () {
                  var s = label(i);
                  var pw = page.getWidth(), ph = page.getHeight();
                  if (!useBitmap) {
                    var w = font.widthOfTextAtSize(s, size);
                    var x = pos === 'bc' || pos === 'tc' ? (pw - w) / 2 :
                      (pos === 'br' || pos === 'tr' ? pw - w - M : M);
                    var y = (pos === 'tl' || pos === 'tr' || pos === 'tc') ? ph - M - size : M;
                    page.drawText(s, { x: x, y: y, size: size, font: font, color: hexRgb(PDFLib, color) });
                    return Promise.resolve();
                  }
                  var t = textToImage(s, { size: size, color: color, bold: false });
                  var tw = t.w / DPR, th = t.h / DPR;
                  return cvBlob(t.cv, 'image/png').then(function (b) { return b.arrayBuffer(); })
                    .then(function (ab) { return S.doc.embedPng(new Uint8Array(ab)); })
                    .then(function (img) {
                      var x = (pos === 'bc' || pos === 'tc') ? (pw - tw) / 2 :
                        (pos === 'br' || pos === 'tr' ? pw - tw - M : M);
                      var y = (pos === 'tl' || pos === 'tr' || pos === 'tc') ? ph - M - th : M;
                      page.drawImage(img, { x: x, y: y, width: tw, height: th });
                    });
                };
              });
              return jobs.reduce(function (c, j, i) {
                return c.then(j).then(function () { status('正在加页码 ' + (i + 1) + '/' + jobs.length + '…'); });
              }, Promise.resolve());
            }
          }).then(function () {
            return persist().then(function () {
              status('已添加页码，共 ' + total + ' 页');
              render();
            });
          });
        });
      };
    }
  };
  function hexRgb(PDFLib, hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '#000000');
    if (!m) return PDFLib.rgb(0, 0, 0);
    return PDFLib.rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
  }

  /* ---------- 加密 ---------- */
  PANE.encrypt = {
    html: function () {
      return '<div class="pdf-row"><label class="pdf-lb">打开密码</label>' +
        '<input type="text" id="ecUser" placeholder="打开文档时必须输入" autocomplete="new-password" style="flex:1"></div>' +
        '<div class="pdf-row"><label class="pdf-lb">确认密码</label>' +
        '<input type="text" id="ecUser2" placeholder="再输一次" autocomplete="new-password" style="flex:1"></div>' +
        '<div class="pdf-row"><label class="pdf-lb">属主密码</label>' +
        '<input type="text" id="ecOwner" placeholder="留空 = 与打开密码相同" autocomplete="new-password" style="flex:1"></div>' +
        '<div class="pdf-row"><label class="pdf-lb">强度</label>' +
        '<select id="ecAlg">' +
        '<option value="AES-256">AES-256（推荐，PDF 2.0 标准）</option>' +
        '<option value="AES-128">AES-128（兼容 2005 年后的阅读器）</option>' +
        '<option value="RC4-128">RC4-128（很老的阅读器，已不安全）</option>' +
        '</select></div>' +
        '<div class="pdf-checks">' +
        '<label><input type="checkbox" id="ecPrint" checked> 允许打印</label>' +
        '<label><input type="checkbox" id="ecCopy"> 允许复制文字</label>' +
        '<label><input type="checkbox" id="ecMod"> 允许修改内容</label>' +
        '</div>' +
        '<div class="pdf-warn">密码遗失无法找回。权限位属「君子协定」，正规阅读器会遵守，但拦不住专门的破解工具 —— 真正的门是打开密码。</div>' +
        '<div class="pdf-row"><button class="btn btn-pri" id="ecGo">加密并下载</button></div>';
    },
    bind: function (root) {
      U.$('#ecGo', root).onclick = function () {
        if (!needDoc()) return;
        var btn = this;
        var pw = U.$('#ecUser', root).value, pw2 = U.$('#ecUser2', root).value;
        var owner = U.$('#ecOwner', root).value;
        var alg = U.$('#ecAlg', root).value;
        if (!pw) { U.toast('请填写打开密码', 'err'); return; }
        if (pw !== pw2) { U.toast('两次输入的密码不一致', 'err'); return; }
        if (pw.length < 4) { U.toast('密码太短，建议至少 6 位', 'err'); return; }
        var allowPrint = U.$('#ecPrint', root).checked;
        var allowCopy = U.$('#ecCopy', root).checked;
        var allowMod = U.$('#ecMod', root).checked;
        withBusy(btn, '加密中…', function () {
          // 在一个副本上加密，不动当前工作文档
          return U.loadPdfLib().then(function (PDFLib) {
            return S.doc.save().then(function (raw) {
              return PDFLib.PDFDocument.load(raw);
            }).then(function (tmp) {
              tmp.encrypt({
                userPassword: pw,
                ownerPassword: owner || pw,
                algorithm: alg,
                allowWeakCryptography: alg === 'RC4-128',
                permissions: {
                  // 禁止打印必须传 false；传字符串 'none' 会被当成「允许」处理（实测确认）
                  printing: allowPrint ? 'highResolution' : false,
                  copying: allowCopy,
                  modifying: allowMod,
                  annotating: allowMod,
                  fillingForms: true,
                  contentAccessibility: true,
                  documentAssembly: allowMod
                }
              });
              return tmp.save();
            });
          }).then(function (u8) {
            status('已加密输出 · ' + fmtSize(u8.length) + ' · ' + alg);
            U.saveBlob(baseName(S.name) + '_加密.pdf', toBlob(u8));
          });
        });
      };
    }
  };

  /* ---------- 解锁 ---------- */
  PANE.unlock = {
    html: function () {
      return '<div class="pdf-tip">适用两种情况：<br>' +
        '① 能正常打开，但禁止打印 / 复制 / 修改 → <b>密码留空</b><br>' +
        '② 需要密码才能打开 → <b>填入该密码</b></div>' +
        '<div class="pdf-row"><label class="pdf-lb">打开密码</label>' +
        '<input type="text" id="ulPw" placeholder="没有就留空" autocomplete="off" style="flex:1"></div>' +
        '<div class="pdf-warn">解锁会重建文件结构，书签、表单域、批注<b>可能丢失</b>，页面内容与排版不受影响。</div>' +
        '<div class="pdf-row"><button class="btn btn-pri" id="ulGo">解除限制并下载</button>' +
        '<span class="pdf-hint-inline" id="ulInfo"></span></div>';
    },
    bind: function (root) {
      var info = U.$('#ulInfo', root);
      function refresh() {
        if (!S.bytes) { info.textContent = ''; return; }
        info.textContent = isEncryptedBytes(S.bytes) ? '检测到该文件带加密标记' : '该文件看起来没有加密保护';
      }
      refresh();
      U.$('#ulGo', root).onclick = function () {
        if (!needDoc()) return;
        var btn = this, pw = U.$('#ulPw', root).value;
        withBusy(btn, '处理中…', function () {
          return U.loadPdfLib().then(function (PDFLib) {
            var loadFirst;
            if (pw) loadFirst = PDFLib.PDFDocument.load(S.bytes, { password: pw });
            else {
              loadFirst = PDFLib.PDFDocument.load(S.bytes).catch(function (e) {
                if (/encrypted|password/i.test(String(e.message))) {
                  return PDFLib.PDFDocument.load(S.bytes, { password: '' });
                }
                throw e;
              });
            }
            return loadFirst.then(function (src) {
              // 关键：必须 copyPages 重建，直接 save 会保留 /Encrypt 字典
              return PDFLib.PDFDocument.create().then(function (out) {
                return out.copyPages(src, src.getPageIndices()).then(function (pgs) {
                  pgs.forEach(function (p) { out.addPage(p); });
                  return out.save();
                });
              });
            });
          }).then(function (u8) {
            var ok = !isEncryptedBytes(u8);
            status(ok ? '已解除限制 · ' + fmtSize(u8.length) : '输出仍带加密标记，可能密码有误');
            U.saveBlob(baseName(S.name) + '_已解锁.pdf', toBlob(u8));
          });
        });
      };
    }
  };

  /* ---------- 提取图片 ---------- */
  PANE.extract = {
    html: function () {
      return '<div class="pdf-tip">把 PDF 里内嵌的图片单独取出来。JPEG 会原样导出（零损失），' +
        '无损压缩的 RGB / 灰度图会转成 PNG。' +
        '<br>若某页是「整页扫描成一张图」，会得到一张整页图；文字型 PDF 通常没有可提取的图片。</div>' +
        '<div class="pdf-row"><button class="btn btn-pri" id="exGo">开始提取</button>' +
        '<span class="pdf-hint-inline" id="exInfo"></span></div>';
    },
    bind: function (root) {
      U.$('#exGo', root).onclick = function () {
        if (!needDoc()) return;
        var btn = this, info = U.$('#exInfo', root);
        withBusy(btn, '提取中…', function () {
          return U.loadPdfLib().then(function (PDFLib) {
            var PN = PDFLib.PDFName, PD = PDFLib.PDFDict;
            var out = [], skipped = 0, seen = 0;
            var pages = S.doc.getPages();
            pages.forEach(function (page, pi) {
              var res;
              try { res = page.node.Resources(); } catch (e) { return; }
              if (!res) return;
              var xo = res.lookup(PN.of('XObject'), PD);
              if (!xo) return;
              xo.keys().forEach(function (key) {
                var stream;
                try { stream = S.doc.context.lookup(xo.get(key)); } catch (e) { return; }
                if (!stream || !stream.dict) return;
                var sub;
                try { sub = stream.dict.lookup(PN.of('Subtype')); } catch (e) { return; }
                if (!sub || String(sub) !== '/Image') return;
                seen++;
                var nm = String(key).replace(/^\//, '');
                var base = 'p' + U.pad(pi + 1, String(pages.length).length) + '_' + nm;
                var r = imageFromStream(PDFLib, stream, nm);
                if (r) out.push({ name: base + '.' + r.ext, data: r.data, page: pi + 1 });
                else skipped++;
              });
            });
            function imageFromStream(PDFLib, stream, nm) {
              var dict = stream.dict;
              var filt;
              try { filt = dict.lookup(PN.of('Filter')); } catch (e) { return null; }
              var fs = filt ? String(filt) : '';
              // 只有「纯 DCTDecode」（没有 Flate / LZW 等外层包裹）才能直接当 JPEG 文件导出
              var plainDct = fs.indexOf('DCTDecode') >= 0 &&
                !/FlateDecode|LZWDecode|ASCII85Decode|ASCIIHexDecode|RunLengthDecode/.test(fs);
              if (plainDct) {
                var raw = new Uint8Array(stream.getContents ? stream.getContents() : stream.contents);
                if (raw.length < 4) return null;
                // 有些流带 Exif / JFIF 前缀，往后找 JPEG 的 SOI 标记 FF D8
                if (!(raw[0] === 0xFF && raw[1] === 0xD8)) {
                  for (var k = 0; k < Math.min(raw.length - 1, 1024); k++) {
                    if (raw[k] === 0xFF && raw[k + 1] === 0xD8) { raw = raw.subarray(k); break; }
                  }
                }
                if (!(raw[0] === 0xFF && raw[1] === 0xD8)) return null;
                return { ext: 'jpg', data: raw };
              }
              return null;                                  // 其他格式交给调用方计数跳过
            }
            if (!seen) { info.textContent = '这个 PDF 里没有内嵌图片（多半是纯文字型）'; return Promise.resolve(); }
            if (!out.length) {
              info.textContent = '找到 ' + seen + ' 张图片，但都不是 JPEG 格式，暂时无法直接导出。可改用「转图片」功能按页导出。';
              return Promise.resolve();
            }
            var files = out.map(function (f) { return { name: f.name, data: f.data }; });
            U.saveBlob(baseName(S.name) + '_图片' + out.length + '张.zip', U.zipStore(files));
            info.textContent = '导出 ' + out.length + ' 张' + (skipped ? '，另有 ' + skipped + ' 张非 JPEG 格式已跳过' : '');
            return Promise.resolve();
          });
        });
      };
    }
  };

  /* ---------- 转图片 ---------- */
  PANE.toimage = {
    html: function () {
      var webp = '';
      return '<div class="pdf-row"><label class="pdf-lb">格式</label>' +
        '<select id="tiFmt">' +
        '<option value="image/jpeg">JPG（照片推荐）</option>' +
        '<option value="image/png">PNG（无损，最大）</option>' +
        '<option value="image/webp">WebP（最小）</option>' +
        '</select></div>' +
        '<div class="pdf-row"><label class="pdf-lb">清晰度</label>' +
        '<select id="tiDpi">' +
        '<option value="72">72 DPI · 屏幕预览</option>' +
        '<option value="96">96 DPI</option>' +
        '<option value="150" selected>150 DPI · 推荐</option>' +
        '<option value="200">200 DPI · 高清</option>' +
        '<option value="300">300 DPI · 打印级</option>' +
        '</select></div>' +
        '<div class="pdf-row" id="tiQRow"><label class="pdf-lb">画质</label>' +
        '<input type="range" id="tiQ" min="40" max="100" value="88" style="flex:1">' +
        '<span class="pdf-val" id="tiQv">88</span></div>' +
        '<div class="pdf-row"><label class="pdf-lb">页面范围</label>' +
        '<input type="text" id="tiPages" placeholder="留空 = 全部，如 1-3,5" style="flex:1"></div>' +
        '<div class="pdf-row"><label class="pdf-lb">输出</label>' +
        '<select id="tiOut">' +
        '<option value="zip">打包成 ZIP</option>' +
        '<option value="each">逐张下载</option>' +
        '</select></div>' +
        '<div class="pdf-row"><button class="btn btn-pri" id="tiGo">开始转换</button>' +
        '<span class="pdf-hint-inline" id="tiInfo"></span></div>' + webp;
    },
    bind: function (root) {
      var q = U.$('#tiQ', root), fmt = U.$('#tiFmt', root);
      q.oninput = function () { U.$('#tiQv', root).textContent = q.value; };
      function syncQ() { U.$('#tiQRow', root).hidden = fmt.value === 'image/png'; }
      fmt.onchange = syncQ; syncQ();
      U.$('#tiGo', root).onclick = function () {
        if (!needDoc()) return;
        var btn = this, info = U.$('#tiInfo', root);
        var mime = fmt.value, dpi = parseInt(U.$('#tiDpi', root).value, 10);
        var qual = parseInt(q.value, 10) / 100;
        var way = U.$('#tiOut', root).value;
        var ext = mime === 'image/jpeg' ? 'jpg' : (mime === 'image/png' ? 'png' : 'webp');
        var rg = parseRanges(U.$('#tiPages', root).value, S.pages);
        if (rg.bad.length) { U.toast('页码写错了：' + rg.bad.join(' '), 'err'); return; }
        var list = rg.list.length ? rg.list : Array.apply(null, { length: S.pages }).map(function (_, i) { return i + 1; });
        var pdf = null, files = [], ok = false;
        withBusy(btn, '转换中…', function () {
          return U.pdfOpen(S.bytes.slice()).then(function (d) {
            pdf = d;
            var i = 0;
            return (function step() {
              if (i >= list.length) return Promise.resolve();
              var n = list[i];
              return pdf.getPage(n).then(function (page) {
                var vp0 = page.getViewport({ scale: 1 });
                var scale = dpi / 72;
                while (vp0.width * scale * vp0.height * scale > 4e7 && scale > 0.3) scale *= 0.75;
                var vp = page.getViewport({ scale: scale });
                var cv = document.createElement('canvas');
                cv.width = Math.max(1, Math.floor(vp.width));
                cv.height = Math.max(1, Math.floor(vp.height));
                var ctx = cv.getContext('2d');
                if (mime !== 'image/png') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); }
                return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
                  return cvBlob(cv, mime, qual);
                }).then(function (b) {
                  return b.arrayBuffer();
                }).then(function (ab) {
                  var nm = baseName(S.name) + '_p' + U.pad(n, String(S.pages).length) + '.' + ext;
                  if (way === 'each') U.saveBlob(nm, new Blob([ab], { type: mime }));
                  else files.push({ name: nm, data: new Uint8Array(ab) });
                });
              }).then(function () {
                i++;
                status('正在转换 ' + i + '/' + list.length + ' 页…');
                return new Promise(function (r) { setTimeout(r, 0); }).then(step);
              });
            })();
          }).then(function () { ok = true; });
        }).then(function () {
          if (pdf) { try { pdf.destroy(); } catch (e) { } }
          if (!ok) return;
          if (way === 'zip') {
            if (!files.length) { info.textContent = '没有生成任何图片'; return; }
            status('已转换 ' + files.length + ' 页');
            U.saveBlob(baseName(S.name) + '_图片' + files.length + '张.zip', U.zipStore(files));
            info.textContent = '共 ' + files.length + ' 张 · ' + ext.toUpperCase();
          } else {
            status('已逐张下载 ' + list.length + ' 张');
            info.textContent = '共 ' + list.length + ' 张';
          }
        });
      };
    }
  };

  /* =====================================================================
   *  PDF → Excel / Word
   * ===================================================================== */

  /* 共用状态：记录当前解析出的各页内容，供预览与导出共用，
     这样「调整参数」不必重新解析 PDF（解析要加载渲染库、较慢）。
     deep = 这次解析有没有连带读「矢量图形 + 位图」（版面复刻模式需要）。
     Excel 那边不需要图形，所以共用同一份缓存时会有一深一浅两种结果。 */
  var P2O = {
    key: '', pages: [], bounds: null, warn: '', mergeCell: true,
    deep: false, mode: 'layout', bodySize: 0
  };

  /** office-write.js 按需加载（只有用到 PDF→Office 时才拉，不在首屏付代价） */
  function loadOW() {
    if (U.ow) return Promise.resolve(U.ow);
    return U.loadScript('assets/js/office-write.js').then(function () {
      if (!U.ow) throw new Error('转换模块未能初始化');
      return U.ow;
    });
  }

  /**
   * 追加清理函数，而不是覆盖 root._cleanup。
   * app.js 关面板时只调用一次 _cleanup；若直接赋值，先注册的监听器就永远摘不掉。
   */
  function addCleanup(root, fn) {
    var prev = root._cleanup;
    root._cleanup = prev ? function () { prev(); fn(); } : fn;
  }

  function p2oKey() { return S.name + '|' + S.size + '|' + S.pages; }

  /**
   * pdf.js 解好的位图（page.objs）→ PNG base64。
   *
   * 为什么交给 canvas：pdf.js 的像素有三种格式（1bpp 灰度 / RGB / RGBA），
   * 自己写 PNG 编码要cover三种；canvas 一次解决，还能拿到不错的压缩率。
   * 注意它的 data 是**未乘 alpha 的直通值**（RGB 格式也一样占 4 byte/像素），
   * 所以直接搬、保留透明通道即可 —— 合同上的印章/签名本来是透明底。
   */
  function imgB64(obj) {
    var w = obj.width | 0, h = obj.height | 0, d = obj.data;
    if (!w || !h || !d || !d.length) return '';
    var n = w * h;
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d');
    if (!ctx) return '';
    var im, o, i, k;
    try { im = ctx.createImageData(w, h); } catch (e) { return ''; }
    o = im.data;
    if (obj.kind === 1) {                 // 1bpp 灰度：1 byte 塞 8 个像素，高位在前
      var stride = (w + 7) >> 3;
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var v = ((d[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1) ? 255 : 0;
          k = (y * w + x) * 4;
          o[k] = o[k + 1] = o[k + 2] = v; o[k + 3] = 255;
        }
      }
    } else {
      var ch = d.length >= n * 4 ? 4 : 3;
      for (i = 0; i < n; i++) {
        var j = i * ch; k = i * 4;
        o[k] = d[j]; o[k + 1] = d[j + 1]; o[k + 2] = d[j + 2];
        o[k + 3] = ch === 4 ? d[j + 3] : 255;
      }
    }
    ctx.putImageData(im, 0, 0);
    return String(cv.toDataURL('image/png')).replace(/^data:[^,]*,/, '');
  }

  /**
   * VML path → SVG path（只服务「版面预览」）。
   *
   * office-write.js 为了塞进 Word 的 VML 才用 VML 路径语法，它的规矩是
   * 「一个命令字母后面可以跟**多组**坐标」（`l1,2 3,4 5,6` 就等于三次 lineto），
   * SVG 则要求每个点都带命令。这里把那套规则展开。
   */
  function vml2svg(d) {
    var s = String(d || ''), i = 0, n = s.length, out = '';
    function rd() {                        // 读一组「x,y」，回传 "x y"
      while (i < n && (s[i] === ' ' || s[i] === ',')) i++;
      var st = i;
      while (i < n && (s[i] === '-' || (s[i] >= '0' && s[i] <= '9'))) i++;
      var a = s.slice(st, i);
      while (i < n && (s[i] === ' ' || s[i] === ',')) i++;
      st = i;
      while (i < n && (s[i] === '-' || (s[i] >= '0' && s[i] <= '9'))) i++;
      return a + ' ' + s.slice(st, i);
    }
    while (i < n) {
      var c = s[i];
      if (c === ' ') { i++; continue; }
      if (c === 'e') break;
      if (c === 'x') { out += 'Z '; i++; continue; }
      /* 注意：一定要**先把命令字母跳过去**再读坐标。
       * rd() 会从当前位置开始扫数字，若还没跳过 'm' 就直接调它，
       * 读到的会是空字符串（'m' 既不是分隔符也不是数字）。 */
      if (c === 'm' || c === 'l') { i++; out += (c === 'm' ? 'M' : 'L') + rd() + ' '; continue; }
      if (c === 'q') { i += 2; out += 'Q' + rd() + ' ' + rd() + ' '; continue; }   // qb
      if (c === 'c') { i++; out += 'C' + rd() + ' ' + rd() + ' ' + rd() + ' '; continue; }
      i++;                                 // 认不出来就跳过，别让预览整页崩掉
    }
    return out.trim();
  }

  /**
   * 逐页读取「文字项 + 真实框线」（一页一让，避免大文件卡死主线程）。
   *
   * 框线为什么要单独读：PDF 的表格边框是**矢量描边 / 填充矩形**，
   * 完全不在文字层里 —— getTextContent() 一根都拿不到。
   * 改走 getOperatorList() 之后格线就是「算出来的」：
   * 栏位精确、合并格可判定、格内折行自动归到同一格。
   * 拿不到框线（结构特殊的 PDF）不报错，自动退回文字空隙法。
   */
  function readText(pdf, list, onStep, deep) {
    var out = [], i = 0, OPS = null;
    return U.loadPdfJs().then(function (pj) {
      OPS = pj.OPS;
      return (function step() {
        if (i >= list.length) return Promise.resolve(out);
        var n = list[i];
        var cur = { page: n, items: [], rules: null };
        return pdf.getPage(n).then(function (page) {
          /* 尺寸取**未旋转**的页面盒：内容流的坐标就在这个空间里，
           * 转 90° 的页面用 viewport 尺寸会反掉（矢量全画到纸外）。
           * 代价是旋转页的 Word 出来是「躺着的正内容」—— Word 本身没法转页。 */
          var vb = page.view, vp = page.getViewport({ scale: 1 });
          cur.width = (vb && vb.length === 4) ? Math.abs(vb[2] - vb[0]) : vp.width;
          cur.height = (vb && vb.length === 4) ? Math.abs(vb[3] - vb[1]) : vp.height;
          return page.getTextContent().then(function (tc) {
            cur.items = U.ow.normalize(tc.items);
            if (!OPS) return null;
            return page.getOperatorList().then(function (ol) {
              cur.rules = U.ow.rulesFromOps(ol, OPS);
              if (!deep) return null;
              return readLayoutBits(page, ol, OPS, cur);
            }).catch(function () { /* 取不到就当没有框线/图形 */ });
          });
        }).then(function () {
          out.push(cur);
          i++;
          if (onStep) onStep(i, list.length, n);
          return new Promise(function (r) { setTimeout(r, 0); }).then(step);
        });
      })();
    });
  }

  /**
   * 「版面复刻」额外要的两样东西：矢量图形（表格框线、色块）与位图（印章、签名）。
   * 都从同一份 operatorList 里算，文字层（getTextContent）一根线都拿不到。
   */
  function readLayoutBits(page, ol, OPS, cur) {
    cur.paths = U.ow.pathsFromOps(ol, OPS, { pageW: cur.width, pageH: cur.height });
    var ims = U.ow.imagesFromOps(ol, OPS, {});
    cur.skipped = 0;
    cur.images = ims.map(function (im) {
      if (!im.name) return null;
      var obj = null;
      try { obj = page.objs.get(im.name); } catch (e) { obj = null; }
      if (!obj || !obj.data) { cur.skipped++; return null; }
      /* 超大位图（扫描底图之类）不搬进 docx：一是没必要，二是主线程会卡住。
       * 12MP ≈ 4000×3000，超过就不可能是印章/签名了。 */
      if ((obj.width | 0) * (obj.height | 0) > 12000000) { cur.skipped++; return null; }
      var b64 = imgB64(obj);
      if (!b64) { cur.skipped++; return null; }
      return { x: im.x, y: im.y, w: im.w, h: im.h, b64: b64, ext: 'png' };
    }).filter(Boolean);
    return null;
  }

  /** 页面范围 → 页码数组 */
  function pageListOf(input, max) {
    var rg = parseRanges(input, max);
    if (rg.bad.length) return { bad: rg.bad };
    return { list: rg.list.length ? rg.list : Array.apply(null, { length: max }).map(function (_, i) { return i + 1; }) };
  }

  /** 扫描件判断：文字量少得离谱 */
  function scanWarn(pages) {
    var chars = pages.reduce(function (a, p) {
      return a + p.items.reduce(function (b, it) { return b + it.str.length; }, 0);
    }, 0);
    var per = pages.length ? chars / pages.length : 0;
    if (!chars) {
      return '这个 PDF 一页文字都没读出来，基本可以确定是<b>扫描件</b>（整页是图片）。' +
        '文字型 PDF 才能转，扫描件请先用 OCR 工具。';
    }
    if (per < 25) {
      return '平均每页只读到 ' + Math.round(per) + ' 个字，很少 —— 可能大部分页面是扫描图。' +
        '如果预览里大片空白，就是这个原因。';
    }
    return '';
  }

  /**
   * 每页重新分列。优先级（在 office-write.js 里实现）：
   *   手动指定的列边界  >  该页的真实框线  >  文字空隙法
   */
  function buildGrids(opt) {
    return P2O.pages.map(function (p) {
      var o = { mergeFill: opt.mergeFill };
      if (p.rules) o.rules = p.rules;
      if (P2O.bounds) o.bounds = P2O.bounds;
      var res = U.ow.rowsFromItems(p.items, o);
      return { page: p.page, res: res };
    });
  }

  /** 该页各栏的实际宽度（pt）—— 给 Excel 还原列宽用，导出版面才接近原 PDF */
  function colWidthsOf(res) {
    return res.bands.map(function (b) { return b.x1 - b.x0; });
  }

  /** 取出某一行里的「真实合并格」跨度，转成 Excel 的 0 基范围 */
  function collectMerges(res, ri, outRow, into) {
    if (!res.byRules || !res.rows[ri]) return;
    (res.rows[ri].cells || []).forEach(function (c) {
      var cs = c.span || 1, rs = c.rs || 1;
      if (cs < 2 && rs < 2) return;
      into.push({ r0: outRow, c0: c.col, r1: outRow + rs - 1, c1: c.col + cs - 1 });
    });
  }

  /** 预览表格（列宽按各列 PDF 实际宽度成比例） */
  function prevTable(res, maxRows) {
    if (!res.grid.length) return '<div class="p2o-none">这一页没读到表格内容</div>';
    var span = res.maxX - res.minX || 1;
    var cols = res.bands.map(function (b) {
      return '<col style="width:' + ((b.x1 - b.x0) / span * 100).toFixed(3) + '%">';
    }).join('');
    var n = Math.min(res.grid.length, maxRows || 200);
    var body = '';
    for (var i = 0; i < n; i++) {
      body += '<tr>' + res.grid[i].map(function (c) {
        return '<td title="' + U.esc(c) + '">' + (U.esc(c) || '<i class="p2o-e"></i>') + '</td>';
      }).join('') + '</tr>';
    }
    if (res.grid.length > n) {
      body += '<tr><td class="p2o-more" colspan="' + res.colCount + '">… 还有 ' +
        (res.grid.length - n) + ' 行未显示（导出时会全部包含）</td></tr>';
    }
    return '<table class="p2o-tbl"><colgroup>' + cols + '</colgroup><tbody>' + body + '</tbody></table>';
  }

  /** 列边界把手（可拖拽） */
  function prevRuler(res) {
    var span = res.maxX - res.minX || 1;
    var hs = '';
    // 首尾不画把手（拖不了，会跑出范围）
    for (var i = 1; i < res.bands.length; i++) {
      var pct = (res.bands[i].x0 - res.minX) / span * 100;
      hs += '<div class="p2o-h" data-h="' + i + '" style="left:' + pct.toFixed(3) + '%">' +
        '<i></i></div>';
    }
    return '<div class="p2o-ruler" id="p2oRuler">' + hs + '</div>';
  }

  /** 把「拖动后的像素位置」换算回 PDF 坐标 */
  function px2pdf(px, stageW, res) {
    var span = res.maxX - res.minX || 1;
    return res.minX + Math.max(0, Math.min(1, px / stageW)) * span;
  }

  /**
   * 挂上拖拽 / 新增 / 删除分隔线的交互。
   *
   * 两个必须注意的点：
   *  1. 标尺宽度必须与「表格实际宽度」严格一致。表格在 overflow:auto 容器里，
   *     出现纵向滚动条时可用宽度会少约 15px；若拿外层容器宽度当基准，百分比就会
   *     整体偏移，拖动时线和列对不上。这里直接量表格自己的 getBoundingClientRect()。
   *  2. 拖拽的 mousemove/mouseup 只在「按下到松开」这段时间挂在 window 上，
   *     松手立刻摘掉 —— 不能常驻 document，否则每次重绘都累加一份监听器。
   */
  function bindRuler(root, res, onChange) {
    var ruler = U.$('#p2oRuler', root);
    if (!ruler) return;
    var wrap = ruler.parentNode.querySelector('.p2o-tblwrap');
    var tbl = wrap && wrap.querySelector('.p2o-tbl');

    /* 让标尺的宽度 = 表格的实际渲染宽度 */
    function syncWidth() {
      if (!tbl) return;
      var w = tbl.getBoundingClientRect().width;
      if (w > 0) ruler.style.width = w + 'px';
    }
    syncWidth();
    var onResize = function () { syncWidth(); };
    window.addEventListener('resize', onResize);
    addCleanup(root, function () { window.removeEventListener('resize', onResize); });

    var dragging = null, startPX = 0, startLeft = '';

    function curBounds() {
      var b = P2O.bounds;
      if (!b) {
        b = [res.minX];
        res.bands.forEach(function (x) { b.push(x.x1); });
        P2O.bounds = b;
      }
      return b.slice();
    }
    function commit(arr, label) {
      arr.sort(function (a, b) { return a - b; });
      var out = [arr[0]];
      for (var i = 1; i < arr.length; i++) {
        if (arr[i] - out[out.length - 1] >= 6) out.push(arr[i]);   // 过窄的列没意义
      }
      if (out.length < 2) { U.toast('这样就没有列了，已撤销', 'err'); return false; }
      P2O.bounds = out;
      onChange(label);
      return true;
    }
    function pdfAt(clientX) {
      var r = ruler.getBoundingClientRect();
      return px2pdf(clientX - r.left, r.width, res);
    }

    U.$$('.p2o-h', ruler).forEach(function (h) {
      h.onmousedown = function (e) {
        e.preventDefault();
        e.stopPropagation();
        dragging = Number(h.dataset.h);
        startPX = pdfAt(e.clientX);
        startLeft = h.style.left;
        h.classList.add('drag');
        document.body.style.cursor = 'col-resize';
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      };
      h.ondblclick = function (e) {                      // 双击删掉这条分隔线
        e.stopPropagation();
        var arr = curBounds();
        var idx = Number(h.dataset.h);
        if (idx <= 0 || idx >= arr.length) return;
        arr.splice(idx, 1);
        commit(arr, '已删除一条分隔线');
      };
    });

    /* 拖拽期间只移动线本身、不重算表格 —— 每帧重绘整表会明显发顿 */
    function onMove(e) {
      if (dragging == null) return;
      var r = ruler.getBoundingClientRect();
      var px = Math.max(0, Math.min(r.width, e.clientX - r.left));
      var el = ruler.querySelector('[data-h="' + dragging + '"]');
      if (el) el.style.left = px + 'px';                 // 固定像素，避免百分比在拖动中跳动
    }
    function onUp(e) {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      if (dragging == null) return;
      var arr = curBounds();
      var idx = dragging;
      var el = ruler.querySelector('[data-h="' + idx + '"]');
      if (el) el.classList.remove('drag');
      dragging = null;
      var x = pdfAt(e.clientX);
      if (Math.abs(x - startPX) < 1.5) {
        /* 没真正移动（多半是双击的第一下）：把线还原，并且**不要重绘**。
           重绘会换掉整个 handle 元素，浏览器后续的 dblclick 就找不到目标，
           「双击删除分隔线」会永远失效 —— 这个坑踩过一次。 */
        if (el && startLeft) el.style.left = startLeft;
        return;
      }
      arr[idx] = x;
      commit(arr, '列边界已调整（对所有页生效）');
    }

    ruler.onmousedown = function (e) {
      if (e.target.closest && e.target.closest('.p2o-h')) return;
      var arr = curBounds();
      var x = pdfAt(e.clientX);                          // 点空白处 = 在该处新增一条
      if (x - arr[0] < 6 || arr[arr.length - 1] - x < 6) return;
      arr.push(x);
      commit(arr, '已新增一条分隔线');
    };
  }

  /* ---------- PDF 转 Excel ---------- */
  PANE.toxlsx = {
    html: function () {
      return '<div class="pdf-tip">把 PDF 里的<b>表格</b>提取成 Excel（.xlsx）。' +
        '只支持<b>文字型 PDF</b>（能用鼠标选中文字的）—— 扫描件是整页图片，读不出内容。' +
        '数字会写成真正的数值，Excel 里可直接求和、排序。</div>' +
        '<div class="pdf-row"><label class="pdf-lb">页面范围</label>' +
        '<input type="text" id="xPages" placeholder="留空 = 全部，如 1-3,5" style="flex:1"></div>' +
        '<div class="pdf-row"><button class="btn btn-pri" id="xRead">读取并识别</button>' +
        '<span class="pdf-hint-inline" id="xInfo"></span></div>' +
        '<div id="xOut"></div>';
    },
    bind: function (root) {
      U.$('#xRead', root).onclick = function () {
        if (!needDoc()) return;
        var btn = this, info = U.$('#xInfo', root);
        var pg = pageListOf(U.$('#xPages', root).value, S.pages);
        if (pg.bad) { U.toast('页码写错了：' + pg.bad.join(' '), 'err'); return; }
        P2O.bounds = null;
        P2O.mergeCell = true;
        withBusy(btn, '读取中…', function () {
          var pdf = null;
          return loadOW().then(function () {
            return U.pdfOpen(S.bytes.slice());
          }).then(function (d) {
            pdf = d;
            return readText(pdf, pg.list, function (i, n) {
              status('正在读取第 ' + i + ' / ' + n + ' 页…');
            });
          }).then(function (pages) {
            P2O.pages = pages;
            P2O.key = p2oKey();
            P2O.warn = scanWarn(pages);
            status('');
            var rows = 0, byR = 0;
            pages.forEach(function (p) {
              var o = {};
              if (p.rules) o.rules = p.rules;
              var rr = U.ow.rowsFromItems(p.items, o);
              rows += rr.grid.length;
              if (rr.byRules) byR++;
            });
            info.textContent = pages.length + ' 页 · 共 ' + rows + ' 行' +
              (byR ? '（其中 ' + byR + ' 页用框线精确定位）' : '');
            renderX(root);
          }).then(function () { if (pdf) { try { pdf.destroy(); } catch (e) { } } });
        });
      };
      if (P2O.key === p2oKey() && P2O.pages.length) renderX(root);
    }
  };

  /** 渲染 Excel 预览区（含调列把手） */
  function renderX(root) {
    var out = U.$('#xOut', root);
    if (!out) return;
    if (P2O.key !== p2oKey() || !P2O.pages.length) { out.innerHTML = ''; return; }
    var mf = P2O.mergeCell !== false;
    var grids = buildGrids({ mergeFill: mf });
    var cur = Math.min(renderX._p || 0, grids.length - 1);
    var g = grids[cur];
    var manual = !!P2O.bounds;

    var warn = P2O.warn ? '<div class="p2o-warn">' + P2O.warn + '</div>' : '';
    var tabs = '';
    if (grids.length > 1) {
      tabs = '<div class="p2o-tabs">' + grids.map(function (x, i) {
        return '<button class="' + (i === cur ? 'on' : '') + '" data-pg="' + i + '">' +
          '第 ' + x.page + ' 页</button>';
      }).join('') + '</div>';
    }

    out.innerHTML = warn +
      '<div class="t-section"><div class="sec-t">核对识别结果' +
      (grids.length > 1 ? '（第 ' + g.page + ' 页，共 ' + grids.length + ' 页）' : '') + '</div>' +
      '<div class="p2o-note">' +
      '<b>拖动竖线</b>调整列边界 · <b>双击竖线</b>删除 · <b>点标尺空白</b>新增一条' +
      (manual ? ' · <span class="p2o-man">列边界已手动指定，对所有页生效</span>' +
        '<button class="btn btn-sm" id="xAuto">恢复自动识别</button>' : '') +
      '</div>' +
      tabs +
      '<div class="p2o-stage" id="p2oStage">' +
      prevRuler(g.res) +
      '<div class="p2o-tblwrap">' + prevTable(g.res) + '</div>' +
      '</div>' +
      '<div class="p2o-meta" id="xMeta"></div>' +
      '</div>' +

      '<div class="t-section"><div class="sec-t">导出设置</div>' +
      '<label class="ck"><input type="checkbox" id="xRealMerge">' +
      '<span>还原真实合并单元格' +
      '<br><i class="p2o-sub">PDF 有框线时能准确判定哪些格子是合并的（两栏之间没有竖线）。' +
      '勾选后版面与原件一致、便于打印；不勾则把合并格的值<b>展开填充</b>到每一格，' +
      '便于排序 / 筛选 / 做透视表。</i></span></label>' +
      '<label class="ck"><input type="checkbox" id="xMergeCell"' + (mf ? ' checked' : '') + '>' +
      '<span>无框线表格：纵向补齐（留空的格继承上方值）' +
      '<br><i class="p2o-sub">只对<b>没有框线</b>的表格生效 —— 那种情况只能靠猜，' +
      '若「合计」这类独立行被误填了值，取消勾选即可。' +
      '有框线的表格按真实合并格处理，不受此项影响。</i></span></label>' +
      '<label class="ck"><input type="checkbox" id="xMerge" checked>' +
      '<span>全部页合并到一个工作表（同一张表跨页时用；取消则每页一个工作表）</span></label>' +
      '<label class="ck"><input type="checkbox" id="xHead" checked>' +
      '<span>首行作为表头（加粗 + 冻结首行）</span></label>' +
      '<div class="pdf-row"><button class="btn btn-pri" id="xGo">导出 Excel</button>' +
      '<span class="pdf-hint-inline" id="xGoInfo"></span></div>' +
      '</div>';

    var meta = U.$('#xMeta', out);
    (function refreshMeta() {
      var r = g.res;
      var cells = r.grid.reduce(function (a, row) {
        return a + row.filter(function (x) { return x; }).length;
      }, 0);
      meta.innerHTML = '识别到 <b>' + r.colCount + '</b> 列 × <b>' + r.rowCount + '</b> 行 · ' +
        cells + ' 个非空单元格' +
        (r.byRules
          ? ' · <b class="p2o-ok">已用 PDF 框线定位</b>（栏位精确、合并格按真实判定）'
          : ' · <span class="p2o-guess">该页找不到框线，按文字位置推断</span>') +
        (r.filledCells ? ' · ' + r.filledCells + ' 格由合并填充' : '');
    })();

    function redraw(msg) {
      if (msg) U.toast(msg, 'ok');
      renderX(root);
    }
    bindRuler(out, g.res, redraw);

    U.$$('[data-pg]', out).forEach(function (b) {
      b.onclick = function () { renderX._p = Number(b.dataset.pg); renderX(root); };
    });
    var auto = U.$('#xAuto', out);
    if (auto) auto.onclick = function () { P2O.bounds = null; redraw('已恢复自动识别'); };
    // 展开填充是启发式：默认开（纵向合并格才读得到值），误判时可关掉看原始留空
    U.$('#xMergeCell', out).onchange = function () {
      P2O.mergeCell = this.checked;
      renderX(root);
    };

    U.$('#xGo', out).onclick = function () {
      var btn = this, gi = U.$('#xGoInfo', out);
      var merge = U.$('#xMerge', out).checked;
      var head = U.$('#xHead', out).checked;
      var realMerge = U.$('#xRealMerge', out).checked;
      withBusy(btn, '生成中…', function () {
        var gs = buildGrids({ mergeFill: P2O.mergeCell !== false });
        var sheets = [];
        if (merge) {
          var all = [], merges = [], heights = [], firstHead = null, colW = null;
          gs.forEach(function (x, idx) {
            var r = x.res;
            if (!colW && r.byRules) colW = colWidthsOf(r);
            r.grid.forEach(function (row, ri) {
              // 跨页的同一张表，第 2 页起会重复出现表头行 → 去掉，否则 Excel 里表头夹在中间
              if (idx > 0 && ri === 0 && firstHead &&
                JSON.stringify(row) === JSON.stringify(firstHead)) return;
              all.push(row);
              heights.push(r.rows[ri] ? r.rows[ri].h : 0);
              if (realMerge) collectMerges(r, ri, all.length - 1, merges);
            });
            if (idx === 0) firstHead = r.grid[0] || null;
          });
          if (!all.length) throw new Error('没有可导出的内容');
          sheets.push({
            name: 'Sheet1', rows: all, headerBold: head, freezeHeader: head,
            colWidths: colW, rowHeights: heights,
            merges: realMerge ? merges : null
          });
        } else {
          gs.forEach(function (x) {
            if (!x.res.grid.length) return;
            var m2 = [], h2 = [];
            x.res.grid.forEach(function (row, ri) {
              h2.push(x.res.rows[ri] ? x.res.rows[ri].h : 0);
              if (realMerge) collectMerges(x.res, ri, ri, m2);
            });
            sheets.push({
              name: 'P' + x.page, rows: x.res.grid,
              headerBold: head, freezeHeader: head,
              colWidths: x.res.byRules ? colWidthsOf(x.res) : null,
              rowHeights: h2,
              merges: realMerge ? m2 : null
            });
          });
          if (!sheets.length) throw new Error('没有可导出的内容');
        }
        var blob = U.ow.buildXlsx(sheets, {});
        var nm = baseName(S.name) + '_表格.xlsx';
        U.saveBlob(nm, blob);
        var total = sheets.reduce(function (a, s) { return a + s.rows.length; }, 0);
        gi.textContent = sheets.length + ' 个工作表 · ' + total + ' 行 · ' + fmtSize(blob.size);
        status('已导出 ' + nm);
      });
    };
  }

  /* ---------- PDF 转 Word ---------- */
  PANE.todocx = {
    html: function () {
      return '<div class="pdf-tip">把 PDF 转成 Word（.docx）。两种模式：' +
        '<br>· <b>原版版面</b>：按 PDF 的<b>真实坐标</b>排 —— 表格框线、分区位置、' +
        '盖章签名都照搬，打开就是原件那个样子。适合要「看起来一模一样」的场合。' +
        '<br>· <b>流式文档</b>：把内容重新排成「标题 + 段落 + 表格」的规范文档，' +
        '版面跟原件不同，但方便二次编辑。' +
        '<br>两种都只支持<b>文字型 PDF</b>（扫描件请先用 OCR）。</div>' +
        '<div class="pdf-row"><label class="pdf-lb">转换模式</label>' +
        '<div class="seg" id="dMode">' +
        '<button class="seg-b on" data-m="layout">原版版面</button>' +
        '<button class="seg-b" data-m="flow">流式文档</button>' +
        '</div></div>' +
        '<div class="pdf-row"><label class="pdf-lb">页面范围</label>' +
        '<input type="text" id="dPages" placeholder="留空 = 全部，如 1-3,5" style="flex:1"></div>' +
        '<div class="pdf-row"><button class="btn btn-pri" id="dRead">读取并预览</button>' +
        '<span class="pdf-hint-inline" id="dInfo"></span></div>' +
        '<div id="dOut"></div>';
    },
    bind: function (root) {
      U.$('#dRead', root).onclick = function () {
        if (!needDoc()) return;
        var btn = this, info = U.$('#dInfo', root);
        var pg = pageListOf(U.$('#dPages', root).value, S.pages);
        if (pg.bad) { U.toast('页码写错了：' + pg.bad.join(' '), 'err'); return; }
        withBusy(btn, '读取中…', function () {
          var pdf = null;
          return loadOW().then(function () {
            return U.pdfOpen(S.bytes.slice());
          }).then(function (d) {
            pdf = d;
            /* 一律「深读」：版面模式要框线与印章，流式模式用不到但代价很小
             * （operatorList 本来就要取，图形只是顺手算一遍）。
             * 不这样做的話，两种模式会共存两份缓存，切模式就互相看不见。 */
            return readText(pdf, pg.list, function (i, n) {
              status('正在读取第 ' + i + ' / ' + n + ' 页…');
            }, true);
          }).then(function (pages) {
            P2O.pages = pages;
            P2O.key = p2oKey();
            P2O.bounds = null;
            P2O.deep = true;
            P2O.bodySize = U.ow.bodySizeOf(pages);
            P2O.warn = scanWarn(pages);
            status('');
            info.textContent = pages.length + ' 页';
            renderD(root);
          }).then(function () { if (pdf) { try { pdf.destroy(); } catch (e) { } } });
        });
      };

      var segs = root.querySelectorAll('#dMode .seg-b');
      Array.prototype.forEach.call(segs, function (b) {
        b.classList.toggle('on', b.getAttribute('data-m') === P2O.mode);
        b.onclick = function () {
          P2O.mode = b.getAttribute('data-m');
          Array.prototype.forEach.call(segs, function (x) {
            x.classList.toggle('on', x === b);
          });
          renderD(root);
        };
      });

      if (P2O.key === p2oKey() && P2O.pages.length) renderD(root);
    }
  };

  function renderD(root) {
    var out = U.$('#dOut', root);
    if (!out) return;
    if (P2O.key !== p2oKey() || !P2O.pages.length) { out.innerHTML = ''; return; }
    if (P2O.mode === 'layout') renderDLayout(out, root);
    else renderDFlow(out, root);
  }

  /* =====================================================================
   * 模式一：原版版面（版面复刻）
   * 每页按 PDF 的真实 pt 坐标排：框线走绝对定位的 VML 图形层，文字走
   * 「一个视觉行 = 一个段落 + tab 定位」。预览用同一套坐标画成 HTML，
   * 所以「预览长什么样 = 导出的 Word 长什么样」。
   * ===================================================================== */
  var DL_FONTS = [
    ['宋体', '宋体（合同 / 公文原味）'],
    ['微软雅黑', '微软雅黑'],
    ['等线', '等线'],
    ['仿宋', '仿宋'],
    ['PingFang SC', 'PingFang SC（Mac）']
  ];

  /** 数字兜底：非正数 / NaN 一律回退到默认值 */
  function numOr(v, d) {
    var n = Number(v);
    return (isFinite(n) && n > 0) ? n : d;
  }

  /**
   * 一页 → 版面预览的 HTML（纯字符串，不碰 DOM —— 这样离线也能验证）。
   *
   * 单位换算：CSS 里 1pt = 96/72 px，再乘缩放系数 K 把整页收进面板宽度。
   * 全部用 px、不用 transform:scale → 文字按最终尺寸栅格化，不会发虚。
   *
   * @param p   { items, paths, images, width, height }
   * @param opt { font, bodySize }
   */
  function facPageHtml(p, opt) {
    opt = opt || {};
    var W = numOr(p.width, 595.28), H = numOr(p.height, 841.89);
    var K = (96 / 72) * Math.min(0.92, 660 / (W * 96 / 72));
    var h = ['<svg width="' + (W * K).toFixed(1) + '" height="' + (H * K).toFixed(1) +
      '" viewBox="0 0 ' + Math.round(W * 20) + ' ' + Math.round(H * 20) + '" ' +
      'style="position:absolute;left:0;top:0;pointer-events:none">'];
    /* viewBox 用**缇**（1pt = 20 缇）：pathsFromOps 产出的路径本来就是缇坐标，
     * 直接对上去，连 stroke-width 也跟着放大 20 倍即可，不必逐个换算。 */
    (p.paths || []).forEach(function (q) {
      var d = q && q.d ? vml2svg(q.d) : '';
      if (!d) return;
      h.push('<path d="' + d + '"' + (q.fill ? ' fill="#' + q.fill + '"' : ' fill="none"') +
        (q.line ? ' stroke="#' + q.line + '" stroke-width="' +
          (Math.max(0.3, numOr(q.lw, 1) * 0.75) * 20).toFixed(1) + '"' : '') + '/>');
    });
    h.push('</svg>');
    (p.images || []).forEach(function (im) {
      if (!im || !im.b64) return;
      h.push('<img src="data:image/png;base64,' + im.b64 + '" alt="" style="left:' +
        (im.x * K).toFixed(1) + 'px;top:' + ((H - im.y - im.h) * K).toFixed(1) +
        'px;width:' + (im.w * K).toFixed(1) + 'px;height:' + (im.h * K).toFixed(1) + 'px">');
    });
    /* 文字：用 layoutMetrics 算出的**与导出完全相同**的段落度量，再由基线反推
     * CSS 的 top（CSS 的 top 是字盒顶，字盒顶 = 基线 − ascent；宋体 ascent ≈ 0.86em）。
     * 这里的 0.86 只影响预览的视觉，导出用的是 KB，不受它影响。 */
    var lm = U.ow.layoutMetrics(p.items, {
      pageW: W, pageH: H, bodySize: opt.bodySize, boldOnTitle: true
    }, 2);
    lm.rows.forEach(function (l) {
      var top = (H - l.base - l.size * 0.86) * K;
      var fs = (l.size * K).toFixed(2);
      l.cells.forEach(function (k) {
        h.push('<i style="left:' + (k.x * K).toFixed(2) + 'px;top:' + top.toFixed(2) +
          'px;font-size:' + fs + 'px;line-height:1;' +
          'font-weight:' + (l.bold ? '700' : '400') + ';' +
          "font-family:'" + (opt.font || '宋体') + "','Times New Roman',sans-serif;" +
          (k.sp ? 'letter-spacing:' + (k.sp / 20 * K).toFixed(2) + 'px;' : '') +
          '">' + U.esc(k.text) + '</i>');
      });
    });
    return '<div class="p2o-fac" style="width:' + (W * K).toFixed(1) + 'px;height:' +
      (H * K).toFixed(1) + 'px">' + h.join('') + '</div>';
  }

  function renderDLayout(out, root) {
    /* 版本一致性防线：Service Worker 是 cache-first，更新後第一次開可能拿到
     * 新的 tools-pdf.js 配舊的 office-write.js（缺 layoutMetrics）→ 直接報錯。
     * 這種「檔案對不上」的失敗要講人话，不要丟一個 undefined 的例外給使用者。 */
    if (!U.ow || !U.ow.layoutMetrics || !U.ow.buildDocxLayout || !U.ow.bodySizeOf) {
      out.innerHTML = '<div class="p2o-warn">转换模块版本不一致（浏览器缓存了旧文件）。' +
        '请<b>按住 Ctrl 再按 F5 强制刷新</b>，或关掉页面重新打开一次。</div>';
      return;
    }
    if (!P2O.deep) {   /* 缓存是「流式」模式读的，没有图形信息 */
      out.innerHTML = (P2O.warn ? '<div class="p2o-warn">' + P2O.warn + '</div>' : '') +
        '<div class="p2o-warn">这份 PDF 还没有读图形信息（框线 / 印章）。' +
        '原版版面模式需要它，请重新点一次读取。</div>' +
        '<div class="pdf-row"><button class="btn btn-pri" id="dAgain">重新读取</button></div>';
      U.$('#dAgain', out).onclick = function () { U.$('#dRead', root).click(); };
      return;
    }

    var fopt = DL_FONTS.map(function (f) {
      return '<option value="' + f[0] + '">' + f[1] + '</option>';
    }).join('');
    out.innerHTML = (P2O.warn ? '<div class="p2o-warn">' + P2O.warn + '</div>' : '') +
      '<div class="t-section"><div class="sec-t">版面预览</div>' +
      '<div class="p2o-note">按 PDF 的真实坐标画的，<b>导出的 Word 就是这个样子</b>。' +
      '框线、分区、盖章位置都在原来的地方。</div>' +
      '<div class="p2o-doc" id="dPrev"></div></div>' +

      '<div class="t-section"><div class="sec-t">导出设置</div>' +
      '<div class="pdf-row"><label class="pdf-lb">中文字体</label>' +
      '<select id="dFont">' + fopt + '</select></div>' +
      '<div class="pdf-row"><label class="pdf-lb">西文字体</label>' +
      '<select id="dLatin">' +
      '<option value="Times New Roman">Times New Roman（推荐）</option>' +
      '<option value="Arial">Arial</option>' +
      '<option value="Calibri">Calibri</option>' +
      '</select></div>' +
      '<label class="ck"><input type="checkbox" id="dTitle" checked>' +
      '<span>大字号行加粗（当标题处理）</span></label>' +
      '<div class="pdf-hint-inline" style="margin-bottom:11px">' +
      '字号、行距、字距都按 PDF 原值写死，所以每页都会自动分页；' +
      '字体换了字号不变，排版不会跑。</div>' +
      '<div class="pdf-row"><button class="btn btn-pri" id="dGo">导出 Word</button>' +
      '<span class="pdf-hint-inline" id="dGoInfo"></span></div>' +
      '</div>';

    var font = U.$('#dFont', out).value;

    function drawFac() {
      var o = { font: font, bodySize: P2O.bodySize };
      var pathsN = 0, imgsN = 0, missN = 0;
      var html = P2O.pages.map(function (p) {
        pathsN += (p.paths || []).length;
        imgsN += (p.images || []).length;
        missN += (p.skipped || 0);
        return facPageHtml(p, o);
      }).join('');
      pgEl.innerHTML = '<div class="p2o-facwrap">' + html + '</div>' +
        '<div class="p2o-facbar"><span>共 ' + P2O.pages.length + ' 页</span>' +
        '<span>框线 ' + pathsN + '</span>' +
        (imgsN ? '<span>图片 ' + imgsN + '</span>' : '') +
        (missN ? '<span>跳过 ' + missN + ' 张超大图</span>' : '') + '</div>';
      U.$('#dGoInfo', out).textContent = P2O.pages.length + ' 页 · 框线 ' + pathsN +
        (imgsN ? ' · 图 ' + imgsN : '');
    }

    var pgEl = U.$('#dPrev', out);
    drawFac();

    U.$('#dFont', out).onchange = function () {
      font = this.value;                 // drawFac 从闭包读它，重画即生效
      drawFac();
    };

    U.$('#dGo', out).onclick = function () {
      var btn = this, gi = U.$('#dGoInfo', out);
      var cjk = U.$('#dFont', out).value;
      var latin = U.$('#dLatin', out).value;
      var bold = U.$('#dTitle', out).checked;
      withBusy(btn, '生成中…', function () {
        var pg = P2O.pages.map(function (p) {
          return {
            items: p.items, paths: p.paths || [], images: p.images || [],
            width: p.width, height: p.height
          };
        });
        var blob = U.ow.buildDocxLayout(pg, {
          font: cjk, latinFont: latin, boldOnTitle: bold, bodySize: P2O.bodySize
        });
        /* 文件名带后缀：同一个 PDF 常常两种模式各导一次来对比，不加后缀会撞名 */
        var nm = baseName(S.name) + '（原版版面）.docx';
        U.saveBlob(nm, blob);
        gi.textContent = fmtSize(blob.size);
        status('已导出 ' + nm);
      });
    };
  }

  /* =====================================================================
   * 模式二：流式文档（重新排版：标题 + 段落 + 表格）
   * ===================================================================== */
  function renderDFlow(out, root) {
    var warn = P2O.warn ? '<div class="p2o-warn">' + P2O.warn + '</div>' : '';
    out.innerHTML = warn +
      '<div class="t-section"><div class="sec-t">预览</div>' +
      '<div class="p2o-note">这里显示的是「转成 Word 后会是什么样」，不是 PDF 原样。</div>' +
      '<div class="p2o-doc" id="dPrev"></div></div>' +

      '<div class="t-section"><div class="sec-t">导出设置</div>' +
      '<div class="pdf-row"><label class="pdf-lb">段落切分</label>' +
      '<input type="range" id="dSplit" min="120" max="300" step="5" value="175" style="flex:1">' +
      '<span class="pdf-val" id="dSplitV">1.75×</span></div>' +
      '<label class="ck"><input type="checkbox" id="dTbl" checked>' +
      '<span>保留表格结构（取消则全部当纯文字，适合只想要文字的场合）</span></label>' +
      '<label class="ck"><input type="checkbox" id="dHead" checked>' +
      '<span>按字号识别标题层级</span></label>' +
      '<label class="ck"><input type="checkbox" id="dBreak" checked>' +
      '<span>每页之间插入分页符</span></label>' +
      '<div class="pdf-row"><label class="pdf-lb">正文字体</label>' +
      '<select id="dFont">' +
      '<option value="微软雅黑">微软雅黑（推荐）</option>' +
      '<option value="宋体">宋体（公文风格）</option>' +
      '<option value="等线">等线</option>' +
      '<option value="PingFang SC">PingFang SC（Mac）</option>' +
      '</select></div>' +
      '<div class="pdf-row"><button class="btn btn-pri" id="dGo">导出 Word</button>' +
      '<span class="pdf-hint-inline" id="dGoInfo"></span></div>' +
      '</div>';

    function opts() {
      return {
        keepTables: U.$('#dTbl', out).checked,
        splitK: Number(U.$('#dSplit', out).value) / 100
      };
    }
    function blocksOfPage(p) {
      var o = opts();
      o.mergeFill = true;
      o.headings = U.$('#dHead', out).checked;
      if (p.rules) o.rules = p.rules;          // 有框线时整块出表，不再按行猜
      return U.ow.blocksFromItems(p.items, o);
    }
    /** 单元格内容 → 预览用 HTML（格内折行要真的换行） */
    function cellHtml(t) {
      return U.esc(t).replace(/\n/g, '<br>');
    }
    function draw() {
      var html = '';
      var stat = { h: 0, p: 0, tbl: 0, rows: 0, ok: 0 };
      P2O.pages.forEach(function (p, pi) {
        html += '<div class="p2o-docpg"><span class="p2o-docpn">第 ' + p.page + ' 页' +
          (p.rules && (p.rules.h.length || p.rules.v.length) ? ' · 有框线' : '') + '</span>';
        var bl = blocksOfPage(p);
        if (!bl.length) html += '<div class="p2o-none">（这一页没读到文字）</div>';
        bl.forEach(function (b) {
          if (b.t === 'br') return;
          if (b.t === 'h') {
            stat.h++;
            html += '<div class="p2o-dh h' + b.level + '">' + U.esc(b.text) + '</div>';
          } else if (b.t === 'table') {
            stat.tbl++; stat.rows += b.rows.length;
            var ncol = b.rows.reduce(function (a, r) { return Math.max(a, r.length); }, 0);
            html += '<table class="p2o-dtbl">' + b.rows.map(function (r, ri) {
              var tds = '', c = 0;
              while (c < ncol) {
                var sp = (b.spans && b.spans[ri]) ? b.spans[ri][c] : undefined;
                if (sp === null) { c++; continue; }          // 被合并格覆盖
                var cs = (sp && sp.cs) || 1, rs = (sp && sp.rs) || 1;
                var vm = (sp && sp.vm) || 'none';
                if (vm === 'cont') { c += cs; continue; }    // 被上面的纵向合并覆盖
                var attr = (cs > 1 ? ' colspan="' + cs + '"' : '') +
                  (rs > 1 ? ' rowspan="' + rs + '"' : '');
                var tag = ri === 0 ? 'th' : 'td';
                tds += '<' + tag + attr + '>' + (cellHtml(r[c]) || '') + '</' + tag + '>';
                c += cs;
              }
              return '<tr>' + tds + '</tr>';
            }).join('') + '</table>';
          } else {
            stat.p++; html += '<div class="p2o-dp">' + U.esc(b.text) + '</div>';
          }
        });
        html += '</div>';
      });
      U.$('#dPrev', out).innerHTML = html;
      U.$('#dGoInfo', out).textContent = '标题 ' + stat.h + ' · 段落 ' + stat.p +
        ' · 表格 ' + stat.tbl + (stat.tbl ? '（' + stat.rows + ' 行）' : '');
    }
    draw();

    U.$('#dSplit', out).oninput = function () {
      U.$('#dSplitV', out).textContent = (this.value / 100).toFixed(2) + '×';
      draw();
    };
    ['dTbl', 'dHead'].forEach(function (id) {
      U.$('#' + id, out).onchange = draw;
    });

    U.$('#dGo', out).onclick = function () {
      var btn = this, gi = U.$('#dGoInfo', out);
      var br = U.$('#dBreak', out).checked;
      var font = U.$('#dFont', out).value;
      withBusy(btn, '生成中…', function () {
        var blocks = [];
        P2O.pages.forEach(function (p, pi) {
          var bl = blocksOfPage(p);
          if (!bl.length) return;
          if (pi > 0 && br) blocks.push({ t: 'br' });
          bl.forEach(function (b) { blocks.push(b); });
        });
        if (!blocks.length) throw new Error('没有可导出的内容（可能是扫描件）');
        var blob = U.ow.buildDocx(blocks, { font: font });
        var nm = baseName(S.name) + '.docx';
        U.saveBlob(nm, blob);
        gi.textContent = fmtSize(blob.size);
        status('已导出 ' + nm);
      });
    };
  }

  /* ================= 注册 ================= */
  LB.register({
    id: 'pdfbox', cat: 'office', icon: '📕', name: 'PDF 工具箱',
    desc: '合并/拆分/旋转/压缩/水印/页码/加密/解锁/提取图片/转图片，全程本地不上传',
    kw: 'pdf 合并 拆分 旋转 压缩 水印 页码 加密 解密 解锁 解密pdf 去除密码 权限 提取图片 重排 重新排列 删除页面 转图片 jpg png webp 分割 瘦身 加水印 pdf工具箱 扫描件',

    tpl: function () {
      return '<div id="pdfApp"></div>';
    },

    init: function (root) {
      appEl = root.querySelector('#pdfApp');
      // 切换工具时保留上次的视图，但若文档已被清掉就退回首页
      if (feat && !FEATS.some(function (f) { return f.id === feat.id; })) feat = null;
      render();
    }
  });

})();
