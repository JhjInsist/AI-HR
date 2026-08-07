/**
 * 侧边栏候选人卡片 · 第一步测试(reach_tasks 纯读进度卡片)
 *
 * 设计要点:侧边栏"看简历"必须是纯读——不得改 status、不得 save、不得写 timeline。
 * 与画布用的 getCandidateInfo(有副作用:推进状态机+发欢迎语)严格分离。
 *
 * 运行:npm run build && node tests/sidebar-candidate.test.js
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { ReachService } = require('../dist/reach/reach.service');
const { ReachStatus } = require('../dist/reach/reach.schema');
const { TableService } = require('../dist/table/table.service');

/** mongoose 链式查询 mock:findOne().sort().exec() / .limit() */
function query(result) {
  return {
    sort() { return this; },
    limit() { return this; },
    exec: async () => result,
  };
}

/**
 * 造 service。model 捕获 findOne 的 filter、save 次数、timeline 推入,用于断言无副作用。
 * @param {object|null} task 命中的任务(null 表示查不到)
 */
function makeService(task, tableStub) {
  const calls = { findOneFilters: [], timelinePushes: [], resumeQueries: [] };
  const model = {
    findOne(filter) { calls.findOneFilters.push(filter); return query(task); },
    find: () => query([]),
    updateOne: (_filter, update) => ({
      exec: async () => { if (update?.$push?.timeline) calls.timelinePushes.push(update.$push.timeline); },
    }),
  };
  const redis = { set: async () => 'OK' };
  const config = { get: () => '', getBool: () => true };
  const feishu = {};
  const miaohui = {};
  const hr = {};
  const llm = {};
  // table 默认为 {}(不含 getCandidate)——刻意保留,用于验证表格服务不可用时卡片仍可用
  const table = tableStub || {};
  const service = new ReachService(model, redis, config, feishu, miaohui, hr, llm, table);
  return { service, calls };
}

function baseTask(overrides = {}) {
  let saved = 0;
  const t = {
    taskId: 'RT-card',
    dataId: 'rec-1',
    phone: '13800000000',
    name: '张三',
    position: '后端工程师',
    interviewer: '李四',
    round: '一面',
    interviewTime: '2026-08-10 15:30',
    status: ReachStatus.CONFIRMED,
    wxid: 'wx-zhangsan',
    externalUserId: 'wm-zhangsan',
    chatId: 'chat-1',
    evalDoc: 'https://feishu/doc/eval-1',
    meetingLink: '',
    humanTakeover: false,
    timeline: [{ at: new Date(), event: 'CONFIRMED', detail: '好友通过' }],
    save: async () => { saved++; },
    get savedCount() { return saved; },
  };
  Object.assign(t, overrides);
  // 用闭包记 save 次数(Object.assign 覆盖 save 时重设)
  t.__savedCount = () => saved;
  return t;
}

