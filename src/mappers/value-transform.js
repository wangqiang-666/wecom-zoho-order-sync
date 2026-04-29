/**
 * 主表行值 → ZOHO 字段值的类型转换 + picklist 白名单校验
 *
 * 输入： rawRow   —— { 主表列名: 原始文本值 } （从企微表格读来的）
 *        fieldMap —— config/field-map.json 已加载的对象
 * 输出： { ok: true, payload: {...}, warnings: [...] }
 *       { ok: false, errors: [{ field, reason }] }
 */

const logger = require("../utils/logger");

function toStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function parseInt_(v) {
  const s = toStr(v).replace(/,/g, "");
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return NaN;
  return n;
}

function parseFloat_(v) {
  const s = toStr(v).replace(/,/g, "").replace(/[¥￥$]/g, "");
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return n;
}

function parseBool(v) {
  const s = toStr(v).toLowerCase();
  if (s === "") return null;
  if (["是", "true", "1", "y", "yes", "√"].includes(s)) return true;
  if (["否", "false", "0", "n", "no", "×"].includes(s)) return false;
  return undefined; // 非法
}

function parseDate(v) {
  const s = toStr(v);
  if (s === "") return null;
  // 企微 FIELD_TYPE_DATE_TIME 返回毫秒时间戳（13 位）
  if (/^\d{13}$/.test(s)) {
    const d = new Date(Number(s));
    if (isNaN(d.getTime())) return undefined;
    return d.toISOString().slice(0, 10);
  }
  // 支持 2026/04/21、2026-04-21、2026年4月21日
  const m = s.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function parseMultiselect(v) {
  const s = toStr(v);
  if (s === "") return [];
  return s.split(/[;|；,，\n]/).map((x) => x.trim()).filter(Boolean);
}

/**
 * 判断字段是否必填（支持运行时 override）
 * @param {object} spec - field-map 里的字段定义
 * @param {string[]|null} override - 运行时 override 数组（null = 回落默认）
 * @param {Set<string>} locked - 锁定必填的源字段集（如「主题」）
 * @returns {boolean}
 */
function isFieldRequired(spec, override, locked) {
  if (override === null) return !!spec.required;  // 未配置 → 用 field-map 默认
  return locked.has(spec.source) || override.includes(spec.source);
}

/**
 * 转换单行
 * defaultOwnerId: 姓名反查失败时的兜底 ZOHO user.id
 * currency: 默认币种（写入 field22）
 * lookupResolver: async(moduleApiName, displayName) => recordId | null
 * userResolver:   async(displayName) => userId | null  (表格「订单所有者」姓名 → ZOHO user.id)
 * requiredOverride: string[] | null  (运行时必填字段 override，null = 回落 field-map 默认)
 * lockedSources: Set<string>  (锁定必填的源字段集，如「主题」)
 */
async function transformRow({ rawRow, fieldMap, defaultOwnerId, currency, lookupResolver, userResolver, requiredOverride = null, lockedSources = new Set() }) {
  const payload = {};
  const errors = [];
  const warnings = [];

  for (const spec of fieldMap.fields) {
    if (spec.type === "local") continue;

    const raw = rawRow[spec.source];
    const isEmpty = raw === undefined || raw === null || toStr(raw) === "";

    // 必填检查（支持运行时 override）
    // ownerlookup：勾了必填 → 空值就报错（与其他字段一致）；
    //             没勾必填 → 空值会落到 fallback default owner（保持原行为）
    if (isFieldRequired(spec, requiredOverride, lockedSources) && isEmpty) {
      errors.push({ field: spec.source, reason: "必填为空" });
      continue;
    }
    if (isEmpty && spec.type !== "ownerlookup") continue;

    try {
      switch (spec.type) {
        case "text":
        case "textarea":
          payload[spec.target] = toStr(raw);
          break;

        case "integer": {
          const n = parseInt_(raw);
          if (n === null) break;
          if (Number.isNaN(n)) {
            errors.push({ field: spec.source, reason: `非整数: ${raw}` });
            break;
          }
          payload[spec.target] = n;
          break;
        }

        case "double": {
          const n = parseFloat_(raw);
          if (n === null) break;
          if (Number.isNaN(n)) {
            errors.push({ field: spec.source, reason: `非数字: ${raw}` });
            break;
          }
          payload[spec.target] = n;
          break;
        }

        case "boolean": {
          const b = parseBool(raw);
          if (b === null) break;
          if (b === undefined) {
            errors.push({ field: spec.source, reason: `无法识别的布尔值: ${raw}` });
            break;
          }
          payload[spec.target] = b;
          break;
        }

        case "date": {
          const d = parseDate(raw);
          if (d === null) break;
          if (d === undefined) {
            errors.push({ field: spec.source, reason: `日期格式无法解析: ${raw}` });
            break;
          }
          payload[spec.target] = d;
          break;
        }

        case "picklist": {
          const v = toStr(raw);
          if (spec.picklist && !spec.picklist.includes(v)) {
            errors.push({
              field: spec.source,
              reason: `值「${v}」不在允许清单: ${spec.picklist.join("/")}`,
            });
            break;
          }
          payload[spec.target] = v;
          break;
        }

        case "multiselectpicklist": {
          const arr = parseMultiselect(raw);
          if (spec.picklist) {
            const bad = arr.filter((x) => !spec.picklist.includes(x));
            if (bad.length) {
              errors.push({
                field: spec.source,
                reason: `值 ${bad.join(",")} 不在允许清单`,
              });
              break;
            }
          }
          payload[spec.target] = arr;
          break;
        }

        case "ownerlookup": {
          // 用户查找：表格填姓名，反查 ZOHO user.id
          // 支持 Owner（订单所有者）和其他用户查找字段（如 field8 业务员）
          const nameRaw = toStr(raw);
          let resolvedId = null;
          if (nameRaw && userResolver) {
            try {
              resolvedId = await userResolver(nameRaw);
            } catch (e) {
              warnings.push(`${spec.source} 反查异常 「${nameRaw}」: ${e.message}`);
            }
          }
          if (!resolvedId) {
            // 反查不到 → 落回默认 owner（Admin），并 warn 而非失败
            // 录单人离职/姓名不规范不应阻断整个订单同步
            if (!defaultOwnerId) {
              errors.push({ field: spec.source, reason: "默认订单所有者未配置" });
              break;
            }
            if (nameRaw) {
              warnings.push(`${spec.source}「${nameRaw}」无法匹配 ZOHO 用户，已落回默认 owner`);
            }
            resolvedId = defaultOwnerId;
          }
          // 根据 target 决定写入哪个字段
          if (spec.target === "Owner") {
            payload.Owner = { id: resolvedId };
          } else {
            payload[spec.target] = { id: resolvedId };
          }
          break;
        }

        case "lookup": {
          if (!spec.lookup || spec.lookup.startsWith("<TODO")) {
            warnings.push(`${spec.source}: lookup 关联模块未确认，暂跳过`);
            break;
          }
          const v = toStr(raw);
          if (!lookupResolver) {
            warnings.push(`${spec.source}: 无 lookupResolver，跳过`);
            break;
          }
          const id = await lookupResolver(spec.lookup, v, spec.lookupSearchField);
          if (!id) {
            errors.push({
              field: spec.source,
              reason: `在模块 ${spec.lookup} 中找不到「${v}」`,
            });
            break;
          }
          payload[spec.target] = { id };
          break;
        }

        default:
          warnings.push(`${spec.source}: 未知类型 ${spec.type}`);
      }
    } catch (e) {
      errors.push({ field: spec.source, reason: e.message });
    }
  }

  // 币种兜底
  if (payload[fieldMap._constants.currencyField] === undefined &&
      payload.field20 !== undefined) {
    payload[fieldMap._constants.currencyField] = currency || fieldMap._constants.currencyDefault;
  }

  // 需求1：人民币快递金额 (field218) = 原币订单金额 (field20)
  // 企微表格"10订单金额" → ZOHO field20（原币订单金额）+ field218（人民币快递金额）
  if (payload.field20 !== undefined) {
    payload.field218 = payload.field20;
  }

  // 需求3：订单状态 (field62) 默认值 = "正常"
  if (payload.field62 === undefined) {
    payload.field62 = "正常";
  }

  // 下单日期 (field90)：已停用 - 不对此字段进行任何操作，插入时保持空白
  // if (payload.field90 === undefined) {
  //   payload.field90 = new Date().toISOString().slice(0, 10);
  // }

  return errors.length === 0
    ? { ok: true, payload, warnings }
    : { ok: false, errors, warnings };
}

module.exports = { transformRow };
