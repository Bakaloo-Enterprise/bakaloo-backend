import { CrmError } from './errors.js'
import { normalize } from './bot.js'

const MAX_KEYWORDS = 50
const MAX_EXACT = 20
const MAX_REPLY = 1000

/** Validation + persistence for bot rules and settings (managers only; permission checked by the route). */
export class BotAdminService {
  /**
   * @param {{ botRepo: import('./bot.repository.js').BotRepository, emit: (e: string, p: object) => void }} deps
   */
  constructor({ botRepo }) {
    this.botRepo = botRepo
  }

  async getSettings() {
    return this.botRepo.getSettings()
  }

  async updateSettings(input, userId) {
    if (input.fallbackText !== undefined && !input.fallbackText.trim()) {
      throw new CrmError('The fallback message cannot be empty (turn it off instead)', 400, 'INVALID_SETTINGS')
    }
    return this.botRepo.updateSettings({ ...input, fallbackText: input.fallbackText?.trim() }, userId)
  }

  async listRules() {
    return this.botRepo.listRules()
  }

  async createRule(input, userId) {
    const rule = this.validate(input)
    return this.botRepo.createRule(rule, userId)
  }

  async updateRule(id, input) {
    const existing = await this.botRepo.getRule(id)
    if (!existing) throw new CrmError('Rule not found', 404, 'RULE_NOT_FOUND')
    // Validate the MERGED result so a partial edit cannot leave an inconsistent rule.
    const merged = this.validate({
      name: input.name ?? existing.name,
      matchType: input.matchType ?? existing.match_type,
      keywords: input.keywords ?? existing.keywords,
      exactKeywords: input.exactKeywords ?? existing.exact_keywords,
      whenHours: input.whenHours ?? existing.when_hours,
      action: input.action ?? existing.action,
      replyText: input.replyText !== undefined ? input.replyText : existing.reply_text,
      cooldownMinutes: input.cooldownMinutes ?? existing.cooldown_minutes,
      isActive: input.isActive ?? existing.is_active,
    })
    return this.botRepo.updateRule(id, { ...merged, replyText: merged.replyText ?? null })
  }

  async deleteRule(id) {
    if (!(await this.botRepo.deleteRule(id))) throw new CrmError('Rule not found', 404, 'RULE_NOT_FOUND')
  }

  async reorder(ids) {
    await this.botRepo.reorder(ids)
    return this.botRepo.listRules()
  }

  /** @returns normalised rule fields, or throws CrmError 400 */
  validate(i) {
    const bad = (m) => new CrmError(m, 400, 'INVALID_RULE')
    const name = String(i.name ?? '').trim()
    if (!name) throw bad('Give the rule a name')

    const clean = (list, max, label) => {
      const seen = new Set()
      const out = []
      for (const raw of list ?? []) {
        const kw = String(raw).trim()
        const n = normalize(kw)
        if (!n) continue
        if (n.length > 60) throw bad(`${label} “${kw.slice(0, 20)}…” is too long`)
        if (!seen.has(n)) {
          seen.add(n)
          out.push(kw)
        }
      }
      if (out.length > max) throw bad(`Too many ${label.toLowerCase()}s (max ${max})`)
      return out
    }
    const keywords = clean(i.keywords, MAX_KEYWORDS, 'Keyword')
    const exactKeywords = clean(i.exactKeywords, MAX_EXACT, 'Exact keyword')

    if (i.matchType === 'PINCODE') {
      // keywords are meaningless for a PIN-code rule
    } else {
      if (keywords.length + exactKeywords.length === 0) throw bad('Add at least one keyword')
      if (i.matchType === 'CONTAINS' || i.matchType === 'STARTS_WITH') {
        // A bare digit or single letter would fire inside ordinary sentences ("2 kg onions").
        const risky = keywords.find((k) => /^\p{N}+$/u.test(normalize(k)) || normalize(k).length < 2)
        if (risky) throw bad(`“${risky}” would match inside normal sentences. Put numbers and very short words in “Exact keywords” instead.`)
      }
    }

    const replyText = i.replyText == null ? null : String(i.replyText).trim()
    if (i.action !== 'HANDOFF' && !replyText) throw bad('Write the reply the customer should receive')
    if (replyText && replyText.length > MAX_REPLY) throw bad(`The reply is too long (max ${MAX_REPLY} characters)`)

    return {
      name,
      matchType: i.matchType,
      keywords: i.matchType === 'PINCODE' ? [] : keywords,
      exactKeywords: i.matchType === 'PINCODE' ? [] : exactKeywords,
      whenHours: i.whenHours ?? 'ANY',
      action: i.action ?? 'REPLY',
      replyText: replyText || null,
      cooldownMinutes: i.cooldownMinutes ?? 0,
      isActive: i.isActive ?? true,
    }
  }
}
