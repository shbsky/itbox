/* ===== Linux / 编码工具 ===== */
(function () {
  'use strict';
  var LB = window.LB, U = LB.util, D = LB.data;

  /* ---------- 1. 随机密码生成器 ---------- */
  LB.register({
    id: 'password', cat: 'linux', icon: '🔐', name: '随机密码生成器',
    desc: '自定义长度与字符集，批量生成强密码',
    kw: '密码 随机 password 生成 强密码 密钥 令牌 token',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">配置</div>' +
        '<div class="row tight">' +
        '<div class="field"><label class="field-l">长度</label><input type="number" id="plen" value="16" min="4" max="128"></div>' +
        '<div class="field"><label class="field-l">数量</label><input type="number" id="pcnt" value="5" min="1" max="200"></div>' +
        '<div class="field"><label class="field-l">前缀（可选）</label><input type="text" id="ppre" placeholder="如 Db_"></div></div>' +
        '<div class="chk-grid mt12">' +
        '<label class="chk"><input type="checkbox" id="pup" checked>大写 A-Z</label>' +
        '<label class="chk"><input type="checkbox" id="plo" checked>小写 a-z</label>' +
        '<label class="chk"><input type="checkbox" id="pnum" checked>数字 0-9</label>' +
        '<label class="chk"><input type="checkbox" id="psym" checked>符号 !@#$…</label>' +
        '<label class="chk"><input type="checkbox" id="pnoamb">排除易混淆 0O1lI</label>' +
        '<label class="chk"><input type="checkbox" id="pnodup">字符不重复</label>' +
        '<label class="chk"><input type="checkbox" id="pnosim">排除引号与反斜杠</label></div>' +
        '<div class="field mt8"><label class="field-l">额外排除字符</label><input type="text" id="pex" placeholder="输入要排除的字符，如 %&"></div>' +
        '<div class="btn-group"><button class="btn btn-pri" id="pgo">生成</button>' +
        '<button class="btn btn-sm" id="puuid">生成 UUID v4 ×5</button>' +
        '<button class="btn btn-sm" id="phex">随机 Hex（32位）×5</button></div></div>' +
        '<div class="t-section"><div class="sec-t">结果</div>' + U.outBlock('pout') +
        '<div class="small mt8" id="pinfo"></div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var SET = {
        up: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        lo: 'abcdefghijklmnopqrstuvwxyz',
        num: '0123456789',
        sym: '!@#$%^&*()-_=+[]{};:,.?/'
      };
      var build = function () {
        var pool = '';
        if ($('#pup').checked) pool += SET.up;
        if ($('#plo').checked) pool += SET.lo;
        if ($('#pnum').checked) pool += SET.num;
        if ($('#psym').checked) pool += SET.sym;
        if ($('#pnoamb').checked) pool = pool.replace(/[0O1lI]/g, '');
        if ($('#pnosim').checked) pool = pool.replace(/["'`\\]/g, '');
        var ex = $('#pex').value || '';
        for (var i = 0; i < ex.length; i++) pool = pool.split(ex[i]).join('');
        if (!pool) { U.toast('字符集为空，请至少勾选一种', 'err'); return null; }
        return pool;
      };
      var gen = function (len, pool, noDup) {
        if (noDup && len > pool.length) throw new Error('长度超过可用字符数（' + pool.length + '）');
        var arr = pool.split(''), out = '';
        for (var i = 0; i < len; i++) {
          var idx = U.randInt(arr.length);
          out += arr[idx];
          if (noDup) { arr.splice(idx, 1); }
        }
        return out;
      };
      $('#pgo').onclick = function () {
        try {
          var pool = build(); if (!pool) return;
          var len = Number($('#plen').value), cnt = Number($('#pcnt').value);
          if (!(len >= 1 && len <= 512)) throw new Error('长度 1-512');
          if (!(cnt >= 1 && cnt <= 200)) throw new Error('数量 1-200');
          var noDup = $('#pnodup').checked, pre = $('#ppre').value || '';
          var lines = [];
          for (var i = 0; i < cnt; i++) lines.push(pre + gen(len, pool, noDup));
          U.setOut('pout', lines.join('\n'));
          var entropy = Math.log2(Math.pow(pool.length, len));
          var lv = entropy < 50 ? ['弱', 'err'] : entropy < 80 ? ['中等', 'warn'] : entropy < 120 ? ['强', 'ok'] : ['极强', 'ok'];
          $('#pinfo').innerHTML = '字符集大小 <b>' + pool.length + '</b> · 单条熵约 <b>' + entropy.toFixed(1) +
            ' bits</b> · 强度 <span class="tag ' + lv[1] + '">' + lv[0] + '</span>' +
            '<br>按当前算力，暴力破解约需 10^' + Math.floor(entropy / 3.32 * 0.6) + ' 年量级（仅为量级估算）';
        } catch (e) { U.toast(e.message, 'err'); }
      };
      $('#puuid').onclick = function () {
        var out = [];
        for (var i = 0; i < 5; i++) {
          var b = new Uint8Array(16);
          (window.crypto || {}).getRandomValues ? crypto.getRandomValues(b) : b.forEach(function (_, k) { b[k] = U.randInt(256); });
          b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
          var h = Array.prototype.map.call(b, function (x) { return U.pad(x.toString(16), 2); }).join('');
          out.push(h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20));
        }
        U.setOut('pout', out.join('\n'));
      };
      $('#phex').onclick = function () {
        var out = [];
        for (var i = 0; i < 5; i++) {
          var s = '';
          for (var j = 0; j < 32; j++) s += '0123456789abcdef'[U.randInt(16)];
          out.push(s);
        }
        U.setOut('pout', out.join('\n'));
      };
      $('#pgo').click();
    }
  });

  /* ---------- 2. Crontab 可视化生成器 ---------- */
  LB.register({
    id: 'cron', cat: 'linux', icon: '⏰', name: 'Crontab 生成器',
    desc: '可视化拼 Cron 表达式，预览下次执行时间',
    kw: 'cron crontab 定时任务 表达式 生成器 linux',
    tpl: function () {
      var f = function (id, label, ph) {
        return '<div class="field"><label class="field-l">' + label + '</label><input type="text" id="' + id + '" value="*" placeholder="' + ph + '"></div>';
      };
      return '<div class="t-section"><div class="sec-t">字段（分 时 日 月 周）</div>' +
        '<div class="row tight">' + f('cmin', '分钟 0-59', '0') + f('chour', '小时 0-23', '2') +
        f('cday', '日 1-31', '*') + f('cmon', '月 1-12', '*') + f('cdow', '周 0-7', '*') + '</div>' +
        '<div class="field mt8"><label class="field-l">要执行的命令</label>' +
        '<input type="text" class="mono" id="ccmd" value="/usr/local/bin/backup.sh >> /var/log/backup.log 2>&1"></div>' +
        '<div class="field"><label class="field-l">常用预设</label><select id="cpreset">' +
        '<option value="">— 选择预设 —</option>' +
        '<option value="* * * * *">每分钟</option>' +
        '<option value="*/5 * * * *">每 5 分钟</option>' +
        '<option value="0 * * * *">每小时整点</option>' +
        '<option value="0 2 * * *">每天凌晨 2:00</option>' +
        '<option value="30 3 * * 0">每周日 3:30</option>' +
        '<option value="0 0 1 * *">每月 1 号 0:00</option>' +
        '<option value="0 0 * * 1-5">工作日每天 0:00</option>' +
        '<option value="0 */2 * * *">每 2 小时</option>' +
        '<option value="0 9,18 * * *">每天 9:00 和 18:00</option>' +
        '<option value="0 0 1 1 *">每年 1 月 1 日</option>' +
        '<option value="@reboot">@reboot 开机执行</option>' +
        '<option value="@daily">@daily 每天</option>' +
        '<option value="@weekly">@weekly 每周</option>' +
        '<option value="@monthly">@monthly 每月</option></select></div>' +
        '<div class="btn-group"><button class="btn btn-pri" id="cgo">解析并预览</button></div></div>' +
        '<div class="t-section"><div class="sec-t">表达式</div>' + U.outBlock('cout') + '</div>' +
        '<div class="t-section"><div class="sec-t">人类可读说明</div><div class="out" id="cdesc"></div></div>' +
        '<div class="t-section"><div class="sec-t">接下来 10 次执行时间</div><div class="out" id="cnext"></div></div>' +
        '<div class="t-section"><div class="sec-t">字段规则速记</div><div class="small" style="line-height:2">' +
        '<span class="mono">*</span> 任意值　<span class="mono">,</span> 列举（1,3,5）　<span class="mono">-</span> 范围（1-5）　<span class="mono">/</span> 步长（*/10）<br>' +
        '周字段 0 和 7 都表示周日；<b>日与周同时指定时为「或」关系</b>（满足其一即执行）<br>' +
        '命令中 <span class="mono">%</span> 需转义为 <span class="mono">\\%</span>；建议命令用绝对路径，并重定向输出到日志<br>' +
        '系统级任务写 <span class="mono">/etc/crontab</span>（多一个用户字段），用户级用 <span class="mono">crontab -e</span></div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      var DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
      function parseField(str, min, max, names) {
        str = String(str).trim().toUpperCase();
        if (!str || str === '?' || str === '*') return null;
        if (str.indexOf('/') >= 0 && str.split('/')[0] === '*') { }
        var set = new Set();
        str.split(',').forEach(function (part) {
          part = part.trim();
          var stepS = '', range = part;
          if (part.indexOf('/') >= 0) { var pp = part.split('/'); range = pp[0]; stepS = pp[1]; }
          var step = stepS ? parseInt(stepS, 10) : 1;
          var lo, hi;
          if (range === '*') { lo = min; hi = max; }
          else if (range.indexOf('-') >= 0) {
            var rr = range.split('-');
            lo = norm(rr[0]); hi = norm(rr[1]);
          } else { lo = norm(range); hi = (stepS && range === '*') ? max : lo; if (stepS && range !== '*') hi = max; }
          if (isNaN(lo) || isNaN(hi) || lo < min || hi > max) throw new Error('字段值超出范围（' + min + '-' + max + '）：' + part);
          for (var i = lo; i <= hi; i += step) set.add(i);
        });
        function norm(x) {
          x = String(x).trim();
          if (names && names.indexOf(x) >= 0) return names.indexOf(x) + min;
          return parseInt(x, 10);
        }
        return set;
      }
      function describe(sets) {
        var p = [];
        var m = sets.min, h = sets.hour, dom = sets.day, mon = sets.mon, dow = sets.dow;
        var f = function (set, min, max, unit) {
          if (!set) return '每' + unit;
          var arr = Array.from(set).sort(function (a, b) { return a - b; });
          if (arr.length === 1) return (unit === '月' ? arr[0] + ' 月' : unit === '周' ? '星期' + (arr[0] % 7) : arr[0] + ' ' + unit);
          // 检测是否等差
          var step = arr[1] - arr[0], even = true;
          for (var i = 2; i < arr.length; i++) if (arr[i] - arr[i - 1] !== step) { even = false; break; }
          if (even && arr.length > 2) return '每 ' + step + ' ' + unit + '（从 ' + arr[0] + ' 开始）';
          return arr.join('、') + ' ' + unit;
        };
        p.push('在 ' + f(h, 0, 23, '时') + ' 的 ' + f(m, 0, 59, '分'));
        if (dom && mon) p.push('于 ' + f(mon, 1, 12, '月') + ' ' + f(dom, 1, 31, '日'));
        else if (dom) p.push('于每月 ' + f(dom, 1, 31, '日'));
        else if (mon) p.push('于 ' + f(mon, 1, 12, '月') + ' 的每一天');
        if (dow) p.push('且为 ' + f(dow, 0, 6, '周'));
        return p.join('，');
      }
      var run = function () {
        var expr = [$('#cmin').value.trim(), $('#chour').value.trim(), $('#cday').value.trim(),
        $('#cmon').value.trim(), $('#cdow').value.trim()].filter(function (x) { return x; });
        var cmd = $('#ccmd').value.trim();
        if (expr.length !== 5) { U.toast('请填写完整的 5 个时间字段', 'err'); return; }
        var exprStr = expr.join(' ');
        try {
          var sets = {
            min: parseField(expr[0], 0, 59, null),
            hour: parseField(expr[1], 0, 23, null),
            day: parseField(expr[2], 1, 31, null),
            mon: parseField(expr[3], 1, 12, MON),
            dow: parseField(expr[4], 0, 7, null)
          };
          if (sets.dow) { if (sets.dow.has(7)) { sets.dow.delete(7); sets.dow.add(0); } }
          U.setOut('cout', exprStr + (cmd ? '  ' + cmd : '') + '\n\n# 写入方式：crontab -e  # 查看：crontab -l');
          $('#cdesc').textContent = describe(sets);
          // 计算接下来 10 次
          var now = new Date();
          var t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0);
          var res = [], guard = 0;
          var limit = 366 * 24 * 60;
          while (res.length < 10 && guard < limit) {
            guard++;
            t = new Date(t.getTime() + 60000);
            var monOk = !sets.mon || sets.mon.has(t.getMonth() + 1);
            var domOk = !sets.day || sets.day.has(t.getDate());
            var dowOk = !sets.dow || sets.dow.has(t.getDay());
            var dateOk = (sets.day && sets.dow) ? (domOk || dowOk) : (monOk && domOk && dowOk);
            if (!dateOk) continue;
            if (sets.hour && !sets.hour.has(t.getHours())) continue;
            if (sets.min && !sets.min.has(t.getMinutes())) continue;
            res.push(U.fmtDate(t, true) + '  周' + '日一二三四五六'[t.getDay()]);
          }
          $('#cnext').textContent = res.length ? res.join('\n') : '未来一年内没有匹配的执行时间，请检查表达式';
        } catch (e) { U.toast(e.message, 'err'); }
      };
      $('#cpreset').onchange = function () {
        var v = this.value;
        if (!v) return;
        if (v[0] === '@') { $('#cdesc').textContent = '特殊表达式 ' + v; U.setOut('cout', v + '  ' + $('#ccmd').value.trim()); $('#cnext').textContent = '（特殊表达式不计算具体时间）'; return; }
        var p = v.split(' ');
        $('#cmin').value = p[0]; $('#chour').value = p[1]; $('#cday').value = p[2]; $('#cmon').value = p[3]; $('#cdow').value = p[4];
        run();
      };
      $('#cgo').onclick = run;
      $('#cmin').value = '0'; $('#chour').value = '2';
      run();
    }
  });

  /* ---------- 3. Linux / Vim 命令速查 ---------- */
  LB.register({
    id: 'linuxcmd', cat: 'linux', icon: '🐧', name: 'Linux / Vim 命令速查',
    desc: '按分类检索常用命令，支持复制',
    kw: 'linux 命令 速查 shell vim 排查 系统管理',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">搜索</div>' +
        '<input type="text" id="cf" placeholder="如 端口 / 磁盘 / 日志 / dd">' +
        '<div class="tabs mt12" id="ctabs"></div></div>' +
        '<div class="t-section"><div class="sec-t">命令列表</div><div id="clist"></div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var groups = D.linuxGroups.concat([['vim', 'Vim 编辑器']]);
      var all = D.linuxCmd.map(function (c) { return [c[0], c[1], c[2]]; })
        .concat(D.vimCmd.map(function (c) { return ['vim', c[0] + ' → ' + c[1], c[2]]; }));
      var cur = 'all';
      $('#ctabs').innerHTML = '<button class="tab on" data-g="all">全部</button>' +
        groups.map(function (g) { return '<button class="tab" data-g="' + g[0] + '">' + g[1] + '</button>'; }).join('');
      var render = function () {
        var k = $('#cf').value.trim().toLowerCase();
        var rows = all.filter(function (c) {
          return (cur === 'all' || c[0] === cur) && (!k || c[1].toLowerCase().indexOf(k) >= 0 || c[2].toLowerCase().indexOf(k) >= 0);
        });
        $('#clist').innerHTML = rows.length ? rows.map(function (c) {
          return '<div class="cheat-item"><div class="cmd">' + U.esc(c[1]) + '</div><div class="dsc">' + U.esc(c[2]) + '</div>' +
            '<button class="btn btn-sm cp" data-c="' + U.esc(c[1]) + '">复制</button></div>';
        }).join('') : '<div class="small" style="text-align:center;padding:20px">无匹配命令</div>';
        U.$$('#clist .cp', root).forEach(function (b) { b.onclick = function () { U.copy(b.dataset.c); }; });
      };
      U.$$('#ctabs .tab', root).forEach(function (t) {
        t.onclick = function () {
          U.$$('#ctabs .tab', root).forEach(function (x) { x.classList.remove('on'); });
          t.classList.add('on'); cur = t.dataset.g; render();
        };
      });
      $('#cf').oninput = render;
      render();
    }
  });

  /* ---------- 4. Base64 ---------- */
  LB.register({
    id: 'base64', cat: 'linux', icon: '🔤', name: 'Base64 编解码',
    desc: '文本 Base64 编码 / 解码，支持中文',
    kw: 'base64 编码 解码 encode decode 中文',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">输入</div>' +
        '<textarea id="bin" style="min-height:110px">Hello IT工具箱 🚀</textarea>' +
        '<div class="btn-group"><button class="btn btn-pri" id="benc">编码 ↓</button>' +
        '<button class="btn" id="bdec">解码 ↑</button>' +
        '<label class="chk" style="margin-left:auto"><input type="checkbox" id="burl">URL 安全（+/ → -_）</label></div></div>' +
        '<div class="t-section"><div class="sec-t">输出</div>' + U.outBlock('bout') + '</div>' +
        '<div class="t-section"><div class="sec-t">命令行等价</div><div class="small mono" style="line-height:1.9">' +
        'echo -n "str" | base64<br>echo "c3Ry" | base64 -d　（macOS 用 <span class="mono">base64 -D</span>）<br>' +
        'openssl base64 -in file -out out.txt<br>base64 -w 0 file　# 不换行</div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      $('#benc').onclick = function () {
        try {
          var s = U.b64enc($('#bin').value);
          if ($('#burl').checked) s = s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          U.setOut('bout', s);
        } catch (e) { U.toast(e.message, 'err'); }
      };
      $('#bdec').onclick = function () {
        try {
          var s = $('#bin').value.replace(/-/g, '+').replace(/_/g, '/');
          U.setOut('bout', U.b64dec(s));
        } catch (e) { U.toast('解码失败：不是合法的 Base64', 'err'); }
      };
      $('#benc').click();
    }
  });

  /* ---------- 5. JSON 格式化 ---------- */
  LB.register({
    id: 'json', cat: 'linux', icon: '🧾', name: 'JSON 格式化 / 校验',
    desc: '美化、压缩、转义、键排序与错误定位',
    kw: 'json 格式化 美化 压缩 校验 转义 parse',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">输入</div>' +
        '<textarea id="jin" style="min-height:150px">{"name":"IT工具箱","version":"1.0","tools":["ipv4","cron","sql"],"meta":{"offline":true,"count":34}}</textarea>' +
        '<div class="row mt8">' +
        '<div class="field"><label class="field-l">缩进</label><select id="jind"><option value="2">2 空格</option><option value="4">4 空格</option><option value="tab">Tab</option><option value="0">压缩</option></select></div>' +
        '<label class="chk" style="margin-bottom:8px"><input type="checkbox" id="jsort">键排序</label>' +
        '<label class="chk" style="margin-bottom:8px"><input type="checkbox" id="jesc">输出转义字符串</label></div>' +
        '<div class="btn-group"><button class="btn btn-pri" id="jfmt">格式化</button>' +
        '<button class="btn btn-sm" id="jmin">压缩</button>' +
        '<button class="btn btn-sm" id="jescb">转义为一行</button>' +
        '<button class="btn btn-sm" id="junesc">反转义</button>' +
        '<button class="btn btn-sm" id="jclr">清空</button></div></div>' +
        '<div class="t-section"><div class="sec-t">输出</div>' + U.outBlock('jout') +
        '<div class="small mt8" id="jinfo"></div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var sortFn = function (a, b) { return a[0] > b[0] ? 1 : a[0] < b[0] ? -1 : 0; };
      var parse = function () {
        var txt = $('#jin').value.trim();
        if (!txt) throw new Error('请输入 JSON');
        try { return JSON.parse(txt); }
        catch (e) {
          var m = /position (\d+)/.exec(e.message);
          if (m) {
            var pos = Number(m[1]);
            var before = txt.slice(0, pos).split('\n');
            e.message += '（第 ' + before.length + ' 行，第 ' + before[before.length - 1].length + ' 列附近）';
          }
          throw e;
        }
      };
      var fmt = function (ind) {
        try {
          var o = parse();
          var out = JSON.stringify(o, null, ind === 0 ? 0 : (ind === 'tab' ? '\t' : Number(ind)));
          if (ind !== 0 && $('#jsort').checked) out = JSON.stringify(sortObj(o), null, ind === 'tab' ? '\t' : Number(ind));
          $('#jout').textContent = $('#jesc').checked ? JSON.stringify(out) : out;
          var size = new Blob([$('#jin').value]).size, osize = new Blob([out]).size;
          $('#jinfo').innerHTML = '<span class="tag ok">JSON 合法</span> 输入 ' + size + ' B → 输出 ' + osize + ' B' +
            ' · 顶层键 ' + (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).length : (Array.isArray(o) ? o.length + ' 项' : '基本类型'));
        } catch (e) { $('#jout').textContent = ''; $('#jinfo').innerHTML = '<span class="tag err">解析失败</span> ' + U.esc(e.message); }
      };
      function sortObj(o) {
        if (Array.isArray(o)) return o.map(sortObj);
        if (o && typeof o === 'object') {
          return Object.keys(o).sort().reduce(function (acc, k) { acc[k] = sortObj(o[k]); return acc; }, {});
        }
        return o;
      }
      $('#jfmt').onclick = function () { fmt($('#jind').value); };
      $('#jmin').onclick = function () { $('#jind').value = '0'; fmt(0); };
      $('#jescb').onclick = function () { try { U.setOut('jout', JSON.stringify($('#jin').value)); } catch (e) { U.toast(e.message, 'err'); } };
      $('#junesc').onclick = function () {
        try { U.setOut('jout', JSON.parse($('#jin').value)); } catch (e) { U.toast('不是合法的转义字符串', 'err'); }
      };
      $('#jclr').onclick = function () { $('#jin').value = ''; U.setOut('jout', ''); $('#jinfo').textContent = ''; };
      $('#jind').onchange = function () { if (this.value !== '0') fmt(this.value); };
      fmt(2);
    }
  });

  /* ---------- 6. chmod 权限计算器 ---------- */
  LB.register({
    id: 'chmod', cat: 'linux', icon: '🔓', name: 'chmod 权限计算器',
    desc: '数字 ↔ rwx 双向换算，含特殊权限位',
    kw: 'chmod 权限 rwx 755 644 setuid sticky 计算',
    tpl: function () {
      var grp = function (who) {
        return '<div class="field"><label class="field-l">' + who + '</label><div class="chk-grid">' +
          ['读 r', '写 w', '执行 x'].map(function (t, i) {
            return '<label class="chk"><input type="checkbox" class="perm" data-w="' + who + '" data-b="' + (4 >> i) + '">' + t + '</label>';
          }).join('') + '</div></div>';
      };
      return '<div class="t-section"><div class="sec-t">数字模式</div>' +
        '<div class="row"><div class="field"><label class="field-l">权限数字（3-4 位）</label>' +
        '<input type="text" id="mnum" value="755" placeholder="755 / 4755"></div>' +
        '<div class="field" style="flex:0 0 auto"><button class="btn btn-pri" id="mgo">→ 解析</button></div></div>' +
        '<div class="kv mt12" id="mkv"></div></div>' +
        '<div class="t-section"><div class="sec-t">符号模式（勾选后自动生成命令）</div>' +
        grp('所有者 user') + grp('所属组 group') + grp('其他 other') +
        '<div class="field"><label class="field-l">特殊权限位</label><div class="chk-grid">' +
        '<label class="chk"><input type="checkbox" class="sp" data-b="4">setuid（4000，执行时以属主身份）</label>' +
        '<label class="chk"><input type="checkbox" class="sp" data-b="2">setgid（2000，继承目录属组）</label>' +
        '<label class="chk"><input type="checkbox" class="sp" data-b="1">sticky（1000，仅属主可删，如 /tmp）</label></div></div>' +
        '<div class="field"><label class="field-l">文件/目录路径</label><input type="text" class="mono" id="mpath" value="/var/www/html"></div>' +
        '<div class="btn-group"><button class="btn btn-pri" id="mgen">生成命令</button></div>' +
        '<div class="mt12">' + U.outBlock('mout') + '</div></div>' +
        '<div class="t-section"><div class="sec-t">速查</div><div class="small" style="line-height:2">' +
        '<span class="mono">644</span> 文件常规　<span class="mono">755</span> 可执行文件/目录　<span class="mono">600</span> 私钥　' +
        '<span class="mono">700</span> 个人目录　<span class="mono">777</span> ⚠️ 危险，别用<br>' +
        '<span class="mono">chmod -R 755 dir</span> 递归改目录　<span class="mono">chown -R www:www dir</span> 递归改属主<br>' +
        '<span class="mono">umask 022</span> → 新建文件 644/目录 755；<span class="mono">umask 077</span> → 600/700</div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var sym = function (n) {
        return ((n & 4) ? 'r' : '-') + ((n & 2) ? 'w' : '-') + ((n & 1) ? 'x' : '-');
      };
      var parse = function () {
        var v = $('#mnum').value.trim();
        if (!/^[0-7]{3,4}$/.test(v)) { U.toast('请输入 3-4 位八进制数（0-7）', 'err'); return; }
        var s = v.length === 4 ? v : '0' + v;
        var parts = [Number(s[1]), Number(s[2]), Number(s[3])];
        var sp = Number(s[0]);
        var names = ['所有者', '所属组', '其他'];
        $('#mkv').innerHTML =
          '<div class="k">数字表示</div><div class="v hl">' + v + '</div>' +
          '<div class="k">符号表示</div><div class="v hl">' + (sp ? '特殊位 ' + sp + ' + ' : '') + parts.map(sym).join('') + '</div>' +
          '<div class="k">逐位拆解</div><div class="v">' + names.map(function (n, i) { return n + ' = ' + parts[i] + ' (' + sym(parts[i]) + ')'; }).join('　') + '</div>' +
          (sp ? '<div class="k">特殊位</div><div class="v">' + (sp & 4 ? 'setuid ' : '') + (sp & 2 ? 'setgid ' : '') + (sp & 1 ? 'sticky' : '') + '</div>' : '') +
          '<div class="k">等价命令</div><div class="v">chmod ' + v + ' ' + ($('#mpath').value || 'file') + '</div>';
        // 回写到勾选框
        U.$$('.perm', root).forEach(function (c) {
          var idx = ['所有者 user', '所属组 group', '其他 other'].indexOf(c.dataset.w);
          c.checked = !!(parts[idx] & Number(c.dataset.b));
        });
        U.$$('.sp', root).forEach(function (c) { c.checked = !!(sp & Number(c.dataset.b)); });
      };
      var gen = function () {
        var parts = [0, 0, 0], names = ['所有者 user', '所属组 group', '其他 other'];
        U.$$('.perm', root).forEach(function (c) {
          if (!c.checked) return;
          parts[names.indexOf(c.dataset.w)] += Number(c.dataset.b);
        });
        var sp = 0;
        U.$$('.sp', root).forEach(function (c) { if (c.checked) sp += Number(c.dataset.b); });
        var num = (sp ? String(sp) : '') + parts.join('');
        var p = $('#mpath').value.trim() || 'file';
        U.setOut('mout', 'chmod ' + num + ' ' + p + '\n# 递归：chmod -R ' + num + ' ' + p +
          '\n# 等价符号写法：chmod ' + ['u', 'g', 'o'].map(function (w, i) {
            return w + '=' + sym(parts[i]).replace(/-/g, '');
          }).join(',') + ' ' + p);
      };
      $('#mgo').onclick = parse;
      $('#mnum').onkeydown = function (e) { if (e.key === 'Enter') parse(); };
      $('#mgen').onclick = gen;
      U.$$('.perm,.sp', root).forEach(function (c) { c.onchange = gen; });
      parse(); gen();
    }
  });

  /* ---------- 7. URL 编解码 ---------- */
  LB.register({
    id: 'urlcodec', cat: 'linux', icon: '🔗', name: 'URL 编解码',
    desc: 'URL 组件编码、参数解析与构造',
    kw: 'url 编码 解码 encodeURIComponent 参数 querystring',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">输入</div>' +
        '<textarea id="uin" style="min-height:90px">https://example.com/search?q=IT工具箱&page=1#top</textarea>' +
        '<div class="btn-group"><button class="btn btn-pri" id="uenc">编码</button>' +
        '<button class="btn" id="udec">解码</button>' +
        '<button class="btn btn-sm" id="uparse">解析结构</button></div></div>' +
        '<div class="t-section"><div class="sec-t">输出</div>' + U.outBlock('uout') + '</div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      $('#uenc').onclick = function () { U.setOut('uout', encodeURIComponent($('#uin').value)); };
      $('#udec').onclick = function () { try { U.setOut('uout', decodeURIComponent($('#uin').value.replace(/\+/g, ' '))); } catch (e) { U.toast('解码失败', 'err'); } };
      $('#uparse').onclick = function () {
        try {
          var u = new URL($('#uin').value.trim());
          var rows = [['协议 protocol', u.protocol], ['主机 host', u.host], ['主机名 hostname', u.hostname],
          ['端口 port', u.port || '(默认)'], ['路径 pathname', u.pathname], ['查询串 search', u.search], ['锚点 hash', u.hash || '(无)']];
          var ps = [];
          u.searchParams.forEach(function (v, k) { ps.push(k + ' = ' + v); });
          U.setOut('uout', rows.map(function (r) { return r[0].padEnd(16, ' ') + r[1]; }).join('\n') +
            (ps.length ? '\n\n查询参数：\n' + ps.join('\n') : ''));
        } catch (e) { U.toast('不是完整的 URL（需含 http:// 等协议头）', 'err'); }
      };
      $('#uparse').click();
    }
  });

  /* ---------- 8. 哈希计算 ---------- */
  LB.register({
    id: 'hash', cat: 'linux', icon: '#️⃣', name: '哈希 / 校验值计算',
    desc: 'MD5、SHA-1/256/512 等文本摘要',
    kw: 'hash md5 sha1 sha256 校验 摘要 签名',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">输入文本</div>' +
        '<textarea id="hin" style="min-height:100px">IT工具箱</textarea>' +
        '<div class="btn-group"><button class="btn btn-pri" id="hgo">计算</button></div></div>' +
        '<div class="t-section"><div class="sec-t">结果（点击行复制）</div><div id="hout"></div>' +
        '<div class="small mt8">对比校验：<span class="mono">md5sum file</span> / <span class="mono">sha256sum file</span>；' +
        '本页结果应与命令行一致（同样区分大小写与换行）</div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var render = function () {
        var txt = $('#hin').value;
        var md5 = U.md5(txt);
        var rows = [['MD5', md5]];
        var algos = ['SHA-1', 'SHA-256', 'SHA-512'];
        var html = function () {
          $('#hout').innerHTML = rows.map(function (r) {
            return '<div class="cheat-item"><div class="cmd" style="flex:0 0 78px">' + r[0] + '</div>' +
              '<div class="cmd" style="flex:1;color:var(--txt)">' + r[1] + '</div>' +
              '<button class="btn btn-sm cp" data-c="' + r[1] + '">复制</button></div>';
          }).join('');
          U.$$('#hout .cp', root).forEach(function (b) { b.onclick = function () { U.copy(b.dataset.c); }; });
        };
        html();
        algos.forEach(function (a) {
          U.sha(txt, a).then(function (h) {
            rows.push([a, h]); rows.sort(function (x, y) { return ['MD5', 'SHA-1', 'SHA-256', 'SHA-512'].indexOf(x[0]) - ['MD5', 'SHA-1', 'SHA-256', 'SHA-512'].indexOf(y[0]); });
            html();
          }).catch(function () {
            rows.push([a, '(当前环境不支持 Web Crypto，请用 md5sum/sha256sum 命令)']); html();
          });
        });
      };
      $('#hgo').onclick = render;
      $('#hin').oninput = function () {
        clearTimeout(this._t);
        this._t = setTimeout(render, 250);
      };
      render();
    }
  });

  /* ---------- 9. 时间戳转换 ---------- */
  LB.register({
    id: 'timestamp', cat: 'linux', icon: '🕐', name: '时间戳转换',
    desc: 'Unix 时间戳 ↔ 日期，多格式输出',
    kw: 'timestamp 时间戳 日期 unix 转换 时区',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">当前时间</div>' +
        '<div class="kv" id="tnow"></div>' +
        '<div class="btn-group"><button class="btn btn-sm" id="trefresh">刷新</button>' +
        '<button class="btn btn-sm" id="tpause">暂停自动刷新</button></div></div>' +
        '<div class="t-section"><div class="sec-t">时间戳 ↔ 日期</div>' +
        '<div class="row"><div class="field"><label class="field-l">Unix 时间戳（秒 / 毫秒自动识别）</label>' +
        '<input type="text" id="tts" value="1735689600"></div>' +
        '<div class="field"><label class="field-l">日期时间</label><input type="text" id="tdt" placeholder="2026-01-01 00:00:00"></div></div>' +
        '<div class="btn-group"><button class="btn btn-pri" id="t2d">时间戳 → 日期</button>' +
        '<button class="btn" id="d2t">日期 → 时间戳</button></div>' +
        '<div class="kv mt12" id="tkv"></div></div>' +
        '<div class="t-section"><div class="sec-t">常用格式</div><div class="scroll-x"><table class="tb" id="tfmt"></table></div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var timer = null, paused = false;
      var tick = function () {
        var now = Math.floor(Date.now() / 1000);
        $('#tnow').innerHTML = [
          ['秒级时间戳', now + '  <button class="btn btn-sm cp" data-c="' + now + '">复制</button>'],
          ['毫秒级时间戳', Date.now() + '  <button class="btn btn-sm cp" data-c="' + Date.now() + '">复制</button>'],
          ['本地时间', U.fmtDate(new Date(), true)],
          ['ISO 8601', new Date().toISOString()],
          ['UTC 时间', new Date().toUTCString()]
        ].map(function (r) { return '<div class="k">' + r[0] + '</div><div class="v hl">' + r[1] + '</div>'; }).join('');
        U.$$('#tnow .cp', root).forEach(function (b) { b.onclick = function () { U.copy(b.dataset.c); }; });
      };
      var start = function () {
        clearInterval(timer);
        if (!paused) timer = setInterval(tick, 1000);
      };
      tick(); start();
      $('#trefresh').onclick = tick;
      $('#tpause').onclick = function () {
        paused = !paused;
        this.textContent = paused ? '恢复自动刷新' : '暂停自动刷新';
        start();
      };
      var toDate = function (ts) {
        ts = String(ts).trim();
        var n = Number(ts);
        if (!isFinite(n)) throw new Error('时间戳无效');
        if (Math.abs(n) > 1e11) n = Math.floor(n / 1000); // 毫秒
        return new Date(n * 1000);
      };
      var render = function (d) {
        var ts = Math.floor(d.getTime() / 1000);
        $('#tkv').innerHTML = [
          ['本地时间', U.fmtDate(d, true)],
          ['秒级时间戳', ts],
          ['毫秒级时间戳', d.getTime()],
          ['ISO 8601', d.toISOString()],
          ['UTC', d.toUTCString()],
          ['星期', '星期' + '日一二三四五六'[d.getDay()]],
          ['距今', HumanDiff(Date.now() - d.getTime())]
        ].map(function (r) { return '<div class="k">' + r[0] + '</div><div class="v hl">' + U.esc(String(r[1])) + '</div>'; }).join('');
        $('#tfmt').innerHTML = '<tr><th>格式</th><th>值</th></tr>' + [
          ['YYYY-MM-DD', d.getFullYear() + '-' + U.pad(d.getMonth() + 1) + '-' + U.pad(d.getDate())],
          ['YYYY/MM/DD HH:mm:ss', U.fmtDate(d, true).replace(/-/g, '/')],
          ['YYYYMMDD', '' + d.getFullYear() + U.pad(d.getMonth() + 1) + U.pad(d.getDate())],
          ['MySQL DATETIME', U.fmtDate(d, true)],
          ['Nginx/Apache 日志', d.toUTCString()],
          ['ISO 8601', d.toISOString()],
          ['date +%s 命令', 'date -d "' + U.fmtDate(d, true) + '" +%s']
        ].map(function (r) { return '<tr><td class="k mono">' + U.esc(r[0]) + '</td><td class="mono">' + U.esc(r[1]) + '</td></tr>'; }).join('');
      };
      function HumanDiff(ms) {
        var abs = Math.abs(ms), s = Math.floor(abs / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), dd = Math.floor(h / 24);
        var t = dd ? dd + ' 天 ' + (h % 24) + ' 小时' : h ? h + ' 小时 ' + (m % 60) + ' 分' : m ? m + ' 分 ' + (s % 60) + ' 秒' : s + ' 秒';
        return ms >= 0 ? t + '前' : t + '后';
      }
      $('#t2d').onclick = function () { try { render(toDate($('#tts').value)); } catch (e) { U.toast(e.message, 'err'); } };
      $('#d2t').onclick = function () {
        var v = $('#tdt').value.trim();
        var d = new Date(v.replace(/-/g, '/'));
        if (isNaN(d.getTime())) { U.toast('日期格式无法识别，试试 2026-01-01 00:00:00', 'err'); return; }
        $('#tts').value = Math.floor(d.getTime() / 1000);
        render(d);
      };
      render(toDate($('#tts').value));
      root._cleanup = function () { clearInterval(timer); };
    }
  });
})();
