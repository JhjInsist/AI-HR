/**
 * 侧边栏入口鉴权测试(玄玄 review #1)。
 *
 * 契约:
 * - card/resume 不能裸奔:必须持有本服务签发的会话令牌。
 * - 会话只能由「宿主签发的 OAuth code」换取 —— code 只有登录态的聚合聊天能拿到
 *   (/oauth/getOAuthCode 挂 auth),且 redeem 在 identity-service 侧是原子一次性消费。
 * - 浏览器零共享密钥:兑换在服务端做,共享 token 不下发。
 * - fail-closed:BFF 地址或签名密钥未配置 → 一律拒绝,不许退化成"放行"。
 *
 * 运行:npm run build && node tests/sidebar-auth.test.js
 */
require('reflect-metadata');
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidebarAuthService } = require('../dist/logic/sidebar-auth.service');

function cfg(map) {
  return { get: (k, d = '') => (map[k] !== undefined ? map[k] : d), getBool: () => true, getNum: (k, d) => d };
}

async function main() {
  // 假 BFF:模拟 /v1/oauth/getUserInfo 的真实返回结构
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('code=good')) {
      res.end(JSON.stringify({ errcode: 0, errmsg: '', userId: 'wx-u1',
        data: { userId: 'wx-u1', orgId: 'org-ok', botId: 'bot-1', uid: 'u-1', name: '张三' } }));
    } else if (req.url.includes('code=otherorg')) {
      res.end(JSON.stringify({ errcode: 0, errmsg: '',
        data: { userId: 'wx-u9', orgId: 'org-evil', botId: 'bot-9', uid: 'u-9' } }));
    } else if (req.url.includes('code=expired')) {
      res.end(JSON.stringify({ errcode: -2, errmsg: 'code expired' }));
    } else if (req.url.includes('code=used')) {
      res.end(JSON.stringify({ errcode: -1, errmsg: 'invalid code' }));
    } else if (req.url.includes('code=boom')) {
      res.statusCode = 500; res.end('{}');
    } else {
      res.end(JSON.stringify({ errcode: -1, errmsg: 'invalid code' }));
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const BFF = `http://127.0.0.1:${srv.address().port}`;

  // 测试用假 BFF 直接挂在根上,故把路径覆盖成 bff 原生口径(无 /api 网关前缀)
  const base = { SIDEBAR_OAUTH_BASE: BFF, SIDEBAR_SESSION_SECRET: 'sekret-A',
    SIDEBAR_OAUTH_PATH: '/v1/oauth/getUserInfo' };

  // ── 1:正常兑换 → 拿到会话令牌,且 code 真的发给了 BFF ──
  {
    const svc = new SidebarAuthService(cfg(base));
    const r = await svc.createSession('good');
    assert.ok(r && r.token, '1: 应签发令牌');
    assert.ok(seen.some((u) => u.includes('code=good')), '1: code 已发往 BFF 兑换');
    const p = svc.verify(r.token);
    assert.ok(p, '1: 自己签的令牌应能验通');
    assert.equal(p.orgId, 'org-ok', '1: 载荷带 orgId');
    assert.equal(p.uid, 'u-1', '1: 载荷带 uid');
  }

  // ── 2:code 无效/过期/已用 → 不签发(这三种都是 BFF 明确拒绝) ──
  {
    const svc = new SidebarAuthService(cfg(base));
    for (const c of ['expired', 'used', 'nonexistent']) {
      assert.equal(await svc.createSession(c), null, `2: code=${c} 不应签发会话`);
    }
    assert.equal(await svc.createSession(''), null, '2: 空 code 不签发');
    assert.equal(await svc.createSession(undefined), null, '2: 缺 code 不签发');
  }

  // ── 3:BFF 挂了 → 不签发(不能因为下游异常就放行) ──
  {
    const svc = new SidebarAuthService(cfg(base));
    assert.equal(await svc.createSession('boom'), null, '3: BFF 500 时不签发');
  }

  // ── 4:orgId 白名单 ──
  {
    const wl = new SidebarAuthService(cfg({ ...base, SIDEBAR_ORG_WHITELIST: 'org-ok,org-2' }));
    assert.ok(await wl.createSession('good'), '4: 白名单内放行');
    assert.equal(await wl.createSession('otherorg'), null, '4: 白名单外拒绝(防他司拿 code 来换)');
    // 未配白名单时不限制 org(单租户部署常态),但仍必须 code 有效
    const noWl = new SidebarAuthService(cfg(base));
    assert.ok(await noWl.createSession('otherorg'), '4: 未配白名单则不限 org');
  }

  // ── 5:fail-closed —— 关键配置缺失时一律拒绝,且不发请求 ──
  {
    const before = seen.length;
    const noBff = new SidebarAuthService(cfg({ SIDEBAR_SESSION_SECRET: 'x' }));
    assert.equal(await noBff.createSession('good'), null, '5: 未配 BFF 地址 → 拒绝');
    assert.equal(seen.length, before, '5: 未配置时不应发出任何请求');
    assert.equal(noBff.verify('anything'), null, '5: 未配置时 verify 一律失败');

    const noSecret = new SidebarAuthService(cfg({ SIDEBAR_OAUTH_BASE: BFF }));
    assert.equal(await noSecret.createSession('good'), null, '5: 未配签名密钥 → 拒绝');
    assert.equal(noSecret.verify('anything'), null, '5: 无密钥时 verify 一律失败');
    assert.equal(noSecret.enabled(), false, '5: enabled() 应如实反映未启用');
  }

  // ── 6:令牌不可伪造 ──
  {
    const svc = new SidebarAuthService(cfg(base));
    const { token } = await svc.createSession('good');

    assert.equal(svc.verify(''), null, '6: 空令牌');
    assert.equal(svc.verify(undefined), null, '6: 缺令牌');
    assert.equal(svc.verify('garbage'), null, '6: 垃圾串');
    assert.equal(svc.verify(token + 'x'), null, '6: 尾部篡改');
    assert.equal(svc.verify(token.slice(0, -3)), null, '6: 截断');

    // 改载荷但留原签名
    const [body] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ orgId: 'org-evil', uid: 'hacker',
      exp: Date.now() + 6e5 })).toString('base64url');
    assert.equal(svc.verify(`${forged}.${token.split('.')[1]}`), null, '6: 改载荷保签名');
    assert.notEqual(body, forged, '6: 前置检查');

    // 换密钥签的令牌不能通过(防跨环境/跨服务重放)
    const other = new SidebarAuthService(cfg({ ...base, SIDEBAR_SESSION_SECRET: 'sekret-B' }));
    assert.equal(other.verify(token), null, '6: 别的密钥签的令牌不认');
  }

  // ── 7:过期令牌 ──
  {
    const svc = new SidebarAuthService(cfg({ ...base, SIDEBAR_SESSION_TTL_SEC: '0' }));
    const { token } = await svc.createSession('good');
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(svc.verify(token), null, '7: 过期即失效');
  }

  // ── 7b:默认兑换路径必须带 /api 前缀 ──
  // 官方文档与 demo.html 都是 {console}/api/v1/oauth/getUserInfo;xiaoju-bff 里的路由本身
  // 是 /v1/oauth/getUserInfo(无 /api,由网关加)。早先写成后者,指向公网域名时必 404、
  // 鉴权全废且表现为「恒 401」不易察觉。这条钉住默认值,防止被改回去。
  {
    const before = seen.length;
    const svc = new SidebarAuthService(cfg({
      SIDEBAR_OAUTH_BASE: BFF, SIDEBAR_SESSION_SECRET: 'sekret-A',   // 刻意不配 PATH
    }));
    await svc.createSession('good');
    const url = seen[before] || '';
    assert.ok(url.startsWith('/api/v1/oauth/getUserInfo'),
      `7b: 默认路径应为 /api/v1/oauth/getUserInfo(官方口径),实际=${url}`);

    // 直连内网 bff 的部署可覆盖成无 /api 的原生路由
    const before2 = seen.length;
    const svc2 = new SidebarAuthService(cfg({ ...base }));
    await svc2.createSession('good');
    assert.ok((seen[before2] || '').startsWith('/v1/oauth/getUserInfo'),
      '7b: SIDEBAR_OAUTH_PATH 可覆盖为 bff 原生路径');
  }

  // ══════════ controller 守卫接线(只测 service 不够:守卫漏接 = 鉴权白做) ══════════
  {
    const { LogicController } = require('../dist/logic/logic.controller');
    const svc = new SidebarAuthService(cfg(base));
    const { token } = await svc.createSession('good');

    const hits = { card: 0, resume: 0 };
    const reach = {
      getCandidateCard: async () => { hits.card++; return { found: true, name: '张三' }; },
      getCandidateResume: async () => { hits.resume++; return { data: Buffer.from('x'), name: 'r.pdf' }; },
    };
    const ctl = new LogicController({ get: () => '' }, {}, {}, reach, svc);
    const fakeRes = () => {
      const o = { code: 200, body: null, headers: {}, sent: null };
      o.status = (c) => { o.code = c; return o; };
      o.json = (b) => { o.body = b; return o; };
      o.setHeader = (k, v) => { o.headers[k] = v; };
      o.send = (d) => { o.sent = d; return o; };
      o.type = () => o; o.set = () => o;
      return o;
    };

    // 8:无/错令牌 → 拒绝,且绝不触达数据层(不能先取数据再判权限)
    for (const bad of [undefined, '', 'forged.sig']) {
      let threw = false;
      try { await ctl.candidateCard(bad, 'wm-1'); } catch (e) { threw = true; }
      assert.equal(threw, true, `8: candidate-card 无效令牌(${JSON.stringify(bad)})必须抛`);
    }
    assert.equal(hits.card, 0, '8: 鉴权失败时不得调用数据层');

    // 9:有效令牌 → 放行
    const ok = await ctl.candidateCard(token, 'wm-1');
    assert.equal(ok.found, true, '9: 有效令牌应放行');
    assert.equal(hits.card, 1, '9: 放行后才查数据');

    // 10:resume 同样受保护(它能下载简历,漏了最严重)
    const r1 = fakeRes();
    await ctl.candidateResume(r1, undefined, 'rec-1');
    assert.equal(r1.code, 401, '10: resume 无令牌 → 401');
    assert.equal(hits.resume, 0, '10: 未鉴权不得下载简历');
    const r2 = fakeRes();
    await ctl.candidateResume(r2, token, 'rec-1');
    assert.equal(r2.code, 200, '10: 有效令牌可下载');
    assert.equal(hits.resume, 1, '10: 已取简历');

    // 11:建会话路由
    const r3 = fakeRes();
    await ctl.sidebarSession(r3, { code: 'good' });
    assert.equal(r3.body.ok, true, '11: 合法 code 建会话成功');
    assert.ok(svc.verify(r3.body.token), '11: 返回的令牌可验通');
    const r4 = fakeRes();
    await ctl.sidebarSession(r4, { code: 'expired' });
    assert.equal(r4.code, 401, '11: 过期 code → 401');

    // 12:未配置鉴权时,即便持有旧令牌也一律拒绝(fail-closed 不能被绕过)
    const off = new SidebarAuthService(cfg({}));
    const ctlOff = new LogicController({ get: () => '' }, {}, {}, reach, off);
    let threwOff = false;
    try { await ctlOff.candidateCard(token, 'wm-1'); } catch (e) { threwOff = true; }
    assert.equal(threwOff, true, '12: 未配置鉴权 → 拒绝(不退化成放行)');
  }

  // ══════════ @Headers 绑定(直接调方法绕过了装饰器,故查 Nest 运行时元数据) ══════════
  // 上面 8-12 是手动传参调用,证明不了「HTTP 请求进来时框架真的会把头绑到那个参数」。
  // 若装饰器绑错位置/绑错头名,线上会拿到 undefined → verify 恒失败(功能坏)或参数错位(更糟)。
  {
    const { LogicController } = require('../dist/logic/logic.controller');
    const HEADERS = 6;   // Nest RouteParamtypes.HEADERS
    const headerBindings = (method) => {
      const md = Reflect.getMetadata('__routeArguments__', LogicController, method) || {};
      return Object.entries(md)
        .filter(([k]) => k.startsWith(`${HEADERS}:`))
        .map(([, v]) => ({ index: v.index, name: v.data }));
    };

    const card = headerBindings('candidateCard');
    assert.deepEqual(card, [{ index: 0, name: 'x-sidebar-session' }],
      'H1: candidateCard 须把 x-sidebar-session 头绑到第 0 个参数');

    const resume = headerBindings('candidateResume');
    assert.deepEqual(resume, [{ index: 1, name: 'x-sidebar-session' }],
      'H2: candidateResume 须把该头绑到第 1 个参数(第 0 个是 @Res)');

    // 建会话路由存在且是 POST
    const { RequestMethod } = require('@nestjs/common');
    assert.equal(Reflect.getMetadata('path', LogicController.prototype.sidebarSession),
      'sidebar-session', 'H3: 建会话路由路径');
    assert.equal(Reflect.getMetadata('method', LogicController.prototype.sidebarSession),
      RequestMethod.POST, 'H3: 建会话须是 POST(code 不该出现在 URL/referer/日志里)');
  }

  await new Promise((r) => srv.close(r));
  console.log('sidebar-auth: ALL PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
