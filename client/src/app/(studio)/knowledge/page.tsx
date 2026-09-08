import {
  listKnowledgeDocumentsForUser,
  KnowledgeServiceError,
  type KnowledgeDocumentMetadata,
} from '@/server/knowledge';

import { KnowledgeDocumentList } from './knowledge-document-list';

export const dynamic = 'force-dynamic';

export default async function KnowledgePage() {
  let documents: KnowledgeDocumentMetadata[] = [];
  let errorMessage: string | undefined;

  try {
    documents = await listKnowledgeDocumentsForUser();
  } catch (error) {
    errorMessage = error instanceof KnowledgeServiceError
      ? error.message
      : 'Could not load your Knowledge.';
  }

  return (
    <>
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
    </>
  );
}
