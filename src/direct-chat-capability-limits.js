const ORDER = Object.freeze(['execution', 'file', 'web', 'external']);

const TEXT = Object.freeze({
  execution: 'Capability limit: Direct Chat cannot execute code or create execution-backed plots.',
  file: 'Capability limit: Direct Chat cannot create, upload, or provide downloadable files or generated media.',
  web: 'Capability limit: Direct Chat cannot search, browse, or open the web.',
  external: 'Capability limit: Direct Chat cannot deploy, publish, message, or change external state.'
});

const NEGATED_ACTION =
  /^(?:do\s+not|don't|dont|never|avoid|without|no\s+need\s+to)\b|^(?:不要|不用|无需|無需|不需要|避免)/iu;
const DISCUSSION_LEAD =
  /^(?:explain|describe|discuss|review|compare|define|translate|summari[sz]e|quote|analy[sz]e|tell\s+me\s+(?:about|how|why|what)|how\b|why\b|what\b|write\s+(?:an?\s+)?(?:tutorial|explanation|guide|example|article)|(?:解释|解釋|描述|讨论|討論|说明|說明|为什么|為什麼|如何|什么是|什麼是))/iu;
const EXECUTION_ACTION =
  /^(?:run|execute)\b[^.!?;\r\n]{0,180}\b(?:python|code|script|program|command|test|calculation)\b|^(?:plot|visuali[sz]e)\b|^(?:make|create|generate|draw|show|render|produce)\b[^.!?;\r\n]{0,160}\b(?:plot|chart|graph)\b|^(?:运行|運行|执行|執行).{0,80}(?:代码|代碼|脚本|腳本|python)|^(?:画图|畫圖|绘图|繪圖|生成图表|生成圖表)/iu;
const FILE_ACTION =
  /^(?:make|create|generate|produce|prepare|compile|typeset|render|export|save|download|upload|provide|return|send|give|share)\b[^.!?;\r\n]{0,220}(?:\b(?:files?|attachments?|downloads?|archives?|pdf|latex|tex|documents?|spreadsheets?|presentations?|images?|photos?|illustrations?|audio|voice|videos?)\b|\.(?:pdf|tex|csv|json|md|docx?|xlsx?|pptx?|zip|tar|gz|py|js|ts|html|svg|png|jpe?g|webp|mp3|wav|m4a|mp4)\b)|^(?:创建|建立|生成|制作|製作|编译|編譯|导出|導出|下载|下載|上传|上傳).{0,140}(?:文件|文档|文檔|pdf|latex|tex|图片|圖片|音频|音頻|视频|視頻)/iu;
const WEB_ACTION =
  /^(?:search|browse|google|visit|fetch|open|read|look\s+up|find)\b[^.!?;\r\n]{0,180}(?:\b(?:web|internet|online|website|site|url)\b|https?:\/\/|www\.)|^(?:搜索|搜尋|浏览|瀏覽|打开|打開|查找|查詢).{0,120}(?:网络|網絡|互联网|互聯網|网站|網站|网页|網頁)/iu;
const EXTERNAL_ACTION =
  /^(?:deploy|publish|push|upload|email|post|submit)\b|^send\b[^.!?;\r\n]{0,160}\b(?:email|notification)\b|^send\b[^.!?;\r\n]{0,160}\bto\s+(?!(?:me|us|here|this\s+chat)\b)\S|^(?:change|update|delete|remove)\b[^.!?;\r\n]{0,160}\b(?:account|website|site|server|deployment|repository|repo|setting|record|remote)\b|^(?:部署|发布|發布|推送|上传|上傳|发送|發送|删除|刪除|修改).{0,120}(?:网站|網站|服务器|伺服器|仓库|倉庫|账号|帳號|设置|設定|邮件|郵件|消息)/iu;

function actionText(value) {
  let text = String(value || '').trim();
  text = text.replace(/^(?:please|kindly)\s+/iu, '');
  text = text.replace(/^(?:can|could|would|will)\s+you\s+(?:(?:please|kindly)\s+)?/iu, '');
  text = text.replace(/^i(?:'d|\s+would)?\s+(?:like|want|need)\s+(?:you\s+)?to\s+/iu, '');
  text = text.replace(/^let(?:'s|\s+us)\s+/iu, '');
  text = text.replace(/^(?:请你?|請你?|麻烦你?|麻煩你?)[ \t]*/u, '');
  return text;
}

function clauses(value) {
  const unquoted = String(value || '')
    .normalize('NFKC')
    .replace(/```[^\r\n]*\r?\n?[\s\S]*?```/gu, ' ')
    .replace(/~~~[^\r\n]*\r?\n?[\s\S]*?~~~/gu, ' ')
    .replace(/`[^`\r\n]*`/gu, ' ')
    .replace(/[“”]([^“”\r\n]*)[“”]/gu, ' ')
    .replace(/"([^"\r\n]*)"/gu, ' ')
    .replace(/[‘’]([^‘’\r\n]*)[‘’]/gu, ' ');
  return unquoted
    .split(/(?:[!?。！？;；\r\n]+|\.(?=\s|$))/u)
    .flatMap((clause) => clause.split(/(?:,\s*)?\b(?:and\s+then|then|but)\b\s+(?=(?:(?:please|kindly)\s+)?(?:do\s+not|don't|dont|never|avoid|run|execute|plot|visuali[sz]e|make|create|generate|draw|show|render|produce|prepare|compile|typeset|export|save|download|upload|provide|return|send|give|share|search|browse|google|visit|fetch|open|read|look\s+up|find|deploy|publish|push|email|post|submit|change|update|delete|remove|explain|describe|discuss|summari[sz]e)\b)/giu))
    .map(actionText)
    .filter(Boolean);
}

export function directChatCapabilityCategories(value) {
  const requested = new Set();
  for (const clause of clauses(value)) {
    if (NEGATED_ACTION.test(clause) || DISCUSSION_LEAD.test(clause)) continue;
    if (EXECUTION_ACTION.test(clause)) requested.add('execution');
    if (FILE_ACTION.test(clause)) requested.add('file');
    const suppliedTextTarget = /\b(?:in|from)\s+(?:the\s+)?(?:supplied|provided|attached|this|given)\s+(?:text|content|document)\b/iu.test(clause);
    if (!suppliedTextTarget && WEB_ACTION.test(clause)) requested.add('web');
    if (EXTERNAL_ACTION.test(clause)) requested.add('external');
  }
  return Object.freeze(ORDER.filter((category) => requested.has(category)));
}

export function directChatCapabilityNotice(value) {
  const categories = directChatCapabilityCategories(value);
  if (categories.length === 0) return '';
  return `${categories.map((category) => TEXT[category]).join('\n')}\n\nI will still complete every supported text or current supplied-image part below.\n\n`;
}
