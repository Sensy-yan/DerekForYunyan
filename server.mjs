/**
 * Derek AI Dashboard - Node.js Server (v2)
 * Full-featured: file upload, vectorization (BM25+embedding), dynamic dashboard, RAG Q&A
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import OpenAI from 'openai'
import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

// Lazy-load PDF and DOCX parsers
let _mammoth = null
async function getMammoth() {
  if (!_mammoth) {
    const mod = await import('mammoth')
    _mammoth = mod.default || mod
  }
  return _mammoth
}

let _pdfjsLib = null
function getPdfjsLib() {
  if (!_pdfjsLib) {
    _pdfjsLib = require('pdfjs-dist/build/pdf.js')
    _pdfjsLib.GlobalWorkerOptions.workerSrc = ''
  }
  return _pdfjsLib
}

// PDF parse using pdfjs-dist (no worker, server-side)
async function parsePDF(buffer) {
  try {
    const pdfjsLib = getPdfjsLib()
    const uint8 = new Uint8Array(buffer)
    const doc = await pdfjsLib.getDocument({ 
      data: uint8, 
      useWorkerFetch: false, 
      isEvalSupported: false,
      useSystemFonts: true
    }).promise
    let text = ''
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      text += content.items.map(item => item.str).join(' ') + '\n'
    }
    return { text: text.trim(), numpages: doc.numPages }
  } catch(e) {
    throw new Error('PDF parsing failed: ' + e.message)
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─────────────────────────────────────────────
// Load API config
// ─────────────────────────────────────────────
let apiKey = process.env.OPENAI_API_KEY || ''
let baseURL = process.env.OPENAI_BASE_URL || 'https://www.genspark.ai/api/llm_proxy/v1'

function loadConfig() {
  try {
    const cfgPath = path.join(os.homedir(), '.genspark_llm.yaml')
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, 'utf8')
      const cfg = yaml.load(raw)
      const rawKey = cfg?.openai?.api_key || ''
      const expanded = rawKey.replace(/\${(\w+)}/g, (_, k) => process.env[k] || rawKey)
      if (expanded && !expanded.includes('${')) apiKey = expanded
      baseURL = cfg?.openai?.base_url || baseURL
    }
  } catch (e) { /* ignore */ }
}

loadConfig()

const MODEL = 'gpt-5'
let llm = new OpenAI({ apiKey, baseURL })

console.log(`[init] Derek AI Dashboard | Model: ${MODEL} | Key: ${apiKey.slice(0,8)}...`)

// ─────────────────────────────────────────────
// Built-in Knowledge Base (Shoreless Inc.)
// ─────────────────────────────────────────────
const BUILTIN_KB = [
  { id: 'kb-0', text: 'Shoreless, Inc. is an enterprise AI company founded around 2021, headquartered in Katy, TX (near Houston). Founder and CEO: Kenneth Myers (95% equity). The company specializes in Agentic AI built on 100% Microsoft C#/.NET stack with native Azure, Teams, and Dynamics integration.' },
  { id: 'kb-1', text: 'TC Energy is the anchor customer with a Phase 2 Purchase Order (PO #4500664463) for $329,600 ($41,200/month) for the Agentic AI US Gas Commercial project, running May 1 - December 31, 2025. Buyer contact: Elize Moreau (elize_moreau@tcenergy.com). This represents an 8-month engagement.' },
  { id: 'kb-2', text: 'Financial metrics: H1 2025 revenue $100,150 (services delivery). H2 2025 contracted $329,600 (TC Energy Phase 2 PO, signed). FY2025 total estimate ~$430K. FY2025 ARR run-rate $600K+. FY2026 projected $800K-$1.2M (TC renewal + new logos). FY2027 projected $1.5M-$2.5M (multi-vertical expansion).' },
  { id: 'kb-3', text: 'P&L Summary (Jan-Jun 2025): Services Revenue $100,150. Contract Labor (COGS) -$114,500. Other expenses total -$123,296. Net Operating Loss: -$23,146. Gross margin is effectively ~100% on SaaS portion.' },
  { id: 'kb-4', text: 'Balance Sheet (Jun 30, 2025): Cash $259,650. Total Current Assets $327,050. Accounts Receivable $67,400. Liabilities $350,196 (primarily $350,000 convertible notes). Equity: -$23,146 (negative).' },
  { id: 'kb-5', text: 'Deal Terms: Investment vehicle GSV SPV XXVII. Security type: Series Seed Preferred. Convertible note: $250K at $10M valuation cap, 20% discount. Seed-1 price $0.2833/share (1,291,993 shares). Seed-2 price $1.5816/share (1,264,542 shares). Initial closing October 1, 2025. Third closing January 22, 2026.' },
  { id: 'kb-6', text: 'Capitalization table: Kenneth Myers 9,500,000 common shares (95%). Black Lake 500,000 common shares (5%). Total authorized 14,500,000 shares (common + preferred). Existing convertible notes $350,000 automatically convert to Seed-1 at closing.' },
  { id: 'kb-7', text: 'Risk Assessment - HIGH RISKS: (1) Customer concentration - TC Energy represents ~95% of pipeline, single PO dependency. (2) Founder/key-person - Kenneth Myers is sole developer and sales leader. (3) Services-heavy model - consulting revenue, not SaaS recurring. MEDIUM RISKS: Long sales cycles (3-6 months), negative equity, competitive pressure from Microsoft Copilot, ServiceNow.' },
  { id: 'kb-8', text: 'Exit Scenarios: Base case FY2028 strategic M&A $40-60M (10-20x MOIC). Upside: Microsoft acquisition $100M+ (50x+ MOIC). Downside: TC Energy stalls, 0-2x. Potential acquirers: Microsoft, ServiceNow, UiPath, Palantir, Accenture/Deloitte, TC Energy (vertical integration).' },
  { id: 'kb-9', text: 'Technology: Agentic AI Engine with autonomous multi-step agents. 100% C#/.NET Microsoft Stack - native Azure, Teams, Dynamics 365 integration. Enterprise-grade security (on-premise/hybrid deployment). PLATO Leader framework: AI leadership, change management, AI adoption, digital twins. Proven ROI: +59% throughput improvement, -30% cost reduction.' },
  { id: 'kb-10', text: 'Market opportunity: Total Addressable Market $25B+ (Energy TAM $14B by 2030). Target verticals: Energy 75%, Accounting 35%, Logistics 25%, Real Estate 20%. Company is uniquely positioned as Microsoft-native agentic AI vs Python-based competitors.' },
  { id: 'kb-11', text: 'Investment thesis: (1) Rare Microsoft-native C#/.NET agentic AI - significant technical differentiation. (2) Validated by TC Energy $329,600 PO with measurable ROI. (3) Proven outcomes (+59% throughput, -30% costs). (4) Large fragmented TAM $25B+. (5) Experienced founder (20+ years enterprise software). (6) Market timing aligns with 2025-2026 production-ready agentic AI shift.' },
  { id: 'kb-12', text: 'GP Recommendation: Invest $250K as convertible note/Series Seed at $10M cap. Use of proceeds: Product development (agentic engine, PLATO platform), sales/marketing, team expansion. Key milestones: TC Energy Phase 2 delivery, 2 new customer logos by Q1 2026, SaaS ARR $500K+.' },
  { id: 'kb-13', text: 'Team: Kenneth Myers - Founder/CEO (95% equity). Email: KEN@SHORELESS.AI. LinkedIn: linkedin.com/in/kenneymyers. Background: 20+ years enterprise software and AI, author, ordained elder, kickboxing black belt. Published 10+ LinkedIn articles on enterprise AI strategy (2023-2025). Tags: C#/.NET, Agentic AI, Enterprise Integration, AI Governance, Greentown Labs, Houston Tech Ecosystem.' },
  { id: 'kb-14', text: 'Sidecar investors in GSV SPV XXVII: Mayes Middleton ($50K), Rocker U Interests, other LPs. Microsoft has strategic sidecar interest. Black Lake (5% common equity). Company is based in Greentown Labs incubator, part of Houston tech ecosystem.' },
  { id: 'kb-15', text: 'Revenue table: H1 2025 Actual $100,150 (services). H2 2025 Contracted $329,600 (TC Energy PO). FY2025 Estimate ~$430K. FY2025 ARR Run-rate $600K+. FY2026 Projection $800K-$1.2M. FY2027 Projection $1.5M-$2.5M. Key driver: TC Energy Phase 2 at $41,200/month.' }
]

// ─────────────────────────────────────────────
// Vector Store (document + builtin KB)
// ─────────────────────────────────────────────
let vectorStore = []  // uploaded document chunks
let currentDocName = ''
let currentDocRaw = ''
let embeddingAvailable = null

// BM25 keyword search
function bm25Search(query, chunks, k = 8) {
  if (!chunks || chunks.length === 0) return []
  const qTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2)
  if (qTerms.length === 0) return chunks.slice(0, k).map(c => c.text)
  const scored = chunks.map(chunk => {
    const text = chunk.text.toLowerCase()
    let score = 0
    for (const term of qTerms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const matches = (text.match(new RegExp(escaped, 'g')) || []).length
      score += Math.log(1 + matches) * (1 + term.length / 8)
    }
    if (text.includes(query.toLowerCase().slice(0, 20))) score *= 1.8
    return { text: chunk.text, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k).filter(x => x.score > 0).map(x => x.text)
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9)
}

async function retrieveContext(query, k = 8) {
  const results = []
  
  // 1. Search uploaded document (if available)
  if (vectorStore.length > 0) {
    if (embeddingAvailable === true) {
      try {
        const qEmbed = (await llm.embeddings.create({ model: 'text-embedding-3-small', input: query })).data[0].embedding
        const scored = vectorStore.filter(c => c.embedding).map(c => ({ text: c.text, score: cosineSimilarity(qEmbed, c.embedding) }))
        scored.sort((a, b) => b.score - a.score)
        results.push(...scored.slice(0, k).map(x => x.text))
      } catch (_) {
        embeddingAvailable = false
        results.push(...bm25Search(query, vectorStore, k))
      }
    } else {
      results.push(...bm25Search(query, vectorStore, k))
    }
  }
  
  // 2. Always search builtin KB
  const kbResults = bm25Search(query, BUILTIN_KB, 6)
  for (const r of kbResults) {
    if (!results.includes(r)) results.push(r)
  }
  
  return results.slice(0, k + 4)
}

