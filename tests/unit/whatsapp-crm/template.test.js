import { describe, expect, it } from 'vitest'
import {
  buildSendComponents, canSend, componentsToInput, extractVariables, interpretTemplateWebhook, normalizeLanguage,
  renderPreview, sanitizeParam, summarizeComponents, validateTemplateInput,
} from '../../../src/modules/whatsapp-crm/template.js'

const base = (o = {}) => ({
  name: 'abandoned_cart', language: 'en', metaCategory: 'MARKETING', purpose: 'abandoned_cart',
  bodyText: 'Hi {{customer_name}}, your cart worth Rs {{cart_value}} is still waiting for you at Bakaloo.',
  examples: { customer_name: 'Rahul', cart_value: '1240' }, ...o,
})
const errs = (i) => validateTemplateInput(i).errors.map((e) => `${e.field}: ${e.message}`)
const fields = (i) => validateTemplateInput(i).errors.map((e) => e.field)

describe('normalizeLanguage / extractVariables', () => {
  it('turns webhook-style codes into API codes', () => {
    expect(normalizeLanguage('en-US')).toBe('en_US')
    expect(normalizeLanguage(' hi ')).toBe('hi')
    expect(normalizeLanguage(null)).toBe('')
  })
  it('lists variables once, in order', () => {
    expect(extractVariables('Hi {{a}} and {{ b }} and {{a}} again').map((v) => v.name)).toEqual(['a', 'b'])
    expect(extractVariables('no vars')).toEqual([])
  })
})

describe('validateTemplateInput — valid templates', () => {
  it('builds the exact Meta components for a named-variable marketing template', () => {
    const r = validateTemplateInput(base({
      headerText: 'Your cart is waiting',
      footerText: 'Reply STOP to opt out',
      buttons: [
        { type: 'URL', text: 'View Cart', url: 'https://bakaloo.in/cart/{{cart_id}}' },
        { type: 'QUICK_REPLY', text: 'Need Help' },
      ],
      examples: { customer_name: 'Rahul', cart_value: '1240', cart_id: 'abc123' },
    }))
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.value).toMatchObject({ name: 'abandoned_cart', language: 'en', metaCategory: 'MARKETING', parameterFormat: 'NAMED', headerFormat: 'TEXT', allowCategoryChange: true })
    expect(r.value.components).toEqual([
      { type: 'HEADER', format: 'TEXT', text: 'Your cart is waiting' },
      { type: 'BODY', text: base().bodyText, example: { body_text_named_params: [{ param_name: 'customer_name', example: 'Rahul' }, { param_name: 'cart_value', example: '1240' }] } },
      { type: 'FOOTER', text: 'Reply STOP to opt out' },
      { type: 'BUTTONS', buttons: [
        { type: 'URL', text: 'View Cart', url: 'https://bakaloo.in/cart/{{cart_id}}', example: ['https://bakaloo.in/cart/abc123'] },
        { type: 'QUICK_REPLY', text: 'Need Help' },
      ] },
    ])
    expect(r.value.variables).toEqual([
      { name: 'customer_name', example: 'Rahul', where: 'body' },
      { name: 'cart_value', example: '1240', where: 'body' },
      { name: 'cart_id', example: 'abc123', where: 'button0' },
    ])
  })
  it('a header variable gets the header example block', () => {
    const r = validateTemplateInput(base({ headerText: 'Hello {{customer_name_h}} today', examples: { customer_name: 'R', cart_value: '1', customer_name_h: 'Priya' } }))
    expect(r.errors).toEqual([])
    expect(r.value.components[0].example).toEqual({ header_text_named_params: [{ param_name: 'customer_name_h', example: 'Priya' }] })
  })
  it('a template with no variables needs no examples', () => {
    const r = validateTemplateInput({ name: 'welcome', language: 'en_US', metaCategory: 'UTILITY', bodyText: 'Welcome to Bakaloo! We deliver groceries in minutes.' })
    expect(r.ok).toBe(true)
    expect(r.value.components).toEqual([{ type: 'BODY', text: 'Welcome to Bakaloo! We deliver groceries in minutes.' }])
  })
  it('call button: country code kept as digits, plus sign removed for Meta', () => {
    const r = validateTemplateInput(base({ buttons: [{ type: 'PHONE_NUMBER', text: 'Call us', phoneNumber: '+91 98765-43210' }] }))
    expect(r.value.components.at(-1).buttons[0]).toEqual({ type: 'PHONE_NUMBER', text: 'Call us', phone_number: '919876543210' })
  })
  it('normalises the language (en-US -> en_US) and accepts Hindi/Bengali codes', () => {
    expect(validateTemplateInput(base({ language: 'en-US' })).value.language).toBe('en_US')
    expect(validateTemplateInput(base({ language: 'hi' })).ok).toBe(true)
    expect(validateTemplateInput(base({ language: 'bn' })).ok).toBe(true)
  })
  it('allowCategoryChange defaults on and can be switched off', () => {
    expect(validateTemplateInput(base()).value.allowCategoryChange).toBe(true)
    expect(validateTemplateInput(base({ allowCategoryChange: false })).value.allowCategoryChange).toBe(false)
  })
  it('warns (not errors) when there are many variables for little text', () => {
    const r = validateTemplateInput({ name: 'tight', language: 'en', metaCategory: 'UTILITY', bodyText: 'Hi {{a}}, order {{b}} for {{c}} sent by {{d}} ok', examples: { a: '1', b: '2', c: '3', d: '4' } })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/many variables/)
  })
})

