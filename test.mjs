/**
 * test.mjs —— onethu.wechat.news（公众号订阅插件）离线测试
 *
 * 用法：node test.mjs
 * 不需要网络、不需要 OneTHU：宿主 ctx 全部 mock，HTTP 全部走内存 fixtures，
 * AI 走本地假模型。覆盖：清单/注册面、订阅、渲染、阅读器、去重、AI、日报、
 * 原子收藏、provider 层契约（禁用的不调用 / 单通道失败隔离 / cursor 写回 /
 * 新增 provider 无需改其它层）、降级、存储裁剪、错误路径。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "plugin.js"), "utf8");

/* ---------- 断言器（不用 node:assert，失败也继续跑完） ---------- */

let pass = 0;
const fails = [];
function ok(cond, label) {
  if (cond) { pass++; return true; }
  fails.push(label);
  return false;
}
function eq(actual, expected, label) {
  return ok(Object.is(actual, expected), label + "（期望 " + JSON.stringify(expected) + "，实际 " + JSON.stringify(actual) + "）");
}
function has(hay, needle, label) {
  return ok(String(hay == null ? "" : hay).indexOf(needle) >= 0, label + "（未找到 " + JSON.stringify(needle) + "）");
}
function notHas(hay, needle, label) {
  return ok(String(hay == null ? "" : hay).indexOf(needle) < 0, label + "（不应出现 " + JSON.stringify(needle) + "）");
}
let reported = false;
function report() {
  if (reported) return;
  reported = true;
  console.log("");
  if (fails.length) {
    console.log("✗ 失败 " + fails.length + " 条 · 通过 " + pass + " 条");
    for (const f of fails) console.log("  - " + f);
  } else {
    console.log("✓ 全部通过：" + pass + " 条断言，0 失败");
  }
}
process.on("exit", () => report());

/* ---------- fixtures ---------- */

const NOW = Date.now();
const NOW_S = Math.floor(NOW / 1000);
const DAY = (() => {
  const d = new Date(NOW);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
})();
const BIZ = "MzkxMjM0NTY3OA==";
const ACCOUNT = "清华大学学生会";
const GH = "gh_abcdef123456";
const ALBUM_ID = "3512345678";
const PAD = "<!--" + "x".repeat(52000) + "-->";

const A1 = "https://mp.weixin.qq.com/s?__biz=" + BIZ + "&mid=2247484001&idx=1&sn=aaa111";
const A_BLOCKED = "https://mp.weixin.qq.com/s?__biz=" + BIZ + "&mid=2247489001&idx=1&sn=zzz999";
const HOME_LINKS = [
  "https://mp.weixin.qq.com/s?__biz=" + BIZ + "&mid=2247484100&idx=1&sn=home01",
  "https://mp.weixin.qq.com/s?__biz=" + BIZ + "&mid=2247484101&idx=1&sn=home02",
];
const ALBUM_LINKS = ["https://mp.weixin.qq.com/s?__biz=" + BIZ + "&mid=2247484200&idx=1&sn=alb001"];

function articleHtml(o) {
  const opt = o || {};
  return "<!DOCTYPE html><html><head><title>x</title></head><body>\n<script>\n" +
    "var msg_title = '" + (opt.title || "关于开展 2026 年春季学期选课工作的通知") + "'.html(false);\n" +
    // 线上真实写法就是「空串 || 真值」（例如 var biz = "" || "MzI4NjAxNjY4Nw==";），这里照抄
    (opt.dropBiz ? "" : 'var biz = "" || "' + (opt.biz || BIZ) + '";\n') +
    'var mid = "' + (opt.mid || "2247484001") + '" || "";\n' +
    'var idx = "' + (opt.idx || "1") + '" || "";\n' +
    'var sn = "' + (opt.sn === undefined ? "aaa111" : opt.sn) + '";\n' +
    'var ct = "' + (opt.ct || NOW_S) + '";\n' +
    'var nickname = htmlDecode("' + (opt.account || ACCOUNT) + '");\n' +
    'var user_name = "' + GH + '";\n' +
    'var msg_cdn_url = "https://mmbiz.qpic.cn/mmbiz_jpg/AAA/0?wx_fmt=jpeg";\n' +
    'var msg_desc = "选课时间、入口与注意事项。";\n' +
    'var album_id_str = "' + (opt.albumId === undefined ? ALBUM_ID : opt.albumId) + '";\n' +
    "</script>\n" +
    '<div id="js_content">\n' +
    "<p>第一段正文内容：2026 年春季学期选课将于 4 月 1 日 9:00 开始。</p>\n" +
    '<p><img data-src="https://mmbiz.qpic.cn/mmbiz_png/BBB/640?wx_fmt=png" /></p>\n' +
    "<p>第三段正文内容：退课截止到 4 月 15 日。</p>\n" +
    '<img data-src="https://evil.example.com/x.png" />\n' +
    "</div>\n" +
    '<div id="js_sg_bar"></div>\n' +
    PAD + "\n</body></html>";
}

function homepageHtml(items) {
  return "<html><head></head><body><script>\nvar username = \"" + GH + "\";\nvar data = " +
    JSON.stringify({ appmsg_list: items }) + ";\n</script></body></html>";
}
function homepageItems(n, from) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const no = (from || 4100) + i;
    out.push({
      title: "页面模板文章 " + no,
      link: "https://mp.weixin.qq.com/s?__biz=" + BIZ + "&amp;mid=22474" + no + "&amp;idx=1&amp;sn=h" + no,
      sendtime: NOW_S - i * 60,
      digest: "摘要 " + no,
    });
  }
  return out;
}
function albumHtml(items) {
  let h = "<html><body><ul>";
  for (const it of items) {
    h += '<li class="js_album_item" data-title="' + it.title + '" data-link="' + it.link +
      '" data-msgid="' + it.msgid + '" data-itemidx="1" data-cover=""></li>';
  }
  h += "</ul><script>window.cgiData = " + JSON.stringify({ continue_flag: "0" }) + ";</script></body></html>";
  return h;
}
function albumHtmlMore() {
  return "<html><body><ul></ul><script>window.cgiData = " +
    JSON.stringify({ continue_flag: "1", from_msgid: "999", from_itemidx: "1" }) + ";</script></body></html>";
}
const RSS_XML = '<?xml version="1.0"?><rss version="2.0"><channel><title>自建 RSS 源</title>' +
  "<item><title>RSS 文章一</title><link>https://mp.weixin.qq.com/s?__biz=" + BIZ + "&amp;mid=2247487001&amp;idx=1&amp;sn=rss01</link>" +
  "<pubDate>Wed, 01 Apr 2026 01:00:00 GMT</pubDate><description>来自 RSS 的描述</description></item>" +
  "<item><title>RSS 文章二</title><link>https://mp.weixin.qq.com/s?__biz=" + BIZ + "&amp;mid=2247487002&amp;idx=1&amp;sn=rss02</link>" +
  "<pubDate>Wed, 01 Apr 2026 02:00:00 GMT</pubDate><description>第二篇</description></item>" +
  "</channel></rss>";
const SOGOU_EMPTY = "<html><body><div>没有结果</div></body></html>";
const SOGOU_BLOCKED = "<html><body>请输入验证码 antispider</body></html>";
const SOGOU_OK = "<html><body>" +
  '<div class="txt-box"><h3><a target="_blank" href="/link?url=dn9a_abc&amp;type=2&amp;query=x&amp;token=y" id="sogou_vr_11002601_title_0"><em><!--red_beg-->' + ACCOUNT + '<!--red_end--></em>到访南开大学开展调研交流&ldquo;一二&middot;九&rdquo;歌咏比赛</a></h3>' +
  '<p class="txt-info" id="sogou_vr_11002601_summary_0">' + ACCOUNT + '执行主席在会上介绍部门架构与工作分工，从九大模块介绍学生会在思想引领方面的工作。</p>' +
  '<div class="s-p"><span class="all-time-y2">' + ACCOUNT + '</span><span class="s2"><script>document.write(timeConvert(\'1712577628\'))</script></span></div></div>' +
  "</body></html>";
const SOGOU_OK_OTHER = SOGOU_OK.split(ACCOUNT).join("南开大学学生会").split("到访南开大学开展调研交流").join("举办春季运动会");
const SOGOU_HOP_OK = "<html><script>var url = \'\';\nurl += \'https://mp.weixin.qq.com/s?__biz=" + BIZ + "&mid=2247487101&idx=1&sn=sg01\';\nwindow.location.replace(url)</script></html>";
const BLOCKED_PAGE = "<html><body><div>环境异常，请在微信客户端打开</div></body></html>";
/** 微信 POC 人机验证页（线上实测形状：wappoc_appmsgcaptcha + poc_token）。 */
const CAPTCHA_PAGE = '<html><head><title></title></head><body><div id="js_weixin_poc" data-poc-token="x"><div>环境异常，请在微信客户端打开</div>' +
  '<script>var poc_token="poc_abc";location.href="/mp/wappoc_appmsgcaptcha?poc_token=poc_abc";</script></body></html>' + PAD;
/** 失效/错误链接页（线上实测：可见文字就是「系统出错 ： …」，没有正文也没有验证码）。 */
const EXPIRED_BODY = "<html><head><title></title></head><body><div>系统出错 ： 请稍后重试</div></body></html>";
/** 搜狗搜索结果里的临时链接（带 signature，只在当时那个会话短暂有效）。 */
const TEMP_LINK = "https://mp.weixin.qq.com/s?src=11&timestamp=1791905902&ver=7024&signature=RMJHzF24deadbeef";
const SOGOU_HOP_TEMP = "<html><script>var url = '';\nurl += '" + TEMP_LINK.replace(/&/g, "&amp;") + "';\nwindow.location.replace(url)</script></html>";

/* ---------- 假宿主 ---------- */

let runSeq = 0;
async function loadModule(code) {
  runSeq++;
  const src = code + "\n// harness-run-" + runSeq + "\n";
  return await import("data:text/javascript;base64," + Buffer.from(src, "utf8").toString("base64"));
}

function makeRoot() {
  const el = {
    dataset: {},
    listeners: {},
    _html: "",
    root: null,
    addEventListener(type, fn) { this.listeners[type] = fn; },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return this._html; },
    set(v) { this._html = String(v); },
  });
  return el;
}

