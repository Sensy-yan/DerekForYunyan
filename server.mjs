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
app.get('/generate', (c) => c.html(GENERATE_HTML))

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
// SHARED STYLES (used by both pages)
// ─────────────────────────────────────────────
const SHARED_CSS = `
:root{--bg:#f0f4f8;--bg2:#e8edf2;--white:#fff;--navy:#0c2340;--border:#e2e8f0;--border2:#f1f5f9;--ts:#4b5563;--tt:#9ca3af;--cyan:#06b6d4;--cdark:#0e7490;--green:#10b981;--gl:#d1fae5;--amber:#f59e0b;--al:#fef3c7;--red:#ef4444;--rl:#fee2e2;--blue:#3b82f6;--bl:#dbeafe;--purple:#8b5cf6;--pl:#ede9fe;--r-sm:6px;--r-md:8px;--r-lg:12px;--r-xl:16px;--r-full:999px;--t:.15s ease;}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;font-family:'Inter',sans-serif;background:var(--bg);}
/* TOPBAR */
.topbar{background:var(--white);border-bottom:1px solid var(--border);height:56px;display:flex;align-items:center;padding:0 20px;gap:10px;flex-shrink:0;z-index:100;position:sticky;top:0;}
.tb-logo{width:34px;height:34px;background:linear-gradient(135deg,#0e7490,#06b6d4);border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.tb-logo i{font-size:14px;color:#fff;}
.tb-title{font-size:0.96rem;font-weight:800;color:var(--navy);letter-spacing:-.02em;}
.tb-dot{width:7px;height:7px;background:#10b981;border-radius:50%);}
.tb-tag{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:var(--r-full);font-size:.68rem;font-weight:700;}
.tg-teal{background:rgba(6,182,212,.1);color:#0e7490;}
.tg-amber{background:rgba(245,158,11,.1);color:#b45309;}
.tb-sp{flex:1;}
.tb-nav{display:flex;gap:4px;}
.tb-nav-btn{display:flex;align-items:center;gap:6px;padding:6px 14px;border-radius:var(--r-md);border:none;font-size:.75rem;font-weight:600;color:var(--ts);cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;background:transparent;text-decoration:none;}
.tb-nav-btn:hover{background:var(--bg2);color:var(--navy);}
.tb-nav-btn.active{background:rgba(6,182,212,.1);color:#0e7490;}
.tb-model{display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:var(--r-md);border:1px solid rgba(6,182,212,.25);background:rgba(6,182,212,.06);font-size:.72rem;font-weight:600;color:#0e7490;cursor:pointer;}
.tb-model .dot{width:6px;height:6px;background:#10b981;border-radius:50%;animation:pulse 2s infinite;}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.4;}}
.tb-key-btn{padding:4px 12px;border-radius:var(--r-md);border:1px solid rgba(245,158,11,.4);background:rgba(245,158,11,.08);font-size:.7rem;font-weight:600;color:#b45309;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;}
.tb-key-btn:hover{background:rgba(245,158,11,.15);}
.tb-user{width:32px;height:32px;background:linear-gradient(135deg,#0c2340,#0e4a6e);border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;}
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
`

// ─────────────────────────────────────────────
// MAIN HTML — Knowledge Base + Chat
// ─────────────────────────────────────────────
const MAIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Derek — Knowledge Base & Chat</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
<style>
${SHARED_CSS}
html,body{overflow:hidden;}
.page{display:flex;flex-direction:column;height:100vh;overflow:hidden;}
.body{display:flex;flex:1;min-height:0;overflow:hidden;}

/* ── LEFT: File Upload Panel ── */
.upload-panel{flex:0 0 360px;display:flex;flex-direction:column;border-right:1px solid var(--border);background:var(--white);overflow:hidden;}
.upload-panel-header{padding:18px 20px 14px;border-bottom:1px solid var(--border2);flex-shrink:0;}
.upload-panel-title{font-size:.92rem;font-weight:800;color:var(--navy);display:flex;align-items:center;gap:8px;margin-bottom:4px;}
.upload-panel-sub{font-size:.72rem;color:var(--tt);line-height:1.5;}
.upload-panel-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;}
.upload-panel-body::-webkit-scrollbar{width:4px;}
.upload-panel-body::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px;}

