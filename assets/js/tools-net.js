/* ===== 网络工具 ===== */
(function () {
  'use strict';
  var LB = window.LB, U = LB.util, D = LB.data;
  var maskOptions = (function () {
    var s = '';
    for (var i = 0; i <= 32; i++) s += '<option value="' + i + '">/' + i + '  ' + U.maskStr(i) + '</option>';
    return s;
  })();

  /* ---------- 1. IPv4 子网计算器 ---------- */
  LB.register({
    id: 'ipv4', cat: 'net', icon: '🧮', name: 'IPv4 子网计算器',
    desc: '算网络地址、广播地址、可用主机数与掩码',
    kw: 'ipv4 子网 掩码 netmask broadcast 网络地址 主机 网段',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">输入</div>' +
        '<div class="field"><label class="field-l">IP 地址 / CIDR</label>' +
        '<input type="text" id="v4in" value="192.168.10.130/24" placeholder="如 192.168.1.1/24 或 10.0.0.5"></div>' +
        '<div class="row"><div class="field"><label class="field-l">掩码位数（若上方未带 /）</label>' +
        '<select id="v4bits">' + maskOptions + '</select></div>' +
        '<div class="field" style="flex:0 0 auto"><button class="btn btn-pri" id="v4go">计算</button></div></div>' +
        '<div class="hint small">支持直接粘贴 <span class="mono">IP/掩码</span>、<span class="mono">IP 掩码</span>（空格分隔）</div></div>' +
        '<div class="t-section"><div class="sec-t">计算结果</div>' +
        '<div class="kv" id="v4kv"></div><div class="btn-group">' +
        '<button class="btn btn-sm" data-copytext="#v4kv">复制结果</button></div></div>' +
        '<div class="t-section"><div class="sec-t">地址明细</div><div class="scroll-x"><table class="tb" id="v4tb"></table></div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      $('#v4bits').value = '24';
      var calc = function () {
        var raw = $('#v4in').value.trim(), ip, bits;
        try {
          raw = raw.replace(/\s+/g, '/');
          if (raw.indexOf('/') >= 0) {
            var a = raw.split('/');
            ip = U.ip2int(a[0]);
            if (/^\d{1,2}$/.test(a[1])) bits = Number(a[1]);
            else { var m = U.ip2int(a[1]); bits = maskToBits(m); }
          } else { ip = U.ip2int(raw); bits = Number($('#v4bits').value); }
          if (bits < 0 || bits > 32) throw new Error('掩码位数 0-32');
          render(ip, bits);
        } catch (e) { U.toast(e.message, 'err'); }
      };
      function maskToBits(m) {
        for (var b = 0; b <= 32; b++) if (U.maskInt(b) === (m >>> 0)) return b;
        throw new Error('不是合法的子网掩码：' + U.int2ip(m));
      }
      function render(ip, bits) {
        var mask = U.maskInt(bits), net = (ip & mask) >>> 0;
        var bcast = (net | (~mask >>> 0)) >>> 0;
        var total = Math.pow(2, 32 - bits);
        var hosts = bits >= 31 ? total : total - 2;
        var first = bits >= 31 ? net : (net + 1) >>> 0;
        var last = bits >= 31 ? bcast : (bcast - 1) >>> 0;
        var bin = function (n) { var s = (n >>> 0).toString(2); while (s.length < 32) s = '0' + s; return s.replace(/(.{8})/g, '$1 ').trim(); };
        var hex = '0x' + (ip >>> 0).toString(16).toUpperCase().padStart(8, '0');
        var ptr = U.int2ip(ip).split('.').reverse().join('.') + '.in-addr.arpa';
        var kv = [
          ['IP 地址', U.int2ip(ip) + ' <span class="tag info">' + U.ipClass(ip) + '</span> <span class="tag ' + (U.ipScope(ip).indexOf('私有') >= 0 ? 'warn' : 'gray') + '">' + U.ipScope(ip) + '</span>', 1],
          ['网络地址', U.int2ip(net) + '/' + bits, 1],
          ['子网掩码', U.maskStr(bits) + '  (/' + bits + ')', 0],
          ['通配符 / 反掩码', U.wildcard(bits), 0],
          ['广播地址', U.int2ip(bcast), 0],
          ['可用主机范围', bits >= 31 ? U.int2ip(net) + ' ~ ' + U.int2ip(bcast) + '（/31 为点对点链路）' : U.int2ip(first) + ' ~ ' + U.int2ip(last), 1],
          ['总地址数', U.fmtNum(total), 0],
          ['可用主机数', U.fmtNum(hosts), 1],
          ['二进制', bin(ip), 0],
          ['十六进制', hex, 0],
          ['PTR 反解', ptr, 0]
        ];
        $('#v4kv').innerHTML = kv.map(function (r) {
          return '<div class="k">' + r[0] + '</div><div class="v' + (r[2] ? ' hl' : '') + '">' + r[1] + '</div>';
        }).join('');
        var rows = [
          ['主机位 / 网络位', (32 - bits) + ' 位主机 / ' + bits + ' 位网络'],
          ['下一个子网', bits < 32 ? U.int2ip((net + total) >>> 0) + '/' + bits : '—'],
          ['上一个子网', bits > 0 ? U.int2ip((net - total) >>> 0) + '/' + bits : '—'],
          ['是否网络地址', ip === net ? '✅ 是（该网段的网络号）' : '否'],
          ['是否广播地址', ip === bcast ? '✅ 是（该网段的广播地址）' : '否'],
          ['是否可用主机', (bits >= 31 ? ip >= net && ip <= bcast : ip > net && ip < bcast) ? '✅ 是' : '否']
        ];
        $('#v4tb').innerHTML = rows.map(function (r) {
          return '<tr><td class="k">' + U.esc(r[0]) + '</td><td>' + r[1] + '</td></tr>';
        }).join('');
      }
      $('#v4go').onclick = calc;
      $('#v4in').onkeydown = function (e) { if (e.key === 'Enter') calc(); };
      $('#v4bits').onchange = calc;
      calc();
    }
  });

  /* ---------- 2. IPv6 子网计算器 ---------- */
  LB.register({
    id: 'ipv6', cat: 'net', icon: '🌍', name: 'IPv6 子网计算器',
    desc: '展开/压缩、网络地址与地址范围',
    kw: 'ipv6 子网 前缀 prefix 展开 压缩',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">输入</div>' +
        '<div class="field"><label class="field-l">IPv6 地址 / 前缀</label>' +
        '<input type="text" id="v6in" value="2001:db8:abcd:0012::1/64" placeholder="如 2001:db8::1/64"></div>' +
        '<div class="btn-group"><button class="btn btn-pri" id="v6go">计算</button></div></div>' +
        '<div class="t-section"><div class="sec-t">结果</div><div class="kv" id="v6kv"></div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var calc = function () {
        try {
          var raw = $('#v6in').value.trim(), pre = 64;
          if (raw.indexOf('/') >= 0) { var a = raw.split('/'); pre = Number(a[1]); raw = a[0]; }
          if (!(pre >= 0 && pre <= 128)) throw new Error('前缀长度 0-128');
          var g = expand6(raw);
          var big = toBig(g);
          var mask = (1n << BigInt(128)) - 1n;
          if (pre > 0) mask = (((1n << BigInt(pre)) - 1n) << BigInt(128 - pre)) & ((1n << BigInt(128)) - 1n);
          else mask = 0n;
          var net = big & mask;
          var bcast = net | (~mask & ((1n << BigInt(128)) - 1n));
          var total = pre === 128 ? 1n : (1n << BigInt(128 - pre));
          $('#v6kv').innerHTML = [
            ['IPv6 地址', fmt6(big)],
            ['展开形式', full6(big)],
            ['前缀长度', '/' + pre],
            ['网络地址', fmt6(net) + '/' + pre],
            ['起始地址', full6(net)],
            ['结束地址', full6(bcast)],
            ['地址总数', total > 1000000000000000000n ? '≈' + total.toString().slice(0, 4) + ' × 10^' + (total.toString().length - 4) : U.fmtNum(total.toString())],
            ['地址类型', v6type(big)]
          ].map(function (r) { return '<div class="k">' + r[0] + '</div><div class="v">' + U.esc(String(r[1])) + '</div>'; }).join('');
        } catch (e) { U.toast('IPv6 格式错误：' + e.message, 'err'); }
      };
      function expand6(s) {
        if (s.indexOf('.') >= 0) {
          var i = s.lastIndexOf(':'), v4 = U.ip2int(s.slice(i + 1));
          s = s.slice(0, i + 1) + (((v4 >>> 16) & 0xffff).toString(16)) + ':' + ((v4 & 0xffff).toString(16));
        }
        var head, tail;
        if (s.indexOf('::') >= 0) {
          var p = s.split('::');
          head = p[0] ? p[0].split(':') : [];
          tail = p[1] ? p[1].split(':') : [];
          var miss = 8 - head.length - tail.length;
          if (miss < 0) throw new Error('段数超过 8');
          var mid = []; for (var k = 0; k < miss; k++) mid.push('0');
          return head.concat(mid, tail).map(function (x) { return parseInt(x || '0', 16); });
        }
        var all = s.split(':');
        if (all.length !== 8) throw new Error('需要 8 段或包含 ::');
        return all.map(function (x) { return parseInt(x || '0', 16); });
      }
      function toBig(g) {
        var b = 0n;
        for (var i = 0; i < 8; i++) {
          if (isNaN(g[i]) || g[i] < 0 || g[i] > 0xffff) throw new Error('每段必须 0-FFFF');
          b = (b << 16n) | BigInt(g[i]);
        }
        return b;
      }
      function full6(b) {
        var out = [];
        for (var i = 7; i >= 0; i--) out.push(Number((b >> BigInt(i * 16)) & 0xffffn).toString(16).padStart(4, '0'));
        return out.join(':');
      }
      function fmt6(b) {
        var full = full6(b).split(':').map(function (x) { return x.replace(/^0+(?=.)/, ''); });
        var bestS = -1, bestL = 0, s = -1, len = 0;
        for (var i = 0; i < 8; i++) {
          if (full[i] === '0') { if (s < 0) { s = i; len = 1; } else len++; if (len > bestL) { bestL = len; bestS = s; } }
          else { s = -1; len = 0; }
        }
        if (bestL < 2) return full.join(':');
        return full.slice(0, bestS).join(':') + '::' + full.slice(bestS + bestL).join(':');
      }
      function v6type(b) {
        var f = Number((b >> 120n) & 0xffn);
        if (b === 0n) return '未指定地址 ::';
        if (b === 1n) return '回环地址 ::1';
        if ((f & 0xfe) === 0xfc) return '唯一本地地址 ULA（fc00::/7）';
        if ((f & 0xc0) === 0xfe) return '链路本地地址（fe80::/10）';
        if (f === 0xff) return '组播地址（ff00::/8）';
        if ((f & 0xe0) === 0x20) return '全局单播地址（2000::/3）';
        if (b >> 32n === 0xffffn) return 'IPv4 映射地址';
        return '其他 / 保留地址';
      }
      $('#v6go').onclick = calc;
      $('#v6in').onkeydown = function (e) { if (e.key === 'Enter') calc(); };
      calc();
    }
  });

  /* ---------- 3. IP 范围转 CIDR / ACL ---------- */
  LB.register({
    id: 'range2cidr', cat: 'net', icon: '📐', name: 'IP 范围转 CIDR',
    desc: '起止 IP 转成最少的 CIDR 网段列表',
    kw: 'range cidr 范围 acl 转换 ip段',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">输入</div>' +
        '<div class="row"><div class="field"><label class="field-l">起始 IP</label><input type="text" id="rs" value="192.168.1.0"></div>' +
        '<div class="field"><label class="field-l">结束 IP</label><input type="text" id="re" value="192.168.1.200"></div></div>' +
        '<div class="btn-group"><button class="btn btn-pri" id="rgo">转换</button>' +
        '<button class="btn btn-sm" id="rdemo">示例</button></div></div>' +
        '<div class="t-section"><div class="sec-t">CIDR 列表</div>' + U.outBlock('rout') +
        '<div class="row mt12"><div class="field"><label class="field-l">ACL / 反掩码输出格式</label>' +
        '<select id="rfmt"><option value="cidr">CIDR（192.168.1.0/24）</option>' +
        '<option value="acl">Cisco ACL（192.168.1.0 0.0.0.255）</option>' +
        '<option value="huawei">华为 ACL（192.168.1.0 0.0.0.255）</option>' +
        '<option value="mask">IP + 掩码</option>' +
        '<option value="range">IP 范围</option></select></div></div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var last = [];
      var build = function () {
        var f = $('#rfmt').value;
        var lines = last.map(function (c) {
          var p = c.split('/'), ip = U.ip2int(p[0]), b = Number(p[1]);
          if (f === 'acl') return 'permit ip ' + p[0] + ' ' + U.wildcard(b);
          if (f === 'huawei') return 'rule permit source ' + p[0] + ' ' + U.wildcard(b);
          if (f === 'mask') return p[0] + ' ' + U.maskStr(b);
          if (f === 'range') {
            var n = (ip & U.maskInt(b)) >>> 0, size = Math.pow(2, 32 - b);
            return U.int2ip(n) + ' - ' + U.int2ip((n + size - 1) >>> 0);
          }
          return c;
        });
        U.setOut('rout', lines.join('\n') + (lines.length ? '\n\n共 ' + lines.length + ' 个网段' : ''));
      };
      $('#rgo').onclick = function () {
        try {
          last = U.rangeToCidr(U.ip2int($('#rs').value), U.ip2int($('#re').value));
          build();
        } catch (e) { U.toast(e.message, 'err'); }
      };
      $('#rfmt').onchange = build;
      $('#rdemo').onclick = function () { $('#rs').value = '10.0.0.5'; $('#re').value = '10.0.1.200'; $('#rgo').click(); };
      $('#rgo').click();
    }
  });

  /* ---------- 4. CIDR / 掩码 / 反掩码互转 ---------- */
  LB.register({
    id: 'cidrmask', cat: 'net', icon: '🔁', name: 'CIDR ↔ 掩码 ↔ 反掩码',
    desc: '三种掩码表示法互相转换并查看容量',
    kw: 'cidr 掩码 netmask 反掩码 wildcard 互转 24',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">输入（任一格式）</div>' +
        '<div class="field"><input type="text" id="cin" value="255.255.255.128" placeholder="/24 或 255.255.255.0 或 0.0.0.255（反掩码）"></div>' +
        '<div class="btn-group"><button class="btn btn-pri" id="cgo">转换</button></div>' +
        '<div class="hint small">自动识别：带 / 视为 CIDR；以 255 开头视为掩码；其他按掩码处理，结果同时给出三种形式</div></div>' +
        '<div class="t-section"><div class="sec-t">结果</div><div class="kv" id="ckv"></div></div>' +
        '<div class="t-section"><div class="sec-t">常用掩码速查</div><div class="scroll-x"><table class="tb" id="ctb"></table></div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var calc = function () {
        var raw = $('#cin').value.trim(), bits;
        try {
          if (raw.indexOf('/') >= 0) raw = raw.split('/')[1].trim();
          if (/^\d{1,2}$/.test(raw)) bits = Number(raw);
          else {
            var m = U.ip2int(raw), found = -1;
            for (var b = 0; b <= 32; b++) { if (U.maskInt(b) === (m >>> 0)) { found = b; break; } }
            if (found < 0) {
              var w = U.ip2int(raw), f2 = -1;
              for (var b2 = 0; b2 <= 32; b2++) { if (((~U.maskInt(b2)) >>> 0) === (w >>> 0)) { f2 = b2; break; } }
              if (f2 < 0) throw new Error('既不是合法掩码也不是合法反掩码');
              found = f2;
            }
            bits = found;
          }
          if (bits < 0 || bits > 32) throw new Error('掩码位数 0-32');
          var total = Math.pow(2, 32 - bits), hosts = bits >= 31 ? total : total - 2;
          $('#ckv').innerHTML = [
            ['CIDR 前缀', '/' + bits], ['子网掩码', U.maskStr(bits)],
            ['反掩码 / 通配符', U.wildcard(bits)], ['总地址数', U.fmtNum(total)],
            ['可用主机数', U.fmtNum(hosts)],
            ['二进制掩码', (function () { var s = (U.maskInt(bits) >>> 0).toString(2); while (s.length < 32) s = '0' + s; return s.replace(/(.{8})/g, '$1.'); })()],
            ['适用规模', bits <= 20 ? '大型网络 / 内网汇总' : bits <= 24 ? '园区 / 部门网段' : bits <= 28 ? '小型网段' : bits <= 30 ? '点对点链路' : '单主机']
          ].map(function (r) { return '<div class="k">' + r[0] + '</div><div class="v hl">' + r[1] + '</div>'; }).join('');
        } catch (e) { U.toast(e.message, 'err'); }
      };
      $('#cgo').onclick = calc;
      $('#cin').onkeydown = function (e) { if (e.key === 'Enter') calc(); };
      $('#ctb').innerHTML = '<tr><th>CIDR</th><th>子网掩码</th><th>反掩码</th><th>可用主机</th></tr>' +
        [8, 16, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32].map(function (b) {
          var t = Math.pow(2, 32 - b), h = b >= 31 ? t : t - 2;
          return '<tr><td>/' + b + '</td><td class="mono">' + U.maskStr(b) + '</td><td class="mono">' + U.wildcard(b) + '</td><td>' + U.fmtNum(h) + '</td></tr>';
        }).join('');
      calc();
    }
  });

  /* ---------- 5. 网段拆分 / 合并 ---------- */
  LB.register({
    id: 'subnet', cat: 'net', icon: '✂️', name: '网段拆分 / 合并',
    desc: '大网划分子网，或多个网段聚合成超网',
    kw: '子网 划分 拆分 合并 vlsm 超网 聚合 split merge',
    tpl: function () {
      return '<div class="tabs" id="stab"><button class="tab on" data-m="split">拆分子网</button>' +
        '<button class="tab" data-m="merge">合并聚合</button></div>' +
        '<div id="spane"><div class="t-section"><div class="sec-t">拆分</div>' +
        '<div class="row"><div class="field"><label class="field-l">网段</label><input type="text" id="snet" value="192.168.10.0/24"></div>' +
        '<div class="field"><label class="field-l">方式</label><select id="smode">' +
        '<option value="count">按子网数</option><option value="host">按每网主机数</option><option value="bits">按新前缀</option></select></div>' +
        '<div class="field"><label class="field-l">数值</label><input type="number" id="snum" value="6"></div></div>' +
        '<div class="btn-group"><button class="btn btn-pri" id="sgo">计算</button></div></div>' +
        '<div class="t-section"><div class="sec-t">子网列表</div>' + U.outBlock('sout') + '</div></div>' +
        '<div id="mpane" hidden><div class="t-section"><div class="sec-t">合并（每行一个网段，支持 192.168.0.0/24 或单个 IP）</div>' +
        '<textarea id="min" style="min-height:150px">192.168.0.0/24\n192.168.1.0/24\n192.168.2.0/25\n192.168.2.128/25\n10.0.0.0/8</textarea>' +
        '<div class="btn-group"><button class="btn btn-pri" id="mgo">聚合</button></div></div>' +
        '<div class="t-section"><div class="sec-t">聚合结果</div>' + U.outBlock('mout') + '</div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      U.$$('#stab .tab', root).forEach(function (t) {
        t.onclick = function () {
          U.$$('#stab .tab', root).forEach(function (x) { x.classList.remove('on'); });
          t.classList.add('on');
          var m = t.dataset.m;
          $('#spane').hidden = m !== 'split';
          $('#mpane').hidden = m !== 'merge';
        };
      });
      $('#sgo').onclick = function () {
        try {
          var net = U.parseNet($('#snet').value);
          if (net.prefix == null) throw new Error('请写成 192.168.10.0/24 形式');
          var base = (net.ip & U.maskInt(net.prefix)) >>> 0;
          var oldSize = Math.pow(2, 32 - net.prefix);
          var mode = $('#smode').value, v = Number($('#snum').value), newBits;
          if (mode === 'count') {
            if (v < 1) throw new Error('子网数需 ≥ 1');
            var k = Math.ceil(Math.log(v) / Math.LN2);
            newBits = net.prefix + k;
          } else if (mode === 'host') {
            if (v < 1) throw new Error('主机数需 ≥ 1');
            var need = v + 2, hb = Math.ceil(Math.log(need) / Math.LN2);
            newBits = 32 - hb;
          } else {
            newBits = v;
          }
          if (newBits > 32) newBits = 32;
          if (newBits < net.prefix) throw new Error('新前缀不能小于原前缀（/' + net.prefix + '），那是合并不是拆分');
          var size = Math.pow(2, 32 - newBits), cnt = oldSize / size;
          var lines = ['原网段: ' + U.int2ip(base) + '/' + net.prefix + '   新前缀: /' + newBits +
            '   子网数: ' + cnt + '   每网可用主机: ' + (newBits >= 31 ? size : size - 2), ''];
          for (var i = 0; i < cnt && i < 2000; i++) {
            var n = (base + i * size) >>> 0;
            var bc = (n + size - 1) >>> 0;
            var f = newBits >= 31 ? n : (n + 1) >>> 0;
            var l = newBits >= 31 ? bc : (bc - 1) >>> 0;
            lines.push(U.pad(i + 1, 3) + '.  ' + U.int2ip(n) + '/' + newBits +
              '   掩码 ' + U.maskStr(newBits) +
              '   范围 ' + U.int2ip(f) + ' - ' + U.int2ip(l));
          }
          if (cnt > 2000) lines.push('…（子网过多，仅显示前 2000 个）');
          U.setOut('sout', lines.join('\n'));
        } catch (e) { U.toast(e.message, 'err'); }
      };
      $('#mgo').onclick = function () {
        try {
          var items = $('#min').value.split(/[\s,;]+/).filter(Boolean).map(function (x) {
            var p = U.parseNet(x);
            if (p.prefix == null) p.prefix = 32;
            if (p.prefix < 0 || p.prefix > 32) throw new Error('前缀错误：' + x);
            return { base: (p.ip & U.maskInt(p.prefix)) >>> 0, prefix: p.prefix };
          });
          if (!items.length) throw new Error('请输入网段');
          var before = items.length;
          var merged = U.mergeCidr(items);
          U.setOut('mout', merged.join('\n') + '\n\n输入 ' + before + ' 个 → 聚合为 ' + merged.length + ' 个');
        } catch (e) { U.toast(e.message, 'err'); }
      };
      $('#sgo').click();
    }
  });

  /* ---------- 6. IP 排序去重 ---------- */
  LB.register({
    id: 'ipsort', cat: 'net', icon: '🔢', name: 'IP 排序去重',
    desc: '批量 IP 排序、去重、展开 CIDR、格式转换',
    kw: 'ip 排序 去重 sort 批量 excel cidr展开',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">输入（支持 IP、CIDR、任意分隔符，也支持从 Excel 一列粘贴）</div>' +
        '<textarea id="iin" style="min-height:150px">192.168.1.10\n10.0.0.2\n192.168.1.3\n10.0.0.2\n172.16.5.1\n192.168.1.10</textarea>' +
        '<div class="chk-grid mt8">' +
        '<label class="chk"><input type="checkbox" id="isort" checked>按数值排序</label>' +
        '<label class="chk"><input type="checkbox" id="iuniq" checked>去重</label>' +
        '<label class="chk"><input type="checkbox" id="idesc">降序</label>' +
        '<label class="chk"><input type="checkbox" id="iexp">展开 CIDR</label>' +
        '<label class="chk"><input type="checkbox" id="ipad">按点分对齐（补 0）</label></div>' +
        '<div class="row mt8"><div class="field"><label class="field-l">输出分隔</label><select id="isep">' +
        '<option value="nl">每行一个</option><option value="comma">逗号</option><option value="space">空格</option></select></div>' +
        '<div class="field" style="flex:0 0 auto"><button class="btn btn-pri" id="igo">处理</button></div></div></div>' +
        '<div class="t-section"><div class="sec-t">输出</div>' + U.outBlock('iout') + '</div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      $('#igo').onclick = function () {
        try {
          var raw = $('#iin').value.split(/[\s,;，、|]+/).filter(Boolean);
          var list = [];
          raw.forEach(function (x) {
            if (x.indexOf('/') >= 0 && $('#iexp').checked) {
              var p = x.split('/'), b = Number(p[1]);
              if (isNaN(b) || b < 0 || b > 32) throw new Error('CIDR 错误：' + x);
              var s = U.ip2int(p[0]) & U.maskInt(b), size = Math.pow(2, 32 - b);
              if (size > 65536) throw new Error('CIDR 太大（' + x + '），展开上限 65536 个地址');
              for (var i = 0; i < size; i++) list.push((s + i) >>> 0);
            } else {
              list.push(U.ip2int(x.indexOf('/') >= 0 ? x.split('/')[0] : x));
            }
          });
          var seen = {}, out = [];
          list.forEach(function (n) {
            if ($('#iuniq').checked) { if (seen[n]) return; seen[n] = 1; }
            out.push(n);
          });
          if ($('#isort').checked) out.sort(function (a, b) { return a - b; });
          if ($('#idesc').checked) out.reverse();
          var sep = $('#isep').value === 'comma' ? ',' : $('#isep').value === 'space' ? ' ' : '\n';
          var lines = out.map(function (n) {
            var ip = U.int2ip(n);
            if ($('#ipad').checked) ip = ip.split('.').map(function (x) { return U.pad(x, 3); }).join('.');
            return ip;
          });
          U.setOut('iout', lines.join(sep) + '\n\n共 ' + lines.length + ' 个（原始输入 ' + raw.length + ' 条）');
        } catch (e) { U.toast(e.message, 'err'); }
      };
      $('#igo').click();
    }
  });

  /* ---------- 7. 带宽 / 流量换算 ---------- */
  LB.register({
    id: 'bandwidth', cat: 'net', icon: '📶', name: '带宽换算',
    desc: 'bit/Byte 互换，算传输时间与所需带宽',
    kw: '带宽 流量 换算 mbps MB/s 传输时间 bit byte',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">输入</div>' +
        '<div class="row"><div class="field"><label class="field-l">数值</label><input type="number" id="bnum" value="100"></div>' +
        '<div class="field"><label class="field-l">单位</label><select id="bunit">' +
        '<option value="1">bit/s (bps)</option><option value="1000">Kbit/s (Kbps)</option>' +
        '<option value="1000000">Mbit/s (Mbps)</option><option value="1000000000">Gbit/s (Gbps)</option>' +
        '<option value="8">Byte/s (B/s)</option><option value="8000">KB/s</option>' +
        '<option value="8000000">MB/s</option><option value="8000000000">GB/s</option></select></div></div>' +
        '</div><div class="t-section"><div class="sec-t">换算结果（点击复制）</div><div class="scroll-x"><table class="tb" id="btb"></table></div></div>' +
        '<div class="t-section"><div class="sec-t">传输时间估算</div>' +
        '<div class="row"><div class="field"><label class="field-l">文件大小</label><input type="number" id="bsize" value="10"></div>' +
        '<div class="field"><label class="field-l">单位</label><select id="bsunit">' +
        '<option value="1048576">MiB</option><option value="1073741824">GiB</option>' +
        '<option value="1000000000">GB</option><option value="1099511627776">TiB</option></select></div></div>' +
        '<div class="btn-group"><button class="btn btn-pri" id="bgo2">估算</button></div>' +
        '<div class="kv mt12" id="bkv"></div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var units = [
        ['bit/s', 1], ['Kbit/s', 1e3], ['Mbit/s', 1e6], ['Gbit/s', 1e9], ['Tbit/s', 1e12],
        ['Byte/s', 8], ['KB/s', 8e3], ['MB/s', 8e6], ['GB/s', 8e9], ['TB/s', 8e12]
      ];
      var render = function () {
        var bps = Number($('#bnum').value) * Number($('#bunit').value);
        if (!isFinite(bps) || bps < 0) return;
        $('#btb').innerHTML = '<tr><th>单位</th><th>数值</th><th>单位</th><th>数值</th></tr>' +
          units.map(function (u, i) {
            if (i % 2) return '';
            var r = '<td class="k mono">' + u[0] + '</td><td class="mono">' + fmt(bps / u[1]) + '</td>';
            var n = units[i + 1];
            if (n) r += '<td class="k mono">' + n[0] + '</td><td class="mono">' + fmt(bps / n[1]) + '</td>';
            else r += '<td></td><td></td>';
            return '<tr>' + r + '</tr>';
          }).join('');
        est();
      };
      function fmt(n) {
        if (n === 0) return '0';
        if (n < 0.001) return n.toExponential(3);
        if (n < 1) return n.toFixed(6).replace(/0+$/, '');
        if (n < 1000) return n.toFixed(3).replace(/\.?0+$/, '');
        return n.toLocaleString('en-US', { maximumFractionDigits: 3 });
      }
      function est() {
        var bps = Number($('#bnum').value) * Number($('#bunit').value);
        var bytes = Number($('#bsize').value) * Number($('#bsunit').value);
        if (!isFinite(bps) || bps <= 0 || !isFinite(bytes)) return;
        var sec = bytes / (bps / 8);
        $('#bkv').innerHTML = [
          ['理论耗时', fmtDur(sec)],
          ['实际耗时（90% 效率）', fmtDur(sec / 0.9)],
          ['实际耗时（80% 效率）', fmtDur(sec / 0.8)],
          ['每秒可传', fmt(bps / 8) + ' Byte/s = ' + fmt((bps / 8) / 1048576) + ' MiB/s'],
          ['每分钟可传', fmt((bps / 8) * 60 / 1048576) + ' MiB'],
          ['每小时可传', fmt((bps / 8) * 3600 / 1073741824) + ' GiB'],
          ['每天可传', fmt((bps / 8) * 86400 / 1073741824) + ' GiB']
        ].map(function (r) { return '<div class="k">' + r[0] + '</div><div class="v hl">' + U.esc(r[1]) + '</div>'; }).join('');
      }
      function fmtDur(s) {
        if (!isFinite(s)) return '-';
        var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), ss = Math.floor(s % 60);
        var p = [];
        if (d) p.push(d + ' 天');
        if (h) p.push(h + ' 小时');
        if (m) p.push(m + ' 分');
        p.push((s < 60 ? s.toFixed(2) : ss) + ' 秒');
        return p.join(' ');
      }
      $('#bnum').oninput = render;
      $('#bunit').onchange = render;
      $('#bsize').oninput = est;
      $('#bsunit').onchange = est;
      $('#bgo2').onclick = est;
      render();
    }
  });

  /* ---------- 8. 进制转换 ---------- */
  LB.register({
    id: 'radix', cat: 'net', icon: '🔣', name: '进制转换',
    desc: '二 / 八 / 十 / 十六进制互转，支持大数',
    kw: '进制 二进制 八进制 十进制 十六进制 hex bin dec oct 转换',
    tpl: function () {
      var f = function (id, base, label, ph) {
        return '<div class="field"><label class="field-l">' + label + '</label>' +
          '<input type="text" class="mono" id="' + id + '" data-base="' + base + '" placeholder="' + ph + '"></div>';
      };
      return '<div class="t-section"><div class="sec-t">任意一格输入，其余自动转换</div>' +
        f('r2', 2, '二进制 BIN (2)', '如 11000000') +
        f('r8', 8, '八进制 OCT (8)', '如 300') +
        f('r10', 10, '十进制 DEC (10)', '如 192') +
        f('r16', 16, '十六进制 HEX (16)', '如 C0') +
        '<div class="hint small">支持任意长度大整数（BigInt）；八/十六进制不区分大小写</div></div>' +
        '<div class="t-section"><div class="sec-t">IP ↔ 整数 / 十六进制</div>' +
        '<div class="row"><div class="field"><label class="field-l">IP 地址</label><input type="text" class="mono" id="rip" placeholder="192.168.1.1"></div>' +
        '<div class="field"><label class="field-l">十进制整数</label><input type="text" class="mono" id="rint" placeholder="3232235777"></div></div>' +
        '<div class="btn-group"><button class="btn btn-sm" id="r2ip">← 整数转 IP</button>' +
        '<button class="btn btn-sm" id="r2int">IP 转整数 →</button></div>' +
        '<div class="kv mt12" id="rkv"></div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var boxes = ['r2', 'r8', 'r10', 'r16'];
      boxes.forEach(function (id) {
        $('#' + id).addEventListener('input', function () {
          var base = Number(this.dataset.base), val = this.value.trim();
          if (!val) { boxes.forEach(function (b) { if (b !== id) $('#' + b).value = ''; }); return; }
          try {
            boxes.forEach(function (b) {
              if (b === id) return;
              $('#' + b).value = U.convBase(val, base, Number($('#' + b).dataset.base));
            });
            $('#rip').value = ''; $('#rint').value = '';
          } catch (e) { /* 输入中不提示 */ }
        });
      });
      $('#r2int').onclick = function () {
        try {
          var n = U.ip2int($('#rip').value);
          $('#rint').value = n;
          $('#rkv').innerHTML = [
            ['十进制', n], ['十六进制', '0x' + (n >>> 0).toString(16).toUpperCase()],
            ['二进制', (n >>> 0).toString(2).replace(/(.{8})/g, '$1 ')]
          ].map(function (r) { return '<div class="k">' + r[0] + '</div><div class="v hl mono">' + r[1] + '</div>'; }).join('');
        } catch (e) { U.toast(e.message, 'err'); }
      };
      $('#r2ip').onclick = function () {
        try {
          var v = $('#rint').value.trim();
          var n = /^0x/i.test(v) ? parseInt(v, 16) : Number(v);
          if (!isFinite(n) || n < 0 || n > 4294967295) throw new Error('请输入 0-4294967295 的整数');
          $('#rip').value = U.int2ip(n);
        } catch (e) { U.toast(e.message, 'err'); }
      };
    }
  });

  /* ---------- 9. MAC 厂商查询 ---------- */
  LB.register({
    id: 'mac', cat: 'net', icon: '🔎', name: 'MAC 厂商查询',
    desc: '根据 MAC 前 3 字节识别厂商与虚拟环境',
    kw: 'mac oui 厂商 网卡 地址 查询 虚拟机',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">输入 MAC（支持 : - . 或无分隔）</div>' +
        '<div class="field"><input type="text" class="mono" id="min2" value="00:0C:29:AB:CD:EF" placeholder="00:0C:29:AB:CD:EF"></div>' +
        '<div class="btn-group"><button class="btn btn-pri" id="mgo2">查询</button>' +
        '<button class="btn btn-sm" id="mrand">随机生成 MAC</button></div></div>' +
        '<div class="t-section"><div class="sec-t">结果</div><div class="kv" id="mkv"></div></div>' +
        '<div class="alert info small">内置 ' + D.oui.length + ' 条常见 OUI 记录，完全本地匹配；未命中时可用下方站点查询。</div>' +
        '<div class="t-section"><div class="sec-t">在线补充查询</div><div id="mlinks" class="btn-group"></div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var calc = function () {
        var raw = $('#min2').value, hex = raw.toUpperCase().replace(/[^0-9A-F]/g, '');
        var r = D.ouiLookup(hex);
        var kv = [
          ['原始输入', U.esc(raw)],
          ['规范化', hex ? hex.replace(/(.{2})(?=.)/g, '$1:') : '-'],
          ['OUI 前缀', hex ? hex.slice(0, 6) : '-'],
          ['厂商', r ? '<span class="tag ok">' + U.esc(r.vendor) + '</span>' : '<span class="tag gray">本地库未收录</span>'],
          ['第 1 字节特征', hex ? byteInfo(hex.slice(0, 2)) : '-'],
          ['类型', hex ? macType(hex) : '-']
        ];
        $('#mkv').innerHTML = kv.map(function (x) { return '<div class="k">' + x[0] + '</div><div class="v mono">' + x[1] + '</div>'; }).join('');
      };
      function byteInfo(b2) {
        var v = parseInt(b2, 16);
        return '第1字节 ' + b2 + ' → ' + (v & 1 ? '组播' : '单播') + ' / ' + (v & 2 ? '本地管理（可能手动指定或虚拟网卡）' : '全局唯一（厂商烧录）');
      }
      function macType(hex) {
        var v = parseInt(hex.slice(0, 2), 16);
        var p3 = hex.slice(0, 6);
        var virt = ['000569', '001C14', '005056', '000C29', '0A0027', '080027', '001C42', '0242AC', '525400'];
        if (virt.indexOf(p3) >= 0) return '虚拟机 / 容器网卡';
        return (v & 1) ? '组播地址' : '单播（物理网卡）';
      }
      $('#mgo2').onclick = calc;
      $('#min2').onkeydown = function (e) { if (e.key === 'Enter') calc(); };
      $('#mrand').onclick = function () {
        var b = [];
        for (var i = 0; i < 6; i++) { var n = U.randInt(256); if (i === 0) n = (n | 2) & 0xfe; b.push(U.pad(n.toString(16), 2)); }
        $('#min2').value = b.join(':').toUpperCase(); calc();
      };
      $('#mlinks').innerHTML = [
        ['MAC 厂商库', 'https://macvendors.com/'],
        ['Wireshark OUI', 'https://www.wireshark.org/tools/oui-lookup.html']
      ].map(function (x) {
        return '<a class="btn btn-sm" href="' + x[1] + '" target="_blank" rel="noopener">' + x[0] + ' ↗</a>';
      }).join('');
      calc();
    }
  });

  /* ---------- 10. IP 归属地 / WHOIS 入口 ---------- */
  LB.register({
    id: 'iplookup', cat: 'net', icon: '🗺️', name: 'IP 归属地 / WHOIS',
    desc: '本地判断 IP 属性 + 跳转权威查询站点',
    kw: 'ip 归属地 whois 查询 asn ip138 位置',
    tpl: function () {
      return '<div class="alert info">网页版为纯离线设计，归属地数据库体积大且需持续更新；这里先做本地属性判断，再一键跳转权威站点查询。</div>' +
        '<div class="t-section"><div class="sec-t">输入 IP 或域名</div>' +
        '<div class="field"><input type="text" id="lq" value="223.5.5.5" placeholder="IP 或域名"></div>' +
        '<div class="btn-group"><button class="btn btn-pri" id="lgo">本地分析</button></div>' +
        '<div class="kv mt12" id="lkv"></div></div>' +
        '<div class="t-section"><div class="sec-t">一键跳转查询</div><div id="llinks" class="btn-group"></div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var go = function () {
        var v = $('#lq').value.trim();
        var links = D.whoisSites.map(function (s) {
          return '<a class="btn btn-sm" href="' + s[1].replace('{IP}', encodeURIComponent(v)) + '" target="_blank" rel="noopener">' + s[0] + ' ↗</a>';
        }).join('');
        $('#llinks').innerHTML = links;
        try {
          var ip = U.ip2int(v);
          var rows = [
            ['IP', U.int2ip(ip)], ['类别', U.ipClass(ip)], ['属性', U.ipScope(ip)],
            ['十进制', ip], ['十六进制', '0x' + (ip >>> 0).toString(16).toUpperCase()],
            ['PTR', U.int2ip(ip).split('.').reverse().join('.') + '.in-addr.arpa']
          ];
          var b = (ip >>> 24) & 255;
          if (b >= 224 && b < 240) rows.push(['组播范围', '224.0.0.0/4']);
          $('#lkv').innerHTML = rows.map(function (r) {
            return '<div class="k">' + r[0] + '</div><div class="v hl">' + U.esc(String(r[1])) + '</div>';
          }).join('');
        } catch (e) {
          $('#lkv').innerHTML = '<div class="k">提示</div><div class="v">不是 IPv4 地址（可能是域名或 IPv6），请点上方按钮跳转查询</div>';
        }
      };
      $('#lgo').onclick = go;
      $('#lq').onkeydown = function (e) { if (e.key === 'Enter') go(); };
      go();
    }
  });

  /* ---------- 11. 公共 DNS ---------- */
  LB.register({
    id: 'dns', cat: 'net', icon: '📡', name: '公共 DNS 大全',
    desc: '国内外主流公共 DNS 与 DoH/DoT 地址',
    kw: 'dns 公共 114 8.8.8.8 阿里 腾讯 解析',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">公共 DNS 一览（点击地址复制）</div>' +
        '<div class="scroll-x"><table class="tb"><tr><th>服务商</th><th>DNS 地址</th><th>说明</th></tr>' +
        D.dns.map(function (d) {
          return '<tr><td class="k">' + U.esc(d[0]) + '</td><td class="mono cp" data-c="' + U.esc(d[1].split(' / ')[0]) + '" title="点击复制">' +
            U.esc(d[1]) + '</td><td>' + U.esc(d[2]) + '</td></tr>';
        }).join('') + '</table></div></div>' +
        '<div class="t-section"><div class="sec-t">常用排查命令</div>' +
        '<div id="dnsCmd"></div></div>';
    },
    init: function (root) {
      var cmds = [
        ['nslookup example.com 223.5.5.5', '用指定 DNS 解析域名'],
        ['dig @8.8.8.8 example.com +short', 'dig 指定 DNS 解析'],
        ['dig example.com ANY +noall +answer', '查询所有记录'],
        ['dig +trace example.com', '追踪解析全过程（排查 DNS 劫持）'],
        ['systemd-resolve --status', '查看当前系统 DNS 配置'],
        ['cat /etc/resolv.conf', '查看 resolv.conf'],
        ['ipconfig /flushdns', 'Windows 刷新 DNS 缓存'],
        ['ipconfig /displaydns', 'Windows 查看 DNS 缓存'],
        ['resolvectl flush-caches', 'Linux systemd-resolved 清缓存'],
        ['nscd -i hosts', '清除 nscd 缓存']
      ];
      root.querySelector('#dnsCmd').innerHTML = cmds.map(function (c) {
        return '<div class="cheat-item"><div class="cmd">' + U.esc(c[0]) + '</div><div class="dsc">' + U.esc(c[1]) + '</div>' +
          '<button class="btn btn-sm cp" data-c="' + U.esc(c[0]) + '">复制</button></div>';
      }).join('');
      U.$$('.cp', root).forEach(function (e) {
        e.onclick = function () { U.copy(e.dataset.c); };
      });
    }
  });

  /* ---------- 12. 网线线序 / 接口速查 ---------- */
  LB.register({
    id: 'wiring', cat: 'net', icon: '🔌', name: '线序 / 接口速查',
    desc: '网线线序、光纤模块与以太网标准',
    kw: '线序 t568a t568b 交叉线 光纤 sfp 模块 水晶头 cat6',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">网线线序</div>' +
        D.wiring.map(function (w) {
          return '<div class="issue"><div class="lv">🔧</div><div class="b">' +
            '<div class="tt">' + U.esc(w[0]) + '</div>' +
            '<div class="ds"><b>线序：</b>' + U.esc(w[1]) + '</div>' +
            '<div class="ds"><b>用途：</b>' + U.esc(w[2]) + '</div></div></div>';
        }).join('') + '</div>' +
        '<div class="t-section"><div class="sec-t">光纤模块 / 速率</div><div class="scroll-x"><table class="tb">' +
        '<tr><th>模块</th><th>速率</th><th>接口</th><th>传输距离</th></tr>' +
        D.fiber.map(function (f) { return '<tr><td class="k">' + U.esc(f[0]) + '</td><td>' + U.esc(f[1]) + '</td><td>' + U.esc(f[2]) + '</td><td>' + U.esc(f[3]) + '</td></tr>'; }).join('') +
        '</table></div></div>' +
        '<div class="t-section"><div class="sec-t">以太网标准与线缆</div><div class="scroll-x"><table class="tb">' +
        '<tr><th>标准</th><th>速率</th><th>最低线缆</th><th>距离</th></tr>' +
        D.ethStd.map(function (f) { return '<tr><td class="k">' + U.esc(f[0]) + '</td><td>' + U.esc(f[1]) + '</td><td>' + U.esc(f[2]) + '</td><td>' + U.esc(f[3]) + '</td></tr>'; }).join('') +
        '</table></div></div>';
    },
    init: function () { }
  });

  /* ---------- 13. 常用端口速查 ---------- */
  LB.register({
    id: 'ports', cat: 'net', icon: '🚪', name: '常用端口速查',
    desc: '运维常见端口与对应服务',
    kw: '端口 port 80 443 3306 6379 服务 占用',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">搜索端口或服务</div>' +
        '<input type="text" id="pf" placeholder="如 3306 / mysql / redis"></div>' +
        '<div class="t-section"><div class="sec-t">端口表</div><div class="scroll-x"><table class="tb" id="ptb"></table></div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var render = function () {
        var k = $('#pf').value.trim().toLowerCase();
        var rows = D.ports.filter(function (p) {
          return !k || p[0].indexOf(k) >= 0 || p[2].toLowerCase().indexOf(k) >= 0 || p[3].toLowerCase().indexOf(k) >= 0;
        });
        $('#ptb').innerHTML = '<tr><th>端口</th><th>协议</th><th>服务</th><th>说明</th></tr>' +
          rows.map(function (p) {
            return '<tr><td class="k mono">' + U.esc(p[0]) + '</td><td>' + U.esc(p[1]) + '</td><td><b>' + U.esc(p[2]) + '</b></td><td>' + U.esc(p[3]) + '</td></tr>';
          }).join('') + (rows.length ? '' : '<tr><td colspan="4" style="text-align:center;color:var(--txt-3)">无匹配</td></tr>');
      };
      $('#pf').oninput = render;
      render();
    }
  });

  /* ---------- 14. HTTP 状态码 ---------- */
  LB.register({
    id: 'httpcode', cat: 'net', icon: '📋', name: 'HTTP 状态码速查',
    desc: '常见状态码含义与排障提示',
    kw: 'http 状态码 404 500 502 504 状态码 响应',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">搜索</div><input type="text" id="hf" placeholder="如 502 / timeout"></div>' +
        '<div class="t-section"><div class="sec-t">状态码</div>' + '<div id="hlist"></div></div>' +
        '<div class="t-section"><div class="sec-t">Nginx 502/504 快速定位</div>' +
        '<div class="small" style="line-height:1.9">' +
        '<b>502 Bad Gateway</b>：上游服务没起来 / 端口不通 / upstream 配错 / 上游返回非法响应 → 查 <span class="mono">error.log</span> 里的 <span class="mono">connect() failed</span><br>' +
        '<b>504 Gateway Timeout</b>：上游处理太慢 → 调 <span class="mono">proxy_read_timeout / fastcgi_read_timeout</span>，或优化慢 SQL / 慢接口<br>' +
        '<b>499</b>：客户端等不及断开了，通常伴随上游慢，看 <span class="mono">$request_time</span> 与 <span class="mono">$upstream_response_time</span><br>' +
        '<b>413</b>：请求体过大 → <span class="mono">client_max_body_size 50m;</span>（PHP 还要调 <span class="mono">upload_max_filesize</span>）<br>' +
        '<b>429</b>：被限流 → 检查网关 <span class="mono">limit_req</span> / 应用限流 / WAF 策略</div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var render = function () {
        var k = $('#hf').value.trim().toLowerCase();
        var rows = D.httpStatus.filter(function (h) {
          return !k || h[0].indexOf(k) >= 0 || h[1].toLowerCase().indexOf(k) >= 0 || h[3].indexOf(k) >= 0;
        });
        $('#hlist').innerHTML = rows.map(function (h) {
          var cls = h[2] === 'ok' ? 'ok' : h[2] === 'err' ? 'err' : h[2] === 'warn' ? 'warn' : 'info';
          return '<div class="issue"><div class="lv"><span class="tag ' + cls + '">' + h[0] + '</span></div>' +
            '<div class="b"><div class="tt">' + U.esc(h[1]) + '</div><div class="ds">' + U.esc(h[3]) + '</div></div></div>';
        }).join('') || '<div class="small">无匹配</div>';
      };
      $('#hf').oninput = render;
      render();
    }
  });
})();
