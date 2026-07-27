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
  wxid?: string;        // 联系方式是微信号时传(HR人工校正场景)：按微信号搜索加友，跳过手机号校验
  round?: string;       // 面试轮次：一面(默认)/二面/三面，话术按轮次说话
  evalDoc?: string;     // 面评文档链接(表格「面试评价」)，建日程时放进日程描述
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
export function buildInviteMessage(name?: string, position?: string, interviewTimeRaw?: string, template?: string, round?: string): string {
  const timeText = formatInterviewTimeText(interviewTimeRaw);
  const pos = position || '相关';
  const nm = name || '您';
  const rd = round || '一面';
  const tpl = template && template.trim()
    ? template
    : '{name}您好~ 我是句子互动招聘助理😊 您应聘的【{position}】岗位，{round}初步约在 {time}。方便的话回复「可以」确认；如需调整，回复您方便的时间就好~';
  return tpl.replace(/\{name\}/g, nm).replace(/\{position\}/g, pos).replace(/\{time\}/g, timeText).replace(/\{round\}/g, rd);
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

/** 候选人时间表达 → 槽位 {date(哪天), part(半天), clock(钟点)}。full=有日期+至少半天粒度。
 *  比 extractTime 宽:「周五下午」「明天」这类没钟点的也抓得到(改期收集要按槽位追问)。 */
export function extractTimeSlot(text: string): { date?: string; part?: string; clock?: string; full: boolean; raw: string } {
  const t = (text || '').replace(/\s+/g, '');
  const date = t.match(/(今天|明天|后天|大后天|下下?周[一二三四五六日天]|周[一二三四五六日天]|礼拜[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|\d{1,2}[日号])/)?.[1];
  const part = t.match(/(上午|下午|中午|晚上|早上|傍晚)/)?.[1];
  const clock = extractTime(t);
  const raw = [date && !(clock || '').includes(date) ? date : '', part && !(clock || '').includes(part) ? part : '', clock].filter(Boolean).join('');
  return { date, part, clock, full: !!(date && (part || clock)), raw };
}

/** 候选人给的时间和当前约定时间是否算"同一场"（同一天且钟点不冲突→确认;否则→改期提案） */
export function sameAsScheduled(slot: ReturnType<typeof extractTimeSlot>, interviewTimeRaw?: string): boolean {
  const ms = parseInterviewTime(interviewTimeRaw);
  if (ms == null) return !slot.date && !slot.clock; // 原时间都没定:候选人没给新时间才算"确认"
  const d = new Date(ms + 8 * 3600 * 1000);
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  const sameDay = !slot.date
    || slot.date === `周${days[d.getUTCDay()]}` || slot.date === `礼拜${days[d.getUTCDay()]}`
    || slot.date === `${d.getUTCMonth() + 1}月${d.getUTCDate()}日` || slot.date === `${d.getUTCMonth() + 1}月${d.getUTCDate()}号`;
  if (!sameDay) return false;
  if (slot.clock) {
    const hh = parseInt(slot.clock.match(/(\d{1,2})[:：点时]/)?.[1] || '-1', 10);
    let sch = d.getUTCHours();
    const cand12 = hh < 12 && (slot.clock.includes('下午') || slot.clock.includes('晚上')) ? hh + 12 : hh;
    return cand12 === sch || hh === sch || (sch > 12 && hh === sch - 12);
  }
  if (slot.part) {
    const sch = d.getUTCHours();
    const map: Record<string, [number, number]> = { 早上: [6, 10], 上午: [6, 12], 中午: [11, 14], 下午: [12, 19], 傍晚: [17, 20], 晚上: [18, 23] };
    const rg = map[slot.part];
    return !!rg && sch >= rg[0] && sch <= rg[1];
  }
  return true; // 只说"可以/好的"没带任何时间
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
  // 防抖:候选人连发多条 → 攒几秒合并成一段再理解、只回一条连贯的(治"串行乱回")
  private readonly msgBuffer = new Map<string, { texts: string[]; timer: NodeJS.Timeout }>();
  private readonly DEBOUNCE_MS = 4000;
  // 记下"我们(AI)发给候选人的消息文本",用于在 isSelf 回调时区分"AI 自己发的回声"vs"真人 HR 打的"→ 真人打的自动转人工。
  // 按文本匹配(不带 chatId):宁可漏检真人(AI继续回,顶多多聊两句),也别误把 AI 回声当真人 → 误停 AI。
  private readonly recentSends = new Map<string, number>();  // key=文本前60字, value=时间戳
  private sk(text: string) { return (text || '').trim().slice(0, 60); }
  /** 统一的给候选人发消息:发前记一笔(用于回声识别),再真发。所有 AI→候选人的消息都走这里。 */
  private async sendCandidate(chatId: string, text: string) {
    if (!chatId || !text) return { ok: false, code: -97 } as any;
    const now = Date.now();
    this.recentSends.set(this.sk(text), now);
    if (this.recentSends.size > 500) for (const [k, t] of this.recentSends) if (now - t > 300_000) this.recentSends.delete(k);
    return this.miaohui.sendText(chatId, text);
  }
  /** 这条 isSelf 消息是不是我们 AI 刚发的回声(5 分钟内发过一样的文本)。 */
  private isOurSend(text: string): boolean {
    const t = this.recentSends.get(this.sk(text));
    return !!t && Date.now() - t < 300_000;
  }
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
    // 联系方式=「能联系上候选人的微信号」：默认手机号即微信号；HR 人工校正后可能是微信号(wxid)。
    // 企微加好友本就支持手机号/微信号搜索，两种都把值当搜索词发给秒回。
    const wxid = (dto.wxid || '').trim();
    const phone = (dto.phone || '').trim();
    const contact = wxid || phone;
    if (!wxid && !/^1[3-9]\d{9}$/.test(phone)) return { ok: false, msg: '缺少或非法手机号 phone(微信号请传 wxid)' };
    if (!contact) return { ok: false, msg: '缺少联系方式' };

    // 幂等：同号短时间内只建一次任务
    if (!(await this.lock(`reach:create:${contact}`, 60))) {
      return { ok: false, msg: '该联系方式触达刚发起过，请勿重复', duplicate: true };
    }
    // 重新触达：清掉该号旧任务，保证一个号同时只有一条活跃触达，避免好友通过/消息回调关联到旧任务
    const removed = await this.taskModel.deleteMany({ $or: [{ phone: contact }, { phone }, ...(dto.dataId ? [{ dataId: dto.dataId }] : [])] }).exec();
    if (removed.deletedCount) this.logger.log(`[触达] ${contact} 清理旧任务 ${removed.deletedCount} 条后重新触达`);

    const taskId = `RT${Date.now()}${Math.floor(Math.random() * 1000)}`;
    // 加好友托管号：只从 HR 名录按面试官取 userId(秒回 botId)。名录没有该面试官则自动新增一条(供中台补配)，不再用全局默认。
    const _interviewer = (dto.interviewer || '').trim();
    let hrBotUserId = '';
    if (_interviewer) {
      const _hr = await this.hr.findOrCreate(_interviewer);
      hrBotUserId = (_hr.userId || '').trim();
    }
    const doc = await this.taskModel.create({
      taskId,
      dataId: dto.dataId || '',
      phone: contact,
      name: dto.name || '',
      position: dto.position || '',
      interviewer: dto.interviewer || '',
      interviewTime: dto.interviewTime || '',
      round: dto.round || '一面',
      evalDoc: dto.evalDoc || '',
      hrBotUserId,
      status: ReachStatus.ADDING,
      timeline: [{ at: new Date(), event: 'CREATE', detail: `建任务(${dto.round || '一面'})，联系方式=${wxid ? '微信号' : '手机号'}，约面时间=${dto.interviewTime || '未填'}` }],
    });

    // 托管号未配置(面试官不在名录/名录没填 botId)：不再用全局默认，直接失败并提示去中台配置(名录已自动新增该面试官)。
    if (!hrBotUserId) {
      const who = _interviewer || '未指定面试官';
      doc.status = ReachStatus.ADD_FAILED;
      await doc.save();
      await this.appendTimeline(taskId, 'ADD_FAILED', `面试官「${who}」未配置秒回托管号(botId)`);
      await this.requestHandover(doc, 'SEND_FAILED', `面试官「${who}」在 HR 名录里没配秒回托管号(botId)，已自动加进名录，请去中台 HR 名录补上 botId 后重试`);
      await this.backfillProgress(doc, `触达失败：面试官「${who}」未配置秒回托管号`, 'ADD_FAILED');
      this.logger.warn(`[触达] ${contact} 面试官「${who}」无秒回托管号，已建名录待配，不发起加好友`);
      return { ok: false, taskId, msg: '面试官未配置秒回托管号(botId)，请在中台 HR 名录配置', needConfig: true };
    }

    // 打招呼(加好友申请语)只做简单自我介绍；欢迎语(带约面时间+请确认)在好友通过后单独发
    const hello = this.config.get('HELLO_MSG', '你好，我是句子互动招聘助理，看到你投递的简历，想加你了解一下~');
    const res = await this.miaohui.addFriendByPhone(contact, hello, { extraInfo: taskId, userId: hrBotUserId });
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

  // ───────────────────────── ①.6 改期直推（表格 → 触达）─────────────────────────
  /** 表格服务在面试时间被改后调用：直接给已绑定会话的候选人推新时间(不重走加好友)。
   *  {dataId?|phone?, interviewTime, round?}。没绑定会话(还没聊过)返回 ok:false,表格服务自行退回重触达。 */
  async notifyTimeChange(dataId: string, phone: string, interviewTime: string, round?: string) {
    let task = dataId ? await this.taskModel.findOne({ dataId }).sort({ createdAt: -1 }).exec() : null;
    if (!task && phone) task = await this.taskModel.findOne({ phone }).sort({ createdAt: -1 }).exec();
    if (!task) return { ok: false, msg: '找不到触达任务' };
    if (!task.chatId) return { ok: false, msg: '候选人未绑定会话(还没聊过),无法直发,请退回重触达' };
    const rd = round || task.round || '一面';
    const timeText = formatInterviewTimeText(interviewTime);
    const text = `${task.name || '您'}您好~ 跟您同步一下：您的${rd}面试时间调整为【${timeText}】。方便的话回复「可以」确认；如有冲突，回复您方便的时间就好~`;
    const r = await this.sendCandidate(task.chatId, text);
    if (!r.ok) return { ok: false, msg: `发送失败 code=${r.code}` };
    task.interviewTime = interviewTime;
    task.round = rd;
    task.status = ReachStatus.WELCOMED;  // 回到"已发邀约待确认"态,候选人回复走原意图链
    // 已建过日程的:同步移动日历日程到新时间(玄玄需求:面试官同意后同步更新日历日程)
    if (task.scheduleEventId) {
      const start = parseInterviewTime(interviewTime);
      if (start != null) {
        const moved = await this.feishu.updateInterviewEventTime(task.scheduleEventId, start, start + 30 * 60 * 1000);
        await this.appendTimeline(task.taskId, moved ? 'SCHEDULE_MOVED' : 'SCHEDULE_MOVE_FAIL', `日程改到 ${timeText}`);
      }
    }
    await task.save();
    await this.appendTimeline(task.taskId, 'RESCHEDULE_NOTIFY', `已推送${rd}改期:${timeText}`);
    this.logger.log(`[改期直推] ${task.name || task.phone} ${rd}→${timeText}`);
    return { ok: true, taskId: task.taskId };
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
    // 【观测】全量打印秒回推送原文，用于确认不同推送的真实结构（token 脱敏）
    try {
      const safe = JSON.parse(JSON.stringify(body));
      if (safe?.data?.token) safe.data.token = '***';
      if (safe?.token) safe.token = '***';
      this.logger.log(`[mh回调·原文] ${JSON.stringify(safe)}`);
    } catch { /* ignore */ }
    // 回调来源校验：回调 body.data.token 是小组级 token，须与配置的 MIAOHUI_GROUP_TOKEN 一致
    const groupToken = this.config.get('MIAOHUI_GROUP_TOKEN');
    if (groupToken && d?.token && d.token !== groupToken) {
      this.logger.warn('[mh回调] token 不匹配，忽略该回调');
      return;
    }
    const id = d?.messageId || d?.requestId || body?.eventId;
    // 【观测】识别推送类型（与下方分发判据一致），便于确认分类是否正确
    // 加好友结果回调:code 在顶层 body.code(非 data 内),data 里带 errorCode/message,标识用 errorCode 或 fromwxid。
    // 好友通过回调:data 带 externalUserId + wxid。两者都有 createTimestamp/phoneNum,靠 errorCode/externalUserId 区分。
    const isFriendSend = (d?.errorCode !== undefined) || (body?.code !== undefined && d?.fromwxid !== undefined && d?.externalUserId === undefined && d?.contactId === undefined);
    let type = 'UNKNOWN(未识别)';
    if (d?.isSelf !== undefined && d?.contactId) type = 'MESSAGE(收到消息)';
    else if (d?.sentStatus !== undefined) type = 'SENT_RESULT(发送结果)';
    else if (d?.externalUserId && d?.wxid && d?.phoneNum) type = 'FRIEND_CONFIRM(好友通过)';
    else if (isFriendSend) type = 'FRIEND_SEND(加好友结果)';
    this.logger.log(`[mh回调·识别] 类型=${type} isSelf=${d?.isSelf} contactType=${d?.contactType} msgType=${d?.messageType ?? d?.type} contactId=${d?.contactId || ''} wxid=${d?.wxid || ''} chatId=${d?.chatId || ''} msgId=${d?.messageId || ''} 文本=${JSON.stringify(this.extractMsgText(d)).slice(0, 60)}`);
    try {
      // 接收消息回调（候选人回复，data.isSelf + data.contactId）→ 服务主导对话（已弃用秒懂画布）
      if (d?.isSelf !== undefined && d?.contactId) return await this.onMessage(d, id);
      // 发送消息结果回调：带 sentStatus
      if (d?.sentStatus !== undefined) return await this.onSentResult(d, id);
      // 好友通过回调：data 带 externalUserId + wxid + phoneNum（先于加好友结果判断，避免误分）
      if (d?.externalUserId && d?.wxid && d?.phoneNum) return await this.onFriendConfirm(d, id);
      // 加好友结果回调：code 在顶层 body.code，data 带 errorCode/message；把顶层 code 并进 d 传给处理器
      if (isFriendSend) return await this.onFriendSend({ ...d, code: body?.code ?? d?.code }, id);
      this.logger.log(`[mh回调] 未识别类型 keys=${Object.keys(d || {}).join(',')} bodyCode=${body?.code}`);
    } catch (e: any) {
      this.logger.error(`[mh回调] 处理异常: ${e?.message}`);
    }
  }

  // ───────────────────────── ③ 服务主导对话（收消息）─────────────────────────
  /**
   * 候选人消息回调入口（服务主导，已弃用秒懂画布）。
   * 好友通过后首条消息 → 发带时间欢迎语；之后的回复 → 大模型意图分类 → 回复+建日程+通知HR+回填。
   */
  /** 是否在工作时间(北京时 9:00-22:00);外面不触答/不聊天(玄玄需求:别半夜骚扰候选人)。 */
  private inWorkHours(): boolean {
    const h = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
    return h >= 9 && h < 22;
  }

  private async onMessage(d: any, id?: string) {
    const chatId = (d?.chatId || '').toString();
    const extId = (d?.externalUserId || d?.contactId || '').toString().trim();
    if (!extId) return;
    if (id && !(await this.lock(`mh:msg:${id}`))) return; // 同消息只处理一次
    const task = await this.taskModel
      .findOne({ $or: [{ externalUserId: extId }, { wxid: extId }, { chatId }] })
      .sort({ createdAt: -1 }).exec();
    if (!task) { this.logger.log(`[消息] 未匹配触达任务 extId=${extId}`); return; }
    if (chatId && task.chatId !== chatId) { task.chatId = chatId; await task.save(); }
    // isSelf=托管号自己发的:可能是 AI 的回声,也可能是真人 HR 在秒回工作台手动回了候选人。
    // 不是我们AI发的回声 → 真人回了 → 自动切转人工(玄玄需求13:00),之后 AI 闭嘴,取消转人工才恢复。
    if (d?.isSelf === true) {
      const stext = this.extractMsgText(d);
      if (stext && !this.isOurSend(stext) && !task.humanTakeover) await this.onHumanReply(task, stext);
      return;
    }
    if (!this.inWorkHours()) { this.logger.log('[工作时间外] 不聊天,消息暂不处理'); return; }
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
    // 防抖:不立即回;攒进缓冲,等 DEBOUNCE_MS 内候选人不再发,合并成一段再处理(治串行乱回)
    this.bufferMessage(task.taskId, text);
  }

  /** 把候选人这条消息攒进缓冲,重置计时器;静默 DEBOUNCE_MS 后 flush 合并处理。 */
  private bufferMessage(taskId: string, text: string) {
    const buf = this.msgBuffer.get(taskId) || { texts: [], timer: null as any };
    buf.texts.push(text);
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => { this.flushMessages(taskId).catch((e) => this.logger.error(`[flush] ${taskId}: ${e?.message}`)); }, this.DEBOUNCE_MS);
    this.msgBuffer.set(taskId, buf);
  }

  /** 合并这段时间候选人连发的几条 → 一次 handleReply(理解更连贯)。flush 时重取任务、再校验转人工。 */
  private async flushMessages(taskId: string) {
    const buf = this.msgBuffer.get(taskId);
    this.msgBuffer.delete(taskId);
    if (!buf || !buf.texts.length) return;
    const combined = buf.texts.join('\n');
    const task = await this.taskModel.findOne({ taskId }).sort({ createdAt: -1 }).exec();
    if (!task) return;
    if (task.humanTakeover) { this.logger.log(`[防抖flush] ${taskId} 已转人工,跳过`); return; }
    if (buf.texts.length > 1) this.logger.log(`[防抖] ${task.name || task.phone} 合并 ${buf.texts.length} 条: ${combined.replace(/\n/g, ' | ').slice(0, 80)}`);
    await this.recordHistory(task, 'candidate', combined);
    await this.handleReply(task, combined);
  }

  /** 发带时间欢迎语（秒回 /message/send）。幂等:已发过直接返回;发送成功才推进 WELCOMED,
   *  失败保持原状态,候选人开口后 onMessage 兜底补发。会话标识优先 chatId,回退 externalUserId/wxid。 */
  private async sendWelcome(task: ReachTaskDocument) {
    if (task.status === ReachStatus.WELCOMED || task.status === ReachStatus.REPLIED
        || task.status === ReachStatus.INTENT_ACCEPT) return; // 已进入后续阶段,不重复打招呼
    const target = task.chatId || task.externalUserId || task.wxid;
    if (!target) { this.logger.warn(`[欢迎语] task ${task.taskId} 无会话标识,等候选人开口再发`); return; }
    const welcome = buildInviteMessage(task.name, task.position, task.interviewTime, this.config.get('WELCOME_TEMPLATE'), (task as any).round);
    const r = await this.sendCandidate(target, welcome);
    this.logger.log(`[欢迎语] ${task.name || task.phone} ok=${r.ok} code=${r.code} via=${task.chatId ? 'chatId' : 'extId'}`);
    if (!r.ok) return; // 没发出去,保持 CONFIRMED,等 onMessage 兜底
    task.status = ReachStatus.WELCOMED;
    await task.save();
    await this.appendTimeline(task.taskId, 'WELCOMED', '已发带时间欢迎语');
  }

  /** 候选人回复 → 大模型意图分类 → 回复 + 建日程 + 通知HR + 回填 */
  /** 确定性意图前置:明确的用规则直判(不靠模型瞎猜),模糊的才交给大模型。修"已读乱回"。 */
  private quickIntent(text: string): string | null {
    const t = (text || '').trim();
    if (!t) return null;
    if (/转人工|找真人|人工客服|要真人|真人.*聊/.test(t)) return 'HUMAN';
    if (/不考虑|不来了|不面了|不去了|已入职|入职了|找到工作|算了不|放弃/.test(t)) return 'REJECT';
    const slot = extractTimeSlot(t);
    if (slot.date || slot.clock) return 'TIME';                 // 带具体时间→TIME,由 sameAsScheduled 分确认/改期
    if (/^(可以|好的|好呀|好嘞|没问题|行|行的|ok|方便|确认|同意|没有问题|嗯好|👌|沒問題)/i.test(t)) return 'TIME';
    if (/不行|不方便|改期|改一下|改个时间|换时间|换个时间|调整.*时间|另约|时间.*不(合适|行)/.test(t)) return 'RESCHEDULE';
    return null;
  }

  /** 记一轮对话进 task.history(给智能体做上下文),只留最近 10 轮。 */
  private async recordHistory(task: ReachTaskDocument, role: 'candidate' | 'ai', text: string) {
    if (!text) return;
    task.history = [...(task.history || []), { role, text: text.slice(0, 500), at: new Date() }].slice(-10);
    try { await task.save(); } catch { /* 历史非关键,并发保存冲突忽略 */ }
  }

  /** 真人 HR 在秒回工作台手动回了候选人(检测到非 AI 回声的 isSelf 消息)→ 自动转人工(玄玄需求13:00)。
   *  之后 AI 一律不接待候选人消息;HR 在进度表取消【转人工】勾选 → rule5 同步回来恢复 AI。 */
  private async onHumanReply(task: ReachTaskDocument, humanText: string) {
    task.humanTakeover = true;
    task.status = ReachStatus.HANDOVER;
    await task.save();
    await this.recordHistory(task, 'ai', `[真人HR] ${humanText}`);
    this.logger.log(`[真人接入] ${task.name || task.phone} HR手动回复「${humanText.slice(0, 40)}」→ 自动转人工`);
    await this.requestHandover(task, 'HUMAN_REPLY', `HR 在秒回工作台手动回复了候选人,自动转人工`, humanText);
    await this.backfillProgress(task, '检测到真人 HR 回复,自动转人工', 'HANDOVER');
  }

  /** live 模式:智能体接管——先发它生成的回复,再按它判定的 action 走"已验证的关键动作"(动作由代码执行+校验,模型只提议)。 */
  private async executeAgentTurn(task: ReachTaskDocument, text: string, agent: { reply: string; action: string; time: string }) {
    const who = task.name || task.phone;
    if (task.chatId && agent.reply) await this.sendCandidate(task.chatId, agent.reply);
    await this.recordHistory(task, 'ai', agent.reply);
    this.logger.log(`[智能体·真跑] ${who} 回「${agent.reply.slice(0, 50)}」动作:${agent.action}${agent.time ? ' time:' + agent.time : ''}`);
    switch (agent.action) {
      case 'confirm':
        task.status = ReachStatus.INTENT_ACCEPT;
        if (!task.meetingLink) await this.scheduleInterview(task, {});
        await task.save();
        await this.backfillProgress(task, '候选人确认面试时间(智能体)', 'INTENT_ACCEPT');
        break;
      case 'propose_reschedule':
        task.status = ReachStatus.INTENT_RESCHEDULE;
        task.pendingTime = agent.time || text.slice(0, 30);
        await task.save();
        await this.notifyHr(`🔄【候选人要改期】${who} 希望调整到【${task.pendingTime}】，请一面面试官在进度表改「一面时间」拍板，确认后会自动通知候选人。`);
        await this.backfillProgress(task, `候选人期望改到${task.pendingTime}(智能体)`, 'INTENT_RESCHEDULE', task.pendingTime);
        break;
      case 'handover':
        task.status = ReachStatus.HANDOVER;
        await task.save();
        await this.requestHandover(task, 'USER_REQUEST', '智能体判定转人工', text);
        await this.backfillProgress(task, '智能体转人工', 'HANDOVER');
        break;
      case 'reject_close':
        task.status = ReachStatus.INTENT_REJECT;
        await task.save();
        await this.requestHandover(task, 'REJECT', '候选人拒绝(智能体)', text);
        break;
      default:
        if (task.status === ReachStatus.WELCOMED) task.status = ReachStatus.REPLIED;
        await task.save();
    }
  }

  /** 拼"任务状态上下文"给模型:应聘岗位/已约时间/当前状态,让判意图和答疑更准、不答非所问。 */
  private buildContext(task: ReachTaskDocument): string {
    const parts: string[] = [];
    if (task.position) parts.push(`应聘岗位：${task.position}`);
    if (task.interviewTime) parts.push(`${task.round || '一面'}已约时间：${formatInterviewTimeText(task.interviewTime)}`);
    const statusMap: Partial<Record<ReachStatus, string>> = {
      [ReachStatus.INTENT_ACCEPT]: '面试已确认约成',
      [ReachStatus.WELCOMED]: '已发面试邀约,正等候选人确认时间',
      [ReachStatus.INTENT_RESCHEDULE]: '候选人要改期,正在对时间',
    };
    parts.push(`当前状态：${statusMap[task.status] || '沟通中'}`);
    return `【对话背景】${parts.join('；')}。`;
  }

  private async handleReply(task: ReachTaskDocument, text: string) {
    const ctx = this.buildContext(task);
    // 对话智能体开关:off=纯模板(现状)| shadow=模板照常服务+智能体只记录"它会怎么回"(验证用)| live=智能体真接管
    const agentMode = (this.config.get('REPLY_AGENT_MODE') || process.env.REPLY_AGENT_MODE || 'off').toString();
    if (agentMode !== 'off') {
      const agent = await this.llm.agentTurn({ context: ctx, history: (task.history || []).map((h) => ({ role: h.role, text: h.text })), message: text });
      if (agent) {
        if (agentMode === 'live') return await this.executeAgentTurn(task, text, agent);
        this.logger.log(`[智能体·影子] ${task.name || task.phone} 候选人「${text.replace(/\n/g, ' ').slice(0, 50)}」→ 模型会回「${agent.reply.slice(0, 60)}」动作:${agent.action}${agent.time ? ' time:' + agent.time : ''}`);
      }
      // agent 为 null(解析失败) → 回退下面的模板流程
    }
    const intent = this.quickIntent(text) || await this.llm.classifyIntent(text, ctx);
    const given = extractTime(text);
    const slot = extractTimeSlot(text);
    let reply = ''; let status: ReachStatus = ReachStatus.REPLIED; let note = '';
    let meetingLink = task.meetingLink || '';
    let expectTime = '';   // 候选人期望的改期时间(带给表格服务→@面试官拍板)
    if (intent === 'TIME' || intent === 'RESCHEDULE') task.otherStreak = 0;
    switch (intent) {
      case 'TIME': {
        // 玄玄定的规格:候选人给的时间≠当前约定 → 不是确认,是改期提案 → 不建日程,找面试官拍板
        if (!sameAsScheduled(slot, task.interviewTime)) {
          // 给出了可用的时间/区间(具体到哪天,或给了钟点) → 直接找面试官拍板,不逼问到分钟
          if (slot.date || slot.clock) {
            status = ReachStatus.INTENT_RESCHEDULE;
            task.pendingTime = slot.raw || text.slice(0, 30);
            task.rescheduleAsks = 0;
            expectTime = task.pendingTime;
            reply = `收到~【${expectTime}】我跟面试官确认一下，定了马上回复您哈`;
            note = `候选人期望改到【${expectTime}】，待面试官拍板(改一面时间即拍板，会自动通知候选人)`;
          } else {
            // "下周吧/最近忙"这类没落到哪天 → 引导给区间
            task.rescheduleAsks = (task.rescheduleAsks || 0) + 1;
            if (task.rescheduleAsks >= 3) { await this.rescheduleStuck(task, text); return; }
            status = ReachStatus.INTENT_RESCHEDULE;
            reply = `好的~ 您给个大概方便的时间段就行，比如「周四周五下午」或「下周一上午」，我让面试官从里面挑个时间~`;
            note = `候选人想改期(还没给到具体哪天:${text.slice(0, 20)})，AI引导区间中(第${task.rescheduleAsks}轮)`;
          }
          break;
        }
        // 已约成后候选人重复确认:不重复建日程/不重复通知,只回一句(玄玄:约成只通知一次)
        if (task.status === ReachStatus.INTENT_ACCEPT && task.meetingLink) {
          if (task.chatId) await this.sendCandidate(task.chatId,
            `您的面试已经约好啦，${formatInterviewTimeText(task.interviewTime)}，到时见~`);
          return;
        }
        status = ReachStatus.INTENT_ACCEPT;
        task.rescheduleAsks = 0; task.pendingTime = '';
        if (!meetingLink) meetingLink = await this.scheduleInterview(task, given ? { time: given } : {});
        const timeText = formatInterviewTimeText(task.interviewTime);
        reply = `好的，面试就约在【${timeText}】啦~ 线上视频形式${meetingLink ? `，会议链接：${meetingLink}` : '，会议链接稍后发您'}。到时见~`;
        note = `候选人确认面试时间【${timeText}】`;
        break;
      }
      case 'RESCHEDULE':
        // 不转人工:AI 先引导拿"时间区间或具体时间"(最多3轮),拿到了找面试官拍板
        if (slot.date || slot.clock) {
          status = ReachStatus.INTENT_RESCHEDULE;
          task.pendingTime = slot.raw || text.slice(0, 30);
          task.rescheduleAsks = 0;
          expectTime = task.pendingTime;
          reply = `收到~【${expectTime}】我跟面试官确认一下，定了马上回复您哈`;
          note = `候选人期望改到【${expectTime}】，待面试官拍板(改一面时间即拍板，会自动通知候选人)`;
          break;
        }
        task.rescheduleAsks = (task.rescheduleAsks || 0) + 1;
        if (task.rescheduleAsks >= 3) { await this.rescheduleStuck(task, text); return; }
        status = ReachStatus.INTENT_RESCHEDULE;
        reply = task.rescheduleAsks === 1
          ? '没问题~ 您给个大概方便的时间段就行，比如「周四周五下午」或「下周一上午」，我让面试官从里面挑个时间~'
          : '好嘞~ 给个范围就够：这周还是下周？哪几天比较空？上午还是下午？我拿着去对面试官的时间~';
        note = `候选人想改期，AI引导时间区间中(第${task.rescheduleAsks}轮)`;
        break;
      case 'HUMAN':
        reply = '好的~ 我让我们招聘同事直接来跟您对接哈，稍等一下下~';
        if (task.chatId) await this.sendCandidate(task.chatId, reply);
        task.status = ReachStatus.HANDOVER;
        await task.save();
        await this.requestHandover(task, 'USER_REQUEST', '候选人要求人工对接', text);
        await this.backfillProgress(task, '候选人要求人工，已转人工', 'HANDOVER');
        return;
      case 'REJECT':
        if (!task.rejectAsked) {
          // 玄玄定的:先挽留问原因,判断确实不想参与才转人工
          task.rejectAsked = true;
          status = ReachStatus.REPLIED;
          reply = '啊，收到~ 方便说下是什么原因吗？如果是时间对不上，咱们完全可以改约您方便的时间；有其他顾虑也可以直接跟我说，我看看能不能帮上~';
          note = '候选人首次婉拒，AI挽留询问原因中';
          break;
        }
        status = ReachStatus.INTENT_REJECT;
        reply = '好的，完全理解~ 感谢您的关注，后续有更合适的机会我再联系您。祝一切顺利！';
        note = '候选人确认不参与，流程关闭';
        break;
      case 'QUESTION':
        status = ReachStatus.INTENT_QUESTION;
        reply = await this.llm.answer(text, ctx);
        note = `候选人提问：${text.slice(0, 30)}`;
        break;
      default:
        // 听不懂:连续2次识别不了意图 → 别硬聊,转人工
        task.otherStreak = (task.otherStreak || 0) + 1;
        if (task.otherStreak >= 3) {
          reply = '不好意思哈~ 我让我们招聘同事直接来跟您沟通，稍等一下下~';
          if (task.chatId) await this.sendCandidate(task.chatId, reply);
          task.status = ReachStatus.HANDOVER;
          await task.save();
          await this.requestHandover(task, 'USER_REQUEST', '连续三轮没听懂候选人意图，AI退出', text);
          await this.backfillProgress(task, `AI连续3轮没听懂候选人(最后原话:${text.slice(0, 30)})，已转人工`, 'HANDOVER');
          return;
        }
        status = ReachStatus.REPLIED;
        reply = await this.llm.answer(text, ctx);
        note = '';
    }
    if (task.chatId && reply) { await this.sendCandidate(task.chatId, reply); await this.recordHistory(task, 'ai', reply); }
    task.intent = intent;
    if (intent !== 'QUESTION') task.status = status;
    else if (task.status === ReachStatus.WELCOMED) task.status = ReachStatus.REPLIED;
    await task.save();
    await this.appendTimeline(task.taskId, `INTENT_${intent}`, given || '');
    const who = task.name || task.phone;
    // 确认→通知HR；改约/拒绝/知识库答不上→转人工（表格服务置「转人工=是」+通知HR）
    // 约成通知统一由表格服务侧「一面约成」发(含@面试官+勾一面+会议链接),这里不重复发(玄玄:只通知一次)
    if (status === ReachStatus.INTENT_RESCHEDULE) {
      // 改期不转人工(玄玄规格):AI已回复"跟面试官确认",通过回填把 expectTime 带给表格服务→@一面面试官拍板;
      // 面试官改一面时间即拍板,表格服务调 /notify → notifyTimeChange 自动通知候选人新时间。
      if (expectTime) {
        await this.notifyHr(`🔄【候选人要改期】${who} 希望调整到【${expectTime}】，请一面面试官在进度表改「一面时间」拍板，确认后会自动通知候选人。`);
      }
    } else if (status === ReachStatus.INTENT_REJECT) {
      await this.requestHandover(task, 'REJECT', '候选人婉拒本次面试', text);
    } else if (intent === 'QUESTION' && /问下同事|问一下同事/.test(reply)) {
      await this.requestHandover(task, 'KB_MISS', `候选人问到知识库未覆盖的问题：${text.slice(0, 40)}`, text);
    }
    await this.backfillProgress(task, note || `候选人意图=${intent}`, `INTENT_${intent}`, expectTime);
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
    const phone = (body?.phoneNum || '').toString().trim();
    // 先按 extraInfo(本系统 taskId) 精确命中；命中不到再按手机号回退查本系统「加好友中」任务。
    // 候选人可能点的是更早那次加好友邀请（extraInfo 是旧 taskId，旧任务已被 /reach 幂等清理），
    // 此时 extraInfo 对不上但手机号能对上。createTask 对同手机号 deleteMany，库内同 phone 最多一条任务，
    // 回退不会混淆；库里查不到该手机号任务才算「非本系统」（限制仍成立）。
    let task = extraInfo ? await this.taskModel.findOne({ taskId: extraInfo }).exec() : null;
    if (!task && phone) {
      task = await this.taskModel
        .findOne({ phone, status: { $in: [ReachStatus.ADDING, ReachStatus.PENDING, ReachStatus.CONFIRMED] } })
        .sort({ createdAt: -1 })
        .exec();
      if (task) this.logger.log(`[friend/confirm] extraInfo=${extraInfo || '无'} 未命中，按手机号回退命中本系统任务 ${task.taskId}`);
    }
    if (!task) {
      this.logger.log(`[friend/confirm] 非本系统触达（extraInfo=${extraInfo || '无'} phone=${phone} 库无对应任务），不触发约面`);
      return;
    }
    task.status = ReachStatus.CONFIRMED;
    task.wxid = body.wxid || task.wxid;
    task.externalUserId = body.externalUserId || body.externalUserid || task.externalUserId;
    if (body.chatId) task.chatId = body.chatId;
    await task.save();
    await this.appendTimeline(task.taskId, 'CONFIRMED', `好友通过 wxid=${task.wxid} extId=${task.externalUserId || '无'}`);
    this.logger.log(`[friend/confirm] ${task.name || task.phone} 好友已通过 extId=${task.externalUserId || '无'}`);
    // 好友通过即主动发首条邀约,不等候选人先开口(玄玄需求)。发不出去(还没会话标识)时保持
    // CONFIRMED,候选人开口后 onMessage 会兜底补发。
    await this.sendWelcome(task);
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
    const welcome = buildInviteMessage(task.name, task.position, task.interviewTime, undefined, (task as any).round);
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
    const end = start + 30 * 60 * 1000; // 结束=开始+30分钟(玄玄:面试统一30min)
    try {
      const { eventId, meetingUrl } = await this.feishu.createInterviewEvent({
        hrEmail,
        hrOpenId,
        summary: `线上面试-${task.position || '岗位待定'}-${task.name || task.phone}`,
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
  private async backfillProgress(task: ReachTaskDocument, note: string, event = '', expectTime = '') {
    if (this.dry) { this.logger.log(`[DRY] 回填 ${task.phone} [${event || task.status}] ${note}`); return; }
    await this.table.backfill({
      dataId: task.dataId, phone: task.phone, event: event || task.status, note,
      status: task.status, interviewTime: task.interviewTime, meetingLink: task.meetingLink,
      expectTime: expectTime || undefined, round: task.round || '一面',
    });
  }

  /** 定时扫描(每30分钟)：
   *  ①发出邀约(WELCOMED)超24h没回 → 转人工；
   *  ②改期追问中(INTENT_RESCHEDULE 无 pendingTime)超24h没动静 → 每日回访一次,3天仍拿不到 → 转人工。 */
  async sweepIdle() {
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
    // ① 沉默超24h → 转人工
    const silent = await this.taskModel.find({
      status: ReachStatus.WELCOMED, humanTakeover: { $ne: true }, updatedAt: { $lt: dayAgo },
    }).limit(50).exec();
    for (const t of silent) {
      t.status = ReachStatus.HANDOVER;
      await t.save();
      await this.appendTimeline(t.taskId, 'SILENT', '发出邀约超24小时无回复');
      await this.requestHandover(t, 'SILENT', '发出邀约超24小时无回复，请HR人工跟进', '');
      await this.backfillProgress(t, '发出邀约超24小时无回复，已转人工', 'HANDOVER');
    }
    // ② 改期拖着(说"看排班"这类) → 每日回访,3次后转人工
    const pending = await this.taskModel.find({
      status: ReachStatus.INTENT_RESCHEDULE, humanTakeover: { $ne: true },
      $or: [{ pendingTime: '' }, { pendingTime: null }], updatedAt: { $lt: dayAgo },
    }).limit(50).exec();
    for (const t of pending) {
      t.revisits = (t.revisits || 0) + 1;
      if (t.revisits >= 3) {
        t.status = ReachStatus.HANDOVER;
        await t.save();
        await this.appendTimeline(t.taskId, 'REVISIT_GIVEUP', '连续回访3天仍未拿到时间');
        await this.requestHandover(t, 'RESCHEDULE', '改期连续回访3天仍未拿到时间，请HR人工对时间', '');
        await this.backfillProgress(t, '改期回访3天没结果，已转人工', 'HANDOVER');
        continue;
      }
      await t.save();
      if (t.chatId) await this.sendCandidate(t.chatId, '您好呀~ 面试时间上您考虑得怎么样啦？给我个大概方便的时间段就行（比如「周四周五下午」），我去协调面试官~');
      await this.appendTimeline(t.taskId, 'REVISIT', `第${t.revisits}次回访`);
    }
    if (silent.length || pending.length) this.logger.log(`[扫描] 沉默转人工${silent.length} 改期回访${pending.length}`);
  }

  /** 改期沟通3轮仍拿不到具体时间 → 不硬聊,转人工(玄玄定的兜底) */
  private async rescheduleStuck(task: ReachTaskDocument, text: string) {
    const reply = '好嘞~ 那我让我们招聘同事直接来跟您对时间，稍等一下下哈~';
    if (task.chatId) await this.sendCandidate(task.chatId, reply);
    task.status = ReachStatus.HANDOVER;
    await task.save();
    await this.appendTimeline(task.taskId, 'RESCHEDULE_STUCK', '3轮追问未拿到具体改期时间');
    await this.requestHandover(task, 'RESCHEDULE', '改期沟通3轮仍未拿到具体时间，请HR人工对时间', text);
    await this.backfillProgress(task, '改期3轮没对上具体时间，已转人工', 'HANDOVER');
  }

  /** 转人工：通知表格服务标记「转人工=是」+ 飞书通知HR。触达服务判定需人工时调用 */
  private async requestHandover(task: ReachTaskDocument, reason: string, reasonText: string, candidateReply?: string) {
    await this.table.handover({ dataId: task.dataId, phone: task.phone, reason, reasonText, candidateReply });
    await this.notifyHr(`👤【转人工·${reason}】${task.name || task.phone}：${reasonText}${candidateReply ? `\n候选人原话：${candidateReply}` : ''}`);
  }
}