// ─────────────────────────────────────────────
// Text processing
// ─────────────────────────────────────────────
function stripHtml(raw) {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ').trim()
}

function chunkText(text, size = 500, overlap = 100) {
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/)
  const chunks = []; let buf = ''
  for (const s of sentences) {
    if ((buf + ' ' + s).length > size) {
      if (buf) chunks.push(buf.trim())
      const words = buf.split(' ')
      buf = words.slice(-Math.floor(overlap / 5)).join(' ') + ' ' + s
    } else { buf += (buf ? ' ' : '') + s }
  }
  if (buf.trim()) chunks.push(buf.trim())
  return chunks.filter(c => c.length > 20)
}

// ─────────────────────────────────────────────
// Hono App
// ─────────────────────────────────────────────
const app = new Hono()
app.use('/api/*', cors())

// ── Upload & vectorize ────────────────────────
// ── Text extraction helpers ───────────────────
async function extractTextFromFile(file) {
  const name = file.name.toLowerCase()
  const ext = name.split('.').pop()

  // PDF
  if (ext === 'pdf') {
    const buffer = Buffer.from(await file.arrayBuffer())
    try {
      const data = await parsePDF(buffer)
      return { text: data.text, type: 'pdf', pageCount: data.numpages }
    } catch (e) {
      throw new Error('Failed to parse PDF: ' + e.message)
    }
  }
  // DOCX
  if (ext === 'docx' || ext === 'doc') {
    const buffer = Buffer.from(await file.arrayBuffer())
    try {
      const mammoth = await getMammoth()
      const result = await mammoth.extractRawText({ buffer })
      return { text: result.value, type: 'docx', warnings: result.messages?.length || 0 }
    } catch (e) {
      throw new Error('Failed to parse DOCX: ' + e.message)
    }
  }

  // Images (JPG, PNG, GIF, WEBP, BMP, etc.)
  if (['jpg','jpeg','png','gif','webp','bmp','tiff','svg'].includes(ext)) {
    // Use LLM vision to describe image if available, otherwise return placeholder
    const buffer = Buffer.from(await file.arrayBuffer())
    const base64 = buffer.toString('base64')
    const mimeMap = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', bmp:'image/bmp', tiff:'image/tiff', svg:'image/svg+xml' }
    const mime = mimeMap[ext] || 'image/jpeg'
    const dataUrl = `data:${mime};base64,${base64}`

    // Try vision API
    try {
      const visionRes = await llm.chat.completions.create({
        model: MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Please analyze this image in detail. Describe all text, numbers, charts, tables, figures, and key information visible in the image. Focus on extractable data for financial analysis.' },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }],
        max_tokens: 2048
      })
      const description = visionRes.choices[0]?.message?.content || ''
      return { text: `[Image: ${file.name}]\n${description}`, type: 'image', width: null, height: null }
    } catch (e) {
      // Vision API failed, return basic metadata
      return { text: `[Image file: ${file.name} — ${Math.round(file.size/1024)}KB. Image content analysis unavailable. Please ensure your API key supports vision capabilities.]`, type: 'image', error: e.message }
    }
  }

  // HTML
  if (ext === 'html' || ext === 'htm') {
    const raw = await file.text()
    return { text: stripHtml(raw), type: 'html' }
  }

  // Plain text, markdown, CSV, JSON
  const raw = await file.text()
  return { text: raw, type: ext }
}

app.post('/api/upload', async (c) => {
  try {
    const form = await c.req.formData()
    // Support both single 'file' and multiple 'files[]'
    const singleFile = form.get('file')
    const multiFiles = form.getAll('files[]')
    const files = multiFiles.length > 0 ? multiFiles : (singleFile ? [singleFile] : [])
    if (files.length === 0) return c.json({ error: 'No file' }, 400)

    const supportedExts = ['html','htm','txt','md','csv','json','pdf','doc','docx','jpg','jpeg','png','gif','webp','bmp','tiff','svg']
    
    // Validate all files first
    for (const f of files) {
      const ext = f.name.split('.').pop()?.toLowerCase() || ''
      if (!supportedExts.includes(ext)) {
        return c.json({ error: `Unsupported file type: .${ext} (${f.name}). Supported: ${supportedExts.join(', ')}` }, 400)
      }
    }

    // Reset vector store and process all files
    vectorStore = []
    const fileResults = []
    let totalText = ''
    
    for (const file of files) {
      const name = file.name
      try {
        const extracted = await extractTextFromFile(file)
        const text = extracted.text.slice(0, Math.floor(80000 / files.length)) // distribute space evenly
        totalText += (totalText ? '\n\n--- Document: ' + name + ' ---\n' : '') + text
        fileResults.push({ name, size: file.size, type: extracted.type, chars: text.length, ok: true })
      } catch (e) {
        fileResults.push({ name, size: file.size, type: 'error', chars: 0, ok: false, error: e.message })
      }
    }

    const truncated = totalText.slice(0, 80000)
    currentDocName = files.length === 1 ? files[0].name : `${files.length} files`
    currentDocRaw = truncated

    const chunks = chunkText(truncated, 500, 100)
    let usedEmbeddings = false

    // Try embeddings first
    if (embeddingAvailable !== false) {
      try {
        const batchSize = 20
        for (let i = 0; i < chunks.length; i += batchSize) {
          const batch = chunks.slice(i, i + batchSize)
          const embedRes = await llm.embeddings.create({ model: 'text-embedding-3-small', input: batch })
          batch.forEach((text, j) => {
            vectorStore.push({ id: `chunk-${i+j}`, text, embedding: embedRes.data[j].embedding, metadata: { source: currentDocName, index: i+j } })
          })
        }
        embeddingAvailable = true; usedEmbeddings = true
      } catch (e) {
        embeddingAvailable = false
        chunks.forEach((text, i) => vectorStore.push({ id: `chunk-${i}`, text, embedding: null, metadata: { source: currentDocName, index: i } }))
      }
    } else {
      chunks.forEach((text, i) => vectorStore.push({ id: `chunk-${i}`, text, embedding: null, metadata: { source: currentDocName, index: i } }))
    }

    return c.json({
      name: currentDocName,
      fileCount: files.length,
      files: fileResults,
      totalSize: files.reduce((s, f) => s + f.size, 0),
      chunks: vectorStore.length,
      chars: truncated.length,
      fileType: files.length === 1 ? fileResults[0]?.type : 'multi',
      searchMode: usedEmbeddings ? 'vector' : 'bm25'
    })
  } catch (err) {
    console.error('[upload]', err.message)
    return c.json({ error: err.message || 'Upload failed' }, 500)
  }
})

// ── Config update ─────────────────────────────
app.post('/api/config', async (c) => {
  try {
    const { key } = await c.req.json()
    if (!key) return c.json({ error: 'No key provided' }, 400)
    apiKey = key
    llm = new OpenAI({ apiKey, baseURL })
    embeddingAvailable = null
    // Test connection
    try {
      const test = await llm.chat.completions.create({
        model: MODEL, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5
      })
      console.log('[config] API key updated and verified')
      return c.json({ ok: true, model: MODEL })
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 400)
    }
  } catch (e) {
    return c.json({ error: e.message }, 500)
  }
})

// ── Chat (SSE streaming) ─────────────────────
app.post('/api/chat', async (c) => {
  try {
    const { message } = await c.req.json()
    if (!message) return c.json({ error: 'No message' }, 400)

    const contextChunks = await retrieveContext(message, 8)
    const contextSource = vectorStore.length > 0 ? currentDocName : 'built-in knowledge base'
    let contextBlock = ''
    if (contextChunks.length > 0) {
      contextBlock = `\n\n<context source="${contextSource}">\n${contextChunks.join('\n---\n')}\n</context>`
    }

    const systemPrompt = `You are Derek AI, a world-class investment analyst assistant specializing in venture capital deal analysis.
You have deep expertise in deal memos, financial analysis, startup evaluation, and VC investment strategy.

When answering:
- Use the provided context as your PRIMARY source (it contains real document data)
- Format with HTML: <h4> for headers, <ul><li> for lists, <strong> for key numbers/terms, <table> for data
- Be concise and data-driven - cite specific numbers, percentages, dates, and facts
- If data is from the document/KB, present it confidently
- For charts or visual requests, describe the data clearly so a dashboard can be generated`

    const userMsg = contextBlock ? `${message}${contextBlock}` : message

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const enc = new TextEncoder()

    const run = async () => {
      try {
        const stream = await llm.chat.completions.create({
          model: MODEL,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }],
          stream: true, max_tokens: 1500
        })
        for await (const chunk of stream) {
          const t = chunk.choices[0]?.delta?.content || ''
          if (t) await writer.write(enc.encode(`data: ${JSON.stringify({ text: t })}\n\n`))
        }
        await writer.write(enc.encode('data: [DONE]\n\n'))
      } catch (err) {
        console.error('[chat]', err.message)
        // Fallback: answer from KB using simple pattern matching
        const fallbackReply = getFallbackReply(message, contextChunks)
        for (const chunk of fallbackReply.match(/.{1,50}/g) || []) {
          await writer.write(enc.encode(`data: ${JSON.stringify({ text: chunk })}\n\n`))
          await new Promise(r => setTimeout(r, 30))
        }
        await writer.write(enc.encode('data: [DONE]\n\n'))
      } finally {
        await writer.close()
      }
    }
    run()

    return new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' }
    })
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Generate Dashboard ────────────────────────
app.post('/api/generate-dashboard', async (c) => {
  try {
    const { prompt } = await c.req.json()
    if (!prompt) return c.json({ error: 'No prompt' }, 400)

    const contextChunks = await retrieveContext(prompt, 14)
    const contextSource = vectorStore.length > 0 ? currentDocName : 'built-in knowledge base'
    const contextBlock = contextChunks.length > 0
      ? `\n\nData source: ${contextSource}\n---\n${contextChunks.join('\n---\n')}`
      : ''

    const systemPrompt = `You are Derek AI, an expert investment intelligence dashboard generator.
Generate a complete, interactive HTML dashboard section.

ABSOLUTE REQUIREMENTS:
1. Output ONLY raw HTML — no markdown, no backtick fences, no explanations outside HTML tags
2. Use Chart.js (var Chart = already globally available) with unique IDs prefixed "dyn_"
3. CSS variables available: --bg:#f0f4f8; --white:#fff; --navy:#0c2340; --border:#e2e8f0; --cyan:#06b6d4; --cdark:#0e7490; --green:#10b981; --amber:#f59e0b; --red:#ef4444; --blue:#3b82f6; --purple:#8b5cf6;
4. Card style: background:white; border-radius:16px; border:1px solid #e2e8f0; padding:20px; box-shadow:0 2px 10px rgba(0,0,0,.06);
5. Font: Inter (loaded). Numbers: font-family:'JetBrains Mono',monospace
6. Required sections: gradient header card, KPI metrics grid (3-4 cards), at least 1 Chart.js chart, data table
7. Extract REAL data from context — no fake numbers
8. All Chart.js code in <script> wrapped in setTimeout(()=>{...},150)
9. KPI card style: background:linear-gradient(135deg,#0c2340,#0e4a6e); color:white; padding:16px; border-radius:12px;
10. Status badges: green=positive, amber=caution, red=risk

The output will be directly injected into a div — make it a complete, self-contained dashboard.`

    const userMsg = `Create a professional investment dashboard for: "${prompt}"${contextBlock}`

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const enc = new TextEncoder()

    const run = async () => {
      try {
        const stream = await llm.chat.completions.create({
          model: MODEL,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }],
          stream: true, max_tokens: 4096
        })
        for await (const chunk of stream) {
          const t = chunk.choices[0]?.delta?.content || ''
          if (t) await writer.write(enc.encode(`data: ${JSON.stringify({ text: t })}\n\n`))
        }
        await writer.write(enc.encode('data: [DONE]\n\n'))
      } catch (err) {
        console.error('[generate]', err.message)
        // Fallback: generate static dashboard from KB
        const fallbackHtml = generateFallbackDashboard(prompt, contextChunks)
        await writer.write(enc.encode(`data: ${JSON.stringify({ text: fallbackHtml })}\n\n`))
        await writer.write(enc.encode('data: [DONE]\n\n'))
      } finally {
        await writer.close()
      }
    }
    run()

    return new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' }
    })
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Status ─────────────────────────────────────
app.get('/api/status', (c) => {
  return c.json({
    model: MODEL, baseURL,
    docLoaded: currentDocName || null,
    chunks: vectorStore.length,
    kbChunks: BUILTIN_KB.length,
    searchMode: embeddingAvailable ? 'vector' : 'bm25',
    apiKeyPrefix: apiKey.slice(0, 8) + '...'
  })
})

