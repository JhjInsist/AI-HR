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
        helloMsg,
        userId: opts?.userId || this.config.get('MIAOHUI_BOT_USERID', 'jiahongjia'),
        corpId: this.config.get('MIAOHUI_CORP_ID', 'ww5ecc1acd5dce6e9d'),
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
}
