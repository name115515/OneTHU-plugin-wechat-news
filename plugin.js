/**
 * OneTHU 公众号订阅插件（onethu.wechat.news）—— 单文件 JS 插件
 *
 * 功能：应用内订阅微信公众号 → 看更新列表 → 内置 AI 概览/分类 → 每日重点摘要 → 应用内阅读正文（含图片）。
 * 数据源：免登录公开通道（页面模板 var data / 合集 appmsgalbum / 搜狗搜索 / 自备 RSS），
 *        实现为可插拔 provider 层（见 PROVIDERS 与 README「将来怎么接全量历史」）。
 * 隐私：不需要微信登录态、不需要公众号凭据、不经过任何第三方服务器；正文只在本机内存中解析。
 */

export const manifest = {
  id: "onethu.wechat.news",
  kind: "js",
  name: "公众号订阅",
  version: "0.3.0",
  author: "jerry",
  description:
    "订阅微信公众号：更新列表、AI 概览分类、每日重点摘要、应用内阅读（含图片）。取数走免登录公开通道，可插拔。",
  permissions: ["net:external", "llm", "storage", "ui", "css", "nav"],
  settings: [
    { key: "channels", label: "启用的取数通道（homepage,album,sogou,rss）", type: "text", default: "homepage,album,sogou,rss" },
    { key: "sogouEnabled", label: "搜狗通道（1 开 / 0 关）", type: "text", default: "1" },
    { key: "sogouResolveMax", label: "搜狗临时链接归一上限（每次刷新最多换算几篇，0=不换算）", type: "text", default: "3" },
    { key: "rssUrls", label: "自备 RSS/Atom 源（每行一个，可用于自建 wewe-rss 全量历史）", type: "textarea", default: "" },
    { key: "homepageHids", label: "页面模板 hid 扫描范围", type: "text", default: "1-6" },
    { key: "albumIds", label: "补充合集（每行：名称或biz|album_id）", type: "textarea", default: "" },
    { key: "dailyBodyLimit", label: "生成摘要时抓正文的篇数上限", type: "text", default: "6" },
    { key: "aiEnabled", label: "AI 概览与分类（1 开 / 0 关）", type: "text", default: "1" },
    { key: "dailyAuto", label: "打开页面时自动生成当日摘要（1 开 / 0 关）", type: "text", default: "0" },
    { key: "perSubKeep", label: "每订阅保留篇数", type: "text", default: "60" },
    { key: "requestGapMs", label: "抓取间隔（毫秒，防风控）", type: "text", default: "500" },
    { key: "visionEnabled", label: "识图开关（本期未接线，仅留档）", type: "text", default: "0" },
    { key: "vlmBaseUrl", label: "预留：识图模型 Endpoint（未启用）", type: "text", default: "" },
    { key: "vlmApiKey", label: "预留：识图模型 API Key（未启用）", type: "password", default: "" },
    { key: "vlmModel", label: "预留：识图模型名称（未启用）", type: "text", default: "" },
    { key: "historyToken", label: "预留：公众号后台 token（未启用，将来接全量历史用）", type: "password", default: "" },
    { key: "importMax", label: "导入表格时最多收多少篇（0=不限）", type: "text", default: "2000" },
  ],
  commands: [
    { id: "wechat-refresh", title: "刷新公众号订阅" },
    { id: "wechat-digest", title: "生成公众号日报" },
    { id: "wechat-sub", title: "订阅公众号", inputLabel: "文章链接 / 公众号名 / RSS 地址", inputPlaceholder: "https://mp.weixin.qq.com/s/… 或 清华大学" },
    { id: "wechat-latest", title: "看最新一篇" },
    { id: "wechat-open", title: "打开公众号订阅页" },
    { id: "wechat-import", title: "导入公众号文章表格（CSV）" },
    { id: "wechat-doctor", title: "网络自检（公众号通道）" },
  ],
};

/* ---------- 常量 ---------- */

const TAB_ID = "feed";
const PAGE_KEY = "plugin:" + manifest.id + ":" + TAB_ID;
const MP = "https://mp.weixin.qq.com";
const SOGOU = "https://weixin.sogou.com";
const CATEGORIES = ["科研学术", "讲座活动", "通知公告", "就业实习", "校园生活", "其他"];
const PROMPT_VER = "v1";
const SOGOU_COOLDOWN_MS = 30 * 60 * 1000;
/** 搜狗反爬页特征（搜索页与 /link 中转页都会命中）。 */
const SOGOU_BLOCK_RE = /(antispider|请输入验证码|访问过于频繁|用户您好)/;
const BLOCK_COOLDOWN_MS = 30 * 60 * 1000;
const ARTICLE_MEM_CACHE = 8;
const GLOBAL_KEEP = 600;
const SEEN_KEEP = 1200;
const AI_CACHE_KEEP = 40;
const SETTINGS_TTL_MS = 15000;

const EP = {
  homepage: (biz, hid, cid) => MP + "/mp/homepage?__biz=" + encodeURIComponent(biz) + "&hid=" + hid + "&cid=" + cid + "&scene=18",
  album: (biz, albumId, count) =>
    MP + "/mp/appmsgalbum?__biz=" + encodeURIComponent(biz) + "&action=getalbum&album_id=" + encodeURIComponent(albumId) +
    "&count=" + (count || 20) + "&is_reverse=1&scene=173",
  article: (link) => link,
  sogou: (kw) => SOGOU + "/weixin?type=2&ie=utf8&query=" + encodeURIComponent(kw),
};

const DEFAULTS = {};
for (const s of manifest.settings) DEFAULTS[s.key] = s.default || "";

/* ---------- 错误类型 ---------- */

class WeChatBlockedError extends Error {
  constructor(msg) { super(msg || "文章页被风控拦截"); this.name = "WeChatBlockedError"; this.blocked = true; }
}
class SogouBlockedError extends Error {
  constructor(msg) { super(msg || "搜狗需要验证"); this.name = "SogouBlockedError"; this.blocked = true; }
}
class ChannelGoneError extends Error {
  constructor(msg) { super(msg || "该通道已失效"); this.name = "ChannelGoneError"; this.gone = true; }
}

/* ---------- 小工具 ---------- */

const log = (line) => { try { ctx.log("[wechat] " + line); } catch (_) {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));

