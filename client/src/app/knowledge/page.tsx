import { StudioNav } from '@/components/studio/studio-nav';
import { requireUserId } from '@/server/auth';
import {
  listKnowledgeDocumentsForUser,
  KnowledgeServiceError,
} from '@/server/knowledge';

import { KnowledgeDocumentList } from './knowledge-document-list';

export const dynamic = 'force-dynamic';

export default async function KnowledgePage() {
  const resourceId = await requireUserId();
  let documents: Awaited<ReturnType<typeof listKnowledgeDocumentsForUser>> = [];
  let errorMessage: string | undefined;

  try {
    documents = await listKnowledgeDocumentsForUser();
  } catch (error) {
    errorMessage = error instanceof KnowledgeServiceError
      ? error.message
      : 'Could not load your Knowledge.';
  }

  return (
    <div className="studio-shell">
      <StudioNav resourceId={resourceId} />
      <main className="studio-main">
        <header className="studio-page-header">
          <div>
            <p className="studio-eyebrow">Your documents</p>
            <h1>Knowledge</h1>
            <p>
              Documents you upload in chat are saved here and indexed, so every agent can find
              answers inside them later.
            </p>
          </div>
        </header>

        {errorMessage ? (
          <div className="studio-alert studio-alert-error" role="alert">
            {errorMessage}
          </div>
        ) : (
          <KnowledgeDocumentList initialDocuments={documents} />
        )}
      </main>
    </div>
  );
}