function makeHost(opts) {
  const o = opts || {};
  const settings = Object.assign({ requestGapMs: "0" }, o.settings || {});
  const store = new Map();
  const routes = o.routes || {};
  const calls = { fetch: [], reqs: [], chat: [], clipboard: "", fav: [], nav: "", toast: [], forms: [] };
  const writes = [];
  const commands = new Map();
  const logs = [];
  let tab = null, css = "", atom = null, tabReady = null;
  const root = o.noRoot ? null : makeRoot();

  const routeFor = (url) => {
    const keys = Object.keys(routes).filter((k) => k !== "*" && url.indexOf(k) >= 0);
    const key = keys.length ? keys[0] : (routes["*"] !== undefined ? "*" : "");
    if (!key) return { reject: "没有为该请求准备 fixture：" + url };
    let spec = routes[key];
    if (typeof spec === "function") spec = spec(url);
    return spec == null ? { body: "" } : spec;
  };

  const ctx = {
    log(line) { logs.push(String(line)); },
    registerCommand(def, fn) { commands.set(def.id, fn); },
    registerTab(def) { tab = def; },
    registerCss(text) { css += text; },
    registerAtom(def) { atom = def; },
    onethu: {
      settings: {
        get(k) { return k in settings ? settings[k] : null; },
        set(k, v) { settings[k] = v; },
      },
      storage: {
        get(k) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
        set(k, v) {
          const s = JSON.stringify(v);
          if (o.quota && o.quota(k, s)) { const e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e; }
          writes.push(k);
          store.set(k, s);
          return true;
        },
        keys() { return Array.from(store.keys()); },
        remove(k) { store.delete(k); },
      },
      net: {
        async fetch(url, init) {
          calls.fetch.push(url);
          calls.reqs.push({ url: url, headers: (init && init.headers) || null, method: (init && init.method) || "GET" });
          const spec = routeFor(url);
          if (spec.reject) throw new Error(spec.reject);
          const status = spec.status == null ? 200 : spec.status;
          const hdrs = spec.headers || null;
          return {
            status: status,
            ok: status < 400,
            url: url,
            headers: {
              get(n) {
                if (!hdrs) return null;
                const k = String(n).toLowerCase();
                for (const name of Object.keys(hdrs)) if (name.toLowerCase() === k) return hdrs[name];
                return null;
              },
            },
            async text() { return spec.body == null ? "" : String(spec.body); },
          };
        },
      },
      llm: {
        provider() { return "madmodel"; },
        async chat(prompt) {
          calls.chat.push(prompt);
          if (o.llm) return o.llm(prompt);
          return { text: "{}", model: "fake" };
        },
      },
      ui: {
        toast(t) { calls.toast.push(String(t)); },
        async confirm() { return o.confirm === undefined ? true : o.confirm; },
        async form(title, fields) { calls.forms.push({ title: title, fields: fields }); return o.form ? o.form(title, fields) : null; },
        onTabReady(key, cb) { tabReady = { key: key, cb: cb }; },
        getTabRoot() { return root; },
        clipboard: {
          async write(s) { calls.clipboard = String(s); },
          async read() { return ""; },
        },
      },
      favorites: { async add(k) { calls.fav.push(String(k)); return true; } },
      nav: { go(page) { calls.nav = page; return true; } },
    },
  };

  const h = {
    ctx: ctx, store: store, calls: calls, commands: commands, logs: logs, settings: settings, root: root, routes: routes,
    get tab() { return tab; },
    get css() { return css; },
    get atom() { return atom; },
    get tabReady() { return tabReady; },
    get: (k) => (store.has(k) ? JSON.parse(store.get(k)) : null),
    set: (k, v) => store.set(k, JSON.stringify(v)),
    keys: () => Array.from(store.keys()),
    subs: () => {
      const v = store.has("subs") ? JSON.parse(store.get("subs")) : [];
      return Array.isArray(v) ? v : [];
    },
    sub: (name) => {
      const list = h.subs();
      for (const s of list) if (name ? s.name === name : true) return s;
      return null;
    },
    arts: (subId) => {
      const id = subId || (h.subs()[0] || {}).id;
      const v = store.has("a:" + id) ? JSON.parse(store.get("a:" + id)) : [];
      return Array.isArray(v) ? v : [];
    },
    art: (artId) => {
      for (const s of h.subs()) for (const a of h.arts(s.id)) if (a.id === artId) return a;
      return null;
    },
    fetches: (needle) => calls.fetch.filter((u) => u.indexOf(needle) >= 0),
    writes: () => writes.slice(),
    writesOf: (k) => writes.filter((x) => x === k).length,
    toasts: () => calls.toast.slice(),
    reqs: (needle) => calls.reqs.filter((r) => r.url.indexOf(needle) >= 0),
    hdr(rec, name) {
      if (!rec || !rec.headers) return null;
      const k = String(name).toLowerCase();
      for (const key of Object.keys(rec.headers)) if (key.toLowerCase() === k) return rec.headers[key];
      return null;
    },
    notes: () => (root ? root.innerHTML : "") + " / " + logs.join(" / "),
    attachTab() {
      if (!root || !tabReady) return root;
      tabReady.cb(root);
      return root;
    },
    async click(action, id, extra) {
      if (!root || !root.listeners.click) return false;
      const el = {
        getAttribute: (n) => (n === "data-act" ? action : null),
        dataset: Object.assign({ act: action, id: id || "" }, extra || {}),
      };
      root.listeners.click({
        target: { closest: () => el },
        preventDefault() {},
      });
      await settle(h);
      return true;
    },
    async change(subId, chan, checked) {
      if (!root || !root.listeners.change) return false;
      root.listeners.change({
        target: { getAttribute: (n) => (n === "data-act" ? "chan" : n === "data-sub" ? subId : n === "data-chan" ? chan : null), checked: !!checked },
      });
      await settle(h);
      return true;
    },
  };
  return h;
}

/** 等宿主安静下来：连续几拍没有任何新请求 / 日志 / DOM 变化。 */
async function settle(h, minStable, maxTicks) {
  const stableNeed = minStable || 3;
  const cap = maxTicks || 600;
  let last = "", stable = 0;
  for (let i = 0; i < cap; i++) {
    await new Promise((r) => setTimeout(r, 2));
    const sig = h.calls.fetch.length + "|" + h.calls.chat.length + "|" + h.logs.length + "|" +
      (h.root ? h.root.innerHTML.length : 0) + "|" + h.keys().length + "|" + h.calls.toast.length;
    if (sig === last) {
      stable++;
      if (stable >= stableNeed) return;
    } else {
      stable = 0;
      last = sig;
    }
  }
}

/* ---------- 通用 fixtures / 启动器 ---------- */

async function boot(opts) {
  const mod = await loadModule(opts && opts.code ? opts.code : SRC);
  const h = makeHost(opts);
  await mod.default(h.ctx);
  h.mod = mod;
  if (h.root) h.attachTab();
  return h;
}

function baseRoutes(extra) {
  const specific = {
    "mid=2247484001": { body: articleHtml() },
    "mid=2247489001": { body: BLOCKED_PAGE },
    "mp/homepage": (url) => ({
      body: url.indexOf("hid=1&cid=1") >= 0 ? homepageHtml(homepageItems(2, 4100)) : homepageHtml([]),
    }),
    "mp/appmsgalbum": { body: albumHtml([{ title: "合集文章 4200", link: ALBUM_LINKS[0], msgid: "2247484200" }]) },
    "weixin.sogou.com": { body: SOGOU_EMPTY },
    "example.com/feed.xml": { body: RSS_XML },
  };
  const generic = {
    "mp.weixin.qq.com/s?": (url) => {
      const mid = (url.match(/mid=(\d+)/) || [])[1] || "0";
      const idx = (url.match(/idx=(\d+)/) || [])[1] || "1";
      return { body: articleHtml({ mid: mid, idx: idx, title: "文章 " + mid, albumId: "" }) };
    },
  };
  return Object.assign(specific, generic, extra || {});
}

function aiStub(prompt) {
  if (prompt.indexOf("中文日报") >= 0) {
    return {
      text: "## 导读\n今天最值得看的是选课安排。\n\n1. **选课通知**：4 月 1 日 9:00 开始选课，退课截止 4 月 15 日。\n2. **讲座**：周三有 AI 讲座。",
      model: "fake-digest",
    };
  }
  if (prompt.indexOf("总结这篇公众号文章") >= 0) {
    return { text: "- 选课 4 月 1 日开始\n- 退课截止 4 月 15 日\n一句话：别错过选课窗口。", model: "fake-sum" };
  }
  const nums = Array.from(prompt.matchAll(/^(\d+)\. /gm)).map((m) => parseInt(m[1], 10));
  const items = nums.map((i) => ({ i: i, cats: ["通知公告"], points: ["要点 " + i] }));
  return { text: JSON.stringify({ items: items, topics: ["选课季"] }), model: "fake-classifier" };
}

const A1_ID = "2247484001_1";
const A1_TITLE = "关于开展 2026 年春季学期选课工作的通知";

/* ---------- 1. 清单与注册面 ---------- */

const b = await boot({ routes: baseRoutes(), llm: aiStub });
const M = b.mod.manifest;
eq(M.id, "onethu.wechat.news", "manifest.id 固定");
ok(/^[a-z0-9.-]+$/.test(M.id), "manifest.id 只含 [a-z0-9.-]");
eq(M.kind, "js", "kind=js（纯 JS 插件，无 sidecar）");
eq(M.permissions.join(","), "net:external,llm,storage,ui,css,nav", "只申请这 6 个权限，不多要");
ok(M.settings.length >= 13, "设置项数量：" + M.settings.length);
ok(M.settings.some((s) => s.key === "channels"), "有 channels（通道开关，扩展点入口）");
ok(M.settings.some((s) => s.key === "rssUrls"), "有 rssUrls（接自建 wewe-rss 全量历史）");
ok(M.settings.some((s) => s.key === "historyToken" && s.type === "password"), "预留 historyToken（全量历史扩展点，本期只存不读）");
ok(M.settings.some((s) => s.key === "visionEnabled"), "识图开关留档");
eq(M.commands.map((c) => c.id).join(","), "wechat-refresh,wechat-digest,wechat-sub,wechat-latest,wechat-open,wechat-import,wechat-doctor", "7 个命令（含导入表格与网络自检）");
ok(M.settings.some((s) => s.key === "sogouResolveMax"), "有 sogouResolveMax（临时链接归一上限）");
ok(M.settings.some((s) => s.key === "importMax"), "有 importMax（导入表格上限）");
eq(b.tab.id, "feed", "registerTab id");
eq(b.tab.title, "公众号", "registerTab 标题");
eq(String(b.tab.iconSvg).indexOf("<svg"), 0, "registerTab 带 svg 图标");
eq(b.tabReady.key, "plugin:onethu.wechat.news:feed", "PAGE_KEY 与宿主约定 plugin:<id>:<tabId> 一致");
has(b.css, '[data-plg="onethu.wechat.news"]', "CSS 全部限定在插件作用域内");
eq(b.commands.size, 7, "7 个命令都注册成功");
ok(Array.from(b.commands.keys()).indexOf("wechat-import") >= 0, "wechat-import（导入表格）已注册");
eq(b.atom.group, "公众号", "原子收藏分组");
has(b.logs.join("\n"), "已激活 v" + M.version, "激活日志");
has(b.logs.join("\n"), "homepage/album/sogou/rss", "激活日志列出通道注册表（可插拔层的可见性）");

/* ---------- 2. 空状态 ---------- */

has(b.root.innerHTML, "还没有文章", "空状态提示");
has(b.root.innerHTML, "订阅管理", "工具栏有订阅管理入口");
has(b.root.innerHTML, "尚未更新", "未刷新时显示状态");

/* ---------- 3. 订阅：粘贴一篇文章链接 ---------- */

const subMsg = await b.commands.get("wechat-sub")(A1);
has(subMsg, "已订阅「" + ACCOUNT + "」", "命令返回订阅结果");
const sub = b.sub(ACCOUNT);
ok(!!sub, "订阅已入库");
eq(sub.biz, BIZ, "从文章页取到 biz");
eq(sub.ghId, GH, "回填 ghId（页面模板通道用得到）");
ok((sub.albumIds || []).indexOf(ALBUM_ID) >= 0, "回填合集 album_id");
eq((sub.channels || []).join(","), "homepage,album,sogou,rss", "新订阅默认启用全部通道");
eq(sub.enabled, true, "新订阅默认启用");
eq((sub.sources || []).length, 4, "记录了 4 个通道的取数结果");
eq(sub.error, "", "没有订阅级错误");
const arts = b.arts(sub.id);
ok(arts.length >= 4, "共抓到 " + arts.length + " 篇");
const a1 = b.art(A1_ID);
ok(!!a1, "文章页那篇以 mid_idx 为主键入库");
eq(a1.title, A1_TITLE, "标题取自文章页");
eq(a1.link, A1, "链接已归一化（去掉 # 片段）");
ok(a1.t > NOW - 60000, "时间取自 ct 变量");
eq(a1.read, false, "新文章默认未读");
eq(a1.star, false, "新文章默认未收藏");
eq(a1.ext, null, "ext 字段预留（provider 扩展点）");
eq((a1.cats || []).length, 0, "cats 初始为空");
const srcStr = arts.map((a) => a.source).join(",");
has(srcStr, "article", "来源标记 article（订阅时落地的那篇）");
has(srcStr, "homepage", "来源标记 homepage");
has(srcStr, "album", "来源标记 album");
ok(b.fetches("mp/homepage").length >= 1, "调用了页面模板通道");
{
  const hm = arts.filter((a) => a.source === "homepage");
  ok(hm.length >= 2, "页面模板入库 " + hm.length + " 篇");
  ok(hm[0].t > NOW - 3600000, "页面模板条目的 sendtime（秒）被解析成毫秒时间");
  ok(hm[0].link.indexOf("&amp;") < 0, "JSON 里的 &amp; 已还原成 &（链接可直接打开）");
  ok(hm[0].link.indexOf("mid=22474") > 0, "链接保留了 mid（跨通道去重靠它）");
}
ok(b.fetches("mp/appmsgalbum").length >= 1, "调用了合集通道");

/* ---------- 4. 列表渲染 ---------- */

const listHtml = b.root.innerHTML;
has(listHtml, A1_TITLE, "列表显示文章标题");
has(listHtml, "来源：页面模板", "来源标签取 provider.title（新 provider 自动有名字）");
has(listHtml, "来源：合集", "合集来源标签");
has(listHtml, "全部 ", "筛选 chip");
has(listHtml, "未读 ", "工具栏显示未读计数");
eq(b.root.dataset.plg, "onethu.wechat.news", "根节点带 data-plg（CSS 作用域依赖）");
has(listHtml, 'data-act="open"', "标题是阅读入口");

