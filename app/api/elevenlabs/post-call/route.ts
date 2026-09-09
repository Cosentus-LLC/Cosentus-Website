import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { createClient } from '@supabase/supabase-js'

/**
 * ElevenLabs post-call webhook receiver (post_call_transcription).
 *
 * WHY THIS EXISTS: the workspace runs with PII redaction / Zero Retention
 * Mode enabled (HIPAA posture), so fetching a conversation transcript
 * after the call (the /api/crm/voice-capture approach) returns fully
 * redacted content and every voice lead came through blank ("Voice
 * Caller" / "not provided"). Per ElevenLabs docs, the post-call webhook
 * is the prescribed way to receive call data for ZRM agents: the payload
 * is pushed to us when analysis completes, before/without retention.
 * Same webhook-style pattern already used for the Zeus agents.
 *
 * Security: HMAC-verified against ELEVENLABS_WEBHOOK_SECRET using the
 * documented ElevenLabs-Signature scheme (t=<unix>,v0=<hex hmac of
 * "<timestamp>.<rawBody>">), with a 30-minute timestamp tolerance.
 * If the secret env var is not configured, the payload is NOT processed
 * (fail closed) but we still return 200 so ElevenLabs does not
 * auto-disable the webhook while setup is in progress.
 *
 * Scope: workspace-level webhooks fire for EVERY agent in the workspace.
 * We only process the Cosentus website agent and ACK everything else
 * with 200 immediately, so high-volume agents elsewhere in the
 * workspace never hit the extraction path.
 *
 * Reliability: ElevenLabs requires a 200 to count delivery as
 * successful, and under HIPAA settings failed webhooks are not retried.
 * Every handled branch therefore returns 200; only a bad signature
 * returns 401.
 */

// Must match the agent embedded in CindyVoiceAgent.tsx.
const WEBSITE_AGENT_ID =
  process.env.ELEVENLABS_AGENT_ID || 'agent_4401knqw7z4ees28j1wgmdwq7t6r'

const SIGNATURE_TOLERANCE_MS = 30 * 60 * 1000 // 30 minutes

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder'
)

