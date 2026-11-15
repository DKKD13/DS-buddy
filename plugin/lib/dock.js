/**
 * The floating window: a small standalone page the owner pops out of the
 * project page (window.open with popup=yes) or opens in a side browser. It
 * shows what waits for the owner across projects, lets them act on it, and
 * hands navigation back to the main page. No framework: one HTML string.
 */

export function dockHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>个人助理</title>
<style>
:root{color-scheme:light dark;--paper:#fff;--card:#fff;--ink:#141111;--ink2:rgba(20,17,17,.62);--ink3:rgba(20,17,17,.42);--hair:rgba(20,17,17,.14);--cyan:#1fb4dc;--cyan-s:#d7f2fe;--lav:#8f7fd2;--lav-s:#ebe6f8;--lime:#4f9a2a;--lime-s:#dff5c9;--orange:#e07b2d;--orange-s:#fde6d8;--pink:#d6286f;--pink-s:#ffe0ec;--stone:#8f8a84;--stone-s:#eceae6;--yellow:#ffd440;--yellow-s:#fff4c7;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--paper:#1b1b19;--card:#242422;--ink:#e5e5e2;--ink2:rgba(229,229,226,.66);--ink3:rgba(229,229,226,.45);--hair:rgba(229,229,226,.12);--cyan-s:rgba(39,204,243,.16);--lav-s:rgba(187,175,230,.18);--lime-s:rgba(169,216,119,.18);--orange-s:rgba(248,161,111,.18);--pink-s:rgba(255,153,195,.18);--stone-s:rgba(192,185,177,.16);--yellow-s:rgba(255,212,64,.14);--cyan:#27ccf3;--lav:#bbafe6;--lime:#a9d877;--orange:#f8a16f;--pink:#ff99c3;--stone:#c0b9b1}}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,"Noto Sans SC",sans-serif;color:var(--ink);background:var(--paper);-webkit-font-smoothing:antialiased}
header{position:sticky;top:0;display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--paper);border-bottom:1px solid var(--hair);z-index:2}
header b{font-size:14px;font-weight:600}
header .face{width:22px;height:22px;border-radius:5px;background:var(--yellow);display:grid;place-items:center;font-size:11px;font-weight:700;color:#141111}
header .light{width:7px;height:7px;border-radius:2px;background:var(--stone);margin-left:auto}
header .light.on{background:var(--lime)}header .light.busy{background:var(--yellow)}
header .n{font:11px/1 var(--mono);color:var(--ink3)}
main{padding:10px 12px 24px;display:flex;flex-direction:column;gap:14px}
h2{margin:0 0 6px;font-size:11px;font-weight:600;color:var(--ink3);letter-spacing:.02em}
h2 i{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--pink);margin-right:6px;vertical-align:1px}
.list{display:flex;flex-direction:column;gap:8px}
.card{position:relative;border:1px solid var(--hair);border-radius:8px;background:var(--card);padding:9px 11px}
.card.yellow{background:var(--yellow-s)}
.top{display:flex;align-items:center;gap:6px;min-width:0;margin-bottom:2px}
.kind{font-size:11px;padding:1px 6px;border-radius:5px;background:var(--stone-s);color:var(--ink2);white-space:nowrap}
.kind.pink{background:var(--pink-s)}.kind.lav{background:var(--lav-s)}.kind.cyan{background:var(--cyan-s)}.kind.lime{background:var(--lime-s)}.kind.orange{background:var(--orange-s)}
.proj{font:11px/1 var(--mono);color:var(--ink3);margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%}
.title{font-weight:600;font-size:14px;line-height:1.4}
.body{color:var(--ink2);font-size:13px;margin-top:2px;word-break:break-word}
.acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
button{font:inherit;font-size:12.5px;line-height:1;padding:7px 10px;border-radius:8px;border:1px solid var(--hair);background:transparent;color:var(--ink);cursor:pointer}
button:hover{border-color:var(--ink3)}
button.rec{border-color:var(--ink);font-weight:600}
button.quiet{border-color:transparent;color:var(--ink3)}
button.quiet:hover{border-color:var(--hair);color:var(--ink)}
button:disabled{opacity:.5;cursor:default}
.why{font:11px/1.4 var(--mono);color:var(--ink3);margin-top:6px}
.who{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink2)}
.who i{width:8px;height:8px;border-radius:2px;background:var(--yellow);flex:none}
.who b{color:var(--ink);font-weight:600}
.empty{color:var(--ink3);font-size:13px;padding:18px 4px;text-align:center}
.err{color:var(--orange);font-size:12px}
footer{padding:8px 14px 16px;color:var(--ink3);font-size:11px;display:flex;justify-content:space-between}
footer a{color:inherit}
</style>
</head>
<body>
<header><span class="face">助</span><b>个人助理</b><span class="n" id="count"></span><span class="light" id="light" title="连接"></span></header>
<main id="main"><div class="empty">正在连接…</div></main>
<footer><span id="hint">点“打开”会跳回项目页</span><a href="/" target="dsh-main">项目页</a></footer>
<script>
(function(){
  var STATE='/api/mira-projects/state', ACTION='/api/mira-projects/action';
  var ACT_LABEL={open_project:'打开项目',handoff:'交给项目',open_thread:'打开线程',reply:'回一句',save_memory:'记下来',copy_text:'复制'};
  var KIND={next_step:['下一步','pink'],reminder:['提醒','orange'],open_loop:['没收尾','orange'],recap:['回顾','cyan'],link:['跨项目','lav'],capture:['记一下','lav'],morning:['早安回顾','yellow']};
  function recap(at){var hh=new Date(at||Date.now()).getHours();return hh<11?'早安回顾':hh<18?'今日回顾':'晚间回顾'}
  var TOOL={inbox_read:'在读收件箱',post_message:'在写回复',update_card:'在更新卡片',request_decision:'在准备拍板卡',withdraw_decision:'在作废拍板',open_thread:'在开线程',list_threads:'在看线程',read_thread:'在看线程',message_thread:'在转达',message_coordinator:'在转达给协调员',memory_read:'在读记忆',memory_write:'在写记忆',card_propose:'在准备卡片',no_reply:'刚结束一轮'};
  var h=function(tag,attrs,kids){var el=document.createElement(tag);attrs=attrs||{};for(var k in attrs){if(k==='class')el.className=attrs[k];else if(k==='text')el.textContent=attrs[k];else if(k.slice(0,2)==='on')el.addEventListener(k.slice(2),attrs[k]);else if(k==='disabled')el.disabled=!!attrs[k];else el.setAttribute(k,attrs[k]);}(kids||[]).forEach(function(c){if(c)el.appendChild(typeof c==='string'?document.createTextNode(c):c)});return el};
  var light=document.getElementById('light'), main=document.getElementById('main'), count=document.getElementById('count');
  var since=-1, snap=null, busy={};
  function esc(s){return String(s==null?'':s)}
  function post(body){return fetch(ACTION,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return {}}).then(function(d){if(!r.ok||d.error)throw new Error(d.error||('HTTP '+r.status));return d})})}
  function jump(projectId,threadId,prefill){
    var msg={type:'mira-dock',projectId:projectId,threadId:threadId||null,prefill:prefill||null,at:Date.now()};
    try{localStorage.setItem('mira-projects:jump',JSON.stringify(msg))}catch(e){}
    if(window.opener&&!window.opener.closed){try{window.opener.postMessage(msg,location.origin);window.opener.focus();return}catch(e){}}
    window.open('/','dsh-main');
  }
  function doAction(card,action,btn){
    if(busy[card.id])return;busy[card.id]=true;btn.disabled=true;
    var p;
    if(action.id==='copy_text'){p=(navigator.clipboard?navigator.clipboard.writeText(action.text||card.body||card.title):Promise.resolve()).catch(function(){}).then(function(){return post({op:'cardAction',projectId:card.projectId,cardId:card.id,actionId:'copy_text'})})}
    else p=post({op:'cardAction',projectId:card.projectId,cardId:card.id,actionId:action.id});
    p.then(function(){var to=card.jumpProjectId||card.projectId;if(action.id==='open_thread')jump(to,card.threadId);if(action.id==='open_project'||action.id==='handoff')jump(to,null);if(action.id==='reply')jump(to,card.threadClosed?null:card.threadId,action.text||'')}).catch(function(e){btn.disabled=false;btn.textContent='失败：'+e.message}).then(function(){busy[card.id]=false});
  }
  function render(){
    var d=snap&&snap.dock; main.innerHTML='';
    if(!d){main.appendChild(h('div',{class:'empty',text:'没有项目'}));return}
    if(d.headline){main.appendChild(h('div',{class:'card yellow'},[h('div',{class:'top'},[h('span',{class:'kind',text:({morning:'早安回顾',evening:'收工回顾',update:'个人助理的判断'})[d.headline.kind]||'个人助理的判断'}),h('a',{class:'proj',href:'/api/mira-projects/today/view',target:'mira-today',text:'今日看板'})]),h('div',{class:'title',text:d.headline.headline})]))}
    var total=d.waiting.length+d.review.length+d.cards.length;
    count.textContent=total?total+' 件等你':'';
    document.title=total?'('+total+') 个人助理':'个人助理';
    if(d.waiting.length){var s=h('section');s.appendChild(h('h2',null,[h('i'),'等你拍板']));var l=h('div',{class:'list'});d.waiting.forEach(function(w){var opts=h('div',{class:'acts'});w.options.forEach(function(o,i){opts.appendChild(h('button',{class:i===w.recommended?'rec':'',title:o.consequence||'',onclick:function(ev){var b=ev.currentTarget;b.disabled=true;post({op:'answerDecision',projectId:w.projectId,decisionId:w.id,chosen:i}).catch(function(e){b.disabled=false;b.textContent='失败：'+e.message})},text:o.label+(i===w.recommended?' · 推荐':'')}))});opts.appendChild(h('button',{class:'quiet',text:'打开',onclick:function(){jump(w.projectId,w.threadId)}}));l.appendChild(h('div',{class:'card pink'},[h('div',{class:'top'},[h('span',{class:'kind pink',text:'拍板'}),h('span',{class:'proj',text:w.projectName+' · '+w.threadTitle})]),h('div',{class:'title',text:w.question}),opts]))});s.appendChild(l);main.appendChild(s)}
    if(d.review.length){var s2=h('section');s2.appendChild(h('h2',null,[h('i'),'待验收']));var l2=h('div',{class:'list'});d.review.forEach(function(t){l2.appendChild(h('div',{class:'card lav'},[h('div',{class:'top'},[h('span',{class:'kind lav',text:'待验收'}),h('span',{class:'proj',text:t.projectName+' · '+t.assigneeName})]),h('div',{class:'title',text:t.title}),t.summary?h('div',{class:'body',text:t.summary}):null,h('div',{class:'acts'},[h('button',{class:'rec',disabled:t.usesGitlab&&(!t.gitlab||['ready','merge_error'].indexOf(t.gitlab.status)<0),text:t.usesGitlab?'验收通过并合并':'验收通过',onclick:function(ev){var b=ev.currentTarget;b.disabled=true;post({op:'updateThread',projectId:t.projectId,threadId:t.id,resolved:true,state:'done',expectedSha:t.gitlab&&t.gitlab.sha}).catch(function(e){b.disabled=false;b.textContent='失败：'+e.message})}}),h('button',{class:'quiet',text:'打开',onclick:function(){jump(t.projectId,t.id)}})])]))});s2.appendChild(l2);main.appendChild(s2)}
    var s3=h('section');s3.appendChild(h('h2',{text:'个人助理的卡'}));var l3=h('div',{class:'list'});
    if(!d.cards.length)l3.appendChild(h('div',{class:'empty',text:'现在没有要递给你的卡。个人助理会在项目有进展、或早上第一次打开时整理。'}));
    d.cards.forEach(function(c){var k=c.kind==='morning'?[recap(c.at),'yellow']:(KIND[c.kind]||[c.kind,'stone']);var acts=h('div',{class:'acts'});(c.actions||[]).forEach(function(a){acts.appendChild(h('button',{class:a.id==='open_thread'?'rec':'',text:a.label||ACT_LABEL[a.id]||a.id,onclick:function(ev){doAction(c,a,ev.currentTarget)}}))});acts.appendChild(h('button',{class:'quiet',text:'忽略',onclick:function(ev){doAction(c,{id:'dismiss'},ev.currentTarget)}}));l3.appendChild(h('div',{class:'card '+k[1]},[h('div',{class:'top'},[h('span',{class:'kind '+k[1],text:k[0]}),h('span',{class:'proj',text:c.projectName+(c.threadTitle?' · '+c.threadTitle:'')})]),h('div',{class:'title',text:c.title}),c.body?h('div',{class:'body',text:c.body}):null,acts,h('div',{class:'why',text:'依据 '+(c.evidence||[]).map(function(s){return '#'+s}).join(' ')+(c.confidence!=null?' · 把握 '+Math.round(c.confidence*100)+'%':'')})]))});
    s3.appendChild(l3);main.appendChild(s3);
    if(d.working.length){var s4=h('section');s4.appendChild(h('h2',{text:'现在在忙'}));var l4=h('div',{class:'list'});d.working.forEach(function(w){l4.appendChild(h('div',{class:'who'},[h('i'),h('span',null,[h('b',{text:w.who}),' · '+w.title+' · '+(w.activity&&TOOL[w.activity.tool]||'在想')])]))});s4.appendChild(l4);main.appendChild(s4)}
  }
  function loop(){
    var q=STATE+'?since='+since+'&wait='+(since>=0?'1':'0');
    fetch(q,{credentials:'same-origin',cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(d){light.className='light '+((d.dock&&d.dock.working.length)?'busy':'on');if(d.rev!==since){since=d.rev;snap=d;render()}setTimeout(loop,50)}).catch(function(e){light.className='light';main.innerHTML='';main.appendChild(h('div',{class:'empty err',text:'连接中断，正在重试：'+e.message}));setTimeout(loop,2500)});
  }
  loop();
})();
</script>
</body>
</html>`
}