/** 全局串行队列：所有出网请求排队 + 固定间隔，避免触发风控。 */
let queueTail = Promise.resolve();
function serial(task, gapMs) {
  const run = queueTail.then(async () => {
    const out = await task();
    if (gapMs) await sleep(gapMs);
    return out;
  });
  queueTail = run.then(() => undefined, () => undefined);
  return run;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const NAMED_ENTITIES = {
  nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", amp: "&",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", hellip: "…", mdash: "—", ndash: "–",
  middot: "·", times: "×", bull: "•", deg: "°", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™",
  emsp: " ", ensp: " ", thinsp: " ", shy: "",
};

function decodeEntities(s) {
  return String(s == null ? "" : s)
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&([a-zA-Z]+);/g, (m, name) => (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/** 去标签取纯文本（标题/摘要用）。 */
function stripTags(html) {
  const noScript = String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  return decodeEntities(noScript.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function hash(s) {
  let h = 2166136261;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

function trimTo(s, n) {
  const str = String(s == null ? "" : s).trim();
  return str.length > n ? str.slice(0, n) + "…" : str;
}

/** 从 text[start] 的 { 或 [ 起做括号配平切片（跳过字符串与转义）。 */
function balancedSlice(text, start) {
  const open = text[start];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, quote = "", escNext = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escNext) { escNext = false; continue; }
      if (ch === "\\") { escNext = true; continue; }
      if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/** 找到 key 之后第一个 { 或 [ 并配平解析成 JSON。 */
function jsonAfter(text, key) {
  const at = String(text || "").indexOf(key);
  if (at < 0) return null;
  for (let i = at + key.length; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      const slice = balancedSlice(text, i);
      if (!slice) return null;
      try { return JSON.parse(slice); } catch (_) { return null; }
    }
    if (ch !== " " && ch !== "=" && ch !== ":" && ch !== "\t" && ch !== "\n" && ch !== "\r") return null;
  }
  return null;
}

/** 容错 JSON：直接解析 → 去代码围栏 → 首 { 到末 } → null。 */
function tolerantJson(text) {
  const s = String(text == null ? "" : text).trim();
  if (!s) return null;
  const tries = [s];
  const fenced = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) tries.push(fenced[1].trim());
  // 逐个取出「顶层配平片段」：AI 常在 JSON 前后夹带说明文字，甚至夹带别的花括号（示例、注释）
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "{" && ch !== "[") continue;
    const one = balancedSlice(s, i);
    if (!one) continue;
    tries.push(one);
    i += one.length - 1;
  }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) tries.push(s.slice(a, b + 1));
  for (const t of tries) { try { return JSON.parse(t); } catch (_) {} }
  return null;
}

function normLink(link) {
  let s = String(link || "").trim().replace(/&amp;/g, "&");
  if (s.startsWith("http://")) s = "https://" + s.slice(7);
  return s.replace(/#.*$/, "");
}

/** 文章主键：优先 mid_idx，否则链接 hash。 */
function articleId(link, mid, idx) {
  if (mid) return String(mid) + "_" + String(idx == null ? "" : idx);
  return "l" + hash(normLink(link));
}

/** 从链接里抠 mid/idx 得到主键（RSS/搜狗这类没有 appmsgid 的来源也能与页面模板对齐去重）。 */
function idFromLink(link) {
  const s = String(link || "");
  const mid = (s.match(/[?&]mid=(\d+)/) || [])[1] || "";
  const idx = (s.match(/[?&]idx=(\d+)/) || [])[1] || "1";
  return articleId(s, mid, idx);
}

function fmtRel(ms) {
  if (!ms) return "";
  const d = Date.now() - ms;
  if (d < 0) return "刚刚";
  const min = Math.floor(d / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return min + " 分钟前";
  const h = Math.floor(min / 60);
  if (h < 24) return h + " 小时前";
  const day = Math.floor(h / 24);
  if (day < 30) return day + " 天前";
  const dt = new Date(ms);
  return dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
}

function todayKey(ms) {
  const d = new Date(ms == null ? Date.now() : ms);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/** 归一化公众号名，用于搜狗候选比对。 */
function normName(s) {
  return String(s || "").toLowerCase().replace(/[^0-9a-z\u4e00-\u9fa5]/g, "");
}

/** 从「已存下且链接长期有效」的文章里按标题找同一篇。
 *  搜狗结果里的标题常被截断成「…的」（如「…第五届第…」），所以除全等外加一层前缀比对。 */
function knownByTitle(known, title) {
  if (!known) return null;
  const exact = known[title];
  if (exact) return exact;
  const k = normName(title);
  if (k.length < 8) return null;
  for (const t in known) {
    const kt = normName(t);
    if (kt.length < 8) continue;
    if (kt.indexOf(k) === 0 || k.indexOf(kt) === 0) return known[t];
  }
  return null;
}

function nameMatch(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  if (x.indexOf(y) >= 0 || y.indexOf(x) >= 0) return true;
  const setB = {};
  for (const ch of y) setB[ch] = 1;
  let hit = 0;
  for (const ch of x) if (setB[ch]) hit++;
  return hit / Math.max(x.length, y.length) >= 0.6;
}

function uniqBy(list, keyFn) {
  const seen = {}, out = [];
  for (const it of list || []) {
    const k = keyFn(it);
    if (!k || seen[k]) continue;
    seen[k] = 1;
    out.push(it);
  }
  return out;
}

function sortByTimeDesc(list) {
  return (list || []).slice().sort((a, b) => (b.t || 0) - (a.t || 0));
}

/* ---------- 设置 ---------- */

let settingsSnap = null;
let settingsAt = 0;
function settings() {
  if (settingsSnap && Date.now() - settingsAt < SETTINGS_TTL_MS) return settingsSnap;
  settingsAt = Date.now();
  settingsSnap = {};
  for (const s of manifest.settings) {
    let v = null;
    try { v = ctx.onethu.settings.get(s.key); } catch (_) { v = null; }
    settingsSnap[s.key] = v == null || v === "" ? (s.default || "") : String(v);
  }
  return settingsSnap;
}

function cfg(key) {
  const v = settings()[key];
  return v == null ? "" : v;
}

function cfgNum(key, dflt) {
  const n = parseInt(cfg(key), 10);
  return Number.isFinite(n) ? n : dflt;
}

function cfgBool(key) {
  const v = String(cfg(key)).trim().toLowerCase();
  return v === "1" || v === "on" || v === "true" || v === "yes";
}

function cfgLines(key) {
  return String(cfg(key) || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** 启用的通道集合（设置 channels ∩ 各通道自身开关）。 */
function enabledChannels() {
  const parts = String(cfg("channels") || "").split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  const set = {};
  for (const p of (parts.length ? parts : ["homepage", "album", "sogou", "rss"])) set[p] = 1;
  if (!cfgBool("sogouEnabled")) delete set.sogou;
  return set;
}

/* ---------- 存储（插件私有 KV，宿主实现为 localStorage） ---------- */

const kv = {
  get(key, dflt) {
    try {
      const v = ctx.onethu.storage.get(key);
      return v == null ? (dflt === undefined ? null : dflt) : v;
    } catch (e) { log("storage.get 失败 " + key + "：" + (e && e.message)); return dflt === undefined ? null : dflt; }
  },
  set(key, val) {
    try { ctx.onethu.storage.set(key, val); return true; }
    catch (e) { log("storage.set 失败 " + key + "：" + (e && e.message)); return false; }
  },
  remove(key) { try { ctx.onethu.storage.remove(key); } catch (_) {} },
};

/* ---------- 网络（自带浏览器头 + cookie 仓） ---------- */

/**
 * 宿主传输层的两条实测约束（2026-10-13 实证，见 apps/desktop/src-tauri/src/lib.rs http_request）：
 *  - 每次调用新建 reqwest client，不设任何默认 User-Agent；
 *  - 该 client 没有跨调用的 cookie 仓（cookie 只在单次调用内部的逐跳链里传递）。
 * 后果：插件请求「没有浏览器标识、也不带 cookie」——实测同一 IP 下，搜狗对无 UA 的请求直接
 * 302 到 /antispider/（无 UA 302、带 UA 200），微信对无会话的请求发 POC 人机验证页。
 * 所以插件自带浏览器头，并按 host 维护轻量 cookie 仓（宿主在 x-onethu-set-cookie-hops 里回传逐跳 Set-Cookie）。
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const JAR_MAX_HOSTS = 8;

const JAR = new Map();

function hostOf(url) {
  const m = String(url || "").match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : "";
}

function jarBucket(host, create) {
  if (!host) return null;
  let b = JAR.get(host);
  if (!b && create) { b = new Map(); JAR.set(host, b); }
  if (b) { JAR.delete(host); JAR.set(host, b); }
  while (JAR.size > JAR_MAX_HOSTS) JAR.delete(JAR.keys().next().value);
  return b || null;
}

function jarHeader(url) {
  const b = jarBucket(hostOf(url), false);
  return b && b.size ? [...b].map((kv) => kv[0] + "=" + kv[1]).join("; ") : "";
}

/** 记一条 Set-Cookie（Max-Age=0 当作删除）。 */
function jarPut(host, sc) {
  const m = /^([^=;]+)=([^;]*)/.exec(String(sc || "").trim());
  if (!m) return;
  const name = m[1].trim();
  const dead = /max-age\s*=\s*0/i.test(sc) || /expires\s*=\s*thu,\s*01\s*jan\s*1970/i.test(sc);
  const b = jarBucket(host, !dead);
  if (!b) return;
  if (dead) b.delete(name); else b.set(name, m[2]);
}

/** Set-Cookie 值里可能含逗号（Expires），只在「逗号 + 名字=」处切开。 */
function splitSetCookie(raw) {
  return String(raw || "").split(/,(?=\s*[A-Za-z0-9_.\-]+=)/).map((s) => s.trim()).filter(Boolean);
}

/** 收 cookie：优先逐跳精确通道，退回扁平通道，再退回 set-cookie 头。 */
function jarAbsorb(url, res) {
  const h = res && res.headers;
  if (!h || typeof h.get !== "function") return;
  const read = (n) => { try { return h.get(n); } catch (_) { return null; } };
  const hops = read("x-onethu-set-cookie-hops");
  if (hops) {
    try {
      const arr = JSON.parse(hops);
      let n = 0;
      for (const it of arr) if (it && it.u && it.l) { jarPut(hostOf(it.u), it.l); n++; }
      if (n) return;
    } catch (_) { /* 通道不可用时退回下一种 */ }
  }
  const all = read("x-onethu-set-cookie");
  if (all) {
    try {
      const arr = JSON.parse(all);
      for (const sc of arr) jarPut(hostOf(url), sc);
      if (arr.length) return;
    } catch (_) { /* 同上 */ }
  }
  const plain = read("set-cookie");
  if (plain) for (const sc of splitSetCookie(plain)) jarPut(hostOf(url), sc);
}

/** 该请求要带的头。 */
function headersFor(url) {
  const host = hostOf(url);
  const h = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };
  if (host.indexOf("weixin.sogou.com") >= 0) h.Referer = SOGOU + "/";
  else if (host.indexOf("mp.weixin.qq.com") >= 0) h.Referer = MP + "/";
  const ck = jarHeader(url);
  if (ck) h.Cookie = ck;
  return h;
}

/** 最终落点 URL（宿主在 x-onethu-final-url 回传，用来识别「被弹到验证页」）。 */
function finalUrlOf(res, fallback) {
  const h = res && res.headers;
  if (h && typeof h.get === "function") {
    try { const f = h.get("x-onethu-final-url"); if (f) return f; } catch (_) { /* ignore */ }
  }
  return fallback;
}

async function getText(url) {
  const gap = cfgNum("requestGapMs", 500);
  return serial(async () => {
    let res;
    try { res = await ctx.onethu.net.fetch(url, { method: "GET", headers: headersFor(url) }); }
    catch (e) { throw new Error("请求失败：" + (e && e.message ? e.message : String(e))); }
    const status = res && typeof res.status === "number" ? res.status : 0;
    const finalUrl = finalUrlOf(res, url);
    try { jarAbsorb(url, res); } catch (e) { log("收 cookie 失败：" + ((e && e.message) || e)); }
    const text = await res.text();
    if (status && status >= 400) throw new Error("HTTP " + status + "（" + String(url).slice(0, 60) + "）");
    return { text: String(text || ""), status: status, len: String(text || "").length, url: finalUrl };
  }, gap);
}

/* ---------- 通用解析小件 ---------- */

/** 解析形如 "1-6, 9" 的范围/列表。 */
function parseRanges(s, max) {
  const out = [];
  for (const part of String(s || "").split(/[,，\s]+/).filter(Boolean)) {
    const mm = part.match(/^(\d+)-(\d+)$/);
    if (mm) {
      const a = parseInt(mm[1], 10), b = parseInt(mm[2], 10);
      for (let i = a; i <= b && out.length < (max || 24); i++) out.push(i);
    } else if (/^\d+$/.test(part)) out.push(parseInt(part, 10));
  }
  return out.length ? out : [1];
}

/** 取标签属性值：attr('<li a="1" b=2>', 'a') → "1"。 */
function attr(tag, name) {
  const key = name + "=";
  let at = String(tag || "").indexOf(key);
  if (at < 0) return "";
  let i = at + key.length;
  const q = tag[i];
  if (q === '"' || q === "'") {
    const end = tag.indexOf(q, i + 1);
    return end < 0 ? "" : decodeEntities(tag.slice(i + 1, end));
  }
  let end = i;
  while (end < tag.length && !/[\s>]/.test(tag[end])) end++;
  return decodeEntities(tag.slice(i, end));
}

/** 取 <img> 的真实图片地址（data-src 优先），只认微信图床。 */
function imgSrc(tag) {
  let src = attr(tag, "data-src") || attr(tag, "src") || "";
  src = String(src).trim();
  if (!/^https:\/\/mmbiz\.(qpic|qlogo)\.cn\//.test(src)) return "";
  return src;
}

/** 时间戳归一化到毫秒。 */
function normTime(v) {
  const n = typeof v === "number" ? v : parseInt(String(v || ""), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? n * 1000 : n;
}

/** 读取 var name = "value"; / var name = 'value'; / var name = token; / var name = "" || "value"; */
function readVar(html, name) {
  const text = String(html || "");
  const key = "var " + name;
  // var biz 会命中 var bizuin，所以要逐处找「名字后紧跟空白或 =」的那一个
  let at = -1;
  for (let p = text.indexOf(key); p >= 0; p = text.indexOf(key, p + 1)) {
    const next = text[p + key.length];
    if (next === undefined || /[\s=]/.test(next)) { at = p; break; }
  }
  if (at < 0) return null;
  let i = at + key.length;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== "=") return null;
  i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  const q = text[i];
  if (q === '"' || q === "'") {
    // 线上真实写法：var biz = "" || "MzI4NjAxNjY4Nw==";（第一段是空串，真值在 || 后面）
    let quote = q;
    let out = "";
    for (let j = i + 1; j < text.length; j++) {
      const ch = text[j];
      if (ch === "\\") { out += text[j + 1] || ""; j++; continue; }
      if (ch !== quote) { out += ch; continue; }
      if (out) return decodeEntities(out);
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (text.slice(k, k + 2) !== "||") return decodeEntities(out);
      k += 2;
      while (k < text.length && /\s/.test(text[k])) k++;
      const nq = text[k];
      if (nq !== '"' && nq !== "'") return decodeEntities(out);
      quote = nq;
      out = "";
      j = k;
    }
    return null;
  }
  let end = i;
  while (end < text.length && !/[;,)]/.test(text[end])) end++;
  const rawv = text.slice(i, end).trim();
  // 线上真实写法：var nickname = htmlDecode("清华大学")（文章标题另有 '…'.html(false) 形式，引号分支已能处理）
  const hd = rawv.match(/^htmlDecode\s*\(\s*(['"])([\s\S]*?)\1/);
  if (hd) return decodeEntities(hd[2]);
  return decodeEntities(rawv);
}

/** 取 number 型 var（mid/idx/ct 可能写成 "123" || "456"）。 */
function readVarNum(html, name) {
  const v = readVar(html, name);
  if (!v) return 0;
  const mm = String(v).match(/\d{3,}/);
  return mm ? parseInt(mm[0], 10) : 0;
}

const ARTICLE_ERR_MARKS = ["环境异常", "未知错误", "请在微信客户端打开", "该内容已被发布者删除", "参数错误", "此内容因违规无法查看"];

/** 搜狗搜索结果里的「临时链接」：带 signature、没有 __biz，只在当时那个会话里短暂有效。 */
function isSogouTempLink(url) {
  const s = String(url || "");
  if (!/^https?:\/\/mp\.weixin\.qq\.com\/s\b/i.test(s)) return false;
  if (/[?&]__biz=/i.test(s)) return false;
  return /[?&]signature=/i.test(s) || (/[?&]src=(11|3|1)\b/i.test(s) && /[?&](timestamp|ver)=/i.test(s));
}

/** 用页面里读出的参数拼一条长期有效的规范链接（临时链接过期后仍能打开）。
 *  实测（2026-10-14）：微信要求 sn —— 只有 __biz&mid&idx 的链接一律落到「参数错误」错误页，
 *  所以拿不到 sn 时宁可返回空串（调用方保留原链接），不要拼一条打不开的链接。 */
function canonicalLink(p) {
  if (!p || !p.biz || !p.mid || !p.sn) return "";
  return MP + "/s?__biz=" + p.biz + "&mid=" + p.mid + "&idx=" + (p.idx || "1") + "&sn=" + p.sn;
}

/** 打不开的文章页 → { reason, hint }：把「验证码 / 临时链接过期 / 链接不完整 / 被删」分开说清楚。 */
function classifyArticleFailure(text, link) {
  const t = String(text || "");
  if (/wappoc_appmsgcaptcha|poc_token=/i.test(t) || t.indexOf("环境异常") >= 0) {
    return {
      reason: "微信要求人机验证",
      hint: "当前网络被微信判定为异常环境（开着代理/VPN、或用机房网络时常见）。关掉代理后重试，或换个网络再试。",
    };
  }
  if (isSogouTempLink(link)) {
    return {
      reason: "临时链接已过期",
      hint: "这是搜狗搜索结果里的临时链接（带 signature），只在当时那个浏览器会话里短暂有效。请在微信里打开文章 → 右上角「…」→ 复制链接，或直接「按名字订阅」；已在列表里的条目可在页面顶部点「刷新」重新抓一次链接。",
    };
  }
  if (t.indexOf("系统出错") >= 0 || t.indexOf("系统繁忙") >= 0) {
    return { reason: "链接已失效或不是正文链接", hint: "请确认给的是文章正文地址（https://mp.weixin.qq.com/s/… 或带 __biz/mid/idx/sn 的完整链接）。" };
  }
  for (const mk of ARTICLE_ERR_MARKS) if (t.indexOf(mk) >= 0) return { reason: mk, hint: "" };
  if (t.indexOf('id="js_content"') < 0) return { reason: "页面里没有正文", hint: "可能指向分享页/被删文章，或微信改了页面结构。" };
  return { reason: "页面异常", hint: "" };
}

/** 解析一篇文章页（正文只在内存，不落库）。 */
function parseArticleHtml(html, link) {
  const text = String(html || "");
  const hasBody = text.indexOf('id="js_content"') >= 0;
  if (text.length < 50000 || !hasBody) {
    const cls = classifyArticleFailure(text, link);
    return { ok: false, blocked: true, reason: cls.reason, hint: cls.hint, len: text.length };
  }
  const title = readVar(text, "msg_title") || stripTags((text.match(/<h1[^>]*>[\s\S]*?<\/h1>/i) || [""])[0]) || "（无标题）";
  const albumRaw = readVar(text, "album_id_str") || readVar(text, "album_id") || "";
  const albumIds = String(albumRaw).split(/[,，\s]+/).filter((s) => /^\d+$/.test(s));
  const canon = normLink(link);
  const out = {
    ok: true,
    title: stripTags(title),
    link: canon,
    // 页面里的 var 读不到时，用链接参数兜底（真实链接本身带 __biz/mid/idx/sn）
    biz: readVar(text, "biz") || bizFromLink(canon) || "",
    mid: readVar(text, "mid") || linkParam(canon, "mid") || "",
    idx: readVar(text, "idx") || linkParam(canon, "idx") || "",
    sn: readVar(text, "sn") || linkParam(canon, "sn") || "",
    t: normTime(readVarNum(text, "ct") || readVarNum(text, "create_time")),
    account: readVar(text, "nickname") || "",
    ghId: readVar(text, "user_name") || "",
    cover: readVar(text, "msg_cdn_url") || "",
    digest: readVar(text, "msg_desc") || "",
    albumIds: albumIds,
    nodes: [],
    imageCount: 0,
  };
  const start = text.indexOf('id="js_content"');
  let end = text.indexOf('id="js_sg_bar"', start);
  if (end < 0) end = text.indexOf("rich_media_tool", start);
  if (end < 0) end = Math.min(text.length, start + 400000);
  const region = text.slice(start, end);
  out.nodes = parseContentNodes(region);
  out.imageCount = out.nodes.filter((n) => n.type === "img").length;
  if (!out.nodes.some((n) => n.type === "p") && !out.imageCount) return { ok: false, blocked: true, reason: "正文为空", len: text.length };
  return out;
}

/** 把 js_content 区块切成有序的段落/图片节点。 */
function parseContentNodes(region) {
  const events = [];
  const pRe = /<p\b[\s\S]*?<\/p>/gi;
  const imgRe = /<img\b[^>]*>/gi;
  const pRanges = [];
  const pImgs = [];
  let m;
  while ((m = pRe.exec(region))) {
    const block = m[0];
    const imgs = [];
    let im;
    imgRe.lastIndex = 0;
    while ((im = imgRe.exec(block))) {
      const src = imgSrc(im[0]);
      if (src) imgs.push(src);
    }
    pRanges.push([m.index, m.index + block.length]);
    for (const s of imgs) pImgs.push({ at: m.index, src: s, used: false });
    const t = stripTags(block.replace(/<img\b[^>]*>/gi, " "));
    events.push({ at: m.index, text: t, imgs: imgs });
  }
  const loose = [];
  let im2;
  imgRe.lastIndex = 0;
  while ((im2 = imgRe.exec(region))) {
    const at = im2.index;
    let inside = false;
    for (const rg of pRanges) if (at >= rg[0] && at < rg[1]) { inside = true; break; }
    if (inside) continue;
    const src = imgSrc(im2[0]);
    if (src) loose.push({ at: at, src: src });
  }
  const merged = [];
  for (const ev of events) merged.push({ at: ev.at, kind: "p", text: ev.text, imgs: ev.imgs });
  for (const lo of loose) merged.push({ at: lo.at, kind: "img", src: lo.src });
  merged.sort((a, b) => a.at - b.at);
  const nodes = [];
  for (const it of merged) {
    if (it.kind === "img") { nodes.push({ type: "img", src: it.src }); continue; }
    for (const s of it.imgs) nodes.push({ type: "img", src: s });
    if (it.text) nodes.push({ type: "p", text: trimTo(it.text, 4000) });
    if (nodes.length > 400) break;
  }
  return nodes;
}

/** 是否「微信错误小页」（2KB 级的未知错误，说明该入口不可用）。 */
function isWeChatErrPage(text) {
  const t = String(text || "");
  return t.length < 4000 && ARTICLE_ERR_MARKS.some((mk) => t.indexOf(mk) >= 0);
}

/** 抓正文（带内存 LRU；正文不落库）。 */
async function fetchArticle(link) {
  const url = normLink(link);
  const id = idFromLink(url);
  const hit = memArticles.get(id);
  if (hit) return hit;
  const { text } = await getText(url);
  const parsed = parseArticleHtml(text, url);
  if (!parsed.ok) throw new WeChatBlockedError("文章打不开（" + parsed.reason + "）" + (parsed.hint ? "：" + parsed.hint : ""));
  memCachePut(id, parsed);
  return parsed;
}

const memArticles = new Map();
function memCachePut(id, val) {
  if (memArticles.has(id)) memArticles.delete(id);
  memArticles.set(id, val);
  while (memArticles.size > ARTICLE_MEM_CACHE) memArticles.delete(memArticles.keys().next().value);
}

/* ---------- 发现通道（可插拔 provider 层） ---------- */

/**
 * provider 契约：{ id, title, needs, discover(sub) → Candidate[] }
 *  - discover 可以读写 sub：回填 sub.ghId / sub.albumIds，写 sub.cursor[自己] 断点、sub.failUntil 冷却；
 *  - 抛出 ChannelGoneError / SogouBlockedError / WeChatBlockedError 表示「该通道暂不可用」，
 *    调度器只记录错误，其它通道与整个插件都不受影响；
 *  - 将来接「全量历史」只需：实现一个新的 provider → 注册进 PROVIDERS → 在 manifest.settings 里加它的字段。
 *    存储、去重、UI、阅读器、AI、命令都不需要改。
 */
function candidateFromAppmsg(it, source) {
  const link = normLink(it.link || it.url || "");
  if (!link) return null;
  const mid = it.appmsgid || it.mid || (link.match(/[?&]mid=(\d+)/) || [])[1] || "";
  const idx = it.itemidx || it.idx || (link.match(/[?&]idx=(\d+)/) || [])[1] || "1";
  return {
    id: articleId(link, mid, idx),
    title: stripTags(it.title || "") || "（无标题）",
    link: link,
    t: normTime(it.update_time || it.sendtime || it.create_time || it.t || it.datetime || 0),
    digest: trimTo(stripTags(it.digest || it.desc || ""), 200),
    cover: it.cover || it.cover_url || "",
    source: source,
  };
}

/** 通道 1：页面模板（mp/homepage，内嵌 var data={"appmsg_list":[…]}）。 */
const homepageProvider = {
  id: "homepage",
  title: "页面模板",
  needs: { biz: true },
  async discover(sub) {
    if (!sub.biz) return [];
    const out = [];
    let sawErr = false;
    for (const hid of parseRanges(cfg("homepageHids") || "1-6", 8)) {
      let any = false;
      for (const cid of [1, 2, 3]) {
        const r = await getText(EP.homepage(sub.biz, hid, cid));
        if (isWeChatErrPage(r.text)) { sawErr = true; break; }
        if (!sub.ghId) {
          const gh = readVar(r.text, "username");
          if (gh) sub.ghId = gh;
        }
        const data = jsonAfter(r.text, "var data");
        const list = (data && data.appmsg_list) || [];
        for (const it of list) { const c = candidateFromAppmsg(it, "homepage"); if (c) out.push(c); }
        if (list.length) any = true;
      }
      if (!any) break;
    }
    if (!out.length && sawErr) throw new ChannelGoneError("页面模板无内容（该号未维护模板）");
    return out;
  },
};

/** 通道 2：合集（mp/appmsgalbum，li.js_album_item + window.cgiData 游标）。 */
function parseAlbumItems(html) {
  const text = String(html || "");
  const out = [];
  const key = "js_album_item";
  let at = text.indexOf(key);
  while (at >= 0) {
    const start = text.lastIndexOf("<li", at);
    const end = text.indexOf(">", at);
    if (start >= 0 && end > start) {
      const tag = text.slice(start, end + 1);
      const link = attr(tag, "data-link");
      if (link) {
        out.push({
          title: attr(tag, "data-title"),
          link: link,
          appmsgid: attr(tag, "data-msgid"),
          itemidx: attr(tag, "data-itemidx"),
          cover: attr(tag, "data-cover"),
        });
      }
    }
    at = text.indexOf(key, at + key.length);
  }
  return out;
}

/** 设置里手填的补充合集：每行「名称|album_id」或「album_id」。 */
function extraAlbumIds(sub) {
  const out = [];
  for (const line of cfgLines("albumIds")) {
    const parts = line.split("|");
    const id = String(parts.length > 1 ? parts[1] : parts[0]).trim();
    if (!/^\d+$/.test(id)) continue;
    const who = parts.length > 1 ? parts[0].trim() : "";
    if (who && who !== sub.biz && sub.name && !nameMatch(who, sub.name)) continue;
    out.push(id);
  }
  return out;
}

const albumProvider = {
  id: "album",
  title: "合集",
  needs: { biz: true },
  async discover(sub) {
    if (!sub.biz) return [];
    const ids = uniqBy(
      (sub.albumIds || []).concat(extraAlbumIds(sub)).map((id) => ({ id: String(id) })),
      (x) => x.id
    ).map((x) => x.id).slice(0, 3);
    if (!ids.length) return [];
    const out = [];
    const cursorMap = Object.assign({}, (sub.cursor && sub.cursor.album) || {});
    for (const albumId of ids) {
      let cursor = cursorMap[albumId] || null;
      const url0 = EP.album(sub.biz, albumId, 20);
      for (let page = 0; page < 5; page++) {
        const url = cursor && cursor.from_msgid
          ? url0 + "&from_msgid=" + encodeURIComponent(cursor.from_msgid) + "&from_itemidx=" + encodeURIComponent(cursor.from_itemidx || "1")
          : url0;
        const r = await getText(url);
        if (isWeChatErrPage(r.text)) throw new ChannelGoneError("合集已失效（album_id=" + albumId + "）");
        for (const it of parseAlbumItems(r.text)) { const c = candidateFromAppmsg(it, "album"); if (c) out.push(c); }
        const cgi = jsonAfter(r.text, "cgiData") || {};
        if (String(cgi.continue_flag) === "1" && cgi.from_msgid) {
          cursor = { from_msgid: cgi.from_msgid, from_itemidx: cgi.from_itemidx };
        } else {
          cursor = null;
          break;
        }
      }
      if (cursor) cursorMap[albumId] = cursor; else delete cursorMap[albumId];
    }
    sub.cursor = Object.assign({}, sub.cursor, { album: cursorMap });
    return out;
  },
};

/** 搜狗反爬时的统一提示（含可操作建议）。 */
function sogouBlockMessage() {
  return "搜狗要求验证码（反爬拦截，该通道已暂停 " + Math.round(SOGOU_COOLDOWN_MS / 60000) + " 分钟）。常见原因：请求太频繁、网络走了代理/VPN、或客户端被判为脚本。" +
    "可稍后重试、关掉代理再试，或改用「粘贴文章链接」订阅。";
}

/** 通道 3：搜狗微信文章搜索（未登录可用，可能触发验证码）。 */
function parseSogouList(html) {
  const text = String(html || "");
  const out = [];
  const key = 'class="txt-box"';
  let at = text.indexOf(key);
  while (at >= 0) {
    const next = text.indexOf(key, at + key.length);
    const block = text.slice(at, next < 0 ? at + 4000 : next);
    const h3a = block.match(/<h3[^>]*>[\s\S]*?<\/h3>/i);
    const title = stripTags(h3a ? h3a[0] : "");
    const hrefM = block.match(/href="(\/link\?url=[^"]+)"/);
    let t = 0;
    // 线上（2026-10 实测）时间写在 document.write(timeConvert('1712577628')) 里，旧结构是 t="…" 属性
    const tM = block.match(/\st="(\d{9,13})"/) || block.match(/timeConvert\('(\d{9,13})'\)/);
    if (tM) t = normTime(tM[1]);
    let account = "";
    const acc2 = block.match(/<span class="all-time-y2"[^>]*>([\s\S]*?)<\/span>/i);
    if (acc2) account = stripTags(acc2[1]);
    const accAt = account ? -1 : block.indexOf('class="account"');
    if (accAt >= 0) {
      const gt = block.indexOf(">", accAt);
      const close = block.indexOf("</a>", gt);
      if (gt >= 0 && close > gt) account = stripTags(block.slice(gt + 1, close));
    }
    const infoM = block.match(/<p class="txt-info"[^>]*>([\s\S]*?)<\/p>/i);
    if (title && hrefM) out.push({ title: title, rel: hrefM[1], t: t, account: account, digest: trimTo(stripTags(infoM ? infoM[1] : ""), 200) });
    if (next < 0) break;
    at = next;
  }
  return out;
}

/** 搜狗中转页 → 真实文章链接（拼 url += '…' 片段）。 */
function sogouRealLink(html) {
  const text = String(html || "");
  let i = text.indexOf("url +=");
  let out = "";
  while (i >= 0) {
    const q1 = text.indexOf("'", i);
    const q2 = text.indexOf("'", q1 + 1);
    if (q1 < 0 || q2 < 0) break;
    out += text.slice(q1 + 1, q2);
    i = text.indexOf("url +=", q2);
  }
  if (!out) {
    const m = text.match(/http:\/\/mp\.weixin\.qq\.com\/s\?[^"'\s<>]+/);
    out = m ? m[0] : "";
  }
  return out ? normLink(decodeEntities(out)) : "";
}

const sogouProvider = {
  id: "sogou",
  title: "搜狗搜索",
  needs: { kw: true },
  async discover(sub, _cfg, ext) {
    if (sub.failUntil && sub.failUntil.sogou && Date.now() < sub.failUntil.sogou) return [];
    const kws = ((sub.keywords && sub.keywords.length ? sub.keywords : [sub.name]) || []).filter(Boolean).slice(0, 2);
    const resolveMax = cfgNum("sogouResolveMax", 3);
    const known = (ext && ext.known) || null;
    const out = [];
    let resolved = 0;
    for (const kw of kws) {
      const r = await getText(EP.sogou(kw));
      if (SOGOU_BLOCK_RE.test(r.text)) {
        sub.failUntil = Object.assign({}, sub.failUntil, { sogou: Date.now() + SOGOU_COOLDOWN_MS });
        throw new SogouBlockedError(sogouBlockMessage());
      }
      for (const it of parseSogouList(r.text)) {
        if (sub.name && it.account && !nameMatch(it.account, sub.name)) {
          const byKw = (sub.keywords || []).some((k) => normName(it.title).indexOf(normName(k)) >= 0);
          if (!byKw) continue;
        }
        let link = "";
        if (it.rel) {
          try {
            const hop = await getText(SOGOU + it.rel);
            if (SOGOU_BLOCK_RE.test(hop.text)) {
              sub.failUntil = Object.assign({}, sub.failUntil, { sogou: Date.now() + SOGOU_COOLDOWN_MS });
              throw new SogouBlockedError(sogouBlockMessage());
            }
            link = sogouRealLink(hop.text);
          } catch (e) {
            if (e instanceof SogouBlockedError) throw e;
            log("搜狗中转页解析失败：" + (e && e.message));
          }
        }
        if (!/^https:\/\/mp\.weixin\.qq\.com\//.test(link)) continue;
        // 搜狗给的是会话绑定的临时链接（signature），过期后谁也打不开：
        // 趁它还新鲜立刻抓一次页面，用页面参数换成长久有效的规范链接。
        let fin = link, title = it.title, t = it.t, digest = it.digest, cover = "", mid = "", idx = "", ext = {};
        // 这篇已经存过 → 复用已存的主键，不再为它下载整页文章（一篇可能几 MB，且正文没变化）：
        //   · 存的是长期链接：原样复用；
        //   · 存的是临时链接：用这次抓到的新临时链接续期（搜索结果每次都会给新链接）。
        const prior = knownByTitle(known, it.title);
        if (prior && prior.link) {
          const oldTemp = !!(prior.ext && prior.ext.temp);
          const newTemp = isSogouTempLink(link);
          out.push({
            id: prior.id,
            title: it.title,
            link: oldTemp ? link : prior.link,
            t: it.t || prior.t,
            digest: it.digest || prior.digest,
            cover: prior.cover || "",
            source: "sogou",
            ext: oldTemp ? (newTemp ? { temp: true } : {}) : (prior.ext || {}),
          });
          continue;
        }
        if (isSogouTempLink(link) && resolved < resolveMax) {
          resolved++;
          try {
            const parsed = await fetchArticle(link);
            const canon = canonicalLink(parsed);
            if (canon) fin = canon;
            title = parsed.title || title;
            t = parsed.t || t;
            digest = parsed.digest || digest;
            cover = parsed.cover || "";
            mid = parsed.mid;
            idx = parsed.idx;
            ext = canon ? { tempLink: link } : { temp: true };
          } catch (e) {
            ext = { temp: true };
            log("搜狗临时链接归一失败（" + ((e && e.message) || e) + "）");
          }
        }
        // 有页面参数就用 mid_idx，否则从链接里抠（与页面模板/RSS 通道主键对齐）
        out.push({ id: mid ? articleId(fin, mid, idx) : idFromLink(fin), title: title, link: fin, t: t, digest: digest, cover: cover, source: "sogou", ext: ext });
      }
    }
    return out;
  },
};

/** 通道 4：用户自备 RSS/Atom（也是接自建 wewe-rss 全量历史的现成入口）。 */
function tagText(block, name) {
  const at = String(block).indexOf("<" + name);
  if (at < 0) return "";
  const gt = String(block).indexOf(">", at);
  if (gt < 0) return "";
  const close = String(block).indexOf("</" + name, gt);
  if (close < 0) return "";
  return String(block).slice(gt + 1, close).trim();
}

function parseRss(xml) {
  const text = String(xml || "");
  const out = [];
  const re = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m;
  while ((m = re.exec(text))) {
    const b = m[0];
    const title = decodeEntities(stripTags(tagText(b, "title")));
    let link = decodeEntities(tagText(b, "link"));
    if (!link) {
      const lm = b.match(/<link\b[^>]*>/i);
      if (lm) link = attr(lm[0], "href");
    }
    if (!link) continue;
    const dateStr = tagText(b, "pubDate") || tagText(b, "published") || tagText(b, "updated") || tagText(b, "dc:date");
    const desc = decodeEntities(stripTags(tagText(b, "description") || tagText(b, "summary") || tagText(b, "content:encoded")));
    let cover = "";
    const cm = b.match(/<(enclosure|media:content|media:thumbnail)\b[^>]*>/i);
    if (cm) cover = attr(cm[0], "url");
    out.push({
      id: idFromLink(link),
      title: title || "（无标题）",
      link: normLink(link),
      t: dateStr ? Date.parse(dateStr) || 0 : 0,
      digest: trimTo(desc, 200),
      cover: cover,
      source: "rss",
    });
  }
  return out;
}

const rssProvider = {
  id: "rss",
  title: "自备 RSS",
  needs: { rss: true },
  async discover(sub) {
    const urls = [];
    if (sub.rssUrl) urls.push(sub.rssUrl);
    for (const u of cfgLines("rssUrls")) urls.push(u);
    const out = [];
    for (const u of uniqBy(urls.map((x) => ({ x: x })), (o) => o.x).map((o) => o.x).slice(0, 5)) {
      const r = await getText(u);
      for (const c of parseRss(r.text)) out.push(c);
    }
    return out;
  },
};


/* ---------- 表格导入（CSV / 从 Excel 直接粘贴） ---------- */

/**
 * 表格导入通道：把 wechatDownload 一类工具导出的 CSV（或从表格软件直接复制的内容）变成文章条目。
 * 它是「导入型」通道——不参与自动刷新（discover 恒返回空），只在用户显式「导入表格」时被调用，
 * 这样既不打乱其它通道的调度契约，也给将来接全量历史留的是同一个入口（见 README 第 6 节）。
 */
const csvProvider = {
  id: "csv",
  title: "表格导入",
  importOnly: true,
  needs: {},
  async discover() { return []; },
};

/** 表头列名别名（比对前会过 normName：小写 + 去符号）。 */
const TABLE_COLS = {
  title: ["title", "标题", "文章标题", "题目", "name"],
  url: ["url", "link", "链接", "地址", "文章链接"],
  time: ["time", "发布时间", "时间", "日期", "publish_time", "pub_time"],
  like: ["like_num", "like", "点赞", "点赞数", "likes"],
  read: ["read_num", "read", "阅读", "阅读量", "reads"],
  share: ["share_num", "share", "分享", "分享数", "shares"],
  comment: ["comment_count", "comment", "评论", "评论数", "comments"],
};

/** 没有表头时按 wechatDownload 的导出列序兜底：title,url,time,like_num,read_num,share_num,comment_count。 */
const TABLE_COLS_POSITIONAL = { title: 0, url: 1, time: 2, like: 3, read: 4, share: 5, comment: 6 };

/** 解析 CSV/TSV 文本 → 二维数组（支持引号包裹、"" 转义、CRLF、从 Excel 粘贴的制表符、BOM）。 */
function parseTable(raw) {
  // wechatDownload 导出的 CSV 是 UTF-16LE（带 BOM）：万一内容以带 NUL 填充的形态传进来，先去 NUL 再解析。
  const text = String(raw == null ? "" : raw)
    .replace(/^\uFEFF/, "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n");
  const head = text.split("\n")[0] || "";
  const delim = head.split("\t").length > head.split(",").length ? "\t" : ",";
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && !cell) { quoted = true; continue; }
    if (ch === delim) { row.push(cell.trim()); cell = ""; continue; }
    if (ch === "\n") { row.push(cell.trim()); rows.push(row); row = []; cell = ""; continue; }
    cell += ch;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ""));
}

/** 识别表头 → { title: 列号, url: 列号, … }；识别不出（缺 title 或 url）返回 null。 */
function tableCols(row) {
  const idx = {};
  for (let i = 0; i < row.length; i++) {
    const h = normName(row[i]);
    if (!h) continue;
    for (const key in TABLE_COLS) {
      if (idx[key] != null) continue;
      if (TABLE_COLS[key].some((alias) => normName(alias) === h)) { idx[key] = i; break; }
    }
  }
  return idx.title == null || idx.url == null ? null : idx;
}

/** 表格里的时间 → 毫秒（写的是北京时间；也容忍纯秒 / 纯毫秒时间戳）。 */
function parseTableTime(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return 0;
  if (/^\d{9,10}$/.test(s)) return parseInt(s, 10) * 1000;
  if (/^\d{12,13}$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!m) return 0;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], (+m[4] || 0) - 8, +m[5] || 0, +m[6] || 0);
  return ms > 0 ? ms : 0;
}

/** 表格里的数字（容忍千分位与「1.5万」这类写法）。 */
function tableNum(v) {
  const s = String(v == null ? "" : v).replace(/[,\s]/g, "");
  const m = s.match(/^(\d+(?:\.\d+)?)([万亿])?$/);
  if (!m) return 0;
  let n = parseFloat(m[1]);
  if (m[2] === "万") n *= 10000;
  if (m[2] === "亿") n *= 100000000;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** 单元格文本（越界返回空串）。 */
function cellAt(row, n) {
  if (n == null || !row) return "";
  return String(row[n] == null ? "" : row[n]).trim();
}

function isMpLink(link) {
  return /^https?:\/\/mp\.weixin\.qq\.com\//i.test(String(link || ""));
}

/**
 * 表格 → 候选条目。返回 { list, total, skipped, nonMp, capped }：
 * total = 数据行数；skipped = 缺标题/缺链接/非公众号链接/重复行；nonMp = 其中非公众号链接的行数。
 */
function candidatesFromTable(rows, maxN) {
  const list = [];
  const seen = {};
  let total = 0;
  let skipped = 0;
  let nonMp = 0;
  let capped = 0;
  if (!rows || !rows.length) return { list: list, total: 0, skipped: 0, nonMp: 0, capped: 0 };
  let start = 1;
  let cols = tableCols(rows[0]);
  if (!cols) { cols = TABLE_COLS_POSITIONAL; start = 0; }
  const cap = maxN > 0 ? maxN : 0;
  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    const title = cellAt(row, cols.title);
    const rawLink = cellAt(row, cols.url);
    if (!title && !rawLink) continue;
    total++;
    if (!title || !rawLink) { skipped++; continue; }
    const link = normLink(rawLink);
    if (!isMpLink(link)) { skipped++; nonMp++; continue; }
    const id = idFromLink(link);
    if (seen[id]) { skipped++; continue; }
    if (cap && list.length >= cap) { capped++; continue; }
    seen[id] = 1;
    const stats = {
      read: tableNum(cellAt(row, cols.read)),
      like: tableNum(cellAt(row, cols.like)),
      share: tableNum(cellAt(row, cols.share)),
      comment: tableNum(cellAt(row, cols.comment)),
    };
    list.push({
      id: id,
      title: title,
      link: link,
      t: parseTableTime(cellAt(row, cols.time)),
      digest: "",
      cover: "",
      source: "csv",
      ext: { imported: 1, stats: stats },
    });
  }
  return { list: list, total: total, skipped: skipped, nonMp: nonMp, capped: capped };
}

/** 导入进来的条目：不参与「每订阅保留篇数」的滚动淘汰（它是用户显式导入的目录）。 */
/** 从链接里取查询参数（页面里读不到 var 时的兜底）。 */
function linkParam(url, name) {
  const m = String(url || "").match(new RegExp("[?&]" + name + "=([^&#]+)"));
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]);
  } catch (_) {
    return m[1];
  }
}

function isImported(a) {
  return !!(a && a.ext && a.ext.imported);
}

const PROVIDERS = [homepageProvider, albumProvider, sogouProvider, rssProvider, csvProvider];
const ALL_CHANNEL_IDS = PROVIDERS.map((p) => p.id);
/** 参与自动刷新的通道（导入型通道不算）。 */
const FEED_CHANNEL_IDS = PROVIDERS.filter((p) => !p.importOnly).map((p) => p.id);

/** 调度：按 sub.channels ∩ 设置开关挑通道，并发跑（网络仍串行），单通道失败不影响其它。 */
async function discoverFor(sub) {
  const en = enabledChannels();
  const wanted = sub.channels && sub.channels.length ? sub.channels : FEED_CHANNEL_IDS;
  const picked = PROVIDERS.filter((p) => !p.importOnly && wanted.indexOf(p.id) >= 0 && en[p.id]);
  // 把「这个订阅已经存下的、链接长期有效的文章」按标题交给通道：
  // 通道可以用它跳过重复抓取（搜狗那类通道为了一篇会去下载整页文章，几百 KB 到几 MB）。
  const known = {};
  for (const a of articlesOf(sub.id)) {
    if (a && a.title && a.link) known[a.title] = a;
  }
  const sources = [];
  const lists = await Promise.all(
    picked.map(async (p) => {
      try {
        const got = await p.discover(sub, null, { known: known });
        sources.push({ id: p.id, ok: true, count: got.length });
        return got;
      } catch (e) {
        const msg = (e && e.message) || String(e);
        sources.push({ id: p.id, ok: false, count: 0, error: msg, hard: !!(e && (e.gone || e.blocked)) });
        log("通道 " + p.id + " 失败：" + msg);
        return [];
      }
    })
  );
  const all = [];
  for (const l of lists) for (const c of l) all.push(c);
  return { candidates: uniqBy(all, (c) => c.id), sources: sources };
}

/* ---------- 存储层（订阅 / 文章 / 日报 / AI 缓存） ---------- */

const K = {
  subs: "subs",
  arts: (subId) => "a:" + subId,
  seen: (subId) => "seen:" + subId,
  daily: (date) => "daily:" + date,
  ai: (h) => "ai:" + h,
  aiIdx: "ai:idx",
};

function loadSubs() {
  const v = kv.get(K.subs, []);
  return Array.isArray(v) ? v : [];
}
function saveSubs(list) { return kv.set(K.subs, list); }
function findSub(id) {
  const list = loadSubs();
  for (const s of list) if (s.id === id) return s;
  return null;
}
function upsertSub(sub) {
  const list = loadSubs();
  let found = false;
  for (let i = 0; i < list.length; i++) if (list[i].id === sub.id) { list[i] = sub; found = true; }
  if (!found) list.push(sub);
  saveSubs(list);
  return sub;
}
function removeSub(id) {
  saveSubs(loadSubs().filter((s) => s.id !== id));
  kv.remove(K.arts(id));
  kv.remove(K.seen(id));
}
function subIdFor(biz, rssUrl, name) {
  return "s" + hash(String(biz || rssUrl || normName(name) || Date.now()));
}

function loadArticles(subId) {
  const v = kv.get(K.arts(subId), []);
  return Array.isArray(v) ? v : [];
}
function loadSeen(subId) {
  const v = kv.get(K.seen(subId), []);
  return Array.isArray(v) ? v : [];
}
function addSeen(subId, ids) {
  if (!ids || !ids.length) return;
  // 至少保留本批次的全部 id，否则大批量淘汰（导入上千篇）后旧 id 会被截断，下次刷新又「复活」
  const keep = Math.max(SEEN_KEEP, ids.length);
  const merged = uniqBy(ids.concat(loadSeen(subId)).map((id) => ({ id: id })), (o) => o.id).map((o) => o.id);
  kv.set(K.seen(subId), merged.slice(0, keep));
}

/** 按篇数上限裁剪：⭐ 收藏与「表格导入」的条目永远保留，其余按时间倒序。 */
function trimArticles(list) {
  const keep = Math.max(10, cfgNum("perSubKeep", 60));
  const sorted = sortByTimeDesc(list);
  if (sorted.length <= keep) return { kept: sorted, dropped: [] };
  const starred = sorted.filter((a) => a.star);
  const pinned = sorted.filter((a) => a.star || isImported(a));
  const rest = sorted.filter((a) => !a.star && !isImported(a));
  const kept = rest.slice(0, Math.max(0, keep - starred.length)).concat(pinned);
  const keptIds = {};
  for (const a of kept) keptIds[a.id] = 1;
  return { kept: sortByTimeDesc(kept), dropped: sorted.filter((a) => !keptIds[a.id]).map((a) => a.id) };
}

function saveArticles(subId, list) {
  const t = trimArticles(list);
  addSeen(subId, t.dropped);
  if (kv.set(K.arts(subId), t.kept)) return t.kept;
  // 配额兜底：把「最近的非置顶篇目」逐次减半再试（⭐ 收藏与表格导入的篇目始终保留）
  const pinned = t.kept.filter((a) => a.star || isImported(a));
  const rest = t.kept.filter((a) => !a.star && !isImported(a)); // 已是时间倒序
  let n = rest.length;
  let last = t.kept;
  for (let i = 0; i < 6 && n > 0; i++) {
    n = Math.floor(n / 2);
    const kept = sortByTimeDesc(rest.slice(0, n).concat(pinned));
    const keptIds = {};
    for (const a of kept) keptIds[a.id] = 1;
    addSeen(subId, t.kept.filter((a) => !keptIds[a.id]).map((a) => a.id));
    last = kept;
    if (kv.set(K.arts(subId), kept)) { toast("存储空间不足，已清理最旧的未读文章（现有 " + kept.length + " 篇）"); return kept; }
  }
  toast("本地存储已满，本次更新未能全部保存（请减少订阅或调小「每个订阅保留篇数」）");
  return last;
}

/** 全局篇数上限：超出时从最大的订阅里丢最旧的未读；只有真的写进存储才记账。 */
function globalTrim() {
  const subs = loadSubs();
  const cache = {};
  let total = 0;
  for (const s of subs) { cache[s.id] = loadArticles(s.id); total += cache[s.id].length; }
  let guard = 0;
  let blocked = false;
  while (total > GLOBAL_KEEP && guard++ < 60 && !blocked) {
    let bigId = "";
    for (const s of subs) if (!bigId || cache[s.id].length > cache[bigId].length) bigId = s.id;
    const list = cache[bigId];
    if (!list || !list.length) break;
    const sorted = sortByTimeDesc(list);
    let victim = null;
    for (let i = sorted.length - 1; i >= 0; i--) if (!sorted[i].star && !isImported(sorted[i])) { victim = sorted[i]; break; }
    if (!victim) break;
    const next = list.filter((a) => a.id !== victim.id);
    if (!kv.set(K.arts(bigId), next)) { blocked = true; break; } // 写不进存储：再淘汰也落不了盘
    cache[bigId] = next;
    addSeen(bigId, [victim.id]);
    total--;
  }
  if (blocked) log("全局清理提前结束：本地存储写入失败（账面仍有 " + total + " 篇）");
  return total;
}

/** 合并新发现：去重、补全字段、统计新增。 */
function mergeCandidates(sub, candidates) {
  const existing = loadArticles(sub.id);
  const byId = {};
  for (const a of existing) byId[a.id] = a;
  const seenSet = {};
  for (const id of loadSeen(sub.id)) seenSet[id] = 1;
  let added = 0;
  for (const c of candidates) {
    const old = byId[c.id];
    if (old) {
      // 已存在的条目只补不覆盖，但链接有个例外：
      // ① 旧链接是搜狗临时链接（会过期）→ 用这次抓到的新临时链接续期；
      // ② 旧链接是临时链接、这次拿到长期链接（页面模板/合集/RSS）→ 换成长期链接。
      const oldTemp = !!(old.ext && old.ext.temp);
      const newTemp = !!(c.ext && c.ext.temp);
      const relink = c.link && ((oldTemp && !newTemp) || (oldTemp && newTemp && c.link !== old.link));
      byId[c.id] = Object.assign({}, old, {
        title: c.title || old.title,
        t: old.t || c.t,
        digest: old.digest || c.digest,
        cover: old.cover || c.cover,
        source: old.source || c.source,
        ext: relink ? (c.ext || null) : (old.ext || c.ext || null),
        link: relink ? c.link : old.link,
      });
      continue;
    }
    if (seenSet[c.id]) continue;
    byId[c.id] = {
      id: c.id,
      subId: sub.id,
      subName: sub.name,
      title: c.title,
      link: c.link,
      t: c.t || 0,
      digest: c.digest || "",
      cover: c.cover || "",
      source: c.source,
      ext: c.ext || null,
      cats: [],
      points: [],
      read: false,
      star: false,
      imageCount: 0,
      summarized: false,
      addedAt: Date.now(),
    };
    added++;
  }
  const list = saveArticles(sub.id, Object.values(byId));
  return { added: added, list: list };
}

function articlesOf(subId) { return sortByTimeDesc(loadArticles(subId)); }
function allArticles() {
  const out = [];
  for (const s of loadSubs()) for (const a of loadArticles(s.id)) out.push(a);
  return sortByTimeDesc(out);
}
function patchArticle(subId, artId, patch) {
  const list = loadArticles(subId);
  let hit = null;
  for (let i = 0; i < list.length; i++) if (list[i].id === artId) { list[i] = Object.assign({}, list[i], patch); hit = list[i]; }
  if (hit) saveArticles(subId, list);
  return hit;
}

function getDaily(date) {
  const v = kv.get(K.daily(date), null);
  return v && typeof v === "object" ? v : null;
}
function putDaily(date, obj) { kv.set(K.daily(date), obj); }

function aiGet(key) {
  const v = kv.get(K.ai(key), null);
  return typeof v === "string" ? v : null;
}
function aiPut(key, val) {
  kv.set(K.ai(key), val);
  const idx = kv.get(K.aiIdx, []);
  const list = Array.isArray(idx) ? idx.filter((k) => k !== key) : [];
  list.unshift(key);
  while (list.length > AI_CACHE_KEEP) { const drop = list.pop(); kv.remove(K.ai(drop)); }
  kv.set(K.aiIdx, list);
}

/* ---------- 订阅维护 ---------- */

function newSub(fields) {
  return Object.assign(
    {
      id: "",
      name: "",
      biz: "",
      ghId: "",
      keywords: [],
      rssUrl: "",
      albumIds: [],
      channels: [],
      cursor: {},
      failUntil: {},
      enabled: true,
      addedAt: Date.now(),
      lastSyncAt: 0,
      lastNewAt: 0,
      sources: [],
      error: "",
    },
    fields || {}
  );
}

/** 计算某订阅的未读数。 */
function unreadOf(subId) {
  let n = 0;
  for (const a of loadArticles(subId)) if (!a.read) n++;
  return n;
}
function totalUnread() {
  let n = 0;
  for (const s of loadSubs()) n += unreadOf(s.id);
  return n;
}

/* ---------- AI：概览 / 分类 / 每日重点摘要 ---------- */

function aiEnabled() { return cfgBool("aiEnabled"); }

async function aiChat(prompt, timeoutMs) {
  let timer = null;
  // 宿主没有取消接口：超时后底层请求仍在跑，这里只是不再等待（调用方不会写缓存，可安全重试）
  const call = Promise.resolve().then(() => ctx.onethu.llm.chat(prompt));
  call.catch(() => {});
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error("AI 超时（" + Math.round((timeoutMs || 90000) / 1000) + "s，可稍后重试）")), timeoutMs || 90000);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function aiErrText(e) {
  const m = e == null ? "未知错误" : (e && e.message) || String(e);
  if (/未登录|login|unauthor/i.test(m)) return "内置 AI 未就绪（请先在 OneTHU 里登录/配置模型）：" + m;
  return m;
}

/** 分类 + 要点：每批 ≤12 篇，只喂标题与摘要，结果写回文章。 */
async function aiClassify(articles) {
  if (!aiEnabled()) return { ok: false, reason: "AI 未启用（设置里打开 aiEnabled）" };
  if (!articles.length) return { ok: false, reason: "没有可整理的文章" };
  const batches = [];
  for (let i = 0; i < articles.length; i += 12) batches.push(articles.slice(i, i + 12));
  let classified = 0;
  const topics = [];
  try {
    for (const batch of batches) {
      const key = "cls" + PROMPT_VER + hash(batch.map((a) => a.id).sort().join(","));
      let text = aiGet(key);
      if (!text) {
        const lines = batch.map((a, i) => i + 1 + ". " + a.title + (a.digest ? "｜" + trimTo(a.digest, 60) : "")).join("\n");
        const prompt =
          "你在帮一位清华学生整理微信公众号的更新。下面每行是一篇文章的编号与标题。\n" +
          "请为每篇给出：类别（只能从这些里选：" + CATEGORIES.join("、") + "）与最多 2 条要点（每条不超过 30 字，只能基于标题/摘要里明确的信息，不要编造）。\n" +
          '只输出 JSON，不要任何解释：{"items":[{"i":1,"cats":["类别"],"points":["要点"]}],"topics":["这批更新整体在讲什么，一句话"]}\n\n' + lines;
        const res = await aiChat(prompt);
        text = (res && res.text) || "";
        if (!text) return { ok: false, reason: "AI 没有返回内容", classified: classified };
        aiPut(key, text);
      }
      const data = tolerantJson(text);
      if (!data || !Array.isArray(data.items)) return { ok: false, reason: "AI 返回的不是 JSON", raw: text, classified: classified };
      const bySub = {};
      for (const it of data.items) {
        const idx = parseInt(it.i, 10) - 1;
        const art = batch[idx];
        if (!art) continue;
        const cats = uniqBy(
          (Array.isArray(it.cats) ? it.cats : []).map((c) => ({ c: CATEGORIES.indexOf(String(c)) >= 0 ? String(c) : "其他" })),
          (o) => o.c
        ).map((o) => o.c).slice(0, 2);
        const points = (Array.isArray(it.points) ? it.points : []).map((p) => trimTo(String(p), 40)).slice(0, 2);
        bySub[art.subId] = bySub[art.subId] || [];
        bySub[art.subId].push({ id: art.id, cats: cats, points: points });
        classified++;
      }
      // 每个订阅每批只写一次存储（原来是每篇一次 load+save，一批 12 篇就是 24 次整表读写）
      for (const subId of Object.keys(bySub)) {
        const list = loadArticles(subId);
        const patches = {};
        for (const p of bySub[subId]) patches[p.id] = p;
        let hit = false;
        for (let i = 0; i < list.length; i++) {
          const p = patches[list[i].id];
          if (p) { list[i] = Object.assign({}, list[i], { cats: p.cats, points: p.points }); hit = true; }
        }
        if (hit) saveArticles(subId, list);
      }
      if (Array.isArray(data.topics)) for (const t of data.topics) topics.push(String(t));
    }
  } catch (e) {
    return { ok: false, reason: aiErrText(e), classified: classified };
  }
  return { ok: true, classified: classified, topics: topics };
}

/** 抓正文摘要（最多 N 篇，用于提升日报质量）。 */
async function bodySnippets(articles, limit) {
  const out = [];
  let done = 0;
  for (const a of articles) {
    if (done >= limit) break;
    if (a.summarized) { out.push(a); done++; continue; } // 计入额度，否则实抓次数会超出 dailyBodyLimit
    try {
      const parsed = await fetchArticle(a.link);
      const text = parsed.nodes.filter((n) => n.type === "p").map((n) => n.text).join("\n").slice(0, 1500);
      patchArticle(a.subId, a.id, { summarized: true, imageCount: parsed.imageCount, digest: a.digest || trimTo(text, 200) });
      out.push(Object.assign({}, a, { body: text }));
      done++;
    } catch (e) {
      log("抓正文失败（" + a.title + "）：" + (e && e.message));
      out.push(a);
    }
  }
  return out;
}

/** 每日重点摘要。 */
async function aiDailyDigest(date) {
  const day = date || todayKey();
  if (!aiEnabled()) return { ok: false, reason: "AI 未启用（设置里打开 aiEnabled）" };
  const from = new Date(day + "T00:00:00").getTime();
  const to = from + 86400000;
  let arts = allArticles().filter((a) => a.t >= from && a.t < to);
  let scope = "当日";
  if (!arts.length) {
    const since = Date.now() - 3 * 86400000;
    arts = allArticles().filter((a) => a.t >= since);
    scope = "最近 3 天";
  }
  if (!arts.length) arts = allArticles().slice(0, 12);
  if (!arts.length) return { ok: false, reason: "还没有订阅到任何文章" };
  const picked = arts.slice(0, 24);
  const withBody = await bodySnippets(picked, Math.max(0, cfgNum("dailyBodyLimit", 6)));
  const lines = withBody.map((a, i) =>
    i + 1 + ". [" + (a.subName || "未知公众号") + "] " + a.title + (a.body ? "｜正文摘录：" + trimTo(a.body.replace(/\s+/g, " "), 400) : a.digest ? "｜摘要：" + a.digest : "")
  ).join("\n");
  const prompt =
    "你是清华学生的信息助手。下面是" + scope + "内订阅的微信公众号文章（编号、公众号、标题、摘要/正文摘录）。\n" +
    "请写一份中文日报：先给一句话导读，再挑 3-5 条真正值得看的重点（说明为什么值得看，指出与学习/科研/选课/活动/就业的关系），最后给一句提醒。\n" +
    "只用 Markdown，不要输出代码块，不要编造原文没有的信息。提到的重点请用编号标注来源。\n\n" + lines;
  try {
    const res = await aiChat(prompt, 120000);
    const text = (res && res.text) || "";
    if (!text) return { ok: false, reason: "AI 没有返回内容" };
    const byCat = {};
    for (const a of arts) {
      const c = (a.cats && a.cats[0]) || "未分类";
      (byCat[c] = byCat[c] || []).push(a);
    }
    let md = "# 公众号日报 · " + day + "（" + scope + " " + arts.length + " 篇）\n\n" + text.trim();
    md += "\n\n---\n\n## 分类清单\n";
    for (const c of CATEGORIES.concat(Object.keys(byCat).filter((k) => CATEGORIES.indexOf(k) < 0 && k !== "未分类"))) {
      const list = byCat[c];
      if (!list) continue;
      md += "\n**" + c + "**\n";
      for (const a of list.slice(0, 8)) md += "- [" + a.title + "](" + a.link + ") · " + (a.subName || "未知公众号") + "\n";
    }
    if (byCat["未分类"]) {
      md += "\n**未分类**\n";
      for (const a of byCat["未分类"].slice(0, 8)) md += "- [" + a.title + "](" + a.link + ") · " + (a.subName || "未知公众号") + "\n";
    }
    const obj = { markdown: md, at: Date.now(), date: day, scope: scope, count: arts.length, model: (res && res.model) || "" };
    putDaily(day, obj);
    return Object.assign({ ok: true }, obj);
  } catch (e) {
    return { ok: false, reason: aiErrText(e) };
  }
}

/** 单篇总结（阅读器按钮）。 */
async function aiSummarizeOne(art) {
  if (!aiEnabled()) return { ok: false, reason: "AI 未启用（设置里打开 aiEnabled）" };
  const key = "one" + PROMPT_VER + hash(art.id + (art.title || ""));
  const cached = aiGet(key);
  if (cached) return { ok: true, text: cached, cached: true };
  try {
    const parsed = await fetchArticle(art.link);
    patchArticle(art.subId, art.id, { summarized: true, imageCount: parsed.imageCount });
    const body = parsed.nodes.filter((n) => n.type === "p").map((n) => n.text).join("\n").slice(0, 3000);
    const prompt =
      "请用中文总结这篇公众号文章，输出 3-5 条要点（每条一行，以 - 开头），最后一行用「一句话：」给出结论。只基于原文，不要编造。\n\n标题：" +
      parsed.title + "\n公众号：" + (parsed.account || art.subName) + "\n正文：\n" + body;
    const res = await aiChat(prompt);
    const text = (res && res.text) || "";
    if (!text) return { ok: false, reason: "AI 没有返回内容" };
    aiPut(key, text);
    return { ok: true, text: text };
  } catch (e) {
    return { ok: false, reason: aiErrText(e) };
  }
}

/* ---------- 刷新调度 ---------- */

let refreshing = false;
let lastRefreshAt = 0;

async function refreshSub(sub) {
  const t0 = Date.now();
  try {
    const r = await discoverFor(sub);
    const merged = mergeCandidates(sub, r.candidates);
    sub.sources = r.sources;
    sub.lastSyncAt = Date.now();
    if (merged.added) sub.lastNewAt = Date.now();
    sub.error = "";
    upsertSub(sub);
    return { subId: sub.id, name: sub.name, added: merged.added, total: merged.list.length, sources: r.sources, ms: Date.now() - t0 };
  } catch (e) {
    sub.error = (e && e.message) || String(e);
    sub.lastSyncAt = Date.now();
    upsertSub(sub);
    return { subId: sub.id, name: sub.name, added: 0, total: loadArticles(sub.id).length, sources: [], error: sub.error, ms: Date.now() - t0 };
  }
}

async function refreshAll(opts) {
  if (refreshing) return { skipped: true, reason: "正在刷新中" };
  refreshing = true;
  const subs = loadSubs().filter((s) => s.enabled);
  const out = { subs: [], added: 0, errors: [], ms: 0 };
  const t0 = Date.now();
  try {
    for (const sub of subs) {
      const r = await refreshSub(sub);
      out.subs.push(r);
      out.added += r.added;
      const failed = (r.sources || []).filter((s) => !s.ok);
      out.failed = (out.failed || 0) + failed.length;
      if (r.error) out.errors.push(sub.name + "：" + r.error);
      else if (failed.length) out.errors.push(sub.name + "：" + failed.map((s) => sourceLabel(s.id) + "（" + s.error + "）").join("、"));
    }
    globalTrim();
  } finally {
    refreshing = false;
    lastRefreshAt = Date.now();
    out.ms = Date.now() - t0;
  }
  return out;
}

/** 单订阅刷新时保持 channels 与设置一致（新增通道自动生效）。 */
function effectiveChannels(sub) {
  const en = enabledChannels();
  const wanted = sub.channels && sub.channels.length ? sub.channels : FEED_CHANNEL_IDS;
  return wanted.filter((c) => en[c]);
}

/* ---------- 页面样式（选择器限定在 [data-plg] 作用域内） ---------- */

const CSS = [
  '[data-plg="onethu.wechat.news"]{display:flex;flex-direction:column;gap:10px}',
  '[data-plg="onethu.wechat.news"] .wx-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
  '[data-plg="onethu.wechat.news"] .wx-meta{color:var(--text-3);font-size:12px;margin-left:auto}',
  '[data-plg="onethu.wechat.news"] .wx-note{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:12px;color:var(--text-3)}',
  '[data-plg="onethu.wechat.news"] .wx-chips{display:flex;flex-wrap:wrap;gap:6px}',
  '[data-plg="onethu.wechat.news"] .wx-chip{border:1px solid var(--border);background:transparent;color:inherit;border-radius:999px;padding:4px 10px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}',
  '[data-plg="onethu.wechat.news"] .wx-chip.on{border-color:currentColor;font-weight:600}',
  '[data-plg="onethu.wechat.news"] .wx-dot{width:7px;height:7px;border-radius:50%;background:#3ecf8e;display:inline-block}',
  '[data-plg="onethu.wechat.news"] .wx-dot.warn{background:#e0a13c}',
  '[data-plg="onethu.wechat.news"] .wx-dot.err{background:#e05c5c}',
  '[data-plg="onethu.wechat.news"] .wx-list{display:flex;flex-direction:column;gap:8px}',
  '[data-plg="onethu.wechat.news"] .wx-item{border:1px solid var(--border);border-radius:10px;padding:10px 12px;background:var(--surface)}',
  '[data-plg="onethu.wechat.news"] .wx-item.unread{border-left:3px solid #3ecf8e}',
  '[data-plg="onethu.wechat.news"] .wx-item-head{display:flex;gap:8px;align-items:flex-start}',
  '[data-plg="onethu.wechat.news"] .wx-title{font-weight:600;cursor:pointer;color:inherit;text-decoration:none;flex:1}',
  '[data-plg="onethu.wechat.news"] .wx-star{cursor:pointer;background:transparent;border:none;color:#e0a13c;font-size:15px}',
  '[data-plg="onethu.wechat.news"] .wx-sub{color:var(--text-3);font-size:12px;margin:4px 0}',
  '[data-plg="onethu.wechat.news"] .wx-digest{font-size:13px;color:var(--text-3);line-height:1.5}',
  '[data-plg="onethu.wechat.news"] .wx-points{margin:6px 0 0;padding-left:16px;font-size:13px}',
  '[data-plg="onethu.wechat.news"] .wx-tag{display:inline-block;border:1px solid var(--border);border-radius:6px;padding:0 6px;font-size:11px;margin-right:4px}',
  '[data-plg="onethu.wechat.news"] .wx-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}',
  '[data-plg="onethu.wechat.news"] .wx-actions button{background:transparent;border:1px solid var(--border);border-radius:8px;padding:3px 8px;font-size:12px;cursor:pointer;color:inherit}',
  '[data-plg="onethu.wechat.news"] .wx-warn{color:var(--text-3);font-size:11px}',
  '[data-plg="onethu.wechat.news"] .wx-daily{border:1px solid var(--border);border-radius:10px;padding:12px;background:var(--surface)}',
  '[data-plg="onethu.wechat.news"] .wx-daily h1{font-size:16px;margin:0 0 8px}',
  '[data-plg="onethu.wechat.news"] .wx-daily h2{font-size:14px;margin:12px 0 6px}',
  '[data-plg="onethu.wechat.news"] .wx-daily h3{font-size:13px;margin:10px 0 4px}',
  '[data-plg="onethu.wechat.news"] .wx-daily ul{margin:4px 0;padding-left:20px}',
  '[data-plg="onethu.wechat.news"] .wx-daily p{margin:6px 0;line-height:1.6}',
  '[data-plg="onethu.wechat.news"] .wx-daily blockquote{margin:6px 0;padding-left:10px;border-left:3px solid var(--border);color:var(--text-3)}',
  '[data-plg="onethu.wechat.news"] .wx-reader{border:1px solid var(--border);border-radius:10px;padding:14px;background:var(--surface)}',
  '[data-plg="onethu.wechat.news"] .wx-reader h2{font-size:17px;margin:0 0 6px}',
  '[data-plg="onethu.wechat.news"] .wx-reader p{line-height:1.75;margin:10px 0;font-size:14px}',
  '[data-plg="onethu.wechat.news"] .wx-reader img{max-width:100%;border-radius:8px;display:block;margin:10px auto}',
  '[data-plg="onethu.wechat.news"] .wx-manage table{width:100%;border-collapse:collapse;font-size:13px}',
  '[data-plg="onethu.wechat.news"] .wx-manage th,[data-plg="onethu.wechat.news"] .wx-manage td{border-bottom:1px solid var(--border);padding:6px 4px;text-align:left;vertical-align:top}',
  '[data-plg="onethu.wechat.news"] .wx-empty{color:var(--text-3);font-size:13px;padding:16px;text-align:center;border:1px dashed var(--border);border-radius:10px}',
  '[data-plg="onethu.wechat.news"] .wx-chan{display:inline-flex;gap:6px;align-items:center;font-size:12px;margin-right:8px;color:var(--text-3)}',
].join("\n");

/* ---------- 视图工具 ---------- */

function toast(msg) {
  try { ctx.onethu.ui.toast(String(msg)); } catch (_) {}
  log(msg);
}

const ui = {
  mode: "list",
  filter: "",
  openId: "",
  busy: "",
  note: "",
  reader: null,
  readerLoading: false,
  daily: null,
  doctor: null,
  summary: "",
  limit: 0,
  root: null,
};

/** 订阅 / 导入流程的重入闸：宿主表单是模态的，但连点两下会开出两个表单。 */
let flowBusy = false;
/** onTabReady 的退订函数（dispose 时调用，否则回调会一直留在宿主里）。 */
let tabOff = null;

function relTimeOf(a) { return a.t ? fmtRel(a.t) : "时间未知"; }

function favKey(artId) { return TAB_ID + "~a:" + artId; }

/** 页面没打开时，只设 ui.note 没人看得见，同时发一条系统提示。 */
function noteOrToast(msg) {
  ui.note = msg;
  if (!ui.root) toast(msg);
}

/** 停用/重装时清内存态（本地数据不动）。 */
function resetUi() {
  ui.mode = "list";
  ui.filter = "";
  ui.openId = "";
  ui.busy = "";
  ui.note = "";
  ui.reader = null;
  ui.readerLoading = false;
  ui.daily = null;
  ui.doctor = null;
  ui.summary = "";
  ui.limit = 0;
  ui.root = null;
}

const SOURCE_LABELS = { article: "文章页", rss: "RSS", album: "合集", homepage: "页面模板", sogou: "搜狗" };
function sourceLabel(id) {
  for (const p of PROVIDERS) if (p.id === id) return p.title;
  if (SOURCE_LABELS[id]) return SOURCE_LABELS[id];
  return id || "未知来源";
}

/** 极简 Markdown → HTML（只支持日报用到的语法，全部转义）。 */
function mdLite(md) {
  const lines = String(md || "").split(/\r?\n/);
  let html = "";
  let inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (/^###\s+/.test(line)) { closeList(); html += "<h3>" + inlineMd(line.replace(/^###\s+/, "")) + "</h3>"; continue; }
    if (/^##\s+/.test(line)) { closeList(); html += "<h2>" + inlineMd(line.replace(/^##\s+/, "")) + "</h2>"; continue; }
    if (/^#\s+/.test(line)) { closeList(); html += "<h1>" + inlineMd(line.replace(/^#\s+/, "")) + "</h1>"; continue; }
    if (/^---+$/.test(line)) { closeList(); html += "<hr>"; continue; }
    if (/^>\s?/.test(line)) { closeList(); html += "<blockquote>" + inlineMd(line.replace(/^>\s?/, "")) + "</blockquote>"; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += "<li>" + inlineMd(line.replace(/^\s*[-*]\s+/, "")) + "</li>";
      continue;
    }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    html += "<p>" + inlineMd(line) + "</p>";
  }
  closeList();
  return html;
}

function inlineMd(s) {
  const links = [];
  let t = String(s == null ? "" : s).replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (m, txt, url) => {
    links.push({ txt: txt, url: url });
    return "\u0001" + (links.length - 1) + "\u0001";
  });
  t = esc(t).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\u0001(\d+)\u0001/g, (m, i) => {
    const l = links[Number(i)];
    if (!l) return "";
    return '<a href="#" data-act="ext" data-url="' + esc(l.url) + '">' + esc(l.txt) + "</a>";
  });
  return t;
}

/** 阅读器正文节点 → HTML。 */
function nodesHtml(nodes) {
  let out = "";
  for (const n of nodes || []) {
    if (n.type === "img") out += '<img src="' + esc(n.src) + '" loading="lazy" alt="">';
    else out += "<p>" + esc(n.text) + "</p>";
  }
  return out;
}

/** 数字简写：15236 → 1.5万（阅读/点赞用）。 */
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, "") + "亿";
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, "") + "万";
  return String(v);
}

