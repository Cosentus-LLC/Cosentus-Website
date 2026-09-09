import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder'
)

export async function POST(req: NextRequest) {
  try {
    const { conversationId, pageUrl } = await req.json()
    if (!conversationId) return NextResponse.json({ error: 'conversationId required' }, { status: 400 })

    const elevenLabsKey = process.env.ELEVENLABS_API_KEY
    if (!elevenLabsKey) return NextResponse.json({ error: 'ElevenLabs API key not configured' }, { status: 500 })

    // Wait a few seconds for ElevenLabs to process the transcript
    await new Promise(r => setTimeout(r, 3000))

    // Fetch conversation transcript from ElevenLabs
    const convRes = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`, {
      headers: { 'xi-api-key': elevenLabsKey },
    })

    if (!convRes.ok) {
      console.error('ElevenLabs API error:', convRes.status)
      // Fallback: create generic lead
      return createGenericLead(conversationId, pageUrl)
    }

    const convData = await convRes.json()
    const transcript = convData.transcript || []

    if (transcript.length < 2) {
      // Too short — probably a test call, skip
      return NextResponse.json({ success: true, skipped: true, reason: 'conversation too short' })
    }

    // Build readable transcript
    const fullTranscript = transcript
      .map((t: any) => `${t.role === 'agent' ? 'Cindy' : 'Caller'}: ${t.message || t.text || ''}`)
      .filter((l: string) => l.length > 8)
      .join('\n')

    // Use Claude to extract lead info from transcript
    const anthropicKey = process.env.ANTHROPIC_API_KEY
    let extractedLead: any = {}

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
        }
      } catch (e) {
        console.error('AI extraction failed:', e)
      }
    }

    // No identifying data extracted -> no lead. With workspace-level PII
    // redaction (ZRM) enabled on ElevenLabs, transcripts fetched here are
    // redacted, so this path can no longer extract anything; the post-call
    // webhook (/api/elevenlabs/post-call) is now the capture path. This
    // guard stops the blank "Voice Caller / not provided" leads and emails
    // this route used to create as a fallback.
    if (!extractedLead.email && !extractedLead.phone && !extractedLead.first_name && !extractedLead.last_name) {
      return NextResponse.json({ success: true, skipped: true, reason: 'no contact info extracted from transcript' })
    }

    // Create lead from extracted data
    const firstName = extractedLead.first_name || 'Voice'
    const lastName = extractedLead.last_name || 'Caller'

    // Check for existing lead (by phone or email)
    let existingId: string | null = null
    if (extractedLead.phone) {
      const { data } = await supabase.from('leads').select('id').eq('phone', extractedLead.phone).limit(1)
      if (data && data.length > 0) existingId = data[0].id
    }
    if (!existingId && extractedLead.email) {
      const { data } = await supabase.from('leads').select('id').eq('email', extractedLead.email).limit(1)
      if (data && data.length > 0) existingId = data[0].id
    }

    if (existingId) {
      // Update existing lead
      await supabase.from('leads').update({ last_activity: new Date().toISOString() }).eq('id', existingId)
      await supabase.from('activities').insert({
        lead_id: existingId, type: 'call',
        description: `Voice call via Cindy on ${pageUrl || 'website'}. ${extractedLead.notes || ''}`,
        metadata: { conversationId, transcript_length: transcript.length },
      })
      return NextResponse.json({ success: true, lead_id: existingId, duplicate: true })
    }

    // Create new lead
    const res = await fetch(`${req.nextUrl.origin}/api/crm/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        first_name: firstName,
        last_name: lastName,
        email: extractedLead.email || null,
        phone: extractedLead.phone || null,
        practice_name: extractedLead.practice_name || null,
        specialty: extractedLead.specialty || 'other',
        provider_count: extractedLead.provider_count || null,
        source: 'voice_agent',
        notes: `Voice call captured from Cindy. ${extractedLead.notes || ''} [Conversation: ${conversationId}]`,
      }),
    })
    const result = await res.json()

    // Log the full transcript as an activity
    if (result.lead_id) {
      await supabase.from('activities').insert({
        lead_id: result.lead_id, type: 'call',
        description: `Voice call via Cindy (${transcript.length} messages). ${extractedLead.notes || ''}`,
        metadata: { conversationId, transcript_length: transcript.length, page: pageUrl },
      })
    }

    return NextResponse.json({ success: true, lead_id: result.lead_id, extracted: extractedLead })
  } catch (err) {
    console.error('Voice capture error:', err)
    return NextResponse.json({ error: 'Voice capture failed' }, { status: 500 })
  }
}

async function createGenericLead(conversationId: string, pageUrl: string) {
  return NextResponse.json({ success: true, generic: true, conversationId, note: 'Transcript not yet available, lead will be captured on next cron run' })
}