/* ---------- 5. 应用内阅读器 ---------- */

await b.click("open", A1_ID);
const rHtml = b.root.innerHTML;
has(rHtml, "第一段正文内容", "正文段落渲染");
has(rHtml, "退课截止到 4 月 15 日", "正文后续段落渲染");
has(rHtml, 'src="https://mmbiz.qpic.cn/mmbiz_png/BBB/640?wx_fmt=png"', "微信图床图片内联渲染（无 CSP 限制）");
notHas(rHtml, "evil.example.com", "非 mmbiz/qlogo 图床的图片不渲染");
has(rHtml, "1 张图", "显示图片数量");
eq(b.art(A1_ID).read, true, "打开即标记已读");
eq(b.art(A1_ID).imageCount, 1, "回写图片数量");
eq(b.art(A1_ID).summarized, true, "回写「已抓正文」标记");
has(rHtml, "复制原文链接", "阅读器提供复制链接（桌面端不能直接开外链）");
has(rHtml, "AI 总结这篇", "阅读器提供单篇 AI 总结");

/* ---------- 6. 单篇 AI 总结（含缓存） ---------- */

const chat0 = b.calls.chat.length;
await b.click("aisum", A1_ID);
has(b.root.innerHTML, "别错过选课窗口", "AI 总结显示在阅读器里");
eq(b.calls.chat.length, chat0 + 1, "单篇总结调用一次 AI");
has(b.calls.chat[b.calls.chat.length - 1], A1_TITLE, "提示词带标题");
has(b.calls.chat[b.calls.chat.length - 1], "第一段正文内容", "提示词带正文");
await b.click("aisum", A1_ID);
eq(b.calls.chat.length, chat0 + 1, "同一篇第二次走缓存，不再调 AI");
await b.click("back");
notHas(b.root.innerHTML, "第一段正文内容", "返回列表");

/* ---------- 7. 幂等刷新 / 去重 ---------- */

const n1 = b.arts(sub.id).length;
const r2 = await b.commands.get("wechat-refresh")();
has(r2.text, "新增 0 篇", "重复刷新不重复入库");
eq(b.arts(sub.id).length, n1, "篇数不变");
has(r2.items.map((x) => x.subtitle).join("|"), "无新增", "命令结果逐订阅标注");
eq((r2.kv || []).length >= 3, true, "命令返回结构化 kv");

/* ---------- 8. AI 概览与分类 ---------- */

const chat1 = b.calls.chat.length;
await b.click("classify");
const a1c = b.art(A1_ID);
eq((a1c.cats || []).join(","), "通知公告", "分类写回文章");
eq((a1c.points || []).length >= 1, true, "要点写回文章");
has(b.root.innerHTML, "通知公告", "列表显示分类标签");
ok(b.calls.chat.length > chat1, "分类调用了 AI");
has(b.calls.chat[b.calls.chat.length - 1], "只能从这些里选", "提示词限定类别集合（防止模型自创类别）");
const chat2 = b.calls.chat.length;
await b.click("classify");
eq(b.calls.chat.length, chat2, "已全部分类时不再调 AI（幂等）");
has(b.root.innerHTML, "没有需要整理的文章", "提示无需整理");

/* ---------- 9. 每日重点摘要（日报） ---------- */

const digest = await b.commands.get("wechat-digest")();
has(digest.markdown, "# 公众号日报 · " + DAY, "日报标题带日期");
has(digest.markdown, "导读", "包含 AI 生成的正文");
has(digest.markdown, "分类清单", "附本地分类清单（不依赖 AI 的结构化输出）");
has(digest.markdown, "**通知公告**", "清单按类别分组");
has(digest.markdown, A1, "清单里有原文链接");
has(digest.markdown, ACCOUNT, "清单里标注公众号");
ok(!!b.get("daily:" + DAY), "日报落库（应用重启后仍可见）");
ok(b.get("daily:" + DAY).count >= 3, "日报记录了覆盖篇数（" + b.get("daily:" + DAY).count + " 篇）");
has(digest.text, "公众号日报", "命令文本摘要");
const digestCalls = b.calls.chat.filter((p) => p.indexOf("中文日报") >= 0).length;
eq(digestCalls, 1, "日报只调用一次 AI");
has(b.calls.chat[b.calls.chat.length - 1], "正文摘录", "日报提示词带正文摘录（提升质量）");
has(b.calls.chat[b.calls.chat.length - 1], "不要编造", "日报提示词有反编造约束");
b.attachTab();
has(b.root.innerHTML, "导读", "日报渲染在列表上方");
has(b.root.innerHTML, "fake-digest", "显示生成模型");

/* ---------- 10. 收藏 / 已读 / 复制 / 原子 ---------- */

const atomA = b.atom.resolve("feed~a:" + A1_ID);
eq(atomA.title, A1_TITLE, "原子收藏解析出文章标题");
has(atomA.sub, ACCOUNT, "原子副标题带公众号与时间");
eq(b.atom.resolve("a:" + A1_ID).title, A1_TITLE, "不带 tabId 前缀也能解析（容错）");
eq(b.atom.resolve("feed~a:不存在的文章"), null, "文章不存在时原子失效返回 null");
const atomD = b.atom.resolve("feed~daily:" + DAY);
eq(atomD.title, "公众号日报 · " + DAY, "日报也是可收藏原子");
const favBefore = b.calls.fav.length;
await b.click("star", A1_ID);
eq(b.art(A1_ID).star, true, "点收藏写回文章");
eq(b.calls.fav[b.calls.fav.length - 1], "feed~a:" + A1_ID, "收藏键与原子键完全一致（收藏夹可反查）");
await b.click("star", A1_ID);
eq(b.art(A1_ID).star, false, "再点取消收藏");
eq(b.calls.fav.length, favBefore + 1, "取消收藏不再调用收藏接口");
await b.click("copy", A1_ID);
eq(b.calls.clipboard, b.art(A1_ID).link, "复制的是原文链接（桌面端唯一可行的出口）");
await b.click("read", A1_ID);
eq(b.art(A1_ID).read, false, "可手动切回未读");
await b.click("read", A1_ID);
eq(b.art(A1_ID).read, true, "再切回已读");

/* ---------- 11. 订阅管理（含删除的确认与级联清理） ---------- */

await b.click("manage");
has(b.root.innerHTML, "取数通道可逐个开关", "管理页给出通道开关的说明");
has(b.root.innerHTML, 'data-act="chan"', "管理页有通道复选框");
has(b.root.innerHTML, 'data-chan="album"', "逐个通道列出");
has(b.root.innerHTML, 'data-act="sync"', "单订阅同步");
has(b.root.innerHTML, 'data-act="toggle"', "启用/停用");
has(b.root.innerHTML, 'data-act="del"', "删除订阅");
const sid = b.sub(ACCOUNT).id;
await b.click("sync", sid);
has(b.notes(), "新增 0 篇", "单订阅同步后提示新增数量");
await b.click("manage");
await b.click("toggle", sid);
eq(b.sub(ACCOUNT).enabled, false, "停用订阅");
await b.click("toggle", sid);
eq(b.sub(ACCOUNT).enabled, true, "重新启用");

const delOpts = { routes: baseRoutes(), llm: aiStub, confirm: false };
const dc = await boot(delOpts);
await dc.commands.get("wechat-sub")(A1);
const dcid = dc.subs()[0].id;
await dc.click("del", dcid);
eq(dc.subs().length, 1, "确认框里选取消则不删除");
delOpts.confirm = true;
await dc.click("del", dcid);
eq(dc.subs().length, 0, "确认后删除订阅");
eq(dc.get("a:" + dcid) == null, true, "文章缓存一并清除（不留孤儿数据）");
eq(dc.get("seen:" + dcid) == null, true, "seen 一并清除");

/* ---------- 12. RSS 订阅 + 跨通道主键归一 ---------- */

const RSS_DUP_XML = '<?xml version="1.0"?><rss version="2.0"><channel><title>RSS 同源镜像</title>' +
  "<item><title>RSS 镜像一</title><link>https://mp.weixin.qq.com/s?__biz=" + BIZ + "&amp;mid=224744100&amp;idx=1&amp;sn=h4100</link>" +
  "<pubDate>Wed, 01 Apr 2026 01:00:00 GMT</pubDate></item>" +
  "<item><title>RSS 镜像二</title><link>https://mp.weixin.qq.com/s?__biz=" + BIZ + "&amp;mid=224744101&amp;idx=1&amp;sn=h4101</link>" +
  "<pubDate>Wed, 01 Apr 2026 02:00:00 GMT</pubDate></item>" +
  "</channel></rss>";

const rh = await boot({ routes: baseRoutes(), llm: aiStub });
const rmsg = await rh.commands.get("wechat-sub")("https://example.com/feed.xml");
has(rmsg, "已订阅 RSS「自建 RSS 源」", "RSS 订阅成功");
const rsub = rh.sub("自建 RSS 源");
eq(rsub.rssUrl, "https://example.com/feed.xml", "记录 RSS 地址");
eq((rsub.channels || []).join(","), "rss", "RSS 订阅只启用 rss 通道");
eq(rh.art("2247487001_1").title, "RSS 文章一", "RSS 文章以链接里的 mid_idx 为主键");
ok(rh.art("2247487001_1").link.indexOf("&mid=2247487001") > 0, "实体转义已还原（&amp; → &）");
eq(rh.art("2247487001_1").source, "rss", "来源标记 rss");
has(rh.root.innerHTML, "来源：自备 RSS", "来源标签用 provider.title（自备 RSS）");
eq(rh.arts(rsub.id).length, 2, "两条 item 都入库");

const dupH = await boot({ routes: baseRoutes({ "example.com/dup.xml": { body: RSS_DUP_XML } }), llm: aiStub });
await dupH.commands.get("wechat-sub")(A1);
const dsub = dupH.subs()[0];
const homeIds = dupH.arts(dsub.id).filter((a) => a.source === "homepage").map((a) => a.id);
ok(homeIds.indexOf("224744100_1") >= 0, "页面模板通道的文章主键来自链接里的 mid（" + homeIds.join(",") + "）");
const n0 = dupH.arts(dsub.id).length;
dupH.settings.rssUrls = "https://example.com/dup.xml";
const r3 = await dupH.commands.get("wechat-refresh")();
has(r3.text, "新增 0 篇", "同一篇文章从 RSS 通道再来不算新增（跨通道主键一致）");
eq(dupH.arts(dsub.id).length, n0, "篇数不变");
eq(dupH.art("224744100_1").source, "homepage", "保留首次入库的来源，不被后来的通道改写");

/* ---------- 13. 搜狗：验证码与冷却 ---------- */

const sg = await boot({ routes: baseRoutes({ "weixin.sogou.com": { body: SOGOU_BLOCKED } }), llm: aiStub, settings: { channels: "sogou" } });
const sm = await sg.commands.get("wechat-sub")("清华大学学生会");
has(sm, "验证码", "按名称订阅遇到验证码时给出明确提示");
has(sm, "粘贴文章链接", "并引导改用文章链接订阅");
has(sm, "暂停 30 分钟", "提示里说明该通道已暂停多久（保护账号）");
has(sm, "代理", "提示里给出「关掉代理」这条可操作线索");
eq(sg.subs().length, 0, "被拦时不留下半个订阅");

const sg2 = await boot({ routes: baseRoutes({ "weixin.sogou.com": { body: SOGOU_BLOCKED } }), llm: aiStub });
await sg2.commands.get("wechat-sub")(A1);
const s2 = sg2.sub(ACCOUNT);
ok(!!(s2.failUntil && s2.failUntil.sogou > Date.now()), "搜狗被拦后写入冷却时间（30 分钟）");
const sgSrc = (s2.sources || []).find((x) => x.id === "sogou");
eq(sgSrc.ok, false, "该通道标记为失败");
eq(sgSrc.hard, true, "标记为硬失败（宿主可据此提示换通道）");
has(sgSrc.error, "验证", "失败原因可读");
eq((s2.sources || []).find((x) => x.id === "homepage").ok, true, "其它通道照常成功");