function busyNote() {
  return ui.busy ? '<div class="wx-note">' + esc(ui.busy) + "</div>" : ui.note ? '<div class="wx-note">' + esc(ui.note) + "</div>" : "";
}

function channelStatus(sub) {
  const srcs = sub.sources || [];
  if (sub.error) return { cls: "err", text: sub.error };
  if (!srcs.length) return { cls: "warn", text: "尚未取数" };
  const okCount = srcs.filter((s) => s.ok).length;          // 通道本身是否正常
  const newCount = srcs.filter((s) => s.ok && s.count > 0).length; // 其中拿到新内容的
  if (!okCount) return { cls: "err", text: "取数通道暂不可用：" + (srcs.map((s) => s.error).filter(Boolean)[0] || "全部失败") };
  if (!newCount) return { cls: "warn", text: "通道正常，本次没有新内容" };
  return { cls: "ok", text: newCount + " 个通道有新内容" };
}

/* ---------- 渲染 ---------- */

function btn(act, label, cls) {
  return '<button class="btn ' + (cls || "btn-ghost") + '" data-act="' + act + '">' + esc(label) + "</button>";
}
function act(id, artId, label) {
  return '<button data-act="' + id + '" data-id="' + esc(artId) + '">' + esc(label) + "</button>";
}