async function main() {
  // ── 测试1:externalUserId 命中,返回卡片字段,且零副作用 ──
  {
    const task = baseTask();
    const { service, calls } = makeService(task);
    const card = await service.getCandidateCard({ externalUserId: 'wm-zhangsan' });

    assert.equal(card.found, true, '1: 应命中');
    assert.equal(card.name, '张三', '1: 返回姓名');
    assert.equal(card.position, '后端工程师', '1: 返回岗位');
    assert.equal(card.interviewer, '李四', '1: 返回面试官');
    assert.equal(card.round, '一面', '1: 返回轮次');
    assert.equal(card.status, ReachStatus.CONFIRMED, '1: 返回当前状态');
    assert.equal(card.interviewTime, '2026-08-10 15:30', '1: 返回面试时间');
    assert.ok(Array.isArray(card.timeline), '1: 返回时间线数组');

    // 核心:纯读,无副作用
    assert.equal(task.status, ReachStatus.CONFIRMED, '1: status 不得被改动');
    assert.equal(task.__savedCount(), 0, '1: 不得调用 save');
    assert.equal(calls.timelinePushes.length, 0, '1: 不得写 timeline');

    // findOne 用 $or 且包含 externalUserId 条件
    const f = calls.findOneFilters[0];
    assert.ok(f && Array.isArray(f.$or), '1: 应以 $or 查询');
    assert.ok(f.$or.some((c) => c.externalUserId === 'wm-zhangsan'), '1: $or 含 externalUserId 条件');
  }

  // ── 测试2:查不到返回 found:false ──
  {
    const { service } = makeService(null);
    const card = await service.getCandidateCard({ externalUserId: 'nobody' });
    assert.deepEqual(card, { found: false }, '2: 查不到返回 {found:false}');
  }

  // ── 测试3:wxid / chatId / phone 任一键都能构造查询 ──
  {
    const task = baseTask();
    const { service, calls } = makeService(task);
    await service.getCandidateCard({ wxid: 'wx-zhangsan', chatId: 'chat-1', phone: '13800000000' });
    const f = calls.findOneFilters[0];
    assert.ok(f.$or.some((c) => c.wxid === 'wx-zhangsan'), '3: $or 含 wxid');
    assert.ok(f.$or.some((c) => c.chatId === 'chat-1'), '3: $or 含 chatId');
    assert.ok(f.$or.some((c) => c.phone === '13800000000'), '3: $or 含 phone');
  }

  // ── 测试3b:全空入参返回 found:false,且不查库 ──
  {
    const { service, calls } = makeService(baseTask());
    const card = await service.getCandidateCard({});
    assert.equal(card.found, false, '3b: 无任何标识应 found:false');
    assert.equal(calls.findOneFilters.length, 0, '3b: 无标识不应查库');
  }

  // ── 测试4(回归):重构后 getCandidateInfo 仍保留副作用(CONFIRMED→WELCOMED) ──
  {
    const task = baseTask({ status: ReachStatus.CONFIRMED });
    const { service, calls } = makeService(task);
    const r = await service.getCandidateInfo('13800000000', 'wm-zhangsan');
    assert.equal(r.found, true, '4: 命中');
    assert.ok(r.welcome, '4: getCandidateInfo 仍返回 welcome 欢迎语');
    assert.equal(task.status, ReachStatus.WELCOMED, '4: 仍把 CONFIRMED 推进到 WELCOMED');
    assert.ok(task.__savedCount() > 0, '4: 仍会 save');
    assert.ok(calls.timelinePushes.some((t) => t.event === 'WELCOMED'), '4: 仍写 WELCOMED 时间线');
  }

  // ══════════ 第二步:合并表格服务(进度表)字段 ══════════

  /** 表格服务 stub:返回 GET /candidate 的典型响应。queries 收集入参用于断言。 */
  function tableStub(queries = [], overrides) {
    return {
      getCandidate: async (p) => {
        queries.push(p);
        return Object.assign({
          found: true,
          dataId: 'rec-1',
          name: '张三(表格)',        // 与 mongo 重叠,不得覆盖 mongo
          contact: '13800000000',
          position: '后端(表格)',     // 与 mongo 重叠
          positionCategory: '后端',
          identity: '应届生',
          channel: 'BOSS直聘',
          screening: '通过',
          memo: '沟通顺畅',
          transcript: 'https://feishu/doc/ts-1',
          hasResume: true,
          resumeName: '张三-简历.pdf',
          resumeUrl: '/candidate/resume?dataId=rec-1',
        }, overrides || {});
      },
    };
  }

  // ── 测试5:表格字段合并进卡片 ──
  {
    const task = baseTask();
    const q = [];
    const { service } = makeService(task, tableStub(q));
    const card = await service.getCandidateCard({ externalUserId: 'wm-zhangsan' });
    assert.equal(q.length, 1, '5: 恰好调表格服务一次');
    assert.equal(q[0].dataId, 'rec-1', '5: 用 mongo 的 dataId 去查表格');
    assert.equal(card.identity, '应届生', '5: 补候选人身份');
    assert.equal(card.positionCategory, '后端', '5: 补岗位大类');
    assert.equal(card.channel, 'BOSS直聘', '5: 补渠道');
    assert.equal(card.screening, '通过', '5: 补简历筛选');
    assert.equal(card.memo, '沟通顺畅', '5: 补备忘录');
    assert.equal(card.transcript, 'https://feishu/doc/ts-1', '5: 补逐字稿链接');
    assert.equal(card.hasResume, true, '5: 标记有简历');
    assert.equal(card.resumeName, '张三-简历.pdf', '5: 简历文件名');
  }

  // ── 测试6:重叠字段以 mongo(进度引擎事实源)为准 ──
  {
    const task = baseTask();
    const { service } = makeService(task, tableStub());
    const card = await service.getCandidateCard({ externalUserId: 'wm-zhangsan' });
    assert.equal(card.name, '张三', '6: name 用 mongo,不被表格覆盖');
    assert.equal(card.position, '后端工程师', '6: position 用 mongo');
    assert.equal(card.phone, '13800000000', '6: phone 用 mongo');
    assert.equal(card.interviewer, '李四', '6: interviewer 用 mongo');
    assert.equal(card.evalDoc, 'https://feishu/doc/eval-1', '6: evalDoc 用 mongo');
  }

  // ── 测试7:简历链改写成 miaopin 自己的代理路径(表格服务的路径浏览器带不了token) ──
  {
    const task = baseTask();
    const { service } = makeService(task, tableStub());
    const card = await service.getCandidateCard({ externalUserId: 'wm-zhangsan' });
    assert.ok(card.resumeUrl.includes('/logic/candidate-resume'), '7: 走 miaopin 自己的代理路由');
    assert.ok(card.resumeUrl.includes('rec-1'), '7: 带 dataId');
    assert.ok(!card.resumeUrl.includes('/candidate/resume?'), '7: 不直接暴露表格服务路径');
  }

  // ── 测试7b:dataId 为空(靠手机号匹配的记录)时,简历链仍带 phone 可定位 ──
  {
    const task = baseTask({ dataId: '' });
    const { service } = makeService(task, tableStub());
    const card = await service.getCandidateCard({ externalUserId: 'wm-zhangsan' });
    assert.ok(card.resumeUrl.includes('phone=13800000000'),
      '7b: dataId 缺失时必须带 phone,否则简历链 404');
  }

  // ── 测试8(关键):表格服务不可用时,卡片仍可用(降级不阻断) ──
  {
    const task = baseTask();
    const { service, calls } = makeService(task);   // table = {},无 getCandidate
    const card = await service.getCandidateCard({ externalUserId: 'wm-zhangsan' });
    assert.equal(card.found, true, '8: 表格服务缺失时卡片仍返回 found:true');
    assert.equal(card.name, '张三', '8: mongo 字段完整');
    assert.equal(card.status, ReachStatus.CONFIRMED, '8: status 仍不变');
    assert.equal(task.__savedCount(), 0, '8: 仍无副作用');
    assert.equal(calls.timelinePushes.length, 0, '8: 仍不写 timeline');
  }

  // ── 测试9:表格服务抛异常时降级,不把纯读接口拖挂 ──
  {
    const task = baseTask();
    const boom = { getCandidate: async () => { throw new Error('table service 502'); } };
    const { service } = makeService(task, boom);
    const card = await service.getCandidateCard({ externalUserId: 'wm-zhangsan' });
    assert.equal(card.found, true, '9: 表格服务抛异常时卡片仍可用');
    assert.equal(card.name, '张三', '9: mongo 字段完整');
    assert.equal(card.identity, undefined, '9: 补充字段缺失但不报错');
  }

  // ── 测试10:mongo 查不到时,不应白调表格服务 ──
  {
    const q = { resumeQueries: [] };
    const stub = { getCandidate: async (p) => { q.resumeQueries.push(p); return { found: true }; } };
    const { service } = makeService(null, stub);
    const card = await service.getCandidateCard({ externalUserId: 'nobody' });
    assert.equal(card.found, false, '10: 返回 found:false');
    assert.equal(q.resumeQueries.length, 0, '10: 未命中任务时不调表格服务');
  }

  // ── 测试11:mongo evalDoc 为空时,用表格的补位 ──
  {
    const task = baseTask({ evalDoc: '' });
    const { service } = makeService(task, tableStub([], { evalDoc: 'https://feishu/doc/from-table' }));
    const card = await service.getCandidateCard({ externalUserId: 'wm-zhangsan' });
    assert.equal(card.evalDoc, 'https://feishu/doc/from-table', '11: mongo 空则用表格补位');
  }

  // ══════════ TableService 真实 HTTP(axios/token注入/头解析都要真跑一次) ══════════
  {
    delete process.env.TABLE_SERVICE_URL;          // 排除 env 兜底干扰
    const seen = [];
    const RESUME = Buffer.from('%PDF-1.4 fake-resume');
    const srv = http.createServer((req, res) => {
      seen.push({ url: req.url, token: req.headers['x-aihr-token'] });
      if (req.url.startsWith('/candidate/resume')) {
        if (req.url.includes('dataId=missing')) { res.statusCode = 404; res.end('{"ok":false}'); return; }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition',
          `inline; filename*=UTF-8''${encodeURIComponent('张三-简历.pdf')}`);
        res.end(RESUME);
        return;
      }
      if (req.url.startsWith('/candidate')) {
        if (req.url.includes('dataId=boom')) { res.statusCode = 500; res.end('{"ok":false}'); return; }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url.includes('dataId=none')
          ? { found: false }
          : { found: true, dataId: 'rec-1', name: '张三', identity: '应届生', hasResume: true, resumeName: '张三-简历.pdf' }));
        return;
      }
      res.statusCode = 404; res.end('{}');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const cfg = (url, tok) => ({ get: (k) => (k === 'TABLE_SERVICE_URL' ? url : k === 'AIHR_TABLE_TOKEN' ? tok : '') });

    // 12:正常查询 + token 真的进了请求头
    const svc = new TableService(cfg(base, 's3cret'));
    const r12 = await svc.getCandidate({ dataId: 'rec-1', phone: '' });
    assert.equal(r12.name, '张三', '12: 解析响应');
    assert.equal(r12.identity, '应届生', '12: 补充字段');
    assert.equal(seen[0].token, 's3cret', '12: X-AIHR-Token 已注入请求头');
    assert.ok(seen[0].url.includes('dataId=rec-1'), '12: dataId 进了 query');

    // 13:found:false → null
    assert.equal(await svc.getCandidate({ dataId: 'none' }), null, '13: found:false 返回 null');

    // 14:500 不抛,降级 null
    assert.equal(await svc.getCandidate({ dataId: 'boom' }), null, '14: 500 降级为 null 且不抛');

    // 15:未配置 base → 不发请求
    const before = seen.length;
    assert.equal(await new TableService(cfg('', 's3cret')).getCandidate({ dataId: 'x' }), null, '15: 未配置返回 null');
    assert.equal(seen.length, before, '15: 未配置时一个请求都不发');

    // 16:简历字节 + 中文文件名从 Content-Disposition 解出
    const r16 = await svc.getResume({ dataId: 'rec-1' });
    assert.ok(Buffer.isBuffer(r16.data), '16: 返回 Buffer');
    assert.equal(r16.data.toString(), '%PDF-1.4 fake-resume', '16: 字节完整(arraybuffer 转换正确)');
    assert.equal(r16.name, '张三-简历.pdf', '16: RFC5987 中文名解码正确');

    // 17:简历 404 不抛
    assert.equal(await svc.getResume({ dataId: 'missing' }), null, '17: 404 降级为 null 且不抛');

    await new Promise((r) => srv.close(r));
  }

  console.log('sidebar-candidate: ALL PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
