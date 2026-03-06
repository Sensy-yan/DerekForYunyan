import { Hono } from 'hono'
import { cors } from 'hono/cors'
import OpenAI from 'openai'

// ─────────────────────────────────────────────
// LLM Client (Genspark proxy → Claude Sonnet)
// ─────────────────────────────────────────────
const llm = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
  baseURL: process.env.OPENAI_BASE_URL || 'https://www.genspark.ai/api/llm_proxy/v1',
})
const MODEL = 'claude-sonnet-4-5'

// ─────────────────────────────────────────────
// In-Memory Vector Store
// ─────────────────────────────────────────────
interface VectorChunk {
  id: string
  text: string
  embedding: number[]
  metadata: { source: string; index: number }
}

const vectorStore: VectorChunk[] = []
let currentDocName = ''
let currentDocRaw = ''

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-9)
}

async function embedText(text: string): Promise<number[]> {
  const res = await llm.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  })
  return res.data[0].embedding
}

function chunkText(text: string, size = 400, overlap = 80): string[] {
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/)
  const chunks: string[] = []
  let buf = ''
  for (const s of sentences) {
    if ((buf + ' ' + s).length > size) {
      if (buf) chunks.push(buf.trim())
      // overlap: keep last part
      const words = buf.split(' ')
      buf = words.slice(-Math.floor(overlap / 5)).join(' ') + ' ' + s
    } else {
      buf += (buf ? ' ' : '') + s
    }
  }
  if (buf.trim()) chunks.push(buf.trim())
  return chunks.filter(c => c.length > 20)
}

async function retrieveTopK(query: string, k = 6): Promise<string[]> {
  if (vectorStore.length === 0) return []
  const qEmbed = await embedText(query)
  const scored = vectorStore.map(chunk => ({
    text: chunk.text,
    score: cosineSimilarity(qEmbed, chunk.embedding),
  }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k).map(x => x.text)
}

// ─────────────────────────────────────────────
// HTML strip helper
// ─────────────────────────────────────────────
function stripHtml(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ').trim()
}

// ─────────────────────────────────────────────
// Hono App
// ─────────────────────────────────────────────
const app = new Hono()
app.use('/api/*', cors())

// ── Upload & vectorize ──────────────────────
app.post('/api/upload', async (c) => {
  try {
    const form = await c.req.formData()
    const file = form.get('file') as File | null
    if (!file) return c.json({ error: 'No file' }, 400)

    const name = file.name
    const raw = await file.text()
    const plainText = name.endsWith('.html') || name.endsWith('.htm') ? stripHtml(raw) : raw
    const truncated = plainText.slice(0, 60000)

    // Reset store
    vectorStore.length = 0
    currentDocName = name
    currentDocRaw = truncated

    // Chunk + embed
    const chunks = chunkText(truncated, 500, 100)
    const batchSize = 20
    let done = 0
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize)
      const embedRes = await llm.embeddings.create({
        model: 'text-embedding-3-small',
        input: batch,
      })
      batch.forEach((text, j) => {
        vectorStore.push({
          id: `chunk-${i + j}`,
          text,
          embedding: embedRes.data[j].embedding,
          metadata: { source: name, index: i + j },
        })
      })
      done += batch.length
    }

    return c.json({
      name,
      size: file.size,
      chunks: vectorStore.length,
      chars: truncated.length,
    })
  } catch (err: any) {
    console.error('upload error:', err)
    return c.json({ error: err.message || 'Upload failed' }, 500)
  }
})

