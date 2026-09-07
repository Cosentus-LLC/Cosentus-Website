import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder'
)

// Simple AI scoring based on available data
function calculateAIScore(data: Record<string, unknown>): number {
  let score = 30 // base

  // Specialty match bonus
  const highValueSpecialties = ['anesthesia', 'orthopedics', 'asc', 'pain_management']
  if (highValueSpecialties.includes(data.specialty as string)) score += 15

  // Provider count bonus
  const providers = data.provider_count as number || 0
  if (providers >= 10) score += 20
  else if (providers >= 5) score += 10
  else if (providers >= 2) score += 5

  // Monthly charges bonus
  const charges = data.monthly_charges as number || 0
  if (charges >= 500000) score += 20
  else if (charges >= 200000) score += 15
  else if (charges >= 100000) score += 10

  // Contact completeness bonus
  if (data.email) score += 5
  if (data.phone) score += 5

  // Source bonus (inbound > outbound)
  const highIntentSources = ['website_chat', 'contact_form', 'voice_agent']
  if (highIntentSources.includes(data.source as string)) score += 10

  return Math.min(score, 100)
}

function calculateTemperature(score: number): string {
  if (score >= 75) return 'hot'
  if (score >= 45) return 'warm'
  return 'cold'
}

const HUBSPOT_TIMEOUT_MS = 2000

// fetch with a hard timeout so a slow HubSpot response can never delay or
// fail the /api/crm/leads request. Aborts after HUBSPOT_TIMEOUT_MS.
async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HUBSPOT_TIMEOUT_MS)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Mirror a lead into HubSpot as a Contact. Best-effort and bounded:
 * any failure (including timeout) is logged and swallowed so it never
 * affects the Supabase write or the API response. Supabase remains the
 * system of record.
 *
 * Uses HubSpot's email-based upsert (idProperty=email) so repeat
 * submissions update the existing contact instead of creating duplicates.
 * No-ops cleanly when HUBSPOT_TOKEN is not configured.
 *
 * Logging is PII-safe: only status codes and error messages are logged,
 * never response bodies or raw error objects (which can contain
 * user-submitted email/phone/notes).
 */
async function syncToHubSpot(lead: {
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
  practice_name?: string
  specialty?: string
  source?: string
  notes?: string
}): Promise<void> {
  const token = process.env.HUBSPOT_TOKEN
  if (!token) return // feature off until token is configured
  if (!lead.email) return // HubSpot upsert key is email; skip if absent

  const extraParts = [
    lead.specialty ? `Specialty: ${lead.specialty}` : '',
    lead.source ? `Source: ${lead.source}` : '',
    lead.notes || '',
  ].filter(Boolean)

  const properties: Record<string, string> = {
    email: lead.email,
  }
  if (lead.first_name) properties.firstname = lead.first_name
  if (lead.last_name) properties.lastname = lead.last_name
  if (lead.phone) properties.phone = lead.phone
  if (lead.practice_name) properties.company = lead.practice_name
  if (extraParts.length) properties.message = extraParts.join(' | ')

  // On CREATE only, classify the contact as a New Lead so it surfaces as
  // actionable in HubSpot. NOT applied on update: re-submissions from an
  // existing contact (who may already be a customer / further in the
  // pipeline) must not be downgraded back to 'lead'/'NEW'.
  const createProperties: Record<string, string> = {
    ...properties,
    lifecyclestage: 'lead',
    hs_lead_status: 'NEW',
  }

  try {
    const res = await fetchWithTimeout(
      `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(lead.email)}?idProperty=email`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ properties }),
      },
    )

    // 404 means the contact does not exist yet — create it as a New Lead.
    if (res.status === 404) {
      const createRes = await fetchWithTimeout('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ properties: createProperties }),
      })
      if (!createRes.ok) {
        console.error('[HubSpot] contact create failed', { status: createRes.status })
      }
      return
    }

    if (!res.ok) {
      console.error('[HubSpot] contact upsert failed', { status: res.status })
    }
  } catch (err) {
    console.error('[HubSpot] sync error', {
      message: err instanceof Error ? err.message : 'unknown',
    })
  }
}

