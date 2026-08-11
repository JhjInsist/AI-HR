/**
 * 侧边栏页面逻辑测试：把页面的内联 JS 放进 vm 真跑一遍，对着「模拟官方 helper」断言。
 *
 * 为什么需要：页面此前只做过 node --check（语法），SDK 调用契约一行都没执行过。
 * 而契约细节恰恰最容易错 —— 例如 getCurExternalContact 的回调字段是 userId 而不是
 * externalUserId（helper 做了改名），读错就永远取不到人。
 *
 * 这里的假 SDK 严格按 juzi-helper-1.0.11.js 源码的行为造：
 *   - invoke(api, params, cb)，cb 收 { err_msg: '<api>:ok', ... }
 *   - getCurExternalContact 回调字段是 userId
 *   - sidebarAuth 回 { err_msg, data: { baseInfo: {...} } }
 *   - getCurChatInfo 是对象方法 { success, fail }
 *   - isJuziWx: true 标记
 *
 * 运行：npm run build && node tests/sidebar-page.test.js
 */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { SIDEBAR_HTML } = require('../dist/logic/sidebar.page');

const CODE = SIDEBAR_HTML.match(/<script>([\s\S]*?)<\/script>/)[1];

/** 造运行环境。opts: {search, sdk, responses} */
function run(opts) {
  const calls = { fetches: [], invokes: [] };
  const app = {
    innerHTML: '',
    dataset: {},
    addEventListener() {},
  };
  const ctx = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    Error,
    JSON,
    String,
    Object,
    Array,
    Math,
    encodeURIComponent,
    decodeURIComponent,
    document: {
      getElementById: () => app,
      createElement: () => ({ click() {}, dataset: {}, style: {} }),
      body: { appendChild() {}, removeChild() {} },
    },
    location: { search: opts.search || '', href: 'http://svc/logic/sidebar' },
    async fetch(url, init) {
      calls.fetches.push({ url, init });
      const r = (opts.responses || []).shift();
      if (!r) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: r.status === undefined ? true : r.status < 400,
        status: r.status === undefined ? 200 : r.status,
        json: async () => r.body,
        blob: async () => r.body,
      };
    },
  };
  ctx.window = ctx;
  ctx.parent = { postMessage() {} };   // 与 window 不同 → 视为在 iframe 内
  ctx.window.parent = ctx.parent;
  if (opts.sdk) ctx.juziWx = opts.sdk(calls);
  if (opts.wx) ctx.wx = opts.wx;

  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return { calls, app };
}

/** 模拟官方 helper 的行为 */
function helper(codes) {
  const pool = codes ? codes.slice() : ['code-1'];
  return (calls) => ({
    isJuziWx: true,
    invoke(api, params, cb) {
      calls.invokes.push({ api, params });
      if (api === 'updateBaseInfo') return;            // listen：不回调，等宿主推
      if (api === 'sidebarAuth') {
        const code = pool.shift() || '';
        return cb({ err_msg: 'sidebarAuth:ok', data: { baseInfo: { code, juziChatId: 'chat-STALE' } } });
      }
      if (api === 'getCurExternalContact') {
        // helper 把宿主的 externalUserId 改名成 userId 回调
        return cb({ err_msg: 'getCurExternalContact:ok', userId: 'wm-zhangsan' });
      }
      cb({ err_msg: api + ':fail' });
    },
    getCurChatInfo({ success }) { success({ Id: 'chat-1', wxid: 'wx-1' }); },
  });
}

// helper 的回调是同步的，60ms 足够；SDK 缺失的用例要等页面的快速失败超时（见 wait 传参）
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 60));

