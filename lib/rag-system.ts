// RAG System Core - Embeddings, Vector Search, and Query Processing

import { pipeline, env } from '@xenova/transformers';

// Configure transformers to use local models when available
env.allowLocalModels = false;
env.allowRemoteModels = true;

// Vector store entry
interface VectorEntry {
  id: string;
  text: string;
  embedding: number[];
  metadata: {
    category?: string;
    keywords?: string[];
  };
}

// Simple LRU cache implementation for query -> response
class LRUCache<K, V> {
  private capacity: number;
  private map = new Map<K, { value: V; ts: number }>();
  private ttlMs: number;

  constructor(capacity = 200, ttlMs = 5 * 60 * 1000) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
  }

  get(key: K): V | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    // refresh order
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, ts: Date.now() });
    if (this.map.size > this.capacity) {
      // remove oldest
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
  }

  clear() {
    this.map.clear();
  }
}

class RAGSystem {
  private embedder: any = null;
  private vectorStore: VectorEntry[] = [];
  private isInitialized = false;
  private cache = new LRUCache<string, { answer: string; sources: Array<{ text: string; score: number }>; confidence: number }>(200, 5 * 60 * 1000);
  // Runtime metrics for observability
  private metrics = {
    requestCount: 0,
    totalLatencyMs: 0,
    lastRequestMs: 0
  };

  async initialize() {
    if (this.isInitialized) return;

    try {
      // Initialize the embedding model
      this.embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      this.isInitialized = true;
      console.log('RAG System initialized successfully');
    } catch (error) {
      console.error('Failed to initialize RAG system:', error);
      throw error;
    }
  }

