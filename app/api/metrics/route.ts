import { NextResponse } from 'next/server';
import { getRAGSystem } from '@/lib/rag-system';

export async function GET() {
  try {
    const rag = getRAGSystem();
    // Ensure initialized (non-blocking)
    try { await rag.initialize(); } catch (e) { /* ignore init errors here */ }
    const stats = rag.getStats();
    return NextResponse.json({ success: true, stats, timestamp: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}


