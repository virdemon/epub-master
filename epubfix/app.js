/* ============================================================
   EPUB Master — 交互层
   所有数值都来自真实处理结果，没有任何写死的示例数据。
   ============================================================ */
(function () {
  'use strict';

  var MODES = EpubFix.MODES;
  var SET_KEY = 'epubmaster.settings.v1';
  var HIS_KEY = 'epubmaster.history.v1';

  /* ---------------------------------------------------------------- 工具 */

  function $(id) { return document.getElementById(id); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }

  function fmtBytes(n) {
    if (n == null || isNaN(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(2) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function fmtWords(n) {
    if (!n || n < 0) return '';
    if (n >= 10000) return (n / 10000).toFixed(1) + ' 万字';
    return n.toLocaleString('zh-CN') + ' 字';
  }

  function pct(x) {
    if (!isFinite(x)) return '—';
    return (x * 100).toFixed(1) + '%';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var toastWrap = $('toastWrap');
  function toast(msg, kind) {
    var d = document.createElement('div');
    d.className = 'toast' + (kind === 'err' ? ' is-err' : kind === 'ok' ? ' is-ok' : '');
    d.textContent = msg;
    toastWrap.appendChild(d);
    setTimeout(function () {
      d.style.transition = 'opacity .25s';
      d.style.opacity = '0';
      setTimeout(function () { d.remove(); }, 280);
    }, 2800);
  }

  /* ---------------------------------------------------------- 设置与历史 */

  var defaults = {
    dirName: '',
    mode: 'deep',
    target: 'auto',
    volume: false,          // 默认不分卷，输出一个完整文件
    // null = 没设置过，跟着当前模式的预设走；用户保存过才用用户的值
    edge: null,
    quality: null,
    fonts: null,
    logs: true,
    concurrency: 1,
    readerFont: 18,
    readerZoom: 100,
    tocW: 264,
    outVersion: 'auto'      // auto = 跟原书；'2' / '3' = 强制目标版本
  };

  var settings = Object.assign({}, defaults);
  try {
    var raw = localStorage.getItem(SET_KEY);
    if (raw) settings = Object.assign(settings, JSON.parse(raw));
  } catch (e) { /* 存储不可用就用默认值 */ }

  function saveSettings() {
    try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  var history = [];
  try {
    var hr = localStorage.getItem(HIS_KEY);
    if (hr) history = JSON.parse(hr) || [];
  } catch (e) { history = []; }

  function pushHistory(rec) {
    if (!settings.logs) return;
    history.unshift(rec);
    if (history.length > 100) history.length = 100;
    try { localStorage.setItem(HIS_KEY, JSON.stringify(history)); } catch (e) {}
    renderHistory();
  }

  /* 目录句柄存在 IndexedDB 里：localStorage 存不了 FileSystemHandle */
  function idb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('epubmaster', 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function idbSet(key, val) {
    try {
      var db = await idb();
      await new Promise(function (res, rej) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = res;
        tx.onerror = function () { rej(tx.error); };
      });
    } catch (e) { /* 忽略 */ }
  }

  async function idbGet(key) {
    try {
      var db = await idb();
      return await new Promise(function (res, rej) {
        var tx = db.transaction('kv', 'readonly');
        var r = tx.objectStore('kv').get(key);
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------- 状态 */

  var state = {
    mode: settings.mode,
    splitLevel: 1,
    target: settings.target,
    volume: false,
    outVersion: 'auto',
    current: null,
    result: null,
    busy: false,
    cancel: false,
    queue: [],
    batchRunning: false,
    dirHandle: null,
    book: null
  };

  /* ------------------------------------------------------------- 视图 */

  var VIEW_NAMES = {
    home: '首页', batch: '批量处理', history: '历史记录',
    tools: '工具箱', settings: '设置', about: '关于'
  };

  function showView(name) {
    $$('.view').forEach(function (v) {
      v.classList.toggle('is-active', v.id === 'view-' + name);
    });
    $$('.nav-item').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.view === name);
    });
    $('topbarTitle').textContent = VIEW_NAMES[name] || '';
    document.querySelector('.scroll').scrollTop = 0;
    // 右侧面板只对首页有意义
    document.querySelector('.panel').style.display = name === 'home' ? '' : 'none';
    document.querySelector('.app').style.gridTemplateColumns =
      name === 'home' ? '' : '228px minmax(0, 1fr)';
  }

  $$('.nav-item').forEach(function (b) {
    on(b, 'click', function () { showView(b.dataset.view); });
  });

  /* ------------------------------------------------------------- 模式 */

  function modeInfo(id) {
    return MODES[id] || MODES.deep;
  }

  function applyMode(id, opts) {
    state.mode = id;
    var m = modeInfo(id);
    $$('.mode-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.mode === id);
    });
    $('modeDesc').textContent = m.desc;

    // 基础开关跟随模式，用户之后可以再改
    if (opts && opts.syncUi) {
      $('optFonts').checked = !!m.dropFonts;
      $('optImages').checked = true;
      $('optClean').checked = !!m.tidyEmpty;
      $('optPreserveCss').checked = !!m.preserveCss;
      $('imgEdge').value = m.maxEdge || 1600;
      $('imgQuality').value = Math.round(m.quality * 100);
      syncRangeLabels();
    }

    // 参数表按控件的真实状态生成，别按预设写死，否则和下面的开关对不上
    var rows = [
      ['原书样式表', $('optPreserveCss').checked ? '保留' : '替换'],
      ['图片', $('optImages').checked ? '最长边 ' + $('imgEdge').value + ' px · 质量 ' + $('imgQuality').value : '不处理'],
      ['内嵌字体', $('optFonts').checked ? '移除' : '保留'],
      ['空段落清理', $('optClean').checked ? '执行' : '保留'],
      ['输出格式', targetVersionText()],
      ['分卷', state.volume ? targetLabel() : '关闭']
    ];
    $('modeParams').innerHTML = rows.map(function (r) {
      return '<li><span>' + r[0] + '</span><b>' + r[1] + '</b></li>';
    }).join('');

    updateEstimate();
  }

  function targetLabel() {
    if (!state.volume) return '关闭';
    var t = state.target;
    if (t === 'auto') return '自动（超 100 MB）';
    if (t === '0') return '不限（不切）';
    return t + ' MB';
  }

  /* ------------------------------------------------ 输出版本（EPUB 2 / 3） */

  function srcVersion() {
    var d = state.current && state.current.diag && state.current.diag.info;
    var v = (d && d.version) || (state.current && state.current.info && state.current.info.version) || '';
    return v;
  }

  function targetVersionText() {
    if (state.outVersion === '2') return 'EPUB 2.0';
    if (state.outVersion === '3') return 'EPUB 3.0';
    var v = srcVersion();
    if (!v) return '同原书';
    return 'EPUB ' + (/^\s*3\./.test(v) ? '3.0' : '2.0') + '（同原书）';
  }

  function syncVersionUi() {
    $('panelFormat').textContent = targetVersionText();
    var d = $('verDesc'), note = $('verNote');
    if (state.outVersion === 'auto') {
      d.textContent = '保留原书版本：原书是 EPUB 3 就输出 3，是 EPUB 2 就输出 2';
      note.textContent = srcVersion() ? '原书 EPUB ' + srcVersion() : '';
    } else if (state.outVersion === '2') {
      d.textContent = '按 EPUB 2.0 重建包结构：OPF 版本、NCX 目录、XHTML 1.1 文档类型。不支持的特性会写在结果里';
      note.textContent = '强制转换';
    } else {
      d.textContent = '按 EPUB 3.0 重建包结构：nav 导航文档、cover-image、dcterms:modified，同时保留 NCX 兼容老阅读器';
      note.textContent = '强制转换';
    }
  }

  $$('#verSeg .seg-btn').forEach(function (b) {
    on(b, 'click', function () {
      $$('#verSeg .seg-btn').forEach(function (x) { x.classList.remove('is-active'); });
      b.classList.add('is-active');
      state.outVersion = b.dataset.ver;
      settings.outVersion = state.outVersion;
      saveSettings();
      syncVersionUi();
      applyMode(state.mode, { syncUi: false });
    });
  });

  $$('.mode-btn').forEach(function (b) {
    on(b, 'click', function () { applyMode(b.dataset.mode, { syncUi: true }); });
  });

  function syncRangeLabels() {
    $('edgeValue').textContent = $('imgEdge').value + ' px';
    $('qualityValue').textContent = $('imgQuality').value;
    $('imgDesc').textContent = $('optImages').checked
      ? '缩小超大图片并重新编码（最长边 ' + $('imgEdge').value + ' px，质量 ' + $('imgQuality').value + '）'
      : '已关闭，所有图片原样保留，体积下降会明显变少';
  }

  /* --------------------------------------------------------- 规则控件 */

  $$('#splitLevelSeg .seg-btn').forEach(function (b) {
    on(b, 'click', function () {
      $$('#splitLevelSeg .seg-btn').forEach(function (x) { x.classList.remove('is-active'); });
      b.classList.add('is-active');
      state.splitLevel = Number(b.dataset.level);
    });
  });

  $$('#targetSeg .seg-btn').forEach(function (b) {
    on(b, 'click', function () {
      $$('#targetSeg .seg-btn').forEach(function (x) { x.classList.remove('is-active'); });
      b.classList.add('is-active');
      state.target = b.dataset.target;
      $('targetHint').textContent = b.dataset.target === '0'
        ? '不分卷'
        : '每卷上限 ' + (b.dataset.target === 'auto' ? '100 MB' : b.dataset.target + ' MB');
      syncVolumeUi();
      updateEstimate();
    });
  });

  // 分卷开关：默认关闭，关闭时把目标体积与切分方式整组收起来
  on($('optVolume'), 'change', function () {
    state.volume = $('optVolume').checked;
    syncVolumeUi();
    applyMode(state.mode, { syncUi: false });
  });

  function syncVolumeUi() {
    var on2 = !!state.volume;
    $('volumeOpts').hidden = !on2;
    if (!on2) {
      $('targetHint').textContent = '';
    } else if (!$('targetHint').textContent) {
      $('targetHint').textContent = state.target === '0'
        ? '不分卷'
        : '每卷上限 ' + (state.target === 'auto' ? '100 MB' : state.target + ' MB');
    }
    $('panelVolume').textContent = on2 ? targetLabel() : '关闭';
    $('panelOutHint').textContent = on2
      ? '超过上限时按章节边界拆卷，每卷都是独立可打开的 EPUB。'
      : '输出一个完整 EPUB。需要拆卷请在高级设置里开启。';
  }

  $$('.tab').forEach(function (t) {
    on(t, 'click', function () {
      $$('.tab').forEach(function (x) { x.classList.remove('is-active'); });
      t.classList.add('is-active');
      $('basicPane').classList.toggle('is-active', t.dataset.tab === 'basic');
      $('advPane').classList.toggle('is-active', t.dataset.tab === 'adv');
    });
  });

  ['optFonts', 'optImages', 'optClean', 'optPreserveCss', 'optUnused', 'optDedupe'].forEach(function (id) {
    on($(id), 'change', function () {
      syncRangeLabels();
      applyMode(state.mode, { syncUi: false });
    });
  });
  on($('imgEdge'), 'input', function () {
    syncRangeLabels();
    updateEstimate();
  });
  on($('imgQuality'), 'input', function () {
    syncRangeLabels();
    updateEstimate();
  });

  /* ----------------------------------------------------- 预计输出体积 */

  /*
   * 估算不是承诺。文本按 deflate 后约四成、图片按各模式的实际压缩比经验值算，
   * 界面上一律标注"约"和区间，避免让人以为这是精确值。
   */
  var IMAGE_FACTOR = { standard: 0.34, deep: 0.2, extreme: 0.1 };

  function updateEstimate() {
    var el = $('estSize'), note = $('estNote');
    if (!state.current || !state.current.diag) {
      el.textContent = '导入书籍后显示';
      note.textContent = '';
      return;
    }
    var d = state.current.diag.info;
    var imgBytes = d.imageBytes || 0;
    var fontBytes = d.fontBytes || 0;
    var total = state.current.file.size;
    var textBytes = Math.max(0, total - imgBytes - fontBytes);

    var m = modeInfo(state.mode);
    // 用户手动改了开关就以开关为准
    var dropFonts = $('optFonts').checked;
    var resize = $('optImages').checked;
    var edge = Number($('imgEdge').value) || 1600;

    var factor = IMAGE_FACTOR[state.mode] || 0.2;
    if (!resize) factor = 0.98;
    else if ($('optPreserveCss').checked) factor = Math.min(0.55, factor + 0.2);
    if (resize && !$('optPreserveCss').checked) { /* 保持模式值 */ }
    if (resize && edge >= 2400) factor += 0.06;

    var est = textBytes * 0.52 + imgBytes * factor + (dropFonts ? 0 : fontBytes) + 24 * 1024;
    est = Math.min(est, total * 1.02);

    el.textContent = '约 ' + fmtBytes(est);
    var lines = [];
    // 图片本来就没压过的书，实际输出可能比这里高两三倍；区间给宽一点，别把话说死
    lines.push('图片压缩比因书而异：' + fmtBytes(est * 0.55) + ' – ' + fmtBytes(est * 2.2));

    if (state.volume && state.target !== '0') {
      var limit = state.target === 'auto' ? 100 * 1048576 : Number(state.target) * 1048576;
      var n = Math.max(1, Math.ceil(est / limit));
      if (state.target === 'auto') {
        lines.push(n > 1 ? '超过 100 MB，会拆成约 ' + n + ' 卷' : '不到 100 MB，单文件输出');
      } else {
        lines.push(n > 1 ? '按 ' + state.target + ' MB 拆成约 ' + n + ' 卷' : '单文件输出');
      }
    } else {
      lines.push('单个完整文件');
    }
    note.textContent = lines.join('　·　');
  }

  /* --------------------------------------------------------- 导入文件 */

  var fileInput = $('fileInput');
  var toolInput = $('toolInput');

  function isEpub(f) {
    return /\.epub$/i.test(f.name) || f.type === 'application/epub+zip';
  }

  function pickFiles(multiple) {
    fileInput.multiple = !!multiple;
    fileInput.value = '';
    fileInput.click();
  }

  on(fileInput, 'change', function () {
    var files = Array.prototype.slice.call(fileInput.files || []);
    if (!files.length) return;
    if (fileInput.multiple) addToBatch(files);
    else loadSingle(files[0]);
  });

  on($('pickBtn'), 'click', function (e) {
    e.stopPropagation();
    pickFiles(false);
  });
  on($('rechooseBtn'), 'click', function (e) {
    e.stopPropagation();
    pickFiles(false);
  });
  on($('dropzone'), 'click', function (e) {
    if (e.target.closest('#fileCard')) return;
    pickFiles(false);
  });

  var dz = $('dropzone');
  ['dragenter', 'dragover'].forEach(function (ev) {
    on(document, ev, function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
      e.preventDefault();
      dz.classList.add('is-over');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    on(document, ev, function (e) {
      if (ev === 'drop') {
        e.preventDefault();
        var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []).filter(isEpub);
        dz.classList.remove('is-over');
        if (!files.length) { toast('请拖入 .epub 文件', 'err'); return; }
        if (files.length === 1) loadSingle(files[0]);
        else { addToBatch(files); showView('batch'); }
      } else if (!e.relatedTarget) {
        dz.classList.remove('is-over');
      }
    });
  });

  function checkSize(file) {
    var w = $('sizeWarn');
    if (file.size > 300 * 1048576) {
      w.hidden = false;
      w.textContent = '这个文件有 ' + fmtBytes(file.size) +
        '。解包后图片要占用数倍内存，浏览器有可能在处理到一半时崩掉。建议先用「标准优化」试一次，或者用桌面版处理。';
    } else {
      w.hidden = true;
    }
  }

  /* 书籍卡上的信息条目：每项一个"标签 + 值"，长书名不会把这行挤成一团 */
  function setFacts(rows) {
    $('fileFacts').innerHTML = (rows || []).map(function (r) {
      return '<span><i>' + esc(r[0]) + '</i><b>' + esc(r[1]) + '</b></span>';
    }).join('');
  }

  async function loadSingle(file) {
    if (!isEpub(file)) { toast('请选择 .epub 文件', 'err'); return; }
    state.current = { file: file, info: null, diag: null };
    state.result = null;

    $('dzEmpty').hidden = true;
    $('fileCard').hidden = false;
    $('fileCard').removeAttribute('data-ready');
    $('dropCard').classList.add('is-loaded');
    $('fileTitle').textContent = file.name.replace(/\.epub$/i, '');
    $('fileTitle').title = $('fileTitle').textContent;
    $('fileAuthor').textContent = '正在读取…';
    $('fileName').textContent = file.name + '　·　' + fmtBytes(file.size);
    $('fileName').title = file.name;
    setFacts([]);
    $('fileDiag').innerHTML = '';
    if (state.coverUrl) { try { URL.revokeObjectURL(state.coverUrl); } catch (e) {} state.coverUrl = ''; }
    $('coverImg').removeAttribute('src');
    $('coverImg').hidden = true;
    $('coverFallback').hidden = false;
    $('resultCard').hidden = true;
    $('progressCard').hidden = true;
    $('errorCard').hidden = true;
    checkSize(file);

    var buf = await file.arrayBuffer();
    state.current.buffer = buf;

    // 元数据
    try {
      var info = await EpubFix.inspect(buf);
      state.current.info = info;
      $('fileTitle').textContent = info.title || file.name.replace(/\.epub$/i, '');
      $('fileTitle').title = $('fileTitle').textContent;
      $('coverImg').alt = $('fileTitle').textContent + ' 封面';
      $('fileAuthor').textContent = info.creator ? '作者：' + info.creator : '未标注作者';
      if (info.cover && info.cover.bytes) {
        var url = URL.createObjectURL(new Blob([info.cover.bytes], { type: info.cover.mediaType }));
        state.coverUrl = url;
        $('coverImg').onerror = function () {
          // 封面解不出来就退回占位图，不留一个破图标
          $('coverImg').hidden = true;
          $('coverFallback').hidden = false;
        };
        $('coverImg').src = url;
        $('coverImg').hidden = false;
        $('coverFallback').hidden = true;
      }
    } catch (e) {
      $('fileAuthor').textContent = '读取失败：' + e.message;
    }

    // 结构检查
    try {
      var d = await EpubFix.diagnose(buf);
      state.current.diag = d;
      var chips = [];
      chips.push('<span class="chip chip-info">EPUB ' + esc(d.info.version || '2') + '</span>');
      chips.push('<span class="chip chip-info">' + esc(d.info.language || '未标注语言') + '</span>');
      var errs = d.issues.filter(function (i) { return i.level === 'error'; }).length;
      var warns = d.issues.filter(function (i) { return i.level === 'warn'; }).length;
      if (errs) chips.push('<span class="chip chip-err">' + errs + ' 个结构问题</span>');
      else if (warns) chips.push('<span class="chip chip-warn">' + warns + ' 个提示</span>');
      else chips.push('<span class="chip chip-ok">结构正常</span>');
      $('fileDiag').innerHTML = chips.join('');

      setFacts([
        ['章节', d.info.chapters ? d.info.chapters + ' 章' : '未识别'],
        ['字数', fmtWords(d.info.words) || '未统计'],
        ['图片', d.info.images ? d.info.images + ' 张 · ' + fmtBytes(d.info.imageBytes) : '无图片'],
        ['内嵌字体', d.info.fonts ? d.info.fonts + ' 个 · ' + fmtBytes(d.info.fontBytes) : '无内嵌字体'],
        ['样式表', d.info.css ? d.info.css + ' 份' : '无']
      ]);
    } catch (e) {
      $('fileDiag').innerHTML = '<span class="chip chip-err">结构检查失败：' + esc(e.message) + '</span>';
    }

    $('fileCard').setAttribute('data-ready', '1');
    syncVersionUi();
    updateEstimate();
  }

  /* --------------------------------------------------------- 处理选项 */

  function collectOptions() {
    // 分卷关闭时，目标体积与上限一律不传：引擎就不会去想拆卷这件事
    var volumeTarget = 0;
    var targetBytes = 0;
    if (state.volume) {
      if (state.target === 'auto') volumeTarget = 'auto';
      else if (state.target !== '0') {
        volumeTarget = Number(state.target) * 1048576;
        // 同一个数字身兼两职：先当压缩上限（图片按它反推预算），压不下来才拿来分卷
        targetBytes = volumeTarget;
      }
    }

    var imgOn = $('optImages').checked;
    var base = {
      mode: state.mode,
      splitLevel: state.splitLevel,
      volumeTarget: volumeTarget,
      targetBytes: targetBytes,
      noImageOptimize: !imgOn,
      imageDedupe: $('optDedupe') ? $('optDedupe').checked : true,
      outputVersion: state.outVersion,
      preserveCss: $('optPreserveCss').checked,
      keepInlineStyles: $('optPreserveCss').checked,
      dropFonts: $('optFonts').checked,
      tidyEmpty: $('optClean').checked,
      dropUnused: $('optUnused').checked,
      maxEdge: imgOn ? Number($('imgEdge').value) : 0,
      quality: Number($('imgQuality').value) / 100
    };
    var lang = $('langInput').value.trim();
    if (lang) base.lang = lang;
    return base;
  }

  /* ------------------------------------------------------------- 进度 */

  var PHASE_NAME = {
    unzip: '正在检查', parse: '正在检查',
    images: '正在优化图片', clean: '正在优化正文', rewrite: '正在优化引用',
    build: '正在生成章节', pack: '正在打包', verify: '正在验证输出',
    done: '已完成'
  };

  function setProgress(phase, msg, ratio) {
    $('progressCard').hidden = false;
    $('progressPhase').textContent = PHASE_NAME[phase] || phase || '处理中';
    $('progressMsg').textContent = msg || '';
    if (ratio != null && isFinite(ratio)) {
      var v = Math.max(0, Math.min(100, Math.round(ratio * 100)));
      $('barFill').style.width = v + '%';
      $('progressPct').textContent = v + '%';
    } else {
      // 拿不到真实进度就不显示数字，只显示当前阶段
      $('progressPct').textContent = '';
    }
  }

  /* ------------------------------------------------------------- 开始 */

  $('cancelBtn').addEventListener('click', function () {
    state.cancel = true;
    $('progressMsg').textContent = '已请求取消，正在当前阶段结束后停止…';
  });

  on($('startBtn2'), 'click', function () { runSingle(); });
  function resetCard() {
    state.current = null;
    state.result = null;
    $('dzEmpty').hidden = false;
    $('fileCard').hidden = true;
    $('dropCard').classList.remove('is-loaded');
    $('resultCard').hidden = true;
    $('progressCard').hidden = true;
    $('barFill').style.width = '0%';
    if (state.coverUrl) { try { URL.revokeObjectURL(state.coverUrl); } catch (e) {} state.coverUrl = ''; }
    updateEstimate();
    syncVersionUi();
  }

  on($('nextBtn'), 'click', function () {
    resetCard();
    pickFiles(false);
  });

  on($('coverBtn'), 'click', function (e) {
    // 点封面=打开预览：卡片上最自然的动作就是"翻一下这本书"
    e.stopPropagation();
    if (!state.current) return;
    openReader('original');
  });

  async function runSingle() {
    if (state.busy) return;
    if (!state.current) { toast('请先选择一本 EPUB', 'err'); return; }
    if (!state.current.buffer) {
      state.current.buffer = await state.current.file.arrayBuffer();
    }

    state.busy = true;
    state.cancel = false;
    $('startBtn2').disabled = true;
    $('resultCard').hidden = true;
    $('errorCard').hidden = true;
    $('barFill').style.width = '0%';
    $('cancelBtn').hidden = false;
    setProgress('unzip', '准备中…', 0);

    var t0 = performance.now();
    var opts = collectOptions();
    // 取消要能中途生效，不能等整个处理跑完才检查
    opts.shouldCancel = function () { return !!state.cancel; };

    try {
      var res = await EpubFix.process(state.current.buffer, opts, function (p) {
        if (state.cancel) throw new Error('__CANCELLED__');
        setProgress(p.phase, p.message, p.ratio);
      });
      var ms = Math.round(performance.now() - t0);
      state.result = { res: res, opts: opts, ms: ms, name: state.current.info ? state.current.info.title : state.current.file.name };
      renderResult();
      setProgress('done', '完成', 1);
      $('cancelBtn').hidden = true;
      setTimeout(function () { $('progressCard').hidden = true; }, 700);
    } catch (e) {
      $('progressCard').hidden = true;
      if (e.message === '__CANCELLED__') {
        toast('已取消，没有生成文件');
      } else {
        $('errorCard').hidden = false;
        $('errorText').textContent = e.message || String(e);
        $('resultCard').hidden = true;
      }
    } finally {
      state.busy = false;
      $('startBtn2').disabled = false;
    }
  }

  on($('errCloseBtn'), 'click', function () { $('errorCard').hidden = true; });

  /* ------------------------------------------------------------- 结果 */

  /*
   * 统计口径必须说清楚，否则一定出现"总量 8.5KB、文本 12.4KB"这种自相矛盾的画面：
   *   文件体积  = ZIP 压缩后的字节数（inB / outB），用户看到的磁盘占用
   *   资源体积  = 解压后每个文件的原始字节数（sizeBreakdown / afterBreakdown）
   * 两个数不同源，不能相加，也不能拿一个当另一个的分母。
   */
  /* 分类图标：统一 24 格描边图标（Lucide 的形状），放在同尺寸圆角底上。
     只有"图标+名称"都在，才不用靠颜色区分；色只做轻微区分。 */
  var CAT_META = {
    图片: {
      tint: '#eff6ff', color: '#2563eb',
      icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.2" y="3.6" width="17.6" height="16.8" rx="2.4"/><circle cx="8.6" cy="9.4" r="1.5"/><path d="m20.6 16.4-4.8-4.8L7 20"/></svg>'
    },
    文本: {
      tint: '#eef2ff', color: '#4f46e5',
      icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3.2H7.4a2 2 0 0 0-2 2v13.6a2 2 0 0 0 2 2h9.2a2 2 0 0 0 2-2V8z"/><path d="M14 3.2V8h5"/><path d="M9 12.6h6M9 16.2h4"/></svg>'
    },
    字体: {
      tint: '#f5f0ff', color: '#7c3aed',
      icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.6 7.4V5.2h14.8v2.2"/><path d="M12 5.2v13.6"/><path d="M9 18.8h6"/></svg>'
    },
    其他: {
      tint: '#f1f5f9', color: '#64748b',
      icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.8 8.6 4.4v9.6L12 21.2 3.4 16.8V7.2z"/><path d="m3.4 7.2 8.6 4.4 8.6-4.4"/><path d="M12 11.6v9.6"/></svg>'
    }
  };

  function renderResult() {
    var r = state.result;
    if (!r) return;
    var rep = r.res.report;
    var inB = rep.inputBytes;
    var outB = rep.outputBytes;
    var saved = inB - outB;
    var ratio = inB ? saved / inB : 0;
    var volN = rep.volumes || 1;

    $('resultCard').hidden = false;
    // 结果卡在长页面的下半部分，处理完直接把视线带过去，省得用户自己找
    setTimeout(function () {
      $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);

    // --- 状态：完成 / 部分成功
    var partial = (rep.verifyIssues || []).length > 0;
    $('resultBadge').textContent = partial
      ? '部分成功'
      : (volN > 1 ? volN + ' 卷已完成' : '已完成');
    $('resultBadge').className = partial ? 'badge-ok badge-warn' : 'badge-ok';

    $('resultSub').textContent = [
      r.name || '未命名',
      rep.modeLabel || r.opts.mode,
      volN > 1 ? volN + ' 个文件' : '单个文件'
    ].join('　·　');

    // --- 概览：全部由真实字节数算出
    var ratioText, ratioCls;
    if (saved > 0) {
      ratioText = pct(ratio);
      ratioCls = ratio >= 0.05 ? 'good' : 'flat';
    } else if (saved === 0) {
      ratioText = '0%';
      ratioCls = 'flat';
    } else {
      ratioText = '增加 ' + pct(-ratio);
      ratioCls = 'bad';
    }

    var outVer = rep.outputVersion || '—';
    var verIsForced = rep.versionMode === 'forced';

    $('statsRow').innerHTML = [
      sumItem('原始体积', fmtBytes(inB), 'ZIP 文件大小'),
      sumItem('处理后体积', fmtBytes(outB), volN > 1 ? volN + ' 个文件合计' : 'ZIP 文件大小'),
      sumItem('节省空间', (saved >= 0 ? '' : '−') + fmtBytes(Math.abs(saved)), saved > 0 ? '真实减少的字节' : '没有减少', saved > 0 ? 'good' : 'flat'),
      sumItem('体积减少', ratioText, '（原始 − 处理后）÷ 原始', ratioCls),
      sumItem('耗时', (r.ms / 1000).toFixed(r.ms < 10000 ? 1 : 0) + ' 秒', '本机完成'),
      sumItem('处理模式', rep.modeLabel || r.opts.mode, '参数见右侧面板'),
      sumItem('输出版本', 'EPUB ' + outVer, verIsForced ? '按你选的版本重建' : '跟随原书 ' + (rep.sourceVersion || '?')),
      sumItem('输出文件', volN + ' 个', volN > 1 ? '每卷可独立打开' : '一个完整 EPUB')
    ].join('');

    // --- 版本：输出的是什么、核对结果、有没有保不住的特性
    $('verOut').textContent = 'EPUB ' + outVer;
    $('verState').textContent = rep.versionVerified ? '结构自检通过' : '结构自检未通过';
    $('verState').className = 'ver-badge' + (rep.versionVerified ? '' : ' is-bad');
    $('verNote2').textContent = [
      verIsForced ? '指定输出' : '跟随原书（EPUB ' + (rep.sourceVersion || '?') + '）',
      volN > 1 ? volN + ' 个文件' : '1 个文件',
      fmtBytes(outB)
    ].join('　·　');
    var verWarns = rep.versionWarnings || [];
    $('verWarn').hidden = verWarns.length === 0;
    $('verWarn').innerHTML = verWarns.map(function (w) {
      return '<div class="vw">' + esc(w) + '</div>';
    }).join('');

    $('scopeNote').textContent =
      '下面的体积是解压后的资源大小，和上面的 ZIP 文件体积口径不同，不能直接相加';

    // --- 分类分析
    $('breakdown').innerHTML = [
      catImages(rep),
      catText(rep),
      catFonts(rep),
      catOther(rep)
    ].join('');

    // --- 排版兼容性检查：每一项都来自引擎的真实检查结果
    renderAudit(rep);
    // --- 重复图片清理：位置数、资源数、省下的字节，三个口径分开写
    renderDedupe(rep);

    // --- 输出文件列表
    var vols = r.res.volumes || [];
    $('volSection').hidden = vols.length === 0;
    $('volNote').textContent = vols.length > 1
      ? vols.length + ' 卷，合计 ' + fmtBytes(outB)
      : '单个文件 ' + fmtBytes(outB);
    $('volList').innerHTML = vols.map(function (v, i) {
      return '<button type="button" class="vol-row" data-vol="' + i + '">' +
        '<span class="vol-name">' + esc(v.fileName) + '</span>' +
        '<span class="vol-meta"><b>' + fmtBytes(v.bytes.length) + '</b>　' + v.chapters + ' 章　' +
        '<i>预览</i></span></button>';
    }).join('');
    $$('#volList .vol-row').forEach(function (b) {
      on(b, 'click', function () {
        openReader('result', { volume: Number(b.dataset.vol) });
      });
    });

    // --- 提示
    var warns = (rep.warnings || []).slice();
    if (!saved && !warns.length) {
      warns.push('这本书没有可压缩的空间：' +
        (rep.imagesFound ? '图片已经足够小，' : '它不含图片，') +
        '正文用 deflate 压缩后已接近极限。文件仍然经过结构修复与重新打包，可以直接使用。');
    }
    $('warnSection').hidden = warns.length === 0;
    $('warnList').innerHTML = warns.map(function (w) {
      var cls = /失败|不通过|无法|损坏|问题/.test(w) ? ' is-error' : /发现|跳过|说明/.test(w) ? ' is-info' : '';
      return '<div class="warn-item' + cls + '">' + esc(w) + '</div>';
    }).join('');

    pushHistory({
      t: Date.now(),
      name: r.name || '未命名',
      mode: rep.modeLabel || r.opts.mode,
      inB: inB,
      outB: outB,
      vols: volN,
      warn: (rep.warnings || []).length
    });
  }


  /* 排版兼容性检查：ok=检查通过  fixed=已修复  warn=需要确认  info=风险提示
     状态全部由引擎按输出包里的真实内容算出，界面不做任何美化或兜底。 */
  var AUDIT_META = {
    ok: { label: '检查通过', cls: 'is-ok' },
    fixed: { label: '已修复', cls: 'is-fixed' },
    warn: { label: '需要确认', cls: 'is-warn' },
    info: { label: '风险提示', cls: 'is-info' }
  };

  function renderAudit(rep) {
    var list = rep.audit || [];
    $('auditSection').hidden = list.length === 0;
    if (!list.length) return;
    var c = rep.auditCounts || {};
    $('auditNote').textContent = [
      c.fixed ? c.fixed + ' 项已修复' : '',
      c.ok ? c.ok + ' 项通过' : '',
      c.warn ? c.warn + ' 项需要确认' : '',
      c.info ? c.info + ' 项风险提示' : ''
    ].filter(Boolean).join('　·　');

    $('auditList').innerHTML = list.map(function (it) {
      var meta = AUDIT_META[it.status] || AUDIT_META.info;
      return '<div class="audit-item ' + meta.cls + '">' +
        '<span class="audit-dot" aria-hidden="true"></span>' +
        '<div class="audit-body">' +
          '<div class="audit-title">' + esc(it.title) +
            '<span class="audit-tag">' + meta.label + '</span></div>' +
          '<div class="audit-desc">' + esc(it.detail) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  /* 重复图片清理：数字全部来自引擎，界面只负责把它们分开讲清楚
     「显示位置」「资源文件」「省下的字节」是三件事，不能混成一个数。 */
  function renderDedupe(rep) {
    var d = rep.dedupe;
    var box = $('dedupeSection');
    if (!d || !d.on) {
      box.hidden = true;
      return;
    }
    box.hidden = false;

    function stat(k, v, hint, cls) {
      return '<div class="dup-stat' + (cls ? ' ' + cls : '') + '">' +
        '<span class="dup-k">' + esc(k) + '</span>' +
        '<span class="dup-v">' + esc(v) + '</span>' +
        (hint ? '<span class="dup-h">' + esc(hint) + '</span>' : '') +
        '</div>';
    }

    var stats = [
      stat('正文图片位置', d.positions + ' 处', '按阅读顺序扫到的 <img> 数量'),
      stat('不同图片', d.unique + ' 种', '内容互不相同，全部保留'),
      stat('保留首次出现', d.kept + ' 处', '每张图只留第一次出现的位置'),
      stat('清除重复显示', d.removed + ' 处', d.removed ? '仅移除重复位置的引用' : '没有发现重复',
        d.removed ? 'is-do' : '')
    ];
    if (d.droppedResources > 0) {
      stats.push(stat('移除冗余资源', d.droppedResources + ' 个', '内容相同且已无人引用的文件', 'is-do'));
      stats.push(stat('实际节省', fmtBytes(d.savedBytes || 0), '解压后的图片体积', 'is-do'));
    } else if (d.removed > 0) {
      stats.push(stat('移除冗余资源', '0 个', '资源仍被首次位置引用，不能删'));
    }
    if (d.skipped > 0) {
      stats.push(stat('无法确认保留', d.skipped + ' 处', '解码失败，按不同图片处理'));
    }
    $('dedupeStats').innerHTML = stats.join('');

    var recs = d.records || [];
    $('dedupeNote').textContent = recs.length
      ? '只清理能确认完全相同的图片，相似但不完全一致的一律保留'
      : '这本书没有内容完全相同的重复图片';
    $('dedupeSummary').textContent = recs.length
      ? '（' + recs.length + (rep.dedupeRecordTotal > recs.length ? ' / 共 ' + rep.dedupeRecordTotal : '') + ' 张图）'
      : '';
    $('dedupeDetail').hidden = recs.length === 0;
    $('dedupeList').innerHTML = recs.map(function (r) {
      return '<div class="dup-row">' +
        '<div class="dup-row-top">' +
          '<span class="dup-name">' + esc(r.name) + '</span>' +
          '<span class="dup-size">' + fmtBytes(r.bytes || 0) + '</span>' +
          '<span class="dup-tag">' + (r.pixel ? '像素比对确认' : '内容哈希相同') + '</span>' +
          (r.mergedFiles > 1 ? '<span class="dup-tag is-soft">合并 ' + r.mergedFiles + ' 个文件</span>' : '') +
        '</div>' +
        '<div class="dup-row-desc">保留 ' + esc(r.keep) +
          '　·　清除 ' + esc(r.removed.join('、')) + '</div>' +
      '</div>';
    }).join('');
  }

  function sumItem(k, v, hint, cls) {    return '<div class="sum-item' + (cls ? ' ' + cls : '') + '">' +
      '<div class="sum-k">' + esc(k) + '</div>' +
      '<div class="sum-v">' + esc(v) + '</div>' +
      (hint ? '<div class="sum-hint">' + esc(hint) + '</div>' : '') +
      '</div>';
  }

  /* 分类面板：每一类都要说清"发现了什么、做了什么、省了多少"，没有就明说没有 */
  function catBlock(name, tag, tagCls, saveBytes, desc, bars) {
    var meta = CAT_META[name];
    var saveTxt = saveBytes > 0 ? '省下 ' + fmtBytes(saveBytes) : '无变化';
    return '<div class="cat' + (tagCls === 'tag-keep' && !saveBytes ? ' is-empty' : '') + '">' +
      '<div class="cat-top">' +
        '<span class="cat-ico" style="background:' + meta.tint + ';color:' + meta.color +
          ';border-color:' + meta.tint + '">' + meta.icon + '</span>' +
        '<span class="cat-name">' + name + '</span>' +
        '<span class="cat-tag ' + tagCls + '">' + esc(tag) + '</span>' +
        '<span class="cat-save' + (saveBytes > 0 ? '' : ' none') + '">' + saveTxt + '</span>' +
      '</div>' +
      '<div class="cat-desc">' + desc + '</div>' +
      (bars || '') +
      '</div>';
  }

  function catBars(before, after, color) {
    var max = Math.max(before, after, 1);
    return '<div class="cat-bars">' +
      '<div class="cat-bar"><span>处理前</span><span class="cat-track">' +
        '<i style="width:' + Math.round((before / max) * 100) + '%;background:#c7d2e5"></i></span>' +
        '<b>' + fmtBytes(before) + '</b></div>' +
      '<div class="cat-bar"><span>处理后</span><span class="cat-track">' +
        '<i style="width:' + Math.round((after / max) * 100) + '%;background:' + color + '"></i></span>' +
        '<b>' + fmtBytes(after) + '</b></div>' +
      '</div>';
  }

  function catImages(rep) {
    var before = rep.sizeBreakdown.image || 0;
    var after = rep.afterBreakdown ? rep.afterBreakdown.image : before;
    var found = rep.imagesFound || 0;
    var done = rep.imagesProcessed || 0;
    var svg = rep.svgsTotal || 0;

    if (!found && !svg) {
      return catBlock('图片', '没有图片', 'tag-keep', 0,
        '这本书里没有任何位图或 SVG 资源，图片部分没有可优化的对象。', '');
    }
    var tag = done > 0 ? '优化 ' + done + ' 张' : '未改动';
    var parts = [];
    parts.push('发现 <b>' + found + '</b> 张位图' + (svg ? '，另有 <b>' + svg + '</b> 个 SVG（矢量，不重编码）' : '') + '。');
    if (done > 0) {
      parts.push('成功重编码 <b>' + done + '</b> 张，体积 ' + fmtBytes(rep.imageBytesBefore) + ' → ' + fmtBytes(rep.imageBytesAfter) + '。');
    } else if (found) {
      parts.push('没有一张需要处理：要么已经是优化过的 JPEG，要么重编码后反而更大，全部原样保留。');
    }
    // 没有被任何章节或样式表引用的图片不会写进新包，必须说清楚，不能悄悄少掉
    if (rep.unusedImages) {
      parts.push('另有 <b>' + rep.unusedImages + '</b> 张图片（' + fmtBytes(rep.unusedImageBytes || 0) +
        '）在原书里没有任何章节或样式表引用，属于死资源，没有写进新包。');
    }
    return catBlock('图片', tag, done > 0 ? 'tag-do' : 'tag-keep', before - after, parts.join(''), catBars(before, after, CAT_META.图片.color));
  }

  function catText(rep) {
    var before = rep.sizeBreakdown.text || 0;
    var after = rep.afterBreakdown ? rep.afterBreakdown.text : before;
    var fix = (rep.rebuiltParagraphs || 0) + (rep.convertedBlocks || 0);
    var desc = '整理出 <b>' + (rep.chapters || 0) + '</b> 章，来自 ' + (rep.sourceDocuments || rep.chapters || 0) + ' 个正文文件。';
    if (fix) desc += '重建 <b>' + fix + '</b> 处段落结构（' + (rep.rebuiltParagraphs || 0) + ' 处换行合段、' + (rep.convertedBlocks || 0) + ' 处 div 转 p）。';
    if (rep.mergedShortParagraphs) desc += '另外把 <b>' + rep.mergedShortParagraphs + '</b> 个"一句话一段"的碎段接成了正常段落。';
    if (rep.removedEmptyParagraphs) desc += '删除 <b>' + rep.removedEmptyParagraphs + '</b> 个空段落。';
    desc += ' 文本在 ZIP 里本来就被压得很狠，重新打包后体积变化通常不大。';
    return catBlock('文本', '已重排', 'tag-do', before - after, desc, catBars(before, after, CAT_META.文本.color));
  }

  function catFonts(rep) {
    var before = rep.sizeBreakdown.font || 0;
    var after = rep.afterBreakdown ? rep.afterBreakdown.font : before;
    var found = rep.fontsTotal || 0;
    if (!found) {
      return catBlock('字体', '无内嵌字体', 'tag-keep', 0,
        '这本书没有内嵌字体文件，字形由阅读器自己的字体提供。', '');
    }
    var removed = rep.removedFonts || 0;
    var desc = '发现 <b>' + found + '</b> 个字体文件，共 ' + fmtBytes(before) + '。';
    if (removed) {
      desc += '移除 <b>' + removed + '</b> 个，腾出 ' + fmtBytes(rep.droppedFontBytes || 0) + '。';
      desc += '移除后标题与特殊字符可能改用系统字体显示，这是换取体积的代价。';
    } else {
      desc += '全部保留，没有执行字体删除。内嵌字体通常决定标题字形，删了会明显变样。';
      desc += ' 想进一步减小体积，可以在高级设置里打开「移除内嵌字体」。';
    }
    return catBlock('字体', removed ? '移除 ' + removed + ' 个' : '保留 ' + found + ' 个',
      removed ? 'tag-warn' : 'tag-keep', before - after, desc,
      removed ? catBars(before, after, CAT_META.字体.color) : '');
  }

  function catOther(rep) {
    var before = rep.sizeBreakdown.other || 0;
    var after = rep.afterBreakdown ? rep.afterBreakdown.other : before;
    var dropped = rep.orphanFiles || 0;
    if (!before && !after) {
      return catBlock('其他', '无其他资源', 'tag-keep', 0,
        '除了图片、文本与字体，这本书没有别的资源类型。', '');
    }
    var desc = '封面之外的杂项文件（OPF、导航、音视频等），共 ' + fmtBytes(before) + '。';
    if (dropped) desc += '清理了 <b>' + dropped + '</b> 个确认无人引用的文件。';
    else if (before - after <= 0) desc += '没有发现可以安全清理的冗余资源，全部原样保留。';
    return catBlock('其他', dropped ? '清理 ' + dropped + ' 个' : '保留原样',
      dropped ? 'tag-do' : 'tag-keep', before - after, desc,
      dropped ? catBars(before, after, CAT_META.其他.color) : '');
  }

  /* ------------------------------------------------------------- 保存 */

  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1500);
  }

  async function saveAll() {
    var r = state.result;
    if (!r) return;
    var vols = r.res.volumes || [];
    if (!vols.length) { toast('没有可保存的文件', 'err'); return; }

    // 桌面版：写进 下载\EPUB_Master（或用户选的目录），同名自动加序号
    if (desk() && desk().saveFiles) {
      try {
        // 直接传 Uint8Array：转成数字数组走 IPC，一本 90MB 的书会传上千万个数
        var payload = vols.map(function (v) {
          return { name: v.fileName, bytes: v.bytes };
        });
        var res = await desk().saveFiles(payload, { dir: settings.dirName || '' });
        if (res && res.saved) {
          toast('已保存 ' + res.saved + ' 个文件到 ' + res.dir, 'ok');
          state.lastOutDir = res.dir;
        } else if (res && res.error) {
          toast('保存失败：' + res.error, 'err');
        }
        return;
      } catch (e) {
        toast('保存失败：' + e.message, 'err');
        return;
      }
    }

    var h = state.dirHandle;
    // 浏览器版：还没授权目录时先让用户选一次，选择器直接落在下载目录
    if (!h && window.showDirectoryPicker) {
      try {
        h = await window.showDirectoryPicker({
          mode: 'readwrite', id: 'epubmaster-out', startIn: 'downloads'
        });
        state.dirHandle = h;
        settings.dirName = h.name;
        saveSettings();
        await idbSet('dir', h);
        refreshDirUi();
      } catch (e) {
        if (e.name === 'AbortError') toast('已取消，改为下载方式保存');
      }
    }

    if (h) {
      try {
        var perm = await h.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') perm = await h.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          var n = 0;
          var names = [];
          for (var i = 0; i < vols.length; i++) {
            var name = await freeName(h, vols[i].fileName);
            var fh = await h.getFileHandle(name, { create: true });
            var w = await fh.createWritable();
            await w.write(vols[i].bytes);
            await w.close();
            names.push(name);
            n++;
          }
          toast('已写入「' + h.name + '」：' + n + ' 个文件' +
            (names[0] !== vols[0].fileName ? '（同名文件已自动改名，未覆盖）' : ''), 'ok');
          return;
        }
      } catch (e) {
        toast('写入目录失败，改为下载：' + e.message, 'err');
      }
    }

    for (var j = 0; j < vols.length; j++) {
      downloadBlob(new Blob([vols[j].bytes], { type: 'application/epub+zip' }), vols[j].fileName);
      if (vols.length > 1) await new Promise(function (s) { setTimeout(s, 400); });
    }
    toast(vols.length > 1 ? '已开始下载 ' + vols.length + ' 个文件到浏览器下载目录' : '已开始下载到浏览器下载目录', 'ok');
  }

  on($('saveBtn'), 'click', saveAll);

  on($('openDirBtn'), 'click', async function () {
    if (desk() && desk().openDir) {
      desk().openDir(settings.dirName || state.lastOutDir || '');
      return;
    }
    if (state.dirHandle) {
      toast('浏览器无法打开资源管理器，文件已写入「' + state.dirHandle.name + '」，请用文件管理器访问');
    } else if (settings.dirName) {
      toast('输出目录：' + settings.dirName);
    } else {
      toast('默认输出目录是「' + defaultDirPath() + '」。浏览器版需要你选一次文件夹才能直接写入');
    }
  });

  on($('logBtn'), 'click', function () {
    var r = state.result;
    if (!r) return;
    var rep = r.res.report;
    var bd = rep.sizeBreakdown || {};
    var af = rep.afterBreakdown || {};
    var lines = [
      '文件：' + (r.name || ''),
      '模式：' + (rep.modeLabel || r.opts.mode),
      '',
      '【体积】（ZIP 文件大小，用户实际占用）',
      '  原始：' + fmtBytes(rep.inputBytes),
      '  输出：' + fmtBytes(rep.outputBytes) + (rep.volumes > 1 ? '（' + rep.volumes + ' 卷，合计）' : ''),
      '  节省：' + (rep.inputBytes - rep.outputBytes >= 0 ? '' : '增大 ') + fmtBytes(Math.abs(rep.inputBytes - rep.outputBytes)),
      '  比例：(原始 − 处理后) ÷ 原始 = ' + Math.round((rep.inputBytes - rep.outputBytes) / Math.max(1, rep.inputBytes) * 1000) / 10 + '%',
      '',
      '【资源】（解压后字节数，与上面的口径不同，不能相加）',
      '  图片：' + fmtBytes(bd.image) + ' → ' + fmtBytes(af.image) +
        '　（' + (rep.imagesFound || 0) + ' 张位图，重编码 ' + rep.imagesProcessed + ' 张' +
        (rep.svgsTotal ? '，SVG ' + rep.svgsTotal + ' 个未动' : '') + '）',
      '  文本：' + fmtBytes(bd.text) + ' → ' + fmtBytes(af.text),
      '  字体：' + fmtBytes(bd.font) + ' → ' + fmtBytes(af.font) +
        '　（发现 ' + (rep.fontsTotal || 0) + ' 个，移除 ' + (rep.removedFonts || 0) + ' 个）',
      '  其他：' + fmtBytes(bd.other) + ' → ' + fmtBytes(af.other),
      '  合计：' + fmtBytes(rep.rawTotal || 0) + ' → ' + fmtBytes(rep.afterRawTotal || 0) +
        '　（ZIP 压缩比 ' + Math.round((rep.zipRatio || 0) * 100) + '%）',
      '',
      '【结构】',
      '  章节：' + rep.chapters + '　原始正文文件：' + rep.sourceDocuments,
      '  段落重建：' + rep.rebuiltParagraphs + '　div→p：' + rep.convertedBlocks,
      '  空段落删除：' + rep.removedEmptyParagraphs + '　空容器：' + rep.removedEmptyBlocks,
      '  旧样式表移除：' + rep.removedCssFiles + '　原样式表归一：' + rep.normalizedCssFiles,
      '  内联样式：保留 ' + rep.keptInlineStyles + ' / 移除 ' + rep.removedInlineStyles,
      '  死图引用删除：' + rep.removedDeadImages + '　未解析图片：' + rep.unresolvedImages,
      '  输出自检：' + (rep.verified ? '通过' : '发现问题 — ' + (rep.verifyIssues || []).join('；')),
      '  用时：' + (r.ms / 1000).toFixed(1) + ' 秒',
      '',
      '【提示】'
    ].concat((rep.warnings || []).length
      ? (rep.warnings || []).map(function (w, i) { return '  ' + (i + 1) + '. ' + w; })
      : ['  无']);
    openModal('处理日志', '<pre style="white-space:pre-wrap;font-size:12px;line-height:1.7;margin:0">' +
      esc(lines.join('\n')) + '</pre>', []);
  });

  /* ------------------------------------------------------------- 阅读窗口 */

  /*
   * 阅读窗口是"只读的独立渲染器"：
   *   - 书的内容放在 iframe 里，原书 CSS 再野也影响不到软件界面
   *   - 图片在取章时才转 data:，一本 500MB 的书不会因为预览就吃掉全部内存
   *   - 关闭时 closeBook() 丢掉解包数据，不残留
   *   - 不改动源文件，也不生成临时 EPUB
   */
  var reader = {
    book: null,
    idx: 0,
    style: 'original',           // original = 原书样式；reading = 阅读样式
    fontPx: Number(settings.readerFont) || 18,
    zoom: Number(settings.readerZoom) || 100,
    tocW: Number(settings.tocW) || 264,
    pathIndex: {},
    source: '',
    volume: 0,
    mode: 'read',              // read = 原书阅读；images = 图片浏览
    busy: false
  };

  function joinPath(baseFile, rel) {
    if (!rel) return '';
    if (/^[a-z][a-z0-9+.\-]*:/i.test(rel) || rel.indexOf('//') === 0) return rel;
    if (rel.charAt(0) === '/') return rel.slice(1);
    var dir = baseFile.indexOf('/') < 0 ? '' : baseFile.slice(0, baseFile.lastIndexOf('/'));
    var raw = (dir ? dir + '/' : '') + rel;
    var out = [];
    raw.split('/').forEach(function (seg) {
      if (!seg || seg === '.') return;
      if (seg === '..') out.pop();
      else out.push(seg);
    });
    return out.join('/');
  }

  /* 只做安全网，不重排：不改字号、不改行距、不改缩进 */
  function readerShellCss() {
    return [
      'html{background:#fff}',
      'body{margin:0;padding:26px 34px 72px;font-size:' + reader.fontPx + 'px;color:#1f2937;',
      '  -webkit-text-size-adjust:100%;word-wrap:break-word}',
      'img{max-width:100%;height:auto;cursor:zoom-in}',
      'svg{max-width:100%;height:auto}',
      'table{max-width:100%}',
      'pre{white-space:pre-wrap;word-break:break-word}',
      '.ef-missing{display:inline-block;padding:6px 10px;border:1px dashed #cbd5e1;border-radius:6px;',
      '  background:#f8fafc;color:#94a3b8;font-size:12px;text-indent:0}'
    ].join('\n');
  }

  /* 阅读样式：TXT 式的统一排版，用户主动选它时才生效 */
  function readingCss() {
    var f = reader.fontPx;
    return [
      'html,body{background:#fcfcfa !important}',
      'body{margin:0 auto !important;padding:34px 44px 96px !important;max-width:760px !important;',
      '  font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",Georgia,serif !important;',
      '  font-size:' + f + 'px !important;line-height:1.9 !important;color:#1b1b1b !important;',
      '  text-align:justify !important;letter-spacing:.01em}',
      'body *{font-family:inherit !important;color:inherit !important;background:none !important}',
      'p,div,li,dd,dt,blockquote,td,th{font-size:1em !important;line-height:1.9 !important}',
      'p{text-indent:2em !important;margin:0 0 .58em !important}',
      // 很多书用 <div> 当段落。只给"里面没有元素、纯文字"的 div 加缩进，
      // 否则会把图片容器、版式容器一起缩进，越改越乱。
      'div:not(:has(*)),section:not(:has(*)){text-indent:2em !important;margin:0 0 .58em !important}',
      'h1,h2,h3,h4,h5,h6{text-indent:0 !important;text-align:center !important;',
      '  line-height:1.5 !important;margin:1.2em 0 .9em !important;font-size:1.24em !important}',
      'p[align="center"],p[align="right"],.center,.title,.chapter-title,.subtitle{',
      '  text-indent:0 !important;text-align:center !important}',
      'img{max-width:100% !important;height:auto !important;display:block;margin:.9em auto}',
      'figure,figcaption{text-indent:0 !important;text-align:center !important}',
      'table{margin:1em auto !important;border-collapse:collapse;font-size:.95em !important}',
      'td,th{padding:4px 9px;border:1px solid #ddd}',
      'a{color:#1d4ed8 !important;text-decoration:none}'
    ].join('\n');
  }

  /* 点击图片 → 原图查看层（在 iframe 内部，不跨文档操作） */
  var ZOOM_SCRIPT = [
    '<script>(function(){',
    'var ov=null;',
    'function close(){ if(ov){ ov.remove(); ov=null; } }',
    'document.addEventListener("click",function(e){',
    '  var t=e.target;',
    '  if(ov && (t===ov||t.tagName==="DIV")){ close(); return; }',
    '  if(!t||t.tagName!=="IMG") return;',
    '  e.preventDefault();',
    '  close();',
    '  ov=document.createElement("div");',
    '  ov.style.cssText="position:fixed;inset:0;z-index:9999;background:rgba(17,24,39,.92);overflow:auto;cursor:zoom-out;padding:24px";',
    '  var im=document.createElement("img");',
    '  im.src=t.src;',
    '  im.style.cssText="display:block;margin:0 auto;max-width:none;width:"+t.naturalWidth+"px;height:auto;border-radius:6px";',
    '  ov.appendChild(im); document.body.appendChild(ov);',
    '});',
    'document.addEventListener("keydown",function(e){ if(e.key==="Escape") close(); });',
    '})();<\/script>'
  ].join('\n');

  function chapterDoc(rc) {
    var base = reader.style === 'original' ? (rc.css || '') : '';
    return '<!DOCTYPE html><html lang="' + esc(reader.book.language || 'zh-CN') + '"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>' + base + '</style>' +
      (reader.style === 'reading' ? '<style>' + readingCss() + '</style>' : '') +
      '<style>' + readerShellCss() + '</style>' +
      // 缩放放在最后一层，任何原书样式都盖不住它
      '<style>html{zoom:' + (reader.zoom / 100) + '}</style>' +
      '</head><body>' + rc.html + ZOOM_SCRIPT + '</body></html>';
  }

  async function openReader(source, opts) {
    opts = opts || {};
    if (reader.busy) return;
    var buf, title, label, cls;

    if (source === 'original') {
      if (!state.current) { toast('请先选择一本 EPUB', 'err'); return; }
      try {
        buf = state.current.buffer || (state.current.buffer = await state.current.file.arrayBuffer());
      } catch (e) { toast('读取文件失败：' + e.message, 'err'); return; }
      title = (state.current.info && state.current.info.title) || state.current.file.name.replace(/\.epub$/i, '');
      label = '原书';
      cls = '';
    } else {
      var r = state.result;
      if (!r) { toast('还没有处理结果', 'err'); return; }
      var vi = opts.volume || 0;
      var vols = r.res.volumes || [];
      var v = vols[vi];
      if (!v) { toast('找不到可预览的输出文件', 'err'); return; }
      buf = v.bytes;
      title = v.fileName.replace(/\.epub$/i, '');
      label = vols.length > 1 ? '第 ' + (vi + 1) + ' / ' + vols.length + ' 卷' : '处理结果';
      cls = ' is-out';
    }

    $('rdLoading').hidden = false;
    $('reader').hidden = false;
    reader.busy = true;
    try {
      var book = await EpubFix.openBook(buf);
      closeReader(true);              // 先放掉上一本
      reader.book = book;
      reader.source = source;
      reader.volume = opts.volume || 0;
      reader.pathIndex = {};
      book.chapters.forEach(function (c, i) {
        reader.pathIndex[c.path] = i;
        reader.pathIndex[c.path.toLowerCase()] = i;
      });

      $('rdTitle').textContent = title || book.title || '未命名';
      $('rdTitle').title = title || '';
      $('rdSource').textContent = label;
      $('rdSource').className = 'rd-chip' + cls;
      $('rdMeta').textContent = [
        book.creator ? '作者 ' + book.creator : '未标注作者',
        book.chapters.length + ' 章',
        book.stats.images ? book.stats.images + ' 图' : '无图',
        book.stats.fonts ? book.stats.fonts + ' 字体' : '无内嵌字体'
      ].join('　·　');

      buildToc();
      applyReaderLayout();
      setReaderMode('read');

      // 从原书切到处理结果（或反过来）时，尽量停在同一章，方便直接对比
      var startIdx = 0;
      if (opts.matchTitle) {
        var want = String(opts.matchTitle).trim();
        for (var mi = 0; mi < book.chapters.length; mi++) {
          var ct = (book.chapters[mi].title || '').trim();
          if (!ct) continue;
          if (ct === want || ct.indexOf(want) >= 0 || want.indexOf(ct) >= 0) { startIdx = mi; break; }
        }
      }
      renderChapter(startIdx, true);
      updateSwapBtn();
    } catch (e) {
      $('reader').hidden = true;
      toast('打不开这本书：' + e.message, 'err');
    } finally {
      reader.busy = false;
      $('rdLoading').hidden = true;
    }
  }

  function buildToc() {
    var book = reader.book;
    var toc = book.toc && book.toc.length ? book.toc : book.chapters.map(function (c, i) {
      return { title: c.title, index: i, level: 0 };
    });
    $('rdTocCount').textContent = toc.length + ' 项 / ' + book.chapters.length + ' 章';
    if (!toc.length) {
      $('rdToc').innerHTML = '<li class="rd-toc-empty">这本书没有可识别的目录。' +
        '章节仍可按正文顺序翻页，用底部的上一章 / 下一章。</li>';
      return;
    }
    $('rdToc').innerHTML = toc.map(function (t, i) {
      var lv = Math.min(2, t.level || 0);
      return '<li data-i="' + i + '" data-ch="' + t.index + '"' +
        (lv ? ' class="lv' + lv + '"' : '') +
        ' title="' + esc(t.title) + '">' + esc(t.title) + '</li>';
    }).join('');
    $$('#rdToc li[data-ch]').forEach(function (li) {
      on(li, 'click', function () {
        renderChapter(Number(li.dataset.ch));
      });
    });
  }

  function setActiveToc(chIdx) {
    var hit = null;
    $$('#rdToc li[data-ch]').forEach(function (li) {
      var on2 = Number(li.dataset.ch) === chIdx;
      li.classList.toggle('is-active', on2);
      if (on2 && !hit) hit = li;
    });
    // 目录很长时，把当前项滚进视野，但不要带动正文
    if (hit) {
      var list = $('rdToc');
      var top = hit.offsetTop - list.clientHeight / 2 + hit.offsetHeight / 2;
      list.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  }

  function renderChapter(i, resetScroll) {
    var book = reader.book;
    if (!book) return;
    var ch = book.chapters[i];
    if (!ch) return;

    reader.idx = i;
    $('rdChapterTitle').textContent = ch.title || '正文';
    $('rdChapterTitle').title = ch.title || '';
    $('rdPos').textContent = '第 ' + (i + 1) + ' / ' + book.chapters.length + ' 章';
    $('rdPrev').disabled = i <= 0;
    $('rdNext').disabled = i >= book.chapters.length - 1;
    setActiveToc(i);

    var rc;
    try {
      rc = EpubFix.readChapter(book, i);
    } catch (e) {
      toast('读取章节失败：' + e.message, 'err');
      return;
    }

    // 缺图不隐藏，标出来——隐藏等于把问题藏起来
    var html = rc.html.replace(/<img[^>]*data-efmissing="([^"]*)"[^>]*>/gi, function (all, src) {
      var s = src || '';
      try { s = decodeURIComponent(s); } catch (e) { /* 编码坏了就原样显示 */ }
      return '<span class="ef-missing">图片缺失：' + esc(s) + '</span>';
    });

    reader.pending = chapterDoc({ html: html, css: rc.css });
    $('rdLoading').hidden = false;
    $('rdFrame').srcdoc = reader.pending;
    reader.revealed = !!resetScroll;
  }

  /* iframe 载入完成：装内部链接跳转、清掉加载态 */
  on($('rdFrame'), 'load', function () {
    $('rdLoading').hidden = true;
    var f = $('rdFrame');
    var doc = f.contentDocument;
    if (!doc || !reader.book) return;

    var ch = reader.book.chapters[reader.idx];
    doc.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#') return;
      if (/^[a-z][a-z0-9+.\-]*:/i.test(href)) return;
      ev.preventDefault();
      var bare = href.split('#')[0];
      var abs = joinPath(ch.path, bare);
      var idx = reader.pathIndex[abs];
      if (idx == null) idx = reader.pathIndex[String(abs).toLowerCase()];
      if (idx != null) renderChapter(idx);
      else toast('这个链接指向的内容不在本书里：' + bare, 'err');
    });
  });

  function applyReaderLayout() {
    document.getElementById('reader').style.setProperty('--toc-w', reader.tocW + 'px');
    $('rdZoomVal').textContent = reader.zoom + '%';
    $$('#rdStyleSeg .rd-seg-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.style === reader.style);
    });
    // 原书样式下字号由书自己决定，只能缩放；阅读样式下才谈得上调字号
    var orig = reader.style === 'original';
    $('rdFontMinus').disabled = orig;
    $('rdFontPlus').disabled = orig;
    $('rdFontMinus').title = orig ? '原书样式的字号由书籍自身决定，切到「阅读样式」可调整' : '缩小字号';
    $('rdFontPlus').title = $('rdFontMinus').title;
  }

  function saveReaderPrefs() {
    settings.readerFont = reader.fontPx;
    settings.readerZoom = reader.zoom;
    settings.tocW = reader.tocW;
    saveSettings();
  }

  function closeReader(keepVisible) {
    lbClose();
    if (gallery.obs) { gallery.obs.disconnect(); gallery.obs = null; }
    // 图片浏览借来的 object URL 与缩略图缓存必须一起放掉，
    // 否则来回开几本书，内存只涨不落。
    gallery.urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    gallery.urls = [];
    gallery.images = [];
    gallery.view = [];
    gallery.byPath = {};
    gallery.fullOrder = [];
    if (gallery.origBook) { try { EpubFix.closeBook(gallery.origBook); } catch (e) {} }
    gallery.origBook = null;
    gallery.origMap = null;
    if (reader.book) {
      try { EpubFix.closeBook(reader.book); } catch (e) { /* 已经关过了 */ }
    }
    reader.book = null;
    $('galGrid').innerHTML = '';
    $('rdFrame').srcdoc = '<!DOCTYPE html><body></body>';
    if (!keepVisible) $('reader').hidden = true;
  }

  on($('rdClose'), 'click', function () { closeReader(); });
  on(document, 'keydown', function (e) {
    // 大图层在上，方向键先给图片翻页
    if (!$('lightbox').hidden) {
      if (e.key === 'Escape') { lbClose(); return; }
      if (e.key === 'ArrowLeft') { lbNav(-1); return; }
      if (e.key === 'ArrowRight') { lbNav(1); return; }
      return;
    }
    if ($('reader').hidden) return;
    if (e.key === 'Escape') { closeReader(); return; }
    if (reader.mode === 'images') return;
    if (e.key === 'ArrowLeft') $('rdPrev').click();
    if (e.key === 'ArrowRight') $('rdNext').click();
  });


  /* 原书 ⇄ 处理结果：保留当前章节与阅读样式，直接对照同一段文字 */
  function updateSwapBtn() {
    var btn = $('rdSwap');
    if (!btn) return;
    var hasResult = !!(state.result && state.result.res && (state.result.res.volumes || []).length);
    var show = reader.source === 'result' || hasResult;
    btn.hidden = !show;
    if (show) $('rdSwapLabel').textContent = reader.source === 'result' ? '回原书对照' : '看处理结果';
  }

  on($('rdSwap'), 'click', function () {
    if (reader.busy || !reader.book) return;
    var ch = reader.book.chapters[reader.idx];
    var wantTitle = (ch && ch.title) || '';
    var to = reader.source === 'result' ? 'original' : 'result';
    var vol = reader.volume;
    closeReader(true);
    openReader(to, { volume: vol, matchTitle: wantTitle });
  });

  on($('rdPrev'), 'click', function () {
    if (reader.idx > 0) renderChapter(reader.idx - 1, true);
  });
  on($('rdNext'), 'click', function () {
    if (reader.book && reader.idx < reader.book.chapters.length - 1) renderChapter(reader.idx + 1, true);
  });

  $$('#rdStyleSeg .rd-seg-btn').forEach(function (b) {
    on(b, 'click', function () {
      reader.style = b.dataset.style;
      applyReaderLayout();
      renderChapter(reader.idx, true);
    });
  });

  on($('rdFontMinus'), 'click', function () {
    reader.fontPx = Math.max(13, reader.fontPx - 1);
    saveReaderPrefs();
    renderChapter(reader.idx, false);
  });
  on($('rdFontPlus'), 'click', function () {
    reader.fontPx = Math.min(28, reader.fontPx + 1);
    saveReaderPrefs();
    renderChapter(reader.idx, false);
  });

  function setZoom(z) {
    reader.zoom = Math.max(60, Math.min(220, Math.round(z / 10) * 10));
    saveReaderPrefs();
    applyReaderLayout();
    renderChapter(reader.idx, false);
  }
  on($('rdZoomIn'), 'click', function () { setZoom(reader.zoom + 10); });
  on($('rdZoomOut'), 'click', function () { setZoom(reader.zoom - 10); });
  on($('rdZoomReset'), 'click', function () { setZoom(100); });

  /* 目录与正文之间的分隔线：拖动改宽度，只影响目录，正文自动占满剩下的 */
  (function initSplitter() {
    var split = $('rdSplit');
    var dragging = false;
    function onMove(e) {
      if (!dragging) return;
      var body = $('rdBody').getBoundingClientRect();
      var w = e.clientX - body.left - 12;
      var max = Math.max(220, body.width * 0.55);
      reader.tocW = Math.max(180, Math.min(max, w));
      document.getElementById('reader').style.setProperty('--toc-w', reader.tocW + 'px');
    }
    function stop() {
      if (!dragging) return;
      dragging = false;
      split.classList.remove('is-drag');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      saveReaderPrefs();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', stop);
    }
    on(split, 'mousedown', function (e) {
      e.preventDefault();
      dragging = true;
      split.classList.add('is-drag');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', stop);
    });
    // 触屏 / 触控板也能拖
    split.addEventListener('touchstart', function (e) {
      dragging = true;
      split.classList.add('is-drag');
      var t = e.touches[0];
      var move = function (ev) { onMove(ev.touches[0]); };
      var end = function () {
        dragging = false;
        split.classList.remove('is-drag');
        saveReaderPrefs();
        split.removeEventListener('touchmove', move);
        split.removeEventListener('touchend', end);
      };
      split.addEventListener('touchmove', move, { passive: true });
      split.addEventListener('touchend', end);
      onMove(t);
    }, { passive: true });
  })();

  /* ------------------------------------------------- 图片浏览（新增模式） */

  /*
   * 和"原书阅读"共用同一本已解包的书（openBook 里已列好图片清单），
   * 不再二次解包、也不改源文件。
   * 缩略图按需生成：只有滚到视口附近才解码，并缩到 320px 以内再丢掉位图，
   * 所以 500 多张图的书不会一次性把内存吃满。
   */
  var gallery = {
    images: [],
    view: [],
    byPath: {},
    fullOrder: [],
    idx: 0,
    zoom: 0,           // 0 = 适应窗口；其它为百分比
    compare: false,
    obs: null,
    urls: [],
    origBook: null,
    origMap: null
  };

  function trackUrl(u) { if (u) gallery.urls.push(u); return u; }

  function imageMetaLine(im) {
    return [
      im.width ? im.width + '×' + im.height : '尺寸未知',
      fmtBytes(im.bytes),
      im.format,
      im.referenced ? '正文引用' : '未被引用'
    ].join('　·　');
  }

  function imageChapterText(im) {
    if (!im.chapters || !im.chapters.length) return im.usedInCss ? '样式表引用' : '';
    var ch = reader.book && reader.book.chapters[im.chapters[0]];
    return '第 ' + (im.chapters[0] + 1) + ' 章' + (ch && ch.title ? '：' + ch.title : '');
  }

  function galCardHtml(im, i) {
    var tags = '';
    if (!im.referenced) tags += '<span class="gal-tag is-warn">未引用</span>';
    if (im.vector) tags += '<span class="gal-tag"' + (im.referenced ? '' : ' style="top:26px"') + '>SVG</span>';
    /*
     * 这里用 div[role=button] 而不是 <button>：Chromium 给 button 套了一层匿名
     * flex 容器，里面的缩略图拿不到确定宽度，aspect-ratio 会算成 0 高（实测 7×7），
     * 整个网格就塌成一条。换成 div 后宽度由网格列决定，缩略图才能按比例显示。
     */
    return '<div class="gal-card" role="button" tabindex="0" data-i="' + i + '" title="' + esc(im.path) + '">' +
      '<span class="gal-thumb" data-path="' + esc(im.path) + '">' + tags +
        '<span class="gal-ph">载入中…</span></span>' +
      '<span class="gal-info">' +
        '<span class="gal-name">' + esc(im.name) + '</span>' +
        '<span class="gal-sub">' +
          esc([im.width ? im.width + '×' + im.height : '尺寸未知', fmtBytes(im.bytes), im.format].join(' · ')) +
        '</span>' +
        '<span class="gal-sub">' + esc(imageChapterText(im) || '未在任何章节中出现') + '</span>' +
      '</span></div>';
  }

  function putThumb(el, url) {
    el.dataset.state = 'ok';
    el.insertAdjacentHTML('beforeend', '<img alt="" src="' + url + '" />');
    var ph = el.querySelector('.gal-ph');
    if (ph) ph.remove();
  }

  function thumbFail(el, why) {
    el.dataset.state = 'error';
    var ph = el.querySelector('.gal-ph');
    if (ph) ph.textContent = why;
  }

  function loadThumb(el) {
    var path = el.dataset.path;
    if (!path || el.dataset.state) return;
    var im = gallery.byPath[path];
    if (!im) return;
    el.dataset.state = 'loading';
    if (im._thumb) { putThumb(el, im._thumb); return; }

    var r;
    try {
      r = EpubFix.readImage(reader.book, path);
    } catch (e) {
      thumbFail(el, '预览已关闭');
      return;
    }
    if (!r) { thumbFail(el, '文件不存在'); return; }

    var blob = new Blob([r.bytes], { type: r.mediaType });
    if (im.vector) {
      // 矢量图直接用原文件：浏览器自己缩放，比先栅格化再缩清楚
      im._thumb = trackUrl(URL.createObjectURL(blob));
      putThumb(el, im._thumb);
      return;
    }

    createImageBitmap(blob).then(function (bm) {
      var max = 320;
      var scale = Math.min(1, max / Math.max(bm.width || 1, bm.height || 1));
      var w = Math.max(1, Math.round((bm.width || 1) * scale));
      var h = Math.max(1, Math.round((bm.height || 1) * scale));
      var cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      cv.getContext('2d').drawImage(bm, 0, 0, w, h);
      if (bm.close) bm.close();
      im._thumb = cv.toDataURL('image/jpeg', 0.82);
      cv.width = cv.height = 1;
      putThumb(el, im._thumb);
    }).catch(function () {
      // 浏览器解不了这种格式（例如 HEIC）时直说，不要留一个白框
      thumbFail(el, im.format + ' 无法在当前环境解码');
    });
  }

  function observeThumbs() {
    if (gallery.obs) { gallery.obs.disconnect(); gallery.obs = null; }
    var grid = $('galGrid');
    if (!('IntersectionObserver' in window)) {
      $$('#galGrid .gal-thumb').forEach(loadThumb);
      return;
    }
    gallery.obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        gallery.obs.unobserve(en.target);
        loadThumb(en.target);
      });
    }, { root: grid, rootMargin: '420px 0px' });
    $$('#galGrid .gal-thumb').forEach(function (el) { gallery.obs.observe(el); });
  }

  function currentFilter() {
    return {
      q: ($('galSearch').value || '').trim().toLowerCase(),
      sort: $('galSort').value,
      used: $('galOnlyUsed').checked,
      min: $('galMinSize').value
    };
  }

  function passesFilter(im, f) {
    if (f.used && !im.referenced) return false;
    if (f.q && im.name.toLowerCase().indexOf(f.q) < 0 && im.path.toLowerCase().indexOf(f.q) < 0) return false;
    if (f.min === '500k') {
      if (im.bytes < 500 * 1024) return false;
    } else if (f.min !== 'all') {
      if (Math.max(im.width || 0, im.height || 0) < Number(f.min)) return false;
    }
    return true;
  }

  function renderGallery() {
    var book = reader.book;
    if (!book) return;
    gallery.images = (book.images || []).slice();
    gallery.byPath = {};
    gallery.images.forEach(function (im) { gallery.byPath[im.path] = im; });

    var totalBytes = gallery.images.reduce(function (sum, i) { return sum + i.bytes; }, 0);
    var used = gallery.images.filter(function (i) { return i.referenced; }).length;
    $('galSummary').textContent = gallery.images.length
      ? '共 ' + gallery.images.length + ' 张 · ' + used + ' 张被引用 · ' +
        (gallery.images.length - used) + ' 张未被引用 · 合计 ' + fmtBytes(totalBytes)
      : '';
    applyGalleryFilter();
  }

  function applyGalleryFilter() {
    var f = currentFilter();
    var list = gallery.images.filter(function (im) { return passesFilter(im, f); });
    if (f.sort === 'size') list.sort(function (a, b) { return b.bytes - a.bytes; });
    else if (f.sort === 'pixels') list.sort(function (a, b) { return (b.width * b.height) - (a.width * a.height); });
    else if (f.sort === 'name') list.sort(function (a, b) { return a.name.localeCompare(b.name); });
    else list.sort(function (a, b) { return a.order - b.order; });
    gallery.view = list;
    $('galCount').textContent = list.length;

    var grid = $('galGrid');
    var st = $('galState');
    if (!gallery.images.length) {
      grid.innerHTML = '';
      st.hidden = false;
      st.innerHTML = '这本书里没有图片资源。<br>图片浏览只读原包，不会改动 EPUB。';
      return;
    }
    if (!list.length) {
      grid.innerHTML = '';
      st.hidden = false;
      st.innerHTML = '当前筛选条件下没有图片。<br>放宽筛选条件或清空搜索再试。';
      return;
    }
    st.hidden = true;
    grid.innerHTML = list.map(galCardHtml).join('');
    $$('#galGrid .gal-card').forEach(function (b) {
      on(b, 'click', function () { lbOpen(Number(b.dataset.i)); });
      on(b, 'keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          lbOpen(Number(b.dataset.i));
        }
      });
    });
    observeThumbs();
    grid.scrollTop = 0;
  }

  /* ---------------- 大图查看 ---------------- */

  function fullUrlFor(im) {
    if (im._full) return im._full;
    var r;
    try { r = EpubFix.readImage(reader.book, im.path); } catch (e) { return ''; }
    if (!r) return '';
    im._full = trackUrl(URL.createObjectURL(new Blob([r.bytes], { type: r.mediaType })));
    gallery.fullOrder.push(im.path);
    // 只留最近 4 张原图，其余立即释放
    while (gallery.fullOrder.length > 4) {
      var old = gallery.byPath[gallery.fullOrder.shift()];
      if (old && old._full) { try { URL.revokeObjectURL(old._full); } catch (e) {} old._full = ''; }
    }
    return im._full;
  }

  function updateLbZoom() {
    var stage = $('lbStage');
    var imgs = [$('lbImg'), $('lbImgB')];
    if (!gallery.zoom) {
      stage.classList.add('is-fit');
      imgs.forEach(function (im) { im.style.width = ''; im.style.height = ''; });
      $('lbZoomVal').textContent = '适应';
      return;
    }
    stage.classList.remove('is-fit');
    var pct = gallery.zoom / 100;
    imgs.forEach(function (im) {
      if (!im.getAttribute('src') || !im.naturalWidth) return;
      im.style.width = Math.round(im.naturalWidth * pct) + 'px';
      im.style.height = 'auto';
    });
    $('lbZoomVal').textContent = gallery.zoom + '%';
  }

  function lbOpen(i) {
    if (!gallery.view.length) return;
    gallery.idx = Math.max(0, Math.min(gallery.view.length - 1, i));
    var im = gallery.view[gallery.idx];

    gallery.zoom = 0;
    gallery.compare = false;
    $('lbPaneB').hidden = true;
    $('lbImgB').removeAttribute('src');
    $('lbStage').classList.remove('is-compare');
    $('lbCompare').classList.remove('is-active');
    $('lbCapA').textContent = '处理后';
    $('lbCapB').textContent = '原书';

    var url = fullUrlFor(im);
    if (url) $('lbImg').src = url;
    else {
      $('lbImg').removeAttribute('src');
      $('lbFoot').textContent = '这个文件读不出来：' + im.path;
    }

    $('lbName').textContent = im.name;
    $('lbName').title = im.path;
    $('lbMeta').textContent = imageMetaLine(im) + '　·　' + (imageChapterText(im) || '未在任何章节中出现');
    $('lbPrev').disabled = gallery.idx <= 0;
    $('lbNext').disabled = gallery.idx >= gallery.view.length - 1;

    var canCompare = reader.source === 'result';
    $('lbCompare').disabled = !canCompare;
    $('lbCompare').title = canCompare
      ? '与原书同一路径的那张图并排对比'
      : '只有从结果页打开的「处理后的书」才能和原书对比';

    $('lightbox').hidden = false;
    updateLbZoom();
    if (url) {
      $('lbFoot').textContent = '文件：' + im.path + '　·　第 ' + (gallery.idx + 1) +
        ' / ' + gallery.view.length + ' 张　·　图片浏览只读原包，不会改动 EPUB';
    }
  }

  function lbNav(delta) {
    var next = gallery.idx + delta;
    if (next < 0 || next >= gallery.view.length) return;
    lbOpen(next);
  }

  function lbClose() {
    if (!gallery.view.length && $('lightbox').hidden) return;
    $('lightbox').hidden = true;
    $('lbImg').removeAttribute('src');
    $('lbImgB').removeAttribute('src');
    $('lbPaneB').hidden = true;
    $('lbStage').classList.remove('is-compare');
    gallery.compare = false;
  }

  async function ensureOrigBook() {
    if (gallery.origBook) return true;
    if (!state.current) return false;
    var buf = state.current.buffer || (state.current.buffer = await state.current.file.arrayBuffer());
    gallery.origBook = await EpubFix.openBook(buf);
    gallery.origMap = {};
    (gallery.origBook.images || []).forEach(function (im) {
      gallery.origMap[im.path.toLowerCase()] = im;
    });
    return true;
  }

  /*
   * 找原书里"同一张图"。
   * 处理后图片常被转成 JPEG，路径会从 p1.png 变成 p1.jpg，
   * 所以先按完整路径找，找不到再按去掉扩展名的文件名找；
   * 同名有多张就直接说"无法确定"，绝不拿相似的图凑数。
   */
  function findOrigImage(im) {
    var exact = gallery.origMap[im.path.toLowerCase()];
    if (exact) return { im: exact, how: 'path' };
    var stem = im.name.replace(/\.[^.]+$/, '').toLowerCase();
    if (!stem) return null;
    var cands = (gallery.origBook.images || []).filter(function (o) {
      return o.name.replace(/\.[^.]+$/, '').toLowerCase() === stem;
    });
    if (cands.length === 1) return { im: cands[0], how: 'name' };
    if (cands.length > 1) return { ambiguous: cands.length };
    return null;
  }

  async function lbToggleCompare() {
    var im = gallery.view[gallery.idx];
    if (!im) return;

    if (gallery.compare) {
      gallery.compare = false;
      $('lbPaneB').hidden = true;
      $('lbStage').classList.remove('is-compare');
      $('lbCompare').classList.remove('is-active');
      gallery.zoom = 0;
      updateLbZoom();
      $('lbFoot').textContent = '文件：' + im.path + '　·　第 ' + (gallery.idx + 1) + ' / ' + gallery.view.length + ' 张';
      return;
    }

    if (reader.source !== 'result') {
      toast('对比需要「原书」与「处理后的书」里同一路径的两张图，请从结果页打开预览', 'err');
      return;
    }

    $('lbCompare').disabled = true;
    var ok = false;
    try { ok = await ensureOrigBook(); } catch (e) { toast('打不开原书：' + e.message, 'err'); }
    $('lbCompare').disabled = false;
    if (!ok) { toast('没有可对比的原书文件', 'err'); return; }

    var hit = findOrigImage(im);
    if (hit && hit.ambiguous) {
      toast('原书里有 ' + hit.ambiguous + ' 张同名图片（' + im.name + '），无法确定是哪一张，所以不做对比', 'err');
      return;
    }
    if (!hit) {
      toast('原书里没有能对上的图片（' + im.path + '），无法确认是同一张，所以不做对比', 'err');
      return;
    }
    var o = hit.im;
    var r;
    try { r = EpubFix.readImage(gallery.origBook, o.path); } catch (e) { r = null; }
    if (!r) { toast('原书里这张图读不出来', 'err'); return; }

    var howText = hit.how === 'path'
      ? '同一路径'
      : '按文件名匹配（原书 ' + o.name + '，处理后 ' + im.name + '，扩展名已变）';
    $('lbImgB').src = trackUrl(URL.createObjectURL(new Blob([r.bytes], { type: r.mediaType })));
    $('lbCapA').textContent = '处理后 · ' + fmtBytes(im.bytes) + (im.width ? ' · ' + im.width + '×' + im.height : '');
    $('lbCapB').textContent = '原书 · ' + fmtBytes(o.bytes) + (o.width ? ' · ' + o.width + '×' + o.height : '');
    $('lbPaneB').hidden = false;
    $('lbStage').classList.add('is-compare');
    $('lbCompare').classList.add('is-active');
    gallery.compare = true;
    gallery.zoom = 0;
    updateLbZoom();
    $('lbFoot').textContent = howText + '。左边是处理后的文件，右边是原书里那张；' +
      '体积差就是这次的压缩效果，画质请自己判断。';
  }

  function setReaderMode(m) {
    reader.mode = m;
    $$('#rdModeSeg .rd-seg-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.mode === m);
    });
    $('rdBody').classList.toggle('is-images', m === 'images');
    $('rdGallery').hidden = m !== 'images';
    document.getElementById('reader').classList.toggle('is-images', m === 'images');
    if (m === 'images') renderGallery();
  }

  $$('#rdModeSeg .rd-seg-btn').forEach(function (b) {
    on(b, 'click', function () { setReaderMode(b.dataset.mode); });
  });

  ['#galSearch', '#galSort', '#galOnlyUsed', '#galMinSize'].forEach(function (sel) {
    var el = $(sel.slice(1));
    on(el, sel === '#galSearch' ? 'input' : 'change', function () {
      if (!reader.book || reader.mode !== 'images') return;
      applyGalleryFilter();
    });
  });

  on($('lbClose'), 'click', lbClose);
  on($('lightbox'), 'click', function (e) {
    if (e.target.dataset && e.target.dataset.lb === 'close') lbClose();
  });
  on($('lbPrev'), 'click', function () { lbNav(-1); });
  on($('lbNext'), 'click', function () { lbNav(1); });
  on($('lbFit'), 'click', function () { gallery.zoom = 0; updateLbZoom(); });
  on($('lbActual'), 'click', function () { gallery.zoom = 100; updateLbZoom(); });
  on($('lbZoomIn'), 'click', function () {
    gallery.zoom = Math.min(400, (gallery.zoom || 100) + 20);
    updateLbZoom();
  });
  on($('lbZoomOut'), 'click', function () {
    gallery.zoom = Math.max(20, (gallery.zoom || 100) - 20);
    updateLbZoom();
  });
  on($('lbCompare'), 'click', lbToggleCompare);
  on($('lbImg'), 'load', function () { if (gallery.zoom) updateLbZoom(); });
  on($('lbImgB'), 'load', function () { if (gallery.zoom) updateLbZoom(); });
  on($('lbImg'), 'error', function () {
    $('lbFoot').textContent = '这张图片无法在当前环境解码，已跳过显示（文件仍然完整保留在 EPUB 里）。';
  });

  on($('previewBookBtn'), 'click', function (e) {
    e.stopPropagation();
    openReader('original');
  });
  on($('previewBtn'), 'click', function () { openReader('result'); });
  on($('previewSrcBtn'), 'click', function () { openReader('original'); });


  /* --------------------------------------------------------- 结构检查 */

  on($('diagBtn'), 'click', async function (e) {
    e.stopPropagation();
    if (!state.current || !state.current.buffer) { toast('请先选择文件', 'err'); return; }
    var d = state.current.diag || (await EpubFix.diagnose(state.current.buffer));
    state.current.diag = d;

    var lvName = { error: '错误', warn: '提示', info: '信息' };
    var html = '<div class="issue-list">';
    if (!d.issues.length) {
      html += '<div class="issue issue-info"><span class="issue-lv">正常</span>' +
        '<span class="issue-msg">没有发现结构问题，可以直接处理。</span></div>';
    } else {
      d.issues.forEach(function (it) {
        html += '<div class="issue issue-' + it.level + '">' +
          '<span class="issue-lv">' + lvName[it.level] + '</span>' +
          '<span class="issue-msg">' + esc(it.message) +
          (it.detail ? '<div class="issue-detail">' + esc(it.detail) + '</div>' : '') +
          '</span></div>';
      });
    }
    html += '</div>';

    var summary = '<p style="margin-bottom:10px;color:#6b7a94">EPUB ' + esc(d.info.version || '2') +
      '　' + d.info.docs + ' 个正文文件　' + d.info.chapters + ' 章　' +
      d.info.images + ' 张图（' + fmtBytes(d.info.imageBytes) + '）　' +
      d.info.fonts + ' 个字体　' + d.info.css + ' 份样式表</p>';

    openModal('结构检查', summary + html, [
      {
        text: '一键修复并优化', primary: true, fn: function () {
          closeModal();
          runSingle();
        }
      }
    ]);
  });

  /* ------------------------------------------------------------- 弹窗 */

  var modal = $('modal');
  var modalAction = null;

  function openModal(title, bodyHtml, actions) {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = bodyHtml;
    var foot = $('modalFoot');
    foot.innerHTML = '';
    (actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = a.primary ? 'btn-primary' : 'btn-ghost';
      b.textContent = a.text;
      b.onclick = a.fn;
      foot.appendChild(b);
    });
    modal.hidden = false;
  }
  function closeModal() { modal.hidden = true; modalAction = null; }
  on(modal, 'click', function (e) {
    if (e.target.dataset.close) closeModal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  on($('aboutBtn'), 'click', function () { showView('about'); });

  /* ------------------------------------------------------------- 关于 */

  function fillAbout() {
    var el = $('aboutRuntime');
    if ($('aboutShell')) {
      $('aboutShell').textContent = window.emDesktop
        ? 'Electron ' + (window.emDesktop.version || '') + ' 外壳，界面与处理逻辑和网页版完全同一份代码'
        : '浏览器环境（网页版），功能与桌面版一致，只是保存方式跟随浏览器';
    }
    if (el) {
      el.textContent = window.emDesktop ? '桌面版' : '浏览器版';
      el.className = 'chip ' + (window.emDesktop ? 'chip-ok' : 'chip-info');
    }
  }

  on($('checkUpdateBtn'), 'click', function () {
    var note = $('updateNote');
    // 没有更新服务器就直说，不做假的"检查中→已是最新"
    if (window.emDesktop && window.emDesktop.checkUpdate) {
      note.textContent = '正在检查…';
      window.emDesktop.checkUpdate().then(function (r) {
        note.textContent = r && r.message ? r.message : '当前已是最新版本。';
      }).catch(function (e) {
        note.textContent = '检查失败：' + e.message;
      });
      return;
    }
    note.textContent = '当前为离线构建（v2.2.0），没有配置更新服务器，' +
      '也就无法自动升级——需要新版本请手动替换程序文件。';
  });

  /* ------------------------------------------------------------- 输出目录 */

  /*
   * 默认输出目录 = 当前用户的「下载」目录下的 EPUB_Master。
   * 桌面版由 Electron 给出真实路径并负责建目录；浏览器版拿不到绝对路径，
   * 所以第一次保存时让用户选一次文件夹（选择器直接落在下载目录），之后记住。
   */
  var DEFAULT_DIR_NAME = 'EPUB_Master';

  function desk() { return window.emDesktop || null; }

  function defaultDirPath() {
    var d = desk();
    if (d && d.defaultDir) return d.defaultDir;
    return '下载\\' + DEFAULT_DIR_NAME;
  }

  async function pickDir() {
    if (desk() && desk().pickDir) {
      try {
        var p = await desk().pickDir();
        if (p) {
          settings.dirName = p;
          state.dirHandle = null;
          saveSettings();
          refreshDirUi();
          toast('输出目录：' + p, 'ok');
        }
        return;
      } catch (e) {
        toast('选择目录失败：' + e.message, 'err');
        return;
      }
    }

    if (!window.showDirectoryPicker) {
      toast('当前环境不支持选择目录，结果会以下载方式保存', 'err');
      return;
    }
    try {
      var h = await window.showDirectoryPicker({
        mode: 'readwrite', id: 'epubmaster-out', startIn: 'downloads'
      });
      state.dirHandle = h;
      settings.dirName = h.name;
      saveSettings();
      await idbSet('dir', h);
      refreshDirUi();
      toast('输出目录：' + h.name, 'ok');
    } catch (e) {
      if (e.name !== 'AbortError') toast('选择目录失败：' + e.message, 'err');
    }
  }

  on($('dirPickBtn'), 'click', pickDir);
  on($('setDirBtn'), 'click', pickDir);
  on($('setDirResetBtn'), 'click', async function () {
    settings.dirName = '';
    state.dirHandle = null;
    saveSettings();
    try { await idbSet('dir', null); } catch (e) { /* 忽略 */ }
    refreshDirUi();
    toast('已恢复默认输出目录：' + defaultDirPath(), 'ok');
  });

  function refreshDirUi() {
    var chosen = settings.dirName || '';
    var shown = chosen || defaultDirPath();
    $('dirText').textContent = shown;
    $('dirText').title = shown;
    $('setDir').value = chosen;
    $('setDir').placeholder = '默认：' + defaultDirPath();
    $('setDirDesc').textContent = chosen
      ? '你手动选择的目录，会被记住；点「恢复默认」回到下载目录'
      : '未选择时自动用「' + defaultDirPath() + '」，不存在会自动创建';
  }

  async function restoreDir() {
    var h = await idbGet('dir');
    if (!h) return;
    try {
      var p = await h.queryPermission({ mode: 'readwrite' });
      state.dirHandle = h;
      if (p !== 'granted') {
        // 不主动弹权限框，等用户点保存时再要
        $('dirText').textContent = (h.name || '') + '（需授权）';
        return;
      }
      refreshDirUi();
    } catch (e) { /* 句柄失效就用下载 */ }
  }

  /* 同名文件不覆盖：已有就加 (2)(3) */
  async function freeName(h, name) {
    var base = name.replace(/\.epub$/i, '');
    var n = name;
    var i = 2;
    for (var guard = 0; guard < 200; guard++) {
      try {
        await h.getFileHandle(n);
      } catch (e) {
        return n;   // 取不到就是不存在，可以写
      }
      n = base + ' (' + i + ').epub';
      i++;
    }
    return base + ' (' + Date.now() + ').epub';
  }

  /* ------------------------------------------------------------- 批量 */

  function addToBatch(files) {
    var added = 0;
    files.forEach(function (f) {
      if (!isEpub(f)) return;
      // 同名同大小视为重复
      var dup = state.queue.some(function (q) {
        return q.file.name === f.name && q.file.size === f.size;
      });
      if (dup) return;
      state.queue.push({
        file: f,
        mode: settings.mode,
        status: 'wait',
        outBytes: 0,
        vols: 0,
        note: '',
        result: null
      });
      added++;
    });
    if (!added) { toast('没有可添加的新文件', 'err'); return; }
    renderBatch();
    toast('已添加 ' + added + ' 个文件', 'ok');
  }

  on($('batchAddBtn'), 'click', function () {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.epub,application/epub+zip';
    inp.multiple = true;
    inp.onchange = function () { addToBatch(Array.prototype.slice.call(inp.files || [])); };
    inp.click();
  });

  var STATUS_TEXT = { wait: '等待中', run: '处理中', ok: '成功', err: '失败', cancel: '已取消' };

  function renderBatch() {
    var body = $('batchBody');
    if (!state.queue.length) {
      body.innerHTML = '<tr><td colspan="7"><div class="batch-empty">还没有任务。点「添加文件」或把多本 EPUB 拖进首页。</div></td></tr>';
      $('batchSummary').textContent = '还没有任务';
      $('batchCancelBtn').hidden = true;
      return;
    }
    var okN = state.queue.filter(function (q) { return q.status === 'ok'; }).length;
    var errN = state.queue.filter(function (q) { return q.status === 'err'; }).length;
    var waitN = state.queue.filter(function (q) { return q.status === 'wait'; }).length;
    $('batchSummary').textContent =
      '共 ' + state.queue.length + ' 本　等待 ' + waitN + '　成功 ' + okN + '　失败 ' + errN;
    $('batchCancelBtn').hidden = waitN === 0;

    body.innerHTML = state.queue.map(function (q, i) {
      var modeOpts = ['standard', 'deep', 'extreme'].map(function (m) {
        return '<option value="' + m + '"' + (q.mode === m ? ' selected' : '') + '>' + MODES[m].label + '</option>';
      }).join('');
      var out = q.status === 'ok'
        ? '<b>' + fmtBytes(q.outBytes) + '</b>' + (q.vols > 1 ? '（' + q.vols + ' 卷）' : '')
        : q.status === 'run' ? '<span style="color:#2563eb">处理中</span>' : '—';
      return '<tr>' +
        '<td class="name" title="' + esc(q.file.name) + '">' + esc(q.file.name) + '</td>' +
        '<td>' + fmtBytes(q.file.size) + '</td>' +
        '<td><select data-i="' + i + '" class="q-mode"' + (q.status === 'wait' ? '' : ' disabled') + '>' + modeOpts + '</select></td>' +
        '<td><span class="status status-' + q.status + '">' + STATUS_TEXT[q.status] + '</span></td>' +
        '<td>' + out + '</td>' +
        '<td class="note">' + esc(q.note || '') + '</td>' +
        '<td>' + (q.status === 'wait'
          ? '<button type="button" class="btn-ghost small q-del" data-i="' + i + '">移除</button>'
          : q.status === 'err' ? '<button type="button" class="btn-ghost small q-retry" data-i="' + i + '">重试</button>' : '') +
        '</td></tr>';
    }).join('');

    $$('.q-mode').forEach(function (s) {
      on(s, 'change', function () {
        state.queue[Number(s.dataset.i)].mode = s.value;
      });
    });
    $$('.q-del').forEach(function (b) {
      on(b, 'click', function () {
        state.queue.splice(Number(b.dataset.i), 1);
        renderBatch();
      });
    });
    $$('.q-retry').forEach(function (b) {
      on(b, 'click', function () {
        var q = state.queue[Number(b.dataset.i)];
        q.status = 'wait';
        q.note = '';
        renderBatch();
      });
    });
  }

  on($('batchClearBtn'), 'click', function () {
    state.queue = state.queue.filter(function (q) {
      return q.status === 'wait' || q.status === 'run';
    });
    renderBatch();
  });

  on($('batchCancelBtn'), 'click', function () {
    state.queue.forEach(function (q) {
      if (q.status === 'wait') { q.status = 'cancel'; q.note = '已取消'; }
    });
    renderBatch();
  });

  on($('batchStartBtn'), 'click', function () { runBatch(); });

  async function runBatch() {
    if (state.batchRunning) { toast('批量任务正在运行', 'err'); return; }
    var pending = state.queue.filter(function (q) { return q.status === 'wait'; });
    if (!pending.length) { toast('没有等待中的任务', 'err'); return; }

    state.batchRunning = true;
    $('batchStartBtn').disabled = true;
    var conc = Math.max(1, Math.min(3, Number($('batchConcurrency').value) || settings.concurrency || 1));

    var cursor = 0;

    async function worker() {
      while (true) {
        if (cursor >= pending.length) return;
        var q = pending[cursor++];
        if (q.status !== 'wait') continue;

        q.status = 'run';
        q.note = '';
        renderBatch();

        try {
          var buf = await q.file.arrayBuffer();
          // 只覆盖模式；分卷与否已经由 collectOptions 按界面状态算好了
          var res = await EpubFix.process(buf, Object.assign({}, collectOptions(), { mode: q.mode }));
          q.result = res;
          q.status = 'ok';
          q.outBytes = res.report.outputBytes;
          q.vols = res.volumes.length;
          q.note = res.report.warnings.length ? res.report.warnings[0] : '';

          // 立即落盘，避免结果只活在内存里
          await saveQueueResult(q);
        } catch (e) {
          q.status = 'err';
          q.note = e.message || String(e);
        }
        renderBatch();
        updateBatchSummaryHistory();
      }
    }

    var workers = [];
    for (var i = 0; i < conc; i++) workers.push(worker());
    await Promise.all(workers);

    state.batchRunning = false;
    $('batchStartBtn').disabled = false;
    var okN = state.queue.filter(function (q) { return q.status === 'ok'; }).length;
    var errN = state.queue.filter(function (q) { return q.status === 'err'; }).length;
    toast('批量完成：成功 ' + okN + '，失败 ' + errN, errN && !okN ? 'err' : okN ? 'ok' : '');
  }

  async function saveQueueResult(q) {
    var vols = (q.result && q.result.volumes) || [];
    // 桌面版：静默写到输出目录（不存在会自动建）
    if (desk() && desk().saveFiles) {
      var payload = vols.map(function (v) { return { name: v.fileName, bytes: v.bytes }; });
      var r = await desk().saveFiles(payload, { silent: true, dir: settings.dirName || '' });
      if (r && r.dir) q.note = (q.note ? q.note + '　' : '') + '已保存到 ' + r.dir;
      else if (r && r.error) { q.status = 'err'; q.note = '保存失败：' + r.error; }
      return;
    }
    if (state.dirHandle) {
      try {
        var perm = await state.dirHandle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') perm = await state.dirHandle.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          for (var i = 0; i < vols.length; i++) {
            var nm = await freeName(state.dirHandle, vols[i].fileName);
            var fh = await state.dirHandle.getFileHandle(nm, { create: true });
            var w = await fh.createWritable();
            await w.write(vols[i].bytes);
            await w.close();
          }
          return;
        }
      } catch (e) { /* 落到下载 */ }
    }
    for (var j = 0; j < vols.length; j++) {
      downloadBlob(new Blob([vols[j].bytes], { type: 'application/epub+zip' }), vols[j].fileName);
      await new Promise(function (s) { setTimeout(s, 500); });
    }
  }

  function updateBatchSummaryHistory() {
    state.queue.forEach(function (q) {
      if (q.status === 'ok' && !q.logged) {
        q.logged = true;
        pushHistory({
          t: Date.now(),
          name: q.file.name.replace(/\.epub$/i, ''),
          mode: MODES[q.mode].label,
          inB: q.file.size,
          outB: q.outBytes,
          vols: q.vols,
          warn: 0
        });
      }
    });
  }

  on($('batchConcurrency'), 'change', function () {
    settings.concurrency = Math.max(1, Math.min(3, Number($('batchConcurrency').value) || 1));
    saveSettings();
  });

  /* ------------------------------------------------------------- 历史 */

  function renderHistory() {
    var el = $('historyList');
    if (!history.length) {
      el.innerHTML = '<div class="batch-empty">还没有处理记录。</div>';
      return;
    }
    el.innerHTML = history.map(function (h) {
      var saved = h.inB ? (h.inB - h.outB) / h.inB : 0;
      var d = new Date(h.t);
      var time = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0') + ' ' +
        String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      return '<div class="history-row">' +
        '<div class="history-main">' +
        '<div class="history-name">' + esc(h.name) + '</div>' +
        '<div class="history-sub">' + time + '　·　' + esc(h.mode) +
        (h.vols > 1 ? '　·　' + h.vols + ' 卷' : '') +
        (h.warn ? '　·　' + h.warn + ' 条提示' : '') + '</div></div>' +
        '<div class="history-size">' + fmtBytes(h.inB) + ' → <b>' + fmtBytes(h.outB) + '</b><br>' +
        '<span style="color:' + (saved > 0 ? '#059669' : '#6b7a94') + ';font-size:11.5px">' +
        (saved > 0 ? '省 ' + pct(saved) : '未减少') + '</span></div>' +
        '</div>';
    }).join('');
  }

  on($('historyClearBtn'), 'click', function () {
    if (!history.length) return;
    if (!confirm('清空所有处理记录？输出文件不受影响。')) return;
    history = [];
    try { localStorage.removeItem(HIS_KEY); } catch (e) {}
    renderHistory();
    toast('记录已清空');
  });

  /* ------------------------------------------------------------- 设置 */

  function loadSettingsUi() {
    refreshDirUi();
    $('setMode').value = settings.mode;
    $('setVolume').checked = !!settings.volume;
    $('setTarget').value = settings.target;
    $('setTarget').disabled = !settings.volume;
    $('setEdge').value = settings.edge || $('imgEdge').value;
    $('setQuality').value = settings.quality || $('imgQuality').value;
    $('setFonts').checked = settings.fonts == null ? $('optFonts').checked : !!settings.fonts;
    $('setLogs').checked = settings.logs !== false;
    $('setConcurrency').value = settings.concurrency || 1;
    $('batchConcurrency').value = settings.concurrency || 1;
  }

  on($('setVolume'), 'change', function () {
    $('setTarget').disabled = !$('setVolume').checked;
  });

  on($('saveSettingsBtn'), 'click', function () {
    settings.mode = $('setMode').value;
    settings.target = $('setTarget').value;
    settings.edge = Number($('setEdge').value) || 1600;
    settings.quality = Math.max(55, Math.min(98, Number($('setQuality').value) || 85));
    settings.fonts = $('setFonts').checked;
    settings.volume = $('setVolume').checked;
    settings.logs = $('setLogs').checked;
    settings.concurrency = Math.max(1, Math.min(3, Number($('setConcurrency').value) || 1));
    saveSettings();

    // 立刻反馈到首页
    applyMode(settings.mode, { syncUi: true });
    state.target = settings.target;
    state.volume = !!settings.volume;
    $('optVolume').checked = state.volume;
    syncVolumeUi();
    $$('#targetSeg .seg-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.target === settings.target);
    });
    $('batchConcurrency').value = settings.concurrency;
    toast('设置已保存，下次新建任务生效', 'ok');
  });

  /* ------------------------------------------------------------- 工具箱 */

  var toolCopy = {
    images: ['图片优化', '只处理图片，正文一个标签都不会动。用于确认"排版没变、图变小了"。'],
    svg: ['SVG 检查', '列出所有 SVG 资源并做无损精简。'],
    structure: ['结构检查与修复', '检查 ZIP、容器、OPF、spine、引用与 XML 良构性。'],
    meta: ['元数据编辑', '只改 OPF 里的 dc:* 字段，其余字节保持不变。'],
    replace: ['文字查找替换', '批量改角色名、错别字、译名。只替换正文文本，标签、属性、文件名一律不动。'],
    cover: ['封面提取', '把书里的封面原图导出成独立图片文件，EPUB 本身不做任何改动。']
  };

  $$('#toolGrid [data-tool]').forEach(function (b) {
    on(b, 'click', function () { openTool(b.dataset.tool); });
  });

  function askFile() {
    return new Promise(function (resolve) {
      toolInput.value = '';
      toolInput.onchange = function () {
        resolve((toolInput.files || [])[0] || null);
      };
      toolInput.click();
    });
  }

  async function openTool(tool) {
    var copy = toolCopy[tool] || ['工具', ''];
    openModal(copy[0],
      '<p style="color:#6b7a94;line-height:1.7">' + esc(copy[1]) + '</p>' +
      '<p style="margin-top:14px"><button type="button" class="btn-primary" id="toolPick">选择 EPUB 文件</button></p>' +
      '<div id="toolOut" style="margin-top:14px"></div>', []);

    on($('toolPick'), 'click', async function () {
      var f = await askFile();
      if (!f) return;
      var out = $('toolOut');
      out.innerHTML = '<p style="color:#6b7a94">正在读取…</p>';
      try {
        var buf = await f.arrayBuffer();
        if (tool === 'structure') return toolStructure(buf, out);
        if (tool === 'images') return toolImages(buf, out);
        if (tool === 'svg') return toolSvg(buf, out);
        if (tool === 'meta') return toolMeta(buf, out, f);
        if (tool === 'replace') return toolReplace(buf, out, f);
        if (tool === 'cover') return toolCover(buf, out, f);
      } catch (e) {
        out.innerHTML = '<div class="warn-item is-error">' + esc(e.message) + '</div>';
      }
    });
  }

  async function toolStructure(buf, out) {
    var d = await EpubFix.diagnose(buf);
    var lvName = { error: '错误', warn: '提示', info: '信息' };
    var html = '<div class="issue-list">';
    if (!d.issues.length) {
      html += '<div class="issue issue-info"><span class="issue-lv">正常</span><span class="issue-msg">结构没有问题。</span></div>';
    } else {
      d.issues.forEach(function (it) {
        html += '<div class="issue issue-' + it.level + '"><span class="issue-lv">' + lvName[it.level] +
          '</span><span class="issue-msg">' + esc(it.message) +
          (it.detail ? '<div class="issue-detail">' + esc(it.detail) + '</div>' : '') + '</span></div>';
      });
    }
    html += '</div>';
    out.innerHTML = html;

    var errors = d.issues.filter(function (i) { return i.level === 'error'; }).length;
    var mf = $('modalFoot');
    mf.innerHTML = '';
    if (errors) {
      var b = document.createElement('button');
      b.className = 'btn-primary';
      b.textContent = '修复结构并保存新文件';
      b.onclick = async function () {
        b.disabled = true;
        b.textContent = '处理中…';
        try {
          var res = await EpubFix.process(buf, { mode: 'standard' });
          var v = res.volumes[0];
          downloadBlob(new Blob([v.bytes], { type: 'application/epub+zip' }), v.fileName);
          out.insertAdjacentHTML('afterbegin',
            '<div class="warn-item is-info">已修复并生成新文件：' + esc(v.fileName) + '（' + fmtBytes(v.bytes.length) + '）</div>');
        } catch (e) {
          out.insertAdjacentHTML('afterbegin', '<div class="warn-item is-error">修复失败：' + esc(e.message) + '</div>');
        }
        b.disabled = false;
        b.textContent = '修复结构并保存新文件';
      };
      mf.appendChild(b);
    }
  }

  async function toolImages(buf, out) {
    var scan = await EpubFix.scanAssets(buf);
    if (!scan.images.length) {
      out.innerHTML = '<div class="issue issue-info"><span class="issue-lv">提示</span>' +
        '<span class="issue-msg">这本书里没有可处理的位图（可能有 SVG，请用 SVG 检查）。</span></div>';
      return;
    }
    var total = scan.images.reduce(function (s, i) { return s + i.bytes; }, 0);
    var rows = scan.images.slice(0, 60).map(function (i) {
      return '<tr><td class="asset-name" title="' + esc(i.path) + '">' + esc(i.path) + '</td>' +
        '<td class="num">' + (i.width ? i.width + '×' + i.height : '—') + '</td>' +
        '<td class="num">' + fmtBytes(i.bytes) + '</td></tr>';
    }).join('');

    out.innerHTML =
      '<p style="margin-bottom:8px">共 <b>' + scan.images.length + '</b> 张位图，合计 <b>' + fmtBytes(total) + '</b>' +
      (scan.images.length > 60 ? '（下面只列最大的 60 张）' : '') + '</p>' +
      '<div style="max-height:300px;overflow:auto"><table class="asset-table">' +
      '<thead><tr><th>文件</th><th>尺寸</th><th>体积</th></tr></thead><tbody>' + rows + '</tbody></table></div>';

    var mf = $('modalFoot');
    mf.innerHTML = '';
    var b = document.createElement('button');
    b.className = 'btn-primary';
    b.textContent = '压缩图片并保存';
    b.onclick = async function () {
      b.disabled = true;
      b.textContent = '处理中…';
      try {
        var res = await EpubFix.process(buf, {
          mode: 'deep',
          onlyImages: true,
          splitLevel: 0,
          volumeTarget: 0,
          maxEdge: settings.edge || 1600,
          quality: (settings.quality || 85) / 100,
          dropFonts: false
        });
        var v = res.volumes[0];
        var rep = res.report;
        var saved = rep.imageBytesBefore - rep.imageBytesAfter;
        out.insertAdjacentHTML('afterbegin',
          '<div class="warn-item is-info">图片 ' + rep.imagesProcessed + '/' + rep.imagesTotal + ' 张：' +
          fmtBytes(rep.imageBytesBefore) + ' → ' + fmtBytes(rep.imageBytesAfter) +
          '（省 ' + fmtBytes(saved) + '）　整体 ' + fmtBytes(rep.inputBytes) + ' → ' + fmtBytes(rep.outputBytes) +
          '<br>正文未做任何改动（只换图片）。</div>');
        downloadBlob(new Blob([v.bytes], { type: 'application/epub+zip' }), v.fileName);
      } catch (e) {
        out.insertAdjacentHTML('afterbegin', '<div class="warn-item is-error">处理失败：' + esc(e.message) + '</div>');
      }
      b.disabled = false;
      b.textContent = '压缩图片并保存';
    };
    mf.appendChild(b);
  }

  async function toolSvg(buf, out) {
    var scan = await EpubFix.scanAssets(buf);
    if (!scan.svgs.length) {
      out.innerHTML = '<div class="issue issue-info"><span class="issue-lv">提示</span>' +
        '<span class="issue-msg">这本书里没有独立的 SVG 文件。</span></div>';
      return;
    }
    var total = scan.svgs.reduce(function (s, i) { return s + i.bytes; }, 0);
    var unused = scan.svgs.filter(function (s) { return !s.used; });
    var rows = scan.svgs.map(function (s) {
      return '<tr><td class="asset-name">' + esc(s.path) + '</td>' +
        '<td class="num">' + fmtBytes(s.bytes) + '</td>' +
        '<td class="num">' + (s.used ? '已引用' : '<span style="color:#d97706">未引用</span>') + '</td></tr>';
    }).join('');
    out.innerHTML =
      '<p style="margin-bottom:8px">共 <b>' + scan.svgs.length + '</b> 个 SVG，合计 <b>' + fmtBytes(total) + '</b>' +
      (unused.length ? '，其中 <b style="color:#d97706">' + unused.length + '</b> 个没有被任何章节或样式表引用' : '，全部都有引用') +
      '</p>' +
      '<div style="max-height:300px;overflow:auto"><table class="asset-table">' +
      '<thead><tr><th>文件</th><th>体积</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table></div>';

    var mf = $('modalFoot');
    mf.innerHTML = '';
    [false, true].forEach(function (dropUnused) {
      var b = document.createElement('button');
      b.className = dropUnused ? 'btn-ghost' : 'btn-primary';
      b.textContent = dropUnused ? '精简并删除未引用' : '精简 SVG 并保存';
      b.disabled = !!dropUnused && !unused.length;
      b.onclick = async function () {
        b.disabled = true;
        var old = b.textContent;
        b.textContent = '处理中…';
        try {
          var res = await EpubFix.optimizeSvgs(buf, { dropUnused: dropUnused });
          var rep = res.report;
          var name = '精简SVG_' + new Date().toISOString().slice(0, 10) + '.epub';
          downloadBlob(new Blob([res.bytes], { type: 'application/epub+zip' }), name);
          out.insertAdjacentHTML('afterbegin',
            '<div class="warn-item is-info">已精简 ' + rep.files + ' 个 SVG：' + fmtBytes(rep.before) + ' → ' +
            fmtBytes(rep.after) + (rep.dropped.length ? '，删除未引用 ' + rep.dropped.length + ' 个' : '') +
            '。整体输出 ' + fmtBytes(res.bytes.length) + '，已开始下载。</div>');
        } catch (e) {
          out.insertAdjacentHTML('afterbegin', '<div class="warn-item is-error">精简失败：' + esc(e.message) + '</div>');
        }
        b.disabled = false;
        b.textContent = old;
      };
      mf.appendChild(b);
    });
  }

  async function toolMeta(buf, out, file) {
    var info = await EpubFix.inspect(buf);
    function row(name, id, val) {
      return '<div class="form-item"><label>' + name + '</label>' +
        '<input class="input" id="' + id + '" value="' + esc(val || '') + '" /></div>';
    }
    out.innerHTML = '<div class="form-grid">' +
      row('书名 dc:title', 'mTitle', info.title) +
      row('作者 dc:creator', 'mCreator', info.creator) +
      row('语言 dc:language', 'mLang', info.language) +
      row('出版日期 dc:date', 'mDate', '') +
      '<div class="full">' + row('出版方 dc:publisher', 'mPub', '') + '</div>' +
      '<div class="full form-item"><label>简介 dc:description</label>' +
      '<textarea class="input" id="mDesc" rows="3"></textarea></div>' +
      '</div>' +
      '<p style="margin-top:10px;color:#6b7a94;font-size:12px">只改这些字段，正文、图片、样式表完全不动。</p>';

    var mf = $('modalFoot');
    mf.innerHTML = '';
    var b = document.createElement('button');
    b.className = 'btn-primary';
    b.textContent = '保存为新文件';
    b.onclick = async function () {
      b.disabled = true;
      b.textContent = '处理中…';
      try {
        var fields = {
          title: $('mTitle').value.trim(),
          creator: $('mCreator').value.trim(),
          language: $('mLang').value.trim(),
          date: $('mDate').value.trim(),
          publisher: $('mPub').value.trim(),
          description: $('mDesc').value.trim()
        };
        var r = await EpubFix.editMetadata(buf, fields);
        if (!r.changed.length) {
          out.insertAdjacentHTML('afterbegin', '<div class="warn-item">没有字段变化，未生成文件。</div>');
        } else {
          var name = (fields.title || file.name.replace(/\.epub$/i, '')) + '.epub';
          downloadBlob(new Blob([r.bytes], { type: 'application/epub+zip' }), name);
          out.insertAdjacentHTML('afterbegin',
            '<div class="warn-item is-info">已更新 ' + r.changed.join('、') + '，生成 ' + esc(name) +
            '（' + fmtBytes(r.bytes.length) + '）</div>');
        }
      } catch (e) {
        out.insertAdjacentHTML('afterbegin', '<div class="warn-item is-error">保存失败：' + esc(e.message) + '</div>');
      }
      b.disabled = false;
      b.textContent = '保存为新文件';
    };
    mf.appendChild(b);
  }

  /* 文字查找替换：改角色名、错别字、译名。
     只替换标签外的正文文本，id/class/href/样式表和脚本里的同名字串一律不动。 */
  async function toolReplace(buf, out, file) {
    out.innerHTML = '<div class="form-grid">' +
      '<div class="form-item"><label>查找内容</label>' +
      '<input class="input" id="repFind" placeholder="例如：李小明" /></div>' +
      '<div class="form-item"><label>替换为</label>' +
      '<input class="input" id="repTo" placeholder="例如：李霄" /></div>' +
      '<div class="full form-item"><label>选项</label>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink-2)">' +
      '<input type="checkbox" id="repCase" /> 区分大小写（中文一般不用勾）</label>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink-2);margin-top:6px">' +
      '<input type="checkbox" id="repToc" checked /> 同时更新目录标题与书名</label>' +
      '</div>' +
      '</div>' +
      '<div id="repResult" style="margin-top:12px"></div>' +
      '<p style="margin-top:10px;color:#6b7a94;font-size:12px">' +
      '只替换正文里的文字。id、class、链接地址、样式表和脚本里出现同样的字不会被改动，' +
      '所以改名字不会把书改坏。</p>';

    var mf = $('modalFoot');
    mf.innerHTML = '';

    var scanBtn = document.createElement('button');
    scanBtn.className = 'btn-ghost';
    scanBtn.textContent = '先查一查';
    mf.appendChild(scanBtn);

    var runBtn = document.createElement('button');
    runBtn.className = 'btn-primary';
    runBtn.textContent = '全部替换并保存';
    mf.appendChild(runBtn);

    function opts() {
      return {
        find: $('repFind').value,
        replace: $('repTo').value,
        matchCase: $('repCase').checked,
        scope: $('repToc').checked ? 'all' : 'body'
      };
    }

    function repList(files) {
      if (!files.length) return '';
      var rows = files.slice(0, 12).map(function (f) {
        return '<div class="issue issue-info"><span class="issue-lv">' + f.count + ' 处</span>' +
          '<span class="issue-msg">' + esc(f.path) + '</span></div>';
      }).join('');
      var more = files.length > 12
        ? '<p style="font-size:12px;color:#6b7a94;margin-top:6px">另有 ' + (files.length - 12) + ' 个文件也有命中</p>'
        : '';
      return '<div class="issue-list" style="margin-top:10px">' + rows + '</div>' + more;
    }

    scanBtn.onclick = async function () {
      var o = opts();
      var res = $('repResult');
      if (!o.find) { res.innerHTML = '<div class="warn-item">先填要查找的内容。</div>'; return; }
      scanBtn.disabled = true;
      scanBtn.textContent = '查找中…';
      try {
        var r = await EpubFix.findText(buf, o);
        if (!r.total && !r.splitHits) {
          res.innerHTML = '<div class="warn-item">没找到「' + esc(o.find) + '」，书里没有这个字符串。</div>';
        } else {
          var html = '<div class="warn-item is-info">找到 <b>' + r.total + '</b> 处，分布在 ' +
            r.fileCount + ' 个文件里。</div>';
          if (r.samples.length) {
            html += '<div class="issue-list" style="margin-top:10px">' +
              r.samples.map(function (s) {
                return '<div class="issue issue-info"><span class="issue-lv">原文</span>' +
                  '<span class="issue-msg">' + esc(s.text) + '</span></div>';
              }).join('') + '</div>';
          }
          html += repList(r.files);
          if (r.splitHits) {
            html += '<div class="warn-item" style="margin-top:10px">' +
              '还有 <b>' + r.splitHits + '</b> 处被标签拆开了（比如 <span>李</span>小明），' +
              '这种情况换不到，需要你手动处理。</div>';
          }
          res.innerHTML = html;
        }
      } catch (e) {
        res.innerHTML = '<div class="warn-item is-error">查找失败：' + esc(e.message) + '</div>';
      }
      scanBtn.disabled = false;
      scanBtn.textContent = '先查一查';
    };

    runBtn.onclick = async function () {
      var o = opts();
      var res = $('repResult');
      if (!o.find) { res.innerHTML = '<div class="warn-item">先填要查找的内容。</div>'; return; }
      runBtn.disabled = true;
      runBtn.textContent = '替换中…';
      try {
        var r = await EpubFix.replaceText(buf, o);
        if (!r.total) {
          res.innerHTML = '<div class="warn-item">没有可替换的内容，未生成文件。</div>';
        } else {
          var name = file.name.replace(/\.epub$/i, '') + '_已替换.epub';
          downloadBlob(new Blob([r.bytes], { type: 'application/epub+zip' }), name);
          var html = '<div class="warn-item is-info">已替换 <b>' + r.total + '</b> 处，涉及 ' +
            r.fileCount + ' 个文件，生成 ' + esc(name) + '（' + fmtBytes(r.bytes.length) + '）</div>';
          html += repList(r.files);
          if (r.splitHits) {
            html += '<div class="warn-item" style="margin-top:10px">注意：还有 <b>' + r.splitHits +
              '</b> 处被标签拆开的名字没换到。</div>';
          }
          res.innerHTML = html;
        }
      } catch (e) {
        res.innerHTML = '<div class="warn-item is-error">替换失败：' + esc(e.message) + '</div>';
      }
      runBtn.disabled = false;
      runBtn.textContent = '全部替换并保存';
    };
  }

  async function toolCover(buf, out, file) {
    var info = await EpubFix.inspect(buf);
    if (!info.cover || !info.cover.bytes) {
      out.innerHTML = '<div class="issue issue-warn"><span class="issue-lv">提示</span>' +
        '<span class="issue-msg">这本书没有可识别的封面（manifest 里没有 cover-image，' +
        '也没有 <code>&lt;meta name="cover"&gt;</code> 指向的图片）。</span></div>';
      return;
    }
    var mt = info.cover.mediaType || 'image/jpeg';
    var ext = /png/.test(mt) ? 'png' : /webp/.test(mt) ? 'webp' : /gif/.test(mt) ? 'gif'
      : /svg/.test(mt) ? 'svg' : 'jpg';
    var blob = new Blob([info.cover.bytes], { type: mt });
    var url = URL.createObjectURL(blob);
    out.innerHTML =
      '<p style="margin-bottom:10px">封面：<b>' + esc(mt) + '</b>　' + fmtBytes(info.cover.bytes.length) + '</p>' +
      '<img src="' + url + '" alt="封面" style="max-width:200px;border:1px solid #e6ecf7;border-radius:8px" />' +
      '<p style="margin-top:10px;color:#6b7a94;font-size:12px">这是书里那张原图，没有重新编码。</p>';

    var mf = $('modalFoot');
    mf.innerHTML = '';
    var b = document.createElement('button');
    b.className = 'btn-primary';
    b.textContent = '保存封面图片';
    b.onclick = function () {
      var base = (info.title || file.name.replace(/\.epub$/i, '')) + '-封面.' + ext;
      downloadBlob(blob, base);
      out.insertAdjacentHTML('afterbegin',
        '<div class="warn-item is-info">已导出 ' + esc(base) + '（' + fmtBytes(info.cover.bytes.length) + '）</div>');
    };
    mf.appendChild(b);
  }

  /* ------------------------------------------------------------- 启动 */

  (async function boot() {
    // 首页一进来就该是设置里选的那个模式，否则用户改的默认值等于没生效
    applyMode(settings.mode || state.mode, { syncUi: true });
    if (settings.edge) $('imgEdge').value = settings.edge;
    if (settings.quality) $('imgQuality').value = settings.quality;
    if (settings.fonts != null) $('optFonts').checked = !!settings.fonts;
    syncRangeLabels();
    state.target = settings.target;
    state.volume = !!settings.volume;
    $('optVolume').checked = state.volume;
    $$('#targetSeg .seg-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.target === settings.target);
    });
    syncVolumeUi();
    state.outVersion = settings.outVersion || 'auto';
    $$('#verSeg .seg-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.ver === state.outVersion);
    });
    refreshDirUi();
    loadSettingsUi();
    syncVersionUi();
    fillAbout();
    renderBatch();
    renderHistory();
    updateEstimate();
    await restoreDir();
  })();

  // 交给自动化测试用：暴露少量状态，便于核对真实结果
  window.__em = {
    state: state,
    settings: settings,
    history: function () { return history; },
    reader: reader,
    gallery: gallery,
    openReader: openReader,
    setReaderMode: setReaderMode,
    renderResult: renderResult
  };
})();
