import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { ConfigService } from '../config/config.service';
// https-proxy-agent v7 为 ESM 导出，用 require 兼容当前 moduleResolution
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HttpsProxyAgent } = require('https-proxy-agent');

/** 统一补全请求（与 provider 无关） */
export interface LlmMessage { role: 'user' | 'assistant'; content: string; }
export interface LlmRequest {
  system?: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
}
export interface LlmResponse { message: string; usage?: any; }

/** 多 provider：bedrock(Claude) / OpenAI 兼容网关(gpt 等)，可按需扩展 */
export type LlmProvider = 'bedrock' | 'anthropic' | 'openai' | 'deepseek' | 'doubao';

/** 默认知识库（公司事实）。配置台 KNOWLEDGE_BASE 可覆盖为你自己的 QA/FAQ。 */
export const KB_DEFAULT =
  '【公司】句子互动(JuziBot)，企业级AI公司，做能真正进入业务流程干活的AI员工。\n' +
  '【办公地点】北京海淀东升大厦A座。\n' +
  '【面试流程】一面(HR/用人部门)→二面→CEO终面→发offer→背景调查→入职。\n' +
  '【面试形式】线上视频面试，到时点面试链接进入。\n' +
  '【薪资/具体待遇】面议：回"薪资是面议的，面试聊得好都好谈~具体到面试环节和面试官细聊哈"。';

/** 意图分类 system prompt（只输出标签） */
const SYS_INTENT =
  '你是招聘对话意图分类器。结合可能提供的【对话背景】(候选人应聘岗位/已约的面试时间/当前状态)，判断候选人【最新消息】的意图。严格只输出一个大写英文标签，不要解释、不要标点：\n' +
  '- 想面试/要面试/愿意面试/可以面试、给出或同意某个面试时间、明确说可以/没问题/确认 → TIME\n' +
  '- 想改约/换时间/那天不行 → RESCHEDULE\n' +
  '- 明确拒绝/不考虑/不来了/已入职别家 → REJECT\n' +
  '- 要求人工/找真人/让HR或招聘同事直接联系 → HUMAN\n' +
  '- 问公司/岗位/薪资/流程/地点/面试形式等问题 → QUESTION\n' +
  '- 其他闲聊或无法判断 → OTHER';

