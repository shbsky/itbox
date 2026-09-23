/* ===== PDF → Office 核心库（PDF 表格识别 + xlsx / docx 生成） =====
 *
 * 设计要点：
 *   · 无 DOM 依赖（只复用 U.zipStore），因此可以在 node 里直接单测 —— 表格聚类是本项目
 *     最容易出错的一段逻辑，必须可测。
 *   · 手写 OOXML，不引入 SheetJS / docx 之类的重型库（那些 900KB 起，而我们要的只是
 *     「把二维数组写成表格」，自己写约 200 行就够，且完全可控）。
 *   · .xlsx 与 .docx 本质都是 ZIP + 一堆 XML，正好复用已有的 U.zipStore（store 模式，
 *     OOXML 允许不压缩）。
 *
 * 对外 API（挂在 LB.util.ow）：
 *   ow.rowsFromItems(items, opt)    PDF 文字项 → 行/列网格（列边界可外部覆盖，供 UI 手动调列）
 *   ow.blocksFromItems(items, opt)  PDF 文字项 → Word 块序列（标题 / 段落 / 表格）
 *   ow.buildXlsx(sheets, opt)       → Blob（.xlsx）
 *   ow.buildDocx(blocks, opt)       → Blob（.docx）
 *
 * 「PDF 文字项」由 tools-pdf.js 从 pdf.js getTextContent() 归一化而来：
 *   { x, y, w, h, str, size }        x/y 为 PDF 用户空间坐标（原点左下、y 向上）
 */
