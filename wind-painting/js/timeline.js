// 時間軸與參數 key（依賴 wind.js 提供的 window.WIND_API）
// - 場景總長 scene.duration（秒），key 存在 scene.keys = { 參數名: [[秒, 值], ...] }
// - 播放時有 key 的參數依時間平滑漸變（smoothstep），沒 key 的參數維持面板上的值
// - 調整滑桿後按「設 key」：把調過的參數寫進目前時間；什麼都沒調就把全部參數記一個 key
// - 修改暫存在瀏覽器（localStorage）；按「複製 keys」貼給 AI 寫回 scenes.js 才算正式保存
// - scene.music：配樂（可多首疊放）和時間軸同步（時間軸 0 秒 = 配樂 0 秒）；播放中以第一首（主配樂）的時間為準，
//   其他音軌跟著對齊；配樂結束後改用真實時間
(function () {
  'use strict';
  var api = window.WIND_API;
  if (!api) return;
  var scene = api.scene;
  var duration = scene.duration || 600;
  var fileKeys = JSON.stringify(scene.keys || {});
  var storeId = 'wind-keys:' + scene.id;
  var NEAR = 0.25; // 秒：這個範圍內視為同一個 key

  var tracks = load();
  var t = 0, playing = false, rate = 1;
  var touched = {}; // 參數名 → 開始調整前的值（尚未設 key 的修改）

  // ---------- 資料 ----------
  function load() {
    try {
      var saved = JSON.parse(localStorage.getItem(storeId) || 'null');
      if (saved && saved.base === fileKeys) return saved.tracks;
    } catch (e) { /* 沒有暫存或無法讀取：用檔案裡的 key */ }
    return JSON.parse(fileKeys);
  }
  function save() {
    try { localStorage.setItem(storeId, JSON.stringify({ base: fileKeys, tracks: tracks })); } catch (e) { /* 無法暫存就只留在記憶體 */ }
  }
  function evalTrack(k, time) {
    var tr = tracks[k];
    if (time <= tr[0][0]) return tr[0][1];
    for (var i = 1; i < tr.length; i++) {
      if (time <= tr[i][0]) {
        var a = tr[i - 1], b = tr[i];
        var u = (time - a[0]) / Math.max(1e-6, b[0] - a[0]);
        u = u * u * (3 - 2 * u);
        return a[1] + (b[1] - a[1]) * u;
      }
    }
    return tr[tr.length - 1][1];
  }
  function putKey(k, time, v) {
    var tr = tracks[k] || (tracks[k] = []);
    tr = tracks[k] = tr.filter(function (p) { return Math.abs(p[0] - time) > NEAR; });
    tr.push([round(time, 2), round(v, 3)]);
    tr.sort(function (a, b) { return a[0] - b[0]; });
  }
  function keyTimes() {
    var out = [];
    Object.keys(tracks).forEach(function (k) {
      tracks[k].forEach(function (p) {
        if (!out.some(function (x) { return Math.abs(x - p[0]) < 0.01; })) out.push(p[0]);
      });
    });
    return out.sort(function (a, b) { return a - b; });
  }
  function round(v, n) { var m = Math.pow(10, n); return Math.round(v * m) / m; }

  // ---------- 動作 ----------
  function apply() {
    Object.keys(tracks).forEach(function (k) {
      if (tracks[k].length && !(k in touched)) api.set(k, evalTrack(k, t));
    });
  }
  function discardEdits() { touched = {}; }
  function seek(time) {
    t = Math.max(0, Math.min(duration, time));
    discardEdits(); apply(); render(); syncAudio();
  }
  function setKey() {
    var keys = Object.keys(touched);
    if (!keys.length) keys = api.params.map(function (d) { return d.key; });
    keys.forEach(function (k) {
      // 第一次替這個參數設 key 而且不在開頭：在 0 秒補上原本的值，前段才不會被新值蓋掉
      if (!(tracks[k] && tracks[k].length) && t > NEAR && k in touched) putKey(k, 0, touched[k]);
      putKey(k, t, api.P[k]);
    });
    discardEdits(); save(); apply(); render();
  }
  function deleteKey() {
    var hit = false;
    Object.keys(tracks).forEach(function (k) {
      var n = tracks[k].length;
      tracks[k] = tracks[k].filter(function (p) { return Math.abs(p[0] - t) > NEAR; });
      if (tracks[k].length !== n) hit = true;
      if (!tracks[k].length) delete tracks[k];
    });
    if (hit) { save(); discardEdits(); apply(); render(); }
  }
  function jumpKey(dir) {
    var ts = keyTimes(), target = null;
    for (var i = 0; i < ts.length; i++) {
      if (dir > 0 && ts[i] > t + 0.05) { target = ts[i]; break; }
      if (dir < 0 && ts[i] < t - 0.05) target = ts[i];
    }
    if (target != null) { playing = false; seek(target); render(); }
  }
  function copyKeys() {
    var text = 'duration: ' + duration + ',\nkeys: ' + JSON.stringify(tracks) + ',';
    var btn = el.copy;
    var done = function () { btn.textContent = '已複製'; setTimeout(function () { btn.textContent = '複製 keys'; }, 1200); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () { prompt('keys', text); });
    else prompt('keys', text);
  }
  function clearAll() {
    if (!Object.keys(tracks).length || !confirm('清除這個場景的所有 key？（scenes.js 裡的不受影響，重新整理前可按「還原」）')) return;
    tracks = {}; save(); discardEdits(); render();
  }
  function restoreFile() {
    if (!confirm('放棄瀏覽器暫存的 key，改回 scenes.js 裡的版本？')) return;
    tracks = JSON.parse(fileKeys); save(); discardEdits(); apply(); render();
  }

  api.onUserInput = function (k, before) {
    if (!(k in touched)) touched[k] = before;
    render();
  };
  api.onReset = function () { discardEdits(); apply(); render(); };
  // 用真實時間計時（模擬的 dt 有上限，掉幀時會變慢），時間軸才對得上整段的實際長度
  var lastNow = performance.now();
  api.tick = function () {
    var nowMs = performance.now(), dt = Math.min(1, (nowMs - lastNow) / 1000);
    lastNow = nowMs;
    if (playing && starting) {
      // 等所有要播的音軌緩衝好再一起開始；時間軸先停著（最多等 5 秒）
      startWait += dt;
      var act = audios.filter(active);
      if (act.every(function (a) { return !a.seeking && a.readyState >= 3; }) || startWait > 5) {
        act.forEach(function (a) { a.play().catch(function () { /* 瀏覽器擋自動播放：時間軸仍照真實時間走 */ }); });
        starting = false;
      }
    } else if (playing) {
      var from = t;
      t = followAudio(dt);
      if (t >= duration) { t = duration; playing = false; render(); syncAudio(); }
      fireGusts(from, t);
      if (Object.keys(touched).length) discardEdits(); // 播放時未設 key 的修改不保留
      apply();
    }
    api.time = t; api.playing = playing;
    renderHead();
  };
  // 定時陣風（scene.gusts）：播放時經過該秒數就觸發一次，拖曳跳轉不觸發
  var gustList = (scene.gusts || []).slice().sort(function (a, b) { return a.t - b.t; });
  function fireGusts(from, to) {
    gustList.forEach(function (g) {
      if (g.t > from && g.t <= to) api.gust(g.x == null ? 0.5 : g.x, g.y == null ? 0.5 : g.y, g.s, g.r);
    });
  }

  // ---------- 配樂 ----------
  // scene.music：字串，或 [{ src, label?, volume?, until? }, ...]；第一首是時間基準；until = 播到幾秒就停（之後靜音）
  var tracks_ = [].concat(scene.music || []).map(function (m) { return typeof m === 'string' ? { src: m } : m; });
  var audios = [], muted = false;
  try { muted = localStorage.getItem('wind-muted') === '1'; } catch (e) { /* 讀不到就預設有聲 */ }
  tracks_.forEach(function (m) {
    var a = new Audio(m.src);
    a.preload = 'metadata'; // 只先讀長度，按播放才緩衝，避免開頁時大檔佔滿連線、拖慢底圖
    a._ok = false; a._vol = m.volume == null ? 1 : m.volume; a._label = m.label || m.src;
    a._until = m.until == null ? Infinity : m.until;
    a.addEventListener('loadedmetadata', function () { a._ok = true; renderAudio(); });
    a.addEventListener('error', function () { a._ok = false; renderAudio(); });
    audios.push(a);
  });
  var master = audios[0] || null;
  api.audios = audios; // 除錯用：檢查各音軌狀態
  var starting = false, startWait = 0;
  // 這首在目前時間該不該播（載入成功、在長度與 until 之內）
  function active(a) { return a._ok && t < Math.min(a.duration || 0, a._until) - 0.05; }
  // 狀態改變（開始播放、跳轉、變速）時重新對齊：全部暫停、跳到同一時間，等緩衝好再一起開始
  // 注意：主配樂原檔是 VBR mp3，瀏覽器跳轉不準，所以改用 m4a（可精確跳轉）
  function syncAudio() {
    audios.forEach(function (a) { if (!a.paused) a.pause(); });
    starting = false;
    if (!playing) return;
    audios.forEach(function (a) {
      if (!active(a)) return;
      a.preload = 'auto';
      a.currentTime = t;
      a.playbackRate = rate;
      a.volume = a._vol;
      a.muted = muted || rate > 2; // 5×、10× 只看畫面，聲音太快沒意義
    });
    starting = audios.some(active); startWait = 0;
  }
  // 播放中每幀：時間以主配樂為準；其他音軌用 ±3% 播放速度微調追上，不跳時間（跳時間會造成錯拍）
  function followAudio(dt) {
    var ref = master && active(master) && !master.paused && master.readyState >= 2 ? master : null;
    var now = ref ? ref.currentTime : t + dt * rate;
    audios.forEach(function (a) {
      if (!a._ok) return;
      var on = a._ok && now < Math.min(a.duration || 0, a._until) - 0.05;
      if (!on) { if (!a.paused) a.pause(); return; }
      if (a === ref) return;
      if (a.paused) {
        a.currentTime = now; a.playbackRate = rate; a.volume = a._vol; a.muted = muted || rate > 2;
        a.play().catch(function () {});
        return;
      }
      var diff = a.currentTime - now;
      if (Math.abs(diff) > 0.25) a.currentTime = now;
      else a.playbackRate = rate * (1 - Math.max(-0.03, Math.min(0.03, diff)));
    });
    return now;
  }
  function renderAudio() {
    if (!el || !el.mute) return;
    var ok = audios.filter(function (a) { return a._ok; });
    el.mute.hidden = !audios.length;
    el.mute.disabled = !ok.length;
    el.mute.textContent = !ok.length ? '無配樂' : muted ? '🔇' : '🔊';
    el.mute.title = audios.map(function (a) { return (a._ok ? '✓ ' : '✗ 載入失敗 ') + a._label; }).join(' ／ ');
  }

  // ---------- 介面 ----------
  var root = document.getElementById('timeline');
  root.innerHTML =
    '<button data-a="play" title="播放／暫停（空白鍵）">▶</button>' +
    '<span class="time" title="點一下輸入時間"></span>' +
    '<div class="bar"><div class="marks"></div><div class="head"></div></div>' +
    '<button data-a="mute" hidden></button>' +
    '<select data-a="rate" title="播放速度"><option value="1">1×</option><option value="2">2×</option><option value="5">5×</option><option value="10">10×</option></select>' +
    '<button data-a="prev" title="上一個 key">◀◆</button>' +
    '<button data-a="next" title="下一個 key">◆▶</button>' +
    '<button data-a="key" class="setkey" title="把調過的參數記在目前時間（K）">◆ 設 key</button>' +
    '<button data-a="del" title="刪除目前時間的 key">刪 key</button>' +
    '<button data-a="copy">複製 keys</button>' +
    '<button data-a="restore" title="改回 scenes.js 的 key">還原</button>' +
    '<button data-a="clear" title="清除所有 key">清除</button>';
  var el = {
    play: q('[data-a=play]'), time: q('.time'), bar: q('.bar'), marks: q('.marks'), head: q('.head'),
    rate: q('[data-a=rate]'), mute: q('[data-a=mute]'), key: q('[data-a=key]'), del: q('[data-a=del]'), copy: q('[data-a=copy]'),
  };
  function q(s) { return root.querySelector(s); }

  el.play.addEventListener('click', togglePlay);
  q('[data-a=prev]').addEventListener('click', function () { jumpKey(-1); });
  q('[data-a=next]').addEventListener('click', function () { jumpKey(1); });
  el.key.addEventListener('click', setKey);
  el.del.addEventListener('click', deleteKey);
  el.copy.addEventListener('click', copyKeys);
  q('[data-a=restore]').addEventListener('click', restoreFile);
  q('[data-a=clear]').addEventListener('click', clearAll);
  el.rate.addEventListener('change', function () { rate = +el.rate.value; el.rate.blur(); syncAudio(); });
  el.mute.addEventListener('click', function () {
    muted = !muted;
    try { localStorage.setItem('wind-muted', muted ? '1' : '0'); } catch (e) { /* 只在這次有效 */ }
    renderAudio();
    audios.forEach(function (a) { a.muted = muted || rate > 2; });
  });
  el.time.addEventListener('click', function () {
    var s = prompt('跳到時間（分:秒，例如 3:20）', fmt(t));
    if (s == null) return;
    var m = s.trim().split(':'), sec = m.length > 1 ? (+m[0]) * 60 + (+m[1]) : +m[0];
    if (isFinite(sec)) seek(sec);
  });

  // 拖曳時間軸
  var dragging = false;
  el.bar.addEventListener('pointerdown', function (e) {
    dragging = true; el.bar.setPointerCapture(e.pointerId); scrub(e);
  });
  el.bar.addEventListener('pointermove', function (e) { if (dragging) scrub(e); });
  el.bar.addEventListener('pointerup', function () { dragging = false; });
  function scrub(e) {
    var r = el.bar.getBoundingClientRect();
    var time = (e.clientX - r.left) / r.width * duration;
    // 靠近 key 標記時吸附
    var snap = 6 / r.width * duration;
    keyTimes().forEach(function (k) { if (Math.abs(k - time) < snap) time = k; });
    seek(time);
  }

  window.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'select' || tag === 'textarea' || (tag === 'input' && e.target.type !== 'range')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'k' || e.key === 'K') setKey();
  });

  function togglePlay() {
    if (!playing && t >= duration) t = 0;
    playing = !playing;
    if (playing) discardEdits();
    render(); syncAudio();
  }

  function fmt(s) {
    s = Math.round(s * 10) / 10;
    var m = Math.floor(s / 60), r = s - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
  }
  var lastHead = -1;
  function renderHead() {
    if (Math.abs(lastHead - t) < 0.02) return;
    lastHead = t;
    el.head.style.left = (t / duration * 100) + '%';
    el.time.textContent = fmt(t) + ' / ' + fmt(duration).replace(/\.0$/, '');
    var onKey = keyTimes().some(function (k) { return Math.abs(k - t) <= NEAR; });
    el.del.disabled = !onKey;
    root.classList.toggle('onkey', onKey);
    markRows();
  }
  function render() {
    lastHead = -1;
    el.play.textContent = playing ? '❚❚' : '▶';
    el.marks.innerHTML = '';
    gustList.forEach(function (g) {
      var m = document.createElement('b');
      m.style.left = (g.t / duration * 100) + '%';
      m.title = '陣風 ' + fmt(g.t);
      el.marks.appendChild(m);
    });
    keyTimes().forEach(function (k) {
      var m = document.createElement('i');
      m.style.left = (k / duration * 100) + '%';
      m.title = fmt(k);
      el.marks.appendChild(m);
    });
    var n = Object.keys(touched).length;
    el.key.classList.toggle('pending', n > 0);
    el.key.textContent = n ? '◆ 設 key（' + n + '）' : '◆ 設 key';
    renderHead();
  }
  // 面板上有 key 的參數名稱前加 ◇，目前時間正好有 key 時變 ◆，調過還沒設 key 時變紅
  function markRows() {
    api.params.forEach(function (d) {
      var r = api.rows[d.key];
      if (!r) return;
      var tr = tracks[d.key];
      r.row.classList.toggle('keyed', !!(tr && tr.length));
      r.row.classList.toggle('onkey', !!(tr && tr.some(function (p) { return Math.abs(p[0] - t) <= NEAR; })));
      r.row.classList.toggle('dirty', d.key in touched);
    });
  }

  apply();
  render();
  renderAudio();
})();