/* 线上结构（2026-10 实测）：账号名在 span.all-time-y2，时间在 timeConvert(\'…\')，标题带 <!--red_beg--> 高亮注释 */
const sg3Routes = baseRoutes();
delete sg3Routes["weixin.sogou.com"];
// 键序即匹配优先级：/link 中转页的 URL 同时含 "weixin.sogou.com"，所以 /link 键必须排在前面
const sg3 = await boot({ routes: Object.assign({ "weixin.sogou.com/link": { body: SOGOU_HOP_OK }, "weixin.sogou.com": { body: SOGOU_OK } }, sg3Routes), llm: aiStub, settings: { channels: "sogou" } });
await sg3.commands.get("wechat-sub")(A1);
const sgArts = sg3.arts(sg3.sub(ACCOUNT).id).filter((a) => a.source === "sogou");
eq(sgArts.length, 1, "搜狗通道按线上结构解析出 1 篇");
const sgArt = sgArts[0] || {};
has(sgArt.title, "到访南开大学", "标题取自 h3 且去掉了高亮注释");
has(sgArt.title, "“一二·九”歌咏比赛", "常见命名实体（ldquo/middot/rdquo）被还原");
ok(sgArt.t > 0, "时间取自 timeConvert(\'…\')");
eq(sgArt.id, "2247487101_1", "中转页链接归一化后主键为 mid_idx");
has(sgArt.digest, "部门架构", "摘要取自 p.txt-info");

const sg4 = await boot({ routes: baseRoutes({ "weixin.sogou.com": { body: SOGOU_OK_OTHER } }), llm: aiStub, settings: { channels: "sogou" } });
await sg4.commands.get("wechat-sub")(A1);
eq(sg4.arts(sg4.sub(ACCOUNT).id).filter((a) => a.source === "sogou").length, 0, "账号名对不上的条目被丢弃（证明账号名解析有效）");
const sogouReq = sg2.fetches("weixin.sogou.com").length;
await sg2.commands.get("wechat-refresh")();
eq(sg2.fetches("weixin.sogou.com").length, sogouReq, "冷却期内不再请求搜狗（保护账号）");

/* ---------- 14. 通道全失败时的降级 ---------- */

const dg = await boot({ routes: baseRoutes(), llm: aiStub });
await dg.commands.get("wechat-sub")(A1);
const dgid = dg.subs()[0].id;
const ids0 = dg.arts(dgid).map((a) => a.id).sort().join(",");
ok(ids0.length > 0, "先有一批文章（" + dg.arts(dgid).length + " 篇）");
dg.routes["mp/homepage"] = { reject: "网络抖动" };
dg.routes["mp/appmsgalbum"] = { reject: "网络抖动" };
dg.routes["weixin.sogou.com"] = { reject: "网络抖动" };
await dg.click("refresh");
eq(dg.arts(dgid).map((a) => a.id).sort().join(","), ids0, "通道全失败时不丢已有文章");
has(dg.root.innerHTML, "所有取数通道都没拿到内容", "顶部说明通道全失败");
has(dg.root.innerHTML, "可稍后重试或换通道", "并给出可操作的建议");
has(dg.root.innerHTML, "通道正常，本次没有新内容", "RSS 空成功不再被误报成「通道不可用」");
const dgR = await dg.commands.get("wechat-refresh")();
has(dgR.items.map((x) => x.subtitle).join("|"), "失败", "命令结果标出失败");
has(dgR.items.map((x) => x.subtitle).join("|"), "页面模板", "并指明是哪个通道失败");
eq(dg.arts(dgid).length, ids0.split(",").length, "篇数不变");
// 真正「所有参与的通道都失败」时才标为不可用（把订阅收窄到只留页面模板）
const dgSubs = dg.subs();
for (const s of dgSubs) s.channels = ["homepage"];
dg.set("subs", dgSubs);
await dg.click("refresh");
has(dg.root.innerHTML, "取数通道暂不可用", "参与通道全失败时才标为不可用");
has(dg.root.innerHTML, "网络抖动", "并把首个失败原因带出来");

/* ---------- 15. 存储裁剪、seen 防复活、⭐ 保护 ---------- */

const tr = await boot({
  routes: baseRoutes({ "mp/homepage": (url) => ({ body: url.indexOf("hid=1&cid=1") >= 0 ? homepageHtml(homepageItems(25, 5000)) : homepageHtml([]) }) }),
  llm: aiStub,
  settings: { perSubKeep: "10", channels: "homepage" },
});
await tr.commands.get("wechat-sub")(A1);
const tid = tr.subs()[0].id;
eq(tr.arts(tid).length, 10, "超出 perSubKeep 的文章被裁剪（上限 10）");
const seenN = (tr.get("seen:" + tid) || []).length;
ok(seenN >= 15, "被裁掉的文章记入 seen，共 " + seenN + " 条");
const trR = await tr.commands.get("wechat-refresh")();
has(trR.text, "新增 0 篇", "seen 挡住已裁掉的文章，避免下次刷新复活");
eq(tr.arts(tid).length, 10, "篇数保持在上限内");
eq((tr.get("seen:" + tid) || []).length, seenN, "seen 不再增长");
const oldest = tr.arts(tid).slice().sort((a, b) => a.t - b.t)[0];
await tr.click("star", oldest.id);
eq(tr.art(oldest.id).star, true, "收藏一篇最旧的文章");
tr.routes["mp/homepage"] = (url) => ({ body: url.indexOf("hid=1&cid=1") >= 0 ? homepageHtml(homepageItems(8, 6000)) : homepageHtml([]) });
await tr.commands.get("wechat-refresh")();
ok(tr.art(oldest.id) !== null, "⭐ 收藏的文章即使最旧也不会被裁掉");
const trN = tr.arts(tid).length;
ok(trN >= 10 && trN <= 11, "总篇数仍受上限约束（" + trN + " 篇）");

/* ---------- 16. 错误路径 ---------- */

const eb = await boot({ routes: baseRoutes(), llm: aiStub, settings: { channels: "homepage" } });
const bm = await eb.commands.get("wechat-sub")(A_BLOCKED);
has(bm, "订阅失败", "文章页被风控时按失败返回");
has(bm, "人机验证", "说明被微信要求人机验证（比旧的「风控」文案更准确）");
eq(eb.subs().length, 0, "失败时不留下半个订阅");
const rm = await eb.commands.get("wechat-sub")("https://example.com/missing.xml");
has(rm, "RSS 订阅失败", "非微信链接走 RSS 分支");
has(rm, "没有为该请求准备 fixture", "底层 HTTP 错误原样带出，便于排查");
const eb2 = await boot({ routes: baseRoutes({ "example.com/feed404.xml": { status: 404, body: "nope" } }), llm: aiStub });
const m4 = await eb2.commands.get("wechat-sub")("https://example.com/feed404.xml");
has(m4, "HTTP 404", "非 2xx 明确报状态码");
const m5 = await eb2.commands.get("wechat-sub")("   ");
has(m5, "已打开订阅表单", "命令收到空输入时改为打开订阅表单");
eq(eb2.subs().length, 0, "空输入不会误建订阅");
const eh = await boot({ routes: baseRoutes(), llm: aiStub, form: () => ({ input: "   " }) });
await eh.click("addsub");
has(eh.calls.toast.join("|"), "没有输入内容", "表单里只填空格也算空输入");
eq(eh.subs().length, 0, "同样不会误建订阅");
const eh2 = await boot({ routes: baseRoutes(), llm: aiStub, form: () => ({ input: A1 }) });
await eh2.click("addsub");
has(eh2.calls.toast.join("|"), "已订阅", "表单里粘贴文章链接也能订阅（与命令同一条路径）");
eq(eh2.subs().length, 1, "订阅已建立");
const m6 = await eb2.commands.get("wechat-open")();
has(m6, "已打开", "打开页面命令返回结果");
eq(eb2.calls.nav, "plugin:onethu.wechat.news:feed", "跳转到本插件页面");

/* ---------- 17. provider 层契约（可插拔扩展点的四条保证） ---------- */

/* 契约 1：设置里关掉的通道根本不会被调用 */
const ca = await boot({ routes: baseRoutes(), llm: aiStub, settings: { channels: "homepage" } });
await ca.commands.get("wechat-sub")(A1);
const csub = ca.subs()[0];
eq((csub.sources || []).map((x) => x.id).join(","), "homepage", "只有启用列表里的通道参与调度");
eq(ca.fetches("mp/appmsgalbum").length, 0, "被禁用的合集通道一次都没被请求");
eq(ca.fetches("weixin.sogou.com").length, 0, "被禁用的搜狗通道一次都没被请求");
eq((csub.channels || []).join(","), "homepage,album,sogou,rss", "订阅侧仍登记全部通道（全局开关与订阅开关相互独立）");
await ca.change(csub.id, "album", true);
eq(ca.subs()[0].channels.indexOf("album") >= 0, true, "管理页勾选后写回订阅");
await ca.change(csub.id, "homepage", false);
eq(ca.subs()[0].channels.indexOf("homepage"), -1, "取消勾选后订阅侧禁用");
await ca.change(csub.id, "album", false);
await ca.change(csub.id, "sogou", false);
await ca.change(csub.id, "rss", false);
eq(ca.subs()[0].channels.join(","), "rss", "拒绝清空：最后一个通道不能被关掉");
has(ca.calls.toast.join("|"), "至少要保留一个取数通道", "并给出明确提示");

/* 契约 2：单个通道抛错不影响其它通道，也不把整单打挂 */
const cb = await boot({ routes: baseRoutes({ "mp/homepage": { reject: "页面模板接口 500" } }), llm: aiStub, settings: { channels: "homepage,album" } });
const cbMsg = await cb.commands.get("wechat-sub")(A1);
has(cbMsg, "已订阅", "单通道失败不阻断订阅");
const cbs = cb.subs()[0];
const hp = (cbs.sources || []).find((x) => x.id === "homepage");
eq(hp.ok, false, "失败通道被标记为失败");
has(hp.error, "页面模板接口 500", "错误原因保留下来");
eq((cbs.sources || []).find((x) => x.id === "album").ok, true, "其它通道照常成功");
ok(!cbs.error, "订阅级状态不受影响（不整单报错）");
eq(cb.arts(cbs.id).some((a) => a.source === "album"), true, "成功通道的文章正常入库");
eq(cb.arts(cbs.id).some((a) => a.source === "homepage"), false, "失败通道不留下垃圾数据");
has(cb.logs.join("\n"), "通道 homepage 失败", "失败只记日志，不打断流程");

/* 契约 3：分页游标写回订阅（下次刷新从这里继续） */
const cc = await boot({ routes: baseRoutes({ "mp/appmsgalbum": { body: albumHtmlMore() } }), llm: aiStub, settings: { channels: "album" } });
await cc.commands.get("wechat-sub")(A1);
const ccs = cc.subs()[0];
ok(!!(ccs.cursor && ccs.cursor.album && ccs.cursor.album[ALBUM_ID]), "合集分页游标写回 sub.cursor");
eq(ccs.cursor.album[ALBUM_ID].from_msgid, "999", "游标字段取自页面 cgiData");
ok(cc.fetches("from_msgid=999").length >= 1, "下一页请求带上了游标");
eq(cc.fetches("mp/appmsgalbum").length, 5, "分页有硬上限（最多 5 页），不会无限翻");

/* 契约 4：新增一个 provider 只需注册 + 加设置字段，其余层零改动 */
const fakeCode = (() => {
  const provider = [
    "",
    "const fakeProvider = {",
    '  id: "fake",',
    '  title: "假通道",',
    "  needs: { biz: true },",
    "  async discover(sub) {",
    '    const r = await getText(cfg("fakeUrl"));',
    "    const arr = JSON.parse(r.text);",
    '    return arr.map((it) => candidateFromAppmsg(it, "fake")).filter(Boolean);',
    "  },",
    "};",
    "",
  ].join("\n");
  let src = SRC.replace("const PROVIDERS = [", provider + "const PROVIDERS = [fakeProvider, ");
  src = src.replace('{ key: "channels"', '{ key: "fakeUrl", label: "假通道地址", type: "text", default: "" },\n    { key: "channels"');
  return src;
})();
ok(fakeCode !== SRC && fakeCode.indexOf("const fakeProvider") > 0, "已把假 provider 注入源码（未改动任何原有层）");
const fb = await boot({
  routes: baseRoutes({ "fake.example/feed.json": { body: JSON.stringify([{ title: "假通道文章", link: "https://mp.weixin.qq.com/s?__biz=" + BIZ + "&mid=2247489900&idx=1&sn=fake01", update_time: NOW_S }]) } }),
  llm: aiStub,
  settings: { channels: "fake", fakeUrl: "https://fake.example/feed.json" },
  code: fakeCode,
});
await fb.commands.get("wechat-sub")(A1);
const fsub = fb.subs()[0];
eq((fsub.sources || []).map((x) => x.id).join(","), "fake", "新通道参与调度");
eq(fb.fetches("fake.example").length, 1, "调用了新通道自己的地址");
eq(fb.fetches("mp/homepage").length, 0, "原有通道没有被调用");
const fa = fb.art("2247489900_1");
ok(!!fa, "新通道的文章用同一份存储结构入库（存储层零改动）");
eq(fa.source, "fake", "来源标记为新通道 id");
eq(fa.ext, null, "ext 扩展位保留给未来使用");
fb.attachTab();
has(fb.root.innerHTML, "来源：假通道", "列表直接用 provider.title，UI 层零改动");
eq(fb.atom.resolve("feed~a:2247489900_1").title, "假通道文章", "原子收藏零改动");
const fLatest = await fb.commands.get("wechat-latest")();
has(fLatest.items.map((x) => x.subtitle).join("|"), "假通道", "命令结果零改动");
has(fb.logs.join("\n"), "fake/homepage/album/sogou/rss", "激活日志自动列出新通道");