(function () {
  'use strict';
  var LB = (typeof window !== 'undefined' && window.LB) || {};
  var U = LB.util || {};
  var OW = {};

  /* ================= 通用小工具 ================= */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c];
    });
  }
  /** 0 → A，25 → Z，26 → AA */
  function colName(i) {
    var s = '', n = i + 1;
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }
  function median(a) {
    if (!a || !a.length) return 0;
    var b = a.slice().sort(function (x, y) { return x - y; });
    var m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  }
  function num(v, dflt) {
    return (typeof v === 'number' && isFinite(v)) ? v : dflt;
  }

  /**
   * 判断一个字符串该不该当「数字」写进 Excel。
   * 当数字写的好处：Excel 里能直接求和/排序（这正是「拿数据去算」的核心诉求）。
   * 但不能乱当，两种情况必须留成文本：
   *   · 前导零 —— 00123 会被吃掉零，工号/电话/编号就废了
   *   · 超 15 位 —— Excel 只有 15 位有效数字，长条码/流水号会变科学计数法
   */
  function asNum(s) {
    var t = String(s == null ? '' : s).trim();
    if (!t) return null;
    var v = t;
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) v = t.replace(/,/g, '');   // 1,234.56
    else if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
    if (/^-?0\d/.test(v)) return null;
    if (v.replace(/[-.]/g, '').length > 15) return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  /* ================= UTF-8 / ZIP ================= */

  var TE = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;

  function u8(str) {
    if (TE) return TE.encode(str);
    // 兜底：手写 UTF-8（含代理对），老环境没有 TextEncoder 时用
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length &&
        str.charCodeAt(i + 1) >= 0xDC00 && str.charCodeAt(i + 1) <= 0xDFFF) {
        var cp = 0x10000 + ((c - 0xD800) << 10) + (str.charCodeAt(++i) - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function zip(files) {
    if (typeof U.zipStore !== 'function') throw new Error('缺少 U.zipStore，无法打包');
    return U.zipStore(files);
  }
  /** 把 {路径: 字符串/字节} 打成 ZIP，用于 xlsx / docx */
  function pack(parts, mime) {
    var files = Object.keys(parts).map(function (p) {
      var v = parts[p];
      return { name: p, data: (v instanceof Uint8Array) ? v : u8(v) };
    });
    var blob = zip(files);
    try { return new Blob([blob], { type: mime }); } catch (e) { return blob; }
  }

  var XMLHEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
  var MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  var MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  /* =====================================================================
   *  一、XLSX 生成器
   * ===================================================================== */

  /** 工作表名合法化：Excel 禁止 []:*?/\ 且最长 31 字符 */
  function sheetName(n, i) {
    var s = String(n || '').replace(/[\[\]:*?\/\\]/g, '_').trim();
    if (!s) s = 'Sheet' + (i + 1);
    return s.length > 31 ? s.slice(0, 31) : s;
  }

  /**
   * @param {Array<{name?:string, rows:Array<Array<string|number>>, headerBold?:boolean, widths?:number[]}>} sheets
   */
  OW.buildXlsx = function (sheets, opt) {
    opt = opt || {};
    if (!sheets || !sheets.length) throw new Error('没有可写入的数据');
    var names = [];

    var sheetXml = sheets.map(function (sh, si) {
      var rows = sh.rows || [];
      var nm = sheetName(sh.name, si);
      // 重名会让 Excel 报「已修复/发现不可读取的内容」，必须去重
      var base = nm, k = 2;
      while (names.indexOf(nm) >= 0) { nm = base.slice(0, 28) + '_' + (k++); }
      names.push(nm);

      var colCount = rows.reduce(function (a, r) { return Math.max(a, r.length); }, 0);

      /* ---- 列宽 ----
         两个来源取较大值：
          · 内容估算（保证文字看得见）—— 注意按「折行后的最长一行」算，
            不能拿整串（含 \n）去算，否则一个多行说明格会把列撑到不合理宽度
          · PDF 真实列宽（sh.colWidths，单位 pt）→ 换算成 Excel 字符宽，
            这样导出后的版面才和原 PDF 接近
         pt → 字符：px = pt×96/72，字符 = px/7  ⇒  pt×0.1905
         下限 8 字符是防「某列被压成一字一行」的硬保险。 */
      var widths = sh.widths;
      if (!widths) {
        var ptW = sh.colWidths || null;
        widths = [];
        for (var c = 0; c < colCount; c++) {
          var mx = 0;
          rows.forEach(function (r) {
            var v = r[c];
            if (v == null) return;
            String(v).split('\n').forEach(function (ln) {
              var w = 0;
              for (var q = 0; q < ln.length; q++) w += (ln.charCodeAt(q) > 0x2E80 ? 2 : 1);
              if (w > mx) mx = w;
            });
          });
          var est = mx * 1.15 + 2;
          if (ptW && ptW[c]) est = Math.max(est, ptW[c] * 0.1905);
          widths.push(Math.min(70, Math.max(8, est)));
        }
      }
      var cols = '';
      if (widths.length) {
        cols = '<cols>' + widths.map(function (w, i) {
          return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' +
            (Math.round(w * 100) / 100) + '" customWidth="1"/>';
        }).join('') + '</cols>';
      }

      /* ---- 合并格：Excel 只在左上角保留值，其余格必须清空，
             否则合并区域里带着重复值 = 脏数据（筛出来会重） ---- */
      var data = rows.map(function (r) { return r.slice(); });
      var merges = sh.merges || null;
      if (merges) {
        merges.forEach(function (m) {
          for (var rr = m.r0; rr <= m.r1; rr++) {
            if (!data[rr]) continue;
            for (var cc = m.c0; cc <= m.c1; cc++) {
              if (rr === m.r0 && cc === m.c0) continue;
              data[rr][cc] = '';
            }
          }
        });
      }

      /* ---- 单元格 ---- */
      var rowHt = sh.rowHeights || null;
      var body = data.map(function (r, ri) {
        var cells = '';
        for (var ci = 0; ci < r.length; ci++) {
          var v = r[ci];
          if (v == null || v === '') continue;                 // 空单元格省略，Excel 视为空
          var ref = colName(ci) + (ri + 1);
          var head = (sh.headerBold !== false && ri === 0);
          var nv = (typeof v === 'number') ? v : asNum(v);
          if (nv !== null) {
            cells += '<c r="' + ref + '"' + (head ? ' s="1"' : '') + '><v>' + nv + '</v></c>';
          } else {
            var s = String(v);
            var sp = (s !== s.trim()) ? ' xml:space="preserve"' : '';
            var st = (s.indexOf('\n') >= 0)
              ? (head ? ' s="3"' : ' s="2"')                     // 含折行 → 用折行样式
              : (head ? ' s="1"' : '');
            cells += '<c r="' + ref + '"' + st + ' t="inlineStr"><is><t' + sp + '>' +
              esc(s) + '</t></is></c>';
          }
        }
        var attr = '';
        var rh = (rowHt && rowHt[ri]) || 0;
        if (rh > 0) attr = ' ht="' + (Math.round(rh * 100) / 100) + '" customHeight="1"';
        return '<row r="' + (ri + 1) + '"' + attr + '>' + cells + '</row>';
      }).join('');

      /* ---- 合并区域声明。在 worksheet 里的位置有约束：
             mergeCells 必须在 sheetData **之后** ---- */
      var mergeXml = '';
      if (merges && merges.length) {
        mergeXml = '<mergeCells count="' + merges.length + '">' +
          merges.map(function (m) {
            return '<mergeCell ref="' + colName(m.c0) + (m.r0 + 1) + ':' +
              colName(m.c1) + (m.r1 + 1) + '"/>';
          }).join('') + '</mergeCells>';
      }

      var lastRef = colCount > 0 && rows.length > 0
        ? colName(colCount - 1) + rows.length : 'A1';
      var freeze = sh.freezeHeader !== false && rows.length > 1
        ? '<sheetViews><sheetView workbookViewId="0">' +
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
        '</sheetView></sheetViews>'
        : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';

      return {
        name: nm,
        xml: XMLHEAD +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<dimension ref="A1:' + lastRef + '"/>' +
          freeze + cols +
          '<sheetData>' + body + '</sheetData>' + mergeXml +
          '</worksheet>'
      };
    });

    /* ---- 组装 ZIP ---- */
    var parts = {};
    parts['[Content_Types].xml'] = XMLHEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheetXml.map(function (s, i) {
        return '<Override PartName="/xl/worksheets/sheet' + (i + 1) +
          '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>';

    parts['_rels/.rels'] = XMLHEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';

    parts['xl/workbook.xml'] = XMLHEAD +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + sheetXml.map(function (s, i) {
        return '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
      }).join('') + '</sheets></workbook>';

    parts['xl/_rels/workbook.xml.rels'] = XMLHEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheetXml.map(function (s, i) {
        return '<Relationship Id="rId' + (i + 1) +
          '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
          'Target="worksheets/sheet' + (i + 1) + '.xml"/>';
      }).join('') +
      '<Relationship Id="rId' + (sheetXml.length + 1) +
      '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';

    // 样式：0 = 正文，1 = 加粗（表头）
    parts['xl/styles.xml'] = XMLHEAD +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2">' +
      '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/>' +
      '<charset val="134"/></font>' +
      '<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/>' +
      '<charset val="134"/></font>' +
      '</fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="4">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      // 2 = 折行：同一格里的折行要真的换行显示，不然只看到第一行
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">' +
      '<alignment vertical="top" wrapText="1"/></xf>' +
      // 3 = 表头加粗 + 折行
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">' +
      '<alignment vertical="top" wrapText="1"/></xf>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';

    sheetXml.forEach(function (s, i) { parts['xl/worksheets/sheet' + (i + 1) + '.xml'] = s.xml; });

    return pack(parts, MIME_XLSX);
  };

  /* =====================================================================
   *  二、DOCX 生成器
   * ===================================================================== */

  var A4_USABLE_TWIPS = 9026;      // A4 宽 11906 twips − 左右各 1440 页边距

  function run(text, opt) {
    opt = opt || {};
    var s = String(text == null ? '' : text);
    if (!s) return '';
    var sp = (s !== s.trim()) ? ' xml:space="preserve"' : '';
    var rpr = '';
    if (opt.bold) rpr += '<w:b/>';
    if (opt.size) rpr += '<w:sz w:val="' + Math.round(opt.size * 2) + '"/>';   // 半磅
    if (rpr) rpr = '<w:rPr>' + rpr + '</w:rPr>';
    return '<w:r>' + rpr + '<w:t' + sp + '>' + esc(s) + '</w:t></w:r>';
  }
  function para(text, opt) {
    opt = opt || {};
    var ppr = '';
    if (opt.style) ppr += '<w:pStyle w:val="' + opt.style + '"/>';
    if (opt.align) ppr += '<w:jc w:val="' + opt.align + '"/>';
    // w:spacing 在 pPr 里只能出现一次，前后距与行距必须合并成一个元素
    var spc = '';
    if (opt.spacing) spc += ' w:before="' + opt.spacing[0] + '" w:after="' + opt.spacing[1] + '"';
    if (opt.line) spc += ' w:line="' + opt.line + '" w:lineRule="auto"';
    if (spc) ppr += '<w:spacing' + spc + '/>';
    if (opt.indent) ppr += '<w:ind w:firstLineChars="200"/>';                 // 首行缩进 2 字符
    if (ppr) ppr = '<w:pPr>' + ppr + '</w:pPr>';
    return '<w:p>' + ppr + run(text, opt) + '</w:p>';
  }

  /**
   * 单元格内容可能含换行（同一格内的折行被拼回一格）→ 每行一个 <w:p>。
   * 直接塞 \n 进 <w:t> 里 Word 会当成空格，折行就丢了。
   */
  function paraLines(text, opt) {
    var s = String(text == null ? '' : text);
    var o = opt || {};
    var tight = { bold: o.bold, spacing: [0, 0], line: 240 };
    if (s.indexOf('\n') < 0) return para(s, tight);
    return s.split('\n').map(function (ln) { return para(ln, tight); }).join('');
  }

  /**
   * @param {Array} blocks
   *   {t:'h', level:1|2|3, text}
   *   {t:'p', text}
   *   {t:'table', rows:[[...]], widths?:number[]}
   */
  OW.buildDocx = function (blocks, opt) {
    opt = opt || {};
    if (!blocks || !blocks.length) throw new Error('没有可写入的内容');

    var body = blocks.map(function (b) {
      if (b.t === 'br') return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      if (b.t === 'h') {
        var lv = Math.min(3, Math.max(1, b.level || 1));
        return para(b.text, { style: 'Heading' + lv, spacing: [lv === 1 ? 240 : 180, 80] });
      }
      if (b.t === 'table') {
        var rows = b.rows || [];
        if (!rows.length) return '';
        var ncol = rows.reduce(function (a, r) { return Math.max(a, r.length); }, 0);
        var widths = b.widths;
        if (!widths || widths.length !== ncol) {
          widths = [];
          for (var i = 0; i < ncol; i++) widths.push(A4_USABLE_TWIPS / ncol);
        }
        var tblGridEl = '<w:tblGrid>' + widths.map(function (w) {
          return '<w:gridCol w:w="' + Math.round(w) + '"/>';
        }).join('') + '</w:tblGrid>';
        var spans = b.spans, heights = b.heights;
        var trs = rows.map(function (r, ri) {
          var tcs = '', c = 0;
          while (c < ncol) {
            var sp = (spans && spans[ri]) ? spans[ri][c] : undefined;
            if (sp === null) { c++; continue; }              // 被合并格覆盖，不产生 tc
            var cs = (sp && sp.cs) || 1;
            if (cs > ncol - c) cs = ncol - c;
            var wsum = 0;
            for (var k = 0; k < cs; k++) wsum += widths[c + k] || 0;
            var vm = (sp && sp.vm) || 'none';
            var bold = (ri === 0 && rows.length > 1);        // 首行当表头加粗
            // tcPr 子元素顺序有约束：tcW → gridSpan → vMerge → shd
            var tcPr = '<w:tcW w:w="' + Math.round(wsum) + '" w:type="dxa"/>';
            if (cs > 1) tcPr += '<w:gridSpan w:val="' + cs + '"/>';
            if (vm === 'restart') tcPr += '<w:vMerge w:val="restart"/>';
            else if (vm === 'cont') tcPr += '<w:vMerge/>';
            if (bold) tcPr += '<w:shd w:val="clear" w:fill="F2F2F2"/>';
            tcs += '<w:tc><w:tcPr>' + tcPr + '</w:tcPr>' +
              paraLines(r[c] == null ? '' : r[c], { bold: bold }) + '</w:tc>';
            c += cs;
          }
          var trPr = '';
          var rh = (heights && heights[ri]) || 0;
          if (rh > 0) {
            trPr = '<w:trPr><w:trHeight w:val="' + Math.round(rh * 20) +
              '" w:hRule="atLeast"/></w:trPr>';          // pt → twips
          }
          return '<w:tr>' + trPr + tcs + '</w:tr>';
        }).join('');
        var tblPr = '<w:tblPr><w:tblW w:w="' + A4_USABLE_TWIPS + '" w:type="dxa"/>' +
          '<w:tblBorders>' +
          '<w:top w:val="single" w:sz="4" w:color="808080"/>' +
          '<w:left w:val="single" w:sz="4" w:color="808080"/>' +
          '<w:bottom w:val="single" w:sz="4" w:color="808080"/>' +
          '<w:right w:val="single" w:sz="4" w:color="808080"/>' +
          '<w:insideH w:val="single" w:sz="4" w:color="A6A6A6"/>' +
          '<w:insideV w:val="single" w:sz="4" w:color="A6A6A6"/>' +
          '</w:tblBorders>' +
          '<w:tblLayout w:type="fixed"/></w:tblPr>';
        return '<w:tbl>' + tblPr + tblGridEl + trs + '</w:tbl>' +
          '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>';   // 表格后补空段，避免两表粘连
      }
      return para(b.text, opt.indent === false ? {} : { indent: true });
    }).join('');

    var parts = {};
    parts['[Content_Types].xml'] = XMLHEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '</Types>';

    parts['_rels/.rels'] = XMLHEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>';

    parts['word/_rels/document.xml.rels'] = XMLHEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';

    /* 中文字体必须显式指定 eastAsia，否则 Word 会用 Calibri 兜底，
       中文走「字体回退」渲染，字号与行距都不受控。 */
    var font = (opt.font || '微软雅黑');
    parts['word/styles.xml'] = XMLHEAD +
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:docDefaults><w:rPrDefault><w:rPr>' +
      '<w:rFonts w:ascii="' + esc(font) + '" w:hAnsi="' + esc(font) +
      '" w:eastAsia="' + esc(font) + '" w:cs="' + esc(font) + '"/>' +
      '<w:sz w:val="21"/><w:szCs w:val="21"/>' +
      '<w:lang w:val="en-US" w:eastAsia="zh-CN"/>' +
      '</w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto"/>' +
      '<w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
      '<w:name w:val="Normal"/><w:qFormat/>' +
      // 字体同时写进 Normal 样式本身：docDefaults 对所有解析器不一定生效
      // （python-docx 读 styles['Normal'].font.name 就是 None），两处都写最稳
      '<w:rPr><w:rFonts w:ascii="' + esc(font) + '" w:hAnsi="' + esc(font) +
      '" w:eastAsia="' + esc(font) + '" w:cs="' + esc(font) + '"/></w:rPr>' +
      '</w:style>' +
      [1, 2, 3].map(function (lv) {
        var sz = [36, 30, 25][lv - 1];                     // 18pt / 15pt / 12.5pt
        return '<w:style w:type="paragraph" w:styleId="Heading' + lv + '">' +
          '<w:name w:val="heading ' + lv + '"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
          '<w:pPr><w:keepNext/><w:outlineLvl w:val="' + (lv - 1) + '"/>' +
          '<w:spacing w:before="240" w:after="80"/><w:jc w:val="left"/></w:pPr>' +
          '<w:rPr><w:b/><w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/></w:rPr>' +
          '</w:style>';
      }).join('') +
      '</w:styles>';

    parts['word/document.xml'] = XMLHEAD +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' + body +
      '<w:sectPr>' +
      '<w:pgSz w:w="11906" w:h="16838"/>' +                            // A4 纵向
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" ' +
      'w:header="851" w:footer="992" w:gutter="0"/>' +
      '</w:sectPr>' +
      '</w:body></w:document>';

    return pack(parts, MIME_DOCX);
  };

  /* =====================================================================
   *  三、PDF 文字项 → 结构化网格
   * ===================================================================== */

  /** 把 pdf.js 的 textContent.items 归一化成我们自己的格式 */
  OW.normalize = function (rawItems) {
    var out = [];
    (rawItems || []).forEach(function (it) {
      var s = it && it.str;
      if (!s || !s.trim()) return;                    // 纯空白（含全角空格）丢掉
      var tr = it.transform || [];
      var h = Math.abs(tr[3] || it.height || 10);
      if (h < 0.6) h = it.height || 10;
      out.push({
        str: String(s),
        x: tr[4] || 0,
        y: tr[5] || 0,
        w: Math.abs(it.width || 0) || (String(s).length * h * 0.5),
        h: h,
        size: h
      });
    });
    return out;
  };

  /** 按 y 聚成行（PDF 坐标 y 向上，故降序 = 视觉从上到下） */
  OW.groupRows = function (items, rowTol) {
    if (!items.length) return [];
    var tol = num(rowTol, Math.max(2, median(items.map(function (i) { return i.h; })) * 0.55));
    var sorted = items.slice().sort(function (a, b) { return b.y - a.y || a.x - b.x; });
    var rows = [], cur = null;
    sorted.forEach(function (it) {
      if (cur && Math.abs(cur.y - it.y) <= tol) {
        cur.items.push(it);
        // 用中位数维持行基准 y，避免被个别偏移的字带跑
        cur.y = median(cur.items.map(function (i) { return i.y; }));
        cur.h = Math.max(cur.h, it.h);
      } else {
        cur = { y: it.y, h: it.h, items: [it] };
        rows.push(cur);
      }
    });
    rows.forEach(function (r) {
      r.items.sort(function (a, b) { return a.x - b.x; });
    });
    return rows;
  };

  /**
   * 推导列边界。
   *
   * 思路：用「覆盖计数谷底」而不是「左边缘聚类」。
   *   · 左边缘聚类对右对齐的数字列（金额、数量）会失效 —— 它们的左边缘参差不齐。
   *   · 改成统计每个 x 位置被多少个文字项覆盖：真正的列间空隙几乎没人覆盖，形成谷底；
   *     即使有个别长文本跨过空隙，也只是把该处计数抬高 1，谷底依然存在。
   */
  OW.detectBands = function (rows, opt) {
    opt = opt || {};
    var items = [];
    var minX = Infinity, maxX = -Infinity;
    rows.forEach(function (r) {
      r.items.forEach(function (it) {
        items.push(it);
        if (it.x < minX) minX = it.x;
        if (it.x + it.w > maxX) maxX = it.x + it.w;
      });
    });
    if (!items.length || !(maxX > minX)) return [];

    var BIN = 1;                                       // 1pt 一格
    var n = Math.max(2, Math.ceil((maxX - minX) / BIN) + 1);
    var cov = new Array(n);
    for (var i = 0; i < n; i++) cov[i] = 0;
    items.forEach(function (it) {
      var a = Math.floor((it.x - minX) / BIN);
      var b = Math.ceil((it.x + it.w - minX) / BIN) - 1;
      if (a < 0) a = 0;
      if (b > n - 1) b = n - 1;
      if (b < a) b = a;
      for (var k = a; k <= b; k++) cov[k]++;
    });

    /* 平滑，抑制个别超长文本造成的毛刺 */
    var sm = cov.map(function (_, idx) {
      var s = 0, c = 0;
      for (var k = idx - 1; k <= idx + 1; k++) if (k >= 0 && k < n) { s += cov[k]; c++; }
      return s / c;
    });

    var mx = 0;
    for (var j = 0; j < n; j++) if (sm[j] > mx) mx = sm[j];
    var TH = Math.max(1, mx * num(opt.valleyRatio, 0.14));

    /* 找连续低覆盖段 = 可切的空隙 */
    var gaps = [], run = -1;
    for (var q = 0; q <= n; q++) {
      var low = (q < n) && sm[q] <= TH;
      if (low && run < 0) run = q;
      if (!low && run >= 0) {
        gaps.push({
          midPt: minX + (run + q) / 2 * BIN,
          wPt: (q - run) * BIN,
          aPt: minX + run * BIN,
          bPt: minX + q * BIN
        });
        run = -1;
      }
    }

    /* 空隙太小的不切。这个门檻是量出来的，不是拍的：
       实测同一份 25 页合同 —— 有框线的真表格，栏间空隙宽 10~79pt；
       纯文字页（两端对齐的条文）只有 0~3pt。
       门檻取 8pt 就能把「纯文字页被误判成表格」全部挡掉，
       而真正的无框线表格（栏间总会留出约一个字的间隔）依然切得出来。
       另外这个门檻也顺手保住了「一个字不被切成两半」。 */
    var minGap = num(opt.minGap, 8);
    var minCol = num(opt.minColW, 10);                 // 切出来的列至少这么宽
    var cuts = [];
    gaps.forEach(function (g) {
      if (g.wPt < minGap) return;
      if (cuts.length && g.midPt - cuts[cuts.length - 1] < minCol) return;
      if (maxX - g.midPt < minCol) return;             // 最后一段太窄
      if (g.midPt - minX < minCol) return;             // 第一段太窄
      cuts.push(g.midPt);
    });

    var maxCols = num(opt.maxCols, 60);
    if (cuts.length > maxCols) {                        // 异常分裂时保留最宽的几个空隙
      cuts = gaps.filter(function (g) { return g.wPt >= minGap; })
        .sort(function (a, b) { return b.wPt - a.wPt; })
        .slice(0, maxCols).map(function (g) { return g.midPt; })
        .sort(function (a, b) { return a - b; });
    }

    var bounds = [minX].concat(cuts, [maxX]);
    var bands = [];
    for (var b2 = 0; b2 < bounds.length - 1; b2++) {
      bands.push({ x0: bounds[b2], x1: bounds[b2 + 1] });
    }
    return bands;
  };

  /* =====================================================================
   *  「真实框线」格线识别
   *  ---------------------------------------------------------------------
   *  为什么需要：detectBands() 只能靠「文字覆盖率的谷底」猜列边界，而 PDF 表格
   *  其实画了真实矢量框线。用真框线之后，格子是「算出来的」而不是「猜出来的」：
   *    · 栏列位置精确对齐（实测：一份 4 栏采购表精确切出 4 栏，栏宽分毫不差）
   *    · 合并单元格可准确判定（两列之间没有竖线 = 横向合并格）
   *    · 单元格内的折行自动归到同一格 —— 格内没有分割线就是一个 row band，
   *      不再需要「留空就继承上方」这种启发式，也就不会把整列填满
   *  没有框线的表格自动退回 detectBands()，行为不变。
   * ===================================================================== */

  /** 中日韩表意文字（判断「字间距是拉开的字距还是真的分隔」用） */
  var CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

  /**
   * 在中文 PDF 裡同樣占「一個全角」的符號：方框 □■、圓點 ●○、帶圈數字 ①…、
   * 以及製表符 ─│┌ 等。它們不在 CJK 的碼位範圍裡，但宋體一樣給 1em 寬。
   * 不特別處理的話，勾選框 □ 會被算成 0.5em 而排成半角、還會被送去拉丁字體
   * 渲染成一個小方塊（實測對比圖裡就看得出來）。
   */
  var WIDE = /[\u2460-\u27BF\u2E80-\u2FFF]/;

  /**
   * Times New Roman（Times-Roman AFM）ASCII 字宽表，单位 1/1000 em。
   *
   * 为什么非要有这张表：还原「PDF 把字压扁了」时的补偿量是
   *   w:spacing =（PDF 真实宽度 − 自然宽度）/ 字数
   * 自然宽度估不准，补偿就是错的。实测用「西文一律 0.5em」估算时，
   * 大写字母与标点密集的一格（如「廠AQL（Cr:0.4, Ma:0.4, Mi:0.65）,」）
   * 低估了 40pt，那一行就冲出页面右缘折行 —— 折出来的行盒会把整页后面的
   * 行往下推一个行高（p6/p18 就是这么坏的）。宋体的汉字与全角标点是正好 1em。
   */
  var LATW = (function () {
    var t = {}, w = [250, 333, 408, 500, 500, 833, 778, 180, 333, 333,
      500, 564, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500,
      500, 500, 278, 278, 564, 564, 564, 444, 921, 722, 667, 667, 722, 611,
      556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556,
      611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500, 333, 444,
      500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
      500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480,
      541];
    for (var i = 0; i < w.length; i++) t[32 + i] = w[i];
    return t;
  })();

  /** 单个字符在指定字号下的自然推进量（pt） */
  function advOf(ch, size) {
    if (CJK.test(ch) || WIDE.test(ch)) return size;   // 宋体汉字 / 全角标点 / 方框 = 1em
    var c = ch.charCodeAt(0);
    if (c === 9 || c === 10 || c === 13) return 0;
    if (c === 32) return size * 0.25;
    var u = LATW[c];
    return size * (u == null ? 0.5 : u / 1000);
  }

  /**
   * 固定行高（w:lineRule="exact"，行盒高 L）時，該段首行基線距行盒頂的係數。
   *
   * KB 是個**跨渲染器不一致**的常數，所以取中間值當保險：
   *   · LibreOffice 對 w:lineRule="exact" 固定用 0.80
   *     （實測 L = 200/240/268/360/480tw 全部量到 0.8000，與字號無關）
   *   · Word 用字體的 ascent 比例；宋體的 hhea / OS/2 都是 220/256 = 0.8594
   *     （用 fontTools 讀 C:\Windows\Fonts\simsun.ttc 確認，兩套度量一致）
   * 取 0.83 → 兩邊各有約 0.03·L 的偏差（12pt 字約 0.37pt = 0.13mm），
   * 而不是押錯邊就吃滿 0.06·L。無論押哪邊，誤差都是**每行獨立、不累積**的：
   * B 每次都由絕對目標反算，不是一路加下去。
   */
  var KB = 0.83;

  /**
   * 中文 PDF 常見「橫向壓縮」（Tz）排版：字寬被壓到 0.9em 左右。
   * 不還原的話轉出來的字會比原件寬一截（實測 92.6pt 變成 105pt）。
   * 用字距 w:spacing 把每字的推進量拉回 PDF 的真實值。
   *
   * @param pdfW  這一格在 PDF 裡的真實寬度（pt）
   * @param limit 這一格左緣到「文字區右緣」還剩多少 pt（見下方折行說明）
   * @returns 每字要加/減的 twips（限幅 ±3pt，避免把異常值放大）
   */
  function spacingOf(text, size, pdfW, limit) {
    var n = text.length;
    if (!n) return 0;
    var nat = 0;
    for (var i = 0; i < n; i++) nat += advOf(text.charAt(i), size);
    var sp = (pdfW - nat) / n;
    /* 折行是版面復刻最致命的失敗：某一行若剛好排到右緣（表格最後一格常見，
     * 實測 p6 只超出 0.02pt），Word 判定放不下就折行，多出來的行盒會把這一頁
     * 後面的行整批往下推一個行高（12~13pt），版面就崩了。寧可把字距再收一點。 */
    if (limit != null && nat + sp * n > limit) sp = (limit - nat) / n;
    return Math.max(-60, Math.min(20, Math.round(sp * 20)));
  }

  /**
   * 去掉「逐字拉开」造成的字间空格（实测：貴 司 已 通 過 的 相 關 …）。
   *
   * 判据：一个字 + 一个空格、再一个字 + 一个空格……出现 3 次以上，就是排版拉开的字距。
   * 只出现 1~2 次的不动 —— 那更可能是「資料名稱 填寫說明」这种两段文字的真实分隔。
   * 注意「流程 之」这种**PDF 原文本身就带空格**的不在清理范围（那属于忠实还原）。
   */
  function unspace(t) {
    if (!t || t.length < 5 || t.indexOf(' ') < 0) return t;
    var m = t.match(/[\u2E80-\u9FFF]\s(?=[\u2E80-\u9FFF])/g);
    if (m && m.length >= 3) {
      return t.replace(/([\u2E80-\u9FFF])[ \t]+(?=[\u2E80-\u9FFF])/g, '$1');
    }
    return t;
  }

  /** 3x2 矩阵相乘（语义同 canvas ctx.transform：CTM = CTM × M） */
  function mulM(m, n) {
    return [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
    ];
  }

  /**
   * 从 pdf.js 的 operator list 里取出所有「画出来的横 / 竖直线段」。
   * OPS 由调用方传入（不依赖 pdf.js 全局），保持纯函数，可在 node 里单测。
   *
   * 三个关键点：
   *  1. constructPath 的 args = [子算子数组, 扁平坐标数组, minMax]。
   *     **只用前两个**。第三个 minMax 是「四个数排序后」的结果，不是
   *     [minX, minY, maxX, maxY]，误用会得到错误包围盒。
   *  2. 坐标必须逐点过 CTM（`cm` 变换），并跟踪 save / restore 与
   *     Form XObject 的作用范围，否则嵌套内容里的线位置全错。
   *  3. 框线不一定是「描边」——Excel 导出的 PDF 常用「填充的细长矩形」画线，
   *     所以 stroke / fill / fillStroke 都要收。
   *
   * @returns { h:[{y,x0,x1}], v:[{x,y0,y1}] }  线段为 PDF 用户坐标（y 向上）
   */
  OW.rulesFromOps = function (ol, OPS, opt) {
    opt = opt || {};
    var out = { h: [], v: [] };
    if (!ol || !ol.fnArray || !OPS) return out;
    var fn = ol.fnArray, ar = ol.argsArray;
    var minLen = num(opt.minLen, 6);
    var ctm = [1, 0, 0, 1, 0, 0], stack = [], segs = [];

    function apply(x, y) {
      return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
    }
    function pushSeg(x1, y1, x2, y2) {
      var a = apply(x1, y1), b = apply(x2, y2);
      segs.push([a[0], a[1], b[0], b[1]]);
    }
    function parsePath(a) {
      if (!a) return;
      var ops = a[0], co = a[1];
      if (!ops || !co) return;
      var ci = 0, x = 0, y = 0, sx = 0, sy = 0, k, op, nx, ny;
      for (k = 0; k < ops.length; k++) {
        op = ops[k];
        if (op === OPS.moveTo) { x = co[ci++]; y = co[ci++]; sx = x; sy = y; }
        else if (op === OPS.lineTo) { nx = co[ci++]; ny = co[ci++]; pushSeg(x, y, nx, ny); x = nx; y = ny; }
        else if (op === OPS.curveTo) { x = co[ci + 4]; y = co[ci + 5]; ci += 6; }
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) { x = co[ci + 2]; y = co[ci + 3]; ci += 4; }
        else if (op === OPS.closePath) { pushSeg(x, y, sx, sy); x = sx; y = sy; }
        else if (op === OPS.rectangle) {
          var rx = co[ci++], ry = co[ci++], rw = co[ci++], rh = co[ci++];
          pushSeg(rx, ry, rx + rw, ry);
          pushSeg(rx + rw, ry, rx + rw, ry + rh);
          pushSeg(rx + rw, ry + rh, rx, ry + rh);
          pushSeg(rx, ry + rh, rx, ry);
        }
      }
    }
    function flush() {
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        var dx = Math.abs(s[2] - s[0]), dy = Math.abs(s[3] - s[1]);
        // 只认水平 / 垂直段；斜线与曲线一律丢弃（表格框线不会是斜的）
        if (dx >= minLen && dy <= Math.max(0.8, dx * 0.01)) {
          out.h.push({ y: (s[1] + s[3]) / 2, x0: Math.min(s[0], s[2]), x1: Math.max(s[0], s[2]) });
        } else if (dy >= minLen && dx <= Math.max(0.8, dy * 0.01)) {
          out.v.push({ x: (s[0] + s[2]) / 2, y0: Math.min(s[1], s[3]), y1: Math.max(s[1], s[3]) });
        }
      }
      segs = [];
    }

    for (var i = 0; i < fn.length; i++) {
      var f = fn[i], a = ar[i];
      if (f === OPS.save) { stack.push(ctm.slice()); continue; }
      if (f === OPS.restore) { ctm = stack.pop() || ctm; continue; }
      if (f === OPS.transform) { if (a && a.length === 6) ctm = mulM(ctm, a); continue; }
      if (f === OPS.paintFormXObjectBegin) {
        stack.push(ctm.slice());
        if (a && a[0]) ctm = mulM(ctm, a[0]);
        continue;
      }
      if (f === OPS.paintFormXObjectEnd) { ctm = stack.pop() || ctm; continue; }
      if (f === OPS.constructPath) { parsePath(a); continue; }
      if (f === OPS.stroke || f === OPS.fill || f === OPS.eoFill ||
        f === OPS.fillStroke || f === OPS.eoFillStroke) { flush(); continue; }
      if (f === OPS.endPath) { segs = []; continue; }
    }
    return out;
  };

  /** 把「同一位置」的线段聚成一条，并合并其上的多个区间（一条框线常被切成好几段） */
  function mergeRun(list, posKey, aKey, bKey, tol) {
    if (!list.length) return [];
    var sorted = list.slice().sort(function (p, q) { return p[posKey] - q[posKey]; });
    var groups = [], cur = null;
    sorted.forEach(function (s) {
      // 用「组内第一条」当基准比较，别用平均值 —— 否则长串会缓慢漂移
      if (cur && Math.abs(s[posKey] - cur.p0) <= tol) { cur.sum += s[posKey]; cur.n++; cur.items.push(s); }
      else { cur = { p0: s[posKey], sum: s[posKey], n: 1, items: [s] }; groups.push(cur); }
    });
    var out = [];
    groups.forEach(function (g) {
      var pos = g.sum / g.n;
      var iv = g.items.map(function (s) { return [s[aKey], s[bKey]]; })
        .sort(function (p, q) { return p[0] - q[0]; });
      var merged = [];
      iv.forEach(function (r) {
        var last = merged[merged.length - 1];
        if (last && r[0] <= last[1] + 2) last[1] = Math.max(last[1], r[1]);
        else merged.push([r[0], r[1]]);
      });
      merged.forEach(function (m) {
        var o = {};
        o[posKey] = pos; o[aKey] = m[0]; o[bKey] = m[1];
        out.push(o);
      });
    });
    return out;
  }

  /** 数值数组按容差去重（返回各簇的平均值） */
  function uniqNums(nums, tol) {
    var s = nums.slice().sort(function (a, b) { return a - b; });
    var out = [], cur = null;
    s.forEach(function (v) {
      if (cur && Math.abs(v - cur.p0) <= tol) { cur.sum += v; cur.n++; }
      else { cur = { p0: v, sum: v, n: 1 }; out.push(cur); }
    });
    return out.map(function (c) { return c.sum / c.n; });
  }

  /**
   * 用真实框线把文字归位成网格。
   *
   * 算法：
   *  1. 合并共线线段 → 得到唯一的一组 x（栏边界）与 y（列边界）
   *  2. 横竖线互相过滤：横线要落在竖线的纵向范围内，反之亦然
   *     —— 这一步把页脚横线、标题下划线这类「不属于表格」的线排掉
   *  3. 从 (0,0) 起扫，向右扩到「遇到竖线」为止、向下扩到「整段横向范围遇到横线」为止，
   *     得到真实单元格（含横向 / 纵向跨格）
   *  4. 文字按「左边缘 x + 基线 y」落格；同一格内的多条视觉行就是折行，
   *     用换行拼回同一格（不再拆成多行）
   *  5. 表格外的文字（标题、页脚）各成一行，标记 inTable:false
   *
   * @returns null 表示框线不足、不可用（调用方会退回 detectBands）
   */
  OW.gridFromRules = function (items, rules, opt) {
    opt = opt || {};
    if (!rules || !rules.h || !rules.v) return null;
    var tolP = num(opt.ruleTol, 2.5);

    var H = mergeRun(rules.h, 'y', 'x0', 'x1', tolP);
    var V = mergeRun(rules.v, 'x', 'y0', 'y1', tolP);
    if (H.length < 2 || V.length < 2) return null;

    /* 互相过滤：把不属于表格的线排掉 */
    var vy0 = Infinity, vy1 = -Infinity, hx0 = Infinity, hx1 = -Infinity, i;
    for (i = 0; i < V.length; i++) { if (V[i].y0 < vy0) vy0 = V[i].y0; if (V[i].y1 > vy1) vy1 = V[i].y1; }
    for (i = 0; i < H.length; i++) { if (H[i].x0 < hx0) hx0 = H[i].x0; if (H[i].x1 > hx1) hx1 = H[i].x1; }
    if (!isFinite(vy0) || !isFinite(hx0)) return null;
    H = H.filter(function (l) { return l.y >= vy0 - tolP && l.y <= vy1 + tolP; });
    V = V.filter(function (l) { return l.x >= hx0 - tolP && l.x <= hx1 + tolP; });
    if (H.length < 2 || V.length < 2) return null;

    /* 唯一栏 / 列边界。y 向上 → 降序 = 视觉从上到下 */
    var xs = uniqNums(V.map(function (l) { return l.x; }), tolP);
    var ys = uniqNums(H.map(function (l) { return l.y; }), tolP).sort(function (a, b) { return b - a; });
    if (xs.length < 3 || ys.length < 3) return null;            // 至少要 2 栏 × 2 列才算表格
    var nC = xs.length - 1, nR = ys.length - 1;
    if (nC > num(opt.maxCols, 60) || nR > num(opt.maxRows, 5000)) return null;

    /** 某条竖线是否贯穿这段 y 范围 */
    function hasV(yTop, yBot, x) {
      for (var k = 0; k < V.length; k++) {
        if (Math.abs(V[k].x - x) <= tolP && V[k].y0 <= yBot + tolP && V[k].y1 >= yTop - tolP) return true;
      }
      return false;
    }
    /** 某条横线是否贯穿这段 x 范围 */
    function hasH(xL, xR, y) {
      for (var k = 0; k < H.length; k++) {
        if (Math.abs(H[k].y - y) <= tolP && H[k].x0 <= xL + tolP && H[k].x1 >= xR - tolP) return true;
      }
      return false;
    }

    /* ---- 真实单元格：向右扩到遇竖线、向下扩到整段遇横线 ---- */
    var owner = [], cells = [], r0, c0;
    for (r0 = 0; r0 < nR; r0++) {
      var ln = new Array(nC);
      for (c0 = 0; c0 < nC; c0++) ln[c0] = null;
      owner.push(ln);
    }
    for (r0 = 0; r0 < nR; r0++) {
      for (c0 = 0; c0 < nC; c0++) {
        if (owner[r0][c0]) continue;
        var cs = 1;
        while (c0 + cs < nC && !hasV(ys[r0], ys[r0 + 1], xs[c0 + cs])) cs++;
        var rs = 1;
        while (r0 + rs < nR) {
          var okAll = true;
          for (var k2 = 0; k2 < cs; k2++) {
            if (hasH(xs[c0 + k2], xs[c0 + k2 + 1], ys[r0 + rs])) { okAll = false; break; }
          }
          if (!okAll) break;
          rs++;
        }
        var cell = { ri: r0, ci: c0, rs: rs, cs: cs, texts: [], text: '' };
        cells.push(cell);
        for (var a2 = r0; a2 < r0 + rs; a2++) {
          for (var b2 = c0; b2 < c0 + cs; b2++) owner[a2][b2] = cell;
        }
      }
    }

    /* ---- 文字落格 ---- */
    function rowAt(y) {
      for (var k = 0; k < nR; k++) { if (y > ys[k + 1]) return k; }
      return nR - 1;
    }
    function colAt(x) {
      for (var k = 0; k < nC; k++) { if (x < xs[k + 1]) return k; }
      return nC - 1;
    }
    var outside = [], yTop = ys[0], yBot = ys[nR], xR = xs[nC];
    items.forEach(function (it) {
      if (it.y > yTop + tolP || it.y < yBot - tolP || it.x > xR + tolP) { outside.push(it); return; }
      var cell = owner[rowAt(it.y)][colAt(it.x)];
      if (!cell) { outside.push(it); return; }
      cell.texts.push(it);
    });

    /**
     * 一格内的多条视觉行 → 用换行拼回一格。
     * 这就是「同一格内折行不拆成多行」的关键：格子是框线定出来的，折行落在同一格里。
     *
     * 同一视觉行内相邻文字项的间距处理有个坑：
     * PDF 里「两端对齐」的段落会把字距拉开（貴 司 已 通 過…），若一律按
     * 「间距 > 1/4 字号就补空格」会把每个字之间都塞上空格。所以：
     *  · 两端都是中日韩字时阈值放大到 0.85 字号（中文本来字字相接）
     *  · 兜底：若补出来的空格数超过字数的 35%，说明整行都是被拉开的字距，全部撤掉
     */
    function joinTexts(list) {
      if (!list.length) return '';
      var s = list.slice().sort(function (p, q) { return q.y - p.y || p.x - q.x; });
      var lines = [], cur = null;
      s.forEach(function (it) {
        var tol = Math.max(1.5, (it.h || 10) * 0.5);
        if (cur && Math.abs(it.y - cur.y) <= tol) cur.items.push(it);
        else { cur = { y: it.y, items: [it] }; lines.push(cur); }
      });
      return lines.map(function (l) {
        l.items.sort(function (p, q) { return p.x - q.x; });
        var sz0 = l.items.length ? (l.items[0].size || 10) : 10;
        var gaps = [];
        for (var g = 1; g < l.items.length; g++) {
          gaps.push(l.items[g].x - (l.items[g - 1].x + l.items[g - 1].w));
        }
        /* 「字距被排版整体拉开」的判定（实测：貴 司 已 通 過… / 環 安 衛 政 策 / 流程 之）：
           正间隙数 ≥3 且**大小彼此接近** → 是拉开字距，一个空格都不该补。
           真正「一格里有几段文字并排」只会有一个明显大的间隙、其余接近 0，
           所以不会满足「都差不多大」这个条件。 */
        var pos = gaps.filter(function (v) { return v > 0.5; });
        var spread = false;
        if (pos.length >= 3) {
          var mn = Math.min.apply(null, pos), mxg = Math.max.apply(null, pos);
          if (mxg - mn < Math.max(1.5, sz0 * 0.35)) spread = true;
        }
        var parts = [], prevCh = '', spaces = 0, chars = 0;
        l.items.forEach(function (it, gi) {
          if (gi > 0 && !spread) {
            var a = prevCh.charAt(prevCh.length - 1), b = it.str.charAt(0);
            var need = (CJK.test(a) && CJK.test(b)) ? 1.2 : 0.25;
            if (gaps[gi - 1] > Math.max(1.2, (it.size || 10) * need)) { parts.push('\u0001'); spaces++; }
          }
          parts.push(it.str);
          prevCh = it.str;
          chars += it.str.length;
        });
        var t = parts.join('');
        if (spaces && chars && spaces > chars * 0.35) t = t.split('\u0001').join('');
        else t = t.split('\u0001').join(' ');
        return unspace(t.replace(/\s+$/, ''));
      }).filter(function (t) { return t.trim(); }).join('\n');
    }
    cells.forEach(function (c) { c.text = joinTexts(c.texts); });

    /* ---- 组装输出：表格外文字各成一行（标记 inTable:false） ---- */
    var fill = opt.mergeFill !== false, filledCells = 0;
    var tblGrid = [], ri, ci;
    for (ri = 0; ri < nR; ri++) {
      var l2 = [];
      for (ci = 0; ci < nC; ci++) l2.push('');
      tblGrid.push(l2);
    }
    cells.forEach(function (c) {
      if (!c.text) return;
      for (var a3 = 0; a3 < c.rs; a3++) {
        for (var b3 = 0; b3 < c.cs; b3++) {
          if (a3 > 0 && !fill) continue;            // 纵向按开关；横向跨列一定填
          tblGrid[c.ri + a3][c.ci + b3] = c.text;
          if (a3 > 0 || b3 > 0) filledCells++;
        }
      }
    });

    /** 表格外的文字按视觉行分组，每行输出成一行（放到第 1 栏） */
    function outLines(list) {
      var s = list.slice().sort(function (p, q) { return q.y - p.y || p.x - q.x; });
      var out = [], cur = null;
      s.forEach(function (it) {
        var tol = Math.max(2, (it.h || 10) * 0.6);
        if (cur && Math.abs(it.y - cur.y) <= tol) cur.items.push(it);
        else { cur = { y: it.y, items: [it] }; out.push(cur); }
      });
      out.forEach(function (l) { l.items.sort(function (p, q) { return p.x - q.x; }); });
      return out;
    }
    var above = outLines(outside.filter(function (it) { return it.y > yTop + tolP; }));
    var below = outLines(outside.filter(function (it) { return !(it.y > yTop + tolP); }));

    var grid = [], outRows = [];
    function addLine(l) {
      var l3 = [];
      for (var z = 0; z < nC; z++) l3.push('');
      l3[0] = l.items.map(function (t) { return t.str; }).join('').trim();
      if (!l3[0]) return;
      var cs2 = l.items.map(function (it) {
        return { text: it.str, x0: it.x, x1: it.x + it.w, col: 0, span: 1, size: it.size, vm: 'none' };
      });
      cs2[0].text = l3[0];
      grid.push(l3);
      outRows.push({ y: l.y, h: 0, cells: cs2, inTable: false });
    }
    above.forEach(addLine);

    for (ri = 0; ri < nR; ri++) {
      var cellsOut = [];
      cells.forEach(function (c) {
        if (c.ri !== ri) return;
        var sz = 0;
        if (c.texts.length) {
          sz = median(c.texts.map(function (t) { return t.size || 0; }).filter(function (v) { return v > 0; })) || 0;
        }
        cellsOut.push({
          text: c.text, x0: xs[c.ci], x1: xs[c.ci + c.cs],
          col: c.ci, span: c.cs, rs: c.rs, size: sz, vm: c.rs > 1 ? 'restart' : 'none'
        });
      });
      // 竖向跨格的第 2..n 行：补一个「承接格」，Word 那边要用它画纵向合并
      cells.forEach(function (c) {
        if (c.rs > 1 && ri > c.ri && ri < c.ri + c.rs) {
          cellsOut.push({ text: '', x0: xs[c.ci], x1: xs[c.ci + c.cs], col: c.ci, span: c.cs, size: 0, vm: 'cont' });
        }
      });
      cellsOut.sort(function (p, q) { return p.col - q.col; });
      outRows.push({ y: ys[ri], h: ys[ri] - ys[ri + 1], cells: cellsOut, inTable: true });
      grid.push(tblGrid[ri]);
    }
    below.forEach(addLine);

    var bands = [];
    for (var k3 = 0; k3 < nC; k3++) bands.push({ x0: xs[k3], x1: xs[k3 + 1] });

    return {
      bands: bands,
      rows: outRows,
      grid: grid,
      colCount: nC,
      rowCount: grid.length,
      minX: xs[0],
      maxX: xs[nC],
      filledCells: filledCells,
      byRules: true,
      colLines: xs,
      rowLines: ys,
      // 列高（pt）供 Excel / Word 还原行高，让版面接近原 PDF
      rowHeights: (function () {
        var a4 = [];
        for (var q = 0; q < nR; q++) a4.push(ys[q] - ys[q + 1]);
        return a4;
      })()
    };
  };

  /**
   * 判断入参是「原始 pdf.js 文字项」还是「已归一化项」。
   * pdf.js 给的是 transform/width/height；我们自己的是 x/y/w/h。
   * 加这层防御是因为两者混用时不会报错、只会静默产出全错的结果
   * （x 取到 undefined → 每一条都自己成一行），排查起来很费时间。
   */
  function isRaw(items) {
    if (!items || !items.length) return false;
    var a = items[0];
    return a.transform !== undefined || a.x === undefined;
  }
  function ensure(items) {
    return isRaw(items) ? OW.normalize(items) : (items || []);
  }

  /**
   * 行 × 列 → 二维网格。
   *
   * @param items  文字项（原始 pdf.js 项或已归一化项都可，内部自动识别）
   * @param opt    { bounds?:number[], rowTol?, mergeFill?, edgeTol?, minGap?, minColW? }
   *   bounds 传入时直接用 —— UI 的「手动调列」就是不断改这个数组后重新调用
   * @returns { bands, rows:[{y,h,cells:[{text,x0,x1,span,col}]}], grid, colCount, rowCount }
   */
  OW.rowsFromItems = function (items, opt) {
    opt = opt || {};
    items = ensure(items);

    /* 有真实框线就用框线（格子是算出来的，最准）；但手动拉过列边界时手动优先 */
    if (opt.rules && !(opt.bounds && opt.bounds.length > 1)) {
      var rr = OW.gridFromRules(items, opt.rules, opt);
      if (rr) return rr;
    }

    var rows = OW.groupRows(items, opt.rowTol);
    if (!rows.length) {
      return { bands: [], rows: [], grid: [], colCount: 0, rowCount: 0, minX: 0, maxX: 0 };
    }

    var bands;
    if (opt.bounds && opt.bounds.length > 1) {
      bands = [];
      for (var i = 0; i < opt.bounds.length - 1; i++) {
        bands.push({ x0: opt.bounds[i], x1: opt.bounds[i + 1] });
      }
    } else {
      bands = OW.detectBands(rows, opt);
    }
    if (!bands.length) bands = [{ x0: 0, x1: 1 }];

    var nCol = bands.length;
    var TOL = num(opt.edgeTol, 1.5);
    var mergeFill = opt.mergeFill !== false;           // 默认展开填充

    /** x 落在第几列（越界时夹到首/末列） */
    function bandAt(x) {
      if (x < bands[0].x0) return 0;
      for (var k = 0; k < nCol; k++) {
        if (x < bands[k].x1) return k;
      }
      return nCol - 1;
    }

    /**
     * 定位一个文字项属于哪一列、是否横跨多列。
     *
     * 关键：用「左边缘」定起始列，不能用中心点。
     * 合并格的文字是从合并区左边缘开始排的，中心点会落到中间某列去 ——
     * 实测「员工信息表」横跨 3 列时，按中心点算只填了右边 2 格、第 1 格是空的。
     *
     * 右边缘判「横跨」时要留余量：列边界是「空隙中点」，不是真实格线，
     * 正常格子也可能有一点点溢出（左对齐的长文本越过边界几个点）。
     * 所以要求必须真正「进入」下一列一段距离才算跨列。
     */
    function locate(it) {
      var col = bandAt(it.x + TOL);
      var span = 1;
      for (var m = col + 1; m < nCol; m++) {
        var bw = bands[m].x1 - bands[m].x0;
        var need = Math.max(6, bw * 0.3);              // 进入下一列至少这么多，才算跨列
        if (it.x + it.w >= bands[m].x0 + need) span = m - col + 1;
        else break;
      }
      return { col: col, span: span };
    }

    var outRows = rows.map(function (r) {
      var cells = r.items.map(function (it) {
        var loc = locate(it);
        return { text: it.str, x0: it.x, x1: it.x + it.w, col: loc.col, span: loc.span, size: it.size };
      });
      return { y: r.y, h: r.h, cells: cells };
    });

    /* ---- 组装网格 ---- */
    var grid = outRows.map(function (r) {
      var line = [];
      for (var c = 0; c < nCol; c++) line.push('');
      // 同一列可能有多个文字项（如「12」「.5」被拆开）→ 按 x 顺序拼接
      var byCol = {};
      r.cells.forEach(function (cell) {
        (byCol[cell.col] = byCol[cell.col] || []).push(cell);
      });
      Object.keys(byCol).forEach(function (cStr) {
        var c = Number(cStr);
        var list = byCol[c].sort(function (a, b) { return a.x0 - b.x0; });
        var txt = list.map(function (t) { return t.text; }).join('');
        var span = 1;
        list.forEach(function (t) { span = Math.max(span, t.span); });
        for (var k = 0; k < span && c + k < nCol; k++) line[c + k] = txt;   // 展开填充
      });
      return line;
    });

    /* ---- 纵向合并：某列本行空、上一行有值 → 继承上方（仅无框线时的启发式） ----
       这是「猜」不是「算」，所以刻意保守。有框线时走 gridFromRules，那里只填真合并格。
       曾经太贪心（上限 30 行、不限长度）导致整列被一个残值填满：
       表头那一行右边恰好多出一小段文字，后面 30 行就全被它覆写。 */
    var filled = 0;
    if (mergeFill && grid.length > 1) {
      var maxRun = num(opt.maxFillRun, 8);             // 连续继承上限
      var maxLen = num(opt.maxFillLen, 40);            // 被继承的值太长 → 是正文不是合并格标签
      for (var c2 = 0; c2 < nCol; c2++) {
        var run2 = 0, last = '';
        for (var r2 = 0; r2 < grid.length; r2++) {
          var v = grid[r2][c2];
          if (v) { last = v; run2 = 0; }
          else if (last && run2 < maxRun && last.length <= maxLen) {
            // 只有当本行别处有内容时才继承（整行空白说明是空行，不该填）
            var hasOther = grid[r2].some(function (x, idx) { return idx !== c2 && x; });
            if (hasOther) { grid[r2][c2] = last; run2++; filled++; }
          }
        }
      }
    }

    return {
      bands: bands,
      rows: outRows,
      grid: grid,
      colCount: nCol,
      rowCount: grid.length,
      minX: bands[0].x0,
      maxX: bands[nCol - 1].x1,
      filledCells: filled
    };
  };

  /**
   * 把「框线识别出来的连续表格行」打包成一个 Word 表格块。
   * spans 是「每行 × 每列」的稀疏数组：被合并覆盖的格子为 null，
   * 锚点格带 {cs:横向跨几列, vm:'restart'|'cont'|'none'}。
   */
  function tableBlock(res, a, b) {
    var widths = res.bands.map(function (bd) {
      return (bd.x1 - bd.x0) / (res.maxX - res.minX) * A4_USABLE_TWIPS;
    });
    var spans = [];
    for (var i = a; i < b; i++) {
      var arr = new Array(res.colCount);
      for (var z = 0; z < res.colCount; z++) arr[z] = null;
      (res.rows[i].cells || []).forEach(function (c) {
        if (c.col == null || c.col < 0 || c.col >= res.colCount) return;
        arr[c.col] = { cs: c.span || 1, rs: c.rs || 1, vm: c.vm || 'none' };
      });
      spans.push(arr);
    }
    return {
      t: 'table',
      rows: res.grid.slice(a, b),
      widths: widths,
      spans: spans,
      heights: res.rows.slice(a, b).map(function (r) { return r.h || 0; })
    };
  }

  /**
   * PDF 文字项 → Word 块序列。
   * 每个「行」先当一个段落；行距明显大于常规行距时视为换段。
   * 字号明显大于正文的行视为标题。
   * opt.keepTables 为真且检测到多列时，把连续多列行合并成一张 Word 表格。
   */
  OW.blocksFromItems = function (items, opt) {
    opt = opt || {};
    items = ensure(items);
    var res = OW.rowsFromItems(items, opt);
    if (!res.rows.length) return [];
    var rows = res.rows;
    var isTable = res.colCount >= 2 && opt.keepTables !== false;

    /* 正文基准字号 = 出现最多的字号（用众数，比中位数更抗标题干扰） */
    var freq = {};
    res.grid.forEach(function (line, ri) {
      var sz = Math.round(median(rows[ri].cells.map(function (c) { return c.size; })) * 2) / 2;
      if (sz > 0) freq[sz] = (freq[sz] || 0) + 1;
    });
    var bodySize = 0, best = -1;
    Object.keys(freq).forEach(function (k) {
      if (freq[k] > best || (freq[k] === best && Number(k) < bodySize)) {
        best = freq[k]; bodySize = Number(k);
      }
    });
    if (!bodySize) bodySize = median(items.map(function (i) { return i.size; })) || 10;

    /* 常规行距 = 相邻行基准 y 差的中位数 */
    var gaps = [];
    for (var i = 1; i < rows.length; i++) {
      var d = rows[i - 1].y - rows[i].y;                // y 向上，故相减为正
      if (d > 0.5) gaps.push(d);
    }
    var lineGap = median(gaps) || bodySize * 1.4;
    var splitK = num(opt.splitK, 1.75);                // 超过常规行距这么多倍 → 换段

    var blocks = [];
    var buf = [];
    var useHeadings = opt.headings !== false;
    function flush() {
      var t = buf.join('').trim();
      if (t) blocks.push({ t: 'p', text: t });
      buf = [];
    }

    /* ---- 有真实框线：整块出表，其余走段落/标题 ----
       旧版按「这行有几格有值」猜是不是表格，遇到合并格多的表会把大半张表
       当段落丢掉（实测一份 4 栏采购表被拆成 7 个碎表，还把页脚吸进表里）。
       有了框线就知道哪几行属于表格，直接整块搬，不再猜。 */
    if (res.byRules) {
      var bi = 0;
      while (bi < rows.length) {
        if (rows[bi].inTable) {
          var bj = bi;
          while (bj < rows.length && rows[bj].inTable) bj++;
          flush();
          blocks.push(tableBlock(res, bi, bj));
          bi = bj;
          continue;
        }
        var rr2 = rows[bi];
        var tx = (rr2.cells || []).map(function (c) { return c.text; })
          .filter(function (t) { return t; }).join(' ').trim();
        if (tx) {
          var sz2 = median((rr2.cells || []).map(function (c) { return c.size || 0; })
            .filter(function (v) { return v > 0; })) || bodySize;
          var gp = bi > 0 ? (rows[bi - 1].y - rr2.y) : lineGap;
          if (useHeadings && sz2 >= bodySize * 1.22) {
            flush();
            blocks.push({ t: 'h', level: sz2 >= bodySize * 1.6 ? 1 : 2, text: tx });
          } else {
            if (bi > 0 && gp > lineGap * splitK) flush();
            buf.push(tx);
          }
        }
        bi++;
      }
      flush();
      return blocks;
    }

    /* 表格模式：连续的多列行整块转成一张表 */
    if (isTable) {
      var tRows = [], tBegin = -1;
      function flushTable() {
        if (tRows.length >= 2) {
          blocks.push({ t: 'table', rows: tRows, widths: res.bands.map(function (b) {
            return (b.x1 - b.x0) / (res.maxX - res.minX) * A4_USABLE_TWIPS;
          }) });
        } else if (tRows.length === 1) {
          tRows[0].forEach(function (v) { if (v) blocks.push({ t: 'p', text: v }); });
        }
        tRows = []; tBegin = -1;
      }
      rows.forEach(function (r, ri) {
        var line = res.grid[ri];
        var nonEmpty = line.filter(function (x) { return x; }).length;
        var rowSize = median(r.cells.map(function (c) { return c.size; })) || bodySize;
        var isHeading = useHeadings && rowSize >= bodySize * 1.26;
        var sparse = nonEmpty < 2;                     // 只有一格有值 → 像标题/说明文字
        if (sparse || isHeading) {
          flushTable();
          var txt = line.filter(function (x) { return x; }).join(' ');
          if (!txt) return;
          var g = tBegin >= 0 ? rows[tBegin].y - r.y : 0;
          if (isHeading) {
            flush();
            blocks.push({ t: 'h', level: rowSize >= bodySize * 1.7 ? 1 : 2, text: txt });
          } else {
            var prevGap = gaps.length ? (ri > 0 ? rows[ri - 1].y - r.y : lineGap) : lineGap;
            if (prevGap > lineGap * splitK) flush();
            buf.push(txt);
          }
        } else {
          if (!tRows.length) { flush(); tBegin = ri; }
          tRows.push(line);
        }
      });
      flushTable();
      flush();
    } else {
      rows.forEach(function (r, ri) {
        var line = res.grid[ri].filter(function (x) { return x; }).join(' ');
        if (!line.trim()) { flush(); return; }
        var rowSize = median(r.cells.map(function (c) { return c.size; })) || bodySize;
        var gap = ri > 0 ? (rows[ri - 1].y - r.y) : lineGap;
        if (rowSize >= bodySize * 1.26 && useHeadings) {
          flush();
          blocks.push({ t: 'h', level: rowSize >= bodySize * 1.7 ? 1 : 2, text: line.trim() });
        } else {
          if (ri > 0 && gap > lineGap * splitK) flush();
          buf.push(line.trim());
        }
      });
      flush();
    }

    return blocks;
  };

  /** 页面纯文本（给「这可能是扫描件」的判断用） */
  OW.textOf = function (items) {
    return OW.groupRows(items).map(function (r) {
      return r.items.map(function (i) { return i.str; }).join('');
    }).join('\n');
  };

  /* =====================================================================
   *  4. 版面复刻式 DOCX（「原版版面」模式）
   *  ---------------------------------------------------------------------
   *  buildDocx() 产出的是「流式文档」：表格是真 Word 表格，好编辑、能续写，
   *  但 PDF 本来就没有「段落」概念，重新排版后版面必然走样。
   *  合同 / 表单这类文件，用户要的是「打开跟原件长得一样，能存能印」。
   *
   *  解法（与商业工具 PDFPai 同一路线，已解剖其产物确认）：
   *    · 页面用 PDF 的真实尺寸，页边距 0
   *    · 框线 / 色块 / 印章 → VML <v:group> 绝对定位到页面
   *      （mso-position-*-relative:page，坐标单位改用缇 1pt=20twips）
   *    · 每个「视觉行」→ 一个段落：w:ind 精确左缩进、w:tab 精确定列、
   *      w:spacing lineRule="exact" 精确行高
   *  于是得到「位置精确的流式文字 + 矢量框线」：文字仍可编辑可搜索，
   *  版面却和原件几乎一致。代价是表格不再结构化（不能选整列 / 排序）——
   *  要算数的场景请走 PDF→Excel。
   *
   *  坐标系：PDF 原点左下、y 向上；VML 原点左上、y 向下。
   *  故 yVml = pageH - yPdf。1pt = 20 twips，VML 只吃整数。
   * ===================================================================== */

  function hexByte(v) {
    var s = Math.max(0, Math.min(255, Math.round(v))).toString(16).toUpperCase();
    return s.length < 2 ? '0' + s : s;
  }

  /**
   * pdf.js 的颜色参数 → 'RRGGBB'；认不出返回 null。
   *
   * 两种形态都要认：
   *   · 裸分量 [r,g,b] / [g] / [c,m,y,k]（pdf.js 的 setFillRGBColor 走这个，
   *     实测是 Float32Array，JSON 出来像 {"0":0,"1":0,"2":0}，
   *     所以**不能**把 a[0] 当色彩空间名去比 —— 那会把黑色当成「不认识」）
   *   · 带色名的 ['rgb', r,g,b] / ['g', v] / ['cmyk', c,m,y,k]
   *   · 已成串的 '#000000'
   */
  function colorOf(a) {
    if (!a || !a.length) return null;
    if (typeof a === 'string') return normHex(a);
    var n = a.length, v;
    if (typeof a[0] === 'string') {
      var cs = a[0].replace(/^#/, '');
      if (/^[0-9a-fA-F]{6}$/.test(cs)) return cs.toUpperCase();
      var nm = String(a[0]).toLowerCase();
      if (nm === 'rgb' || nm === 'rgb ') return rgbOut(a[1], a[2], a[3]);
      if (nm === 'g' || nm === 'gray') return rgbOut(a[1], a[1], a[1]);
      if (nm === 'cmyk') {
        return rgbOut(1 - Math.min(1, a[1] + a[4]),
          1 - Math.min(1, a[2] + a[4]), 1 - Math.min(1, a[3] + a[4]));
      }
      return null;
    }
    // 裸分量：实测 pdf.js 一律给 Uint8ClampedArray 且已是 0~255（例：0,112,192 / 255,0,0）
    if (n >= 4) {                                   // cmyk（PDF 算子用 0~1）
      return rgbOut(1 - Math.min(1, a[0] + a[3]),
        1 - Math.min(1, a[1] + a[3]), 1 - Math.min(1, a[2] + a[3]));
    }
    if (n === 3) return rgbOut(a[0] / 255, a[1] / 255, a[2] / 255);
    if (n === 1) return rgbOut(a[0], a[0], a[0]);   // 单分量按 0~1
    return null;
  }
  function normHex(s) {
    var m = String(s).replace(/[^0-9a-fA-F]/g, '');
    if (m.length === 6) return m.toUpperCase();
    if (m.length === 3) return (m[0] + m[0] + m[1] + m[1] + m[2] + m[2]).toUpperCase();
    return null;
  }
  /** 统一按 0~1 的比例转 'RRGGBB' */
  function rgbOut(r, g, b) {
    return hexByte((Number(r) || 0) * 255) +
      hexByte((Number(g) || 0) * 255) +
      hexByte((Number(b) || 0) * 255);
  }

  /**
   * 取出「完整矢量几何」用于 1:1 复刻版面。
   *
   * 与 rulesFromOps 的分工：那个只保留横/竖线段，用来**推断表格网格**；
   * 这个保留全部路径（矩形、折线、曲线、细长色条），用来**照原样画出来**。
   * PDF 里表格线常常是「填充的细长矩形」而不是描边，所以 fill 也要收。
   *
   * @param opt.pageH 页面高（pt），用于把 y 翻成 VML 的「向下为正」
   * @param opt.pageW 页面宽（pt），用于剔除整页白底矩形
   * @returns {Array<{d:string, fill?:string, line?:string, lw?:number}>}
   *          d = VML 路径串（单位缇、已翻 y），已带结尾的 'e'
   */
  OW.pathsFromOps = function (ol, OPS, opt) {
    opt = opt || {};
    var out = [];
    if (!ol || !ol.fnArray || !OPS) return out;
    var pageH = num(opt.pageH, 0), pageW = num(opt.pageW, 0);
    var fn = ol.fnArray, ar = ol.argsArray;
    var ctm = [1, 0, 0, 1, 0, 0], stack = [];
    var fillC = null, strokeC = null, lw = 1;
    var cur = [], bb = null;

    function T(x, y) {
      return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
    }
    /** 转成 VML 坐标（缇、y 向下），顺带累积包围盒 */
    function P(x, y) {
      var p = T(x, y);
      if (!bb) bb = [p[0], p[1], p[0], p[1]];
      else {
        if (p[0] < bb[0]) bb[0] = p[0];
        if (p[1] < bb[1]) bb[1] = p[1];
        if (p[0] > bb[2]) bb[2] = p[0];
        if (p[1] > bb[3]) bb[3] = p[1];
      }
      return Math.round(p[0] * 20) + ',' + Math.round((pageH - p[1]) * 20);
    }
    function dOf(a) {
      var ops = a[0], co = a[1];
      if (!ops || !co) return '';
      var ci = 0, d = '', x = 0, y = 0, sx = 0, sy = 0, k, op, n = ops.length;
      for (k = 0; k < n; k++) {
        op = ops[k];
        if (op === OPS.moveTo) { x = co[ci++]; y = co[ci++]; sx = x; sy = y; d += 'm' + P(x, y) + ' '; }
        else if (op === OPS.lineTo) { x = co[ci++]; y = co[ci++]; d += 'l' + P(x, y) + ' '; }
        else if (op === OPS.curveTo) {
          d += 'c' + P(co[ci], co[ci + 1]) + ' ' + P(co[ci + 2], co[ci + 3]) + ' ' +
            P(co[ci + 4], co[ci + 5]) + ' ';
          x = co[ci + 4]; y = co[ci + 5]; ci += 6;
        } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
          d += 'qb' + P(co[ci], co[ci + 1]) + ' ' + P(co[ci + 2], co[ci + 3]) + ' ';
          x = co[ci + 2]; y = co[ci + 3]; ci += 4;
        } else if (op === OPS.closePath) { d += 'x '; x = sx; y = sy; }
        else if (op === OPS.rectangle) {
          var rx = co[ci++], ry = co[ci++], rw = co[ci++], rh = co[ci++];
          d += 'm' + P(rx, ry) + ' l' + P(rx + rw, ry) + ' ' + P(rx + rw, ry + rh) + ' ' +
            P(rx, ry + rh) + ' x ';
          x = rx; y = ry; sx = rx; sy = ry;
        }
      }
      return d;
    }
    function flush(paint) {
      var d = cur.join(''), box = bb;
      cur = []; bb = null;
      if (!d || !box) return;
      var filled = (paint === 'fill' || paint === 'both');
      var stroked = (paint === 'stroke' || paint === 'both');
      // 整页白底矩形要丢掉，否则会盖住后面所有内容
      if (pageW && pageH && (box[2] - box[0]) > pageW * 0.96 && (box[3] - box[1]) > pageH * 0.96) return;
      if (filled && (!fillC || fillC === 'FFFFFF')) filled = false;   // 白底不画
      if (stroked && !strokeC) stroked = false;
      if (!filled && !stroked) return;
      var o = { d: d + 'e' };
      if (filled) o.fill = fillC;
      if (stroked) { o.line = strokeC; o.lw = lw; }
      out.push(o);
    }

    for (var i = 0; i < fn.length; i++) {
      var f = fn[i], a = ar[i], saved;
      if (f === OPS.save) { stack.push(ctm.slice()); continue; }
      if (f === OPS.restore) { saved = stack.pop(); if (saved) ctm = saved; continue; }
      if (f === OPS.transform) { if (a && a.length === 6) ctm = mulM(ctm, a); continue; }
      if (f === OPS.paintFormXObjectBegin) {
        stack.push(ctm.slice()); if (a && a[0]) ctm = mulM(ctm, a[0]); continue;
      }
      if (f === OPS.paintFormXObjectEnd) { saved = stack.pop(); if (saved) ctm = saved; continue; }
      if (f === OPS.setFillRGBColor || f === OPS.setFillColor || f === OPS.setFillColorN) {
        var fc = colorOf(a); if (fc) fillC = fc; continue;
      }
      if (f === OPS.setStrokeRGBColor || f === OPS.setStrokeColor || f === OPS.setStrokeColorN) {
        var sc = colorOf(a); if (sc) strokeC = sc; continue;
      }
      if (f === OPS.setLineWidth) { lw = num(a && a[0], 1); continue; }
      if (f === OPS.constructPath) { var dd = dOf(a); if (dd) cur.push(dd); continue; }
      if (f === OPS.stroke) { flush('stroke'); continue; }
      if (f === OPS.fill || f === OPS.eoFill) { flush('fill'); continue; }
      if (f === OPS.fillStroke || f === OPS.eoFillStroke) { flush('both'); continue; }
      if (f === OPS.endPath) { cur = []; bb = null; continue; }
    }
    return out;
  };

  /**
   * 取出每张位图在页面上的**摆放框**。
   *
   * PDF 里 paintImageXObject 是把图像画在「单位正方形 [0,1]×[0,1]」上，
   * 再经当前 CTM 变换。所以把 (0,0) 与 (1,1) 两点过 CTM 就得到外框。
   * 注意 CTM 可能含翻转（d<0），故宽高要取绝对值。
   *
   * @returns {Array<{name:string, x:number, y:number, w:number, h:number}>}
   *          x/y 为 PDF 坐标（y 向上），y 是**下边缘**
   */
  OW.imagesFromOps = function (ol, OPS, opt) {
    var out = [];
    if (!ol || !ol.fnArray || !OPS) return out;
    var fn = ol.fnArray, ar = ol.argsArray;
    var ctm = [1, 0, 0, 1, 0, 0], stack = [];
    function T(x, y) {
      return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
    }
    for (var i = 0; i < fn.length; i++) {
      var f = fn[i], a = ar[i], saved;
      if (f === OPS.save) { stack.push(ctm.slice()); continue; }
      if (f === OPS.restore) { saved = stack.pop(); if (saved) ctm = saved; continue; }
      if (f === OPS.transform) { if (a && a.length === 6) ctm = mulM(ctm, a); continue; }
      if (f === OPS.paintFormXObjectBegin) {
        stack.push(ctm.slice()); if (a && a[0]) ctm = mulM(ctm, a[0]); continue;
      }
      if (f === OPS.paintFormXObjectEnd) { saved = stack.pop(); if (saved) ctm = saved; continue; }
      if (f === OPS.paintImageXObject || f === OPS.paintJpegXObject) {
        var p0 = T(0, 0), p1 = T(1, 1);
        out.push({
          name: a && a[0],
          x: Math.min(p0[0], p1[0]), y: Math.min(p0[1], p1[1]),
          w: Math.abs(p1[0] - p0[0]), h: Math.abs(p1[1] - p0[1])
        });
      }
    }
    return out;
  };

  /** base64（可带 data: 前缀）→ Uint8Array。浏览器与 node 都有 atob */
  function b64bin(s) {
    var clean = String(s == null ? '' : s).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (typeof atob === 'function') {
      var bin = atob(clean), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    var buf = Buffer.from(clean, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /**
   * 把一页的文字项排成「视觉行 → 单元格」。
   * 与 rowsFromItems 的区别：这里**不做任何语义推断**（不猜表格、不做纵向继承），
   * 只忠实还原「这行字从 x 多少开始、分了几段、每段在哪」，因为版面复刻要的就是坐标本身。
   */
  function layoutLines(items, opt) {
    opt = opt || {};
    var list = (items || []).filter(function (a) {
      return a && a.str != null && String(a.str).replace(/\s/g, '') !== '';
    });
    if (!list.length) return [];
    list = list.slice().sort(function (a, b) { return b.y - a.y || a.x - b.x; });

    var lines = [], cur = null;
    list.forEach(function (a) {
      /* 同排文字在 PDF 裡幾乎都是**完全同一個基線**（差 0），所以容差不需要寬。
       * 容差太大會把「上下相鄰但較擠的兩行」併成一行 —— 實測 p12 的
       * 「基本帳戶資料」(x=67.8) 與「支行：* 塘廈支行」(x=163.0) 只差 5.3pt，
       * 就被 0.45em 的容差併掉了，兩行被壓到同一個 y。
       * 併錯的代價只是多一個行盒；因為每行的位置都是絕對定位、不靠累加，
       * 不會把後面幾行推走，所以這裡可以放心收緊。 */
      var tol = Math.max(0.8, (a.size || 10) * 0.20);
      if (cur && Math.abs(a.y - cur.base) <= tol) cur.items.push(a);
      else { cur = { base: a.y, items: [a] }; lines.push(cur); }
    });

    var sj = num(opt.sizeJump, 1.35);            // 行内字号突变 → 另起一段（不是同一格）
    lines.forEach(function (l) {
      /* 基线取「本行各片段 y 的中位数」：同排文字正常共享基线，但偶有上下标之类的
       * 离群值，中位数比「第一个片段」稳，位置复刻全靠这个值。 */
      var ys = l.items.map(function (a) { return a.y; })
        .sort(function (a, b) { return a - b; });
      l.base = ys[ys.length >> 1];
      var its = l.items.slice().sort(function (a, b) { return a.x - b.x; });
      var cells = [], c = null;
      its.forEach(function (a) {
        var lim = Math.max(3, (a.size || 10) * 0.55);
        var big = c && a.size > c.size * sj;
        if (c && !big && (a.x - c.end) <= lim) {
          c.text += a.str;
          if (a.x + (a.w || 0) > c.end) c.end = a.x + (a.w || 0);
          if (a.size > c.size) c.size = a.size;
        } else {
          c = { x: a.x, end: a.x + (a.w || 0), text: a.str, size: a.size || 10 };
          cells.push(c);
        }
      });
      cells.forEach(function (k) { k.text = k.text.replace(/\s+$/, ''); });
      var keep = cells.filter(function (k) { return k.text !== ''; });
      l.cells = keep;
      l.x0 = keep.length ? keep[0].x : 0;
      l.size = keep.reduce(function (m, k) { return Math.max(m, k.size); }, 0) || 10;
      l.top = Math.max.apply(null, its.map(function (a) {
        return a.y + (a.size || 10) * 0.88;
      }));
    });

    var out = lines.filter(function (l) { return l.cells.length; });
    for (var i = 0; i < out.length; i++) {
      var nx = out[i + 1];
      out[i].pitch = nx ? Math.max(4, out[i].top - nx.top)
        : (out[i - 1] ? out[i - 1].pitch : out[i].size * 1.45);
    }
    return out;
  }

  /**
   * 正文字号 = 全文出现次数最多的字号。用来判断「这行是不是标题」。
   * 抽成公开函数是为了让预览与导出拿到**同一个**基准 —— 各算各的会出现
   * 同一行在预览里是标题、在 Word 里不是（或反过来）。
   */
  OW.bodySizeOf = function (pages) {
    var hist = {}, best = 0, bn = -1;
    (pages || []).forEach(function (p) {
      (p.items || []).forEach(function (a) {
        var k = Math.round((a.size || 10) * 2) / 2;
        hist[k] = (hist[k] || 0) + 1;
      });
    });
    Object.keys(hist).forEach(function (k) {
      if (hist[k] > bn) { bn = hist[k]; best = parseFloat(k); }
    });
    return best || 10;
  };

  /**
   * 一頁的「版面段落度量」—— 導出與預覽共用同一份結果。
   *
   * 為什麼要抽出來：預覽若自己算一套，只要行高 / 段前距 / 字距差一點，
   * 預覽跟真正的 docx 就會對不上，那預覽就失去意義了。
   *
   * @param items 歸一化文字項（x/y/w/size/str）
   * @param opt   { pageW, pageH, bodySize, boldOnTitle, sizeJump }
   * @param Stw0  進入本頁文字流前**已經吃掉的行盒高度**（twips）。
   *              每頁開頭的圖形段落用 w:line="2" 佔位，所以有圖形傳 2、沒有傳 0。
   * @returns { rows, Stw }
   *   rows[i] = { base, size, szTw, bold, Ltw, Ttw, Btw, tabs, cells }
   *            base = PDF 基線（pt，y 向上）；Ttw = 距頁頂的基線（twips，y 向下）
   *   cells[j] = { x, end, text, size, tab, sp }
   *            tab = 該格的 tab stop 位置（twips，0 = 不發 tab）；sp = w:spacing 字距
   */
  OW.layoutMetrics = function (items, opt, Stw0) {
    opt = opt || {};
    var W = num(opt.pageW, 595.28), H = num(opt.pageH, 841.89);
    var bodySize = num(opt.bodySize, 0) || 10;
    var Stw = num(Stw0, 0);
    var rows = layoutLines(items, opt).map(function (l) {
      var szTw = Math.round(l.size * 2);              // w:sz 的單位是半磅
      var bold = opt.boldOnTitle !== false && l.size > bodySize * 1.15;
      /* 全部用「整數 twips」累加，跟渲染器拿到的是同一組數字：
       * 若用 float 點數推算、只把輸出四捨五入，模型與渲染器的累計量會慢慢分家，
       * 實測每行會漂 +0.02pt（24 行後累到 0.46pt）。改用整數 twips 後，
       * 我累加的 L 就是 Word 拿到的 L，誤差不會往下傳。
       *
       * L 取 1.02×字號：實測中文字身 ascent = 0.86em，而宋體的自然行高恰為 1.0em
       * （hhea 800/−200），所以 w:line = 字號×20 就剛好不裁字 —— 解剖 PDFPai 的產物
       * 證實它也是這麼做的（sz=24 配 w:line=240）。取 1.02 只是留 2% 保險。
       * 這個選擇還有個關鍵好處：B_i = pitch − 1.02·size，只要行距 ≥1.02 倍字號
       * 就不會被夾到 0，也就是近 99% 的行都是**精確定位**（實測全文 646 行，
       * 行距/字號小於 1.30 的只有 20 行）。 */
      var Ltw = Math.max(24, Math.round(l.size * 1.02 * 20));
      var Ttw = Math.round((H - l.base) * 20);
      var Btw = Ttw - KB * Ltw - Stw;
      if (!(Btw > 0)) Btw = 0;
      Stw += Btw + Ltw;

      /* tab stop 只收「> 0.5pt」的座標：實測 w:pos="0" 會讓整份 w:tabs 失效，
       * 退回到每 36pt 一個的預設定位點，整行字就散了。
       * 第一格在 x≈0 時不發 tab（游標本來就在 0），所以不需要 pos=0 的定位點。
       * 也不設 w:ind：實測 ind 與 tab 混用會讓位置跑掉（ind=36pt + tab=108pt 落在 84pt），
       * 純 tab（ind=0）則分毫不差（108.10 / 180.10，混字級也一樣）。 */
      var tabs = [], cells = [];
      l.cells.forEach(function (k) {
        var t = Math.round(k.x * 20);
        if (t > 10) tabs.push(t);
        cells.push({
          x: k.x, end: k.end, text: k.text, size: k.size,
          tab: t > 10 ? t : 0,
          sp: spacingOf(k.text, l.size, k.end - k.x, W - 2 - k.x)
        });
      });
      return {
        base: l.base, size: l.size, szTw: szTw, bold: bold,
        Ltw: Ltw, Ttw: Ttw, Btw: Btw,
        tabs: tabs.filter(function (t, i) { return tabs.indexOf(t) === i; })
          .sort(function (a, b) { return a - b; }),
        cells: cells
      };
    });
    return { rows: rows, Stw: Stw };
  };

  /**
   * 生成「版面复刻」docx。
   *
   * @param pages [{ items, paths, images, width, height }]
   *        items  = 归一化文字项（x/y/w/h/size/str），y 为基线、PDF 坐标
   *        paths  = OW.pathsFromOps 的产物
   *        images = [{ x, y, w, h, b64, ext }]，y 为 PDF 坐标的**下边缘**
   * @param opt { font, latinFont, boldOnTitle, scale }
   */
  OW.buildDocxLayout = function (pages, opt) {
    opt = opt || {};
    if (!pages || !pages.length) throw new Error('没有可转换的页面');
    var cjk = opt.font || '宋体';
    var latin = opt.latinFont || 'Times New Roman';
    /* w:hint="eastAsia" 是關鍵：□ 這類「兩邊都算」的字符若不指定，
     * Word 會拿拉丁字體（Times New Roman）去畫，變成一個特別小的方塊。 */
    var FA = ' w:ascii="' + esc(latin) + '" w:hAnsi="' + esc(latin) +
      '" w:eastAsia="' + esc(cjk) + '" w:cs="' + esc(latin) + '" w:hint="eastAsia"';
    var media = [], rels = [], imgN = 0;

    // 正文字号 = 全文出现次数最多的字号（用来判断「这行是不是标题」）
    var bodySize = num(opt.bodySize, 0) || OW.bodySizeOf(pages);

    /* 注意 rPr 的子元素顺序是 schema 规定的：rFonts → b → … → spacing → … → sz，
     * 把 w:spacing 放到 w:sz 后面会被判为非法。 */
    function rpr(sz, b, sp) {
      return '<w:rPr><w:rFonts' + FA + '/>' + (b ? '<w:b/>' : '') +
        (sp ? '<w:spacing w:val="' + sp + '"/>' : '') +
        '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/></w:rPr>';
    }

    /* 基線定位公式（實測歸納，與字號無關，常數 KB 見檔頭）：
     *       T_i = S_{i-1} + KB·L_i + B_i   ⇒   B_i = T_i − KB·L_i − S_{i-1}
     *   T_i = 該行目標基線距頁頂，S_i = 累計到第 i 段的行盒底。
     * B_i 每次都從「絕對目標」重算而非累加，所以某行被夾成 0（行距比行高還緊的
     * 少數行）時，下一行只要有空間就會自動補回來 —— 誤差不會往下累積。
     * 這些計算全部搬進 OW.layoutMetrics，好讓「預覽」與「導出」用同一份數字。
     */

    var body = '';
    pages.forEach(function (pg, pi) {
      var W = num(pg.width, 595.28), H = num(pg.height, 841.89);
      var cw = Math.round(W * 20), ch = Math.round(H * 20);

      /* 换页：分页符加在每个「新页的第一个段落」上。一页可能有图形段落，
       * 也可能没有（纯文字页），所以用一次性旗标，谁先出现谁拿。 */
      var pendingBreak = pi > 0;
      function pb() {
        if (!pendingBreak) return '';
        pendingBreak = false;
        return '<w:pageBreakBefore/>';
      }

      /* ---- 1) 矢量图形 + 图片：整页一个绝对定位的 VML group ---- */
      var g = [];
      (pg.paths || []).forEach(function (p, i) {
        if (!p || !p.d) return;
        var fd = !!p.fill, sd = !!p.line;
        if (!fd && !sd) return;
        g.push('<v:shape id="s' + pi + '_' + i + '" style="position:absolute;left:0;top:0;' +
          'width:' + cw + ';height:' + ch + '" coordsize="' + cw + ',' + ch +
          '" path="' + p.d + '" filled="' + (fd ? 't' : 'f') + '"' +
          (fd ? ' fillcolor="#' + p.fill + '"' : '') +
          ' stroked="' + (sd ? 't' : 'f') + '"' +
          (sd ? ' strokecolor="#' + p.line + '" strokeweight="' +
            Math.max(0.3, num(p.lw, 1) * 0.75).toFixed(2) + 'pt"' : '') + '/>');
      });
      (pg.images || []).forEach(function (im) {
        if (!im || !im.b64) return;
        imgN++;
        var ext = im.ext || 'png';
        media.push({ name: 'image' + imgN + '.' + ext, b64: im.b64 });
        rels.push({ id: 'rIdImg' + imgN, target: 'media/image' + imgN + '.' + ext });
        g.push('<v:shape id="im' + imgN + '" style="position:absolute;' +
          'left:' + Math.round(im.x * 20) + ';' +
          'top:' + Math.round((H - im.y - im.h) * 20) + ';' +
          'width:' + Math.round(im.w * 20) + ';height:' + Math.round(im.h * 20) + '"' +
          ' coordsize="' + Math.round(im.w * 20) + ',' + Math.round(im.h * 20) + '"' +
          ' stroked="f" filled="f"><v:imagedata r:id="rIdImg' + imgN +
          '" o:title=""/></v:shape>');
      });

      /* ---- 2) 图形段落：整页的框线 / 色块 / 印章放进一个绝对定位的 VML group ----
       * z-index:-10 是为了把图形压到文字**底下**：文字现在是普通段落（不是文字框），
       * 不指定的话浮动的 VML 会盖在正文上面。PDFPai 的产物也是这么做的。 */
      var gPara = '';
      if (g.length) {
        gPara = '<w:p><w:pPr>' + pb() + '<w:widowControl w:val="0"/>' +
          '<w:snapToGrid w:val="0"/>' +
          '<w:spacing w:before="0" w:after="0" w:line="2" w:lineRule="exact"/>' +
          '<w:ind w:left="0" w:right="0" w:firstLine="0"/>' +
          '<w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr>' +
          '<w:r><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr><w:pict>' +
          '<v:group id="g' + pi + '" style="position:absolute;margin-left:0pt;' +
          'margin-top:0pt;width:' + W.toFixed(2) + 'pt;height:' + H.toFixed(2) + 'pt;' +
          'mso-position-horizontal-relative:page;mso-position-vertical-relative:page;' +
          'z-index:-10" coordorigin="0,0" coordsize="' + cw + ',' + ch + '">' +
          g.join('') + '</v:group></w:pict></w:r></w:p>';
      }

      /* ---- 3) 文字：一个视觉行 = 一个普通段落 ----
       *
       * 为什么走「段落流」而不是绝对定位的 VML 文字框：
       *   · 文字框里 LibreOffice 会**忽略 run 级的 w:sz**，中文一律按 docDefaults
       *     的字号渲染（实测设定 9pt 出来是 10.5pt，整行宽了 16%）；
       *   · 普通段落完全听话：run 级 w:sz 与坐标都精准（实测 9.00 / 16.00pt、
       *     x = 36.10 / 72.10 / 108.10 全部等于设定值）。
       *
       * 垂直用 w:line + w:lineRule="exact"：行盒高度被写死，不再随字体度量浮动，
       * 实测每行稳定前进 13.40pt（与设定值分毫不差）。解剖 PDFPai 的产物证实
       * 它走的也是这条路（w:line=272/240/267… 全是 exact，配 811 个 w:before）。
       *
       * 基线定位公式（实测归纳，与字号无关）：
       *   行盒高 L、段前距 B 时，该段首行基线距行盒顶 = 0.8·L
       *   （L = 200/240/268/360/480tw 一律量到 0.8000；9~18pt 字全部相同）
       *       T_i = S_{i-1} + 0.8·L_i + B_i   ⇒   B_i = T_i − 0.8·L_i − S_{i-1}
       *   T_i = 该行目标基线距页顶，S_i = 累计到第 i 段的行盒顶。
       * B_i 每次都从「绝对目标」重算而非累加，所以某行被夹成 0（行距比行高还紧的
       * 少数行）时，下一行只要有空间就会自动补回来 —— 误差不会往下累积。
       *
       * L 取 1.02×字号：实测中文字身 ascent = 0.86em，而宋体的自然行高恰为 1.0em
       * （hhea 800/−200），所以 w:line = 字号×20 就刚好不裁字 —— 解剖 PDFPai 的产物
       * 证实它就是这么做的（sz=24 配 w:line=240）。取 1.02 只是留 2% 保险。
       * 这个选择还有个关键好处：B_i = pitch − 1.02·size，只要行距 ≥1.02 倍字号就不会
       * 被夹到 0，也就是近 99% 的行都是**精确定位**（实測全文 646 行，行距/字号
       * 小于 1.30 的只有 20 行）。
       *
       * 同一行的多个格子用「每格一个 tab stop」定位，且**不设 w:ind**：
       * 实测 ind=0 时纯 tab 定位完全精准（108.10 / 180.10 分毫不差，混字级也一样），
       * 而 ind 与 tab 混用会让位置跑掉（ind=36pt + tab=108pt 实际落在 84pt）。
       */
      var pageOut = '';
      /* 本頁的段落度量（行高 / 段前距 / tab / 字距）全部由 layoutMetrics 算好，
       * 預覽用的是同一支函式 —— 兩邊各算一套的話，預覽跟 docx 就會對不上。
       * Stw0 = 圖形段落 w:line="2" 已經佔掉的 2 twips（0.1pt）。 */
      var lm = OW.layoutMetrics(pg.items, {
        pageW: W, pageH: H, bodySize: bodySize,
        boldOnTitle: opt.boldOnTitle, sizeJump: opt.sizeJump
      }, gPara ? 2 : 0);
      lm.rows.forEach(function (l) {
        var p = '<w:p><w:pPr>' + pb() + '<w:widowControl w:val="0"/>' +
          '<w:snapToGrid w:val="0"/>';
        if (l.tabs.length) {
          p += '<w:tabs>' + l.tabs.map(function (t) {
            return '<w:tab w:val="left" w:pos="' + t + '"/>';
          }).join('') + '</w:tabs>';
        }
        /* w:right 給負值 → 文字區右緣推到頁面外 110pt。
         * 這一行若剛好排到頁面右緣（表格最後一格），正數邊界會讓它折行，
         * 折出來的行盒會把整頁後面的行往下推 12~13pt（p6/p18 就是這樣壞的）。 */
        p += '<w:spacing w:before="' + Math.round(l.Btw) + '" w:after="0" w:line="' +
          l.Ltw + '" w:lineRule="exact"/>' +
          '<w:ind w:left="0" w:right="-2200" w:firstLine="0"/><w:jc w:val="left"/>' +
          '<w:rPr>' + FA + '<w:sz w:val="' + l.szTw + '"/><w:szCs w:val="' + l.szTw +
          '"/></w:rPr></w:pPr>';
        l.cells.forEach(function (k) {
          if (k.tab) p += '<w:r><w:tab/></w:r>';
          p += '<w:r>' + rpr(l.szTw, l.bold, k.sp) +
            '<w:t xml:space="preserve">' + esc(k.text) + '</w:t></w:r>';
        });
        pageOut += p + '</w:p>';
      });

      body += gPara + pageOut;
    });

    /* ---- 3) 打包 ---- */
    var parts = {};
    parts['[Content_Types].xml'] = XMLHEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Default Extension="jpg" ContentType="image/jpeg"/>' +
      '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '</Types>';

    parts['_rels/.rels'] = XMLHEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rIdDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>';

    var drels = rels.map(function (r) {
      return '<Relationship Id="' + r.id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="' + r.target + '"/>';
    }).join('');
    parts['word/_rels/document.xml.rels'] = XMLHEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      drels + '</Relationships>';

    parts['word/styles.xml'] = XMLHEAD +
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts' + FA + '/>' +
      '<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr><w:widowControl w:val="0"/><w:snapToGrid w:val="0"/></w:pPr></w:pPrDefault>' +
      '</w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
      '<w:name w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:widowControl w:val="0"/><w:snapToGrid w:val="0"/></w:pPr>' +
      '<w:rPr><w:rFonts' + FA + '/></w:rPr></w:style>' +
      '</w:styles>';

    var first = pages[0];
    parts['word/document.xml'] = XMLHEAD +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
      ' xmlns:v="urn:schemas-microsoft-com:vml"' +
      ' xmlns:o="urn:schemas-microsoft-com:office:office"' +
      ' xmlns:w10="urn:schemas-microsoft-com:office:word"' +
      ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
      '<w:body>' + body +
      '<w:sectPr><w:pgSz w:w="' + Math.round(num(first.width, 595.28) * 20) +
      '" w:h="' + Math.round(num(first.height, 841.89) * 20) + '"/>' +
      '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" ' +
      'w:header="0" w:footer="0" w:gutter="0"/>' +
      '<w:docGrid w:type="default" w:linePitch="240" w:charSpace="0"/>' +
      '</w:sectPr></w:body></w:document>';

    media.forEach(function (m) { parts['word/media/' + m.name] = b64bin(m.b64); });

    return pack(parts, MIME_DOCX);
  };

  OW._internals = {
    esc: esc, colName: colName, asNum: asNum, median: median,
    layoutLines: layoutLines, colorOf: colorOf,
    advOf: advOf, spacingOf: spacingOf, KB: KB
  };

  /* ================= 导出 ================= */
  if (LB.util) LB.util.ow = OW;
  if (typeof module !== 'undefined' && module.exports) module.exports = OW;
})();
