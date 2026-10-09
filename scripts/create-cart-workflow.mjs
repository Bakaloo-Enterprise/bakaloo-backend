#!/usr/bin/env node
/**
 * Create the recommended abandoned-cart WhatsApp workflow (it is saved SWITCHED OFF unless --activate).
 *
 *   node scripts/create-cart-workflow.mjs                 # DRY RUN: shows what would be created, writes nothing
 *   node scripts/create-cart-workflow.mjs --apply         # creates it, switched off (review it on the Workflows page)
 *   node scripts/create-cart-workflow.mjs --apply --activate
 *   node scripts/create-cart-workflow.mjs --template my_template_name --delay 5
 *   node scripts/create-cart-workflow.mjs --map body.1=customer_name    # templates with numbered variables ({{1}})
 *
 * What it sets up: a cart idle for 5 minutes -> the approved template (with the customer's cart picture when the
 * template has an image) -> if Meta can't deliver the template and the customer wrote in the last 24 hours, a normal
 * message in Gujarati / English / Roman Gujarati. One reminder per customer per day.
 *
 * It refuses to create a second cart workflow when one already exists (two would double-message customers):
 * edit the existing one on the Workflows page instead, or pass --force.
 */
import { query, closePool } from '../src/config/database.js'
import { env } from '../src/config/env.js'
import { WorkflowRepository } from '../src/modules/whatsapp-crm/workflow.repository.js'
import { WorkflowService } from '../src/modules/whatsapp-crm/workflow.service.js'
import { TemplateRepository } from '../src/modules/whatsapp-crm/template.repository.js'
import { summarizeComponents } from '../src/modules/whatsapp-crm/template.js'

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true)
}
const apply = process.argv.includes('--apply')
const activate = process.argv.includes('--activate')
const force = process.argv.includes('--force')
const templateName = arg('template', 'abandon_cart_reminder_normal')
const delay = Number(arg('delay', 5))
// --map body.1=customer_name  (repeatable): what a numbered template variable means
const explicitMap = {}
process.argv.forEach((a, i) => {
  if (process.argv[i - 1] === '--map' && a.includes('=')) explicitMap[a.slice(0, a.indexOf('='))] = a.slice(a.indexOf('=') + 1)
})

const TOKENS = ['customer_name', 'cart_value', 'item_count', 'cart_items', 'cart_link']
const SYNONYMS = {
  name: 'customer_name', first_name: 'customer_name', customer: 'customer_name', username: 'customer_name',
  link: 'cart_link', url: 'cart_link', cart_url: 'cart_link', checkout_link: 'cart_link',
  amount: 'cart_value', total: 'cart_value', value: 'cart_value', cart_total: 'cart_value',
  items: 'cart_items', products: 'cart_items', item: 'cart_items', count: 'item_count',
}
const TEXTS = {
  gu: 'નમસ્તે {{customer_name}} 👋\nતમારી Bakaloo Cart માં {{cart_items}} (₹{{cart_value}}) રહી ગયું છે. 🛒\nOrder પૂરો કરો અને તાજા શાકભાજી તમારા ઘરે મેળવો:\n{{cart_link}}\nકોઈ મદદ જોઈએ તો અહીં જ લખો.',
  en: 'Hi {{customer_name}} 👋\nYou left {{cart_items}} (₹{{cart_value}}) in your Bakaloo cart. 🛒\nComplete your order here:\n{{cart_link}}\nNeed help? Just reply here.',
  gl: 'Namaste {{customer_name}} 👋\nTamari Bakaloo cart ma {{cart_items}} (₹{{cart_value}}) rahi gayu chhe. 🛒\nOrder purn karva ahi click karo:\n{{cart_link}}\nKoi madad joiye to ahi j lakho.',
}

