import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ConfigService } from '../config/config.service';

/**
 * 秒回触达：招聘企微「加好友」。
 * 固定话术模板，不用任何模型生成。
 */
@Injectable()
export class MiaohuiService {
  private readonly logger = new Logger(MiaohuiService.name);
  private readonly base = process.env.MIAOHUI_OPENAPI_BASE || 'https://test-aa-api.ddregion.com';

  constructor(private readonly config: ConfigService) {}

  /** 通过手机号加好友（小组级开放接口）。返回 {ok, code}。
   *  opts.extraInfo：透传业务标识（触达编排用 taskId，同号首次固定）。
   *  opts.userId：指定 HR 托管账号（覆盖配置默认值）。 */
  async addFriendByPhone(
    phone: string,
    helloMsg: string,
    opts?: { extraInfo?: string; userId?: string },
  ): Promise<{ ok: boolean; code: number; raw?: any }> {
    const token = this.config.get('MIAOHUI_GROUP_TOKEN');
    if (!token) return { ok: false, code: -99, raw: '缺 MIAOHUI_GROUP_TOKEN' };
    try {
      const body: Record<string, any> = {
        token,
        phoneNum: phone,
        // 新版秒回(Stride)托管账号字段是 botId（老版叫 userId）；值由调用方按 HR 名录传入。
        botId: opts?.userId || '',
        helloMsg,
        instant: true,
        isEncrypt: false,
      };
      if (opts?.extraInfo) body.extraInfo = opts.extraInfo;
      const { data } = await axios.post(`${this.base}/addFriend/send`, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      });
      return { ok: data?.code === 0, code: data?.code, raw: data };
    } catch (e: any) {
      return { ok: false, code: -98, raw: e?.message?.slice(0, 120) };
    }
  }

  /** 给指定会话发文本消息（小组级开放接口 POST /message/send，messageType=0 纯文本）。
   *  chatId 来自好友通过/消息回调。返回 {ok, code}。 */
  async sendText(chatId: string, text: string): Promise<{ ok: boolean; code: number; raw?: any }> {
    const token = this.config.get('MIAOHUI_GROUP_TOKEN');
    if (!token) return { ok: false, code: -99, raw: '缺 MIAOHUI_GROUP_TOKEN' };
    if (!chatId) return { ok: false, code: -97, raw: '缺 chatId' };
    try {
      const { data } = await axios.post(
        `${this.base}/message/send`,
        { token, chatId, messageType: 0, payload: { text } },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 },
      );
      return { ok: data?.code === 0, code: data?.code, raw: data };
    } catch (e: any) {
      return { ok: false, code: -98, raw: e?.message?.slice(0, 120) };
    }
  }
}
