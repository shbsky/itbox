/* ===== IT工具箱 · 证件照制作 =====
   核心算法：色度键前景分离 + 距离变换边缘去污，一步换底
   全程 Canvas 本地运算，不上传、不联网、不依赖任何 AI 模型
*/
(function () {
  'use strict';
  var LB = window.LB, U = LB.util;

  /* ================= 常量 ================= */

  /** 源图降采样上限：最大输出规格是 1500px，2000 足够；
   *  再大只会让逐像素循环变慢，画质没有实际收益 */
  var MAXSIDE = 2000;
  var MAX_MB = 30;
  var MAX_BATCH = 40;      // 批量上限，避免一次塞几百张把内存撑爆
  var MAX_SHEET = 120;     // 单张排版图最多放几张

  /** 证件照规格表（宽 × 高，单位像素）
   *  名字照抄参考站点，但把「34cm×45cm」修正为 mm
   *  —— 402×531 @300dpi 反算正好是 34mm × 45mm，原站单位写错了 */
  var SPECS = {
    common: [
      ['一寸', 295, 413],
      ['大一寸', 390, 567],
      ['小二寸', 413, 531],
      ['二寸', 413, 579],
      ['五寸', 1050, 1500],
      ['五寸竖版', 1500, 1050]
    ],
    exam: [
      ['公务员审核工具', 295, 413],
      ['公务员 34mm×45mm', 402, 531],
      ['公务员小', 130, 170],
      ['公务员小（特小）', 114, 156],
      ['司法考试', 413, 626],
      ['四六级 / 计算机', 144, 192],
      ['会计', 114, 156],
      ['护士', 160, 210],
      ['普通话测试', 413, 579],
      ['高考 / 考研', 480, 640],
      ['日语', 360, 480]
    ],
    cert: [
      ['身份证', 358, 441],
      ['社保照片', 358, 441],
      ['毕业证', 480, 640],
      ['教师资格证', 295, 413],
      ['护照', 390, 567],
      ['产品图 / 头像', 800, 800],
      ['签证', 700, 700]
    ]
  };
  var GROUP_NAME = { common: '常用尺寸', exam: '报名考试', cert: '各类证件' };

  /** 底色预设 */
  var BG = {
    keep: { n: '保持原底', label: '原底' },
    white: { n: '白底', solid: [255, 255, 255], css: '#ffffff' },
    red: { n: '红底', solid: [213, 0, 27], css: '#d5001b' },
    blue: { n: '蓝底', solid: [67, 142, 219], css: '#438edb' },
    gray: { n: '浅灰底', solid: [217, 221, 227], css: '#d9dde3' },
    grad: { n: '渐变灰', grad: [[242, 244, 247], [201, 208, 218]], css: 'linear-gradient(#f2f4f7,#c9d0da)' },
    none: { n: '抠透明', label: '透明' }
  };

  var PAPER = {
    '1200x1800': '6 寸相纸 1200 × 1800',
    '1800x1200': '6 寸横放 1800 × 1200',
    '2480x3508': 'A4 竖版 2480 × 3508',
    '1050x1500': '5 寸相纸 1050 × 1500'
  };

  /* ================= 小工具 ================= */

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function baseName(n) {
    return String(n || 'photo').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_');
  }
  function stamp() {
    var d = new Date(), p = function (x) { return x < 10 ? '0' + x : '' + x; };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  /** 面板是否真的可见 —— 不然用户在别的工具里粘贴也会触发本工具 */
  function visible(el) {
    return !!(el && el.getClientRects && el.getClientRects().length);
  }
  function loadImage(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('图片解码失败')); };
      img.src = url;
    });
  }
  function blobToU8(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(new Uint8Array(fr.result)); };
      fr.onerror = function () { rej(new Error('读取图片数据失败')); };
      fr.readAsArrayBuffer(blob);
    });
  }
  function encodeCanvas(cv, mime, q) {
    return new Promise(function (res) {
      cv.toBlob(function (b) { res(b); }, mime, q);
    });
  }
  /** 二分质量逼近目标体积（只对 JPEG / WebP 有效，PNG 无质量参数） */
  function encodeToTarget(cv, mime, target) {
    return encodeCanvas(cv, mime, 0.92).then(function (b) {
      if (!b || b.size <= target) return b;
      var lo = 0.15, hi = 0.92, best = null, i = 0;
      function step() {
        if (i++ >= 7) return best || encodeCanvas(cv, mime, 0.15);
        var mid = (lo + hi) / 2;
        return encodeCanvas(cv, mime, mid).then(function (r) {
          if (!r) return best;
          if (r.size <= target) { best = r; lo = mid; } else { hi = mid; }
          return step();
        });
      }
      return step();
    });
  }

  /* ================= 核心算法 ================= */

  /**
   * 自动估计背景色：取图像四条边条带的**中位数**
   *
   * 用中位数而不是平均值 —— 前景（头发、肩膀、手臂）经常从画面边缘侵入，
   * 平均值会被这些离群点拉偏，中位数对入侵像素免疫。
   */
  function sampleBg(data, w, h) {
    var bw = Math.max(2, Math.round(w * 0.06));
    var bh = Math.max(2, Math.round(h * 0.06));
    var step = Math.max(1, Math.round(Math.max(w, h) / 300));
    var rs = [], gs = [], bs = [];
    var push = function (x, y) {
      var i = (y * w + x) * 4;
      rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    };
    var x, y;
    for (y = 0; y < h; y += step) {
      for (x = 0; x < bw; x += step) { push(x, y); push(w - 1 - x, y); }
    }
    for (x = 0; x < w; x += step) {
      for (y = 0; y < bh; y += step) { push(x, y); push(x, h - 1 - y); }
    }
    if (!rs.length) return { r: 255, g: 255, b: 255 };
    var med = function (a) { a.sort(function (p, q) { return p - q; }); return a[a.length >> 1]; };
    return { r: med(rs), g: med(gs), b: med(bs) };
  }

  /**
   * 倒角距离变换：算出每个像素到**最近的背景像素**的距离
   *
   * 两遍扫描（前向 + 后向）即可得到近似欧氏距离，复杂度 O(n)。
   * 这一步是整个算法的关键 —— 它让我们能精确知道
   * 「这个像素离背景边缘有几个像素」，从而只在真正的边缘带做去污，
   * 而不会像全局线性模型那样把脸部肤色一起推向新底色。
   */
  function distTransform(mask, w, h, out) {
    var INF = 1e6, D1 = 1, D2 = 1.41421356;
    var d = out || new Float32Array(w * h);
    var i, x, y;
    for (i = 0; i < w * h; i++) d[i] = mask[i] ? 0 : INF;

    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        if (d[i] === 0) continue;
        var b = d[i];
        if (x > 0 && d[i - 1] + D1 < b) b = d[i - 1] + D1;
        if (y > 0) {
          if (d[i - w] + D1 < b) b = d[i - w] + D1;
          if (x > 0 && d[i - w - 1] + D2 < b) b = d[i - w - 1] + D2;
          if (x < w - 1 && d[i - w + 1] + D2 < b) b = d[i - w + 1] + D2;
        }
        d[i] = b;
      }
    }
    for (y = h - 1; y >= 0; y--) {
      for (x = w - 1; x >= 0; x--) {
        i = y * w + x;
        if (d[i] === 0) continue;
        var c = d[i];
        if (x < w - 1 && d[i + 1] + D1 < c) c = d[i + 1] + D1;
        if (y < h - 1) {
          if (d[i + w] + D1 < c) c = d[i + w] + D1;
          if (x < w - 1 && d[i + w + 1] + D2 < c) c = d[i + w + 1] + D2;
          if (x > 0 && d[i + w - 1] + D2 < c) c = d[i + w - 1] + D2;
        }
        d[i] = c;
      }
    }
    return d;
  }

  /**
   * 边缘带内的 alpha 精确解算
   *
   * 只靠倒角距离求 alpha 是不够的 —— 距离是按像素整数量化的，
   * 一条 2px 宽的抗锯齿带只能得到 {0, 0.5, 1} 三个档位，
   * 解不出 0.25 这种中间值，白边依然会残留。
   *
   * 改用颜色投影：由 C = α·F + (1−α)·B旧 两边同减 B旧 得
   *     C − B旧 = α·(F − B旧)
   * 于是   α = (C − B旧)·(F − B旧) / |F − B旧|²      ← 最小二乘投影
   *
   * F 取「离本像素最近的那个确定前景像素」的颜色。
   * 确定前景定义为距离 > 带宽 R，它一定落在 R+1 的窗口内，所以窗口开到 R+1 就是精确的。
   */
  function bandAlpha(buf, sd, w, h, x, y, i, R, W2, br, bgc, bb, fallback) {
    var x0 = x - W2 < 0 ? 0 : x - W2, x1 = x + W2 >= w ? w - 1 : x + W2;
    var y0 = y - W2 < 0 ? 0 : y - W2, y1 = y + W2 >= h ? h - 1 : y + W2;
    var best = Infinity, xx, yy, q, dx, dy, d2;

    for (yy = y0; yy <= y1; yy++) {
      var row = yy * w;
      for (xx = x0; xx <= x1; xx++) {
        q = row + xx;
        if (sd[q] <= R) continue;                 // 只要确定前景
        dx = xx - x; dy = yy - y; d2 = dx * dx + dy * dy;
        if (d2 < best) best = d2;
      }
    }
    if (best === Infinity) return fallback;       // 窗口里找不到前景（细碎噪点）→ 退回按距离估

    // 把最近点周围约 1.4px 内的确定前景一起平均，抵消 JPEG 噪点
    var lim2 = best + 2, fr = 0, fg = 0, fb = 0, cnt = 0;
    for (yy = y0; yy <= y1; yy++) {
      var row2 = yy * w;
      for (xx = x0; xx <= x1; xx++) {
        q = row2 + xx;
        if (sd[q] <= R) continue;
        dx = xx - x; dy = yy - y; d2 = dx * dx + dy * dy;
        if (d2 > lim2) continue;
        var qp = q * 4;
        fr += buf[qp]; fg += buf[qp + 1]; fb += buf[qp + 2]; cnt++;
      }
    }
    if (!cnt) return fallback;
    fr /= cnt; fg /= cnt; fb /= cnt;

    var ur = fr - br, ug = fg - bgc, ub = fb - bb;
    var den = ur * ur + ug * ug + ub * ub;
    if (den < 300) return 0;      // 前景色与背景色几乎重合，说明这里本来就是背景
    var pp = i * 4;
    var v = ((buf[pp] - br) * ur + (buf[pp + 1] - bgc) * ug + (buf[pp + 2] - bb) * ub) / den;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  /**
   * 换底色 / 抠透明（就地修改 buf）
   *
   * 三步走：
   *   ① 颜色阈值切出「确定背景」的二值遮罩
   *   ② 算**有符号距离**：前景侧为正、背景侧为负，|sdf| ≤ R 就是过渡带
   *      —— 必须两侧都算。抗锯齿过渡带是跨在阈值分界线两侧的，
   *         只算「到背景的距离」会把分界线靠背景一侧的半前景像素当成纯背景抹掉，
   *         那正是残留白边最大的一批像素。
   *   ③ 带内用颜色投影精确解出 α（见 bandAlpha），带外 α 取 0 或 1
   *
   * 换底的合成公式（把 C = α·F + (1−α)·B旧 代入化简得到）：
   *     C新 = C + (1−α)·(B新 − B旧)
   * α=1 前景原样不动；α=0 背景刚好变成纯新底色；0<α<1 的边缘自动去污 —— 白边消失就在这里。
   * 用加法而不去反解 F = (C−(1−α)B旧)/α，避免 α→0 时的除零爆炸。
   *
   * @param {Uint8ClampedArray} buf  像素数据，会被原地改写
   * @param {{r,g,b}} old            旧背景色
   * @param {{solid?:number[],grad?:number[][]}|null} nw  新底色；null = 抠透明
   * @param {number} tol             容差：与旧背景色的距离小于它就判为背景
   * @param {number} feather         边缘去污带宽（像素，单侧）
   * @param {boolean} cut            true = 输出 alpha 通道
   * @returns {{bgRatio:number}}     被判为背景的像素占比
   */
  function keyOut(buf, w, h, old, nw, tol, feather, cut) {
    var n = w * h;
    var br = old.r, bgc = old.g, bb = old.b;
    var lim = tol * tol * 3;          // 与 (Δr²+Δg²+Δb²) 直接比，省掉开方
    var mask = new Uint8Array(n);
    var i, x, y, p, bgCount = 0;

    for (i = 0; i < n; i++) {
      p = i * 4;
      var dr = buf[p] - br, dg = buf[p + 1] - bgc, db = buf[p + 2] - bb;
      if (dr * dr + dg * dg + db * db <= lim) { mask[i] = 1; bgCount++; }
    }

    // 有符号距离场：前景侧 = 到最近背景的距离（正），背景侧 = 到最近前景的距离（负）
    // 注意 mask[i]=1 表示「背景」，所以负值要赋给 mask[i] 为真的像素
    var sd = distTransform(mask, w, h);
    var inv = new Uint8Array(n);
    for (i = 0; i < n; i++) inv[i] = mask[i] ? 0 : 1;   // 1 = 前景，作为距离变换的源
    var dfg = distTransform(inv, w, h);
    for (i = 0; i < n; i++) { if (mask[i]) sd[i] = -dfg[i]; }
    inv = null; dfg = null;

    var R = feather < 1 ? 1 : feather;
    var W2 = Math.ceil(R) + 1;                // R+1 内必能找到最近的前景像素

    // 新底色的起点与每行增量（渐变底用得上）
    var sr = 0, sg = 0, sb = 0, ir = 0, ig = 0, ib = 0;
    if (nw && nw.grad) {
      sr = nw.grad[0][0]; sg = nw.grad[0][1]; sb = nw.grad[0][2];
      ir = (nw.grad[1][0] - sr) / h; ig = (nw.grad[1][1] - sg) / h; ib = (nw.grad[1][2] - sb) / h;
    } else if (nw && nw.solid) {
      sr = nw.solid[0]; sg = nw.solid[1]; sb = nw.solid[2];
    }

    for (y = 0; y < h; y++) {
      var qr = sr + ir * y, qg = sg + ig * y, qb = sb + ib * y;
      var kr = qr - br, kg = qg - bgc, kb = qb - bb;
      var base = y * w;
      for (x = 0; x < w; x++) {
        i = base + x;
        var s = sd[i];
        var a;
        if (s > R) a = 1;                                     // 确定前景
        else if (s < -R) a = 0;                               // 确定背景
        else a = bandAlpha(buf, sd, w, h, x, y, i, R, W2, br, bgc, bb, (s + R) / (2 * R));

        p = i * 4;
        var iv = 1 - a;
        if (cut) {
          if (a <= 0) { buf[p] = 0; buf[p + 1] = 0; buf[p + 2] = 0; buf[p + 3] = 0; }
          else {
            buf[p] -= iv * br; buf[p + 1] -= iv * bgc; buf[p + 2] -= iv * bb;
            buf[p + 3] = (buf[p + 3] * a) | 0;
          }
        } else if (a <= 0) {
          // 纯背景直接铺新底色。
          // 不能用 C+(B新−B旧)：墙面受光不匀时局部背景色并不等于取样的 B旧，
          // 那样补出来会带着原图的明暗偏差（角落发暗），一眼就看得出脏。
          buf[p] = qr; buf[p + 1] = qg; buf[p + 2] = qb;
        } else if (a < 1) {
          buf[p] += iv * kr; buf[p + 1] += iv * kg; buf[p + 2] += iv * kb;
        }
      }
    }
    return { bgRatio: bgCount / n };
  }

  /* ================= 裁剪几何 ================= */

  /**
   * 以「最短边刚好填满」为基准(scale=1)，叠加缩放与偏移算出源图裁剪框
   * px / py ∈ [−1,1]，0 = 居中；用百分比而不是绝对像素，批量时才能套用到不同尺寸的照片
   */
  function calcCrop(iw, ih, sw, sh, scale, px, py) {
    var A = sw / sh, cw, ch;
    if (iw / ih > A) { ch = ih; cw = ih * A; } else { cw = iw; ch = iw / A; }
    cw /= scale; ch /= scale;
    if (cw > iw) { cw = iw; ch = iw / A; }
    if (ch > ih) { ch = ih; cw = ih * A; }
    var mx = iw - cw, my = ih - ch;
    return { x: mx / 2 * (1 + px), y: my / 2 * (1 + py), w: cw, h: ch, mx: mx, my: my };
  }

  /* ================= 工具注册 ================= */

  /**
   * 证件卡图标（内联 SVG）：圆角卡框 + 左侧人像 + 右侧三条信息线
   *
   * 刻意不用 emoji —— 🪪(U+1FAAA) 属 Unicode 14.0，而 Windows 10 的 Segoe UI Emoji
   * 只覆盖到 Unicode 13.0，会渲染成空白豆腐块；👤 之类虽是安全字元，但观感不像证件照。
   * 内联 SVG 不受系统字体影响，任何机器显示一致；stroke=currentColor 自动跟随主题色。
   * 尺寸用 1em，自动适配卡片(23px) / 拖放区(38px) / 面板头(20px) 三处不同字号。
   */
  var ID_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"' +
    ' style="width:1em;height:1em" fill="none" stroke="currentColor"' +
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="2" y="4.5" width="20" height="15" rx="2.5"/>' +
    '<circle cx="8.6" cy="10.3" r="2.4"/>' +
    '<path d="M4.7 16.8c0-2.1 1.7-3.4 3.9-3.4s3.9 1.3 3.9 3.4z"/>' +
    '<path d="M15.3 10h4M15.3 13h4M15.3 16h4"/>' +
    '</svg>';

  LB.register({
    id: 'idphoto', cat: 'office', icon: ID_ICON, name: '证件照制作',
    desc: '按标准规格裁剪、一键换底色、压到指定 KB、批量导出、排版打印，全程本地不上传',
    kw: '证件照 一寸 二寸 换底色 换背景 白底 红底 蓝底 登记照 报名照 照片 身份证 护照 签证 社保 简历照 头像 排版 打印 批量 压缩 抠图 抠透明 修图 照片处理',

    tpl: function () {
      // 必须有独立的根节点：app.js 切换工具时只换 bodyEl 的 innerHTML，
      // 若直接判断 bodyEl 可见性，切到别的工具后仍会误判为「本工具显示中」
      return '<div id="ipApp">' +
        /* ---- 1 添加 ---- */
        '<div class="t-section"><div class="sec-t">1 · 添加照片</div>' +
        '<div class="drop-zone" id="ipDrop">' +
        '<div class="drop-ico">' + ID_ICON + '</div>' +
        '<div class="drop-t">拖拽照片到此处</div>' +
        '<div class="drop-s">支持 JPG / PNG / WebP · 单张 ≤ ' + MAX_MB + ' MB · 一次最多 ' + MAX_BATCH + ' 张（多张自动批量）</div>' +
        '<button class="btn btn-pri" id="ipPick">选择照片</button>' +
        '<div class="drop-s mt8">也可以直接按 <b>Ctrl + V</b> 粘贴剪贴板里的照片</div>' +
        '</div>' +
        '<input type="file" id="ipFile" accept="image/*" multiple hidden>' +
        '<div class="ip-list" id="ipList" hidden></div>' +
        '</div>' +

        /* ---- 2 规格与底色 ---- */
        '<div class="t-section"><div class="sec-t">2 · 规格与底色</div>' +

        '<div class="ip-cats" id="ipCats">' +
        '<button class="ip-cat" data-g="common">常用尺寸</button>' +
        '<button class="ip-cat" data-g="exam">报名考试</button>' +
        '<button class="ip-cat" data-g="cert">各类证件</button>' +
        '<button class="ip-cat" data-g="custom">指定尺寸</button>' +
        '</div>' +
        '<div class="ip-pop" id="ipPop" hidden></div>' +
        '<div class="ip-spec"><span>当前规格</span><b id="ipSpecTxt">一寸 · 295 × 413</b>' +
        '<em>宽 × 高（像素）</em></div>' +

        '<div class="field mt12"><label class="field-l">底色</label>' +
        '<div class="ip-sw" id="ipSw">' +
        '<button class="ip-sw-i on" data-bg="keep">保持原底</button>' +
        '<button class="ip-sw-i" data-bg="white" style="--sw:#ffffff">白底</button>' +
        '<button class="ip-sw-i" data-bg="red" style="--sw:#d5001b">红底</button>' +
        '<button class="ip-sw-i" data-bg="blue" style="--sw:#438edb">蓝底</button>' +
        '<button class="ip-sw-i" data-bg="gray" style="--sw:#d9dde3">浅灰底</button>' +
        '<button class="ip-sw-i" data-bg="grad" style="--sw:linear-gradient(#f2f4f7,#c9d0da)">渐变灰</button>' +
        '<button class="ip-sw-i" data-bg="custom" id="ipCustSw" style="--sw:#7c9cd6">自定义</button>' +
        '<button class="ip-sw-i" data-bg="none">抠透明</button>' +
        '</div>' +
        '<input type="color" id="ipCustC" value="#7c9cd6" hidden>' +
        '</div>' +

        '<div id="ipKeyWrap" hidden>' +
        '<div class="row tight">' +
        '<div class="field"><label class="field-l">背景容差 <b class="qval" id="ipTolV">30</b></label>' +
        '<input type="range" class="range" id="ipTol" min="5" max="120" step="1" value="30">' +
        '<div class="hint">越大判为背景的像素越多。背景有阴影、渐变或偏灰时调大</div></div>' +
        '<div class="field"><label class="field-l">边缘去污带宽 <b class="qval" id="ipFerV">3 px</b></label>' +
        '<input type="range" class="range" id="ipFer" min="1" max="10" step="1" value="3">' +
        '<div class="hint">重算多宽的边缘带，用来消掉换底色后的白色光晕。<b>调大不会冲淡脸部</b></div></div>' +
        '</div>' +
        '<div class="ip-bginfo" id="ipBgInfo"></div>' +
        '<div class="btn-group"><button class="btn btn-sm" id="ipPickBg">在照片上点选背景色</button>' +
        '<button class="btn btn-sm" id="ipAutoBg">恢复自动识别</button></div>' +
        '</div>' +
        '</div>' +

        /* ---- 3 位置 ---- */
        '<div class="t-section"><div class="sec-t">3 · 调整位置</div>' +
        '<div class="ip-stage">' +
        '<div class="ip-cv-wrap"><canvas id="ipCv"></canvas></div>' +
        '<div class="ip-side">' +
        '<div class="field"><label class="field-l">缩放 <b class="qval" id="ipZoomV">100%</b></label>' +
        '<input type="range" class="range" id="ipZoom" min="100" max="320" step="1" value="100"></div>' +
        '<div class="field"><label class="field-l">水平偏移 <b class="qval" id="ipPxV">0%</b></label>' +
        '<input type="range" class="range" id="ipPx" min="-100" max="100" step="1" value="0"></div>' +
        '<div class="field"><label class="field-l">垂直偏移 <b class="qval" id="ipPyV">0%</b></label>' +
        '<input type="range" class="range" id="ipPy" min="-100" max="100" step="1" value="0"></div>' +
        '<div class="btn-group"><button class="btn btn-sm" id="ipReset">复位</button>' +
        '<button class="btn btn-sm" id="ipHead">头顶留白</button></div>' +
        '<div class="hint">直接在照片上按住拖动也能移动位置；滚轮可缩放</div>' +
        '</div>' +
        '</div>' +
        '</div>' +

        /* ---- 4 输出 ---- */
        '<div class="t-section"><div class="sec-t">4 · 输出</div>' +
        '<div class="row tight">' +
        '<div class="field"><label class="field-l">输出格式</label>' +
        '<select id="ipFmt">' +
        '<option value="jpeg">JPG / JPEG（推荐 · 体积小）</option>' +
        '<option value="png">PNG（无损 · 体积大）</option>' +
        '</select></div>' +
        '<div class="field"><label class="field-l">限制体积 KB（留空不限）</label>' +
        '<input type="number" id="ipKB" min="1" step="1" placeholder="如 50"></div>' +
        '</div>' +
        '<div class="btn-group">' +
        '<button class="btn btn-pri" id="ipGo">生成并下载</button>' +
        '<button class="btn" id="ipSheet">排版打印</button>' +
        '<button class="btn" id="ipClear">清空</button>' +
        '</div>' +
        '<div class="ip-sheet-panel" id="ipSheetP" hidden>' +
        '<div class="row tight">' +
        '<div class="field"><label class="field-l">纸张</label><select id="ipPaper">' +
        '<option value="1200x1800">6 寸相纸 1200 × 1800</option>' +
        '<option value="1800x1200">6 寸横放 1800 × 1200</option>' +
        '<option value="2480x3508">A4 竖版 2480 × 3508</option>' +
        '<option value="1050x1500">5 寸相纸 1050 × 1500</option>' +
        '<option value="custom">自定义</option>' +
        '</select></div>' +
        '<div class="field" id="ipPWrap" hidden><label class="field-l">宽</label><input type="number" id="ipPW" value="1200" min="200"></div>' +
        '<div class="field" id="ipHWrap" hidden><label class="field-l">高</label><input type="number" id="ipPH" value="1800" min="200"></div>' +
        '<div class="field"><label class="field-l">间隙</label><input type="number" id="ipGap" value="8" min="0" max="60"></div>' +
        '<div class="field"><label class="field-l">页边距</label><input type="number" id="ipMargin" value="24" min="0" max="200"></div>' +
        '</div>' +
        '<div class="ip-sheet-info" id="ipSheetInfo"></div>' +
        '<div class="btn-group"><button class="btn btn-pri btn-sm" id="ipSheetGo">生成排版图</button>' +
        '<div class="hint">生成后可导到 Word / 直接送冲印，沿间隙裁剪即可</div></div>' +
        '</div>' +
        '<div class="ip-status" id="ipStatus"></div>' +
        '</div>' +
        '</div>';
    },

    init: function (root) {
      var $ = function (s) { return U.$(s, root); };
      var $$ = function (s) { return U.$$(s, root); };
      var appEl = root.querySelector('#ipApp') || root;

      /* ---------- 状态 ---------- */
      var S = {
        items: [],
        idx: 0,
        spec: { w: 295, h: 413, name: '一寸' },
        bg: 'keep',
        customC: '#7c9cd6',
        oldBg: null,          // 手动指定的旧背景色；null = 自动采样
        tol: 30,
        feather: 3,
        scale: 1,
        px: 0,
        py: 0,
        pickBg: false,
        headGuide: false
      };
      var dispScale = 1;
      var activeGroup = '';

      /* ---------- 当前生效的旧/新背景色 ---------- */
      function resolveNew() {
        var k = S.bg;
        if (k === 'keep' || k === 'none') return null;
        if (k === 'custom') {
          var c = hex2rgb(S.customC);
          return { solid: [c.r, c.g, c.b] };
        }
        var b = BG[k];
        if (!b) return null;
        if (b.solid) return { solid: b.solid.slice() };
        if (b.grad) return { grad: [[b.grad[0][0], b.grad[0][1], b.grad[0][2]], [b.grad[1][0], b.grad[1][1], b.grad[1][2]]] };
        return null;
      }
      function hex2rgb(s) {
        var m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(s || '').trim());
        if (!m) return { r: 255, g: 255, b: 255 };
        return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
      }
      function resolveOld(it) {
        if (S.oldBg) return S.oldBg;
        // 自动采样结果缓存到条目上：预览拖动时每帧都会问一次，
        // 40 张批量重绘时不缓存会明显卡顿
        if (!it._autoBg) it._autoBg = sampleBg(it.data.data, it.w, it.h);
        return it._autoBg;
      }

      /* ---------- 取「已换底」的源画布 ---------- */
      function getKeyed(it) {
        if (!it) return null;
        if (S.bg === 'keep') return it.cv;

        var old = resolveOld(it), nw = resolveNew();
        var sig = [old.r, old.g, old.b, nw ? JSON.stringify(nw) : '-', S.tol, S.feather, S.bg].join('|');
        if (it.keyed && it.keyedSig === sig) return it.keyed;

        var cv = document.createElement('canvas');
        cv.width = it.w; cv.height = it.h;
        var ctx = cv.getContext('2d');
        var img = ctx.createImageData(it.w, it.h);
        img.data.set(it.data.data);                 // 从原始快照复制，绝不污染 it.data
        it.bgRatio = keyOut(img.data, it.w, it.h, old, nw, S.tol, S.feather, S.bg === 'none').bgRatio;
        ctx.putImageData(img, 0, 0);
        it.keyed = cv;
        it.keyedSig = sig;
        return cv;
      }

      /* ---------- 把源图渲染成目标规格 ---------- */
      function renderOne(it) {
        var sw = S.spec.w, sh = S.spec.h;
        var cv = document.createElement('canvas');
        cv.width = sw; cv.height = sh;
        var ctx = cv.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        if (S.bg !== 'none') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, sw, sh); }
        var src = getKeyed(it);
        if (!src) return cv;
        var c = calcCrop(it.w, it.h, sw, sh, S.scale, S.px, S.py);
        ctx.drawImage(src, c.x, c.y, c.w, c.h, 0, 0, sw, sh);
        return cv;
      }

      /* ---------- 预览 ---------- */
      var cvEl = $('#ipCv');
      function fitCanvas() {
        var maxW = 300, maxH = 320;
        var k = Math.min(maxW / S.spec.w, maxH / S.spec.h);
        cvEl.style.width = Math.round(S.spec.w * k) + 'px';
        cvEl.style.height = Math.round(S.spec.h * k) + 'px';
        dispScale = k;
      }
      var checkerPat = null;
      /** 抠透明模式下预览铺棋盘格，用户才看得出哪里是透明的 */
      function drawChecker(ctx, w, h) {
        if (!checkerPat) {
          var c = document.createElement('canvas');
          c.width = 16; c.height = 16;
          var cc = c.getContext('2d');
          cc.fillStyle = '#ffffff'; cc.fillRect(0, 0, 16, 16);
          cc.fillStyle = '#e3e8f0'; cc.fillRect(0, 0, 8, 8); cc.fillRect(8, 8, 8, 8);
          checkerPat = ctx.createPattern(c, 'repeat');
        }
        ctx.fillStyle = checkerPat;
        ctx.fillRect(0, 0, w, h);
      }
      function drawPreview() {
        if (cvEl.width !== S.spec.w) cvEl.width = S.spec.w;
        if (cvEl.height !== S.spec.h) cvEl.height = S.spec.h;
        fitCanvas();
        var ctx = cvEl.getContext('2d');
        var it = S.items[S.idx];
        if (!it) {
          ctx.fillStyle = '#eef1f7';
          ctx.fillRect(0, 0, cvEl.width, cvEl.height);
          ctx.fillStyle = '#93a0b4';
          ctx.font = '13px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('等待添加照片', cvEl.width / 2, cvEl.height / 2);
          cvEl.style.width = '200px'; cvEl.style.height = '200px';
          return;
        }
        // 必须先清空：抠透明模式下 renderOne 出来的画布是真透明的，
        // 直接叠画会把上一帧的残影留在下面
        ctx.clearRect(0, 0, cvEl.width, cvEl.height);
        if (S.bg === 'none') drawChecker(ctx, cvEl.width, cvEl.height);
        var out = renderOne(it);
        ctx.drawImage(out, 0, 0);

        // 中心辅助线
        ctx.save();
        ctx.strokeStyle = 'rgba(37,99,235,.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(cvEl.width / 2, 0); ctx.lineTo(cvEl.width / 2, cvEl.height);
        ctx.moveTo(0, cvEl.height / 2); ctx.lineTo(cvEl.width, cvEl.height / 2);
        ctx.stroke();
        ctx.restore();

        // 头顶留白参考线（证件照规范：头顶距上边缘约 8%）
        if (S.headGuide) {
          ctx.save();
          ctx.strokeStyle = 'rgba(220,38,38,.75)';
          ctx.lineWidth = Math.max(1, Math.round(cvEl.height / 300));
          ctx.beginPath();
          ctx.moveTo(0, cvEl.height * 0.08); ctx.lineTo(cvEl.width, cvEl.height * 0.08);
          ctx.stroke();
          ctx.restore();
        }
        updateBgInfo(it);
      }

      function updateBgInfo(it) {
        var box = $('#ipBgInfo');
        if (!box) return;
        if (S.bg === 'keep') { box.hidden = true; box.textContent = ''; return; }
        box.hidden = false;
        var r = it.bgRatio;
        if (r == null) { box.textContent = ''; return; }
        var pct = (r * 100).toFixed(1) + '%';
        var o = resolveOld(it);
        var cls = 'ok', tip = '背景识别正常';
        if (r > 0.95) { cls = 'bad'; tip = '几乎整张都被当成背景了 —— 请调小「背景容差」'; }
        else if (r < 0.03) { cls = 'bad'; tip = '几乎没识别出背景 —— 请调大「背景容差」，或点选背景色'; }
        else if (r > 0.85) { cls = 'warn'; tip = '背景占比偏高，检查一下人物有没有被吃掉'; }
        box.innerHTML = '识别为背景 <b>' + pct + '</b>' +
          '　·　取样底色 <span class="ip-dot" style="background:rgb(' + o.r + ',' + o.g + ',' + o.b + ')"></span>' +
          'rgb(' + o.r + ',' + o.g + ',' + o.b + ')' +
          '　·　<span class="' + cls + '">' + tip + '</span>';
      }

      /* ---------- 照片列表 ---------- */
      function renderList() {
        var list = $('#ipList');
        if (!S.items.length) { list.hidden = true; list.innerHTML = ''; return; }
        list.hidden = false;
        list.innerHTML = S.items.map(function (it, i) {
          return '<div class="ip-item' + (i === S.idx ? ' on' : '') + '" data-i="' + i + '">' +
            '<img src="' + it.url + '" alt="">' +
            '<div class="ip-item-m"><b>' + U.esc(it.name) + '</b>' +
            '<span>' + it.w + ' × ' + it.h + ' px</span></div>' +
            '<button class="ip-x" data-del="' + i + '" title="移除">✕</button>' +
            '</div>';
        }).join('');
        $$('.ip-item').forEach(function (el) {
          el.onclick = function (e) {
            if (e.target.classList.contains('ip-x')) return;
            S.idx = Number(el.dataset.i);
            renderList(); drawPreview();
          };
        });
        $$('.ip-x').forEach(function (b) {
          b.onclick = function (e) {
            e.stopPropagation();
            var i = Number(b.dataset.del);
            URL.revokeObjectURL(S.items[i].url);
            S.items.splice(i, 1);
            if (S.idx >= S.items.length) S.idx = Math.max(0, S.items.length - 1);
            renderList(); drawPreview();
          };
        });
      }

      /* ---------- 添加照片 ---------- */
      var busy = false;
      function addFiles(files) {
        files = (files || []).filter(function (f) { return f && /^image\//.test(f.type || ''); });
        if (!files.length) { U.toast('没找到图片文件', 'err'); return; }
        var room = MAX_BATCH - S.items.length;
        if (room <= 0) { U.toast('最多 ' + MAX_BATCH + ' 张，请先清空', 'err'); return; }
        if (files.length > room) { U.toast('超出上限，只加入前 ' + room + ' 张', 'err'); files = files.slice(0, room); }
        busy = true;
        setStatus('正在读取照片…');
        var i = 0;
        function step() {
          if (i >= files.length) {
            busy = false;
            renderList(); drawPreview();
            setStatus('已添加 ' + S.items.length + ' 张照片');
            return;
          }
          var f = files[i++];
          if (f.size > MAX_MB * 1048576) { return step(); }
          return loadImage(f).then(function (img) {
            var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
            if (!iw || !ih) return step();
            var k = Math.min(1, MAXSIDE / Math.max(iw, ih));
            var w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k));
            var cv = document.createElement('canvas');
            cv.width = w; cv.height = h;
            var ctx = cv.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, w, h);
            S.items.push({
              name: f.name || '照片.jpg',
              url: URL.createObjectURL(f),
              cv: cv,                                   // 源画布（保持原底时直接用）
              data: ctx.getImageData(0, 0, w, h),       // 原始像素快照，永不被改写
              w: w, h: h, keyed: null, keyedSig: '', bgRatio: null
            });
            S.idx = S.items.length - 1;
            return step();
          }, function () { return step(); });
        }
        step();
      }
      function setStatus(t) { var e = $('#ipStatus'); if (e) e.textContent = t || ''; }

      /* ---------- 规格选择 ---------- */
      function setSpec(w, h, name) {
        S.spec = { w: w, h: h, name: name };
        $('#ipSpecTxt').textContent = name + ' · ' + w + ' × ' + h;
        syncCats(); drawPreview(); updateSheetInfo();
      }
      function syncCats() {
        $$('.ip-cat').forEach(function (b) {
          var g = b.dataset.g;
          b.classList.toggle('on', g === activeGroup);
          if (g === 'custom') { b.textContent = '指定尺寸'; return; }
          var hit = (SPECS[g] || []).filter(function (s) {
            return s[1] === S.spec.w && s[2] === S.spec.h;
          })[0];
          b.textContent = GROUP_NAME[g] + (hit ? '：' + hit[0] : '');
        });
      }
      function openPop(g) {
        var pop = $('#ipPop');
        if (activeGroup === g && !pop.hidden) { pop.hidden = true; activeGroup = ''; syncCats(); return; }
        activeGroup = g;
        if (g === 'custom') {
          pop.innerHTML = '<div class="ip-pop-t">自定义尺寸（像素）</div>' +
            '<div class="row tight">' +
            '<div class="field"><label class="field-l">宽</label><input type="number" id="ipCW" min="20" max="4000" value="' + S.spec.w + '"></div>' +
            '<div class="field"><label class="field-l">高</label><input type="number" id="ipCH" min="20" max="4000" value="' + S.spec.h + '"></div>' +
            '</div><button class="btn btn-pri btn-sm" id="ipCOK">确定</button>';
          $('#ipCOK').onclick = function () {
            var w = Math.max(20, Math.min(4000, parseInt($('#ipCW').value, 10) || 295));
            var h = Math.max(20, Math.min(4000, parseInt($('#ipCH').value, 10) || 413));
            setSpec(w, h, '自定义');
            pop.hidden = true; activeGroup = ''; syncCats();
          };
        } else {
          pop.innerHTML = '<div class="ip-pop-t">' + GROUP_NAME[g] + '</div><div class="ip-pop-list">' +
            SPECS[g].map(function (s, i) {
              return '<button class="ip-pop-i" data-i="' + i + '">' + U.esc(s[0]) +
                '<em>' + s[1] + ' × ' + s[2] + '</em></button>';
            }).join('') + '</div>';
          $$('.ip-pop-i').forEach(function (b) {
            b.onclick = function () {
              var s = SPECS[g][Number(b.dataset.i)];
              setSpec(s[1], s[2], s[0]);
              pop.hidden = true; activeGroup = ''; syncCats();
            };
          });
        }
        pop.hidden = false;
        syncCats();
      }

      /* ---------- 底切换 ---------- */
      function setBg(k) {
        S.bg = k;
        $$('.ip-sw-i').forEach(function (b) {
          b.classList.toggle('on', b.dataset.bg === k);
        });
        $('#ipKeyWrap').hidden = (k === 'keep');
        if (k === 'none') {
          $('#ipFmt').value = 'png';
          $('#ipFmt').disabled = true;
          U.toast('抠透明模式固定输出 PNG（JPG 不支持透明）');
        } else {
          $('#ipFmt').disabled = false;
        }
        if (k === 'custom') {
          S.customC = $('#ipCustC').value || S.customC;
          $('#ipCustSw').style.setProperty('--sw', S.customC);
        }
        S.items.forEach(function (it) { it.keyed = null; it.keyedSig = ''; });
        drawPreview();
      }

      /* ---------- 输出 ---------- */
      function outName(it, ext) {
        var b = BG[S.bg] ? (BG[S.bg].label || BG[S.bg].n) : '原底';
        return baseName(it.name) + '_' + S.spec.name + '_' + b + '.' + ext;
      }
      function needItems() {
        if (!S.items.length) { U.toast('请先添加照片', 'err'); return false; }
        if (busy) { U.toast('照片还在读取中，稍等一下', 'err'); return false; }
        return true;
      }
      function doExport() {
        if (!needItems()) return;
        var mime = $('#ipFmt').value === 'png' ? 'image/png' : 'image/jpeg';
        var ext = mime === 'image/png' ? 'png' : 'jpg';
        if (S.bg === 'none') { mime = 'image/png'; ext = 'png'; }
        var kb = parseInt($('#ipKB').value, 10);
        var target = (kb > 0) ? kb * 1024 : 0;
        if (target && mime === 'image/png') { U.toast('PNG 无法限制体积，请改用 JPG', 'err'); return; }

        setStatus('正在生成…');
        var i = 0, out = [], failed = 0;
        function step() {
          if (i >= S.items.length) return Promise.resolve();
          var it = S.items[i++];
          var cv = renderOne(it);
          var job = target ? encodeToTarget(cv, mime, target) : encodeCanvas(cv, mime, 0.92);
          return job.then(function (b) {
            if (b) out.push({ name: outName(it, ext), blob: b, src: it });
            else failed++;
            setStatus('正在生成 ' + i + ' / ' + S.items.length);
            return step();
          });
        }
        step().then(function () {
          if (!out.length) { setStatus('生成失败'); U.toast('生成失败，换个格式试试', 'err'); return; }
          if (out.length === 1) {
            U.saveBlob(out[0].name, out[0].blob);
            setStatus('已下载 ' + out[0].name + '（' + fmtSize(out[0].blob.size) + '）');
            return;
          }
          setStatus('正在打包…');
          Promise.all(out.map(function (o) { return blobToU8(o.blob).then(function (u8) { return { name: o.name, data: u8 }; }); }))
            .then(function (entries) {
              var blob = U.zipStore(entries);
              U.saveBlob('证件照_' + S.spec.name + '_' + stamp() + '.zip', blob);
              setStatus('已打包 ' + entries.length + ' 张，合计 ' + fmtSize(blob.size) +
                (failed ? '（' + failed + ' 张失败）' : ''));
            })
            .catch(function (e) { setStatus('打包失败：' + e.message); U.toast('打包失败：' + e.message, 'err'); });
        }).catch(function (e) {
          setStatus('生成出错：' + e.message);
          U.toast('生成出错：' + e.message, 'err');
        });
      }

      /* ---------- 排版打印 ---------- */
      function readSheetCfg() {
        var pv = $('#ipPaper').value, pw, ph;
        if (pv === 'custom') {
          pw = Math.max(200, parseInt($('#ipPW').value, 10) || 1200);
          ph = Math.max(200, parseInt($('#ipPH').value, 10) || 1800);
        } else {
          var a = pv.split('x'); pw = parseInt(a[0], 10); ph = parseInt(a[1], 10);
        }
        var gap = Math.max(0, Math.min(60, parseInt($('#ipGap').value, 10) || 0));
        var mg = Math.max(0, Math.min(200, parseInt($('#ipMargin').value, 10) || 0));
        var cols = Math.floor((pw - mg * 2 + gap) / (S.spec.w + gap));
        var rows = Math.floor((ph - mg * 2 + gap) / (S.spec.h + gap));
        cols = Math.max(0, cols); rows = Math.max(0, rows);
        return { pw: pw, ph: ph, gap: gap, mg: mg, cols: cols, rows: rows, total: cols * rows };
      }
      function updateSheetInfo() {
        var box = $('#ipSheetInfo');
        if (!box || $('#ipSheetP').hidden) return;
        var c = readSheetCfg();
        if (!c.total) {
          box.className = 'ip-sheet-info bad';
          box.textContent = '这个尺寸放不下 —— 纸张太小或照片规格太大，换纸张或调小规格';
          return;
        }
        var n = Math.min(c.total, MAX_SHEET);
        box.className = 'ip-sheet-info';
        box.innerHTML = '每张可排 <b>' + c.cols + ' × ' + c.rows + ' = ' + c.total + ' 张</b>' +
          (c.total > MAX_SHEET ? '（超过上限，只排前 ' + MAX_SHEET + ' 张）' : '') +
          '　·　资料来源 ' + S.items.length + ' 张，不足自动重复填充';
      }
      function doSheet() {
        if (!needItems()) return;
        var c = readSheetCfg();
        if (!c.total) { U.toast('纸张放不下，请调整纸张或规格', 'err'); return; }
        var n = Math.min(c.total, MAX_SHEET);
        setStatus('正在排版…');

        var sheet = document.createElement('canvas');
        sheet.width = c.pw; sheet.height = c.ph;
        var ctx = sheet.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.pw, c.ph);

        var totalW = c.cols * S.spec.w + (c.cols - 1) * c.gap;
        var totalH = c.rows * S.spec.h + (c.rows - 1) * c.gap;
        var x0 = Math.round((c.pw - totalW) / 2);
        var y0 = Math.round((c.ph - totalH) / 2);

        var cache = {}, i = 0;
        function cellAt(k) {
          var it = S.items[k % S.items.length];
          if (!cache[k % S.items.length]) cache[k % S.items.length] = renderOne(it);
          return cache[k % S.items.length];
        }
        for (var r = 0; r < c.rows && i < n; r++) {
          for (var q = 0; q < c.cols && i < n; q++, i++) {
            var px = x0 + q * (S.spec.w + c.gap);
            var py = y0 + r * (S.spec.h + c.gap);
            ctx.drawImage(cellAt(i), px, py);
          }
        }
        // 裁剪线：画在间隙里，冲印后沿灰线裁开
        ctx.strokeStyle = 'rgba(140,148,160,.7)';
        ctx.lineWidth = 1;
        for (var r2 = 0; r2 < c.rows && r2 * c.cols < n; r2++) {
          for (var q2 = 0; q2 < c.cols && r2 * c.cols + q2 < n; q2++) {
            var ex = x0 + q2 * (S.spec.w + c.gap);
            var ey = y0 + r2 * (S.spec.h + c.gap);
            ctx.strokeRect(ex - 0.5, ey - 0.5, S.spec.w + 1, S.spec.h + 1);
          }
        }
        var kb = parseInt($('#ipKB').value, 10);
        var target = (kb > 0) ? kb * 1024 * 4 : 0;      // 排版图体积上限放宽 4 倍
        (target ? encodeToTarget(sheet, 'image/jpeg', target) : encodeCanvas(sheet, 'image/jpeg', 0.92))
          .then(function (b) {
            if (!b) { setStatus('排版失败'); U.toast('排版失败', 'err'); return; }
            U.saveBlob('证件照排版_' + S.spec.name + '_' + c.pw + 'x' + c.ph + '_' + stamp() + '.jpg', b);
            setStatus('已生成排版图，共 ' + n + ' 张（' + c.cols + '×' + c.rows + '），' + fmtSize(b.size));
          });
      }

      /* ---------- 交互绑定 ---------- */
      var drop = $('#ipDrop'), fi = $('#ipFile');
      $('#ipPick').onclick = function (e) { e.stopPropagation(); fi.click(); };
      drop.onclick = function () { fi.click(); };
      fi.onchange = function () { addFiles(Array.prototype.slice.call(fi.files)); fi.value = ''; };

      ['dragenter', 'dragover'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); });
      });
      ['dragleave', 'dragend'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
      });
      drop.addEventListener('drop', function (e) {
        e.preventDefault(); e.stopPropagation(); drop.classList.remove('over');
        var dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length) addFiles(Array.prototype.slice.call(dt.files));
      });
      root.addEventListener('dragover', function (e) { e.preventDefault(); });
      root.addEventListener('drop', function (e) {
        if (e.target === drop || drop.contains(e.target)) return;
        e.preventDefault();
        var dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length) addFiles(Array.prototype.slice.call(dt.files));
      });

      function onPaste(e) {
        if (!visible(appEl)) return;                 // 只有本工具显示时才接管粘贴
        var its = (e.clipboardData || {}).items || [], list = [];
        for (var i = 0; i < its.length; i++) {
          if (its[i].kind === 'file') { var f = its[i].getAsFile(); if (f) list.push(f); }
        }
        if (list.length) { e.preventDefault(); addFiles(list); }
      }
      document.addEventListener('paste', onPaste);

      $$('.ip-cat').forEach(function (b) {
        b.onclick = function () { openPop(b.dataset.g); };
      });

      $$('.ip-sw-i').forEach(function (b) {
        b.onclick = function () {
          if (b.dataset.bg === 'custom') {
            var ci = $('#ipCustC');
            S.customC = ci.value || S.customC;
            ci.click();
            return;
          }
          setBg(b.dataset.bg);
        };
      });
      $('#ipCustC').onchange = function () {
        S.customC = this.value;
        $('#ipCustSw').style.setProperty('--sw', this.value);
        setBg('custom');
      };

      $('#ipTol').oninput = function () {
        S.tol = Number(this.value);
        $('#ipTolV').textContent = S.tol;
        S.items.forEach(function (it) { it.keyed = null; it.keyedSig = ''; });
        drawPreview();
      };
      $('#ipFer').oninput = function () {
        S.feather = Number(this.value);
        $('#ipFerV').textContent = S.feather + ' px';
        S.items.forEach(function (it) { it.keyed = null; it.keyedSig = ''; });
        drawPreview();
      };
      $('#ipPickBg').onclick = function () {
        if (!S.items.length) { U.toast('请先添加照片', 'err'); return; }
        S.pickBg = true;
        cvEl.style.cursor = 'crosshair';
        U.toast('点击照片里的背景区域');
      };
      $('#ipAutoBg').onclick = function () {
        S.oldBg = null;
        S.items.forEach(function (it) { it.keyed = null; it.keyedSig = ''; });
        drawPreview();
        U.toast('已恢复自动识别背景色', 'ok');
      };

      $('#ipZoom').oninput = function () {
        S.scale = Number(this.value) / 100;
        $('#ipZoomV').textContent = this.value + '%';
        drawPreview();
      };
      ['ipPx', 'ipPy'].forEach(function (id) {
        $('#' + id).oninput = function () {
          S.px = Number($('#ipPx').value) / 100;
          S.py = Number($('#ipPy').value) / 100;
          $('#ipPxV').textContent = $('#ipPx').value + '%';
          $('#ipPyV').textContent = $('#ipPy').value + '%';
          drawPreview();
        };
      });
      $('#ipReset').onclick = function () {
        S.scale = 1; S.px = 0; S.py = 0;
        $('#ipZoom').value = 100; $('#ipPx').value = 0; $('#ipPy').value = 0;
        $('#ipZoomV').textContent = '100%';
        $('#ipPxV').textContent = '0%'; $('#ipPyV').textContent = '0%';
        drawPreview();
      };
      $('#ipHead').onclick = function () {
        S.headGuide = !S.headGuide;
        this.classList.toggle('btn-pri', S.headGuide);
        drawPreview();
      };

      /* ---- 预览上的拖拽 / 滚轮 / 点选背景 ---- */
      var drag = null;
      cvEl.addEventListener('mousedown', function (e) {
        if (!S.items.length) return;
        if (S.pickBg) return;
        drag = { x: e.clientX, y: e.clientY, px: S.px, py: S.py };
        cvEl.style.cursor = 'grabbing';
        e.preventDefault();
      });
      window.addEventListener('mousemove', function (e) {
        if (!drag || !S.items.length) return;
        var it = S.items[S.idx];
        var c = calcCrop(it.w, it.h, S.spec.w, S.spec.h, S.scale, S.px, S.py);
        var dw = cvEl.clientWidth || 1;
        // 屏幕像素 → 源图像素 → 归一化偏移
        var dxSrc = (e.clientX - drag.x) * (c.w / dw);
        var dySrc = (e.clientY - drag.y) * (c.h / dw);
        S.px = clamp(drag.px - (c.mx > 0 ? dxSrc / (c.mx / 2) : 0), -1, 1);
        S.py = clamp(drag.py - (c.my > 0 ? dySrc / (c.my / 2) : 0), -1, 1);
        $('#ipPx').value = Math.round(S.px * 100);
        $('#ipPy').value = Math.round(S.py * 100);
        $('#ipPxV').textContent = Math.round(S.px * 100) + '%';
        $('#ipPyV').textContent = Math.round(S.py * 100) + '%';
        drawPreview();
      });
      window.addEventListener('mouseup', function () {
        if (drag) { drag = null; cvEl.style.cursor = S.pickBg ? 'crosshair' : 'grab'; }
      });
      cvEl.addEventListener('click', function (e) {
        if (!S.pickBg || !S.items.length) return;
        var it = S.items[S.idx];
        var rect = cvEl.getBoundingClientRect();
        var u = (e.clientX - rect.left) / rect.width;
        var v = (e.clientY - rect.top) / rect.height;
        var c = calcCrop(it.w, it.h, S.spec.w, S.spec.h, S.scale, S.px, S.py);
        var sx = Math.round(c.x + u * c.w), sy = Math.round(c.y + v * c.h);
        sx = Math.max(1, Math.min(it.w - 2, sx));
        sy = Math.max(1, Math.min(it.h - 2, sy));
        // 取 5×5 邻域平均值，比单像素稳
        var d = it.data.data, rs = 0, gs = 0, bs = 0, cnt = 0;
        for (var y = sy - 2; y <= sy + 2; y++) {
          for (var x = sx - 2; x <= sx + 2; x++) {
            if (x < 0 || y < 0 || x >= it.w || y >= it.h) continue;
            var p = (y * it.w + x) * 4;
            rs += d[p]; gs += d[p + 1]; bs += d[p + 2]; cnt++;
          }
        }
        S.oldBg = { r: Math.round(rs / cnt), g: Math.round(gs / cnt), b: Math.round(bs / cnt) };
        S.pickBg = false;
        cvEl.style.cursor = 'grab';
        S.items.forEach(function (x) { x.keyed = null; x.keyedSig = ''; });
        drawPreview();
        U.toast('已取样背景色 rgb(' + S.oldBg.r + ',' + S.oldBg.g + ',' + S.oldBg.b + ')', 'ok');
      });
      cvEl.addEventListener('wheel', function (e) {
        if (!S.items.length) return;
        e.preventDefault();
        var cur = Number($('#ipZoom').value);
        var next = clamp(cur + (e.deltaY < 0 ? 4 : -4), 100, 320);
        $('#ipZoom').value = next;
        S.scale = next / 100;
        $('#ipZoomV').textContent = next + '%';
        drawPreview();
      }, { passive: false });
      cvEl.style.cursor = 'grab';

      function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

      /* ---- 输出区 ---- */
      $('#ipGo').onclick = doExport;
      $('#ipClear').onclick = function () {
        S.items.forEach(function (it) { URL.revokeObjectURL(it.url); });
        S.items = []; S.idx = 0; S.oldBg = null;
        renderList(); drawPreview(); setStatus('');
      };
      $('#ipSheet').onclick = function () {
        var p = $('#ipSheetP');
        p.hidden = !p.hidden;
        this.classList.toggle('btn-pri', !p.hidden);
        if (!p.hidden) updateSheetInfo();
      };
      $('#ipPaper').onchange = function () {
        var c = this.value === 'custom';
        $('#ipPWrap').hidden = !c; $('#ipHWrap').hidden = !c;
        updateSheetInfo();
      };
      ['ipPW', 'ipPH', 'ipGap', 'ipMargin'].forEach(function (id) {
        $('#' + id).oninput = updateSheetInfo;
      });
      $('#ipSheetGo').onclick = doSheet;

      /* ---------- 收尾 ---------- */
      return {
        destroy: function () {
          document.removeEventListener('paste', onPaste);
          S.items.forEach(function (it) { URL.revokeObjectURL(it.url); });
          S.items = [];
        }
      };
    }
  });
})();
