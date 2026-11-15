/** Read-only HTTP adapters. Provider continuation URLs are private state, never evidence. */
import { createHash } from 'node:crypto'
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function problem(code, message, retryMs) { const e = Error(message);e.code = code;e.retryMs = retryMs;return e }
const validTime = value => { const t = typeof value === 'number' ? value : Date.parse(value);if (!Number.isSafeInteger(t) || t < 1 || t > 8640000000000000) throw problem('PROVIDER_DATA','来源时间无效');return t }
const plain = (value, limit = 20000) => { if (typeof value !== 'string' || !value.isWellFormed()) throw problem('PROVIDER_DATA','来源正文无效');return value.slice(0,limit).toWellFormed() }
const externalId = value => { if (typeof value !== 'string' || !value || value.length > 1024 || !value.isWellFormed() || /[\x00-\x1f]/.test(value)) throw problem('PROVIDER_DATA','来源记录身份无效');return value }
export function providerURL(config, value, endpoint) {
  let url
  try { url = new URL(value) } catch { throw problem('PROVIDER_DATA','来源分页地址无效') }
  if (url.origin !== config.origin || url.pathname !== endpoint || url.username || url.password || url.hash) throw problem('PROVIDER_DATA','来源分页地址越出已选范围')
  return url.href
}
async function jsonRequest(url, { token, fetcher, signal, now, headers = {} }) {
  const response = await fetcher(url, { method:'GET', headers:{ Authorization:'Bearer '+token, ...headers }, redirect:'error', signal })
  if (!response.ok) {
    await response.body?.cancel().catch(()=>{})
    const raw = response.headers.get('retry-after'), seconds = /^\d+$/.test(raw || '') ? Number(raw)*1000 : Date.parse(raw || '')-now
    const wait = Number.isFinite(seconds) ? Math.max(1000,Math.min(seconds,3600000)) : undefined
    throw problem([401,403].includes(response.status)?'AUTHENTICATION_REQUIRED':response.status===410?'CURSOR_EXPIRED':response.status===429?'RATE_LIMITED':'PROVIDER_HTTP', [401,403].includes(response.status)?'来源凭据不可用或权限不足':response.status===429?'来源限流，等待后重试':'来源服务暂时不可用', wait)
  }
  const pieces=[];let length=0
  if (!response.body) throw problem('PROVIDER_DATA','来源响应为空')
  for await(const chunk of response.body) { length+=chunk.length;if(length>2*1024*1024) { await response.body.cancel().catch(()=>{});throw problem('PROVIDER_DATA','单页来源资料过大，未推进游标') }pieces.push(chunk) }
  try { return JSON.parse(Buffer.concat(pieces).toString('utf8')) } catch { throw problem('PROVIDER_DATA','来源响应不是有效JSON') }
}
// Reuse Mira's lark-raw-context text/title and locale selection convention, with bounded traversal.
function larkText(value) {
  let nodes=0,length=0;const parts=[]
  const add=text=>{if(typeof text!=='string'||!text.isWellFormed())throw problem('PROVIDER_DATA','飞书正文格式无效');if(length<=20000){parts.push(text.slice(0,20001-length).toWellFormed());length+=text.length+1}}
  const walk=(node,depth=0)=>{
    if(++nodes>5000||depth>24)throw problem('PROVIDER_DATA','飞书正文结构过大')
    if(!node||typeof node!=='object')return
    if(Array.isArray(node)){for(const child of node)walk(child,depth+1);return}
    if(typeof node.text==='string'){add(node.text);return}
    if(typeof node.title==='string')add(node.title)
    for(const key of ['post','zh_cn','en_us','content','elements'])if(node[key]&&typeof node[key]==='object'){walk(node[key],depth+1);return}
    for(const [key,child] of Object.entries(node))if(!['title','href','image_key','file_key'].includes(key))walk(child,depth+1)
  }
  walk(value);return parts.join('\n').slice(0,20001).toWellFormed()
}
function sourceRecord(config, {id,title,text,occurredAt,deleted=false,truncated=false,context=''}) {
  return { externalId:externalId(id), title:plain(title,300), text:plain(text), occurredAt:validTime(occurredAt), deleted:deleted===true, truncated:truncated===true,
    source:config.provider==='graph-mail'?'email':'lark', context:plain(context,500), ...(config.provider==='feishu-chat'?{upstreamRef:'lark:'+id}:{}), trust:'external' }
}
export async function connectorPage(config, { cursor, since, now, token, fetch:fetcher=fetch, signal }) {
  const request = url => jsonRequest(url,{token,fetcher,signal,now,headers:config.provider==='graph-mail'?{Prefer:'outlook.body-content-type="text"'}:{}})
  if (config.provider==='graph-mail') {
    const me = await request(config.origin+'/v1.0/me?$select=id')
    if (me.id !== config.accountId) throw problem('AUTHENTICATION_REQUIRED','来源凭据与所选邮箱身份不符')
    const endpoint='/v1.0/me/mailFolders/inbox/messages/delta'
    const initial=new URL(config.origin+endpoint);initial.searchParams.set('$select','id,subject,body,from,receivedDateTime,lastModifiedDateTime');initial.searchParams.set('$filter','receivedDateTime ge '+new Date(since).toISOString());initial.searchParams.set('$top','50')
    const page=await request(cursor?.url?providerURL(config,cursor.url,endpoint):initial.href)
    if (!Array.isArray(page.value)||page.value.length>1000||Boolean(page['@odata.nextLink'])===Boolean(page['@odata.deltaLink'])) throw problem('PROVIDER_DATA','邮件增量响应缺少有效分页游标')
    const url=providerURL(config,page['@odata.nextLink']||page['@odata.deltaLink'],endpoint)
    if(page['@odata.nextLink']&&url===cursor?.url)throw problem('PROVIDER_DATA','邮件分页游标没有前进')
    const records=page.value.map(m=>{
      if(m['@removed'])return sourceRecord(config,{id:m.id,title:'已删除的邮件',text:'',occurredAt:now,deleted:true})
      if(m.body?.contentType?.toLowerCase()!=='text')throw problem('PROVIDER_DATA','邮箱未返回纯文本正文，未推进游标')
      const name=m.from?.emailAddress?.name || m.from?.emailAddress?.address || '未知发件人',body=plain(m.body.content,20001)
      return sourceRecord(config,{id:m.id,title:plain(m.subject||'无主题',300),text:body,occurredAt:validTime(m.receivedDateTime),truncated:body.length>20000,context:'发件人：'+plain(name,200)})
    })
    return {records,cursor:{url},caughtUp:Boolean(page['@odata.deltaLink'])}
  }
  const endpoint='/open-apis/im/v1/messages', windowStart=cursor?.windowStart ?? since, windowEnd=cursor?.windowEnd ?? now
  const url=new URL(config.origin+endpoint)
  for(const [key,value] of Object.entries({container_id_type:'chat',container_id:config.chatId,start_time:Math.floor(windowStart/1000),end_time:Math.ceil(windowEnd/1000),sort_type:'ByCreateTimeAsc',page_size:50,...(cursor?.pageToken?{page_token:cursor.pageToken}:{})}))url.searchParams.set(key,String(value))
  const page=await request(url.href)
  if(page.code!==0)throw problem([99991663,99991664,99991668,99991672].includes(page.code)?'AUTHENTICATION_REQUIRED':page.code===99991400?'RATE_LIMITED':'PROVIDER_DATA','飞书来源读取未成功')
  if(!Array.isArray(page.data?.items)||page.data.items.length>1000||typeof page.data.has_more!=='boolean'||page.data.has_more&&(typeof page.data.page_token!=='string'||!page.data.page_token||page.data.page_token.length>8192||page.data.page_token===cursor?.pageToken))throw problem('PROVIDER_DATA','飞书来源分页响应无效')
  const records=page.data.items.map(m=>{
    if(m.chat_id!==config.chatId)throw problem('PROVIDER_DATA','飞书响应越出所选会话')
    let text='',truncated=false
    if(m.deleted!==true) {
      if(['text','post'].includes(m.msg_type)) { let content;try{content=JSON.parse(m.body.content)}catch{throw problem('PROVIDER_DATA','飞书正文格式无效')}text=m.msg_type==='text'?plain(content.text,20001):larkText(content) }
      else text='['+plain(m.msg_type||'未知',80)+'消息；此类型正文尚未读取]'
      truncated=text.length>20000
    }
    return sourceRecord(config,{id:m.message_id,title:'飞书消息',text,occurredAt:validTime(Number(m.create_time)),deleted:m.deleted===true,truncated,context:'会话：'+config.chatId+' · 发件人：'+plain(m.sender?.id||'未知',200)})
  })
  const more=page.data.has_more, next=more?{windowStart,windowEnd,pageToken:page.data.page_token}:{windowStart:Math.max(since,windowEnd-300000)}
  return {records,cursor:next,caughtUp:!more}
}