// ── Serve HTML ─────────────────────────────────
app.get('/', (c) => c.html(MAIN_HTML))

// ─────────────────────────────────────────────
// Fallback Functions (when API key fails)
// ─────────────────────────────────────────────
function getFallbackReply(message, contextChunks) {
  const q = message.toLowerCase()
  // Find the most relevant context chunks
  const relevant = contextChunks.slice(0, 4).join(' ')
  if (relevant.length > 100) {
    return `<h4>📊 Based on available data:</h4><p>${contextChunks[0] || ''}</p>${contextChunks[1] ? '<p>' + contextChunks[1] + '</p>' : ''}<p style="color:#9ca3af;font-size:.72rem;margin-top:8px">⚠️ Live AI unavailable — showing knowledge base data. Please update your API key.</p>`
  }
  if (q.includes('financial') || q.includes('revenue') || q.includes('money')) {
    return '<h4>💰 Financial Summary</h4><ul><li>H1 2025 Revenue: <strong>$100,150</strong></li><li>H2 2025 TC Energy PO: <strong>$329,600</strong></li><li>FY2025 Estimate: <strong>~$430K</strong></li><li>ARR Run-rate: <strong>$600K+</strong></li><li>Net Operating Loss: <strong>-$23,146</strong></li></ul>'
  }
  if (q.includes('risk')) {
    return '<h4>⚠️ Key Risks</h4><ul><li><strong>HIGH</strong>: Customer concentration (TC Energy ~95%)</li><li><strong>HIGH</strong>: Founder key-person dependency</li><li><strong>MEDIUM</strong>: Services-heavy revenue model</li><li><strong>MEDIUM</strong>: Long sales cycles (3-6 months)</li></ul>'
  }
  return '<p>I can answer questions about Shoreless Inc. — try asking about financials, risks, deal terms, or the investment thesis.</p><p style="color:#9ca3af;font-size:.72rem">⚠️ Live AI is currently unavailable. Please update your API key to enable full AI responses.</p>'
}

