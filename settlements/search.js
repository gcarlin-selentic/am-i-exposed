(function () {
  var q = document.getElementById('settle-q');
  if (!q) return;
  var res = document.getElementById('settle-results');
  var empty = document.getElementById('settle-empty');
  var data = null, loading = false;

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }

  function row(x) {
    var tag = x.h ? ' <span class="settle-tag">in our check</span>' : '';
    var amt = x.a ? '<span class="settle-amount">' + (x.o ? 'up to ' : '') + esc(x.a) + '</span>' : '';
    return '<li' + (x.o ? ' class="open-row"' : '') + '><a href="' + x.u + '">' +
      '<span class="settle-name">' + esc(x.n) + tag + '</span>' + amt +
      '<span class="settle-when">' + esc(x.w) + '</span></a></li>';
  }

  function render() {
    var term = q.value.trim().toLowerCase();
    if (term.length < 2) { res.hidden = true; empty.hidden = true; res.innerHTML = ''; return; }
    if (!data) return;
    var open = [], rest = [];
    for (var i = 0; i < data.length; i++) {
      if (data[i].n.toLowerCase().indexOf(term) < 0) continue;
      (data[i].o ? open : rest).push(data[i]);
    }
    var hits = open.concat(rest).slice(0, 40);
    if (!hits.length) { res.hidden = true; empty.hidden = false; res.innerHTML = ''; return; }
    empty.hidden = true; res.hidden = false;
    var html = '';
    for (var j = 0; j < hits.length; j++) html += row(hits[j]);
    res.innerHTML = html;
  }

  function load() {
    if (data || loading) return;
    loading = true;
    fetch('/settlements/search.json')
      .then(function (r) { return r.json(); })
      .then(function (j) { data = j; loading = false; render(); })
      .catch(function () { loading = false; });
  }

  q.addEventListener('focus', load, { once: true });
  q.addEventListener('input', function () { if (!data) load(); render(); });
})();
