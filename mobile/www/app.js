/* ============================================================
   EPUB 压缩大师 (Android) — 交互层
   极简四页：主页 → 压缩设置 → 处理中 → 完成
   ============================================================ */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- 工具 */

  function $(id) { return document.getElementById(id); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }

  function fmtBytes(n) {
    if (n == null || isNaN(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(2) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  var toastTimer = null;
  function toast(msg, isErr) {
    var t = document.createElement('div');
    t.className = 'toast' + (isErr ? ' is-err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3000);
  }

  /* ---------------------------------------------------------------- 页面切换 */

  var SCREENS = ['screen-home', 'screen-config', 'screen-progress', 'screen-done'];
  var current = 'screen-home';

  function showScreen(id) {
    current = id;
    SCREENS.forEach(function (s) {
      var el = $(s);
      if (el) el.classList.toggle('is-hidden', s !== id);
    });
  }

  /* ---------------------------------------------------------------- 状态 */

  var state = {
    fileName: '',
    fileBytes: null,      // 原始 EPUB 字节（只读，永不修改）
    mode: 'recommended',
    dedupe: true,         // 清除重复图片
    result: null,         // { bytes, report }
    savedUri: null,
    savedPath: null,
    saving: false
  };

  var cancelFlag = false;

  /* ---------------------------------------------------------------- 选择文件 */

  var fileInput = $('file-input');

  function isEpub(f) {
    return /\.epub$/i.test(f.name) || f.type === 'application/epub+zip';
  }

  on($('btn-choose'), 'click', function () {
    fileInput.value = '';
    fileInput.click();
  });

  on(fileInput, 'change', function () {
    var f = fileInput.files && fileInput.files[0];
    if (!f) return;
    if (!isEpub(f)) {
      toast('请选择 .epub 文件', true);
      return;
    }

    state.fileName = f.name;
    state.result = null;
    state.savedUri = null;
    state.savedPath = null;
    cancelFlag = false;

    // 读取原始字节（只读，后续处理都在内存副本上做，绝不写回原文件）
    f.arrayBuffer().then(function (buf) {
      state.fileBytes = new Uint8Array(buf);
      $('cfg-file-name').textContent = f.name;
      $('cfg-file-size').textContent = fmtBytes(buf.byteLength);
      $('cfg-file-format').textContent = 'EPUB';
      showScreen('screen-config');
    }).catch(function (e) {
      toast('读取文件失败：' + e.message, true);
    });
  });

  /* ---------------------------------------------------------------- 返回 / 模式选择 */

  on($('btn-back'), 'click', function () {
    showScreen('screen-home');
  });

  var modeCards = Array.prototype.slice.call(
    $('mode-group').querySelectorAll('.mode-card')
  );

  modeCards.forEach(function (card) {
    on(card, 'click', function () {
      modeCards.forEach(function (c) { c.classList.remove('is-active'); });
      card.classList.add('is-active');
      state.mode = card.getAttribute('data-mode');
    });
  });

  on($('opt-dedupe'), 'change', function (e) {
    state.dedupe = !!e.target.checked;
  });

  /* ---------------------------------------------------------------- 压缩 */

  on($('btn-start'), 'click', function () {
    if (!state.fileBytes) {
      toast('请先选择 EPUB 文件', true);
      return;
    }
    startCompress();
  });

  function startCompress() {
    cancelFlag = false;
    $('progress-fill').style.width = '0%';
    $('progress-status').textContent = '正在分析 EPUB';
    $('progress-stage').textContent = '准备中…';
    showScreen('screen-progress');

    // 让界面先渲染，再开始异步压缩（引擎逐张 await，不会卡死主线程）
    setTimeout(function () {
      EpubCompress.compress(state.fileBytes, {
        mode: state.mode,
        dedupe: state.dedupe,
        shouldCancel: function () { return cancelFlag; }
      }, function (p) {
        updateProgress(p);
      }).then(function (r) {
        if (cancelFlag) return;
        onDone(r);
      }).catch(function (e) {
        if (cancelFlag || (e && e.message === '__CANCELLED__')) {
          toast('已取消，原始文件未受影响');
          showScreen('screen-config');
          return;
        }
        toast('压缩失败：' + (e && e.message ? e.message : e), true);
        showScreen('screen-config');
      });
    }, 60);
  }

  function updateProgress(p) {
    if (!p) return;
    if (p.message) $('progress-status').textContent = p.message;
    if (p.ratio != null) {
      var pct = Math.round(p.ratio * 100);
      $('progress-fill').style.width = pct + '%';
    }
    var stage = '';
    switch (p.phase) {
      case 'unzip': stage = '正在解包文件…'; break;
      case 'dedupe': stage = '正在查找重复图片'; break;
      case 'compress': stage = '逐张压缩图片'; break;
      case 'rewrite': stage = '更新引用关系'; break;
      case 'pack': stage = '正在生成新文件'; break;
      case 'done': stage = '即将完成'; break;
    }
    if (stage) $('progress-stage').textContent = stage;
  }

  on($('btn-cancel'), 'click', function () {
    cancelFlag = true;
    $('progress-status').textContent = '正在取消…';
  });

  /* ---------------------------------------------------------------- 完成 */

  function baseName(name) {
    var i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
  }

  function outFileName() {
    return baseName(state.fileName) + '_compressed.epub';
  }

  function onDone(r) {
    var rep = r.report;
    state.result = r;
    state.savedUri = null;
    state.savedPath = null;

    var name = outFileName();
    $('done-file-name').textContent = name;
    $('done-before').textContent = fmtBytes(rep.inputBytes);
    $('done-after').textContent = fmtBytes(rep.outputBytes);

    var saved = rep.inputBytes - rep.outputBytes;
    $('done-saved').textContent = (saved >= 0 ? '-' : '+') + fmtBytes(Math.abs(saved));
    $('done-ratio').textContent =
      rep.inputBytes > 0 ? Math.round((saved / rep.inputBytes) * 1000) / 10 + '%' : '—';

    var dd = $('done-dedupe');
    if (dd) {
      if (rep.dupRemoved > 0) {
        dd.textContent = '清掉 ' + rep.dupRemoved + ' 个重复图片，省下 ' + fmtBytes(rep.dupSavedBytes);
        dd.classList.remove('is-hidden');
      } else {
        dd.classList.add('is-hidden');
      }
    }

    $('done-location').textContent = '正在保存到手机…';

    showScreen('screen-done');
    saveResult(false);
  }

  /* ---------------------------------------------------------------- 保存（原生桥接） */

  function saveResult(thenOpen) {
    if (!state.result || state.saving) {
      if (thenOpen && state.savedUri) openSaved();
      return;
    }
    var bytes = state.result.bytes;
    var name = outFileName();
    var nat = window.__emNative;

    // 网页环境兜底：交给浏览器下载
    function fallbackDownload() {
      var blob = new Blob([bytes], { type: 'application/epub+zip' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1500);
      $('done-location').textContent = '已下载到浏览器下载目录';
      $('done-location').classList.remove('is-error');
    }

    if (!nat || typeof nat.save !== 'function') {
      fallbackDownload();
      return;
    }

    state.saving = true;
    $('done-location').textContent = '正在保存到手机…';
    $('done-location').classList.remove('is-error');

    nat.save(name, bytes, function (done, total) {
      var pct = total > 0 ? Math.round((done / total) * 100) : 0;
      $('done-location').textContent = '正在保存到手机…' + pct + '%';
    }).then(function (res) {
      state.saving = false;

      if (res && res.ok) {
        state.savedUri = res.uri;
        state.savedPath = res.path;
        var ver = state.result && state.result.report && state.result.report.epubVersion;
        var verText = ver === '2.0' ? 'EPUB 2.0' : (ver ? 'EPUB ' + ver : 'EPUB');
        $('done-location').textContent =
          '已保存到「' + res.path + '」\n格式 ' + verText + '，排版与章节保持原样';
        $('done-location').classList.remove('is-error');
        if (thenOpen) openSaved();
        return;
      }

      var msg = (res && res.error) ? res.error : '未知错误';
      if (msg === 'NOT_NATIVE') {
        fallbackDownload();
        return;
      }
      $('done-location').textContent = '保存失败：' + msg + '\n再点一次「打开文件」可重试';
      $('done-location').classList.add('is-error');
    }).catch(function (e) {
      state.saving = false;
      $('done-location').textContent = '保存失败：' + (e && e.message ? e.message : e);
      $('done-location').classList.add('is-error');
    });
  }

  function openSaved() {
    if (!state.savedUri) return;
    window.__emNative.open(state.savedUri).then(function (r) {
      if (!r || !r.ok) {
        toast((r && r.error) ? r.error : '无法打开文件', true);
      }
    });
  }

  /* ---------------------------------------------------------------- 打开 / 再压缩 / 返回首页 */

  on($('btn-open'), 'click', function () {
    if (!state.result) return;
    if (state.savedUri) {
      openSaved();
    } else {
      // 之前保存失败了，这里先重试保存，成功后自动打开
      saveResult(true);
    }
  });

  on($('btn-done-back'), 'click', function () {
    goHome();
  });

  on($('btn-again'), 'click', function () {
    resetAll();
    showScreen('screen-home');
    setTimeout(function () {
      fileInput.value = '';
      fileInput.click();
    }, 120);
  });

  function resetAll() {
    state.fileName = '';
    state.fileBytes = null;
    state.result = null;
    state.savedUri = null;
    state.savedPath = null;
    state.saving = false;
    cancelFlag = false;
    fileInput.value = '';
  }

  function goHome() {
    resetAll();
    showScreen('screen-home');
  }

  /* ---------------------------------------------------------------- 关于 */

  on($('btn-info'), 'click', function () {
    $('modal-about').classList.add('is-open');
  });
  on($('btn-about-close'), 'click', function () {
    $('modal-about').classList.remove('is-open');
  });
  on($('modal-about-mask'), 'click', function () {
    $('modal-about').classList.remove('is-open');
  });

  /* ---------------------------------------------------------------- 安卓返回键 */

  // 由原生层调用：返回 true = 网页已处理（不退出应用）；false = 允许退出
  window.__emBack = function () {
    var modal = $('modal-about');
    if (modal && modal.classList.contains('is-open')) {
      modal.classList.remove('is-open');
      return true;
    }
    if (current === 'screen-progress') {
      cancelFlag = true;
      $('progress-status').textContent = '正在取消…';
      // 稍等让引擎收尾，再回到设置页
      setTimeout(function () { showScreen('screen-config'); }, 200);
      return true;
    }
    if (current === 'screen-config') {
      showScreen('screen-home');
      return true;
    }
    if (current === 'screen-done') {
      goHome();
      return true;
    }
    return false; // 主页再按返回 = 退出应用
  };

  /* ---------------------------------------------------------------- 初始化 */

  showScreen('screen-home');
})();
