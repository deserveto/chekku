import { NextResponse } from 'next/server';

import {
  CompetitiveAnalysisServiceError,
  listCompetitiveAnalysesForUser,
} from '@/server/competitive-analyses';

export async function GET() {
  try {
    const analyses = await listCompetitiveAnalysesForUser();
    return NextResponse.json({ analyses });
  } catch (error) {
    if (error instanceof CompetitiveAnalysisServiceError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal-error', message: 'Could not load competitive analyses.' } },
      { status: 500 },
    );
  }
}
