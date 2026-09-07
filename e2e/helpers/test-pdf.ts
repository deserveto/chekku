/**
 * Builds a minimal but structurally valid two-page PDF (Helvetica text on
 * each page) with a correct xref table, so the browser PDF.js renderer can
 * rasterize both pages during chat-attachment e2e runs.
 */
export function buildTwoPagePdf(): Buffer {
  const objects: string[] = [
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Kids [3 0 R 5 0 R] /Count 2>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <</Font <</F1 7 0 R>>>>>>',
    '<</Length 62>>\nstream\nBT /F1 24 Tf 72 700 Td (Chekku e2e page one) Tj ET\nendstream',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources <</Font <</F1 7 0 R>>>>>>',
    '<</Length 62>>\nstream\nBT /F1 24 Tf 72 700 Td (Chekku e2e page two) Tj ET\nendstream',
    '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    // Stream dictionaries must declare their real byte length; compute it
    // from the stream payload before assembling the object.
    const streamMatch = /<\/Length \d+>>(\nstream\n[\s\S]*\nendstream)/.exec(
      object,
    );
    const finalObject = streamMatch
      ? object.replace(
          /<\/Length \d+>/,
          `<</Length ${Buffer.byteLength(streamMatch[1]!.replace(/^\nstream\n/, '').replace(/\nendstream$/, ''), 'latin1')}>`,
        )
      : object;
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${finalObject}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(body, 'latin1');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<</Size ${objects.length + 1} /Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body + xref + trailer, 'latin1');
}
