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
/**
 * 造 service。
 * @param task 单个任务(任何查询都命中它),或任务数组(按 filter 的字段值精确匹配 —— 冲突场景要用这个,
 *             否则无论查哪个标识都返回同一条,测不出"不同标识命中不同候选人")
 */
function makeService(task, tableStub) {
  const calls = { findOneFilters: [], timelinePushes: [], resumeQueries: [] };
  const pool = Array.isArray(task) ? task : null;
  const pick = (filter) => {
    if (!pool) return task;
    const keys = Object.keys(filter || {});
    return pool.find((t) => keys.every((k) => t[k] === filter[k])) || null;
  };
  const model = {
    findOne(filter) { calls.findOneFilters.push(filter); return query(pick(filter)); },
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

    // 按可信度优先级单键定位(不再用 $or 混查,见 review #2 与测试 18-24)
    const f = calls.findOneFilters[0];
    assert.ok(!f.$or, '1: 不应使用 $or 混查');
    assert.equal(f.externalUserId, 'wm-zhangsan', '1: 首选 externalUserId 单键定位');
  }

  // ── 测试2:查不到返回 found:false ──
  {
    const { service } = makeService(null);
    const card = await service.getCandidateCard({ externalUserId: 'nobody' });
    assert.deepEqual(card, { found: false }, '2: 查不到返回 {found:false}');
  }

  // ── 测试3:无 externalUserId 时按优先级降级用 wxid 定位,且仍能命中 ──
  {
    const task = baseTask();
    const { service, calls } = makeService(task);
    const card = await service.getCandidateCard({ wxid: 'wx-zhangsan', chatId: 'chat-1', phone: '13800000000' });
    const f = calls.findOneFilters[0];
    assert.ok(!f.$or, '3: 不应使用 $or 混查');
    assert.equal(f.wxid, 'wx-zhangsan', '3: 缺 externalUserId 时次选 wxid');
    assert.equal(card.found, true, '3: 仍能命中');
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

  // ══════════ 标识优先级与冲突 fail-closed(玄玄 review #2) ══════════
  // 背景:聚合聊天侧边栏切会话时会残留上一会话的 chatId(迭代100 修过这个 bug)。
  // 原实现把所有标识塞进 $or 后按 createdAt 取最新 —— 不同标识分别命中不同候选人时,
  // 会展示"较新的那个错误候选人",连带泄露其简历。故改为:优先级取最可信标识,
  // 其余非空标识必须指向同一任务,冲突则拒绝。

  const A = () => baseTask({ taskId: 'RT-A', name: '甲', dataId: 'rec-A',
    externalUserId: 'wm-A', wxid: 'wx-A', chatId: 'chat-A', phone: '13800000001' });
  const B = () => baseTask({ taskId: 'RT-B', name: '乙', dataId: 'rec-B',
    externalUserId: 'wm-B', wxid: 'wx-B', chatId: 'chat-B', phone: '13800000002' });

  // ── 18:externalUserId 与残留 chatId 指向不同人 → 拒绝,绝不展示任一方 ──
  {
    const { service } = makeService([A(), B()]);
    const card = await service.getCandidateCard({ externalUserId: 'wm-A', chatId: 'chat-B' });
    assert.equal(card.found, false, '18: 标识冲突必须 fail closed');
    assert.notEqual(card.name, '乙', '18: 绝不能展示错误候选人');
    assert.notEqual(card.name, '甲', '18: 冲突时连正确的也不给(宁缺勿错)');
  }

  // ── 19:externalUserId 优先于 wxid/chatId(都指向同一人时正常返回) ──
  {
    const { service } = makeService([A(), B()]);
    const card = await service.getCandidateCard({ externalUserId: 'wm-A', wxid: 'wx-A', chatId: 'chat-A' });
    assert.equal(card.found, true, '19: 全部标识一致应命中');
    assert.equal(card.name, '甲', '19: 命中正确候选人');
  }

  // ── 20:externalUserId 最可信 —— 优先用它查,而不是别的键 ──
  {
    const { service, calls } = makeService([A(), B()]);
    await service.getCandidateCard({ chatId: 'chat-A', wxid: 'wx-A', externalUserId: 'wm-A' });
    const f0 = calls.findOneFilters[0];
    assert.ok(!f0.$or, '20: 不应再用 $or 混查');
    assert.equal(f0.externalUserId, 'wm-A', '20: 首选 externalUserId 定位');
  }

  // ── 21:phone 与 externalUserId 冲突也要拒绝 ──
  {
    const { service } = makeService([A(), B()]);
    const card = await service.getCandidateCard({ externalUserId: 'wm-A', phone: '13800000002' });
    assert.equal(card.found, false, '21: phone 指向他人 → 拒绝');
  }

  // ── 22:任务上该字段为空时不算冲突(chatId 是懒填充的,空≠矛盾) ──
  {
    const t = A(); t.chatId = '';
    const { service } = makeService([t]);
    const card = await service.getCandidateCard({ externalUserId: 'wm-A', chatId: 'chat-new' });
    assert.equal(card.found, true, '22: 任务 chatId 为空时不应误判冲突');
    assert.equal(card.name, '甲', '22: 正常返回');
  }

  // ── 23:主键查不到时按优先级降级(未加好友的候选人只有 chatId) ──
  {
    const t = A(); t.externalUserId = '';
    const { service } = makeService([t]);
    const card = await service.getCandidateCard({ externalUserId: 'wm-unknown', chatId: 'chat-A' });
    assert.equal(card.found, true, '23: 主键无命中应降级用次级标识');
    assert.equal(card.name, '甲', '23: 命中正确候选人');
  }

  // ── 24:全部标识都查不到 → found:false ──
  {
    const { service } = makeService([A(), B()]);
    const card = await service.getCandidateCard({ externalUserId: 'wm-x', chatId: 'chat-y' });
    assert.equal(card.found, false, '24: 都查不到返回 found:false');
  }

  // ── 25(回归):getCandidateInfo 单键(phone)调用行为不受影响 ──
  {
    const t = A(); t.status = ReachStatus.CONFIRMED;
    const { service, calls } = makeService([t]);
    const r = await service.getCandidateInfo('13800000001', 'wm-A');
    assert.equal(r.found, true, '25: 画布链路仍能按 phone 命中');
    assert.equal(t.status, ReachStatus.WELCOMED, '25: 副作用仍保留');
    assert.ok(calls.timelinePushes.some((x) => x.event === 'WELCOMED'), '25: 仍写 WELCOMED');
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
