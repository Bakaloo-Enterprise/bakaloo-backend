import { describe, expect, it } from 'vitest'
import { flowReplyContent } from '../../../src/modules/whatsapp-crm/webhook-parser.js'

describe('flowReplyContent', () => {
  it('turns a Flow answer into readable text and keeps the raw answers', () => {
    const r = flowReplyContent({ name: 'flow', body: 'Sent', response_json: JSON.stringify({ screen_0_Label_0: '3_Other ?', flow_token: 'unused' }) })
    expect(r.body).toBe('Form answer: Other ?')
    expect(r.interactive.type).toBe('nfm_reply')
    expect(r.interactive.response.screen_0_Label_0).toBe('3_Other ?')
  })
  it('survives broken JSON', () => {
    expect(flowReplyContent({ response_json: '{oops' }).body).toBe('Submitted a form')
  })
})
