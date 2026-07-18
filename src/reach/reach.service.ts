import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Redis } from 'ioredis';
import { ConfigService } from '../config/config.service';
import { FeishuService } from '../feishu/feishu.service';
import { MiaohuiService } from '../miaohui/miaohui.service';
import { HrService } from '../hr/hr.service';
import { LlmService } from '../llm/llm.service';
import { extractTime } from '../miaodong/miaodong.service';
import { TableService } from '../table/table.service';
import { ReachTask, ReachStatus, ReachTaskDocument } from './reach.schema';
import { REACH_REDIS } from './reach.module';

/** 发起触达入参（表格服务 → POST /reach） */
export interface CreateReachDto {
  dataId?: string;
  phone: string;
  interviewTime?: string;
  name?: string;
  position?: string;
  interviewer?: string; // 一面面试官姓名（建日程按此查 HR 名录，可不传→兜底查进度表）
}

function cellText(v: any): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? x.text ?? x.name ?? '' : String(x))).join('');
  if (typeof v === 'object') return v.text ?? v.name ?? '';
  return String(v);
}

/**
 * 解析约面时间为 Unix 毫秒时间戳（兼容多格式；解析不了返回 null）。
 * 支持：Unix 毫秒/秒时间戳、ISO datetime（含时区）、"YYYY-MM-DD HH:mm"（按本地时区）。
 * 注：表格服务实际传的格式待确认，此处做尽量宽松的兼容。
 */
export function parseInterviewTime(raw?: string): number | null {
  const s = (raw || '').trim();
  if (!s) return null;
  // 纯数字：Unix 秒（10 位）或毫秒（13 位）时间戳
  if (/^\d{10}$/.test(s)) return parseInt(s, 10) * 1000;
  if (/^\d{13}$/.test(s)) return parseInt(s, 10);
  // "YYYY-MM-DD HH:mm[:ss]"：按东八区解释墙上时间（服务器时区无关：当 UTC 算再减 8 小时）
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - 8 * 3600 * 1000;
    return isNaN(t) ? null : t;
  }
  // 其余交给 Date 兜底（ISO 带时区等）
  const t = new Date(s).getTime();
  return isNaN(t) ? null : t;
}