try {
  const existing = await query(`SELECT id, name, is_active FROM wa_workflows WHERE trigger_type = 'CART_ABANDONED' ORDER BY created_at`)
  if (existing.rows.length && !force) {
    console.log('A cart-abandoned workflow already exists, so nothing was created:')
    for (const w of existing.rows) console.log(`  - "${w.name}"  (${w.is_active ? 'ON' : 'OFF'})  ${w.id}`)
    console.log('\nOpen WhatsApp CRM -> Workflows, edit it, and set "Remind the same customer at most once every" and the')
    console.log('"normal message" texts (button: Use suggested text). Re-run with --force only if you really want a second one.')
    process.exitCode = 0
  } else {
    const tpl = (await query(`SELECT * FROM wa_templates WHERE name = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1`, [templateName])).rows[0]
    if (!tpl) throw new Error(`No APPROVED template named "${templateName}". Check the name on the Templates page (or pass --template NAME).`)

    const vars = summarizeComponents(tpl.components, tpl.parameter_format).variables
    const values = {}
    const problems = []
    for (const v of vars) {
      const key = String(v.key)
      if (explicitMap[key]) {
        if (!TOKENS.includes(explicitMap[key])) throw new Error(`--map ${key}=${explicitMap[key]}: use one of ${TOKENS.join(', ')}`)
        values[key] = `{{${explicitMap[key]}}}`
        continue
      }
      if (TOKENS.includes(key)) continue // filled automatically
      const mapped = SYNONYMS[String(v.name).toLowerCase()]
      if (mapped && TOKENS.includes(mapped)) values[key] = `{{${mapped}}}`
      else problems.push(`${key} (${v.where})`)
    }
    if (problems.length) {
      const body = String(tpl.body_text ?? '').replace(/\s+/g, ' ').slice(0, 200)
      throw new Error(
        `I can't tell what to put in: ${problems.join(', ')}.\nTemplate text: "${body}"\n` +
          `Say what each one is with --map, e.g.:  node scripts/create-cart-workflow.mjs ${problems.map((p) => `--map ${p.split(' ')[0]}=customer_name`).join(' ')}\n` +
          `(choose from: ${TOKENS.join(', ')}), or create the workflow on the Workflows page.`,
      )
    }

    const input = {
      name: 'Abandoned cart reminder',
      description: 'Cart idle for the wait time -> approved template; normal message if the template cannot be delivered. One reminder per customer per day.',
      triggerType: 'CART_ABANDONED',
      triggerConfig: { delayMinutes: delay, cooldownHours: 24 },
      conditions: [],
      actions: [{
        type: 'SEND_TEMPLATE',
        templateId: tpl.id,
        values,
        fallbackTexts: TEXTS,
        ...(tpl.header_format === 'IMAGE' ? { imageSource: { mode: 'CART_PRODUCT', pick: 'TOP' } } : {}),
      }],
    }
    console.log(`Template: ${tpl.name} (${tpl.meta_category}, ${tpl.language})  header: ${tpl.header_format ?? 'none'}`)
    console.log(`Variables: ${vars.map((v) => v.key).join(', ') || 'none'}  ->  filled: ${JSON.stringify(values)} (+ automatic ones)`)
    console.log(`Wait: ${delay} min   Reminder gap: 24 h   Picture: ${tpl.header_format === 'IMAGE' ? "customer's top cart item" : 'n/a'}`)
    if (!env.CUSTOMER_APP_URL) console.log('WARNING: CUSTOMER_APP_URL is not set on this server, so the cart link cannot be built and the workflow cannot be switched on.')

    if (!apply) {
      console.log('\nDRY RUN: nothing was written. Run again with --apply to create it (switched off).')
    } else {
      const service = new WorkflowService({ repo: new WorkflowRepository(), tplRepo: new TemplateRepository(), sender: null, emit: () => {}, logger: console, appUrl: env.CUSTOMER_APP_URL })
      const wf = await service.create(input, null)
      console.log(`\nCreated "${wf.name}" (${wf.id}), switched OFF.`)
      if (activate) {
        await service.setActive(wf.id, true)
        console.log('Switched ON: it reacts to carts abandoned from now on.')
      } else {
        console.log('Review it on WhatsApp CRM -> Workflows, then switch it on.')
      }
    }
  }
} catch (err) {
  console.error(`\nNot done: ${err.message}`)
  if (err.errors) console.error(JSON.stringify(err.errors))
  process.exitCode = 1
} finally {
  await closePool()
}
