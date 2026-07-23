import { NextResponse } from 'next/server';

import {
  CompetitiveAnalysisServiceError,
  getCompetitiveAnalysisForUser,
} from '@/server/competitive-analyses';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ analysisId: string }> },
) {
  try {
    const { analysisId } = await params;
    return NextResponse.json(await getCompetitiveAnalysisForUser(analysisId));
  } catch (error) {
    if (error instanceof CompetitiveAnalysisServiceError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal-error', message: 'Could not load competitive analysis.' } },
      { status: 500 },
    );
  }
}