/** Verify the ElevenLabs-Signature header over the raw request body. */
function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false
  const parts = header.split(',')
  const tPart = parts.find(p => p.startsWith('t='))
  const vPart = parts.find(p => p.startsWith('v0='))
  if (!tPart || !vPart) return false

  const timestamp = tPart.substring(2)
  const tsMs = Number(timestamp) * 1000
  if (!Number.isFinite(tsMs)) return false
  if (Math.abs(Date.now() - tsMs) > SIGNATURE_TOLERANCE_MS) return false

  const expected = 'v0=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  const a = Buffer.from(vPart)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text()

    const secret = process.env.ELEVENLABS_WEBHOOK_SECRET
    if (!secret) {
      // Fail closed (no processing of unauthenticated payloads) but ACK so
      // ElevenLabs does not rack up failures while the env var is pending.
      console.error('[EL webhook] ELEVENLABS_WEBHOOK_SECRET not configured; payload ignored')
      return NextResponse.json({ success: true, skipped: 'webhook secret not configured' })
    }

    if (!verifySignature(rawBody, req.headers.get('elevenlabs-signature'), secret)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const event = JSON.parse(rawBody)

    if (event.type !== 'post_call_transcription') {
      return NextResponse.json({ success: true, skipped: `unhandled type ${event.type}` })
    }

    const data = event.data || {}
    if (data.agent_id !== WEBSITE_AGENT_ID) {
      return NextResponse.json({ success: true, skipped: 'other agent' })
    }

    const conversationId: string = data.conversation_id || 'unknown'
    const transcript: { role: string; message?: string | null }[] = data.transcript || []

    if (transcript.length < 2) {
      return NextResponse.json({ success: true, skipped: 'conversation too short' })
    }

    // Same transcript shaping as /api/crm/voice-capture, so extraction
    // behavior stays consistent between the two paths.
    const fullTranscript = transcript
      .map(t => `${t.role === 'agent' ? 'Cindy' : 'Caller'}: ${t.message || ''}`)
      .filter(l => l.length > 8)
      .join('\n')

    const anthropicKey = process.env.ANTHROPIC_API_KEY
    let extractedLead: {
      first_name?: string | null
      last_name?: string | null
      email?: string | null
      phone?: string | null
      practice_name?: string | null
      specialty?: string | null
      provider_count?: number | null
      notes?: string | null
    } = {}

    if (anthropicKey && fullTranscript.length > 50) {
      try {
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 500,
            messages: [{ role: 'user', content: `Extract lead information from this voice agent transcript. Return ONLY a JSON object with these fields (use null for unknown): first_name, last_name, email, phone, practice_name, specialty, provider_count, notes.

For specialty, map to one of: anesthesia, orthopedics, pain_management, asc, behavioral_health, urgent_care, obgyn, other.
For notes, write a brief 1-2 sentence summary of what they were asking about.

Transcript:
${fullTranscript.slice(0, 3000)}` }],
          }),
        })

        if (aiRes.ok) {
          const aiData = await aiRes.json()
          const text = aiData.content?.[0]?.text || ''
          const jsonMatch = text.match(/\{[\s\S]*\}/)
          if (jsonMatch) extractedLead = JSON.parse(jsonMatch[0])
        } else {
          console.error('[EL webhook] AI extraction HTTP error', { status: aiRes.status })
        }
      } catch (e) {
        console.error('[EL webhook] AI extraction failed:', e instanceof Error ? e.message : 'unknown')
      }
    }

    // No identifying data -> no lead. This is what prevents the blank
    // "Voice Caller / not provided" rows and emails.
    const hasIdentity = Boolean(
      extractedLead.email || extractedLead.phone || extractedLead.first_name || extractedLead.last_name
    )
    if (!hasIdentity) {
      return NextResponse.json({ success: true, skipped: 'no contact info in transcript', conversationId })
    }

    // Guard against a duplicate created moments earlier by the legacy
    // voice-capture path for this same conversation.
    const { data: existingConv } = await supabase
      .from('activities')
      .select('lead_id')
      .contains('metadata', { conversationId })
      .limit(1)
    if (existingConv && existingConv.length > 0) {
      return NextResponse.json({ success: true, skipped: 'conversation already captured', lead_id: existingConv[0].lead_id })
    }

    // Delegate creation/dedupe/notification to the existing lead pipeline
    // (Supabase insert, scoring, assignment, HubSpot mirror, Resend email).
    const res = await fetch(`${req.nextUrl.origin}/api/crm/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        first_name: extractedLead.first_name || 'Voice',
        last_name: extractedLead.last_name || 'Caller',
        email: extractedLead.email || null,
        phone: extractedLead.phone || null,
        practice_name: extractedLead.practice_name || null,
        specialty: extractedLead.specialty || 'other',
        provider_count: extractedLead.provider_count || null,
        source: 'voice_agent',
        notes: `Voice call captured via post-call webhook. ${extractedLead.notes || ''} [Conversation: ${conversationId}]`,
      }),
    })
    const result = await res.json()

    if (result.lead_id) {
      await supabase.from('activities').insert({
        lead_id: result.lead_id,
        type: 'call',
        description: `Voice call via Cindy (${transcript.length} messages). ${extractedLead.notes || ''}`,
        metadata: {
          conversationId,
          transcript_length: transcript.length,
          call_duration_secs: data.metadata?.call_duration_secs ?? null,
          captured_via: 'post_call_webhook',
        },
      })
    }

    return NextResponse.json({ success: true, lead_id: result.lead_id, duplicate: result.duplicate || false })
  } catch (err) {
    console.error('[EL webhook] error:', err instanceof Error ? err.message : 'unknown')
    // 200 by design: HIPAA-mode webhooks are not retried, and repeated
    // non-200s auto-disable the webhook. The error is logged above.
    return NextResponse.json({ success: false, error: 'processing failed' })
  }
}