/* Drop Zone */
.drop-zone{border:2px dashed var(--border);border-radius:var(--r-xl);padding:0;cursor:pointer;transition:all var(--t);position:relative;overflow:hidden;}
.drop-zone:hover,.drop-zone.drag{border-color:#06b6d4;background:rgba(6,182,212,.02);}
.drop-zone.has-files{border-style:solid;border-color:rgba(16,185,129,.5);background:rgba(16,185,129,.02);}
.drop-zone-inner{padding:24px 20px;text-align:center;}
.drop-icon{width:48px;height:48px;background:linear-gradient(135deg,#0e7490,#06b6d4);border-radius:14px;display:flex;align-items:center;justify-content:center;margin:0 auto 12px;box-shadow:0 4px 14px rgba(6,182,212,.3);}
.drop-icon i{font-size:20px;color:#fff;}
.drop-title{font-size:.88rem;font-weight:700;color:var(--navy);margin-bottom:4px;}
.drop-sub{font-size:.72rem;color:var(--tt);line-height:1.6;}
.drop-formats{display:flex;gap:5px;flex-wrap:wrap;justify-content:center;margin-top:10px;}
.fmt-tag{font-size:.62rem;font-weight:600;padding:2px 8px;border-radius:var(--r-full);border:1px solid var(--border);color:var(--ts);background:var(--bg);}
.fmt-tag.pdf{border-color:rgba(239,68,68,.3);color:#dc2626;background:rgba(239,68,68,.05);}
.fmt-tag.docx{border-color:rgba(59,130,246,.3);color:#2563eb;background:rgba(59,130,246,.05);}
.fmt-tag.img{border-color:rgba(139,92,246,.3);color:#7c3aed;background:rgba(139,92,246,.05);}
.fmt-tag.text{border-color:rgba(6,182,212,.3);color:#0e7490;background:rgba(6,182,212,.05);}
.upload-input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;}

/* Progress */
.proc-card{background:var(--bg);border:1px solid var(--border);border-radius:var(--r-xl);padding:16px;display:none;}
.proc-card.show{display:block;}
.proc-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}
.proc-title{font-size:.82rem;font-weight:700;color:var(--navy);display:flex;align-items:center;gap:7px;}
.proc-pct{font-size:.72rem;font-weight:700;color:#0e7490;font-family:'JetBrains Mono',monospace;}
.proc-bar-track{height:6px;background:var(--border);border-radius:var(--r-full);overflow:hidden;margin-bottom:8px;}
.proc-bar-fill{height:100%;background:linear-gradient(90deg,#0e7490,#06b6d4,#10b981);border-radius:var(--r-full);transition:width .4s ease;width:0%;}
.proc-status{font-size:.71rem;color:var(--tt);}

/* File Queue */
.file-queue{display:flex;flex-direction:column;gap:6px;}
.fq-item{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--white);border:1px solid var(--border);border-radius:var(--r-lg);transition:all .2s;}
.fq-item.ok{border-color:rgba(16,185,129,.35);background:rgba(16,185,129,.03);}
.fq-item.err{border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.03);}
.fq-item.running{border-color:rgba(6,182,212,.5);background:rgba(6,182,212,.04);}
.fq-icon{font-size:15px;flex-shrink:0;}
.fq-name{flex:1;font-size:.76rem;font-weight:600;color:var(--navy);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fq-size{font-size:.67rem;color:var(--tt);flex-shrink:0;}
.fq-status{width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;flex-shrink:0;}
.fq-status.ok{background:rgba(16,185,129,.15);color:#059669;}
.fq-status.err{background:rgba(239,68,68,.15);color:#dc2626;}
.fq-status.wait{background:rgba(107,114,128,.1);color:#6b7280;}
.fq-status.spin{background:rgba(6,182,212,.1);color:#0e7490;animation:spin .7s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}

/* Loaded state */
.loaded-card{background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.3);border-radius:var(--r-xl);padding:14px 16px;}
.loaded-header{display:flex;align-items:center;gap:10px;}
.loaded-icon{width:38px;height:38px;background:rgba(16,185,129,.12);border-radius:var(--r-md);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.loaded-icon i{font-size:16px;color:#059669;}
.loaded-info{flex:1;min-width:0;}
.loaded-name{font-size:.84rem;font-weight:700;color:var(--navy);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.loaded-meta{font-size:.7rem;color:var(--tt);margin-top:2px;}
.loaded-remove{cursor:pointer;color:var(--tt);font-size:14px;padding:4px;transition:color .15s;}
.loaded-remove:hover{color:var(--red);}
.loaded-chunks{display:flex;gap:4px;flex-wrap:wrap;margin-top:10px;}
.chunk-badge{font-size:.62rem;padding:2px 8px;border-radius:var(--r-full);background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.2);color:#0e7490;font-family:'JetBrains Mono',monospace;}
.chunk-badge.vec{background:rgba(16,185,129,.08);border-color:rgba(16,185,129,.25);color:#059669;}

/* KB Status */
.kb-status{background:var(--bg);border:1px solid var(--border);border-radius:var(--r-xl);padding:14px 16px;}
.kb-status-row{display:flex;align-items:center;gap:10px;}
.kb-icon{width:34px;height:34px;background:linear-gradient(135deg,#0c2340,#0e4a6e);border-radius:var(--r-md);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.kb-icon i{font-size:13px;color:#67e8f9;}
.kb-info{flex:1;}
.kb-title{font-size:.8rem;font-weight:700;color:var(--navy);}
.kb-sub{font-size:.69rem;color:var(--tt);margin-top:1px;}
.kb-badge{font-size:.64rem;font-weight:700;padding:3px 9px;border-radius:var(--r-full);background:rgba(16,185,129,.1);color:#059669;border:1px solid rgba(16,185,129,.25);}

/* Quick links */
.quick-actions{display:flex;flex-direction:column;gap:6px;}
.qa-title{font-size:.74rem;font-weight:700;color:var(--ts);margin-bottom:4px;display:flex;align-items:center;gap:6px;}
.qa-btn{display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--white);border:1px solid var(--border);border-radius:var(--r-lg);cursor:pointer;transition:all .15s;width:100%;text-align:left;font-family:'Inter',sans-serif;}
.qa-btn:hover{border-color:#06b6d4;background:rgba(6,182,212,.04);}
.qa-btn-em{font-size:13px;flex-shrink:0;}
.qa-btn-text{flex:1;font-size:.76rem;font-weight:500;color:var(--ts);}
.qa-btn-arrow{font-size:10px;color:var(--tt);}

/* ── RIGHT: AI Chat ── */
.chat-panel{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--white);overflow:hidden;}
.chat-header{padding:14px 20px;border-bottom:1px solid var(--border2);display:flex;align-items:center;gap:10px;flex-shrink:0;}
.chat-av{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#0c4a56,#06b6d4);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 2px 8px rgba(6,182,212,.3);}
.chat-av i{font-size:16px;color:#fff;}
.chat-title{font-size:.92rem;font-weight:700;color:var(--navy);}
.chat-sub{font-size:.65rem;color:var(--tt);margin-top:1px;}
.chat-ctx{margin-left:auto;display:flex;align-items:center;gap:5px;background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.25);border-radius:var(--r-full);padding:4px 12px;font-size:.67rem;font-weight:600;color:#0e7490;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.chat-chips{padding:8px 16px;border-bottom:1px solid var(--border2);display:flex;gap:5px;overflow-x:auto;flex-shrink:0;background:var(--bg);}
.chat-chips::-webkit-scrollbar{height:0;}
.chip{display:flex;align-items:center;gap:5px;flex-shrink:0;padding:4px 11px;border-radius:var(--r-full);border:1px solid var(--border);font-size:.67rem;font-weight:600;color:var(--tt);cursor:pointer;transition:all var(--t);background:var(--white);white-space:nowrap;font-family:'Inter',sans-serif;}
.chip:hover{border-color:#06b6d4;color:#0e7490;background:rgba(6,182,212,.05);}
.chip.active{background:#06b6d4;color:#fff;border-color:#06b6d4;}
.cd{width:6px;height:6px;border-radius:50%;flex-shrink:0;}
.chat-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;}
.chat-msgs::-webkit-scrollbar{width:4px;}
.chat-msgs::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px;}
/* idle */
.ai-idle{display:flex;flex-direction:column;align-items:center;padding:30px 20px;gap:10px;text-align:center;}
.ai-idle-icon{width:56px;height:56px;border-radius:16px;background:linear-gradient(135deg,#0c4a56,#06b6d4);display:flex;align-items:center;justify-content:center;font-size:24px;color:#fff;box-shadow:0 4px 16px rgba(6,182,212,.35);margin-bottom:4px;}
.ai-idle h3{font-size:.94rem;font-weight:700;color:var(--navy);}
.ai-idle p{font-size:.76rem;color:var(--tt);line-height:1.7;max-width:380px;}
.tip-list{display:flex;flex-direction:column;gap:6px;width:100%;max-width:420px;margin-top:4px;}
.tip-item{display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--bg);border:1px solid var(--border2);border-radius:var(--r-lg);cursor:pointer;transition:all .15s;}
.tip-item:hover{border-color:#06b6d4;background:rgba(6,182,212,.04);}
.tip-em{font-size:14px;flex-shrink:0;}
.tip-txt{font-size:.74rem;color:var(--ts);font-weight:500;line-height:1.45;text-align:left;}
/* messages */
.ai-msg{display:flex;gap:8px;}
.ai-msg.user{flex-direction:row-reverse;}
.msg-av{width:28px;height:28px;border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;}
.msg-av.bot{background:linear-gradient(135deg,#0c4a56,#06b6d4);color:#fff;}
.msg-av.usr{background:var(--navy);color:#fff;}
.msg-bubble{max-width:82%;padding:10px 13px;border-radius:12px;font-size:.78rem;line-height:1.7;color:var(--navy);}
.ai-msg.user .msg-bubble{background:linear-gradient(135deg,#0c4a56,#0e7490);color:#fff;border-radius:12px 2px 12px 12px;}
.ai-msg.bot .msg-bubble{background:var(--bg);border:1px solid var(--border2);border-radius:2px 12px 12px 12px;}
.msg-bubble h4{font-size:.76rem;font-weight:700;color:var(--navy);margin:0 0 5px;}
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
.rag-badge{display:inline-flex;align-items:center;gap:4px;font-size:.63rem;font-weight:600;padding:2px 9px;border-radius:var(--r-full);background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.2);color:#0e7490;margin-top:6px;}
/* input */
.chat-input{padding:12px 16px;border-top:1px solid var(--border2);flex-shrink:0;}
.chat-input-row{display:flex;gap:8px;align-items:flex-end;}
.chat-ta{flex:1;resize:none;border:1px solid var(--border);border-radius:var(--r-lg);padding:9px 12px;font-size:.78rem;font-family:'Inter',sans-serif;color:var(--navy);outline:none;background:var(--bg);min-height:62px;max-height:120px;line-height:1.5;}
.chat-ta:focus{border-color:#06b6d4;background:var(--white);box-shadow:0 0 0 3px rgba(6,182,212,.1);}
.chat-ta::placeholder{color:var(--tt);}
.send-btn{width:38px;height:38px;border-radius:var(--r-md);border:none;background:linear-gradient(135deg,#0e7490,#06b6d4);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .15s;}
.send-btn:hover{opacity:.85;transform:translateY(-1px);}
.send-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;}
.chat-hint{font-size:.64rem;color:var(--tt);margin-top:5px;text-align:center;}
</style>
</head>
<body>
<div class="page">
<!-- TOPBAR -->
<div class="topbar">
  <div class="tb-logo"><i class="fas fa-brain"></i></div>
  <div class="tb-title">Derek</div>
  <div class="tb-tag tg-teal" style="margin-left:4px"><i class="fas fa-circle" style="font-size:6px"></i> AI Intelligence</div>
  <div class="tb-sp"></div>
  <nav class="tb-nav">
    <a class="tb-nav-btn active" href="/"><i class="fas fa-database" style="font-size:11px"></i> Knowledge Base</a>
    <a class="tb-nav-btn" href="/generate"><i class="fas fa-wand-magic-sparkles" style="font-size:11px"></i> Generate Dashboard</a>
  </nav>
  <div class="tb-model" onclick="showApiModal()" title="Click to update API key">
    <span class="dot"></span>
    <span id="modelLabel">gpt-5 · RAG</span>
  </div>
  <button class="tb-key-btn" onclick="showApiModal()"><i class="fas fa-key" style="font-size:10px"></i> API Key</button>
  <div class="tb-user">D</div>
</div>

<div class="body">
<!-- ── LEFT: Upload Panel ── -->
<div class="upload-panel">
  <div class="upload-panel-header">
    <div class="upload-panel-title">
      <i class="fas fa-folder-open" style="color:#06b6d4;font-size:14px"></i>
      Knowledge Base
    </div>
    <div class="upload-panel-sub">Upload documents to enrich AI context. Supports PDF, DOCX, images, HTML, TXT, CSV, JSON.</div>
  </div>
  <div class="upload-panel-body" id="uploadPanelBody">

    <!-- Drop Zone -->
    <div class="drop-zone" id="dropZone"
      ondragover="event.preventDefault();this.classList.add('drag')"
      ondragleave="this.classList.remove('drag')"
      ondrop="handleDrop(event)">
      <input type="file" class="upload-input" id="fileInput"
        accept=".html,.htm,.txt,.md,.csv,.json,.pdf,.doc,.docx,.jpg,.jpeg,.png,.gif,.webp,.bmp"
        multiple
        onchange="handleFileChange(event)"/>
      <div class="drop-zone-inner">
        <div class="drop-icon"><i class="fas fa-cloud-upload-alt"></i></div>
        <div class="drop-title">Drop files here or click to browse</div>
        <div class="drop-sub">Batch upload supported — mix any formats</div>
        <div class="drop-formats">
          <span class="fmt-tag pdf">PDF</span>
          <span class="fmt-tag docx">DOCX</span>
          <span class="fmt-tag img">Images</span>
          <span class="fmt-tag text">TXT / MD</span>
          <span class="fmt-tag text">CSV / JSON</span>
          <span class="fmt-tag">HTML</span>
        </div>
      </div>
    </div>

    <!-- Processing Progress (hidden initially) -->
    <div class="proc-card" id="procCard">
      <div class="proc-header">
        <div class="proc-title">
          <i class="fas fa-microchip" style="color:#06b6d4;font-size:12px"></i>
          <span id="procTitle">Processing…</span>
        </div>
        <div class="proc-pct" id="procPct">0%</div>
      </div>
      <div class="proc-bar-track"><div class="proc-bar-fill" id="procBar"></div></div>
      <div class="proc-status" id="procStatus">Preparing…</div>
      <div class="loaded-chunks" id="procChunks" style="margin-top:8px"></div>
    </div>

    <!-- File Queue (shown during batch) -->
    <div class="file-queue" id="fileQueue" style="display:none"></div>

    <!-- Loaded State (shown after success) -->
    <div class="loaded-card" id="loadedCard" style="display:none">
      <div class="loaded-header">
        <div class="loaded-icon" id="loadedIconWrap"><i class="fas fa-file-check"></i></div>
        <div class="loaded-info">
          <div class="loaded-name" id="loadedName">—</div>
          <div class="loaded-meta" id="loadedMeta">—</div>
        </div>
        <span class="loaded-remove" onclick="clearDoc()" title="Remove documents"><i class="fas fa-times-circle"></i></span>
      </div>
      <div class="loaded-chunks" id="loadedChunks"></div>
    </div>

    <!-- Built-in KB Status -->
    <div class="kb-status">
      <div class="kb-status-row">
        <div class="kb-icon"><i class="fas fa-database"></i></div>
        <div class="kb-info">
          <div class="kb-title">Built-in Knowledge Base</div>
          <div class="kb-sub">Shoreless Inc. · Always active</div>
        </div>
        <div class="kb-badge">16 chunks</div>
      </div>
    </div>

    <!-- Quick Ask Actions -->
    <div class="quick-actions">
      <div class="qa-title"><i class="fas fa-bolt" style="color:#f59e0b;font-size:10px"></i> Quick Questions</div>
      <button class="qa-btn" onclick="quickAsk('What are the key financial metrics and revenue projections?')">
        <span class="qa-btn-em">💰</span>
        <span class="qa-btn-text">Financial metrics & projections</span>
        <i class="fas fa-chevron-right qa-btn-arrow"></i>
      </button>
      <button class="qa-btn" onclick="quickAsk('What are the main investment risks for Shoreless Inc?')">
        <span class="qa-btn-em">⚠️</span>
        <span class="qa-btn-text">Investment risk assessment</span>
        <i class="fas fa-chevron-right qa-btn-arrow"></i>
      </button>
      <button class="qa-btn" onclick="quickAsk('Summarize the deal terms and investment structure')">
        <span class="qa-btn-em">📋</span>
        <span class="qa-btn-text">Deal terms & cap table</span>
        <i class="fas fa-chevron-right qa-btn-arrow"></i>
      </button>
      <button class="qa-btn" onclick="quickAsk('What are the exit scenarios and MOIC projections?')">
        <span class="qa-btn-em">🚀</span>
        <span class="qa-btn-text">Exit scenarios & MOIC</span>
        <i class="fas fa-chevron-right qa-btn-arrow"></i>
      </button>
      <button class="qa-btn" onclick="window.location.href='/generate'">
        <span class="qa-btn-em">📊</span>
        <span class="qa-btn-text">Generate a dashboard →</span>
        <i class="fas fa-external-link-alt qa-btn-arrow"></i>
      </button>
    </div>

  </div>
</div>

<!-- ── RIGHT: AI Chat ── -->
<div class="chat-panel">
  <div class="chat-header">
    <div class="chat-av"><i class="fas fa-robot"></i></div>
    <div>
      <div class="chat-title">Derek AI</div>
      <div class="chat-sub" id="chatSubLabel">RAG Intelligence · Built-in KB active</div>
    </div>
    <div class="chat-ctx" id="chatCtx">
      <i class="fas fa-circle" style="font-size:6px;color:#06b6d4"></i>
      <span id="chatCtxText">KB Ready</span>
    </div>
  </div>
  <div class="chat-chips">
    <button class="chip" onclick="chipAsk('Give me a comprehensive overview of Shoreless Inc.',this)"><span class="cd" style="background:#06b6d4"></span>Overview</button>
    <button class="chip" onclick="chipAsk('What are the key financial metrics and revenue projections?',this)"><span class="cd" style="background:#f59e0b"></span>Financials</button>
    <button class="chip" onclick="chipAsk('What are the main investment risks?',this)"><span class="cd" style="background:#ef4444"></span>Risks</button>
    <button class="chip" onclick="chipAsk('Summarize the deal terms and investment structure',this)"><span class="cd" style="background:#8b5cf6"></span>Deal Terms</button>
    <button class="chip" onclick="chipAsk('What are the exit scenarios and MOIC projections?',this)"><span class="cd" style="background:#3b82f6"></span>Exit</button>
    <button class="chip" onclick="chipAsk('Tell me about Kenneth Myers and the founding team',this)"><span class="cd" style="background:#10b981"></span>Team</button>
  </div>
  <div class="chat-msgs" id="chatMsgs">
    <div class="ai-idle" id="aiIdle">
      <div class="ai-idle-icon">🤖</div>
      <h3>Derek AI · RAG Intelligence</h3>
      <p>Built-in Shoreless Inc. knowledge base is active. Upload documents on the left for additional context. Ask anything about the deal.</p>
      <div class="tip-list">
        <div class="tip-item" onclick="useTip(this)"><span class="tip-em">📊</span><span class="tip-txt">Generate a financial dashboard with revenue charts</span></div>
        <div class="tip-item" onclick="useTip(this)"><span class="tip-em">🔍</span><span class="tip-txt">What are the key investment risks?</span></div>
        <div class="tip-item" onclick="useTip(this)"><span class="tip-em">💰</span><span class="tip-txt">Summarize financial performance and projections</span></div>
        <div class="tip-item" onclick="useTip(this)"><span class="tip-em">🎯</span><span class="tip-txt">What is the investment thesis?</span></div>
        <div class="tip-item" onclick="useTip(this)"><span class="tip-em">🚀</span><span class="tip-txt">Who are the likely strategic acquirers and at what valuation?</span></div>
      </div>
    </div>
  </div>
  <div class="chat-input">
    <div class="chat-input-row">
      <textarea class="chat-ta" id="chatInput"
        placeholder="Ask anything about the deal — AI will search through documents and knowledge base…"
        rows="3"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat();}"
        oninput="this.style.height='auto';this.style.height=Math.min(Math.max(this.scrollHeight,62),120)+'px'"></textarea>
      <button class="send-btn" id="sendBtn" onclick="sendChat()">
        <i class="fas fa-paper-plane" style="font-size:12px"></i>
      </button>
    </div>
    <div class="chat-hint"><i class="fas fa-database" style="font-size:9px"></i> RAG · Enter to send · Shift+Enter new line</div>
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
// ── STATE ──
let docLoaded = false, docName = '', searchMode = 'bm25';

// Init
fetch('/api/status').then(r=>r.json()).then(d=>{
  if(d.model) document.getElementById('modelLabel').textContent = d.model + ' · RAG';
  if(d.docLoaded){docLoaded=true;docName=d.docLoaded;document.getElementById('chatCtxText').textContent=d.docLoaded.slice(0,20)+(d.docLoaded.length>20?'…':'');}
  else{document.getElementById('chatCtxText').textContent='KB: '+d.kbChunks+' chunks';}
}).catch(()=>{});

// ── API KEY MODAL ──
function showApiModal(){document.getElementById('apiModal').classList.add('show');}
function hideApiModal(){document.getElementById('apiModal').classList.remove('show');}
async function saveApiKey(){
  const key=document.getElementById('apiKeyInput').value.trim();
  if(!key){alert('Please enter an API key');return;}
  const btn=document.getElementById('saveKeyBtn');
  const status=document.getElementById('apiKeyStatus');
  btn.disabled=true;btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Testing…';
  status.style.display='block';status.style.color='#b45309';status.textContent='Testing connection…';
  try{
    const res=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
    const data=await res.json();
    if(data.ok){status.style.color='#059669';status.textContent='✅ API key verified! Model: '+data.model;setTimeout(()=>hideApiModal(),1500);}
    else{status.style.color='#dc2626';status.textContent='❌ Invalid key: '+(data.error||'Unknown error');}
  }catch(e){status.style.color='#dc2626';status.textContent='❌ Error: '+e.message;}
  finally{btn.disabled=false;btn.innerHTML='<i class="fas fa-check"></i> Save & Test';}
}

// ── FILE UPLOAD ──
const ALLOWED=['html','htm','txt','md','csv','json','pdf','doc','docx','jpg','jpeg','png','gif','webp','bmp'];
function getIcon(ext){
  if(ext==='pdf')return'📄';
  if(['doc','docx'].includes(ext))return'📝';
  if(['jpg','jpeg','png','gif','webp','bmp'].includes(ext))return'🖼️';
  if(['csv','json'].includes(ext))return'📊';
  if(['html','htm'].includes(ext))return'🌐';
  return'📄';
}
function fmtSize(b){return b<1024?b+'B':b<1048576?(b/1024).toFixed(1)+'KB':(b/1048576).toFixed(1)+'MB';}

function handleDrop(e){
  e.preventDefault();
  document.getElementById('dropZone').classList.remove('drag');
  const files=Array.from(e.dataTransfer?.files||[]);
  if(files.length>0)processFiles(files);
}
function handleFileChange(e){
  const files=Array.from(e.target.files||[]);
  if(files.length>0)processFiles(files);
  e.target.value='';
}

async function processFiles(files){
  const valid=[],invalid=[];
  for(const f of files){
    const ext=f.name.split('.').pop()?.toLowerCase()||'';
    if(ALLOWED.includes(ext))valid.push(f);else invalid.push(f.name);
  }
  if(invalid.length>0)addMsg('bot',\`<p>⚠️ Skipped unsupported: <strong>\${invalid.join(', ')}</strong></p>\`);
  if(valid.length===0)return;
  if(valid.length===1)await processSingle(valid[0]);
  else await processBatch(valid);
}

async function processSingle(file){
  const ext=file.name.split('.').pop()?.toLowerCase()||'';
  const isImg=['jpg','jpeg','png','gif','webp','bmp'].includes(ext);
  const isPdf=ext==='pdf';
  const isDocx=['doc','docx'].includes(ext);
  showProc(true);
  setProc(10,'Processing '+file.name+'…',isPdf?'Parsing PDF pages…':isDocx?'Extracting DOCX…':isImg?'Analyzing image with Vision AI…':'Uploading…');
  const fq=document.getElementById('fileQueue'); fq.style.display='none';
  const form=new FormData(); form.append('file',file);
  let pv=10;
  const pi=setInterval(()=>{pv=Math.min(pv+(isPdf||isDocx||isImg?4:7),85);setProc(pv,null,pv<30?(isPdf?'Parsing PDF…':isDocx?'Parsing DOCX structure…':isImg?'Vision AI processing…':'Reading file…'):pv<60?'Extracting text & structure…':pv<80?'Chunking & building index…':'Finalizing…');},isPdf||isDocx||isImg?550:350);
  try{
    const res=await fetch('/api/upload',{method:'POST',body:form});
    const data=await res.json(); clearInterval(pi);
    if(data.error)throw new Error(data.error);
    setProc(100,'✅ Ready: '+data.name,'Search mode: '+(data.searchMode==='vector'?'Vector Embeddings':'BM25 Keyword')+' · '+data.chunks+' chunks');
    searchMode=data.searchMode||'bm25';
    showLoadedCard(data.name,data.chunks+' chunks · '+fmtSize(data.totalSize||data.size||0)+' · '+(searchMode==='vector'?'Vector':'BM25'),data.fileType,data.chunks,searchMode);
    removeIdle();
    addMsg('bot',\`<h4>\${getIcon(ext)} Ready: \${data.name}</h4><p>Processed <strong>\${data.chunks} chunks</strong> using \${searchMode==='vector'?'Vector Embeddings':'BM25 Keyword'} search.</p><ul>\${data.fileType==='image'?'<li>🖼️ Image analyzed via Vision AI</li>':data.fileType==='pdf'?'<li>📄 PDF parsed — all pages extracted</li>':data.fileType==='docx'?'<li>📝 DOCX parsed — content extracted</li>':''}<li>Ask questions in the chat or <a href="/generate" style="color:#0e7490;font-weight:600">generate a dashboard →</a></li></ul>\`);
  }catch(err){clearInterval(pi);showProc(false);addMsg('bot','<p>❌ Upload failed: '+err.message+'</p>');}
}

async function processBatch(files){
  showProc(true);
  setProc(5,\`Uploading \${files.length} files…\`,'Preparing batch upload…');
  const fq=document.getElementById('fileQueue'); fq.style.display='flex'; fq.innerHTML='';
  const itemMap={};
  for(const f of files){
    const ext=f.name.split('.').pop()?.toLowerCase()||'';
    const key=f.name.replace(/[^a-z0-9]/gi,'_');
    const el=document.createElement('div'); el.className='fq-item';
    el.innerHTML=\`<span class="fq-icon">\${getIcon(ext)}</span><span class="fq-name">\${f.name}</span><span class="fq-size">\${fmtSize(f.size)}</span><span class="fq-status wait" id="fq-\${key}"><i class="fas fa-clock"></i></span>\`;
    fq.appendChild(el); itemMap[f.name]={el,key};
  }
  // mark all spinning
  for(const {el,key} of Object.values(itemMap)){el.className='fq-item running';const s=el.querySelector(\`#fq-\${key}\`);if(s){s.className='fq-status spin';s.innerHTML='<i class="fas fa-sync-alt"></i>';}}
  const form=new FormData(); for(const f of files)form.append('files[]',f);
  const hasBig=files.some(f=>/\\.(pdf|docx?)$/i.test(f.name));
  let pv=5;
  const pi=setInterval(()=>{pv=Math.min(pv+(hasBig?3:6),85);setProc(pv,null,pv<40?'Parsing files…':pv<70?'Extracting text & chunking…':'Building search index…');},500);
  try{
    const res=await fetch('/api/upload',{method:'POST',body:form});
    const data=await res.json(); clearInterval(pi);
    if(data.error)throw new Error(data.error);
    for(const fr of (data.files||[])){
      const im=itemMap[fr.name]; if(!im)continue;
      const{el,key}=im; const s=el.querySelector(\`#fq-\${key}\`);
      if(fr.ok===false){el.className='fq-item err';if(s){s.className='fq-status err';s.innerHTML='<i class="fas fa-times"></i>';}}
      else{el.className='fq-item ok';if(s){s.className='fq-status ok';s.innerHTML='<i class="fas fa-check"></i>';}}
    }
    setProc(100,\`✅ \${files.length} files ready\`,data.chunks+' chunks · '+(data.chars/1000).toFixed(1)+'K chars');
    searchMode=data.searchMode||'bm25';
    const modeLabel=searchMode==='vector'?'Vector Embeddings':'BM25 Keyword';
    showLoadedCard(\`\${files.length} files\`,data.chunks+' chunks · '+fmtSize(data.totalSize||0)+' · '+modeLabel,'multi',data.chunks,searchMode);
    removeIdle();
    const ok=data.files?.filter(f=>f.ok!==false).length||files.length;
    const fail=data.files?.filter(f=>f.ok===false).length||0;
    addMsg('bot',\`<h4>📦 Batch Upload Complete</h4><p><strong>\${ok}/\${files.length}</strong> files · <strong>\${data.chunks} chunks</strong> · \${modeLabel}</p>\${fail?'<p>⚠️ '+fail+' failed</p>':''}<p style="margin-top:6px">Ask questions or <a href="/generate" style="color:#0e7490;font-weight:600">generate a dashboard →</a></p>\`);
  }catch(err){
    clearInterval(pi);showProc(false);
    for(const{el,key}of Object.values(itemMap)){el.className='fq-item err';const s=el.querySelector(\`#fq-\${key}\`);if(s){s.className='fq-status err';s.innerHTML='<i class="fas fa-times"></i>';}}
    addMsg('bot','<p>❌ Batch upload failed: '+err.message+'</p>');
  }
}

function showProc(show){document.getElementById('procCard').classList.toggle('show',show);}
function setProc(pct,title,status){
  const b=document.getElementById('procBar'); b.style.width=pct+'%';
  document.getElementById('procPct').textContent=Math.round(pct)+'%';
  if(title)document.getElementById('procTitle').textContent=title;
  if(status)document.getElementById('procStatus').textContent=status;
}
function showLoadedCard(name,meta,type,chunks,mode){
  docLoaded=true; docName=name;
  const wrap=document.getElementById('loadedIconWrap');
  const icon=type==='multi'?'fa-layer-group':type==='pdf'?'fa-file-pdf':type==='docx'?'fa-file-word':type==='image'?'fa-image':'fa-file-check';
  const col=type==='multi'?'#7c3aed':type==='image'?'#0e7490':'#059669';
  const bg=type==='multi'?'rgba(124,58,237,.12)':type==='image'?'rgba(14,116,144,.12)':'rgba(16,185,129,.12)';
  wrap.style.background=bg; wrap.innerHTML=\`<i class="fas \${icon}" style="font-size:16px;color:\${col}"></i>\`;
  document.getElementById('loadedCard').style.display='block';
  document.getElementById('loadedName').textContent=name;
  document.getElementById('loadedMeta').textContent=meta;
  document.getElementById('dropZone').classList.add('has-files');
  document.getElementById('chatCtxText').textContent=name.slice(0,20)+(name.length>20?'…':'');
  // Chunk badges
  const lc=document.getElementById('loadedChunks'); lc.innerHTML='';
  const mb=document.createElement('span'); mb.className='chunk-badge '+(mode==='vector'?'vec':'');
  mb.textContent=(mode==='vector'?'Vector':'BM25')+' Active'; lc.appendChild(mb);
  const n=Math.min(chunks,8);
  for(let i=0;i<n;i++){const s=document.createElement('span');s.className='chunk-badge';s.textContent='c'+i;lc.appendChild(s);}
  if(chunks>8){const s=document.createElement('span');s.className='chunk-badge';s.textContent='+' + (chunks-8);lc.appendChild(s);}
}
function clearDoc(){
  docLoaded=false;docName='';
  document.getElementById('loadedCard').style.display='none';
  document.getElementById('fileQueue').style.display='none';
  document.getElementById('procCard').classList.remove('show');
  document.getElementById('dropZone').classList.remove('has-files');
  document.getElementById('chatCtxText').textContent='KB Ready';
  addMsg('bot','<p>📁 Documents removed. Built-in knowledge base still active.</p>');
}

// ── CHAT ──
function removeIdle(){document.getElementById('aiIdle')?.remove();}
function addMsg(role,html){
  removeIdle();
  const msgs=document.getElementById('chatMsgs');
  const div=document.createElement('div'); div.className='ai-msg '+role;
  const icon=role==='bot'?'<i class="fas fa-robot" style="font-size:10px"></i>':'<i class="fas fa-user" style="font-size:10px"></i>';
  div.innerHTML=\`<div class="msg-av \${role==='bot'?'bot':'usr'}">\${icon}</div><div class="msg-bubble">\${html}</div>\`;
  msgs.appendChild(div); msgs.scrollTop=msgs.scrollHeight; return div;
}
function showTyping(){
  removeIdle();
  const msgs=document.getElementById('chatMsgs');
  const div=document.createElement('div'); div.className='ai-msg bot'; div.id='typingDot';
  div.innerHTML='<div class="msg-av bot"><i class="fas fa-robot" style="font-size:10px"></i></div><div class="typing-dots"><span></span><span></span><span></span></div>';
  msgs.appendChild(div); msgs.scrollTop=msgs.scrollHeight;
}
function hideTyping(){document.getElementById('typingDot')?.remove();}
async function sendChat(){
  const input=document.getElementById('chatInput');
  const msg=input.value.trim(); if(!msg)return;
  input.value=''; input.style.height='';
  const sendBtn=document.getElementById('sendBtn'); sendBtn.disabled=true;
  addMsg('user',msg); showTyping();
  try{
    const res=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg})});
    hideTyping();
    if(!res.ok){const e=await res.json();throw new Error(e.error||'Chat failed');}
    const msgs=document.getElementById('chatMsgs');
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
  }catch(err){hideTyping();addMsg('bot','<p>❌ '+err.message+'</p>');}
  finally{sendBtn.disabled=false;}
}
function chipAsk(text,btn){
  document.querySelectorAll('.chip').forEach(c=>c.classList.remove('active'));
  btn.classList.add('active'); setTimeout(()=>btn.classList.remove('active'),2000);
  document.getElementById('chatInput').value=text; sendChat();
}
function quickAsk(text){document.getElementById('chatInput').value=text;sendChat();}
function useTip(el){document.getElementById('chatInput').value=el.querySelector('.tip-txt').textContent;sendChat();}
</script>
</body>
</html>`

// ─────────────────────────────────────────────
// GENERATE HTML — Dashboard Generation Page
// ─────────────────────────────────────────────
const GENERATE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Derek — Generate Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
${SHARED_CSS}
html,body{overflow:hidden;}
.page{display:flex;flex-direction:column;height:100vh;overflow:hidden;}
.gen-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;}

/* ── Top Controls ── */
.gen-controls{background:var(--white);border-bottom:1px solid var(--border);padding:16px 20px;flex-shrink:0;}
.gen-controls-row1{display:flex;align-items:center;gap:12px;margin-bottom:12px;}
.gen-label{font-size:.78rem;font-weight:700;color:var(--navy);white-space:nowrap;}
.gen-ta-wrap{flex:1;position:relative;}
.gen-ta{width:100%;resize:none;border:1px solid var(--border);border-radius:var(--r-lg);padding:10px 14px;font-size:.82rem;font-family:'Inter',sans-serif;color:var(--navy);outline:none;background:var(--bg);line-height:1.5;}
.gen-ta:focus{border-color:#06b6d4;background:var(--white);box-shadow:0 0 0 3px rgba(6,182,212,.1);}
.gen-ta::placeholder{color:var(--tt);}
.gen-go-btn{padding:10px 22px;border-radius:var(--r-lg);border:none;background:linear-gradient(135deg,#0e7490,#06b6d4);color:#fff;font-size:.82rem;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;display:flex;align-items:center;gap:8px;white-space:nowrap;flex-shrink:0;height:42px;}
.gen-go-btn:hover{opacity:.88;transform:translateY(-1px);}
.gen-go-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;}
.gen-presets-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
.preset-label{font-size:.69rem;font-weight:700;color:var(--tt);white-space:nowrap;}
.preset-btn{display:flex;align-items:center;gap:5px;padding:5px 12px;border-radius:var(--r-full);border:1px solid var(--border);background:var(--bg);font-size:.72rem;font-weight:600;color:var(--ts);cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;white-space:nowrap;}
.preset-btn:hover,.preset-btn.active{border-color:#06b6d4;color:#0e7490;background:rgba(6,182,212,.08);}
.ctrl-hint{font-size:.65rem;color:var(--tt);display:flex;align-items:center;gap:4px;}

/* ── Dashboard Area ── */
.dash-outer{flex:1;overflow:hidden;display:flex;flex-direction:column;}
.dash-toolbar{display:flex;align-items:center;gap:10px;padding:10px 20px;background:var(--bg);border-bottom:1px solid var(--border);flex-shrink:0;}
.dash-toolbar-title{font-size:.82rem;font-weight:700;color:var(--navy);flex:1;}
.dash-tag{font-size:.65rem;font-weight:700;padding:3px 9px;border-radius:var(--r-full);}
.dash-tag.live{background:rgba(16,185,129,.1);color:#059669;}
.dash-tag.streaming{background:rgba(245,158,11,.1);color:#b45309;}
.dash-tag.error{background:rgba(239,68,68,.1);color:#dc2626;}
.dash-action-btn{display:flex;align-items:center;gap:5px;padding:5px 12px;border-radius:var(--r-md);border:1px solid var(--border);background:var(--white);font-size:.72rem;font-weight:600;color:var(--ts);cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;}
.dash-action-btn:hover{border-color:#06b6d4;color:#0e7490;}
.dash-scroll{flex:1;overflow-y:auto;padding:20px;}
.dash-scroll::-webkit-scrollbar{width:6px;}
.dash-scroll::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px;}
.dash-inner{min-height:400px;}
.stream-cursor::after{content:'▋';animation:blink .7s steps(1) infinite;color:#06b6d4;}
@keyframes blink{0%,100%{opacity:1;}50%{opacity:0;}}
.empty-dash{text-align:center;padding:60px 24px;color:var(--tt);}
.empty-dash-icon{width:64px;height:64px;background:var(--bg2);border-radius:20px;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:28px;}
.empty-dash h3{font-size:1rem;font-weight:700;color:var(--ts);margin-bottom:8px;}
.empty-dash p{font-size:.79rem;line-height:1.7;max-width:400px;margin:0 auto;}
.empty-dash-presets{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:20px;}
.edp-btn{display:flex;flex-direction:column;align-items:center;gap:6px;padding:16px 20px;border-radius:var(--r-xl);border:1px solid var(--border);background:var(--white);cursor:pointer;font-family:'Inter',sans-serif;transition:all .2s;min-width:120px;}
.edp-btn:hover{border-color:#06b6d4;background:rgba(6,182,212,.04);transform:translateY(-2px);}
.edp-em{font-size:22px;}
.edp-text{font-size:.74rem;font-weight:600;color:var(--navy);text-align:center;line-height:1.3;}
</style>
</head>
<body>
<div class="page">
<!-- TOPBAR -->
<div class="topbar">
  <div class="tb-logo"><i class="fas fa-brain"></i></div>
  <div class="tb-title">Derek</div>
  <div class="tb-tag tg-amber" style="margin-left:4px"><i class="fas fa-bolt" style="font-size:8px"></i> Dashboard Generator</div>
  <div class="tb-sp"></div>
  <nav class="tb-nav">
    <a class="tb-nav-btn" href="/"><i class="fas fa-database" style="font-size:11px"></i> Knowledge Base</a>
    <a class="tb-nav-btn active" href="/generate"><i class="fas fa-wand-magic-sparkles" style="font-size:11px"></i> Generate Dashboard</a>
  </nav>
  <div class="tb-model" onclick="showApiModal()" title="Click to update API key">
    <span class="dot"></span>
    <span id="modelLabel">gpt-5 · RAG</span>
  </div>
  <button class="tb-key-btn" onclick="showApiModal()"><i class="fas fa-key" style="font-size:10px"></i> API Key</button>
  <div class="tb-user">D</div>
</div>

<div class="gen-body">
  <!-- ── Controls ── -->
  <div class="gen-controls">
    <div class="gen-controls-row1">
      <div class="gen-label"><i class="fas fa-wand-magic-sparkles" style="color:#06b6d4;margin-right:5px"></i>Prompt</div>
      <div class="gen-ta-wrap">
        <textarea class="gen-ta" id="genInput" rows="1"
          placeholder="Describe the dashboard… e.g. 'Financial overview with revenue charts and KPI cards'"
          onkeydown="if(event.key==='Enter'&&event.ctrlKey){event.preventDefault();generateDash()}"
          oninput="this.style.height='auto';this.style.height=Math.min(Math.max(this.scrollHeight,40),100)+'px'"></textarea>
      </div>
      <button class="gen-go-btn" id="genBtn" onclick="generateDash()">
        <i class="fas fa-wand-magic-sparkles"></i> Generate
      </button>
    </div>
    <div class="gen-presets-row">
      <span class="preset-label">Presets:</span>
      <button class="preset-btn" onclick="usePreset(this,'Financial Overview with KPI cards and revenue trend chart')"><span>📊</span> Financial Overview</button>
      <button class="preset-btn" onclick="usePreset(this,'Revenue & customer metrics with growth projections and trend lines')"><span>🏆</span> Revenue & Customers</button>
      <button class="preset-btn" onclick="usePreset(this,'Risk assessment dashboard with risk matrix, severity ratings and mitigation strategies')"><span>⚠️</span> Risk Assessment</button>
      <button class="preset-btn" onclick="usePreset(this,'Revenue projections from FY2025 to FY2027 with scenario analysis')"><span>📈</span> Revenue Projections</button>
      <button class="preset-btn" onclick="usePreset(this,'Exit scenarios with MOIC calculations, IRR estimates, and comparable acquisitions')"><span>🚪</span> Exit Scenarios & MOIC</button>
      <button class="preset-btn" onclick="usePreset(this,'Investment thesis with market opportunity, competitive advantages, and strategic fit')"><span>💼</span> Investment Thesis</button>
      <button class="preset-btn" onclick="usePreset(this,'Cap table, deal terms, convertible note structure, and ownership breakdown')"><span>📋</span> Cap Table & Terms</button>
      <button class="preset-btn" onclick="usePreset(this,'Team profile, founder background, and key person analysis')"><span>👥</span> Team & Founder</button>
      <span class="ctrl-hint"><kbd style="background:var(--bg2);padding:1px 5px;border-radius:3px;font-size:.62rem">Ctrl+Enter</kbd> to generate</span>
    </div>
  </div>

  <!-- ── Dashboard Output ── -->
  <div class="dash-outer">
    <div class="dash-toolbar">
      <i class="fas fa-chart-line" style="color:#06b6d4;font-size:13px"></i>
      <div class="dash-toolbar-title" id="dashToolbarTitle">AI-Generated Dashboard</div>
      <span class="dash-tag" id="dashTag" style="display:none"></span>
      <button class="dash-action-btn" id="copyBtn" onclick="copyDash()" style="display:none">
        <i class="fas fa-copy" style="font-size:10px"></i> Copy HTML
      </button>
      <button class="dash-action-btn" onclick="clearDash()" id="clearBtn" style="display:none">
        <i class="fas fa-trash" style="font-size:10px"></i> Clear
      </button>
    </div>
    <div class="dash-scroll">
      <div class="dash-inner" id="dashInner">
        <div class="empty-dash" id="emptyDash">
          <div class="empty-dash-icon">📊</div>
          <h3>No Dashboard Yet</h3>
          <p>Select a preset or enter a custom prompt above, then click <strong>Generate</strong>. Uses your uploaded documents or the built-in Shoreless Inc. knowledge base.</p>
          <div class="empty-dash-presets">
            <div class="edp-btn" onclick="usePreset(null,'Financial Overview with KPI cards and revenue trend chart')"><span class="edp-em">📊</span><span class="edp-text">Financial<br>Overview</span></div>
            <div class="edp-btn" onclick="usePreset(null,'Risk assessment dashboard with risk matrix and severity ratings')"><span class="edp-em">⚠️</span><span class="edp-text">Risk<br>Assessment</span></div>
            <div class="edp-btn" onclick="usePreset(null,'Revenue projections from FY2025 to FY2027 with scenario analysis')"><span class="edp-em">📈</span><span class="edp-text">Revenue<br>Projections</span></div>
            <div class="edp-btn" onclick="usePreset(null,'Exit scenarios with MOIC calculations and comparable acquisitions')"><span class="edp-em">🚪</span><span class="edp-text">Exit<br>Scenarios</span></div>
            <div class="edp-btn" onclick="usePreset(null,'Investment thesis with market opportunity and competitive advantages')"><span class="edp-em">💼</span><span class="edp-text">Investment<br>Thesis</span></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</div>

<!-- API KEY MODAL -->
<div class="modal-overlay" id="apiModal">
  <div class="modal">
    <h3><i class="fas fa-key" style="color:#06b6d4;margin-right:8px"></i>Update API Key</h3>
    <p>Enter your Genspark API key to enable live AI dashboard generation.</p>
    <input type="password" id="apiKeyInput" placeholder="Enter API key (e.g. gsk-xxx...)" />
    <div id="apiKeyStatus" style="font-size:.74rem;margin-bottom:10px;display:none"></div>
    <div class="modal-btns">
      <button class="modal-btn secondary" onclick="hideApiModal()">Cancel</button>
      <button class="modal-btn primary" id="saveKeyBtn" onclick="saveApiKey()"><i class="fas fa-check"></i> Save & Test</button>
    </div>
  </div>
</div>

<script>
// ── API KEY ──
function showApiModal(){document.getElementById('apiModal').classList.add('show');}
function hideApiModal(){document.getElementById('apiModal').classList.remove('show');}
async function saveApiKey(){
  const key=document.getElementById('apiKeyInput').value.trim();
  if(!key){alert('Please enter an API key');return;}
  const btn=document.getElementById('saveKeyBtn'),status=document.getElementById('apiKeyStatus');
  btn.disabled=true;btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Testing…';
  status.style.display='block';status.style.color='#b45309';status.textContent='Testing connection…';
  try{
    const res=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
    const data=await res.json();
    if(data.ok){status.style.color='#059669';status.textContent='✅ API key verified! Model: '+data.model;setTimeout(()=>hideApiModal(),1500);}
    else{status.style.color='#dc2626';status.textContent='❌ Invalid key: '+(data.error||'Unknown error');}
  }catch(e){status.style.color='#dc2626';status.textContent='❌ Error: '+e.message;}
  finally{btn.disabled=false;btn.innerHTML='<i class="fas fa-check"></i> Save & Test';}
}

// Init
fetch('/api/status').then(r=>r.json()).then(d=>{
  if(d.model)document.getElementById('modelLabel').textContent=d.model+' · RAG';
}).catch(()=>{});

let currentDashHtml = '';

// ── GENERATE ──
function usePreset(el,text){
  document.querySelectorAll('.preset-btn').forEach(p=>p.classList.remove('active'));
  if(el)el.classList.add('active');
  document.getElementById('genInput').value=text;
  document.getElementById('genInput').style.height='auto';
  document.getElementById('genInput').focus();
}

async function generateDash(){
  const prompt=document.getElementById('genInput').value.trim();
  if(!prompt){document.getElementById('genInput').focus();return;}
  const btn=document.getElementById('genBtn');
  const inner=document.getElementById('dashInner');
  const tag=document.getElementById('dashTag');
  const title=document.getElementById('dashToolbarTitle');
  const empty=document.getElementById('emptyDash');
  if(empty)empty.remove();
  btn.disabled=true;btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Generating…';
  tag.style.display='flex';tag.className='dash-tag streaming';tag.textContent='⚡ Streaming…';
  title.textContent=prompt.slice(0,60)+(prompt.length>60?'…':'');
  document.getElementById('copyBtn').style.display='none';
  document.getElementById('clearBtn').style.display='none';
  inner.innerHTML='<div style="padding:30px;color:var(--tt);display:flex;align-items:center;gap:12px;font-size:.84rem"><i class="fas fa-spinner fa-spin" style="color:#06b6d4;font-size:20px"></i><div><div style="font-weight:600;color:var(--navy)">Generating dashboard…</div><div style="font-size:.74rem;margin-top:3px">AI is analyzing your data and building visualizations</div></div></div>';
  let htmlBuf='',rt=null;
  try{
    const res=await fetch('/api/generate-dashboard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt})});
    if(!res.ok)throw new Error('Generation failed');
    const reader=res.body.getReader();const decoder=new TextDecoder();let lo='';
    while(true){
      const{done,value}=await reader.read();if(done)break;
      const text=lo+decoder.decode(value,{stream:true});
      const lines=text.split('\\n');lo=lines.pop()||'';
      for(const line of lines){
        if(!line.startsWith('data: '))continue;
        const payload=line.slice(6).trim();if(payload==='[DONE]')break;
        try{const obj=JSON.parse(payload);if(obj.text){htmlBuf+=obj.text;if(!rt){rt=setTimeout(()=>{rt=null;renderStream(htmlBuf);},200);}}}catch(_){}
      }
    }
    clearTimeout(rt);renderFinal(htmlBuf);
    tag.className='dash-tag live';tag.textContent='✓ Live';
    document.getElementById('copyBtn').style.display='flex';
    document.getElementById('clearBtn').style.display='flex';
  }catch(err){
    inner.innerHTML='<div style="padding:24px;color:#dc2626;font-size:.82rem"><i class="fas fa-exclamation-circle" style="margin-right:6px"></i>'+err.message+'</div>';
    tag.className='dash-tag error';tag.textContent='Error';
  }finally{btn.disabled=false;btn.innerHTML='<i class="fas fa-wand-magic-sparkles"></i> Generate';}
}

function renderStream(html){
  const el=document.getElementById('dashInner');
  let clean=html.replace(/^\`\`\`html\s*/i,'').replace(/\`\`\`\s*$/,'');
  el.innerHTML=clean+'<span class="stream-cursor"></span>';
}
function renderFinal(html){
  const el=document.getElementById('dashInner');
  currentDashHtml=html.replace(/^\`\`\`html\s*/i,'').replace(/\`\`\`\s*$/,'').trim();
  el.innerHTML=currentDashHtml;
  el.querySelectorAll('script').forEach(old=>{const s=document.createElement('script');s.textContent=old.textContent;old.replaceWith(s);});
}
function copyDash(){
  navigator.clipboard?.writeText(currentDashHtml).then(()=>{
    const btn=document.getElementById('copyBtn');
    const orig=btn.innerHTML;btn.innerHTML='<i class="fas fa-check" style="font-size:10px"></i> Copied!';
    setTimeout(()=>btn.innerHTML=orig,2000);
  });
}
function clearDash(){
  document.getElementById('dashInner').innerHTML='<div class="empty-dash" id="emptyDash"><div class="empty-dash-icon">📊</div><h3>No Dashboard Yet</h3><p>Select a preset or enter a custom prompt, then click Generate.</p></div>';
  document.getElementById('dashTag').style.display='none';
  document.getElementById('copyBtn').style.display='none';
  document.getElementById('clearBtn').style.display='none';
  document.getElementById('dashToolbarTitle').textContent='AI-Generated Dashboard';
  document.querySelectorAll('.preset-btn').forEach(p=>p.classList.remove('active'));
  currentDashHtml='';
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
