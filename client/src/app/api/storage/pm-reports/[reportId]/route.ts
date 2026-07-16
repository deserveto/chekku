import { NextResponse } from 'next/server';

import {
  getPmReportForUser,
  PmReportServiceError,
} from '@/server/pm-reports';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ reportId: string }> },
) {
  try {
    const { reportId } = await params;
    return NextResponse.json(await getPmReportForUser(reportId));
  } catch (error) {
    if (error instanceof PmReportServiceError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal-error', message: 'Could not load report.' } },
      { status: 500 },
    );
  }
}
