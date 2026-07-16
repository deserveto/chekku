import { NextResponse } from 'next/server';

import {
  listPmReportsForUser,
  PmReportServiceError,
} from '@/server/pm-reports';

export async function GET() {
  try {
    const reports = await listPmReportsForUser();
    return NextResponse.json({ reports });
  } catch (error) {
    if (error instanceof PmReportServiceError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal-error', message: 'Could not load reports.' } },
      { status: 500 },
    );
  }
}