function visibleArticles() {
  let arts = allArticles();
  if (ui.filter) arts = arts.filter((a) => a.subId === ui.filter);
  return arts;
}

function lastSyncAll() {
  let last = lastRefreshAt;
  for (const s of loadSubs()) if ((s.lastSyncAt || 0) > last) last = s.lastSyncAt;
  return last;
}

function barHtml() {
  const last = lastSyncAll();
  return (
    '<div class="wx-bar">' +
    btn("refresh", "刷新", "btn-primary") +
    btn("digest", "生成日报") +
    btn("classify", "AI 分类") +
    btn("manage", ui.mode === "manage" ? "返回列表" : "订阅管理") +
    btn("doctor", "网络自检") +
    btn("import", "导入表格") +
    '<span class="wx-meta">' + (last ? "上次更新 " + esc(fmtRel(last)) : "尚未更新") +
    " · 未读 " + totalUnread() + " · 共 " + allArticles().length + " 篇</span></div>"
  );
}

function chipsHtml(subs) {
  if (!subs.length) return "";
  let h = '<div class="wx-chips">';
  h += '<button class="wx-chip' + (ui.filter ? "" : " on") + '" data-act="filter" data-id="">全部 ' + allArticles().length + "</button>";
  for (const s of subs) {
    const st = channelStatus(s);
    const un = unreadOf(s.id);
    h += '<button class="wx-chip' + (ui.filter === s.id ? " on" : "") + '" data-act="filter" data-id="' + esc(s.id) + '" title="' + esc(st.text) + '">' +
      '<span class="wx-dot ' + st.cls + '"></span>' + esc(s.name) + (un ? " · " + un : "") + (s.enabled ? "" : "（已停用）") + "</button>";
  }
  h += "</div>";
  return h;
}

