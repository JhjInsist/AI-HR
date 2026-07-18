import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { ConfigService } from '../config/config.service';
import { NODE_TPL } from './canvas-template';

/** 意图分类 bot 的系统提示词（切模型重建时沿用） */
const SYS_INTENT =
  '你是意图分类器。判断候选人回复的意图,严格只输出一行标签,不解释不加前缀:\n' +
  '·给出可面试时间→TIME\n·想改时间→RESCHEDULE\n·明确拒绝/不考虑→REJECT\n·问公司岗位薪资流程等→QUESTION\n·以上都不是→OTHER';

/** 对话应答 bot 的系统提示词（切模型重建时沿用） */
const SYS_CHAT =
  '你是句子互动的招聘助理,在企业微信上和候选人聊天。只用下面的事实回答,不知道就说"这个我帮你转人工确认",绝不编造。\n' +
  '【公司】句子互动(JuziBot),企业级AI公司,做能真正进入业务流程干活的AI员工。\n' +
  '【办公地点】北京海淀东升大厦A座。\n' +
  '【面试流程】一面(HR/用人部门)→二面→CEO终面→发offer→背景调查→入职。\n' +
  '【面试形式】线上视频面试,到时点面试链接进入。\n' +
  '【薪资/具体待遇】面议,统一回"这个帮你转人工确认"。\n' +
  '要求:口语化、简短(1-2句)、礼貌热情,答完问题自然引导回约面试时间。直接输出要发给候选人的话,不要任何JSON、标签、前后缀。';

/** 供配置台下拉的可用模型（取自 ai-service completion.enum 的当代常用款） */
export const MODEL_GROUPS = [
  { provider: '豆包(火山)', models: ['doubao-1.5-pro-32k', 'doubao-seed-1.6', 'doubao-seed-1.6-flash', 'doubao-seed-2.0-pro', 'doubao-seed-2.0-lite'] },
  { provider: 'OpenAI', models: ['gpt-4o-mini-2024-07-18', 'gpt-4o-2024-11-20', 'gpt-4.1-2025-04-14', 'gpt-4.1-mini-2025-04-14', 'gpt-5.1', 'gpt-5.2'] },
  { provider: 'DeepSeek', models: ['deepseek-chat', 'deepseek-v4-pro'] },
  { provider: '通义千问', models: ['qwen-plus', 'qwen-max', 'qwen3-max'] },
  { provider: 'Claude', models: ['claude-4.5-sonnet', 'claude-4.5-haiku'] },
];

@Injectable()
export class InsightAdminService {
  private readonly logger = new Logger(InsightAdminService.name);
  constructor(private readonly config: ConfigService) {}

  private base() { return process.env.INSIGHT_BASE || 'https://test-aa-insight.ddregion.com/api'; }
  private org() { return process.env.INSIGHT_ORG || 'aab99626-d471-4d3e-966b-2b447b909bf8'; }
  private jwt() { return process.env.INSIGHT_TOKEN || ''; }
  private hdr() { return { Authorization: `Bearer ${this.jwt()}`, 'Content-Type': 'application/json' }; }

