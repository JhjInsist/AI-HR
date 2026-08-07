// 聚合聊天侧边栏 · 候选人卡片页（自包含，无外部依赖；由 GET /logic/sidebar 提供）
//
// 两种嵌入模式都支持（xiaoju-bot-pc/src/components/Sidebar/index.tsx）：
//  ① JS-SDK 版（注册 URL 带 msgType=postMessage，推荐）：
//     postMessage {type:'sidebarHelper', data:{api,reqId}} → 宿主回 {reqId,api,data}
//     - sidebarAuth            拿 baseInfo（含 juziChatId/juziChatWxid），并让宿主后续推送 updateBaseInfo
//     - getCurExternalContact  拿 externalUserId（命中率最高的键）
//     - updateBaseInfo         宿主在切会话时主动推送 → 据此刷新卡片（iframe 不重载）
//  ② 普通版：宿主把上下文拼进 iframe URL query（juziChatId/juziChatWxid/...，注意没有 externalUserId）
export const SIDEBAR_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>候选人</title>
<style>
:root{--bg:#f5f6f8;--card:#fff;--ink:#1c1f24;--sub:#6b7280;--line:#e5e7eb;--acc:#2f6f4f;--warn:#b45309;--radius:8px}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--card:#1d2026;--ink:#e8eaed;--sub:#9aa1ab;--line:#2c3038;--acc:#4ea87a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{padding:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:10px 12px;margin-bottom:8px}
.hd{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}
.nm{font-size:16px;font-weight:600}
.ps{color:var(--sub);font-size:12px}
.badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;background:var(--acc);color:#fff}
.badge.hand{background:var(--warn)}
.row{display:grid;grid-template-columns:72px 1fr;gap:8px;padding:4px 0;font-size:12.5px}
.row .k{color:var(--sub)}
.row .v{word-break:break-all}
h3{font-size:12px;color:var(--sub);margin:0 0 6px;font-weight:600}
a{color:var(--acc)}
.tl{list-style:none;margin:0;padding:0;max-height:190px;overflow:auto}
.tl li{padding:3px 0;border-top:1px dashed var(--line);font-size:12px}
.tl li:first-child{border-top:none}
.tl .t{color:var(--sub);font-size:11px;margin-right:6px}
.tip{color:var(--sub);padding:18px 10px;text-align:center;line-height:1.7}
.err{color:var(--warn)}
.btn{display:inline-block;padding:4px 10px;border:1px solid var(--line);border-radius:6px;text-decoration:none;font-size:12px}
</style>
</head>
<body>
<div class="wrap" id="app"><div class="tip">正在识别当前会话…</div></div>
<script>
(function(){
  var app = document.getElementById('app');
  var reqSeq = 0, pending = {}, lastKey = '';

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function qs(){ var o={}, s=location.search.replace(/^\\?/,''); if(!s) return o;
    s.split('&').forEach(function(kv){ var i=kv.indexOf('='); if(i>0)
      o[decodeURIComponent(kv.slice(0,i))]=decodeURIComponent(kv.slice(i+1)); }); return o; }

  // ── 与宿主通信（JS-SDK 版）──
  function ask(api, timeout){
    return new Promise(function(resolve){
      if (window.parent === window) return resolve(null);   // 非 iframe，直接跳过
      var reqId = 'r' + (++reqSeq);
      var done = false;
      pending[reqId] = function(data){ done = true; resolve(data); };
      try { window.parent.postMessage({ type:'sidebarHelper', data:{ api: api, reqId: reqId } }, '*'); }
      catch(e){ return resolve(null); }
      setTimeout(function(){ if(!done){ delete pending[reqId]; resolve(null); } }, timeout || 2500);
    });
  }

  window.addEventListener('message', function(e){
    var p = e.data || {};
    if (p.reqId && pending[p.reqId]) { var cb = pending[p.reqId]; delete pending[p.reqId]; cb(p.data); return; }
    // 宿主切会话时主动推送（sendResponse({api:'updateBaseInfo'...})）→ 重新识别并刷新
    if (p.api === 'updateBaseInfo') { load(); }
  }, false);

  // ── 收集候选人标识 ──
  async function ids(){
    var q = qs(), out = {};
    // 直接指定（便于脱离聚合聊天单独验证：/logic/sidebar?phone=138xxxx）
    ['externalUserId','wxid','chatId','phone'].forEach(function(k){ if (q[k]) out[k] = q[k]; });
    if (out.externalUserId || out.phone) return out;   // 显式指定则不再问宿主
    // 普通版：URL 里有 juziChatId / juziChatWxid（无 externalUserId）
    if (q.juziChatId)   out.chatId = q.juziChatId;
    if (q.juziChatWxid) out.wxid   = q.juziChatWxid;
    // JS-SDK 版：先 auth（拿 baseInfo，并开启后续 updateBaseInfo 推送），再要 externalUserId
    var auth = await ask('sidebarAuth');
    var b = auth && auth.baseInfo;
    if (b) {
      if (b.juziChatId)   out.chatId = b.juziChatId;
      if (b.juziChatWxid) out.wxid   = b.juziChatWxid;
    }
    var c = await ask('getCurExternalContact');
    if (c && c.externalUserId) out.externalUserId = c.externalUserId;
    if (!out.externalUserId) {                        // 兜底：完整会话信息里也带
      var info = await ask('getCurChatInfo');
      if (info && !info.err_msg) {
        if (info.wxUserId) out.externalUserId = info.wxUserId;
        if (info.wxid && !out.wxid) out.wxid = info.wxid;
        if (info.id && !out.chatId) out.chatId = info.id;
      }
    }
    return out;
  }

  function render(c){
    if (!c || !c.found) {
      app.innerHTML = '<div class="tip">未找到该候选人的触达记录。<br/>可能不是通过秒聘发起的候选人。</div>';
      return;
    }
    var h = '';
    h += '<div class="card"><div class="hd">'
      +  '<span class="nm">' + esc(c.name || '未命名') + '</span>'
      +  (c.round ? '<span class="ps">' + esc(c.round) + '</span>' : '')
      +  (c.humanTakeover ? '<span class="badge hand">转人工</span>'
           : (c.status ? '<span class="badge">' + esc(c.status) + '</span>' : ''))
      +  '</div>';
    [['岗位', c.position], ['岗位大类', c.positionCategory], ['身份', c.identity],
     ['渠道', c.channel], ['初筛', c.screening], ['面试官', c.interviewer],
     ['面试时间', c.interviewTime], ['手机号', c.phone]].forEach(function(kv){
      if (kv[1]) h += '<div class="row"><span class="k">' + kv[0] + '</span><span class="v">' + esc(kv[1]) + '</span></div>';
    });
    h += '</div>';

    var links = '';
    if (c.hasResume && c.resumeUrl) links += '<a class="btn" href="' + esc(c.resumeUrl) + '" target="_blank" rel="noopener">简历' + (c.resumeName ? '（' + esc(c.resumeName) + '）' : '') + '</a> ';
    if (c.evalDoc)    links += '<a class="btn" href="' + esc(c.evalDoc) + '" target="_blank" rel="noopener">面评</a> ';
    if (c.transcript) links += '<a class="btn" href="' + esc(c.transcript) + '" target="_blank" rel="noopener">逐字稿</a> ';
    if (c.meetingLink) links += '<a class="btn" href="' + esc(c.meetingLink) + '" target="_blank" rel="noopener">会议链接</a>';
    if (links) h += '<div class="card"><h3>材料</h3>' + links + '</div>';

    if (c.memo) h += '<div class="card"><h3>备忘录</h3><div>' + esc(c.memo) + '</div></div>';

    if (c.timeline && c.timeline.length) {
      var items = c.timeline.slice().reverse().slice(0, 30).map(function(t){
        var at = t.at ? new Date(t.at) : null;
        var ts = at && !isNaN(at) ? (at.getMonth()+1) + '/' + at.getDate() + ' ' +
          ('0'+at.getHours()).slice(-2) + ':' + ('0'+at.getMinutes()).slice(-2) : '';
        return '<li><span class="t">' + ts + '</span>' + esc(t.event || '') +
               (t.detail ? ' · ' + esc(t.detail) : '') + '</li>';
      }).join('');
      h += '<div class="card"><h3>进度留痕</h3><ul class="tl">' + items + '</ul></div>';
    }
    app.innerHTML = h;
  }

  async function load(){
    try {
      var id = await ids();
      var key = ['externalUserId','wxid','chatId','phone'].map(function(k){ return id[k]||''; }).join('|');
      if (!key.replace(/\\|/g,'')) {
        app.innerHTML = '<div class="tip">请选择一个候选人会话。</div>';
        return;
      }
      if (key === lastKey) return;                  // 同一会话不重复请求
      lastKey = key;
      app.innerHTML = '<div class="tip">加载中…</div>';
      var p = [];
      ['externalUserId','wxid','chatId','phone'].forEach(function(k){
        if (id[k]) p.push(k + '=' + encodeURIComponent(id[k]));
      });
      var res = await fetch('/logic/candidate-card?' + p.join('&'), { headers:{ 'Accept':'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      render(await res.json());
    } catch (e) {
      lastKey = '';                                 // 失败可重试（否则同一会话卡在错误态）
      app.innerHTML = '<div class="tip err">加载失败：' + esc(e && e.message) + '</div>';
    }
  }

  load();
})();
</script>
</body>
</html>`;
