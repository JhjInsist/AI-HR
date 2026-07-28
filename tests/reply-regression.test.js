const assert = require('node:assert/strict');
const http = require('node:http');
const {
  ReachService,
  extractCandidateText,
  extractTimeSlot,
  isPureAcknowledgement,
  isSafeAgentConfirm,
  isSafeAgentReschedule,
  shouldSuppressAcknowledgement,
} = require('../dist/reach/reach.service');
const { ReachStatus } = require('../dist/reach/reach.schema');
const { MiaohuiService } = require('../dist/miaohui/miaohui.service');

function query(result) {
  return {
    sort() { return this; },
    limit() { return this; },
    exec: async () => result,
  };
}

function makeService(sendByWecom, taskForQueries = null) {
  const timeline = [];
  const handovers = [];
  const model = {
    updateOne: (_filter, update) => ({
      exec: async () => {
        if (update?.$push?.timeline) timeline.push(update.$push.timeline);
      },
    }),
    find: () => query([]),
    findOne: () => query(taskForQueries),
  };
  const redis = { set: async () => 'OK' };
  const config = {
    get: (key) => key === 'WELCOME_TEMPLATE' ? '' : '',
    getBool: () => true,
  };
  const feishu = { sendText: async () => ({}) };
  const miaohui = {
    sendText: async () => ({ ok: false, code: -97 }),
    sendTextByWecom: sendByWecom,
  };
  const hr = {};
  const llm = { agentTurn: async () => { throw new Error('纯确认结束语不应调用模型'); } };
  const table = {
    handover: async (payload) => {
      handovers.push(payload);
      return {};
    },
    backfill: async () => ({}),
  };
  return {
    service: new ReachService(model, redis, config, feishu, miaohui, hr, llm, table),
    timeline,
    handovers,
  };
}

