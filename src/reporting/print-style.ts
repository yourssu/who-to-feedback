/** Replace this print layout and the report template when the PDF design changes. */
export const reportPrintStyle = `
  @page { size: 1280px 720px; margin: 0; }
  @media print {
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .overview-card { min-height: 0; min-width: 0; }
  .overview-card img { max-height: 240px !important; }
  .slide:last-child { break-after: auto; page-break-after: auto; }
  }
`;