/**
 * Register the lead as a submission of the HubSpot "Contact Form 2026"
 * form via the Forms Submissions API. This is what causes the contact to
 * count as a real form submission in HubSpot, so it enters form-based
 * marketing lists (e.g. "Marketing Qualified Leads"). Runs ALONGSIDE
 * syncToHubSpot (which owns the contact upsert + New Lead status); this
 * call only generates the form-submission event.
 *
 * Best-effort and bounded: any failure is logged and swallowed so it can
 * never affect the Supabase write or the API response. No-ops cleanly
 * when HUBSPOT_FORM_GUID is not configured (acts as an on/off switch with
 * no deploy required).
 *
 * Only fields that exist on the HubSpot form are sent. Per HubSpot's Forms
 * API validation, submitting fields not present on the form (e.g. specialty,
 * source) causes rejection, so those are folded into `message` instead.
 * The form's required "what service" dropdown uses a service taxonomy that
 * does not map cleanly from our specialty values, so it is intentionally
 * omitted (the field was made optional on the form) rather than guessed.
 *
 * Logging is PII-safe: only status codes / error messages, never bodies.
 */
async function submitHubSpotForm(lead: {
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
  practice_name?: string
  specialty?: string
  source?: string
  notes?: string
}): Promise<void> {
  const formGuid = process.env.HUBSPOT_FORM_GUID
  if (!formGuid) return // feature off until form GUID is configured
  if (!lead.email) return // a form submission without email cannot resolve a contact

  const portalId = process.env.HUBSPOT_PORTAL_ID
  if (!portalId) return // explicit; never default to a hardcoded tenant

  const extraParts = [
    lead.specialty ? `Specialty: ${lead.specialty}` : '',
    lead.source ? `Source: ${lead.source}` : '',
    lead.notes || '',
  ].filter(Boolean)

  // name/value pairs using HubSpot internal field names ONLY.
  const fields: { name: string; value: string }[] = [{ name: 'email', value: lead.email }]
  if (lead.first_name) fields.push({ name: 'firstname', value: lead.first_name })
  if (lead.last_name) fields.push({ name: 'lastname', value: lead.last_name })
  if (lead.phone) fields.push({ name: 'phone', value: lead.phone })
  if (lead.practice_name) fields.push({ name: 'company', value: lead.practice_name })
  if (extraParts.length) fields.push({ name: 'message', value: extraParts.join(' | ') })

  try {
    const res = await fetchWithTimeout(
      `https://api.hsforms.com/submissions/v3/integration/submit/${portalId}/${formGuid}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields,
          context: { pageName: 'Cosentus Website Lead', pageUri: 'https://cosentus.com/contact' },
        }),
      },
    )
    if (!res.ok) {
      console.error('[HubSpot] form submission failed', { status: res.status })
    }
  } catch (err) {
    console.error('[HubSpot] form submission error', {
      message: err instanceof Error ? err.message : 'unknown',
    })
  }
}

/**
 * Email the lead details to the sales inbox via Resend.
 *
 * Best-effort and bounded, exactly like the HubSpot mirrors: runs inside
 * Promise.allSettled with the shared fetchWithTimeout, so a slow or failed
 * Resend call can never delay or fail the lead capture. Supabase remains
 * the system of record; this is a notification only.
 *
 * No-ops cleanly when no Resend key is configured (acts as an on/off
 * switch with no deploy required). Reads `Resend_Email` (the name the
 * Vercel env var was created under) with `RESEND_API_KEY` as fallback.
 *
 * The From address only requires the cosentus.com domain to be verified
 * in Resend; the mailbox itself does not need to exist. Reply-To is set
 * to the lead's email so sales can reply directly from the notification.
 *
 * Logging is PII-safe: only status codes and error messages are logged.
 */
async function sendLeadEmail(
  lead: {
    first_name?: string
    last_name?: string
    email?: string
    phone?: string
    practice_name?: string
    specialty?: string
    source?: string
    notes?: string
  },
  isDuplicate: boolean,
): Promise<void> {
  const apiKey = process.env.Resend_Email || process.env.RESEND_API_KEY
  if (!apiKey) return // feature off until a Resend key is configured

  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Unknown'
  const subject = `${isDuplicate ? 'Returning lead' : 'New lead'}: ${name}${
    lead.practice_name ? ` — ${lead.practice_name}` : ''
  }`

  const lines = [
    `Name: ${name}`,
    `Email: ${lead.email || 'not provided'}`,
    `Phone: ${lead.phone || 'not provided'}`,
    `Company / Practice: ${lead.practice_name || 'not provided'}`,
    `Specialty: ${lead.specialty || 'not provided'}`,
    `Source: ${lead.source || 'unknown'}`,
    `Notes: ${lead.notes || 'none'}`,
    isDuplicate
      ? 'This contact already existed in the CRM; their record was updated with this new interaction.'
      : 'This is a brand-new lead in the CRM.',
  ]

  try {
    const res = await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Cosentus Website <website@cosentus.com>',
        to: ['grow@cosentus.com'],
        reply_to: lead.email || undefined,
        subject,
        text: lines.join('\n'),
      }),
    })
    if (!res.ok) {
      console.error('[Resend] lead email failed', { status: res.status })
    }
  } catch (err) {
    console.error('[Resend] lead email error', {
      message: err instanceof Error ? err.message : 'unknown',
    })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const { first_name, last_name, email, phone, practice_name, specialty, provider_count, monthly_charges, source, notes } = body

    if (!first_name || !last_name) {
      return NextResponse.json({ error: 'first_name and last_name are required' }, { status: 400 })
    }

    // Check for duplicates by email, phone, or practice+name combo
    let existingId: string | null = null
    if (email) {
      const { data } = await supabase.from('leads').select('id').eq('email', email).limit(1)
      if (data && data.length > 0) existingId = data[0].id
    }
    if (!existingId && phone) {
      const { data } = await supabase.from('leads').select('id').eq('phone', phone).limit(1)
      if (data && data.length > 0) existingId = data[0].id
    }
    if (!existingId && practice_name && last_name) {
      const { data } = await supabase.from('leads').select('id').eq('practice_name', practice_name).eq('last_name', last_name).limit(1)
      if (data && data.length > 0) existingId = data[0].id
    }
    if (existingId) {
      await supabase.from('leads').update({ last_activity: new Date().toISOString() }).eq('id', existingId)
      await supabase.from('activities').insert({
        lead_id: existingId,
        type: source === 'voice_agent' ? 'call' : 'chat',
        description: `Returning lead, new ${source?.replace('_', ' ')} interaction${notes ? ': ' + notes : ''}`,
      })
      await Promise.allSettled([
        syncToHubSpot({ first_name, last_name, email, phone, practice_name, specialty, source, notes }),
        submitHubSpotForm({ first_name, last_name, email, phone, practice_name, specialty, source, notes }),
        sendLeadEmail({ first_name, last_name, email, phone, practice_name, specialty, source, notes }, true),
      ])
      return NextResponse.json({ success: true, lead_id: existingId, duplicate: true })
    }

    // Calculate AI score
    const ai_score = calculateAIScore(body)
    const temperature = calculateTemperature(ai_score)
    const revenue_potential = monthly_charges ? Math.round(monthly_charges * 0.08) : null // ~8% of monthly charges

    const { data, error } = await supabase.from('leads').insert({
      first_name, last_name, email, phone, practice_name,
      specialty: specialty || 'other',
      provider_count: provider_count || null,
      monthly_charges: monthly_charges || null,
      source: source || 'other',
      ai_score, temperature, revenue_potential,
      status: 'new',
      notes: notes || null,
      tags: source === 'website_chat' ? ['chat-capture'] : source === 'voice_agent' ? ['voice-capture'] : ['manual'],
    }).select().single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Log activity
    await supabase.from('activities').insert({
      lead_id: data.id,
      type: source === 'voice_agent' ? 'call' : source === 'website_chat' ? 'chat' : 'note',
      description: `New lead captured via ${source?.replace('_', ' ') || 'manual entry'}${notes ? ': ' + notes : ''}`,
    })

    // Auto-assign based on specialty
    const assignmentRules: Record<string, string[]> = {
      anesthesia: ['Logan Lowry', 'Allen Ranjan'],
      orthopedics: ['Mark Wines', 'Allen Ranjan'],
      pain_management: ['Allen Ranjan'],
      asc: ['Mark Wines', 'Allen Ranjan'],
      behavioral_health: ['Allen Ranjan'],
      urgent_care: ['Allen Ranjan'],
      other: ['Allen Ranjan'],
    }
    const reps = assignmentRules[specialty || 'other'] || assignmentRules.other
    const assignee = reps[Math.floor(Math.random() * reps.length)]
    await supabase.from('leads').update({ assigned_to: assignee }).eq('id', data.id)
    await supabase.from('activities').insert({ lead_id: data.id, type: 'note', description: `Auto-assigned to ${assignee}` })

    // Create notification
    const { error: notifError } = await supabase.from('notifications').insert({ type: 'new_lead', title: 'New lead captured', body: `${first_name} ${last_name} from ${practice_name || 'unknown practice'} (${specialty || 'other'})`, lead_id: data.id, link: `/crm/leads/${data.id}`, read: false })
    if (notifError) console.error('Notification insert failed:', notifError.message)

    // Mirror to HubSpot (non-blocking, best-effort, run concurrently)
    await Promise.allSettled([
      syncToHubSpot({ first_name, last_name, email, phone, practice_name, specialty, source, notes }),
      submitHubSpotForm({ first_name, last_name, email, phone, practice_name, specialty, source, notes }),
      sendLeadEmail({ first_name, last_name, email, phone, practice_name, specialty, source, notes }, false),
    ])

    return NextResponse.json({ success: true, lead_id: data.id, ai_score, temperature, assigned_to: assignee, duplicate: false })
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// GET: list leads with optional filters
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const specialty = searchParams.get('specialty')
  const temperature = searchParams.get('temperature')
  const status = searchParams.get('status')
  const limit = parseInt(searchParams.get('limit') || '50')

  let query = supabase.from('leads').select('*').order('ai_score', { ascending: false }).limit(limit)

  if (specialty) query = query.eq('specialty', specialty)
  if (temperature) query = query.eq('temperature', temperature)
  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ leads: data, count: data?.length || 0 })
}

// PATCH: update lead with audit logging
export async function PATCH(req: NextRequest) {
  try {
    const { lead_id, updates, changed_by } = await req.json()
    if (!lead_id) return NextResponse.json({ error: 'lead_id required' }, { status: 400 })

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co',
      process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder'
    )

    // Get current values for audit
    const { data: current } = await supabase.from('leads').select('*').eq('id', lead_id).single()
    if (!current) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

    // Constrain to allowed fields
    const allowed = ['status', 'temperature', 'ai_score', 'assigned_to', 'notes', 'tags', 'revenue_potential', 'next_follow_up', 'first_name', 'last_name', 'email', 'phone', 'practice_name', 'specialty', 'provider_count', 'monthly_charges', 'campaign_id']
    const safeUpdates: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(updates)) { if (allowed.includes(k)) safeUpdates[k] = v }
    const { error } = await supabase.from('leads').update({ ...safeUpdates, updated_at: new Date().toISOString() }).eq('id', lead_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Log each changed field to audit_log
    for (const [key, value] of Object.entries(updates)) {
      if (current[key] !== value) {
        await supabase.from('audit_log').insert({
          entity_type: 'lead', entity_id: lead_id,
          action: key === 'status' ? 'stage_change' : key === 'ai_score' ? 'score_change' : key === 'assigned_to' ? 'assign' : 'update',
          field_changed: key, old_value: String(current[key] ?? ''), new_value: String(value ?? ''), changed_by: changed_by || 'system',
        })
      }
    }

    return NextResponse.json({ success: true })
  } catch { return NextResponse.json({ error: 'Update failed' }, { status: 500 }) }
}