function itemHtml(a) {
  const cats = (a.cats || []).map((c) => '<span class="wx-tag">' + esc(c) + "</span>").join("");
  const pts = a.points && a.points.length ? '<ul class="wx-points">' + a.points.map((p) => "<li>" + esc(p) + "</li>").join("") + "</ul>" : "";
  const imgNote = a.imageCount ? '<span class="wx-warn">含 ' + esc(String(a.imageCount)) + " 张图" + (cfgBool("visionEnabled") ? "" : "（未识图）") + "</span>" : "";
  const st = (a.ext && a.ext.stats) || null;
  const stats = st && (st.read || st.like || st.share || st.comment)
    ? " · 阅读 " + fmtNum(st.read) + (st.like ? " · 赞 " + fmtNum(st.like) : "") + (st.comment ? " · 评论 " + fmtNum(st.comment) : "")
    : "";
  return (
    '<div class="wx-item' + (a.read ? "" : " unread") + '">' +
    '<div class="wx-item-head"><a class="wx-title" href="#" data-act="open" data-id="' + esc(a.id) + '">' + esc(a.title) + "</a>" +
    '<button class="wx-star" data-act="star" data-id="' + esc(a.id) + '" title="收藏到 OneTHU 收藏夹">' + (a.star ? "★" : "☆") + "</button></div>" +
    '<div class="wx-sub">' + esc(a.subName || "") + " · " + esc(relTimeOf(a)) + " · 来源：" + esc(sourceLabel(a.source)) + stats + (cats ? " · " + cats : "") + "</div>" +
    (a.digest ? '<div class="wx-digest">' + esc(trimTo(a.digest, 160)) + "</div>" : "") + pts +
    '<div class="wx-actions">' + act("open", a.id, "阅读") + act("aisum", a.id, "AI 总结这篇") + act("copy", a.id, "复制链接") +
    act("read", a.id, a.read ? "标记未读" : "标记已读") + imgNote + "</div></div>"
  );
}

