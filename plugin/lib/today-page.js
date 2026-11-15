/**
 * 今日看板 as a standalone page at /api/mira-projects/today/view, in the same
 * spirit as the dock: one HTML string, no framework, long-polls
 * /api/mira-projects/today. The project page can link to it or embed it
 * until it grows its own "今天" view.
 */

export function todayHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>今天，个人助理</title>
<style>
:root{color-scheme:light dark;--paper:#fbfaf8;--card:#fff;--ink:#141111;--ink2:rgba(20,17,17,.62);--ink3:rgba(20,17,17,.42);--hair:rgba(20,17,17,.12);--cyan:#1fb4dc;--cyan-s:#d7f2fe;--lav:#8f7fd2;--lav-s:#ebe6f8;--lime:#4f9a2a;--lime-s:#dff5c9;--orange:#e07b2d;--orange-s:#fde6d8;--pink:#d6286f;--pink-s:#ffe0ec;--stone:#8f8a84;--stone-s:#eceae6;--yellow:#ffd440;--yellow-s:#fff4c7;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--paper:#1b1b19;--card:#242422;--ink:#e5e5e2;--ink2:rgba(229,229,226,.66);--ink3:rgba(229,229,226,.45);--hair:rgba(229,229,226,.12);--cyan:#27ccf3;--cyan-s:rgba(39,204,243,.16);--lav:#bbafe6;--lav-s:rgba(187,175,230,.18);--lime:#a9d877;--lime-s:rgba(169,216,119,.18);--orange:#f8a16f;--orange-s:rgba(248,161,111,.18);--pink:#ff99c3;--pink-s:rgba(255,153,195,.18);--stone:#c0b9b1;--stone-s:rgba(192,185,177,.16);--yellow-s:rgba(255,212,64,.14)}}
*{box-sizing:border-box}
html,body{margin:0}
body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,"Noto Sans SC",sans-serif;color:var(--ink);background:var(--paper);-webkit-font-smoothing:antialiased}
header{position:sticky;top:0;z-index:2;background:var(--paper);border-bottom:.5px solid var(--hair)}
.bar{max-width:1040px;margin:0 auto;padding:12px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.face{width:24px;height:24px;border-radius:6px;background:var(--yellow);display:grid;place-items:center;font-size:12px;font-weight:700;color:#141111}
.bar h1{margin:0;font-size:16px;font-weight:600}
.day{font:12px/1 var(--mono);color:var(--ink3)}
.sp{flex:1}
.light{width:7px;height:7px;border-radius:2px;background:var(--stone)}.light.on{background:var(--lime)}.light.busy{background:var(--yellow)}
button,.btn{font:inherit;font-size:13px;line-height:1;padding:7px 10px;border-radius:8px;border:.5px solid var(--hair);background:transparent;color:var(--ink);cursor:pointer;text-decoration:none;display:inline-block}
button:hover,.btn:hover{border-color:var(--ink3)}
button.rec{border-color:var(--ink);font-weight:600}
button.quiet{border-color:transparent;color:var(--ink3)}button.quiet:hover{color:var(--ink);border-color:var(--hair)}
button:disabled{opacity:.5;cursor:default}
main{max-width:760px;margin:0 auto;padding:16px 16px 48px;display:grid;grid-template-columns:minmax(0,1fr);gap:24px}
@media (max-width:760px){main{grid-template-columns:minmax(0,1fr)}}
.wide{grid-column:1/-1}
section{display:flex;flex-direction:column;gap:8px;min-width:0}
h2{margin:0;font-size:12px;font-weight:600;color:var(--ink3);letter-spacing:.02em;display:flex;align-items:center;gap:6px}
h2 .n{font:12px/1 var(--mono);font-weight:400}
.card{border:.5px solid var(--hair);border-radius:8px;background:var(--card);padding:10px 12px;min-width:0}
.card.yellow{background:var(--card)}
.top{display:flex;align-items:center;gap:6px;min-width:0;margin-bottom:2px}
.kind{font-size:12px;padding:1px 6px;border-radius:5px;background:var(--stone-s);color:var(--ink2);white-space:nowrap}
.kind.pink{background:var(--pink-s)}.kind.lav{background:var(--lav-s)}.kind.cyan{background:var(--cyan-s)}.kind.lime{background:var(--lime-s)}.kind.orange{background:var(--orange-s)}.kind.yellow{background:var(--yellow-s)}
.proj{font:12px/1.2 var(--mono);color:var(--ink3);margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:50%}
.title{font-weight:600;font-size:14px;line-height:1.45}
.headline{font-size:16px;font-weight:600;line-height:1.45;margin:2px 0 6px}
.body{color:var(--ink2);font-size:13px;margin-top:2px;word-break:break-word}
.acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.rsec{margin-top:8px}
.rsec b{display:block;font-size:12px;color:var(--ink3);font-weight:600;margin-bottom:2px}
.rsec ul{margin:0;padding-left:18px}
.rsec li{margin:2px 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ref{display:none}
.prow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;align-items:center}
.pname{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chips{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}
.meter{grid-column:1/-1;height:4px;border-radius:2px;background:var(--stone-s);overflow:hidden}
.meter i{display:block;height:100%;background:var(--cyan)}
.meta{grid-column:1/-1;font-size:12px;color:var(--ink3)}
details{grid-column:1/-1}
summary{cursor:pointer;font-size:12px;color:var(--ink2)}
.tl{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.tl li{display:grid;grid-template-columns:44px 10px minmax(0,1fr);gap:8px;align-items:baseline;padding:4px 0;border-bottom:.5px dashed var(--hair);font-size:13px}
.tl li:last-child{border-bottom:0}
.tl time{font:12px/1 var(--mono);color:var(--ink3)}
.tl .dot{width:7px;height:7px;border-radius:2px;background:var(--stone);align-self:center}
.tl .dot.thread{background:var(--cyan)}.tl .dot.done{background:var(--lime)}.tl .dot.review{background:var(--lav)}.tl .dot.failed{background:var(--orange)}.tl .dot.decision{background:var(--pink)}.tl .dot.card{background:var(--yellow)}.tl .dot.pc{background:var(--stone)}.tl .dot.owner{background:var(--ink)}
.tl .where{color:var(--ink3);font-size:12px;margin-right:4px}
.filters{display:flex;flex-wrap:wrap;gap:6px}
.filters button[aria-pressed=true]{border-color:var(--ink);font-weight:600}
.empty{color:var(--ink3);font-size:13px;padding:10px 2px}
.err{color:var(--orange);font-size:12px}
a{color:inherit;text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:2px}
.totals{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--ink2)}
.totals b{font:600 14px/1 var(--mono);color:var(--ink);margin-right:3px}
</style>
</head>
<body>
<header><div class="bar"><span class="face">助</span><h1>今天</h1><span class="day" id="day"></span>
<button class="quiet" id="prev" title="前一天">‹</button><button class="quiet" id="next" title="后一天">›</button>
<span class="sp"></span><span class="day" id="hub"></span><button id="run">现在整理</button><span class="light" id="light"></span></div></header>
<main id="main"><div class="empty wide">正在连接…</div></main>
<script>
(function(){
  var TODAY='/api/mira-projects/today', ACTION='/api/mira-projects/action';
  var KIND={next_step:['下一步','pink'],reminder:['提醒','orange'],open_loop:['没收尾','orange'],recap:['回顾','cyan'],link:['跨项目','lav']};
  var RECAP={morning:'早安回顾',evening:'收工回顾',update:'个人助理的判断'};
  var SEC=[['focus','今天的重心'],['done','做成了什么'],['waiting','等你的'],['stalled','停住的'],['tomorrow','明天先做']];
  var h=function(tag,attrs,kids){var el=document.createElement(tag);attrs=attrs||{};for(var k in attrs){var v=attrs[k];if(v==null)continue;if(k==='class')el.className=v;else if(k==='text')el.textContent=v;else if(k.slice(0,2)==='on')el.addEventListener(k.slice(2),v);else if(k==='disabled')el.disabled=!!v;else el.setAttribute(k,v);}(kids||[]).forEach(function(c){if(c)el.appendChild(typeof c==='string'?document.createTextNode(c):c)});return el};
  var main=document.getElementById('main'), light=document.getElementById('light');
  var since=-1, view=null, day=null, filter=null, gen=0;
  function post(body){return fetch(ACTION,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return {}}).then(function(d){if(!r.ok||d.error)throw new Error(d.error||('HTTP '+r.status));return d})})}
  function jump(projectId,threadId){var msg={type:'mira-dock',projectId:projectId,threadId:threadId||null,prefill:null,at:Date.now()};try{localStorage.setItem('mira-projects:jump',JSON.stringify(msg))}catch(e){}if(window.opener&&!window.opener.closed){try{window.opener.postMessage(msg,location.origin);window.opener.focus();return}catch(e){}}window.open('/','dsh-main')}
  function hm(at){var d=new Date(at);return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)}
  function ago(at){var m=Math.max(0,Math.round((Date.now()-at)/60000));return m<60?m+' 分钟':m<2880?Math.round(m/60)+' 小时':Math.round(m/1440)+' 天'}
  function shift(key,n){var p=key.split('-').map(Number);var d=new Date(p[0],p[1]-1,p[2]+n);return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2)}
  function fail(btn){return function(e){btn.disabled=false;btn.textContent='失败：'+e.message}}
  function sec(title,n,cls){var s=h('section',{class:cls||''});s.appendChild(h('h2',null,[title,n!=null?h('span',{class:'n',text:String(n)}):null]));return s}
  function refs(list){return (list&&list.length)?h('span',{class:'ref',text:list.map(function(r){return '#'+r.split('#')[1]}).join(' ')}):null}

  function recap(v){
    var r=v.recap&&v.recap.latest;
    var s=sec('个人助理的判断',null,'wide');
    if(!r){s.appendChild(h('div',{class:'card yellow'},[h('div',{class:'body',text:v.isToday?'今天还没有回顾':'这一天没有个人助理写的回顾。'})]));return s}
    var c=h('div',{class:'card yellow'},[h('div',{class:'top'},[h('span',{class:'kind yellow',text:RECAP[r.kind]||r.kind}),h('span',{class:'proj',text:hm(r.at)})]),h('div',{class:'headline',text:r.headline})]);
    SEC.forEach(function(p){var items=(r.sections||{})[p[0]]||[];if(!items.length)return;var ul=h('ul');items.forEach(function(it){ul.appendChild(h('li',null,[it.text,refs(it.refs)]))});c.appendChild(h('div',{class:'rsec'},[h('b',{text:p[1]}),ul]))});
    s.appendChild(c);return s;
  }
  function waiting(v){
    var w=v.waiting, n=w.decisions.length+w.review.length+w.failed.length, s=sec('等你的',n);
    if(!n){s.appendChild(h('div',{class:'empty',text:'没有等你的事。'}));return s}
    w.decisions.forEach(function(d){var acts=h('div',{class:'acts'});d.options.forEach(function(o,i){acts.appendChild(h('button',{class:i===d.recommended?'rec':'',title:o.consequence||'',text:o.label+(i===d.recommended?' · 推荐':''),onclick:function(ev){var b=ev.currentTarget;b.disabled=true;post({op:'answerDecision',projectId:d.projectId,decisionId:d.id,chosen:i}).catch(fail(b))}}))});acts.appendChild(h('button',{class:'quiet',text:'打开',onclick:function(){jump(d.projectId,d.threadId)}}));s.appendChild(h('div',{class:'card pink'},[h('div',{class:'top'},[h('span',{class:'kind pink',text:'拍板'}),h('span',{class:'proj',text:d.projectName+' · 等了 '+ago(d.since)})]),h('div',{class:'title',text:d.question}),h('div',{class:'body',text:'「'+d.threadTitle+'」'}),acts]))});
    w.review.forEach(function(t){s.appendChild(h('div',{class:'card lav'},[h('div',{class:'top'},[h('span',{class:'kind lav',text:'待验收'}),h('span',{class:'proj',text:t.projectName+'，'+t.assigneeName+'，'+ago(t.since)})]),h('div',{class:'title',text:t.title}),t.summary?h('div',{class:'body',text:t.summary}):null,h('div',{class:'acts'},[h('button',{class:'rec',disabled:t.usesGitlab&&(!t.gitlab||['ready','merge_error'].indexOf(t.gitlab.status)<0),text:t.usesGitlab?'验收通过并合并':'验收通过',onclick:function(ev){var b=ev.currentTarget;b.disabled=true;post({op:'updateThread',projectId:t.projectId,threadId:t.id,resolved:true,state:'done',expectedSha:t.gitlab&&t.gitlab.sha}).catch(fail(b))}}),h('button',{class:'quiet',text:'打开',onclick:function(){jump(t.projectId,t.id)}})])]))});
    w.failed.forEach(function(t){s.appendChild(h('div',{class:'card orange'},[h('div',{class:'top'},[h('span',{class:'kind orange',text:'失败'}),h('span',{class:'proj',text:t.projectName})]),h('div',{class:'title',text:t.title}),t.summary?h('div',{class:'body',text:t.summary}):null,h('div',{class:'acts'},[h('button',{text:'打开',onclick:function(){jump(t.projectId,t.id)}})])]))});
    return s;
  }
  function cards(v){
    var open=(v.cards||[]).filter(function(c){return c.state==='open'}), s=sec('个人助理的卡',open.length);
    if(!open.length){s.appendChild(h('div',{class:'empty',text:'现在没有个人助理的卡。'}));return s}
    open.forEach(function(c){var k=KIND[c.kind]||[c.kind,'stone'];var t=c.target||{};var acts=h('div',{class:'acts'});(c.actions||[]).forEach(function(a){acts.appendChild(h('button',{class:a.id==='open_thread'||a.id==='handoff'?'rec':'',text:a.label||a.id,title:a.text||'',onclick:function(ev){var b=ev.currentTarget;b.disabled=true;var p=a.id==='copy_text'&&navigator.clipboard?navigator.clipboard.writeText(a.text||c.body||c.title).catch(function(){}):Promise.resolve();p.then(function(){return post({op:'cardAction',projectId:'hub',cardId:c.id,actionId:a.id})}).then(function(){if(a.id==='open_thread')jump(t.projectId,t.threadId);if(a.id==='open_project'||a.id==='handoff')jump(t.projectId,null)}).catch(fail(b))}}))});acts.appendChild(h('button',{class:'quiet',text:'关掉',onclick:function(ev){var b=ev.currentTarget;b.disabled=true;post({op:'cardAction',projectId:'hub',cardId:c.id,actionId:'dismiss'}).catch(fail(b))}}));
      s.appendChild(h('div',{class:'card '+k[1]},[h('div',{class:'top'},[h('span',{class:'kind '+k[1],text:k[0]}),c.level==='interrupt'?h('span',{class:'kind pink',text:'可打断'}):null,h('span',{class:'proj',text:(t.projectName||'')+(t.threadTitle?'，'+t.threadTitle:'')})]),h('div',{class:'title',text:c.title}),c.body?h('div',{class:'body',text:c.body}):null,acts,h('div',{class:'body'},[refs(c.refs)])]))});
    return s;
  }
  function projects(v){
    var s=sec('各项目进展',v.projects.length,'wide');
    var t=v.totals;s.appendChild(h('div',{class:'totals'},[h('span',null,[h('b',{text:String(t.events)}),'条动态']),h('span',null,[h('b',{text:String(t.opened)}),'个新线程']),h('span',null,[h('b',{text:String(t.done)}),'个完成']),h('span',null,[h('b',{text:String(t.answered)}),'次拍板']),h('span',null,[h('b',{text:String(v.pcMinutes)}),'分钟设备活动'])]));
    if(!v.projects.length){s.appendChild(h('div',{class:'empty',text:'这一天没有项目动态。'}));return s}
    v.projects.forEach(function(p){
      var ch=h('div',{class:'chips'});
      [['完成',p.done.length,'lime'],['进行中',p.working.length,'cyan'],['等你',p.blocked.length,'pink'],['待验收',p.review.length,'lav'],['失败',p.failed.length,'orange']].forEach(function(x){if(x[1])ch.appendChild(h('span',{class:'kind '+x[2],text:x[0]+' '+x[1]}))});
      var pct=p.checklist.total?Math.round(100*p.checklist.done/p.checklist.total):0;
      var det=null, rows=[].concat(p.done.map(function(r){return ['完成',r]}),p.working.map(function(r){return ['进行中',r]}),p.blocked.map(function(r){return ['等你',r]}),p.review.map(function(r){return ['待验收',r]}));
      if(rows.length){var ul=h('ul',{class:'tl'});rows.forEach(function(x){var r=x[1];ul.appendChild(h('li',null,[h('time',{text:x[0]}),h('span',{class:'dot '+({'完成':'done','进行中':'thread','等你':'decision','待验收':'review'})[x[0]]}),h('span',null,[h('a',{href:'#',text:r.title,onclick:function(e){e.preventDefault();jump(p.id,r.id)}}),'，'+r.assigneeName+(r.checklist.total?' · 清单 '+r.checklist.done+'/'+r.checklist.total:'')+(r.summary?'，'+r.summary:'')])]))});det=h('details',null,[h('summary',{text:'展开 '+rows.length+' 个线程'}),ul])}
      s.appendChild(h('div',{class:'card'},[h('div',{class:'prow'},[h('a',{class:'pname',href:'#',text:p.name,onclick:function(e){e.preventDefault();jump(p.id,null)}}),ch,h('div',{class:'meter'},[h('i',{style:'width:'+pct+'%'})]),h('div',{class:'meta',text:'清单 '+p.checklist.done+'/'+p.checklist.total+' · 今天 '+p.events+' 条动态'+(p.pcMinutes?' · 电脑上 '+p.pcMinutes+' 分钟':'')+(p.busy.length?'，'+p.busy.join('、')+' 在跑':'')+(p.lastAt?' · 最后 '+hm(p.lastAt):'')}),det])]));
    });
    return s;
  }
  function devices(v){
    var rows=v.devices||[],s=sec('设备活动',rows.length,'wide');
    s.appendChild(h('p',{class:'meta',text:'活动分钟按设备累计；同一时段的多台设备分别记账。'}));
    if(!rows.length)s.appendChild(h('div',{class:'empty',text:'还没有电脑活动摘要。连接桌面后会按设备显示。'}));
    rows.forEach(function(d){s.appendChild(h('div',{class:'card'},[h('strong',{text:d.name}),h('div',{class:'meta',text:d.minutes+' 分钟 · '+d.windows+' 个摘要窗 · 最近 '+hm(d.lastAt)})]))});
    return s;
  }
  function timeline(v){
    var s=sec('事件回顾',v.timeline.length,'wide');
    var names=[];v.timeline.forEach(function(e){if(names.indexOf(e.projectName)<0)names.push(e.projectName)});
    if(names.length>1){var f=h('div',{class:'filters'});[null].concat(names).forEach(function(n){f.appendChild(h('button',{'aria-pressed':String(filter===n),text:n||'全部',onclick:function(){filter=n;render()}}))});s.appendChild(f)}
    var list=v.timeline.filter(function(e){return filter==null||e.projectName===filter});
    if(!list.length){s.appendChild(h('div',{class:'empty',text:'没有事件。'}));return s}
    var ul=h('ul',{class:'tl'});list.slice().reverse().forEach(function(e){ul.appendChild(h('li',null,[h('time',{text:hm(e.at)}),h('span',{class:'dot '+e.kind}),h('span',null,[h('span',{class:'where',text:e.projectName}),e.threadId&&e.projectId?h('a',{href:'#',text:e.text,onclick:function(ev){ev.preventDefault();jump(e.projectId,e.threadId)}}):e.text])]))});
    s.appendChild(h('div',{class:'card'},[ul]));return s;
  }
  function render(){
    var v=view;main.innerHTML='';if(!v)return;
    document.getElementById('day').textContent=v.day+(v.isToday?'，今天':'');
    document.getElementById('next').disabled=v.isToday;
    document.getElementById('hub').textContent=v.hubStatus==='running'?'个人助理在整理…':'';
    [waiting(v),recap(v),cards(v),projects(v),devices(v),timeline(v)].forEach(function(x){main.appendChild(x)});
    var n=v.waiting.decisions.length+v.waiting.review.length;document.title=(n?'('+n+') ':'')+'今天，个人助理';
  }
  function loop(my){
    if(my!==gen)return;
    var q=TODAY+'?since='+since+'&wait='+(since>=0?'1':'0')+(day?'&day='+day:'');
    fetch(q,{credentials:'same-origin',cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(d){if(my!==gen)return;if(d.error)throw new Error(d.error);light.className='light '+(d.hubStatus==='running'?'busy':'on');since=d.rev;view=d;day=d.day;render();setTimeout(function(){loop(my)},50)}).catch(function(e){if(my!==gen)return;light.className='light';main.innerHTML='';main.appendChild(h('div',{class:'empty err wide',text:'连接中断，正在重试：'+e.message}));setTimeout(function(){loop(my)},2500)});
  }
  function go(d){day=d;since=-1;filter=null;gen++;loop(gen)}
  document.getElementById('prev').onclick=function(){if(day)go(shift(day,-1))};
  document.getElementById('next').onclick=function(){if(day&&view&&!view.isToday)go(shift(day,1))};
  document.getElementById('run').onclick=function(ev){var b=ev.currentTarget;b.disabled=true;post({op:'hubRun'}).then(function(){b.textContent='已请个人助理整理';setTimeout(function(){b.disabled=false;b.textContent='现在整理'},4000)}).catch(fail(b))};
  go(new URLSearchParams(location.search).get('day'));
})();
</script>
</body>
</html>`
}
