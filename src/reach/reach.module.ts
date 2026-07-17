/**
 * ioredis 客户端注入令牌（触达编排的幂等锁/去重用）。
 *
 * 注：miaopin-service 是扁平结构（所有 service 都注册在 AppModule）。
 * 若把 ReachController/ReachService 单独放本模块并重复 provide
 * ConfigService/FeishuService/MiaohuiService，会与 AppModule 形成循环依赖。
 * 因此 ReachController/ReachService/redis provider 都注册在 AppModule，
 * 本文件只保留跨文件共享的注入令牌常量。
 */
export const REACH_REDIS = 'REACH_REDIS';
