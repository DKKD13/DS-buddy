/**
 * The developer view as a standalone page at /api/mira-projects/workers/view, in the same shape as the day board:
 * one HTML string, no framework, reads /api/mira-projects/workers. It only shows; nothing on it changes anything.
 */

export function workersHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>开发者视图，后台环节</title>
<style>
:root{color-scheme:light dark;--paper:#fbfaf8;--card:#fff;--ink:#141111;--ink2:rgba(20,17,17,.62);--ink3:rgba(20,17,17,.42);--hair:rgba(20,17,17,.12);--cyan:#1fb4dc;--cyan-s:#d7f2fe;--lav:#8f7fd2;--lav-s:#ebe6f8;--lime:#4f9a2a;--lime-s:#dff5c9;--orange:#e07b2d;--orange-s:#fde6d8;--pink:#d6286f;--pink-s:#ffe0ec;--stone:#8f8a84;--stone-s:#eceae6;--yellow:#ffd440;--yellow-s:#fff4c7;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--paper:#1b1b19;--card:#242422;--ink:#e5e5e2;--ink2:rgba(229,229,226,.66);--ink3:rgba(229,229,226,.45);--hair:rgba(229,229,226,.12);--cyan:#27ccf3;--cyan-s:rgba(39,204,243,.16);--lav:#bbafe6;--lav-s:rgba(187,175,230,.18);--lime:#a9d877;--lime-s:rgba(169,216,119,.18);--orange:#f8a16f;--orange-s:rgba(248,161,111,.18);--pink:#ff99c3;--pink-s:rgba(255,153,195,.18);--stone:#c0b9b1;--stone-s:rgba(192,185,177,.16);--yellow-s:rgba(255,212,64,.14)}}
*{box-sizing:border-box}
html,body{margin:0}
body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,"Noto Sans SC",sans-serif;color:var(--ink);background:var(--paper);-webkit-font-smoothing:antialiased}
header{position:sticky;top:0;z-index:2;background:var(--paper);border-bottom:.5px solid var(--hair)}
.bar{max-width:1080px;margin:0 auto;padding:12px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.face{width:24px;height:24px;border-radius:6px;background:var(--yellow);display:grid;place-items:center;font-size:12px;font-weight:700;color:#141111}
.bar h1{margin:0;font-size:16px;font-weight:600}
.day{font:12px/1 var(--mono);color:var(--ink3)}
.sp{flex:1}
.light{width:7px;height:7px;border-radius:2px;background:var(--stone)}.light.on{background:var(--lime)}
button,.btn{font:inherit;font-size:13px;line-height:1;padding:7px 10px;border-radius:8px;border:.5px solid var(--hair);background:transparent;color:var(--ink);cursor:pointer;text-decoration:none;display:inline-block}
button:hover,.btn:hover{border-color:var(--ink3)}
button.quiet{border-color:transparent;color:var(--ink3)}button.quiet:hover{color:var(--ink);border-color:var(--hair)}
button:disabled{opacity:.5;cursor:default}
main{max-width:1080px;margin:0 auto;padding:16px 16px 64px;display:flex;flex-direction:column;gap:22px}
section{display:flex;flex-direction:column;gap:8px;min-width:0}
h2{margin:0;font-size:15px;font-weight:600;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
h2 small{font-size:12px;font-weight:400;color:var(--ink3)}
.lede{margin:0;color:var(--ink2);font-size:13px;max-width:78ch}
.card{border:.5px solid var(--hair);border-radius:8px;background:var(--card);min-width:0}
.pad{padding:10px 12px}
.kind{font-size:12px;line-height:1.5;padding:0 6px;border-radius:5px;background:var(--stone-s);color:var(--ink2);white-space:nowrap}
.kind.pink{background:var(--pink-s)}.kind.lav{background:var(--lav-s)}.kind.cyan{background:var(--cyan-s)}.kind.lime{background:var(--lime-s)}.kind.orange{background:var(--orange-s)}.kind.yellow{background:var(--yellow-s)}
.flow{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:18px}
@media (max-width:900px){.flow{grid-template-columns:repeat(2,minmax(0,1fr))}.step::after{display:none}}
.step{position:relative;border:.5px solid var(--hair);border-radius:8px;background:var(--card);padding:10px 12px;display:flex;flex-direction:column;gap:2px;color:inherit;text-decoration:none}
.step:hover{border-color:var(--ink3);text-decoration:none}
.step::after{content:"→";position:absolute;right:-15px;top:50%;transform:translateY(-50%);color:var(--ink3);font-size:13px}
.step:last-child::after{display:none}
.step .name{font-size:13px;font-weight:600;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.step .num{font:600 20px/1.3 var(--mono)}
.step .sub{font-size:12px;color:var(--ink2)}
.step .rule{font-size:12px;color:var(--ink3);margin-top:4px}
.note{font-size:13px;color:var(--ink2);padding:2px 0 2px 10px;max-width:86ch}
.totals{display:flex;flex-wrap:wrap;gap:16px;font-size:12px;color:var(--ink2)}
.totals b{font:600 15px/1 var(--mono);color:var(--ink);margin-right:3px}
.hours{display:grid;grid-template-columns:repeat(24,minmax(0,1fr));gap:3px;align-items:end;height:72px;margin-top:10px}
.hr{display:flex;flex-direction:column-reverse;height:100%;min-width:0}
.hr i{display:block;min-height:0}.hr i.screen{background:var(--cyan)}.hr i.lark{background:var(--lav)}.hr i.other{background:var(--stone)}
.hlab{display:grid;grid-template-columns:repeat(24,minmax(0,1fr));gap:3px;font:10px/1.6 var(--mono);color:var(--ink3);text-align:center}
.legend{display:flex;gap:12px;font-size:12px;color:var(--ink3);margin-top:4px}
.legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px}
.rows{display:flex;flex-direction:column}
button.row{display:grid;gap:10px;align-items:baseline;width:100%;text-align:left;border:0;border-bottom:.5px solid var(--hair);border-radius:0;padding:8px 12px;font-size:13px;line-height:1.5;background:transparent}
button.row:hover{background:var(--stone-s)}
button.row[aria-expanded=true]{background:var(--yellow-s)}
.rows>*:last-child{border-bottom:0}
.w4{grid-template-columns:104px 190px 170px minmax(0,1fr)}
.c4{grid-template-columns:minmax(0,1.2fr) 150px 150px minmax(0,1.4fr)}
.t3{display:grid;grid-template-columns:52px minmax(0,1fr) minmax(0,2fr) 76px;gap:10px;align-items:baseline;padding:8px 12px;border-bottom:.5px solid var(--hair);font-size:13px}
@media (max-width:760px){.w4,.c4,.t3{grid-template-columns:minmax(0,1fr)}}
.head{display:grid;gap:10px;padding:6px 12px;border-bottom:.5px solid var(--hair);font-size:12px;color:var(--ink3)}
@media (max-width:760px){.head{display:none}}
.mono{font:12px/1.5 var(--mono);color:var(--ink2)}
.dim{color:var(--ink3)}
.clip{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.chips{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center}
.detail{padding:12px;border-bottom:.5px solid var(--hair);background:var(--paper);display:flex;flex-direction:column;gap:10px}
.cols{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:16px}
@media (max-width:760px){.cols{grid-template-columns:minmax(0,1fr)}}
.cols h3{margin:0 0 4px;font-size:12px;font-weight:600;color:var(--ink3)}
.frags{max-height:420px;overflow:auto;border:.5px solid var(--hair);border-radius:8px;background:var(--card)}
.frag{padding:7px 10px;border-bottom:.5px dashed var(--hair);font-size:13px}
.frag:last-child{border-bottom:0}
.frag.cited{box-shadow:inset 3px 0 0 var(--lime)}
.frag .hd{font:11px/1.6 var(--mono);color:var(--ink3);display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.frag .tt{font-weight:600}
.frag .tx{color:var(--ink2);word-break:break-word;max-height:6.4em;overflow:auto}
.act{border:.5px solid var(--hair);border-radius:8px;background:var(--card);padding:8px 10px;margin-bottom:6px}
.act b{display:block}
.act .tx{color:var(--ink2);font-size:13px}
details{font-size:13px}
summary{cursor:pointer;color:var(--ink2)}
pre{font:11.5px/1.55 var(--mono);white-space:pre-wrap;word-break:break-word;background:var(--stone-s);border-radius:8px;padding:10px;max-height:360px;overflow:auto;margin:6px 0 0}
.empty{color:var(--ink3);font-size:13px;padding:10px 12px}
.err{color:var(--orange);font-size:13px}
a{color:inherit;text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:2px}
.flow{grid-template-columns:minmax(0,1fr);gap:0;border:.5px solid var(--hair);border-radius:8px;overflow:hidden;background:var(--card)}.step{border:0;border-radius:0;padding:12px 16px}.step+.step{border-top:.5px solid var(--hair)}.step:hover{background:var(--paper)}.step::after{display:none}.step .num{font:600 16px/1.3 var(--mono)}.note{font-size:12px;color:var(--ink3);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.step{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:16px;row-gap:2px;align-items:center}.step .name{grid-column:1;grid-row:1}.step .sub{grid-column:1;grid-row:2}.step .num{grid-column:2;grid-row:1/3;text-align:right;font:500 14px/1.3 var(--mono)}
body:not(.explain) .lede,body:not(.explain) .note{display:none}button[aria-pressed=true]{border-color:var(--ink3)}
.watch{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}.watch-item{font-size:13px;line-height:20px;padding:10px 12px;border-radius:8px;background:var(--yellow-s);color:var(--ink)}.watch-ok{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--ink2)}.watch-ok::before{content:"";width:7px;height:7px;border-radius:2px;background:var(--lime)}
.kind,.kind.pink,.kind.lav,.kind.cyan,.kind.lime,.kind.orange{background:none;padding:0;color:var(--ink2)}
</style>
</head>
<body>
<header><div class="bar"><span class="face">助</span><h1>开发者视图</h1><span class="day" id="day"></span>
<button class="quiet" id="prev" title="前一天">‹</button><button class="quiet" id="next" title="后一天">›</button>
<span class="sp"></span><span class="day" id="at"></span><a class="btn" href="/api/mira-projects/today/view">今日看板</a><button class="quiet" id="explain" aria-pressed="false" onclick="var on=document.body.classList.toggle('explain');this.setAttribute('aria-pressed',on)">说明</button><button id="reload">刷新</button><span class="light" id="light"></span></div></header>
<main id="main"><div class="empty">正在连接…</div></main>
<script>
(function(){
  var API='/api/mira-projects/workers';
  var SRC={screen:'屏幕',lark:'飞书',accessibility:'窗口文字',mail:'邮件'};
  var WSTATE={open:['这 10 分钟还没过完','stone'],settling:['等碎片到齐','stone'],queued:['排队中','cyan'],rewrite:['来了新碎片，待重写','cyan'],written:['已写','lime'],retrying:['失败，待重试','orange'],'gave-up':['失败多次，已放弃','pink'],skipped:['超过 24 小时，不处理','stone'],expired:['原文已过保留期','stone']};
  var CSTATE={grace:['宽限中，先等你自己回','stone'],queued:['排队问模型','cyan'],owed:['判为要回','pink'],'no-reply':['判为不用回','lime'],retrying:['失败，待重试','orange'],'gave-up':['失败多次，已放弃','pink']};
  var INBOX={'message.posted':'你发来的话','project.attention':'项目里要你看的事','feishu.attention':'飞书里等你回的消息','card.acted':'你用了助理的卡','card.dismissed':'你关掉了助理的卡','request:important':'重要消息直通','request:attention':'有事要你看','request:morning':'早间回顾','request:evening':'晚间回顾','request:owner':'你点了“现在整理”','request:conversation':'重试上一次回答'};
  var TOOL={hub_inbox_read:'读收件箱',hub_search:'搜记录',hub_source:'看原文',hub_read:'读记录',hub_chat_read:'读对话',hub_feishu_chat:'读飞书会话',hub_feishu_live:'实时查飞书',today_read:'看今日看板',project_read:'看项目',hub_no_reply:'决定不说话',hub_reply:'回复你',hub_about_remember:'记下关于你的事',hub_memory_write:'写记忆',hub_card_propose:'递卡',hub_card_withdraw:'撤卡',recap_write:'写回顾',hub_project_create:'建项目',hub_project_delete:'删项目',hub_project_restore:'恢复项目',hub_task_open:'开任务',hub_task_accept:'验收任务',hub_task_archive:'归档任务',hub_task_message:'给任务留言',hub_decision_answer:'替你拍板',hub_models:'看模型',hub_set_model:'换模型',hub_attention_mode:'改提醒模式'};
  var MODE={off:'关闭',observe:'只记录',auto:'自动提醒'};
  var h=function(tag,attrs,kids){var el=document.createElement(tag);attrs=attrs||{};for(var k in attrs){var v=attrs[k];if(v==null)continue;if(k==='class')el.className=v;else if(k==='text')el.textContent=v;else if(k.slice(0,2)==='on')el.addEventListener(k.slice(2),v);else if(k==='disabled')el.disabled=!!v;else el.setAttribute(k,v);}(kids||[]).forEach(function(c){if(c)el.appendChild(typeof c==='string'?document.createTextNode(c):c)});return el};
  var main=document.getElementById('main'), light=document.getElementById('light');
  var view=null, day=null, gen=0, open=null, detail=null, detailErr=null, timer=null;
  function get(q){return fetch(API+q,{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.json().catch(function(){return {}}).then(function(d){if(!r.ok||d.error)throw new Error(d.error||('HTTP '+r.status));return d})})}
  function p2(n){return ('0'+n).slice(-2)}
  function hm(at){var d=new Date(at);return p2(d.getHours())+':'+p2(d.getMinutes())}
  function shift(key,n){var p=key.split('-').map(Number);var d=new Date(p[0],p[1]-1,p[2]+n);return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())}
  function num(ref){return '#'+String(ref).split('#')[1]}
  function chip(text,color,title){return h('span',{class:'kind'+(color?' '+color:''),text:text,title:title})}
  function sec(id,title,small,lede){var s=h('section',{id:id});s.appendChild(h('h2',null,[title,small?h('small',{text:small}):null]));if(lede)s.appendChild(h('p',{class:'lede',text:lede}));return s}
  function bySource(map){var out=[];Object.keys(map||{}).forEach(function(k){out.push((SRC[k]||k)+' '+map[k])});return out.join('，')}
  function sum(map,keys){var n=0;keys.forEach(function(k){n+=(map||{})[k]||0});return n}
  function pre(title,text,opened){var d=h('details',opened?{open:''}:null,[h('summary',{text:title}),h('pre',{text:text})]);return d}

  function toggle(kind,key){
    if(open&&open.kind===kind&&open.key===key){open=null;detail=null;detailErr=null;render();return}
    var mine=open={kind:kind,key:key};detail=null;detailErr=null;render();
    get('?'+(kind==='window'?'window=':'conversation=')+encodeURIComponent(key)).then(function(d){if(open!==mine)return;detail=d;render()}).catch(function(e){if(open!==mine)return;detailErr=e.message;render()});
  }
  function isOpen(kind,key){return !!(open&&open.kind===kind&&open.key===key)}
  function fragList(list,citedLabel){
    var box=h('div',{class:'frags'});
    if(!list.length)box.appendChild(h('div',{class:'empty',text:'没有碎片。'}));
    list.forEach(function(f){
      box.appendChild(h('div',{class:'frag'+(f.cited?' cited':'')},[
        h('div',{class:'hd'},[h('span',{text:hm(f.at)}),h('span',{text:SRC[f.source]||f.source}),f.app?h('span',{text:f.app}):null,h('span',{text:num(f.ref)}),
          f.own?chip('本人','cyan','屏幕上的内容，或你自己发的消息：可以作为“你做了什么”的依据'):null,f.important?chip('找你的','pink','私聊你，或在群里 @ 了你'):null,f.ask?chip('待回','orange'):null,f.cited?chip(citedLabel,'lime'):null]),
        f.title?h('div',{class:'tt',text:f.title}):null,
        h('div',{class:'tx',text:f.expired?'（原文已过保留期，不再显示）':(f.text||'（没有文字）')})]));
    });
    return box;
  }
  function pending(){return detailErr?h('div',{class:'detail'},[h('div',{class:'err',text:'读不出来：'+detailErr})]):h('div',{class:'detail'},[h('div',{class:'dim',text:'正在读取…'})])}

  function flow(v){
    var s=v.sources,hs=v.history.states,fs=v.followups.states,a=v.attention,t=v.turns;
    var silent=t.filter(function(x){return x.silent}).length;
    var owed=v.followups.judgments.filter(function(j){return j.needsReply}).length;
    /* What needs a look comes first, as a status page leads with problems; nothing wrong is one quiet line. */
    var alerts=[];
    if(hs['gave-up'])alerts.push('电脑历史有 '+hs['gave-up']+' 段写不出来，已放弃');
    var retry=sum(hs,['retrying']);if(retry)alerts.push('电脑历史有 '+retry+' 段在重试');
    var ferr=sum(fs,['failed','error','gave-up']);if(ferr)alerts.push('「要不要回」有 '+ferr+' 次没判成');
    if(owed)alerts.push(owed+' 条飞书消息判为要回');
    var watch=h('div',{class:'watch'},alerts.length?alerts.map(function(x){return h('div',{class:'watch-item',text:x})}):[h('div',{class:'watch-ok',text:'后台运行正常'})]);
    function step(href,name,tag,numText,sub,rule){return h('a',{class:'step',href:href,title:rule},[h('div',{class:'name'},[name,tag?chip(tag[0],tag[1]):null]),h('div',{class:'num',text:numText}),h('div',{class:'sub',text:sub})])}
    var box=h('section',null,[watch,
      h('div',{class:'flow'},[
        step('#sources','碎片进来',null,String(s.total),bySource(s.bySource)||'今天还没有','Mac 每分钟传一次屏幕文字，每 2 分钟传一次飞书消息'),
        step('#history','① 电脑历史',['调模型','lav'],String((hs.written||0))+' 段',(sum(hs,['queued','rewrite','retrying'])?'排队 '+sum(hs,['queued','rewrite','retrying'])+' 段':'没有排队')+(hs['gave-up']?'，放弃 '+hs['gave-up']:''),'每 '+v.history.minutes+' 分钟一段，过完再等 '+v.history.settleMinutes+' 分钟，把这段的碎片交给模型写成“你做了什么”'),
        step('#followups','② 要不要回',['调模型','lav'],v.followups.judgments.length+' 次',owed?'其中 '+owed+' 次判为要回':'没有判为要回的','有人私聊或 @ 你，'+v.followups.graceMinutes+' 分钟你还没回，才问模型“这要不要回”'),
        step('#attention','③ 飞书关注',['不调模型','stone'],a.items.length+' 条','模式：'+(MODE[a.mode]||a.mode),'把判为要回的交给助理。现在是“'+(MODE[a.mode]||a.mode)+'”'+(a.mode==='observe'?'：只记下来，不叫醒助理':'')),
        step('#turns','助理被叫醒',null,t.length+' 轮',silent?silent+' 轮看完没说话':'每轮都说了话','你发的话、项目里有事要你看、早晚回顾会叫醒它；'+(a.mode==='auto'||s.devices.some(function(d){return d.wakeMinutes})?'飞书里找你的消息也会':'飞书消息眼下不会')+'。说不说话它自己定')])]);
    var direct=0;t.forEach(function(x){x.inbox.forEach(function(i){if(i.kind==='request:important')direct+=i.n})});
    var wake=(s.devices.filter(function(d){return d.wakeMinutes})[0]||{}).wakeMinutes;
    box.appendChild(h('div',{class:'note',text:'直通线：私聊或 @ 你的消息直接叫醒助理，'+(wake?'同一设备 '+wake+' 分钟内最多一次':'未开启')+'；这一天 '+direct+' 次。'}));
    return box;
  }
  function sources(v){
    var s=v.sources,sc=sec('sources','碎片进来',null,null);
    var c=h('div',{class:'card pad'});
    c.appendChild(h('div',{class:'totals'},[h('span',null,[h('b',{text:String(s.total)}),'条碎片']),h('span',null,[h('b',{text:String(s.bySource.screen||0)}),'屏幕']),h('span',null,[h('b',{text:String(s.bySource.lark||0)}),'飞书']),h('span',null,[h('b',{text:String(s.important)}),'找你的（私聊 / @）']),h('span',null,[h('b',{text:String(s.mine)}),'你自己发的']),s.lastAt?h('span',null,['最近一条 '+hm(s.lastAt)]):null]));
    var max=1;s.hours.forEach(function(x){var n=0;for(var k in x)n+=x[k];if(n>max)max=n});
    var bars=h('div',{class:'hours'}),labs=h('div',{class:'hlab'});
    s.hours.forEach(function(x,i){var col=h('div',{class:'hr',title:p2(i)+' 点：'+(bySource(x)||'没有')});['screen','lark'].forEach(function(k){if(x[k])col.appendChild(h('i',{class:k,style:'height:'+(100*x[k]/max)+'%'}))});var rest=0;for(var k in x)if(k!=='screen'&&k!=='lark')rest+=x[k];if(rest)col.appendChild(h('i',{class:'other',style:'height:'+(100*rest/max)+'%'}));bars.appendChild(col);labs.appendChild(h('span',{text:i%3===0?p2(i):''}))});
    c.appendChild(bars);c.appendChild(labs);
    c.appendChild(h('div',{class:'legend'},[h('span',null,[h('i',{style:'background:var(--cyan)'}),'屏幕']),h('span',null,[h('i',{style:'background:var(--lav)'}),'飞书']),h('span',{text:'按小时'})]));
    sc.appendChild(c);
    var d=h('div',{class:'card rows'});
    if(!s.devices.length)d.appendChild(h('div',{class:'empty',text:'还没有设备连上来。'}));
    s.devices.forEach(function(x){d.appendChild(h('div',{class:'t3',style:'grid-template-columns:minmax(0,1fr) auto auto auto'},[h('b',{text:x.name}),chip(x.connection==='recent'?'在线':'最近没有心跳',x.connection==='recent'?'lime':'orange'),chip(x.enabled?'采集已开':'采集已关',x.enabled?'':'orange'),h('span',{class:'mono',text:'心跳 '+hm(x.receivedAt)})]))});
    sc.appendChild(d);
    sc.appendChild(h('p',{class:'lede',text:''}));
    return sc;
  }
  function windowDetail(d){
    var box=h('div',{class:'detail'});
    var said=!d.written?'这一段还没写。':d.asked?'模型读了下面的原文，写出右边的活动。右边每条活动只能引用这一段里的碎片编号；编造的编号会被代码丢掉。':(d.readable?'这一段没有你本人的依据（没有屏幕文字，也没有你发的消息），所以没有调模型，直接记为“没有活动”。':'这一段的原文已过保留期，只剩当时写下的结果。');
    box.appendChild(h('div',{class:'dim',text:d.deviceName+'，'+hm(d.start)+'–'+hm(d.end)+'，'+said}));
    var right=h('div');right.appendChild(h('h3',{text:'写出的活动'+(d.written?'（第 '+d.written.version+' 版，'+hm(d.written.at)+' 写）':'')}));
    if(!d.written)right.appendChild(h('div',{class:'empty',text:'还没有结果。'}));
    else if(!d.written.activities.length)right.appendChild(h('div',{class:'empty',text:'结果是空的：这段时间没有可以记下来的事。'}));
    else d.written.activities.forEach(function(a){right.appendChild(h('div',{class:'act'},[h('b',{text:a.title}),a.detail?h('div',{class:'tx',text:a.detail}):null,h('div',{class:'chips',style:'margin-top:4px'},[].concat((a.apps||[]).map(function(x){return chip(x)}),a.projectRef?[chip('项目 '+a.projectRef,'cyan')]:[],[h('span',{class:'mono',text:(a.refs||[]).map(num).join(' ')})]))]))});
    var left=h('div',null,[h('h3',{text:'这一段的碎片（'+d.fragments.length+' 条）'}),fragList(d.fragments,'被引用')]);
    box.appendChild(h('div',{class:'cols'},[left,right]));
    if(d.input)box.appendChild(pre('交给模型的原文（按现在的数据重建）',d.input));
    box.appendChild(pre('系统提示词：写在代码里、每次都一样的规则',d.system));
    return box;
  }
  function history(v){
    var hv=v.history,sc=sec('history','① 电脑历史','调模型','把屏幕和飞书的碎片写成“这 10 分钟你在做什么”。时间线和今日看板里的电脑活动就来自这里。每分钟最多处理 '+hv.perTick+' 段；写不出来会隔 5 分钟重试，最多 5 次。');
    var chips=h('div',{class:'chips'});Object.keys(WSTATE).forEach(function(k){if(hv.states[k])chips.appendChild(chip(WSTATE[k][0]+' '+hv.states[k],WSTATE[k][1]))});sc.appendChild(chips);
    var card=h('div',{class:'card rows'});
    card.appendChild(h('div',{class:'head w4'},[h('span',{text:'时段'}),h('span',{text:'拿到的碎片'}),h('span',{text:'状态'}),h('span',{text:'写出的活动（点一行看全过程）'})]));
    if(!hv.windows.length)card.appendChild(h('div',{class:'empty',text:'这一天没有碎片。'}));
    hv.windows.forEach(function(w){
      var st=WSTATE[w.state]||[w.state,'stone'],label=st[0];
      if(w.state==='written')label=w.asked===false?'已写，没调模型':'已写 '+hm(w.writtenAt);
      if(w.state==='retrying'&&w.attempts)label='失败 '+w.attempts+' 次'+(w.retryAt?'，'+hm(w.retryAt)+' 再试':'');
      var out=w.activities.length?w.activities.map(function(a){return a.title}).join('；'):(w.state==='written'?'（没有可记的事）':'');
      card.appendChild(h('button',{class:'row w4','aria-expanded':String(isOpen('window',w.key)),onclick:function(){toggle('window',w.key)}},[
        h('span',{class:'mono',text:hm(w.start)+'–'+hm(w.end)}),
        h('span',{class:'dim clip',text:(bySource(w.bySource)||'0 条')+(w.fragments?'，本人 '+w.own:'')}),
        h('span',null,[chip(label,st[1])]),
        h('span',{class:'clip',text:out})]));
      if(isOpen('window',w.key))card.appendChild(detail?windowDetail(detail):pending());
    });
    sc.appendChild(card);return sc;
  }
  function chatDetail(d){
    var box=h('div',{class:'detail'});
    var j=d.judged,said=!j?'模型还没有判过这个会话。':(j.needsReply?'模型判为要回：'+j.ask:'模型判为不用回。')+(j.current?'':'（这是对更早那批消息的判断）');
    box.appendChild(h('div',{class:'dim',text:(d.waiting?'还在等你回。':'现在已经不在等你回（你回过了，或你把它放到一边了）。')+said}));
    box.appendChild(h('div',{class:'cols'},[h('div',null,[h('h3',{text:'会话里最近的消息'}),fragList(d.fragments,'模型指出的那条')]),
      h('div',null,[h('h3',{text:'判断结果'}),j?h('div',{class:'act'},[h('b',{text:j.needsReply?'要回':'不用回'}),j.ask?h('div',{class:'tx',text:j.ask}):null,h('div',{class:'mono',text:hm(j.at)+' 判，'+((j.refs||[]).map(num).join(' ')||'没有引用')})]):h('div',{class:'empty',text:'还没有结果。'})])]));
    if(d.input)box.appendChild(pre('交给模型的原文（标“待回”的是代码认定找你的消息，模型只能在这些里面选）',d.input));
    box.appendChild(pre('系统提示词：写在代码里、每次都一样的规则',d.system));
    return box;
  }
  function followups(v){
    var fv=v.followups,sc=sec('followups','② 要不要回','调模型','代码先挑出“找你的”飞书消息（私聊你，或群里 @ 你）并且你之后没在那个会话说过话的；等满 '+fv.graceMinutes+' 分钟你还没回，才让模型读这个会话，只回答一件事：这里有没有要你回的。超过 '+fv.maxAgeHours+' 小时的不再提醒。');
    var card=h('div',{class:'card rows'});
    card.appendChild(h('div',{class:'head c4'},[h('span',{text:'还在等你回的会话'}),h('span',{text:'找你的消息'}),h('span',{text:'状态'}),h('span',{text:'模型说对方要你做什么'})]));
    if(!fv.conversations.length)card.appendChild(h('div',{class:'empty',text:'现在没有会话在等你回。'+(fv.states['too-old']?'（另有 '+fv.states['too-old']+' 个超过 '+fv.maxAgeHours+' 小时，不再提醒）':'')}));
    fv.conversations.forEach(function(c){
      var st=CSTATE[c.state]||[c.state,'stone'];
      card.appendChild(h('button',{class:'row c4','aria-expanded':String(isOpen('chat',c.id)),onclick:function(){toggle('chat',c.id)}},[
        h('span',{class:'clip',text:c.title}),h('span',{class:'mono',text:c.asks+' 条，最早 '+hm(c.since)}),h('span',null,[chip(st[0],st[1])]),h('span',{class:'clip dim',text:c.ask||''})]));
      if(isOpen('chat',c.id))card.appendChild(detail?chatDetail(detail):pending());
    });
    sc.appendChild(card);
    if(fv.conversations.length&&fv.states['too-old'])sc.appendChild(h('p',{class:'lede',text:'另有 '+fv.states['too-old']+' 个会话超过 '+fv.maxAgeHours+' 小时，不再提醒，没有列出来。'}));
    var log=h('div',{class:'card rows'});
    log.appendChild(h('div',{class:'head c4'},[h('span',{text:'这一天模型判过的'}),h('span',{text:'时间'}),h('span',{text:'结论'}),h('span',{text:'模型说对方要你做什么'})]));
    if(!fv.judgments.length)log.appendChild(h('div',{class:'empty',text:'这一天模型没有判过任何会话。'}));
    fv.judgments.forEach(function(j,i){
      var key='j'+i+'|'+j.id;
      log.appendChild(h('button',{class:'row c4','aria-expanded':String(isOpen('chat',key)),onclick:function(){if(isOpen('chat',key)){open=null;detail=null;render();return}var mine=open={kind:'chat',key:key};detail=null;detailErr=null;render();get('?conversation='+encodeURIComponent(j.id)).then(function(d){if(open!==mine)return;detail=d;render()}).catch(function(e){if(open!==mine)return;detailErr=e.message;render()})}},[
        h('span',{class:'clip',text:j.title||'飞书会话'}),h('span',{class:'mono',text:hm(j.at)}),h('span',null,[chip(j.needsReply?'要回':'不用回',j.needsReply?'pink':'lime')]),h('span',{class:'clip dim',text:j.ask||''})]));
      if(isOpen('chat',key))log.appendChild(detail?chatDetail(detail):pending());
    });
    sc.appendChild(log);return sc;
  }
  function memory(v){
    var m=v.memory;if(!m)return document.createTextNode('');
    var when=function(at){var d=new Date(at);return p2(d.getMonth()+1)+'-'+p2(d.getDate())+' '+hm(at)};
    var sc=sec('memory','④ 自动记「关于你」','调模型','一段对话里你最后一次打字过去 '+m.idleMinutes+' 分钟后，模型只读你自己打的字（不读助理的回答、不读按钮替你发的话），挑出长期的偏好、纠正和事实；每条必须引你的原话，代码核对原话确实在那条消息里才记。每天 '+m.tidyHour+':00 之后整理一次：合并重复、去掉被推翻的，只动自动记的。'+(m.startedAt?'从 '+when(m.startedAt)+' 开始读，之前说的不读。':'还没开始读。')+'现在有 '+m.lines+' 条是自动记的。');
    var MSTATE={waiting:['等对话安静','stone'],due:['下一轮就读','lime'],retrying:['出错，稍后重试','orange'],'gave-up':['出错多次，不再试','pink']};
    var card=h('div',{class:'card rows'});
    card.appendChild(h('div',{class:'head c4'},[h('span',{text:'还没读的对话'}),h('span',{text:'你打的字'}),h('span',{text:'状态'}),h('span',{text:'你最后一次打字'})]));
    if(!m.pending.length)card.appendChild(h('div',{class:'empty',text:'现在没有对话在等着读。'}));
    m.pending.forEach(function(c){var st=MSTATE[c.state]||[c.state,'stone'];card.appendChild(h('div',{class:'t3',style:'grid-template-columns:minmax(0,1.2fr) 150px 150px minmax(0,1.4fr)'},[h('span',{class:'clip',text:c.title}),h('span',{class:'mono',text:c.messages+' 条'}),h('span',null,[chip(st[0],st[1])]),h('span',{class:'mono',text:when(c.lastAt)})]))});
    sc.appendChild(card);
    var log=h('div',{class:'card rows'});
    log.appendChild(h('div',{class:'head c4'},[h('span',{text:'这一天读过的'}),h('span',{text:'时间'}),h('span',{text:'结果'}),h('span',{text:'没通过核对的'})]));
    if(!m.scans.length)log.appendChild(h('div',{class:'empty',text:'这一天没有读过任何对话。'}));
    m.scans.forEach(function(s){log.appendChild(h('div',{class:'t3',style:'grid-template-columns:minmax(0,1.2fr) 150px 150px minmax(0,1.4fr)'},[h('span',{class:'clip',text:s.title}),h('span',{class:'mono',text:hm(s.at)}),h('span',null,[chip('读 '+s.messages+' 条，记下 '+s.added+' 条',s.added?'lime':'stone')]),h('span',{class:'clip dim',text:s.rejected.length?s.rejected.length+' 条：'+s.rejected.join('；'):''})]))});
    sc.appendChild(log);
    sc.appendChild(h('p',{class:'lede',text:m.tidied?'最近一次整理：'+when(m.tidied.at)+'，当时 '+m.tidied.lines+' 条，去掉 '+m.tidied.retired+' 条'+(m.tidied.rejected.length?'，'+m.tidied.rejected.length+' 条提议没通过核对':'')+'。':'还没有整理过。'}));
    return sc;
  }
  function attention(v){
    var a=v.attention,sc=sec('attention','③ 飞书关注','不调模型','纯代码的分发员：② 判为要回的，它负责交给助理。三种模式——关闭：什么都不做；只记录：记下“本来会提醒什么”，不叫醒助理；自动提醒：放进助理的收件箱并叫醒它。');
    var c=h('div',{class:'card pad'});
    c.appendChild(h('div',{class:'totals'},[h('span',null,['当前模式 ',h('b',{text:MODE[a.mode]||a.mode})]),h('span',null,['静默时段 ',h('b',{text:p2(a.quiet.from)+':00–'+p2(a.quiet.to)+':00'}),a.quietNow?'（现在在静默）':'']),h('span',null,['今天已叫醒 ',h('b',{text:a.wokeToday+' / '+a.dailyWakes}),'次'])]));
    c.appendChild(h('div',{class:'dim',style:'font-size:13px;margin-top:6px',text:'模式没有开关按钮：直接对助理说“飞书提醒打开 / 只记录 / 关掉”，它会改。静默时段和每天上限只挡“叫醒”，不丢消息。'}));
    sc.appendChild(c);
    var list=h('div',{class:'card rows'});
    list.appendChild(h('div',{class:'head c4'},[h('span',{text:'这一天它经手的'}),h('span',{text:'时间'}),h('span',{text:'怎么处理的'}),h('span',{text:'对方要你做什么'})]));
    if(!a.items.length)list.appendChild(h('div',{class:'empty',text:'这一天没有经手任何消息。'}));
    a.items.forEach(function(x){list.appendChild(h('div',{class:'t3',style:'grid-template-columns:minmax(0,1.2fr) 150px 150px minmax(0,1.4fr)'},[h('span',{class:'clip',text:(x.who?x.who+'，':'')+(x.title||'飞书会话')}),h('span',{class:'mono',text:hm(x.at)}),h('span',null,[chip(x.raised?(x.woke?'已交给助理并叫醒':'已放进收件箱，没叫醒'):'只记录',x.raised?'pink':'stone')]),h('span',{class:'clip dim',text:x.ask||''})]))});
    sc.appendChild(list);return sc;
  }
  function turns(v){
    var sc=sec('turns','助理被叫醒的每一轮',null,'助理不是一直在跑：有东西进了它的收件箱才醒一轮。每一轮先读收件箱，再自己决定查什么、做什么、说不说话。下面按时间倒序，是它每一轮被什么叫醒、依次用了哪些工具。');
    var card=h('div',{class:'card rows'});
    card.appendChild(h('div',{class:'head',style:'grid-template-columns:52px minmax(0,1fr) minmax(0,2fr) 76px'},[h('span',{text:'结束'}),h('span',{text:'被什么叫醒'}),h('span',{text:'依次做了什么'}),h('span',{text:'结果'})]));
    if(!v.turns.length)card.appendChild(h('div',{class:'empty',text:'这一天助理没有被叫醒过。'}));
    v.turns.forEach(function(t){
      var why=h('div',{class:'chips'});if(!t.inbox.length)why.appendChild(h('span',{class:'dim',text:'收件箱里没有新东西'}));
      t.inbox.forEach(function(i){why.appendChild(chip((INBOX[i.kind]||i.kind)+(i.n>1?' ×'+i.n:''),i.kind==='message.posted'?'cyan':i.kind==='request:important'||i.kind==='feishu.attention'?'pink':i.kind.indexOf('request:')===0?'yellow':''))});
      var did=h('div',{class:'chips'});if(!t.tools.length)did.appendChild(h('span',{class:'dim',text:'没有用工具'}));
      t.tools.forEach(function(x){did.appendChild(chip(TOOL[x.tool]||x.tool,x.ok?(x.tool==='hub_reply'||x.tool==='hub_card_propose'?'lime':''):'orange',x.tool+(x.ok?'':'（失败）')+(x.ms!=null?'，'+x.ms+' 毫秒':'')))});
      card.appendChild(h('div',{class:'t3'},[h('span',{class:'mono',text:hm(t.at)}),why,did,h('span',null,[chip(t.silent?'没说话':'说了话',t.silent?'stone':'lime')])]));
    });
    sc.appendChild(card);return sc;
  }
  function render(){
    var v=view;if(!v)return;main.innerHTML='';
    document.getElementById('day').textContent=v.day+(v.day===v.today?'，今天':'');
    document.getElementById('next').disabled=v.day===v.today;
    document.getElementById('at').textContent='取数 '+hm(v.now);
    [flow(v),sources(v),history(v),followups(v),attention(v),memory(v),turns(v)].forEach(function(x){main.appendChild(x)});
  }
  function load(my){
    get(day?'?day='+day:'').then(function(d){if(my!==gen)return;light.className='light on';view=d;day=d.day;render()}).catch(function(e){if(my!==gen)return;light.className='light';if(!view){main.innerHTML='';main.appendChild(h('div',{class:'empty err',text:'读不出来：'+e.message}))}});
  }
  function go(d){day=d;open=null;detail=null;detailErr=null;gen++;load(gen)}
  document.getElementById('prev').onclick=function(){if(day)go(shift(day,-1))};
  document.getElementById('next').onclick=function(){if(day&&view&&view.day!==view.today)go(shift(day,1))};
  document.getElementById('reload').onclick=function(){load(gen)};
  timer=setInterval(function(){if(view&&view.day===view.today&&!document.hidden)load(gen)},60000);
  go(new URLSearchParams(location.search).get('day'));
})();
</script>
</body>
</html>`
}
