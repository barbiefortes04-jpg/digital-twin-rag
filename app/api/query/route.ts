import { NextRequest, NextResponse } from 'next/server';
import { getRAGSystem } from '@/lib/rag-system';
import { getAllProfileContent } from '@/lib/profile-data';

let isSystemInitialized = false;

async function initializeSystem() {
  if (isSystemInitialized) return;
  
  const ragSystem = getRAGSystem();
  await ragSystem.initialize();
  
  // Add all profile content to vector store
  const profileContent = getAllProfileContent();
  const documents = profileContent.map((text, index) => ({
    id: `doc_${index}`,
    text,
    metadata: { source: 'profile' }
  }));
  
  await ragSystem.addDocuments(documents);
  isSystemInitialized = true;
  console.log('RAG system initialized with profile data');
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { query } = body || {};
    const { queries } = body || {};

    if (!query && !(Array.isArray(queries) && queries.length > 0)) {
      return NextResponse.json(
        { error: 'Request must include `query` string or `queries` array' },
        { status: 400 }
      );
    }

    // Initialize system if needed
    await initializeSystem();
    
    const ragSystem = getRAGSystem();
    if (Array.isArray(queries) && queries.length > 0) {
      const results = await ragSystem.batchQuery(queries, 5);
      return NextResponse.json({ success: true, results, timestamp: new Date().toISOString() });
    }

    const result = await ragSystem.query(query, 5);

    return NextResponse.json({
      success: true,
      query,
      answer: result.answer,
      confidence: result.confidence,
      sources: result.sources.slice(0, 3), // Return top 3 sources
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Query error:', error);
    return NextResponse.json(
      { 
        error: 'Failed to process query',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    await initializeSystem();
    const ragSystem = getRAGSystem();
    const stats = ragSystem.getStats();
    
    return NextResponse.json({
      success: true,
      stats,
      status: 'RAG system is operational'
    });
  } catch (error) {
    return NextResponse.json(
      { 
        error: 'Failed to get system status',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