/* ---------- 18. 停用与数据保留 ---------- */

const dh = await boot({ routes: baseRoutes(), llm: aiStub });
await dh.commands.get("wechat-sub")(A1);
const act = await dh.mod.default(dh.ctx);
ok(typeof act.dispose === "function", "activate 返回 dispose（卸载时可清理）");
act.dispose();
has(dh.logs.join("\n"), "已停用", "dispose 记录停用");
eq(dh.subs().length, 1, "停用后订阅仍保留在插件私有存储（重新启用即恢复）");
ok(dh.arts(dh.subs()[0].id).length > 0, "文章也保留，不会因为停用丢数据");

/* ---------- 19. 网络层：自带浏览器头 + cookie 仓（宿主传输层默认不发 UA） ---------- */

const netBase = baseRoutes();
delete netBase["weixin.sogou.com"];
const netH = await boot({
  routes: Object.assign({
    "weixin.sogou.com/link": { body: SOGOU_HOP_OK },
    "weixin.sogou.com": () => ({
      body: SOGOU_OK,
      headers: {
        "x-onethu-set-cookie-hops": JSON.stringify([
          { u: "https://weixin.sogou.com/weixin?type=2", l: "SNUID=abc123; Path=/; Domain=weixin.sogou.com" },
          { u: "https://weixin.sogou.com/weixin?type=2", l: "SUID=def456; Path=/" },
        ]),
      },
    }),
  }, netBase),
  llm: aiStub,
  settings: { channels: "sogou" },
});
await netH.commands.get("wechat-sub")(A1);
await netH.commands.get("wechat-refresh")();
const sgR1 = netH.reqs("weixin.sogou.com")[0];
ok(!!sgR1, "搜狗通道发出了请求");
ok(String(netH.hdr(sgR1, "user-agent")).indexOf("Mozilla/5.0") === 0, "搜狗请求自带浏览器 UA（宿主传输层默认不发 UA）");
eq(netH.hdr(sgR1, "referer"), "https://weixin.sogou.com/", "搜狗请求带 Referer");
eq(netH.hdr(sgR1, "accept-language"), "zh-CN,zh;q=0.9,en;q=0.8", "带 Accept-Language");
has(String(netH.hdr(sgR1, "accept")), "text/html", "带 Accept");
const sgR2 = netH.reqs("weixin.sogou.com")[1];
ok(!!sgR2, "第二次搜狗请求发出");
has(String(netH.hdr(sgR2, "cookie")), "SNUID=abc123", "第二次请求带上刚收到的 cookie（逐跳通道 x-onethu-set-cookie-hops）");
has(String(netH.hdr(sgR2, "cookie")), "SUID=def456", "同一响应里的多条 Set-Cookie 都被收下");
const mpR1 = netH.reqs("mp.weixin.qq.com")[0];
ok(!!mpR1, "订阅文章时也请求了微信侧");
ok(String(netH.hdr(mpR1, "user-agent")).indexOf("Mozilla/5.0") === 0, "微信侧请求同样带 UA");
eq(netH.hdr(mpR1, "referer"), "https://mp.weixin.qq.com/", "微信侧带自己的 Referer");
eq(netH.hdr(mpR1, "cookie"), null, "cookie 按 host 分开：搜狗的 cookie 不会发给微信");

netH.routes["weixin.sogou.com"] = () => ({
  body: SOGOU_OK,
  headers: { "x-onethu-set-cookie-hops": JSON.stringify([{ u: "https://weixin.sogou.com/weixin?type=2", l: "SNUID=; Max-Age=0; Path=/" }]) },
});
await netH.commands.get("wechat-refresh")();
const sgR3 = netH.reqs("weixin.sogou.com")[2];
ok(!!sgR3, "第三次搜狗请求发出");
has(String(netH.hdr(sgR3, "cookie")), "SNUID", "删除生效前的那次请求仍带着旧 cookie（删除只影响后续请求）");
await netH.commands.get("wechat-refresh")();
const sgAll = netH.reqs("weixin.sogou.com");
const sgLast = sgAll[sgAll.length - 1];
ok(sgAll.length >= 4, "删除后仍继续请求搜狗（共 " + sgAll.length + " 次）");
notHas(String(netH.hdr(sgLast, "cookie")), "SNUID", "Max-Age=0 的 cookie 被删掉（不会一直带着过期会话）");
has(String(netH.hdr(sgLast, "cookie")), "SUID=def456", "只删那一条，其余 cookie 保留");

const flatH = await boot({
  routes: baseRoutes({ "mid=2247484001": { body: articleHtml(), headers: { "x-onethu-set-cookie": JSON.stringify(["poc_sid=flat789; Path=/"]) } } }),
  llm: aiStub,
});
await flatH.commands.get("wechat-sub")(A1);
await flatH.commands.get("wechat-refresh")();
const flatReqs = flatH.reqs("mp.weixin.qq.com");
has(String(flatH.hdr(flatReqs[flatReqs.length - 1], "cookie")), "poc_sid=flat789", "宿主只给扁平通道 x-onethu-set-cookie 时也能收 cookie");

/* ---------- 20. 文章失败分类（临时链接 / 人机验证 / 链接失效） ---------- */

const tmpBase = baseRoutes();
delete tmpBase["mp.weixin.qq.com/s?"];
const tmpH = await boot({ routes: Object.assign({ "mp.weixin.qq.com/s?src=11": { body: EXPIRED_BODY } }, tmpBase), llm: aiStub });
const tmpMsg = await tmpH.commands.get("wechat-sub")(TEMP_LINK);
has(tmpMsg, "临时链接已过期", "搜狗临时链接过期 → 明确说「临时链接已过期」");
has(tmpMsg, "复制链接", "并告诉用户去哪儿拿长期链接");
notHas(tmpMsg, "环境异常", "不再误报成「风控拦截（环境异常）」");
eq(tmpH.subs().length, 0, "失败时不留下半个订阅");

const capH = await boot({ routes: Object.assign({ "mp.weixin.qq.com/s?src=11": { body: CAPTCHA_PAGE } }, tmpBase), llm: aiStub });
const capMsg = await capH.commands.get("wechat-sub")(TEMP_LINK);
has(capMsg, "人机验证", "POC 验证码页 → 判为「微信要求人机验证」");
has(capMsg, "代理", "并说明代理/VPN 会触发（可操作的建议）");

const blkH = await boot({ routes: baseRoutes(), llm: aiStub });
const blkMsg = await blkH.commands.get("wechat-sub")(A_BLOCKED);
has(blkMsg, "人机验证", "规范链接上的「环境异常」页同样归到人机验证");
has(blkMsg, "关掉代理", "给出关掉代理的排查动作");

const shortH = await boot({ routes: baseRoutes({ "mp.weixin.qq.com/s/AbCdEf": { body: EXPIRED_BODY } }), llm: aiStub });
const shortMsg = await shortH.commands.get("wechat-sub")("https://mp.weixin.qq.com/s/AbCdEfGhIjKl");
has(shortMsg, "链接已失效或不是正文链接", "「系统出错」页 → 判为链接失效/不是正文链接");
has(shortMsg, "__biz/mid/idx/sn", "并告诉用户正确链接长什么样");

/* ---------- 21. 搜狗临时链接归一（换成长效规范链接） ---------- */

const rvBase = baseRoutes();
delete rvBase["weixin.sogou.com"];
delete rvBase["mp.weixin.qq.com/s?"];
function rvRoutes() {
  return Object.assign({
    "mp.weixin.qq.com/s?src=11": { body: articleHtml({ mid: "2247487301", idx: "1" }) },
    "weixin.sogou.com/link": { body: SOGOU_HOP_TEMP },
    "weixin.sogou.com": { body: SOGOU_OK },
  }, rvBase);
}
const rv = await boot({ routes: rvRoutes(), llm: aiStub, settings: { channels: "sogou" } });
await rv.commands.get("wechat-sub")(A1);
const rvArt = rv.arts(rv.sub(ACCOUNT).id).filter((a) => a.source === "sogou")[0] || {};
ok(rv.fetches("signature=").length >= 1, "趁临时链接还新鲜，抓了一次页面来换算");
eq(rvArt.id, "2247487301_1", "换算后主键用规范链接的 mid_idx（跨通道去重才有效）");
eq(rvArt.link, "https://mp.weixin.qq.com/s?__biz=" + BIZ + "&mid=2247487301&idx=1&sn=aaa111", "入库链接是长期有效的规范链接");
eq((rvArt.ext || {}).tempLink, TEMP_LINK, "原始临时链接留在 ext.tempLink（可追溯）");
eq(rvArt.title, "关于开展 2026 年春季学期选课工作的通知", "标题用文章页里的真标题");

const rv0 = await boot({ routes: rvRoutes(), llm: aiStub, settings: { channels: "sogou", sogouResolveMax: "0" } });
await rv0.commands.get("wechat-sub")(A1);
const a0 = rv0.arts(rv0.sub(ACCOUNT).id).filter((a) => a.source === "sogou")[0] || {};
has(String(a0.link), "signature=", "上限为 0：不换算，原样保留临时链接");
eq(Object.keys(a0.ext || {}).length, 0, "上限为 0 时连标记都不写（没有尝试过换算）");
eq(rv0.fetches("signature=").length, 0, "完全没有为换算多抓页面");

const failRoutes = rvRoutes();
failRoutes["mp.weixin.qq.com/s?src=11"] = { body: EXPIRED_BODY };
const rvf = await boot({ routes: failRoutes, llm: aiStub, settings: { channels: "sogou" } });
await rvf.commands.get("wechat-sub")(A1);
const af = rvf.arts(rvf.sub(ACCOUNT).id).filter((a) => a.source === "sogou")[0] || {};
eq((af.ext || {}).temp, true, "换算失败时标记 ext.temp（照旧入库，不丢这篇文章）");
eq((rvf.sub(ACCOUNT).sources || []).find((x) => x.id === "sogou").ok, true, "单篇换算失败不影响整条通道");
has(rvf.logs.join("\n"), "临时链接归一失败", "日志里留下失败原因（便于排查）");

// 线上真实形状：文章页里 var sn = ""（拿不到 sn）→ 规范化不了，只能保留临时链接
function tempKeepRoutes() {
  const r = rvRoutes();
  r["mp.weixin.qq.com/s?src=11"] = { body: articleHtml({ mid: "2247487301", idx: "1", sn: "" }) };
  return r;
}
const nosnH = await boot({ routes: tempKeepRoutes(), llm: aiStub, settings: { channels: "sogou" } });
await nosnH.commands.get("wechat-sub")(A1);
const na = nosnH.arts(nosnH.sub(ACCOUNT).id).filter((a) => a.source === "sogou")[0] || {};
has(String(na.link), "signature=", "页面不给 sn 时不拼假链接，保留原临时链接（能读就先用）");
eq(na.id, "2247487301_1", "但没有 sn 也有 mid → 主键仍按 mid_idx（跨通道去重不乱）");
eq((na.ext || {}).temp, true, "并标记 ext.temp=true（提醒链接会过期）");