// ── Chat (SSE streaming) ────────────────────
app.post('/api/chat', async (c) => {
  const { message } = await c.req.json()

  // RAG: retrieve context chunks
  let contextBlock = ''
  if (vectorStore.length > 0) {
    const chunks = await retrieveTopK(message, 6)
    if (chunks.length > 0) {
      contextBlock = `\n\n<document_context source="${currentDocName}">\n${chunks.join('\n---\n')}\n</document_context>`
    }
  }

  const systemPrompt = `You are Derek AI, an expert investment analyst assistant. 
You have deep expertise in venture capital, deal memos, financial analysis, and startup evaluation.
When document context is provided, answer based primarily on that document.
Format responses with clear structure using HTML tags: <h4> for headers, <ul><li> for lists, <strong> for emphasis.
Be concise, data-driven, and insightful. Always cite specific numbers and facts when available.`

  const userMsg = contextBlock
    ? `${message}${contextBlock}`
    : message

  // SSE streaming response
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  const streamLLM = async () => {
    try {
      const stream = await llm.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg },
        ],
        stream: true,
        max_tokens: 1024,
      })
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || ''
        if (text) {
          await writer.write(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`))
        }
      }
      await writer.write(encoder.encode('data: [DONE]\n\n'))
    } catch (err: any) {
      await writer.write(encoder.encode(`data: ${JSON.stringify({ error: err.message })}\n\n`))
    } finally {
      await writer.close()
    }
  }

  streamLLM()

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  })
})

// ── Generate Dashboard (SSE streaming HTML) ─
app.post('/api/generate-dashboard', async (c) => {
  const { prompt } = await c.req.json()

  // Retrieve relevant context
  let contextBlock = ''
  if (vectorStore.length > 0) {
    const chunks = await retrieveTopK(prompt, 10)
    if (chunks.length > 0) {
      contextBlock = `\n\nDocument: ${currentDocName}\n---\n${chunks.join('\n---\n')}`
    }
  }

  const systemPrompt = `You are Derek AI, an expert dashboard generator for investment intelligence.
Generate a complete, self-contained HTML dashboard section based on the user's request and any provided document context.

CRITICAL REQUIREMENTS:
1. Output ONLY valid HTML (no markdown, no backticks, no explanation text outside HTML)
2. Use Chart.js (already loaded on page via CDN) for all charts
3. Use the exact same CSS variable design system:
   --bg:#f0f4f8; --white:#fff; --navy:#0c2340; --border:#e2e8f0;
   --cyan:#06b6d4; --cyan-dark:#0e7490; --green:#10b981; --amber:#f59e0b; --red:#ef4444; --blue:#3b82f6; --purple:#8b5cf6;
4. Match this card style: background:white; border-radius:16px; border:1px solid #e2e8f0; padding:20px;
5. Use Inter font (already loaded), JetBrains Mono for numbers
6. Include inline <script> tags with Chart.js code using unique canvas IDs (prefix: dyn_)
7. Make it visually rich: KPI cards, charts, tables, color-coded badges
8. All data must come from the document context — extract real numbers and facts
9. The output must be a complete dashboard section, not just a chart
10. Use gradient header cards similar to: background:linear-gradient(135deg,#0c2340,#0e4a6e)

Generate a professional, data-rich dashboard now.`

  const userMsg = `Generate a dashboard for: "${prompt}"${contextBlock}`

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  const streamLLM = async () => {
    try {
      const stream = await llm.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg },
        ],
        stream: true,
        max_tokens: 4096,
      })
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || ''
        if (text) {
          await writer.write(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`))
        }
      }
      await writer.write(encoder.encode('data: [DONE]\n\n'))
    } catch (err: any) {
      await writer.write(encoder.encode(`data: ${JSON.stringify({ error: err.message })}\n\n`))
    } finally {
      await writer.close()
    }
  }

  streamLLM()

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  })
})

// ── Status ──────────────────────────────────
app.get('/api/status', (c) => {
  return c.json({
    model: MODEL,
    docLoaded: currentDocName || null,
    chunks: vectorStore.length,
  })
})

// ── Main Page ────────────────────────────────
app.get('/', (c) => c.html(MAIN_HTML))

// ─────────────────────────────────────────────
// MAIN HTML
// ─────────────────────────────────────────────
const MAIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Derek — AI Dashboard Intelligence</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
:root{
  --bg:#f0f4f8;--bg2:#e8edf2;--white:#fff;--navy:#0c2340;
  --border:#e2e8f0;--border2:#f1f5f9;
  --ts:#4b5563;--tt:#9ca3af;
  --cyan:#06b6d4;--cdark:#0e7490;
  --green:#10b981;--gl:#d1fae5;
  --amber:#f59e0b;--al:#fef3c7;
  --red:#ef4444;--rl:#fee2e2;
  --blue:#3b82f6;--bl:#dbeafe;
  --purple:#8b5cf6;--pl:#ede9fe;
  --r-sm:6px;--r-md:8px;--r-lg:12px;--r-xl:16px;--r-full:999px;
  --t:.15s ease;
}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;overflow:hidden;font-family:'Inter',sans-serif;background:var(--bg);}