function listHtml(arts) {
  if (!arts.length) {
    return '<div class="wx-empty">还没有文章。<br>点「刷新」拉取更新；或在「订阅管理 → 新增订阅」里粘贴任意一篇该公众号的文章链接。</div>';
  }
  const limit = Math.max(60, ui.limit || 120);
  let h = '<div class="wx-list">';
  for (const a of arts.slice(0, limit)) h += itemHtml(a);
  h += "</div>";
  if (arts.length > limit) h += '<div class="wx-note">已显示 ' + limit + " 篇（共 " + arts.length + " 篇） " +
    '<button data-act="more" data-id="">显示更多</button></div>';
  return h;
}

function readerHtml() {
  if (ui.readerLoading) return '<div class="wx-reader">正在载入正文…（首次打开需要下载整页）</div>';
  const a = ui.reader;
  if (!a) return '<div class="wx-reader">文章不存在（可能已被清理）。<div class="wx-actions">' + act("back", "", "← 返回列表") + "</div></div>";
  const summary = ui.summary ? '<div class="wx-note">' + esc(ui.summary).replace(/\n/g, "<br>") + "</div>" : "";
  return (
    '<div class="wx-reader">' +
    '<div class="wx-bar">' + act("back", "", "← 返回列表") + act("aisum", a.id, "AI 总结这篇") + act("copy", a.id, "复制原文链接") +
    act("star", a.id, a.star ? "★ 已收藏" : "☆ 收藏") + act("read", a.id, a.read ? "标记未读" : "标记已读") + "</div>" +
    "<h2>" + esc(a.title) + "</h2>" +
    '<div class="wx-sub">' + esc(a.subName || "") + " · " + esc(a.t ? new Date(a.t).toLocaleString() : "时间未知") +
    " · 来源：" + esc(sourceLabel(a.source)) + (a.imageCount ? " · " + esc(String(a.imageCount)) + " 张图" : "") + "</div>" +
    summary +
    nodesHtml(a.nodes) +
    (!a.nodes || !a.nodes.length ? '<div class="wx-note">正文为空或未能解析。</div>' : "") +
    "</div>"
  );
}

function dailyHtml() {
  const d = ui.daily || getDaily(todayKey());
  if (!d || !d.markdown) return "";
  return '<div class="wx-daily">' + mdLite(d.markdown) +
    '<div class="wx-sub">生成于 ' + esc(fmtRel(d.at) || "时间未知") + (d.model ? " · 模型 " + esc(d.model) : "") + "</div></div>";
}

function manageHtml(subs) {
  let h = '<div class="wx-manage">';
  h += '<div class="wx-bar">' + btn("addsub", "新增订阅", "btn-primary") + btn("refresh", "全部刷新") + "</div>";
  h += '<div class="wx-note">取数通道可逐个开关：关掉某通道后该订阅只用其余通道（某个通道失效时不必删订阅）。</div>';
  if (!subs.length) {
    h += '<div class="wx-empty">还没有订阅。点「新增订阅」，粘贴任意一篇该公众号的文章链接即可（会自动识别公众号并回填合集）。</div>';
  } else {
    h += "<table><thead><tr><th>公众号</th><th>取数通道</th><th>状态</th><th>操作</th></tr></thead><tbody>";
    for (const s of subs) {
      const st = channelStatus(s);
      const chans = s.channels && s.channels.length ? s.channels : FEED_CHANNEL_IDS;
      h += "<tr><td><strong>" + esc(s.name) + "</strong><div class=\"wx-sub\">" +
        esc(s.biz ? "biz " + s.biz : s.rssUrl ? trimTo(s.rssUrl, 40) : "未识别到 biz") + (s.ghId ? " · " + esc(s.ghId) : "") +
        (s.albumIds && s.albumIds.length ? " · 合集 " + s.albumIds.length + " 个" : "") + "</div></td>";
      h += "<td>" + FEED_CHANNEL_IDS.map((c) =>
        '<label class="wx-chan"><input type="checkbox" data-act="chan" data-sub="' + esc(s.id) + '" data-chan="' + c + '"' +
        (chans.indexOf(c) >= 0 ? " checked" : "") + ">" + esc(sourceLabel(c)) + "</label>").join("") + "</td>";
      h += '<td><span class="wx-dot ' + st.cls + '"></span> <span class="wx-sub">' + esc(st.text) + "</span>" +
        '<div class="wx-sub">' + (s.lastSyncAt ? esc(fmtRel(s.lastSyncAt)) + "更新过" : "尚未更新") +
        " · " + loadArticles(s.id).length + " 篇 · 未读 " + unreadOf(s.id) + "</div></td>";
      h += '<td><button data-act="import" data-id="' + esc(s.id) + '">导入表格</button> ' +
        '<button data-act="sync" data-id="' + esc(s.id) + '">刷新</button> ' +
        '<button data-act="toggle" data-id="' + esc(s.id) + '">' + (s.enabled ? "停用" : "启用") + "</button> " +
        '<button data-act="del" data-id="' + esc(s.id) + '">删除</button></td></tr>';
    }
    h += "</tbody></table>";
  }
  h += "</div>";
  return h;
}

function viewHtml() {
  const subs = loadSubs();
  let h = '<div class="wx-wrap">';
  h += barHtml();
  h += busyNote();
  h += doctorHtml();
  if (ui.mode === "manage") {
    h += manageHtml(subs);
  } else {
    h += chipsHtml(subs);
    if (ui.openId) h += readerHtml();
    else {
      h += dailyHtml();
      h += listHtml(visibleArticles());
    }
  }
  h += "</div>";
  return h;
}

