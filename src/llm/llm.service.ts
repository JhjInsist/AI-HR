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
  '【薪资/具体待遇】面议，统一回"这个我帮你转人工确认"。';

/** 意图分类 system prompt（只输出标签） */
const SYS_INTENT =
  '你是招聘对话意图分类器。判断候选人这句话的意图，严格只输出一个大写英文标签，不要解释、不要标点：\n' +
  '- 想面试/要面试/愿意面试/可以面试、给出或同意某个面试时间、明确说可以/没问题/确认 → TIME\n' +
  '- 想改约/换时间/那天不行 → RESCHEDULE\n' +
  '- 明确拒绝/不考虑/不来了/已入职别家 → REJECT\n' +
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
    const messages: any[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push(...req.messages.map((m) => ({ role: m.role, content: m.content })));
    const data: any = { model, messages, max_tokens: req.maxTokens || 1024, temperature: req.temperature ?? 0.3 };
    try {
      const r = await this.getAxios().post(`${baseUrl}/v1/chat/completions`, data, {
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
  async classifyIntent(text: string): Promise<string> {
    try {
      const r = await this.completion({ system: SYS_INTENT, messages: [{ role: 'user', content: text }], temperature: 0, maxTokens: 10 });
      const label = (r.message || 'OTHER').toUpperCase().replace(/[^A-Z]/g, '');
      const known = ['TIME', 'RESCHEDULE', 'REJECT', 'QUESTION', 'OTHER'];
      return known.find((k) => label.includes(k)) || 'OTHER';
    } catch (e: any) {
      this.logger.warn(`意图分类失败，回退 OTHER: ${e?.message}`);
      return 'OTHER';
    }
  }

  /** 结合知识库回答候选人问题（知识库可在配置台 KNOWLEDGE_BASE 配自己的 QA，留空用内置） */
  async answer(text: string): Promise<string> {
    const kb = this.config.get('KNOWLEDGE_BASE') || KB_DEFAULT;
    const system =
      '你是句子互动的招聘助理，在企业微信上和候选人聊天。只用下面【知识库】里的内容回答，' +
      '知识库里没有的就说"这个我帮你转人工确认"，绝不编造。\n【知识库】\n' + kb +
      '\n要求：口语化、简短(1-2句)、礼貌热情，答完问题自然引导回约面试时间。直接输出要发给候选人的话，不要任何JSON、标签、前后缀。';
    const r = await this.completion({ system, messages: [{ role: 'user', content: text }], temperature: 0.3, maxTokens: 300 });
    return r.message || '这个我帮您转人工确认一下哈~';
  }
}