/* ── TOPBAR ── */
.topbar{background:var(--white);border-bottom:1px solid var(--border);height:56px;display:flex;align-items:center;padding:0 20px;gap:10px;flex-shrink:0;z-index:100;}
.tb-logo{width:34px;height:34px;background:linear-gradient(135deg,#0e7490,#06b6d4);border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.tb-logo i{font-size:14px;color:#fff;}
.tb-title{font-size:0.96rem;font-weight:800;color:var(--navy);letter-spacing:-.02em;}
.tb-dot{width:7px;height:7px;background:#10b981;border-radius:50%;}
.tb-tag{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:var(--r-full);font-size:.68rem;font-weight:700;}
.tg-teal{background:rgba(6,182,212,.1);color:#0e7490;}
.tg-amber{background:rgba(245,158,11,.1);color:#b45309;}
.tg-green{background:rgba(16,185,129,.1);color:#059669;}
.tb-sp{flex:1;}
.tb-model{display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:var(--r-md);border:1px solid rgba(6,182,212,.25);background:rgba(6,182,212,.06);font-size:.72rem;font-weight:600;color:#0e7490;}
.tb-model .dot{width:6px;height:6px;background:#10b981;border-radius:50%;animation:pulse 2s infinite;}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.4;}}
.tb-user{width:32px;height:32px;background:linear-gradient(135deg,#0c2340,#0e4a6e);border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;cursor:pointer;}

/* ── LAYOUT ── */
.page{display:flex;flex-direction:column;height:100vh;overflow:hidden;}
.body{display:flex;flex:1;min-height:0;overflow:hidden;}

/* ── LEFT PANEL ── */
.left{flex:1;min-width:0;overflow-y:auto;padding:20px;background:var(--bg);display:flex;flex-direction:column;gap:16px;}
.left::-webkit-scrollbar{width:4px;}
.left::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px;}

/* ── UPLOAD ZONE ── */
.upload-zone{background:var(--white);border:2px dashed var(--border);border-radius:var(--r-xl);padding:28px 20px;text-align:center;cursor:pointer;transition:all var(--t);position:relative;}
.upload-zone:hover,.upload-zone.drag{border-color:#06b6d4;background:rgba(6,182,212,.03);}
.upload-zone.has-file{border-style:solid;border-color:rgba(16,185,129,.4);background:rgba(16,185,129,.03);}
.upload-icon{width:48px;height:48px;background:linear-gradient(135deg,#0e7490,#06b6d4);border-radius:14px;display:flex;align-items:center;justify-content:center;margin:0 auto 12px;box-shadow:0 4px 14px rgba(6,182,212,.3);}
.upload-icon i{font-size:20px;color:#fff;}
.upload-title{font-size:.94rem;font-weight:700;color:var(--navy);margin-bottom:5px;}
.upload-sub{font-size:.76rem;color:var(--tt);line-height:1.6;}
.upload-types{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:10px;}
.upload-type{font-size:.65rem;font-weight:600;padding:2px 8px;border-radius:var(--r-full);background:var(--bg2);color:var(--ts);border:1px solid var(--border);}
.upload-input{position:absolute;inset:0;opacity:0;cursor:pointer;}
.file-loaded{display:flex;align-items:center;gap:10px;padding:12px 14px;background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.25);border-radius:var(--r-lg);margin-top:12px;}
.file-loaded-icon{width:34px;height:34px;background:rgba(16,185,129,.12);border-radius:var(--r-md);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.file-loaded-icon i{font-size:14px;color:#059669;}
.file-loaded-info{flex:1;min-width:0;}
.file-loaded-name{font-size:.8rem;font-weight:700;color:var(--navy);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.file-loaded-meta{font-size:.68rem;color:var(--tt);margin-top:2px;}
.file-remove{cursor:pointer;color:var(--tt);font-size:12px;padding:4px;border-radius:4px;transition:color var(--t);}
.file-remove:hover{color:var(--red);}

/* ── VECTORIZE PROGRESS ── */
.vec-progress{background:var(--white);border:1px solid var(--border);border-radius:var(--r-xl);padding:16px;display:none;}
.vec-progress.show{display:block;}
.vec-title{font-size:.8rem;font-weight:700;color:var(--navy);margin-bottom:10px;display:flex;align-items:center;gap:8px;}
.vec-bar-track{height:6px;background:var(--bg2);border-radius:var(--r-full);overflow:hidden;margin-bottom:8px;}
.vec-bar-fill{height:100%;background:linear-gradient(90deg,#0e7490,#06b6d4);border-radius:var(--r-full);transition:width .4s ease;width:0%;}
.vec-status{font-size:.72rem;color:var(--tt);}
.vec-chunks{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;}
.vec-chunk{font-size:.62rem;padding:2px 7px;border-radius:var(--r-full);background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.2);color:#0e7490;}

/* ── GENERATE PROMPT ── */
.gen-box{background:var(--white);border:1px solid var(--border);border-radius:var(--r-xl);padding:18px;}
.gen-box-title{font-size:.82rem;font-weight:700;color:var(--navy);margin-bottom:12px;display:flex;align-items:center;gap:8px;}
.gen-presets{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:12px;}
.gen-preset{display:flex;align-items:center;gap:5px;padding:5px 11px;border-radius:var(--r-full);border:1px solid var(--border);background:var(--bg);font-size:.72rem;font-weight:600;color:var(--ts);cursor:pointer;transition:all var(--t);}
.gen-preset:hover{border-color:#06b6d4;color:#0e7490;background:rgba(6,182,212,.05);}
.gen-input-row{display:flex;gap:8px;}
.gen-textarea{flex:1;resize:none;border:1px solid var(--border);border-radius:var(--r-lg);padding:10px 12px;font-size:.8rem;font-family:'Inter',sans-serif;color:var(--navy);outline:none;background:var(--bg);min-height:72px;line-height:1.6;}
.gen-textarea:focus{border-color:#06b6d4;background:var(--white);box-shadow:0 0 0 3px rgba(6,182,212,.1);}
.gen-textarea::placeholder{color:var(--tt);}
.gen-btn{padding:10px 18px;border-radius:var(--r-lg);border:none;background:linear-gradient(135deg,#0e7490,#06b6d4);color:#fff;font-size:.8rem;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;transition:all var(--t);display:flex;align-items:center;gap:7px;flex-shrink:0;align-self:flex-end;}
.gen-btn:hover{opacity:.88;transform:translateY(-1px);}
.gen-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;}

/* ── DYNAMIC DASHBOARD AREA ── */
.dash-area{background:var(--white);border:1px solid var(--border);border-radius:var(--r-xl);min-height:200px;overflow:hidden;}
.dash-area-header{padding:14px 18px;border-bottom:1px solid var(--border2);display:flex;align-items:center;gap:10px;}
.dash-area-icon{width:28px;height:28px;background:linear-gradient(135deg,#0e7490,#06b6d4);border-radius:8px;display:flex;align-items:center;justify-content:center;}
.dash-area-icon i{font-size:12px;color:#fff;}
.dash-area-title{font-size:.84rem;font-weight:700;color:var(--navy);}
.dash-area-tag{margin-left:auto;font-size:.65rem;font-weight:700;padding:2px 8px;border-radius:var(--r-full);background:rgba(16,185,129,.1);color:#059669;}
.dash-content{padding:18px;}

/* ── STREAM CURSOR ── */
.stream-cursor::after{content:'▋';animation:blink .7s steps(1) infinite;color:#06b6d4;font-size:.85em;}
@keyframes blink{0%,100%{opacity:1;}50%{opacity:0;}}

/* ── EMPTY STATE ── */
.empty-state{text-align:center;padding:40px 20px;color:var(--tt);}
.empty-state-icon{width:52px;height:52px;background:var(--bg2);border-radius:14px;display:flex;align-items:center;justify-content:center;margin:0 auto 14px;font-size:22px;color:var(--border);}
.empty-state h3{font-size:.88rem;font-weight:600;color:var(--ts);margin-bottom:6px;}
.empty-state p{font-size:.76rem;line-height:1.6;}

/* ── RIGHT: AI PANEL ── */
.right{flex:0 0 380px;display:flex;flex-direction:column;border-left:1px solid var(--border);background:var(--white);overflow:hidden;}
.ai-header{padding:14px 16px;border-bottom:1px solid var(--border2);display:flex;align-items:center;gap:10px;flex-shrink:0;}
.ai-av{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#0c4a56,#06b6d4);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 2px 8px rgba(6,182,212,.3);}
.ai-av i{font-size:14px;color:#fff;}
.ai-title{font-size:.88rem;font-weight:700;color:var(--navy);}
.ai-sub{font-size:.64rem;color:var(--tt);margin-top:1px;}
.ai-ctx{margin-left:auto;display:flex;align-items:center;gap:5px;background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.25);border-radius:var(--r-full);padding:3px 10px;font-size:.67rem;font-weight:600;color:#0e7490;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

/* ── CHIPS ── */
.chip-strip{padding:8px 12px;border-bottom:1px solid var(--border2);display:flex;gap:5px;overflow-x:auto;flex-shrink:0;background:var(--bg);}
.chip-strip::-webkit-scrollbar{height:0;}
.ai-chip{display:flex;align-items:center;gap:5px;flex-shrink:0;padding:4px 10px;border-radius:var(--r-full);border:1px solid var(--border);font-size:.67rem;font-weight:600;color:var(--tt);cursor:pointer;transition:all var(--t);background:var(--white);white-space:nowrap;font-family:'Inter',sans-serif;}
.ai-chip:hover{border-color:#06b6d4;color:#0e7490;background:rgba(6,182,212,.05);}
.ai-chip.active{background:#06b6d4;color:#fff;border-color:#06b6d4;}
.cd{width:6px;height:6px;border-radius:50%;flex-shrink:0;}

/* ── MESSAGES ── */
.ai-msgs{flex:1;overflow-y:auto;padding:14px 14px 8px;display:flex;flex-direction:column;gap:12px;}
.ai-msgs::-webkit-scrollbar{width:4px;}
.ai-msgs::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px;}
.ai-idle{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:20px 16px;gap:10px;}
.ai-idle-icon{width:52px;height:52px;border-radius:16px;background:linear-gradient(135deg,#0c4a56,#06b6d4);display:flex;align-items:center;justify-content:center;font-size:22px;color:#fff;box-shadow:0 4px 16px rgba(6,182,212,.35);}
.ai-idle h3{font-size:.92rem;font-weight:700;color:var(--navy);}
.ai-idle p{font-size:.75rem;color:var(--tt);line-height:1.6;text-align:center;}
.tip-list{display:flex;flex-direction:column;gap:6px;width:100%;margin-top:4px;}
.tip-item{display:flex;align-items:center;gap:8px;padding:9px 11px;background:var(--bg);border:1px solid var(--border2);border-radius:var(--r-lg);cursor:pointer;transition:all var(--t);}
.tip-item:hover{border-color:#06b6d4;background:rgba(6,182,212,.04);}
.tip-em{font-size:14px;flex-shrink:0;}
.tip-txt{font-size:.74rem;color:var(--ts);font-weight:500;line-height:1.45;}

.ai-msg{display:flex;gap:8px;}
.ai-msg.user{flex-direction:row-reverse;}
.msg-av{width:28px;height:28px;border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;}
.msg-av.bot{background:linear-gradient(135deg,#0c4a56,#06b6d4);color:#fff;}
.msg-av.usr{background:var(--navy);color:#fff;}
.msg-bubble{max-width:84%;padding:9px 12px;border-radius:12px;font-size:.77rem;line-height:1.65;color:var(--navy);}
.ai-msg.user .msg-bubble{background:linear-gradient(135deg,#0c4a56,#0e7490);color:#fff;border-radius:12px 2px 12px 12px;}
.ai-msg.bot .msg-bubble{background:var(--bg);border:1px solid var(--border2);border-radius:2px 12px 12px 12px;}
.msg-bubble h4{font-size:.75rem;font-weight:700;color:var(--navy);margin:0 0 5px;}
.ai-msg.user .msg-bubble h4{color:#fff;}
.msg-bubble ul{margin:4px 0;padding-left:16px;}
.msg-bubble li{margin-bottom:3px;}
.msg-bubble strong{color:#0e7490;}
.ai-msg.user .msg-bubble strong{color:#67e8f9;}
.msg-bubble p{margin-bottom:6px;}
.msg-bubble p:last-child{margin-bottom:0;}
.typing-dots{display:flex;gap:4px;padding:10px 12px;background:var(--bg);border:1px solid var(--border2);border-radius:2px 12px 12px 12px;width:fit-content;}
.typing-dots span{width:6px;height:6px;background:#9ca3af;border-radius:50%;animation:bounce 1.2s infinite;}
.typing-dots span:nth-child(2){animation-delay:.2s;}
.typing-dots span:nth-child(3){animation-delay:.4s;}
@keyframes bounce{0%,60%,100%{transform:translateY(0);}30%{transform:translateY(-5px);}}

/* ── AI INPUT ── */
.ai-input{padding:12px;border-top:1px solid var(--border2);flex-shrink:0;}
.ai-input-row{display:flex;gap:8px;align-items:flex-end;}
.ai-ta{flex:1;resize:none;border:1px solid var(--border);border-radius:var(--r-lg);padding:9px 12px;font-size:.77rem;font-family:'Inter',sans-serif;color:var(--navy);outline:none;background:var(--bg);min-height:64px;max-height:120px;line-height:1.5;}
.ai-ta:focus{border-color:#06b6d4;background:var(--white);box-shadow:0 0 0 3px rgba(6,182,212,.1);}
.ai-ta::placeholder{color:var(--tt);}
.send-btn{width:34px;height:34px;border-radius:var(--r-md);border:none;background:linear-gradient(135deg,#0e7490,#06b6d4);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all var(--t);}
.send-btn:hover{opacity:.85;transform:translateY(-1px);}
.send-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;}
.ai-hint{font-size:.64rem;color:var(--tt);margin-top:5px;text-align:center;}

/* ── RAG badge ── */
.rag-badge{display:inline-flex;align-items:center;gap:4px;font-size:.64rem;font-weight:600;padding:2px 8px;border-radius:var(--r-full);background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.2);color:#0e7490;margin-top:5px;}
</style>
</head>
<body>
<div class="page">

<!-- TOPBAR -->
<div class="topbar">
  <div class="tb-logo"><i class="fas fa-database"></i></div>
  <div class="tb-title">Derek</div>
  <div class="tb-dot"></div>
  <div class="tb-tag tg-teal"><i class="fas fa-circle" style="font-size:6px"></i> AI Intelligence</div>
  <div class="tb-tag tg-amber"><i class="fas fa-bolt" style="font-size:8px"></i> Dynamic Dashboard</div>
  <div class="tb-sp"></div>
  <div class="tb-model">
    <span class="dot"></span>
    claude-sonnet-4-5 · RAG
  </div>
  <div class="tb-user">D</div>
</div>

<!-- BODY -->
<div class="body">

<!-- ════ LEFT PANEL ════ -->
<div class="left" id="leftPanel">

  <!-- Upload Zone -->
  <div class="upload-zone" id="uploadZone"
    ondragover="event.preventDefault();this.classList.add('drag')"
    ondragleave="this.classList.remove('drag')"
    ondrop="handleDrop(event)">
    <input type="file" class="upload-input" id="fileInput"
      accept=".html,.htm,.txt,.md,.csv,.json,.pdf"
      onchange="handleFileChange(event)"/>
    <div class="upload-icon"><i class="fas fa-cloud-upload-alt"></i></div>
    <div class="upload-title">Upload Deal Memo or Document</div>
    <div class="upload-sub">Drag & drop or click to select a file.<br>File will be vectorized for semantic Q&A and dynamic dashboard generation.</div>
    <div class="upload-types">
      <span class="upload-type">.html</span>
      <span class="upload-type">.txt</span>
      <span class="upload-type">.md</span>
      <span class="upload-type">.csv</span>
      <span class="upload-type">.json</span>
    </div>
  </div>

  <!-- File loaded indicator -->
  <div class="file-loaded" id="fileLoaded" style="display:none">
    <div class="file-loaded-icon"><i class="fas fa-file-check"></i></div>
    <div class="file-loaded-info">
      <div class="file-loaded-name" id="loadedName">—</div>
      <div class="file-loaded-meta" id="loadedMeta">—</div>
    </div>
    <span class="file-remove" onclick="clearDoc()" title="Remove document"><i class="fas fa-times-circle"></i></span>
  </div>

  <!-- Vectorize Progress -->
  <div class="vec-progress" id="vecProgress">
    <div class="vec-title">
      <i class="fas fa-microchip" style="color:#06b6d4"></i>
      <span id="vecTitle">Vectorizing document…</span>
    </div>
    <div class="vec-bar-track"><div class="vec-bar-fill" id="vecBar"></div></div>
    <div class="vec-status" id="vecStatus">Extracting text and generating embeddings…</div>
    <div class="vec-chunks" id="vecChunks"></div>
  </div>

  <!-- Generate Prompt Box -->
  <div class="gen-box">
    <div class="gen-box-title">
      <i class="fas fa-magic" style="color:#06b6d4;font-size:13px"></i>
      Generate Dashboard with AI
    </div>
    <div class="gen-presets" id="genPresets">
      <span class="gen-preset" onclick="usePreset(this)"><span>📊</span> Financial Overview</span>
      <span class="gen-preset" onclick="usePreset(this)"><span>🏆</span> Top Customers & Revenue</span>
      <span class="gen-preset" onclick="usePreset(this)"><span>⚠️</span> Risk Assessment Dashboard</span>
      <span class="gen-preset" onclick="usePreset(this)"><span>📈</span> Revenue Trajectory & Projections</span>
      <span class="gen-preset" onclick="usePreset(this)"><span>🚪</span> Exit Scenarios & MOIC</span>
      <span class="gen-preset" onclick="usePreset(this)"><span>💼</span> Investment Thesis Summary</span>
      <span class="gen-preset" onclick="usePreset(this)"><span>📋</span> Cap Table & Deal Terms</span>
      <span class="gen-preset" onclick="usePreset(this)"><span>👥</span> Team & Founder Profile</span>
    </div>
    <div class="gen-input-row">
      <textarea class="gen-textarea" id="genInput"
        placeholder="Describe the dashboard you want to generate... e.g. 'Show me a KPI dashboard with revenue charts, key financial metrics, and customer concentration analysis'"
        onkeydown="if(event.key==='Enter'&&event.ctrlKey){generateDash()}"
        rows="3"></textarea>
      <button class="gen-btn" id="genBtn" onclick="generateDash()">
        <i class="fas fa-wand-magic-sparkles"></i> Generate
      </button>
    </div>
    <div style="font-size:.65rem;color:var(--tt);margin-top:6px;"><kbd style="background:var(--bg2);padding:1px 5px;border-radius:3px;font-size:.62rem">Ctrl+Enter</kbd> to generate · Works best with a document uploaded</div>
  </div>

  <!-- Dynamic Dashboard Output -->
  <div class="dash-area" id="dashArea">
    <div class="dash-area-header">
      <div class="dash-area-icon"><i class="fas fa-chart-line"></i></div>
      <div class="dash-area-title" id="dashAreaTitle">Generated Dashboard</div>
      <div class="dash-area-tag" id="dashAreaTag" style="display:none">Live</div>
    </div>
    <div class="dash-content" id="dashContent">
      <div class="empty-state">
        <div class="empty-state-icon"><i class="fas fa-chart-bar"></i></div>
        <h3>No Dashboard Generated Yet</h3>
        <p>Upload a document and enter a prompt above,<br>then click <strong>Generate</strong> to create a live AI dashboard.</p>
      </div>
    </div>
  </div>

</div><!-- /left -->

<!-- ════ RIGHT: AI CHAT ════ -->
<div class="right">
  <div class="ai-header">
    <div class="ai-av"><i class="fas fa-robot"></i></div>
    <div>
      <div class="ai-title">Derek AI</div>
      <div class="ai-sub">claude-sonnet-4-5 · Vector RAG</div>
    </div>
    <div class="ai-ctx" id="aiCtx">
      <i class="fas fa-circle" style="font-size:6px;color:#06b6d4"></i>
      <span id="aiCtxText">No doc loaded</span>
    </div>
  </div>

  <!-- Chips -->
  <div class="chip-strip">
    <button class="ai-chip" onclick="chipAsk('Give me an overview of this document',this)"><span class="cd" style="background:#06b6d4"></span>Overview</button>
    <button class="ai-chip" onclick="chipAsk('What are the key financial metrics and revenue figures?',this)"><span class="cd" style="background:#f59e0b"></span>Financials</button>
    <button class="ai-chip" onclick="chipAsk('What are the main investment risks?',this)"><span class="cd" style="background:#ef4444"></span>Risks</button>
    <button class="ai-chip" onclick="chipAsk('Summarize the deal terms and structure',this)"><span class="cd" style="background:#8b5cf6"></span>Deal Terms</button>
    <button class="ai-chip" onclick="chipAsk('What are the exit scenarios and MOIC projections?',this)"><span class="cd" style="background:#3b82f6"></span>Exit</button>
    <button class="ai-chip" onclick="chipAsk('Tell me about the founding team and key people',this)"><span class="cd" style="background:#10b981"></span>Team</button>
  </div>

  <!-- Messages -->
  <div class="ai-msgs" id="aiMsgs">
    <div class="ai-idle" id="aiIdle">
      <div class="ai-idle-icon"><i class="fas fa-robot"></i></div>
      <h3>Derek AI · RAG-Powered</h3>
      <p>Upload a document to enable semantic search. I'll answer questions based on your document's actual content using vector similarity.</p>
      <div class="tip-list">
        <div class="tip-item" onclick="useTip(this)">
          <span class="tip-em">📁</span>
          <span class="tip-txt">Upload a deal memo, then ask me to generate a financial dashboard</span>
        </div>
        <div class="tip-item" onclick="useTip(this)">
          <span class="tip-em">🔍</span>
          <span class="tip-txt">What are the key risks and how are they mitigated?</span>
        </div>
        <div class="tip-item" onclick="useTip(this)">
          <span class="tip-em">💰</span>
          <span class="tip-txt">Summarize the financial performance and revenue projections</span>
        </div>
        <div class="tip-item" onclick="useTip(this)">
          <span class="tip-em">🎯</span>
          <span class="tip-txt">What is the investment thesis and why should we invest?</span>
        </div>
        <div class="tip-item" onclick="useTip(this)">
          <span class="tip-em">🚪</span>
          <span class="tip-txt">Who are the most likely strategic acquirers and at what valuation?</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Input -->
  <div class="ai-input">
    <div class="ai-input-row">
      <textarea class="ai-ta" id="aiInput"
        placeholder="Ask anything about your document — AI will search through vectorized content to answer..."
        rows="3"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat();}"
        oninput="this.style.height='auto';this.style.height=Math.min(Math.max(this.scrollHeight,64),120)+'px'"></textarea>
      <button class="send-btn" id="sendBtn" onclick="sendChat()">
        <i class="fas fa-paper-plane" style="font-size:12px"></i>
      </button>
    </div>
    <div class="ai-hint"><i class="fas fa-vector-square" style="font-size:9px"></i> Vector RAG · Enter to send · Shift+Enter for new line</div>
  </div>
</div><!-- /right -->

</div><!-- /body -->
</div><!-- /page -->

<script>
// ══════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════
let docLoaded = false;
let docName = '';

// ══════════════════════════════════════════════
// FILE UPLOAD
// ══════════════════════════════════════════════
function handleDrop(e) {
  e.preventDefault();
  document.getElementById('uploadZone').classList.remove('drag');
  const file = e.dataTransfer?.files?.[0];
  if (file) processFile(file);
}

function handleFileChange(e) {
  const file = e.target.files?.[0];
  if (file) processFile(file);
  e.target.value = '';
}

async function processFile(file) {
  const allowed = ['html','htm','txt','md','csv','json'];
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  if (!allowed.includes(ext)) {
    addMsg('bot', '<p>⚠️ Unsupported file type <strong>.' + ext + '</strong>. Please upload .html, .txt, .md, .csv, or .json.</p>');
    return;
  }

  // Show progress
  const vp = document.getElementById('vecProgress');
  const bar = document.getElementById('vecBar');
  const status = document.getElementById('vecStatus');
  const title = document.getElementById('vecTitle');
  const chunksEl = document.getElementById('vecChunks');
  vp.classList.add('show');
  bar.style.width = '15%';
  title.textContent = 'Uploading ' + file.name + '…';
  status.textContent = 'Sending file to server…';
  chunksEl.innerHTML = '';

  const form = new FormData();
  form.append('file', file);

  try {
    bar.style.width = '40%';
    status.textContent = 'Extracting text content…';
    await new Promise(r => setTimeout(r, 300));
    bar.style.width = '65%';
    status.textContent = 'Generating vector embeddings…';

    const res = await fetch('/api/upload', { method: 'POST', body: form });
    const data = await res.json();

    if (data.error) throw new Error(data.error);

    bar.style.width = '100%';
    title.textContent = '✅ Vectorized: ' + data.name;
    status.textContent = data.chunks + ' chunks · ' + data.chars.toLocaleString() + ' chars · text-embedding-3-small';

    // Show chunk badges
    const n = Math.min(data.chunks, 16);
    for (let i = 0; i < n; i++) {
      const span = document.createElement('span');
      span.className = 'vec-chunk';
      span.textContent = 'chunk-' + i;
      chunksEl.appendChild(span);
    }
    if (data.chunks > 16) {
      const span = document.createElement('span');
      span.className = 'vec-chunk';
      span.textContent = '+' + (data.chunks - 16) + ' more';
      chunksEl.appendChild(span);
    }

    // Update state
    docLoaded = true;
    docName = data.name;

    // Show file loaded bar
    document.getElementById('fileLoaded').style.display = 'flex';
    document.getElementById('loadedName').textContent = data.name;
    const kb = Math.round(data.size / 1024);
    document.getElementById('loadedMeta').textContent = data.chunks + ' vectors · ' + kb + ' KB · RAG ready';

    // Update zone style
    document.getElementById('uploadZone').classList.add('has-file');

    // Update AI context pill
    document.getElementById('aiCtxText').textContent = data.name.slice(0, 20) + (data.name.length > 20 ? '…' : '');

    // Notify in chat
    removeIdle();
    addMsg('bot', \`<h4>📁 Document Vectorized: \${data.name}</h4>
      <p>Successfully created <strong>\${data.chunks} vector chunks</strong> using text-embedding-3-small embeddings.</p>
      <p>You can now:</p>
      <ul>
        <li><strong>Ask questions</strong> — I'll use semantic search to find relevant passages</li>
        <li><strong>Generate dashboards</strong> — Enter a prompt in the left panel to create dynamic charts</li>
      </ul>
      <div class="rag-badge"><i class="fas fa-vector-square" style="font-size:9px"></i> Vector RAG Active · claude-sonnet-4-5</div>\`);

  } catch (err) {
    bar.style.width = '0%';
    vp.classList.remove('show');
    addMsg('bot', '<p>❌ Failed to process file: ' + err.message + '</p>');
  }
}

function clearDoc() {
  docLoaded = false;
  docName = '';
  document.getElementById('fileLoaded').style.display = 'none';
  document.getElementById('vecProgress').classList.remove('show');
  document.getElementById('uploadZone').classList.remove('has-file');
  document.getElementById('aiCtxText').textContent = 'No doc loaded';
  addMsg('bot', '<p>📁 Document removed. Vector store cleared.</p>');
}

// ══════════════════════════════════════════════
// GENERATE DASHBOARD
// ══════════════════════════════════════════════
function usePreset(el) {
  const txt = el.querySelector('span:last-child')?.textContent || el.textContent.trim();
  document.getElementById('genInput').value = txt;
  document.getElementById('genInput').focus();
}

async function generateDash() {
  const prompt = document.getElementById('genInput').value.trim();
  if (!prompt) {
    document.getElementById('genInput').focus();
    return;
  }

  const btn = document.getElementById('genBtn');
  const dashContent = document.getElementById('dashContent');
  const dashTag = document.getElementById('dashAreaTag');
  const dashTitle = document.getElementById('dashAreaTitle');

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating…';
  dashTag.style.display = 'flex';
  dashTag.textContent = 'Streaming…';
  dashTitle.textContent = prompt.slice(0, 50) + (prompt.length > 50 ? '…' : '');

  // Show streaming placeholder
  dashContent.innerHTML = '<div style="padding:16px;font-size:.78rem;color:var(--tt);display:flex;align-items:center;gap:8px;"><i class="fas fa-spinner fa-spin" style="color:#06b6d4"></i> Generating dashboard with claude-sonnet-4-5…</div>';

  let htmlBuf = '';
  let renderTimer = null;

  try {
    const res = await fetch('/api/generate-dashboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let leftover = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = leftover + decoder.decode(value, { stream: true });
      const lines = text.split('\\n');
      leftover = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') break;
        try {
          const obj = JSON.parse(payload);
          if (obj.error) throw new Error(obj.error);
          if (obj.text) {
            htmlBuf += obj.text;
            // Throttle render to avoid too many DOM updates
            if (!renderTimer) {
              renderTimer = setTimeout(() => {
                renderTimer = null;
                renderDashStream(htmlBuf);
              }, 150);
            }
          }
        } catch(_) {}
      }
    }

    // Final render
    clearTimeout(renderTimer);
    renderDashFinal(htmlBuf);

    dashTag.textContent = '✓ Live';
    dashTag.style.background = 'rgba(16,185,129,.1)';
    dashTag.style.color = '#059669';

  } catch (err) {
    dashContent.innerHTML = '<div style="padding:16px;color:#dc2626;font-size:.8rem;">❌ Generation failed: ' + err.message + '</div>';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Generate';
  }
}

function renderDashStream(html) {
  const el = document.getElementById('dashContent');
  // Strip markdown fences if present
  let clean = html.replace(/^\`\`\`html\\s*/i, '').replace(/\`\`\`\\s*$/, '');
  el.innerHTML = clean + '<span class="stream-cursor"></span>';
}

function renderDashFinal(html) {
  const el = document.getElementById('dashContent');
  let clean = html.replace(/^\`\`\`html\\s*/i, '').replace(/\`\`\`\\s*$/, '').trim();
  el.innerHTML = clean;
  // Re-execute any inline scripts
  el.querySelectorAll('script').forEach(oldScript => {
    const newScript = document.createElement('script');
    newScript.textContent = oldScript.textContent;
    oldScript.replaceWith(newScript);
  });
}

// ══════════════════════════════════════════════
// AI CHAT
// ══════════════════════════════════════════════
function removeIdle() {
  const idle = document.getElementById('aiIdle');
  if (idle) idle.remove();
}

function addMsg(role, html) {
  removeIdle();
  const msgs = document.getElementById('aiMsgs');
  const div = document.createElement('div');
  div.className = 'ai-msg ' + role;
  div.innerHTML = \`
    <div class="msg-av \${role === 'bot' ? 'bot' : 'usr'}">\${role === 'bot' ? '<i class="fas fa-robot" style="font-size:10px"></i>' : '<i class="fas fa-user" style="font-size:10px"></i>'}</div>
    <div class="msg-bubble">\${html}</div>
  \`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function showTyping() {
  removeIdle();
  const msgs = document.getElementById('aiMsgs');
  const div = document.createElement('div');
  div.className = 'ai-msg bot';
  div.id = 'typingDot';
  div.innerHTML = '<div class="msg-av bot"><i class="fas fa-robot" style="font-size:10px"></i></div><div class="typing-dots"><span></span><span></span><span></span></div>';
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function hideTyping() {
  document.getElementById('typingDot')?.remove();
}

async function sendChat() {
  const input = document.getElementById('aiInput');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  input.style.height = '';

  const sendBtn = document.getElementById('sendBtn');
  sendBtn.disabled = true;

  addMsg('user', msg);
  showTyping();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });

    hideTyping();
    const msgs = document.getElementById('aiMsgs');

    // Create bot message div for streaming
    const div = document.createElement('div');
    div.className = 'ai-msg bot';
    div.innerHTML = '<div class="msg-av bot"><i class="fas fa-robot" style="font-size:10px"></i></div><div class="msg-bubble stream-cursor" id="streamBubble"></div>';
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;

    const bubble = document.getElementById('streamBubble');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let leftover = '';
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = leftover + decoder.decode(value, { stream: true });
      const lines = chunk.split('\\n');
      leftover = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') break;
        try {
          const obj = JSON.parse(payload);
          if (obj.text) {
            fullText += obj.text;
            bubble.innerHTML = fullText;
            msgs.scrollTop = msgs.scrollHeight;
          }
        } catch(_) {}
      }
    }

    bubble.classList.remove('stream-cursor');
    if (docLoaded) {
      bubble.innerHTML += '<div class="rag-badge" style="margin-top:8px"><i class="fas fa-vector-square" style="font-size:9px"></i> Vector RAG · ' + docName.slice(0,24) + '</div>';
    }

  } catch (err) {
    hideTyping();
    addMsg('bot', '<p>❌ Error: ' + err.message + '</p>');
  } finally {
    sendBtn.disabled = false;
  }
}

function chipAsk(text, btn) {
  document.querySelectorAll('.ai-chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  setTimeout(() => btn.classList.remove('active'), 2000);
  document.getElementById('aiInput').value = text;
  sendChat();
}

function useTip(el) {
  const txt = el.querySelector('.tip-txt').textContent;
  document.getElementById('aiInput').value = txt;
  sendChat();
}
</script>
</body>
</html>`

export default app
