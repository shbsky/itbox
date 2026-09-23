/* ===== 音频工具箱 =====
 *
 * 包含两个工具：
 *   1) 音频互转    mp3 / m4a / wav / ogg / flac  ← 纯浏览器本地，零上传
 *   2) 视频提取音频 mp4 / mov / mkv / webm → mp3 / m4a / wav / (ogg)
 *      带视频轨的文件浏览器无法直接解码，必须走后端 ffmpeg（见 server.js 的 /api/audio）
 *
 * 前端编码能力（决定「音质无损」能做到什么程度）：
 *   - WAV   : 手写 RIFF 头 + PCM，真无损、无依赖
 *   - MP3   : lamejs（本地库 assets/lib/lame.min.js），首次用到才加载
 *   - WebM  : MediaRecorder 的 Opus，产出 .webm 而非 .ogg（浏览器不做 ogg 封装）
 *   - M4A   : MediaRecorder 的 AAC，产出 .webm 而非 .m4a
 *   - FLAC  : ✗ 浏览器无 FLAC 编码器 → 自动转交后端
 *   - OGG   : ✗ 浏览器不做 ogg 封装   → 自动转交后端
 *
 * 「智能默认」策略：能从源头无损搬运就无损，必须重编码时才重编码。
 */
(function () {
  'use strict';
  var LB = window.LB, U = LB.util;

  /* ================= 常量 ================= */

  var MAX_V = 2000;              // 视频单文件上限 MB（后端还要再挡一次）
  var MAX_A = 500;               // 音频单文件上限 MB
  var MAX_N = 20;                // 单次批量上限

  /* 浏览器能「直接解码」的纯音频容器（注意：不含 mkv，永远不行） */
  var DECODABLE = ['mp3', 'm4a', 'wav', 'ogg', 'oga', 'flac', 'aac', 'opus', 'weba', 'mp4', 'mov'];

  /* 浏览器永远解不了的容器 —— 必须走后端 */
  var NEVER_LOCAL = ['mkv', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'rmvb', '3gp'];

  /* 「是视频容器」的扩展名：浏览器 decodeAudioData 一旦读到视频轨就会失败，
     所以视频提取工具对这些一律直接走后端，不做无谓的本地尝试 */
  var VIDEOISH = ['mp4', 'mov', 'webm', 'm4v', 'mpg', 'mpeg', 'ogv', 'flv'];

  /* 浏览器「本地能编码」的目标格式 → 注意 ext 未必等于格式名 */
  var LOCAL_OUT = {
    wav: { mime: 'audio/wav', ext: 'wav', mode: 'pcm' },
    mp3: { mime: 'audio/mpeg', ext: 'mp3', mode: 'lame' },
    webm: { mime: 'audio/webm', ext: 'webm', mode: 'rec', recMime: 'audio/webm' },
    weba: { mime: 'audio/webm', ext: 'webm', mode: 'rec', recMime: 'audio/webm' },
    m4a: { mime: 'audio/mp4', ext: 'webm', mode: 'rec', recMime: 'audio/webm' }
  };

  /* 只能后端做的目标格式 */
  var SERVER_ONLY = ['flac', 'ogg', 'opus'];

  /* 音频输出格式（用户可选项） */
  var A_OUT = [
    { v: 'mp3', label: 'MP3', hint: '兼容性最好，体积小' },
    { v: 'm4a', label: 'M4A / AAC', hint: '同码率音质优于 MP3' },
    { v: 'wav', label: 'WAV', hint: '无损无压缩，体积大' },
    { v: 'flac', label: 'FLAC', hint: '无损压缩（需后端）' },
    { v: 'ogg', label: 'OGG', hint: '开源格式（需后端）' }
  ];

  /* 视频提取的输出格式 —— 只留真实会用的三个 */
  var V_OUT = [
    { v: 'mp3', label: 'MP3', hint: '兼容性最好' },
    { v: 'm4a', label: 'M4A / AAC', hint: '体积与音质均衡' },
    { v: 'wav', label: 'WAV', hint: '无损，体积大' }
  ];

  /* 码率档位 */
  var RATES = [
    { v: 320, label: '320 kbps', hint: '高质量' },
    { v: 192, label: '192 kbps', hint: '标准（推荐）' },
    { v: 128, label: '128 kbps', hint: '省空间' },
    { v: 96, label: '96 kbps', hint: '语音够用' }
  ];

  /* ================= 小工具 ================= */

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
  function extOf(name) {
    var n = String(name || ''), d = n.lastIndexOf('.');
    return d > 0 ? n.slice(d + 1).toLowerCase() : '';
  }
  function secFmt(s) {
    if (!isFinite(s) || s < 0) return '-';
    var m = Math.floor(s / 60), r = s - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(r < 10 ? 1 : 0);
  }
  function blobToU8(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(new Uint8Array(fr.result)); };
      fr.onerror = function () { rej(new Error('读取失败')); };
      fr.readAsArrayBuffer(blob);
    });
  }
  /** 秒 → "3分12秒" / "12秒" */
  function durFmt(s) {
    if (!isFinite(s) || s < 0) return '-';
    s = Math.round(s);
    if (s < 60) return s + '秒';
    var m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return m + '分' + (r ? r + '秒' : '');
    var h = Math.floor(m / 60);
    return h + '小时' + (m % 60 ? (m % 60) + '分' : '');
  }
  function clockOf(d) {
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /* ================= 剩余时间估算器 =================
   * 用「已完成任务的实测速度」预测剩余，滑动窗口平滑，
   * 避免单个文件大小差异导致估计值剧烈跳动。
   */
  function Eta(sizes) {
    var hist = [];                    // {bytes, ms}
    var t0 = Date.now();
    return {
      total: sizes.reduce(function (a, b) { return a + b; }, 0),
      begin: function () { t0 = Date.now(); hist = []; },
      /** 记一次实测：处理了 bytes 字节、耗时 ms */
      mark: function (bytes, ms) {
        if (bytes > 0 && ms > 0) {
          hist.push({ bytes: bytes, ms: ms });
          if (hist.length > 6) hist.shift();     // 只留最近 6 次
        }
      },
      /** 估算剩余秒数；样本不足时返回 null（UI 显示“估算中”） */
      left: function (doneBytes) {
        var rest = this.total - doneBytes;
        if (rest <= 0) return 0;
        if (!hist.length) return null;
        var b = 0, m = 0;
        hist.forEach(function (h) { b += h.bytes; m += h.ms; });
        if (!b) return null;
        return rest * (m / b) / 1000;
      },
      elapsed: function () { return (Date.now() - t0) / 1000; }
    };
  }

  /* ================= 转换日志 ================= */
  function LogBox(root, title) {
    var open = false, lines = 0;
    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<div class="au-log-t" data-lt><span class="ar">▶</span><span>' + U.esc(title) + '</span>' +
      '<span class="cnt" data-lc>0</span></div>' +
      '<div class="au-log" data-lb hidden></div>';
    root.querySelector('[data-lganchor]').appendChild(wrap);
    var t = wrap.querySelector('[data-lt]');
    var box = wrap.querySelector('[data-lb]');
    var cnt = wrap.querySelector('[data-lc]');

    t.onclick = function () {
      open = !open;
      t.classList.toggle('open', open);
      box.hidden = !open;
      if (open) box.scrollTop = box.scrollHeight;
    };

    return {
      /** kind: '' | 'ok' | 'err' | 'warn' | 'dim' | 'hl' */
      add: function (msg, kind) {
        lines++;
        if (lines > 800) { box.removeChild(box.firstChild); lines--; }   // 防内存膨胀
        var d = document.createElement('div');
        d.innerHTML = '<span class="tm">' + clockOf(new Date()) + '</span>' +
          '<span class="' + (kind || '') + '">' + U.esc(msg) + '</span>';
        box.appendChild(d);
        if (cnt) cnt.textContent = String(lines);
        if (open) box.scrollTop = box.scrollHeight;
        else if (kind === 'err') {                    // 有错时自动展开
          open = true; t.classList.add('open'); box.hidden = false;
          box.scrollTop = box.scrollHeight;
        }
        return msg;
      },
      clear: function () { box.innerHTML = ''; lines = 0; if (cnt) cnt.textContent = '0'; }
    };
  }

  /* ================= 摘要统计 ================= */
  function StatBar(root) {
    var el = root.querySelector('[data-stat]');
    return {
      show: function (rows) {
        el.classList.remove('hidden');
        el.innerHTML = rows.map(function (r) {
          return '<div class="' + (r.cls || '') + '">' + U.esc(r.k) +
            '<b>' + U.esc(String(r.v)) + '</b></div>';
        }).join('');
      },
      hide: function () { el.classList.add('hidden'); el.innerHTML = ''; }
    };
  }

  /* ================= 音频引擎（纯前端） ================= */

  var Eng = {
    /** 解码任意「纯音频容器」为 AudioBuffer。失败时抛出带说明的错误。 */
    decode: function (arrayBuffer, filename) {
      var ext = extOf(filename);
      if (NEVER_LOCAL.indexOf(ext) >= 0) {
        var e = new Error('MKV_NEED_SERVER');
        e.reason = '浏览器不支持 ' + ext.toUpperCase() + ' 容器';
        throw e;
      }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('浏览器不支持 Web Audio API');
      var ac = new AC();
      return new Promise(function (res, rej) {
        // 回调式（兼容 Safari 老版本，它不返回 Promise）
        var done = false;
        var ok = function (buf) { if (!done) { done = true; res(buf); } };
        var no = function (err) {
          if (done) return;
          done = true;
          var e2 = new Error('CANNOT_DECODE');
          e2.reason = '这个文件没法直接解码（可能是 ' + (ext || '未知') + ' 格式）';
          e2.raw = err;
          rej(e2);
        };
        try {
          var p = ac.decodeAudioData(arrayBuffer, ok, no);
          if (p && p.then) p.then(ok, no);
        } catch (err) { no(err); }
      }).then(function (buf) { return { buf: buf, ac: ac }; });
    },

    /** AudioBuffer → WAV（16 位 PCM，真无损） */
    pcmWav: function (buf) {
      var nCh = buf.numberOfChannels, sr = buf.sampleRate, n = buf.length;
      var bytes = n * nCh * 2;
      var ab = new ArrayBuffer(44 + bytes), v = new DataView(ab);
      var str = function (off, s) {
        for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
      };
      str(0, 'RIFF');
      v.setUint32(4, 36 + bytes, true);
      str(8, 'WAVE');
      str(12, 'fmt ');
      v.setUint32(16, 16, true);
      v.setUint16(20, 1, true);          // PCM
      v.setUint16(22, nCh, true);
      v.setUint32(24, sr, true);
      v.setUint32(28, sr * nCh * 2, true);   // byte rate
      v.setUint16(32, nCh * 2, true);        // block align
      v.setUint16(34, 16, true);             // bits
      str(36, 'data');
      v.setUint32(40, bytes, true);

      var chs = [], c;
      for (c = 0; c < nCh; c++) chs.push(buf.getChannelData(c));
      var off = 44, i, s;
      for (i = 0; i < n; i++) {
        for (c = 0; c < nCh; c++) {
          s = chs[c][i];
          s = s < -1 ? -1 : (s > 1 ? 1 : s);
          v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
          off += 2;
        }
      }
      return new Blob([ab], { type: 'audio/wav' });
    },

    /** AudioBuffer → MP3（lamejs，分块让出主线程） */
    mp3: function (buf, kbps) {
      return U.loadScript('assets/lib/lame.min.js').then(function () {
        var lame = window.lamejs;
        if (!lame) throw new Error('MP3 编码器未能加载');
        var nCh = Math.min(2, buf.numberOfChannels);
        var sr = buf.sampleRate;
        var enc = new lame.Mp3Encoder(nCh, sr, kbps || 192);
        var L = buf.getChannelData(0);
        var R = nCh > 1 ? buf.getChannelData(1) : null;
        var BLK = 1152 * 40;                 // 约 1 秒一块
        var out = [], i, l, r, blk;
        var toI16 = function (f32, from, to) {
          var a = new Int16Array(to - from);
          for (var k = 0; k < a.length; k++) {
            var s = f32[from + k];
            s = s < -1 ? -1 : (s > 1 ? 1 : s);
            a[k] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          return a;
        };
        for (i = 0; i < buf.length; i += BLK) {
          var end = Math.min(i + BLK, buf.length);
          l = toI16(L, i, end);
          r = R ? toI16(R, i, end) : l;
          blk = nCh > 1 ? enc.encodeBuffer(l, r) : enc.encodeBuffer(l);
          if (blk.length) out.push(new Uint8Array(blk));
        }
        blk = enc.flush();
        if (blk.length) out.push(new Uint8Array(blk));
        return new Blob(out, { type: 'audio/mpeg' });
      });
    },

    /** AudioBuffer → WebM/Opus（MediaRecorder 实时录音，故耗时≈音频时长） */
    rec: function (buf, recMime) {
      return new Promise(function (res, rej) {
        if (typeof window.MediaRecorder === 'undefined') {
          rej(new Error('浏览器不支持 MediaRecorder'));
          return;
        }
        var AC = window.AudioContext || window.webkitAudioContext;
        var ac = new AC();
        var dest = ac.createMediaStreamDestination();
        var src = ac.createBufferSource();
        src.buffer = buf;
        src.connect(dest);
        var mime = recMime || 'audio/webm';
        if (window.MediaRecorder.isTypeSupported && !window.MediaRecorder.isTypeSupported(mime)) {
          mime = 'audio/webm';
          if (!window.MediaRecorder.isTypeSupported(mime)) {
            rej(new Error('浏览器不支持录制 webm'));
            return;
          }
        }
        var chunks = [];
        var mr;
        try { mr = new MediaRecorder(dest.stream, { mimeType: mime }); }
        catch (e) { rej(new Error('MediaRecorder 初始化失败：' + e.message)); return; }
        mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        mr.onerror = function () { rej(new Error('录制出错')); };
        mr.onstop = function () {
          try { ac.close(); } catch (_) { }
          if (!chunks.length) { rej(new Error('录制结果为空')); return; }
          res(new Blob(chunks, { type: mime }));
        };
        mr.start();
        src.start();
        src.onended = function () { setTimeout(function () { try { mr.stop(); } catch (_) { } }, 120); };
      });
    }
  };

  /* ================= 后端接口（ffmpeg） ================= */

  var Srv = {
    /** 探测后端是否可用（决定 MKV 等能否处理） */
    probe: function () {
      if (Srv._p) return Srv._p;
      Srv._p = fetch('api/audio', { method: 'GET' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { return !!(j && j.ffmpeg); })
        .catch(function () { return false; });
      return Srv._p;
    },

    /**
     * 上传并转码。
     * @param {File} file
     * @param {string} to      目标格式 mp3/m4a/wav/ogg/flac/opus
     * @param {number} kbps    码率（wav/flac 忽略）
     * @param {boolean} lossless 是否优先无损搬轨
     * @param {function} onProg 上传进度回调 0~100
     */
    convert: function (file, to, kbps, lossless, onProg) {
      return new Promise(function (res, rej) {
        var q = 'to=' + encodeURIComponent(to) + '&kbps=' + (kbps || '') +
          '&lossless=' + (lossless ? '1' : '0') +
          '&name=' + encodeURIComponent(file.name || 'input');
        var xhr = new XMLHttpRequest();
        xhr.open('POST', 'api/audio?' + q, true);
        xhr.responseType = 'blob';
        xhr.upload.onprogress = function (e) {
          if (onProg && e.lengthComputable) onProg(Math.round(e.loaded / e.total * 92));
        };
        xhr.onload = function () {
          if (xhr.status !== 200) {
            var msg = '后端转码失败（HTTP ' + xhr.status + '）';
            var b = xhr.response;
            if (b && b.size) {
              // 错误体是 JSON
              var fr = new FileReader();
              fr.onload = function () {
                try {
                  var j = JSON.parse(fr.result);
                  rej(new Error(j.error || msg));
                } catch (e) { rej(new Error(msg)); }
              };
              fr.onerror = function () { rej(new Error(msg)); };
              fr.readAsText(b);
            } else rej(new Error(msg));
            return;
          }
          if (onProg) onProg(100);
          // 从响应头取回真实扩展名（后端可能因编码限制改了容器）
          var ext = to;
          var cd = xhr.getResponseHeader('X-Out-Ext');
          if (cd) ext = cd;
          res({ blob: xhr.response, ext: ext });
        };
        xhr.onerror = function () { rej(new Error('上传失败，请检查网络或后端服务')); };
        var fd = new FormData();
        fd.append('file', file, file.name || 'input');
        xhr.send(fd);
      });
    }
  };

  /* ================= 页面骨架 ================= */

  /* 把「引擎判断」抽出来，UI 和转换流程共用同一套判断
     opts.video = true 时（视频提取工具），mp4/mov/webm 这类「可能带视频轨」的
     容器一律直接走后端 —— 浏览器 decodeAudioData 遇到视频轨必失败，
     硬走本地只会白等一轮再回退，标签还会骗用户说「不上传」。 */
  function planFor(name, to, lossless, opts) {
    var ext = extOf(name);
    var local = LOCAL_OUT[to];
    var canLocal = !!local;

    if (NEVER_LOCAL.indexOf(ext) >= 0) {
      return { engine: 'server', why: ext.toUpperCase() + ' 容器浏览器不支持' };
    }
    if (!canLocal) {
      return { engine: 'server', why: to.toUpperCase() + ' 浏览器不会编码' };
    }
    if (opts && opts.video && VIDEOISH.indexOf(ext) >= 0) {
      return { engine: 'server', why: '视频文件里的音轨需后端拆出（浏览器读不了视频轨）' };
    }
    /* 目标 m4a 但本地只能录出 WebM —— 无论无损与否都必须走后端，
       否则会产出「扩展名是 m4a、内容是 webm」的坏文件。 */
    if (to === 'm4a' && local.ext !== 'm4a') {
      return { engine: 'server', mode: null, why: '浏览器只能录 WebM/Opus，M4A 需后端' };
    }
    if (lossless) {
      // 想无损，但源格式与目标能一致才成立
      // m4a 源 → m4a 目标：可直接复制，但浏览器做不到容器拷贝，仍需后端
      if ((to === 'mp3' && ext === 'mp3') || (to === 'wav' && ext === 'wav')) {
        return { engine: 'local', mode: 'copy', why: '同格式，直接保留原始数据（真正无损）' };
      }
      if (to === 'mp3' && (ext === 'm4a' || ext === 'aac' || ext === 'wav' || ext === 'flac')) {
        // 无损搬轨在浏览器里做不到，但可以「高码率重编码」近似
        return {
          engine: 'local', mode: 'lossy-best',
          why: '浏览器无法搬轨，改用最高码率重编码（320kbps）'
        };
      }
      if (to === 'wav') {
        return { engine: 'local', mode: 'pcm', why: '解码为 PCM，内容与原音一致（无损）' };
      }
    }
    return { engine: 'local', mode: local.mode, why: '' };
  }

  function engineBadge(plan) {
    if (plan.engine === 'server') {
      return '<span class="au-eng au-eng-s" title="' + U.esc(plan.why) + '">服务器</span>';
    }
    if (plan.mode === 'copy') return '<span class="au-eng au-eng-c" title="' + U.esc(plan.why) + '">无损</span>';
    return '<span class="au-eng au-eng-l" title="' + U.esc(plan.why || '浏览器本地完成') + '">本地</span>';
  }

  /* ================= 共用：任务队列渲染 ================= */

  function statusText(t) {
    if (t.state === 'wait') return '等待';
    if (t.state === 'run') return t.note || '处理中…';
    if (t.state === 'ok') return '完成 ' + fmtSize(t.out ? t.out.size : 0);
    if (t.state === 'err') return t.err || '失败';
    return '';
  }

  function renderList(root, items, idx, ops) {
    var box = root.querySelector('.au-list');
    if (!items.length) {
      box.innerHTML = '<div class="au-empty">还没有文件。用上面的区域选择，或直接把文件拖进来。</div>';
      return;
    }
    box.innerHTML = items.map(function (t, i) {
      var cls = 'au-item' + (i === idx ? ' on' : '') +
        (t.state === 'err' ? ' bad' : '') + (t.state === 'run' ? ' run' : '');
      var plan = t.plan || planFor(t.file.name, ops.out(), ops.lossless(), ops);
      var extra = '';
      if (t.state === 'ok' && t.out) {
        var d = t.out.size - t.file.size;
        var pct = t.file.size ? Math.round(d / t.file.size * 100) : 0;
        extra = ' · 原 ' + fmtSize(t.file.size) +
          (pct < 0 ? ' ↓' + Math.abs(pct) + '%' : (pct > 0 ? ' ↑' + pct + '%' : ''));
      }
      return '<div class="' + cls + '" data-i="' + i + '">' +
        '<div class="au-item-main">' +
        '<div class="au-item-n" title="' + U.esc(t.file.name) + '">' + U.esc(t.file.name) + '</div>' +
        '<div class="au-item-m">' + fmtSize(t.file.size) +
        (t.dur ? ' · ' + secFmt(t.dur) : '') +
        ' → <b>' + (t.outExt || ops.out() || '?').toUpperCase() + '</b>' + engineBadge(plan) +
        U.esc(extra) + '</div>' +
        '<div class="au-bar"><i data-bar="' + i + '"></i></div>' +
        '</div>' +
        '<div class="au-item-s" title="' + U.esc(statusText(t)) + '">' + U.esc(statusText(t)) + '</div>' +
        '<button class="au-x" data-del="' + i + '" title="移除">×</button>' +
        '</div>';
    }).join('');
  }

  /** 只更新某一档的进度条，不重绘整个列表（避免拖慢大批量） */
  function setItemProg(root, i, pct) {
    var b = root.querySelector('[data-bar="' + i + '"]');
    if (b) b.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  /* ================= 工具 1：音频互转 ================= */

  function audioTool() {
    var S = {
      items: [], idx: -1, out: 'mp3', kbps: 192, lossless: true, running: false
    };

    function outOpts() {
      return '<option value="">选择输出格式</option>' + A_OUT.map(function (o) {
        return '<option value="' + o.v + '">' + o.label + '　' + o.hint + '</option>';
      }).join('');
    }

    return {
      tpl: function () {
        return '<div id="auApp">' +
          '<div class="t-section"><div class="sec-t">1 · 添加音频</div>' +
          '<div class="drop-zone" id="auDrop">' +
          '<div class="drop-ico">' + LB.util.iconAudio() + '</div>' +
          '<div class="drop-t">把音频拖到这里，或点击选择</div>' +
          '<div class="drop-s">支持 MP3 / M4A / WAV / OGG / FLAC / AAC · 单文件最大 ' + MAX_A + 'MB · 最多 ' + MAX_N + ' 个</div>' +
          '<input type="file" id="auFile" accept="audio/*,.mp3,.m4a,.wav,.ogg,.flac,.aac,.opus" multiple hidden>' +
          '</div>' +
          '<div class="au-list" id="auList"></div>' +
          '</div>' +

          '<div class="t-section"><div class="sec-t">2 · 转换设置</div>' +
          '<div class="row tight">' +
          '<div class="field"><label class="field-l">输出格式</label>' +
          '<select id="auOut">' + outOpts() + '</select></div>' +
          '<div class="field"><label class="field-l">码率</label>' +
          '<select id="auRate">' + RATES.map(function (r) {
            return '<option value="' + r.v + '"' + (r.v === 192 ? ' selected' : '') + '>' +
              r.label + '　' + r.hint + '</option>';
          }).join('') + '</select></div>' +
          '</div>' +
          '<label class="ck"><input type="checkbox" id="auLoss" checked>' +
          '<span>尽量无损（能搬轨就不重编码；无法搬轨时自动用最高码率）</span></label>' +
          '<div class="hint" id="auTip">选好格式后，每个文件会标明走<b>本地</b>（不上传）还是<b>服务器</b>。</div>' +
          '</div>' +

          '<div class="t-section"><div class="sec-t">3 · 开始转换</div>' +
          '<div class="btn-group">' +
          '<button class="btn btn-pri" id="auGo">开始转换</button>' +
          '<button class="btn" id="auClear">清空</button>' +
          '</div>' +
          '<div class="au-prog" id="auProg" hidden><i data-total></i></div>' +
          '<div class="au-status" id="auStatus"></div>' +
          '<div class="au-stat hidden" data-stat></div>' +
          '<div data-lganchor></div>' +
          '</div>' +
          '</div>';
      },
      init: function (root) {
        var $ = function (s) { return root.querySelector(s); };
        var drop = $('#auDrop'), fi = $('#auFile');

        function planOf(t) { return planFor(t.file.name, S.out, S.lossless); }
        function draw() {
          renderList(root, S.items, S.idx, {
            out: function () { return S.out; },
            lossless: function () { return S.lossless; }
          });
          var serverCnt = S.items.filter(function (t) { return planOf(t).engine === 'server'; }).length;
          var tip = $('#auTip');
          if (!S.items.length) {
            tip.innerHTML = '选好格式后，每个文件会标明走<b>本地</b>（不上传）还是<b>服务器</b>。';
          } else if (serverCnt) {
            tip.innerHTML = '这 ' + serverCnt + ' 个文件需要<b>服务器</b>转码（会先上传到服务器再返回）。' +
              '其余在浏览器本地完成，不上传。';
          } else {
            tip.innerHTML = '全部可在<b>本地</b>完成，文件不会离开这台电脑。';
          }
        }
        window.__auDraw1 = draw;

        function add(files) {
          var arr = Array.prototype.slice.call(files);
          var skip = 0;
          arr.forEach(function (f) {
            if (S.items.length >= MAX_N) { skip++; return; }
            if (!/^audio\//.test(f.type) && !/\.(mp3|m4a|wav|ogg|oga|flac|aac|opus|weba)$/i.test(f.name)) {
              // 也允许拖到视频（会提示需后端）
              if (!/\.(mp4|mov|mkv|webm|avi|wmv|flv|ts)$/i.test(f.name)) { skip++; return; }
            }
            if (f.size > MAX_A * 1048576) { skip++; return; }
            S.items.push({ file: f, state: 'wait', outExt: null, out: null, dur: 0 });
          });
          if (arr.length) S.idx = S.items.length - 1;
          draw();
          if (skip) U.toast(skip + ' 个文件被跳过（格式不支持或超过 ' + MAX_A + 'MB）', 'err');
        }

        drop.onclick = function () { fi.click(); };
        fi.onchange = function () { add(this.files); this.value = ''; };
        ['dragenter', 'dragover'].forEach(function (ev) {
          drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
        });
        ['dragleave', 'drop'].forEach(function (ev) {
          drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
        });
        drop.addEventListener('drop', function (e) {
          if (e.dataTransfer && e.dataTransfer.files) add(e.dataTransfer.files);
        });

        root.addEventListener('click', function (e) {
          var del = e.target.closest ? e.target.closest('[data-del]') : null;
          if (del) {
            var i = Number(del.dataset.del);
            S.items.splice(i, 1);
            if (S.idx >= S.items.length) S.idx = S.items.length - 1;
            draw();
            return;
          }
          var it = e.target.closest ? e.target.closest('.au-item') : null;
          if (it) { S.idx = Number(it.dataset.i); draw(); }
        });

        $('#auOut').onchange = function () {
          S.out = this.value;
          S.items.forEach(function (t) { t.state = 'wait'; t.out = null; t.outExt = null; });
          draw();
        };
        $('#auRate').onchange = function () { S.kbps = Number(this.value); };
        $('#auLoss').onchange = function () { S.lossless = this.checked; draw(); };
        $('#auClear').onclick = function () {
          S.items = []; S.idx = -1;
          $('#auStatus').textContent = '';
          draw();
        };
        $('#auGo').onclick = function () { run(); };

        function setProg(p) {
          var box = $('#auProg');
          if (p == null) { box.hidden = true; return; }
          box.hidden = false;
          box.querySelector('[data-total]').style.width = p + '%';
        }

        function needOut() {
          if (!S.out) { U.toast('请先选择输出格式', 'err'); return false; }
          if (!S.items.length) { U.toast('请先添加音频文件', 'err'); return false; }
          if (S.running) { U.toast('正在转换，稍等一下', 'err'); return false; }
          return true;
        }

        function run() {
          if (!needOut()) return;
          S.running = true;

          var st = $('#auStatus'), stat = StatBar(root), lg = LogBox(root, '转换日志');
          lg.clear();
          lg.add('开始批量转换，共 ' + S.items.length + ' 个文件，输出 ' + S.out.toUpperCase() +
            '（' + S.kbps + ' kbps，' + (S.lossless ? '优先无损' : '标准重编码') + '）', 'hl');
          stat.hide();

          var todo = S.items.filter(function (t) { return t.state !== 'ok'; });
          todo.forEach(function (t) { t.state = 'wait'; t.err = ''; t.note = ''; t.out = null; });
          if (!todo.length) { S.running = false; U.toast('都已经转换完成了', 'ok'); return; }

          var eta = Eta(todo.map(function (t) { return t.file.size; }));
          eta.begin();
          var doneBytes = 0;
          var i = 0, outOk = [], fail = 0;
          var tStart = 0, tBytes = 0;
          var uiTimer = null;

          /* 剩余时间刷新：每秒一次，与转换本身解耦 */
          function tickUI() {
            var left = eta.left(doneBytes);
            var el = eta.elapsed();
            var tail = ' · 已用 ' + durFmt(el) +
              (left == null ? ' · 剩余估算中…' : ' · 剩余约 ' + durFmt(left));
            var base = st.getAttribute('data-msg') || '';
            st.innerHTML = base + '<span class="eta">' + tail + '</span>';
          }

          function msg(html) {
            st.setAttribute('data-msg', html);
            tickUI();
          }

          function step() {
            if (i >= todo.length) return Promise.resolve();
            var t = todo[i++], plan = planOf(t);
            t.plan = plan;
            t.state = 'run';
            t.note = plan.engine === 'server' ? '上传并转码…' : '本地转码…';
            msg('正在处理 <b>' + i + ' / ' + todo.length + '</b>：' + U.esc(t.file.name));
            draw();
            tStart = Date.now(); tBytes = t.file.size;

            var idxInAll = S.items.indexOf(t);
            var localPct = 0;
            /* 本地任务没有真实进度事件，用「已耗时 / 预估耗时」做平滑推进 */
            var fakeTimer = null;
            if (plan.engine !== 'server') {
              var estMs = Math.max(600, t.file.size / 1048576 * 900);   // 约 0.9s/MB 经验值
              fakeTimer = setInterval(function () {
                localPct = Math.min(94, localPct + (100 - localPct) * 0.08);
                setItemProg(root, idxInAll, localPct);
              }, 200);
            }
            function stopFake() { if (fakeTimer) { clearInterval(fakeTimer); fakeTimer = null; } }

            var job;
            if (plan.engine === 'server') {
              lg.add('  ' + t.file.name + ' → 上传到服务器转码' + (plan.mode === 'copy' ? '（无损搬轨）' : ''), 'dim');
              job = Srv.convert(t.file, S.out, S.kbps, S.lossless, function (p) {
                setItemProg(root, idxInAll, p);
                var base = (i - 1) / todo.length * 100;
                setProg(Math.round(base + p / todo.length));
              }).then(function (r) { return { blob: r.blob, ext: r.ext }; });
            } else {
              job = localConvert(t.file, S.out, S.kbps, plan).then(function (r) {
                return { blob: r, ext: (LOCAL_OUT[S.out] || {}).ext || S.out };
              });
            }

            return job.then(function (r) {
              stopFake();
              setItemProg(root, idxInAll, 100);
              t.out = r.blob;
              t.outExt = r.ext;
              t.state = 'ok';
              t.note = '';
              outOk.push(t);
              doneBytes += tBytes;
              eta.mark(tBytes, Date.now() - tStart);
              lg.add('  ✓ ' + t.file.name + ' → ' + (r.ext || S.out).toUpperCase() +
                '  ' + fmtSize(r.blob.size) + '  用时 ' + ((Date.now() - tStart) / 1000).toFixed(1) + 's', 'ok');
              setProg(Math.round(i / todo.length * 100));
              return step();
            }).catch(function (e) {
              stopFake();
              var m = e && e.message;
              /* 本地解不了 → 自动改走后端兜底 */
              if (m === 'MKV_NEED_SERVER' || m === 'CANNOT_DECODE') {
                lg.add('  ' + t.file.name + '：本地无法解码（' + (e.reason || '') + '），改走服务器', 'warn');
                return Srv.probe().then(function (ok) {
                  if (!ok) throw new Error((e.reason || '本地无法解码') + '，且服务器未启用转码功能');
                  t.state = 'run';
                  t.note = '转交服务器…';
                  draw();
                  return Srv.convert(t.file, S.out, S.kbps, S.lossless, function (p) {
                    setItemProg(root, idxInAll, p);
                    var base = (i - 1) / todo.length * 100;
                    setProg(Math.round(base + p / todo.length));
                  }).then(function (r) {
                    setItemProg(root, idxInAll, 100);
                    t.out = r.blob; t.outExt = r.ext; t.state = 'ok'; t.note = '';
                    outOk.push(t);
                    doneBytes += tBytes;
                    eta.mark(tBytes, Date.now() - tStart);
                    lg.add('  ✓ ' + t.file.name + '（服务器）→ ' + (r.ext || S.out).toUpperCase() +
                      '  ' + fmtSize(r.blob.size), 'ok');
                    setProg(Math.round(i / todo.length * 100));
                    return step();
                  });
                }).catch(function (e2) {
                  t.state = 'err';
                  t.err = e2.message || '转换失败';
                  fail++;
                  doneBytes += tBytes;
                  lg.add('  ✗ ' + t.file.name + '：' + t.err, 'err');
                  setProg(Math.round(i / todo.length * 100));
                  return step();
                });
              }
              t.state = 'err';
              t.err = m || '转换失败';
              fail++;
              doneBytes += tBytes;
              eta.mark(tBytes, Date.now() - tStart);
              lg.add('  ✗ ' + t.file.name + '：' + t.err, 'err');
              setProg(Math.round(i / todo.length * 100));
              return step();
            });
          }

          uiTimer = setInterval(tickUI, 1000);
          msg('准备开始…');

          step().then(function () {
            S.running = false;
            clearInterval(uiTimer);
            setProg(100);
            draw();

            var totalOut = outOk.reduce(function (a, t) { return a + t.out.size; }, 0);
            var totalIn = todo.reduce(function (a, t) { return a + t.file.size; }, 0);
            var secs = eta.elapsed();
            stat.show([
              { k: '成功', v: outOk.length + ' 个', cls: 'g' },
              { k: '失败', v: fail + ' 个', cls: fail ? 'r' : '' },
              { k: '总输入', v: fmtSize(totalIn) },
              { k: '总输出', v: fmtSize(totalOut) },
              { k: '总耗时', v: durFmt(secs) },
              { k: '平均速度', v: secs > 0 ? fmtSize(totalIn / secs) + '/s' : '-' }
            ]);
            lg.add('全部结束：成功 ' + outOk.length + '，失败 ' + fail +
              '，共耗时 ' + durFmt(secs), fail ? 'warn' : 'ok');

            if (!outOk.length) {
              msg('全部失败');
              U.toast('转换失败，看日志里的原因', 'err');
              return;
            }
            if (outOk.length === 1) {
              var t = outOk[0];
              var nm = baseName(t.file.name) + '.' + (t.outExt || S.out);
              U.saveBlob(nm, t.out);
              msg('已下载 <b>' + U.esc(nm) + '</b>（' + fmtSize(t.out.size) + '）' +
                (fail ? '，' + fail + ' 个失败' : ''));
              return;
            }
            msg('正在打包 ' + outOk.length + ' 个…');
            lg.add('打包 ZIP…', 'dim');
            Promise.all(outOk.map(function (t) {
              return blobToU8(t.out).then(function (u8) {
                return { name: baseName(t.file.name) + '.' + (t.outExt || S.out), data: u8 };
              });
            })).then(function (es) {
              var zb = U.zipStore(es);
              U.saveBlob('音频转换_' + es.length + '个.zip', zb);
              msg('已打包 <b>' + es.length + '</b> 个（' + fmtSize(zb.size) + '）' +
                (fail ? '，' + fail + ' 个失败' : ''));
              lg.add('已下载 ZIP：' + fmtSize(zb.size), 'ok');
            }).catch(function (e) {
              msg('打包失败：' + U.esc(e.message));
              lg.add('打包失败：' + e.message, 'err');
            });
          });
        }

        function localConvert(file, to, kbps, plan) {
          if (plan.mode === 'copy') {
            // 同格式：原样输出（真正无损）
            return Promise.resolve(file);
          }
          return blobToU8(file).then(function (u8) {
            // decodeAudioData 会「消耗」ArrayBuffer，传副本更稳
            return Eng.decode(u8.buffer.slice(0));
          }).then(function (r) {
            var buf = r.buf;
            try { r.ac.close(); } catch (_) { }
            if (plan.mode === 'pcm') return Eng.pcmWav(buf);
            if (plan.mode === 'lame') return Eng.mp3(buf, plan.mode === 'lossy-best' ? 320 : kbps);
            if (plan.mode === 'rec') return Eng.rec(buf, (LOCAL_OUT[to] || {}).recMime);
            return Eng.pcmWav(buf);
          });
        }

        draw();
      }
    };
  }

  /* ================= 工具 2：视频提取音频 ================= */

  function videoTool() {
    var S = { items: [], idx: -1, out: 'mp3', kbps: 192, lossless: true, running: false, backend: null };

    return {
      tpl: function () {
        return '<div id="avApp">' +
          '<div class="t-section"><div class="sec-t">1 · 添加视频</div>' +
          '<div class="drop-zone" id="avDrop">' +
          '<div class="drop-ico">' + LB.util.iconVideo() + '</div>' +
          '<div class="drop-t">把视频拖到这里，或点击选择</div>' +
          '<div class="drop-s">MP4 / MOV / MKV / WEBM → MP3 / M4A / WAV · 单文件最大 ' + MAX_V + 'MB</div>' +
          '<input type="file" id="avFile" accept="video/*,.mp4,.mov,.mkv,.webm,.avi,.wmv,.flv,.ts" multiple hidden>' +
          '</div>' +
          '<div class="au-list" id="avList"></div>' +
          '</div>' +

          '<div class="t-section"><div class="sec-t">2 · 提取设置</div>' +
          '<div class="row tight">' +
          '<div class="field"><label class="field-l">输出格式</label>' +
          '<select id="avOut"><option value="">选择输出格式</option>' + V_OUT.map(function (o) {
            return '<option value="' + o.v + '">' + o.label + '　' + o.hint + '</option>';
          }).join('') + '</select></div>' +
          '<div class="field"><label class="field-l">码率</label>' +
          '<select id="avRate">' + RATES.map(function (r) {
            return '<option value="' + r.v + '"' + (r.v === 192 ? ' selected' : '') + '>' +
              r.label + '　' + r.hint + '</option>';
          }).join('') + '</select></div>' +
          '</div>' +
          '<label class="ck"><input type="checkbox" id="avLoss" checked>' +
          '<span>优先无损提取（直接把原音频轨搬出来，速度极快、音质 100% 保留）</span></label>' +
          '<div class="au-note" id="avNote"></div>' +
          '</div>' +

          '<div class="t-section"><div class="sec-t">3 · 开始提取</div>' +
          '<div class="btn-group">' +
          '<button class="btn btn-pri" id="avGo">开始提取</button>' +
          '<button class="btn" id="avClear">清空</button>' +
          '</div>' +
          '<div class="au-prog" id="avProg" hidden><i data-total></i></div>' +
          '<div class="au-status" id="avStatus"></div>' +
          '<div class="au-stat hidden" data-stat></div>' +
          '<div data-lganchor></div>' +
          '</div>' +
          '</div>';
      },
      init: function (root) {
        var $ = function (s) { return root.querySelector(s); };
        var drop = $('#avDrop'), fi = $('#avFile');

        function planOf(t) { return planFor(t.file.name, S.out, S.lossless, { video: true }); }

        function draw() {
          renderList(root, S.items, S.idx, {
            out: function () { return S.out; },
            lossless: function () { return S.lossless; },
            video: true
          });
        }
        window.__avDraw2 = draw;

        /* 后端可用性探测 —— 决定 MKV 能否处理 */
        Srv.probe().then(function (ok) {
          S.backend = ok;
          var n = $('#avNote');
          if (ok) {
            n.className = 'au-note ok';
            n.innerHTML = '已连接转码服务：<b>MKV / MOV / WEBM 等带视频轨的文件也能处理</b>，' +
              '并支持无损提取原音频轨。';
          } else {
            n.className = 'au-note warn';
            n.innerHTML = '未连接转码服务：<b>只能处理 MP4 / MOV（不含视频轨或可解码的）</b>。' +
              'MKV 需要后端支持 —— 详见部署说明。';
          }
        });

        function add(files) {
          var arr = Array.prototype.slice.call(files), skip = 0;
          arr.forEach(function (f) {
            if (S.items.length >= MAX_N) { skip++; return; }
            if (!/^video\//.test(f.type) && !/\.(mp4|mov|mkv|webm|avi|wmv|flv|ts|m2ts|3gp)$/i.test(f.name)) {
              skip++; return;
            }
            if (f.size > MAX_V * 1048576) { skip++; return; }
            S.items.push({ file: f, state: 'wait', outExt: null, out: null });
          });
          if (arr.length) S.idx = S.items.length - 1;
          draw();
          if (skip) U.toast(skip + ' 个文件被跳过（格式不支持或超过 ' + MAX_V + 'MB）', 'err');
        }

        drop.onclick = function () { fi.click(); };
        fi.onchange = function () { add(this.files); this.value = ''; };
        ['dragenter', 'dragover'].forEach(function (ev) {
          drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
        });
        ['dragleave', 'drop'].forEach(function (ev) {
          drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
        });
        drop.addEventListener('drop', function (e) {
          if (e.dataTransfer && e.dataTransfer.files) add(e.dataTransfer.files);
        });

        root.addEventListener('click', function (e) {
          var del = e.target.closest ? e.target.closest('[data-del]') : null;
          if (del) {
            S.items.splice(Number(del.dataset.del), 1);
            if (S.idx >= S.items.length) S.idx = S.items.length - 1;
            draw();
            return;
          }
          var it = e.target.closest ? e.target.closest('.au-item') : null;
          if (it) { S.idx = Number(it.dataset.i); draw(); }
        });

        $('#avOut').onchange = function () { S.out = this.value; draw(); };
        $('#avRate').onchange = function () { S.kbps = Number(this.value); };
        $('#avLoss').onchange = function () { S.lossless = this.checked; draw(); };
        $('#avClear').onclick = function () {
          S.items = []; S.idx = -1; $('#avStatus').textContent = ''; draw();
        };
        $('#avGo').onclick = function () { run(); };

        function setProg(p) {
          var box = $('#avProg');
          if (p == null) { box.hidden = true; return; }
          box.hidden = false;
          box.querySelector('[data-total]').style.width = p + '%';
        }

        function needOut() {
          if (!S.out) { U.toast('请先选择输出格式', 'err'); return false; }
          if (!S.items.length) { U.toast('请先添加视频文件', 'err'); return false; }
          if (S.running) { U.toast('正在提取，稍等一下', 'err'); return false; }
          return true;
        }

        /* 视频提取 100% 依赖后端 ffmpeg —— 提前拦一道，
           避免用户选完文件、点了按钮、白等上传才吃一个 503 */
        function run() {
          if (!needOut()) return;
          if (S.backend === false) {
            U.toast('后端转码服务未启用，无法提取视频音频。请看部署说明安装 ffmpeg。', 'err');
            return;
          }
          S.running = true;

          var st = $('#avStatus'), stat = StatBar(root), lg = LogBox(root, '提取日志');
          lg.clear();
          lg.add('开始批量提取，共 ' + S.items.length + ' 个视频，输出 ' + S.out.toUpperCase() +
            '（' + S.kbps + ' kbps，' + (S.lossless ? '优先无损搬轨' : '标准重编码') + '）', 'hl');
          stat.hide();

          var todo = S.items.filter(function (t) { return t.state !== 'ok'; });
          todo.forEach(function (t) { t.state = 'wait'; t.err = ''; t.note = ''; t.out = null; });
          if (!todo.length) { S.running = false; U.toast('都已经提取完成了', 'ok'); return; }

          var eta = Eta(todo.map(function (t) { return t.file.size; }));
          eta.begin();
          var doneBytes = 0;
          var i = 0, outOk = [], fail = 0;
          var tStart = 0, tBytes = 0;
          var uiTimer = null;

          /* 剩余时间刷新：每秒一次，与转码本身解耦 */
          function tickUI() {
            var left = eta.left(doneBytes);
            var el = eta.elapsed();
            var tail = ' · 已用 ' + durFmt(el) +
              (left == null ? ' · 剩余估算中…' : ' · 剩余约 ' + durFmt(left));
            var base = st.getAttribute('data-msg') || '';
            st.innerHTML = base + '<span class="eta">' + tail + '</span>';
          }

          function msg(html) {
            st.setAttribute('data-msg', html);
            tickUI();
          }

          function step() {
            if (i >= todo.length) return Promise.resolve();
            var t = todo[i++];
            var plan = planOf(t);
            t.plan = plan;
            t.state = 'run';
            t.outExt = S.out;
            t.note = '上传并提取…';
            msg('正在处理 <b>' + i + ' / ' + todo.length + '</b>：' + U.esc(t.file.name));
            draw();
            tStart = Date.now(); tBytes = t.file.size;

            var idxInAll = S.items.indexOf(t);
            lg.add('  ' + t.file.name + ' → ' +
              (plan.engine === 'server' ? '上传到服务器提取' : '本地提取') +
              (S.lossless ? '（优先无损搬轨）' : '') +
              (plan.why ? ' · ' + plan.why : ''), 'dim');

            return Srv.convert(t.file, S.out, S.kbps, S.lossless, function (p) {
              setItemProg(root, idxInAll, p);
              var base = (i - 1) / todo.length * 100;
              setProg(Math.round(base + p / todo.length));
            }).then(function (r) {
              setItemProg(root, idxInAll, 100);
              t.out = r.blob; t.outExt = r.ext; t.state = 'ok'; t.note = '';
              outOk.push(t);
              doneBytes += tBytes;
              eta.mark(tBytes, Date.now() - tStart);
              lg.add('  ✓ ' + t.file.name + ' → ' + (r.ext || S.out).toUpperCase() +
                '  ' + fmtSize(r.blob.size) +
                '  用时 ' + ((Date.now() - tStart) / 1000).toFixed(1) + 's', 'ok');
              setProg(Math.round(i / todo.length * 100));
              return step();
            }).catch(function (e) {
              t.state = 'err';
              t.err = e.message || '提取失败';
              fail++;
              doneBytes += tBytes;
              eta.mark(tBytes, Date.now() - tStart);
              lg.add('  ✗ ' + t.file.name + '：' + t.err, 'err');
              setProg(Math.round(i / todo.length * 100));
              return step();
            });
          }

          uiTimer = setInterval(tickUI, 1000);
          msg('准备开始…');

          step().then(function () {
            S.running = false;
            clearInterval(uiTimer);
            setProg(100);
            draw();

            var totalOut = outOk.reduce(function (a, t) { return a + t.out.size; }, 0);
            var totalIn = todo.reduce(function (a, t) { return a + t.file.size; }, 0);
            var secs = eta.elapsed();
            stat.show([
              { k: '成功', v: outOk.length + ' 个', cls: 'g' },
              { k: '失败', v: fail + ' 个', cls: fail ? 'r' : '' },
              { k: '总输入', v: fmtSize(totalIn) },
              { k: '总输出', v: fmtSize(totalOut) },
              { k: '总耗时', v: durFmt(secs) },
              { k: '平均速度', v: secs > 0 ? fmtSize(totalIn / secs) + '/s' : '-' }
            ]);
            lg.add('全部结束：成功 ' + outOk.length + '，失败 ' + fail +
              '，共耗时 ' + durFmt(secs), fail ? 'warn' : 'ok');

            if (!outOk.length) {
              msg('全部失败');
              U.toast('提取失败，看日志里的原因', 'err');
              return;
            }
            if (outOk.length === 1) {
              var t = outOk[0];
              var nm = baseName(t.file.name) + '.' + (t.outExt || S.out);
              U.saveBlob(nm, t.out);
              msg('已下载 <b>' + U.esc(nm) + '</b>（' + fmtSize(t.out.size) + '）' +
                (fail ? '，' + fail + ' 个失败' : ''));
              return;
            }
            msg('正在打包 ' + outOk.length + ' 个…');
            lg.add('打包 ZIP…', 'dim');
            Promise.all(outOk.map(function (t) {
              return blobToU8(t.out).then(function (u8) {
                return { name: baseName(t.file.name) + '.' + (t.outExt || S.out), data: u8 };
              });
            })).then(function (es) {
              var zb = U.zipStore(es);
              U.saveBlob('提取音频_' + es.length + '个.zip', zb);
              msg('已打包 <b>' + es.length + '</b> 个（' + fmtSize(zb.size) + '）' +
                (fail ? '，' + fail + ' 个失败' : ''));
              lg.add('已下载 ZIP：' + fmtSize(zb.size), 'ok');
            }).catch(function (e) {
              msg('打包失败：' + U.esc(e.message));
              lg.add('打包失败：' + e.message, 'err');
            });
          });
        }

        draw();
      }
    };
  }

  /* ================= 注册 ================= */

  var A_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" style="width:1em;height:1em"' +
    ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M9 18V5l12-2v13"/>' +
    '<circle cx="6" cy="18" r="3"/>' +
    '<circle cx="18" cy="16" r="3"/>' +
    '</svg>';

  var V_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" style="width:1em;height:1em"' +
    ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="2" y="4" width="20" height="16" rx="2.5"/>' +
    '<path d="M10 9l5 3-5 3z"/>' +
    '<path d="M17.5 9.5v5"/>' +
    '</svg>';

  LB.util.iconAudio = function () { return A_ICON; };
  LB.util.iconVideo = function () { return V_ICON; };

  LB.register({
    id: 'audio', cat: 'office', icon: A_ICON, name: '音频互转',
    desc: 'MP3 / M4A / WAV / OGG / FLAC 互相转换，可调码率、支持批量打包，尽量无损',
    kw: '音频 音档 音乐 转换 互转 mp3 m4a wav ogg flac aac opus 码率 比特率 压缩 无损 批量',
    tpl: audioTool().tpl,
    init: function (root) { audioTool().init(root); }
  });

  LB.register({
    id: 'audiox', cat: 'office', icon: V_ICON, name: '视频提取音频',
    desc: 'MP4 / MOV / MKV / WEBM 提取音轨为 MP3 / M4A / WAV，可无损直取原音轨',
    kw: '视频 提取 音频 音轨 抽取 mp4 mov mkv webm mp3 m4a wav 转音频 分离音轨 无损',
    tpl: videoTool().tpl,
    init: function (root) { videoTool().init(root); }
  });

})();