  /** 重建某 bot 的画布以套用新模型，沿用其固定系统提示词 */
  async rebuild(botId: string, systemPrompt: string, model: string, temperature: number): Promise<void> {
    const base = this.base(), org = this.org();
    const cur = (await axios.get(`${base}/canvas/get?botId=${botId}&orgId=${org}`, { headers: this.hdr() })).data.data;
    const canvasId = cur.canvasId;

    const rid = randomUUID(), lid = randomUUID(), sid = randomUUID();
    const brR = randomUUID(), brL = randomUUID(), lpL = randomUUID(), lpS = randomUUID(), sR = randomUUID();
    const port = (items: [string, string][]) => ({
      items: items.map(([group, id]) => ({ id, group, attrs: { fo: { x: -5, y: -5, width: 10, height: 10, magnet: true } } })),
    });
    const clone = (o: any) => JSON.parse(JSON.stringify(o));

    const recv = clone(NODE_TPL['receive-text-message']);
    recv.id = rid; recv.ports = port([['right', brR]]); recv.position = { x: -1200, y: -200 };
    const ro = recv.data.outputTypes || [];

    const llm = clone(NODE_TPL['llm-completion']);
    llm.id = lid; llm.ports = port([['left', lpL], ['right', brL]]); llm.position = { x: -700, y: -260 };
    const np = {
      ...llm.data.nodePayload, modelType: model, systemPrompt, enableUserPrompt: true,
      userPrompt: '候选人：{{msg}}', jsonOutput: false, temperature,
      inputs: [{ name: 'msg', type: { type: 'string', isRequired: true }, dataPath: 'text', valueType: 'reference', referenceNodeId: rid }],
    };
    delete np.dbTables;
    llm.data.nodePayload = np; delete llm.data.dbTables;
    llm.data.output = [{ name: 'message', type: { type: 'string', isRequired: true } }];

    const send = clone(NODE_TPL['send-text-message']);
    send.id = sid; send.ports = port([['left', lpS], ['right', sR]]); send.position = { x: -200, y: -200 };
    send.data.nodePayload = {
      inputs: [{ name: 'message', type: { type: 'string', isRequired: true }, dataPath: 'message', valueType: 'reference', referenceNodeId: lid }],
      template: '{{message}}', enableMention: false,
    };

    const edge = (a: string, ap: string, b: string, bp: string) => ({
      id: randomUUID(), shape: 'custom-curve-edge', router: { name: 'normal' },
      attrs: { line: { style: { animation: '' }, strokeDasharray: 0 } },
      source: { cell: a, port: ap }, target: { cell: b, port: bp },
    });
    const e1 = edge(rid, brR, lid, lpL), e2 = edge(lid, brL, sid, lpS);
    const rawCanvas = [recv, llm, send, e1, e2];
    const nodes = [
      { nodeId: rid, name: '接收', description: '', type: 'receive-text-message', category: 'trigger', outputTypes: ro, outputBranches: [{ branchId: brR, branchName: 'o' }], nodePayload: {} },
      { nodeId: lid, name: '模型', description: '', type: 'llm-completion', category: 'calculation', outputTypes: [{ name: 'message', type: { type: 'string', isRequired: true } }], outputBranches: [{ branchId: brL, branchName: 'o' }], nodePayload: np },
      { nodeId: sid, name: '输出', description: '', type: 'send-text-message', category: 'action', outputTypes: [], outputBranches: [], nodePayload: send.data.nodePayload },
    ];
    const edges = [
      { edgeId: e1.id, sourceNodeId: rid, sourceBranchId: brR, targetNodeId: lid },
      { edgeId: e2.id, sourceNodeId: lid, sourceBranchId: brL, targetNodeId: sid },
    ];

    await axios.post(`${base}/canvas/save`, { canvasId, orgId: org, botId, nodes, edges, rawCanvas }, { headers: this.hdr() });
    const ver = this.bumpVersion(cur.version);
    const pub = (await axios.post(`${base}/canvas/publish`, { orgId: org, botId, canvasId, version: ver, name: ver, description: model }, { headers: this.hdr() })).data;
    if (pub.code !== 0) throw new Error(`发布失败 ${pub.code} ${pub.message || ''}`);
    const en = (await axios.post(`${base}/canvas/enable`, { orgId: org, botId, canvasId: pub.data.canvasId, skipTestReason: 'other' }, { headers: this.hdr() })).data;
    if (en.code !== 0) throw new Error(`启用失败 ${en.code}`);
    this.logger.log(`bot ${botId} 已切换模型=${model} 版本=${ver}`);
  }

  /** 把意图 + 对话两个 bot 都切到新模型 */
  async setModel(model: string): Promise<{ intent: string; chat: string }> {
    const intentBot = this.config.get('INTENT_BOT_ID');
    const chatBot = this.config.get('CHAT_BOT_ID');
    await this.rebuild(intentBot, SYS_INTENT, model, 0);
    await this.rebuild(chatBot, SYS_CHAT, model, 0.3);
    await this.config.save({ MODEL: model });
    return { intent: intentBot, chat: chatBot };
  }

  private bumpVersion(v?: string): string {
    const m = (v || '').match(/v?(\d+)\.(\d+)\.(\d+)/);
    if (m) return `v${m[1]}.${m[2]}.${parseInt(m[3], 10) + 1}`;
    return 'v10.0.0';
  }
}
