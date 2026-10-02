import { CrmError } from './errors.js'
import { canAccessConversation } from './access.js'
import { decideAutoMove, scoreCard, targetAutoStage } from './pipeline.js'

const PRIORITY_ORDER = { HIGH: 0, MEDIUM: 1, NORMAL: 2 }

export class PipelineService {
  /**
   * @param {{ repo: import('./pipeline.repository.js').PipelineRepository,
   *           emit: (e: string, p: object) => void,
   *           logger: { info: Function, warn: Function },
   *           now?: () => Date }} deps
   */
  constructor({ repo, emit, logger, now = () => new Date() }) {
    this.repo = repo
    this.emit = emit
    this.logger = logger
    this.now = now
    this._stages = null
  }

  async stagesByKey() {
    // Stages are tiny and rarely change; cached per process, refreshed when a key is missing.
    if (!this._stages) this._stages = new Map((await this.repo.listStages()).map((s) => [s.key, s]))
    return this._stages
  }

  // ─── Automation ───────────────────────────────────────────────────
  /**
   * Apply the automatic rules to candidate rows. Returns the moves made.
   * @returns {Promise<Array<{ contactId: string, from: string|null, to: string }>>}
   */
  async applyAutomation(rows) {
    let stages = await this.stagesByKey()
    const moves = []
    for (const r of rows) {
      const targetKey = targetAutoStage({ hasUser: r.has_user, orderCount: r.order_count, hasOutbound: r.has_outbound })
      let target = stages.get(targetKey)
      if (!target) {
        this._stages = null
        stages = await this.stagesByKey()
        target = stages.get(targetKey)
        if (!target) continue // stage deleted/deactivated by an admin: leave the card alone
      }
      const decision = decideAutoMove({
        currentKey: r.stage_key ?? null,
        currentIsAuto: r.stage_is_auto,
        currentSource: r.stage_source,
        targetKey,
      })
      if (!decision.move) continue
      const done = await this.repo.setStage(r.contact_id, target.id, 'AUTO', decision.reason)
      if (done) moves.push({ contactId: r.contact_id, from: done.fromStageId, to: done.toStageId })
    }
    return moves
  }

  /** Cheap, targeted: used right after a new contact appears or an agent first replies. Never throws. */
  async evaluateContact(contactId) {
    try {
      const moves = await this.applyAutomation(await this.repo.reconcileCandidates({ contactId }))
      if (moves.length) this.emit('crm:pipeline', { contactIds: moves.map((m) => m.contactId) })
      return moves
    } catch (err) {
      this.logger.warn({ err: err.message, contactId }, 'Pipeline evaluation failed (will be retried by reconcile)')
      return []
    }
  }

  /** Self-healing sweep, run every minute by the worker. */
  async reconcile() {
    const linked = await this.repo.linkContactsByPhone()
    const moves = await this.applyAutomation(await this.repo.reconcileCandidates())
    if (moves.length || linked) {
      this.logger.info({ linked, moved: moves.length }, 'WhatsApp pipeline reconcile changed cards')
      this.emit('crm:pipeline', { contactIds: moves.map((m) => m.contactId) })
    }
    return { linked, moved: moves.length }
  }

  // ─── Board ────────────────────────────────────────────────────────
  /**
   * Cards grouped by stage, highest priority first. Agents without view_all
   * only get their own + unassigned cards (same rule as the inbox).
   */
  async board(filters, canSeeAll, userId) {
    const stages = await this.repo.listStages()
    const limit = 500
    const rows = await this.repo.board({ ...filters, visibleTo: canSeeAll ? undefined : userId, limit })
    const truncated = rows.length > limit
    const now = this.now()

    const byStage = new Map(stages.map((s) => [s.id, []]))
    const unstaged = []
    for (const r of rows.slice(0, limit)) {
      const sc = scoreCard(
        {
          lastDirection: r.last_message_direction,
          lastMessageAt: r.last_message_at,
          windowOpen: r.window_open,
          openCartValue: Number(r.open_cart_value),
          orderCount: r.order_count,
          totalSpend: Number(r.total_spend),
          isB2b: r.is_b2b,
          isVip: r.is_vip,
          hasOwner: Boolean(r.assigned_to),
        },
        now,
      )
      const card = { ...r, ...sc }
      ;(byStage.get(r.stage_id) ?? unstaged).push(card)
    }
    const sortCards = (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.score - a.score
    return {
      stages: stages.map((s) => ({ ...s, cards: byStage.get(s.id).sort(sortCards) })),
      // Cards not yet staged (brand-new, before the first evaluation) — shown in the first column by the UI.
      unstaged: unstaged.sort(sortCards),
      truncated,
    }
  }

  // ─── Manual move ──────────────────────────────────────────────────
  async moveCard(contactId, stageId, access) {
    const conv = await this.repo.conversationForContact(contactId)
    // Same answer for missing and not-yours, like the inbox.
    if (!conv || !canAccessConversation(access, conv)) throw new CrmError('Customer not found', 404, 'CONTACT_NOT_FOUND')
    const stage = await this.repo.getStage(stageId)
    if (!stage) throw new CrmError('Stage not found', 404, 'STAGE_NOT_FOUND')
    const done = await this.repo.setStage(contactId, stage.id, 'MANUAL', 'moved by agent', access.userId)
    if (done) this.emit('crm:pipeline', { contactIds: [contactId] })
    return { changed: Boolean(done), stageId: stage.id }
  }

  async history(contactId, access) {
    const conv = await this.repo.conversationForContact(contactId)
    if (!conv || !canAccessConversation(access, conv)) throw new CrmError('Customer not found', 404, 'CONTACT_NOT_FOUND')
    return this.repo.history(contactId)
  }
}
