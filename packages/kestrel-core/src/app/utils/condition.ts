import type { Condition, ConditionOperator, ConditionRule } from '../../server/utils/defineCollection.js'

/** Empty = absent or a "no value" (null/undefined/''/[]). Shared by the evaluator (the `empty`
 * @public
 *  operator + bare-rule presence) and the server's required-when-visible check. 0 and false are values. */
export function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
}

// Path scope is SIBLING-ONLY. A bare name or `./name` resolves a sibling in the current scope;
// cross-scope forms (`/abs`, `../parent`, dotted `a.b`) resolve to undefined instead of throwing, keeping
// the evaluator total — but that only hides the field for `is`/bare-presence rules. `empty: true`, `ne`,
// and `notIn` all match `undefined`, which leaves the field visible.
function resolvePath(field: string, scope: Record<string, unknown>): unknown {
  const key = field.startsWith('./') ? field.slice(2) : field
  if (key === '' || key.startsWith('/') || key.startsWith('..') || key.includes('/') || key.includes('.')) {
    return undefined
  }
  return scope[key]
}

function compare(dep: unknown, target: number | string, op: 'gt' | 'gte' | 'lt' | 'lte'): boolean {
  if (typeof dep !== typeof target || (typeof dep !== 'number' && typeof dep !== 'string')) return false
  if (op === 'gt') return dep > target
  if (op === 'gte') return dep >= target
  if (op === 'lt') return dep < target
  return dep <= target
}

function matchOperator(dep: unknown, op: ConditionOperator): boolean {
  for (const [key, target] of Object.entries(op)) {
    if (target === undefined) continue
    let ok: boolean
    switch (key) {
      case 'eq': ok = dep === target; break
      case 'ne': ok = dep !== target; break
      case 'gt': case 'gte': case 'lt': case 'lte':
        ok = compare(dep, target as number | string, key); break
      case 'in': ok = Array.isArray(target) && (target as unknown[]).includes(dep); break
      case 'notIn': ok = Array.isArray(target) && !(target as unknown[]).includes(dep); break
      case 'regexp': {
        if (typeof dep !== 'string' || typeof target !== 'string') { ok = false; break }
        try { ok = new RegExp(target).test(dep) } catch { ok = false }
        break
      }
      case 'empty': ok = target ? isEmptyValue(dep) : !isEmptyValue(dep); break
      default: ok = false
    }
    if (!ok) return false
  }
  return true
}

function evaluateRule(rule: ConditionRule, scope: Record<string, unknown>): boolean {
  const dep = resolvePath(rule.field, scope)
  if (rule.is !== undefined) return dep === rule.is
  if (rule.op) return matchOperator(dep, rule.op)
  return !isEmptyValue(dep)
}

/** Pure, total (never throws) condition evaluator shared by the editor (hide widgets) and the server
 * @public
 *  (required-when-visible). `scope` is the sibling-value map the condition resolves against. */
export function evaluateCondition(condition: Condition, scope: Record<string, unknown>): boolean {
  if ('and' in condition) return condition.and.every((c) => evaluateCondition(c, scope))
  if ('or' in condition) return condition.or.some((c) => evaluateCondition(c, scope))
  if ('not' in condition) return !evaluateCondition(condition.not, scope)
  return evaluateRule(condition, scope)
}

/** Whether a field is shown given the sibling-value `scope`. No condition =\> always visible.
 * @public
 */
export function isFieldVisible(field: { condition?: Condition } | null | undefined, scope: Record<string, unknown>): boolean {
  return !field?.condition || evaluateCondition(field.condition, scope)
}
