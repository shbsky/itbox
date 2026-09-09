/* ===== 数据库工具 ===== */
(function () {
  'use strict';
  var LB = window.LB, U = LB.util, D = LB.data;

  /* ---------- SQL 美化（关键字换行 + 字符串保护） ---------- */
  function protect(sql) {
    var store = [];
    var out = sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`])*`/g, function (m) {
      store.push(m); return '\u0001' + (store.length - 1) + '\u0001';
    });
    return { s: out, store: store };
  }
  function restore(sql, store) {
    return sql.replace(/\u0001(\d+)\u0001/g, function (m, i) { return store[Number(i)]; });
  }
  function beautify(sql) {
    var p = protect(sql), s = p.s.replace(/\s+/g, ' ').trim();
    var kws = ['INSERT INTO', 'DELETE FROM', 'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'INNER JOIN',
      'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'GROUP BY', 'ORDER BY', 'UNION ALL',
      'SELECT', 'FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET', 'VALUES', 'UPDATE', 'SET', 'JOIN', 'ON', 'AND', 'OR'];
    kws.forEach(function (k) {
      var re = new RegExp('\\s*\\b' + k.replace(/ /g, '\\s+') + '\\b\\s*', 'gi');
      s = s.replace(re, '\n' + (['AND', 'OR', 'ON'].indexOf(k) >= 0 ? '  ' : '') + k + ' ');
    });
    s = s.replace(/\n\s*\n/g, '\n').replace(/^\s+|\s+$/g, '');
    s = s.replace(/\(\s*/g, '( ').replace(/\s*\)/g, ' )');
    // 主子句顶格、AND/OR/ON 缩进
    var lines = s.split('\n'), out = [];
    lines.forEach(function (l) {
      l = l.trim();
      if (!l) return;
      var ind = /^(AND|OR|ON)\b/i.test(l) ? '  ' : '';
      out.push(ind + l);
    });
    return restore(out.join('\n'), p.store);
  }

  /* ---------- 1. SQL 审核 ---------- */
  LB.register({
    id: 'sqlreview', cat: 'db', icon: '🩺', name: 'SQL 审核 / 优化评分',
    desc: '40+ 条规则体检 SQL，给出评分与改写建议',
    kw: 'sql 审核 优化 评分 慢查询 规范 检查 review',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">输入 SQL（可多条，用分号分隔）</div>' +
        '<textarea id="qin" style="min-height:150px">SELECT * FROM user u LEFT JOIN order o ON u.id=o.user_id WHERE DATE(u.create_time)=\'2026-01-01\' AND u.status != 1 OR u.name LIKE \'%admin%\' ORDER BY RAND() LIMIT 100000, 20;</textarea>' +
        '<div class="btn-group"><button class="btn btn-pri" id="qgo">开始审核</button>' +
        '<button class="btn btn-sm" id="qdemo">加载示例</button>' +
        '<button class="btn btn-sm" id="qclr">清空</button></div></div>' +
        '<div id="qresult"></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var RULES = [
        {
          id: 'star', re: /select\s+\*/i, lv: 'warn',
          t: '使用了 SELECT *',
          d: '返回多余列会增加网络与 IO 开销，且表结构变更时容易出错，还可能导致覆盖索引失效。',
          s: '改成只查需要的字段，如 SELECT id,name,status FROM …'
        },
        {
          id: 'nowhere', re: /^\s*(update|delete)\b(?![\s\S]*?\bwhere\b)/i, lv: 'err',
          t: 'UPDATE / DELETE 没有 WHERE 条件',
          d: '会全表更新或删除，属于高危操作。',
          s: '务必加上 WHERE 条件；生产执行前先 SELECT 验证影响行数'
        },
        {
          id: 'delnolimit', re: /^\s*delete\b(?![\s\S]*?\blimit\b)/i, lv: 'warn',
          t: 'DELETE 未加 LIMIT',
          d: '大表删除容易造成长事务、主从延迟与锁等待。',
          s: 'DELETE FROM t WHERE … LIMIT 1000 分批删除'
        },
        {
          id: 'likepre', re: /like\s+['"]%/i, lv: 'err',
          t: 'LIKE 前置通配符 %xx',
          d: '前置 % 会导致 B+ 树索引失效，只能全表扫描。',
          s: '改为后置匹配 LIKE \'xx%\'，或接入全文索引 / ES'
        },
        {
          id: 'func', re: /where[\s\S]{0,400}?\b(date|year|month|day|left|substring|upper|lower|concat|ifnull|cast|convert|trim)\s*\(\s*[\w.`]+/i, lv: 'warn',
          t: '在 WHERE 条件中对列使用函数',
          d: '列被函数包裹后无法走索引，只能全表扫描。',
          s: '改写成范围条件：create_time >= \'2026-01-01\' AND create_time < \'2026-01-02\''
        },
        {
          id: 'calc', re: /where[\s\S]{0,200}?[\w.`]+\s*[-+*\/]\s*\d+\s*[=<>]/i, lv: 'warn',
          t: 'WHERE 中列参与了运算',
          d: '列参与运算同样无法使用索引。',
          s: '把运算移到等号右边：WHERE id = 100 - 1'
        },
        {
          id: 'implict', re: /[\w.`]+\s*=\s*['"]\d+['"]/i, lv: 'warn',
          t: '疑似隐式类型转换',
          d: '数字型字段用字符串比较会触发隐式转换，导致索引失效（如 varchar 与 int 比较）。',
          s: '保持类型一致，去掉多余的引号'
        },
        {
          id: 'or', re: /\bwhere\b[\s\S]*?\bor\b[\s\S]*?[=<>]/i, lv: 'warn',
          t: 'WHERE 中使用 OR 连接',
          d: 'OR 常导致优化器放弃索引而选择全表扫描。',
          s: '改为 UNION ALL 拆分，或为各条件分别建索引'
        },
        {
          id: 'notop', re: /\b(not\s+in|not\s+exists|!=|<>)\b/i, lv: 'warn',
          t: '使用了负向查询（!=、NOT IN、NOT EXISTS）',
          d: '负向条件难以利用索引，且 NOT IN 遇 NULL 会返回空集。',
          s: '改写为 LEFT JOIN … IS NULL 或正向 IN 列表'
        },
        {
          id: 'rand', re: /order\s+by\s+rand\(\)/i, lv: 'err',
          t: 'ORDER BY RAND()',
          d: '需要对全部结果随机排序后再取，代价极高。',
          s: '改用随机主键区间：WHERE id >= RAND()*MAX(id) LIMIT 1'
        },
        {
          id: 'bigoffset', re: /limit\s+(\d{4,})\s*,/i, lv: 'warn',
          t: '深分页（大 OFFSET）',
          d: 'MySQL 需要先扫描并丢弃 offset 行，越往后越慢。',
          s: '用游标分页：WHERE id > 上一页最大id ORDER BY id LIMIT 20'
        },
        {
          id: 'joinnoon', re: /\bjoin\b(?![\s\S]*?\bon\b)/i, lv: 'err',
          t: 'JOIN 缺少 ON 条件',
          d: '会产生笛卡尔积，结果集爆炸。',
          s: '补上 ON 关联条件'
        },
        {
          id: 'multijoin', re: /(\bjoin\b[\s\S]*?){3,}/i, lv: 'info',
          t: '关联了 3 张以上的表',
          d: '多表 JOIN 执行计划复杂，容易走错驱动表。',
          s: '考虑拆成多条简单查询在应用层组装，或加冗余字段'
        },
        {
          id: 'subquery', re: /\(\s*select\b/i, lv: 'info',
          t: '包含子查询',
          d: 'MySQL 5.6 以前子查询优化较差，可能产生临时表。',
          s: '评估改写成 JOIN'
        },
        {
          id: 'inlong', re: /\bin\s*\((?:[^()]{300,})\)/i, lv: 'warn',
          t: 'IN 列表过长',
          d: 'IN 列表过长会消耗大量内存并拖慢解析。',
          s: '拆分成多次查询，或改用临时表 JOIN'
        },
        {
          id: 'insertnocol', re: /insert\s+into\s+[\w.`]+\s*(values|\()/i, lv: 'warn',
          t: 'INSERT 未指定列名',
          d: '表结构变更（加列）后语句会失败或写错位。',
          s: '写成 INSERT INTO t (c1,c2) VALUES (?,?)'
        },
        {
          id: 'union', re: /\bunion\b(?!\s+all)/i, lv: 'info',
          t: '使用了 UNION（去重）',
          d: 'UNION 隐含 DISTINCT，会做一次去重排序。',
          s: '若确定无重复，改用 UNION ALL'
        },
        {
          id: 'distinct', re: /select\s+distinct/i, lv: 'info',
          t: '使用了 DISTINCT',
          d: 'DISTINCT 需要排序或哈希去重，代价不小，有时掩盖了 JOIN 数据膨胀问题。',
          s: '先确认是否因 JOIN 产生重复，改用 GROUP BY 或 EXISTS'
        },
        {
          id: 'calcfound', re: /sql_calc_found_rows/i, lv: 'warn',
          t: '使用了 SQL_CALC_FOUND_ROWS',
          d: '该特性已废弃，且会强制扫描全部匹配行。',
          s: '改用 COUNT(*) 单独查询'
        },
        {
          id: 'nolimit', re: /^\s*select\b(?![\s\S]*?\blimit\b)(?![\s\S]*?\bcount\s*\()/i, lv: 'info',
          t: 'SELECT 未加 LIMIT',
          d: '可能返回超大结果集，撑爆应用内存。',
          s: '加 LIMIT 或改为分页查询'
        },
        {
          id: 'ctnoprimary', re: /create\s+table\b(?![\s\S]*?\bprimary\s+key\b)/i, lv: 'err',
          t: 'CREATE TABLE 未定义主键',
          d: 'InnoDB 无主键会用隐藏 row_id，影响主从复制与性能。',
          s: '显式定义自增主键 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY'
        },
        {
          id: 'utf8', re: /charset\s*=?\s*utf8\b(?!mb4)/i, lv: 'warn',
          t: '使用了 utf8（非 utf8mb4）',
          d: 'MySQL 的 utf8 最多 3 字节，存不了 emoji 等 4 字节字符。',
          s: '统一使用 utf8mb4 + utf8mb4_0900_ai_ci'
        },
        {
          id: 'floatmoney', re: /\b(float|double|real)\b[^,)]*\b(price|amount|money|fee|balance|salary)/i, lv: 'warn',
          t: '金额字段使用浮点类型',
          d: '浮点有精度丢失风险，对账会出问题。',
          s: '改用 DECIMAL(18,2) 或 BIGINT 存分'
        },
        {
          id: 'textblob', re: /(\btext\b|\bblob\b|\blongtext\b)/i, lv: 'info',
          t: '使用 TEXT / BLOB 类型',
          d: '大字段会拖慢查询并占用额外存储。',
          s: '考虑拆到独立附表，避免 SELECT * 时带出'
        },
        {
          id: 'enum', re: /\benum\s*\(/i, lv: 'info',
          t: '使用 ENUM 类型',
          d: 'ENUM 增加取值需要改表结构（DDL），不够灵活。',
          s: '改用 TINYINT + 字典表'
        },
        {
          id: 'nowait', re: /\b(for\s+update|lock\s+in\s+share\s+mode)\b/i, lv: 'info',
          t: '使用了加锁读',
          d: '会阻塞其他事务，注意锁范围与持有时间。',
          s: '确认隔离级别与索引命中，避免锁升级为表锁'
        },
        {
          id: 'toolong', re: /^[\s\S]{3000,}$/, lv: 'info',
          t: 'SQL 语句过长',
          d: '超长 SQL 解析与优化耗时会明显上升，且难以维护。',
          s: '拆分逻辑，或把部分条件放到应用层处理'
        },
        {
          id: 'selectconst', re: /select\s+\d+\s*(,|$|from)/i, lv: 'info',
          t: 'SELECT 常量',
          d: 'SELECT 1 常用于探活，注意确认是否走索引或缓存。',
          s: '探活建议固定用 SELECT 1'
        },
        {
          id: 'countstar', re: /count\s*\(\s*\*\s*\)/i, lv: 'info',
          t: '使用 COUNT(*)',
          d: 'COUNT(*) 在 MySQL 8 已优化得不错，但大表仍然慢。',
          s: '考虑近似值或维护计数表'
        }
      ];
      var run = function () {
        var raw = $('#qin').value.trim();
        if (!raw) { U.toast('请输入 SQL', 'err'); return; }
        var stmts = raw.split(/;\s*\n?/).map(function (x) { return x.trim(); }).filter(Boolean);
        var html = '';
        stmts.forEach(function (sql, idx) {
          var issues = [], score = 100;
          var clean = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
          RULES.forEach(function (r) {
            if (r.re.test(clean)) {
              issues.push(r);
              score -= r.lv === 'err' ? 15 : r.lv === 'warn' ? 8 : 3;
            }
          });
          score = Math.max(0, score);
          var lv = score >= 90 ? ['优秀', 'ok'] : score >= 70 ? ['良好', 'warn'] : score >= 50 ? ['需优化', 'warn'] : ['高风险', 'err'];
          html += '<div class="t-section">' +
            '<div class="sec-t">语句 ' + (idx + 1) + (stmts.length > 1 ? ' / ' + stmts.length : '') + '</div>' +
            '<div class="score"><div class="score-num" style="color:var(--' + (lv[1] === 'ok' ? 'ok' : lv[1] === 'err' ? 'err' : 'warn') + ')">' + score + '</div>' +
            '<div class="score-txt"><b>' + lv[0] + '</b><span>发现 ' + issues.length + ' 个问题（严重 ' +
            issues.filter(function (i) { return i.lv === 'err'; }).length + ' / 警告 ' +
            issues.filter(function (i) { return i.lv === 'warn'; }).length + ' / 提示 ' +
            issues.filter(function (i) { return i.lv === 'info'; }).length + '）</span></div></div>';
          if (!issues.length) {
            html += '<div class="alert info">未命中任何审核规则。仍建议结合实际数据量与执行计划（EXPLAIN）确认性能。</div>';
          } else {
            html += issues.map(function (i) {
              var ico = i.lv === 'err' ? '⛔' : i.lv === 'warn' ? '⚠️' : '💡';
              return '<div class="issue"><div class="lv">' + ico + '</div><div class="b">' +
                '<div class="tt">' + U.esc(i.t) + ' <span class="tag ' + (i.lv === 'err' ? 'err' : i.lv === 'warn' ? 'warn' : 'info') + '">' +
                (i.lv === 'err' ? '严重' : i.lv === 'warn' ? '警告' : '提示') + '</span></div>' +
                '<div class="ds">' + U.esc(i.d) + '</div>' +
                '<div class="ds"><b>建议：</b>' + U.esc(i.s) + '</div></div></div>';
            }).join('');
          }
          html += '<div class="sec-t mt12">格式化后的语句</div><div class="out-wrap"><div class="out">' +
            U.esc(beautify(sql)) + '</div><div class="out-ops">' +
            '<button class="btn btn-sm" data-copyraw="' + U.esc(beautify(sql)) + '">复制</button></div></div></div>';
        });
        $('#qresult').innerHTML = html;
        U.$$('#qresult [data-copyraw]', root).forEach(function (b) {
          b.onclick = function () { U.copy(b.getAttribute('data-copyraw')); };
        });
      };
      $('#qgo').onclick = run;
      $('#qdemo').onclick = function () {
        $('#qin').value = 'SELECT * FROM user u LEFT JOIN order o ON u.id=o.user_id WHERE DATE(u.create_time)=\'2026-01-01\' AND u.status != 1 OR u.name LIKE \'%admin%\' ORDER BY RAND() LIMIT 100000, 20;';
        run();
      };
      $('#qclr').onclick = function () { $('#qin').value = ''; $('#qresult').innerHTML = ''; };
      run();
    }
  });

  /* ---------- 2. EXPLAIN 执行计划解析 ---------- */
  LB.register({
    id: 'explain', cat: 'db', icon: '🔬', name: 'EXPLAIN 执行计划解析',
    desc: '粘贴 MySQL EXPLAIN 结果，自动诊断索引问题',
    kw: 'explain 执行计划 索引 优化 mysql 诊断',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">粘贴 EXPLAIN 输出（支持制表符 / 竖线 / 多空格分隔的表格）</div>' +
        '<textarea id="xin" style="min-height:170px">id\tselect_type\ttable\ttype\tpossible_keys\tkey\tkey_len\tref\trows\tExtra\n1\tSIMPLE\tuser\tALL\tNULL\tNULL\tNULL\tNULL\t98213\tUsing where\n1\tSIMPLE\torder\teq_ref\tPRIMARY\tPRIMARY\t8\ttest.user.id\t1\tUsing where</textarea>' +
        '<div class="btn-group"><button class="btn btn-pri" id="xgo">解析</button>' +
        '<button class="btn btn-sm" id="xdemo">示例</button>' +
        '<button class="btn btn-sm" id="xjson">JSON 格式示例</button></div></div>' +
        '<div id="xout"></div>' +
        '<div class="t-section"><div class="sec-t">type 性能等级（由好到差）</div>' +
        '<div class="small" style="line-height:1.9">system &gt; const &gt; eq_ref &gt; ref &gt; range &gt; index &gt; ALL<br>' +
        '口诀：<b>至少要到 range，追求 ref/const；出现 ALL 或 index 且 rows 很大，必须优化</b></div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var COLS = ['id', 'select_type', 'table', 'partitions', 'type', 'possible_keys', 'key', 'key_len', 'ref', 'rows', 'filtered', 'Extra'];
      var parse = function (txt) {
        var lines = txt.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l && !/^\+[-+]+\+$/.test(l); });
        if (!lines.length) throw new Error('内容为空');
        // 找表头
        var hi = -1, header = null;
        for (var i = 0; i < lines.length; i++) {
          var cells = splitRow(lines[i]);
          var hit = cells.filter(function (c) { return COLS.indexOf(c) >= 0; }).length;
          if (hit >= 4) { hi = i; header = cells; break; }
        }
        if (hi < 0) {
          // 尝试固定列顺序（无表头）
          var c2 = splitRow(lines[0]);
          if (c2.length >= 8) {
            header = COLS.slice(0, c2.length);
            hi = -1;
          } else throw new Error('未识别表头，请确认粘贴的是 EXPLAIN 表格结果');
        }
        var rows = [];
        lines.slice(hi + 1).forEach(function (l) {
          var cells = splitRow(l);
          if (cells.length < 3) return;
          if (/^\d+\s+row/i.test(l)) return;
          var o = {};
          header.forEach(function (h, k) { o[h] = cells[k] != null ? cells[k] : ''; });
          rows.push(o);
        });
        return { header: header, rows: rows };
      };
      function splitRow(line) {
        var l = line.trim().replace(/^\||\|$/g, '');
        var cells;
        if (l.indexOf('\t') >= 0) cells = l.split('\t');
        else if (l.indexOf('|') >= 0) cells = l.split('|');
        else cells = l.split(/\s{2,}/);
        return cells.map(function (c) { return c.trim(); });
      }
      var run = function () {
        try {
          var r = parse($('#xin').value);
          var idx = {};
          r.header.forEach(function (h, i) { idx[h] = i; });
          var html = '<div class="t-section"><div class="sec-t">解析结果（共 ' + r.rows.length + ' 行）</div><div class="scroll-x">' +
            '<table class="tb"><tr>' + r.header.map(function (h) { return '<th>' + U.esc(h) + '</th>'; }).join('') + '</tr>' +
            r.rows.map(function (o) {
              var t = (o.type || '').trim();
              var info = D.explainType[t] || {};
              var cls = info.lv >= 5 ? 'err' : info.lv >= 4 ? 'warn' : info.lv >= 3 ? 'info' : 'ok';
              return '<tr>' + r.header.map(function (h) {
                var v = o[h] || '';
                if (h === 'type') v = '<span class="tag ' + cls + '">' + U.esc(v) + '</span>';
                if (h === 'rows') v = '<b>' + U.esc(v) + '</b>';
                if (h === 'key' && (!v || v === 'NULL')) v = '<span class="tag err">NULL</span>';
                return '<td class="mono">' + v + '</td>';
              }).join('') + '</tr>';
            }).join('') + '</table></div></div>';
          // 诊断
          var issues = [];
          r.rows.forEach(function (o, i) {
            var t = (o.type || '').trim();
            var rowsN = Number((o.rows || '0').replace(/[^\d]/g, '')) || 0;
            var extra = (o.Extra || '');
            var key = (o.key || '').trim();
            var poss = (o.possible_keys || '').trim();
            var table = o.table || ('第' + (i + 1) + '行');
            if (t === 'ALL') issues.push(['err', '全表扫描：' + table, '扫描 ' + rowsN + ' 行，需为 WHERE / JOIN 条件字段建立合适索引。']);
            if (t === 'index') issues.push(['warn', '全索引扫描：' + table, '扫描整棵索引树（rows ' + rowsN + '），考虑加更精确的过滤条件。']);
            if ((!key || key === 'NULL') && poss && poss !== 'NULL') issues.push(['err', '有可用索引但未使用：' + table, 'possible_keys=' + poss + '，实际 key=NULL。常见原因：隐式类型转换、函数包裹列、统计信息过旧（可 ANALYZE TABLE）。']);
            if ((!key || key === 'NULL') && (!poss || poss === 'NULL')) issues.push(['warn', '无可用索引：' + table, '没有任何候选索引，建议按查询条件建联合索引（注意最左前缀）。']);
            if (/Using filesort/i.test(extra)) issues.push(['warn', 'Using filesort：' + table, '需要额外排序，考虑让 ORDER BY 字段走索引（与 WHERE 条件组成联合索引）。']);
            if (/Using temporary/i.test(extra)) issues.push(['warn', 'Using temporary：' + table, '创建了临时表（常见于 GROUP BY / DISTINCT / 子查询），尽量让分组字段走索引。']);
            if (/Using index/i.test(extra)) issues.push(['ok', '覆盖索引：' + table, '查询字段都在索引里，无需回表，性能很好。']);
            if (rowsN > 100000) issues.push(['warn', '扫描行数偏大：' + table, 'rows=' + rowsN + '，即使走索引代价也很高，建议增加过滤条件或分页。']);
            if (/Using join buffer/i.test(extra)) issues.push(['warn', 'Using join buffer：' + table, 'JOIN 字段没走索引，被关联字段必须建索引。']);
            if (/Range checked for each record/i.test(extra)) issues.push(['err', 'Range checked：' + table, 'MySQL 无法在连接时确定索引，检查 JOIN 字段类型是否一致。']);
          });
          html += '<div class="t-section"><div class="sec-t">诊断建议</div>' +
            (issues.length ? issues.map(function (i2) {
              var ico = i2[0] === 'err' ? '⛔' : i2[0] === 'warn' ? '⚠️' : '✅';
              return '<div class="issue"><div class="lv">' + ico + '</div><div class="b"><div class="tt">' + U.esc(i2[1]) + '</div>' +
                '<div class="ds">' + U.esc(i2[2]) + '</div></div></div>';
            }).join('') : '<div class="alert info">未发现明显问题，执行计划看起来不错。</div>') + '</div>';
          $('#xout').innerHTML = html;
        } catch (e) { U.toast(e.message, 'err'); }
      };
      $('#xgo').onclick = run;
      $('#xdemo').onclick = function () { $('#xin').value = 'id\tselect_type\ttable\ttype\tpossible_keys\tkey\tkey_len\tref\trows\tExtra\n1\tSIMPLE\tuser\tALL\tNULL\tNULL\tNULL\tNULL\t98213\tUsing where\n1\tSIMPLE\torder\teq_ref\tPRIMARY\tPRIMARY\t8\ttest.user.id\t1\tUsing where'; run(); };
      $('#xjson').onclick = function () {
        $('#xin').value = ['id\tselect_type\ttable\ttype\tpossible_keys\tkey\tkey_len\tref\trows\tfiltered\tExtra',
          '1\tPRIMARY\tuser\tref\tidx_status\tidx_status\t4\tconst\t12\t100.00\tUsing index condition',
          '1\tPRIMARY\torder\tref\tidx_uid\tidx_uid\t8\ttest.user.id\t3\t100.00\tUsing where; Using filesort'].join('\n');
        run();
      };
      run();
    }
  });

  /* ---------- 3. 慢 SQL 日志分析 ---------- */
  LB.register({
    id: 'slowlog', cat: 'db', icon: '🐌', name: '慢 SQL 日志分析',
    desc: '解析 MySQL slow log，聚合 Top 慢查询',
    kw: '慢日志 slow log 分析 mysql 慢查询 top 统计',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">粘贴慢日志内容</div>' +
        '<textarea id="sin" style="min-height:200px"># Time: 2026-09-01T02:10:11.123456Z\n# User@Host: app[app] @ 10.0.0.5 [10.0.0.5]  Id:  1234\n# Query_time: 3.512847  Lock_time: 0.000152 Rows_sent: 20  Rows_examined: 1823451\nSET timestamp=1780000000;\nSELECT * FROM orders WHERE user_id = 10086 AND status = 1 ORDER BY create_time DESC LIMIT 20;\n# Time: 2026-09-01T02:12:01.000000Z\n# User@Host: app[app] @ 10.0.0.5 [10.0.0.5]  Id:  1235\n# Query_time: 2.981234  Lock_time: 0.000120 Rows_sent: 20  Rows_examined: 1654321\nSET timestamp=1780000100;\nSELECT * FROM orders WHERE user_id = 10010 AND status = 1 ORDER BY create_time DESC LIMIT 20;\n# Time: 2026-09-01T02:15:00.000000Z\n# User@Host: report[report] @ 10.0.0.9 [10.0.0.9]  Id:  1236\n# Query_time: 12.345678  Lock_time: 0.001 Rows_sent: 5  Rows_examined: 9876543\nSET timestamp=1780000200;\nSELECT o.id, u.name, SUM(o.amount) FROM orders o LEFT JOIN users u ON o.user_id=u.id WHERE o.create_time > \'2026-08-01\' GROUP BY o.id ORDER BY SUM(o.amount) DESC LIMIT 5;</textarea>' +
        '<div class="row mt8"><div class="field"><label class="field-l">慢查询阈值（秒）</label><input type="number" id="sthr" value="1" step="0.1"></div>' +
        '<div class="field"><label class="field-l">Top N</label><input type="number" id="stop" value="10"></div>' +
        '<div class="field" style="flex:0 0 auto"><button class="btn btn-pri" id="sgo">分析</button></div></div></div>' +
        '<div id="sout"></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var run = function () {
        var txt = $('#sin').value;
        var thr = Number($('#sthr').value) || 0;
        var topN = Number($('#stop').value) || 10;
        var blocks = [], cur = null;
        txt.split('\n').forEach(function (line) {
          var t = line.trim();
          if (/^#\s*Time:/i.test(t)) { cur = { qt: 0, lt: 0, sent: 0, exam: 0, user: '', sql: [], time: t.replace(/^#\s*Time:\s*/i, '') }; blocks.push(cur); return; }
          if (!cur) return;
          var m = /#\s*User@Host:\s*(.+)/i.exec(t);
          if (m) { cur.user = m[1].trim(); return; }
          m = /#\s*Query_time:\s*([\d.]+)\s+Lock_time:\s*([\d.]+)\s+Rows_sent:\s*(\d+)\s+Rows_examined:\s*(\d+)/i.exec(t);
          if (m) { cur.qt = Number(m[1]); cur.lt = Number(m[2]); cur.sent = Number(m[3]); cur.exam = Number(m[4]); return; }
          if (/^(SET\s+timestamp|#\s*(Thread_id|Schema|Rows_affected|Bytes_sent|Errno|Killed|Read_first))/i.test(t)) return;
          if (/^(#|\/\*|--)/.test(t)) return;
          if (t) cur.sql.push(t);
        });
        var recs = blocks.filter(function (b) { return b.sql.length && b.qt >= thr; });
        if (!recs.length) { $('#sout').innerHTML = '<div class="alert warn">未解析到慢查询记录（阈值 ' + thr + 's）。请确认粘贴的是 MySQL slow log 原文。</div>'; return; }
        var norm = function (sql) {
          return sql.replace(/\s+/g, ' ')
            .replace(/'[^']*'/g, '?').replace(/"[^"]*"/g, '?')
            .replace(/\b\d+(\.\d+)?\b/g, '?')
            .replace(/\(\s*\?\s*(,\s*\?\s*){2,}\)/g, '(...)')
            .trim();
        };
        var agg = {};
        recs.forEach(function (b) {
          var key = norm(b.sql.join(' '));
          if (!agg[key]) agg[key] = { sql: key, sample: b.sql.join(' '), cnt: 0, sum: 0, max: 0, exam: 0, sent: 0, lock: 0 };
          var a = agg[key];
          a.cnt++; a.sum += b.qt; a.max = Math.max(a.max, b.qt); a.exam += b.exam; a.sent += b.sent; a.lock += b.lt;
        });
        var list = Object.keys(agg).map(function (k) { return agg[k]; })
          .sort(function (a, b) { return b.sum - a.sum; });
        var total = recs.length;
        var sumAll = recs.reduce(function (s, b) { return s + b.qt; }, 0);
        var maxAll = recs.reduce(function (s, b) { return Math.max(s, b.qt); }, 0);
        var avgAll = sumAll / total;
        var examAll = recs.reduce(function (s, b) { return s + b.exam; }, 0);
        var sentAll = recs.reduce(function (s, b) { return s + b.sent; }, 0);
        var pct = function (n) { return (n / sumAll * 100).toFixed(1) + '%'; };
        var html = '<div class="t-section"><div class="sec-t">总览</div><div class="kv">' +
          [['慢查询条数', total + ' 条'], ['去重后 SQL', list.length + ' 类'],
          ['总耗时', sumAll.toFixed(3) + ' s'], ['平均耗时', avgAll.toFixed(3) + ' s'],
          ['最大耗时', maxAll.toFixed(3) + ' s'],
          ['扫描行数合计', U.fmtNum(examAll)], ['返回行数合计', U.fmtNum(sentAll)],
          ['扫描/返回比', sentAll ? (examAll / sentAll).toFixed(1) + ' : 1' : '—']]
            .map(function (r) { return '<div class="k">' + r[0] + '</div><div class="v hl">' + U.esc(String(r[1])) + '</div>'; }).join('') +
          '</div></div>';
        html += '<div class="t-section"><div class="sec-t">Top ' + Math.min(topN, list.length) + ' 慢查询（按总耗时）</div><div class="scroll-x">' +
          '<table class="tb"><tr><th>#</th><th>次数</th><th>总耗时(s)</th><th>平均(s)</th><th>最大(s)</th><th>占比</th><th>扫描行</th><th>返回行</th></tr>' +
          list.slice(0, topN).map(function (a, i) {
            return '<tr><td class="k">' + (i + 1) + '</td><td>' + a.cnt + '</td><td><b>' + a.sum.toFixed(3) + '</b></td>' +
              '<td>' + (a.sum / a.cnt).toFixed(3) + '</td><td>' + a.max.toFixed(3) + '</td><td>' + pct(a.sum) + '</td>' +
              '<td>' + U.fmtNum(a.exam) + '</td><td>' + U.fmtNum(a.sent) + '</td></tr>';
          }).join('') + '</table></div></div>';
        html += '<div class="t-section"><div class="sec-t">明细与优化建议</div>' +
          list.slice(0, topN).map(function (a, i) {
            var adv = [];
            if (a.exam / Math.max(1, a.cnt) > 10000) adv.push('平均扫描 ' + Math.round(a.exam / a.cnt) + ' 行，索引命中率低，建议用 EXPLAIN 确认执行计划');
            if (a.sent && a.exam / a.sent > 100) adv.push('扫描 ' + (a.exam / a.sent).toFixed(0) + ' 行才返回 1 行，典型索引缺失');
            if (a.cnt > 100) adv.push('执行 ' + a.cnt + ' 次，高频语句优先优化，考虑加缓存');
            if (/order\s+by/i.test(a.sql) && /limit/i.test(a.sql)) adv.push('ORDER BY + LIMIT：让排序字段与过滤条件组成联合索引');
            if (/group\s+by/i.test(a.sql)) adv.push('含 GROUP BY，注意是否产生 Using temporary');
            if (a.sql.indexOf('?') > 0 && /limit\s+\?\s*,\s*\?/i.test(a.sql)) adv.push('疑似深分页，改用游标分页');
            if (!adv.length) adv.push('执行频率与扫描量都不高，可暂时观察');
            return '<div class="issue"><div class="lv"><span class="tag ' + (i < 3 ? 'err' : 'warn') + '">Top' + (i + 1) + '</span></div>' +
              '<div class="b"><div class="tt">耗时 ' + a.sum.toFixed(3) + 's · ' + a.cnt + ' 次 · 平均 ' + (a.sum / a.cnt).toFixed(3) + 's</div>' +
              '<div class="ds"><code style="display:block;white-space:pre-wrap;line-height:1.6">' + U.esc(a.sample.length > 260 ? a.sample.slice(0, 260) + ' …' : a.sample) + '</code></div>' +
              '<div class="ds mt8">' + adv.map(function (x) { return '• ' + U.esc(x); }).join('<br>') + '</div></div></div>';
          }).join('') + '</div>';
        $('#sout').innerHTML = html;
      };
      $('#sgo').onclick = run;
      run();
    }
  });

  /* ---------- 4. 数据库用户 / 授权生成器 ---------- */
  LB.register({
    id: 'grant', cat: 'db', icon: '🔑', name: '数据库用户 / GRANT 生成器',
    desc: '可视化勾选权限，生成建用户与授权语句',
    kw: 'grant 授权 用户 create user 权限 mysql 生成',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">基本信息</div>' +
        '<div class="row">' +
        '<div class="field"><label class="field-l">用户名</label><input type="text" id="gu" value="appuser"></div>' +
        '<div class="field"><label class="field-l">允许来源 Host</label><input type="text" id="gh" value="192.168.%.%"></div>' +
        '<div class="field"><label class="field-l">密码</label><input type="text" id="gp" value="Str0ng!Pass#2026"></div>' +
        '<div class="field"><label class="field-l">类型</label><select id="gdbms">' +
        '<option value="mysql">MySQL 5.7/8.0</option><option value="pg">PostgreSQL</option></select></div></div>' +
        '<div class="row mt8">' +
        '<div class="field"><label class="field-l">作用范围</label><select id="gscope">' +
        '<option value="one">单个库 .*</option><option value="all">全部库 *.*</option><option value="table">指定表</option></select></div>' +
        '<div class="field"><label class="field-l">库名</label><input type="text" id="gdb" value="appdb"></div>' +
        '<div class="field"><label class="field-l">表名（选「指定表」时）</label><input type="text" id="gtb" value="orders"></div></div></div>' +
        '<div class="t-section"><div class="sec-t">权限</div>' +
        '<div class="btn-group mb8"><button class="btn btn-sm" id="gall">全选</button>' +
        '<button class="btn btn-sm" id="gcrud">仅增删改查</button>' +
        '<button class="btn btn-sm" id="gread">只读</button>' +
        '<button class="btn btn-sm" id="gnone">清空</button></div>' +
        '<div class="chk-grid" id="gprivs"></div>' +
        '<div class="chk-grid mt8"><label class="chk"><input type="checkbox" id="gwith">WITH GRANT OPTION（可转授权限，谨慎）</label></div></div>' +
        '<div class="t-section"><div class="sec-t">生成语句</div>' + U.outBlock('gout') +
        '<div class="btn-group"><button class="btn btn-pri" id="ggo">生成</button></div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      $('#gprivs').innerHTML = D.dbPrivs.map(function (p) {
        var on = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].indexOf(p) >= 0;
        return '<label class="chk"><input type="checkbox" class="gp" value="' + p + '"' + (on ? ' checked' : '') + '>' + p + '</label>';
      }).join('');
      var set = function (arr) {
        U.$$('.gp', root).forEach(function (c) { c.checked = arr.indexOf(c.value) >= 0; });
      };
      $('#gall').onclick = function () { set(D.dbPrivs); };
      $('#gcrud').onclick = function () { set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']); };
      $('#gread').onclick = function () { set(['SELECT']); };
      $('#gnone').onclick = function () { set([]); };
      var gen = function () {
        var u = $('#gu').value.trim(), h = $('#gh').value.trim() || '%', p = $('#gp').value;
        var scope = $('#gscope').value, db = $('#gdb').value.trim() || '*', tb = $('#gtb').value.trim() || '*';
        var privs = U.$$('.gp', root).filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
        if (!u) { U.toast('请填写用户名', 'err'); return; }
        if (!privs.length) { U.toast('请至少勾选一项权限', 'err'); return; }
        var out;
        if ($('#gdbms').value === 'pg') {
          var pw = p ? " WITH PASSWORD '" + p + "'" : '';
          out = "-- 创建角色（PostgreSQL）\nCREATE ROLE " + u + " LOGIN" + pw + ";\n\n" +
            "-- 授权\nGRANT " + privs.map(function (x) { return x.split(' ')[0]; }).join(', ').toUpperCase() + " ON ALL TABLES IN SCHEMA public TO " + u + ";\n" +
            "-- 若需对新建表也生效：\nALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO " + u + ";\n\n" +
            "-- 查看权限\n\\du " + u;
        } else {
          var target = scope === 'all' ? '*.*' : scope === 'table' ? '`' + db + '`.`' + tb + '`' : '`' + db + '`.*';
          out = "-- 1. 创建用户\nCREATE USER '" + u + "'@'" + h + "' IDENTIFIED BY '" + p + "';\n\n" +
            "-- 2. 授权\nGRANT " + privs.join(', ') + " ON " + target + " TO '" + u + "'@'" + h + "'" +
            ($('#gwith').checked ? ' WITH GRANT OPTION' : '') + ";\n\n" +
            "-- 3. 刷新权限（MySQL 5.7 及以前建议执行）\nFLUSH PRIVILEGES;\n\n" +
            "-- 附：查看 / 回收 / 删除\nSHOW GRANTS FOR '" + u + "'@'" + h + "';\n" +
            "REVOKE " + privs.join(', ') + " ON " + target + " FROM '" + u + "'@'" + h + "';\n" +
            "DROP USER '" + u + "'@'" + h + "';\n\n" +
            "-- 附：修改密码\nALTER USER '" + u + "'@'" + h + "' IDENTIFIED BY 'NewPass#2026';";
        }
        U.setOut('gout', out);
      };
      $('#ggo').onclick = gen;
      U.$$('.gp,#gwith,#gdbms,#gscope', root).forEach(function (e) { e.onchange = gen; });
      gen();
    }
  });

  /* ---------- 5. SQL 生成器（建表 / 插入） ---------- */
  LB.register({
    id: 'sqlgen', cat: 'db', icon: '🏗️', name: 'SQL 建表 / 插入生成器',
    desc: '可视化编辑字段，生成 CREATE / INSERT 语句',
    kw: 'sql 生成器 create table insert 建表 ddl 语句',
    tpl: function () {
      return '<div class="tabs" id="sgtab"><button class="tab on" data-m="create">CREATE TABLE</button>' +
        '<button class="tab" data-m="insert">INSERT 语句</button></div>' +
        '<div id="sgcreate"><div class="t-section"><div class="sec-t">表信息</div>' +
        '<div class="row tight">' +
        '<div class="field"><label class="field-l">表名</label><input type="text" id="gt2" value="user"></div>' +
        '<div class="field"><label class="field-l">引擎</label><select id="ge"><option>InnoDB</option><option>MyISAM</option><option>Aria</option></select></div>' +
        '<div class="field"><label class="field-l">字符集</label><select id="gc"><option>utf8mb4</option><option>utf8</option><option>latin1</option></select></div>' +
        '<div class="field"><label class="field-l">表注释</label><input type="text" id="gcm" value="用户表"></div></div></div>' +
        '<div class="t-section"><div class="sec-t">字段</div><div id="gcols"></div>' +
        '<div class="btn-group"><button class="btn btn-sm" id="gadd">+ 添加字段</button>' +
        '<button class="btn btn-sm" id="greset">重置为示例</button></div></div>' +
        '<div class="t-section"><div class="sec-t">生成结果</div>' + U.outBlock('gout2') +
        '<div class="btn-group"><button class="btn btn-pri" id="ggo2">生成 SQL</button></div></div></div>' +
        '<div id="sginsert" hidden><div class="t-section"><div class="sec-t">批量插入配置</div>' +
        '<div class="row tight">' +
        '<div class="field"><label class="field-l">表名</label><input type="text" id="it" value="user"></div>' +
        '<div class="field"><label class="field-l">行数</label><input type="number" id="in2" value="3" min="1" max="500"></div>' +
        '<div class="field"><label class="field-l">冲突策略</label><select id="iu">' +
        '<option value="">普通 INSERT</option><option value="ignore">INSERT IGNORE</option>' +
        '<option value="update">ON DUPLICATE KEY UPDATE</option><option value="replace">REPLACE INTO</option></select></div></div>' +
        '<div class="field mt8"><label class="field-l">字段定义（每行一个：字段名 类型）</label>' +
        '<textarea id="ifields" style="min-height:120px">id bigint\nname varchar(64)\nstatus tinyint\ncreate_time datetime</textarea></div>' +
        '<div class="btn-group"><button class="btn btn-pri" id="igo2">生成 INSERT</button></div></div>' +
        '<div class="t-section"><div class="sec-t">生成结果</div>' + U.outBlock('iout2') + '</div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      U.$$('#sgtab .tab', root).forEach(function (t) {
        t.onclick = function () {
          U.$$('#sgtab .tab', root).forEach(function (x) { x.classList.remove('on'); });
          t.classList.add('on');
          var m = t.dataset.m;
          $('#sgcreate').hidden = m !== 'create';
          $('#sginsert').hidden = m !== 'insert';
        };
      });
      var TYPES = D.sqlTypes;
      var defCols = [
        { n: 'id', t: 'BIGINT', len: '', nn: true, ai: true, pk: true, d: '', c: '主键ID' },
        { n: 'username', t: 'VARCHAR', len: '64', nn: true, ai: false, pk: false, d: '', c: '用户名' },
        { n: 'dept_id', t: 'INT', len: '', nn: false, ai: false, pk: false, d: '0', c: '部门ID' },
        { n: 'status', t: 'TINYINT', len: '', nn: true, ai: false, pk: false, d: '1', c: '状态 1启用 0禁用' },
        { n: 'create_time', t: 'DATETIME', len: '', nn: true, ai: false, pk: false, d: 'CURRENT_TIMESTAMP', c: '创建时间' }
      ];
      var renderCols = function () {
        $('#gcols').innerHTML = defCols.map(function (c, i) {
          return '<div class="dyn-row" data-i="' + i + '">' +
            '<input type="text" class="f-n" value="' + U.esc(c.n) + '" placeholder="字段名" style="max-width:120px">' +
            '<select class="f-t">' + TYPES.map(function (t) { return '<option' + (t === c.t ? ' selected' : '') + '>' + t + '</option>'; }).join('') + '</select>' +
            '<input type="text" class="f-l" value="' + U.esc(c.len) + '" placeholder="长度" style="max-width:70px">' +
            '<label class="chk" style="margin:0"><input type="checkbox" class="f-nn"' + (c.nn ? ' checked' : '') + '>非空</label>' +
            '<label class="chk" style="margin:0"><input type="checkbox" class="f-ai"' + (c.ai ? ' checked' : '') + '>自增</label>' +
            '<label class="chk" style="margin:0"><input type="checkbox" class="f-pk"' + (c.pk ? ' checked' : '') + '>主键</label>' +
            '<input type="text" class="f-d" value="' + U.esc(c.d) + '" placeholder="默认值" style="max-width:100px">' +
            '<input type="text" class="f-c" value="' + U.esc(c.c) + '" placeholder="注释" style="min-width:120px">' +
            '<button class="del" title="删除">✕</button></div>';
        }).join('');
        U.$$('#gcols .del', root).forEach(function (b) {
          b.onclick = function () {
            if (defCols.length <= 1) { U.toast('至少保留一个字段', 'err'); return; }
            defCols.splice(Number(b.parentNode.dataset.i), 1); renderCols();
          };
        });
      };
      var sync = function () {
        U.$$('#gcols .dyn-row', root).forEach(function (r, i) {
          if (!defCols[i]) return;
          defCols[i].n = r.querySelector('.f-n').value.trim();
          defCols[i].t = r.querySelector('.f-t').value;
          defCols[i].len = r.querySelector('.f-l').value.trim();
          defCols[i].nn = r.querySelector('.f-nn').checked;
          defCols[i].ai = r.querySelector('.f-ai').checked;
          defCols[i].pk = r.querySelector('.f-pk').checked;
          defCols[i].d = r.querySelector('.f-d').value.trim();
          defCols[i].c = r.querySelector('.f-c').value.trim();
        });
      };
      var gen = function () {
        sync();
        var t = $('#gt2').value.trim() || 'table';
        var lines = defCols.map(function (c) {
          if (!c.n) return null;
          var type = c.t + (c.len ? '(' + c.len + ')' : (c.t === 'INT' ? '' : ''));
          var s = '  `' + c.n + '` ' + type;
          if (['VARCHAR', 'CHAR', 'TEXT', 'LONGTEXT'].indexOf(c.t) < 0) {
            if (c.t === 'INT' || c.t === 'BIGINT' || c.t === 'TINYINT' || c.t === 'SMALLINT') s += ' UNSIGNED';
          }
          if (c.nn || c.pk) s += ' NOT NULL';
          if (c.ai) s += ' AUTO_INCREMENT';
          if (c.d && c.d.toUpperCase() === 'CURRENT_TIMESTAMP') s += ' DEFAULT CURRENT_TIMESTAMP';
          else if (c.d) s += " DEFAULT '" + c.d + "'";
          if (c.c) s += " COMMENT '" + c.c + "'";
          return s;
        }).filter(Boolean);
        var pks = defCols.filter(function (c) { return c.pk; }).map(function (c) { return '`' + c.n + '`'; });
        if (pks.length) lines.push('  PRIMARY KEY (' + pks.join(',') + ')');
        var sql = 'CREATE TABLE `' + t + '` (\n' + lines.join(',\n') +
          '\n) ENGINE=' + $('#ge').value + ' DEFAULT CHARSET=' + $('#gc').value +
          ($('#gcm').value.trim() ? " COMMENT='" + $('#gcm').value.trim() + "'" : '') + ';';
        var extra = '\n\n-- 常用维护语句\n' +
          'ALTER TABLE `' + t + '` ADD COLUMN `new_col` VARCHAR(64) DEFAULT NULL COMMENT \'新字段\';\n' +
          'ALTER TABLE `' + t + '` MODIFY COLUMN `status` TINYINT NOT NULL DEFAULT 1;\n' +
          'CREATE INDEX idx_' + t + '_status ON `' + t + '`(`status`);\n' +
          'DROP TABLE IF EXISTS `' + t + '`;';
        U.setOut('gout2', sql + extra);
      };
      $('#gadd').onclick = function () {
        sync(); defCols.push({ n: 'col_' + defCols.length, t: 'VARCHAR', len: '64', nn: false, ai: false, pk: false, d: '', c: '' }); renderCols();
      };
      $('#greset').onclick = function () { renderCols(); gen(); };
      $('#ggo2').onclick = gen;
      renderCols(); gen();

      // INSERT 生成
      $('#igo2').onclick = function () {
        var t = $('#it').value.trim() || 'table';
        var n = Math.min(500, Math.max(1, Number($('#in2').value) || 1));
        var fields = $('#ifields').value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean)
          .map(function (l) { var p = l.split(/\s+/); return { n: p[0], t: (p[1] || 'varchar').toLowerCase() }; });
        if (!fields.length) { U.toast('请定义字段', 'err'); return; }
        var rand = function (f, i) {
          var base = f.t;
          if (/int/.test(base)) return f.n === 'id' ? i : U.randInt(100);
          if (/date|time/.test(base)) return 'NOW()';
          if (/decimal|float|double/.test(base)) return (U.randInt(10000) / 100).toFixed(2);
          if (/bool/.test(base)) return U.randInt(2);
          return "'" + f.n + "_" + i + "'";
        };
        var rows = [];
        for (var i = 1; i <= n; i++) {
          rows.push('  (' + fields.map(function (f) { return rand(f, i); }).join(', ') + ')');
        }
        var cols = fields.map(function (f) { return '`' + f.n + '`'; }).join(', ');
        var mode = $('#iu').value;
        var head = mode === 'ignore' ? 'INSERT IGNORE INTO' : mode === 'replace' ? 'REPLACE INTO' : 'INSERT INTO';
        var sql = head + ' `' + t + '` (' + cols + ') VALUES\n' + rows.join(',\n');
        if (mode === 'update') {
          var ups = fields.filter(function (f) { return f.n !== 'id'; })
            .map(function (f) { return '`' + f.n + '`=VALUES(`' + f.n + '`)'; }).join(', ');
          sql += '\nON DUPLICATE KEY UPDATE ' + (ups || '`id`=VALUES(`id`)');
        }
        U.setOut('iout2', sql + ';');
      };
      $('#igo2').click();
    }
  });

  /* ---------- 6. 连接字符串生成器 ---------- */
  LB.register({
    id: 'connstr', cat: 'db', icon: '🔌', name: '连接字符串生成器',
    desc: 'MySQL / Redis / PG / Mongo 等连接串与客户端命令',
    kw: '连接字符串 connection string jdbc dsn url redis mysql 生成',
    tpl: function () {
      return '<div class="t-section"><div class="sec-t">参数</div>' +
        '<div class="row tight">' +
        '<div class="field"><label class="field-l">类型</label><select id="kt">' +
        '<option value="mysql">MySQL / MariaDB</option><option value="pg">PostgreSQL</option>' +
        '<option value="redis">Redis</option><option value="mongo">MongoDB</option>' +
        '<option value="mssql">SQL Server</option><option value="oracle">Oracle</option>' +
        '<option value="clickhouse">ClickHouse</option><option value="es">Elasticsearch</option></select></div>' +
        '<div class="field"><label class="field-l">主机</label><input type="text" id="kh" value="192.168.66.58"></div>' +
        '<div class="field"><label class="field-l">端口</label><input type="text" id="kp" value="3306"></div>' +
        '<div class="field"><label class="field-l">用户</label><input type="text" id="ku" value="root"></div>' +
        '<div class="field"><label class="field-l">密码</label><input type="text" id="kw" value="Pass#2026"></div>' +
        '<div class="field"><label class="field-l">库 / 库名 / DB</label><input type="text" id="kd" value="lan_system"></div></div>' +
        '<div class="field mt8"><label class="field-l">额外参数</label><input type="text" id="ke" value="charset=utf8mb4&parseTime=True&loc=Local" placeholder="如 useSSL=false&serverTimezone=Asia/Shanghai"></div>' +
        '<div class="btn-group"><button class="btn btn-pri" id="kgo">生成</button></div></div>' +
        '<div class="t-section"><div class="sec-t">结果</div>' + U.outBlock('kout') + '</div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var DEF = { mysql: 3306, pg: 5432, redis: 6379, mongo: 27017, mssql: 1433, oracle: 1521, clickhouse: 8123, es: 9200 };
      var gen = function () {
        var t = $('#kt').value, h = $('#kh').value.trim(), p = $('#kp').value.trim() || DEF[t],
          u = $('#ku').value.trim(), w = $('#kw').value, d = $('#kd').value.trim(), e = $('#ke').value.trim();
        var q = e ? (e.indexOf('?') === 0 ? e : '?' + e) : '';
        var s = '';
        if (t === 'mysql') {
          s = '-- 命令行\nmysql -h ' + h + ' -P ' + p + ' -u ' + u + ' -p' + (d ? ' ' + d : '') + '\n\n' +
            '-- DSN (Go sql-driver)\n' + u + ':' + w + '@tcp(' + h + ':' + p + ')/' + d + (e ? '?' + e : '') + '\n\n' +
            '-- JDBC\njdbc:mysql://' + h + ':' + p + '/' + d + (e ? '?' + e : '?useSSL=false&serverTimezone=Asia/Shanghai&characterEncoding=utf8') + '\n\n' +
            '-- URL (通用)\nmysql://' + u + ':' + w + '@' + h + ':' + p + '/' + d + q;
        } else if (t === 'pg') {
          s = '-- 命令行\npsql -h ' + h + ' -p ' + p + ' -U ' + u + ' -d ' + d + '\n\n' +
            '-- 环境变量方式（推荐，避免密码泄露在 history）\nPGPASSWORD=' + w + ' psql -h ' + h + ' -p ' + p + ' -U ' + u + ' -d ' + d + '\n\n' +
            '-- URL\npostgres://' + u + ':' + w + '@' + h + ':' + p + '/' + d + (e ? '?' + e.replace(/&/g, '&').replace(/charset[^&]*/, '') : '?sslmode=disable') + '\n\n' +
            '-- JDBC\njdbc:postgresql://' + h + ':' + p + '/' + d;
        } else if (t === 'redis') {
          s = '-- 命令行\nredis-cli -h ' + h + ' -p ' + p + (w ? ' -a ' + w : '') + (d ? ' -n ' + d : '') + '\n\n' +
            '-- URL\nredis://' + (w ? ':' + w + '@' : '') + h + ':' + p + (d ? '/' + d : '') + '\n\n' +
            '-- 集群 / 哨兵\nredis-cli -c -h ' + h + ' -p ' + p + '\nredis-cli -h sentinel-host -p 26379 sentinel get-master-addr-by-name mymaster\n\n' +
            '-- 常用验证\nredis-cli ping\nredis-cli info server | head';
        } else if (t === 'mongo') {
          s = '-- 命令行\nmongosh "mongodb://' + (u ? u + ':' + w + '@' : '') + h + ':' + p + '/' + d + q + '"\n\n' +
            '-- URI\nmongodb://' + (u ? u + ':' + w + '@' : '') + h + ':' + p + '/' + d + (e ? '?' + e : '?authSource=admin');
        } else if (t === 'mssql') {
          s = '-- 命令行\nsqlcmd -S ' + h + ',' + p + ' -U ' + u + ' -P ' + w + ' -d ' + d + '\n\n' +
            '-- JDBC\njdbc:sqlserver://' + h + ':' + p + ';databaseName=' + d + ';user=' + u + ';password=' + w;
        } else if (t === 'oracle') {
          s = '-- 命令行\nsqlplus ' + u + '/' + w + '@//' + h + ':' + p + '/' + d + '\n\n' +
            '-- JDBC\njdbc:oracle:thin:@' + h + ':' + p + ':' + d;
        } else if (t === 'clickhouse') {
          s = '-- 命令行\nclickhouse-client --host ' + h + ' --port ' + p + ' --user ' + u + ' --password ' + w + ' --database ' + d + '\n\n' +
            '-- HTTP 接口\ncurl "http://' + h + ':' + p + '/?user=' + u + '&password=' + w + '" --data-binary "SELECT 1"';
        } else {
          s = '-- curl\ncurl -u ' + u + ':' + w + ' http://' + h + ':' + p + '\n\n' +
            '-- 健康检查\ncurl http://' + h + ':' + p + '/_cluster/health?pretty';
        }
        U.setOut('kout', s);
      };
      $('#kt').onchange = function () { $('#kp').value = DEF[this.value]; gen(); };
      $('#kgo').onclick = gen;
      gen();
    }
  });
})();