describe('validateTemplateInput — Meta rules', () => {
  it.each([
    ['Bad Name', 'name'], ['has-dash', 'name'], ['UPPER', 'name'], ['', 'name'], ['x'.repeat(513), 'name'],
  ])('name %j is rejected', (name, f) => expect(fields(base({ name }))).toContain(f))

  it('rejects bad language, authentication and unknown category/purpose', () => {
    expect(fields(base({ language: 'english' }))).toContain('language')
    expect(errs(base({ metaCategory: 'AUTHENTICATION' })).join(' ')).toMatch(/not supported yet/)
    expect(fields(base({ metaCategory: 'PROMO' }))).toContain('metaCategory')
    expect(fields(base({ purpose: 'nonsense' }))).toContain('purpose')
  })
  it('body: required, ≤1024', () => {
    expect(fields(base({ bodyText: '  ', examples: {} }))).toContain('bodyText')
    expect(fields(base({ bodyText: 'x'.repeat(1025), examples: {} }))).toContain('bodyText')
    expect(validateTemplateInput(base({ bodyText: 'x'.repeat(1024), examples: {} })).ok).toBe(true)
  })
  it('variables may not START or END the message or sit next to each other (Meta 2388299 / INVALID_FORMAT)', () => {
    expect(errs(base({ bodyText: '{{customer_name}}, your cart {{cart_value}} awaits you today', examples: { customer_name: 'a', cart_value: 'b' } })).join(' ')).toMatch(/START with a variable/)
    expect(errs(base({ bodyText: 'Hello, your total is {{cart_value}}', examples: { cart_value: 'b' } })).join(' ')).toMatch(/END with a variable/)
    expect(errs(base({ bodyText: 'Hello {{customer_name}} {{cart_value}} thanks for shopping', examples: { customer_name: 'a', cart_value: 'b' } })).join(' ')).toMatch(/next to each other/)
    expect(errs(base({ bodyText: 'Hi {{customer_name}}{{cart_value}} thanks', examples: { customer_name: 'a', cart_value: 'b' } })).join(' ')).toMatch(/next to each other/)
  })
  it('a variable followed only by punctuation at the end is still at the end', () => {
    expect(errs(base({ bodyText: 'Your total is {{cart_value}}', examples: { cart_value: 'b' } })).join(' ')).toMatch(/END with a variable/)
  })
  it('variable names: lowercase letters/underscores only; numbers and capitals rejected with guidance', () => {
    expect(errs(base({ bodyText: 'Hi {{1}}, welcome to the store today', examples: { 1: 'x' } })).join(' ')).toMatch(/descriptive name/)
    expect(errs(base({ bodyText: 'Hi {{CustomerName}}, welcome to the store today', examples: { CustomerName: 'x' } })).join(' ')).toMatch(/lowercase letters and underscores/)
    expect(errs(base({ bodyText: 'Hi {{cust_name2}}, welcome to the store today', examples: {} })).join(' ')).toMatch(/lowercase/)
  })
  it('incomplete / stray double braces are caught', () => {
    expect(errs(base({ bodyText: 'Hi {{customer_name, welcome to the store today', examples: {} })).join(' ')).toMatch(/incomplete/)
    expect(errs(base({ bodyText: 'Hi customer_name}}, welcome to the store today', examples: {} })).join(' ')).toMatch(/incomplete/)
  })
  it('every variable needs a one-line example', () => {
    expect(fields(base({ examples: { customer_name: 'Rahul' } }))).toContain('examples.cart_value')
    expect(fields(base({ examples: { customer_name: 'Rahul', cart_value: '  ' } }))).toContain('examples.cart_value')
    expect(fields(base({ examples: { customer_name: 'Ra\nhul', cart_value: '1' } }))).toContain('examples.customer_name')
  })
  it('a variable name cannot be reused in header and body', () => {
    expect(errs(base({ headerText: 'Hi {{customer_name}} there', examples: { customer_name: 'a', cart_value: 'b' } })).join(' ')).toMatch(/more than one place/)
  })
  it('header: ≤60, ≤1 variable, no markdown characters', () => {
    expect(fields(base({ headerText: 'x'.repeat(61) }))).toContain('headerText')
    expect(errs(base({ headerText: 'A {{h1x}} and {{h2x}} here', examples: { customer_name: 'a', cart_value: 'b', h1x: 'c', h2x: 'd' } })).join(' ')).toMatch(/at most one variable/)
    expect(errs(base({ headerText: '*Sale* today' })).join(' ')).toMatch(/formatting characters/)
    // underscores INSIDE a variable name are fine
    expect(validateTemplateInput(base({ headerText: 'Hi {{header_name}} there', examples: { customer_name: 'a', cart_value: 'b', header_name: 'c' } })).ok).toBe(true)
  })
  it('footer: ≤60 and no variables', () => {
    expect(fields(base({ footerText: 'x'.repeat(61) }))).toContain('footerText')
    expect(fields(base({ footerText: 'Hi {{customer_name}}' }))).toContain('footerText')
  })

  describe('buttons', () => {
    const btn = (b) => base({ buttons: b })
    it('label required and ≤25', () => {
      expect(fields(btn([{ type: 'QUICK_REPLY', text: '' }]))).toContain('buttons[0]')
      expect(fields(btn([{ type: 'QUICK_REPLY', text: 'x'.repeat(26) }]))).toContain('buttons[0]')
      expect(validateTemplateInput(btn([{ type: 'QUICK_REPLY', text: 'x'.repeat(25) }])).ok).toBe(true)
    })
    it('link must be https, ≤2000, one variable only and only at the very end', () => {
      expect(errs(btn([{ type: 'URL', text: 'Go', url: 'http://x.in' }])).join(' ')).toMatch(/https/)
      expect(errs(btn([{ type: 'URL', text: 'Go', url: 'https://x.in/' + 'a'.repeat(2000) }])).join(' ')).toMatch(/too long/)
      expect(errs(btn([{ type: 'URL', text: 'Go', url: 'https://x.in/{{aa}}/{{bb}}' }])).join(' ')).toMatch(/only one variable/)
      expect(errs(btn([{ type: 'URL', text: 'Go', url: 'https://x.in/{{aa}}/more' }])).join(' ')).toMatch(/very end/)
    })
    it('phone number must look real', () => {
      expect(fields(btn([{ type: 'PHONE_NUMBER', text: 'Call', phoneNumber: 'abc' }]))).toContain('buttons[0]')
      expect(fields(btn([{ type: 'PHONE_NUMBER', text: 'Call', phoneNumber: '+' + '9'.repeat(25) }]))).toContain('buttons[0]')
    })
    it('type counts: ≤2 links, ≤1 call, ≤10 buttons', () => {
      const u = (n) => ({ type: 'URL', text: 'L' + n, url: 'https://x.in/' + n })
      expect(errs(btn([u(1), u(2), u(3)])).join(' ')).toMatch(/At most 2 link/)
      const p = { type: 'PHONE_NUMBER', text: 'Call', phoneNumber: '+919876543210' }
      expect(errs(btn([p, p])).join(' ')).toMatch(/At most 1 call/)
      expect(errs(btn(Array.from({ length: 11 }, (_, i) => ({ type: 'QUICK_REPLY', text: 'q' + i })))).join(' ')).toMatch(/At most 10 buttons/)
    })
    it('quick replies must be grouped: QR,QR,URL ok · URL,QR,QR ok · QR,URL,QR rejected', () => {
      const qr = (t) => ({ type: 'QUICK_REPLY', text: t })
      const url = { type: 'URL', text: 'Open', url: 'https://x.in/a' }
      expect(validateTemplateInput(btn([qr('a'), qr('b'), url])).ok).toBe(true)
      expect(validateTemplateInput(btn([url, qr('a'), qr('b')])).ok).toBe(true)
      expect(errs(btn([qr('a'), url, qr('b')])).join(' ')).toMatch(/together/)
    })
    it('unknown button type', () => {
      expect(fields(btn([{ type: 'FLOW', text: 'x' }]))).toContain('buttons[0]')
    })
  })

  it('collects ALL problems at once so the form can show them together', () => {
    const r = validateTemplateInput({ name: 'Bad Name', language: 'x', metaCategory: '', bodyText: '', buttons: [{ type: 'URL', text: '', url: 'http://x' }] })
    expect(r.ok).toBe(false)
    expect(new Set(r.errors.map((e) => e.field)).size).toBeGreaterThanOrEqual(5)
  })
})