/** innerHTML 重建后，浏览器对 checkbox 的 dirty checkedness 会让勾选视觉回弹，这里按存储状态显式赋值。 */
function syncCheckboxes(root) {
  if (!root.querySelectorAll) return;
  const byId = {};
  for (const s of loadSubs()) byId[s.id] = s;
  const boxes = root.querySelectorAll('input[data-act="chan"]');
  for (const el of boxes) {
    const s = byId[el.getAttribute("data-sub")];
    if (!s) continue;
    const chans = s.channels && s.channels.length ? s.channels : FEED_CHANNEL_IDS;
    el.checked = chans.indexOf(el.getAttribute("data-chan")) >= 0;
  }
}

function render() {
  const root = ui.root;
  if (!root) return;
  root.dataset.plg = manifest.id;
  // 整页重建会清掉滚动位置（读长文时点收藏/已读尤其明显），这里前后恢复
  const scrollers = [root, root.parentElement].filter((el) => el && typeof el.scrollTop === "number");
  const tops = scrollers.map((el) => el.scrollTop);
  root.innerHTML = viewHtml();
  syncCheckboxes(root);
  for (let i = 0; i < scrollers.length; i++) if (tops[i]) scrollers[i].scrollTop = tops[i];
}

/* ---------- 动作 ---------- */

function findArticle(artId) {
  for (const s of loadSubs()) for (const a of loadArticles(s.id)) if (a.id === artId) return a;
  return null;
}

async function doRefresh() {
  if (refreshing) { toast("正在刷新中…"); return; }
  const subs = loadSubs().filter((s) => s.enabled);
  if (!subs.length) { noteOrToast("还没有订阅。先「订阅管理 → 新增订阅」。"); render(); return; }
  ui.busy = "正在刷新 " + subs.length + " 个订阅…";
  ui.note = "";
  render();
  const r = await refreshAll();
  ui.busy = "";
  ui.limit = 0; // 刷新后回到列表前 120 篇
  const parts = ["新增 " + r.added + " 篇"];
  const okCount = r.subs.reduce((n, s) => n + (s.sources || []).filter((x) => x.ok && x.count > 0).length, 0);
  if (!okCount) parts.push("所有取数通道都没拿到内容（已有列表保持不变，可稍后重试或换通道）");
  else if (r.errors.length) parts.push("部分通道失败：" + r.errors.join("；"));
  ui.note = parts.join(" · ") + "（耗时 " + Math.round(r.ms / 1000) + "s）";
  if (cfgBool("dailyAuto") && aiEnabled() && r.added) {
    ui.busy = "正在生成当日摘要…";
    render();
    const d = await aiDailyDigest();
    ui.busy = "";
    if (d.ok) ui.daily = { markdown: d.markdown, at: d.at, model: d.model };
  }
  render();
  toast("刷新完成：" + parts.join(" · "));
}

async function doClassify(quiet) {
  if (!aiEnabled()) { noteOrToast("AI 未启用：设置里把「AI 概览与分类」设为 1"); render(); return; }
  const arts = visibleArticles().filter((a) => !(a.cats && a.cats.length)).slice(0, 36);
  if (!arts.length) { noteOrToast("没有需要整理的文章（都整理过了，或还没订阅到内容）"); render(); return; }
  ui.busy = "AI 正在整理 " + arts.length + " 篇文章…";
  render();
  const r = await aiClassify(arts);
  ui.busy = "";
  ui.note = r.ok
    ? "AI 已整理 " + r.classified + " 篇" + (r.topics && r.topics.length ? "：" + r.topics.filter(Boolean).slice(0, 2).join("；") : "")
    : "AI 未生成（" + r.reason + "）";
  render();
  if (!quiet) toast(ui.note);
}

async function doDigest() {
  if (!aiEnabled()) { noteOrToast("AI 未启用：设置里把「AI 概览与分类」设为 1"); render(); return; }
  ui.busy = "正在生成日报（会抓取正文并调用 AI，可能要十几秒）…";
  render();
  const r = await aiDailyDigest();
  ui.busy = "";
  if (r.ok) { ui.daily = { markdown: r.markdown, at: r.at, model: r.model }; ui.note = "日报已生成（" + r.count + " 篇）"; }
  else ui.note = "日报未生成（" + r.reason + "）";
  render();
  toast(r.ok ? "日报已生成：" + r.count + " 篇" : ui.note);
}

async function openArticle(artId) {
  const a0 = findArticle(artId);
  if (!a0) { ui.note = "文章不存在（可能已被清理）"; render(); return; }
  ui.openId = artId;
  ui.reader = null;
  ui.readerLoading = true;
  ui.summary = "";
  ui.note = "";
  if (!a0.read) patchArticle(a0.subId, a0.id, { read: true });
  render();
  try {
    const parsed = await fetchArticle(a0.link);
    const a = findArticle(artId) || a0;
    ui.reader = Object.assign({}, a, { nodes: parsed.nodes, imageCount: parsed.imageCount, title: parsed.title || a.title });
    patchArticle(a.subId, a.id, { imageCount: parsed.imageCount, summarized: true });
    if (parsed.albumIds && parsed.albumIds.length) {
      const sub = findSub(a.subId);
      if (sub) {
        sub.albumIds = uniqBy((sub.albumIds || []).concat(parsed.albumIds).map((x) => ({ x: String(x) })), (o) => o.x).map((o) => o.x);
        upsertSub(sub);
      }
    }
  } catch (e) {
    ui.note = (e && e.message) || String(e);
  }
  ui.readerLoading = false;
  render();
}

async function doSummarize(artId) {
  const a = findArticle(artId);
  if (!a) return;
  ui.busy = "AI 正在读这篇文章…";
  render();
  const r = await aiSummarizeOne(a);
  ui.busy = "";
  if (r.ok) { ui.summary = r.text; ui.note = ""; }
  else ui.note = "AI 未生成（" + r.reason + "）";
  render();
}

async function copyLink(artId, url) {
  const a = artId ? findArticle(artId) : null;
  const link = url || (a && a.link) || "";
  if (!link) return;
  try {
    await ctx.onethu.ui.clipboard.write(link);
    toast("已复制链接。桌面端不能直接打开外部网页，粘贴到浏览器即可。");
  } catch (e) {
    toast("复制失败：" + ((e && e.message) || e));
  }
}

async function toggleStar(artId) {
  const a = findArticle(artId);
  if (!a) return;
  const next = !a.star;
  patchArticle(a.subId, a.id, { star: next });
  if (next) {
    try { await ctx.onethu.favorites.add(favKey(a.id)); } catch (e) { log("加入收藏失败：" + ((e && e.message) || e)); }
  }
  if (ui.reader && ui.reader.id === a.id) ui.reader = Object.assign({}, ui.reader, { star: next });
  render();
  // 宿主的收藏接口只有 add / list（没有 remove）：取消收藏只能清本插件的标记
  if (next) toast("已收藏到 OneTHU 收藏夹");
  else toast("已取消收藏（已加入收藏夹的条目请到 OneTHU 收藏页手动移除）");
}

function toggleRead(artId) {
  const a = findArticle(artId);
  if (!a) return;
  patchArticle(a.subId, a.id, { read: !a.read });
  if (ui.reader && ui.reader.id === a.id) ui.reader = Object.assign({}, ui.reader, { read: !a.read });
  render();
}

async function onChannelToggle(subId, chan, on) {
  const sub = findSub(subId);
  if (!sub) return;
  const cur = sub.channels && sub.channels.length ? sub.channels.slice() : FEED_CHANNEL_IDS.slice();
  const idx = cur.indexOf(chan);
  if (on && idx < 0) cur.push(chan);
  if (!on && idx >= 0) cur.splice(idx, 1);
  if (!cur.length) { toast("至少要保留一个取数通道"); render(); return; }
  sub.channels = cur;
  upsertSub(sub);
  render();
}

/* ---------- 网络自检 ---------- */

/** 自检：把「通道能不能用、卡在哪一层」直接摊开。桌面端出问题时先跑这个。 */
async function runDoctor() {
  ui.busy = "正在自检网络通道…";
  ui.doctor = [];
  render();
  const rows = [];
  const probe = async (label, url, judge) => {
    const t0 = Date.now();
    try {
      const r = await getText(url);
      const ms = Date.now() - t0;
      const bad = judge ? judge(r) : "";
      rows.push({ label: label, ok: !bad, msg: "HTTP " + r.status + " · " + ms + "ms · " + (bad || "正常") + " · cookie " + (jarHeader(url) ? "有" : "无") + " · " + r.len + " 字节" });
    } catch (e) {
      rows.push({ label: label, ok: false, msg: "失败：" + ((e && e.message) || e) });
    }
    ui.doctor = rows.slice();
    render();
  };
  await probe("微信文章域名（带浏览器头）", MP + "/", (r) => (/wappoc_appmsgcaptcha|环境异常/.test(r.text) ? "被要求人机验证（网络环境异常）" : ""));
  await probe("搜狗搜索页（带浏览器头）", EP.sogou("清华大学"), (r) => {
    if (SOGOU_BLOCK_RE.test(r.text) || r.text.indexOf("antispider") >= 0) return "被反爬拦截（要验证码）";
    if (r.text.indexOf('class="txt-box"') < 0) return "没有搜索结果结构（页面改版或空结果）";
    return "";
  });
  const sub = loadSubs()[0];
  if (sub && sub.biz) await probe("第一个订阅的页面模板 hid=1", EP.homepage(sub.biz, 1, 0), (r) => (isWeChatErrPage(r.text) ? "该 hid/cid 无效（换其它通道）" : ""));
  ui.busy = "";
  ui.doctor = rows.slice();
  render();
  const bad = rows.filter((x) => !x.ok).length;
  toast(bad ? "自检：" + bad + " 项异常（结果见页面顶部）" : "自检：通道全部正常");
  return rows;
}

function doctorHtml() {
  if (!ui.doctor || !ui.doctor.length) return "";
  let h = '<div class="wx-note">网络自检结果（' + esc(new Date().toLocaleString()) + "）：<ul>";
  for (const x of ui.doctor) h += "<li>" + (x.ok ? "✅ " : "⚠️ ") + esc(x.label) + " — " + esc(x.msg) + "</li>";
  h += "</ul>" + act("doctor-close", "", "关闭自检结果") + "</div>";
  return h;
}

async function onAction(action, id, data) {
  if (action === "refresh") return doRefresh();
  if (action === "digest") return doDigest();
  if (action === "classify") return doClassify(false);
  if (action === "manage") { ui.mode = ui.mode === "manage" ? "list" : "manage"; ui.note = ""; render(); return; }
  if (action === "doctor") return runDoctor();
  if (action === "doctor-close") { ui.doctor = null; render(); return; }
  if (action === "filter") { ui.filter = id || ""; ui.openId = ""; ui.limit = 0; render(); return; }
  if (action === "open") return openArticle(id);
  if (action === "back") { ui.openId = ""; ui.reader = null; ui.summary = ""; ui.note = ""; render(); return; }
  if (action === "star") return toggleStar(id);
  if (action === "read") return toggleRead(id);
  if (action === "copy") return copyLink(id, "");
  if (action === "ext") return copyLink("", data && data.url);
  if (action === "aisum") return doSummarize(id);
  if (action === "addsub") return addSubFlow();
  if (action === "import") return importTableFlow(id || "");
  if (action === "more") { ui.limit = Math.max(60, ui.limit || 120) + 120; render(); return; }
  if (action === "sync") {
    const sub = findSub(id);
    if (!sub) return;
    ui.busy = "正在刷新「" + sub.name + "」…";
    render();
    const r = await refreshSub(sub);
    ui.busy = "";
    ui.note = r.error ? "刷新失败：" + r.error : "「" + sub.name + "」新增 " + r.added + " 篇";
    render();
    return;
  }
  if (action === "toggle") {
    const sub = findSub(id);
    if (!sub) return;
    sub.enabled = !sub.enabled;
    upsertSub(sub);
    render();
    return;
  }
  if (action === "del") {
    const sub = findSub(id);
    if (!sub) return;
    const yes = await ctx.onethu.ui.confirm("删除订阅「" + sub.name + "」？该订阅已抓到的文章与缓存也会一并清除。", { danger: true, title: "删除订阅", confirmText: "删除" });
    if (!yes) return;
    removeSub(id);
    if (ui.filter === id) ui.filter = "";
    if (ui.reader && ui.reader.subId === id) { ui.openId = ""; ui.reader = null; ui.readerLoading = false; }
    ui.summary = "";
    render();
    toast("已删除订阅：" + sub.name);
    return;
  }
}

/* ---------- 订阅流程 ---------- */

async function subscribeByArticle(url) {
  ui.busy = "正在识别公众号…";
  render();
  try {
    const parsed = await fetchArticle(url);
    if (!parsed.biz) throw new Error("没能从文章页取到 biz，可能不是公众号文章");
    const name = parsed.account || "未命名公众号";
    const id = subIdFor(parsed.biz, "", name);
    let sub = findSub(id);
    if (sub) {
      sub.enabled = true;
      sub.biz = parsed.biz;
      sub.ghId = sub.ghId || parsed.ghId;
      upsertSub(sub);
    } else {
      sub = newSub({ id: id, name: name, biz: parsed.biz, ghId: parsed.ghId, keywords: [name], albumIds: parsed.albumIds || [], channels: FEED_CHANNEL_IDS.slice() });
      upsertSub(sub);
    }
    const canon = canonicalLink(parsed);
    const link2 = canon || normLink(url);
    mergeCandidates(sub, [{
      id: articleId(link2, parsed.mid, parsed.idx),
      title: parsed.title,
      link: link2,
      t: parsed.t,
      digest: parsed.digest,
      cover: parsed.cover,
      source: "article",
      ext: !canon && isSogouTempLink(url) ? { temp: true } : null,
    }]);
    const r = await refreshSub(sub);
    ui.busy = "";
    return { ok: true, message: "已订阅「" + name + "」" + (r.added ? "，并发现 " + r.added + " 篇其它文章" : "（其它通道暂未发现更多文章，可用合集/搜狗通道再试）") };
  } catch (e) {
    ui.busy = "";
    return { ok: false, message: "订阅失败：" + ((e && e.message) || e) };
  }
}

async function subscribeRss(url) {
  ui.busy = "正在读取 RSS…";
  render();
  try {
    const r = await getText(url);
    const items = parseRss(r.text);
    if (!items.length) throw new Error("这个地址里没有解析到条目（可能不是 RSS/Atom，或需要认证）");
    const tm = r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const name = stripTags(tm ? tm[1] : "") || trimTo(url, 30);
    const id = subIdFor("", url, name);
    let sub = findSub(id);
    if (!sub) sub = newSub({ id: id, name: name, rssUrl: url, channels: ["rss"], keywords: [name] });
    sub.enabled = true;
    upsertSub(sub);
    const merged = mergeCandidates(sub, items);
    ui.busy = "";
    return { ok: true, message: "已订阅 RSS「" + name + "」（" + merged.added + " 篇）" };
  } catch (e) {
    ui.busy = "";
    return { ok: false, message: "RSS 订阅失败：" + ((e && e.message) || e) };
  }
}