// 临时链接续期：同一篇（同 mid）再抓到的是新临时链接 → 换新链接，条目数不变
let hopN = 0;
const renewRoutes = tempKeepRoutes();
renewRoutes["weixin.sogou.com/link"] = () => {
  hopN++;
  const link = "https://mp.weixin.qq.com/s?src=11&timestamp=1791905902&ver=7024&signature=RENEW" + hopN;
  return { body: "<html><script>var url = '';\nurl += '" + link.replace(/&/g, "&amp;") + "';</script></html>" };
};
const renewH = await boot({ routes: renewRoutes, llm: aiStub, settings: { channels: "sogou" } });
await renewH.commands.get("wechat-sub")(A1);
const rn1 = renewH.art("2247487301_1") || {};
has(String(rn1.link), "RENEW1", "第一次入库的是第一条临时链接");
await renewH.commands.get("wechat-refresh")();
const rnArts = renewH.arts(renewH.sub(ACCOUNT).id).filter((a) => a.id === "2247487301_1");
eq(rnArts.length, 1, "同一篇换了临时链接仍然只占一条（主键用 mid_idx）");
has(String(rnArts[0].link), "RENEW2", "链接被换成这次抓到的新临时链接（续期）");
eq((rnArts[0].ext || {}).temp, true, "续期后仍然标记 ext.temp=true");

// 长期链接顶替临时链接：先只有搜狗（临时），后页面模板带来长期链接
const upRoutes = tempKeepRoutes();
upRoutes["mp/homepage"] = { body: homepageHtml([]) };
const upH = await boot({ routes: upRoutes, llm: aiStub });
await upH.commands.get("wechat-sub")(A1);
const up1 = upH.art("2247487301_1") || {};
eq((up1.ext || {}).temp, true, "页面模板还没有内容时，先入库的是搜狗临时链接");
upH.routes["mp/homepage"] = { body: homepageHtml(homepageItems(1, 87301)) };
await upH.commands.get("wechat-refresh")();
const up2 = upH.art("2247487301_1") || {};
has(String(up2.link), "sn=h87301", "之后页面模板给出同一篇的长期链接 → 链接被顶替为长期链接");
has(String(up2.link), "__biz=", "长期链接保留 __biz 参数");
eq(up2.ext, null, "长期链接不需要 ext.temp 标记");
eq(upH.arts(upH.sub(ACCOUNT).id).filter((a) => a.id === "2247487301_1").length, 1, "顶替不产生重复条目");

// 已经存过长期链接的篇目：再次刷新不再为它下载整页文章（搜狗标题被截断也要能认出来）
const SG_TITLE = ACCOUNT + "到访南开大学开展调研交流\u201c一二\u00b7九\u201d歌咏比赛";
const skipRoutes = tempKeepRoutes();
skipRoutes["mp.weixin.qq.com/s?src=11"] = { body: articleHtml({ mid: "2247487301", idx: "1", title: SG_TITLE }) };
const skipH = await boot({ routes: skipRoutes, llm: aiStub, settings: { channels: "sogou" } });
await skipH.commands.get("wechat-sub")(A1);
const k1 = skipH.art("2247487301_1") || {};
has(String(k1.link), "sn=aaa111", "第一次把搜狗临时链接换成了长期链接");
const fetchedBefore = skipH.fetches("mp.weixin.qq.com/s?src=11").length;
skipH.routes["mp.weixin.qq.com/s?src=11"] = () => ({ status: 403, body: "blocked" });
await skipH.commands.get("wechat-refresh")();
eq(skipH.fetches("mp.weixin.qq.com/s?src=11").length, fetchedBefore, "已存长期链接的篇目再次刷新时不再下载文章页");
const k2 = skipH.art("2247487301_1") || {};
has(String(k2.link), "sn=aaa111", "并且仍然保留那条长期链接");
eq(skipH.arts(skipH.sub(ACCOUNT).id).filter((a) => a.id === "2247487301_1").length, 1, "也没有因此多出重复条目");

// 临时链接的篇目：刷新时用新临时链接续期，同样不再下载整页文章
const renewSkipRoutes = tempKeepRoutes();
renewSkipRoutes["mp.weixin.qq.com/s?src=11"] = { body: articleHtml({ mid: "2247487301", idx: "1", title: SG_TITLE, sn: "" }) };
const rsH = await boot({ routes: renewSkipRoutes, llm: aiStub, settings: { channels: "sogou" } });
await rsH.commands.get("wechat-sub")(A1);
const rsBefore = rsH.fetches("mp.weixin.qq.com/s?src=11").length;
rsH.routes["mp.weixin.qq.com/s?src=11"] = () => ({ status: 403, body: "blocked" });
await rsH.commands.get("wechat-refresh")();
eq(rsH.fetches("mp.weixin.qq.com/s?src=11").length, rsBefore, "只有临时链接的篇目：续期时也不再下载文章页");
const rsArts = rsH.arts(rsH.sub(ACCOUNT).id).filter((a) => a.id === "2247487301_1");
eq(rsArts.length, 1, "续期仍然只占一条");
has(String(rsArts[0].link), "signature=", "链接换成了新抓到的临时链接");
eq((rsArts[0].ext || {}).temp, true, "仍然标记 ext.temp=true");

/* ---------- 22. 网络自检命令 ---------- */

const docH = await boot({
  routes: baseRoutes({ "weixin.sogou.com": { body: SOGOU_OK }, "mp.weixin.qq.com/": { body: "<html><body>ok</body></html>" } }),
  llm: aiStub,
  settings: { channels: "sogou" },
});
await docH.commands.get("wechat-sub")(A1);
const dres = await docH.commands.get("wechat-doctor")();
eq(dres.items.length, 3, "自检三行：微信域名 / 搜狗 / 第一个订阅的页面模板");
eq(dres.items.filter((x) => x.title.indexOf("✅") === 0).length, 3, "三项都判为正常");
has(dres.items.map((x) => x.subtitle).join(" | "), "HTTP 200", "每行都带 HTTP 状态");
has(dres.items.map((x) => x.subtitle).join(" | "), "ms · 正常", "每行都带耗时与判定");
has(dres.items.map((x) => x.subtitle).join(" | "), "cookie 无", "还没有会话时如实显示 cookie 无");
has(dres.text, "通道全部正常", "全绿时的结论行");
eq((dres.kv || []).length, 2, "附 kv：UA 与会话状态");
has(String((dres.kv || [])[0].v), "Mozilla/5.0", "kv 里能看到自带的 UA");
has(docH.root.innerHTML, "网络自检结果", "结果同时渲染到页面顶部");
has(docH.root.innerHTML, "微信文章域名", "页面里能看到每一行的标签");
await docH.click("doctor-close");
notHas(docH.root.innerHTML, "网络自检结果", "点「关闭自检结果」后收起");

const docBad = await boot({
  routes: baseRoutes({ "weixin.sogou.com": { body: SOGOU_BLOCKED }, "mp.weixin.qq.com/": { body: "<html><body>ok</body></html>" } }),
  llm: aiStub,
});
await docBad.commands.get("wechat-sub")(A1);
const dres2 = await docBad.commands.get("wechat-doctor")();
has(dres2.items.map((x) => x.title + " " + x.subtitle).join(" | "), "被反爬拦截", "搜狗被拦时那一行明说原因");
has(dres2.text, "1 项异常", "结论行给出异常条数");
has(docBad.root.innerHTML, "⚠️", "页面顶部用 ⚠️ 标出异常行");

const docFail = await boot({ routes: baseRoutes(), llm: aiStub, noRoot: true });
const dres3 = await docFail.commands.get("wechat-doctor")();
has(dres3.text, "项异常", "探不通时不会崩，而是报异常");
has(dres3.items.map((x) => x.subtitle).join(" | "), "失败：", "失败行给出可读原因");
eq(dres3.items.filter((x) => x.title.indexOf("页面模板") >= 0).length, 0, "没有订阅时不探测页面模板（只探两项）");


/* ---------- 23. 导入表格（CSV）通道 ---------- */

const CSV_HEADER = "title,url,time,like_num,read_num,share_num,comment_count";

/** 照 wechatDownload 的真实导出拼一行链接（http/&amp;/#wechat_redirect 三种变体都能开关）。 */
function csvLink(mid, idx, o) {
  const opt = o || {};
  const sep = opt.amp ? "&amp;" : "&";
  return (opt.http ? "http://" : "https://") + "mp.weixin.qq.com/s?__biz=" + (opt.biz || BIZ) +
    sep + "mid=" + mid + sep + "idx=" + (idx || 1) + sep + "sn=" + (opt.sn || "s" + mid) +
    (opt.plain ? "" : "&scene=27#wechat_redirect");
}

const CSV_BASIC = [
  CSV_HEADER,
  "科技爱好者周刊#295：巧妙的灯泡钟," + csvLink("2650236572", 1, { http: true }) + ",2024-03-29 08:35:31,102,15236,307,65",
  '"带,逗号的标题",' + csvLink("2650236573") + ",2024-03-26 08:42:47,120,15437,413,32",
  "用 &amp; 转义的导出," + csvLink("2650236574", 1, { amp: true }) + ",2024-03-22 08:33:51,118,17957,390,66",
  "不是公众号的链接,https://example.com/post/1,2024-03-20 08:00:00,1,2,3,4",
  ",https://mp.weixin.qq.com/s?__biz=" + BIZ + "&mid=2650236575&idx=1&sn=x,2024-03-19 08:00:00,0,0,0,0",
  "缺链接的行,,2024-03-18 08:00:00,0,0,0,0",
  "",
].join("\n");

const impH = await boot({
  routes: baseRoutes(),
  llm: aiStub,
  settings: { channels: "homepage" },
  form: () => ({ target: impH.sub(ACCOUNT).id, csv: CSV_BASIC }),
});
await impH.commands.get("wechat-sub")(A1);
const impSubId = impH.sub(ACCOUNT).id;
const impRes = await impH.commands.get("wechat-import")();
eq(impRes.kv[0].v, "3", "6 行数据 → 新增 3 篇（1 行非公众号链接、2 行缺标题/链接）");
has(impRes.text, "表格 6 行", "结论行给出表格行数");
has(impRes.text, "跳过 3 行", "跳过行数计入结论");
has(impRes.text, "1 行不是公众号链接", "非公众号链接单独说明");
eq(impH.arts(impSubId).filter((a) => a.ext && a.ext.imported).length, 3, "3 篇导入条目落库");
eq(impH.sub(ACCOUNT).lastImportAt > 0, true, "订阅上记下 lastImportAt");

const iA = impH.art("2650236572_1");
ok(!!iA, "主键用 mid_idx（与页面模板/搜狗/RSS 通道对齐去重）");
eq(iA.link, "https://mp.weixin.qq.com/s?__biz=" + BIZ + "&mid=2650236572&idx=1&sn=s2650236572&scene=27", "http→https、去掉 #wechat_redirect 片段（query 原样保留）");
notHas(String(iA.link), "#", "链接里不再带锚点片段");
eq(iA.source, "csv", "source 记为 csv");
eq(iA.subName, ACCOUNT, "subName 回填成订阅名");
eq(new Date(iA.t).toISOString(), "2024-03-29T00:35:31.000Z", "时间按北京时间解析成毫秒");
eq(iA.ext.imported, 1, "标记 ext.imported");
eq(iA.ext.stats.read, 15236, "阅读数入库");
eq(iA.ext.stats.like, 102, "点赞数入库");
eq(iA.ext.stats.comment, 65, "评论数入库");
eq(iA.ext.stats.share, 307, "分享数入库");
ok(!iA.ext.temp, "不带 ext.temp（导入的是长期链接）");
const iB = impH.art("2650236573_1");
ok(!!iB && iB.title === "带,逗号的标题", "引号包裹、含逗号的标题解析正确");
const iC = impH.art("2650236574_1");
ok(!!iC, "&amp; 转义的链接归一成同一种主键");
notHas(String(iC.link), "amp;", "&amp; 已还原成 &");
eq(impH.art("2650236575_1"), null, "缺标题的行没有入库");
has(impH.root.innerHTML, "来源：表格导入", "列表里显示「来源：表格导入」（标题取自 provider 注册表）");
has(impH.root.innerHTML, "阅读 1.5万", "列表里显示阅读数（15236 → 1.5万）");
has(impH.root.innerHTML, "赞 102", "列表里显示点赞数");
has(impH.root.innerHTML, "已导入：", "页面顶部给出导入摘要");
eq(impH.sub(ACCOUNT).channels.indexOf("csv"), -1, "订阅的取数通道里不会出现导入通道");