describe('summarizeComponents / componentsToInput (templates from Meta)', () => {
  const named = [
    { type: 'HEADER', format: 'TEXT', text: 'Hi {{customer_name}} there', example: { header_text_named_params: [{ param_name: 'customer_name', example: 'Pablo' }] } },
    { type: 'BODY', text: 'Your order {{order_number}} is {{order_status}} now', example: { body_text_named_params: [{ param_name: 'order_number', example: 'BK1' }, { param_name: 'order_status', example: 'packed' }] } },
    { type: 'FOOTER', text: 'Bakaloo' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Help' }, { type: 'URL', text: 'Track', url: 'https://x.in/t/{{track_id}}', example: ['https://x.in/t/ZZ9'] }] },
  ]
  const positional = [
    { type: 'BODY', text: 'Hi {{1}}, code {{2}} expires in 3 days', example: { body_text: [['Pablo', 'SAVE20']] } },
  ]
  it('named: pulls variables with examples and where they live', () => {
    const s = summarizeComponents(named, 'NAMED')
    expect(s.headerFormat).toBe('TEXT')
    expect(s.bodyText).toMatch(/order_number/)
    expect(s.variables).toEqual([
      { name: 'customer_name', example: 'Pablo', where: 'header', key: 'customer_name' },
      { name: 'order_number', example: 'BK1', where: 'body', key: 'order_number' },
      { name: 'order_status', example: 'packed', where: 'body', key: 'order_status' },
      { name: 'track_id', example: 'https://x.in/t/ZZ9', where: 'button1', key: 'track_id' },
    ])
  })
  it('positional: keys are scoped so header {{1}} and body {{1}} never collide', () => {
    const s = summarizeComponents(positional, 'POSITIONAL')
    expect(s.variables.map((v) => [v.key, v.example])).toEqual([['body.1', 'Pablo'], ['body.2', 'SAVE20']])
  })
  it('a media header is reported as such', () => {
    expect(summarizeComponents([{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'x' }], 'NAMED').headerFormat).toBe('IMAGE')
  })
  it('simple named templates round-trip into editor fields', () => {
    const r = componentsToInput(named, 'NAMED')
    expect(r.editable).toBe(true)
    expect(r.input.bodyText).toMatch(/order_number/)
    expect(r.input.buttons).toEqual([{ type: 'QUICK_REPLY', text: 'Help' }, { type: 'URL', text: 'Track', url: 'https://x.in/t/{{track_id}}' }])
    expect(r.input.examples.order_number).toBe('BK1')
  })
  it('positional / media-header / exotic-button templates are not editable here, with a reason', () => {
    expect(componentsToInput(positional, 'POSITIONAL')).toMatchObject({ editable: false, reason: expect.stringMatching(/numbered/) })
    expect(componentsToInput([{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'x' }], 'NAMED')).toMatchObject({ editable: false, reason: expect.stringMatching(/image header/) })
    expect(componentsToInput([{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', example: '1' }] }], 'NAMED').editable).toBe(false)
  })
})

describe('buildSendComponents', () => {
  const t = (components, parameter_format = 'NAMED') => ({ components, parameter_format })
  const comps = [
    { type: 'HEADER', format: 'TEXT', text: 'Hi {{customer_name}} there' },
    { type: 'BODY', text: 'Your cart {{cart_value}} is waiting for you at {{store_name}} today' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Help' }, { type: 'URL', text: 'View', url: 'https://bakaloo.in/c/{{cart_id}}' }] },
  ]
  it('named: parameters carry parameter_name; button index is the position in the buttons array', () => {
    const r = buildSendComponents(t(comps), { customer_name: 'Rahul', cart_value: '1240', store_name: 'Salt Lake', cart_id: 'a b/c' })
    expect(r.missing).toEqual([])
    expect(r.components).toEqual([
      { type: 'header', parameters: [{ type: 'text', parameter_name: 'customer_name', text: 'Rahul' }] },
      { type: 'body', parameters: [{ type: 'text', parameter_name: 'cart_value', text: '1240' }, { type: 'text', parameter_name: 'store_name', text: 'Salt Lake' }] },
      { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', parameter_name: 'cart_id', text: 'a%20b%2Fc' }] },
    ])
  })
  it('reports every missing value instead of sending a half-filled message', () => {
    const r = buildSendComponents(t(comps), { customer_name: 'Rahul', cart_value: '   ' })
    expect(r.missing.sort()).toEqual(['cart_id', 'cart_value', 'store_name'])
  })
  it('positional: parameters in order, no names, scoped keys', () => {
    const r = buildSendComponents(t([{ type: 'BODY', text: 'Hi {{1}}, code {{2}} expires soon' }], 'POSITIONAL'), { 'body.1': 'Pablo', 'body.2': 'SAVE20' })
    expect(r.components).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'Pablo' }, { type: 'text', text: 'SAVE20' }] }])
  })
  it('sanitises values: newlines/tabs flattened, long space runs shortened', () => {
    expect(sanitizeParam('a\nb\tc      d')).toBe('a b c   d')
    expect(sanitizeParam(null)).toBe('')
    const r = buildSendComponents(t([{ type: 'BODY', text: 'Hello {{x_y}} bye' }]), { x_y: 'line1\nline2' })
    expect(r.components[0].parameters[0].text).toBe('line1 line2')
  })
  it('a template without variables sends no components at all', () => {
    expect(buildSendComponents(t([{ type: 'BODY', text: 'Welcome!' }]), {})).toEqual({ components: [], missing: [] })
  })
  it('image header needs an https link and is sent as an image parameter', () => {
    const img = t([{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Fresh offers today' }])
    expect(buildSendComponents(img, {}, {}).error).toMatch(/https:\/\/ link/)
    expect(buildSendComponents(img, {}, { headerMediaUrl: 'http://x/a.jpg' }).error).toBeTruthy()
    expect(buildSendComponents(img, {}, { headerMediaUrl: 'https://cdn.x/a.jpg' }).components[0]).toEqual({ type: 'header', parameters: [{ type: 'image', image: { link: 'https://cdn.x/a.jpg' } }] })
  })
  it('a location header is refused', () => {
    expect(buildSendComponents(t([{ type: 'HEADER', format: 'LOCATION' }, { type: 'BODY', text: 'x' }]), {}).error).toMatch(/cannot be sent/)
  })
})

describe('renderPreview', () => {
  const tpl = {
    parameter_format: 'NAMED',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Hi {{customer_name}} there', example: { header_text_named_params: [{ param_name: 'customer_name', example: 'Pablo' }] } },
      { type: 'BODY', text: 'Cart {{cart_value}} waits for you today', example: { body_text_named_params: [{ param_name: 'cart_value', example: '999' }] } },
      { type: 'FOOTER', text: 'Bakaloo' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Help' }, { type: 'URL', text: 'Open', url: 'https://x.in' }] },
    ],
  }
  it('renders filled values, footer and buttons', () => {
    expect(renderPreview(tpl, { customer_name: 'Rahul', cart_value: '1240' })).toBe('Hi Rahul there\n\nCart 1240 waits for you today\n\nBakaloo\n\n[ Help ] [ Open ]')
  })
  it('unfilled variables stay visible, or fall back to the sample value for the editor preview', () => {
    expect(renderPreview(tpl, {})).toContain('{{customer_name}}')
    expect(renderPreview(tpl, {}, { fallbackToExample: true })).toContain('Hi Pablo there')
  })
})

describe('canSend — the single gate', () => {
  it.each(['DRAFT', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'ARCHIVED', 'DELETED'])('%s cannot be sent, with a reason', (status) => {
    const r = canSend({ status, meta_category: 'UTILITY' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBeTruthy()
  })
  it('APPROVED can', () => expect(canSend({ status: 'APPROVED', meta_category: 'MARKETING' })).toEqual({ ok: true }))
  it('approved authentication / location-header templates are still blocked', () => {
    expect(canSend({ status: 'APPROVED', meta_category: 'AUTHENTICATION' }).ok).toBe(false)
    expect(canSend({ status: 'APPROVED', meta_category: 'UTILITY', header_format: 'LOCATION' }).ok).toBe(false)
  })
})

describe('interpretTemplateWebhook', () => {
  const v = (o) => ({ message_template_id: 1689556908129832, message_template_name: 'order_confirmation', message_template_language: 'en-US', ...o })
  it('identifies the template and normalises the language', () => {
    const r = interpretTemplateWebhook('message_template_status_update', v({ event: 'APPROVED' }))
    expect(r.ident).toEqual({ metaId: '1689556908129832', name: 'order_confirmation', language: 'en_US' })
    expect(r.patch).toMatchObject({ status: 'APPROVED', flagged: false, rejection_reason: null })
  })
  it('REJECTED keeps Meta’s reason and the INVALID_FORMAT explanation + recommendation', () => {
    const r = interpretTemplateWebhook('message_template_status_update', v({ event: 'REJECTED', reason: 'INVALID_FORMAT', rejection_info: { reason: 'Parameters next to each other.', recommendation: 'Separate them.' } }))
    expect(r.patch).toMatchObject({ status: 'REJECTED', rejection_reason: 'INVALID_FORMAT', rejection_detail: 'Parameters next to each other. Separate them.' })
    expect(interpretTemplateWebhook('message_template_status_update', v({ event: 'REJECTED', reason: 'NONE' })).patch.rejection_reason).toBeNull()
  })
  it.each([
    ['PENDING', { status: 'PENDING' }], ['PAUSED', { status: 'PAUSED' }], ['DISABLED', { status: 'DISABLED' }], ['IN_APPEAL', { status: 'IN_APPEAL' }],
    ['PENDING_DELETION', { status: 'PENDING_DELETION' }], ['ARCHIVED', { status: 'ARCHIVED' }], ['DELETED', { status: 'DELETED' }],
    ['REINSTATED', { status: 'APPROVED', flagged: false }], ['FLAGGED', { flagged: true }], ['LOCKED', { locked: true }],
  ])('event %s', (event, patch) => expect(interpretTemplateWebhook('message_template_status_update', v({ event })).patch).toMatchObject(patch))
  it('UNARCHIVED and components updates ask for a refetch (the event alone is not enough)', () => {
    expect(interpretTemplateWebhook('message_template_status_update', v({ event: 'UNARCHIVED' })).refetch).toBe(true)
    expect(interpretTemplateWebhook('message_template_components_update', v({})).refetch).toBe(true)
  })
  it('LIMIT_EXCEEDED is an account-level notice, not a template change', () => {
    expect(interpretTemplateWebhook('message_template_status_update', v({ event: 'LIMIT_EXCEEDED' }))).toMatchObject({ accountLevel: true, patch: {} })
  })
  it('unknown events / fields are ignored', () => {
    expect(interpretTemplateWebhook('message_template_status_update', v({ event: 'SOMETHING_NEW' }))).toBeNull()
    expect(interpretTemplateWebhook('totally_other', v({}))).toBeNull()
  })
  it('quality updates', () => {
    expect(interpretTemplateWebhook('message_template_quality_update', v({ previous_quality_score: 'GREEN', new_quality_score: 'YELLOW' })).patch).toEqual({ quality_score: 'YELLOW' })
    expect(interpretTemplateWebhook('message_template_quality_update', v({ new_quality_score: 'PURPLE' }))).toBeNull()
  })
  it('category: an IMPENDING change is a warning with a date; a completed one switches the category', () => {
    const pending = interpretTemplateWebhook('template_category_update', v({ new_category: 'UTILITY', correct_category: 'MARKETING', category_update_timestamp: 1746169200 }))
    expect(pending.event).toBe('CATEGORY_PENDING')
    expect(pending.patch.pending_category).toBe('MARKETING')
    expect(pending.patch.pending_category_at.getTime()).toBe(1746169200 * 1000)
    expect(pending.patch.meta_category).toBeUndefined() // not changed yet
    const done = interpretTemplateWebhook('template_category_update', v({ previous_category: 'UTILITY', new_category: 'MARKETING' }))
    expect(done.patch).toEqual({ meta_category: 'MARKETING', pending_category: null, pending_category_at: null })
  })
})