async function subscribeByName(name) {
  ui.busy = "正在搜狗搜索「" + name + "」…";
  render();
  let r;
  try { r = await getText(EP.sogou(name)); }
  catch (e) { ui.busy = ""; return { ok: false, message: "搜索失败：" + ((e && e.message) || e) }; }
  if (SOGOU_BLOCK_RE.test(r.text)) {
    ui.busy = "";
    return { ok: false, message: sogouBlockMessage() };
  }
  const items = parseSogouList(r.text).filter((it) => !it.account || nameMatch(it.account, name));
  const cands = uniqBy(items.map((it) => ({ name: it.account || name, rel: it.rel, title: it.title })), (o) => o.name).slice(0, 8);
  if (!cands.length) { ui.busy = ""; render(); return { ok: false, message: "搜狗没有搜到「" + name + "」的公众号。请改用「粘贴一篇文章链接」订阅。" }; }
  const ans = await ctx.onethu.ui.form("选择要订阅的公众号", [
    {
      key: "pick",
      label: "搜狗搜到的公众号",
      kind: "select",
      required: true,
      options: cands.map((c) => ({ value: c.rel, label: c.name + "（" + trimTo(c.title, 22) + "）" })),
    },
  ]);
  ui.busy = ""; // 表单结束才解锁，避免连点开出第二个表单
  if (!ans || !ans.pick) { render(); return { ok: false, message: "已取消" }; }
  ui.busy = "正在解析公众号…";
  render();
  let link = "";
  try {
    const hop = await getText(SOGOU + ans.pick);
    // 实测：搜索页能出结果，但 /link 中转页会被弹到 /antispider/（缺 cookie 或请求太快时）
    if (SOGOU_BLOCK_RE.test(hop.text)) return { ok: false, message: sogouBlockMessage() };
    link = sogouRealLink(hop.text);
  } catch (e) { log("搜狗中转页失败：" + ((e && e.message) || e)); }
  ui.busy = "";
  if (!/^https:\/\/mp\.weixin\.qq\.com\//.test(link)) return { ok: false, message: "没能解析出该公众号的文章链接（搜狗页面结构可能变了），请改用「粘贴一篇文章链接」订阅。" };
  return subscribeByArticle(link);
}

async function subscribeFromInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return { ok: false, message: "没有输入内容" };
  const r = /^https?:\/\//i.test(s)
    ? /mp\.weixin\.qq\.com/i.test(s)
      ? await subscribeByArticle(s)
      : await subscribeRss(s)
    : await subscribeByName(s);
  ui.mode = "list";
  render();
  return r;
}

async function addSubFlow() {
  if (flowBusy) { toast("已有订阅 / 导入流程在进行中，请先完成它"); return; }
  flowBusy = true;
  try { await addSubFlowInner(); } finally { flowBusy = false; }
}

async function addSubFlowInner() {
  const input = await ctx.onethu.ui.form("新增公众号订阅", [
    { key: "input", label: "文章链接 / 公众号名 / RSS 地址", placeholder: "https://mp.weixin.qq.com/s/… 或 清华大学", required: true },
  ]);
  if (!input) return;
  const r = await subscribeFromInput(String(input.input || ""));
  toast(r.message);
  ui.mode = "list";
  render();
}


/* ---------- 导入表格（wechatDownload 等工具导出的 CSV） ---------- */

/** 从链接里抠 __biz（导入时用它把表格对到已有订阅上）。 */
function bizFromLink(link) {
  const m = String(link || "").match(/[?&]__biz=([A-Za-z0-9+/=%]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

/** 导入结果的一句话摘要。 */
function importSummary(sub, r) {
  const parts = ["表格 " + r.total + " 行", "新增 " + r.added + " 篇", "合并 " + Math.max(0, r.list.length - r.added) + " 篇"];
  if (r.skipped) parts.push("跳过 " + r.skipped + " 行" + (r.nonMp ? "（其中 " + r.nonMp + " 行不是公众号链接）" : ""));
  if (r.capped) parts.push("超过上限未收 " + r.capped + " 篇");
  return "「" + ((sub && sub.name) || "未指定订阅") + "」" + parts.join("、");
}

/** 解析 + 合并 + 落库。返回 { ok, message, r }（r 同时带 added）。 */
function importTableInto(sub, raw, opts) {
  const rows = parseTable(raw);
  if (!rows.length) return { ok: false, message: "表格是空的（没解析到任何行）" };
  const cap = opts && opts.max ? opts.max : cfgNum("importMax", 2000);
  const r = candidatesFromTable(rows, cap);
  if (!r.list.length) {
    return {
      ok: false,
      message: "表格里没有可导入的公众号文章（共 " + r.total + " 行、跳过 " + r.skipped + " 行" +
        (r.nonMp ? "，其中 " + r.nonMp + " 行不是 mp.weixin.qq.com 链接" : "") + "）",
    };
  }
  const merged = mergeCandidates(sub, r.list);
  r.added = merged.added;
  sub.lastImportAt = Date.now();
  sub.importedCount = (sub.importedCount || 0) + merged.added;
  upsertSub(sub);
  globalTrim();
  ui.note = "已导入：" + importSummary(sub, r) + "。该订阅现有 " + loadArticles(sub.id).length + " 篇。";
  return { ok: true, message: importSummary(sub, r), r: r };
}

/**
 * 导入表格流程：选订阅 → 粘贴表格 → 解析入库。
 * 订阅的确定顺序：显式传入（订阅管理里的「导入表格」按钮）→ 表单选中的 → 表格里第一条链接的 __biz 命中的
 * → 都没有时用第一条链接走一次「粘贴链接订阅」把公众号建出来。
 */
async function importTableFlow(presetSubId) {
  if (flowBusy) { toast("已有订阅 / 导入流程在进行中，请先完成它"); return { ok: false, message: "已有流程在进行中" }; }
  flowBusy = true;
  try { return await importTableFlowInner(presetSubId); } finally { flowBusy = false; }
}

async function importTableFlowInner(presetSubId) {
  const subs = loadSubs();
  const fields = [];
  if (subs.length) {
    fields.push({
      key: "target",
      label: "导入到哪个订阅",
      kind: "select",
      required: true,
      options: subs.map((s) => ({ value: s.id, label: s.name + (s.biz ? "（" + trimTo(s.biz, 16) + "）" : "") })),
    });
  } else {
    fields.push({ key: "target", label: "导入到哪个订阅", placeholder: "还没有订阅：留空就按表格第一行链接自动识别并新建", default: "" });
  }
  fields.push({
    key: "csv",
    label: "表格内容（CSV，或从表格软件/表格网页直接复制）",
    kind: "textarea",
    required: true,
    placeholder: "title,url,time,like_num,read_num,share_num,comment_count\n文章标题,https://mp.weixin.qq.com/s?…,2024-03-29 08:35:31,102,15236,307,65",
  });
  const ans = await ctx.onethu.ui.form("导入公众号文章表格", fields);
  if (!ans) return { ok: false, message: "已取消" };
  const raw = String(ans.csv || "");
  if (!raw.trim()) return { ok: false, message: "没有粘贴表格内容" };

  ui.mode = "list";
  ui.busy = "正在导入表格…";
  render();
  try {
    let sub = presetSubId ? findSub(presetSubId) : null;
    if (!sub && String(ans.target || "")) sub = findSub(String(ans.target));
    if (!sub) {
      const probe = candidatesFromTable(parseTable(raw), 1);
      const link = probe.list.length ? probe.list[0].link : "";
      if (!link) return { ok: false, message: "表格里没有可用的公众号文章链接（需要 title 与 mp.weixin.qq.com 的 url 两列）" };
      const biz = bizFromLink(link);
      let hit = null;
      for (const s of loadSubs()) if (biz && s.biz && s.biz === biz) hit = s;
      if (hit) sub = hit;
      else {
        ui.busy = "正在按表格里的链接识别公众号…";
        render();
        const r = await subscribeByArticle(link);
        if (!r.ok) return { ok: false, message: "没能自动识别公众号（" + r.message + "）。请先用「订阅公众号」建立订阅，再导入表格。" };
        for (const s of loadSubs()) if (s.biz && biz && s.biz === biz) sub = s;
        if (!sub) sub = loadSubs()[loadSubs().length - 1];
      }
    }
    if (!sub) return { ok: false, message: "没能确定导入目标订阅。请先用「订阅公众号」建立订阅，再导入表格。" };
    ui.busy = "";
    const r = importTableInto(sub, raw, {});
    render();
    return r;
  } finally {
    ui.busy = "";
  }
}

/* ---------- 事件绑定与命令 ---------- */

function bindEvents(root) {
  if (root.dataset && root.dataset.wxBound) return;
  if (root.dataset) root.dataset.wxBound = "1";
  root.addEventListener("click", (ev) => {
    const t = ev.target;
    const el = t && t.closest ? t.closest("[data-act]") : null;
    if (!el) return;
    const action = el.getAttribute("data-act");
    if (!action || action === "chan") return;
    if (ev.preventDefault) ev.preventDefault();
    const ds = el.dataset || {};
    onAction(action, ds.id || "", ds).catch((e) => {
      ui.busy = "";
      ui.note = "操作失败：" + ((e && e.message) || e);
      render();
    });
  });
  root.addEventListener("change", (ev) => {
    const el = ev.target;
    if (!el || !el.getAttribute || el.getAttribute("data-act") !== "chan") return;
    onChannelToggle(el.getAttribute("data-sub"), el.getAttribute("data-chan"), !!el.checked);
  });
}

function registerCommands() {
  ctx.registerCommand({ id: "wechat-refresh", title: "刷新公众号订阅" }, async () => {
    const subs = loadSubs();
    if (!subs.length) return { text: "还没有订阅。运行「订阅公众号」命令，粘贴一篇文章链接即可。", markdown: "" };
    const r = await refreshAll();
    return {
      text: "刷新完成：新增 " + r.added + " 篇（" + r.subs.length + " 个订阅，耗时 " + Math.round(r.ms / 1000) + "s）" + (r.errors.length ? "；部分通道失败" : ""),
      items: r.subs.map((s) => {
        const bad = (s.sources || []).filter((x) => !x.ok).map((x) => sourceLabel(x.id) + "（" + x.error + "）");
        const extra = s.error || bad.join("、");
        return {
          title: s.name,
          subtitle: (s.added ? "新增 " + s.added + " 篇" : "无新增") + (extra ? " · " + extra : ""),
          meta: s.total + " 篇",
        };
      }),
      kv: [
        { k: "订阅", v: String(r.subs.length) },
        { k: "新增", v: String(r.added) },
        { k: "未读", v: String(totalUnread()) },
        { k: "总篇数", v: String(allArticles().length) },
      ],
    };
  });

  ctx.registerCommand({ id: "wechat-digest", title: "生成公众号日报" }, async () => {
    const r = await aiDailyDigest();
    if (!r.ok) return { text: "日报未生成（" + r.reason + "）", markdown: "" };
    return { text: "公众号日报 · " + r.date + "（" + r.count + " 篇）", markdown: r.markdown };
  });

  ctx.registerCommand(
    { id: "wechat-sub", title: "订阅公众号", inputLabel: "文章链接 / 公众号名 / RSS 地址", inputPlaceholder: "https://mp.weixin.qq.com/s/… 或 清华大学" },
    async (input) => {
      const s = String(input == null ? "" : input).trim();
      if (!s) {
        await addSubFlow();
        return "已打开订阅表单（也可以直接在这条命令后面跟上文章链接 / 公众号名 / RSS 地址）。";
      }
      const r = await subscribeFromInput(s);
      return r.message;
    }
  );

  ctx.registerCommand({ id: "wechat-latest", title: "看最新一篇" }, async () => {
    const arts = allArticles().slice(0, 5);
    if (!arts.length) return "还没有文章，先运行「刷新公众号订阅」。";
    return {
      text: "最近 " + arts.length + " 篇：",
      items: arts.map((a) => ({
        title: a.title,
        subtitle: (a.subName || "") + " · " + relTimeOf(a) + " · " + sourceLabel(a.source),
        meta: a.read ? "已读" : "未读",
      })),
      kv: [{ k: "未读", v: String(totalUnread()) }],
    };
  });

  ctx.registerCommand({ id: "wechat-doctor", title: "网络自检（公众号通道）" }, async () => {
    const rows = await runDoctor();
    return {
      text: rows.every((x) => x.ok) ? "网络自检：通道全部正常。" : "网络自检：有 " + rows.filter((x) => !x.ok).length + " 项异常。",
      items: rows.map((x) => ({ title: (x.ok ? "✅ " : "⚠️ ") + x.label, subtitle: x.msg })),
      kv: [{ k: "UA", v: UA.slice(0, 40) + "…" }, { k: "cookie", v: jarHeader(MP + "/") ? "已建立会话" : "无" }],
    };
  });

  ctx.registerCommand({ id: "wechat-import", title: "导入公众号文章表格（CSV）" }, async () => {
    const r = await importTableFlow("");
    if (!r.ok) return r.message;
    const arts = allArticles().slice(0, 5);
    return {
      text: r.message,
      items: arts.map((a) => ({ title: a.title, subtitle: (a.subName || "") + " · " + relTimeOf(a) + " · " + sourceLabel(a.source), meta: a.read ? "已读" : "未读" })),
      kv: [
        { k: "新增", v: String(r.r.added) },
        { k: "跳过", v: String(r.r.skipped) },
        { k: "总篇数", v: String(allArticles().length) },
      ],
    };
  });

  ctx.registerCommand({ id: "wechat-open", title: "打开公众号订阅页" }, async () => {
    try { ctx.onethu.nav.go(PAGE_KEY); return "已打开「公众号」页面。"; }
    catch (e) { return "打开失败：" + ((e && e.message) || e); }
  });
}

function resolveAtom(key) {
  const k = String(key || "");
  const cut = k.indexOf("~");
  const rel = cut >= 0 ? k.slice(cut + 1) : k;
  if (rel.indexOf("a:") === 0) {
    const a = findArticle(rel.slice(2));
    if (!a) return null;
    return { title: a.title, sub: (a.subName || "") + " · " + relTimeOf(a) };
  }
  if (rel.indexOf("daily:") === 0) {
    const d = getDaily(rel.slice(6));
    if (!d) return null;
    return { title: "公众号日报 · " + rel.slice(6), sub: d.count + " 篇 · " + (fmtRel(d.at) || "时间未知") };
  }
  return null;
}

const ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 5.5h12.5v13H4z"/><path d="M7.5 9h5.5M7.5 12.5h5.5"/><path d="M16.5 8.5H20v10.5h-9"/></svg>';

/* ---------- 激活 ---------- */

let ctx = null;

export default async function activate(context) {
  ctx = context;
  settingsSnap = null;
  try { ctx.registerCss(CSS); } catch (e) { log("registerCss 失败：" + ((e && e.message) || e)); }
  try { ctx.registerTab({ id: TAB_ID, title: "公众号", iconSvg: ICON }); } catch (e) { log("registerTab 失败：" + ((e && e.message) || e)); }
  try {
    tabOff = ctx.onethu.ui.onTabReady(PAGE_KEY, (root) => {
      ui.root = root;
      bindEvents(root);
      render();
    });
  } catch (e) { log("onTabReady 失败：" + ((e && e.message) || e)); }
  try { registerCommands(); } catch (e) { log("registerCommand 失败：" + ((e && e.message) || e)); }
  try { ctx.registerAtom({ group: "公众号", resolve: resolveAtom }); } catch (e) { log("registerAtom 失败：" + ((e && e.message) || e)); }
  log("已激活 v" + manifest.version + "：订阅 " + loadSubs().length + " 个、文章 " + allArticles().length + " 篇；通道 " + ALL_CHANNEL_IDS.join("/"));
  return {
    dispose() {
      try { if (typeof tabOff === "function") tabOff(); } catch (e) { log("退订 tab 回调失败：" + ((e && e.message) || e)); }
      tabOff = null;
      settingsSnap = null;
      lastRefreshAt = 0;
      resetUi();
      log("已停用（插件数据保留在本地，重新启用后恢复）");
      ctx = null;
    },
  };
}
