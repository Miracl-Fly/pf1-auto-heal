// 离线测试 pf1-auto-heal 的纯逻辑
// 用法: node test-logic.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------- 可控的 mock 环境 ----------
let MOCK_DIST = 0;
let MOCK_SETTINGS = { debug: false, unknownRange: "touch" };
let MOCK_EMITTED = [];
let MOCK_CHAT = [];

const HOOKS = {};
globalThis.Hooks = {
  once(name, fn) { (HOOKS[name] ??= []).push(fn); },
  on(name, fn) { (HOOKS[name] ??= []).push(fn); },
  call() {},
  callAll() {},
};
const fireHook = (name) => (HOOKS[name] ?? []).splice(0).forEach((fn) => fn());

const GM_USER = { id: "gm1", name: "GM", isGM: true, active: true, isSelf: true };

globalThis.ui = {
  notifications: {
    warn: (m) => MOCK_EMITTED.push("WARN:" + m),
    info: (m) => MOCK_EMITTED.push("INFO:" + m),
  },
};
globalThis.fromUuid = async (uuid) => globalThis.__ACTORS?.[uuid] ?? null;

globalThis.ChatMessage = {
  create: async (data) => {
    MOCK_CHAT.push(data);
    return { id: "msg1", delete: async () => { MOCK_CHAT.push({ __deleted: true }); } };
  },
};

globalThis.game = {
  settings: {
    register() {},
    get(_mod, key) {
      if (key in MOCK_SETTINGS) return MOCK_SETTINGS[key];
      return true;
    },
  },
  i18n: { localize: (k) => k },
  user: { id: "u1", name: "测试玩家", isGM: false },
  userId: "u1",
  users: {
    some: (fn) => [GM_USER].some(fn),
    filter: (fn) => [GM_USER].filter(fn),
    get: (id) => (id === "gm1" ? GM_USER : null),
    activeGM: GM_USER,
  },
  socket: { on() {}, emit: (_ch, payload) => MOCK_EMITTED.push(payload) },
  modules: { get: () => ({ socket: true, active: true }) },
};
globalThis.CONST = { TOKEN_DISPOSITIONS: { HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 } };
globalThis.canvas = {
  grid: { measureDistance: () => MOCK_DIST, size: 100, distance: 5 },
  tokens: {
    get: (id) => (id === "src" ? { id: "src", center: { x: 100, y: 100 }, name: "施法者" } : null),
    placeables: [],
  },
};
globalThis.Dialog = class { render() {} };
globalThis.Roll = class {
  constructor(f) { this.formula = f; }
  evaluateSync() { this.total = 0; }
};

// socketlib mock
let MOCK_GM_CALLS = [];
globalThis.socketlib = {
  registerModule: () => ({
    register: (name, fn) => { globalThis.__gmApplyHeal = fn; },
    executeAsGM: async (name, ...args) => {
      MOCK_GM_CALLS.push({ name, args });
      return { ok: true, name: "别人的卡", amount: args[1] };
    },
  }),
};

