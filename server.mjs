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
let vectorStore = []  // current session chunks (for generate page)
let currentDocName = ''
let currentDocRaw = ''
let embeddingAvailable = null

// Persistent Knowledge Base — accumulates all uploaded files across sessions
let kbFiles = []    // metadata list: [{id, name, size, fileType, chunks, chars, addedAt, searchMode}]
let kbStore = []    // all KB chunks combined
let kbEmbeddingAvailable = null

// Saved Dashboards store
let savedDashboards = []  // [{id, prompt, html, savedAt}]

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

// ── KB File Management ───────────────────────
// Add to persistent KB
app.post('/api/kb-add', async (c) => {
  try {
    const form = await c.req.formData()
    const singleFile = form.get('file')
    const multiFiles = form.getAll('files[]')
    const files = multiFiles.length > 0 ? multiFiles : (singleFile ? [singleFile] : [])
    if (files.length === 0) return c.json({ error: 'No file' }, 400)

    const supportedExts = ['html','htm','txt','md','csv','json','pdf','doc','docx','jpg','jpeg','png','gif','webp','bmp','tiff','svg']
    for (const f of files) {
      const ext = f.name.split('.').pop()?.toLowerCase() || ''
      if (!supportedExts.includes(ext)) return c.json({ error: `Unsupported: ${f.name}` }, 400)
    }

    const addedFiles = []
    for (const file of files) {
      try {
        const extracted = await extractTextFromFile(file)
        const text = extracted.text.slice(0, 40000)
        const chunks = chunkText(text, 500, 100)
        let usedEmbeddings = false

        if (kbEmbeddingAvailable !== false) {
          try {
            const batchSize = 20
            for (let i = 0; i < chunks.length; i += batchSize) {
              const batch = chunks.slice(i, i + batchSize)
              const embedRes = await llm.embeddings.create({ model: 'text-embedding-3-small', input: batch })
              batch.forEach((text, j) => {
                kbStore.push({ id: `kb-upload-${kbFiles.length}-${i+j}`, text, embedding: embedRes.data[j].embedding, metadata: { source: file.name } })
              })
            }
            kbEmbeddingAvailable = true; usedEmbeddings = true
          } catch (e) {
            kbEmbeddingAvailable = false
            chunks.forEach((text, i) => kbStore.push({ id: `kb-upload-${kbFiles.length}-${i}`, text, embedding: null, metadata: { source: file.name } }))
          }
        } else {
          chunks.forEach((text, i) => kbStore.push({ id: `kb-upload-${kbFiles.length}-${i}`, text, embedding: null, metadata: { source: file.name } }))
        }

        const fileEntry = {
          id: `kb-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
          name: file.name, size: file.size, fileType: extracted.type,
          chunks: chunks.length, chars: text.length,
          addedAt: new Date().toISOString(), searchMode: usedEmbeddings ? 'vector' : 'bm25'
        }
        kbFiles.push(fileEntry)
        addedFiles.push(fileEntry)
      } catch (e) {
        addedFiles.push({ name: file.name, error: e.message, ok: false })
      }
    }
    return c.json({ ok: true, added: addedFiles, total: kbFiles.length, totalChunks: kbStore.length })
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})

// List KB files
app.get('/api/kb-files', (c) => {
  return c.json({ files: kbFiles, total: kbFiles.length, totalChunks: kbStore.length, builtinChunks: BUILTIN_KB.length })
})

// Delete KB file
app.delete('/api/kb-files/:id', (c) => {
  const id = c.req.param('id')
  const idx = kbFiles.findIndex(f => f.id === id)
  if (idx === -1) return c.json({ error: 'Not found' }, 404)
  const removed = kbFiles.splice(idx, 1)[0]
  // Remove chunks from kbStore
  kbStore = kbStore.filter(ch => ch.metadata?.source !== removed.name)
  return c.json({ ok: true, removed: removed.name, remaining: kbFiles.length })
})

// Chat with KB context (for knowledge base page)
app.post('/api/kb-chat', async (c) => {
  try {
    const { message } = await c.req.json()
    if (!message) return c.json({ error: 'No message' }, 400)

    // Retrieve from KB store + builtin KB
    const results = []
    if (kbStore.length > 0) {
      results.push(...bm25Search(message, kbStore, 8))
    }
    const kbResults = bm25Search(message, BUILTIN_KB, 6)
    for (const r of kbResults) { if (!results.includes(r)) results.push(r) }
    const contextChunks = results.slice(0, 12)

    const contextSource = kbFiles.length > 0 ? `${kbFiles.length} uploaded file(s)` : 'built-in knowledge base'
    const contextBlock = contextChunks.length > 0
      ? `

<context source="${contextSource}">
${contextChunks.join('\n---\n')}
</context>`
      : ''

    const systemPrompt = `You are Derek AI, a world-class investment analyst assistant specializing in venture capital deal analysis.
You have deep expertise in deal memos, financial analysis, startup evaluation, and VC investment strategy.

When answering:
- Use the provided context as your PRIMARY source (it contains real document data)
- Format with HTML: <h4> for headers, <ul><li> for lists, <strong> for key numbers/terms, <table> for data
- Be concise and data-driven - cite specific numbers, percentages, dates, and facts
- If data is from the document/KB, present it confidently`

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
        const fallbackReply = getFallbackReply(message, contextChunks)
        for (const chunk of fallbackReply.match(/.{1,50}/g) || []) {
          await writer.write(enc.encode(`data: ${JSON.stringify({ text: chunk })}\n\n`))
          await new Promise(r => setTimeout(r, 30))
        }
        await writer.write(enc.encode('data: [DONE]\n\n'))
      } finally { await writer.close() }
    }
    run()

    return new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' }
    })
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})

// Chat with dashboard context (for dashboard page)
app.post('/api/dash-chat', async (c) => {
  try {
    const { message, dashHtml } = await c.req.json()
    if (!message) return c.json({ error: 'No message' }, 400)

    const dashContext = dashHtml ? `

<dashboard_content>
${dashHtml.slice(0, 8000)}
</dashboard_content>` : ''
    const contextChunks = await retrieveContext(message, 6)
    const contextBlock = contextChunks.length > 0
      ? `

<knowledge_base>
${contextChunks.join('\n---\n')}
</knowledge_base>`
      : ''

    const systemPrompt = `You are Derek AI, analyzing a generated investment dashboard.
You have access to both the dashboard content and the underlying knowledge base.

When answering:
- Reference specific data points, charts, and metrics from the dashboard
- Format with HTML: <h4> for headers, <ul><li> for lists, <strong> for numbers
- Be analytical — interpret trends, flag risks, highlight opportunities
- Relate dashboard insights to the broader investment thesis`

    const userMsg = `${message}${dashContext}${contextBlock}`

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
        await writer.write(enc.encode(`data: ${JSON.stringify({ text: '<p>AI temporarily unavailable. Please check the dashboard data directly.</p>' })}\n\n`))
        await writer.write(enc.encode('data: [DONE]\n\n'))
      } finally { await writer.close() }
    }
    run()

    return new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' }
    })
  } catch (err) {
    return c.json({ error: err.message }, 500)
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
    builtinChunks: BUILTIN_KB.length,
    kbFiles: kbFiles.length,
    searchMode: embeddingAvailable ? 'vector' : 'bm25',
    apiKeyPrefix: apiKey.slice(0, 8) + '...'
  })
})

// ── Saved Dashboards ───────────────────────────
app.get('/api/saved-dashboards', (c) => {
  return c.json({ dashboards: savedDashboards.map(d => ({ id: d.id, prompt: d.prompt, savedAt: d.savedAt })) })
})

app.post('/api/save-dashboard', async (c) => {
  try {
    const { prompt, html } = await c.req.json()
    if (!html) return c.json({ error: 'No HTML provided' }, 400)
    const id = 'dash-' + Date.now()
    const entry = { id, prompt: prompt || 'Dashboard', html, savedAt: new Date().toISOString() }
    savedDashboards.unshift(entry)
    if (savedDashboards.length > 20) savedDashboards = savedDashboards.slice(0, 20)
    return c.json({ ok: true, id, message: 'Dashboard saved to knowledge base' })
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})

app.get('/api/saved-dashboards/:id', (c) => {
  const id = c.req.param('id')
  const dash = savedDashboards.find(d => d.id === id)
  if (!dash) return c.json({ error: 'Not found' }, 404)
  return c.json(dash)
})

app.delete('/api/saved-dashboards/:id', (c) => {
  const id = c.req.param('id')
  savedDashboards = savedDashboards.filter(d => d.id !== id)
  return c.json({ ok: true })
})

// ── Serve HTML ─────────────────────────────────
app.get('/', (c) => c.html(MAIN_HTML))
app.get('/generate', (c) => c.html(GENERATE_HTML))
app.get('/dashboard', (c) => c.html(DASHBOARD_HTML))

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
// Fallback Functions (when API key fails)
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// HTML PAGES
// ─────────────────────────────────────────────
const MAIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Derek — Knowledge Base</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
<style>
:root{--bg:#f0f4f8;--bg2:#e8edf2;--white:#fff;--navy:#0c2340;--border:#e2e8f0;--border2:#f1f5f9;--ts:#4b5563;--tt:#9ca3af;--cyan:#06b6d4;--cdark:#0e7490;--green:#10b981;--gl:#d1fae5;--amber:#f59e0b;--al:#fef3c7;--red:#ef4444;--rl:#fee2e2;--blue:#3b82f6;--bl:#dbeafe;--purple:#8b5cf6;--pl:#ede9fe;--r-sm:6px;--r-md:8px;--r-lg:12px;--r-xl:16px;--r-full:999px;--t:.15s ease;}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;font-family:'Inter',sans-serif;background:var(--bg);}
.topbar{background:var(--white);border-bottom:1px solid var(--border);height:56px;display:flex;align-items:center;padding:0 20px;gap:10px;flex-shrink:0;z-index:100;position:sticky;top:0;}
.tb-logo{width:34px;height:34px;background:linear-gradient(135deg,#0e7490,#06b6d4);border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.tb-logo i{font-size:14px;color:#fff;}
.tb-title{font-size:0.96rem;font-weight:800;color:var(--navy);letter-spacing:-.02em;}
.tb-tag{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:var(--r-full);font-size:.68rem;font-weight:700;}
.tg-teal{background:rgba(6,182,212,.1);color:#0e7490;}
.tg-amber{background:rgba(245,158,11,.1);color:#b45309;}
.tg-green{background:rgba(16,185,129,.1);color:#059669;}
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
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes bounce{0%,60%,100%{transform:translateY(0);}30%{transform:translateY(-5px);}}
.stream-cursor::after{content:'▋';animation:blink .7s steps(1) infinite;color:#06b6d4;}
@keyframes blink{0%,100%{opacity:1;}50%{opacity:0;}}
html,body{overflow:hidden;}
.page{display:flex;flex-direction:column;height:100vh;overflow:hidden;}
.body{display:flex;flex:1;min-height:0;overflow:hidden;}

/* ── LEFT: KB Panel ── */
.kb-panel{flex:0 0 340px;display:flex;flex-direction:column;border-right:1px solid var(--border);background:var(--white);overflow:hidden;}
.kb-panel-head{padding:16px 20px 12px;border-bottom:1px solid var(--border2);flex-shrink:0;}
.kb-panel-title{font-size:.92rem;font-weight:800;color:var(--navy);display:flex;align-items:center;gap:8px;margin-bottom:3px;}
.kb-panel-sub{font-size:.7rem;color:var(--tt);}
.kb-panel-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;}
.kb-panel-body::-webkit-scrollbar{width:4px;}
.kb-panel-body::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px;}

/* Upload Button */
.upload-btn-area{border:2px dashed var(--border);border-radius:var(--r-xl);padding:18px 16px;text-align:center;cursor:pointer;transition:all .15s;position:relative;}
.upload-btn-area:hover{border-color:#06b6d4;background:rgba(6,182,212,.02);}
.upload-btn-area.drag{border-color:#06b6d4;background:rgba(6,182,212,.04);}
.upload-input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;}
.upload-icon{width:40px;height:40px;background:linear-gradient(135deg,#0e7490,#06b6d4);border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto 10px;box-shadow:0 3px 12px rgba(6,182,212,.25);}
.upload-icon i{font-size:16px;color:#fff;}
.upload-title{font-size:.82rem;font-weight:700;color:var(--navy);margin-bottom:3px;}
.upload-sub{font-size:.68rem;color:var(--tt);}
.fmt-row{display:flex;gap:4px;flex-wrap:wrap;justify-content:center;margin-top:8px;}
.fmt-tag{font-size:.6rem;font-weight:600;padding:2px 7px;border-radius:var(--r-full);border:1px solid var(--border);color:var(--ts);background:var(--bg);}
.fmt-tag.pdf{border-color:rgba(239,68,68,.3);color:#dc2626;background:rgba(239,68,68,.05);}
.fmt-tag.docx{border-color:rgba(59,130,246,.3);color:#2563eb;background:rgba(59,130,246,.05);}
.fmt-tag.img{border-color:rgba(139,92,246,.3);color:#7c3aed;background:rgba(139,92,246,.05);}
.fmt-tag.txt{border-color:rgba(6,182,212,.3);color:#0e7490;background:rgba(6,182,212,.05);}

/* Processing */
.proc-card{background:var(--bg);border:1px solid var(--border);border-radius:var(--r-xl);padding:14px;display:none;}
.proc-card.show{display:block;}
.proc-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
.proc-label{font-size:.8rem;font-weight:700;color:var(--navy);display:flex;align-items:center;gap:6px;}
.proc-pct{font-size:.72rem;font-weight:700;color:#0e7490;font-family:'JetBrains Mono',monospace;}
.proc-bar{height:5px;background:var(--border);border-radius:var(--r-full);overflow:hidden;margin-bottom:6px;}
.proc-fill{height:100%;background:linear-gradient(90deg,#0e7490,#06b6d4,#10b981);border-radius:var(--r-full);transition:width .4s ease;width:0%;}
.proc-status{font-size:.69rem;color:var(--tt);}

/* KB Files List */
.kb-section-title{font-size:.72rem;font-weight:700;color:var(--ts);display:flex;align-items:center;justify-content:space-between;gap:6px;}
.kb-section-count{font-size:.65rem;font-weight:600;padding:2px 8px;border-radius:var(--r-full);background:rgba(6,182,212,.1);color:#0e7490;}
.kb-file-list{display:flex;flex-direction:column;gap:5px;}
.kb-file-item{display:flex;align-items:center;gap:8px;padding:9px 11px;background:var(--bg);border:1px solid var(--border2);border-radius:var(--r-lg);transition:all .15s;}
.kb-file-item:hover{border-color:rgba(6,182,212,.3);background:rgba(6,182,212,.03);}
.kf-icon{font-size:15px;flex-shrink:0;}
.kf-info{flex:1;min-width:0;}
.kf-name{font-size:.76rem;font-weight:600;color:var(--navy);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.kf-meta{font-size:.64rem;color:var(--tt);margin-top:1px;}
.kf-del{cursor:pointer;color:var(--tt);font-size:12px;padding:3px;border-radius:4px;transition:all .15s;flex-shrink:0;border:none;background:none;}
.kf-del:hover{color:var(--red);background:var(--rl);}

/* Builtin KB */
.builtin-kb{background:linear-gradient(135deg,rgba(12,35,64,.04),rgba(14,74,110,.06));border:1px solid rgba(12,35,64,.12);border-radius:var(--r-xl);padding:12px 14px;}
.bk-row{display:flex;align-items:center;gap:10px;}
.bk-icon{width:32px;height:32px;background:linear-gradient(135deg,#0c2340,#0e4a6e);border-radius:var(--r-md);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.bk-icon i{font-size:12px;color:#67e8f9;}
.bk-info{flex:1;}
.bk-title{font-size:.78rem;font-weight:700;color:var(--navy);}
.bk-sub{font-size:.66rem;color:var(--tt);margin-top:1px;}
.bk-badge{font-size:.62rem;font-weight:700;padding:2px 8px;border-radius:var(--r-full);background:rgba(16,185,129,.1);color:#059669;border:1px solid rgba(16,185,129,.25);}

/* Go to Generate */
.gen-cta{display:flex;align-items:center;gap:8px;padding:11px 14px;background:linear-gradient(135deg,rgba(6,182,212,.07),rgba(14,116,144,.1));border:1px solid rgba(6,182,212,.25);border-radius:var(--r-xl);cursor:pointer;transition:all .15s;text-decoration:none;}
.gen-cta:hover{background:linear-gradient(135deg,rgba(6,182,212,.12),rgba(14,116,144,.15));transform:translateY(-1px);}
.gen-cta-icon{width:34px;height:34px;background:linear-gradient(135deg,#0e7490,#06b6d4);border-radius:var(--r-md);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.gen-cta-icon i{color:#fff;font-size:14px;}
.gen-cta-text{flex:1;}
.gen-cta-title{font-size:.8rem;font-weight:700;color:#0e7490;}
.gen-cta-sub{font-size:.66rem;color:var(--tt);margin-top:1px;}

/* ── RIGHT: Chat Panel ── */
.chat-panel{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--white);overflow:hidden;}
.chat-head{padding:14px 20px;border-bottom:1px solid var(--border2);display:flex;align-items:center;gap:10px;flex-shrink:0;}
.chat-av{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#0c4a56,#06b6d4);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 2px 8px rgba(6,182,212,.3);}
.chat-av i{font-size:16px;color:#fff;}
.chat-title{font-size:.92rem;font-weight:700;color:var(--navy);}
.chat-sub{font-size:.65rem;color:var(--tt);margin-top:1px;}
.chat-ctx{margin-left:auto;display:flex;align-items:center;gap:5px;background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.25);border-radius:var(--r-full);padding:4px 12px;font-size:.67rem;font-weight:600;color:#0e7490;}
.chat-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;}
.chat-msgs::-webkit-scrollbar{width:4px;}
.chat-msgs::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px;}
.ai-idle{display:flex;flex-direction:column;align-items:center;padding:40px 24px;gap:10px;text-align:center;}
.ai-idle-icon{width:56px;height:56px;border-radius:16px;background:linear-gradient(135deg,#0c4a56,#06b6d4);display:flex;align-items:center;justify-content:center;font-size:24px;color:#fff;box-shadow:0 4px 16px rgba(6,182,212,.35);margin-bottom:4px;}
.ai-idle h3{font-size:.94rem;font-weight:700;color:var(--navy);}
.ai-idle p{font-size:.76rem;color:var(--tt);line-height:1.7;max-width:400px;}
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
.rag-badge{display:inline-flex;align-items:center;gap:4px;font-size:.63rem;font-weight:600;padding:2px 9px;border-radius:var(--r-full);background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.2);color:#0e7490;margin-top:6px;}
.chat-foot{padding:12px 16px;border-top:1px solid var(--border2);flex-shrink:0;}
.chat-input-row{display:flex;gap:8px;align-items:flex-end;}
.chat-ta{flex:1;resize:none;border:1px solid var(--border);border-radius:var(--r-lg);padding:9px 12px;font-size:.78rem;font-family:'Inter',sans-serif;color:var(--navy);outline:none;background:var(--bg);min-height:62px;max-height:120px;line-height:1.5;}
.chat-ta:focus{border-color:#06b6d4;background:var(--white);box-shadow:0 0 0 3px rgba(6,182,212,.1);}
.chat-ta::placeholder{color:var(--tt);}
.send-btn{width:38px;height:38px;border-radius:var(--r-md);border:none;background:linear-gradient(135deg,#0e7490,#06b6d4);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .15s;}
.send-btn:hover{opacity:.85;transform:translateY(-1px);}
.send-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;}
.chat-hint{font-size:.64rem;color:var(--tt);margin-top:5px;text-align:center;}
/* KB Tabs */
.kb-tabs{display:flex;gap:3px;}
.kb-tab{flex:1;padding:5px 8px;border-radius:var(--r-md);border:1px solid var(--border);background:var(--bg);font-size:.7rem;font-weight:600;color:var(--ts);cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;display:flex;align-items:center;justify-content:center;gap:5px;}
.kb-tab:hover{border-color:#06b6d4;color:#0e7490;}
.kb-tab.active{background:rgba(6,182,212,.1);border-color:rgba(6,182,212,.3);color:#0e7490;}
/* File select in KB */
.kb-file-item.selected{border-color:#06b6d4;background:rgba(6,182,212,.06);}
.kf-sel{width:16px;height:16px;border-radius:50%;border:2px solid var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .15s;cursor:pointer;}
.kb-file-item.selected .kf-sel{background:#06b6d4;border-color:#06b6d4;}
.kb-file-item.selected .kf-sel-dot{width:6px;height:6px;background:#fff;border-radius:50%;}
/* Selected files bar above chat */
.sel-files-bar{padding:7px 14px;background:rgba(6,182,212,.06);border-top:1px solid rgba(6,182,212,.15);display:none;flex-wrap:wrap;gap:5px;align-items:center;flex-shrink:0;}
.sel-files-bar.show{display:flex;}
.sel-bar-label{font-size:.67rem;font-weight:700;color:#0e7490;margin-right:2px;}
.sel-bar-tag{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:var(--r-full);background:rgba(6,182,212,.12);border:1px solid rgba(6,182,212,.25);color:#0e7490;font-size:.65rem;font-weight:600;}
.sel-bar-clear{margin-left:auto;font-size:.64rem;color:var(--tt);cursor:pointer;padding:2px 7px;border-radius:var(--r-full);border:1px solid var(--border);background:var(--bg);font-family:'Inter',sans-serif;}
.sel-bar-clear:hover{color:var(--red);border-color:rgba(239,68,68,.3);}
/* Quick actions row in chat footer */
.chat-quick-row{display:flex;gap:6px;margin-bottom:7px;flex-wrap:wrap;}
.chat-quick-btn{display:flex;align-items:center;gap:4px;padding:4px 10px;border-radius:var(--r-full);border:1px solid var(--border);background:var(--bg);font-size:.68rem;font-weight:600;color:var(--ts);cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;white-space:nowrap;}
.chat-quick-btn:hover{border-color:#06b6d4;color:#0e7490;background:rgba(6,182,212,.06);}
.chat-quick-btn.gen{border-color:rgba(139,92,246,.3);color:#6d28d9;background:rgba(139,92,246,.06);}
.chat-quick-btn.gen:hover{background:rgba(139,92,246,.1);}
</style>
</head>
<body>
<div class="page">
<div class="topbar">
  <div class="tb-logo"><i class="fas fa-brain"></i></div>
  <div class="tb-title">Derek</div>
  <div class="tb-tag tg-teal" style="margin-left:4px"><i class="fas fa-circle" style="font-size:6px"></i> AI Intelligence</div>
  <div class="tb-sp"></div>
  <nav class="tb-nav">
    <a class="tb-nav-btn active" href="/"><i class="fas fa-database" style="font-size:11px"></i> Knowledge Base</a>
    <a class="tb-nav-btn" href="/generate"><i class="fas fa-wand-magic-sparkles" style="font-size:11px"></i> Generate Report</a>
    <a class="tb-nav-btn" href="/dashboard"><i class="fas fa-chart-bar" style="font-size:11px"></i> Dashboard</a>
  </nav>
  <div class="tb-model" onclick="showApiModal()" title="Click to update API key">
    <span class="dot"></span>
    <span id="modelLabel">gpt-5 · RAG</span>
  </div>
  <button class="tb-key-btn" onclick="showApiModal()"><i class="fas fa-key" style="font-size:10px"></i> API Key</button>
  <div class="tb-user">D</div>
</div>

<div class="body">
<!-- ── LEFT: Knowledge Base Panel ── -->
<div class="kb-panel">
  <div class="kb-panel-head">
    <div class="kb-panel-title"><i class="fas fa-database" style="color:#06b6d4;font-size:13px"></i> Knowledge Base</div>
    <div class="kb-panel-sub">Upload documents to enrich AI context. Files persist for all queries.</div>
    <!-- Tab Switcher -->
    <div class="kb-tabs" style="display:flex;gap:4px;margin-top:10px;">
      <button class="kb-tab active" id="tabRaw" onclick="switchTab('raw')"><i class="fas fa-file" style="font-size:10px"></i> Files</button>
      <button class="kb-tab" id="tabDash" onclick="switchTab('dash')"><i class="fas fa-chart-bar" style="font-size:10px"></i> Dashboards</button>
    </div>
  </div>
  <div class="kb-panel-body" id="kbPanelBody">

    <!-- ── TAB: Raw Files ── -->
    <div id="tabRawContent" style="display:flex;flex-direction:column;gap:10px">

    <!-- Upload Area -->
    <div class="upload-btn-area" id="dropZone"
      ondragover="event.preventDefault();this.classList.add('drag')"
      ondragleave="this.classList.remove('drag')"
      ondrop="handleDrop(event)">
      <input type="file" class="upload-input" id="fileInput"
        accept=".html,.htm,.txt,.md,.csv,.json,.pdf,.doc,.docx,.jpg,.jpeg,.png,.gif,.webp,.bmp"
        multiple onchange="handleFileChange(event)"/>
      <div class="upload-icon"><i class="fas fa-cloud-upload-alt"></i></div>
      <div class="upload-title">Drop files or click to upload</div>
      <div class="upload-sub">Files are added to your knowledge base</div>
      <div class="fmt-row">
        <span class="fmt-tag pdf">PDF</span>
        <span class="fmt-tag docx">DOCX</span>
        <span class="fmt-tag img">Images</span>
        <span class="fmt-tag txt">TXT/MD</span>
        <span class="fmt-tag txt">CSV/JSON</span>
      </div>
    </div>

    <!-- Processing Progress -->
    <div class="proc-card" id="procCard">
      <div class="proc-row">
        <div class="proc-label"><i class="fas fa-microchip" style="color:#06b6d4;font-size:11px"></i><span id="procTitle">Processing…</span></div>
        <div class="proc-pct" id="procPct">0%</div>
      </div>
      <div class="proc-bar"><div class="proc-fill" id="procBar"></div></div>
      <div class="proc-status" id="procStatus">Preparing…</div>
    </div>

    <!-- KB Files List with select support -->
    <div id="kbFilesSection" style="display:none">
      <div class="kb-section-title">
        <span><i class="fas fa-folder-open" style="color:#06b6d4;font-size:11px;margin-right:5px"></i> Uploaded Files</span>
        <span class="kb-section-count" id="kbFileCount">0 files</span>
      </div>
      <div style="font-size:.67rem;color:var(--tt);margin-bottom:5px;display:flex;align-items:center;gap:4px;">
        <i class="fas fa-info-circle" style="font-size:9px;color:#06b6d4"></i>
        Click files to select for report generation
      </div>
      <div class="kb-file-list" id="kbFileList"></div>
    </div>

    <!-- Built-in KB -->
    <div class="builtin-kb">
      <div class="bk-row">
        <div class="bk-icon"><i class="fas fa-database"></i></div>
        <div class="bk-info">
          <div class="bk-title">Built-in Knowledge Base</div>
          <div class="bk-sub">Shoreless Inc. · Always active</div>
        </div>
        <div class="bk-badge" id="builtinChunkCount">16 chunks</div>
      </div>
    </div>

    </div><!-- end tabRawContent -->

    <!-- ── TAB: Dashboards ── -->
    <div id="tabDashContent" style="display:none">
      <div class="kb-section-title" style="margin-bottom:8px">
        <span><i class="fas fa-chart-bar" style="color:#8b5cf6;font-size:11px;margin-right:5px"></i> Saved Dashboards</span>
        <span class="kb-section-count" id="savedDashCount">0</span>
      </div>
      <div id="savedDashList">
        <div style="text-align:center;padding:24px 16px;background:var(--bg);border-radius:var(--r-xl);border:1px dashed var(--border)" id="noDashMsg">
          <div style="font-size:24px;margin-bottom:8px">📊</div>
          <div style="font-size:.76rem;font-weight:600;color:var(--ts)">No saved dashboards yet</div>
          <div style="font-size:.68rem;color:var(--tt);margin-top:4px">Generate a report and save it to KB</div>
          <a href="/generate" style="display:inline-flex;align-items:center;gap:5px;margin-top:10px;padding:6px 14px;border-radius:var(--r-full);background:rgba(139,92,246,.1);color:#6d28d9;font-size:.72rem;font-weight:600;text-decoration:none;border:1px solid rgba(139,92,246,.2)"><i class="fas fa-wand-magic-sparkles" style="font-size:10px"></i> Generate Report</a>
        </div>
      </div>
    </div><!-- end tabDashContent -->

    <!-- Generate Report CTA (always visible at bottom) -->
    <a class="gen-cta" href="/generate" id="genCtaBtn">
      <div class="gen-cta-icon"><i class="fas fa-wand-magic-sparkles"></i></div>
      <div class="gen-cta-text">
        <div class="gen-cta-title">Generate a Report</div>
        <div class="gen-cta-sub" id="genCtaSub">Select files from KB and generate an AI dashboard</div>
      </div>
      <i class="fas fa-arrow-right" style="color:#0e7490;font-size:12px"></i>
    </a>

  </div>
</div>

<!-- ── RIGHT: AI Chat ── -->
<div class="chat-panel">
  <div class="chat-head">
    <div class="chat-av"><i class="fas fa-robot"></i></div>
    <div>
      <div class="chat-title">Derek AI</div>
      <div class="chat-sub" id="chatSubLabel">Knowledge Base Q&A · RAG active</div>
    </div>
    <div class="chat-ctx" id="chatCtx">
      <i class="fas fa-circle" style="font-size:6px;color:#10b981"></i>
      <span id="chatCtxText">KB Ready</span>
    </div>
  </div>
  <div class="chat-msgs" id="chatMsgs">
    <div class="ai-idle" id="aiIdle">
      <div class="ai-idle-icon">🤖</div>
      <h3>Derek AI · Knowledge Base Q&A</h3>
      <p>Ask anything about uploaded documents or the built-in Shoreless Inc. knowledge base. Upload files on the left to add more context.</p>
    </div>
  </div>
  <div class="chat-foot">
    <!-- Selected files context bar -->
    <div class="sel-files-bar" id="selFilesBar">
      <span class="sel-bar-label"><i class="fas fa-link" style="font-size:9px"></i> Context:</span>
      <span id="selFileTags"></span>
      <button class="sel-bar-clear" onclick="clearFileSelection()">✕ Clear</button>
    </div>
    <!-- Quick action buttons -->
    <div class="chat-quick-row">
      <button class="chat-quick-btn" onclick="quickAsk('Financial overview and revenue metrics')"><i class="fas fa-chart-line" style="font-size:9px"></i> Financials</button>
      <button class="chat-quick-btn" onclick="quickAsk('Key risks and mitigation strategies')"><i class="fas fa-shield-alt" style="font-size:9px"></i> Risks</button>
      <button class="chat-quick-btn" onclick="quickAsk('Deal terms and investment structure')"><i class="fas fa-handshake" style="font-size:9px"></i> Deal Terms</button>
      <button class="chat-quick-btn gen" onclick="goGenerateWithSelected()"><i class="fas fa-wand-magic-sparkles" style="font-size:9px"></i> Generate Dashboard</button>
    </div>
    <div class="chat-input-row">
      <textarea class="chat-ta" id="chatInput"
        placeholder="Ask anything about your documents…"
        rows="3"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat();}"
        oninput="this.style.height='auto';this.style.height=Math.min(Math.max(this.scrollHeight,62),120)+'px'"></textarea>
      <button class="send-btn" id="sendBtn" onclick="sendChat()">
        <i class="fas fa-paper-plane" style="font-size:12px"></i>
      </button>
    </div>
    <div class="chat-hint"><i class="fas fa-database" style="font-size:9px"></i> RAG · Enter to send · Shift+Enter for new line</div>
  </div>
</div>
</div>
</div>

<!-- API KEY MODAL -->
<div class="modal-overlay" id="apiModal">
  <div class="modal">
    <h3><i class="fas fa-key" style="color:#06b6d4;margin-right:8px"></i>Update API Key</h3>
    <p>Enter your Genspark API key to enable live AI responses and dynamic dashboard generation.</p>
    <input type="password" id="apiKeyInput" placeholder="Enter API key…" />
    <div id="apiKeyStatus" style="font-size:.74rem;margin-bottom:10px;display:none"></div>
    <div class="modal-btns">
      <button class="modal-btn secondary" onclick="hideApiModal()">Cancel</button>
      <button class="modal-btn primary" id="saveKeyBtn" onclick="saveApiKey()"><i class="fas fa-check"></i> Save & Test</button>
    </div>
  </div>
</div>

<script>
// ── STATE ──
let kbFiles = [];
let selectedFileIds = new Set();
let savedDashboards = [];

// Init
fetch('/api/status').then(r=>r.json()).then(d=>{
  if(d.model) document.getElementById('modelLabel').textContent = d.model + ' · RAG';
  if(d.builtinChunks) document.getElementById('builtinChunkCount').textContent = d.builtinChunks + ' chunks';
  if(d.kbFiles > 0) document.getElementById('chatCtxText').textContent = d.kbFiles + ' file(s) loaded';
  else document.getElementById('chatCtxText').textContent = 'KB: ' + (d.kbChunks||16) + ' chunks';
}).catch(()=>{});

// Load KB files on startup
loadKbFiles();
loadSavedDashboards();

// ── TABS ──
function switchTab(tab){
  document.getElementById('tabRaw').classList.toggle('active', tab==='raw');
  document.getElementById('tabDash').classList.toggle('active', tab==='dash');
  document.getElementById('tabRawContent').style.display = tab==='raw'?'flex':'none';
  document.getElementById('tabRawContent').style.flexDirection = 'column';
  document.getElementById('tabRawContent').style.gap = '10px';
  document.getElementById('tabDashContent').style.display = tab==='dash'?'block':'none';
  document.getElementById('genCtaBtn').style.display = tab==='raw'?'flex':'none';
}

// ── API KEY ──
function showApiModal(){document.getElementById('apiModal').classList.add('show');}
function hideApiModal(){document.getElementById('apiModal').classList.remove('show');}
async function saveApiKey(){
  const key=document.getElementById('apiKeyInput').value.trim();
  if(!key){alert('Please enter an API key');return;}
  const btn=document.getElementById('saveKeyBtn'), status=document.getElementById('apiKeyStatus');
  btn.disabled=true; btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Testing…';
  status.style.display='block'; status.style.color='#b45309'; status.textContent='Testing connection…';
  try{
    const res=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
    const data=await res.json();
    if(data.ok){status.style.color='#059669';status.textContent='✅ Verified! Model: '+data.model;setTimeout(()=>hideApiModal(),1500);}
    else{status.style.color='#dc2626';status.textContent='❌ Invalid: '+(data.error||'Unknown error');}
  }catch(e){status.style.color='#dc2626';status.textContent='❌ Error: '+e.message;}
  finally{btn.disabled=false;btn.innerHTML='<i class="fas fa-check"></i> Save & Test';}
}

// ── KB FILES ──
async function loadKbFiles(){
  try{
    const res = await fetch('/api/kb-files');
    const data = await res.json();
    kbFiles = data.files || [];
    renderKbFiles();
    if(kbFiles.length > 0){
      document.getElementById('chatCtxText').textContent = kbFiles.length + ' file(s) in KB';
    }
  }catch(e){}
}

// ── SAVED DASHBOARDS ──
async function loadSavedDashboards(){
  try{
    const res = await fetch('/api/saved-dashboards');
    if(!res.ok) return;
    const data = await res.json();
    savedDashboards = data.dashboards || [];
    renderSavedDashboards();
  }catch(e){}
}

function renderSavedDashboards(){
  const list = document.getElementById('savedDashList');
  const noMsg = document.getElementById('noDashMsg');
  const countEl = document.getElementById('savedDashCount');
  countEl.textContent = savedDashboards.length;
  if(savedDashboards.length === 0){noMsg.style.display='block';return;}
  noMsg.style.display='none';
  // Clear existing dash items
  list.querySelectorAll('.saved-dash-item').forEach(el=>el.remove());
  savedDashboards.forEach(d=>{
    const el = document.createElement('div');
    el.className = 'saved-dash-item';
    el.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--bg);border:1px solid rgba(139,92,246,.2);border-radius:var(--r-lg);cursor:pointer;transition:all .15s;margin-bottom:5px;';
    el.innerHTML = '<div style="font-size:20px">📊</div>'+
      '<div style="flex:1;min-width:0">'+
        '<div style="font-size:.75rem;font-weight:600;color:var(--navy);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+d.prompt+'</div>'+
        '<div style="font-size:.63rem;color:var(--tt);margin-top:1px">'+fmtDate(d.savedAt)+' · Dashboard</div>'+
      '</div>'+
      '<button class="open-dash-btn" data-id="'+d.id+'" style="padding:3px 8px;border-radius:var(--r-md);border:1px solid rgba(139,92,246,.3);background:rgba(139,92,246,.08);color:#6d28d9;font-size:.65rem;font-weight:600;cursor:pointer;font-family:Inter,sans-serif">View</button>';
    el.querySelector('.open-dash-btn').addEventListener('click', function(e){ e.stopPropagation(); openSavedDash(this.dataset.id); });
    list.insertBefore(el, noMsg);
  });
}

function openSavedDash(id){
  const d = savedDashboards.find(x=>x.id===id);
  if(!d) return;
  sessionStorage.setItem('dashHtml', d.html);
  sessionStorage.setItem('dashPrompt', d.prompt);
  window.location.href = '/dashboard';
}

function getIcon(ext){
  if(ext==='pdf')return'📄';
  if(['doc','docx'].includes(ext))return'📝';
  if(['jpg','jpeg','png','gif','webp','bmp'].includes(ext))return'🖼️';
  if(['csv','json'].includes(ext))return'📊';
  if(['html','htm'].includes(ext))return'🌐';
  return'📄';
}
function fmtSize(b){return b<1024?b+'B':b<1048576?(b/1024).toFixed(1)+'KB':(b/1048576).toFixed(1)+'MB';}
function fmtDate(iso){const d=new Date(iso);return d.toLocaleDateString('en',{month:'short',day:'numeric'});}

function renderKbFiles(){
  const section = document.getElementById('kbFilesSection');
  const list = document.getElementById('kbFileList');
  const count = document.getElementById('kbFileCount');
  if(kbFiles.length === 0){section.style.display='none';return;}
  section.style.display='block';
  count.textContent = kbFiles.length + ' file' + (kbFiles.length>1?'s':'');
  list.innerHTML = '';
  kbFiles.forEach(f => {
    const ext = f.name.split('.').pop()?.toLowerCase()||'';
    const el = document.createElement('div');
    el.className = 'kb-file-item' + (selectedFileIds.has(f.id)?' selected':'');
    el.style.cursor = 'pointer';
    el.onclick = () => toggleFileSelect(f.id, f.name, el);
    el.innerHTML = '<div class="kf-sel"><div class="kf-sel-dot"></div></div>'+
      '<span class="kf-icon">'+getIcon(ext)+'</span>'+
      '<div class="kf-info">'+
        '<div class="kf-name">'+f.name+'</div>'+
        '<div class="kf-meta">'+f.chunks+' chunks · '+fmtSize(f.size)+' · '+fmtDate(f.addedAt)+'</div>'+
      '</div>'+
      '<button class="kf-del" onclick="event.stopPropagation();deleteKbFile(this.dataset.id,this)" data-id="'+f.id+'" title="Remove"><i class="fas fa-times"></i></button>';
    list.appendChild(el);
  });
  updateGenCtaSub();
}

function toggleFileSelect(id, name, el){
  if(selectedFileIds.has(id)){selectedFileIds.delete(id);el.classList.remove('selected');}
  else{selectedFileIds.add(id);el.classList.add('selected');}
  updateSelFilesBar();
  updateGenCtaSub();
}

function updateSelFilesBar(){
  const bar = document.getElementById('selFilesBar');
  const tagsEl = document.getElementById('selFileTags');
  if(selectedFileIds.size === 0){bar.classList.remove('show');return;}
  bar.classList.add('show');
  const names = [...selectedFileIds].map(id=>{const f=kbFiles.find(x=>x.id===id);return f?f.name:'';}).filter(Boolean);
  tagsEl.innerHTML = names.map(n=>'<span class="sel-bar-tag"><i class="fas fa-file" style="font-size:8px"></i> '+(n.length>18?n.slice(0,18)+'…':n)+'</span>').join('');
}

function clearFileSelection(){
  selectedFileIds.clear();
  document.querySelectorAll('.kb-file-item.selected').forEach(el=>el.classList.remove('selected'));
  document.getElementById('selFilesBar').classList.remove('show');
  updateGenCtaSub();
}

function updateGenCtaSub(){
  const sub = document.getElementById('genCtaSub');
  if(selectedFileIds.size > 0){
    sub.textContent = selectedFileIds.size + ' file(s) selected · Click to generate report';
  } else {
    sub.textContent = 'Select files from KB and generate an AI dashboard';
  }
}

function goGenerateWithSelected(){
  if(selectedFileIds.size > 0){
    const ids = [...selectedFileIds].join(',');
    window.location.href = '/generate?files='+encodeURIComponent(ids);
  } else {
    window.location.href = '/generate';
  }
}

async function deleteKbFile(id, btn){
  const f = kbFiles.find(x => x.id === id);
  const name = f ? f.name : 'file';
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  try{
    await fetch('/api/kb-files/'+id, {method:'DELETE'});
    kbFiles = kbFiles.filter(f => f.id !== id);
    selectedFileIds.delete(id);
    renderKbFiles();
    updateSelFilesBar();
    addMsg('bot', '<p>🗑️ Removed <strong>'+name+'</strong> from knowledge base.</p>');
    if(kbFiles.length === 0) document.getElementById('chatCtxText').textContent = 'KB Ready';
    else document.getElementById('chatCtxText').textContent = kbFiles.length + ' file(s) in KB';
  }catch(e){btn.innerHTML='<i class="fas fa-times"></i>';}
}

// ── FILE UPLOAD ──
const ALLOWED=['html','htm','txt','md','csv','json','pdf','doc','docx','jpg','jpeg','png','gif','webp','bmp'];

function handleDrop(e){
  e.preventDefault();
  document.getElementById('dropZone').classList.remove('drag');
  const files=Array.from(e.dataTransfer?.files||[]);
  if(files.length>0) processFiles(files);
}
function handleFileChange(e){
  const files=Array.from(e.target.files||[]);
  if(files.length>0) processFiles(files);
  e.target.value='';
}

async function processFiles(files){
  const valid=[], invalid=[];
  for(const f of files){
    const ext=f.name.split('.').pop()?.toLowerCase()||'';
    if(ALLOWED.includes(ext)) valid.push(f); else invalid.push(f.name);
  }
  if(invalid.length>0) addMsg('bot','<p>⚠️ Skipped: <strong>'+invalid.join(', ')+'</strong></p>');
  if(valid.length===0) return;
  await uploadToKb(valid);
}

async function uploadToKb(files){
  showProc(true);
  setProc(5, 'Uploading '+files.length+' file(s)…', 'Preparing…');
  const form = new FormData();
  if(files.length === 1) form.append('file', files[0]);
  else files.forEach(f => form.append('files[]', f));
  const hasBig = files.some(f => /\.(pdf|docx?)$/i.test(f.name));
  let pv = 5;
  const pi = setInterval(()=>{pv=Math.min(pv+(hasBig?3:6),85);setProc(pv,null,pv<40?'Parsing files…':pv<70?'Extracting & chunking…':'Building index…');},500);
  try{
    const res = await fetch('/api/kb-add', {method:'POST', body:form});
    const data = await res.json(); clearInterval(pi);
    if(data.error) throw new Error(data.error);
    setProc(100, '✅ '+files.length+' file(s) added to KB', 'Total: '+data.totalChunks+' chunks in knowledge base');
    await loadKbFiles();
    removeIdle();
    const names = (data.added||[]).filter(f=>!f.error).map(f=>f.name).join(', ');
    addMsg('bot', '<h4>📚 Added to Knowledge Base</h4><p><strong>'+(data.added||[]).filter(f=>!f.error).length+' file(s)</strong> added: '+names+'</p><p>Total KB: <strong>'+data.totalChunks+' chunks</strong> available for Q&A and report generation.</p><p style="margin-top:6px">Click files on the left to <strong>select for report generation</strong>, or ask questions below.</p>');
    setTimeout(()=>showProc(false), 3000);
  }catch(err){
    clearInterval(pi); showProc(false);
    addMsg('bot', '<p>❌ Upload failed: ' + err.message + '</p>');
  }
}

function showProc(show){document.getElementById('procCard').classList.toggle('show',show);}
function setProc(pct,title,status){
  document.getElementById('procBar').style.width=pct+'%';
  document.getElementById('procPct').textContent=Math.round(pct)+'%';
  if(title) document.getElementById('procTitle').textContent=title;
  if(status) document.getElementById('procStatus').textContent=status;
}

// ── CHAT ──
function removeIdle(){document.getElementById('aiIdle')?.remove();}
function quickAsk(q){
  document.getElementById('chatInput').value = q;
  sendChat();
}
function addMsg(role,html){
  removeIdle();
  const msgs=document.getElementById('chatMsgs');
  const div=document.createElement('div'); div.className='ai-msg '+role;
  const icon=role==='bot'?'<i class="fas fa-robot" style="font-size:10px"></i>':'<i class="fas fa-user" style="font-size:10px"></i>';
  div.innerHTML='<div class="msg-av '+(role==='bot'?'bot':'usr')+'">'+ icon +'</div><div class="msg-bubble">'+html+'</div>';
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
  const msg=input.value.trim(); if(!msg) return;
  input.value=''; input.style.height='';
  const sendBtn=document.getElementById('sendBtn'); sendBtn.disabled=true;
  addMsg('user', msg); showTyping();
  try{
    const res=await fetch('/api/kb-chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg})});
    hideTyping();
    if(!res.ok){const e=await res.json();throw new Error(e.error||'Chat failed');}
    const msgs=document.getElementById('chatMsgs');
    const div=document.createElement('div'); div.className='ai-msg bot';
    div.innerHTML='<div class="msg-av bot"><i class="fas fa-robot" style="font-size:10px"></i></div><div class="msg-bubble stream-cursor" id="streamBubble"></div>';
    msgs.appendChild(div); msgs.scrollTop=msgs.scrollHeight;
    const bubble=document.getElementById('streamBubble');
    const reader=res.body.getReader(); const decoder=new TextDecoder(); let lo='',ft='';
    while(true){
      const{done,value}=await reader.read(); if(done) break;
      const chunk=lo+decoder.decode(value,{stream:true});
      const lines=chunk.split('\n'); lo=lines.pop()||'';
      for(const line of lines){
        if(!line.startsWith('data: ')) continue;
        const payload=line.slice(6).trim(); if(payload==='[DONE]') break;
        try{const obj=JSON.parse(payload);if(obj.text){ft+=obj.text;bubble.innerHTML=ft;msgs.scrollTop=msgs.scrollHeight;}}catch(_){}
      }
    }
    bubble.classList.remove('stream-cursor');
    const src = kbFiles.length > 0 ? kbFiles.length + ' file(s)' : 'Built-in KB';
    bubble.innerHTML += '<div class="rag-badge"><i class="fas fa-database" style="font-size:9px"></i> RAG · '+src+'</div>';
  }catch(err){hideTyping();addMsg('bot','<p>❌ '+err.message+'</p>');}
  finally{sendBtn.disabled=false;}
}
</script>
</body>
</html>`

const GENERATE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Derek — Generate Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
<style>
:root{--bg:#f0f4f8;--bg2:#e8edf2;--white:#fff;--navy:#0c2340;--border:#e2e8f0;--border2:#f1f5f9;--ts:#4b5563;--tt:#9ca3af;--cyan:#06b6d4;--cdark:#0e7490;--green:#10b981;--gl:#d1fae5;--amber:#f59e0b;--al:#fef3c7;--red:#ef4444;--rl:#fee2e2;--blue:#3b82f6;--bl:#dbeafe;--purple:#8b5cf6;--pl:#ede9fe;--r-sm:6px;--r-md:8px;--r-lg:12px;--r-xl:16px;--r-full:999px;--t:.15s ease;}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;font-family:'Inter',sans-serif;background:var(--bg);}
.topbar{background:var(--white);border-bottom:1px solid var(--border);height:56px;display:flex;align-items:center;padding:0 20px;gap:10px;flex-shrink:0;z-index:100;position:sticky;top:0;}
.tb-logo{width:34px;height:34px;background:linear-gradient(135deg,#0e7490,#06b6d4);border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.tb-logo i{font-size:14px;color:#fff;}
.tb-title{font-size:0.96rem;font-weight:800;color:var(--navy);letter-spacing:-.02em;}
.tb-tag{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:var(--r-full);font-size:.68rem;font-weight:700;}
.tg-teal{background:rgba(6,182,212,.1);color:#0e7490;}
.tg-amber{background:rgba(245,158,11,.1);color:#b45309;}
.tg-green{background:rgba(16,185,129,.1);color:#059669;}
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
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes bounce{0%,60%,100%{transform:translateY(0);}30%{transform:translateY(-5px);}}
.stream-cursor::after{content:'▋';animation:blink .7s steps(1) infinite;color:#06b6d4;}
@keyframes blink{0%,100%{opacity:1;}50%{opacity:0;}}
html,body{overflow:hidden;}
.page{display:flex;flex-direction:column;height:100vh;overflow:hidden;}

/* Layout */
.gen-body{flex:1;min-height:0;display:flex;overflow:hidden;}

/* LEFT: file selector */
.gen-left{flex:0 0 320px;display:flex;flex-direction:column;border-right:1px solid var(--border);background:var(--white);overflow:hidden;}
.gl-head{padding:16px 18px 12px;border-bottom:1px solid var(--border2);flex-shrink:0;}
.gl-title{font-size:.88rem;font-weight:800;color:var(--navy);display:flex;align-items:center;gap:7px;margin-bottom:3px;}
.gl-sub{font-size:.69rem;color:var(--tt);}
.gl-body{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;}
.gl-body::-webkit-scrollbar{width:4px;}
.gl-body::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px;}

/* KB File Selector */
.source-section{display:flex;flex-direction:column;gap:6px;}
.source-label{font-size:.71rem;font-weight:700;color:var(--ts);display:flex;align-items:center;gap:5px;}
.source-item{display:flex;align-items:center;gap:8px;padding:9px 10px;border:1px solid var(--border);border-radius:var(--r-lg);cursor:pointer;transition:all .15s;background:var(--bg);}
.source-item:hover{border-color:rgba(6,182,212,.4);}
.source-item.selected{border-color:#06b6d4;background:rgba(6,182,212,.06);}
.source-item.selected .si-check{display:flex;}
.si-icon{font-size:15px;flex-shrink:0;}
.si-info{flex:1;min-width:0;}
.si-name{font-size:.75rem;font-weight:600;color:var(--navy);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.si-meta{font-size:.63rem;color:var(--tt);margin-top:1px;}
.si-check{width:18px;height:18px;border-radius:50%;background:#06b6d4;color:#fff;font-size:9px;display:none;align-items:center;justify-content:center;flex-shrink:0;}
.builtin-source{display:flex;align-items:center;gap:8px;padding:9px 10px;border:1px solid rgba(16,185,129,.3);border-radius:var(--r-lg);background:rgba(16,185,129,.04);}
.bs-icon{width:28px;height:28px;background:linear-gradient(135deg,#0c2340,#0e4a6e);border-radius:var(--r-md);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.bs-icon i{font-size:11px;color:#67e8f9;}
.bs-info{flex:1;}
.bs-name{font-size:.75rem;font-weight:700;color:var(--navy);}
.bs-meta{font-size:.63rem;color:#059669;margin-top:1px;}
.bs-badge{font-size:.6rem;font-weight:700;padding:1px 7px;border-radius:var(--r-full);background:rgba(16,185,129,.1);color:#059669;}

/* Upload to generate (quick upload) */
.quick-upload{border:2px dashed var(--border);border-radius:var(--r-xl);padding:14px;text-align:center;cursor:pointer;transition:all .15s;position:relative;}
.quick-upload:hover{border-color:#06b6d4;}
.quick-upload.drag{border-color:#06b6d4;background:rgba(6,182,212,.03);}
.qu-input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;}
.qu-text{font-size:.74rem;color:var(--tt);display:flex;align-items:center;justify-content:center;gap:7px;}
.qu-text i{color:#06b6d4;}

/* Selected summary */
.sel-summary{padding:10px 12px;background:rgba(6,182,212,.06);border:1px solid rgba(6,182,212,.2);border-radius:var(--r-lg);}
.sel-sum-title{font-size:.72rem;font-weight:700;color:#0e7490;margin-bottom:5px;}
.sel-sum-tags{display:flex;flex-wrap:wrap;gap:4px;}
.sel-tag{font-size:.64rem;padding:2px 8px;border-radius:var(--r-full);background:rgba(6,182,212,.1);color:#0e7490;border:1px solid rgba(6,182,212,.2);}

/* RIGHT: Prompt + Generate */
.gen-right{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--bg);overflow:hidden;}
.gr-top{background:var(--white);border-bottom:1px solid var(--border);padding:18px 20px;flex-shrink:0;}
.gr-top-title{font-size:.88rem;font-weight:800;color:var(--navy);margin-bottom:12px;display:flex;align-items:center;gap:7px;}
.prompt-area{display:flex;gap:10px;align-items:flex-start;margin-bottom:12px;}
.prompt-ta{flex:1;resize:none;border:1px solid var(--border);border-radius:var(--r-lg);padding:11px 14px;font-size:.82rem;font-family:'Inter',sans-serif;color:var(--navy);outline:none;background:var(--bg);min-height:72px;max-height:140px;line-height:1.6;}
.prompt-ta:focus{border-color:#06b6d4;background:var(--white);box-shadow:0 0 0 3px rgba(6,182,212,.1);}
.prompt-ta::placeholder{color:var(--tt);}
.gen-btn{padding:11px 22px;border-radius:var(--r-lg);border:none;background:linear-gradient(135deg,#0e7490,#06b6d4);color:#fff;font-size:.82rem;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;display:flex;align-items:center;gap:8px;white-space:nowrap;flex-shrink:0;align-self:flex-start;}
.gen-btn:hover{opacity:.88;transform:translateY(-1px);}
.gen-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;}
.preset-row{display:flex;gap:5px;flex-wrap:wrap;align-items:center;}
.p-label{font-size:.68rem;font-weight:700;color:var(--tt);white-space:nowrap;}
.p-btn{display:flex;align-items:center;gap:4px;padding:5px 11px;border-radius:var(--r-full);border:1px solid var(--border);background:var(--white);font-size:.71rem;font-weight:600;color:var(--ts);cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;white-space:nowrap;}
.p-btn:hover,.p-btn.active{border-color:#06b6d4;color:#0e7490;background:rgba(6,182,212,.08);}
.ctrl-hint{font-size:.64rem;color:var(--tt);}

/* Status area */
.gr-status{padding:10px 20px;background:var(--bg);border-bottom:1px solid var(--border);flex-shrink:0;display:flex;align-items:center;gap:10px;font-size:.74rem;color:var(--ts);}
.status-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
.status-dot.idle{background:#9ca3af;}
.status-dot.running{background:#f59e0b;animation:pulse 1s infinite;}
.status-dot.done{background:#10b981;}
.status-dot.err{background:#ef4444;}

/* Empty state */
.gen-empty{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;padding:40px 24px;text-align:center;}
.ge-icon{font-size:48px;margin-bottom:8px;}
.ge-title{font-size:1rem;font-weight:700;color:var(--ts);}
.ge-sub{font-size:.78rem;color:var(--tt);max-width:380px;line-height:1.6;}
.ge-presets{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:8px;}
.ge-preset-btn{display:flex;flex-direction:column;align-items:center;gap:5px;padding:14px 16px;border-radius:var(--r-xl);border:1px solid var(--border);background:var(--white);cursor:pointer;font-family:'Inter',sans-serif;transition:all .2s;min-width:110px;}
.ge-preset-btn:hover{border-color:#06b6d4;background:rgba(6,182,212,.04);transform:translateY(-2px);}
.ge-em{font-size:20px;}
.ge-txt{font-size:.72rem;font-weight:600;color:var(--navy);text-align:center;line-height:1.3;}

/* Proc card */
.gen-proc{flex:1;display:none;align-items:center;justify-content:center;flex-direction:column;gap:16px;padding:40px;}
.gen-proc.show{display:flex;}
.gp-icon{width:64px;height:64px;border-radius:18px;background:linear-gradient(135deg,#0e7490,#06b6d4);display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(6,182,212,.35);}
.gp-icon i{font-size:26px;color:#fff;animation:spin 1.5s linear infinite;}
.gp-title{font-size:1rem;font-weight:700;color:var(--navy);}
.gp-sub{font-size:.78rem;color:var(--tt);max-width:360px;text-align:center;line-height:1.6;}
.gp-bar-wrap{width:280px;height:6px;background:var(--border);border-radius:var(--r-full);overflow:hidden;}
.gp-bar{height:100%;background:linear-gradient(90deg,#0e7490,#06b6d4,#10b981);border-radius:var(--r-full);animation:growbar 3s ease-in-out infinite;}
@keyframes growbar{0%{width:5%;}50%{width:75%;}100%{width:92%;}}
</style>
</head>
<body>
<div class="page">
<div class="topbar">
  <div class="tb-logo"><i class="fas fa-brain"></i></div>
  <div class="tb-title">Derek</div>
  <div class="tb-tag tg-amber" style="margin-left:4px"><i class="fas fa-bolt" style="font-size:8px"></i> Report Generator</div>
  <div class="tb-sp"></div>
  <nav class="tb-nav">
    <a class="tb-nav-btn" href="/"><i class="fas fa-database" style="font-size:11px"></i> Knowledge Base</a>
    <a class="tb-nav-btn active" href="/generate"><i class="fas fa-wand-magic-sparkles" style="font-size:11px"></i> Generate Report</a>
    <a class="tb-nav-btn" href="/dashboard"><i class="fas fa-chart-bar" style="font-size:11px"></i> Dashboard</a>
  </nav>
  <div class="tb-model" onclick="showApiModal()">
    <span class="dot"></span>
    <span id="modelLabel">gpt-5 · RAG</span>
  </div>
  <button class="tb-key-btn" onclick="showApiModal()"><i class="fas fa-key" style="font-size:10px"></i> API Key</button>
  <div class="tb-user">D</div>
</div>

<div class="gen-body">
<!-- LEFT: Source Selector -->
<div class="gen-left">
  <div class="gl-head">
    <div class="gl-title"><i class="fas fa-folder-open" style="color:#06b6d4;font-size:13px"></i> Data Sources</div>
    <div class="gl-sub">Select files to include in your report</div>
  </div>
  <div class="gl-body">

    <!-- Built-in KB (always active) -->
    <div class="source-label"><i class="fas fa-database" style="font-size:10px;color:#059669"></i> Always Active</div>
    <div class="builtin-source">
      <div class="bs-icon"><i class="fas fa-database"></i></div>
      <div class="bs-info">
        <div class="bs-name">Built-in Knowledge Base</div>
        <div class="bs-meta">✓ Always included · Shoreless Inc.</div>
      </div>
      <div class="bs-badge">16</div>
    </div>

    <!-- KB Files -->
    <div class="source-label" style="margin-top:4px"><i class="fas fa-file" style="font-size:10px;color:#06b6d4"></i> Your Files <span id="kbFileLabelCount" style="font-weight:400;color:var(--tt)"></span></div>
    <div id="sourceFileList" style="display:flex;flex-direction:column;gap:5px">
      <div style="font-size:.73rem;color:var(--tt);padding:10px;text-align:center;background:var(--bg);border-radius:var(--r-lg);border:1px dashed var(--border)" id="noFilesMsg">
        No files in knowledge base yet.<br>
        <a href="/" style="color:#0e7490;font-weight:600">← Upload files first</a>
      </div>
    </div>

    <!-- Quick Upload -->
    <div class="source-label" style="margin-top:4px"><i class="fas fa-upload" style="font-size:10px;color:#8b5cf6"></i> Quick Upload</div>
    <div class="quick-upload" id="quickDrop"
      ondragover="event.preventDefault();this.classList.add('drag')"
      ondragleave="this.classList.remove('drag')"
      ondrop="handleQuickDrop(event)">
      <input type="file" class="qu-input" id="quickFileInput" multiple
        accept=".pdf,.docx,.doc,.txt,.md,.csv,.json,.html,.jpg,.jpeg,.png"
        onchange="handleQuickFile(event)"/>
      <div class="qu-text"><i class="fas fa-plus-circle"></i> Upload & add to report</div>
    </div>

    <!-- Selected Sources Summary -->
    <div class="sel-summary" id="selSummary" style="display:none">
      <div class="sel-sum-title"><i class="fas fa-check-circle" style="margin-right:4px"></i> Selected Sources</div>
      <div class="sel-sum-tags" id="selTags"></div>
    </div>

  </div>
</div>

<!-- RIGHT: Prompt + Status -->
<div class="gen-right">
  <div class="gr-top">
    <div class="gr-top-title">
      <i class="fas fa-wand-magic-sparkles" style="color:#06b6d4;font-size:14px"></i>
      Report Prompt
    </div>
    <div class="prompt-area">
      <textarea class="prompt-ta" id="genInput" rows="3"
        placeholder="Describe the report… e.g. 'Financial overview with revenue charts and KPI cards'"
        onkeydown="if(event.key==='Enter'&&event.ctrlKey){event.preventDefault();generateReport()}"
        oninput="this.style.height='auto';this.style.height=Math.min(Math.max(this.scrollHeight,72),140)+'px'"></textarea>
      <button class="gen-btn" id="genBtn" onclick="generateReport()">
        <i class="fas fa-wand-magic-sparkles"></i> Generate
      </button>
    </div>
    <div class="preset-row">
      <span class="p-label">Presets:</span>
      <button class="p-btn" onclick="setPreset(this,'Financial Overview with KPI cards, revenue trend chart and balance sheet')"><span>📊</span> Financial</button>
      <button class="p-btn" onclick="setPreset(this,'Risk assessment with risk matrix, severity ratings and mitigation strategies')"><span>⚠️</span> Risk</button>
      <button class="p-btn" onclick="setPreset(this,'Revenue projections from FY2025 to FY2027 with scenario analysis and growth drivers')"><span>📈</span> Revenue</button>
      <button class="p-btn" onclick="setPreset(this,'Exit scenarios with MOIC calculations, IRR estimates and comparable acquisitions')"><span>🚪</span> Exit</button>
      <button class="p-btn" onclick="setPreset(this,'Investment thesis with market opportunity, competitive moat and strategic fit')"><span>💼</span> Thesis</button>
      <button class="p-btn" onclick="setPreset(this,'Cap table, deal terms, convertible note structure and ownership breakdown')"><span>📋</span> Cap Table</button>
      <span class="ctrl-hint"><kbd style="background:var(--bg2);padding:1px 5px;border-radius:3px;font-size:.6rem">Ctrl+Enter</kbd> to generate</span>
    </div>
  </div>

  <!-- Status bar -->
  <div class="gr-status" id="statusBar">
    <span class="status-dot idle" id="statusDot"></span>
    <span id="statusText">Select sources and enter a prompt to generate your report</span>
  </div>

  <!-- Empty state -->
  <div class="gen-empty" id="genEmpty">
    <div class="ge-icon">📊</div>
    <div class="ge-title">Ready to Generate</div>
    <div class="ge-sub">Select data sources on the left, write a prompt above, then click Generate. The report will open in a new view.</div>
    <div class="ge-presets">
      <div class="ge-preset-btn" onclick="setPreset(null,'Financial Overview with KPI cards and revenue trend chart')"><span class="ge-em">📊</span><span class="ge-txt">Financial<br>Overview</span></div>
      <div class="ge-preset-btn" onclick="setPreset(null,'Risk assessment with risk matrix and severity ratings')"><span class="ge-em">⚠️</span><span class="ge-txt">Risk<br>Assessment</span></div>
      <div class="ge-preset-btn" onclick="setPreset(null,'Revenue projections with scenario analysis')"><span class="ge-em">📈</span><span class="ge-txt">Revenue<br>Projections</span></div>
      <div class="ge-preset-btn" onclick="setPreset(null,'Exit scenarios with MOIC calculations')"><span class="ge-em">🚪</span><span class="ge-txt">Exit<br>Scenarios</span></div>
      <div class="ge-preset-btn" onclick="setPreset(null,'Complete deal memo with all key metrics')"><span class="ge-em">📑</span><span class="ge-txt">Full Deal<br>Memo</span></div>
    </div>
  </div>

  <!-- Processing state -->
  <div class="gen-proc" id="genProc">
    <div class="gp-icon"><i class="fas fa-chart-line"></i></div>
    <div class="gp-title">Generating Report…</div>
    <div class="gp-sub" id="genProcSub">AI is analyzing your data and building visualizations. This may take 10-20 seconds.</div>
    <div class="gp-bar-wrap"><div class="gp-bar"></div></div>
  </div>
</div>
</div>
</div>

<!-- API KEY MODAL -->
<div class="modal-overlay" id="apiModal">
  <div class="modal">
    <h3><i class="fas fa-key" style="color:#06b6d4;margin-right:8px"></i>Update API Key</h3>
    <p>Enter your Genspark API key to enable live AI report generation.</p>
    <input type="password" id="apiKeyInput" placeholder="Enter API key…" />
    <div id="apiKeyStatus" style="font-size:.74rem;margin-bottom:10px;display:none"></div>
    <div class="modal-btns">
      <button class="modal-btn secondary" onclick="hideApiModal()">Cancel</button>
      <button class="modal-btn primary" id="saveKeyBtn" onclick="saveApiKey()"><i class="fas fa-check"></i> Save & Test</button>
    </div>
  </div>
</div>

<script>
let kbFiles = [], selectedFiles = new Set(), quickUploaded = [];

// Init
fetch('/api/status').then(r=>r.json()).then(d=>{
  if(d.model) document.getElementById('modelLabel').textContent=d.model+' · RAG';
}).catch(()=>{});
loadKbFiles();

// ── API KEY ──
function showApiModal(){document.getElementById('apiModal').classList.add('show');}
function hideApiModal(){document.getElementById('apiModal').classList.remove('show');}
async function saveApiKey(){
  const key=document.getElementById('apiKeyInput').value.trim();
  if(!key){alert('Please enter an API key');return;}
  const btn=document.getElementById('saveKeyBtn'),status=document.getElementById('apiKeyStatus');
  btn.disabled=true;btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Testing…';
  status.style.display='block';status.style.color='#b45309';status.textContent='Testing…';
  try{
    const res=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
    const data=await res.json();
    if(data.ok){status.style.color='#059669';status.textContent='✅ Model: '+data.model;setTimeout(()=>hideApiModal(),1500);}
    else{status.style.color='#dc2626';status.textContent='❌ '+(data.error||'Invalid key');}
  }catch(e){status.style.color='#dc2626';status.textContent='❌ '+e.message;}
  finally{btn.disabled=false;btn.innerHTML='<i class="fas fa-check"></i> Save & Test';}
}

// ── SOURCE FILES ──
async function loadKbFiles(){
  try{
    const res=await fetch('/api/kb-files');
    const data=await res.json();
    kbFiles=data.files||[];
    renderSourceFiles();
  }catch(e){}
}

function getIcon(ext){
  if(ext==='pdf')return'📄';if(['doc','docx'].includes(ext))return'📝';
  if(['jpg','jpeg','png','gif','webp','bmp'].includes(ext))return'🖼️';
  if(['csv','json'].includes(ext))return'📊';return'📄';
}
function fmtSize(b){return b<1024?b+'B':b<1048576?(b/1024).toFixed(1)+'KB':(b/1048576).toFixed(1)+'MB';}

function renderSourceFiles(){
  const list=document.getElementById('sourceFileList');
  const noMsg=document.getElementById('noFilesMsg');
  const label=document.getElementById('kbFileLabelCount');
  label.textContent=kbFiles.length>0?'('+kbFiles.length+')':'';
  
  if(kbFiles.length===0){noMsg.style.display='block';return;}
  noMsg.style.display='none';
  // Remove existing file items
  list.querySelectorAll('.source-item').forEach(el=>el.remove());
  kbFiles.forEach(f=>{
    const ext=f.name.split('.').pop()?.toLowerCase()||'';
    const el=document.createElement('div');
    el.className='source-item'+(selectedFiles.has(f.id)?' selected':'');
    el.dataset.id=f.id;
    el.innerHTML='<span class="si-icon">'+getIcon(ext)+'</span>'+
      '<div class="si-info"><div class="si-name">'+f.name+'</div><div class="si-meta">'+f.chunks+' chunks · '+fmtSize(f.size)+'</div></div>'+
      '<div class="si-check"><i class="fas fa-check" style="font-size:8px"></i></div>';
    el.onclick=()=>toggleFile(f.id, f.name, el);
    list.insertBefore(el, document.getElementById('noFilesMsg'));
  });
  updateSelSummary();
}

function toggleFile(id, name, el){
  if(selectedFiles.has(id)){selectedFiles.delete(id);el.classList.remove('selected');}
  else{selectedFiles.add(id);el.classList.add('selected');}
  updateSelSummary();
}

function updateSelSummary(){
  const sumDiv=document.getElementById('selSummary');
  const tagsDiv=document.getElementById('selTags');
  const selNames=[...selectedFiles].map(id=>{const f=kbFiles.find(x=>x.id===id);return f?f.name:'';}).filter(Boolean);
  if(selNames.length===0&&quickUploaded.length===0){sumDiv.style.display='none';return;}
  sumDiv.style.display='block';
  tagsDiv.innerHTML='';
  selNames.forEach(n=>{const t=document.createElement('span');t.className='sel-tag';t.textContent=n.length>20?n.slice(0,20)+'…':n;tagsDiv.appendChild(t);});
  quickUploaded.forEach(n=>{const t=document.createElement('span');t.className='sel-tag';t.style.background='rgba(139,92,246,.1)';t.style.color='#6d28d9';t.style.borderColor='rgba(139,92,246,.2)';t.textContent='⬆ '+n;tagsDiv.appendChild(t);});
}

// ── QUICK UPLOAD ──
function handleQuickDrop(e){
  e.preventDefault();
  document.getElementById('quickDrop').classList.remove('drag');
  const files=Array.from(e.dataTransfer?.files||[]);
  if(files.length>0) quickUpload(files);
}
function handleQuickFile(e){
  const files=Array.from(e.target.files||[]);
  if(files.length>0) quickUpload(files);
  e.target.value='';
}

async function quickUpload(files){
  setStatus('running','Uploading files to KB…');
  const form=new FormData();
  if(files.length===1)form.append('file',files[0]);
  else files.forEach(f=>form.append('files[]',f));
  try{
    const res=await fetch('/api/kb-add',{method:'POST',body:form});
    const data=await res.json();
    if(data.error)throw new Error(data.error);
    quickUploaded.push(...files.map(f=>f.name));
    await loadKbFiles();
    // Auto-select newly uploaded files
    if(data.added){
      data.added.forEach(f=>{if(!f.error){const found=kbFiles.find(x=>x.name===f.name);if(found)selectedFiles.add(found.id);}});
    }
    renderSourceFiles();
    setStatus('done','✅ '+files.length+' file(s) uploaded and selected');
  }catch(err){
    setStatus('err','❌ '+err.message);
  }
}

// ── PRESET ──
function setPreset(el, text){
  document.querySelectorAll('.p-btn').forEach(p=>p.classList.remove('active'));
  if(el)el.classList.add('active');
  document.getElementById('genInput').value=text;
  document.getElementById('genInput').style.height='auto';
  document.getElementById('genInput').focus();
}

// ── STATUS ──
function setStatus(state, text){
  const dot=document.getElementById('statusDot');
  dot.className='status-dot '+state;
  document.getElementById('statusText').textContent=text;
}

// ── GENERATE ──
async function generateReport(){
  const prompt=document.getElementById('genInput').value.trim();
  if(!prompt){document.getElementById('genInput').focus();return;}
  
  const btn=document.getElementById('genBtn');
  btn.disabled=true; btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Generating…';
  document.getElementById('genEmpty').style.display='none';
  document.getElementById('genProc').classList.add('show');
  document.getElementById('genProcSub').textContent='AI is analyzing '+(selectedFiles.size>0?selectedFiles.size+' selected file(s) + ':'')+' built-in knowledge base…';
  setStatus('running','⚡ Generating report…');
  
  let htmlBuf='';
  try{
    const res=await fetch('/api/generate-dashboard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt})});
    if(!res.ok) throw new Error('Generation failed');
    const reader=res.body.getReader(); const decoder=new TextDecoder(); let lo='';
    while(true){
      const{done,value}=await reader.read(); if(done) break;
      const text=lo+decoder.decode(value,{stream:true});
      const lines=text.split('\n'); lo=lines.pop()||'';
      for(const line of lines){
        if(!line.startsWith('data: ')) continue;
        const payload=line.slice(6).trim(); if(payload==='[DONE]') break;
        try{const obj=JSON.parse(payload);if(obj.text) htmlBuf+=obj.text;}catch(_){}
      }
    }
    
    const clean=htmlBuf.replace(/^\`\`\`html\s*/i,'').replace(/\`\`\`\s*$/,'').trim();
    // Store in sessionStorage and navigate to dashboard
    sessionStorage.setItem('dashHtml', clean);
    sessionStorage.setItem('dashPrompt', prompt);
    setStatus('done','✅ Report generated! Opening dashboard…');
    setTimeout(()=>window.location.href='/dashboard', 500);
  }catch(err){
    document.getElementById('genProc').classList.remove('show');
    document.getElementById('genEmpty').style.display='flex';
    setStatus('err','❌ '+err.message);
  }finally{
    btn.disabled=false; btn.innerHTML='<i class="fas fa-wand-magic-sparkles"></i> Generate';
  }
}
</script>
</body>
</html>`

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Derek — Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
:root{--bg:#f0f4f8;--bg2:#e8edf2;--white:#fff;--navy:#0c2340;--border:#e2e8f0;--border2:#f1f5f9;--ts:#4b5563;--tt:#9ca3af;--cyan:#06b6d4;--cdark:#0e7490;--green:#10b981;--gl:#d1fae5;--amber:#f59e0b;--al:#fef3c7;--red:#ef4444;--rl:#fee2e2;--blue:#3b82f6;--bl:#dbeafe;--purple:#8b5cf6;--pl:#ede9fe;--r-sm:6px;--r-md:8px;--r-lg:12px;--r-xl:16px;--r-full:999px;--t:.15s ease;}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;font-family:'Inter',sans-serif;background:var(--bg);}
.topbar{background:var(--white);border-bottom:1px solid var(--border);height:56px;display:flex;align-items:center;padding:0 20px;gap:10px;flex-shrink:0;z-index:100;position:sticky;top:0;}
.tb-logo{width:34px;height:34px;background:linear-gradient(135deg,#0e7490,#06b6d4);border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.tb-logo i{font-size:14px;color:#fff;}
.tb-title{font-size:0.96rem;font-weight:800;color:var(--navy);letter-spacing:-.02em;}
.tb-tag{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:var(--r-full);font-size:.68rem;font-weight:700;}
.tg-teal{background:rgba(6,182,212,.1);color:#0e7490;}
.tg-amber{background:rgba(245,158,11,.1);color:#b45309;}
.tg-green{background:rgba(16,185,129,.1);color:#059669;}
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
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes bounce{0%,60%,100%{transform:translateY(0);}30%{transform:translateY(-5px);}}
.stream-cursor::after{content:'▋';animation:blink .7s steps(1) infinite;color:#06b6d4;}
@keyframes blink{0%,100%{opacity:1;}50%{opacity:0;}}
html,body{overflow:hidden;}
.page{display:flex;flex-direction:column;height:100vh;overflow:hidden;}

/* Topbar action buttons */
.tb-action-btn{display:flex;align-items:center;gap:5px;padding:5px 12px;border-radius:var(--r-md);border:1px solid var(--border);background:var(--white);font-size:.72rem;font-weight:600;color:var(--ts);cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;text-decoration:none;}
.tb-action-btn:hover{border-color:#06b6d4;color:#0e7490;background:rgba(6,182,212,.05);}
.tb-action-btn.primary{background:linear-gradient(135deg,#0e7490,#06b6d4);color:#fff;border-color:transparent;}
.tb-action-btn.primary:hover{opacity:.88;}
.tb-action-btn.success{background:rgba(16,185,129,.1);color:#059669;border-color:rgba(16,185,129,.3);}
.tb-action-btn.success:hover{background:rgba(16,185,129,.18);}

/* Split layout */
.dash-body{flex:1;min-height:0;display:flex;overflow:hidden;}

/* LEFT: Report Panel */
.report-panel{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:var(--bg);}
.rp-toolbar{background:var(--white);border-bottom:1px solid var(--border);padding:10px 20px;display:flex;align-items:center;gap:10px;flex-shrink:0;}
.rp-title{font-size:.82rem;font-weight:700;color:var(--navy);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rp-tag{font-size:.64rem;font-weight:700;padding:2px 9px;border-radius:var(--r-full);background:rgba(16,185,129,.1);color:#059669;flex-shrink:0;}
.rp-action{display:flex;align-items:center;gap:5px;padding:4px 11px;border-radius:var(--r-md);border:1px solid var(--border);background:var(--white);font-size:.7rem;font-weight:600;color:var(--ts);cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;flex-shrink:0;}
.rp-action:hover{border-color:#06b6d4;color:#0e7490;}
.report-scroll{flex:1;overflow-y:auto;padding:20px;}
.report-scroll::-webkit-scrollbar{width:6px;}
.report-scroll::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px;}
.report-inner{min-height:300px;}

/* Loading / empty states */
.dash-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:60px 24px;text-align:center;height:100%;}
.dl-icon{width:60px;height:60px;border-radius:16px;background:linear-gradient(135deg,#0e7490,#06b6d4);display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(6,182,212,.3);}
.dl-icon i{font-size:24px;color:#fff;}
.dl-title{font-size:.94rem;font-weight:700;color:var(--navy);}
.dl-sub{font-size:.76rem;color:var(--tt);max-width:320px;line-height:1.6;}

/* RIGHT: Chat Panel */
.dash-chat{flex:0 0 360px;display:flex;flex-direction:column;border-left:1px solid var(--border);background:var(--white);overflow:hidden;}
.dc-head{padding:14px 18px;border-bottom:1px solid var(--border2);display:flex;align-items:center;gap:10px;flex-shrink:0;}
.dc-av{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#0c4a56,#06b6d4);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.dc-av i{font-size:14px;color:#fff;}
.dc-title{font-size:.86rem;font-weight:700;color:var(--navy);}
.dc-sub{font-size:.63rem;color:var(--tt);margin-top:1px;}
.dc-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;}
.dc-msgs::-webkit-scrollbar{width:3px;}
.dc-msgs::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px;}
.dc-idle{display:flex;flex-direction:column;align-items:center;padding:28px 16px;gap:8px;text-align:center;}
.dc-idle-icon{font-size:32px;margin-bottom:4px;}
.dc-idle h4{font-size:.84rem;font-weight:700;color:var(--navy);}
.dc-idle p{font-size:.72rem;color:var(--tt);line-height:1.6;max-width:280px;}
.dc-chips{padding:6px 14px;border-bottom:1px solid var(--border2);display:flex;gap:4px;overflow-x:auto;flex-shrink:0;background:var(--bg);}
.dc-chips::-webkit-scrollbar{height:0;}
.dchip{display:flex;align-items:center;gap:4px;flex-shrink:0;padding:4px 10px;border-radius:var(--r-full);border:1px solid var(--border);font-size:.65rem;font-weight:600;color:var(--tt);cursor:pointer;transition:all var(--t);background:var(--white);white-space:nowrap;font-family:'Inter',sans-serif;}
.dchip:hover{border-color:#06b6d4;color:#0e7490;background:rgba(6,182,212,.05);}
.ai-msg{display:flex;gap:7px;}
.ai-msg.user{flex-direction:row-reverse;}
.msg-av{width:26px;height:26px;border-radius:7px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:10px;}
.msg-av.bot{background:linear-gradient(135deg,#0c4a56,#06b6d4);color:#fff;}
.msg-av.usr{background:var(--navy);color:#fff;}
.msg-bubble{max-width:86%;padding:9px 12px;border-radius:11px;font-size:.76rem;line-height:1.7;color:var(--navy);}
.ai-msg.user .msg-bubble{background:linear-gradient(135deg,#0c4a56,#0e7490);color:#fff;border-radius:11px 2px 11px 11px;}
.ai-msg.bot .msg-bubble{background:var(--bg);border:1px solid var(--border2);border-radius:2px 11px 11px 11px;}
.msg-bubble h4{font-size:.74rem;font-weight:700;color:var(--navy);margin:0 0 4px;}
.ai-msg.user .msg-bubble h4{color:#e0f7fa;}
.msg-bubble ul{margin:4px 0;padding-left:14px;}
.msg-bubble li{margin-bottom:3px;}
.msg-bubble strong{color:#0e7490;}
.ai-msg.user .msg-bubble strong{color:#67e8f9;}
.msg-bubble p{margin-bottom:5px;}
.msg-bubble p:last-child{margin-bottom:0;}
.typing-dots{display:flex;gap:4px;padding:9px 11px;background:var(--bg);border:1px solid var(--border2);border-radius:2px 11px 11px 11px;width:fit-content;}
.typing-dots span{width:5px;height:5px;background:#9ca3af;border-radius:50%;animation:bounce 1.2s infinite;}
.typing-dots span:nth-child(2){animation-delay:.2s;}
.typing-dots span:nth-child(3){animation-delay:.4s;}
.dc-foot{padding:10px 14px;border-top:1px solid var(--border2);flex-shrink:0;}
.dc-input-row{display:flex;gap:7px;align-items:flex-end;}
.dc-ta{flex:1;resize:none;border:1px solid var(--border);border-radius:var(--r-lg);padding:8px 11px;font-size:.76rem;font-family:'Inter',sans-serif;color:var(--navy);outline:none;background:var(--bg);min-height:56px;max-height:100px;line-height:1.5;}
.dc-ta:focus{border-color:#06b6d4;background:var(--white);box-shadow:0 0 0 2px rgba(6,182,212,.1);}
.dc-ta::placeholder{color:var(--tt);}
.dc-send{width:34px;height:34px;border-radius:var(--r-md);border:none;background:linear-gradient(135deg,#0e7490,#06b6d4);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .15s;}
.dc-send:hover{opacity:.85;transform:translateY(-1px);}
.dc-send:disabled{opacity:.5;cursor:not-allowed;transform:none;}
.dc-hint{font-size:.62rem;color:var(--tt);margin-top:4px;text-align:center;}
.rag-badge{display:inline-flex;align-items:center;gap:3px;font-size:.61rem;font-weight:600;padding:2px 8px;border-radius:var(--r-full);background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.2);color:#0e7490;margin-top:5px;}
</style>
</head>
<body>
<div class="page">
<div class="topbar">
  <div class="tb-logo"><i class="fas fa-brain"></i></div>
  <div class="tb-title">Derek</div>
  <div class="tb-tag tg-green" style="margin-left:4px"><i class="fas fa-chart-bar" style="font-size:8px"></i> Dashboard</div>
  <div class="tb-sp"></div>
  <a class="tb-action-btn" href="/"><i class="fas fa-arrow-left" style="font-size:10px"></i> Knowledge Base</a>
  <a class="tb-action-btn" href="/generate"><i class="fas fa-redo" style="font-size:10px"></i> New Report</a>
  <button class="tb-action-btn" id="exportBtn" onclick="exportDash()" style="display:none"><i class="fas fa-download" style="font-size:10px"></i> Export HTML</button>
  <button class="tb-action-btn success" id="saveKbBtn" onclick="saveToKb()" style="display:none"><i class="fas fa-database" style="font-size:10px"></i> Save to KB</button>
  <div class="tb-model" onclick="showApiModal()">
    <span class="dot"></span>
    <span id="modelLabel">gpt-5 · AI</span>
  </div>
  <button class="tb-key-btn" onclick="showApiModal()"><i class="fas fa-key" style="font-size:10px"></i> API Key</button>
  <div class="tb-user">D</div>
</div>

<div class="dash-body">
<!-- LEFT: Report -->
<div class="report-panel">
  <div class="rp-toolbar">
    <i class="fas fa-chart-line" style="color:#06b6d4;font-size:13px;flex-shrink:0"></i>
    <div class="rp-title" id="rpTitle">Loading Dashboard…</div>
    <span class="rp-tag" id="rpTag" style="display:none">✓ Live</span>
    <button class="rp-action" onclick="copyHtml()"><i class="fas fa-copy" style="font-size:10px"></i> Copy HTML</button>
  </div>
  <div class="report-scroll">
    <div class="report-inner" id="reportInner">
      <div class="dash-loading" id="dashLoading">
        <div class="dl-icon"><i class="fas fa-chart-line"></i></div>
        <div class="dl-title">Loading Dashboard…</div>
        <div class="dl-sub">If this is your first visit, <a href="/generate" style="color:#0e7490;font-weight:600">generate a report first →</a></div>
      </div>
    </div>
  </div>
</div>

<!-- RIGHT: Chat -->
<div class="dash-chat">
  <div class="dc-head">
    <div class="dc-av"><i class="fas fa-robot"></i></div>
    <div>
      <div class="dc-title">Dashboard AI</div>
      <div class="dc-sub">Ask questions about this report</div>
    </div>
  </div>
  <div class="dc-chips">
    <button class="dchip" onclick="chipAsk('What are the key takeaways from this dashboard?',this)">📋 Key Insights</button>
    <button class="dchip" onclick="chipAsk('What are the top risks highlighted in this report?',this)">⚠️ Risks</button>
    <button class="dchip" onclick="chipAsk('Explain the financial performance shown in the charts',this)">💰 Financials</button>
    <button class="dchip" onclick="chipAsk('What are the investment highlights?',this)">🎯 Investment</button>
    <button class="dchip" onclick="chipAsk('Summarize the exit scenarios and returns',this)">🚪 Exit</button>
  </div>
  <div class="dc-msgs" id="dcMsgs">
    <div class="dc-idle" id="dcIdle">
      <div class="dc-idle-icon">🤖</div>
      <h4>Dashboard AI</h4>
      <p>I can answer questions about this report, explain charts, compare scenarios, or dive deeper into any section.</p>
    </div>
  </div>
  <div class="dc-foot">
    <div class="dc-input-row">
      <textarea class="dc-ta" id="dcInput"
        placeholder="Ask about this dashboard…"
        rows="2"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendDashChat();}"
        oninput="this.style.height='auto';this.style.height=Math.min(Math.max(this.scrollHeight,56),100)+'px'"></textarea>
      <button class="dc-send" id="dcSendBtn" onclick="sendDashChat()">
        <i class="fas fa-paper-plane" style="font-size:11px"></i>
      </button>
    </div>
    <div class="dc-hint">Enter to send · Shift+Enter for new line</div>
  </div>
</div>
</div>
</div>

<!-- API KEY MODAL -->
<div class="modal-overlay" id="apiModal">
  <div class="modal">
    <h3><i class="fas fa-key" style="color:#06b6d4;margin-right:8px"></i>Update API Key</h3>
    <p>Enter your Genspark API key to enable AI-powered dashboard analysis.</p>
    <input type="password" id="apiKeyInput" placeholder="Enter API key…" />
    <div id="apiKeyStatus" style="font-size:.74rem;margin-bottom:10px;display:none"></div>
    <div class="modal-btns">
      <button class="modal-btn secondary" onclick="hideApiModal()">Cancel</button>
      <button class="modal-btn primary" id="saveKeyBtn" onclick="saveApiKey()"><i class="fas fa-check"></i> Save & Test</button>
    </div>
  </div>
</div>

<script>
let currentDashHtml = '';
let dashPrompt = '';

// Init: load from sessionStorage
function init(){
  const html = sessionStorage.getItem('dashHtml');
  const prompt = sessionStorage.getItem('dashPrompt') || 'Dashboard';
  dashPrompt = prompt;
  
  fetch('/api/status').then(r=>r.json()).then(d=>{
    if(d.model) document.getElementById('modelLabel').textContent=d.model+' · AI';
  }).catch(()=>{});
  
  if(html && html.trim()){
    document.getElementById('dashLoading').remove();
    renderDashboard(html, prompt);
  } else {
    document.getElementById('rpTitle').textContent='No Report Loaded';
    document.getElementById('dashLoading').querySelector('.dl-title').textContent='No Dashboard Found';
  }
}

function renderDashboard(html, prompt){
  currentDashHtml = html;
  const inner = document.getElementById('reportInner');
  const existing = document.getElementById('dashLoading');
  if(existing) existing.remove();
  inner.innerHTML = html;
  // Re-execute scripts
  inner.querySelectorAll('script').forEach(old=>{
    const s=document.createElement('script');s.textContent=old.textContent;old.replaceWith(s);
  });
  document.getElementById('rpTitle').textContent = prompt.length>60?prompt.slice(0,60)+'…':prompt;
  document.getElementById('rpTag').style.display='flex';
  document.getElementById('exportBtn').style.display='flex';
  document.getElementById('saveKbBtn').style.display='flex';
}

// ── API KEY ──
function showApiModal(){document.getElementById('apiModal').classList.add('show');}
function hideApiModal(){document.getElementById('apiModal').classList.remove('show');}
async function saveApiKey(){
  const key=document.getElementById('apiKeyInput').value.trim();
  if(!key){alert('Please enter an API key');return;}
  const btn=document.getElementById('saveKeyBtn'),status=document.getElementById('apiKeyStatus');
  btn.disabled=true;btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Testing…';
  status.style.display='block';status.style.color='#b45309';status.textContent='Testing…';
  try{
    const res=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
    const data=await res.json();
    if(data.ok){status.style.color='#059669';status.textContent='✅ Model: '+data.model;setTimeout(()=>hideApiModal(),1500);}
    else{status.style.color='#dc2626';status.textContent='❌ '+(data.error||'Invalid key');}
  }catch(e){status.style.color='#dc2626';status.textContent='❌ '+e.message;}
  finally{btn.disabled=false;btn.innerHTML='<i class="fas fa-check"></i> Save & Test';}
}

// ── EXPORT ──
function copyHtml(){
  if(!currentDashHtml){return;}
  navigator.clipboard?.writeText(currentDashHtml).then(()=>{
    const btn=document.querySelector('.rp-action');
    const orig=btn.innerHTML;btn.innerHTML='<i class="fas fa-check" style="font-size:10px"></i> Copied!';
    setTimeout(()=>btn.innerHTML=orig,2000);
  });
}
function exportDash(){
  if(!currentDashHtml) return;
  const full = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>'+dashPrompt+'</title><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script></head><body style="font-family:Inter,sans-serif;background:#f0f4f8;padding:20px">'+currentDashHtml+'</body></html>';
  const a=document.createElement('a');
  a.href='data:text/html;charset=utf-8,'+encodeURIComponent(full);
  a.download='derek-report.html'; a.click();
}

// ── SAVE TO KB ──
async function saveToKb(){
  if(!currentDashHtml) return;
  const btn=document.getElementById('saveKbBtn');
  btn.innerHTML='<i class="fas fa-spinner fa-spin" style="font-size:10px"></i> Saving…';
  btn.disabled=true;
  try{
    // Save full dashboard HTML via new endpoint
    const res = await fetch('/api/save-dashboard', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({prompt:dashPrompt, html:currentDashHtml})});
    const data = await res.json();
    if(data.error) throw new Error(data.error);
    btn.innerHTML='<i class="fas fa-check" style="font-size:10px"></i> Saved!';
    btn.style.background='rgba(16,185,129,.2)';
    addDashMsg('bot','<p>✅ Dashboard saved to Knowledge Base. You can access it from the <a href="/" style="color:#0e7490;font-weight:600">Knowledge Base page</a> under the Dashboards tab.</p>');
    setTimeout(()=>{btn.innerHTML='<i class="fas fa-database" style="font-size:10px"></i> Save to KB';btn.disabled=false;btn.style.background='';},3000);
  }catch(err){
    btn.innerHTML='<i class="fas fa-database" style="font-size:10px"></i> Save to KB';
    btn.disabled=false;
    addDashMsg('bot','<p>❌ Save failed: '+err.message+'</p>');
  }
}

// ── CHAT ──
function removeIdle(){document.getElementById('dcIdle')?.remove();}
function addDashMsg(role,html){
  removeIdle();
  const msgs=document.getElementById('dcMsgs');
  const div=document.createElement('div');div.className='ai-msg '+role;
  const icon=role==='bot'?'<i class="fas fa-robot" style="font-size:10px"></i>':'<i class="fas fa-user" style="font-size:10px"></i>';
  div.innerHTML='<div class="msg-av '+(role==='bot'?'bot':'usr')+'">'+ icon +'</div><div class="msg-bubble">'+html+'</div>';
  msgs.appendChild(div);msgs.scrollTop=msgs.scrollHeight;return div;
}
function showTyping(){
  removeIdle();
  const msgs=document.getElementById('dcMsgs');
  const div=document.createElement('div');div.className='ai-msg bot';div.id='dcTyping';
  div.innerHTML='<div class="msg-av bot"><i class="fas fa-robot" style="font-size:10px"></i></div><div class="typing-dots"><span></span><span></span><span></span></div>';
  msgs.appendChild(div);msgs.scrollTop=msgs.scrollHeight;
}
function hideTyping(){document.getElementById('dcTyping')?.remove();}

async function sendDashChat(){
  const input=document.getElementById('dcInput');
  const msg=input.value.trim(); if(!msg) return;
  input.value='';input.style.height='';
  const btn=document.getElementById('dcSendBtn');btn.disabled=true;
  addDashMsg('user',msg);showTyping();
  try{
    const res=await fetch('/api/dash-chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg,dashHtml:currentDashHtml.slice(0,8000)})});
    hideTyping();
    if(!res.ok){const e=await res.json();throw new Error(e.error||'Chat failed');}
    const msgs=document.getElementById('dcMsgs');
    const div=document.createElement('div');div.className='ai-msg bot';
    div.innerHTML='<div class="msg-av bot"><i class="fas fa-robot" style="font-size:10px"></i></div><div class="msg-bubble stream-cursor" id="dcStreamBubble"></div>';
    msgs.appendChild(div);msgs.scrollTop=msgs.scrollHeight;
    const bubble=document.getElementById('dcStreamBubble');
    const reader=res.body.getReader();const decoder=new TextDecoder();let lo='',ft='';
    while(true){
      const{done,value}=await reader.read();if(done)break;
      const chunk=lo+decoder.decode(value,{stream:true});
      const lines=chunk.split('\n');lo=lines.pop()||'';
      for(const line of lines){
        if(!line.startsWith('data: '))continue;
        const payload=line.slice(6).trim();if(payload==='[DONE]')break;
        try{const obj=JSON.parse(payload);if(obj.text){ft+=obj.text;bubble.innerHTML=ft;msgs.scrollTop=msgs.scrollHeight;}}catch(_){}
      }
    }
    bubble.classList.remove('stream-cursor');
    bubble.innerHTML+='<div class="rag-badge"><i class="fas fa-chart-bar" style="font-size:8px"></i> Dashboard · RAG</div>';
  }catch(err){hideTyping();addDashMsg('bot','<p>❌ '+err.message+'</p>');}
  finally{btn.disabled=false;}
}

function chipAsk(text,btn){
  document.querySelectorAll('.dchip').forEach(c=>c.style.background='');
  btn.style.background='rgba(6,182,212,.1)';btn.style.borderColor='#06b6d4';btn.style.color='#0e7490';
  setTimeout(()=>{btn.style.background='';btn.style.borderColor='';btn.style.color='';},2000);
  document.getElementById('dcInput').value=text;sendDashChat();
}

init();
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