/** 约面时间友好展示（按东八区 YYYY-MM-DD HH:mm）；解析不了则原样返回 */
export function formatInterviewTimeText(raw?: string): string {
  const s = (raw || '').trim();
  if (!s) return '（时间待定）';
  const ms = parseInterviewTime(s);
  if (ms == null) return s;
  const d = new Date(ms + 8 * 3600 * 1000); // 手动偏移到 UTC+8，规避服务器时区
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * 统一的邀约话术（带姓名+岗位+约面时间+请确认）。
 * 招聘纯企微场景 wecom-contact-bind 画布触发不可用，故把邀约直接并进加好友申请语，
 * 好友一通过候选人即看到带时间的完整邀约；候选人回复走画布 receive 意图链。
 */
export function buildInviteMessage(name?: string, position?: string, interviewTimeRaw?: string, template?: string): string {
  const timeText = formatInterviewTimeText(interviewTimeRaw);
  const pos = position || '相关';
  const nm = name || '您';
  const tpl = template && template.trim()
    ? template
    : '{name}您好~ 我是句子互动招聘助理😊 您应聘的【{position}】岗位，一面初步约在 {time}。方便的话回复「可以」确认；如需调整，回复您方便的时间就好~';
  return tpl.replace(/\{name\}/g, nm).replace(/\{position\}/g, pos).replace(/\{time\}/g, timeText);
}

/** 开场白（好友通过后发，探面试意向，不带具体时间）。占位符 {name} {position} */
export function buildOpening(name?: string, position?: string, template?: string): string {
  const pos = position || '相关';
  const nm = name || '您';
  const tpl = template && template.trim()
    ? template
    : '{name}您好~ 我是句子互动招聘助理😊 看到您投递的【{position}】岗位简历，想跟您约一次面试，请问您近期方便吗？';
  return tpl.replace(/\{name\}/g, nm).replace(/\{position\}/g, pos);
}

/** 意图字符串 → 状态机取值（兼容中英文/画布回报） */
const INTENT_STATUS: Record<string, ReachStatus> = {
  ACCEPT: ReachStatus.INTENT_ACCEPT, TIME: ReachStatus.INTENT_ACCEPT, 确认: ReachStatus.INTENT_ACCEPT,
  RESCHEDULE: ReachStatus.INTENT_RESCHEDULE, 改约: ReachStatus.INTENT_RESCHEDULE, 改期: ReachStatus.INTENT_RESCHEDULE,
  REJECT: ReachStatus.INTENT_REJECT, 拒绝: ReachStatus.INTENT_REJECT,
  QUESTION: ReachStatus.INTENT_QUESTION, 提问: ReachStatus.INTENT_QUESTION,
  HANDOVER: ReachStatus.HANDOVER, 转人工: ReachStatus.HANDOVER,
};

/**
 * 触达编排状态机（方案第五节）。
 * 建任务 → 秒回加好友 → 好友通过回调 → 画布欢迎语/意图回报 → 同步HR + 回填进度表。
 * 所有外部回调走「200 + 异步 + 幂等」；幂等靠 Redis SET NX。
 */
@Injectable()
export class ReachService {
  private readonly logger = new Logger(ReachService.name);
  private get dry() { return this.config.getBool('DRY_RUN', true); }
  private get PROG_APP() { return this.config.get('PROG_APP_TOKEN'); }
  private get PROG_TBL() { return this.config.get('PROG_TABLE_ID'); }

  constructor(
    @InjectModel(ReachTask.name) private readonly taskModel: Model<ReachTaskDocument>,
    @Inject(REACH_REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly feishu: FeishuService,
    private readonly miaohui: MiaohuiService,
    private readonly hr: HrService,
    private readonly llm: LlmService,
    private readonly table: TableService,
  ) {}

  // ── 幂等锁：SET key NX EX；Redis 不可用时不阻断业务（返回可继续） ──
  private async lock(key: string, ttlSec = 300): Promise<boolean> {
    try {
      const r = await this.redis.set(key, '1', 'EX', ttlSec, 'NX');
      return r === 'OK';
    } catch (e: any) {
      this.logger.warn(`Redis 锁异常，放行 ${key}: ${e?.message}`);
      return true;
    }
  }

  private async appendTimeline(taskId: string, event: string, detail?: string) {
    await this.taskModel.updateOne(
      { taskId },
      { $push: { timeline: { at: new Date(), event, detail } } },
    ).exec();
  }

  // ───────────────────────── ① 发起触达 ─────────────────────────
  /** 建任务(ADDING) → 秒回加好友(extraInfo=taskId, userId=hrBotUserId) → 记 timeline */
  async createTask(dto: CreateReachDto) {
    const phone = (dto.phone || '').trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) return { ok: false, msg: '缺少或非法手机号 phone' };

    // 幂等：同号短时间内只建一次任务
    if (!(await this.lock(`reach:create:${phone}`, 60))) {
      return { ok: false, msg: '该手机号触达刚发起过，请勿重复', duplicate: true };
    }
    // 重新触达：清掉该号旧任务，保证一个号同时只有一条活跃触达，避免好友通过/消息回调关联到旧任务
    const removed = await this.taskModel.deleteMany({ phone }).exec();
    if (removed.deletedCount) this.logger.log(`[触达] ${phone} 清理旧任务 ${removed.deletedCount} 条后重新触达`);

    const taskId = `RT${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const hrBotUserId = this.config.get('MIAOHUI_BOT_USERID', 'jiahongjia');
    const doc = await this.taskModel.create({
      taskId,
      dataId: dto.dataId || '',
      phone,
      name: dto.name || '',
      position: dto.position || '',
      interviewer: dto.interviewer || '',
      interviewTime: dto.interviewTime || '',
      hrBotUserId,
      status: ReachStatus.ADDING,
      timeline: [{ at: new Date(), event: 'CREATE', detail: `建任务，约面时间=${dto.interviewTime || '未填'}` }],
    });

    // 打招呼(加好友申请语)只做简单自我介绍；欢迎语(带约面时间+请确认)在好友通过后单独发
    const hello = this.config.get('HELLO_MSG', '你好，我是句子互动招聘助理，看到你投递的简历，想加你了解一下~');
    const res = await this.miaohui.addFriendByPhone(phone, hello, { extraInfo: taskId, userId: hrBotUserId });
    if (!res.ok) {
      doc.status = ReachStatus.ADD_FAILED;
      await doc.save();
      await this.appendTimeline(taskId, 'ADD_FAILED', `发起加好友失败 code=${res.code}`);
      await this.requestHandover(doc, 'SEND_FAILED', `加好友请求发送失败(code=${res.code})`);
      await this.backfillProgress(doc, `触达失败：加好友请求发送失败(code=${res.code})`, 'ADD_FAILED');
      return { ok: false, taskId, msg: '加好友发起失败', code: res.code };
    }
    await this.appendTimeline(taskId, 'ADD_SENT', `已发起加好友 code=${res.code}`);
    return { ok: true, taskId, status: ReachStatus.ADDING };
  }

  // ───────────────────────── ①.5 反向转人工开关（表格 → 触达）─────────────────────────
  /** 表格服务同步进度表【转人工】字段 → 按 dataId 更新任务。
   *  true=此后候选人消息 AI 一律不接待(onMessage 静默)，由 HR 真人跟进；false=恢复 AI 接待。 */
  async setHandover(dataId: string, handover: boolean) {
    if (!dataId) return { ok: false, msg: '缺 dataId' };
    const task = await this.taskModel.findOne({ dataId }).sort({ createdAt: -1 }).exec();
    if (!task) return { ok: false, msg: `未找到 dataId=${dataId} 的任务` };
    if (task.humanTakeover === handover) return { ok: true, taskId: task.taskId, unchanged: true };
    task.humanTakeover = handover;
    await task.save();
    await this.appendTimeline(task.taskId, handover ? 'HANDOVER_ON' : 'HANDOVER_OFF',
      handover ? '表格勾选转人工：AI 停止接待，HR 真人跟进' : '表格取消转人工：恢复 AI 接待');
    this.logger.log(`[转人工] ${task.name || task.phone} → ${handover ? '人工接管' : '恢复AI'}`);
    return { ok: true, taskId: task.taskId, humanTakeover: handover };
  }

  // ───────────────────────── ② 秒回回调分发 ─────────────────────────
  /** 统一回调入口。按 body 字段分发：friend/confirm、friend/send、sentResult。 */
  async handleCallback(body: any) {
    // ⚠️ 秒回小组级回调字段都在 data 下：body = { code, data: {...} }（见 known-everything 回调文档）
    const d = body?.data || body;
    this.logger.log(`[mh回调] 收到回调 keys=${Object.keys(d || {}).join(',')} isSelf=${d?.isSelf} contactId=${d?.contactId || ''} wxid=${d?.wxid || ''} sentStatus=${d?.sentStatus}`);
    // 回调来源校验：回调 body.data.token 是小组级 token，须与配置的 MIAOHUI_GROUP_TOKEN 一致
    const groupToken = this.config.get('MIAOHUI_GROUP_TOKEN');
    if (groupToken && d?.token && d.token !== groupToken) {
      this.logger.warn('[mh回调] token 不匹配，忽略该回调');
      return;
    }
    const id = d?.messageId || d?.requestId || body?.eventId;
    try {
      // 接收消息回调（候选人回复，data.isSelf + data.contactId）→ 服务主导对话（已弃用秒懂画布）
      if (d?.isSelf !== undefined && d?.contactId) return await this.onMessage(d, id);
      // 发送消息结果回调：带 sentStatus
      if (d?.sentStatus !== undefined) return await this.onSentResult(d, id);
      // 加好友任务结果回调：带 createTimestamp（区别于好友通过，两者都有 code+phoneNum+extraInfo）
      if (d?.createTimestamp !== undefined && d?.code !== undefined) return await this.onFriendSend(d, id);
      // 好友通过回调：带 wxid + phoneNum + externalUserId
      if (d?.wxid && d?.phoneNum) return await this.onFriendConfirm(d, id);
      this.logger.log(`[mh回调] 未识别类型 keys=${Object.keys(d || {}).join(',')}`);
    } catch (e: any) {
      this.logger.error(`[mh回调] 处理异常: ${e?.message}`);
    }
  }

  // ───────────────────────── ③ 服务主导对话（收消息）─────────────────────────
  /**
   * 候选人消息回调入口（服务主导，已弃用秒懂画布）。
   * 好友通过后首条消息 → 发带时间欢迎语；之后的回复 → 大模型意图分类 → 回复+建日程+通知HR+回填。
   */
  private async onMessage(d: any, id?: string) {
    if (d?.isSelf === true) return; // 自己发的消息忽略
    const chatId = (d?.chatId || '').toString();
    const extId = (d?.externalUserId || d?.contactId || '').toString().trim();
    if (!extId) return;
    if (id && !(await this.lock(`mh:msg:${id}`))) return; // 同消息只处理一次
    const task = await this.taskModel
      .findOne({ $or: [{ externalUserId: extId }, { wxid: extId }, { chatId }] })
      .sort({ createdAt: -1 }).exec();
    if (!task) { this.logger.log(`[消息] 未匹配触达任务 extId=${extId}`); return; }
    if (chatId && task.chatId !== chatId) { task.chatId = chatId; await task.save(); }
    // 转人工中：AI 一律不接待，候选人消息由 HR 真人在企微跟进，只留痕
    if (task.humanTakeover) {
      this.logger.log(`[消息] ${task.name || task.phone} 已转人工，AI 不接待`);
      await this.appendTimeline(task.taskId, 'MSG_SKIP_HANDOVER', '转人工中，候选人消息由真人处理');
      return;
    }
    // 好友通过后首条消息 → 发欢迎语（这条通常是加好友打招呼回执，不当作候选人意图）
    if (task.status === ReachStatus.CONFIRMED || task.status === ReachStatus.ADDING) {
      await this.sendWelcome(task);
      return;
    }
    const text = this.extractMsgText(d);
    if (!text) return;
    await this.handleReply(task, text);
  }

  /** 好友通过后发带时间欢迎语（用 task.chatId 经秒回 /message/send 发） */
  private async sendWelcome(task: ReachTaskDocument) {
    const welcome = buildInviteMessage(task.name, task.position, task.interviewTime, this.config.get('WELCOME_TEMPLATE'));
    if (task.chatId) {
      const r = await this.miaohui.sendText(task.chatId, welcome);
      this.logger.log(`[欢迎语] ${task.name || task.phone} ok=${r.ok} code=${r.code}`);
    } else {
      this.logger.warn(`[欢迎语] task ${task.taskId} 无 chatId，跳过`);
    }
    task.status = ReachStatus.WELCOMED;
    await task.save();
    await this.appendTimeline(task.taskId, 'WELCOMED', '已发带时间欢迎语');
  }

  /** 候选人回复 → 大模型意图分类 → 回复 + 建日程 + 通知HR + 回填 */
  private async handleReply(task: ReachTaskDocument, text: string) {
    const intent = await this.llm.classifyIntent(text);
    const given = extractTime(text);
    let reply = ''; let status: ReachStatus = ReachStatus.REPLIED; let note = '';
    let meetingLink = task.meetingLink || '';
    switch (intent) {
      case 'TIME': {
        status = ReachStatus.INTENT_ACCEPT;
        if (!meetingLink) meetingLink = await this.scheduleInterview(task, given ? { time: given } : {});
        const timeText = given || formatInterviewTimeText(task.interviewTime);
        reply = `好的，面试就约在【${timeText}】啦~ 线上视频形式${meetingLink ? `，会议链接：${meetingLink}` : '，会议链接稍后发您'}。到时见~`;
        note = `候选人确认面试时间【${timeText}】`;
        break;
      }
      case 'RESCHEDULE':
        status = ReachStatus.INTENT_RESCHEDULE;
        reply = '没问题~ 您方便的时间段是？告诉我大致日期和上午/下午，我帮您协调面试官时间。';
        note = '候选人想改期，待HR协调';
        break;
      case 'REJECT':
        status = ReachStatus.INTENT_REJECT;
        reply = '好的，完全理解~ 感谢您的关注，后续有更合适的机会我再联系您。祝一切顺利！';
        note = '候选人婉拒，流程关闭';
        break;
      case 'QUESTION':
        status = ReachStatus.INTENT_QUESTION;
        reply = await this.llm.answer(text);
        note = `候选人提问：${text.slice(0, 30)}`;
        break;
      default:
        status = ReachStatus.REPLIED;
        reply = await this.llm.answer(text);
        note = '';
    }
    if (task.chatId && reply) await this.miaohui.sendText(task.chatId, reply);
    task.intent = intent;
    if (intent !== 'QUESTION') task.status = status;
    else if (task.status === ReachStatus.WELCOMED) task.status = ReachStatus.REPLIED;
    await task.save();
    await this.appendTimeline(task.taskId, `INTENT_${intent}`, given || '');
    const who = task.name || task.phone;
    // 确认→通知HR；改约/拒绝/知识库答不上→转人工（表格服务置「转人工=是」+通知HR）
    if (status === ReachStatus.INTENT_ACCEPT) {
      await this.notifyHr(`✅【候选人确认】${who} 确认面试${given ? `：${given}` : ''}${meetingLink ? `\n会议链接：${meetingLink}` : ''}`);
    } else if (status === ReachStatus.INTENT_RESCHEDULE) {
      await this.requestHandover(task, 'RESCHEDULE', '候选人想改约，需HR协调新时间', text);
    } else if (status === ReachStatus.INTENT_REJECT) {
      await this.requestHandover(task, 'REJECT', '候选人婉拒本次面试', text);
    } else if (intent === 'QUESTION' && /转人工/.test(reply)) {
      await this.requestHandover(task, 'KB_MISS', `候选人问到知识库未覆盖的问题：${text.slice(0, 40)}`, text);
    }
    await this.backfillProgress(task, note || `候选人意图=${intent}`, `INTENT_${intent}`);
  }

  /** 从消息回调提取文本内容 */
  private extractMsgText(d: any): string {
    if (typeof d?.text === 'string' && d.text) return d.text;
    const p = d?.payload;
    if (typeof p === 'string') return p;
    if (p && typeof p === 'object') return p.text || p.content || p.msg || '';
    return '';
  }

  /** 好友通过：status=CONFIRMED，存 wxid/externalUserId。
   *  ⚠️ 限制：只处理【本系统发起】的加好友（extraInfo=本系统 taskId）。
   *  HR 手动加 / 候选人主动加 / 别的系统加的好友没有 extraInfo，一律不触发约面逻辑。 */
  private async onFriendConfirm(body: any, id?: string) {
    const key = `mh:confirm:${id || body.wxid || body.phoneNum}`;
    if (!(await this.lock(key))) return;
    const extraInfo = (body?.extraInfo || '').trim();
    const task = extraInfo ? await this.taskModel.findOne({ taskId: extraInfo }).exec() : null;
    if (!task) {
      this.logger.log(`[friend/confirm] 非本系统触达（extraInfo=${extraInfo || '无'}），不触发约面 phone=${body.phoneNum}`);
      return;
    }
    task.status = ReachStatus.CONFIRMED;
    task.wxid = body.wxid || task.wxid;
    task.externalUserId = body.externalUserId || body.externalUserid || task.externalUserId;
    await task.save();
    await this.appendTimeline(task.taskId, 'CONFIRMED', `好友通过 wxid=${task.wxid}`);
    this.logger.log(`[friend/confirm] ${task.name || task.phone} 好友已通过`);
  }

  /** 加好友结果：code=1 失败 → ADD_FAILED + 通知HR */
  private async onFriendSend(body: any, id?: string) {
    const key = `mh:friendsend:${id || body.extraInfo || body.phoneNum}`;
    if (!(await this.lock(key))) return;
    const task = await this.findTask(body);
    if (!task) { this.logger.warn(`[friend/send] 未找到任务 phone=${body.phoneNum} extraInfo=${body.extraInfo}`); return; }
    if (body.code === 1) {
      task.status = ReachStatus.ADD_FAILED;
      await task.save();
      await this.appendTimeline(task.taskId, 'ADD_FAILED', `加好友失败 errorCode=${body.errorCode ?? body.code}`);
      await this.requestHandover(task, 'SEND_FAILED', `加好友未成功(errorCode=${body.errorCode ?? body.code})`);
      await this.backfillProgress(task, `触达失败：加好友未成功(errorCode=${body.errorCode ?? body.code})`, 'ADD_FAILED');
    } else {
      await this.appendTimeline(task.taskId, 'ADD_OK', `加好友请求已受理 code=${body.code}`);
    }
  }

  /** 发送结果：sentStatus=false 失败 → 通知HR */
  private async onSentResult(body: any, id?: string) {
    const key = `mh:sent:${id || body.externalRequestId || body.phoneNum}`;
    if (!(await this.lock(key))) return;
    const task = await this.findTask(body);
    const who = task ? (task.name || task.phone) : (body.phoneNum || '某候选人');
    if (body.sentStatus === false) {
      if (task) {
        await this.appendTimeline(task.taskId, 'SEND_FAILED', `发消息失败 ${body.reason || ''}`);
        await this.requestHandover(task, 'SEND_FAILED', `给候选人发送消息失败 ${body.reason || ''}`);
      } else {
        await this.notifyHr(`⚠️【发送失败】给 ${who} 发送消息失败，请HR关注。`);
      }
    } else if (task) {
      await this.appendTimeline(task.taskId, 'SEND_OK', '消息已送达');
    }
  }

  // ───────────────────────── ③ 画布 plugin：查约面信息 ─────────────────────────
  /**
   * 好友通过后画布发欢迎语用。返回结构化字段 + 拼好的 welcome 文本（画布直接发，话术确定性）。
   * externalId：画布传来的 wecomContactId/externalUserId，存入任务作关联键，供后续意图回报匹配。
   */
  async getCandidateInfo(phone: string, externalId?: string): Promise<{ found: boolean; name?: string; position?: string; interviewTime?: string; welcome?: string }> {
    const task = await this.taskModel.findOne({ phone: (phone || '').trim() }).sort({ createdAt: -1 }).exec();
    if (!task) return { found: false };
    let dirty = false;
    // 关联键：画布带来的 contactId 存下，后面 report-intent 按它匹配任务（秒回回调缺失时的兜底）
    const ext = (externalId || '').trim();
    if (ext && task.externalUserId !== ext) { task.externalUserId = ext; dirty = true; }
    // 命中即认为欢迎语链已触发，推进到 WELCOMED（幂等：仅从 CONFIRMED/ADDING 推进）
    if (task.status === ReachStatus.CONFIRMED || task.status === ReachStatus.ADDING) {
      task.status = ReachStatus.WELCOMED;
      dirty = true;
      await this.appendTimeline(task.taskId, 'WELCOMED', `画布取约面信息发欢迎语${ext ? ` contactId=${ext}` : ''}`);
    }
    if (dirty) await task.save();
    const welcome = buildInviteMessage(task.name, task.position, task.interviewTime);
    return { found: true, name: task.name, position: task.position, interviewTime: task.interviewTime, welcome };
  }

  // ───────────────────────── ④ 画布 plugin：意图回报 ─────────────────────────
  /** 画布识别意图后回报：更新 status=INTENT_xxx + 回填进度表 + 通知HR。 */
  async reportIntent(externalId: string, intent: string, slots?: Record<string, any>) {
    const id = (externalId || '').trim();
    // 画布(receive-text-message)回报的是 contactId；触达任务好友通过时存了 externalUserId/wxid。
    // 灵活匹配这三个字段（联调用真实回调样例确认 contactId 具体等于 externalUserId 还是 wxid）。
    const task = await this.taskModel.findOne({ $or: [{ externalUserId: id }, { wxid: id }, { phone: id }] }).sort({ createdAt: -1 }).exec();
    if (!task) return { ok: false, msg: `未找到 ${id} 的触达任务` };

    const status = INTENT_STATUS[(intent || '').toUpperCase()] || INTENT_STATUS[intent] || ReachStatus.REPLIED;
    task.intent = intent;
    if (slots) task.intentSlots = slots;
    // 提问不改主状态（答疑不打扰HR）
    if (status !== ReachStatus.INTENT_QUESTION) task.status = status;
    else if (task.status === ReachStatus.WELCOMED) task.status = ReachStatus.REPLIED;
    await task.save();
    await this.appendTimeline(task.taskId, `INTENT_${intent}`, slots ? JSON.stringify(slots) : undefined);

    // 确认约面：在 HR 飞书日历建带视频会议的面试日程，拿会议链接（失败不阻断）
    let meetingLink = task.meetingLink || '';
    if (status === ReachStatus.INTENT_ACCEPT && !meetingLink) {
      meetingLink = await this.scheduleInterview(task, slots);
    }

    // 同步HR：确认/改约/拒绝/转人工才通知；提问不打扰
    const slotTime = slots?.time || slots?.interviewTime || '';
    const notifyMap: Record<string, string> = {
      [ReachStatus.INTENT_ACCEPT]: `✅【候选人已确认】${task.name || id} 确认约面${slotTime ? `：${slotTime}` : ''}。${meetingLink ? `\n面试会议链接：${meetingLink}` : ''}`,
      [ReachStatus.INTENT_RESCHEDULE]: `🔄【候选人要改约】${task.name || id} 希望调整面试时间${slotTime ? `：${slotTime}` : ''}，请HR协调。`,
      [ReachStatus.INTENT_REJECT]: `🚫【候选人拒绝】${task.name || id} 婉拒本次面试，流程关闭。`,
      [ReachStatus.HANDOVER]: `👤【转人工】${task.name || id} 需真人跟进，请HR接手。`,
    };
    const msg = notifyMap[status];
    if (msg) await this.notifyHr(msg);
    await this.backfillProgress(task, `候选人意图=${intent}${slotTime ? `(${slotTime})` : ''}`);
    return { ok: true, taskId: task.taskId, status: task.status, meetingLink };
  }

  /**
   * 候选人确认约面后，在 HR 飞书日历创建带视频会议的面试日程。
   * 取值优先级：slots.time/interviewTime > task.interviewTime。解析不了则跳过建日程（记 warning）。
   * 建日程失败/无 HR_EMAIL 均不阻断，返回空链接。成功则把 meetingLink/eventId 存入 task。
   */
  private async scheduleInterview(task: ReachTaskDocument, slots?: Record<string, any>): Promise<string> {
    const raw = (slots?.time || slots?.interviewTime || task.interviewTime || '').toString();
    const start = parseInterviewTime(raw);
    if (start == null) {
      this.logger.warn(`[约面日程] 无法解析约面时间「${raw}」，跳过建日程 task=${task.taskId}`);
      await this.appendTimeline(task.taskId, 'SCHEDULE_SKIP', `约面时间无法解析：${raw}`);
      return '';
    }
    // 选面试官 HR：按面试官姓名查名录拿邮箱/openId，回退全局 HR_EMAIL
    const { email: hrEmail, openId: hrOpenId, interviewer } = await this.resolveHr(task);
    if (!hrEmail && !hrOpenId) {
      this.logger.warn(`[约面日程] 未匹配到 HR（面试官=${interviewer || '未知'}）且无 HR_EMAIL，跳过建日程 task=${task.taskId}`);
      await this.appendTimeline(task.taskId, 'SCHEDULE_SKIP', `未匹配到 HR（面试官=${interviewer || '未知'}）`);
      return '';
    }
    const end = start + 60 * 60 * 1000; // 结束=开始+1小时
    try {
      const { eventId, meetingUrl } = await this.feishu.createInterviewEvent({
        hrEmail,
        hrOpenId,
        summary: `面试-${task.name || task.phone}-${task.position || '岗位待定'}`,
        startTime: start,
        endTime: end,
        description: `候选人：${task.name || ''}（${task.phone}）\n岗位：${task.position || ''}\n面试官：${interviewer || '（未指定）'}`,
      });
      task.meetingLink = meetingUrl || '';
      task.scheduleEventId = eventId || '';
      await task.save();
      await this.appendTimeline(task.taskId, 'SCHEDULE_OK', `建面试日程 event=${eventId} 会议链接=${meetingUrl || '(空)'}`);
      return meetingUrl || '';
    } catch (e: any) {
      this.logger.error(`[约面日程] 建日程失败 task=${task.taskId}: ${e?.message}`);
      await this.appendTimeline(task.taskId, 'SCHEDULE_FAILED', e?.message);
      return '';
    }
  }

  /**
   * 解析该任务应约给哪个 HR。
   * 面试官姓名：task.interviewer 优先，空则查进度表「一面面试官」。
   * 有面试官 → 查 HR 名录拿 {email, openId}；名录无此人则回退全局 HR_EMAIL。
   */
  private async resolveHr(task: ReachTaskDocument): Promise<{ email: string; openId: string; interviewer: string }> {
    // 面试官只来自 task.interviewer（表格服务经 /reach 传入），触达服务不再查飞书表格
    const interviewer = (task.interviewer || '').trim();
    if (interviewer) {
      const m = await this.hr.findByName(interviewer);
      if (m && (m.email || m.openId)) return { email: m.email || '', openId: m.openId || '', interviewer };
      this.logger.warn(`[约面日程] HR 名录无面试官「${interviewer}」，回退全局 HR_EMAIL`);
    }
    return { email: this.config.get('HR_EMAIL'), openId: '', interviewer };
  }

  // ───────────────────────── 公共：定位/通知/回填 ─────────────────────────
  /** 按 extraInfo(taskId) 优先，回退 phone 定位任务 */
  private async findTask(body: any): Promise<ReachTaskDocument | null> {
    if (body?.extraInfo) {
      const t = await this.taskModel.findOne({ taskId: body.extraInfo }).exec();
      if (t) return t;
    }
    if (body?.phoneNum) {
      return this.taskModel.findOne({ phone: body.phoneNum }).sort({ createdAt: -1 }).exec();
    }
    return null;
  }

  /** 飞书通知HR（HR_NOTIFY_CHAT） */
  private async notifyHr(text: string) {
    const chat = this.config.get('HR_NOTIFY_CHAT');
    if (!chat) { this.logger.warn(`未配置 HR_NOTIFY_CHAT，跳过通知：${text}`); return; }
    try { await this.feishu.sendText(chat, text); }
    catch (e: any) { this.logger.error(`通知HR失败: ${e?.message}`); }
  }

  /** 回填进度：改调表格服务（触达服务不再直接写飞书多维表格） */
  private async backfillProgress(task: ReachTaskDocument, note: string, event = '') {
    if (this.dry) { this.logger.log(`[DRY] 回填 ${task.phone} [${event || task.status}] ${note}`); return; }
    await this.table.backfill({
      dataId: task.dataId, phone: task.phone, event: event || task.status, note,
      status: task.status, interviewTime: task.interviewTime, meetingLink: task.meetingLink,
    });
  }

  /** 转人工：通知表格服务标记「转人工=是」+ 飞书通知HR。触达服务判定需人工时调用 */
  private async requestHandover(task: ReachTaskDocument, reason: string, reasonText: string, candidateReply?: string) {
    await this.table.handover({ dataId: task.dataId, phone: task.phone, reason, reasonText, candidateReply });
    await this.notifyHr(`👤【转人工·${reason}】${task.name || task.phone}：${reasonText}${candidateReply ? `\n候选人原话：${candidateReply}` : ''}`);
  }
}