async function main() {
  // ── 1：走 SDK 拿到 externalUserId → 只发它（不带残留 chatId）+ 带会话头 ──
  {
    const { calls, app } = run({
      sdk: helper(),
      responses: [
        { body: { ok: true, token: 'TK1', expiresIn: 1800 } },      // POST 建会话
        { body: { found: true, name: '张三', position: '后端' } },   // GET 卡片
      ],
    });
    await tick();

    const post = calls.fetches[0];
    assert.equal(post.url, '/logic/sidebar-session', '1: 先 POST 建会话');
    assert.equal(post.init.method, 'POST', '1: 用 POST(code 不进 URL)');
    assert.equal(JSON.parse(post.init.body).code, 'code-1', '1: 把 sidebarAuth 的 code 发去兑换');

    const get = calls.fetches[1];
    assert.ok(get.url.startsWith('/logic/candidate-card?'), '1: 再查卡片');
    assert.ok(get.url.includes('externalUserId=wm-zhangsan'),
      '1: 必须带 externalUserId(说明读的是 helper 的 userId 字段而非 externalUserId)');
    assert.ok(!get.url.includes('chatId'),
      '1: 拿到 externalUserId 后不得再带 chatId —— 否则服务端冲突校验会把卡片判成未找到');
    assert.equal(get.init.headers['X-Sidebar-Session'], 'TK1', '1: 带会话头');
    assert.ok(app.innerHTML.includes('张三'), '1: 渲染出候选人');
  }

  // ── 2：401 → 换新 code 重试一次 ──
  {
    const { calls, app } = run({
      sdk: helper(['code-A', 'code-B']),
      responses: [
        { body: { ok: true, token: 'TK-OLD' } },
        { status: 401, body: {} },                                  // 卡片：令牌过期
        { body: { ok: true, token: 'TK-NEW' } },                    // 重新建会话
        { body: { found: true, name: '李四' } },
      ],
    });
    await tick();

    assert.equal(calls.fetches.length, 4, '2: 应有 建会话/401/重建/重试 四次请求');
    assert.equal(JSON.parse(calls.fetches[2].init.body).code, 'code-B',
      '2: 重建会话必须用新 code(旧 code 已被一次性消费)');
    assert.equal(calls.fetches[3].init.headers['X-Sidebar-Session'], 'TK-NEW', '2: 重试带新令牌');
    assert.ok(app.innerHTML.includes('李四'), '2: 最终渲染成功');
  }

  // ── 3：helper 未注入(只有原生 jweixin)→ 报 SDK 未就绪，而不是「请选择会话」 ──
  {
    const { calls, app } = run({
      wx: { invoke() {} },        // 原生 wx：无 isJuziWx，invoke 不回调
      responses: [],
    });
    // 无 isJuziWx 时页面走 800ms 快速失败，sidebarAuth + getCurExternalContact 两次 → ~1.6s
    await tick(2200);
    assert.ok(app.innerHTML.includes('SDK 未就绪'),
      '3: 必须报 SDK 问题，不能误报成未选会话');
    assert.equal(calls.fetches.length, 0, '3: 拿不到标识时不应发请求');
  }

  // ── 4：URL 直接指定 phone(脱离聚合聊天单独验证的通路) ──
  {
    const { calls } = run({
      search: '?phone=13800000000',
      sdk: helper(),
      responses: [
        { body: { ok: true, token: 'TK' } },
        { body: { found: true, name: '王五' } },
      ],
    });
    await tick();
    const get = calls.fetches[1];
    assert.ok(get.url.includes('phone=13800000000'), '4: 支持 ?phone= 直接查');
    assert.ok(!get.url.includes('externalUserId'), '4: 不混入其它标识');
  }

  // ── 5：监听宿主切会话(updateBaseInfo listen 已注册) ──
  {
    const { calls } = run({
      sdk: helper(),
      responses: [{ body: { ok: true, token: 'TK' } }, { body: { found: false } }],
    });
    await tick();
    const listen = calls.invokes.find((i) => i.api === 'updateBaseInfo');
    assert.ok(listen, '5: 应注册 updateBaseInfo 监听');
    assert.equal(listen.params.reqType, 'listen', '5: 用 reqType:listen 注册');
  }

  console.log('sidebar-page: ALL PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