/**
 * 大模型客户端（仿 ai-service）：默认接 Claude(Anthropic 裸 HTTP)，预留多 provider。
 * 两层代理：LLM_PROXY_ENDPOINT 反代网关 + HTTP_PROXY_URI 正向代理（海外模型用）。
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private axiosProxy?: AxiosInstance;
  private axiosDefault?: AxiosInstance;

  constructor(private readonly config: ConfigService) {}

  /** 取带/不带正向代理的 axios 实例（缓存复用），抄 ai-service getInternetAxios */
  private getAxios(): AxiosInstance {
    const proxy = process.env.HTTP_PROXY_URI || this.config.get('HTTP_PROXY_URI');
    if (proxy) {
      if (!this.axiosProxy) {
        const agent = new HttpsProxyAgent(proxy);
        this.axiosProxy = axios.create({ httpsAgent: agent, httpAgent: agent, timeout: 60000 });
      }
      return this.axiosProxy;
    }
    if (!this.axiosDefault) this.axiosDefault = axios.create({ timeout: 60000 });
    return this.axiosDefault;
  }

  private provider(): LlmProvider {
    return (this.config.get('LLM_PROVIDER') || process.env.LLM_PROVIDER || 'anthropic') as LlmProvider;
  }

  /**
   * 统一补全入口。默认走公司 LLM 网关(OpenAI 兼容 /v1/chat/completions)，
   * model id 决定实际模型（如 us.anthropic.claude-sonnet-4-6 → 网关内部路由到 Claude）。
   * provider 字段预留：未来可加原生 anthropic /v1/messages 等分支。
   */
  async completion(req: LlmRequest): Promise<LlmResponse> {
    // provider=bedrock 走 Bedrock 通道(Claude)，否则走 OpenAI 兼容网关(gpt 等)
    if (this.provider() === 'bedrock') return this.bedrockChat(req);
    return this.gatewayChat(req);
  }

  /**
   * Bedrock 通道(Claude via AWS Bedrock)，抄 ai-service bedrock.service：
   * POST ${endpoint}/bedrock/v2/chat/completions
   * body {modelId, accessKeyId, accessKeySecret, region, requestBody:{anthropic_version, max_tokens, system, messages, temperature}}
   * 响应取 content[].text。
   */
  private async bedrockChat(req: LlmRequest): Promise<LlmResponse> {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || this.config.get('AWS_ACCESS_KEY_ID');
    const accessKeySecret = process.env.AWS_SECRET_ACCESS_KEY || this.config.get('AWS_SECRET_ACCESS_KEY');
    const region = this.config.get('AWS_REGION') || process.env.AWS_REGION || 'us-east-1';
    const modelId = this.config.get('LLM_MODEL') || process.env.ANTHROPIC_MODEL || 'us.anthropic.claude-sonnet-4-6';
    const proxyEndpoint = process.env.LLM_PROXY_ENDPOINT || this.config.get('LLM_PROXY_ENDPOINT');
    if (!proxyEndpoint) throw new Error('缺 LLM_PROXY_ENDPOINT');
    if (!accessKeyId || !accessKeySecret) throw new Error('缺 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY');
    const requestBody: any = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: req.maxTokens || 1024,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: req.temperature ?? 0.3,
    };
    if (req.system) requestBody.system = req.system;
    try {
      const r = await this.getAxios().post(`${proxyEndpoint}/bedrock/v2/chat/completions`, {
        modelId, accessKeyId, accessKeySecret, region, requestBody,
      });
      const body = r.data;
      const message = (body?.content || []).find((c: any) => c.type === 'text')?.text || '';
      return { message: (message || '').trim(), usage: body?.usage };
    } catch (e: any) {
      const detail = e?.response?.data ? JSON.stringify(e.response.data) : e?.message;
      this.logger.error(`Bedrock 调用失败: ${detail}`);
      throw new Error(`Bedrock 调用失败: ${detail}`);
    }
  }

  /**
   * 公司 LLM 网关(OpenAI 兼容)，抄 ai-service openai.service：
   * POST ${endpoint}/v1/chat/completions，Authorization: Bearer <网关key>，body {model, messages, ...}。
   * 海外模型经此网关 + getAxios(可选正向代理)访问。system 作为 messages[0] role=system。
   */
  private async gatewayChat(req: LlmRequest): Promise<LlmResponse> {
    const apiKey = process.env.ANTHROPIC_API_KEY || this.config.get('ANTHROPIC_API_KEY');
    if (!apiKey) throw new Error('缺 LLM 网关 key(ANTHROPIC_API_KEY)');
    const model = this.config.get('LLM_MODEL') || process.env.ANTHROPIC_MODEL || 'us.anthropic.claude-sonnet-4-6';
    const proxyEndpoint = process.env.LLM_PROXY_ENDPOINT || this.config.get('LLM_PROXY_ENDPOINT');
    const baseUrl = proxyEndpoint || 'https://api.openai.com';
    // 网关地址若已是完整 chat/completions 路径(如火山方舟 /api/v3/chat/completions)直接用,否则按 OpenAI 习惯拼 /v1
    const chatUrl = baseUrl.includes('/chat/completions') ? baseUrl : `${baseUrl}/v1/chat/completions`;
    const messages: any[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push(...req.messages.map((m) => ({ role: m.role, content: m.content })));
    const data: any = { model, messages, max_tokens: req.maxTokens || 1024, temperature: req.temperature ?? 0.3 };
    try {
      const r = await this.getAxios().post(chatUrl, data, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      });
      const message = r.data?.choices?.[0]?.message?.content || '';
      return { message: (message || '').trim(), usage: r.data?.usage };
    } catch (e: any) {
      const detail = e?.response?.data ? JSON.stringify(e.response.data) : e?.message;
      this.logger.error(`LLM 网关调用失败: ${detail}`);
      throw new Error(`LLM 网关调用失败: ${detail}`);
    }
  }

  // ───────────── 高层封装（给对话大脑用）─────────────

  /** 候选人回复意图分类 → TIME/RESCHEDULE/REJECT/QUESTION/OTHER */
  async classifyIntent(text: string, context?: string): Promise<string> {
    try {
      const content = context ? `${context}\n\n【最新消息】${text}` : text;
      const r = await this.completion({ system: SYS_INTENT, messages: [{ role: 'user', content }], temperature: 0, maxTokens: 10 });
      const label = (r.message || 'OTHER').toUpperCase().replace(/[^A-Z]/g, '');
      const known = ['TIME', 'RESCHEDULE', 'REJECT', 'HUMAN', 'QUESTION', 'OTHER'];
      return known.find((k) => label.includes(k)) || 'OTHER';
    } catch (e: any) {
      this.logger.warn(`意图分类失败，回退 OTHER: ${e?.message}`);
      return 'OTHER';
    }
  }

  /** 结合知识库回答候选人问题（知识库可在配置台 KNOWLEDGE_BASE 配自己的 QA，留空用内置） */
  private kbCache = { text: '', at: 0 };

  /** 知识库单一真源=飞书FAQ表(经表格服务 /kb,60s缓存);拉不到回退配置台/内置 */
  private async loadKb(): Promise<string> {
    if (this.kbCache.text && Date.now() - this.kbCache.at < 60_000) return this.kbCache.text;
    const base = (this.config.get('TABLE_SERVICE_URL') || process.env.TABLE_SERVICE_URL || '').replace(/\/$/, '');
    if (base) {
      try {
        const { data } = await axios.get(`${base}/kb`, { timeout: 8000 });
        if (data?.ok && data?.kb) {
          this.kbCache = { text: data.kb, at: Date.now() };
          return data.kb;
        }
      } catch (e: any) {
        this.logger.warn(`拉取飞书FAQ知识库失败,回退本地配置: ${e?.message}`);
      }
    }
    return this.config.get('KNOWLEDGE_BASE') || KB_DEFAULT;
  }

  async answer(text: string, context?: string): Promise<string> {
    const kb = await this.loadKb();
    const system =
      '你是句子互动的招聘助理，在企业微信上和候选人聊天。你的核心目标是和候选人约定面试时间。\n' +
      '回答优先用【知识库】；知识库没有的，用常识以招聘助理身份得体简短回答，不编造具体数字、不做任何承诺。\n' +
      '结合【对话背景】(候选人应聘岗位/已约时间/当前状态)回答，别答非所问、别和已定的事实矛盾。\n' +
      '只有涉及公司机密、需要公司层面承诺(如口头offer、入职条件)、或你确实没法得体回答时，才说"这个我帮您问下同事再回复您"。\n' +
      '【知识库】\n' + kb +
      '\n要求：口语化、简短(1-2句)、礼貌热情。若候选人还没确认面试时间，答完必须自然把话题拉回确认面试时间。直接输出要发给候选人的话，不要任何JSON、标签、前后缀。';
    const content = context ? `${context}\n\n【候选人问】${text}` : text;
    const r = await this.completion({ system, messages: [{ role: 'user', content }], temperature: 0.3, maxTokens: 300 });
    return r.message || '这个我帮您问下同事再回复您哈~';
  }

  /** 对话智能体:一次调用看全上下文(背景+历史+知识库+最新消息),产出 {回复, 动作, 时间}。
   *  关键动作(约成/改期/转人工)只"提议",由 reach.service 代码执行+校验,模型放飞也乱不了。
   *  解析失败返回 null → 调用方回退安全模板流程。 */
  async agentTurn(input: { context: string; history: { role: string; text: string }[]; message: string }):
    Promise<{ reply: string; action: string; time: string } | null> {
    const kb = await this.loadKb();
    const system =
      '你是句子互动的招聘助理,在企业微信上和候选人聊天,核心目标是拿到候选人确认的面试时间。\n' +
      '根据【对话背景】【对话历史】【知识库】读懂候选人【最新消息】(可能连发几句已合并给你),回一句得体、像真人、简短(1-2句)的话,并判断该触发什么动作。\n' +
      '硬规则(必须遵守):\n' +
      '① 绝不擅自定/改面试时间。候选人给了新时间,只能说"我跟面试官确认下",动作=propose_reschedule,由面试官拍板。\n' +
      '② 薪资一律"面议、面试细聊",不报数字、不承诺。③ 不编造公司信息,知识库没有且不好答的说"这个我帮您问下同事"。\n' +
      '④ 明确要真人→handover;首次婉拒→先挽留问原因(action=none),再次明确拒绝→reject_close。\n' +
      'action 只能选一个:confirm(候选人明确确认了背景里【已约时间】)| propose_reschedule(给了不同时间/想改,time填其期望时间原文)| handover | reject_close | none(答疑/闲聊/引导,不触发动作)。\n' +
      '【知识库】\n' + kb + '\n' +
      '严格只输出 JSON,不要任何前后缀:{"reply":"发给候选人的话","action":"confirm|propose_reschedule|handover|reject_close|none","time":"候选人期望时间原文或空"}';
    const hist = (input.history || []).slice(-8).map((h) => `${h.role === 'ai' ? '我' : '候选人'}：${h.text}`).join('\n');
    const user = `${input.context}\n【对话历史】\n${hist || '(无)'}\n【最新消息】${input.message}`;
    try {
      const r = await this.completion({ system, messages: [{ role: 'user', content: user }], temperature: 0.3, maxTokens: 400 });
      const m = (r.message || '').match(/\{[\s\S]*\}/);
      if (!m) return null;
      const j = JSON.parse(m[0]);
      if (!j.reply || !j.action) return null;
      const okActions = ['confirm', 'propose_reschedule', 'handover', 'reject_close', 'none'];
      return { reply: String(j.reply), action: okActions.includes(j.action) ? j.action : 'none', time: String(j.time || '') };
    } catch (e: any) {
      this.logger.warn(`agentTurn 失败(回退模板): ${e?.message}`);
      return null;
    }
  }
}
