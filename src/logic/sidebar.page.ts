// 聚合聊天侧边栏 · 候选人卡片页（由 GET /logic/sidebar 提供）
//
// 用官方 JS-SDK，不自己实现 postMessage 协议：
//   https://res.wx.qq.com/open/js/jweixin-1.2.0.js          （企微 SDK，提供 wx 全局）
//   https://cdn.botorange.com/js/sidebar/juzi-helper-1.0.11.js（句子 helper，patch wx）
// 文档 https://s.apifox.cn/d292e311-af7c-4a68-bfe4-416fd1d657b6/6951436m0
//
// 契约要点（读 helper 源码确认，非推测）：
// - helper 无条件赋值 window.juziWx；window.wx 仅在 (非微信UA && 带 juziSidebar && 在 iframe 内) 时覆盖
//   → 取 SDK 一律写 window.juziWx || window.wx
// - invoke() 只支持 6 个 api：getCurExternalContact / getCurExternalChat / sendChatMessage /
//   sendMultiChatMessage / sidebarAuth / updateBaseInfo
//   getCurChatInfo / openEnterpriseChat / previewImage 是**对象方法**（{success,fail} 形式），不能走 invoke
// - 成功判定：err_msg === '<api>:ok'
// - getCurExternalContact 的回调里字段叫 userId（helper 把宿主的 externalUserId 改了名）
// - config 是空函数、ready 直接执行回调 → 不需要签名 / agentConfig
// - reqType:'listen' 注册的 Promise 只 resolve 一次 → updateBaseInfo 每次触发后必须重新注册
export const SIDEBAR_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>候选人</title>
<script src="https://res.wx.qq.com/open/js/jweixin-1.2.0.js"></script>
<script src="https://cdn.botorange.com/js/sidebar/juzi-helper-1.0.11.js"></script>
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
  var lastKey = '';
  var sessionToken = null;   // 只放内存变量：不落 localStorage，页面一关即失效
  var lastCode = '';         // 宿主签发的一次性 OAuth code（用掉即弃）

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function qs(){ var o={}, s=location.search.replace(/^\\?/,''); if(!s) return o;
    s.split('&').forEach(function(kv){ var i=kv.indexOf('='); if(i>0)
      o[decodeURIComponent(kv.slice(0,i))]=decodeURIComponent(kv.slice(i+1)); }); return o; }

  // ── 官方 SDK ──
  // 取 juziWx 优先：helper 无条件赋值它，而 window.wx 只在特定条件下才被覆盖
  // （若 jweixin 是 npm 引入或 helper 未加载，window.wx 会是原生企微 SDK，没有句子的 invoke 分支）
  function sdk(){ return window.juziWx || window.wx || null; }
  // isJuziWx 是 helper 打的标记，用来区分「helper 真的注入了」与「只有原生 jweixin」。
  // 不用它做调用门禁（万一将来版本去掉标记就全废），只用于诊断报错，避免把
  // 「CDN 没加载」误报成「没选会话」。
  function sdkOk(){ var s = sdk(); return !!(s && s.isJuziWx && typeof s.invoke === 'function'); }
  function isOk(r, api){ var m = (r && (r.err_msg || r.errMsg)) || ''; return m === api + ':ok'; }

  /** invoke 形式（仅限 helper 支持的 6 个 api）。失败/超时统一返回 null。 */
  function invoke(api, params){
    return new Promise(function(resolve){
      var s = sdk();
      if (!s || typeof s.invoke !== 'function') return resolve(null);
      var done = false;
      try {
        s.invoke(api, params || {}, function(r){
          if (done) return;
          done = true;
          resolve(isOk(r, api) ? r : null);
        });
      } catch(e){ return resolve(null); }
      // 没有 isJuziWx 标记时大概率等不到回应（helper 未注入），短超时快速失败，
      // 否则用户要干等数秒才看到诊断。仍然发起调用而非硬门禁：万一将来标记被去掉，
      // 功能不至于全废。
      setTimeout(function(){ if(!done){ done = true; resolve(null); } }, sdkOk() ? 3000 : 800);
    });
  }

  /** getCurChatInfo 是对象方法，不走 invoke（helper 源码里它不在 invoke 的 switch 内）。 */
  function chatInfo(){
    return new Promise(function(resolve){
      var s = sdk();
      if (!s || typeof s.getCurChatInfo !== 'function') return resolve(null);
      var done = false;
      try {
        s.getCurChatInfo({
          success: function(d){ if(!done){ done = true; resolve(d || null); } },
          fail: function(){ if(!done){ done = true; resolve(null); } },
        });
      } catch(e){ return resolve(null); }
      setTimeout(function(){ if(!done){ done = true; resolve(null); } }, sdkOk() ? 3000 : 800);
    });
  }

  /**
   * 宿主切会话时会推 updateBaseInfo。helper 的 listen Promise 只 resolve 一次，
   * 所以每次触发后必须重新注册，否则只会刷新一次。
   *
   * listen 注册只挂 Promise、不 postMessage，且 reject 仅在「收到带 err_msg 的包」时发生，
   * 所以重注册天然被入站消息节流，不会紧循环。下面的退避只是兜底：万一宿主异常刷包
   * （秒回且无 data），避免无限重注册。
   */
  var biFails = 0;
  function watchBaseInfo(){
    var s = sdk();
    if (!s || typeof s.invoke !== 'function') return;
    if (biFails > 8) return;                        // 反复失败：放弃监听（仍可手动切会话触发 load）
    var t0 = Date.now();
    try {
      s.invoke('updateBaseInfo', { reqType: 'listen' }, function(r){
        var hasData = !!(r && r.data);
        if (!hasData && Date.now() - t0 < 300) {     // 秒回且无数据 → 视为失败
          biFails++;
          setTimeout(watchBaseInfo, Math.min(1000 * biFails, 8000));
          return;
        }
        biFails = 0;
        var b = r && r.data && r.data.baseInfo;
        if (b && b.code) lastCode = b.code;
        load();
        watchBaseInfo();          // 重新注册，继续监听后续切换
      });
    } catch(e){ /* SDK 不可用时静默 */ }
  }

  // ── 收集候选人标识 ──
  // 服务端对标识做了冲突校验（切会话时宿主可能残留上一会话的 chatId，见 review #2），
  // 所以拿到最可信的 externalUserId 后就**只发它**，不要把可能过期的 chatId 一起带上。
  async function ids(){
    var q = qs(), out = {};
    if (q.code) lastCode = q.code;                    // 普通版：OAuth 回调把 code 带在 URL 上
    // 用 query 直接指定要看的人（如 ?phone=138xxxx），便于在聚合聊天内定向排查。
    // 注意：这**不能**脱离聚合聊天使用 —— 鉴权需要宿主签发的 code，纯浏览器打开会 401
    //（这是 fail-closed 的预期表现）。加鉴权前的说明有误，此处更正。
    ['externalUserId','wxid','chatId','phone'].forEach(function(k){ if (q[k]) out[k] = q[k]; });
    if (out.externalUserId) return { externalUserId: out.externalUserId };
    if (out.phone) return out;
    // 普通版：宿主把上下文拼进 iframe URL（无 externalUserId）
    if (q.juziChatId)   out.chatId = q.juziChatId;
    if (q.juziChatWxid) out.wxid   = q.juziChatWxid;
    // JS-SDK 版：先 sidebarAuth 拿 code + baseInfo
    var auth = await invoke('sidebarAuth');
    var b = auth && auth.data && auth.data.baseInfo;
    if (b) {
      if (b.code) lastCode = b.code;
      if (b.juziChatId)   out.chatId = b.juziChatId;
      if (b.juziChatWxid) out.wxid   = b.juziChatWxid;
    }
    // helper 把宿主的 externalUserId 改名为 userId 回调给调用方
    var c = await invoke('getCurExternalContact');
    if (c && c.userId) return { externalUserId: c.userId };
    var info = await chatInfo();                      // 兜底：完整会话信息里也带
    if (info) {
      if (info.wxUserId) return { externalUserId: info.wxUserId };
      if (info.wxid && !out.wxid) out.wxid = info.wxid;
      var cid = info.Id || info.id;                   // 文档写 Id，宿主源码发 id
      if (cid && !out.chatId) out.chatId = cid;
    }
    return out;
  }

  // ── 会话：用宿主的一次性 code 换本服务令牌（兑换在服务端做，浏览器不碰共享密钥）──
  async function ensureSession(force){
    if (sessionToken && !force) return sessionToken;
    if (force) sessionToken = null;                   // 令牌过期：作废后重新换
    // 手上没有可用 code 就向宿主要一个。放在这里而不是 ids() 里，是因为 ids() 对
    // ?phone= / ?externalUserId= 会提前 return，若把取 code 留在那儿，这两条通路
    // 在聚合聊天内也拿不到 code、建不了会话（曾是个真 bug）。
    if (!lastCode) {
      var a = await invoke('sidebarAuth');
      var b = a && a.data && a.data.baseInfo;
      if (b && b.code) lastCode = b.code;
    }
    if (!lastCode) return null;
    var code = lastCode; lastCode = '';               // code 一次性消费，用掉即弃
    try {
      var r = await fetch('/logic/sidebar-session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code }),
      });
      if (!r.ok) return null;
      var d = await r.json();
      sessionToken = (d && d.token) || null;
      return sessionToken;
    } catch (e) { return null; }
  }

  /** 带会话头请求；遇 401 自动换新 code 重试一次（令牌 30min 过期，侧边栏可能开一整天）。 */
  async function authedFetch(url){
    var t = await ensureSession(false);
    if (!t) { var e = new Error('身份校验失败'); e.noAuth = true; throw e; }
    var res = await fetch(url, { headers: { 'Accept':'application/json', 'X-Sidebar-Session': t } });
    if (res.status === 401) {
      t = await ensureSession(true);
      if (!t) { var e2 = new Error('身份校验失败'); e2.noAuth = true; throw e2; }
      res = await fetch(url, { headers: { 'Accept':'application/json', 'X-Sidebar-Session': t } });
    }
    return res;
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
    // 简历用 fetch+blob 而非 <a href>：/logic/candidate-resume 要 X-Sidebar-Session 头，
    // 而 <a href> 带不了请求头（同飞书附件 url 需 Bearer 的问题）。令牌也不该出现在 URL 里。
    if (c.hasResume && c.resumeUrl) links += '<a class="btn" href="#" data-resume="' + esc(c.resumeUrl) + '">简历' + (c.resumeName ? '（' + esc(c.resumeName) + '）' : '') + '</a> ';
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
        // 在 iframe 内却什么都拿不到：优先报 SDK 问题，否则才是真没选会话。
        // 否则 helper 未注入时会静默超时并显示「请选择会话」，把加载失败误报成操作提示。
        var inFrame = window !== window.parent;
        app.innerHTML = (inFrame && !sdkOk())
          ? '<div class="tip err">侧边栏 SDK 未就绪。<br/>请检查浏览器能否访问 res.wx.qq.com 与 cdn.botorange.com，'
            + '<br/>并确认工具栏地址带 <code>msgType=postMessage</code> 且已勾选「JS-SDK版」。</div>'
          : '<div class="tip">请选择一个候选人会话。</div>';
        return;
      }
      if (key === lastKey) return;                  // 同一会话不重复请求
      lastKey = key;
      app.innerHTML = '<div class="tip">加载中…</div>';
      var p = [];
      ['externalUserId','wxid','chatId','phone'].forEach(function(k){
        if (id[k]) p.push(k + '=' + encodeURIComponent(id[k]));
      });
      var res = await authedFetch('/logic/candidate-card?' + p.join('&'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      render(await res.json());
    } catch (e) {
      lastKey = '';                                 // 失败可重试（否则同一会话卡在错误态）
      app.innerHTML = e && e.noAuth
        ? '<div class="tip err">身份校验失败。<br/>请在聚合聊天工作台内打开，或联系管理员确认侧边栏鉴权已配置。</div>'
        : '<div class="tip err">加载失败：' + esc(e && e.message) + '</div>';
    }
  }

  // 简历下载：带会话头取字节 → blob → 触发下载。
  // 用 <a download> 程序化点击而不是 window.open：await 之后已脱离用户手势上下文，
  // window.open 会被弹窗拦截器挡掉。
  app.addEventListener('click', async function(e){
    var a = e.target && e.target.closest && e.target.closest('[data-resume]');
    if (!a) return;
    e.preventDefault();
    if (a.dataset.busy) return;                     // 防连点重复下载
    a.dataset.busy = '1';
    var label = a.textContent;
    a.textContent = '下载中…';
    try {
      var res = await authedFetch(a.getAttribute('data-resume'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var blob = await res.blob();
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = (label || '简历').replace(/^简历（|）$/g, '') || '简历';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(function(){ URL.revokeObjectURL(url); }, 60000);
    } catch (err) {
      alert(err && err.noAuth ? '身份校验失败，请在聚合聊天工作台内打开' : '简历下载失败：' + (err && err.message));
    } finally {
      a.textContent = label;
      delete a.dataset.busy;
    }
  }, false);

  watchBaseInfo();   // 监听宿主切会话
  load();
})();
</script>
</body>
</html>`;
