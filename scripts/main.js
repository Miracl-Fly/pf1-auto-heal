/**
 * PF1 自动治疗
 * ------------------------------------------------------------------
 * 释放治疗法术时，把治疗量自动应用到已选中的目标上。
 *
 * 规则：
 *   1. 只处理 actionType === "heal" 的动作
 *   2. 只处理有目标的情况（没选目标就什么都不做）
 *   3. 目标必须在法术范围内（touch / close / medium / long / 模板）
 *   4. 目标若与施法者敌对 → 弹确认框；否则直接治疗
 *
 * 依赖：Pathfinder 1e 系统（pf1）
 */

const MODULE_ID = "pf1-auto-heal";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;

/** socketlib 模块句柄（null = 不可用，会回退原生 socket） */
let socketlibSocket = null;

/** 本地化，找不到 key 时回退到 fallback（localize 找不到会原样返回 key） */
const L = (key, fallback) => {
  try {
    const s = game.i18n?.localize?.(key);
    return s && s !== key ? s : fallback;
  } catch {
    return fallback;
  }
};

/** 转义 HTML */
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

/* ============================================================
 * 设置
 * ========================================================== */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enabled", {
    name: "启用自动治疗",
    hint: "治疗法术释放后，自动把治疗量应用到选中的目标上。",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, "checkRange", {
    name: "检查法术范围",
    hint: "关闭后，只要选中了目标就治疗，不判断距离。",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, "confirmHostile", {
    name: "对敌对目标弹窗确认",
    hint: "目标与施法者敌对时，先弹窗问一句再治疗。",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, "feyFoundling", {
    name: "检测【精类遗孤 Fey Foundling】",
    hint:
      "目标拥有「精类遗孤」专长时，受到魔法治疗会按骰数额外 +2/骰（2d8+5 就是 +4）。" +
      "关掉则不检测。",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, "feyDebug", {
    name: "输出【精类遗孤】判定日志",
    hint: "开启后会在控制台打印是否命中该专长、数了几颗骰子、加了多少。",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "unknownRange", {
    name: "射程读不出来时怎么办",
    hint: "有些法术没填射程数据。这时可以选择：按「触碰」处理（5 尺）、直接放行、或者拦下不治。",
    scope: "world",
    config: true,
    type: String,
    choices: {
      touch: "按触碰处理（5 尺）",
      allow: "放行（不检查距离）",
      block: "拦下（不治疗）",
    },
    default: "touch",
  });

  game.settings.register(MODULE_ID, "debug", {
    name: "输出诊断日志",
    hint: "开启后会在浏览器控制台打印每次治疗的距离/射程判断过程，排查问题时用。",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  console.log(`${MODULE_ID} | 已加载`);
});

/* ready 之后才能用 game.socket 和 fromUuid */
Hooks.once("ready", () => {
  // 万一 socketlib.ready 已经在模块加载前触发过了，这里补一次
  if (!socketlibSocket) registerSocketlib();
  setupHealSocket();

  const mod = game.modules?.get?.(MODULE_ID);
  console.log(
    `${MODULE_ID} | v0.2.0 就绪 | 模块 socket 标记: ${mod?.socket ? "已生效" : "未生效（需重启 FVTT 服务器）"}` +
      ` | GM 代劳通道: ${socketlibSocket ? "socketlib" : "聊天消息"}`
  );
});

/* GM 端：收到玩家的治疗请求（聊天消息通道，不需要 socket 注册） */
Hooks.on("createChatMessage", (msg) => {
  handleHealChatMessage(msg);
});

/* ============================================================
 * 主逻辑
 * ========================================================== */

Hooks.on("pf1PostActionUse", async (actionUse, message) => {
  try {
    if (!game.settings.get(MODULE_ID, "enabled")) return;

    const action = actionUse?.action;
    if (!action) return;

    // 只处理治疗动作
    const isHeal =
      action.actionType === "heal" ||
      action.isHealing === true ||
      action?.constructor?.name === "HealingAction";
    if (!isHeal) return;

    // 目标：优先用 ActionUse 缓存下来的（施法后 game.user.targets 可能已被清空）
    const targets = collectTargets(actionUse);
    if (!targets.length) {
      console.debug(`${MODULE_ID} | 没有目标，跳过`);
      return;
    }

    const actor = actionUse.actor ?? actionUse.item?.actor;
    const token = actionUse.token ?? actor?.token ?? null;
    if (!actor) return;

    // 范围过滤
    const checkRange = game.settings.get(MODULE_ID, "checkRange");
    const valid = [];
    const skipped = [];
    for (const t of targets) {
      if (!t?.actor) continue;
      if (!checkRange || isInRange(actor, token, t, actionUse, action)) valid.push(t);
      else skipped.push(t);
    }

    if (skipped.length) {
      dbg(
        "超出范围，跳过:",
        skipped.map((t) => t.name ?? t.actor?.name)
      );
    }
    if (!valid.length) return;

    // 治疗量 + 骰子数（【精类遗孤】要按骰数加）
    const baseAmount = resolveHealAmount(actionUse, message);
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
      console.warn(`${MODULE_ID} | 治疗量解析失败:`, baseAmount);
      return;
    }
    const dice = countHealDice(actionUse, message);

    // 逐个应用
    const confirmHostile = game.settings.get(MODULE_ID, "confirmHostile");
    for (const t of valid) {
      try {
        const amount = computeHealAmount(t.actor, baseAmount, dice);

        const hostile = isHostile(token, t);
        if (hostile && confirmHostile) {
          const yes = await askHealHostile(t, amount, actor);
          if (!yes) {
            console.debug(`${MODULE_ID} | 用户取消治疗:`, t.name);
            continue;
          }
        }
        await applyHeal(t.actor, amount, actionUse, message, dice);
        console.log(
          `${MODULE_ID} | 已治疗 ${t.actor.name} +${amount}` +
            (amount > baseAmount ? `（基础 ${baseAmount}，精类遗孤 +${amount - baseAmount}）` : "")
        );
      } catch (err) {
        console.error(`${MODULE_ID} | 治疗 ${t?.name} 失败:`, err);
      }
    }
  } catch (err) {
    console.error(`${MODULE_ID} | 主流程出错:`, err);
  }
});

/* ============================================================
 * 目标收集
 * ========================================================== */

export function collectTargets(actionUse) {
  const out = [];
  const push = (t) => {
    if (!t) return;
    // 可能是 Token、TokenDocument 或 TokenPlaceable
    const tok = t.token ?? t.object ?? t;
    const doc = tok?.document ?? tok;
    const actor = t.actor ?? tok?.actor ?? doc?.actor;
    if (!actor) return;
    if (out.some((x) => x.actor === actor)) return;
    out.push({ token: tok, document: doc, actor, name: actor.name });
  };

  // 1) ActionUse 自己缓存的
  const cached = actionUse?.shared?.targets;
  if (cached) {
    for (const t of cached) push(t);
    if (out.length) return out;
  }

  // 2) 回退到当前选中的目标
  for (const t of game.user?.targets ?? []) push(t);
  return out;
}

/* ============================================================
 * 范围判断
 * ========================================================== */

/**
 * 取施法者等级。
 * PF1 的 CL 不在 actor.system.attributes.cl（根本没这个字段），
 * 而是挂在每个 spellbook 上：attributes.spells.spellbooks.<book>.cl
 */
export function getCasterLevel(actor, actionUse) {
  const books = actor?.system?.attributes?.spells?.spellbooks;
  const bookKey = actionUse?.item?.system?.spellbook;

  const readCl = (b) => {
    const cl = b?.cl;
    const v = Number(cl?.total ?? cl?.value ?? cl);
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  // 1) 法术所属的那本
  if (bookKey && books?.[bookKey]) {
    const v = readCl(books[bookKey]);
    if (v) return v;
  }

  // 2) 任何一本在用的
  if (books && typeof books === "object") {
    for (const b of Object.values(books)) {
      if (!b?.inUse) continue;
      const v = readCl(b);
      if (v) return v;
    }
    for (const b of Object.values(books)) {
      const v = readCl(b);
      if (v) return v;
    }
  }

  // 3) 回退到生命骰
  const hd = Number(actor?.system?.attributes?.hd?.total);
  if (Number.isFinite(hd) && hd > 0) return hd;

  return 1;
}

/** 把 PF1 的 range 文本/对象解析成尺数；返回 null 表示无法判断 */
export function rangeToFeet(rangeRaw, actor, actionUse) {
  if (rangeRaw == null) return null;

  const cl = getCasterLevel(actor, actionUse);

  const fromText = (raw) => {
    const s = String(raw ?? "").toLowerCase().trim();
    if (!s) return null;
    if (s.includes("touch")) return 5;
    if (s.includes("personal")) return 0;
    if (s.includes("unlimited") || s.includes("sight") || s.includes("see text")) return null;
    if (s.includes("close")) return 25 + 5 * Math.floor(cl / 2);
    if (s.includes("medium")) return 100 + 10 * cl;
    if (s.includes("long")) return 400 + 40 * cl;
    const m = s.match(/(\d+)\s*(ft|feet|foot|尺)/);
    if (m) return Number(m[1]);
    return null;
  };

  // 对象形式：{ value, units }（PF1 Action 的 range schema）
  if (typeof rangeRaw === "object") {
    const vRaw = rangeRaw.value;
    const uRaw = String(rangeRaw.units ?? "").toLowerCase().trim();
    const vStr = String(vRaw ?? "").toLowerCase().trim();
    const vNum = Number(vRaw);

    // units 或 value 里写着 touch / personal
    if (uRaw.includes("touch") || vStr.includes("touch")) return 5;
    if (uRaw.includes("personal") || vStr.includes("personal")) return 0;
    if (uRaw.includes("unlimited") || uRaw.includes("sight")) return null;

    // value 是数字
    if (Number.isFinite(vNum) && vNum > 0) {
      if (uRaw.includes("mile") || uRaw === "mi") return vNum * 5280;
      return vNum; // 默认按尺
    }

    // value 是文本（close / medium / long）
    const byText = fromText(vStr);
    if (byText !== null) return byText;
    // 再退回 units 本身
    return fromText(uRaw);
  }

  return fromText(rangeRaw);
}

/* ---- 诊断日志 ---- */
function dbg(...args) {
  try {
    if (game.settings.get(MODULE_ID, "debug")) console.log(`${MODULE_ID} |`, ...args);
  } catch {
    /* 设置没注册（测试环境）就静默 */
  }
}

/**
 * 统一拿到 Token placeable。
 * ActionUse.token / actor.token 常常是 TokenDocument，它没有 .center，
 * 也不能直接喂给 canvas.grid.measureDistance。
 */
function resolveTokenPlaceable(tok) {
  if (!tok) return null;
  if (tok.center) return tok; // 已经是 placeable
  const doc = tok.document ?? tok;
  const id = doc?.id;
  if (id && canvas?.tokens?.get) {
    const obj = canvas.tokens.get(id);
    if (obj) return obj;
  }
  // 退一步：activo token
  const actor = doc?.actor ?? tok.actor;
  if (actor?.isToken && canvas?.tokens?.placeables) {
    const found = canvas.tokens.placeables.find((t) => t.actor === actor);
    if (found) return found;
  }
  return doc; // 实在没有就用 document（只有 x/y）
}

/** 两点之间的尺数 */
function measureFt(src, tgt) {
  if (!src || !tgt) return 0;
  const a = src.center ?? { x: src.x, y: src.y };
  const b = tgt.center ?? { x: tgt.x, y: tgt.y };
  if (!Number.isFinite(a.x) || !Number.isFinite(b.x)) return 0;
  try {
    return canvas.grid.measureDistance(a, b);
  } catch (e) {
    return 0;
  }
}

/**
 * 把射程从各种可能的地方挖出来。
 * PF1 的法术射程主要挂在 action.range = { value, units }，
 * 但老数据 / 自制法术经常是空的，所以要往回找几层。
 */
function pickRange(action, actionUse) {
  const item = actionUse?.item;
  const candidates = [
    action?.range,
    actionUse?.action?.range,
    item?.system?.range,
  ];

  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === "object") {
      const v = String(c.value ?? "").trim();
      const u = String(c.units ?? "").trim();
      if (v || u) return c; // 只要有值就认
    } else if (String(c).trim()) {
      return c;
    }
  }

  // 再翻一遍 item 上的所有 action，万一当前 action 没填但别的填了
  const actions = item?.system?.actions ?? [];
  for (const a of actions) {
    const r = a?.range;
    if (!r) continue;
    const v = String(r.value ?? "").trim();
    const u = String(r.units ?? "").trim();
    if (v || u) return r;
  }

  return null;
}

/** 未知射程时的策略 */
function unknownRangePolicy() {
  try {
    return game.settings.get(MODULE_ID, "unknownRange") || "touch";
  } catch {
    return "touch";
  }
}

export function isInRange(actor, token, target, actionUse, action) {
  const src = resolveTokenPlaceable(token ?? actionUse?.token);
  const tgtTok = resolveTokenPlaceable(target?.token ?? target);

  if (!canvas?.grid || !src || !tgtTok) {
    dbg("没有画布或 token，跳过范围检查");
    return true;
  }

  // 1) 模板范围优先（爆发型治疗）
  const template =
    actionUse?.shared?.templateData?.template ?? actionUse?.shared?.template;
  if (template?.object) {
    try {
      const shape = template.object.shape;
      const c = tgtTok.center ?? { x: tgtTok.x, y: tgtTok.y };
      if (shape?.contains?.(c.x, c.y)) {
        dbg("目标在模板内，放行", target?.name);
        return true;
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  // 2) 射程
  const rangeRaw = pickRange(action, actionUse);
  let maxFt = rangeToFeet(rangeRaw, actor, actionUse);

  // 3) 距离
  const dist = measureFt(src, tgtTok);

  // 4) 射程未知
  if (maxFt == null) {
    const policy = unknownRangePolicy();
    dbg("射程解析失败", { rangeRaw, policy, dist });
    if (policy === "allow") return true;
    if (policy === "block") return false;
    maxFt = 5; // touch
  }

  // 5) 比较（touch 允许 1 格容差）
  const gridSize = canvas.grid.size || 100;
  const gridDistance = canvas.grid.distance || 5;
  const oneSquare = (gridSize / gridSize) * gridDistance; // = gridDistance
  const tolerance = maxFt <= 5 ? oneSquare : 0;
  const ok = dist <= maxFt + tolerance;

  dbg(
    ok ? "范围内" : "超出范围",
    {
      目标: target?.name ?? tgtTok.name,
      距离: dist,
      射程: maxFt,
      容差: tolerance,
      rangeRaw,
    }
  );

  return ok;
}

/* ============================================================
 * 敌对判断
 * ========================================================== */

export function dispositionOf(target) {
  const doc = target.document ?? target.token?.document ?? target.token;
  const d = doc?.disposition;
  return typeof d === "number" ? d : 0;
}

export function isHostile(sourceToken, target) {
  const HOSTILE = CONST.TOKEN_DISPOSITIONS?.HOSTILE ?? -1;
  const FRIENDLY = CONST.TOKEN_DISPOSITIONS?.FRIENDLY ?? 1;
  const NEUTRAL = CONST.TOKEN_DISPOSITIONS?.NEUTRAL ?? 0;

  const td = dispositionOf(target);
  const sd = sourceToken?.document?.disposition ?? FRIENDLY;

  // 直接敌对
  if (td === HOSTILE) return true;
  // 施法者友好、目标中立 → 不算敌对（中立生物不会主动害你）
  if (sd === FRIENDLY && td === NEUTRAL) return false;
  // 施法者中立、目标友好 → 不敌对
  if (sd === NEUTRAL && td === FRIENDLY) return false;
  // 其余按“不同阵营”处理
  return sd !== td;
}

/* ============================================================
 * 治疗量
 * ========================================================== */

export function resolveHealAmount(actionUse, message) {
  // 1) 最可靠：ChatAttack 上的 totalDamage（系统自己算好的总和）
  const attacks = actionUse?.shared?.chatAttacks ?? [];
  for (const atk of attacks) {
    const t = Number(atk?.totalDamage);
    if (Number.isFinite(t) && t > 0) return t;
  }

  // 2) 退回逐段 roll 求和
  let sum = 0;
  for (const atk of attacks) {
    for (const r of atk?.damage?.rolls ?? []) {
      if (Number.isFinite(r?.total)) sum += r.total;
    }
  }
  if (sum > 0) return sum;

  // 3) 从 chat message 的 rolls 取
  for (const r of message?.rolls ?? []) {
    if (Number.isFinite(r?.total) && r.total > 0) return r.total;
  }

  // 4) 兜底：直接掷 action 的 damage parts
  try {
    const parts = actionUse?.action?.damage?.parts ?? [];
    let rolled = 0;
    for (const p of parts) {
      const formula = p?.formula;
      if (!formula) continue;
      const roll = new Roll(String(formula), actionUse?.shared?.rollData ?? {});
      roll.evaluateSync?.();
      rolled += Number(roll.total) || 0;
    }
    if (rolled > 0) return rolled;
  } catch (e) {
    console.debug(`${MODULE_ID} | 兜底掷骰失败:`, e);
  }

  return 0;
}

/* ============================================================
 * 【精类遗孤 Fey Foundling】
 * ------------------------------------------------------------
 * 专长效果：受到魔法治疗时，每颗治疗骰额外 +2 点。
 * 所以 2d8+5 的治疗会变成 2d8+5+4。
 * 只影响魔法治疗（本模块处理的全是法术治疗，天然满足）。
 * ========================================================== */

/** 专长名匹配用的归一化：去空格/连字符/下划线，转小写 */
function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[\s\-_·•（）()【】\[\]]/g, "");
}

const FEY_NAMES = ["feyfoundling", "精类遗孤", "精类遗孤feyfoundling"];

/** 目标角色是否拥有【精类遗孤】专长 */
export function hasFeyFoundling(actor) {
  const items = actor?.items;
  if (!items) return false;

  // Collection 有 .contents；普通数组用 as-is
  const list = items.contents ?? (Array.isArray(items) ? items : Array.from(items));
  if (!list?.length) return false;

  for (const it of list) {
    if (!it) continue;
    // 只认专长（有些世界把专长放在 feat 类型里）
    if (it.type && it.type !== "feat") continue;

    const n = normName(it.name);
    if (!n) continue;
    if (FEY_NAMES.some((f) => n === f || n.includes(normName(f)))) {
      return true;
    }
  }
  return false;
}

/** 数这次治疗掷了几颗骰子 */
export function countHealDice(actionUse, message) {
  // 注意排除 d20：message.rolls 里可能混着攻击骰，
  // 那不是治疗骰，误算进去会多给 +2。
  const isHealDie = (faces) => {
    const f = Number(faces);
    return Number.isFinite(f) && f > 1 && f !== 20;
  };

  const diceFromRolls = (rolls) => {
    let n = 0;
    for (const r of rolls ?? []) {
      // roll.terms 里的 Die 项带 faces
      for (const term of r?.terms ?? []) {
        if (isHealDie(term?.faces)) n += Number(term.number) || 0;
      }
    }
    return n;
  };

  // 1) ChatAttack 的伤害骰
  const attacks = actionUse?.shared?.chatAttacks ?? [];
  let n = 0;
  for (const atk of attacks) n += diceFromRolls(atk?.damage?.rolls);
  if (n > 0) return n;

  // 2) chat message 的骰
  n = diceFromRolls(message?.rolls);
  if (n > 0) return n;

  // 3) 从 action.damage.parts 的公式里数（2d8+5 -> 2）
  try {
    const parts = actionUse?.action?.damage?.parts ?? [];
    let total = 0;
    for (const p of parts) {
      const formula = String(p?.formula ?? "");
      if (!formula) continue;
      const re = /(\d*)\s*d\s*(\d+)/gi;
      let mm;
      while ((mm = re.exec(formula)) !== null) {
        const count = mm[1] === "" ? 1 : Number(mm[1]);
        if (Number.isFinite(count) && count > 0) total += count;
      }
    }
    if (total > 0) return total;
  } catch {
    /* 忽略 */
  }

  return 0;
}

/**
 * 把基础治疗量换算成实际治疗量（含【精类遗孤】加成）。
 * 注意：这个必须在能读到 actor.items 的一侧算——玩家对别人的卡
 * 可能看不到专长，所以 GM 端会自己再算一遍。
 */
export function computeHealAmount(actor, base, dice) {
  const amount = Math.abs(Number(base) || 0);
  if (!amount) return 0;

  let enabled = false;
  try {
    enabled = game.settings.get(MODULE_ID, "feyFoundling");
  } catch {
    enabled = false;
  }
  if (!enabled) return amount;

  const d = Number(dice) || 0;
  if (d <= 0) return amount;

  if (!hasFeyFoundling(actor)) return amount;

  const bonus = 2 * d;
  try {
    if (game.settings.get(MODULE_ID, "feyDebug")) {
      console.log(
        `${MODULE_ID} | 【精类遗孤】${actor?.name} 命中：${amount} + 2×${d} = ${amount + bonus}`
      );
    }
  } catch {
    /* 忽略 */
  }
  return amount + bonus;
}

/* ============================================================
 * 应用治疗
 * ========================================================== */

/** 当前用户能不能直接改这个 actor */
export function canModify(actor) {
  if (!actor) return false;
  if (game.user?.isGM) return true;
  return actor.isOwner === true;
}

/** 统一的治疗参数 */
function healOptions() {
  return {
    healing: true,
    asNonLethal: false,
    asWounds: false,
    reduction: 0,
    ratio: 1,
  };
}

/* ---- socketlib：优先通道 ---- */

/** GM 端真正执行治疗 */
async function gmApplyHeal(actorUuid, amount, dice = 0) {
  const actor = await fromUuid(actorUuid);
  if (!actor) {
    console.warn(`${MODULE_ID} | GM 端找不到 actor:`, actorUuid);
    return { ok: false, reason: "actor-not-found" };
  }
  const base = Math.abs(Number(amount) || 0);
  if (!base) return { ok: false, reason: "bad-amount" };

  // GM 端用完整权限重算【精类遗孤】
  const amt = computeHealAmount(actor, base, dice);

  await actor.applyDamage(-amt, healOptions());
  console.log(
    `${MODULE_ID} | GM ${game.user.name} 已代为治疗 ${actor.name} +${amt}` +
      (amt !== base ? `（基础 ${base}，精类遗孤 +${amt - base}）` : "")
  );
  return { ok: true, name: actor.name, amount: amt };
}

function registerSocketlib() {
  if (socketlibSocket) return;
  try {
    if (typeof socketlib === "undefined" || !socketlib?.registerModule) {
      console.warn(`${MODULE_ID} | socketlib 不可用，改用聊天消息通道`);
      return;
    }

    // socketlib 要求 module.socket === true，而这个标记是服务器启动时读的。
    // 如果只刷新了页面，这里会是 false —— 提前说清楚，别让用户猜。
    const mod = game.modules?.get?.(MODULE_ID);
    if (mod && !mod.socket) {
      console.warn(
        `${MODULE_ID} | 本模块的 socket 标记还没生效（module.json 里已写 "socket": true，` +
          `但要重启 FVTT 服务器才会读到）。本次将改用聊天消息通道，功能不受影响。`
      );
      return;
    }

    socketlibSocket = socketlib.registerModule(MODULE_ID);
    if (!socketlibSocket?.register) {
      console.warn(`${MODULE_ID} | socketlib.registerModule 返回空，改用聊天消息通道`);
      socketlibSocket = null;
      return;
    }
    socketlibSocket.register("applyHealAsGM", gmApplyHeal);
    console.log(`${MODULE_ID} | socketlib 通道已注册`);
  } catch (e) {
    console.error(`${MODULE_ID} | socketlib 注册失败，改用聊天消息通道:`, e);
    socketlibSocket = null;
  }
}

Hooks.once("socketlib.ready", registerSocketlib);

/**
 * 应用治疗。
 * 自己能动就自己动；动不了（目标是别人的角色卡）就请 GM 代劳。
 *
 * @param {number} amount 已经算好【精类遗孤】的治疗量（调用方负责）
 * @param {number} dice   本次治疗的骰数；转给 GM 端时用它重算加成
 */
export async function applyHeal(actor, amount, actionUse, message, dice = 0) {
  if (!actor) return null;
  const amt = Math.abs(amount);

  if (canModify(actor)) {
    return actor.applyDamage(-amt, healOptions());
  }

  // 没权限：先看有没有 GM 在线
  const gmOnline = game.users?.some?.((u) => u.isGM && u.active);
  if (!gmOnline) {
    ui.notifications?.warn?.(
      `没有 GM 在线，无法治疗 ${actor.name}（你没有这张卡的权限）。`
    );
    return null;
  }

  // 优先走 socketlib（需要 module.json 的 socket 标记已在服务器端生效）
  if (socketlibSocket) {
    try {
      const res = await socketlibSocket.executeAsGM("applyHealAsGM", actor.uuid, amt, dice);
      if (res?.ok) {
        ui.notifications?.info?.(`已由 GM 代为治疗 ${actor.name} +${res.amount ?? amt}`);
        return res;
      }
      ui.notifications?.warn?.(
        `GM 代为治疗 ${actor.name} 失败：${res?.reason ?? "未知原因"}`
      );
      return null;
    } catch (e) {
      console.error(`${MODULE_ID} | socketlib 调用失败，改用聊天消息通道:`, e);
    }
  }

  // 回退：聊天消息通道（不需要 socket 注册，刷新页面即可用）
  const ok = await requestGmHealViaChat(actor, amt, dice);
  if (ok) {
    ui.notifications?.info?.(`已请求 GM 代为治疗 ${actor.name}（+${amt}）`);
  } else {
    ui.notifications?.warn?.(`无法治疗 ${actor.name}：聊天消息通道也没发出去。`);
  }
  return null;
}

/* ============================================================
 * 聊天消息通道
 * ------------------------------------------------------------
 * 为什么不用 socket：module.json 里的 "socket": true 只有 FVTT
 * 服务器启动时才读，用户只刷新页面的话通道根本没建立。
 * 而「玩家发一条私密聊天消息 → GM 客户端收到」是 Foundry 的
 * 原生文档同步，不需要任何 socket 声明，刷新就能用。
 * ========================================================== */

/** 玩家端：发一条只有 GM 能看到的请求 */
export async function requestGmHealViaChat(actor, amount, dice = 0) {
  try {
    const gmIds = game.users
      ?.filter?.((u) => u.isGM)
      ?.map?.((u) => u.id) ?? [];
    if (!gmIds.length) return false;

    await ChatMessage.create({
      content: `<span></span>`,
      whisper: gmIds,
      blind: true,
      speaker: { alias: MODULE_ID },
      flags: {
        [MODULE_ID]: {
          type: "healRequest",
          actorUuid: actor.uuid,
          amount: Math.abs(amount),
          dice: Number(dice) || 0,
          requesterName: game.user?.name ?? "",
        },
      },
    });
    dbg("已通过聊天消息请求 GM 治疗", actor.name, amount);
    return true;
  } catch (e) {
    console.error(`${MODULE_ID} | 聊天消息请求失败:`, e);
    return false;
  }
}

/** GM 端：收到请求并执行 */
export async function handleHealChatMessage(msg) {
  try {
    if (!game.user?.isGM) return false;

    const flag = msg?.flags?.[MODULE_ID];
    if (flag?.type !== "healRequest") return false;

    // 多个 GM 在线时只让主 GM 处理，避免重复治疗
    const activeGM = game.users?.activeGM;
    if (activeGM && !activeGM.isSelf) return false;

    const actor = await fromUuid(flag.actorUuid);
    if (!actor) {
      console.warn(`${MODULE_ID} | GM 端找不到 actor:`, flag.actorUuid);
      return false;
    }

    const base = Math.abs(Number(flag.amount) || 0);
    if (!base) return false;

    // GM 端用完整权限重新算一次【精类遗孤】——
    // 玩家可能看不到对方卡上的专长，那一步在他那边会漏掉。
    const amt = computeHealAmount(actor, base, flag.dice);

    await actor.applyDamage(-amt, healOptions());
    console.log(
      `${MODULE_ID} | GM ${game.user.name} 代 ${flag.requesterName} 治疗 ${actor.name} +${amt}` +
        (amt !== base ? `（基础 ${base}，精类遗孤 +${amt - base}）` : "")
    );

    // 请求消息用完即删，别占聊天记录
    try {
      await msg.delete?.();
    } catch {
      /* 删不掉也无所谓 */
    }
    return true;
  } catch (e) {
    console.error(`${MODULE_ID} | 处理治疗请求失败:`, e);
    return false;
  }
}

/* ---- 原生 socket：备用通道 ---- */

function setupHealSocket() {
  game.socket?.on?.(SOCKET_CHANNEL, async (payload) => {
    try {
      if (!game.user?.isGM) return; // 只有 GM 处理

      // 多个 GM 在线时只让主 GM 处理，避免重复治疗
      const activeGM = game.users?.activeGM;
      if (activeGM && activeGM.id !== game.user.id) return;

      if (payload?.type !== "requestHeal") return;

      const actor = await fromUuid(payload.actorUuid);
      if (!actor) {
        console.warn(`${MODULE_ID} | 找不到 actor:`, payload.actorUuid);
        return;
      }

      const base = Math.abs(Number(payload.amount) || 0);
      if (!base) return;

      const amt = computeHealAmount(actor, base, payload.dice);

      await actor.applyDamage(-amt, healOptions());
      console.log(
        `${MODULE_ID} | GM ${game.user.name} 代 ${payload.requesterName} 治疗 ${actor.name} +${amt}` +
          (amt !== base ? `（基础 ${base}，精类遗孤 +${amt - base}）` : "")
      );
    } catch (err) {
      console.error(`${MODULE_ID} | GM 代治失败:`, err);
    }
  });
}

/* ============================================================
 * 敌对确认框
 * ========================================================== */

export function askHealHostile(target, amount, healer) {
  const name = target.actor?.name ?? target.name ?? "目标";
  const healerName = healer?.name ?? "施法者";

  return new Promise((resolve) => {
    new Dialog({
      title: L("PF1AUTOHEAL.DialogTitle", "治疗敌对目标？"),
      content: `
        <div style="padding:6px 2px;line-height:1.6">
          <p><strong>${esc(healerName)}</strong> 正在对
             <strong style="color:#c33">${esc(name)}</strong>
             施加治疗。</p>
          <p>目标与施法者敌对，治疗量 <strong>${amount}</strong> 点。</p>
          <p style="color:#666;font-size:0.92em">确定要治疗它吗？</p>
        </div>`,
      buttons: {
        yes: {
          icon: '<i class="fas fa-heart"></i>',
          label: L("PF1AUTOHEAL.Confirm", "治疗"),
          callback: () => resolve(true),
        },
        no: {
          icon: '<i class="fas fa-times"></i>',
          label: L("PF1AUTOHEAL.Cancel", "取消"),
          callback: () => resolve(false),
        },
      },
      default: "no",
      close: () => resolve(false),
    }).render(true);
  });
}
