// 配置台页面（自包含，无外部依赖）
export const ADMIN_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>秒聘 · 配置台</title>
<style>
:root{--bg:#f5f6f8;--card:#fff;--ink:#1c1f24;--sub:#6b7280;--line:#e5e7eb;--acc:#2f6f4f;--accd:#255c40;--warn:#b45309;--radius:10px}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--card:#1d2026;--ink:#e8eaed;--sub:#9aa1ab;--line:#2c3038;--acc:#4ea87a;--accd:#3f9169}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:28px 18px 80px}
h1{font-size:22px;margin:0 0 4px}
.lead{color:var(--sub);margin:0 0 22px;font-size:13.5px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;margin-bottom:16px}
.card h2{font-size:15px;margin:0 0 14px;display:flex;align-items:center;gap:8px}
.card h2 .tag{font-size:11px;color:var(--sub);font-weight:400}
.row{display:grid;grid-template-columns:190px 1fr;gap:12px;align-items:start;padding:9px 0;border-top:1px solid var(--line)}
.row:first-of-type{border-top:none}
.row label{color:var(--sub);font-size:13px;padding-top:7px}
.row label b{display:block;color:var(--ink);font-size:13.5px;font-weight:600}
input,select,textarea{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;color:var(--ink);font:inherit;font-size:13.5px}
textarea{min-height:56px;resize:vertical}
input:focus,select:focus,textarea:focus{outline:2px solid var(--acc);outline-offset:-1px;border-color:transparent}
.inline{display:flex;gap:8px;align-items:center}
.inline button{white-space:nowrap}
button{background:var(--acc);color:#fff;border:none;border-radius:8px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer}
button:hover{background:var(--accd)}
button.ghost{background:transparent;color:var(--acc);border:1px solid var(--acc)}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:12px 18px;display:flex;justify-content:center;gap:12px;z-index:5}
.bar .inner{max-width:860px;width:100%;display:flex;align-items:center;gap:14px}
.hint{color:var(--sub);font-size:12px;margin-top:4px}
#msg{font-size:13px}
.ok{color:var(--acc)}.err{color:#c0392b}
</style>
</head>
<body>
<div class="wrap">
  <h1>秒聘 · 配置台</h1>
  <p class="lead">改完点底部「保存」即时生效，无需重新部署。切换模型会重建秒懂画布，需等几秒。</p>

  <div class="card">
    <h2>📊 数据表 <span class="tag">用哪张多维表</span></h2>
    <div class="row"><label><b>AI-HR 来源表</b>深澜爬简历写入</label><div class="inline"><input id="AIHR_APP_TOKEN" placeholder="app_token"/><input id="AIHR_TABLE_ID" placeholder="table_id"/></div></div>
    <div class="row"><label><b>招聘进度表</b>助手写进度/备忘录</label><div class="inline"><input id="PROG_APP_TOKEN" placeholder="app_token"/><input id="PROG_TABLE_ID" placeholder="table_id"/></div></div>
  </div>

  <div class="card">
    <h2>🤖 Agent（秒懂） <span class="tag">意图识别 + 对话应答</span></h2>
    <div class="row"><label><b>意图分类 bot</b>候选人回复→意图</label><input id="INTENT_BOT_ID" placeholder="botId"/></div>
    <div class="row"><label><b>对话应答 bot</b>结合知识库答疑</label><input id="CHAT_BOT_ID" placeholder="botId"/></div>
    <div class="row"><label><b>模型</b>两个 bot 同时用</label><div><div class="inline"><select id="MODEL"></select><button class="ghost" type="button" onclick="applyModel()">切换并重建</button></div><div class="hint">「保存」只记选择；点「切换并重建」才真正改秒懂画布并生效。</div></div></div>
  </div>

  <div class="card">
    <h2>📨 触达 <span class="tag">加好友 + 话术 + 开关</span></h2>
    <div class="row"><label><b>运行模式</b>误操防线</label><div><select id="DRY_RUN"><option value="true">演练（不真发，只记日志）</option><option value="false">真跑（真加好友触达）</option></select></div></div>
    <div class="row"><label><b>面试链接</b>约上时间后发</label><input id="INTERVIEW_LINK" placeholder="https://..."/></div>
    <div class="row"><label><b>加好友欢迎语</b>建联首句</label><textarea id="HELLO_MSG"></textarea></div>
    <div class="row"><label><b>轮询间隔(秒)</b>改后需重启生效</label><input id="POLL_INTERVAL_SEC" placeholder="120"/></div>
  </div>

  <div class="card">
    <h2>📱 秒回 & 机器人 <span class="tag">招聘企微 + 群机器人</span></h2>
    <div class="row"><label><b>小组 token</b>秒回加好友用</label><input id="MIAOHUI_GROUP_TOKEN" placeholder="token"/></div>
    <div class="row"><label><b>企微 corpId</b></label><input id="MIAOHUI_CORP_ID" placeholder="ww..."/></div>
    <div class="row"><label><b>招聘企微号</b>userId</label><input id="MIAOHUI_BOT_USERID" placeholder="jiahongjia"/></div>
    <div class="row"><label><b>机器人名字</b>群里@它触发</label><input id="FEISHU_BOT_NAME" placeholder="秒聘"/></div>
  </div>

  <div class="card">
    <h2>👤 HR 通知 & 日程 <span class="tag">同步HR + 建面试日程</span></h2>
    <div class="row"><label><b>HR 飞书邮箱</b>约上后建面试日程并邀HR参会</label><input id="HR_EMAIL" placeholder="hr@juzibot.com"/></div>
    <div class="row"><label><b>HR 通知会话</b>触达失败/需人工时通知(chat_id oc_...)</label><input id="HR_NOTIFY_CHAT" placeholder="oc_..."/></div>
  </div>
</div>

<div class="bar"><div class="inner"><button type="button" onclick="save()">保存配置</button><span id="msg"></span></div></div>

<script>
var FIELDS=["AIHR_APP_TOKEN","AIHR_TABLE_ID","PROG_APP_TOKEN","PROG_TABLE_ID","INTENT_BOT_ID","CHAT_BOT_ID","MODEL","DRY_RUN","INTERVIEW_LINK","HELLO_MSG","POLL_INTERVAL_SEC","MIAOHUI_GROUP_TOKEN","MIAOHUI_CORP_ID","MIAOHUI_BOT_USERID","FEISHU_BOT_NAME","HR_EMAIL","HR_NOTIFY_CHAT"];
function el(id){return document.getElementById(id)}
function msg(t,cls){var m=el("msg");m.textContent=t;m.className=cls||""}
function load(){
  fetch("config").then(function(r){return r.json()}).then(function(d){
    var sel=el("MODEL");sel.innerHTML="";
    d.models.forEach(function(g){
      var og=document.createElement("optgroup");og.label=g.provider;
      g.models.forEach(function(m){var o=document.createElement("option");o.value=m;o.textContent=m;og.appendChild(o)});
      sel.appendChild(og);
    });
    FIELDS.forEach(function(k){var e=el(k);if(e&&d.config[k]!=null)e.value=d.config[k]});
  });
}
function collect(){var o={};FIELDS.forEach(function(k){var e=el(k);if(e)o[k]=e.value});return o}
function save(){
  msg("保存中...");
  fetch("config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(collect())})
    .then(function(r){return r.json()}).then(function(d){msg(d.ok?"✓ 已保存并生效":"保存失败",d.ok?"ok":"err")})
    .catch(function(){msg("保存失败","err")});
}
function applyModel(){
  var m=el("MODEL").value;
  if(!confirm("将两个 bot 都切换到 "+m+" 并重建秒懂画布，确定？"))return;
  msg("切换中，请稍候（重建画布约需几秒）...");
  fetch("model",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:m})})
    .then(function(r){return r.json()}).then(function(d){msg(d.ok?("✓ "+d.msg):("✕ "+d.msg),d.ok?"ok":"err")})
    .catch(function(){msg("切换失败","err")});
}
load();
</script>
</body>
</html>`;