// 把 main.js 复制成 .mjs 再导入（避免 Node 按 CommonJS 解析）
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const srcPath = path.join(here, "scripts", "main.js");
const tmpPath = path.join(os.tmpdir(), `pf1-auto-heal-test-${Date.now()}.mjs`);
fs.writeFileSync(tmpPath, fs.readFileSync(srcPath));
const m = await import(`file:///${tmpPath.replace(/\\/g, "/")}`);

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${label}  => ${JSON.stringify(got)}`); }
  else { fail++; console.log(`  FAIL  ${label}  得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`); }
};

// PF1 的 CL 挂在 spellbook 上
const mkActorCl = (cl) => ({
  system: { attributes: { spells: { spellbooks: { primary: { inUse: true, cl: { total: cl } } } } } },
});
const actorCl5 = mkActorCl(5);
const actorCl1 = mkActorCl(1);
const actorCl10 = mkActorCl(10);

console.log("=== rangeToFeet ===");
eq("touch",            m.rangeToFeet({ value: "touch", units: "touch" }, actorCl5), 5);
eq("25 ft",            m.rangeToFeet({ value: "25", units: "ft." }, actorCl5), 25);
eq("30 ft.",           m.rangeToFeet({ value: "30", units: "ft." }, actorCl5), 30);
eq("personal",         m.rangeToFeet({ value: "", units: "personal" }, actorCl5), 0);
eq("close (CL5)",      m.rangeToFeet({ value: "close", units: "" }, actorCl5), 35);
eq("medium (CL5)",     m.rangeToFeet({ value: "medium", units: "" }, actorCl5), 150);
eq("long (CL5)",       m.rangeToFeet({ value: "long", units: "" }, actorCl5), 600);
eq("文本 touch",       m.rangeToFeet("Touch", actorCl5), 5);
eq("文本 25 ft.",      m.rangeToFeet("25 ft.", actorCl5), 25);
eq("文本 close",       m.rangeToFeet("close (25 ft. + 5 ft./2 levels)", actorCl5), 35);
eq("see text => null", m.rangeToFeet({ value: "see text", units: "" }, actorCl5), null);
eq("null 输入",        m.rangeToFeet(null, actorCl5), null);

console.log("\n=== 施法者等级对 close 的影响 ===");
eq("CL1 close",  m.rangeToFeet({ value: "close", units: "" }, actorCl1), 25);
eq("CL10 close", m.rangeToFeet({ value: "close", units: "" }, actorCl10), 50);

console.log("\n=== getCasterLevel ===");
eq("从 spellbook 取", m.getCasterLevel(actorCl5, null), 5);
eq("指定 spellbook", m.getCasterLevel(actorCl5, { item: { system: { spellbook: "primary" } } }), 5);
eq("没有 spellbook 回退 hd", m.getCasterLevel({ system: { attributes: { hd: { total: 7 } } } }, null), 7);
eq("什么都没有 => 1", m.getCasterLevel({}, null), 1);

console.log("\n=== isHostile ===");
const tok = (d) => ({ document: { disposition: d } });
const F = 1, N = 0, H = -1;
eq("友方施法者 -> 敌对目标",  m.isHostile(tok(F), tok(H)), true);
eq("友方施法者 -> 友好目标",  m.isHostile(tok(F), tok(F)), false);
eq("友方施法者 -> 中立目标",  m.isHostile(tok(F), tok(N)), false);
eq("中立施法者 -> 友好目标",  m.isHostile(tok(N), tok(F)), false);
eq("中立施法者 -> 中立目标",  m.isHostile(tok(N), tok(N)), false);
eq("中立施法者 -> 敌对目标",  m.isHostile(tok(N), tok(H)), true);
eq("无 source token 时按友好", m.isHostile(null, tok(H)), true);

console.log("\n=== resolveHealAmount ===");
eq("ChatAttack.totalDamage 优先", m.resolveHealAmount({ shared: { chatAttacks: [{ totalDamage: 17 }] } }, null), 17);
eq("damage.rolls 求和", m.resolveHealAmount({ shared: { chatAttacks: [{ damage: { rolls: [{ total: 8 }, { total: 5 }] } }] } }, null), 13);
eq("message.rolls 回退", m.resolveHealAmount({ shared: {} }, { rolls: [{ total: 12 }] }), 12);
eq("全空 => 0", m.resolveHealAmount({ shared: {} }, null), 0);

console.log("\n=== collectTargets ===");
const fakeActor = (name) => ({ name });
const t1 = { actor: fakeActor("A") };
const t2 = { actor: fakeActor("B") };
eq("数量", m.collectTargets({ shared: { targets: [t1, t2] } }).length, 2);
eq("名字", m.collectTargets({ shared: { targets: [t1, t2] } }).map((x) => x.name), ["A", "B"]);
eq("同一目标去重", m.collectTargets({ shared: { targets: [t1, t1] } }).length, 1);

console.log("\n=== isInRange（重点）===");
const mkTarget = (name) => ({ name, token: { center: { x: 200, y: 200 } } });
const srcTok = { id: "src", center: { x: 100, y: 100 } };
const runRange = (distance, range, policy = "touch") => {
  MOCK_DIST = distance;
  MOCK_SETTINGS.unknownRange = policy;
  const actionUse = { item: { system: { actions: [] } }, action: { range } };
  return m.isInRange(actorCl5, srcTok, mkTarget("T"), actionUse, { range });
};
eq("touch, 距离 0 => 治疗",      runRange(0,   { value: "touch", units: "touch" }), true);
eq("touch, 距离 5 => 治疗",      runRange(5,   { value: "touch", units: "touch" }), true);
eq("touch, 距离 20 => 不治",     runRange(20,  { value: "touch", units: "touch" }), false);
eq("touch, 距离 35 => 不治",     runRange(35,  { value: "touch", units: "touch" }), false);
eq("close(35), 距离 30 => 治疗", runRange(30,  { value: "close", units: "" }), true);
eq("close(35), 距离 40 => 不治", runRange(40,  { value: "close", units: "" }), false);
eq("30ft, 距离 25 => 治疗",      runRange(25,  { value: "30", units: "ft." }), true);
eq("30ft, 距离 40 => 不治",      runRange(40,  { value: "30", units: "ft." }), false);

console.log("\n=== 射程读不出来时的策略 ===");
const emptyRange = { value: "", units: "" };
eq("默认 touch, 距离 20 => 不治", runRange(20, emptyRange, "touch"), false);
eq("默认 touch, 距离 5 => 治疗",  runRange(5,  emptyRange, "touch"), true);
eq("allow, 距离 200 => 仍治疗",   runRange(200, emptyRange, "allow"), true);
eq("block, 距离 0 => 也不治",     runRange(0,  emptyRange, "block"), false);
eq("range 整个缺失 + touch",      runRange(20, null, "touch"), false);

console.log("\n=== 射程从 item.system.actions 兜底 ===");
MOCK_DIST = 20;
const auFallback = {
  item: { system: { actions: [{ range: { value: "close", units: "" } }] } },
  action: { range: { value: "", units: "" } },
};
eq("当前 action 空，从别的 action 找到 close(35) => 治疗",
  m.isInRange(actorCl5, srcTok, mkTarget("T"), auFallback, auFallback.action), true);

// ---------------- 权限 ----------------
console.log("\n=== 权限 / GM 代劳（socketlib 尚未注册）===");

game.user.isGM = false;
eq("普通玩家 + 非 owner => 不能改", m.canModify({ isOwner: false }), false);
eq("普通玩家 + owner => 能改",     m.canModify({ isOwner: true }), true);
game.user.isGM = true;
eq("GM => 总能改",                 m.canModify({ isOwner: false }), true);
eq("actor 为 null => 不能改",      m.canModify(null), false);
game.user.isGM = false;

let directCalls = 0;
const lockedActor = {
  name: "别人的卡",
  uuid: "Actor.abc",
  isOwner: false,
  applyDamage: async () => { directCalls++; return true; },
};

// 无权限 + 没 socketlib => 应该发聊天消息
MOCK_EMITTED = [];
MOCK_CHAT = [];
await m.applyHeal(lockedActor, 12, null, null);
eq("无权限时不直接改 actor", directCalls, 0);
eq("发了一条聊天消息", MOCK_CHAT.length, 1);
eq("聊天消息 type", MOCK_CHAT[0]?.flags?.["pf1-auto-heal"]?.type, "healRequest");
eq("聊天消息带 uuid", MOCK_CHAT[0]?.flags?.["pf1-auto-heal"]?.actorUuid, "Actor.abc");
eq("聊天消息带治疗量", MOCK_CHAT[0]?.flags?.["pf1-auto-heal"]?.amount, 12);
eq("私发给 GM", MOCK_CHAT[0]?.whisper, ["gm1"]);
eq("blind = true", MOCK_CHAT[0]?.blind, true);

// 有权限 => 直接改
const ownActor = {
  name: "自己的卡",
  uuid: "Actor.def",
  isOwner: true,
  applyDamage: async (v) => { directCalls++; ownActor.lastValue = v; return true; },
};
directCalls = 0;
MOCK_CHAT = [];
await m.applyHeal(ownActor, 9, null, null);
eq("有权限时直接改", directCalls, 1);
eq("传给 applyDamage 的是负数（=治疗）", ownActor.lastValue, -9);
eq("有权限时不发聊天消息", MOCK_CHAT.length, 0);

// 没 GM 在线
const savedSome = game.users.some;
game.users.some = () => false;
MOCK_EMITTED = [];
directCalls = 0;
MOCK_CHAT = [];
await m.applyHeal(lockedActor, 5, null, null);
eq("没 GM 时不动 actor", directCalls, 0);
eq("没 GM 时给个警告", MOCK_EMITTED.some((x) => String(x).startsWith("WARN:")), true);
game.users.some = savedSome;

// ---------------- socketlib ----------------
console.log("\n=== socketlib 优先通道 ===");
fireHook("socketlib.ready");

MOCK_GM_CALLS = [];
MOCK_CHAT = [];
game.user.isGM = false;
const locked2 = {
  name: "别人的卡",
  uuid: "Actor.xyz",
  isOwner: false,
  applyDamage: async () => { throw new Error("不该被直接调用"); },
};
const r2 = await m.applyHeal(locked2, 15, null, null);
eq("socketlib 被调用一次", MOCK_GM_CALLS.length, 1);
eq("走的是 applyHealAsGM", MOCK_GM_CALLS[0]?.name, "applyHealAsGM");
eq("传了 actor uuid", MOCK_GM_CALLS[0]?.args?.[0], "Actor.xyz");
eq("传了治疗量", MOCK_GM_CALLS[0]?.args?.[1], 15);
eq("不再发聊天消息", MOCK_CHAT.length, 0);
eq("返回值 ok", r2?.ok, true);

// ---------------- GM 端处理聊天消息 ----------------
console.log("\n=== GM 端处理治疗请求 ===");

let healed = null;
const gmTarget = {
  name: "被治疗的卡",
  uuid: "Actor.gmTarget",
  isOwner: false,
  applyDamage: async (v) => { healed = v; return true; },
};
globalThis.__ACTORS = { "Actor.gmTarget": gmTarget };

let deleted = false;
const fakeMsg = {
  flags: { "pf1-auto-heal": { type: "healRequest", actorUuid: "Actor.gmTarget", amount: 21, requesterName: "测试玩家" } },
  delete: async () => { deleted = true; },
};

game.user.isGM = true;
const handled = await m.handleHealChatMessage(fakeMsg);
eq("GM 处理成功", handled, true);
eq("按负数应用（治疗）", healed, -21);
eq("处理完删掉请求消息", deleted, true);

// 普通玩家不该处理
game.user.isGM = false;
healed = null;
eq("普通玩家不处理", await m.handleHealChatMessage(fakeMsg), false);
eq("普通玩家不改血", healed, null);

// 非本模块的消息不该碰
game.user.isGM = true;
eq("无关消息忽略", await m.handleHealChatMessage({ flags: {} }), false);

// ---------------- 精类遗孤 ----------------
console.log("\n=== 【精类遗孤】专长检测 ===");

const mkItems = (arr) => ({ contents: arr });
const feat = (name, type = "feat") => ({ name, type });

eq("英文名命中", m.hasFeyFoundling({ items: mkItems([feat("Fey Foundling")]) }), true);
eq("中文名命中", m.hasFeyFoundling({ items: mkItems([feat("精类遗孤")]) }), true);
eq("中英混写命中", m.hasFeyFoundling({ items: mkItems([feat("精类遗孤 Fey Foundling")]) }), true);
eq("大小写/空格不敏感", m.hasFeyFoundling({ items: mkItems([feat("fey  foundling")]) }), true);
eq("普通数组也支持", m.hasFeyFoundling({ items: [feat("精类遗孤")] }), true);
eq("没有该专长", m.hasFeyFoundling({ items: mkItems([feat("Power Attack")]) }), false);
eq("不是 feat 类型不算", m.hasFeyFoundling({ items: mkItems([{ name: "Fey Foundling", type: "weapon" }]) }), false);
eq("没有 items", m.hasFeyFoundling({}), false);
eq("actor 为 null", m.hasFeyFoundling(null), false);

console.log("\n=== 数骰子 ===");
const rollWithDice = (counts) => ({
  terms: counts.map((n) => ({ number: n, faces: 8 })),
});
eq("单个 2d8", m.countHealDice({ shared: { chatAttacks: [{ damage: { rolls: [rollWithDice([2])] } }] } }, null), 2);
eq("两个 roll 各 2 颗", m.countHealDice({ shared: { chatAttacks: [{ damage: { rolls: [rollWithDice([2]), rollWithDice([2])] } }] } }, null), 4);
eq("常数项不数", m.countHealDice({ shared: { chatAttacks: [{ damage: { rolls: [{ terms: [{ number: 2, faces: 8 }, { number: 5 }] }] } }] } }, null), 2);
eq("从 message 回退", m.countHealDice({ shared: {} }, { rolls: [rollWithDice([3])] }), 3);
eq("从公式回退 2d8+5", m.countHealDice({ shared: {}, action: { damage: { parts: [{ formula: "2d8+5" }] } } }, null), 2);
eq("公式无骰子", m.countHealDice({ shared: {}, action: { damage: { parts: [{ formula: "5" }] } } }, null), 0);
eq("全空 => 0", m.countHealDice({ shared: {} }, null), 0);
eq("d20 攻击骰不算治疗骰",
  m.countHealDice({ shared: {} }, { rolls: [{ terms: [{ number: 1, faces: 20 }, { number: 2, faces: 8 }] }] }), 2);
eq("全是 d20 => 0",
  m.countHealDice({ shared: {} }, { rolls: [{ terms: [{ number: 1, faces: 20 }] }] }), 0);

console.log("\n=== 加成计算 ===");
const feyActor = { name: "有遗孤的卡", items: mkItems([feat("精类遗孤")]) };
const plainActor = { name: "普通卡", items: mkItems([feat("Power Attack")]) };

MOCK_SETTINGS.feyFoundling = true;
eq("有专长 2骰 基础12 => 16", m.computeHealAmount(feyActor, 12, 2), 16);
eq("有专长 3骰 基础20 => 26", m.computeHealAmount(feyActor, 20, 3), 26);
eq("有专长 1骰 基础7 => 9",   m.computeHealAmount(feyActor, 7, 1), 9);
eq("无专长不变",              m.computeHealAmount(plainActor, 12, 2), 12);
eq("骰数为 0 不加",           m.computeHealAmount(feyActor, 12, 0), 12);
eq("基础为 0",                m.computeHealAmount(feyActor, 0, 2), 0);

MOCK_SETTINGS.feyFoundling = false;
eq("设置关掉则不加", m.computeHealAmount(feyActor, 12, 2), 12);
MOCK_SETTINGS.feyFoundling = true;

console.log("\n=== GM 端重算（玩家看不到专长时由 GM 补上）===");
let gmHealed = null;
const gmFeyActor = {
  name: "GM 侧的卡",
  uuid: "Actor.gmFey",
  isOwner: false,
  items: mkItems([feat("Fey Foundling")]),
  applyDamage: async (v) => { gmHealed = v; return true; },
};
globalThis.__ACTORS = { "Actor.gmFey": gmFeyActor };

let gmDeleted = false;
game.user.isGM = true;
const gmMsg = {
  flags: {
    "pf1-auto-heal": {
      type: "healRequest",
      actorUuid: "Actor.gmFey",
      amount: 13,
      dice: 3,
      requesterName: "测试玩家",
    },
  },
  delete: async () => { gmDeleted = true; },
};
eq("GM 处理成功", await m.handleHealChatMessage(gmMsg), true);
eq("GM 按 13 + 2×3 = 19 治疗", gmHealed, -19);
eq("消息已删", gmDeleted, true);

console.log(`\n===== 结果: ${pass} 通过, ${fail} 失败 =====`);
try { fs.unlinkSync(tmpPath); } catch {}
process.exit(fail ? 1 : 0);
