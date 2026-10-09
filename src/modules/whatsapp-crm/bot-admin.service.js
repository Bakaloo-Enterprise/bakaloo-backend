import { CrmError } from './errors.js'
import { normalize } from './bot.js'

const MAX_KEYWORDS = 50
const MAX_EXACT = 20
const MAX_REPLY = 1000
const NO_KEYWORD_TYPES = new Set(['PINCODE', 'AREA_YES', 'AREA_NO', 'AREA_ASKED', 'PRODUCT'])
const NO_REPLY_ACTIONS = new Set(['HANDOFF', 'IGNORE'])
const isHttps = (u) => { try { return new URL(u).protocol === 'https:' } catch { return false } }

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
    for (const [key, label] of [['playStoreUrl', 'Play Store link'], ['appStoreUrl', 'App Store link'], ['websiteUrl', 'Website link']]) {
      if (input[key] !== undefined && !isHttps(input[key])) throw new CrmError(`${label} must be a full https:// address`, 400, 'INVALID_SETTINGS')
    }
    const t = (v) => (v === undefined ? undefined : v.trim())
    return this.botRepo.updateSettings(
      { ...input, fallbackText: t(input.fallbackText), fallbackTextGu: t(input.fallbackTextGu), fallbackTextGl: t(input.fallbackTextGl) },
      userId,
    )
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
      replyTextGu: input.replyTextGu !== undefined ? input.replyTextGu : existing.reply_text_gu,
      replyTextGl: input.replyTextGl !== undefined ? input.replyTextGl : existing.reply_text_gl,
      asksArea: input.asksArea ?? existing.asks_area,
      cooldownMinutes: input.cooldownMinutes ?? existing.cooldown_minutes,
      isActive: input.isActive ?? existing.is_active,
    })
    return this.botRepo.updateRule(id, { ...merged, replyText: merged.replyText ?? null, replyTextGu: merged.replyTextGu ?? null, replyTextGl: merged.replyTextGl ?? null })
  }

  async deleteRule(id) {
    if (!(await this.botRepo.deleteRule(id))) throw new CrmError('Rule not found', 404, 'RULE_NOT_FOUND')
  }

  async reorder(ids) {
    await this.botRepo.reorder(ids)
    return this.botRepo.listRules()
  }

  // ─── Delivery areas, product words, waiting list ──────────────────
  async listAreas() {
    return this.botRepo.listAreas({ onlyActive: false })
  }

  cleanArea(i, partial = false) {
    const bad = (m) => new CrmError(m, 400, 'INVALID_AREA')
    const out = {}
    if (!partial || i.name !== undefined) {
      const name = String(i.name ?? '').trim()
      if (!name) throw bad('Give the area a name')
      out.name = name.slice(0, 80)
    }
    if (i.nameGu !== undefined) out.nameGu = String(i.nameGu ?? '').trim().slice(0, 80) || null
    if (i.aliases !== undefined) {
      const seen = new Set()
      out.aliases = []
      for (const raw of i.aliases) {
        const a = String(raw).trim()
        const n = normalize(a).replace(/ /g, '')
        if (n.length < 3) throw bad(`“${a}” is too short to be a safe spelling (3+ letters)`)
        if (!seen.has(n)) {
          seen.add(n)
          out.aliases.push(a.slice(0, 60))
        }
      }
    }
    for (const k of ['isServiceable', 'isActive', 'position']) if (i[k] !== undefined) out[k] = i[k]
    return out
  }

  async createArea(input) {
    try {
      return await this.botRepo.createArea(this.cleanArea(input))
    } catch (err) {
      if (err.code === '23505') throw new CrmError('That area already exists', 409, 'AREA_EXISTS')
      throw err
    }
  }

  async updateArea(id, input) {
    try {
      const row = await this.botRepo.updateArea(id, this.cleanArea(input, true))
      if (!row) throw new CrmError('Area not found', 404, 'AREA_NOT_FOUND')
      return row
    } catch (err) {
      if (err.code === '23505') throw new CrmError('That area already exists', 409, 'AREA_EXISTS')
      throw err
    }
  }

  async deleteArea(id) {
    if (!(await this.botRepo.deleteArea(id))) throw new CrmError('Area not found', 404, 'AREA_NOT_FOUND')
  }

  async waitingList() {
    return this.botRepo.waitingList()
  }

  async listProductAliases() {
    return this.botRepo.listProductAliases()
  }

  async addProductAlias({ alias, searchTerm }) {
    const a = String(alias ?? '').trim()
    const t = String(searchTerm ?? '').trim()
    if (normalize(a).length < 2 || !t) throw new CrmError('Enter the word customers type and the catalog name it means', 400, 'INVALID_ALIAS')
    return this.botRepo.addProductAlias(a.slice(0, 60), t.slice(0, 60))
  }

  async deleteProductAlias(id) {
    if (!(await this.botRepo.deleteProductAlias(id))) throw new CrmError('Word not found', 404, 'ALIAS_NOT_FOUND')
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

    if (NO_KEYWORD_TYPES.has(i.matchType)) {
      // PIN / area / product rules match on facts, not keywords
    } else {
      if (keywords.length + exactKeywords.length === 0) throw bad('Add at least one keyword')
      if (i.matchType === 'CONTAINS' || i.matchType === 'STARTS_WITH') {
        // A bare digit or single letter would fire inside ordinary sentences ("2 kg onions").
        const risky = keywords.find((k) => /^\p{N}+$/u.test(normalize(k)) || normalize(k).length < 2)
        if (risky) throw bad(`“${risky}” would match inside normal sentences. Put numbers and very short words in “Exact keywords” instead.`)
      }
    }

    const replyText = i.replyText == null ? null : String(i.replyText).trim()
    if (!NO_REPLY_ACTIONS.has(i.action) && !replyText) throw bad('Write the reply the customer should receive')
    if (replyText && replyText.length > MAX_REPLY) throw bad(`The reply is too long (max ${MAX_REPLY} characters)`)
    const other = (v, label) => {
      const x = v == null ? null : String(v).trim()
      if (x && x.length > MAX_REPLY) throw bad(`The ${label} reply is too long (max ${MAX_REPLY} characters)`)
      return x || null
    }
    const replyTextGu = other(i.replyTextGu, 'Gujarati')
    const replyTextGl = other(i.replyTextGl, 'Roman Gujarati')

    return {
      name,
      matchType: i.matchType,
      keywords: NO_KEYWORD_TYPES.has(i.matchType) ? [] : keywords,
      exactKeywords: NO_KEYWORD_TYPES.has(i.matchType) ? [] : exactKeywords,
      whenHours: i.whenHours ?? 'ANY',
      action: i.action ?? 'REPLY',
      replyText: replyText || null,
      replyTextGu,
      replyTextGl,
      asksArea: i.asksArea ?? false,
      cooldownMinutes: i.cooldownMinutes ?? 0,
      isActive: i.isActive ?? true,
    }
  }
}
