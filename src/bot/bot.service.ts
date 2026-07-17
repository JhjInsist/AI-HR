import { Injectable, Logger } from '@nestjs/common';
import { FeishuService } from '../feishu/feishu.service';
import { MiaohuiService } from '../miaohui/miaohui.service';
import { ConfigService } from '../config/config.service';

function cellText(v: any): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? x.text ?? x.name ?? '' : String(x))).join('');
  if (typeof v === 'object') return v.text ?? v.name ?? '';
  return String(v);
}

/**
 * 对话式机器人应答（规则解析，确定性，无模型/无幻觉）。
 * 支持三类：查进度 / 手动加微信 / 列约面&需人工。听不懂就直说，不瞎答。
 */
@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);
  private get PROG_APP() { return this.config.get('PROG_APP_TOKEN'); }
  private get PROG_TBL() { return this.config.get('PROG_TABLE_ID'); }
  private get HELLO() { return this.config.get('HELLO_MSG', '你好，我是句子互动招聘助理，看到你投递的岗位，想跟你约一次面试~'); }

  constructor(
    private readonly feishu: FeishuService,
    private readonly miaohui: MiaohuiService,
    private readonly config: ConfigService,
  ) {}

  /** 处理一条 @机器人 的消息，返回要回复的文本 */
  async handle(text: string): Promise<string> {
    const t = (text || '').replace(/@[^\s]+/g, '').trim();
    if (!t) return '嗨，我是招聘助理秒聘~ 想查谁的进度，直接说名字就行，比如「测试张三 到哪步了」。';
    const rows = await this.feishu.listRecords(this.PROG_APP, this.PROG_TBL);
    const names = rows.map((r) => cellText(r.fields['姓名'])).filter(Boolean);
    // 模糊匹配：去掉"测试/候选人"前缀取核心名，消息含核心名 或 含其任一≥2字子串即命中
    const core = (n: string) => n.replace(/^(测试|候选人)/, '');
    const nameHit = (n: string): boolean => {
      const c = core(n);
      if (c.length >= 2 && t.includes(c)) return true;
      for (let i = 0; i + 2 <= c.length; i++) if (t.includes(c.slice(i, i + 2))) return true;
      return false;
    };
    const hitName = names.find((n) => n && nameHit(n));
    const phone = (t.match(/1[3-9]\d{9}/) || [])[0];

    // ③ 手动加微信：含手机号 + 命中某候选人
    if (phone && hitName) {
      const res = await this.miaohui.addFriendByPhone(phone, this.HELLO);
      const rec = rows.find((r) => cellText(r.fields['姓名']) === hitName);
      if (rec) {
        const prev = cellText(rec.fields['备忘录']);
        const note = `[手动 ${new Date().toISOString().slice(0, 16)}] 加好友 ${phone}：${res.ok ? '✓已发起' : '✕失败 code=' + res.code}`;
        await this.feishu.updateRecord(this.PROG_APP, this.PROG_TBL, rec.record_id, { '备忘录': `${prev} | ${note}`.slice(0, 900) });
      }
      return `好的，已用招聘企微给 ${phone} 发起加好友${res.ok ? '' : '（返回 code=' + res.code + '，可能号码无效）'}，记到 ${hitName} 备忘录了。`;
    }

    // ② 查进度：命中某候选人
    if (hitName) {
      const rec = rows.find((r) => cellText(r.fields['姓名']) === hitName);
      const 岗位 = cellText(rec.fields['岗位']);
      const 一面 = cellText(rec.fields['一面时间']);
      const 面试官 = cellText(rec.fields['一面面试官']);
      const 联系方式 = cellText(rec.fields['联系方式']);
      const 备忘 = cellText(rec.fields['备忘录']);
      return `${hitName}（${岗位}）：\n· 一面：${一面 ? 一面 + ' / ' + 面试官 : '未约'}\n· 联系方式：${联系方式 || '未找到'}\n· 进展：${备忘 || '（无）'}`;
    }

    // ① 列表：约面 / 需人工
    if (/需人工|加不到|人工/.test(t)) {
      const need = rows.filter((r) => /未找到|失败|需人工/.test(cellText(r.fields['备忘录'])));
      if (!need.length) return '目前没有需要人工介入的候选人 👍';
      return '需要人工介入的：\n' + need.map((r) => `· ${cellText(r.fields['姓名'])}（${cellText(r.fields['备忘录']).slice(-40)}）`).join('\n');
    }
    if (/约面|进度表|列表|有哪些|谁/.test(t)) {
      if (!rows.length) return '进度表暂时没有候选人。';
      return '进度表里的候选人：\n' + rows.slice(0, 20).map((r) => {
        const 一面 = cellText(r.fields['一面时间']);
        return `· ${cellText(r.fields['姓名'])}（${cellText(r.fields['岗位'])}）${一面 ? '已约面' : '待约面'}`;
      }).join('\n');
    }

    // 明确求助才给完整菜单
    if (/帮助|你能|会啥|干嘛|功能|怎么用|help|菜单/i.test(t)) {
      return '我能帮你：\n· 查进度：「测试张三 到哪一步了」\n· 手动加微信：「帮测试张三加微信 138xxxxxxxx」\n· 看列表：「有哪些约面的」「谁需要人工」';
    }
    // 像是查询进度但没匹配到候选人
    if (/进度|到哪|哪一?步|情况|怎么样|查|微信/.test(t)) {
      return '进度表里没找到对应的候选人~ 你可以说「有哪些约面的」看看在册名单。';
    }
    // 其它闲聊/听不懂：简短带过，不刷屏
    return '这个我暂时接不上哈~ 我主要帮你查候选人进度、加微信。想看能干啥就说「帮助」。';
  }
}