async function main() {
  assert.equal(
    extractCandidateText({ type: 11, payload: { content: 'b1dca371c502a2bf66850630dad8ffa2' } }),
    '',
    '图片/系统 payload 不能作为候选人文本',
  );
  assert.equal(
    extractCandidateText({ type: 7, payload: { text: '这周四15.30可以吗', pureText: '这周四15.30可以吗' } }),
    '这周四15.30可以吗',
    '真实文本消息必须保留',
  );

  const slot = extractTimeSlot('这周四15.30可以吗');
  assert.equal(slot.date, '这周四');
  assert.match(slot.clock, /15\.30/);
  assert.equal(slot.raw, '这周四15.30');

  assert.equal(shouldSuppressAcknowledgement(ReachStatus.INTENT_ACCEPT, '嗯嗯，好的'), true);
  assert.equal(shouldSuppressAcknowledgement(ReachStatus.INTENT_ACCEPT, '好的，那薪资多少'), false);
  assert.equal(shouldSuppressAcknowledgement(ReachStatus.WELCOMED, '可以'), false);
  assert.equal(shouldSuppressAcknowledgement(ReachStatus.INTENT_RESCHEDULE, '好的'), true);
  assert.equal(isPureAcknowledgement('👌'), true);
  assert.equal(isPureAcknowledgement('方便'), true);
  assert.equal(isPureAcknowledgement('好的，那薪资多少'), false);

  const scheduled = '2026-07-30 10:00';
  for (const text of ['好的', '好的没问题', '👌', '周四上午10点']) {
    assert.equal(isSafeAgentConfirm(text, scheduled), true, `应允许确认：${text}`);
  }
  for (const text of ['行，我再想想', '可以，那薪资多少', '好的，那不来了', '周三下午2点']) {
    assert.equal(isSafeAgentConfirm(text, scheduled), false, `应拦截误确认：${text}`);
  }
  for (const text of ['周三下午2点方便吗', '我想改期', '这周四15.30可以吗']) {
    assert.equal(isSafeAgentReschedule(text), true, `应识别改期：${text}`);
  }
  for (const text of ['薪资多少', '谢谢']) {
    assert.equal(isSafeAgentReschedule(text), false, `不应误判改期：${text}`);
  }

  const proactiveCalls = [];
  const { service, timeline } = makeService(async (wecomUserId, externalUserId, text) => {
    proactiveCalls.push({ wecomUserId, externalUserId, text });
    return { ok: true, code: 0, raw: { data: { requestId: 'welcome-request-1' } } };
  });
  const task = {
    taskId: 'RT-test',
    name: '测试候选人',
    position: '后端工程师',
    interviewTime: '2026-07-29 15:30',
    round: '一面',
    status: ReachStatus.CONFIRMED,
    chatId: '',
    externalUserId: 'wm-test',
    hrBotUserId: 'zhangsan',
    welcomeAttempts: 0,
    save: async () => {},
  };
  const sent = await service.sendWelcome(task);
  assert.equal(sent, true);
  assert.equal(proactiveCalls.length, 1, '无 chatId 时必须走 sendByWecom 主动发送');
  assert.deepEqual(
    proactiveCalls[0],
    {
      wecomUserId: 'zhangsan',
      externalUserId: 'wm-test',
      text: proactiveCalls[0].text,
    },
  );
  assert.match(proactiveCalls[0].text, /后端工程师/);
  assert.equal(task.status, ReachStatus.WELCOMED);
  assert.equal(task.welcomeRequestId, 'welcome-request-1');
  assert.ok(task.welcomeSentAt instanceof Date);
  assert.ok(timeline.some((item) => item.event === 'WELCOMED'));

  const closedTask = {
    taskId: 'RT-closed',
    name: '已约成候选人',
    status: ReachStatus.INTENT_ACCEPT,
  };
  await service.handleReply(closedTask, '嗯嗯，好的');
  assert.ok(timeline.some((item) => item.event === 'NO_REPLY_ACK'), '结束语必须由代码静默，不能进入模型');

  let retryCalls = 0;
  const { service: retryService } = makeService(async () => {
    retryCalls += 1;
    if (retryCalls === 1) return { ok: false, code: -4, raw: 'contact not ready' };
    return { ok: true, code: 0, raw: { data: { requestId: 'welcome-request-2' } } };
  });
  const retryTask = {
    ...task,
    taskId: 'RT-retry',
    status: ReachStatus.CONFIRMED,
    welcomeAttempts: 0,
    welcomeSentAt: undefined,
    welcomeRequestId: '',
  };
  assert.equal(await retryService.sendWelcome(retryTask), false);
  assert.equal(retryTask.status, ReachStatus.CONFIRMED);
  assert.equal(retryTask.welcomeAttempts, 1);
  assert.equal(await retryService.sendWelcome(retryTask), true);
  assert.equal(retryTask.status, ReachStatus.WELCOMED);
  assert.equal(retryTask.welcomeAttempts, 2);

  const callbackCalls = [];
  const callbackTask = {
    ...task,
    taskId: 'RT-callback',
    phone: '13800000000',
    status: ReachStatus.ADDING,
    welcomeAttempts: 0,
    welcomeRequestId: '',
    welcomeSentAt: undefined,
  };
  const { service: callbackService, timeline: callbackTimeline } = makeService(async (wecomUserId, externalUserId) => {
    callbackCalls.push({ wecomUserId, externalUserId });
    return { ok: true, code: 0, raw: { data: { requestId: 'welcome-request-callback' } } };
  }, callbackTask);
  await callbackService.handleCallback({
    code: 0,
    data: {
      externalUserId: 'wm-callback',
      wxid: 'wx-callback',
      phoneNum: '13800000000',
      extraInfo: 'RT-callback',
    },
  });
  assert.equal(callbackCalls.length, 1);
  assert.deepEqual(callbackCalls[0], { wecomUserId: 'zhangsan', externalUserId: 'wm-callback' });
  assert.equal(callbackTask.status, ReachStatus.WELCOMED);
  assert.ok(callbackTimeline.some((item) => item.event === 'CONFIRMED'));
  assert.ok(callbackTimeline.some((item) => item.event === 'WELCOMED'));

  await callbackService.handleCallback({
    data: {
      messageId: 'image-message-1',
      chatId: 'chat-callback',
      contactId: 'wx-callback',
      externalUserId: 'wm-callback',
      isSelf: false,
      type: 11,
      payload: { content: 'b1dca371c502a2bf66850630dad8ffa2' },
    },
  });
  assert.equal(callbackCalls.length, 1, '非文本回调不得触发任何候选人回复');
  assert.ok(callbackTimeline.some((item) => item.event === 'MSG_SKIP_NON_TEXT'));

  const aiEchoTask = {
    ...task,
    taskId: 'RT-ai-echo',
    status: ReachStatus.WELCOMED,
    chatId: '',
    externalUserId: 'wm-ai-echo',
    humanTakeover: false,
  };
  const { service: aiEchoService, handovers: aiEchoHandovers } = makeService(
    async () => ({ ok: true, code: 0 }),
    aiEchoTask,
  );
  await aiEchoService.sendCandidateByWecom('zhangsan', 'wm-ai-echo', '您好');
  await aiEchoService.handleCallback({
    data: {
      messageId: 'ai-echo-message',
      chatId: 'chat-ai-echo',
      contactId: 'wx-ai-echo',
      externalUserId: 'wm-ai-echo',
      isSelf: true,
      type: 7,
      payload: { text: '您好' },
    },
  });
  assert.equal(aiEchoTask.humanTakeover, false, '同一候选人的 AI 发送回声不能误触发转人工');
  assert.equal(aiEchoHandovers.length, 0, 'AI 发送回声不能发起转人工请求');

  const proactiveHrTask = {
    ...task,
    taskId: 'RT-proactive-hr',
    dataId: 'rec-proactive-hr',
    phone: '13900000000',
    status: ReachStatus.WELCOMED,
    chatId: '',
    externalUserId: 'wm-proactive-hr',
    humanTakeover: false,
  };
  const { service: proactiveHrService, handovers: proactiveHrHandovers } = makeService(
    async () => ({ ok: true, code: 0 }),
    proactiveHrTask,
  );
  await proactiveHrService.sendCandidateByWecom('zhangsan', 'wm-another-candidate', '您好');
  await proactiveHrService.handleCallback({
    data: {
      messageId: 'proactive-hr-message',
      chatId: 'chat-proactive-hr',
      contactId: 'wx-proactive-hr',
      externalUserId: 'wm-proactive-hr',
      isSelf: true,
      type: 7,
      payload: { text: '您好' },
    },
  });
  assert.equal(proactiveHrTask.humanTakeover, true, 'HR 主动给候选人发消息后必须立即切换转人工');
  assert.equal(proactiveHrTask.status, ReachStatus.HANDOVER);
  assert.equal(proactiveHrHandovers.length, 1, 'HR 主动发消息必须向表格服务发起一次转人工');
  assert.equal(proactiveHrHandovers[0].reason, 'HUMAN_REPLY');

  let apiRequest;
  const apiServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      apiRequest = { path: req.url, body: JSON.parse(raw) };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 0, data: { requestId: 'request-from-api' } }));
    });
  });
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const address = apiServer.address();
  process.env.MIAOHUI_OPENAPI_BASE = `http://127.0.0.1:${address.port}`;
  const miaohui = new MiaohuiService({ get: () => 'group-token' });
  const apiResult = await miaohui.sendTextByWecom('zhangsan', 'wm-api', '主动邀约');
  await new Promise((resolve) => apiServer.close(resolve));
  assert.equal(apiResult.ok, true);
  assert.equal(apiRequest.path, '/message/sendByWecom');
  assert.equal(apiRequest.body.wecomUserId, 'zhangsan');
  assert.equal(apiRequest.body.externalUserId, 'wm-api');

  console.log('reply regression: 57/57 PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
