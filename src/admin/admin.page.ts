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
    <h2>📚 知识库 <span class="tag">Claude 答疑依据</span></h2>
    <div class="hint" style="margin:0 0 10px">上传 Excel（第一列=问、第二列=答，自动跳表头）一键导入；也可在下框直接编辑。候选人提问时 Claude 只用这里的内容回答，没有的转人工、绝不编造。</div>
    <div class="row" style="grid-template-columns:1fr"><div class="inline"><input type="file" id="kbFile" accept=".xlsx,.xls" style="flex:1"/><button type="button" onclick="uploadKb()">上传 Excel 导入</button><span id="kbMsg" style="font-size:12px"></span></div></div>
    <div class="row" style="grid-template-columns:1fr"><textarea id="KNOWLEDGE_BASE" style="min-height:180px" placeholder="例：&#10;Q：公司在哪办公？&#10;A：北京海淀东升大厦A座。&#10;Q：面试是什么形式？&#10;A：线上视频面试，到时发面试链接。"></textarea></div>
  </div>

  <div class="card">
    <h2>📨 触达 <span class="tag">加好友 + 话术 + 开关</span></h2>
    <div class="row"><label><b>运行模式</b>误操防线</label><div><select id="DRY_RUN"><option value="true">演练（不真发，只记日志）</option><option value="false">真跑（真加好友触达）</option></select></div></div>
    <div class="row"><label><b>面试链接</b>约上时间后发</label><input id="INTERVIEW_LINK" placeholder="https://..."/></div>
    <div class="row"><label><b>打招呼语</b>加好友申请附言(第一句)</label><textarea id="HELLO_MSG"></textarea></div>
    <div class="row"><label><b>约面欢迎语</b>好友通过后发；占位符 {name} {position} {time}</label><textarea id="WELCOME_TEMPLATE" placeholder="{name}您好~ 我是句子互动招聘助理😊 您应聘的【{position}】岗位，一面初步约在 {time}。方便的话回复「可以」确认；如需调整，回复您方便的时间就好~"></textarea></div>
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

  <div class="card">
    <h2>👥 面试官 HR 名录 <span class="tag">姓名↔飞书邮箱，约面按面试官建日程</span></h2>
    <div class="hint" style="margin:0 0 10px">姓名须与进度表「一面面试官」写法完全一致才能匹配；匹配不到时回退上面的默认 HR 邮箱。只填姓名+邮箱即可，open_id 系统用邮箱自动换。</div>
    <div id="hrList"></div>
    <div class="row">
      <label><b>新增/更新面试官</b>姓名 / 邮箱 / 备注</label>
      <div class="inline">
        <input id="hrName" placeholder="姓名(同进度表面试官)"/>
        <input id="hrEmail_new" placeholder="飞书邮箱"/>
        <input id="hrNote" placeholder="备注(可选)"/>
        <button type="button" onclick="addHr()">保存</button>
      </div>
    </div>
  </div>
</div>

<div class="bar"><div class="inner"><button type="button" onclick="save()">保存配置</button><span id="msg"></span></div></div>

<script>
var FIELDS=["AIHR_APP_TOKEN","AIHR_TABLE_ID","PROG_APP_TOKEN","PROG_TABLE_ID","INTENT_BOT_ID","CHAT_BOT_ID","MODEL","DRY_RUN","INTERVIEW_LINK","HELLO_MSG","POLL_INTERVAL_SEC","MIAOHUI_GROUP_TOKEN","MIAOHUI_CORP_ID","MIAOHUI_BOT_USERID","FEISHU_BOT_NAME","HR_EMAIL","HR_NOTIFY_CHAT","KNOWLEDGE_BASE","WELCOME_TEMPLATE"];
function el(id){return document.getElementById(id)}
function msg(t,cls){var m=el("msg");m.textContent=t;m.className=cls||""}
function load(){
  fetch("/admin/config").then(function(r){return r.json()}).then(function(d){
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
  fetch("/admin/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(collect())})
    .then(function(r){return r.json()}).then(function(d){msg(d.ok?"✓ 已保存并生效":"保存失败",d.ok?"ok":"err")})
    .catch(function(){msg("保存失败","err")});
}
function applyModel(){
  var m=el("MODEL").value;
  if(!confirm("将两个 bot 都切换到 "+m+" 并重建秒懂画布，确定？"))return;
  msg("切换中，请稍候（重建画布约需几秒）...");
  fetch("/admin/model",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:m})})
    .then(function(r){return r.json()}).then(function(d){msg(d.ok?("✓ "+d.msg):("✕ "+d.msg),d.ok?"ok":"err")})
    .catch(function(){msg("切换失败","err")});
}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function renderHr(list){
  var box=el("hrList");box.innerHTML="";
  if(!list||!list.length){box.innerHTML='<div class="hint" style="padding:6px 0">（暂无面试官，下面添加）</div>';return}
  list.forEach(function(h){
    var row=document.createElement("div");row.className="row";row.style.gridTemplateColumns="1fr";
    var wrap=document.createElement("div");wrap.className="inline";wrap.style.justifyContent="space-between";
    var span=document.createElement("span");
    span.innerHTML='<b>'+esc(h.name)+'</b> <span style="color:var(--sub)">'+esc(h.email||"（未填邮箱）")+(h.note?" · "+esc(h.note):"")+'</span>';
    var btn=document.createElement("button");btn.className="ghost";btn.type="button";btn.textContent="删除";
    btn.onclick=function(){delHr(h.name)};
    wrap.appendChild(span);wrap.appendChild(btn);row.appendChild(wrap);box.appendChild(row);
  });
}
function loadHr(){fetch("/admin/hr").then(function(r){return r.json()}).then(renderHr).catch(function(){})}
function addHr(){
  var name=el("hrName").value.trim();if(!name){msg("请先填面试官姓名","err");return}
  fetch("/admin/hr",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name,email:el("hrEmail_new").value.trim(),note:el("hrNote").value.trim()})})
    .then(function(r){return r.json()}).then(function(d){
      if(d.ok){el("hrName").value="";el("hrEmail_new").value="";el("hrNote").value="";renderHr(d.list);msg("✓ 已保存 "+name,"ok")}
      else msg(d.msg||"保存失败","err")});
}
function delHr(name){
  if(!confirm("删除面试官「"+name+"」？"))return;
  fetch("/admin/hr/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name})})
    .then(function(r){return r.json()}).then(function(d){renderHr(d.list);msg("✓ 已删除 "+name,"ok")}).catch(function(){msg("删除失败","err")});
}
function uploadKb(){
  var f=el("kbFile").files[0];
  if(!f){el("kbMsg").textContent="请先选 Excel 文件";el("kbMsg").className="err";return}
  el("kbMsg").textContent="上传解析中...";el("kbMsg").className="";
  var fd=new FormData();fd.append("file",f);
  fetch("/admin/knowledge/upload",{method:"POST",body:fd})
    .then(function(r){return r.json()}).then(function(d){
      if(d.ok){el("KNOWLEDGE_BASE").value=d.kb;el("kbMsg").textContent="✓ 导入 "+d.count+" 条问答，已保存生效";el("kbMsg").className="ok"}
      else {el("kbMsg").textContent="✕ "+(d.msg||"导入失败");el("kbMsg").className="err"}
    }).catch(function(){el("kbMsg").textContent="✕ 上传失败";el("kbMsg").className="err"});
}
load();loadHr();
</script>
</body>
</html>`;