  async addDocuments(documents: Array<{ id: string; text: string; metadata?: any }>) {
    if (!this.isInitialized) await this.initialize();

    for (const doc of documents) {
      const embedding = await this.generateEmbedding(doc.text);
      this.vectorStore.push({ id: doc.id, text: doc.text, embedding, metadata: doc.metadata || {} });
    }

    console.log(`Added ${documents.length} documents to vector store`);
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.embedder) throw new Error('Embedder not initialized');
    const output = await this.embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data as any);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) throw new Error('Vectors must have the same length');
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dotProduct / denom;
  }

  // Primary vector search (returns topK by cosine similarity)
  async search(query: string, topK: number = 5): Promise<Array<{ text: string; score: number; metadata: any }>> {
    if (!this.isInitialized) await this.initialize();
    const queryEmbedding = await this.generateEmbedding(query);

    const results = this.vectorStore.map(entry => ({ text: entry.text, score: this.cosineSimilarity(queryEmbedding, entry.embedding), metadata: entry.metadata }));
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  // Lightweight re-ranker that boosts results based on keyword overlap and metadata
  private reRank(results: Array<{ text: string; score: number; metadata: any }>, query: string): Array<{ text: string; score: number; metadata: any }> {
    const qLower = query.toLowerCase();
    return results.map(r => {
      let boost = 0;
      try {
        const words = new Set(qLower.split(/\W+/).filter(Boolean));
        const textLower = r.text.toLowerCase();
        // token overlap
        let overlap = 0;
        words.forEach(w => { if (textLower.includes(w)) overlap++; });
        boost += overlap * 0.02; // small boost per overlap

        // metadata keyword boost
        if (r.metadata && Array.isArray(r.metadata.keywords)) {
          for (const kw of r.metadata.keywords) {
            if (qLower.includes((kw as string).toLowerCase())) boost += 0.03;
          }
        }
      } catch (err) {
        // ignore
      }
      return { ...r, score: Math.min(1, r.score + boost) };
    }).sort((a, b) => b.score - a.score);
  }

  // Short helper to trim context by character budget (token-budget aware prompt assembly)
  private assembleContext(results: Array<{ text: string; score: number }>, charBudget = 2000): string {
    let ctx = '';
    for (const r of results) {
      if (ctx.length + r.text.length + 2 > charBudget) break;
      ctx += r.text + '\n\n';
    }
    return ctx.trim();
  }

  // Single query with cache, re-ranking, and budget-aware context
  async query(question: string, topK: number = 5): Promise<{ answer: string; sources: Array<{ text: string; score: number }>; confidence: number }> {
    const start = Date.now();
    const cacheKey = `q:${question}:k:${topK}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      // update metrics for cache hit (very low latency assumed)
      const elapsed = Date.now() - start;
      this.metrics.requestCount += 1;
      this.metrics.totalLatencyMs += elapsed;
      this.metrics.lastRequestMs = elapsed;
      return cached;
    }

    const rawResults = await this.search(question, Math.max(topK, 10)); // fetch slightly more for rerank
    const ranked = this.reRank(rawResults, question).slice(0, topK);
    const confidence = ranked.length > 0 ? ranked[0].score : 0;
    const context = this.assembleContext(ranked.map(r => ({ text: r.text, score: r.score })), 1600);

    const answer = this.generateAnswer(question, context, confidence);
    const out = { answer, sources: ranked.map(r => ({ text: r.text, score: r.score })), confidence };
    this.cache.set(cacheKey, out);

    const elapsed = Date.now() - start;
    this.metrics.requestCount += 1;
    this.metrics.totalLatencyMs += elapsed;
    this.metrics.lastRequestMs = elapsed;
    return out;
  }

  // Batch multiple queries concurrently with simple concurrency control
  async batchQuery(queries: string[], topK: number = 5): Promise<Array<{ query: string; answer: string; sources: Array<{ text: string; score: number }>; confidence: number }>> {
    const start = Date.now();
    const runners = queries.map(async q => {
      const res = await this.query(q, topK);
      return { query: q, ...res };
    });
    const out = await Promise.all(runners);
    const elapsed = Date.now() - start;
    // record batch as a single metric event (helps calculate throughput)
    this.metrics.requestCount += queries.length;
    this.metrics.totalLatencyMs += elapsed;
    this.metrics.lastRequestMs = elapsed;
    return out;
  }

  // Answer generation and simple refinement rules (keeps answer concise for production)
  private generateAnswer(question: string, context: string, confidence: number): string {
    if (!context || confidence < 0.25) {
      return "I don't have enough relevant information to answer that question accurately. Try rephrasing or asking about a different topic.";
    }

    // Basic recruiter-feedback style refinement: prefer concise, ATS-friendly phrasing
    const qLower = question.toLowerCase();
    if (qLower.includes('experience') || qLower.includes('worked')) return this.extractExperienceAnswer(context);
    if (qLower.includes('skill') || qLower.includes('technology') || qLower.includes('know')) return this.extractSkillsAnswer(context);
    if (qLower.includes('project') || qLower.includes('built') || qLower.includes('developed')) return this.extractProjectAnswer(context);
    if (qLower.includes('challenge') || qLower.includes('problem')) return this.extractChallengeAnswer(context);
    if (qLower.includes('team') || qLower.includes('leadership')) return this.extractLeadershipAnswer(context);
    return this.extractGeneralAnswer(context);
  }

  private extractExperienceAnswer(context: string): string {
    const lines = context.split('\n').filter(l => l.trim());
    const selected = lines.filter(l => /\bat\b|position|achievement|result/i.test(l));
    return (selected.slice(0, 5).join(' ') || context.slice(0, 400)).trim();
  }

  private extractSkillsAnswer(context: string): string {
    const lines = context.split('\n').filter(l => l.trim());
    const skills = lines.filter(l => /skills:|technology|experience|proficienc/i.test(l));
    return (skills.slice(0, 5).join(' ') || context.slice(0, 300)).trim();
  }

  private extractProjectAnswer(context: string): string {
    const lines = context.split('\n').filter(l => l.trim());
    const projects = lines.filter(l => /built|developed|implemented|project|result/i.test(l));
    return (projects.slice(0, 5).join(' ') || context.slice(0, 400)).trim();
  }

  private extractChallengeAnswer(context: string): string {
    const lines = context.split('\n').filter(l => l.trim());
    const chal = lines.filter(l => /situation|task|action|result|challenge/i.test(l));
    return (chal.slice(0, 6).join(' ') || context.slice(0, 500)).trim();
  }

  private extractLeadershipAnswer(context: string): string {
    const lines = context.split('\n').filter(l => l.trim());
    const lead = lines.filter(l => /team|mentor|lead|leadership|manage/i.test(l));
    return (lead.slice(0, 5).join(' ') || context.slice(0, 350)).trim();
  }

  private extractGeneralAnswer(context: string): string {
    return (context.slice(0, 450) + (context.length > 450 ? '...' : '')).trim();
  }

  getStats() {
    const avgLatency = this.metrics.requestCount > 0 ? Math.round(this.metrics.totalLatencyMs / this.metrics.requestCount) : 0;
    return { totalDocuments: this.vectorStore.length, isInitialized: this.isInitialized, modelName: 'Xenova/all-MiniLM-L6-v2', cacheSize: undefined, metrics: { requestCount: this.metrics.requestCount, avgLatencyMs: avgLatency, lastRequestMs: this.metrics.lastRequestMs } };
  }

  clearVectorStore() {
    this.vectorStore = [];
    this.cache.clear();
  }
}

// Singleton instance
let ragSystemInstance: RAGSystem | null = null;

export function getRAGSystem(): RAGSystem {
  if (!ragSystemInstance) ragSystemInstance = new RAGSystem();
  return ragSystemInstance;
}

export type { VectorEntry };
export { RAGSystem };