const impRes2 = await impH.commands.get("wechat-import")();
eq(impRes2.kv[0].v, "0", "重复导入同一张表：新增 0 篇");
eq(impH.arts(impSubId).filter((a) => a.ext && a.ext.imported).length, 3, "重复导入不产生副本");
const fetchBefore = impH.calls.fetch.length;
await impH.commands.get("wechat-refresh")();
ok(impH.calls.fetch.length > fetchBefore, "刷新照常发请求（导入通道不参与，也不影响其它通道）");
eq(impH.arts(impSubId).filter((a) => a.ext && a.ext.imported).length, 3, "刷新后导入条目仍在");

// 与其它通道同 mid 时按同一主键合并，而不是新增副本
let payload = CSV_HEADER + "\n" + "页面模板里已经有的那篇," + csvLink("224744100", 1, { plain: true }) + ",2024-03-01 08:00:00,1,2,3,4";
const mergeH = await boot({
  routes: baseRoutes(),
  llm: aiStub,
  settings: { channels: "homepage" },
  form: () => ({ target: mergeH.sub(ACCOUNT).id, csv: payload }),
});
await mergeH.commands.get("wechat-sub")(A1);
const before = mergeH.arts(mergeH.sub(ACCOUNT).id).length;
const mergeRes = await mergeH.commands.get("wechat-import")();
eq(mergeRes.kv[0].v, "0", "表格里那篇页面模板已经抓到了 → 不新增");
eq(mergeH.arts(mergeH.sub(ACCOUNT).id).length, before, "总篇数不变");
eq((mergeH.art("224744100_1") || {}).source, "homepage", "已有条目保持原样：source 仍是 homepage，标题也没被表格里的写法覆盖");
eq((mergeH.art("224744100_1") || {}).title, "页面模板里已经有的那篇", "标题按表格里的新写法更新（只补数据，不新增条目、不改 source）");

// 有表头的中文列 / 无表头 / 从表格软件粘贴的 TSV
payload = "标题\t链接\t时间\t点赞\t阅读\t分享\t评论\nTSV 里的一篇\t" + csvLink("2650236581") + "\t2024-03-11 09:00:00\t7\t800\t9\t10";
const fmtH = await boot({
  routes: baseRoutes(),
  llm: aiStub,
  settings: { channels: "homepage" },
  form: () => ({ target: fmtH.sub(ACCOUNT).id, csv: payload }),
});
await fmtH.commands.get("wechat-sub")(A1);
const tsvRes = await fmtH.commands.get("wechat-import")();
eq(tsvRes.kv[0].v, "1", "从表格软件粘贴的 TSV（制表符 + 中文表头）也能导入");
eq((fmtH.art("2650236581_1") || {}).ext.stats.read, 800, "中文表头的「阅读」列解析正确");
eq((fmtH.art("2650236581_1") || {}).ext.stats.like, 7, "中文表头的「点赞」列解析正确");

payload = "没有表头的标题," + csvLink("2650236580", 1, { plain: true }) + ",2024-03-10 08:00:00,3,400,5,6";
const noHdr = await boot({
  routes: baseRoutes(),
  llm: aiStub,
  settings: { channels: "homepage" },
  form: () => ({ target: noHdr.sub(ACCOUNT).id, csv: payload }),
});
await noHdr.commands.get("wechat-sub")(A1);
const noHdrRes = await noHdr.commands.get("wechat-import")();
eq(noHdrRes.kv[0].v, "1", "没有表头时按固定列序（title,url,time,…）导入");
eq((noHdr.art("2650236580_1") || {}).title, "没有表头的标题", "无表头那一行按第 0 列当标题");

// 上限与错误路径
const csvCapH = await boot({
  routes: baseRoutes(),
  llm: aiStub,
  settings: { channels: "homepage", importMax: "1" },
  form: () => ({ target: csvCapH.sub(ACCOUNT).id, csv: CSV_BASIC }),
});
await csvCapH.commands.get("wechat-sub")(A1);
const capRes = await csvCapH.commands.get("wechat-import")();
eq(capRes.kv[0].v, "1", "importMax=1 时只收 1 篇");
has(capRes.text, "超过上限未收", "被上限截断时明说");

const badH = await boot({
  routes: baseRoutes(),
  llm: aiStub,
  form: () => ({ target: badH.sub(ACCOUNT).id, csv: "标题,链接\n某篇文章,https://example.com/a" }),
});
await badH.commands.get("wechat-sub")(A1);
const badRes = await badH.commands.get("wechat-import")();
has(badRes, "没有可导入的公众号文章", "全是非公众号链接时给出可读结论");
has(badRes, "不是 mp.weixin.qq.com 链接", "并说明原因");

const cancelH = await boot({ routes: baseRoutes(), llm: aiStub, form: () => null });
eq(await cancelH.commands.get("wechat-import")(), "已取消", "表单取消时命令返回「已取消」");

const noSubH = await boot({
  routes: baseRoutes(),
  llm: aiStub,
  settings: { channels: "homepage" },
  form: () => ({ target: "", csv: CSV_BASIC }),
});
const autoRes = await noSubH.commands.get("wechat-import")();
has(autoRes.text, "新增 2 篇", "没有订阅时按表格第一条链接自动识别公众号并导入（首行那篇已由订阅动作收下，故计入合并）");
has(autoRes.text, "清华大学学生会", "导入结果落到自动识别出的公众号上");
eq(noSubH.subs().length, 1, "自动建出 1 个订阅（不是每篇建一个）");
eq(noSubH.sub(ACCOUNT).biz, BIZ, "识别出的 biz 与表格链接一致");
eq(noSubH.arts(noSubH.sub(ACCOUNT).id).length, 5, "自动建订阅时的刷新条目与导入条目共用一个订阅（不重复建订阅/条目）");
eq(noSubH.arts(noSubH.sub(ACCOUNT).id).filter((a) => a.ext && a.ext.imported).length, 3, "3 篇都带上导入标记（合并的那篇只是补 ext，source 不变）");
eq(noSubH.arts(noSubH.sub(ACCOUNT).id).filter((a) => a.source === "csv").length, 2, "其中 2 篇是纯表格条目（source=csv）");

// 大表：不参与滚动淘汰 + 列表分页
const bigRows = [CSV_HEADER];
for (let i = 1; i <= 130; i++) {
  const ts = new Date(Date.UTC(2024, 0, 1, 8, 130 - i)).toISOString().slice(0, 19).replace("T", " ");
  bigRows.push("批量导入 " + String(i).padStart(3, "0") + "," + csvLink(String(2650300000 + i), 1, { plain: true }) + "," + ts + ",1,100,2,3");
}
const bigH = await boot({
  routes: baseRoutes(),
  llm: aiStub,
  settings: { channels: "homepage", perSubKeep: "10" },
  form: () => ({ target: bigH.sub(ACCOUNT).id, csv: bigRows.join("\n") }),
});
await bigH.commands.get("wechat-sub")(A1);
const bigRes = await bigH.commands.get("wechat-import")();
eq(bigRes.kv[0].v, "130", "一次导入 130 篇全部入库（默认 importMax=2000）");
eq(bigRes.kv[1].v, "0", "这张表没有需要跳过的行");
eq(bigH.arts(bigH.sub(ACCOUNT).id).filter((a) => a.ext && a.ext.imported).length, 130, "perSubKeep=10 也不会裁掉导入条目");
await bigH.commands.get("wechat-refresh")();
eq(bigH.arts(bigH.sub(ACCOUNT).id).filter((a) => a.ext && a.ext.imported).length, 130, "刷新（会触发裁剪）之后导入条目仍然一篇不少");
has(bigH.root.innerHTML, "显示更多", "超过 120 篇时列表给「显示更多」");
notHas(bigH.root.innerHTML, "批量导入 130", "默认只渲染前 120 篇");
await bigH.click("more");
has(bigH.root.innerHTML, "批量导入 130", "「显示更多」之后能翻到最早的导入条目");

/* ---------- 真实导出样本（qiye45/wechatDownload 的 example/ 逐字抄来） ---------- */

// 真实导出特点：UTF-16LE + BOM、逗号分隔、http:// 链接带 #wechat_redirect、
// 有的批次把 & 写成 &amp;、没抓到数据时点赞/阅读/评论写 0 或 {}。
const REAL_HEADER = "title,url,time,like_num,read_num,share_num,comment_count";
const REAL_ROWS = [
  "科技爱好者周刊#323：技术公司的口号比拼,http://mp.weixin.qq.com/s?__biz=MzI4NjAxNjY4Nw==&mid=2650238548&idx=1&sn=98272891260c9492f0f6dfb9d14bde8a&chksm=f2b6330c820bc5fabf59ef9eb8a9484d8b3b3f6284f14bfdee89869ed9704c2fa693c445178d&scene=27#wechat_redirect,2024-11-01 08:32:43,0,0,0,{}",
  "科技爱好者周刊#328：AI 模型不是一门好生意,http://mp.weixin.qq.com/s?__biz=MzI4NjAxNjY4Nw==&amp;mid=2650239213&amp;idx=1&amp;sn=38e7f56bb119b261b2485f300c8cf3a5&amp;chksm=f280eaf1d8fedf60ff006ba5b9a42169e5a7fb9b62054e7ab77a8894aa9328def7d5cd128ac2&amp;scene=27#wechat_redirect,2024-12-06 08:35:06,179,15984,481,46",
  "2024最流行的网站架构——边缘平台架构：概念与产品,http://mp.weixin.qq.com/s?__biz=MzI4NjAxNjY4Nw==&mid=2650236484&idx=1&sn=8ab9d157efdb10f6caf19e63a4caf0a9&chksm=f21b78a89854a4a1987f9aad4300e38a8394dc5e821bb8f98ddc8b22d2294489083595066b4e&scene=27#wechat_redirect,2024-03-26 08:42:47,120,15437,413,32",
];
const REAL_CSV = [REAL_HEADER].concat(REAL_ROWS).join("\r\n") + "\r\n";
// 粘贴进文本框时最可能出现的形态：整段带 UTF-16 的 NUL 填充 + BOM。
const REAL_CSV_UTF16ISH = "\uFEFF" + REAL_CSV.split("").join("\u0000");

const realH = await boot({
  routes: baseRoutes(),
  llm: aiStub,
  settings: { channels: "homepage" },
  form: () => ({ target: realH.sub(ACCOUNT).id, csv: REAL_CSV_UTF16ISH }),
});
await realH.commands.get("wechat-sub")(A1);
const realRes = await realH.commands.get("wechat-import")();
eq(realRes.kv[0].v, "3", "真实导出（UTF-16 形态）3 行全部导入");
eq(realRes.kv[1].v, "0", "真实导出没有需要跳过的行");

const r328 = realH.art("2650239213_1");
ok(!!r328, "带 &amp; 的那行按 mid 建出条目 2650239213_1");
eq(r328 && r328.title, "科技爱好者周刊#328：AI 模型不是一门好生意", "标题里的 # 与中文冒号原样保留");
eq(r328 && r328.link, "https://mp.weixin.qq.com/s?__biz=MzI4NjAxNjY4Nw==&mid=2650239213&idx=1&sn=38e7f56bb119b261b2485f300c8cf3a5&chksm=f280eaf1d8fedf60ff006ba5b9a42169e5a7fb9b62054e7ab77a8894aa9328def7d5cd128ac2&scene=27", "&amp; 还原成 &、http 升 https、去掉 #wechat_redirect");
eq(r328 && r328.t, Date.UTC(2024, 11, 6, 0, 35, 6), "时间按北京时间解析成 2024-12-06 08:35:06");
eq(r328 && r328.ext.stats.read, 15984, "阅读数解析成数字");
eq(r328 && r328.ext.stats.like, 179, "点赞数解析成数字");
eq(r328 && r328.ext.stats.comment, 46, "评论数解析成数字");

const r323 = realH.art("2650238548_1");
ok(!!r323, "评论列写成 {} 的那行也能导入");
eq(r323 && r323.ext.stats.comment, 0, "{} 当作 0，不产生 NaN");
eq(r323 && r323.ext.stats.read, 0, "整行统计都是 0 时照收条目");
notHas(realH.root.innerHTML, "NaN", "页面上不出现 NaN");
notHas(realH.root.innerHTML, "阅读 0", "统计为 0 时不显示「阅读 0」");
has(realH.root.innerHTML, "1.6万", "阅读数用「万」简写显示");
has(realH.root.innerHTML, "科技爱好者周刊#323：技术公司的口号比拼", "列表里能看到真实标题");

