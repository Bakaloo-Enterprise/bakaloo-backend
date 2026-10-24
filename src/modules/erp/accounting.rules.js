/**
 * Pure accounting rules for the Operations ERP. No database: every figure here can be checked by hand in a test.
 * Money in this module is a MANAGEMENT view (what the records say), not a statutory book — see the screen's footnote.
 */
const r2 = (n) => Math.round(n * 100) / 100

export const EXPENSE_CATEGORIES = Object.freeze({
  RENT: { label: 'Rent', kind: 'FIXED' },
  SALARY: { label: 'Salaries', kind: 'FIXED' },
  ELECTRICITY: { label: 'Electricity & water', kind: 'FIXED' },
  INTERNET: { label: 'Internet & phone', kind: 'FIXED' },
  TAXES: { label: 'Taxes & licences', kind: 'FIXED' },
  TRANSPORT: { label: 'Transport & fuel', kind: 'VARIABLE' },
  PACKING: { label: 'Packing material', kind: 'VARIABLE' },
  RIDER_PAY: { label: 'Rider payouts', kind: 'VARIABLE' },
  MARKETING: { label: 'Marketing', kind: 'VARIABLE' },
  GATEWAY_FEES: { label: 'Payment gateway fees', kind: 'VARIABLE' },
  MAINTENANCE: { label: 'Repairs & maintenance', kind: 'VARIABLE' },
  OTHER: { label: 'Other', kind: 'VARIABLE' },
})

export const CASH_KINDS = Object.freeze({
  OPENING_BALANCE: { label: 'Opening balance', needsAccount: true },
  OWNER_CAPITAL: { label: 'Money the owner put in', needsAccount: true },
  OWNER_DRAWING: { label: 'Money the owner took out', needsAccount: true },
  OTHER_INCOME: { label: 'Other income', needsAccount: true },
  BANK_DEPOSIT: { label: 'Cash put in the bank', needsAccount: false },
  BANK_WITHDRAWAL: { label: 'Cash taken from the bank', needsAccount: false },
})

export const MAX_AMOUNT = 100_000_000

/** Why an amount cannot be recorded; null when fine. */
export function amountProblem(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 'Amount must be more than zero.'
  if (n > MAX_AMOUNT) return 'Amount is too large.'
  if (Math.round(n * 100) / 100 !== n) return 'Use at most 2 decimals.'
  return null
}

/** Which box a payment method fills or empties: physical cash, or the bank (UPI, bank transfer, gateway, cheques …). */
export const accountOfMethod = (m) => (m === 'CASH' ? 'CASH' : 'BANK')

/** What a cash-book entry does to each account. Opening balances are the starting point, not a flow. */
export function flowOf(e) {
  const a = r2(Number(e.amount))
  switch (e.kind) {
    case 'OWNER_CAPITAL': case 'OTHER_INCOME': return [{ account: e.account, delta: a }]
    case 'OWNER_DRAWING': return [{ account: e.account, delta: -a }]
    case 'BANK_DEPOSIT': return [{ account: 'CASH', delta: -a }, { account: 'BANK', delta: a }]
    case 'BANK_WITHDRAWAL': return [{ account: 'BANK', delta: -a }, { account: 'CASH', delta: a }]
    default: return [] // OPENING_BALANCE
  }
}

/** Starts an empty ledger for the two boxes. `in`/`out` are lists so the screen can show exactly where the money came from. */
export const emptyBooks = () => ({ CASH: { in: [], out: [] }, BANK: { in: [], out: [] } })

/** Adds one line (label, amount) to an account. Zero lines are dropped; negative amounts are refused. */
export function add(books, account, direction, label, amount) {
  const a = r2(Number(amount))
  if (!(a >= 0)) throw new Error(`negative amount for ${label}`)
  if (a === 0) return
  const list = books[account][direction]
  const hit = list.find((x) => x.label === label)
  if (hit) hit.amount = r2(hit.amount + a)
  else list.push({ label, amount: a })
}

export const total = (list) => r2(list.reduce((t, x) => t + x.amount, 0))

/** Net movement per account from the books. */
export const netOf = (books) => ({ CASH: r2(total(books.CASH.in) - total(books.CASH.out)), BANK: r2(total(books.BANK.in) - total(books.BANK.out)) })

/**
 * Profit & loss for a month: the stock-ledger profit (sales − cost of goods − wastage) minus running costs, plus other income.
 * `profit` is the valuation module's profit block: { sales, cogs, gross, loss, afterLoss }.
 */
export function profitAndLoss({ profit, expenses, otherIncome }) {
  const byCategory = {}
  for (const e of expenses) {
    const c = (byCategory[e.category] ??= { category: e.category, label: EXPENSE_CATEGORIES[e.category]?.label ?? e.category, kind: e.kind, amount: 0, count: 0 })
    c.amount = r2(c.amount + Number(e.amount)); c.count += 1
  }
  const lines = Object.values(byCategory).sort((a, b) => b.amount - a.amount)
  const fixed = r2(lines.filter((l) => l.kind === 'FIXED').reduce((t, l) => t + l.amount, 0))
  const variable = r2(lines.filter((l) => l.kind === 'VARIABLE').reduce((t, l) => t + l.amount, 0))
  const opex = r2(fixed + variable)
  const operating = r2(profit.afterLoss - opex)
  const net = r2(operating + otherIncome)
  return {
    sales: profit.sales, cogs: profit.cogs, gross: profit.gross, grossMarginPct: profit.sales > 0 ? Math.round((profit.gross / profit.sales) * 1000) / 10 : null,
    wastage: profit.loss, afterWastage: profit.afterLoss,
    expenses: { fixed, variable, total: opex, byCategory: lines },
    operatingProfit: operating, otherIncome: r2(otherIncome), netProfit: net,
    netMarginPct: profit.sales > 0 ? Math.round((net / profit.sales) * 1000) / 10 : null,
    breakEvenSales: profit.sales > 0 && profit.afterLoss > 0 ? r2(opex / (profit.afterLoss / profit.sales)) : null, // sales needed for what is left after goods and wastage to cover running costs
  }
}
