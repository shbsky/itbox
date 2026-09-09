/* ===== IT工具箱 · 核心工具库 ===== */
(function () {
  'use strict';
  var LB = (window.LB = window.LB || {});
  var U = (LB.util = {});

  /* ---------------- 基础 DOM ---------------- */
  U.$ = function (sel, root) { return (root || document).querySelector(sel); };
  U.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  U.el = function (tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  U.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /* ---------------- 提示 ---------------- */
  var toastTimer = null;
  U.toast = function (msg, type) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = (type === 'err' ? '✕ ' : type === 'ok' ? '✓ ' : '') + msg;
    t.style.background = type === 'err' ? '#b91c1c' : type === 'ok' ? '#047857' : '#1e293b';
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2000);
  };

  /* ---------------- 复制（file:// 兼容） ---------------- */
  U.copy = function (text, tip) {
    if (!text) { U.toast('没有可复制的内容', 'err'); return; }
    var done = function () { U.toast(tip || '已复制到剪贴板', 'ok'); };
    var fallback = function () {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? done() : U.toast('复制失败，请手动选择', 'err');
      } catch (e) { U.toast('复制失败，请手动选择', 'err'); }
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else { fallback(); }
  };

  /* ---------------- 数字 / 格式化 ---------------- */
  U.fmtNum = function (n) {
    if (n == null || isNaN(n)) return '-';
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };
  U.pad = function (n, len) {
    var s = String(n);
    while (s.length < (len || 2)) s = '0' + s;
    return s;
  };
  U.fmtDate = function (d, withSec) {
    if (!(d instanceof Date)) d = new Date(d);
    var s = d.getFullYear() + '-' + U.pad(d.getMonth() + 1) + '-' + U.pad(d.getDate()) +
      ' ' + U.pad(d.getHours()) + ':' + U.pad(d.getMinutes());
    return withSec ? s + ':' + U.pad(d.getSeconds()) : s;
  };

  /* ---------------- IPv4 ---------------- */
  U.ip2int = function (ip) {
    var p = String(ip).trim().split('.');
    if (p.length !== 4) throw new Error('IP 格式错误，应为点分十进制（如 192.168.1.1）');
    var n = 0;
    for (var i = 0; i < 4; i++) {
      var v = Number(p[i]);
      if (p[i] === '' || !isFinite(v) || v < 0 || v > 255 || Math.floor(v) !== v)
        throw new Error('IP 每段必须是 0-255 的整数：' + p[i]);
      n = ((n << 8) >>> 0) + v;
    }
    return n >>> 0;
  };
  U.int2ip = function (n) {
    n = n >>> 0;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  };
  U.maskInt = function (bits) {
    bits = Number(bits);
    if (bits < 0 || bits > 32 || isNaN(bits)) throw new Error('掩码位数必须在 0-32 之间');
    if (bits === 0) return 0;
    return (0xFFFFFFFF << (32 - bits)) >>> 0;
  };
  U.maskStr = function (bits) { return U.int2ip(U.maskInt(bits)); };
  U.wildcard = function (bits) { return U.int2ip((~U.maskInt(bits)) >>> 0); };
  /** "192.168.1.0" / "192.168.1.0/24" / "24" → {ip, prefix} */
  U.parseNet = function (s) {
    s = String(s).trim();
    if (s.indexOf('/') >= 0) {
      var a = s.split('/');
      return { ip: U.ip2int(a[0]), prefix: Number(a[1]) };
    }
    if (/^\d{1,2}$/.test(s)) return { ip: 0, prefix: Number(s) };
    return { ip: U.ip2int(s), prefix: null };
  };
  U.ipClass = function (ip) {
    var b = (ip >>> 24) & 255;
    if (b < 128) return 'A 类';
    if (b < 192) return 'B 类';
    if (b < 224) return 'C 类';
    if (b < 240) return 'D 类（组播）';
    return 'E 类（保留）';
  };
  U.ipScope = function (ip) {
    var b = (ip >>> 24) & 255, b2 = (ip >>> 16) & 255;
    if (b === 10) return '私有地址（RFC1918）';
    if (b === 172 && b2 >= 16 && b2 <= 31) return '私有地址（RFC1918）';
    if (b === 192 && b2 === 168) return '私有地址（RFC1918）';
    if (b === 127) return '本地回环（Loopback）';
    if (b === 169 && b2 === 254) return '链路本地（APIPA）';
    if (b >= 224 && b < 240) return '组播地址';
    if (b === 0) return '本网络（保留）';
    if (b === 100 && b2 >= 64 && b2 <= 127) return '运营商级 NAT（CGN）';
    if (b === 192 && b2 === 0 && ((ip >>> 8) & 255) === 2) return 'TEST-NET-1（文档保留）';
    if (b === 198 && b2 === 18) return 'TEST-NET-2（文档保留）';
    if (b === 203 && b2 === 0 && ((ip >>> 8) & 255) === 113) return 'TEST-NET-3（文档保留）';
    if (b === 255) return '广播地址';
    return '公网地址';
  };
  /** IP 范围 → CIDR 列表 */
  U.rangeToCidr = function (start, end) {
    start = start >>> 0; end = end >>> 0;
    if (start > end) throw new Error('起始地址不能大于结束地址');
    var res = [], s = start;
    while (s <= end) {
      var lowbit = s === 0 ? 4294967296 : (s & (-s)) >>> 0;
      var bits = lowbit ? Math.round(Math.log(lowbit) / Math.LN2) : 32;
      var remain = end - s + 1;
      while (bits > 0 && Math.pow(2, bits) > remain) bits--;
      res.push(U.int2ip(s) + '/' + (32 - bits));
      var next = s + Math.pow(2, bits);
      if (next > 4294967295) break;
      s = next >>> 0;
    }
    return res;
  };
  /** CIDR 列表聚合（合并相邻同大小网段） */
  U.mergeCidr = function (items) {
    var arr = items.slice().sort(function (a, b) { return (a.base - b.base) || (a.prefix - b.prefix); });
    // 移除被完全包含的网段
    arr = arr.filter(function (a, i) {
      return !arr.some(function (b, j) {
        if (i === j) return false;
        if (b.prefix > a.prefix) return false;
        var size = Math.pow(2, 32 - b.prefix);
        return a.base >= b.base && a.base < b.base + size;
      });
    });
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < arr.length - 1; i++) {
        var a = arr[i], b = arr[i + 1];
        if (a.prefix === b.prefix && a.prefix > 0) {
          var size = Math.pow(2, 32 - a.prefix);
          if (b.base - a.base === size && (a.base % (size * 2)) === 0) {
            arr.splice(i, 2, { base: a.base, prefix: a.prefix - 1 });
            changed = true;
            break;
          }
        }
      }
    }
    return arr.sort(function (x, y) { return (x.base - y.base) || (x.prefix - y.prefix); })
      .map(function (o) { return U.int2ip(o.base) + '/' + o.prefix; });
  };

  /* ---------------- 进制转换 ---------------- */
  U.convBase = function (val, from, to) {
    var map = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    val = String(val).trim().replace(/[\s_,]/g, '');
    if (!val) throw new Error('请输入数值');
    var neg = false;
    if (val[0] === '-') { neg = true; val = val.slice(1); }
    var dec = 0n;
    if (from === 10) {
      if (!/^\d+$/.test(val)) throw new Error('十进制输入包含非法字符');
      dec = BigInt(val);
    } else {
      var ok = new RegExp('^[0-9a-fA-F]+$');
      if (from === 2 && !/^[01]+$/.test(val)) throw new Error('二进制只能是 0 和 1');
      if ((from === 8 || from === 16) && !ok.test(val)) throw new Error((from === 8 ? '八' : '十六') + '进制输入包含非法字符');
      for (var i = 0; i < val.length; i++) {
        var d = parseInt(val[i], 36);
        if (isNaN(d) || d >= from) throw new Error('数字 ' + val[i] + ' 不属于 ' + from + ' 进制');
        dec = dec * BigInt(from) + BigInt(d);
      }
    }
    if (to === 10) return (neg ? '-' : '') + dec.toString();
    if (dec === 0n) return '0';
    var out = '', base = BigInt(to);
    while (dec > 0n) { out = map[Number(dec % base)] + out; dec = dec / base; }
    return (neg ? '-' : '') + out;
  };

  /* ---------------- Base64 (UTF-8 安全) ---------------- */
  U.b64enc = function (str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };
  U.b64dec = function (str) {
    var clean = String(str).replace(/[\s\r\n]/g, '');
    var bin = atob(clean);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };

  /* ---------------- 随机 ---------------- */
  U.randInt = function (max) {
    if (window.crypto && crypto.getRandomValues) {
      var arr = new Uint32Array(1);
      crypto.getRandomValues(arr);
      return arr[0] % max;
    }
    return Math.floor(Math.random() * max);
  };

  /* ---------------- MD5 ---------------- */
  U.md5 = function (str) {
    function safeAdd(x, y) {
      var lsw = (x & 0xFFFF) + (y & 0xFFFF);
      var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
      return (msw << 16) | (lsw & 0xFFFF);
    }
    function rol(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
    function cmn(q, a, b, x, s, t) { return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
    function binlMD5(x, len) {
      x[len >> 5] |= 0x80 << (len % 32);
      x[(((len + 64) >>> 9) << 4) + 14] = len;
      var i, olda, oldb, oldc, oldd, a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
      for (i = 0; i < x.length; i += 16) {
        olda = a; oldb = b; oldc = c; oldd = d;
        a = ff(a, b, c, d, x[i], 7, -680876936);
        d = ff(d, a, b, c, x[i + 1], 12, -389564586);
        c = ff(c, d, a, b, x[i + 2], 17, 606105819);
        b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
        a = ff(a, b, c, d, x[i + 4], 7, -176418897);
        d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
        c = ff(c, d, a, b, x[i + 6], 17, -1473231341);
        b = ff(b, c, d, a, x[i + 7], 22, -45705983);
        a = ff(a, b, c, d, x[i + 8], 7, 1770035416);
        d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
        c = ff(c, d, a, b, x[i + 10], 17, -42063);
        b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
        a = ff(a, b, c, d, x[i + 12], 7, 1804603682);
        d = ff(d, a, b, c, x[i + 13], 12, -40341101);
        c = ff(c, d, a, b, x[i + 14], 17, -1502002290);
        b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
        a = gg(a, b, c, d, x[i + 1], 5, -165796510);
        d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
        c = gg(c, d, a, b, x[i + 11], 14, 643717713);
        b = gg(b, c, d, a, x[i], 20, -373897302);
        a = gg(a, b, c, d, x[i + 5], 5, -701558691);
        d = gg(d, a, b, c, x[i + 10], 9, 38016083);
        c = gg(c, d, a, b, x[i + 15], 14, -660478335);
        b = gg(b, c, d, a, x[i + 4], 20, -405537848);
        a = gg(a, b, c, d, x[i + 9], 5, 568446438);
        d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
        c = gg(c, d, a, b, x[i + 3], 14, -187363961);
        b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
        a = gg(a, b, c, d, x[i + 13], 5, -1444681467);
        d = gg(d, a, b, c, x[i + 2], 9, -51403784);
        c = gg(c, d, a, b, x[i + 7], 14, 1735328473);
        b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
        a = hh(a, b, c, d, x[i + 5], 4, -378558);
        d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
        c = hh(c, d, a, b, x[i + 11], 16, 1839030562);
        b = hh(b, c, d, a, x[i + 14], 23, -35309556);
        a = hh(a, b, c, d, x[i + 1], 4, -1530992060);
        d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
        c = hh(c, d, a, b, x[i + 7], 16, -155497632);
        b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
        a = hh(a, b, c, d, x[i + 13], 4, 681279174);
        d = hh(d, a, b, c, x[i], 11, -358537222);
        c = hh(c, d, a, b, x[i + 3], 16, -722521979);
        b = hh(b, c, d, a, x[i + 6], 23, 76029189);
        a = hh(a, b, c, d, x[i + 9], 4, -640364487);
        d = hh(d, a, b, c, x[i + 12], 11, -421815835);
        c = hh(c, d, a, b, x[i + 15], 16, 530742520);
        b = hh(b, c, d, a, x[i + 2], 23, -995338651);
        a = ii(a, b, c, d, x[i], 6, -198630844);
        d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
        c = ii(c, d, a, b, x[i + 14], 15, -1416354905);
        b = ii(b, c, d, a, x[i + 5], 21, -57434055);
        a = ii(a, b, c, d, x[i + 12], 6, 1700485571);
        d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
        c = ii(c, d, a, b, x[i + 10], 15, -1051523);
        b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
        a = ii(a, b, c, d, x[i + 8], 6, 1873313359);
        d = ii(d, a, b, c, x[i + 15], 10, -30611744);
        c = ii(c, d, a, b, x[i + 6], 15, -1560198380);
        b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
        a = ii(a, b, c, d, x[i + 4], 6, -145523070);
        d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
        c = ii(c, d, a, b, x[i + 2], 15, 718787259);
        b = ii(b, c, d, a, x[i + 9], 21, -343485551);
        a = safeAdd(a, olda); b = safeAdd(b, oldb); c = safeAdd(c, oldc); d = safeAdd(d, oldd);
      }
      return [a, b, c, d];
    }
    function str2binl(s) {
      var bin = [], mask = (1 << 8) - 1;
      for (var i = 0; i < s.length * 8; i += 8) {
        bin[i >> 5] |= (s.charCodeAt(i / 8) & mask) << (i % 32);
      }
      return bin;
    }
    function binl2hex(bin) {
      var hex = '0123456789abcdef', str = '';
      for (var i = 0; i < bin.length * 4; i++) {
        str += hex.charAt((bin[i >> 2] >> ((i % 4) * 8 + 4)) & 15) +
          hex.charAt((bin[i >> 2] >> ((i % 4) * 8)) & 15);
      }
      return str;
    }
    var utf8 = unescape(encodeURIComponent(str));
    return binl2hex(binlMD5(str2binl(utf8), utf8.length * 8));
  };

  /** SHA 系列（Web Crypto）返回 Promise */
  U.sha = function (str, algo) {
    if (!window.crypto || !crypto.subtle) return Promise.reject(new Error('当前环境不支持 Web Crypto（请通过 http:// 或 localhost 打开）'));
    var map = { 'SHA-1': 'SHA-1', 'SHA-256': 'SHA-256', 'SHA-384': 'SHA-384', 'SHA-512': 'SHA-512' };
    var a = map[algo] || 'SHA-256';
    return crypto.subtle.digest(a, new TextEncoder().encode(str)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    });
  };

  /* ---------------- 文件下载 ---------------- */
  U.download = function (filename, content, mime) {
    try {
      var blob = new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8' });
      if (!URL.createObjectURL) throw new Error('当前环境不支持下载');
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 200);
      U.toast('已导出 ' + filename, 'ok');
    } catch (e) {
      U.toast('导出失败：' + e.message + '（可手动复制结果）', 'err');
    }
  };

  /* ---------------- 存储 ---------------- */
  U.store = {
    get: function (k, dflt) {
      try { var v = localStorage.getItem('lb_' + k); return v == null ? dflt : JSON.parse(v); }
      catch (e) { return dflt; }
    },
    set: function (k, v) {
      try { localStorage.setItem('lb_' + k, JSON.stringify(v)); } catch (e) { /* 忽略 */ }
    }
  };

  /* ---------------- 工具注册 ---------------- */
  LB.tools = [];
  LB.cats = [
    { id: 'net', name: '网络工具', icon: '🌐', desc: '子网划分、CIDR 转换、IP 处理、速查表' },
    { id: 'linux', name: 'Linux 工具', icon: '🐧', desc: '密码生成、Crontab、编码转换、权限计算' },
    { id: 'db', name: '数据库工具', icon: '🗄️', desc: 'SQL 审核、执行计划分析、慢日志、权限生成' },
    { id: 'cloud', name: '云原生工具', icon: '☁️', desc: 'K8s YAML、kubectl 速查、Docker 互转' }
  ];
  /**
   * 注册工具
   * tool = { id, name, cat, icon, desc, kw, tpl():string, init(root):void }
   */
  LB.register = function (tool) { LB.tools.push(tool); };

  /** 生成「输出块 + 复制按钮」的 HTML 容器 */
  U.outBlock = function (id) {
    return '<div class="out-wrap"><div class="out" id="' + id + '"></div>' +
      '<div class="out-ops"><button class="btn btn-sm" data-copy="#' + id + '">复制</button></div></div>';
  };
  U.setOut = function (id, text) {
    var e = document.getElementById(id);
    if (e) e.textContent = text;
  };
  U.setHtml = function (id, html) {
    var e = document.getElementById(id);
    if (e) e.innerHTML = html;
  };
})();