function generateFallbackDashboard(prompt, contextChunks) {
  const p = prompt.toLowerCase()
  // Generate a static but data-rich dashboard based on KB
  return `<div style="font-family:'Inter',sans-serif;">
<div style="background:linear-gradient(135deg,#0c2340,#0e4a6e);color:white;padding:20px;border-radius:12px;margin-bottom:16px;">
  <div style="font-size:.7rem;font-weight:700;letter-spacing:.08em;opacity:.7;margin-bottom:6px;text-transform:uppercase">DEREK AI DASHBOARD</div>
  <div style="font-size:1.1rem;font-weight:800;margin-bottom:4px">Shoreless, Inc. — ${prompt}</div>
  <div style="font-size:.75rem;opacity:.7">Series Seed · Houston, TX · FY2025</div>
</div>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px;">
  <div style="background:linear-gradient(135deg,#0c2340,#0e4a6e);color:white;padding:16px;border-radius:12px;">
    <div style="font-size:.65rem;opacity:.7;margin-bottom:4px;text-transform:uppercase">H1 2025 Revenue</div>
    <div style="font-size:1.4rem;font-weight:800;font-family:'JetBrains Mono',monospace">$100K</div>
    <div style="font-size:.68rem;color:#67e8f9;margin-top:2px">Services delivery</div>
  </div>
  <div style="background:linear-gradient(135deg,#065f46,#10b981);color:white;padding:16px;border-radius:12px;">
    <div style="font-size:.65rem;opacity:.7;margin-bottom:4px;text-transform:uppercase">TC Energy PO</div>
    <div style="font-size:1.4rem;font-weight:800;font-family:'JetBrains Mono',monospace">$329.6K</div>
    <div style="font-size:.68rem;color:#a7f3d0;margin-top:2px">H2 2025 · Signed</div>
  </div>
  <div style="background:linear-gradient(135deg,#7c3aed,#8b5cf6);color:white;padding:16px;border-radius:12px;">
    <div style="font-size:.65rem;opacity:.7;margin-bottom:4px;text-transform:uppercase">ARR Run-Rate</div>
    <div style="font-size:1.4rem;font-weight:800;font-family:'JetBrains Mono',monospace">$600K+</div>
    <div style="font-size:.68rem;color:#c4b5fd;margin-top:2px">FY2025 estimate</div>
  </div>
  <div style="background:linear-gradient(135deg,#0e4a6e,#0e7490);color:white;padding:16px;border-radius:12px;">
    <div style="font-size:.65rem;opacity:.7;margin-bottom:4px;text-transform:uppercase">Valuation Cap</div>
    <div style="font-size:1.4rem;font-weight:800;font-family:'JetBrains Mono',monospace">$10M</div>
    <div style="font-size:.68rem;color:#67e8f9;margin-top:2px">20% discount</div>
  </div>
</div>
<div style="background:white;border:1px solid #e2e8f0;border-radius:16px;padding:18px;margin-bottom:12px;">
  <div style="font-size:.82rem;font-weight:700;color:#0c2340;margin-bottom:12px;">📈 Revenue Trajectory</div>
  <canvas id="dyn_rev_${Date.now()}" height="180"></canvas>
  <script>
  setTimeout(() => {
    const id = document.querySelector('[id^="dyn_rev_"]').id;
    const ctx = document.getElementById(id);
    if (ctx && window.Chart) {
      new Chart(ctx, {
        type: 'bar',
        data: {
          labels: ['H1 2025','H2 2025','FY2025E','FY2026E','FY2027E'],
          datasets: [{
            label: 'Revenue ($K)',
            data: [100, 329.6, 430, 1000, 2000],
            backgroundColor: ['#06b6d4','#10b981','#8b5cf6','#3b82f6','#f59e0b'],
            borderRadius: 8
          }]
        },
        options: {
          responsive: true,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => '$' + ctx.parsed.y + 'K' } } },
          scales: { y: { ticks: { callback: v => '$'+v+'K' }, grid: { color: '#f1f5f9' } }, x: { grid: { display: false } } }
        }
      });
    }
  }, 150);
  </script>
</div>
<div style="background:white;border:1px solid #e2e8f0;border-radius:16px;padding:18px;">
  <div style="font-size:.82rem;font-weight:700;color:#0c2340;margin-bottom:12px;">📋 Key Data Points</div>
  <table style="width:100%;border-collapse:collapse;font-size:.76rem;">
    <tr style="background:#f8fafc;"><th style="padding:8px 10px;text-align:left;color:#0e7490;font-weight:600;border-bottom:2px solid #e2e8f0;">Metric</th><th style="padding:8px 10px;text-align:right;color:#0e7490;font-weight:600;border-bottom:2px solid #e2e8f0;">Value</th><th style="padding:8px 10px;text-align:center;color:#0e7490;font-weight:600;border-bottom:2px solid #e2e8f0;">Status</th></tr>
    <tr><td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;">Cash (Jun 2025)</td><td style="padding:8px 10px;text-align:right;font-family:'JetBrains Mono',monospace;font-weight:600">$259,650</td><td style="padding:8px 10px;text-align:center"><span style="background:#d1fae5;color:#059669;padding:2px 8px;border-radius:999px;font-size:.65rem;font-weight:700">Good</span></td></tr>
    <tr><td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;">TC Energy PO</td><td style="padding:8px 10px;text-align:right;font-family:'JetBrains Mono',monospace;font-weight:600">$329,600</td><td style="padding:8px 10px;text-align:center"><span style="background:#d1fae5;color:#059669;padding:2px 8px;border-radius:999px;font-size:.65rem;font-weight:700">Signed</span></td></tr>
    <tr><td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;">Convertible Notes</td><td style="padding:8px 10px;text-align:right;font-family:'JetBrains Mono',monospace;font-weight:600">$350,000</td><td style="padding:8px 10px;text-align:center"><span style="background:#fef3c7;color:#b45309;padding:2px 8px;border-radius:999px;font-size:.65rem;font-weight:700">Converting</span></td></tr>
    <tr><td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;">Net Loss (H1 2025)</td><td style="padding:8px 10px;text-align:right;font-family:'JetBrains Mono',monospace;font-weight:600">-$23,146</td><td style="padding:8px 10px;text-align:center"><span style="background:#fee2e2;color:#dc2626;padding:2px 8px;border-radius:999px;font-size:.65rem;font-weight:700">Pre-revenue</span></td></tr>
    <tr><td style="padding:8px 10px;">Investment Ask</td><td style="padding:8px 10px;text-align:right;font-family:'JetBrains Mono',monospace;font-weight:600">$250,000</td><td style="padding:8px 10px;text-align:center"><span style="background:#ede9fe;color:#6d28d9;padding:2px 8px;border-radius:999px;font-size:.65rem;font-weight:700">Seed</span></td></tr>
  </table>
</div>
<div style="margin-top:10px;padding:10px 14px;background:#fef3c7;border:1px solid #fde68a;border-radius:8px;font-size:.72rem;color:#92400e;">
  <i class="fas fa-exclamation-triangle"></i> Static dashboard — AI API unavailable. <a href="#" onclick="document.getElementById('apiModal').style.display='flex';return false;" style="color:#0e7490;font-weight:600">Update API key</a> to enable live AI generation.
</div>
</div>`
}


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
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
:root{--bg:#f0f4f8;--bg2:#e8edf2;--white:#fff;--navy:#0c2340;--border:#e2e8f0;--border2:#f1f5f9;--ts:#4b5563;--tt:#9ca3af;--cyan:#06b6d4;--cdark:#0e7490;--green:#10b981;--gl:#d1fae5;--amber:#f59e0b;--al:#fef3c7;--red:#ef4444;--rl:#fee2e2;--blue:#3b82f6;--bl:#dbeafe;--purple:#8b5cf6;--pl:#ede9fe;--r-sm:6px;--r-md:8px;--r-lg:12px;--r-xl:16px;--r-full:999px;--t:.15s ease;}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;overflow:hidden;font-family:'Inter',sans-serif;background:var(--bg);}
.topbar{background:var(--white);border-bottom:1px solid var(--border);height:56px;display:flex;align-items:center;padding:0 20px;gap:10px;flex-shrink:0;z-index:100;}
.tb-logo{width:34px;height:34px;background:linear-gradient(135deg,#0e7490,#06b6d4);border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.tb-logo i{font-size:14px;color:#fff;}
.tb-title{font-size:0.96rem;font-weight:800;color:var(--navy);letter-spacing:-.02em;}
.tb-dot{width:7px;height:7px;background:#10b981;border-radius:50%;}
.tb-tag{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:var(--r-full);font-size:.68rem;font-weight:700;}
.tg-teal{background:rgba(6,182,212,.1);color:#0e7490;}
.tg-amber{background:rgba(245,158,11,.1);color:#b45309;}
.tb-sp{flex:1;}
.tb-model{display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:var(--r-md);border:1px solid rgba(6,182,212,.25);background:rgba(6,182,212,.06);font-size:.72rem;font-weight:600;color:#0e7490;cursor:pointer;}
.tb-model .dot{width:6px;height:6px;background:#10b981;border-radius:50%;animation:pulse 2s infinite;}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.4;}}
.tb-key-btn{padding:4px 12px;border-radius:var(--r-md);border:1px solid rgba(245,158,11,.4);background:rgba(245,158,11,.08);font-size:.7rem;font-weight:600;color:#b45309;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;}
.tb-key-btn:hover{background:rgba(245,158,11,.15);}
.tb-user{width:32px;height:32px;background:linear-gradient(135deg,#0c2340,#0e4a6e);border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;}
.page{display:flex;flex-direction:column;height:100vh;overflow:hidden;}
.body{display:flex;flex:1;min-height:0;overflow:hidden;}
.left{flex:1;min-width:0;overflow-y:auto;padding:20px;background:var(--bg);display:flex;flex-direction:column;gap:16px;}
.left::-webkit-scrollbar{width:4px;}
.left::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px;}
.upload-zone{background:var(--white);border:2px dashed var(--border);border-radius:var(--r-xl);padding:28px 20px;text-align:center;cursor:pointer;transition:all var(--t);position:relative;}
.upload-zone:hover,.upload-zone.drag{border-color:#06b6d4;background:rgba(6,182,212,.03);}
.upload-zone.has-file{border-style:solid;border-color:rgba(16,185,129,.4);background:rgba(16,185,129,.03);}
.upload-icon{width:52px;height:52px;background:linear-gradient(135deg,#0e7490,#06b6d4);border-radius:16px;display:flex;align-items:center;justify-content:center;margin:0 auto 14px;box-shadow:0 4px 16px rgba(6,182,212,.3);}
.upload-icon i{font-size:22px;color:#fff;}
.upload-title{font-size:.96rem;font-weight:700;color:var(--navy);margin-bottom:6px;}
.upload-sub{font-size:.76rem;color:var(--tt);line-height:1.7;}
.upload-types{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:12px;}
.upload-type{font-size:.65rem;font-weight:600;padding:3px 9px;border-radius:var(--r-full);background:var(--bg2);color:var(--ts);border:1px solid var(--border);}
.upload-input{position:absolute;inset:0;opacity:0;cursor:pointer;}
.file-loaded{display:flex;align-items:center;gap:10px;padding:12px 16px;background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.3);border-radius:var(--r-lg);}
.file-loaded-icon{width:36px;height:36px;background:rgba(16,185,129,.12);border-radius:var(--r-md);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.file-loaded-icon i{font-size:15px;color:#059669;}
.file-loaded-info{flex:1;min-width:0;}
.file-loaded-name{font-size:.82rem;font-weight:700;color:var(--navy);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.file-loaded-meta{font-size:.69rem;color:var(--tt);margin-top:2px;}
/* File list (batch mode) */
.file-list{display:flex;flex-direction:column;gap:5px;max-height:160px;overflow-y:auto;padding:2px;}
.file-item{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--white);border:1px solid var(--border);border-radius:var(--r-md);transition:all var(--t);}
.file-item.ok{border-color:rgba(16,185,129,.3);background:rgba(16,185,129,.03);}
.file-item.err{border-color:rgba(239,68,68,.3);background:rgba(239,68,68,.03);}
.file-item.processing{border-color:rgba(6,182,212,.4);background:rgba(6,182,212,.04);animation:pulse-border .8s infinite;}
@keyframes pulse-border{0%,100%{border-color:rgba(6,182,212,.4)}50%{border-color:rgba(6,182,212,.9)}}
.file-item-icon{font-size:14px;flex-shrink:0;}
.file-item-name{flex:1;font-size:.78rem;font-weight:600;color:var(--navy);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.file-item-meta{font-size:.68rem;color:var(--tt);flex-shrink:0;}
.file-item-status{width:16px;height:16px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:10px;}
.file-item-status.ok{background:rgba(16,185,129,.15);color:#059669;}
.file-item-status.err{background:rgba(239,68,68,.15);color:#dc2626;}
.file-item-status.pending{background:rgba(107,114,128,.1);color:#6b7280;}
.file-item-status.spin{background:rgba(6,182,212,.1);color:#0e7490;animation:spin .7s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}
.file-remove{cursor:pointer;color:var(--tt);font-size:13px;padding:4px;border-radius:4px;transition:color var(--t);}
.file-remove:hover{color:var(--red);}
.vec-progress{background:var(--white);border:1px solid var(--border);border-radius:var(--r-xl);padding:18px;display:none;}
.vec-progress.show{display:block;}
.vec-title{font-size:.82rem;font-weight:700;color:var(--navy);margin-bottom:12px;display:flex;align-items:center;gap:8px;}
.vec-bar-track{height:8px;background:var(--bg2);border-radius:var(--r-full);overflow:hidden;margin-bottom:10px;}
.vec-bar-fill{height:100%;background:linear-gradient(90deg,#0e7490,#06b6d4,#10b981);border-radius:var(--r-full);transition:width .4s ease;width:0%;}
.vec-status{font-size:.73rem;color:var(--tt);line-height:1.6;}
.vec-chunks{display:flex;gap:5px;flex-wrap:wrap;margin-top:10px;}
.vec-chunk{font-size:.62rem;padding:2px 8px;border-radius:var(--r-full);background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.2);color:#0e7490;font-family:'JetBrains Mono',monospace;}
.gen-box{background:var(--white);border:1px solid var(--border);border-radius:var(--r-xl);padding:20px;}
.gen-box-title{font-size:.84rem;font-weight:700;color:var(--navy);margin-bottom:14px;display:flex;align-items:center;gap:8px;}
.gen-presets{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:14px;}
.gen-preset{display:flex;align-items:center;gap:5px;padding:5px 12px;border-radius:var(--r-full);border:1px solid var(--border);background:var(--bg);font-size:.72rem;font-weight:600;color:var(--ts);cursor:pointer;transition:all var(--t);}
.gen-preset:hover,.gen-preset.active{border-color:#06b6d4;color:#0e7490;background:rgba(6,182,212,.08);}
.gen-input-row{display:flex;gap:8px;align-items:flex-end;}
.gen-textarea{flex:1;resize:none;border:1px solid var(--border);border-radius:var(--r-lg);padding:10px 13px;font-size:.8rem;font-family:'Inter',sans-serif;color:var(--navy);outline:none;background:var(--bg);min-height:76px;line-height:1.6;}
.gen-textarea:focus{border-color:#06b6d4;background:var(--white);box-shadow:0 0 0 3px rgba(6,182,212,.1);}
.gen-textarea::placeholder{color:var(--tt);}
.gen-btn{padding:11px 20px;border-radius:var(--r-lg);border:none;background:linear-gradient(135deg,#0e7490,#06b6d4);color:#fff;font-size:.8rem;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;transition:all var(--t);display:flex;align-items:center;gap:7px;flex-shrink:0;align-self:flex-end;}
.gen-btn:hover{opacity:.88;transform:translateY(-1px);}
.gen-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;}
.dash-area{background:var(--white);border:1px solid var(--border);border-radius:var(--r-xl);min-height:200px;overflow:hidden;}
.dash-area-header{padding:14px 18px;border-bottom:1px solid var(--border2);display:flex;align-items:center;gap:10px;}
.dash-area-icon{width:28px;height:28px;background:linear-gradient(135deg,#0e7490,#06b6d4);border-radius:8px;display:flex;align-items:center;justify-content:center;}
.dash-area-icon i{font-size:12px;color:#fff;}
.dash-area-title{font-size:.85rem;font-weight:700;color:var(--navy);flex:1;}
.dash-area-tag{font-size:.65rem;font-weight:700;padding:2px 9px;border-radius:var(--r-full);}
.dash-area-tag.live{background:rgba(16,185,129,.1);color:#059669;}
.dash-area-tag.streaming{background:rgba(245,158,11,.1);color:#b45309;}
.dash-content{padding:18px;overflow:auto;max-height:600px;}
.stream-cursor::after{content:'▋';animation:blink .7s steps(1) infinite;color:#06b6d4;}
@keyframes blink{0%,100%{opacity:1;}50%{opacity:0;}}
.empty-state{text-align:center;padding:48px 24px;color:var(--tt);}
.empty-state-icon{width:56px;height:56px;background:var(--bg2);border-radius:16px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:24px;}
.empty-state h3{font-size:.9rem;font-weight:600;color:var(--ts);margin-bottom:7px;}
.empty-state p{font-size:.77rem;line-height:1.7;}
.right{flex:0 0 380px;display:flex;flex-direction:column;border-left:1px solid var(--border);background:var(--white);overflow:hidden;}
.ai-header{padding:14px 16px;border-bottom:1px solid var(--border2);display:flex;align-items:center;gap:10px;flex-shrink:0;}
.ai-av{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#0c4a56,#06b6d4);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 2px 8px rgba(6,182,212,.3);}
.ai-av i{font-size:15px;color:#fff;}
.ai-title{font-size:.9rem;font-weight:700;color:var(--navy);}
.ai-sub{font-size:.64rem;color:var(--tt);margin-top:1px;}
.ai-ctx{margin-left:auto;display:flex;align-items:center;gap:5px;background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.25);border-radius:var(--r-full);padding:3px 10px;font-size:.66rem;font-weight:600;color:#0e7490;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.chip-strip{padding:8px 12px;border-bottom:1px solid var(--border2);display:flex;gap:5px;overflow-x:auto;flex-shrink:0;background:var(--bg);}
.chip-strip::-webkit-scrollbar{height:0;}
.ai-chip{display:flex;align-items:center;gap:5px;flex-shrink:0;padding:4px 10px;border-radius:var(--r-full);border:1px solid var(--border);font-size:.67rem;font-weight:600;color:var(--tt);cursor:pointer;transition:all var(--t);background:var(--white);white-space:nowrap;font-family:'Inter',sans-serif;}
.ai-chip:hover{border-color:#06b6d4;color:#0e7490;background:rgba(6,182,212,.05);}
.ai-chip.active{background:#06b6d4;color:#fff;border-color:#06b6d4;}
.cd{width:6px;height:6px;border-radius:50%;flex-shrink:0;}
.ai-msgs{flex:1;overflow-y:auto;padding:14px 14px 8px;display:flex;flex-direction:column;gap:12px;}
.ai-msgs::-webkit-scrollbar{width:4px;}
.ai-msgs::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px;}
.ai-idle{display:flex;flex-direction:column;align-items:center;padding:20px 16px;gap:10px;}
.ai-idle-icon{width:52px;height:52px;border-radius:16px;background:linear-gradient(135deg,#0c4a56,#06b6d4);display:flex;align-items:center;justify-content:center;font-size:22px;color:#fff;box-shadow:0 4px 16px rgba(6,182,212,.35);}
.ai-idle h3{font-size:.94rem;font-weight:700;color:var(--navy);}
.ai-idle p{font-size:.75rem;color:var(--tt);line-height:1.7;text-align:center;}
.tip-list{display:flex;flex-direction:column;gap:6px;width:100%;margin-top:4px;}
.tip-item{display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--bg);border:1px solid var(--border2);border-radius:var(--r-lg);cursor:pointer;transition:all var(--t);}
.tip-item:hover{border-color:#06b6d4;background:rgba(6,182,212,.04);}
.tip-em{font-size:14px;flex-shrink:0;}
.tip-txt{font-size:.74rem;color:var(--ts);font-weight:500;line-height:1.45;}
.ai-msg{display:flex;gap:8px;}
.ai-msg.user{flex-direction:row-reverse;}
.msg-av{width:28px;height:28px;border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;}
.msg-av.bot{background:linear-gradient(135deg,#0c4a56,#06b6d4);color:#fff;}
.msg-av.usr{background:var(--navy);color:#fff;}
.msg-bubble{max-width:85%;padding:10px 13px;border-radius:12px;font-size:.77rem;line-height:1.7;color:var(--navy);}
.ai-msg.user .msg-bubble{background:linear-gradient(135deg,#0c4a56,#0e7490);color:#fff;border-radius:12px 2px 12px 12px;}
.ai-msg.bot .msg-bubble{background:var(--bg);border:1px solid var(--border2);border-radius:2px 12px 12px 12px;}
.msg-bubble h4{font-size:.75rem;font-weight:700;color:var(--navy);margin:0 0 5px;}
.ai-msg.user .msg-bubble h4{color:#e0f7fa;}
.msg-bubble ul{margin:5px 0;padding-left:16px;}
.msg-bubble li{margin-bottom:4px;}
.msg-bubble strong{color:#0e7490;}
.ai-msg.user .msg-bubble strong{color:#67e8f9;}
.msg-bubble p{margin-bottom:6px;}
.msg-bubble p:last-child{margin-bottom:0;}
.typing-dots{display:flex;gap:4px;padding:10px 12px;background:var(--bg);border:1px solid var(--border2);border-radius:2px 12px 12px 12px;width:fit-content;}
.typing-dots span{width:6px;height:6px;background:#9ca3af;border-radius:50%;animation:bounce 1.2s infinite;}
.typing-dots span:nth-child(2){animation-delay:.2s;}
.typing-dots span:nth-child(3){animation-delay:.4s;}
@keyframes bounce{0%,60%,100%{transform:translateY(0);}30%{transform:translateY(-5px);}}
.ai-input{padding:12px;border-top:1px solid var(--border2);flex-shrink:0;}
.ai-input-row{display:flex;gap:8px;align-items:flex-end;}
.ai-ta{flex:1;resize:none;border:1px solid var(--border);border-radius:var(--r-lg);padding:9px 12px;font-size:.77rem;font-family:'Inter',sans-serif;color:var(--navy);outline:none;background:var(--bg);min-height:64px;max-height:120px;line-height:1.5;}
.ai-ta:focus{border-color:#06b6d4;background:var(--white);box-shadow:0 0 0 3px rgba(6,182,212,.1);}
.ai-ta::placeholder{color:var(--tt);}
.send-btn{width:36px;height:36px;border-radius:var(--r-md);border:none;background:linear-gradient(135deg,#0e7490,#06b6d4);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all var(--t);}
.send-btn:hover{opacity:.85;transform:translateY(-1px);}
.send-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;}
.ai-hint{font-size:.64rem;color:var(--tt);margin-top:5px;text-align:center;}
.rag-badge{display:inline-flex;align-items:center;gap:4px;font-size:.63rem;font-weight:600;padding:2px 9px;border-radius:var(--r-full);background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.2);color:#0e7490;margin-top:6px;}
/* API KEY MODAL */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:none;align-items:center;justify-content:center;z-index:9999;}
.modal-overlay.show{display:flex;}
.modal{background:white;border-radius:20px;padding:28px;width:440px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,.3);}
.modal h3{font-size:1rem;font-weight:800;color:var(--navy);margin-bottom:6px;}
.modal p{font-size:.78rem;color:var(--tt);margin-bottom:16px;line-height:1.6;}
.modal input{width:100%;border:1px solid var(--border);border-radius:var(--r-lg);padding:10px 13px;font-size:.82rem;font-family:'Inter',sans-serif;color:var(--navy);outline:none;margin-bottom:12px;}
.modal input:focus{border-color:#06b6d4;box-shadow:0 0 0 3px rgba(6,182,212,.1);}
.modal-btns{display:flex;gap:8px;justify-content:flex-end;}
.modal-btn{padding:8px 18px;border-radius:var(--r-md);border:none;font-size:.8rem;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;}
.modal-btn.primary{background:linear-gradient(135deg,#0e7490,#06b6d4);color:white;}
.modal-btn.secondary{background:var(--bg2);color:var(--ts);}
</style>
</head>
<body>
<div class="page">
<!-- TOPBAR -->
<div class="topbar">
  <div class="tb-logo"><i class="fas fa-brain"></i></div>
  <div class="tb-title">Derek</div>
  <div class="tb-dot"></div>
  <div class="tb-tag tg-teal"><i class="fas fa-circle" style="font-size:6px"></i> AI Intelligence</div>
  <div class="tb-tag tg-amber"><i class="fas fa-bolt" style="font-size:8px"></i> Dynamic Dashboard</div>
  <div class="tb-sp"></div>
  <div class="tb-model" onclick="showApiModal()" title="Click to update API key">
    <span class="dot"></span>
    <span id="modelLabel">gpt-5 · RAG</span>
  </div>
  <button class="tb-key-btn" onclick="showApiModal()"><i class="fas fa-key" style="font-size:10px"></i> API Key</button>
  <div class="tb-user">D</div>
</div>
<div class="body">
<!-- LEFT PANEL -->
<div class="left" id="leftPanel">
  <div class="upload-zone" id="uploadZone"
    ondragover="event.preventDefault();this.classList.add('drag')"
    ondragleave="this.classList.remove('drag')"
    ondrop="handleDrop(event)">
    <input type="file" class="upload-input" id="fileInput"
      accept=".html,.htm,.txt,.md,.csv,.json,.pdf,.doc,.docx,.jpg,.jpeg,.png,.gif,.webp,.bmp"
      multiple
      onchange="handleFileChange(event)"/>
    <div class="upload-icon"><i class="fas fa-cloud-upload-alt"></i></div>
    <div class="upload-title">Upload Documents <span style="font-size:.75rem;font-weight:500;color:#06b6d4;background:rgba(6,182,212,.1);padding:2px 8px;border-radius:20px;margin-left:6px">Batch</span></div>
    <div class="upload-sub">Drag & drop one or multiple files, or click to select.<br>Supports PDF, DOCX, images, HTML, TXT, CSV, JSON — all auto-processed.</div>
    <div class="upload-types">
      <span class="upload-type">.pdf</span>
      <span class="upload-type">.docx</span>
      <span class="upload-type">.html</span>
      <span class="upload-type">.txt</span>
      <span class="upload-type">.md</span>
      <span class="upload-type">.csv</span>
      <span class="upload-type">.json</span>
      <span class="upload-type">.jpg / .png</span>
    </div>
  </div>
  <div class="file-loaded" id="fileLoaded" style="display:none">
    <div class="file-loaded-icon" id="fileLoadedIcon"><i class="fas fa-file-check"></i></div>
    <div class="file-loaded-info">
      <div class="file-loaded-name" id="loadedName">—</div>
      <div class="file-loaded-meta" id="loadedMeta">—</div>
    </div>
    <span class="file-remove" onclick="clearDoc()" title="Remove"><i class="fas fa-times-circle"></i></span>
  </div>
  <div class="file-list" id="fileList" style="display:none"></div>
  <div class="vec-progress" id="vecProgress">
    <div class="vec-title"><i class="fas fa-microchip" style="color:#06b6d4"></i><span id="vecTitle">Processing…</span></div>
    <div class="vec-bar-track"><div class="vec-bar-fill" id="vecBar"></div></div>
    <div class="vec-status" id="vecStatus">Extracting and indexing content…</div>
    <div class="vec-chunks" id="vecChunks"></div>
  </div>
  <div class="gen-box">
    <div class="gen-box-title"><i class="fas fa-wand-magic-sparkles" style="color:#06b6d4;font-size:13px"></i>Generate Dynamic Dashboard with AI</div>
    <div class="gen-presets" id="genPresets">
      <span class="gen-preset" onclick="usePreset(this)"><span>📊</span> Financial Overview</span>
      <span class="gen-preset" onclick="usePreset(this)"><span>🏆</span> Revenue & Customers</span>
      <span class="gen-preset" onclick="usePreset(this)"><span>⚠️</span> Risk Assessment</span>
      <span class="gen-preset" onclick="usePreset(this)"><span>📈</span> Revenue Projections</span>
      <span class="gen-preset" onclick="usePreset(this)"><span>🚪</span> Exit Scenarios & MOIC</span>
      <span class="gen-preset" onclick="usePreset(this)"><span>💼</span> Investment Thesis</span>
      <span class="gen-preset" onclick="usePreset(this)"><span>📋</span> Cap Table & Terms</span>
      <span class="gen-preset" onclick="usePreset(this)"><span>👥</span> Team & Founder</span>
    </div>
    <div class="gen-input-row">
      <textarea class="gen-textarea" id="genInput"
        placeholder="Describe the dashboard you want… e.g. 'Generate a financial KPI dashboard with revenue charts'"
        onkeydown="if(event.key==='Enter'&&event.ctrlKey){generateDash()}"
        rows="3"></textarea>
      <button class="gen-btn" id="genBtn" onclick="generateDash()">
        <i class="fas fa-wand-magic-sparkles"></i> Generate
      </button>
    </div>
    <div style="font-size:.65rem;color:var(--tt);margin-top:6px;"><kbd style="background:var(--bg2);padding:1px 5px;border-radius:3px;font-size:.62rem">Ctrl+Enter</kbd> to generate</div>
  </div>
  <div class="dash-area" id="dashArea">
    <div class="dash-area-header">
      <div class="dash-area-icon"><i class="fas fa-chart-line"></i></div>
      <div class="dash-area-title" id="dashAreaTitle">AI-Generated Dashboard</div>
      <div class="dash-area-tag" id="dashAreaTag" style="display:none">Live</div>
    </div>
    <div class="dash-content" id="dashContent">
      <div class="empty-state">
        <div class="empty-state-icon"><i class="fas fa-chart-bar" style="color:var(--border)"></i></div>
        <h3>No Dashboard Yet</h3>
        <p>Select a preset or enter a prompt above, then click <strong>Generate</strong>.<br>Works with uploaded documents or the built-in Shoreless knowledge base.</p>
      </div>
    </div>
  </div>
</div>
<!-- RIGHT: AI CHAT -->
<div class="right">
  <div class="ai-header">
    <div class="ai-av"><i class="fas fa-robot"></i></div>
    <div><div class="ai-title">Derek AI</div><div class="ai-sub" id="aiSubLabel">gpt-5 · Vector RAG</div></div>
    <div class="ai-ctx" id="aiCtx" title="Loaded document">
      <i class="fas fa-circle" style="font-size:6px;color:#06b6d4"></i>
      <span id="aiCtxText">KB Ready</span>
    </div>
  </div>
  <div class="chip-strip">
    <button class="ai-chip" onclick="chipAsk('Give me a comprehensive overview of Shoreless Inc.',this)"><span class="cd" style="background:#06b6d4"></span>Overview</button>
    <button class="ai-chip" onclick="chipAsk('What are the key financial metrics and revenue projections?',this)"><span class="cd" style="background:#f59e0b"></span>Financials</button>
    <button class="ai-chip" onclick="chipAsk('What are the main investment risks?',this)"><span class="cd" style="background:#ef4444"></span>Risks</button>
    <button class="ai-chip" onclick="chipAsk('Summarize the deal terms and investment structure',this)"><span class="cd" style="background:#8b5cf6"></span>Deal Terms</button>
    <button class="ai-chip" onclick="chipAsk('What are the exit scenarios and MOIC projections?',this)"><span class="cd" style="background:#3b82f6"></span>Exit</button>
    <button class="ai-chip" onclick="chipAsk('Tell me about Kenneth Myers and the founding team',this)"><span class="cd" style="background:#10b981"></span>Team</button>
  </div>
  <div class="ai-msgs" id="aiMsgs">
    <div class="ai-idle" id="aiIdle">
      <div class="ai-idle-icon"><i class="fas fa-robot"></i></div>
      <h3>Derek AI · RAG Intelligence</h3>
      <p>Built-in Shoreless Inc. knowledge base is active. Upload a document (PDF, DOCX, images, HTML, TXT…) for additional context.</p>
      <div class="tip-list">
        <div class="tip-item" onclick="useTip(this)"><span class="tip-em">📊</span><span class="tip-txt">Generate a financial dashboard with revenue charts</span></div>
        <div class="tip-item" onclick="useTip(this)"><span class="tip-em">🔍</span><span class="tip-txt">What are the key investment risks?</span></div>
        <div class="tip-item" onclick="useTip(this)"><span class="tip-em">💰</span><span class="tip-txt">Summarize financial performance and projections</span></div>
        <div class="tip-item" onclick="useTip(this)"><span class="tip-em">🎯</span><span class="tip-txt">What is the investment thesis?</span></div>
        <div class="tip-item" onclick="useTip(this)"><span class="tip-em">🚀</span><span class="tip-txt">Who are the likely strategic acquirers and at what valuation?</span></div>
      </div>
    </div>
  </div>
  <div class="ai-input">
    <div class="ai-input-row">
      <textarea class="ai-ta" id="aiInput"
        placeholder="Ask anything about the deal — AI will search through documents and knowledge base…"
        rows="3"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat();}"
        oninput="this.style.height='auto';this.style.height=Math.min(Math.max(this.scrollHeight,64),120)+'px'"></textarea>
      <button class="send-btn" id="sendBtn" onclick="sendChat()">
        <i class="fas fa-paper-plane" style="font-size:12px"></i>
      </button>
    </div>
    <div class="ai-hint"><i class="fas fa-database" style="font-size:9px"></i> RAG · Enter to send · Shift+Enter new line</div>
  </div>
</div>
</div>
</div>

<!-- API KEY MODAL -->
<div class="modal-overlay" id="apiModal">
  <div class="modal">
    <h3><i class="fas fa-key" style="color:#06b6d4;margin-right:8px"></i>Update API Key</h3>
    <p>Enter your Genspark API key to enable live AI responses and dynamic dashboard generation.</p>
    <input type="password" id="apiKeyInput" placeholder="Enter API key (e.g. gsk-xxx...)" />
    <div id="apiKeyStatus" style="font-size:.74rem;margin-bottom:10px;display:none"></div>
    <div class="modal-btns">
      <button class="modal-btn secondary" onclick="hideApiModal()">Cancel</button>
      <button class="modal-btn primary" id="saveKeyBtn" onclick="saveApiKey()"><i class="fas fa-check"></i> Save & Test</button>
    </div>
  </div>
</div>

<script>
// ══════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════
let docLoaded = false, docName = '', searchMode = 'bm25';

// Init: load status
fetch('/api/status').then(r=>r.json()).then(d=>{
  if(d.model) document.getElementById('modelLabel').textContent = d.model + ' · RAG';
  if(d.docLoaded){docLoaded=true;docName=d.docLoaded;document.getElementById('aiCtxText').textContent=d.docLoaded.slice(0,18)+(d.docLoaded.length>18?'…':'');}
  else{document.getElementById('aiCtxText').textContent='KB: '+d.kbChunks+' chunks';}
}).catch(()=>{});

// ══════════════════════════════════════════════
// API KEY MODAL
// ══════════════════════════════════════════════
function showApiModal(){document.getElementById('apiModal').classList.add('show');}
function hideApiModal(){document.getElementById('apiModal').classList.remove('show');}

async function saveApiKey(){
  const key = document.getElementById('apiKeyInput').value.trim();
  if(!key){alert('Please enter an API key');return;}
  const btn = document.getElementById('saveKeyBtn');
  const status = document.getElementById('apiKeyStatus');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing…';
  status.style.display='block'; status.style.color='#b45309'; status.textContent='Testing connection…';
  try{
    const res = await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
    const data = await res.json();
    if(data.ok){
      status.style.color='#059669'; status.textContent='✅ API key verified! Model: '+data.model;
      setTimeout(()=>hideApiModal(),1500);
    } else {
      status.style.color='#dc2626'; status.textContent='❌ Invalid key: '+(data.error||'Unknown error');
    }
  } catch(e){
    status.style.color='#dc2626'; status.textContent='❌ Error: '+e.message;
  } finally {
    btn.disabled=false; btn.innerHTML='<i class="fas fa-check"></i> Save & Test';
  }
}

// ══════════════════════════════════════════════
// FILE UPLOAD — BATCH + DRAG
// ══════════════════════════════════════════════
const ALLOWED_EXTS=['html','htm','txt','md','csv','json','pdf','doc','docx','jpg','jpeg','png','gif','webp','bmp'];

function getFileIcon(ext){
  if(ext==='pdf') return '📄';
  if(['doc','docx'].includes(ext)) return '📝';
  if(['jpg','jpeg','png','gif','webp','bmp'].includes(ext)) return '🖼️';
  if(['csv','json'].includes(ext)) return '📊';
  if(['html','htm'].includes(ext)) return '🌐';
  return '📄';
}
function fmtSize(bytes){return bytes<1024?bytes+'B':bytes<1048576?(bytes/1024).toFixed(1)+'KB':(bytes/1048576).toFixed(1)+'MB';}

function handleDrop(e){
  e.preventDefault();
  document.getElementById('uploadZone').classList.remove('drag');
  const files=Array.from(e.dataTransfer?.files||[]);
  if(files.length>0) processFiles(files);
}
function handleFileChange(e){
  const files=Array.from(e.target.files||[]);
  if(files.length>0) processFiles(files);
  e.target.value='';
}

async function processFiles(files){
  // Filter supported
  const valid=[],invalid=[];
  for(const f of files){
    const ext=f.name.split('.').pop()?.toLowerCase()||'';
    if(ALLOWED_EXTS.includes(ext)) valid.push(f);
    else invalid.push(f.name);
  }
  if(invalid.length>0) addMsg('bot',\`<p>⚠️ Skipped unsupported: <strong>\${invalid.join(', ')}</strong></p>\`);
  if(valid.length===0) return;

  // Single file → old-style progress; multi → queue list
  if(valid.length===1){
    await processSingleFile(valid[0]);
  } else {
    await processBatchFiles(valid);
  }
}

/* ── Single file mode ─────────────────────── */
async function processSingleFile(file){
  const ext=file.name.split('.').pop()?.toLowerCase()||'';
  const isImage=['jpg','jpeg','png','gif','webp','bmp'].includes(ext);
  const isPdf=ext==='pdf';
  const isDocx=['doc','docx'].includes(ext);

  const vp=document.getElementById('vecProgress');
  const bar=document.getElementById('vecBar');
  const status=document.getElementById('vecStatus');
  const title=document.getElementById('vecTitle');
  const chunksEl=document.getElementById('vecChunks');
  const fileList=document.getElementById('fileList');
  fileList.style.display='none';

  vp.classList.add('show'); bar.style.width='10%';
  title.textContent='Processing '+file.name+'…';
  status.textContent=isPdf?'Parsing PDF…':isDocx?'Extracting DOCX…':isImage?'Analyzing image…':'Uploading…';
  chunksEl.innerHTML='';

  const form=new FormData(); form.append('file',file);
  let prog=10;
  const pi=setInterval(()=>{prog=Math.min(prog+5,85);bar.style.width=prog+'%';
    if(prog<30)status.textContent=isPdf?'Parsing PDF pages…':isDocx?'Parsing DOCX…':isImage?'Vision AI analyzing…':'Uploading…';
    else if(prog<55)status.textContent='Extracting text & structure…';
    else if(prog<75)status.textContent='Chunking & indexing…';
    else status.textContent='Building search index…';
  },isPdf||isDocx||isImage?600:400);

  try{
    const res=await fetch('/api/upload',{method:'POST',body:form});
    const data=await res.json();
    clearInterval(pi);
    if(data.error)throw new Error(data.error);
    bar.style.width='100%'; searchMode=data.searchMode||'bm25';
    const modeLabel=searchMode==='vector'?'Vector Embeddings':'BM25 Keyword';
    title.textContent='✅ Ready: '+data.name;
    status.textContent=data.chunks+' chunks · '+(data.chars/1000).toFixed(1)+'K chars · '+modeLabel;
    renderChunkBadges(chunksEl,data.chunks,searchMode);
    updateLoadedState(data.name,data.chunks+' chunks · '+fmtSize(data.totalSize||data.size||0)+' · '+modeLabel,data.fileType);
    removeIdle();
    const ftIcon=getFileIcon(ext);
    const ftNote=data.fileType==='image'?'<li>🖼️ <strong>Image analyzed</strong> via Vision AI</li>':data.fileType==='pdf'?'<li>📄 <strong>PDF parsed</strong> — all pages extracted</li>':data.fileType==='docx'?'<li>📝 <strong>DOCX parsed</strong> — content extracted</li>':'';
    addMsg('bot',\`<h4>\${ftIcon} Ready: \${data.name}</h4><p>Processed <strong>\${data.chunks} chunks</strong> · \${modeLabel}.</p><ul>\${ftNote}<li>Ask questions in the chat panel</li><li>Generate dashboards with the left panel</li></ul>\`);
  }catch(err){
    clearInterval(pi); bar.style.width='0%'; vp.classList.remove('show');
    addMsg('bot','<p>❌ Failed: '+err.message+'</p>');
  }
}

/* ── Batch file mode ──────────────────────── */
async function processBatchFiles(files){
  const vp=document.getElementById('vecProgress');
  const bar=document.getElementById('vecBar');
  const status=document.getElementById('vecStatus');
  const title=document.getElementById('vecTitle');
  const chunksEl=document.getElementById('vecChunks');
  const fileList=document.getElementById('fileList');

  // Build queue UI
  fileList.style.display='flex'; fileList.innerHTML='';
  const itemEls=[];
  for(const f of files){
    const ext=f.name.split('.').pop()?.toLowerCase()||'';
    const el=document.createElement('div');
    el.className='file-item pending';
    el.innerHTML=\`<span class="file-item-icon">\${getFileIcon(ext)}</span>
      <span class="file-item-name">\${f.name}</span>
      <span class="file-item-meta">\${fmtSize(f.size)}</span>
      <span class="file-item-status pending" id="fstatus-\${f.name.replace(/[^a-z0-9]/gi,'_')}"><i class="fas fa-clock"></i></span>\`;
    fileList.appendChild(el);
    itemEls.push({el,f,id:f.name.replace(/[^a-z0-9]/gi,'_')});
  }

  vp.classList.add('show'); bar.style.width='5%';
  title.textContent=\`Uploading \${files.length} files…\`; chunksEl.innerHTML='';
  status.textContent='Preparing batch upload…';

  // Send all files at once
  const form=new FormData();
  for(const f of files) form.append('files[]',f);

  // Mark all as spinning
  for(const {el,id} of itemEls){
    el.className='file-item processing';
    const s=el.querySelector(\`#fstatus-\${id}\`);
    if(s){s.className='file-item-status spin';s.innerHTML='<i class="fas fa-sync-alt"></i>';}
  }

  let prog=5;
  const totalSize=files.reduce((s,f)=>s+f.size,0);
  const hasPdf=files.some(f=>f.name.toLowerCase().endsWith('.pdf'));
  const hasDocx=files.some(f=>/\\.docx?$/i.test(f.name));
  const pi=setInterval(()=>{
    prog=Math.min(prog+(hasPdf||hasDocx?3:6),85);
    bar.style.width=prog+'%';
    const done=Math.round((prog/85)*files.length);
    if(prog<40)status.textContent=\`Parsing files (\${done}/\${files.length})…\`;
    else if(prog<70)status.textContent='Extracting & chunking text…';
    else status.textContent='Building search index…';
  },500);

  try{
    const res=await fetch('/api/upload',{method:'POST',body:form});
    const data=await res.json();
    clearInterval(pi);
    if(data.error)throw new Error(data.error);

    // Update each file item's status
    for(const {el,f,id} of itemEls){
      const fr=data.files?.find(r=>r.name===f.name);
      const statusEl=el.querySelector(\`#fstatus-\${id}\`);
      if(fr?.ok===false){
        el.className='file-item err';
        if(statusEl){statusEl.className='file-item-status err';statusEl.innerHTML='<i class="fas fa-times"></i>';}
      } else {
        el.className='file-item ok';
        if(statusEl){statusEl.className='file-item-status ok';statusEl.innerHTML='<i class="fas fa-check"></i>';}
      }
    }

    bar.style.width='100%';
    searchMode=data.searchMode||'bm25';
    const modeLabel=searchMode==='vector'?'Vector Embeddings':'BM25 Keyword';
    title.textContent=\`✅ \${files.length} files ready\`;
    status.textContent=data.chunks+' chunks · '+(data.chars/1000).toFixed(1)+'K chars · '+modeLabel;
    renderChunkBadges(chunksEl,data.chunks,searchMode);

    const successCount=data.files?.filter(f=>f.ok!==false).length||files.length;
    const errCount=data.files?.filter(f=>f.ok===false).length||0;
    updateLoadedState(
      \`\${files.length} files\`,
      \`\${data.chunks} chunks · \${fmtSize(data.totalSize||0)} · \${modeLabel}\`,
      'multi'
    );
    removeIdle();
    const fileListHtml=data.files?.map(f=>\`<li>\${getFileIcon(f.name?.split('.').pop()||'')} <strong>\${f.name}</strong> — \${fmtSize(f.size||0)}\${f.ok===false?' ❌ '+f.error:' ✅'}</li>\`).join('')||'';
    addMsg('bot',\`<h4>📦 Batch Upload Complete</h4><p><strong>\${successCount}</strong> of <strong>\${files.length}</strong> files processed · <strong>\${data.chunks} chunks</strong> · \${modeLabel}</p>\${errCount>0?'<p>⚠️ '+errCount+' file(s) failed</p>':''}<ul>\${fileListHtml}</ul><p style="margin-top:8px">You can now ask questions or generate dashboards across all uploaded documents.</p>\`);
  }catch(err){
    clearInterval(pi); bar.style.width='0%'; vp.classList.remove('show');
    for(const {el,id} of itemEls){
      el.className='file-item err';
      const s=el.querySelector(\`#fstatus-\${id}\`);
      if(s){s.className='file-item-status err';s.innerHTML='<i class="fas fa-times"></i>';}
    }
    addMsg('bot','<p>❌ Batch upload failed: '+err.message+'</p>');
  }
}

/* ── Helpers ──────────────────────────────── */
function renderChunkBadges(el,total,mode){
  el.innerHTML='';
  const me=document.createElement('span'); me.className='vec-chunk';
  me.style.background=mode==='vector'?'rgba(16,185,129,.1)':'rgba(245,158,11,.1)';
  me.style.color=mode==='vector'?'#059669':'#b45309';
  me.textContent=(mode==='vector'?'Vector':'BM25')+' Active';
  el.appendChild(me);
  const n=Math.min(total,10);
  for(let i=0;i<n;i++){const s=document.createElement('span');s.className='vec-chunk';s.textContent='c'+i;el.appendChild(s);}
  if(total>10){const s=document.createElement('span');s.className='vec-chunk';s.textContent='+'+(total-10);el.appendChild(s);}
}
function updateLoadedState(name,meta,type){
  docLoaded=true; docName=name;
  const iconEl=document.getElementById('fileLoadedIcon');
  if(iconEl){
    const icon=type==='multi'?'fa-layer-group':type==='pdf'?'fa-file-pdf':type==='docx'?'fa-file-word':type==='image'?'fa-image':'fa-file-check';
    const color=type==='multi'?'#7c3aed':type==='image'?'#0e7490':'#059669';
    iconEl.style.background=type==='multi'?'rgba(124,58,237,.12)':type==='image'?'rgba(14,116,144,.12)':'rgba(16,185,129,.12)';
    iconEl.innerHTML=\`<i class="fas \${icon}" style="font-size:15px;color:\${color}"></i>\`;
  }
  document.getElementById('fileLoaded').style.display='flex';
  document.getElementById('loadedName').textContent=name;
  document.getElementById('loadedMeta').textContent=meta;
  document.getElementById('uploadZone').classList.add('has-file');
  document.getElementById('aiCtxText').textContent=name.slice(0,18)+(name.length>18?'…':'');
}

function clearDoc(){
  docLoaded=false; docName='';
  document.getElementById('fileLoaded').style.display='none';
  document.getElementById('fileList').style.display='none';
  document.getElementById('vecProgress').classList.remove('show');
  document.getElementById('uploadZone').classList.remove('has-file');
  document.getElementById('aiCtxText').textContent='KB Ready';
  addMsg('bot','<p>📁 Documents removed. Built-in knowledge base still active.</p>');
}

// ══════════════════════════════════════════════
// GENERATE DASHBOARD
// ══════════════════════════════════════════════
function usePreset(el){
  document.querySelectorAll('.gen-preset').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('genInput').value=el.querySelector('span:last-child')?.textContent||el.textContent.trim();
  document.getElementById('genInput').focus();
}

async function generateDash(){
  const prompt=document.getElementById('genInput').value.trim();
  if(!prompt){document.getElementById('genInput').focus();return;}

  const btn=document.getElementById('genBtn');
  const dashContent=document.getElementById('dashContent');
  const dashTag=document.getElementById('dashAreaTag');
  const dashTitle=document.getElementById('dashAreaTitle');

  btn.disabled=true; btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Generating…';
  dashTag.style.display='flex'; dashTag.className='dash-area-tag streaming'; dashTag.textContent='⚡ Streaming…';
  dashTitle.textContent=prompt.slice(0,50)+(prompt.length>50?'…':'');
  dashContent.innerHTML='<div style="padding:20px;color:var(--tt);display:flex;align-items:center;gap:10px;font-size:.8rem"><i class="fas fa-spinner fa-spin" style="color:#06b6d4;font-size:16px"></i>Generating with AI<span class="stream-cursor"></span></div>';

  let htmlBuf='', rt=null;
  try{
    const res=await fetch('/api/generate-dashboard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt})});
    if(!res.ok)throw new Error('Generation failed');
    const reader=res.body.getReader(); const decoder=new TextDecoder(); let lo='';
    while(true){
      const{done,value}=await reader.read();
      if(done)break;
      const text=lo+decoder.decode(value,{stream:true});
      const lines=text.split('\\n'); lo=lines.pop()||'';
      for(const line of lines){
        if(!line.startsWith('data: '))continue;
        const payload=line.slice(6).trim();
        if(payload==='[DONE]')break;
        try{const obj=JSON.parse(payload);if(obj.text){htmlBuf+=obj.text;if(!rt){rt=setTimeout(()=>{rt=null;renderDashStream(htmlBuf);},200);}}}catch(_){}
      }
    }
    clearTimeout(rt); renderDashFinal(htmlBuf);
    dashTag.className='dash-area-tag live'; dashTag.textContent='✓ Live';
  }catch(err){
    dashContent.innerHTML='<div style="padding:20px;color:#dc2626;font-size:.8rem">❌ '+err.message+'</div>';
    dashTag.style.display='none';
  }finally{
    btn.disabled=false; btn.innerHTML='<i class="fas fa-wand-magic-sparkles"></i> Generate';
  }
}

function renderDashStream(html){
  const el=document.getElementById('dashContent');
  let clean=html.replace(/^\`\`\`html\s*/i,'').replace(/\`\`\`\s*$/,'');
  el.innerHTML=clean+'<span class="stream-cursor"></span>';
}

function renderDashFinal(html){
  const el=document.getElementById('dashContent');
  let clean=html.replace(/^\`\`\`html\s*/i,'').replace(/\`\`\`\s*$/,'').trim();
  el.innerHTML=clean;
  el.querySelectorAll('script').forEach(old=>{const s=document.createElement('script');s.textContent=old.textContent;old.replaceWith(s);});
}

// ══════════════════════════════════════════════
// AI CHAT
// ══════════════════════════════════════════════
function removeIdle(){document.getElementById('aiIdle')?.remove();}

function addMsg(role,html){
  removeIdle();
  const msgs=document.getElementById('aiMsgs');
  const div=document.createElement('div'); div.className='ai-msg '+role;
  const icon=role==='bot'?'<i class="fas fa-robot" style="font-size:10px"></i>':'<i class="fas fa-user" style="font-size:10px"></i>';
  div.innerHTML=\`<div class="msg-av \${role==='bot'?'bot':'usr'}">\${icon}</div><div class="msg-bubble">\${html}</div>\`;
  msgs.appendChild(div); msgs.scrollTop=msgs.scrollHeight; return div;
}

function showTyping(){
  removeIdle();
  const msgs=document.getElementById('aiMsgs');
  const div=document.createElement('div'); div.className='ai-msg bot'; div.id='typingDot';
  div.innerHTML='<div class="msg-av bot"><i class="fas fa-robot" style="font-size:10px"></i></div><div class="typing-dots"><span></span><span></span><span></span></div>';
  msgs.appendChild(div); msgs.scrollTop=msgs.scrollHeight;
}

function hideTyping(){document.getElementById('typingDot')?.remove();}

async function sendChat(){
  const input=document.getElementById('aiInput');
  const msg=input.value.trim(); if(!msg)return;
  input.value=''; input.style.height='';
  const sendBtn=document.getElementById('sendBtn'); sendBtn.disabled=true;
  addMsg('user',msg); showTyping();
  try{
    const res=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg})});
    hideTyping();
    if(!res.ok){const e=await res.json();throw new Error(e.error||'Chat failed');}
    const msgs=document.getElementById('aiMsgs');
    const div=document.createElement('div'); div.className='ai-msg bot';
    div.innerHTML='<div class="msg-av bot"><i class="fas fa-robot" style="font-size:10px"></i></div><div class="msg-bubble stream-cursor" id="streamBubble"></div>';
    msgs.appendChild(div); msgs.scrollTop=msgs.scrollHeight;
    const bubble=document.getElementById('streamBubble');
    const reader=res.body.getReader(); const decoder=new TextDecoder(); let lo=''; let ft='';
    while(true){
      const{done,value}=await reader.read(); if(done)break;
      const chunk=lo+decoder.decode(value,{stream:true});
      const lines=chunk.split('\\n'); lo=lines.pop()||'';
      for(const line of lines){
        if(!line.startsWith('data: '))continue;
        const payload=line.slice(6).trim(); if(payload==='[DONE]')break;
        try{const obj=JSON.parse(payload);if(obj.text){ft+=obj.text;bubble.innerHTML=ft;msgs.scrollTop=msgs.scrollHeight;}}catch(_){}
      }
    }
    bubble.classList.remove('stream-cursor');
    const src=docLoaded?docName.slice(0,20):'Built-in KB';
    bubble.innerHTML+=\`<div class="rag-badge" style="margin-top:8px"><i class="fas fa-database" style="font-size:9px"></i> RAG · \${src}</div>\`;
  }catch(err){
    hideTyping(); addMsg('bot','<p>❌ '+err.message+'</p>');
  }finally{sendBtn.disabled=false;}
}

function chipAsk(text,btn){
  document.querySelectorAll('.ai-chip').forEach(c=>c.classList.remove('active'));
  btn.classList.add('active'); setTimeout(()=>btn.classList.remove('active'),2000);
  document.getElementById('aiInput').value=text; sendChat();
}

function useTip(el){
  document.getElementById('aiInput').value=el.querySelector('.tip-txt').textContent;
  sendChat();
}
</script>
</body>
</html>`

// ─────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────
const port = parseInt(process.env.PORT || '3000')
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[server] Derek AI Dashboard running on http://0.0.0.0:${info.port}`)
  console.log(`[server] Model: ${MODEL} | Built-in KB: ${BUILTIN_KB.length} chunks`)
})