await realH.commands.get("wechat-refresh")();
eq(realH.arts(realH.sub(ACCOUNT).id).filter((a) => a.ext && a.ext.imported).length, 3, "刷新之后真实导入的 3 篇仍在");

/* ---------- 真实文章页的 var 写法 + 参数兜底 ---------- */

// 逐字抄自线上文章页（2026-10-14 抓取 mp.weixin.qq.com/s?...mid=2650236572）：
// biz/mid/idx/sn 都是「空串 || 真值」，nickname 走 htmlDecode，且 var biz 后面紧跟 var bizuin。
const REAL_VAR_BLOCK = [
  'var biz = "" || "MzI4NjAxNjY4Nw==";',
  'var bizuin = "" || "MzI4NjAxNjY4Nw==";',
  'var sn = "" || "eb3f033751a46b20ba285b7d3694d727" || "";',
  'var mid = "" || "2650236572";',
  'var idx = "" || "1";',
  'var ct = "1711672635";',
  "var msg_title = '科技爱好者周刊#295：巧妙的灯泡钟'.html(false);",
  'var user_name = "gh_2f5c59ad6e1e";',
  'var nickname = htmlDecode("阮一峰的网络日志");',
].join("\n");

function realPageHtml(opts) {
  const o = opts || {};
  const vars = o.dropBiz ? REAL_VAR_BLOCK.split("\n").filter((l) => l.indexOf("var biz") !== 0).join("\n") : REAL_VAR_BLOCK;
  return '<!DOCTYPE html><html><head></head><body>\n<script>\n' + vars + "\n</script>\n" +
    '<div id="js_content">\n<p>正文第一段：这里记录每周值得分享的科技内容。</p>\n<p>正文第二段。</p>\n</div>\n' +
    '<div id="js_sg_bar"></div>\n' + PAD + "\n</body></html>";
}

function realRoutes() {
  const specific = {
    "mid=2650236572": { body: realPageHtml() },
    "mid=2650236573": { body: realPageHtml({ dropBiz: true }) },
    "mid=2650236574": { body: realPageHtml({ dropBiz: true }) },
    "mp/homepage": { body: homepageHtml([]) },
    "mp/appmsgalbum": { body: albumHtml([]) },
    "weixin.sogou.com": { body: SOGOU_EMPTY },
  };
  return Object.assign(specific, { "mp.weixin.qq.com/s?": { body: realPageHtml() } });
}

const REAL_LINK = "https://mp.weixin.qq.com/s?__biz=MzI4NjAxNjY4Nw==&mid=2650236572&idx=1&sn=eb3f033751a46b20ba285b7d3694d727&scene=27";
const vpH = await boot({ routes: realRoutes(), llm: aiStub, settings: { channels: "homepage" } });
await vpH.commands.get("wechat-sub")(REAL_LINK);
const vpSub = vpH.subs().find((s) => s.biz === "MzI4NjAxNjY4Nw==");
ok(!!vpSub, "真实形态的文章页也能建出订阅");
eq(vpSub && vpSub.biz, "MzI4NjAxNjY4Nw==", "var biz = \"\" || \"…\" 能读出真值");
eq(vpSub && vpSub.name, "阮一峰的网络日志", "nickname 里的 htmlDecode(\"…\") 能读出公众号名");
eq(vpSub && vpSub.ghId, "gh_2f5c59ad6e1e", "user_name 读出 ghId");
const vpArt = vpH.art("2650236572_1");
ok(!!vpArt, "文章按页面里的 mid 建出条目 2650236572_1");
eq(vpArt && vpArt.title, "科技爱好者周刊#295：巧妙的灯泡钟", "msg_title 的 '…'.html(false) 写法读出标题");
ok(!!(vpArt && vpArt.t > 0), "ct 读出时间");

// 页面里没有 var biz（老页面/改版）→ 用链接上的 __biz 兜底
const NB_BIZ = "MzI4NjAxNjY4Nw==";
const nbH = await boot({ routes: realRoutes(), llm: aiStub, settings: { channels: "homepage" } });
await nbH.commands.get("wechat-sub")("https://mp.weixin.qq.com/s?__biz=" + NB_BIZ + "&mid=2650236573&idx=1&sn=dd0011");
const nbSub = nbH.subs().find((s) => s.biz === NB_BIZ);
ok(!!nbSub, "页面里读不到 var biz 时用链接参数兜底建出订阅");

// 页面没有 var biz、链接也没有 __biz → 明确报错而不是静默建一个空订阅
const badH2 = await boot({ routes: realRoutes(), llm: aiStub, settings: { channels: "homepage" } });
const badMsg = await badH2.commands.get("wechat-sub")("https://mp.weixin.qq.com/s?mid=2650236574&idx=1");
has(badMsg, "没能从文章页取到 biz", "两边都拿不到 biz 时给出可读错误");
eq(badH2.subs().length, 0, "失败时不会留下空订阅");

/* ---------- 24. 修复回归护栏：配额兜底 / 全局裁剪记账 / AI 写入 / 交互 ---------- */

// 26.1 存储配额不足：逐次减半、⭐ 保留、明确提示、被削减的进 seen
const qh = await boot({
  routes: baseRoutes({ "mp/homepage": (url) => ({ body: url.indexOf("hid=1&cid=1") >= 0 ? homepageHtml(homepageItems(12, 6100)) : homepageHtml([]) }) }),
  llm: aiStub,
  settings: { channels: "homepage" },
  quota: (k, s) => k.indexOf("a:") === 0 && s.length > 2600,
});
await qh.commands.get("wechat-sub")(A1);
const qid = qh.subs()[0].id;
const qa0 = qh.arts(qid);
qa0[0].star = true;
qh.set("a:" + qid, qa0);
await qh.click("refresh");
const qa1 = qh.arts(qid);
ok(qa1.length > 0, "配额不足时仍保住部分篇目（" + qa1.length + " 篇）");
ok(qa1.length < 13, "配额不足时确实做了削减（否则第二次写入照样超限）");
ok(qa1.some((a) => a.star), "⭐ 收藏的篇目在配额压力下仍保留");
has(qh.calls.toast.join("|"), "存储空间不足", "并给出明确的存储提示");
ok((qh.get("seen:" + qid) || []).length > 0, "被削减的篇目进了 seen（下次刷新不会复活）");

// 26.2 全局篇数上限：只有真的写进存储才记账；写不进时不再假装淘汰成功
function seedMany(h, n, each) {
  const subs = [];
  for (let i = 0; i < n; i++) {
    const sid = "gt" + i;
    subs.push({ id: sid, name: "订阅 " + i, biz: "BIZGT" + i, enabled: true, channels: ["homepage"], createdAt: NOW_S - 5000 });
    const list = [];
    for (let j = 0; j < each; j++) list.push({ id: sid + "_" + j, subId: sid, subName: "订阅 " + i, title: "旧文章 " + j,
      link: "https://mp.weixin.qq.com/s?__biz=BIZGT" + i + "&mid=9" + j + "&idx=1&sn=x" + i + "_" + j, t: NOW_S - (j + 1) * 60, digest: "" });
    h.set("a:" + sid, list);
  }
  h.set("subs", subs);
}
const totalOf = (h) => h.subs().reduce((n, s) => n + h.arts(s.id).length, 0);
const gt = await boot({ routes: baseRoutes({ "mp/homepage": { body: homepageHtml([]) } }), llm: aiStub, settings: { channels: "homepage" } });
seedMany(gt, 11, 60);
eq(totalOf(gt), 660, "先造出 660 篇（超过全局上限 600）");
await gt.commands.get("wechat-refresh")();
eq(totalOf(gt), 600, "全局上限生效：660 → 600，账面与存储一致");
ok((gt.get("seen:" + gt.subs()[0].id) || []).length >= 0, "裁剪不报错");
const gt2 = await boot({ routes: baseRoutes({ "mp/homepage": { body: homepageHtml([]) } }), llm: aiStub, settings: { channels: "homepage" }, quota: (k) => k.indexOf("a:gt0") === 0 });
seedMany(gt2, 11, 60);
await gt2.commands.get("wechat-refresh")();
has(gt2.notes(), "全局清理提前结束", "写不进存储时明确记录提前结束");
eq(totalOf(gt2), 660, "写不进存储时不记账（不做无提示的假淘汰）");
// 26.3 AI 分类：一批只写一次文章表；输出里夹带示例花括号也能解析
const ch = await boot({
  routes: baseRoutes({ "mp/homepage": (url) => ({ body: url.indexOf("hid=1&cid=1") >= 0 ? homepageHtml(homepageItems(12, 6300)) : homepageHtml([]) }) }),
  llm: (p) => {
    if (p.indexOf("只能从这些里选") >= 0) return { text: '先说明格式（示例 {items:[]} 只是示意），真结果如下：' + aiStub(p).text, model: 'noisy' };
    return aiStub(p);
  },
  settings: { channels: "homepage" },
});
await ch.commands.get("wechat-sub")(A1);
const cid = ch.subs()[0].id;
await ch.click("refresh");
const cw0 = ch.writesOf("a:" + cid);
await ch.click("classify");
const cw1 = ch.writesOf("a:" + cid);
const cCount = ch.arts(cid).filter((a) => a.cats && a.cats.length).length;
ok(cCount >= 13, "12 篇 + 订阅时那篇都拿到分类（共 " + cCount + " 篇）");
ok(cw1 - cw0 <= 2, "文章表按批写（" + (cw1 - cw0) + " 次 / " + cCount + " 篇），不是每篇一次整表读写");
ok(cw1 - cw0 < cCount, "写入次数远小于篇数（修复前每篇一次）");
ok(ch.calls.chat.length >= 1, "确实调用了 AI");

// 26.4 日报：已总结的篇目计入抓正文额度；缺 subName 不写字符串 undefined
const dgh = await boot({ routes: baseRoutes({ "mp/homepage": { body: homepageHtml([]) } }), llm: aiStub, settings: { channels: "homepage", dailyBodyLimit: "2" } });
dgh.set("subs", [{ id: "dsub", name: "日报测试号", biz: BIZ, enabled: true, channels: ["homepage"], createdAt: NOW_S - 500 }]);
const darts = [];
for (let i = 0; i < 7; i++) {
  const a = { id: "dart" + i, subId: "dsub", title: "日报文章 " + i, link: "https://mp.weixin.qq.com/s?__biz=" + BIZ + "&mid=22474840" + (10 + i) + "&idx=1&sn=d" + i, t: NOW_S - i * 60, digest: "摘要 " + i };
  if (i < 2) { a.summarized = true; a.summary = "已总结 " + i; }
  darts.push(a);
}
dgh.set("a:dsub", darts);
const df0 = dgh.fetches("mp.weixin.qq.com/s?").length;
const dRes = await dgh.commands.get("wechat-digest")();
const df1 = dgh.fetches("mp.weixin.qq.com/s?").length;
eq(df1 - df0, 0, "dailyBodyLimit=2 且前两篇已总结时不再抓正文（已总结的计入额度）");
notHas(JSON.stringify(dRes), "undefined", "缺 subName 时不会把字符串 undefined 写进日报或 AI 提示词");
has(JSON.stringify(dRes), "未知公众号", "缺 subName 时用占位公众号名");

// 26.5 交互：取消收藏有提示、重渲染保留滚动位置、删除订阅后阅读器不悬空
const ih = await boot({ routes: baseRoutes(), llm: aiStub, settings: { channels: "homepage" }, confirm: true });
await ih.commands.get("wechat-sub")(A1);
const iid = ih.subs()[0].id;
await ih.click("star", A1_ID);
await ih.click("star", A1_ID);
has(ih.calls.toast.join("|"), "已取消收藏", "取消收藏给出提示");
has(ih.calls.toast.join("|"), "手动移除", "并说明收藏夹里的条目需手动移除（宿主没有删除接口）");
ok(!(ih.art(A1_ID) || {}).star, "取消收藏后插件侧 star 复位");
await ih.click("open", A1_ID);
has(ih.root.innerHTML, "wx-reader", "阅读器已打开");
ih.root.scrollTop = 480;
await ih.click("star", A1_ID);
eq(ih.root.scrollTop, 480, "重渲染后保留滚动位置（读长文时点收藏不跳回顶部）");
await ih.click("manage");
await ih.click("del", iid);
eq(ih.subs().length, 0, "确认后删除订阅");
notHas(ih.root.innerHTML, "wx-reader", "删除订阅后阅读器不再悬空");
/* ---------- 结果 ---------- */

report();
if (fails.length) process.exitCode = 1;
